import { ensurePrivateFolder, writeGrantFile } from "../../win/sshfiles";
import type { RunIcacls } from "../../win/sshfiles";
import type { AgentTransport } from "./GrantAgent";
import type { ClientStatus, GrantPlatform, GrantSetup } from "./GrantPlatform";

/** What a Windows node adds to the grant routes. The agent is a named pipe and the files get access lists. */
export interface WindowsGrantOptions {
  /** The SID of the service user. The folders and the pipes give access to it, to SYSTEM and to Administrators only. */
  sid: string;
  /** The checked client. A reason in plain English when there is none. Runs before each grant. */
  checkClient: () => Promise<{ ok: true; sshPath: string } | { ok: false; reason: string }>;
  /** The transport of the agent of one grant: a named pipe with its own name. */
  agentTransport: (grantId: string) => AgentTransport;
  /** Runs icacls. For tests. */
  runIcacls?: RunIcacls;
}

/** A Windows node: named pipes, folders with an access list, and a checked `ssh.exe`. No file has an instance owner. */
export class WindowsGrantPlatform implements GrantPlatform {
  readonly windows = true;

  constructor(
    private readonly dir: string,
    private readonly options: WindowsGrantOptions,
  ) {}

  /** A named pipe has no such limit. */
  socketFits(): boolean {
    return true;
  }

  async clientStatus(): Promise<ClientStatus> {
    const client = await this.options.checkClient();
    return client.ok ? { ssh: true } : { ssh: false, reason: client.reason };
  }

  async prepare(folder: string): Promise<GrantSetup> {
    // The client is checked before each grant: it can change after the start.
    const client = await this.options.checkClient();
    if (!client.ok) return { ok: false, reason: client.reason };
    await ensurePrivateFolder(this.dir, this.options.sid, this.options.runIcacls);
    await ensurePrivateFolder(folder, this.options.sid, this.options.runIcacls);
    return { ok: true, sshPath: client.sshPath };
  }

  transport(grantId: string): AgentTransport {
    return this.options.agentTransport(grantId);
  }

  writePrivate(path: string, text: string): Promise<void> {
    return writeGrantFile(path, text);
  }
}
