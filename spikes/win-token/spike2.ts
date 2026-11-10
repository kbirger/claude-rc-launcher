// THROWAWAY SPIKE 2. Single-user case: a process running as a user (like a service run with -Account)
// builds a restricted copy of its OWN token (UAC-like) and starts a child with it.
// No WTS, no other user, no password. Compare the child's groups/privileges/integrity to a baseline child.
// Writes C:\ProgramData\claude-rc-spike2\spike2.log
import { dlopen, ptr, toArrayBuffer } from "bun:ffi";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "C:\\ProgramData\\claude-rc-spike2";
const LOG = `${DIR}\\spike2.log`;
mkdirSync(DIR, { recursive: true });
const log = (m: string) => {
  const line = `${new Date().toISOString()} ${m}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
};

const k32 = dlopen("kernel32.dll", {
  CloseHandle: { args: ["u64"], returns: "i32" },
  GetCurrentProcess: { args: [], returns: "u64" },
  WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
  GetExitCodeProcess: { args: ["u64", "ptr"], returns: "i32" },
  GetLastError: { args: [], returns: "u32" },
  LocalFree: { args: ["u64"], returns: "u64" },
}).symbols;
const adv = dlopen("advapi32.dll", {
  OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
  GetTokenInformation: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
  SetTokenInformation: { args: ["u64", "u32", "ptr", "u32"], returns: "i32" },
  CreateRestrictedToken: {
    args: ["u64", "u32", "u32", "ptr", "u32", "ptr", "u32", "ptr", "ptr"],
    returns: "i32",
  },
  ConvertStringSidToSidW: { args: ["ptr", "ptr"], returns: "i32" },
  CreateProcessAsUserW: {
    args: ["u64", "ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr"],
    returns: "i32",
  },
}).symbols;

const wide = (s: string) => Buffer.from(s + "\0", "utf16le");
const err = () => k32.GetLastError();

// Let the restricted child write its probe output here.
log(`icacls exit ${Bun.spawnSync(["icacls", DIR, "/grant", "*S-1-5-32-545:(OI)(CI)M"]).exitCode}`);

// probe.cmd: who, groups, privileges.
writeFileSync(
  `${DIR}\\probe.cmd`,
  ["@echo off", `(echo user=%USERDOMAIN%\\%USERNAME%`, "C:\\Windows\\System32\\whoami.exe /groups", "C:\\Windows\\System32\\whoami.exe /priv", `) > ${DIR}\\%1.txt 2>&1`, ""].join("\r\n"),
);

function summarize(name: string) {
  const f = `${DIR}\\${name}.txt`;
  if (!existsSync(f)) return log(`[${name}] no probe output`);
  const lines = readFileSync(f, "utf8").split(/\r?\n/);
  const pick = (re: RegExp) => (lines.find((l) => re.test(l)) ?? "(not found)").replace(/\s{2,}/g, "  ");
  log(`[${name}] ${pick(/^user=/)}`);
  log(`[${name}] admin grp: ${pick(/S-1-5-32-544/)}`);
  log(`[${name}] integrity: ${pick(/Mandatory Label/)}`);
  log(`[${name}] SeDebug:   ${pick(/SeDebugPrivilege/)}`);
  log(`[${name}] privilege count: ${lines.filter((l) => /^Se\w+Privilege/.test(l)).length}`);
}

// Baseline: child inherits our full token.
const base = Bun.spawnSync(["cmd.exe", "/d", "/c", `${DIR}\\probe.cmd`, "baseline"]);
log(`baseline exit ${base.exitCode}`);
summarize("baseline");

// Our own token.
const h = new BigUint64Array(1);
// TOKEN_ALL_ACCESS
if (!adv.OpenProcessToken(k32.GetCurrentProcess(), 0xf01ff, ptr(h))) {
  log(`OpenProcessToken failed: ${err()}`);
  process.exit(1);
}
const own = h[0]!;

function runWith(label: string, token: bigint, withDesktop = false, cflags = 0x08000000) {
  const si = Buffer.alloc(104);
  si.writeUInt32LE(104, 0);
  const desktop = wide("winsta0\default");
  if (withDesktop) si.writeBigUInt64LE(BigInt(ptr(desktop)), 16);
  const pi = Buffer.alloc(24);
  const cmd = wide(`cmd.exe /d /c ${DIR}\\probe.cmd ${label}`);
  const ok = adv.CreateProcessAsUserW(token, null, ptr(cmd), null, null, 0, cflags, null, null, ptr(si), ptr(pi));
  if (!ok) return log(`[${label}] CreateProcessAsUserW failed: ${err()}  (1314 = missing privilege SeAssignPrimaryToken)`);
  const hp = pi.readBigUInt64LE(0);
  const wait = k32.WaitForSingleObject(hp, 15000);
  const code = new Uint32Array(1);
  k32.GetExitCodeProcess(hp, ptr(code));
  log(`[${label}] pid ${pi.readUInt32LE(16)} wait=${wait} exit=${code[0]}`);
  k32.CloseHandle(hp);
  k32.CloseHandle(pi.readBigUInt64LE(8));
  summarize(label);
}

// A: UAC-like restriction. LUA_TOKEN(4) | DISABLE_MAX_PRIVILEGE(1). No SID list.
function restricted(flags: number): bigint | null {
  const o = new BigUint64Array(1);
  if (!adv.CreateRestrictedToken(own, flags, 0, null, 0, null, 0, null, ptr(o))) {
    log(`CreateRestrictedToken(flags ${flags}) failed: ${err()}`);
    return null;
  }
  return o[0]!;
}

function setMedium(tok: bigint): boolean {
  const psid = new BigUint64Array(1);
  if (!adv.ConvertStringSidToSidW(ptr(wide("S-1-16-8192")), ptr(psid))) return false;
  const tml = Buffer.alloc(16); // TOKEN_MANDATORY_LABEL: PSID Sid; DWORD Attributes
  tml.writeBigUInt64LE(psid[0]!, 0);
  tml.writeUInt32LE(0x20 /* SE_GROUP_INTEGRITY */, 8);
  const ok = adv.SetTokenInformation(tok, 25 /* TokenIntegrityLevel */, ptr(tml), 16);
  if (!ok) log(`SetTokenInformation(IntegrityLevel) failed: ${err()}`);
  k32.LocalFree(psid[0]!);
  return !!ok;
}

const a = restricted(0x4 | 0x1);
if (a) {
  log("--- A: CreateRestrictedToken(LUA_TOKEN | DISABLE_MAX_PRIVILEGE)");
  runWith("A-nowin", a);
  runWith("A-desktop", a, true);
  runWith("A-detached", a, false, 0x8);
  runWith("A-newconsole", a, false, 0x10);
  runWith("A-desktop-detached", a, true, 0x8);
  log("--- B: same, then integrity lowered to Medium");
  if (setMedium(a)) runWith("B-lua-medium", a);
  k32.CloseHandle(a);
}
// C: privileges stripped only. D: only the Administrators SID deny-only. E: D + strip + Medium.
function restrictedSids(flags: number, sidStrings: string[]): bigint | null {
  const arr = Buffer.alloc(16 * sidStrings.length); // SID_AND_ATTRIBUTES: PSID, DWORD, pad
  sidStrings.forEach((s, i) => {
    const p = new BigUint64Array(1);
    adv.ConvertStringSidToSidW(ptr(wide(s)), ptr(p));
    arr.writeBigUInt64LE(p[0]!, i * 16);
  });
  const o = new BigUint64Array(1);
  if (!adv.CreateRestrictedToken(own, flags, sidStrings.length, sidStrings.length ? ptr(arr) : null, 0, null, 0, null, ptr(o))) {
    log(`CreateRestrictedToken(sids) failed: ${err()}`);
    return null;
  }
  return o[0]!;
}
const DET = 0x8;
log("--- C: DISABLE_MAX_PRIVILEGE only");
const c = restrictedSids(0x1, []);
if (c) { runWith("C-privs-only", c, false, DET); k32.CloseHandle(c); }
log("--- D: Administrators deny-only, privileges kept");
const d = restrictedSids(0, ["S-1-5-32-544"]);
if (d) { runWith("D-admin-deny", d, false, DET); k32.CloseHandle(d); }
log("--- E: Administrators deny-only + strip privileges + Medium");
const e = restrictedSids(0x1, ["S-1-5-32-544"]);
if (e) { if (setMedium(e)) runWith("E-admin-deny-medium", e, false, DET); k32.CloseHandle(e); }
log("--- F: CreateRestrictedToken with no flags and no lists (a no-op copy)");
const f = restrictedSids(0, []);
if (f) { runWith("F-noop", f, false, DET); k32.CloseHandle(f); }
// Findings so far: with Administrators deny-only the child cannot open its own token (default DACL
// only grants Administrators + SYSTEM). Fix: set TokenOwner and TokenDefaultDacl to the user's SID.
const adv2 = dlopen("advapi32.dll", { GetLengthSid: { args: ["u64"], returns: "u32" } }).symbols;
function userSid(): bigint {
  const need = new Uint32Array(1);
  adv.GetTokenInformation(own, 1, null, 0, ptr(need));
  const buf = Buffer.alloc(need[0]!);
  adv.GetTokenInformation(own, 1, ptr(buf), buf.length, ptr(need));
  keep.push(buf);
  return buf.readBigUInt64LE(0); // TOKEN_USER.User.Sid (points into buf)
}
const keep: Buffer[] = [];
function fixDacl(tok: bigint): boolean {
  const us = userSid();
  const sp = new BigUint64Array(1);
  adv.ConvertStringSidToSidW(ptr(wide("S-1-5-18")), ptr(sp));
  const sids = [us, sp[0]!];
  const sizes = sids.map((s) => adv2.GetLengthSid(s));
  const aclSize = 8 + sizes.reduce((a, n) => a + 8 + n, 0);
  const acl = Buffer.alloc(aclSize);
  acl.writeUInt8(2, 0); // ACL_REVISION
  acl.writeUInt16LE(aclSize, 2);
  acl.writeUInt16LE(sids.length, 4);
  let off = 8;
  sids.forEach((s, i) => {
    acl.writeUInt8(0, off); // ACCESS_ALLOWED_ACE_TYPE
    acl.writeUInt16LE(8 + sizes[i]!, off + 2);
    acl.writeUInt32LE(0x10000000, off + 4); // GENERIC_ALL
    const sidBytes = Buffer.from(toArrayBuffer(Number(s), 0, sizes[i]!));
    sidBytes.copy(acl, off + 8);
    off += 8 + sizes[i]!;
  });
  keep.push(acl);
  const dd = Buffer.alloc(8);
  dd.writeBigUInt64LE(BigInt(ptr(acl)), 0);
  const ok1 = adv.SetTokenInformation(tok, 6 /* TokenDefaultDacl */, ptr(dd), 8);
  if (!ok1) log(`SetTokenInformation(DefaultDacl) failed: ${err()}`);
  const ow = Buffer.alloc(8);
  ow.writeBigUInt64LE(us, 0);
  const ok2 = adv.SetTokenInformation(tok, 4 /* TokenOwner */, ptr(ow), 8);
  if (!ok2) log(`SetTokenInformation(Owner) failed: ${err()}`);
  return !!ok1;
}
const matrix: [string, number][] = [["noflags", 0], ["nowindow", 0x08000000], ["newconsole", 0x10], ["detached", DET]];
log("--- H: LUA_TOKEN|DISABLE_MAX_PRIVILEGE + default DACL/owner fixed");
const hTok = restricted(0x4 | 0x1);
if (hTok && fixDacl(hTok)) for (const [fn, fv] of matrix) runWith(`H-lua-dacl-${fn}`, hTok, false, fv);
log("--- I: same plus integrity Medium");
const iTok = restricted(0x4 | 0x1);
if (iTok && fixDacl(iTok) && setMedium(iTok)) for (const [fn, fv] of matrix) runWith(`I-lua-dacl-medium-${fn}`, iTok, false, fv);
k32.CloseHandle(own);
log("done");
