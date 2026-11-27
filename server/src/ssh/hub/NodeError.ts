/** A node that cannot be reached, or that answers with an error, when the hub asks it for something (502 for a route). */
export class NodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeError";
  }
}
