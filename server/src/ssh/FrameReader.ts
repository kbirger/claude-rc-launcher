import { concat, MAX_FRAME } from "./agentproto";
import { AgentProtocolError } from "./AgentProtocolError";

/** Cuts a byte stream into frames. A frame that is not complete yet stays in the buffer until the next chunk. */
export class FrameReader {
  private buffer: Uint8Array = new Uint8Array(0);

  /** Returns every payload that is complete now. Throws when a frame announces more than MAX_FRAME bytes. */
  push(chunk: Uint8Array): Uint8Array[] {
    this.buffer = this.buffer.length === 0 ? chunk : concat([this.buffer, chunk]);
    const out: Uint8Array[] = [];

    for (;;) {
      if (this.buffer.length < 4) break;
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(0);
      if (length > MAX_FRAME) throw new AgentProtocolError(`frame of ${length} bytes is over the limit`);
      if (this.buffer.length < 4 + length) break;
      out.push(this.buffer.slice(4, 4 + length));
      this.buffer = this.buffer.subarray(4 + length);
    }

    // Copy what is left, so that the buffer never holds on to the caller's chunk.
    this.buffer = this.buffer.slice();
    return out;
  }
}
