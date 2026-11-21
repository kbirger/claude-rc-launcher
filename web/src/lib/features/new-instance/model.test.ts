// @vitest-environment jsdom
// jsdom: the model reads the settings help query and the defaults from the instances index, which also loads the list components and the SvelteKit client.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync } from "svelte";
import { QueryClient } from "@tanstack/svelte-query";
import { inRoot, reactive } from "../../../../test/effect-root.svelte";
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
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise: promise, open };
}

type Call = { method: string; path: string; query: URLSearchParams; body?: unknown };
type Api = {
  users: () => Response | Promise<Response>;
  // The browse answer for a folder and user. The default lists the folder as asked, or the roots.
  fs: (path: string, user: string) => Response | Promise<Response>;
  mkdir: (body: { parent: string; name: string }) => Response | Promise<Response>;
  // The settings help. The default is an old node: the route is not there.
  help: () => Response | Promise<Response>;
  calls: Call[];
};
let api: Api;

beforeEach(() => {
  // Only the timers are fake: Svelte's effect flush and the fetch promises need real microtasks.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  api = {
    users: () => res({ selectable: true, default: "dev", users: [{ name: "dev" }, { name: "alice" }] }),
    fs: (path) => res(path ? listing(path) : roots()),
    mkdir: (body) => res({ path: `${body.parent}/${body.name}` }),
    help: () => res({ error: "not found" }, 404),
    calls: [],
  };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const [item, entry = ""] = url.split("?");
    const path = item!.replace("/api/hosts/h", "");
    const query = new URLSearchParams(entry);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    api.calls.push({ method, path, query, body });
    if (path === "/users") return api.users();
    if (path === "/node") return res({ clone: true });
    if (path === "/instance-settings") return api.help();
    if (path === "/fs/mkdir" && method === "POST") return api.mkdir(body);
    if (path === "/fs") return api.fs(query.get("path") ?? "", query.get("user") ?? "");
    return res({ error: `no route ${method} ${path}` }, 500);
  });
});

