export type Json = Record<string, any>;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type CtxOptions = { url: string; token: string; apply: boolean; fetch?: typeof fetch; log?: (line: string) => void };

/** One API client. A change is only described when `apply` is false. The token is never logged. */
export type Ctx = {
  call(method: string, path: string, body?: unknown): Promise<any>;
  write(what: string, method: string, path: string, body?: unknown): Promise<any>;
  find(path: string, key: string, value: string): Promise<Json | undefined>;
  log(line: string): void;
  apply: boolean;
  changes(): number;
  problems: string[];
};

export function makeCtx(o: CtxOptions): Ctx {
  const log = o.log ?? ((l: string) => console.log(l));
  const f = o.fetch ?? fetch;
  const base = o.url.replace(/\/+$/, "");
  let changes = 0;
  async function call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await f(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${o.token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, `${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  }
  async function write(what: string, method: string, path: string, body?: unknown): Promise<any> {
    changes++;
    if (!o.apply) {
      log(`would ${what}`);
      return undefined;
    }
    const r = await call(method, path, body);
    log(`done: ${what}`);
    return r;
  }
  const find = async (path: string, key: string, value: string): Promise<Json | undefined> => {
    const r = await call("GET", `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`);
    return (r?.results as Json[] | undefined)?.find((x) => x[key] === value);
  };
  return { call, write, find, log, apply: o.apply, changes: () => changes, problems: [] };
}
