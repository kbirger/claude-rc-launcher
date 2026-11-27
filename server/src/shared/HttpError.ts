/** An error that a route answers with `status` and the message. `extra` adds fields to the JSON answer. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: object,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
