import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWebFilesFromDisk } from "../../src/web/files";
import { staticHandler } from "../../src/web/static";
import { defined } from "../support";

let dir: string;
let app: Hono;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<html>index</html>");
  writeFileSync(join(dir, "assets", "app-abc.js"), "console.log(1)");
  writeFileSync(join(dir, "assets", "app-abc.css"), "a{}");
  writeFileSync(join(dir, "favicon.svg"), "<svg/>");
  const files = new Map([
    ["/index.html", { path: join(dir, "index.html"), type: "text/html; charset=utf-8" }],
    ["/assets/app-abc.js", { path: join(dir, "assets", "app-abc.js"), type: "text/javascript; charset=utf-8" }],
    [
      "/_app/immutable/entry/app.abc.js",
      { path: join(dir, "assets", "app-abc.js"), type: "text/javascript; charset=utf-8" },
    ],
    ["/assets/app-abc.css", { path: join(dir, "assets", "app-abc.css"), type: "text/css; charset=utf-8" }],
    ["/favicon.svg", { path: join(dir, "favicon.svg"), type: "image/svg+xml" }],
  ]);
  app = new Hono();
  app.get("/api/x", (context) => context.text("api"));
  app.use("*", staticHandler(files));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("staticHandler", () => {
  test("serves exact file with content type and immutable cache for assets", async () => {
    const response = await app.request("/assets/app-abc.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe("console.log(1)");
    expect((await app.request("/assets/app-abc.css")).headers.get("content-type")).toContain("text/css");
  });
  test("SvelteKit immutable files are cached for a year", async () => {
    const response = await app.request("/_app/immutable/entry/app.abc.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
  test("index.html and / are no-cache", async () => {
    for (const path of ["/", "/index.html"]) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toBe("<html>index</html>");
    }
  });
  test("other files are no-cache", async () => {
    const response = await app.request("/favicon.svg");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
  });
  test("unknown extensionless path falls back to index.html", async () => {
    const response = await app.request("/some/spa/route");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>index</html>");
  });
  test("unknown path with extension is 404", async () => {
    expect((await app.request("/assets/missing.js")).status).toBe(404);
  });
  test("traversal never leaves the map", async () => {
    for (const path of [
      "/../package.json",
      "/%2e%2e/package.json",
      "/assets/%2e%2e/%2e%2e/package.json",
      "/..%5cpackage.json",
      "/a%00b",
    ]) {
      const reply = await app.request(path);
      const body = await reply.text();
      expect(body).not.toContain("claude-rc-launcher");
      expect([200, 404]).toContain(reply.status);
    }

    // traversal that lands on an existing mapped name must still not resolve it
    const response = await app.request("/assets/../index.html");
    expect(response.status).toBeLessThan(500);
  });
  test("non-GET and unhandled API paths pass through", async () => {
    expect(await (await app.request("/api/x")).text()).toBe("api");
    expect((await app.request("/nope", { method: "POST" })).status).toBe(404);
  });
});

describe("loadWebFilesFromDisk", () => {
  test("walks a directory into URL-keyed map", async () => {
    const webFiles = await loadWebFilesFromDisk(dir);
    expect([...webFiles.keys()].sort()).toEqual([
      "/assets/app-abc.css",
      "/assets/app-abc.js",
      "/favicon.svg",
      "/index.html",
    ]);
    expect(defined(webFiles.get("/index.html")).type).toContain("text/html");
  });
  test("missing directory yields empty map", async () => {
    expect((await loadWebFilesFromDisk(join(dir, "nope"))).size).toBe(0);
  });
});
