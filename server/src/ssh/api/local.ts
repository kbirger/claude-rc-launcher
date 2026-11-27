import { Hono } from "hono";
import type { ErrorHandler } from "hono";
import { HostError } from "../../hosts";
import type { HostClient } from "../../hosts";
import { LOCAL_HOST } from "../../shared/hostid";
import { createNodeSsh } from "../node/wiring";
import type { NodeSsh, NodeSshOptions } from "../node/wiring";
import { sshManagedApi, sshNodeApi } from "./node";

// The SSH routes of the host `local`, in the hub process: the same routers as a node has, and an in-process client.

export interface LocalSshOptions extends NodeSshOptions {
  /** The error handler of the router: the one of the app, so that a local call answers as a call to a node does. */
  onError: ErrorHandler;
}

export interface LocalSsh extends NodeSsh {
  /** The in-process client for the host `local`. Missing on Windows: the host has no grant routes there. */
  client?: HostClient;
}

/**
 * A `HostClient` with no network: `call` runs the request in `router` and gives `{ status, body }` as a remote call
 * does (a 204 has a null body, any other body is JSON). `timeoutMs` has no effect, and `stream` is not supported:
 * the events of the local broker go straight to the service.
 */
export function localHostClient(router: Hono, host = LOCAL_HOST): HostClient {
  return {
    async call(method, path, options = {}) {
      const url = new URL(path, "http://local");
      for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
      const hasBody = options.json !== undefined;
      const response = await router.request(url.pathname + url.search, {
        method,
        ...(hasBody || method !== "GET" ? { headers: { "content-type": "application/json" } } : {}),
        ...(hasBody ? { body: JSON.stringify(options.json) } : {}),
      });
      const text = await response.text();
      if (response.status === 204) return { status: 204, body: null };
      if (text === "") throw new HostError(host, "bad response");

      try {
        return { status: response.status, body: JSON.parse(text) as unknown };
      } catch {
        throw new HostError(host, "bad response");
      }
    },
    stream: () => Promise.reject(new HostError(host, "bad response")),
  };
}

/**
 * The SSH wiring of the host `local`, for the hub process: `createNodeSsh`, plus a router with the same SSH routes as a
 * node has and an in-process client for them. Linux only: on Windows there is no client.
 */
export function createLocalSsh(options: LocalSshOptions): LocalSsh {
  // The folder guard for tests is in `createNodeSsh`.
  const node = createNodeSsh(options);
  if (!node.ssh) return node;
  const api = new Hono();
  // The same order as a node: the managed routes first, and a path they do not know falls through to the grant router.
  api.route("/ssh", sshManagedApi(node.sshManaged));
  api.route("/ssh", sshNodeApi(node.ssh));
  const router = new Hono();
  router.route("/api", api);
  router.onError(options.onError);
  const client = localHostClient(router);

  return {
    ...node,
    client,
    // The hub ends its grants at stop and tells this router with DELETEs that nobody waits for. The reset makes sure
    // that every agent socket is closed before the control sockets go, also one that the hub no longer knows.
    async stop() {
      try {
        await client.call("POST", "/api/ssh/reset");
      } catch {
        // the router answers in process: nothing to report at stop
      }

      await node.stop();
    },
  };
}
