// Starts a process with a restricted copy of this process's own token (UAC-like): the Administrators group is
// deny-only, integrity is Medium and only SeChangeNotifyPrivilege is left. Windows only; no helper program.
// dlopen runs inside functions only, so this file imports safely on Linux.
import { dlopen, ptr, toArrayBuffer } from "bun:ffi";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Spawned, WinDeps } from "./instances";

/** A token step failed. Permanent: trying again cannot help, and there is no fallback to the full token. */
export class RestrictedTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestrictedTokenError";
  }
}

const TOKEN_ALL_ACCESS = 0xf01ff;
const LUA_TOKEN = 0x4;
const DISABLE_MAX_PRIVILEGE = 0x1;
const TOKEN_OWNER = 4;
const TOKEN_DEFAULT_DACL = 6;
const TOKEN_INTEGRITY_LEVEL = 25;
const SE_GROUP_INTEGRITY = 0x20;
const GENERIC_ALL = 0x10000000;
const GENERIC_READ = 0x80000000;
const FILE_APPEND_DATA = 0x4;
const FILE_SHARE_READ_WRITE = 0x3;
const OPEN_ALWAYS = 4;
const OPEN_EXISTING = 3;
const STARTF_USESTDHANDLES = 0x100;
const EXTENDED_STARTUPINFO_PRESENT = 0x80000;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002;
const WAIT_TIMEOUT = 0x102;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const CREATE_NO_WINDOW = 0x08000000;
const WAIT_OBJECT_0 = 0;
const POLL_MS = 250;
const INVALID_HANDLE = 0xffffffffffffffffn;

