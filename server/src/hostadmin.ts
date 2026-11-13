import { isIP } from "node:net";
import { Hono, type MiddlewareHandler } from "hono";
import { PeekError, peekCertificate } from "./certpeek";
import { hostUrlProblem } from "./config";
import { HostError, type HostClient, type HostConfig } from "./hostclient";
import { HOST_ID_RE } from "./hostid";
import type { HostRegistry } from "./hostregistry";
import { HttpError } from "./instances";
import { readObject } from "./requests";
import type { User } from "./userauth";

const DNS_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const TEST_CALL_TIMEOUT_MS = 5_000;

const normalizeFingerprint = (s: string) => s.toLowerCase().replace(/^sha256:/, "").replace(/:/g, "");

function checkUrl(v: unknown): string {
  if (typeof v !== "string") throw new HttpError(400, "url is required");
  const problem = hostUrlProblem(v);
  if (problem) throw new HttpError(400, `url ${problem}`);
  return v;
}

function checkServerName(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !(isIP(v) || DNS_RE.test(v))) throw new HttpError(400, "server_name must be a DNS name or an IP address");
  return v;
}

/** `PATCH /:id` with `{ name }`: changes the display name of a managed host. Used by the CLI route and by the web page. */
export function renameHandler(registry: HostRegistry): MiddlewareHandler {
  return async (c) => {
    const id = c.req.param("id") ?? "";
    c.set("auditHost" as never, id as never);
    const body = await readObject(c);
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 64) throw new HttpError(400, "name is required: a non-empty string of at most 64 characters");
    const e = await registry.rename(id, body.name.trim());
    return c.json({ id, name: e.host.name, url: e.host.url, source: e.source });
  };
}

/** Host management for the CLI: read a node certificate, add, rename and remove a managed host. */
export function hostAdminApi(o: {
  registry: HostRegistry;
  makeClient: (h: HostConfig) => HostClient;
  peek?: typeof peekCertificate;
}): Hono {
  const peek = o.peek ?? peekCertificate;
  const r = new Hono();

  const peekOrFail = async (url: string, serverName: string | undefined) => {
    try {
      return await peek({ url, ...(serverName ? { serverName } : {}) });
    } catch (e) {
      if (e instanceof PeekError) throw new HttpError(502, `host ${url}: ${e.reason}`);
      throw e;
    }
  };

  // Audit every add and remove. Attached per route, because this router is mounted next to the forwarding routes.
  const audit: MiddlewareHandler = async (c, next) => {
    await next();
    const u = c.get("user" as never) as User | undefined;
    const host = (c.get("auditHost" as never) as string | undefined) ?? "unknown";
    console.log(`audit user=${u?.username ?? u?.sub ?? "unknown"} host=${host} ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status}`);
  };

  r.post("/probe", async (c) => {
    const body = await readObject(c);
    const url = checkUrl(body.url);
    const p = await peekOrFail(url, checkServerName(body.server_name));
    return c.json({ fingerprint: p.fingerprint, names: p.names, subject: p.subject, not_after: p.notAfter, pem: p.pem });
  });

  r.post("/", audit, async (c) => {
    const body = await readObject(c);
    const id = body.id;
    if (typeof id === "string") c.set("auditHost" as never, id as never);
    if (id === "local") throw new HttpError(409, 'host id "local" is reserved');
    if (typeof id !== "string" || !HOST_ID_RE.test(id)) throw new HttpError(400, `id is required and must match ${HOST_ID_RE.source}`);
    if (o.registry.get(id)) throw new HttpError(409, `host ${id} already exists`);
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name)) throw new HttpError(400, "name must be a non-empty string");
    if (body.force !== undefined && typeof body.force !== "boolean") throw new HttpError(400, "force must be true or false");
    const url = checkUrl(body.url);
    const serverName = checkServerName(body.server_name);
    if (typeof body.fingerprint !== "string") throw new HttpError(400, "fingerprint is required");
    const want = normalizeFingerprint(body.fingerprint);
    if (!/^[0-9a-f]{64}$/.test(want)) throw new HttpError(400, "fingerprint must be 64 hexadecimal characters");

    const seen = await peekOrFail(url, serverName);
    if (normalizeFingerprint(seen.fingerprint) !== want) throw new HttpError(400, "fingerprint does not match the certificate that the node presents");

    const host: HostConfig = {
      id,
      name: typeof body.name === "string" ? body.name : id,
      url,
      ca: seen.pem,
      ...(serverName ? { serverName } : {}),
      auth: { type: "hub_key" },
    };
    if (body.force !== true) {
      try {
        const res = await o.makeClient(host).call("GET", "/api/node", { timeoutMs: TEST_CALL_TIMEOUT_MS });
        if (res.status !== 200) throw new HostError(id, "bad response");
      } catch (e) {
        if (e instanceof HostError) throw new HttpError(502, e.message, { host: id });
        throw e;
      }
    }
    await o.registry.add(host);
    return c.json({ id, name: host.name, url, source: "managed" }, 201);
  });

  r.patch("/:id", audit, renameHandler(o.registry));

  r.delete("/:id", audit, async (c) => {
    const id = c.req.param("id");
    c.set("auditHost" as never, id as never);
    await o.registry.remove(id);
    return c.body(null, 204);
  });

  return r;
}
