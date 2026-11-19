# Web app

- `web/src/routes/`: SvelteKit pages (`instances`, `sessions`, `nodes`, `history`, `permissions`, `updates`, `appearance`), `+layout.svelte`, `layout.css`.
- `web/src/lib/`: `features/` (auth, clone, hosts, instances, new-instance, permissions, sessions, updates), `components/ui/` (shadcn), `shell/` (bottom nav, menu sheet, theme), `shared/` (http, query, theme), `realtime/events.ts` (event stream).
- Tests: vitest with a custom client environment (`web/test/client-env.ts`); helper `inRoot` in `web/test/effect-root.svelte.ts`; `web/test/fake-api.ts` for browser checks against a fake API.
- bits-ui radio and select render buttons with `role=radio`/`aria-checked`, not native inputs; tests query those.
- shadcn style `nova`; components not yet added (for example `radio-group`, `field`) may be hand-written when the CLI cannot run.
