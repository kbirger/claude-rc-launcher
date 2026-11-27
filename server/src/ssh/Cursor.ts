import { AgentProtocolError } from "./AgentProtocolError";

/** Reads fields from a payload and throws AgentProtocolError when a field is cut. */
export class Cursor {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}

  u32(): number {
    if (this.at + 4 > this.bytes.length) throw new AgentProtocolError("request is cut short");
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.at, 4).getUint32(0);
    this.at += 4;
    return value;
  }

  string(): Uint8Array {
    const length = this.u32();
    if (this.at + length > this.bytes.length) throw new AgentProtocolError("request is cut short");
    const value = this.bytes.slice(this.at, this.at + length);
    this.at += length;
    return value;
  }
}
