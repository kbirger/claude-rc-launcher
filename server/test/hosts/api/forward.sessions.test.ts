import { Hono } from "hono";
import { describe, expect, test } from "bun:test";
import { onError } from "../../../src/app";
import { hostsApi } from "../../../src/hosts/api/forward";
import { HostError } from "../../../src/hosts/client";
import type { HostClient, HostConfig } from "../../../src/hosts/client";
import { HostRegistry } from "../../../src/hosts/HostRegistry";
import { defined } from "../../support";

const ID = "0123456789ab";
const SID = "11111111-2222-3333-4444-555555555555";
const hostCfg: HostConfig = {
  id: "nas",
  name: "nas",
  url: "https://x:1",
  ca: "PEM",
  auth: { type: "secret", secret: "s" },
};

function build(client: Partial<HostClient>, local: Hono = new Hono()) {
  const registry = HostRegistry.memory(
    [hostCfg],
    new Map([
      [
        "nas",
        {
          call: () => Promise.resolve({ status: 200, body: {} }),
          stream: () => {
            return Promise.reject(new Error("unused"));
          },
          ...client,
        },
      ],
    ]),
  );
  const app = new Hono();
  app.onError(onError);
  app.route("/api/hosts", hostsApi({ cfg: { name: "hub" } as any, local, registry }));
  return app;
}

const base = `/api/hosts/nas/instances/${ID}/sessions`;

