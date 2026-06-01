# Agent Notes

- At the beginning of each agent session, validate the toolchain environment once: `which proto`, `proto --version`, `which moon`, and `moon --version` must resolve to the versions pinned in `.prototools`. If they do not, fix shell activation or install/sync the Proto toolchain before running project tasks. Make sure that the changes that you make stick, so that every tool call and command you run inherits the proper environment.
- Treat `docs/PRD.md`, which is generated from `docs/PRD.html` and `docs/spikes/` content as source of truth; Linear issue description is never authoritative, unless explicitly told so.
- Run tool commands directly, for example `moon ci`, `pnpm install`, `node ...`, and `nu ...`. If a command only works when wrapped with `proto run`, the session environment is misconfigured; fix shell activation or install/sync the Proto toolchain so every command inherits the pinned tools from `.prototools`.
- Use Moon tasks as the command source of truth. Do not add `package.json` scripts.
- Keep tool versions in `.prototools`. Do not duplicate Node or PNPM versions in Moon toolchain config.
- Manage Go-based developer tools through Moon's Go toolchain `bins` in `.moon/toolchains.yml`; do not add custom `go install ...` scripts.
- Use PNPM catalog entries for external JavaScript dependencies.
- Use Proto-managed Nushell through `proto-nu` for local automation scripts. Do not add Bash entrypoint scripts or npm Nushell packages.
- Use Biome for linting and formatting. Do not add ESLint, Prettier, oxlint, or oxfmt.
- For product/domain behavior and acceptance coverage, write Gherkin feature files and run them through the repo's Vitest/Cucumber pattern, such as `@amiceli/vitest-cucumber`.
- Use `surql` and SurrealQL terminology for SurrealDB query/schema artifacts. Do not name SurrealDB files, helpers, variables, or features `sql`; reserve SQL terminology only for an actual SQL database.
- Use explicit `.ts` extensions for relative TypeScript imports in repo code and tests. The repo allows TypeScript source imports directly, so write `./foo.ts` rather than `./foo`.
- Treat TypeScript project references as Moon-managed output. The root `tsconfig.json` is the Moon-generated TypeScript solution file; fix `.moon/toolchains.yml` or project `moon.yml` dependency metadata, then run `moon sync projects` instead of hand-editing generated references.
- Use `wrangler.jsonc` and generated Wrangler Env types for Cloudflare Workers.
- Use `.kyaml` for Kubernetes values. Use `.tpl` for Helm template sources so YAML tooling only parses rendered manifests.
- Keep `apps/` for consumer surfaces and `services/` for backend services.
