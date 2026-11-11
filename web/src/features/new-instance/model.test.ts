import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync } from "svelte";
import { QueryClient } from "@tanstack/svelte-query";
import { inRoot, reactive } from "../../../test/effect-root.svelte";
import type { StartArgs } from "../instances";
import { createNewDialogModel } from "./model.svelte";
import type { NewInitial } from "./trustprompt";

const HOME = "/home/dev";
const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const listing = (path: string) => ({
  path,
  parent: path === "" ? null : path.slice(0, path.lastIndexOf("/")) || "/",
  dirs: path === HOME ? [{ name: "a", path: `${HOME}/a` }] : [],
});
const roots = () => ({ path: "", parent: null, dirs: [{ name: HOME, path: HOME }] });

// A gate holds answers until the test opens it.
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

type Call = { method: string; path: string; query: URLSearchParams; body?: any };
type Api = {
  users: () => Response | Promise<Response>;
  // The browse answer for a folder and user. The default lists the folder as asked, or the roots.
  fs: (path: string, user: string) => Response | Promise<Response>;
  mkdir: (body: any) => Response | Promise<Response>;
  calls: Call[];
};
let api: Api;

const realFetch = globalThis.fetch;
beforeEach(() => {
  // Only the timers are fake: Svelte's effect flush and the fetch promises need real microtasks.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  api = {
    users: () => res({ selectable: true, default: "dev", users: [{ name: "dev" }, { name: "alice" }] }),
    fs: (path) => res(path ? listing(path) : roots()),
    mkdir: (body) => res({ path: `${body.parent}/${body.name}` }),
    calls: [],
  };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const [p, q = ""] = url.split("?");
    const path = p!.replace("/api/hosts/h", "");
    const query = new URLSearchParams(q);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    api.calls.push({ method, path, query, body });
    if (path === "/users") return api.users();
    if (path === "/node") return res({ clone: true });
    if (path === "/fs/mkdir" && method === "POST") return api.mkdir(body);
    if (path === "/fs") return api.fs(query.get("path") ?? "", query.get("user") ?? "");
    return res({ error: `no route ${method} ${path}` }, 500);
  }) as any;
});

let disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers) d();
  disposers = [];
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

// Moves the fake clock (TanStack also batches its notifications on a timer), then runs the Svelte effects. A few
// rounds, because one answer can enable the next query (the users answer enables the browse).
async function tick(ms = 0) {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(ms);
    flushSync();
  }
}

const trust = (path: string, user = "dev") => ({ path, user });

function mount(start: { initial?: NewInitial; busyReason?: string } = {}) {
  const client = new QueryClient();
  const props = reactive({ initial: start.initial, busyReason: start.busyReason });
  const started: StartArgs[] = [];
  const { value: model, dispose } = inRoot(() =>
    createNewDialogModel({
      host: "h",
      client,
      initial: () => props.initial,
      busyReason: () => props.busyReason,
      onstart: (a) => started.push(a),
    }),
  );
  flushSync();
  disposers.push(() => {
    dispose();
    client.clear();
  });
  return { model, client, props, started };
}

const browses = () => api.calls.filter((c) => c.path === "/fs");
const lastBrowse = () => browses().at(-1)!;