describe("hub session JSON routes", () => {
  test("forward list, touched, files, file with validated query", async () => {
    const calls: any[] = [];
    const app = build({
      call: ((item: string, entry: string, value: any) =>
        Promise.resolve((calls.push([item, entry, value]), { status: 200, body: { ok: entry } }))) as any,
    });
    expect((await app.request(base)).status).toBe(200);
    await app.request(`${base}/${SID}/touched`);
    await app.request(`${base}/${SID}/files?path=a%20b&hidden=1`);
    await app.request(`${base}/${SID}/file?path=x.txt`);
    expect(calls.map((call) => call[1])).toEqual([
      `/api/instances/${ID}/sessions`,
      `/api/instances/${ID}/sessions/${SID}/touched`,
      `/api/instances/${ID}/sessions/${SID}/files`,
      `/api/instances/${ID}/sessions/${SID}/file`,
    ]);
    expect(calls[2][2].query).toEqual({ path: "a b", hidden: "1" });
    expect(calls[3][2].query).toEqual({ path: "x.txt" });
  });
  test("forward the permissions and blocked routes to the node with the same paths", async () => {
    const calls: any[] = [];
    const app = build({
      call: ((item: string, entry: string, value: any) =>
        Promise.resolve((calls.push([item, entry, value]), { status: 200, body: { ok: entry } }))) as any,
    });
    expect((await app.request(`/api/hosts/nas/instances/${ID}/permissions`)).status).toBe(200);
    expect((await app.request(`${base}/${SID}/permissions`)).status).toBe(200);
    expect((await app.request(`${base}/${SID}/blocked`)).status).toBe(200);
    expect(calls.map((call) => [call[0], call[1]])).toEqual([
      ["GET", `/api/instances/${ID}/permissions`],
      ["GET", `/api/instances/${ID}/sessions/${SID}/permissions`],
      ["GET", `/api/instances/${ID}/sessions/${SID}/blocked`],
    ]);
  });
  test("the permissions routes reject bad ids with 400", async () => {
    const app = build({});
    expect((await app.request(`/api/hosts/nas/instances/zz/permissions`)).status).toBe(400);
    expect((await app.request(`${base}/nope/permissions`)).status).toBe(400);
    expect((await app.request(`${base}/nope/blocked`)).status).toBe(400);
  });
  describe("rule edit routes", () => {
    const sbase = `/api/hosts/nas/instances/${ID}`;
    const post = (app: Hono, method: string, item: string, body: unknown) =>
      app.request(item, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const good = { scope: "user", list: "allow", rule: "Bash(git *)", expectedHash: null };
    const routes: [string, string, string][] = [
      ["POST", `${sbase}/permissions/rules`, `/api/instances/${ID}/permissions/rules`],
      ["DELETE", `${sbase}/permissions/rules`, `/api/instances/${ID}/permissions/rules`],
      ["POST", `${sbase}/sessions/${SID}/permissions/rules`, `/api/instances/${ID}/sessions/${SID}/permissions/rules`],
      [
        "DELETE",
        `${sbase}/sessions/${SID}/permissions/rules`,
        `/api/instances/${ID}/sessions/${SID}/permissions/rules`,
      ],
    ];
    test("the four routes forward the body and the status", async () => {
      const calls: any[] = [];
      const app = build({
        call: ((item: string, entry: string, value: any) =>
          Promise.resolve((calls.push([item, entry, value]), { status: 409, body: { error: "changed" } }))) as any,
      });

      for (const [item, url] of routes) {
        const response = await post(app, item, url, good);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: "changed" });
      }

      expect(calls.map((call) => [call[0], call[1]])).toEqual(routes.map(([route, , node]) => [route, node]));
      expect(calls[0][2].json).toEqual(good);
    });
    test("an invalid body is 400 and nothing is forwarded", async () => {
      const calls: any[] = [];
      const app = build({
        call: ((...args: any[]) => Promise.resolve((calls.push(args), { status: 200, body: {} }))) as any,
      });
      const bad: unknown[] = [
        { ...good, scope: "managed" },
        { ...good, scope: "legacy-local" },
        { ...good, list: "nope" },
        { ...good, rule: 5 },
        { ...good, rule: "" },
        { ...good, rule: "a\nb" },
        { ...good, rule: "(x)" },
        { ...good, rule: "B".repeat(2001) },
        { ...good, expectedHash: 5 },
        { scope: "user", list: "allow", rule: "Bash" },
        [],
      ];
      for (const [item, url] of routes)
        for (const badItem of bad) expect((await post(app, item, url, badItem)).status).toBe(400);
      expect(
        (
          await app.request(routes[0][1], {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{",
          })
        ).status,
      ).toBe(400);
      expect(calls).toEqual([]);
    });
    test("the audit line has the hub user and the rule, as one line", async () => {
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => void logs.push(args.join(" "));

      try {
        const app = build({ call: () => Promise.resolve({ status: 200, body: {} }) });
        await post(app, "DELETE", `${sbase}/sessions/${SID}/permissions/rules`, {
          ...good,
          scope: "local",
          list: "deny",
          rule: "Bash(rm *)",
          expectedHash: "ab",
        });
      } finally {
        console.log = orig;
      }

      expect(logs.filter((log) => log.includes("instance="))).toEqual([
        `audit user=unknown role=read host=nas action=remove instance=${ID} scope=local list=deny rule="Bash(rm *)" status=200 nudge=off`,
      ]);
    });
    const sp = `${sbase}/sessions/${SID}/permissions/rules`;
    test("forwards nudge true in the body", async () => {
      const calls: any[] = [];
      const app = build({
        call: ((_item: string, _entry: string, value: any) =>
          Promise.resolve((calls.push(value), { status: 200, body: {} }))) as any,
      });
      expect((await post(app, "POST", sp, { ...good, nudge: true })).status).toBe(200);
      expect(calls[0].json).toEqual({ ...good, nudge: true });
    });
    test("omits the key when the flag is false or missing", async () => {
      const calls: any[] = [];
      const app = build({
        call: ((_item: string, _entry: string, value: any) =>
          Promise.resolve((calls.push(value), { status: 200, body: {} }))) as any,
      });
      await post(app, "POST", sp, { ...good, nudge: false });
      await post(app, "POST", sp, good);
      expect(calls.map((call) => "nudge" in call.json)).toEqual([false, false]);
    });
    test("audit line ends with nudge=on", async () => {
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => void logs.push(args.join(" "));

      try {
        const app = build({ call: () => Promise.resolve({ status: 200, body: {} }) });
        await post(app, "POST", sp, { ...good, nudge: true });
      } finally {
        console.log = orig;
      }

      expect(logs.filter((log) => log.includes("instance="))).toEqual([
        `audit user=unknown role=read host=nas action=add instance=${ID} scope=user list=allow rule="Bash(git *)" status=200 nudge=on`,
      ]);
    });
    test("refuses a non boolean flag with 400 before any forward, and nudge true on the user route", async () => {
      const calls: any[] = [];
      const app = build({
        call: ((...args: any[]) => Promise.resolve((calls.push(args), { status: 200, body: {} }))) as any,
      });
      for (const value of ["true", 1, null])
        expect((await post(app, "POST", sp, { ...good, nudge: value })).status).toBe(400);
      expect((await post(app, "POST", routes[0][1], { ...good, nudge: true })).status).toBe(400);
      expect(calls).toEqual([]);
    });
    test("refuses nudge on a remove or with a list other than allow, before any forward", async () => {
      const calls: any[] = [];
      const app = build({
        call: ((...args: any[]) => Promise.resolve((calls.push(args), { status: 200, body: {} }))) as any,
      });
      expect((await post(app, "DELETE", sp, { ...good, nudge: true, expectedHash: "ab" })).status).toBe(400);
      expect((await post(app, "POST", sp, { ...good, list: "deny", nudge: true })).status).toBe(400);
      expect(calls).toEqual([]);
    });
    test("a hostile scope, list or instance id writes no audit line", async () => {
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => void logs.push(args.join(" "));

      try {
        const app = build({});
        const evil = "user\naudit user=x";
        expect((await post(app, "POST", routes[0][1], { ...good, scope: evil, list: evil })).status).toBe(400);
        expect((await post(app, "POST", `/api/hosts/nas/instances/zz/permissions/rules`, good)).status).toBe(400);
      } finally {
        console.log = orig;
      }

      expect(logs.filter((log) => log.includes("action="))).toEqual([]);
    });
    test("a HostError gives 502", async () => {
      const app = build({
        call: () => {
          return Promise.reject(new HostError("nas", "timeout"));
        },
      });
      expect((await post(app, "POST", routes[0][1], good)).status).toBe(502);
    });
  });
  test("rejects bad ids and bad paths with 400", async () => {
    const app = build({});
    expect((await app.request(`/api/hosts/nas/instances/zz/sessions`)).status).toBe(400);
    expect((await app.request(`${base}/nope/touched`)).status).toBe(400);
    expect((await app.request(`${base}/${SID}/files?path=${"a".repeat(4097)}`)).status).toBe(400);
    expect((await app.request(`${base}/${SID}/file?path=a%00b`)).status).toBe(400);
    expect((await app.request(`${base}/${SID}/download?path=a%00b`)).status).toBe(400);
    expect((await app.request(`${base}/${SID}/download`)).status).toBe(400);
  });
  test("a HostError gives 502", async () => {
    const app = build({
      call: () => {
        return Promise.reject(new HostError("nas", "unreachable"));
      },
    });
    const response = await app.request(`${base}/${SID}/touched`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "host nas: unreachable", host: "nas" });
  });
  test("a node 204 or 201 on a JSON route is a 502, a node 4xx or 5xx passes", async () => {
    for (const status of [204, 201, 302]) {
      const app = build({ call: () => Promise.resolve({ status, body: status === 204 ? null : { value: 1 } }) });

      for (const item of ["", `/${SID}/touched`, `/${SID}/files`, `/${SID}/file?path=a`]) {
        const reply = await app.request(`${base}${item}`);
        expect(reply.status).toBe(502);
        expect(await reply.json()).toEqual({ error: "bad response", host: "nas" });
      }
    }

    const app = build({
      call: () => Promise.resolve({ status: 403, body: { error: "path outside the session folder" } }),
    });
    const response = await app.request(`${base}/${SID}/files?path=x`);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "path outside the session folder" });
  });
  test("/local session routes are reachable through hostsApi", async () => {
    const local = new Hono();
    local.get("/instances/:id/sessions", (context) => context.json([{ id: context.req.param("id") }]));
    const app = build({}, local);
    const response = await app.request(`/api/hosts/local/instances/${ID}/sessions`);
    expect(await response.json()).toEqual([{ id: ID }]);
  });
});

