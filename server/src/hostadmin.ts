import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { isIP } from "node:net";
import { PeekError, peekCertificate } from "./certpeek";
import { hostUrlProblem } from "./config/parse";
import { HostError } from "./hostclient";
import type { HostClient, HostConfig } from "./hostclient";
import { HOST_ID_RE } from "./hostid";
import type { HostRegistry } from "./hostregistry";
import { HttpError } from "./instances";
import { readObject } from "./shared/requests";
import type { User } from "./auth/user";

const DNS_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const TEST_CALL_TIMEOUT_MS = 5_000;

const normalizeFingerprint = (text: string) =>
  text
    .toLowerCase()
    .replace(/^sha256:/, "")
    .replace(/:/g, "");

function checkUrl(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "url is required");
  const problem = hostUrlProblem(value);
  if (problem) throw new HttpError(400, `url ${problem}`);
  return value;
}

function checkServerName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(isIP(value) || DNS_RE.test(value)))
    throw new HttpError(400, "server_name must be a DNS name or an IP address");
  return value;
}

/** `PATCH /:id` with `{ name }`: changes the display name of a managed host. Used by the CLI route and by the web page. */
export function renameHandler(registry: HostRegistry): MiddlewareHandler {
  return async (context) => {
    const id = context.req.param("id") ?? "";
    context.set("auditHost" as never, id as never);
    const body = await readObject(context);
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 64)
      throw new HttpError(400, "name is required: a non-empty string of at most 64 characters");
    const hostEntry = await registry.rename(id, body.name.trim());
    return context.json({ id, name: hostEntry.host.name, url: hostEntry.host.url, source: hostEntry.source });
  };
}

/** Host management for the CLI: read a node certificate, add, rename and remove a managed host. */
export function hostAdminApi(options: {
  registry: HostRegistry;
  makeClient: (hostConfig: HostConfig) => HostClient;
  peek?: typeof peekCertificate;
}): Hono {
  const peek = options.peek ?? peekCertificate;
  const hono = new Hono();

  const peekOrFail = async (url: string, serverName: string | undefined) => {
    try {
      return await peek({ url, ...(serverName ? { serverName } : {}) });
    } catch (error) {
      if (error instanceof PeekError) throw new HttpError(502, `host ${url}: ${error.reason}`);
      throw error;
    }
  };

  // Audit every add and remove. Attached per route, because this router is mounted next to the forwarding routes.
  const audit: MiddlewareHandler = async (context, next) => {
    await next();
    const response = context.get("user" as never) as User | undefined;
    const host = (context.get("auditHost" as never) as string | undefined) ?? "unknown";
    console.log(
      `audit user=${response?.username ?? response?.sub ?? "unknown"} role=${response?.role ?? "read"} host=${host} ${context.req.method} ${new URL(context.req.url).pathname} ${context.res.status}`,
    );
  };

  hono.post("/probe", async (context) => {
    const body = await readObject(context);
    const url = checkUrl(body.url);
    const peekedCert = await peekOrFail(url, checkServerName(body.server_name));
    return context.json({
      fingerprint: peekedCert.fingerprint,
      names: peekedCert.names,
      subject: peekedCert.subject,
      not_after: peekedCert.notAfter,
      pem: peekedCert.pem,
    });
  });

  hono.post("/", audit, async (context) => {
    const body = await readObject(context);
    const id = body.id;
    if (typeof id === "string") context.set("auditHost" as never, id as never);
    if (id === "local") throw new HttpError(409, 'host id "local" is reserved');
    if (typeof id !== "string" || !HOST_ID_RE.test(id))
      throw new HttpError(400, `id is required and must match ${HOST_ID_RE.source}`);
    if (options.registry.get(id)) throw new HttpError(409, `host ${id} already exists`);
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name))
      throw new HttpError(400, "name must be a non-empty string");
    if (body.force !== undefined && typeof body.force !== "boolean")
      throw new HttpError(400, "force must be true or false");
    const url = checkUrl(body.url);
    const serverName = checkServerName(body.server_name);
    if (typeof body.fingerprint !== "string") throw new HttpError(400, "fingerprint is required");
    const want = normalizeFingerprint(body.fingerprint);
    if (!/^[0-9a-f]{64}$/.test(want)) throw new HttpError(400, "fingerprint must be 64 hexadecimal characters");

    const seen = await peekOrFail(url, serverName);
    if (normalizeFingerprint(seen.fingerprint) !== want)
      throw new HttpError(400, "fingerprint does not match the certificate that the node presents");

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
        const res = await options.makeClient(host).call("GET", "/api/node", { timeoutMs: TEST_CALL_TIMEOUT_MS });
        if (res.status !== 200) throw new HostError(id, "bad response");
      } catch (error) {
        if (error instanceof HostError) throw new HttpError(502, error.message, { host: id });
        throw error;
      }
    }

    await options.registry.add(host);
    return context.json({ id, name: host.name, url, source: "managed" }, 201);
  });

  hono.patch("/:id", audit, renameHandler(options.registry));

  hono.delete("/:id", audit, async (context) => {
    const id = context.req.param("id");
    context.set("auditHost" as never, id as never);
    await options.registry.remove(id);
    return context.body(null, 204);
  });

  return hono;
}
