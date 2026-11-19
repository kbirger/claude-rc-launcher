# Conventions

- Commits: conventional (`feat:`, `fix:`, `docs:`, `ci:`; scope like `feat(web):`). git-cliff reads them for versions and notes.
- Server files are flat in `server/src/`, one concern per file, a test of the same name in `server/test/`.
- Hub forwards, node acts. A route that changes a host needs: role row, audit line (`action=... old= new= want=`), hub validation, node implementation on Linux and Windows.
- Node explanation texts for the UI come from the node (for example the settings help route) and render as text. The web page ignores keys or values it does not know.
- Web: state logic lives in tested `.svelte.ts` models that take the `QueryClient` as an argument, import no `.svelte`, and are used by thin components. Feature folders under `web/src/lib/features/<name>/` with `api.ts`, `queries.ts`, `mutations.ts`, `model.svelte.ts`, `index.ts`.
- Web UI uses shadcn-svelte components from `#lib/components/ui/`. Hand-written components copy the shadcn style (`cn`, `data-slot`, `WithElementRef`).
- Docs and user-facing text follow simple English: short sentences, no contractions, no em-dashes or semicolons.
