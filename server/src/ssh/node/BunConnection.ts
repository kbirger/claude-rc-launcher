import type { Socket } from "bun";
import type { RawConnection } from "./GrantAgent";

/** A Bun socket with a queue for the bytes that the socket did not take. */
export class BunConnection implements RawConnection {
  private pending: Uint8Array = new Uint8Array(0);

  constructor(private readonly socket: Socket<unknown>) {}

  write(bytes: Uint8Array): void {
    const next = new Uint8Array(this.pending.length + bytes.length);
    next.set(this.pending);
    next.set(bytes, this.pending.length);
    this.pending = next;
    this.flush();
  }

  end(): void {
    this.socket.end();
  }

  flush(): void {
    if (this.pending.length === 0) return;
    const written = this.socket.write(this.pending);
    if (written < 0) return;
    this.pending = this.pending.subarray(written);
  }
}
