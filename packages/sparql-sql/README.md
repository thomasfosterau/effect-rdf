# @thomasfosterau/effect-sparql-sql

A swappable SQL storage backend for
[`@thomasfosterau/effect-sparql`](../sparql), built on Effect's SQL
abstraction (`effect/sql`: `SqlClient`, `Statement`, `Migrator`). It
implements the engine's `QuadStore` service **and** its `QueryCapability`
extension point: SPARQL algebra is translated to SQL, so whole queries (or the
largest translatable subtrees) run as a single SQL statement, and everything
else falls back to the generic engine.

- **SQLite** (default) through `@effect/sql-sqlite-node` (`node:sqlite`).
- **PostgreSQL** through `@effect/sql-pg` (or any `SqlClient` with the `pg`
  dialect).

## Usage

```ts
import { Effect, Layer, Stream } from 'effect';
import { Engine } from '@thomasfosterau/effect-sparql';
import { SqlStore } from '@thomasfosterau/effect-sparql-sql';

// SQLite file (or ':memory:'); provides SqlStore, QuadStore and SqlClient.
const SparqlLive = Engine.layer().pipe(
  Layer.provideMerge(SqlStore.layerSqlite({ filename: 'data.db' })),
);

const program = Effect.gen(function* () {
  const store = yield* SqlStore.SqlStore;
  yield* store.insert(quads); // batched, interned, one transaction

  const engine = yield* Engine.SparqlEngine;
  const result = yield* engine.select(`
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>
    SELECT ?name (COUNT(?friend) AS ?friends) WHERE {
      ?p foaf:name ?name OPTIONAL { ?p foaf:knows ?friend }
    } GROUP BY ?name`);
  yield* Stream.runForEach(result.bindings, (b) => Effect.log(b.toString()));
});
```

With PostgreSQL, provide any `SqlClient` to `SqlStore.layer`:

```ts
import { PgClient } from '@effect/sql-pg';

const StoreLive = SqlStore.layer().pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(process.env.DATABASE_URL!) })),
);
```

`SqlStoreOptions`: `dialect` (detected from the client), `tablePrefix`
(default `rdf_`), `migrate` (create/migrate the schema with the Effect
`Migrator`, default `true`), `translate` (SPARQL-to-SQL, default `true`),
`batchSize`, `pageSize` (streaming `match`) and `onQuery`, a debug hook that
receives an event for every algebra node offered to the store (`Executed`
with the SQL text, or `Declined` with the reason). `store.compile(op)` returns
the SQL for an algebra tree without running it; queries are also traced with
an `SqlStore.query` span carrying the SQL text.

## Schema

| table              | columns                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| `rdf_terms`        | `id`, `kind`, `value`, `datatype`, `lang`, `dir`, `sub`, `pre`, `obj`, `cls`, `num` |
| `rdf_quads`        | `s`, `p`, `o`, `g` (term ids; `g = 0` is the default graph)                         |
| `rdf_graphs`       | `id` — explicitly created (possibly empty) named graphs                             |
| `rdf_term_classes` | `cls` — the comparison classes present in the dictionary                            |
| `rdf_migrations`   | the store's `Migrator` table                                                        |

- **Terms are interned** in an append-only dictionary. `kind` is 1 IRI, 2
  blank node, 3 literal, 4 triple term. RDF 1.2 **triple terms are
  first-class**: `sub`, `pre`, `obj` hold the ids of their components (and
  `value` is `"s p o"`, so `(value, kind, datatype, lang, dir)` is the unique
  key of every term — indexed on `md5(value)` in PostgreSQL). Triple terms are
  indexed by component.
- `cls` is a **comparison class** (numeric, double, float, string,
  language-tagged string, boolean, temporal, unknown datatype, ill-formed, …)
  and `num` the numeric value of numeric and boolean literals; they let SQL
  evaluate SPARQL comparisons and effective boolean values per row.
- Quads are indexed `spog` (primary key), `posg`, `ospg` and `gspo`.
- Inserts are batched (terms with `INSERT … ON CONFLICT DO NOTHING
  RETURNING`, then quads), in one transaction; ids are cached in memory
  outside transactions. Loading 100,000 triples into SQLite takes about 1.5 s.

## QuadStore

`match` streams by keyset pagination over the index matching the bound
positions; `estimate` (bounded count) and `count` are SQL counts; `insert`,
`delete`, `createGraph`, `dropGraph`, `clear`, `graphs`, `hasGraph`; and
`transaction` maps to `SqlClient.withTransaction` (nested transactions use
savepoints).

## SPARQL to SQL

The engine offers every algebra node top-down; the store returns a stream
when the whole subtree is **exactly** translatable, otherwise the engine
evaluates the node itself and offers its children again. Solutions are rows of
term ids (`NULL` = unbound); the final `SELECT` joins the dictionary to decode
them.

