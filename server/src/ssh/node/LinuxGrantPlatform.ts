import { chown as chownDefault } from "node:fs/promises";
import { createPrivateFile, ensureInstanceFolder, ensureTopFolder, MAX_SOCKET_PATH, stageFits } from "./files";
import type { Chown } from "./files";
import type { ClientStatus, GrantPlatform, GrantSetup, Owner } from "./GrantPlatform";

export interface LinuxGrantPlatformOptions {
  /** The top folder of the grants. */
  dir: string;
  /** The user and group of an instance. When both are known, the files of its grants belong to them. */
  resolveUser?: (instanceId: string) => Owner | undefined;
  /** Changes the owner of a path. For tests. */
  chown?: Chown;
}

/** A Linux node: Unix sockets, folder modes 711 and 700, and files that belong to the instance user. */
export class LinuxGrantPlatform implements GrantPlatform {
  readonly windows = false;

  constructor(private readonly options: LinuxGrantPlatformOptions) {}

  socketFits(socketPath: string): boolean {
    return Buffer.byteLength(socketPath) <= MAX_SOCKET_PATH && stageFits(this.options.dir);
  }

  clientStatus(): Promise<ClientStatus> {
    return Promise.resolve({ ssh: Bun.which("ssh") !== null });
  }

  async prepare(folder: string, instanceId: string): Promise<GrantSetup> {
    const owner = this.options.resolveUser?.(instanceId);
    await ensureTopFolder(this.options.dir);
    await ensureInstanceFolder(folder, owner, this.options.chown ?? chownDefault);
    return owner ? { ok: true, owner } : { ok: true };
  }

  transport(): undefined {
    return undefined;
  }

  writePrivate(path: string, text: string, owner?: Owner): Promise<void> {
    return createPrivateFile(path, text, owner, this.options.chown);
  }
}
