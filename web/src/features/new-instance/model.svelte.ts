import { untrack } from "svelte";
import { createMutation, createQuery, type QueryClient } from "@tanstack/svelte-query";
import { ApiError } from "../../shared/http";
import type { StartArgs } from "../instances";
import type { DirListing } from "./api";
import { breadcrumbs } from "./crumbs";
import { browseQuery, mkdirMutation, nodeQuery, usersQuery } from "./queries";
import { trustStartArgs, type NewInitial, type TrustPrompt } from "./trustprompt";

// The state and rules of the New dialog. NewDialog only draws this.
// It must run inside a component or an $effect.root, because it makes queries and effects. The host is read once:
// App remounts the dialog (#key) when the host changes. `initial` is read again: a 428 that comes while the dialog
// is open hands in a new object, which shows its trust question without a remount.
export function createNewDialogModel(opts: {
  host: string;
  client: QueryClient;
  initial: () => NewInitial | undefined;
  busyReason: () => string | undefined;
  onstart: (a: StartArgs) => void;
}) {
  const { host, client } = opts;
  // The dialog opens again after a 428 with the folder, user and name of that start, and its trust question.
  const init = untrack(() => opts.initial());
  let path = $state<string | undefined>(init?.path);
  let name = $state(init?.name ?? "");
  // Set while the machine updates or restarts: a start or a clone can be cut off, so the user must agree first.
  let ack = $state(false);
  const needsAck = $derived(!!opts.busyReason() && !ack);
  let creating = $state(false);
  let folderName = $state("");
  let userPick = $state<string | undefined>(init?.user);
  let trustPrompt = $state<TrustPrompt | null>(init?.trust ?? null);
  // The clone view is open.
  let cloning = $state(false);
  // True while a clone runs (the panel can be open with no clone running). Close is locked then.
  let cloneBusy = $state(false);

  // An older node without /users fails this query: then there is no selector.
  const usersQ = createQuery(() => usersQuery(host), () => client);
  // An old node or an error: no clone button, no message.
  const nodeQ = createQuery(() => nodeQuery(host), () => client);
  const usersInfo = $derived(usersQ.data?.selectable ? usersQ.data : null);
  const user = $derived(userPick ?? usersInfo?.default ?? "");
  // Only pass a user when the selector is shown.
  const chosenUser = $derived(usersInfo ? user : undefined);
  // Wait for the users answer, so the first listing is for the user that a start would use.
  const browseQ = createQuery(() => ({ ...browseQuery(host, path, chosenUser), enabled: !usersQ.isPending }), () => client);
  const mkdirM = createMutation(() => mkdirMutation(host, client), () => client);
  const listing = $derived<DirListing | null>(browseQ.data ?? null);
  const canClone = $derived(nodeQ.data?.clone === true);
  const error = $derived(
    browseQ.isError
      ? browseQ.error instanceof ApiError ? browseQ.error.message : "Failed to browse"
      : mkdirM.isError
        ? mkdirM.error instanceof ApiError ? mkdirM.error.message : "Failed to create folder"
        : "",
  );

  const atTop = $derived(!listing || listing.path === "");
  // The panel only makes sense inside a folder.
  $effect(() => { if (atTop && cloning) cloning = false; });
  const crumbs = $derived(listing ? breadcrumbs(listing.path) : []);

  // A new `initial` after creation is a late prompt: a 428 came while the dialog was open. It shows its trust question,
  // keeps the typed name, the acknowledgment and the clone view. Outside the clone view, the folder and the user move
  // to the prompt's. In the clone view they stay (a move would empty the listing and close the view); the prompt
  // shows once the view closes. They also stay while the folder of a finished clone loads. A value that goes away
  // (undefined) changes nothing.
  let applied = init;
  // Counts the late prompts, so cloned() can tell whether one came after the clone view opened.
  let latePrompts = 0;
  let promptsAtCloneOpen = 0;
  // True from the end of a clone until the listing of its folder has loaded.
  let loadingCloned = false;
  $effect(() => {
    const next = opts.initial();
    if (next === applied) return;
    applied = next;
    if (!next) return;
    untrack(() => {
      if (!cloning && !loadingCloned) {
        go(next.path);
        userPick = next.user;
      }
      trustPrompt = next.trust;
      latePrompts++;
      if (!name.trim()) name = next.name ?? "";
    });
  });

  function go(p?: string) {
    path = p;
    trustPrompt = null;
    mkdirM.reset();
  }

  // Hands the start to App, which closes the dialog and shows a pending row. It does not wait.
  // A trust start uses the prompt's folder and user, so it works while the listing loads or after a browse error.
  function startWith(addTrust: boolean, l: DirListing | null, u: string | undefined) {
    if (needsAck) return;
    const a = trustStartArgs(trustPrompt, l, u, addTrust);
    if (!a) return;
    opts.onstart({ path: a.path, name: name.trim() || undefined, user: a.user, addTrust: a.addTrust });
  }

  return {
    get name() { return name; },
    set name(v: string) { name = v; },
    get ack() { return ack; },
    set ack(v: boolean) { ack = v; },
    get creating() { return creating; },
    set creating(v: boolean) { creating = v; },
    get folderName() { return folderName; },
    set folderName(v: string) { folderName = v; },
    get path() { return path; },
    get user() { return user; },
    get usersInfo() { return usersInfo; },
    get chosenUser() { return chosenUser; },
    get listing() { return listing; },
    get canClone() { return canClone; },
    get error() { return error; },
    get atTop() { return atTop; },
    get crumbs() { return crumbs; },
    get trustPrompt() { return trustPrompt; },
    get needsAck() { return needsAck; },
    get mkdirPending() { return mkdirM.isPending; },
    get cloning() { return cloning; },
    get cloneBusy() { return cloneBusy; },

    go,

    changeUser(value: string) {
      userPick = value;
      go(path);
    },

    createFolder() {
      if (!listing || !folderName.trim()) return;
      mkdirM.mutate(
        { parent: listing.path, name: folderName.trim(), user: chosenUser },
        {
          onSuccess: (r) => {
            creating = false;
            folderName = "";
            go(r.path);
          },
        },
      );
    },

    /** The clone panel finished a clone into `p`: browse it and start there. */
    async cloned(p: string) {
      // The user of the clone. A change of the selector while the listing loads must not change the start.
      const u = chosenUser;
      // A late prompt that came while the clone view was open stays: the dialog enters `p` but does not start it, and
      // the user picks "Trust and start" or "Start here".
      const late = latePrompts !== promptsAtCloneOpen ? trustPrompt : null;
      cloning = false;
      go(p);
      if (late) trustPrompt = late;
      loadingCloned = true;
      try {
        const l = await client.fetchQuery(browseQuery(host, p, u));
        // Start only when the listing is the new folder, the dialog is still there, and no late prompt came;
        // a trust question then comes back for `p`.
        if (l.path === p && path === p && latePrompts === promptsAtCloneOpen) startWith(false, l, u);
      } catch {
        // The browse error shows from the query.
      } finally {
        loadingCloned = false;
      }
    },

    start(addTrust = false) {
      startWith(addTrust, listing, chosenUser);
    },

    cancelTrust() {
      trustPrompt = null;
    },

    openClone() {
      promptsAtCloneOpen = latePrompts;
      cloning = true;
      creating = false;
    },

    closeClone() {
      cloning = false;
    },

    /** The clone panel says whether a clone runs. */
    setCloneBusy(b: boolean) {
      cloneBusy = b;
    },
  };
}
