import type { StartArgs } from "./features/instances";
import type { NewInitial, TrustPrompt } from "./features/new-instance";

// What startErrorAction decided about a failed start.
export type StartFailure = { kind: "trust"; prompt: TrustPrompt } | { kind: "error"; message: string };

// The state around the selected host, the New dialog and the error of the last start, and the moves between those states.
// App holds one of these and only draws it. The mutation itself stays in App: it needs the query client.
export function createStartFlow(initialHost: string) {
  let selected = $state(initialHost);
  let showNew = $state(false);
  // Set when a start got a 428 "untrusted": the dialog opens again at that folder with the trust question. Each 428 sets
  // a new object, and an open dialog shows the new prompt without a remount.
  let newInitial = $state<NewInitial | undefined>();
  let startError = $state("");

  function clearOutcome() {
    newInitial = undefined;
    startError = "";
  }

  return {
    get selected() { return selected; },
    get showNew() { return showNew; },
    get newInitial() { return newInitial; },
    get startError() { return startError; },

    /** The user picked a host. */
    select(id: string) {
      selected = id;
      showNew = false;
      clearOutcome();
    },
    /** The host list says the selected host is gone. The dialog stays as it is. */
    fallback(id: string) {
      if (id === selected) return;
      selected = id;
      clearOutcome();
    },
    openNew() {
      newInitial = undefined;
      showNew = true;
    },
    closeNew() {
      showNew = false;
      newInitial = undefined;
    },
    /** The dialog handed over a start: the dialog closes and the old outcome goes. The caller runs the mutation. */
    startNew() {
      showNew = false;
      clearOutcome();
    },
    /** A start on `host` failed. Say nothing once the user is on another host. */
    startFailed(host: string, failure: StartFailure, a: StartArgs) {
      if (host !== selected) return;
      if (failure.kind === "error") {
        startError = failure.message;
        return;
      }
      // This prompt replaces the one in the open dialog: say that the displaced folder still needs trust.
      if (showNew && newInitial && newInitial.path !== a.path) startError = `Trust needed for ${newInitial.path}`;
      newInitial = { path: a.path, user: a.user, name: a.name, trust: failure.prompt };
      showNew = true;
    },
  };
}
