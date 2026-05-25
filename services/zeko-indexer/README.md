# @zeko/zeko-indexer

Unified Zeko indexer runtime projection logic.

This package consumes the shared NATS event contracts and materializes the
runtime rows defined by the PRD and the WEB-426 database schema branch. The core
indexer is intentionally tested through Gherkin/Vitest scenarios over a store
boundary so rollback, DA status derivation, bridge correlation, ULID
assignment, and zkApp schema-blind ingestion can be verified without coupling
tests to private helper functions.
