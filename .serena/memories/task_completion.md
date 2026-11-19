# Task completion

Match CI (`.github/workflows/ci.yml`). From the repo root with bun on PATH:

1. `bun run typecheck`
2. `bun run --cwd web check` (0 errors, 0 warnings)
3. `bun run test`
4. `bun run build`

- A change to the Windows node or its shared code also needs its test files in the `windows` job test list in `ci.yml`.
- A UI change is not verified until seen in a browser; tests do not cover layout.
- Commit only when asked. Do not push or open a PR unless asked.
