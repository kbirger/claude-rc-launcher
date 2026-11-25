import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { join } from "node:path";
import type { AgentTransport } from "../sshnodeagent";

// Named pipes for the SSH agent of a grant on a Windows node. The pipe is served by node:net. A pipe that the full
// service token makes has no entry for the service user alone, and a restricted session cannot open it. So after
// `listen`, the node sets the access list of the pipe by name: SYSTEM and the service user, nothing inherited.
// `bun:ffi` loads inside functions only, so this file imports safely on Linux.

/** The prefix of every pipe name: the Win32 form that `ssh.exe` and `node:net` accept. */
export const PIPE_PREFIX = "\\\\.\\pipe\\";
/** The Windows ssh-agent service owns this name. A pipe of ours never has it. */
const SERVICE_PIPE = "openssh-ssh-agent";
const PIPE_LEAF = /^[A-Za-z0-9._-]{1,200}$/;
const SID = /^S-1-\d+(-\d+)+$/;

/** A new random pipe name, such as `\\.\pipe\claude-rc-agent-<32 hex digits>`. */
export function newPipeName(kind: string): string {
  if (!/^[a-z-]{1,20}$/.test(kind)) throw new Error("the pipe kind holds a bad character");
  return `${PIPE_PREFIX}claude-rc-${kind}-${randomBytes(16).toString("hex")}`;
}

/** Throws unless the name is one of ours. */
export function assertPipeName(name: string): void {
  if (!name.startsWith(PIPE_PREFIX)) throw new Error("a pipe name starts with \\\\.\\pipe\\");
  const leaf = name.slice(PIPE_PREFIX.length);
  if (!PIPE_LEAF.test(leaf) || /^\.+$/.test(leaf)) throw new Error("the pipe name holds a bad character");
  if (leaf.toLowerCase().includes(SERVICE_PIPE)) throw new Error("the pipe name clashes with the Windows ssh-agent");
}

/** The access list text: SYSTEM and one user get full control, nothing is inherited. */
export function pipeSddl(sid: string): string {
  if (!SID.test(sid)) throw new Error("the user SID has a bad form");
  return `D:P(A;;GA;;;SY)(A;;GA;;;${sid})`;
}

/** The SID of the user that runs this process. */
export function currentUserSid(): string {
  // The full path matters: another `whoami` can come first on the PATH (Git for Windows has one that takes no /user).
  const exe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
  const line = execFileSync(exe, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).trim();
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(line)?.[1];
  if (!sid) throw new Error("could not read the user SID");
  return sid;
}

const SE_FILE_OBJECT = 1;
const DACL_SECURITY_INFORMATION = 4;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
const SDDL_REVISION_1 = 1;

const wide = (text: string) => Buffer.from(text + "\0", "utf16le");

/** Sets the access list of a named pipe by name. Throws on a Windows error. Windows only. */
export async function restrictPipe(pipeName: string, sid: string): Promise<void> {
  assertPipeName(pipeName);
  const sddl = pipeSddl(sid);
  const { dlopen, ptr } = await import("bun:ffi");
  const adv = dlopen("advapi32.dll", {
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
    GetSecurityDescriptorDacl: { args: ["u64", "ptr", "ptr", "ptr"], returns: "i32" },
    SetNamedSecurityInfoW: { args: ["ptr", "u32", "u32", "ptr", "ptr", "u64", "ptr"], returns: "u32" },
  }).symbols;
  const k32 = dlopen("kernel32.dll", { LocalFree: { args: ["u64"], returns: "u64" } }).symbols;
  const descriptor = new BigUint64Array(1);
  // `ptr` keeps only the address. These buffers stay in local variables until the end, so the garbage collector keeps them.
  const sddlText = wide(sddl);
  const pipeText = wide(pipeName);
  if (!adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(ptr(sddlText), SDDL_REVISION_1, ptr(descriptor), null))
    throw new Error("could not build the pipe access list");

  try {
    const present = new Int32Array(1);
    const defaulted = new Int32Array(1);
    const dacl = new BigUint64Array(1);
    if (!adv.GetSecurityDescriptorDacl(descriptor[0], ptr(present), ptr(dacl), ptr(defaulted)) || !present[0])
      throw new Error("could not read the pipe access list");
    const code = adv.SetNamedSecurityInfoW(
      ptr(pipeText),
      SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      null,
      null,
      dacl[0],
      null,
    );
    if (code !== 0) throw new Error(`could not set the pipe access list (Windows error ${code})`);
  } finally {
    k32.LocalFree(descriptor[0]);
    // Reading the buffers here ends their life after the native calls.
    sddlText.length + pipeText.length;
  }
}

export interface PipeTransportOptions {
  /** The full pipe name. `newPipeName` makes one. */
  name: string;
  /** The SID of the service user. Default: the user of this process. */
  sid?: string;
  /** Sets the access list. Tests give a recorder. Default: `restrictPipe`. */
  restrict?: (name: string, sid: string) => Promise<void>;
}

/**
 * The agent transport for a named pipe. A failed start closes the server, so no pipe is left. The pipe name goes to
 * the caller only after the access list is set.
 */
export function pipeTransport(options: PipeTransportOptions): AgentTransport {
  return {
    async listen(accept) {
      assertPipeName(options.name);
      // Read the SID before the pipe exists: this call blocks and can fail, and the pipe must not wait for it.
      const sid = options.sid ?? currentUserSid();
      const sockets = new Set<Socket>();
      // The pipe has the default access list from `listen` until `restrict` returns. A connection that arrives in that
      // time is closed. The call of `restrict` opens the pipe by name once itself, and that connection ends here too.
      let restricted = false;
      const server: Server = createServer((socket) => {
        socket.on("error", () => {});

        if (!restricted) {
          socket.destroy();
          return;
        }

        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        const handler = accept({
          write: (bytes) => void socket.write(bytes),
          end: () => void socket.end(),
        });
        socket.on("data", (chunk: Buffer) => {
          handler.data(new Uint8Array(chunk));
        });
      });

      const stop = async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        );
      };

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.name, () => {
          server.off("error", reject);
          resolve();
        });
      });

      try {
        await (options.restrict ?? restrictPipe)(options.name, sid);
        restricted = true;
      } catch (error) {
        await stop();
        throw error;
      }

      return { path: options.name, stop };
    },
  };
}