| algebra                          | SQL                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| BGP                              | self-joins of `rdf_quads` (triple term patterns join `rdf_terms` on `kind = 4`)      |
| `Join`                           | merged `FROM`/`WHERE` with compatibility conditions (`NULL`-aware)                   |
| `LeftJoin`                       | `LEFT JOIN (…) ON compatible AND filter` (the OPTIONAL filter is in the `ON` clause) |
| `Union`                          | `UNION ALL` with `NULL` padding                                                      |
| `Minus`, `[NOT] EXISTS`          | correlated `NOT EXISTS` / `EXISTS`                                                   |
| `Filter`                         | `WHERE` (see expressions)                                                            |
| `Graph` (IRI or variable)        | graph column constraints; `FROM` / `FROM NAMED` datasets, union default graph        |
| `Extend`                         | term-valued expressions (variables, constants, `IF`, `COALESCE`, boolean results)    |
| `Values`                         | `VALUES` lists (terms not in the store get query-local negative ids)                 |
| `Project`, `Distinct`, `Reduced` | column selection, `SELECT DISTINCT`                                                  |
| `Slice`                          | `LIMIT` / `OFFSET`                                                                   |
| `Group`                          | `GROUP BY` variables with `COUNT(*)`, `COUNT([DISTINCT] ?x)`, `SAMPLE(?x)`; `HAVING` |

Expressions: `&&`, `||`, `!` (SPARQL's error semantics coincide with SQL's
three-valued logic, an error being `NULL`), `=`, `!=`, `<`, `>`, `<=`, `>=`,
`IN`, `NOT IN`, `BOUND`, `sameTerm`, `isIRI`, `isBlank`, `isLiteral`,
`isNumeric`, `isTRIPLE`, `hasLANG`, `hasLANGDIR`, `STR`, `LANG`, `DATATYPE`,
`STRLEN`, `STRSTARTS`, `STRENDS`, `CONTAINS`, `LANGMATCHES`, `IF`,
`COALESCE`, `EXISTS`, and effective boolean values.

**Correctness first.** Comparisons follow the engine exactly: numbers compare
by value (`1 = 1.0`), strings by code point (binary collation), language
strings only with the same tag, booleans by value, IRIs and blank nodes by
identity, incomparable values are errors. Combinations SQL cannot compare
exactly — dates and durations, integers beyond 2^53, decimals with more than
15 digits, `NaN`/`INF`, float/double promotion against non-constants, triple
term value equality — are recorded at compilation; before running, the store
checks which comparison classes the data contains and hands the node back to
the engine when such a combination can occur.

Evaluated by the engine (with their translatable children in SQL): `ORDER BY`
(SPARQL's ordering is not a total order SQL can reproduce), property paths,
`SERVICE`, `REGEX`, arithmetic, casts, string-building and date/time
functions, `SUM`/`AVG`/`MIN`/`MAX`/`GROUP_CONCAT`, group keys that are
expressions, and `LIMIT`/`GROUP BY` inside `GRAPH ?g`. Results are fetched
with one statement per translated subtree (SQLite has no cursors in
`node:sqlite`).

## Adding a dialect

A `Dialect` (see `Dialect.ts`) only produces SQL text; statements run through
the `SqlClient`. Implement:

- `schema(tables)` — idempotent DDL for the tables above (and a unique index
  on the dictionary key);
- `placeholder(i)` and `anonymousParameters` — `?` (positional) or `$1`;
- `valueKey` — the dictionary key expression (e.g. `md5(value)`);
- typed `NULL`s and casts (`nullId`, `castId`, `castText`, `castDouble`,
  `castInt`) for databases that type `NULL` and parameters strictly;
- `binary(text)` — code point collation; `startsWith`, `endsWith`,
  `contains`, `length` (in characters) and `hasNonZeroDigit`;
- `limitOffset`, `maxParameters`.

The database must support `INSERT … ON CONFLICT DO NOTHING RETURNING`, row
value comparisons, `VALUES` lists and correlated subqueries. Pass the dialect
as `SqlStore.layer({ dialect })` (or extend `Dialect.fromClient`).

## Tests

- The W3C SPARQL 1.0/1.1/1.2 evaluation tests run against SQLite (a fresh
  database per test) **and against PostgreSQL** (PGlite, PostgreSQL compiled
  to WASM, through a small `SqlClient` adapter in `test/support/pglite.ts`):
  707/707 runnable query, update and result-format tests pass on both (the
  same 77 entailment and federation tests as the in-memory store are
  skipped). More than half of the queries run entirely as one SQL statement.
- Differential tests compare the SQL store with the in-memory store on
  random queries over random datasets (including data that forces the
  exactness fallbacks).
- Translation tests assert that representative queries are executed entirely
  in SQL and inspect the generated SQL (SQLite and PostgreSQL).
- A bulk-load test loads 100,000 triples and runs a join/filter/count query.
