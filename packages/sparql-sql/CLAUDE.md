# @thomasfosterau/effect-sparql-sql

A SQL storage backend for the SPARQL engine on `effect/sql`: a term dictionary (with triple terms), `SqlStore` implementing `QuadStore`, and `Translation` / `Dialect` turning algebra subtrees into one SQL statement through the engine's `QueryCapability`, on SQLite (`node:sqlite`) or PostgreSQL.

## Boundary

Peers: `effect`. Runtime dependencies: `@effect/sql-sqlite-node`. Imports from this workspace: core, sparql (tests reuse `packages/sparql/test/support`) — `.fallowrc.json` zone `sparql-sql`.

## Invariants

- **Same solutions as the in-memory engine:** the W3C evaluation suite runs on SQLite and on PostgreSQL (PGlite), and the differential tests compare translated against generic evaluation; untranslatable subtrees fall back to the engine.
- **Exact comparisons:** floats and constants compare as SPARQL does, not as the database would by default.
- **Schema changes are migrations** (`effect/sql` `Migrator`).

## Terms

- **Term dictionary** — the interned id ↔ term table every quad column references.