let libs: ReturnType<typeof load> | undefined;
function load() {
  const k32 = dlopen("kernel32.dll", {
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetCurrentProcess: { args: [], returns: "u64" },
    WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
    GetExitCodeProcess: { args: ["u64", "ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    LocalFree: { args: ["u64"], returns: "u64" },
    InitializeProcThreadAttributeList: { args: ["ptr", "u32", "u32", "ptr"], returns: "i32" },
    UpdateProcThreadAttribute: { args: ["ptr", "u32", "u64", "ptr", "u64", "ptr", "ptr"], returns: "i32" },
    DeleteProcThreadAttributeList: { args: ["ptr"], returns: "void" },
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
  }).symbols;
  const adv = dlopen("advapi32.dll", {
    OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
    GetTokenInformation: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
    SetTokenInformation: { args: ["u64", "u32", "ptr", "u32"], returns: "i32" },
    CreateRestrictedToken: { args: ["u64", "u32", "u32", "ptr", "u32", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    ConvertStringSidToSidW: { args: ["ptr", "ptr"], returns: "i32" },
    GetLengthSid: { args: ["u64"], returns: "u32" },
    CheckTokenMembership: { args: ["u64", "u64", "ptr"], returns: "i32" },
    CreateProcessAsUserW: { args: ["u64", "ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  }).symbols;
  const user = dlopen("userenv.dll", {
    CreateEnvironmentBlock: { args: ["ptr", "u64", "i32"], returns: "i32" },
    DestroyEnvironmentBlock: { args: ["u64"], returns: "i32" },
  }).symbols;
  return { k32, adv, user };
}
const api = () => (libs ??= load());

const wide = (s: string) => Buffer.from(s + "\0", "utf16le");

/** Quotes one argument by the rules of CommandLineToArgvW. */
function quoteArg(a: string): string {
  if (a !== "" && !/[\s"]/.test(a)) return a;
  let out = '"';
  let slashes = 0;
  for (const ch of a) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    if (ch === '"') out += "\\".repeat(slashes * 2 + 1) + '"';
    else out += "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  return out + "\\".repeat(slashes * 2) + '"';
}

/** What the service token is. "unknown" means the check itself failed: that is not the same as "standard". */
export type AdminState = { state: "admin" } | { state: "standard" } | { state: "unknown"; reason: string };

/** Asks whether the Administrators group is enabled in this process's token. Off Windows the answer is "standard". */
export function serviceAdminState(): AdminState {
  if (process.platform !== "win32") return { state: "standard" };
  try {
    const { k32, adv } = api();
    const psid = new BigUint64Array(1);
    const sidStr = wide("S-1-5-32-544");
    if (!adv.ConvertStringSidToSidW(ptr(sidStr), ptr(psid))) {
      return { state: "unknown", reason: `ConvertStringSidToSidW failed (error ${k32.GetLastError()})` };
    }
    try {
      const member = new Uint32Array(1);
      if (!adv.CheckTokenMembership(0n, psid[0]!, ptr(member))) {
        return { state: "unknown", reason: `CheckTokenMembership failed (error ${k32.GetLastError()})` };
      }
      return { state: member[0] !== 0 ? "admin" : "standard" };
    } finally {
      k32.LocalFree(psid[0]!);
    }
  } catch (e) {
    return { state: "unknown", reason: `token module cannot load: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** True when the Administrators group is enabled in this process's token. False when not, on failure and off Windows. */
export function serviceIsAdmin(): boolean {
  return serviceAdminState().state === "admin";
}

/**
 * Decides how sessions start. Fails closed: when the check could not tell, the node still offers the restricted
 * default and the (admin) entry, and restricted starts fail with the reason. It never runs sessions with the full token silently.
 */
export function planSessions(
  s: AdminState,
  makeRestricted: () => WinDeps["spawn"] = restrictedSpawn,
): { serviceIsAdmin: boolean; spawnRestricted?: WinDeps["spawn"]; log: string } {
  if (s.state === "admin") {
    return { serviceIsAdmin: true, spawnRestricted: makeRestricted(), log: "sessions run restricted by default (service account is an administrator)" };
  }
  if (s.state === "standard") {
    return { serviceIsAdmin: false, log: "sessions run as the service account (no administrator rights to drop)" };
  }
  const reason = s.reason;
  return {
    serviceIsAdmin: true,
    spawnRestricted: () => {
      throw new RestrictedTokenError(`cannot tell whether the service is an administrator: ${reason}`);
    },
    log: `cannot tell whether the service account is an administrator (${reason}): restricted sessions will fail, use the (admin) entry`,
  };
}

/** Builds the restricted token. The caller closes it. Throws RestrictedTokenError. */
function buildToken(): bigint {
  const { k32, adv } = api();
  const frees: bigint[] = [];
  const closeOnFail: bigint[] = [];
  const keep: unknown[] = []; // buffers whose addresses are used later: they must stay reachable until the end
  const fail = (what: string): never => {
    throw new RestrictedTokenError(`${what} failed (error ${k32.GetLastError()})`);
  };
  const sid = (s: string): bigint => {
    const p = new BigUint64Array(1);
    const sw = wide(s);
    if (!adv.ConvertStringSidToSidW(ptr(sw), ptr(p))) fail(`ConvertStringSidToSidW ${s}`);
    frees.push(p[0]!);
    return p[0]!;
  };
  try {
    const h = new BigUint64Array(1);
    if (!adv.OpenProcessToken(k32.GetCurrentProcess(), TOKEN_ALL_ACCESS, ptr(h))) fail("OpenProcessToken");
    const own = h[0]!;
    closeOnFail.push(own);

    const need = new Uint32Array(1);
    adv.GetTokenInformation(own, 1 /* TokenUser */, null, 0, ptr(need));
    const tu = Buffer.alloc(need[0]!);
    if (!need[0] || !adv.GetTokenInformation(own, 1, ptr(tu), tu.length, ptr(need))) fail("GetTokenInformation(TokenUser)");
    keep.push(tu);
    const userSid = tu.readBigUInt64LE(0); // points into tu

    const o = new BigUint64Array(1);
    if (!adv.CreateRestrictedToken(own, LUA_TOKEN | DISABLE_MAX_PRIVILEGE, 0, null, 0, null, 0, null, ptr(o))) fail("CreateRestrictedToken");
    const tok = o[0]!;
    closeOnFail.push(tok);
    k32.CloseHandle(own);
    closeOnFail.splice(closeOnFail.indexOf(own), 1);

    // Default DACL and owner: the user and SYSTEM. Without this the child cannot open its own token.
    const sids = [userSid, sid("S-1-5-18")];
    const sizes = sids.map((s) => adv.GetLengthSid(s));
    const aclSize = 8 + sizes.reduce((a, n) => a + 8 + n, 0);
    const acl = Buffer.alloc(aclSize);
    acl.writeUInt8(2, 0); // ACL_REVISION
    acl.writeUInt16LE(aclSize, 2);
    acl.writeUInt16LE(sids.length, 4);
    let off = 8;
    sids.forEach((s, i) => {
      acl.writeUInt8(0, off); // ACCESS_ALLOWED_ACE_TYPE
      acl.writeUInt16LE(8 + sizes[i]!, off + 2);
      acl.writeUInt32LE(GENERIC_ALL, off + 4);
      Buffer.from(toArrayBuffer(Number(s), 0, sizes[i]!)).copy(acl, off + 8);
      off += 8 + sizes[i]!;
    });
    keep.push(acl); // its address goes into dd
    const dd = Buffer.alloc(8);
    dd.writeBigUInt64LE(BigInt(ptr(acl)), 0);
    if (!adv.SetTokenInformation(tok, TOKEN_DEFAULT_DACL, ptr(dd), 8)) fail("SetTokenInformation(DefaultDacl)");
    const ow = Buffer.alloc(8);
    ow.writeBigUInt64LE(userSid, 0);
    if (!adv.SetTokenInformation(tok, TOKEN_OWNER, ptr(ow), 8)) fail("SetTokenInformation(Owner)");

    // LUA_TOKEN leaves integrity at High: lower it to Medium.
    const tml = Buffer.alloc(16);
    tml.writeBigUInt64LE(sid("S-1-16-8192"), 0);
    tml.writeUInt32LE(SE_GROUP_INTEGRITY, 8);
    if (!adv.SetTokenInformation(tok, TOKEN_INTEGRITY_LEVEL, ptr(tml), 16)) fail("SetTokenInformation(IntegrityLevel)");

    closeOnFail.length = 0;
    return tok;
  } catch (e) {
    for (const hd of closeOnFail) k32.CloseHandle(hd);
    if (e instanceof RestrictedTokenError) throw e;
    throw new RestrictedTokenError(`token step failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    for (const p of frees) k32.LocalFree(p);
    void keep;
  }
}

/** Starts each child with a restricted copy of this process's token. Output goes to `logFile` (appended). */
export function restrictedSpawn(): WinDeps["spawn"] {
  return (cmd, args, { cwd, logFile }): Spawned => {
    if (process.platform !== "win32") throw new RestrictedTokenError("restricted sessions need Windows");
    const { k32, adv, user } = api();
    mkdirSync(dirname(logFile), { recursive: true });
    const opened: bigint[] = [];
    const closeAll = () => {
      for (const h of opened) k32.CloseHandle(h);
      opened.length = 0;
    };
    try {
      const token = buildToken();
      opened.push(token);

      let env = 0n;
      try {
        const pe = new BigUint64Array(1);
        if (!user.CreateEnvironmentBlock(ptr(pe), token, 0)) {
          throw new RestrictedTokenError(`CreateEnvironmentBlock failed (error ${k32.GetLastError()})`);
        }
        env = pe[0]!;

        // Inheritable handles: NUL for stdin, the log file for stdout and stderr.
        const sa = Buffer.alloc(24); // SECURITY_ATTRIBUTES: nLength, lpSecurityDescriptor, bInheritHandle
        sa.writeUInt32LE(24, 0);
        sa.writeUInt32LE(1, 16);
        const nulW = wide("NUL");
        const hIn = k32.CreateFileW(ptr(nulW), GENERIC_READ, FILE_SHARE_READ_WRITE, ptr(sa), OPEN_EXISTING, 0, 0n);
        if (hIn === INVALID_HANDLE || hIn === 0n) throw new Error(`cannot open NUL (error ${k32.GetLastError()})`);
        opened.push(hIn);
        const logW = wide(logFile);
        const hOut = k32.CreateFileW(ptr(logW), FILE_APPEND_DATA, FILE_SHARE_READ_WRITE, ptr(sa), OPEN_ALWAYS, 0, 0n);
        if (hOut === INVALID_HANDLE || hOut === 0n) throw new Error(`cannot open log file ${logFile} (error ${k32.GetLastError()})`);
        opened.push(hOut);

        // Only hIn and hOut are inherited: an explicit handle list, not every inheritable handle of the service.
        const handles = new BigUint64Array([hIn, hOut]);
        const need = new BigUint64Array(1);
        k32.InitializeProcThreadAttributeList(null, 1, 0, ptr(need)); // fails by design and reports the size
        const attrs = Buffer.alloc(Number(need[0]!));
        if (!need[0] || !k32.InitializeProcThreadAttributeList(ptr(attrs), 1, 0, ptr(need))) {
          throw new Error(`InitializeProcThreadAttributeList failed (error ${k32.GetLastError()})`);
        }
        let pi: Buffer;
        try {
          if (!k32.UpdateProcThreadAttribute(ptr(attrs), 0, BigInt(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), ptr(handles), 16n, null, null)) {
            throw new Error(`UpdateProcThreadAttribute failed (error ${k32.GetLastError()})`);
          }
          const si = Buffer.alloc(112); // STARTUPINFOEXW: STARTUPINFOW (104) + lpAttributeList
          si.writeUInt32LE(112, 0);
          si.writeUInt32LE(STARTF_USESTDHANDLES, 60);
          si.writeBigUInt64LE(hIn, 80);
          si.writeBigUInt64LE(hOut, 88);
          si.writeBigUInt64LE(hOut, 96);
          si.writeBigUInt64LE(BigInt(ptr(attrs)), 104);
          pi = Buffer.alloc(24); // PROCESS_INFORMATION: hProcess, hThread, dwProcessId, dwThreadId
          const cmdline = wide([cmd, ...args].map(quoteArg).join(" "));
          const cwdW = wide(cwd);
          const ok = adv.CreateProcessAsUserW(
            token, null, ptr(cmdline), null, null, 1,
            CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, env, ptr(cwdW), ptr(si), ptr(pi),
          );
          void [handles, cmdline, cwdW, si, sa, nulW, logW]; // keep alive until CreateProcessAsUserW returned
          if (!ok) throw new Error(`CreateProcessAsUserW failed for ${cmd} (error ${k32.GetLastError()})`);
        } finally {
          k32.DeleteProcThreadAttributeList(ptr(attrs));
        }
        const hp = pi.readBigUInt64LE(0);
        k32.CloseHandle(pi.readBigUInt64LE(8));
        const pid = pi.readUInt32LE(16);

        const exited = new Promise<number>((resolve) => {
          const code = new Uint32Array(1);
          const tick = () => {
            const w = k32.WaitForSingleObject(hp, 0);
            if (w === WAIT_TIMEOUT) return void setTimeout(tick, POLL_MS);
            // Signaled: read the exit code. Any other result (WAIT_FAILED) ends the polling with -1.
            const got = w === WAIT_OBJECT_0 && k32.GetExitCodeProcess(hp, ptr(code));
            k32.CloseHandle(hp);
            resolve(got ? code[0]! : -1);
          };
          setTimeout(tick, POLL_MS);
        });
        return { pid, exited };
      } finally {
        if (env) user.DestroyEnvironmentBlock(env);
      }
    } finally {
      closeAll(); // the child has its own copies of the token and the inherited handles
    }
  };
}