let disposers: (() => void)[] = [];
afterEach(() => {
  for (const disposer of disposers) disposer();
  disposers = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Moves the fake clock (TanStack also batches its notifications on a timer), then runs the Svelte effects. A few
// rounds, because one answer can enable the next query (the users answer enables the browse).
async function tick(ms = 0) {
  for (let index = 0; index < 5; index++) {
    await vi.advanceTimersByTimeAsync(ms);
    flushSync();
  }
}

const trust = (path: string, user = "dev") => ({ path, user });

function mount(start: { initial?: NewInitial; busyReason?: string; canChooseUser?: boolean } = {}) {
  const client = new QueryClient();
  const props = reactive({ initial: start.initial, busyReason: start.busyReason });
  const started: StartArgs[] = [];
  const { value: model, dispose } = inRoot(() =>
    createNewDialogModel({
      host: "h",
      client,
      initial: () => props.initial,
      busyReason: () => props.busyReason,
      ...(start.canChooseUser === undefined ? {} : { canChooseUser: () => start.canChooseUser! }),
      onstart: (startArgs) => started.push(startArgs),
    }),
  );
  flushSync();
  disposers.push(() => {
    dispose();
    client.clear();
  });
  return { model, client, props, started };
}

const browses = () => api.calls.filter((call) => call.path === "/fs");
const lastBrowse = () => browses().at(-1)!;

describe("new dialog model", () => {
  test("go clears the trust prompt and the folder error", async () => {
    const mounted = mount({ initial: { path: HOME, trust: trust(HOME) } });
    await tick();
    expect(mounted.model.trustPrompt).toEqual(trust(HOME));
    api.mkdir = () => res({ error: "exists" }, 409);
    mounted.model.folderName = "x";
    mounted.model.createFolder();
    await tick();
    expect(mounted.model.error).toBe("exists");
    mounted.model.go(`${HOME}/a`);
    await tick();
    expect(mounted.model.trustPrompt).toBeNull();
    expect(mounted.model.error).toBe("");
    expect(mounted.model.path).toBe(`${HOME}/a`);
  });

  test("a browse error shows in error", async () => {
    api.fs = () => res({ error: "no access" }, 403);
    const mounted = mount();
    // TanStack only reports the result fields that were read. The dialog draws `error` from the start, so read it now.
    expect(mounted.model.error).toBe("");
    await tick();
    expect(mounted.model.error).toBe("no access");
  });

  test("changeUser reloads the same folder for the new user", async () => {
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    expect(mounted.model.user).toBe("dev");
    expect(lastBrowse().query.get("user")).toBe("dev");
    mounted.model.changeUser("alice");
    await tick();
    expect(mounted.model.user).toBe("alice");
    expect(mounted.model.chosenUser).toBe("alice");
    expect(lastBrowse().query.get("path")).toBe(HOME);
    expect(lastBrowse().query.get("user")).toBe("alice");
    expect(mounted.model.listing?.path).toBe(HOME);
  });

  test("the first listing waits for the users answer", async () => {
    const harness = gate();

    api.users = async () => {
      await harness.promise;
      return res({ selectable: true, default: "alice", users: [{ name: "dev" }, { name: "alice" }] });
    };

    const mounted = mount();
    await tick();
    expect(api.calls.some((call) => call.path === "/users")).toBe(true);
    expect(browses()).toEqual([]);
    harness.open();
    await tick();
    expect(browses().length).toBe(1);
    expect(lastBrowse().query.get("user")).toBe("alice");
    expect(mounted.model.listing).not.toBeNull();
  });

  test("an older node without users shows no selector and sends no user", async () => {
    api.users = () => res({ error: "not found" }, 404);
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    expect(mounted.model.usersInfo).toBeNull();
    expect(mounted.model.chosenUser).toBeUndefined();
    mounted.model.start();
    expect(mounted.started).toEqual([{ path: HOME, name: undefined, user: undefined, addTrust: false }]);
  });

  test("start passes the folder, the trimmed name and the chosen user", async () => {
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    mounted.model.name = "  work  ";
    mounted.model.start();
    expect(mounted.started).toEqual([{ path: HOME, name: "work", user: "dev", addTrust: false }]);
  });

  test("a blank name is sent as undefined", async () => {
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    mounted.model.name = "   ";
    mounted.model.start();
    expect(mounted.started[0]!.name).toBeUndefined();
  });

  test("start does nothing at the roots view or while the busy acknowledgment is missing", async () => {
    const mounted = mount({ busyReason: "is updating" });
    await tick();
    expect(mounted.model.atTop).toBe(true);
    mounted.model.ack = true;
    mounted.model.start();
    expect(mounted.started).toEqual([]);
    mounted.model.ack = false;
    mounted.model.go(HOME);
    await tick();
    expect(mounted.model.atTop).toBe(false);
    expect(mounted.model.needsAck).toBe(true);
    mounted.model.start();
    mounted.model.start(true);
    expect(mounted.started).toEqual([]);
    mounted.model.ack = true;
    expect(mounted.model.needsAck).toBe(false);
    mounted.model.start();
    expect(mounted.started.length).toBe(1);
  });

  test("a trust start uses the prompt's folder and user, even before the listing loads", async () => {
    api.fs = () => new Promise<Response>(() => {});
    const mounted = mount({
      initial: { path: `${HOME}/x`, user: "alice", name: "n", trust: trust(`${HOME}/x`, "alice") },
    });
    await tick();
    expect(mounted.model.listing).toBeNull();
    expect(mounted.model.path).toBe(`${HOME}/x`);
    expect(mounted.model.user).toBe("alice");
    expect(mounted.model.name).toBe("n");
    mounted.model.start();
    expect(mounted.started).toEqual([]);
    mounted.model.start(true);
    expect(mounted.started).toEqual([{ path: `${HOME}/x`, name: "n", user: "alice", addTrust: true }]);
  });

  test("cancelTrust drops the prompt", async () => {
    const mounted = mount({ initial: { path: HOME, trust: trust(HOME) } });
    mounted.model.cancelTrust();
    expect(mounted.model.trustPrompt).toBeNull();
  });

  test("createFolder with a blank name does nothing", async () => {
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    mounted.model.creating = true;
    mounted.model.folderName = "   ";
    mounted.model.createFolder();
    await tick();
    expect(api.calls.filter((call) => call.path === "/fs/mkdir")).toEqual([]);
    expect(mounted.model.creating).toBe(true);
  });

  test("a created folder is entered, the field clears, and creating turns off", async () => {
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    mounted.model.creating = true;
    mounted.model.folderName = " new ";
    const harness = gate();
    const answer = api.mkdir;
    api.mkdir = (body) => harness.promise.then(() => answer(body));
    mounted.model.createFolder();
    await tick();
    expect(mounted.model.mkdirPending).toBe(true);
    harness.open();
    await tick();
    expect(api.calls.find((call) => call.path === "/fs/mkdir")!.body).toEqual({
      parent: HOME,
      name: "new",
      user: "dev",
    });
    expect(mounted.model.mkdirPending).toBe(false);
    expect(mounted.model.creating).toBe(false);
    expect(mounted.model.folderName).toBe("");
    expect(mounted.model.path).toBe(`${HOME}/new`);
    expect(mounted.model.listing?.path).toBe(`${HOME}/new`);
  });

  test("a mkdir error shows in error", async () => {
    api.mkdir = () => res({ error: "permission denied" }, 403);
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    mounted.model.creating = true;
    mounted.model.folderName = "new";
    mounted.model.createFolder();
    await tick();
    expect(mounted.model.error).toBe("permission denied");
    expect(mounted.model.creating).toBe(true);
    expect(mounted.model.path).toBe(HOME);
  });

  test("cloned starts the new folder when the listing is that folder", async () => {
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    mounted.model.openClone();
    mounted.model.name = "app";
    await mounted.model.cloned(`${HOME}/app`);
    expect(mounted.model.cloning).toBe(false);
    expect(mounted.model.path).toBe(`${HOME}/app`);
    expect(mounted.started).toEqual([{ path: `${HOME}/app`, name: "app", user: "dev", addTrust: false }]);
  });

  test("cloned does not start when the listing is another folder", async () => {
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    api.fs = () => res(listing(HOME));
    await mounted.model.cloned(`${HOME}/app`);
    expect(mounted.started).toEqual([]);
  });

  test("cloned starts nothing when the browse fails", async () => {
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    api.fs = () => res({ error: "gone" }, 404);
    await mounted.model.cloned(`${HOME}/app`);
    expect(mounted.started).toEqual([]);
  });

  test("cloned uses the user chosen when the clone ended", async () => {
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    const harness = gate();

    api.fs = async (path) => {
      await harness.promise;
      return res(listing(path));
    };

    const done = mounted.model.cloned(`${HOME}/app`);
    flushSync();
    mounted.model.changeUser("alice");
    await tick();
    harness.open();
    await done;
    expect(mounted.started).toEqual([{ path: `${HOME}/app`, name: undefined, user: "dev", addTrust: false }]);
    expect(
      api.calls.find((call) => call.path === "/fs" && call.query.get("path") === `${HOME}/app`)!.query.get("user"),
    ).toBe("dev");
  });

  test("going to the roots leaves the clone view", async () => {
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    mounted.model.creating = true;
    mounted.model.openClone();
    expect(mounted.model.cloning).toBe(true);
    expect(mounted.model.creating).toBe(false);
    mounted.model.go();
    await tick();
    expect(mounted.model.atTop).toBe(true);
    expect(mounted.model.cloning).toBe(false);
  });

  test("the crumbs follow the listing", async () => {
    const mounted = mount();
    await tick();
    expect(mounted.model.crumbs).toEqual([]);
    mounted.model.go(HOME);
    await tick();
    expect(mounted.model.crumbs.map((crumb) => crumb.path)).toEqual(["/home", HOME]);
  });

  test("canClone follows the node answer", async () => {
    const mounted = mount();
    await tick();
    expect(mounted.model.canClone).toBe(true);
  });

  test("a late prompt keeps the typed name, the acknowledgment and moves to the new folder", async () => {
    const mounted = mount({ busyReason: "is updating" });
    mounted.model.go(`${HOME}/b`);
    await tick();
    mounted.model.name = "mine";
    mounted.model.ack = true;
    mounted.model.changeUser("alice");
    await tick();
    mounted.props.initial = { path: `${HOME}/a`, user: "dev", name: "theirs", trust: trust(`${HOME}/a`) };
    await tick();
    expect(mounted.model.trustPrompt).toEqual(trust(`${HOME}/a`));
    expect(mounted.model.name).toBe("mine");
    expect(mounted.model.ack).toBe(true);
    expect(mounted.model.path).toBe(`${HOME}/a`);
    expect(mounted.model.user).toBe("dev");
    expect(mounted.model.listing?.path).toBe(`${HOME}/a`);
    // The new prompt is not wiped by the move.
    mounted.model.start(true);
    expect(mounted.started).toEqual([{ path: `${HOME}/a`, name: "mine", user: "dev", addTrust: true }]);
  });

  test("a late prompt fills a blank name", async () => {
    const mounted = mount();
    mounted.model.go(`${HOME}/b`);
    await tick();
    mounted.props.initial = { path: `${HOME}/a`, name: "theirs", trust: trust(`${HOME}/a`) };
    await tick();
    expect(mounted.model.name).toBe("theirs");
  });

  test("a late prompt during a clone does not move the folder and shows when the clone view closes", async () => {
    const mounted = mount();
    mounted.model.go(`${HOME}/b`);
    await tick();
    mounted.model.name = "mine";
    mounted.model.openClone();
    mounted.model.setCloneBusy(true);
    mounted.props.initial = { path: `${HOME}/a`, user: "alice", trust: trust(`${HOME}/a`, "alice") };
    await tick();
    expect(mounted.model.cloning).toBe(true);
    expect(mounted.model.path).toBe(`${HOME}/b`);
    expect(mounted.model.user).toBe("dev");
    expect(mounted.model.name).toBe("mine");
    mounted.model.setCloneBusy(false);
    mounted.model.closeClone();
    await tick();
    expect(mounted.model.cloning).toBe(false);
    expect(mounted.model.trustPrompt).toEqual(trust(`${HOME}/a`, "alice"));
    expect(mounted.model.path).toBe(`${HOME}/b`);
  });

  test("a late prompt during the clone view survives a clone that succeeds, and nothing starts", async () => {
    const mounted = mount();
    mounted.model.go(`${HOME}/b`);
    await tick();
    mounted.model.openClone();
    mounted.model.setCloneBusy(true);
    mounted.props.initial = { path: `${HOME}/a`, trust: trust(`${HOME}/a`) };
    await tick();
    mounted.model.setCloneBusy(false);
    await mounted.model.cloned(`${HOME}/b/app`);
    await tick();
    expect(mounted.started).toEqual([]);
    expect(mounted.model.trustPrompt).toEqual(trust(`${HOME}/a`));
    expect(mounted.model.path).toBe(`${HOME}/b/app`);
    expect(mounted.model.listing?.path).toBe(`${HOME}/b/app`);
    expect(mounted.model.cloning).toBe(false);
    // The user chooses: the prompt's folder, or the cloned one.
    mounted.model.start(true);
    mounted.model.start();
    expect(mounted.started).toEqual([
      { path: `${HOME}/a`, name: undefined, user: "dev", addTrust: true },
      { path: `${HOME}/b/app`, name: undefined, user: "dev", addTrust: false },
    ]);
  });

  test("a late prompt while the new folder loads survives, the dialog stays in that folder, and nothing starts", async () => {
    const mounted = mount();
    mounted.model.go(`${HOME}/b`);
    await tick();
    mounted.model.openClone();
    const harness = gate();

    api.fs = async (path) => {
      await harness.promise;
      return res(listing(path));
    };

    const done = mounted.model.cloned(`${HOME}/b/app`);
    mounted.props.initial = { path: `${HOME}/a`, user: "alice", trust: trust(`${HOME}/a`, "alice") };
    await tick();
    expect(mounted.model.path).toBe(`${HOME}/b/app`);
    expect(mounted.model.trustPrompt).toEqual(trust(`${HOME}/a`, "alice"));
    harness.open();
    await done;
    await tick();
    expect(mounted.started).toEqual([]);
    expect(mounted.model.path).toBe(`${HOME}/b/app`);
    expect(mounted.model.user).toBe("dev");
    expect(mounted.model.trustPrompt).toEqual(trust(`${HOME}/a`, "alice"));
  });

  test("a prompt from before the clone view opened does not stop the start of the cloned folder", async () => {
    const mounted = mount({ initial: { path: `${HOME}/b`, trust: trust(`${HOME}/b`) } });
    await tick();
    mounted.model.openClone();
    await mounted.model.cloned(`${HOME}/b/app`);
    expect(mounted.started).toEqual([{ path: `${HOME}/b/app`, name: undefined, user: "dev", addTrust: false }]);
  });

  test("cloned does not start when the user left the new folder while it loaded", async () => {
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    const harness = gate();

    api.fs = async (path) => {
      await harness.promise;
      return res(listing(path));
    };

    const done = mounted.model.cloned(`${HOME}/app`);
    mounted.model.go(HOME);
    harness.open();
    await done;
    expect(mounted.started).toEqual([]);
  });

  test("a late prompt while the clone view is open with no clone running keeps the view and the folder", async () => {
    const mounted = mount();
    mounted.model.go(`${HOME}/b`);
    await tick();
    mounted.model.openClone();
    mounted.props.initial = { path: `${HOME}/a`, trust: trust(`${HOME}/a`) };
    await tick();
    expect(mounted.model.cloning).toBe(true);
    expect(mounted.model.path).toBe(`${HOME}/b`);
    expect(mounted.model.trustPrompt).toEqual(trust(`${HOME}/a`));
  });

  test("a second prompt for the same folder after Cancel shows again", async () => {
    const mounted = mount({ initial: { path: `${HOME}/a`, trust: trust(`${HOME}/a`) } });
    await tick();
    mounted.model.cancelTrust();
    expect(mounted.model.trustPrompt).toBeNull();
    mounted.props.initial = { path: `${HOME}/a`, trust: trust(`${HOME}/a`) };
    await tick();
    expect(mounted.model.trustPrompt).toEqual(trust(`${HOME}/a`));
  });

  test("an initial value that goes away leaves the dialog as it is", async () => {
    const mounted = mount({ initial: { path: `${HOME}/a`, name: "n", trust: trust(`${HOME}/a`) } });
    await tick();
    mounted.props.initial = undefined;
    await tick();
    expect(mounted.model.trustPrompt).toEqual(trust(`${HOME}/a`));
    expect(mounted.model.path).toBe(`${HOME}/a`);
    expect(mounted.model.name).toBe("n");
  });

  test("typing a name does not apply the prompt again", async () => {
    const mounted = mount();
    mounted.model.go(`${HOME}/b`);
    await tick();
    mounted.props.initial = { path: `${HOME}/a`, trust: trust(`${HOME}/a`) };
    await tick();
    mounted.model.go(`${HOME}/b`);
    mounted.model.name = "x";
    await tick();
    expect(mounted.model.path).toBe(`${HOME}/b`);
    expect(mounted.model.trustPrompt).toBeNull();
  });

  test("closeClone and setCloneBusy", async () => {
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    mounted.model.openClone();
    mounted.model.setCloneBusy(true);
    expect(mounted.model.cloneBusy).toBe(true);
    mounted.model.setCloneBusy(false);
    mounted.model.setCloneBusy(true);
    expect(mounted.model.cloneBusy).toBe(true);
    mounted.model.setCloneBusy(false);
    expect(mounted.model.cloneBusy).toBe(false);
    mounted.model.closeClone();
    expect(mounted.model.cloning).toBe(false);
  });
});

describe("a person who cannot name a user", () => {
  test("gets no selector and no request names a user", async () => {
    const mounted = mount({ canChooseUser: false });
    await tick();
    expect(mounted.model.usersInfo).toBeNull();
    expect(mounted.model.chosenUser).toBeUndefined();
    expect(browses().every((browse) => !browse.query.has("user"))).toBe(true);
  });
  test("an admin gets the selector", async () => {
    const mounted = mount();
    await tick();
    expect(mounted.model.usersInfo?.default).toBe("dev");
  });
});

const HELP = {
  settings: [
    {
      key: "createSession",
      label: "Create a session at start",
      values: [
        { value: true, label: "On", explanation: "on" },
        { value: false, label: "Off", explanation: "off" },
      ],
    },
    {
      key: "spawnMode",
      label: "Session folders",
      values: [
        { value: "same-dir", label: "Same folder", explanation: "same" },
        { value: "worktree", label: "Worktree", explanation: "tree" },
      ],
    },
  ],
};

describe("instance settings in the start form", () => {
  test("an old node (help 404) shows no settings, no error, and the start sends no settings", async () => {
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    expect(mounted.model.settingsHelp).toBeNull();
    expect(mounted.model.error).toBe("");
    mounted.model.start();
    expect(mounted.started).toEqual([{ path: HOME, name: undefined, user: "dev", addTrust: false }]);
  });

  test("an untouched form sends no settings, so the node defaults decide", async () => {
    api.help = () => res(HELP);
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    expect(mounted.model.settingsHelp).toEqual(HELP);
    // HELP has no defaults (an older node): the form shows the built-in values.
    expect(mounted.model.settings).toEqual({ createSession: true, spawnMode: "same-dir" });
    mounted.model.start();
    expect(mounted.started).toEqual([{ path: HOME, name: undefined, user: "dev", addTrust: false }]);
  });

  test("a changed field sends only that field", async () => {
    api.help = () => res(HELP);
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    mounted.model.settings = { createSession: true, spawnMode: "worktree" };
    mounted.model.start();
    // A field set back to the default is no longer sent.
    mounted.model.settings = { createSession: true, spawnMode: "same-dir" };
    mounted.model.start();
    expect(mounted.started).toEqual([
      { path: HOME, name: undefined, user: "dev", addTrust: false, spawnMode: "worktree" },
      { path: HOME, name: undefined, user: "dev", addTrust: false },
    ]);
  });

  test("the node defaults seed the form, and only a change from them is sent", async () => {
    api.help = () => res({ ...HELP, defaults: { createSession: false, spawnMode: "worktree" } });
    const mounted = mount();
    mounted.model.go(HOME);
    await tick();
    expect(mounted.model.settings).toEqual({ createSession: false, spawnMode: "worktree" });
    mounted.model.start();
    mounted.model.settings = { createSession: true, spawnMode: "worktree" };
    mounted.model.start();
    expect(mounted.started).toEqual([
      { path: HOME, name: undefined, user: "dev", addTrust: false },
      { path: HOME, name: undefined, user: "dev", addTrust: false, createSession: true },
    ]);
  });

  test("after a 428 the dialog keeps the settings of that start and the trust start sends them", async () => {
    api.help = () => res(HELP);
    const settings = { createSession: false, spawnMode: "worktree" as const };
    const mounted = mount({ initial: { path: HOME, trust: trust(HOME), settings } });
    await tick();
    expect(mounted.model.settings).toEqual(settings);
    mounted.model.start(true);
    expect(mounted.started).toEqual([{ path: HOME, name: undefined, user: "dev", addTrust: true, ...settings }]);
  });

  test("a late prompt brings the settings of its start", async () => {
    api.help = () => res(HELP);
    const mounted = mount();
    await tick();
    mounted.props.initial = {
      path: HOME,
      trust: trust(HOME),
      settings: { createSession: false, spawnMode: "worktree" },
    };
    await tick();
    expect(mounted.model.settings).toEqual({ createSession: false, spawnMode: "worktree" });
  });
});
