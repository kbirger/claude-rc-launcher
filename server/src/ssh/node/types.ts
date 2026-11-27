import type { NodeEvents } from "../../hosts";
import type { IdentityFor } from "../../shared/asuser";
import type { RunAs, SshdReads } from "./ManagedKeyInstaller";
import type { SshBroker } from "./SshBroker";
import type { WindowsGrantOptions } from "./WindowsGrantPlatform";

// The options of the grant routes (`sshNodeApi`) and of the managed target routes (`sshManagedApi`). The node wiring
// builds them, so they sit with the node code and not in the route file.

export interface SshNodeOptions {
  /** The folder for the sockets and the files of the grants. The routes create it with mode 711. Each instance gets its own folder inside it with mode 700. */
  dir: string;
  events: NodeEvents;
  broker: SshBroker;
  /** The user and group of an instance. When both are known, the files of its grants belong to them. */
  resolveUser?: (instanceId: string) => { uid: number; gid: number } | undefined;
  /** The host keys of a server as `<type> <base64>` lines. */
  keyscan?: (address: string, port: number) => Promise<string[]>;
  probe?: (config: string, targetId: string) => Promise<{ code: number; stderr: string }>;
  signTimeoutMs?: number;
  /** Changes the owner of a path. For tests. */
  chown?: (path: string, uid: number, gid: number) => Promise<void>;
  /** Set on a Windows node. */
  windows?: WindowsGrantOptions;
}

export interface SshManagedOptions {
  /** The sshd host key file. Default: the Ed25519 key of sshd on Linux and on Windows. */
  hostKeyFile?: string;
  /** Runs a provisioning script as the account. For tests. The default runs `sh -s` or PowerShell with the script on stdin. */
  runAs?: RunAs;
  /** The user switch for the default `runAs` on Linux. It rejects an account that does not exist with a 400. */
  identityFor?: IdentityFor;
  /** Asks sshd whether it reads a key file. For tests. The default: `defaultSshdReads` with the sshd of the machine. */
  sshdReads?: SshdReads;
}