describe("new dialog model", () => {
  test("go clears the trust prompt and the folder error", async () => {
    const m = mount({ initial: { path: HOME, trust: trust(HOME) } });
    await tick();
    expect(m.model.trustPrompt).toEqual(trust(HOME));
    api.mkdir = () => res({ error: "exists" }, 409);
    m.model.folderName = "x";
    m.model.createFolder();
    await tick();
    expect(m.model.error).toBe("exists");
    m.model.go(`${HOME}/a`);
    await tick();
    expect(m.model.trustPrompt).toBeNull();
    expect(m.model.error).toBe("");
    expect(m.model.path).toBe(`${HOME}/a`);
  });

  test("a browse error shows in error", async () => {
    api.fs = () => res({ error: "no access" }, 403);
    const m = mount();
    // TanStack only reports the result fields that were read. The dialog draws `error` from the start, so read it now.
    expect(m.model.error).toBe("");
    await tick();
    expect(m.model.error).toBe("no access");
  });

  test("changeUser reloads the same folder for the new user", async () => {
    const m = mount();
    m.model.go(HOME);
    await tick();
    expect(m.model.user).toBe("dev");
    expect(lastBrowse().query.get("user")).toBe("dev");
    m.model.changeUser("alice");
    await tick();
    expect(m.model.user).toBe("alice");
    expect(m.model.chosenUser).toBe("alice");
    expect(lastBrowse().query.get("path")).toBe(HOME);
    expect(lastBrowse().query.get("user")).toBe("alice");
    expect(m.model.listing?.path).toBe(HOME);
  });

  test("the first listing waits for the users answer", async () => {
    const g = gate();
    api.users = async () => {
      await g.p;
      return res({ selectable: true, default: "alice", users: [{ name: "dev" }, { name: "alice" }] });
    };
    const m = mount();
    await tick();
    expect(api.calls.some((c) => c.path === "/users")).toBe(true);
    expect(browses()).toEqual([]);
    g.open();
    await tick();
    expect(browses().length).toBe(1);
    expect(lastBrowse().query.get("user")).toBe("alice");
    expect(m.model.listing).not.toBeNull();
  });

  test("an older node without users shows no selector and sends no user", async () => {
    api.users = () => res({ error: "not found" }, 404);
    const m = mount();
    m.model.go(HOME);
    await tick();
    expect(m.model.usersInfo).toBeNull();
    expect(m.model.chosenUser).toBeUndefined();
    m.model.start();
    expect(m.started).toEqual([{ path: HOME, name: undefined, user: undefined, addTrust: false }]);
  });

  test("start passes the folder, the trimmed name and the chosen user", async () => {
    const m = mount();
    m.model.go(HOME);
    await tick();
    m.model.name = "  work  ";
    m.model.start();
    expect(m.started).toEqual([{ path: HOME, name: "work", user: "dev", addTrust: false }]);
  });

  test("a blank name is sent as undefined", async () => {
    const m = mount();
    m.model.go(HOME);
    await tick();
    m.model.name = "   ";
    m.model.start();
    expect(m.started[0]!.name).toBeUndefined();
  });

  test("start does nothing at the roots view or while the busy acknowledgment is missing", async () => {
    const m = mount({ busyReason: "is updating" });
    await tick();
    expect(m.model.atTop).toBe(true);
    m.model.ack = true;
    m.model.start();
    expect(m.started).toEqual([]);
    m.model.ack = false;
    m.model.go(HOME);
    await tick();
    expect(m.model.atTop).toBe(false);
    expect(m.model.needsAck).toBe(true);
    m.model.start();
    m.model.start(true);
    expect(m.started).toEqual([]);
    m.model.ack = true;
    expect(m.model.needsAck).toBe(false);
    m.model.start();
    expect(m.started.length).toBe(1);
  });

  test("a trust start uses the prompt's folder and user, even before the listing loads", async () => {
    api.fs = () => new Promise<Response>(() => {});
    const m = mount({ initial: { path: `${HOME}/x`, user: "alice", name: "n", trust: trust(`${HOME}/x`, "alice") } });
    await tick();
    expect(m.model.listing).toBeNull();
    expect(m.model.path).toBe(`${HOME}/x`);
    expect(m.model.user).toBe("alice");
    expect(m.model.name).toBe("n");
    m.model.start();
    expect(m.started).toEqual([]);
    m.model.start(true);
    expect(m.started).toEqual([{ path: `${HOME}/x`, name: "n", user: "alice", addTrust: true }]);
  });

  test("cancelTrust drops the prompt", async () => {
    const m = mount({ initial: { path: HOME, trust: trust(HOME) } });
    m.model.cancelTrust();
    expect(m.model.trustPrompt).toBeNull();
  });

  test("createFolder with a blank name does nothing", async () => {
    const m = mount();
    m.model.go(HOME);
    await tick();
    m.model.creating = true;
    m.model.folderName = "   ";
    m.model.createFolder();
    await tick();
    expect(api.calls.filter((c) => c.path === "/fs/mkdir")).toEqual([]);
    expect(m.model.creating).toBe(true);
  });

  test("a created folder is entered, the field clears, and creating turns off", async () => {
    const m = mount();
    m.model.go(HOME);
    await tick();
    m.model.creating = true;
    m.model.folderName = " new ";
    const g = gate();
    const answer = api.mkdir;
    api.mkdir = (body) => g.p.then(() => answer(body)) as any;
    m.model.createFolder();
    await tick();
    expect(m.model.mkdirPending).toBe(true);
    g.open();
    await tick();
    expect(api.calls.find((c) => c.path === "/fs/mkdir")!.body).toEqual({ parent: HOME, name: "new", user: "dev" });
    expect(m.model.mkdirPending).toBe(false);
    expect(m.model.creating).toBe(false);
    expect(m.model.folderName).toBe("");
    expect(m.model.path).toBe(`${HOME}/new`);
    expect(m.model.listing?.path).toBe(`${HOME}/new`);
  });

  test("a mkdir error shows in error", async () => {
    api.mkdir = () => res({ error: "permission denied" }, 403);
    const m = mount();
    m.model.go(HOME);
    await tick();
    m.model.creating = true;
    m.model.folderName = "new";
    m.model.createFolder();
    await tick();
    expect(m.model.error).toBe("permission denied");
    expect(m.model.creating).toBe(true);
    expect(m.model.path).toBe(HOME);
  });

  test("cloned starts the new folder when the listing is that folder", async () => {
    const m = mount();
    m.model.go(HOME);
    await tick();
    m.model.openClone();
    m.model.name = "app";
    await m.model.cloned(`${HOME}/app`);
    expect(m.model.cloning).toBe(false);
    expect(m.model.path).toBe(`${HOME}/app`);
    expect(m.started).toEqual([{ path: `${HOME}/app`, name: "app", user: "dev", addTrust: false }]);
  });

  test("cloned does not start when the listing is another folder", async () => {
    const m = mount();
    m.model.go(HOME);
    await tick();
    api.fs = () => res(listing(HOME));
    await m.model.cloned(`${HOME}/app`);
    expect(m.started).toEqual([]);
  });

  test("cloned starts nothing when the browse fails", async () => {
    const m = mount();
    m.model.go(HOME);
    await tick();
    api.fs = () => res({ error: "gone" }, 404);
    await m.model.cloned(`${HOME}/app`);
    expect(m.started).toEqual([]);
  });

  test("cloned uses the user chosen when the clone ended", async () => {
    const m = mount();
    m.model.go(HOME);
    await tick();
    const g = gate();
    api.fs = async (path) => {
      await g.p;
      return res(listing(path));
    };
    const done = m.model.cloned(`${HOME}/app`);
    flushSync();
    m.model.changeUser("alice");
    await tick();
    g.open();
    await done;
    expect(m.started).toEqual([{ path: `${HOME}/app`, name: undefined, user: "dev", addTrust: false }]);
    expect(api.calls.find((c) => c.path === "/fs" && c.query.get("path") === `${HOME}/app`)!.query.get("user")).toBe("dev");
  });

  test("going to the roots leaves the clone view", async () => {
    const m = mount();
    m.model.go(HOME);
    await tick();
    m.model.creating = true;
    m.model.openClone();
    expect(m.model.cloning).toBe(true);
    expect(m.model.creating).toBe(false);
    m.model.go();
    await tick();
    expect(m.model.atTop).toBe(true);
    expect(m.model.cloning).toBe(false);
  });

  test("the crumbs follow the listing", async () => {
    const m = mount();
    await tick();
    expect(m.model.crumbs).toEqual([]);
    m.model.go(HOME);
    await tick();
    expect(m.model.crumbs.map((c) => c.path)).toEqual(["/home", HOME]);
  });

  test("canClone follows the node answer", async () => {
    const m = mount();
    await tick();
    expect(m.model.canClone).toBe(true);
  });

  test("a late prompt keeps the typed name, the acknowledgment and moves to the new folder", async () => {
    const m = mount({ busyReason: "is updating" });
    m.model.go(`${HOME}/b`);
    await tick();
    m.model.name = "mine";
    m.model.ack = true;
    m.model.changeUser("alice");
    await tick();
    m.props.initial = { path: `${HOME}/a`, user: "dev", name: "theirs", trust: trust(`${HOME}/a`) };
    await tick();
    expect(m.model.trustPrompt).toEqual(trust(`${HOME}/a`));
    expect(m.model.name).toBe("mine");
    expect(m.model.ack).toBe(true);
    expect(m.model.path).toBe(`${HOME}/a`);
    expect(m.model.user).toBe("dev");
    expect(m.model.listing?.path).toBe(`${HOME}/a`);
    // The new prompt is not wiped by the move.
    m.model.start(true);
    expect(m.started).toEqual([{ path: `${HOME}/a`, name: "mine", user: "dev", addTrust: true }]);
  });

  test("a late prompt fills a blank name", async () => {
    const m = mount();
    m.model.go(`${HOME}/b`);
    await tick();
    m.props.initial = { path: `${HOME}/a`, name: "theirs", trust: trust(`${HOME}/a`) };
    await tick();
    expect(m.model.name).toBe("theirs");
  });

  test("a late prompt during a clone does not move the folder and shows when the clone view closes", async () => {
    const m = mount();
    m.model.go(`${HOME}/b`);
    await tick();
    m.model.name = "mine";
    m.model.openClone();
    m.model.setCloneBusy(true);
    m.props.initial = { path: `${HOME}/a`, user: "alice", trust: trust(`${HOME}/a`, "alice") };
    await tick();
    expect(m.model.cloning).toBe(true);
    expect(m.model.path).toBe(`${HOME}/b`);
    expect(m.model.user).toBe("dev");
    expect(m.model.name).toBe("mine");
    m.model.setCloneBusy(false);
    m.model.closeClone();
    await tick();
    expect(m.model.cloning).toBe(false);
    expect(m.model.trustPrompt).toEqual(trust(`${HOME}/a`, "alice"));
    expect(m.model.path).toBe(`${HOME}/b`);
  });

  // Pins today's result, which the brief does not settle: a clone that ends well enters and starts its folder, and the
  // late prompt goes (App then clears the outcome too). See the task 6 report.
  test("a late prompt during a clone that then succeeds is dropped and the cloned folder starts", async () => {
    const m = mount();
    m.model.go(`${HOME}/b`);
    await tick();
    m.model.openClone();
    m.model.setCloneBusy(true);
    m.props.initial = { path: `${HOME}/a`, trust: trust(`${HOME}/a`) };
    await tick();
    m.model.setCloneBusy(false);
    await m.model.cloned(`${HOME}/b/app`);
    expect(m.started).toEqual([{ path: `${HOME}/b/app`, name: undefined, user: "dev", addTrust: false }]);
    expect(m.model.trustPrompt).toBeNull();
  });

  test("a late prompt while the clone view is open with no clone running keeps the view and the folder", async () => {
    const m = mount();
    m.model.go(`${HOME}/b`);
    await tick();
    m.model.openClone();
    m.props.initial = { path: `${HOME}/a`, trust: trust(`${HOME}/a`) };
    await tick();
    expect(m.model.cloning).toBe(true);
    expect(m.model.path).toBe(`${HOME}/b`);
    expect(m.model.trustPrompt).toEqual(trust(`${HOME}/a`));
  });

  test("a second prompt for the same folder after Cancel shows again", async () => {
    const m = mount({ initial: { path: `${HOME}/a`, trust: trust(`${HOME}/a`) } });
    await tick();
    m.model.cancelTrust();
    expect(m.model.trustPrompt).toBeNull();
    m.props.initial = { path: `${HOME}/a`, trust: trust(`${HOME}/a`) };
    await tick();
    expect(m.model.trustPrompt).toEqual(trust(`${HOME}/a`));
  });

  test("an initial value that goes away leaves the dialog as it is", async () => {
    const m = mount({ initial: { path: `${HOME}/a`, name: "n", trust: trust(`${HOME}/a`) } });
    await tick();
    m.props.initial = undefined;
    await tick();
    expect(m.model.trustPrompt).toEqual(trust(`${HOME}/a`));
    expect(m.model.path).toBe(`${HOME}/a`);
    expect(m.model.name).toBe("n");
  });

  test("typing a name does not apply the prompt again", async () => {
    const m = mount();
    m.model.go(`${HOME}/b`);
    await tick();
    m.props.initial = { path: `${HOME}/a`, trust: trust(`${HOME}/a`) };
    await tick();
    m.model.go(`${HOME}/b`);
    m.model.name = "x";
    await tick();
    expect(m.model.path).toBe(`${HOME}/b`);
    expect(m.model.trustPrompt).toBeNull();
  });

  test("closeClone and setCloneBusy", async () => {
    const m = mount();
    m.model.go(HOME);
    await tick();
    m.model.openClone();
    m.model.setCloneBusy(true);
    expect(m.model.cloneBusy).toBe(true);
    m.model.setCloneBusy(false);
    m.model.setCloneBusy(true);
    expect(m.model.cloneBusy).toBe(true);
    m.model.setCloneBusy(false);
    expect(m.model.cloneBusy).toBe(false);
    m.model.closeClone();
    expect(m.model.cloning).toBe(false);
  });
});