describe("hub download", () => {
  const nodeRes = (body: BodyInit | null, item: Record<string, string> = {}, status = 200) => ({
    status,
    headers: new Headers(item),
    body: body instanceof ReadableStream ? body : body === null ? null : new Response(body).body,
  });

  test("streams 5 MB without draining the node before the client reads", async () => {
    let sent = 0;
    const chunk = new Uint8Array(64 * 1024);
    const total = (5 * 1024 * 1024) / chunk.length;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(ctl) {
          if (sent >= total) {
            ctl.close();
            return;
          }

          sent++;
          ctl.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    const app = build({
      download: () => Promise.resolve(nodeRes(body, { "content-length": String(total * chunk.length) })),
    });
    const res = await app.request(`${base}/${SID}/download?path=big.bin`);
    expect(res.status).toBe(200);
    await Bun.sleep(30);
    expect(sent).toBeLessThan(total / 2);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(5 * 1024 * 1024);
    expect(sent).toBe(total);
  });

  test("builds the download headers itself and passes only content-length, query and signal", async () => {
    let got: any;
    const app = build({
      download: (item: string, entry: any) =>
        Promise.resolve(
          ((got = [item, entry]),
          nodeRes("hi", {
            "content-type": "text/html",
            "content-length": "2",
            "content-disposition": "inline",
            "x-content-type-options": "nosniff",
            "set-cookie": "a=b",
            "x-secret": "1",
            server: "node",
          })),
        ),
    });
    const res = await app.request(`${base}/${SID}/download?path=${encodeURIComponent("dir/a b.html")}&inline=1`);
    expect(await res.text()).toBe("hi");
    // A node's text/html plus inline disposition must never reach the browser.
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="a b.html"; filename*=UTF-8''a%20b.html`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("content-length")).toBe("2");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-secret")).toBeNull();
    expect(res.headers.get("server")).toBeNull();
    expect(got[0]).toBe(`/api/instances/${ID}/sessions/${SID}/download`);
    expect(got[1].query).toEqual({ path: "dir/a b.html" });
    expect(got[1].signal).toBeInstanceOf(AbortSignal);
  });

  test("names the download from the last segment of the requested path, not from the node", async () => {
    const app = build({
      download: () => Promise.resolve(nodeRes("x", { "content-disposition": `attachment; filename="evil.exe"` })),
    });
    const res = await app.request(`${base}/${SID}/download?path=${encodeURIComponent("a/b/naïve.txt")}`);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="na_ve.txt"; filename*=UTF-8''na%C3%AFve.txt`,
    );
    await res.text();
  });

  test("cancelling the browser request aborts the signal given to the node call", async () => {
    let sig: AbortSignal | undefined;
    const app = build({
      download: (_p: string, item: any) =>
        Promise.resolve(
          ((sig = item.signal),
          nodeRes(
            new ReadableStream({
              pull() {
                return new Promise(() => {});
              },
            }),
          )),
        ),
    });
    const ctl = new AbortController();
    const res = await app.request(new Request(`http://h${base}/${SID}/download?path=a`, { signal: ctl.signal }));
    expect(res.status).toBe(200);
    expect(defined(sig).aborted).toBe(false);
    ctl.abort();
    expect(defined(sig).aborted).toBe(true);
  });

  test("a node 404 returns 404 JSON", async () => {
    const app = build({
      download: () =>
        Promise.resolve(
          nodeRes(JSON.stringify({ error: "file not found" }), { "content-type": "application/json" }, 404),
        ),
    });
    const res = await app.request(`${base}/${SID}/download?path=a`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "file not found" });
  });

  test("a node 204 or 302 on download is a 502", async () => {
    for (const status of [204, 302, 201]) {
      const app = build({ download: () => Promise.resolve(nodeRes(null, {}, status)) });
      const res = await app.request(`${base}/${SID}/download?path=a`);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "bad response", host: "nas" });
    }
  });

  test("a HostError gives 502; no download method gives 501", async () => {
    const app = build({
      download: () => {
        return Promise.reject(new HostError("nas", "timeout"));
      },
    });
    expect((await app.request(`${base}/${SID}/download?path=a`)).status).toBe(502);
    const response = await build({}).request(`${base}/${SID}/download?path=a`);
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: "downloads are not available for this host" });
  });

  test("audit line has no file path", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));

    try {
      const app = build({ download: () => Promise.resolve(nodeRes("x")) });
      await (await app.request(`${base}/${SID}/download?path=secret.txt`)).text();
    } finally {
      console.log = orig;
    }

    const line = logs.find((log) => log.startsWith("audit"));
    expect(line).toBe("audit user=unknown role=read host=nas GET download 200");
    expect(logs.join("\n")).not.toContain("secret.txt");
  });
});

