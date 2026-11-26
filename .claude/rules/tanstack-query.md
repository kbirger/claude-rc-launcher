---
paths:
  - "web/src/**/queries.ts"
  - "web/src/**/mutations.ts"
  - "web/src/**/model.svelte.ts"
---

# TanStack Query

This project uses `@tanstack/svelte-query` (v6). Do not rely on memory for its API: it differs from the React version and changes between major versions.

Before writing or changing query, mutation or cache code, search the official docs with the TanStack CLI:

```bash
bunx @tanstack/cli search-docs "<topic>" --library query --framework svelte --json
```

- Replace `<topic>` with what you need, for example `"mutations"`, `"invalidation"` or `"optimistic updates"`.
- Use the search results as the source of truth when they disagree with what you remember.
