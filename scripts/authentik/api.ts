export type Json = Record<string, any>;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CtxOptions {
  url: string;
  token: string;
  apply: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

/** One API client. A change is only described when `apply` is false. The token is never logged. */
export interface Ctx {
  call(method: string, path: string, body?: unknown): Promise<any>;
  write(what: string, method: string, path: string, body?: unknown): Promise<any>;
  find(path: string, key: string, value: string): Promise<Json | undefined>;
  log(line: string): void;
  apply: boolean;
  changes(): number;
  problems: string[];
  url: string;
}

export function makeCtx(ctxOptions: CtxOptions): Ctx {
  const log =
    ctxOptions.log ??
    ((line: string) => {
      console.log(line);
    });
  const fetchImpl = ctxOptions.fetch ?? fetch;
  const base = ctxOptions.url.replace(/\/+$/, "");
  let changes = 0;

  async function call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ctxOptions.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, `${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  }

  async function write(what: string, method: string, path: string, body?: unknown): Promise<any> {
    changes++;

    if (!ctxOptions.apply) {
      log(`would ${what}`);
      return undefined;
    }

    const reply = await call(method, path, body);
    log(`done: ${what}`);
    return reply;
  }

  const find = async (path: string, key: string, value: string): Promise<Json | undefined> => {
    const reply = await call("GET", `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`);
    return (reply?.results as Json[] | undefined)?.find((json) => json[key] === value);
  };

  return { call, write, find, log, apply: ctxOptions.apply, changes: () => changes, problems: [], url: base };
}