describe("hub abs for touched files outside the session folder", () => {
  const nodeRes = (body: BodyInit | null, item: Record<string, string> = {}, status = 200) => ({
    status,
    headers: new Headers(item),
    body: body === null ? null : new Response(body).body,
  });

  test("file forwards abs alone and validates it", async () => {
    const calls: any[] = [];
    const app = build({
      call: ((item: string, entry: string, value: any) =>
        Promise.resolve((calls.push([item, entry, value]), { status: 200, body: {} }))) as any,
    });
    const abs = "/home/u/notes/a b#?%&+é.txt";
    expect((await app.request(`${base}/${SID}/file?abs=${encodeURIComponent(abs)}`)).status).toBe(200);
    expect(calls[0][1]).toBe(`/api/instances/${ID}/sessions/${SID}/file`);
    expect(calls[0][2].query).toEqual({ abs });
    // A Windows path passes the hub: only the node knows its own path rules.
    await app.request(`${base}/${SID}/file?abs=${encodeURIComponent("C:\\Users\\u\\a.txt")}`);
    expect(calls[1][2].query).toEqual({ abs: "C:\\Users\\u\\a.txt" });
    const count = calls.length;

    for (const item of [`abs=a%00b`, `abs=${"a".repeat(4097)}`, `abs=%2Fa&path=b`, ``]) {
      expect([item, (await app.request(`${base}/${SID}/file?${item}`)).status]).toEqual([item, 400]);
    }

    expect(calls.length).toBe(count);
  });

  test("a preview by abs gets one audit line with the status only, and no log line holds the path", async () => {
    const logs: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    const keep = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    console.log = console.error = console.warn = keep;
    const abs = "/home/u/.ssh/secret-name.txt";

    try {
      await (
        await build({ call: () => Promise.resolve({ status: 200, body: { name: "x" } }) }).request(
          `${base}/${SID}/file?abs=${encodeURIComponent(abs)}`,
        )
      ).text();
      await (
        await build({
          call: () => Promise.resolve({ status: 404, body: { error: "file was not touched by this session" } }),
        }).request(`${base}/${SID}/file?abs=${encodeURIComponent(abs)}`)
      ).text();
      await (
        await build({
          call: () => {
            return Promise.reject(new HostError("nas", "timeout"));
          },
        }).request(`${base}/${SID}/file?abs=${encodeURIComponent(abs)}`)
      ).text();
      await (
        await build({ download: () => Promise.resolve(nodeRes("x")) }).request(
          `${base}/${SID}/download?abs=${encodeURIComponent(abs)}`,
        )
      ).text();
      // A preview by path is not audited.
      await (
        await build({ call: () => Promise.resolve({ status: 200, body: {} }) }).request(
          `${base}/${SID}/file?path=a.txt`,
        )
      ).text();
    } finally {
      Object.assign(console, orig);
    }

    expect(logs.filter((log) => log.startsWith("audit"))).toEqual([
      "audit user=unknown role=read host=nas GET preview abs 200",
      "audit user=unknown role=read host=nas GET preview abs 404",
      "audit user=unknown role=read host=nas GET preview abs 502",
      "audit user=unknown role=read host=nas GET download 200",
    ]);
    expect(logs.join("\n")).not.toContain("secret-name");
    expect(logs.join("\n")).not.toContain(".ssh");
  });

  test("files does not forward abs", async () => {
    const calls: any[] = [];
    const app = build({
      call: ((item: string, entry: string, value: any) =>
        Promise.resolve((calls.push([item, entry, value]), { status: 200, body: {} }))) as any,
    });
    expect((await app.request(`${base}/${SID}/files?abs=%2Fetc`)).status).toBe(400);
    expect(calls.length).toBe(0);
  });

  test("download forwards abs, names it from its last segment and keeps the hub headers", async () => {
    const got: any[] = [];
    const app = build({
      download: (item: string, entry: any) =>
        Promise.resolve(
          (got.push([item, entry]),
          nodeRes("<b>hi</b>", {
            "content-type": "text/html",
            "content-length": "9",
            "content-disposition": "inline; filename=evil.html",
          })),
        ),
    });
    const res = await app.request(`${base}/${SID}/download?abs=${encodeURIComponent("/home/u/out/naïve.html")}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<b>hi</b>");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="na_ve.html"; filename*=UTF-8''na%C3%AFve.html`,
    );
    expect(got[0][0]).toBe(`/api/instances/${ID}/sessions/${SID}/download`);
    expect(got[0][1].query).toEqual({ abs: "/home/u/out/naïve.html" });
    const response = await app.request(
      `${base}/${SID}/download?abs=${encodeURIComponent("C:\\Users\\u\\report final.pdf")}`,
    );
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="report final.pdf"; filename*=UTF-8''report%20final.pdf`,
    );
    expect(got[1][1].query).toEqual({ abs: "C:\\Users\\u\\report final.pdf" });
    await response.text();
  });

  test("download refuses abs with path, a NUL, or too long, without calling the node", async () => {
    let called = 0;
    const app = build({ download: () => Promise.resolve((called++, nodeRes("x"))) });

    for (const item of [`abs=%2Fa&path=a`, `abs=a%00b`, `abs=${"a".repeat(4097)}`, ``]) {
      expect([item, (await app.request(`${base}/${SID}/download?${item}`)).status]).toEqual([item, 400]);
    }

    expect(called).toBe(0);
  });
});
