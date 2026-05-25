# @zeko/database

SurrealDB service workspace for the explorer read model. `surrealkit/` is the
single source for desired initial schema, seed data, and SurrealKit metadata.
The Kubernetes chart references that project instead of carrying a second copy.

Moon entrypoints:

- `moon run database:test` runs the Gherkin suite through Vitest/Cucumber
  against a real SurrealDB v3 container and SurrealKit.
- `moon run database:migrate-local` reconciles a disposable local database with
  `surrealkit sync --fail-fast`.

This initial bootstrap PR intentionally does not carry numbered migration files.
Follow-up live schema evolution should use SurrealKit rollout migrations once
there is an existing deployed database to advance.
