# Tech stack

- Runtime and tooling: Bun (version pinned in `.bun-version`). Not on PATH here: `export PATH=$HOME/.bun/bin:$PATH`. System Node is 18, too old for many CLIs (shadcn-svelte CLI fails); run tools through bun (`bunfig.toml` `[run] bun = true`).
- Server: TypeScript, Hono, jose (JWT), openid-client (OIDC), @peculiar/x509 (TLS certs), reflect-metadata. Built with `bun build --compile` into one binary; `BUILD_VERSION` comes from `scripts/version.ts`.
- Web: SvelteKit 3 + Svelte 5 runes, adapter-static, Tailwind 4, shadcn-svelte (style `nova`, alias `#lib`, not `$lib`) on bits-ui, `@lucide/svelte`, TanStack Query for data, vitest + jsdom for tests.
- Release: git-cliff computes the version and notes from commit messages (`cliff.toml`), tags build via `.github/workflows/release.yml`.
- Language server in Serena: svelte only.
