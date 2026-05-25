# @zeko/database

SurrealDB service workspace for the explorer read model. `surrealkit/` is the
single source for desired schema, seed data, future migration files, and
SurrealKit metadata. The Kubernetes chart references that project instead of
carrying a second copy.

Moon entrypoints:

- `moon run database:test` runs the Gherkin suite through Vitest/Cucumber
  against a real SurrealDB v3 container and SurrealKit.
- `moon run database:sync-local` reconciles a disposable local database with
  `surrealkit sync --fail-fast`.

This initial schema PR intentionally does not carry numbered migration files.
Follow-up schema evolution should add SurrealKit migration files under
`surrealkit/migrations/`; the Kubernetes chart already mounts that path.
