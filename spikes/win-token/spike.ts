// THROWAWAY SPIKE. Not part of the product, not tested, not wired into any build.
// Question: can a Bun executable, running as SYSTEM, start a process inside each
// interactively logged-on user's session with that user's token, using only bun:ffi?
// Also reports whether that token is UAC-filtered (limited) or the full admin token.
// Run it as SYSTEM on Windows (see README.md). It writes C:\ProgramData\claude-rc-spike\spike.log.
import { dlopen, ptr, toArrayBuffer } from "bun:ffi";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "C:\\ProgramData\\claude-rc-spike";
const LOG = `${DIR}\\spike.log`;
mkdirSync(DIR, { recursive: true });
const log = (m: string) => {
  const line = `${new Date().toISOString()} ${m}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
};

// Let ordinary users write their probe output here (the probe runs as them).
const grant = Bun.spawnSync(["icacls", DIR, "/grant", "*S-1-5-32-545:(OI)(CI)M"]);
log(`icacls exit ${grant.exitCode}`);

const k32 = dlopen("kernel32.dll", {
  CloseHandle: { args: ["u64"], returns: "i32" },
  WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
  GetExitCodeProcess: { args: ["u64", "ptr"], returns: "i32" },
  GetLastError: { args: [], returns: "u32" },
}).symbols;
const wts = dlopen("wtsapi32.dll", {
  WTSEnumerateSessionsW: { args: ["u64", "u32", "u32", "ptr", "ptr"], returns: "i32" },
  WTSFreeMemory: { args: ["ptr"], returns: "void" },
  WTSQueryUserToken: { args: ["u32", "ptr"], returns: "i32" },
}).symbols;
const adv = dlopen("advapi32.dll", {
  DuplicateTokenEx: { args: ["u64", "u32", "ptr", "u32", "u32", "ptr"], returns: "i32" },
  GetTokenInformation: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
  CreateProcessAsUserW: {
    args: ["u64", "ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr"],
    returns: "i32",
  },
}).symbols;
const env = dlopen("userenv.dll", {
  CreateEnvironmentBlock: { args: ["ptr", "u64", "i32"], returns: "i32" },
  DestroyEnvironmentBlock: { args: ["ptr"], returns: "i32" },
}).symbols;

const wide = (s: string) => Buffer.from(s + "\0", "utf16le");
const ELEVATION_TYPE = ["?", "default (no split token)", "full (elevated)", "limited (UAC-filtered)"];

function elevation(token: bigint): string {
  const out = new Uint32Array(1);
  const ret = new Uint32Array(1);
  const type = adv.GetTokenInformation(token, 18, ptr(out), 4, ptr(ret))
    ? ELEVATION_TYPE[out[0]!] ?? `unknown(${out[0]})`
    : `error ${k32.GetLastError()}`;
  const el = new Uint32Array(1);
  const elev = adv.GetTokenInformation(token, 20, ptr(el), 4, ptr(ret)) ? (el[0] ? "yes" : "no") : "?";
  return `elevationType=${type} isElevated=${elev}`;
}

function linkedElevation(token: bigint): string {
  const h = new BigUint64Array(1);
  const ret = new Uint32Array(1);
  if (!adv.GetTokenInformation(token, 19, ptr(h), 8, ptr(ret))) return `no linked token (error ${k32.GetLastError()})`;
  const r = elevation(h[0]!);
  k32.CloseHandle(h[0]!);
  return r;
}

// probe.cmd runs as the user. It writes who it is, its groups and its privileges.
writeFileSync(
  `${DIR}\\probe.cmd`,
  [
    "@echo off",
    `(echo user=%USERDOMAIN%\\%USERNAME%`,
    "whoami /groups",
    "whoami /priv",
    `) > ${DIR}\\session-%1.txt 2>&1`,
    "",
  ].join("\r\n"),
);

// WTS_SESSION_INFOW on x64: DWORD SessionId; (pad) LPWSTR pWinStationName; DWORD State; (pad) = 24 bytes
const pInfo = new BigUint64Array(1);
const count = new Uint32Array(1);
if (!wts.WTSEnumerateSessionsW(0n, 0, 1, ptr(pInfo), ptr(count))) {
  log(`WTSEnumerateSessionsW failed: ${k32.GetLastError()}`);
  process.exit(1);
}
const raw = toArrayBuffer(Number(pInfo[0]!), 0, count[0]! * 24);
const dv = new DataView(raw);
const sessions: { id: number; state: number }[] = [];
for (let i = 0; i < count[0]!; i++) sessions.push({ id: dv.getUint32(i * 24, true), state: dv.getUint32(i * 24 + 16, true) });
wts.WTSFreeMemory(Number(pInfo[0]!));
log(`sessions: ${sessions.map((s) => `${s.id}(state ${s.state})`).join(" ")}  [state 0 = active, 4 = disconnected]`);

for (const s of sessions) {
  if (s.id === 0) continue; // services session
  log(`--- session ${s.id}`);
  const h = new BigUint64Array(1);
  if (!wts.WTSQueryUserToken(s.id, ptr(h))) {
    log(`WTSQueryUserToken failed: ${k32.GetLastError()} (1008 = no user logged on)`);
    continue;
  }
  const tok = h[0]!;
  log(`token from WTSQueryUserToken: ${elevation(tok)}`);
  log(`linked token: ${linkedElevation(tok)}`);

  const d = new BigUint64Array(1);
  // MAXIMUM_ALLOWED, SecurityImpersonation(2), TokenPrimary(1)
  if (!adv.DuplicateTokenEx(tok, 0x02000000, null, 2, 1, ptr(d))) {
    log(`DuplicateTokenEx failed: ${k32.GetLastError()}`);
    k32.CloseHandle(tok);
    continue;
  }
  const primary = d[0]!;
  const eb = new BigUint64Array(1);
  if (!env.CreateEnvironmentBlock(ptr(eb), primary, 0)) {
    log(`CreateEnvironmentBlock failed: ${k32.GetLastError()}`);
    k32.CloseHandle(primary);
    k32.CloseHandle(tok);
    continue;
  }

  // STARTUPINFOW on x64 is 104 bytes. cb at 0, lpDesktop at 16.
  const si = Buffer.alloc(104);
  const desktop = wide("winsta0\\default");
  si.writeUInt32LE(104, 0);
  si.writeBigUInt64LE(BigInt(ptr(desktop)), 16);
  const pi = Buffer.alloc(24); // hProcess, hThread, dwProcessId, dwThreadId
  const cmd = wide(`cmd.exe /d /c ${DIR}\\probe.cmd ${s.id}`);
  const CREATE_UNICODE_ENVIRONMENT = 0x400;
  const CREATE_NO_WINDOW = 0x08000000;
  const ok = adv.CreateProcessAsUserW(
    primary, null, ptr(cmd), null, null, 0,
    CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
    Number(eb[0]!), null, ptr(si), ptr(pi),
  );
  if (!ok) {
    log(`CreateProcessAsUserW failed: ${k32.GetLastError()}`);
  } else {
    const hProc = pi.readBigUInt64LE(0);
    const wait = k32.WaitForSingleObject(hProc, 15000);
    const code = new Uint32Array(1);
    k32.GetExitCodeProcess(hProc, ptr(code));
    log(`process pid ${pi.readUInt32LE(16)} wait=${wait} (0 = finished) exit=${code[0]}`);
    k32.CloseHandle(hProc);
    k32.CloseHandle(pi.readBigUInt64LE(8));
    const f = `${DIR}\\session-${s.id}.txt`;
    if (existsSync(f)) {
      const lines = readFileSync(f, "utf8").split(/\r?\n/);
      const pick = (re: RegExp) => lines.find((l) => re.test(l)) ?? "(not found)";
      log(`probe user:      ${pick(/^user=/)}`);
      log(`probe admin grp: ${pick(/S-1-5-32-544/)}`);
      log(`probe integrity: ${pick(/Mandatory Label/)}`);
      log(`probe privilege: ${pick(/SeDebugPrivilege/)}`);
    } else log(`no probe output at ${f}`);
  }
  env.DestroyEnvironmentBlock(Number(eb[0]!));
  k32.CloseHandle(primary);
  k32.CloseHandle(tok);
}
log("done");
