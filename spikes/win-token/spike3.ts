// THROWAWAY SPIKE 3. Runs an arbitrary command line under a UAC-like restricted copy of this process's own token
// (see spike2.ts for why each step is needed). Usage: spike3.exe <restricted|own> <outfile> <command line...>
// The command runs via "cmd /d /c <command line> > <outfile> 2>&1" and spike3 exits with the command's exit code.
import { dlopen, ptr, toArrayBuffer } from "bun:ffi";

const [mode, outFile, ...rest] = process.argv.slice(2);
if (!mode || !outFile || rest.length === 0) {
  console.error("usage: spike3 <restricted|own> <outfile> <command line...>");
  process.exit(2);
}
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
  CreateRestrictedToken: { args: ["u64", "u32", "u32", "ptr", "u32", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
  ConvertStringSidToSidW: { args: ["ptr", "ptr"], returns: "i32" },
  GetLengthSid: { args: ["u64"], returns: "u32" },
  CreateProcessAsUserW: { args: ["u64", "ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
}).symbols;
const wide = (s: string) => Buffer.from(s + "\0", "utf16le");
const keep: unknown[] = [];
const die = (m: string): never => {
  console.error(`${m} (error ${k32.GetLastError()})`);
  process.exit(3);
};

const h = new BigUint64Array(1);
if (!adv.OpenProcessToken(k32.GetCurrentProcess(), 0xf01ff, ptr(h))) die("OpenProcessToken failed");
const own = h[0]!;

function sid(s: string): bigint {
  const p = new BigUint64Array(1);
  if (!adv.ConvertStringSidToSidW(ptr(wide(s)), ptr(p))) die(`bad sid ${s}`);
  return p[0]!;
}
function userSid(): bigint {
  const need = new Uint32Array(1);
  adv.GetTokenInformation(own, 1, null, 0, ptr(need));
  const buf = Buffer.alloc(need[0]!);
  adv.GetTokenInformation(own, 1, ptr(buf), buf.length, ptr(need));
  keep.push(buf);
  return buf.readBigUInt64LE(0);
}

function restrictedToken(): bigint {
  const o = new BigUint64Array(1);
  // LUA_TOKEN (4) | DISABLE_MAX_PRIVILEGE (1)
  if (!adv.CreateRestrictedToken(own, 0x5, 0, null, 0, null, 0, null, ptr(o))) die("CreateRestrictedToken failed");
  const tok = o[0]!;
  // Default DACL + owner = the user and SYSTEM, so the child can open its own token (Administrators is deny-only now).
  const us = userSid();
  const sids = [us, sid("S-1-5-18")];
  const sizes = sids.map((s) => adv.GetLengthSid(s));
  const size = 8 + sizes.reduce((a, n) => a + 8 + n, 0);
  const acl = Buffer.alloc(size);
  acl.writeUInt8(2, 0);
  acl.writeUInt16LE(size, 2);
  acl.writeUInt16LE(sids.length, 4);
  let off = 8;
  sids.forEach((s, i) => {
    acl.writeUInt8(0, off);
    acl.writeUInt16LE(8 + sizes[i]!, off + 2);
    acl.writeUInt32LE(0x10000000, off + 4);
    Buffer.from(toArrayBuffer(Number(s), 0, sizes[i]!)).copy(acl, off + 8);
    off += 8 + sizes[i]!;
  });
  const dd = Buffer.alloc(8);
  dd.writeBigUInt64LE(BigInt(ptr(acl)), 0);
  if (!adv.SetTokenInformation(tok, 6, ptr(dd), 8)) die("SetTokenInformation(DefaultDacl) failed");
  const ow = Buffer.alloc(8);
  ow.writeBigUInt64LE(us, 0);
  if (!adv.SetTokenInformation(tok, 4, ptr(ow), 8)) die("SetTokenInformation(Owner) failed");
  // Integrity: Medium
  const tml = Buffer.alloc(16);
  tml.writeBigUInt64LE(sid("S-1-16-8192"), 0);
  tml.writeUInt32LE(0x20, 8);
  if (!adv.SetTokenInformation(tok, 25, ptr(tml), 16)) die("SetTokenInformation(IntegrityLevel) failed");
  keep.push(acl, dd, ow, tml);
  return tok;
}

const token = mode === "restricted" ? restrictedToken() : own;
const si = Buffer.alloc(104);
si.writeUInt32LE(104, 0);
const pi = Buffer.alloc(24);
const cmd = wide(`cmd.exe /d /c ${rest.join(" ")} > "${outFile}" 2>&1`);
// No console flags: the child inherits this process's console (or gets its own), as in spike2's working mode.
if (!adv.CreateProcessAsUserW(token, null, ptr(cmd), null, null, 0, 0, null, null, ptr(si), ptr(pi))) die("CreateProcessAsUserW failed");
const hp = pi.readBigUInt64LE(0);
const wait = k32.WaitForSingleObject(hp, 10 * 60 * 1000);
const code = new Uint32Array(1);
k32.GetExitCodeProcess(hp, ptr(code));
console.log(`mode=${mode} pid=${pi.readUInt32LE(16)} wait=${wait} exit=${code[0]}`);
process.exit(code[0]!);
