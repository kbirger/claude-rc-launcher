/** A frame that is too big or a request that is cut short or malformed. The caller should close the connection. */
export class AgentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentProtocolError";
  }
}
