import { untrack } from "svelte";
import { createMutation, createQuery, type QueryClient } from "@tanstack/svelte-query";
import { ApiError } from "../../shared/http";
import { filterGroups } from "./repofilter";
import {
  cloneJobQuery,
  cloneStartMutation,
  githubLoginStartMutation,
  isCloneDone,
  isLoginDone,
  loginJobQuery,
  reposQuery,
} from "./queries";

// The state and rules of the clone panel. ClonePanel only draws this.
// It must run inside a component or an $effect.root, because it makes queries and effects. The host is read once;
// `parent` and `user` are read when they are needed.
export function createCloneModel(opts: {
  host: string;
  client: QueryClient;
  parent: () => string;
  user: () => string | undefined;
  oncloned: (path: string) => void;
  /** Called at once when a clone starts and when it ends in any way, so the dialog can lock Close. */
  onbusy?: (busy: boolean) => void;
}) {
  const { host, client } = opts;
  let repo = $state("");
  let query = $state("");
  let cloning = $state(false);

  // Every change of `cloning` goes through here, so the parent hears it at once (an $effect would run later).
  function setCloning(value: boolean) {
    cloning = value;
    opts.onbusy?.(value);
  }

  let cloneError = $state("");
  // The login code is short-lived and shown once. It is kept in memory only.
  let login = $state<{ code: string; url: string } | null>(null);
  let loginError = $state("");
  let signingIn = $state(false);
  // A job keeps the host it started on. It is cleared once its result is handled, which also stops its query.
  let cloneJob = $state<{ host: string; id: string } | null>(null);
  let loginJob = $state<{ host: string; id: string } | null>(null);

  const reposQ = createQuery(
    () => reposQuery(host, opts.user()),
    () => client,
  );
  const cloneM = createMutation(
    () => cloneStartMutation(host),
    () => client,
  );
  const loginM = createMutation(
    () => githubLoginStartMutation(host),
    () => client,
  );
  const cloneQ = createQuery(
    () => ({ ...cloneJobQuery(cloneJob?.host ?? host, cloneJob?.id ?? ""), enabled: cloneJob !== null }),
    () => client,
  );
  const loginQ = createQuery(
    () => ({ ...loginJobQuery(loginJob?.host ?? host, loginJob?.id ?? ""), enabled: loginJob !== null }),
    () => client,
  );

  const needLogin = $derived(
    reposQ.error instanceof ApiError &&
      reposQ.error.status === 409 &&
      reposQ.error.body?.code === "github-login-required",
  );
  const listError = $derived(
    !reposQ.isError || needLogin
      ? ""
      : reposQ.error instanceof ApiError
        ? reposQ.error.message
        : "Failed to load repos",
  );
  const groups = $derived(reposQ.data?.groups ?? []);
  const listLoading = $derived(reposQ.isPending);
  const shown = $derived(filterGroups(groups, query));

  // Handle the end of a clone job once: clearing cloneJob makes the next run return early.
  $effect(() => {
    if (!cloneJob) return;
    const failed = cloneQ.isError;
    const clone = cloneQ.data;
    if (!failed && !(cloneQ.isSuccess && isCloneDone(clone))) return;
    untrack(() => {
      cloneJob = null;
      setCloning(false);
      if (failed) cloneError = "Lost track of the clone. Check the folder before trying again.";
      else if (clone!.state === "done") {
        if (clone!.path) opts.oncloned(clone!.path);
        else cloneError = "The server did not return the folder path.";
      } else cloneError = clone!.error || "Clone failed";
    });
  });

  // Handle the end of a sign-in once, in the same way.
  $effect(() => {
    if (!loginJob) return;
    const failed = loginQ.isError;
    const item = loginQ.data;
    if (!failed && !(loginQ.isSuccess && isLoginDone(item))) return;
    untrack(() => {
      const jobHost = loginJob!.host;
      loginJob = null;
      login = null;
      signingIn = false;
      if (failed) loginError = "Lost track of the sign-in. Try again.";
      // A reset (not only an invalidate) drops the 409, so the list shows "Loading repos..." while it reloads.
      else if (item!.state === "done") client.resetQueries({ queryKey: reposQuery(jobHost, opts.user()).queryKey });
      else loginError = item!.error || "Sign-in failed";
    });
  });

  return {
    get repo() {
      return repo;
    },
    set repo(value: string) {
      repo = value;
    },
    get query() {
      return query;
    },
    set query(value: string) {
      query = value;
    },
    get cloning() {
      return cloning;
    },
    get cloneError() {
      return cloneError;
    },
    get login() {
      return login;
    },
    get loginError() {
      return loginError;
    },
    get signingIn() {
      return signingIn;
    },
    get needLogin() {
      return needLogin;
    },
    get listError() {
      return listError;
    },
    get listLoading() {
      return listLoading;
    },
    /** The repo groups that match the search field. */
    get shown() {
      return shown;
    },

    pick(name: string) {
      repo = name;
    },

    async clone() {
      if (!repo.trim() || cloning) return;
      setCloning(true);
      cloneError = "";
      const jobHost = host;

      try {
        const { id } = await cloneM.mutateAsync({ repo: repo.trim(), parent: opts.parent(), user: opts.user() });
        cloneJob = { host: jobHost, id };
      } catch (error) {
        setCloning(false);
        cloneError = error instanceof ApiError ? error.message : "Failed to clone";
      }
    },

    async signIn() {
      if (signingIn) return;
      signingIn = true;
      loginError = "";
      const jobHost = host;

      try {
        const harness = await loginM.mutateAsync({ user: opts.user() });
        login = { code: harness.code, url: harness.url };
        loginJob = { host: jobHost, id: harness.id };
      } catch (error) {
        signingIn = false;
        loginError = error instanceof ApiError ? error.message : "Failed to start sign-in";
      }
    },

    /** The component calls this from onDestroy, so the dialog does not stay locked after the panel goes. */
    destroy() {
      if (cloning) opts.onbusy?.(false);
    },
  };
}
