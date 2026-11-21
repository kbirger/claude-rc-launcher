/** An id in authentik: a UUID text for most objects, a number for providers and users. */
export type Pk = string | number;

/** The fields of an authentik API object that the scripts read. Other fields stay `unknown`. */
export interface Json {
  pk?: Pk;
  name?: string;
  slug?: string;
  username?: string;
  managed?: string;
  expression?: string;
  scope_name?: string;
  property_mappings?: string[];
  client_type?: string;
  client_id?: string;
  client_secret?: string;
  signing_key?: string;
  authorization_flow?: string;
  invalidation_flow?: string;
  redirect_uris?: unknown;
  provider?: Pk;
  attributes?: Record<string, unknown>;
  users?: Pk[];
  group?: Pk;
  policy_engine_mode?: string;
  user_obj?: { username?: string };
  group_obj?: { name?: string };
  policy_obj?: { name?: string };
  /** A list reply holds its objects here. */
  results?: Json[];
  [key: string]: unknown;
}

/** The text of an id, when the id is text. The ids of scope mappings, flows, and key pairs are UUIDs. */
export const textOf = (pk: Pk | undefined): string | undefined => (typeof pk === "string" ? pk : undefined);

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
  call(method: string, path: string, body?: unknown): Promise<Json | undefined>;
  write(what: string, method: string, path: string, body?: unknown): Promise<Json | undefined>;
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

  async function call(method: string, path: string, body?: unknown): Promise<Json | undefined> {
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
    return text ? (JSON.parse(text) as Json) : undefined;
  }

  async function write(what: string, method: string, path: string, body?: unknown): Promise<Json | undefined> {
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
    return reply?.results?.find((json) => json[key] === value);
  };

  return { call, write, find, log, apply: ctxOptions.apply, changes: () => changes, problems: [], url: base };
}
