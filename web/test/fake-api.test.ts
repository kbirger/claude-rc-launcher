import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startFakeApi } from "./fake-api";

type Api = ReturnType<typeof startFakeApi>;
let api: Api;
beforeEach(() => {
  api = startFakeApi({ port: 0 });
});
afterEach(() => api.stop());

const call = (method: string, path: string, body?: unknown) =>
  fetch(api.url + path, { method, ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
const H = "/api/hosts/local";

describe("fake hub api", () => {
  test("the host list has local", async () => {
    const hosts = (await (await call("GET", "/api/hosts")).json()) as { id: string; status: string }[];
    expect(hosts.map((h) => h.id)).toContain("local");
    expect(hosts.find((h) => h.id === "local")?.status).toBe("ok");
  });

  test("start, list and stop an instance", async () => {
    const res = await call("POST", `${H}/instances`, { path: "/home/dev/proj-a" });
    expect(res.ok).toBe(true);
    const inst = (await res.json()) as { id: string; path: string };
    expect(inst.path).toBe("/home/dev/proj-a");
    const list = (await (await call("GET", `${H}/instances`)).json()) as { id: string }[];
    expect(list.map((i) => i.id)).toEqual([inst.id]);
    expect((await call("DELETE", `${H}/instances/${inst.id}`)).status).toBe(204);
    expect(await (await call("GET", `${H}/instances`)).json()).toEqual([]);
  });

  test("a folder that is not trusted answers 428 until addTrust", async () => {
    const path = "/home/dev/untrusted";
    const res = await call("POST", `${H}/instances`, { path });
    expect(res.status).toBe(428);
    expect(await res.json()).toEqual({ code: "untrusted", path, user: "dev" });
    expect((await call("POST", `${H}/instances`, { path, addTrust: false })).status).toBe(428);
    expect((await call("POST", `${H}/instances`, { path, addTrust: true })).ok).toBe(true);
    expect((await call("POST", `${H}/instances`, { path })).ok).toBe(true);
  });

  test("a fail rule with times 1 fails once", async () => {
    api.fail({ match: "POST /instances", status: 500, body: { error: "boom" }, times: 1 });
    const first = await call("POST", `${H}/instances`, { path: "/home/dev/proj-a" });
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({ error: "boom" });
    expect((await call("POST", `${H}/instances`, { path: "/home/dev/proj-a" })).ok).toBe(true);
  });

  test("fail rules can be set and reset over HTTP", async () => {
    await call("POST", "/__fake/fail", { match: "GET /node", status: 503 });
    expect((await call("GET", `${H}/node`)).status).toBe(503);
    expect((await call("GET", `${H}/node`)).status).toBe(503);
    await call("POST", "/__fake/reset");
    expect(await (await call("GET", `${H}/node`)).json()).toEqual({ clone: true });
  });

  test("the clone job runs, then is done with a path", async () => {
    const { id, path } = (await (await call("POST", `${H}/clone`, { repo: "acme/app", parent: "/home/dev" })).json()) as { id: string; path: string };
    expect(path).toBe("/home/dev/app");
    const read = async () => (await (await call("GET", `${H}/clone/${id}`)).json()) as { state: string; path?: string };
    expect((await read()).state).toBe("running");
    expect((await read()).state).toBe("running");
    expect(await read()).toEqual({ state: "done", path });
  });

  test("repos answer 409 until the login job is done", async () => {
    const res = await call("GET", `${H}/github/repos`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("github-login-required");
    const login = (await (await call("POST", `${H}/github/login`, {})).json()) as { id: string; code: string; url: string };
    expect(login.code).toBeTruthy();
    expect((await call("GET", `${H}/github/repos`)).status).toBe(409);
    const read = async () => ((await (await call("GET", `${H}/github/login/${login.id}`)).json()) as { state: string }).state;
    expect(await read()).toBe("pending");
    expect(await read()).toBe("pending");
    expect(await read()).toBe("done");
    const ok = await call("GET", `${H}/github/repos`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { groups: unknown[] }).groups.length).toBeGreaterThan(0);
  });
});
