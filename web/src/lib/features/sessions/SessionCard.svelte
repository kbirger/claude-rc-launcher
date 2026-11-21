<script lang="ts">
  import Desktop from "@tabler/icons-svelte/icons/device-desktop";
  import GitBranch from "@tabler/icons-svelte/icons/git-branch";
  import * as Card from "#lib/components/ui/card/index.js";
  import type { GlobalSession } from "./api";
  import { sessionBranch, sessionDetail, sessionState, sessionsHref, sessionTitle, worktreeName } from "./format";

  // One row of the session list: the name, the state, the node and the instance, and the details.
  // `where` shows the node and the instance. The list of one instance turns it off: its heading already says it.
  let { session, now, where = true }: { session: GlobalSession; now: number; where?: boolean } = $props();
  const wt = $derived(worktreeName(session.root));
  const branch = $derived(sessionBranch(session));
</script>

<a
  href={sessionsHref({ host: session.host.id, instance: session.instance.id, session: session.id })}
  class="block min-h-11 min-w-0 no-underline"
>
  <Card.Root size="sm" class="gap-1 *:px-4">
    <Card.Content class="grid grid-cols-[minmax(0,1fr)] gap-1">
      {@const title = sessionTitle(session)}
      {@const st = sessionState(session)}
      <!-- The name has the first line and is cut with an ellipsis when it is too long (the full name is the tooltip). At the end of the line: the status dot (green when live, gray when offline; it pulses while busy). A Remote Control session shows a desktop icon with the dot on its corner. -->
      <div class="flex items-start justify-between gap-2">
        <span
          data-session-title
          class="min-w-0 flex-1 truncate {title ? 'font-semibold' : 'font-normal text-muted-foreground'}"
          {title}
        >
          {title ?? "Untitled session"}
        </span>
        <span class="flex h-6 flex-none items-center gap-2">
          {#if st.remoteControl}
            <!-- The icon has the text color. The status dot sits on its lower right corner. -->
            <span
              class="relative inline-flex"
              title={`Remote Control. ${st.title}`}
              role="img"
              aria-label={`Remote Control. ${st.title}`}
            >
              <Desktop size={20} aria-hidden="true" />
              <span
                class={"absolute -right-1 -bottom-1 size-2.5 rounded-full ring-2 ring-card " +
                  (st.live ? "bg-success" : "bg-muted-foreground/50") +
                  (st.busy ? " animate-pulse" : "")}
              ></span>
            </span>
          {:else}
            <span
              class={"size-2.5 rounded-full " +
                (st.live ? "bg-success" : "bg-muted-foreground/50") +
                (st.busy ? " animate-pulse" : "")}
              title={st.title}
              role="img"
              aria-label={st.title}
            ></span>
          {/if}
        </span>
      </div>
      {#if where}<div class="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-session-where>
          {session.host.name} · {session.instance.name}
        </div>{/if}
      <div class="flex flex-wrap gap-x-2 text-muted-foreground">
        {#each sessionDetail(session, now) as part, i (i)}
          <span class={i === 0 ? "font-mono" : "min-w-0 [overflow-wrap:anywhere]"}>{part}</span>
        {/each}
        {#if branch}<span data-session-branch class="inline-flex min-w-0 items-center gap-1"
            ><GitBranch size={14} class="flex-none" aria-hidden="true" /><span class="min-w-0 [overflow-wrap:anywhere]"
              >{branch}</span
            ></span
          >{/if}
        {#if wt}<span class="min-w-0 [overflow-wrap:anywhere]">work tree: {wt}</span>{/if}
      </div>
    </Card.Content>
  </Card.Root>
</a>
