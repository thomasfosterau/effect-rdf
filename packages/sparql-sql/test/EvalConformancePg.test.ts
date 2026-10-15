/**
 * The W3C SPARQL evaluation tests against the PostgreSQL dialect, using
 * PGlite (PostgreSQL compiled to WASM) through a minimal `SqlClient`. One
 * database is shared by all tests; quads and graphs are cleared between
 * tests (the term dictionary is append-only and kept).
 */
import { afterAll } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as SqlClient from 'effect/sql/SqlClient';
import * as Dialect from '../src/Dialect.ts';
import * as SqlStore from '../src/SqlStore.ts';
import { conformanceSuite } from './support/conformance.ts';
import * as PGlite from './support/pglite.ts';

let listener: ((event: SqlStore.QueryEvent) => void) | undefined;

const runtime = ManagedRuntime.make(
  SqlStore.layer({ dialect: Dialect.postgres, onQuery: (e) => listener?.(e) }).pipe(
    Layer.provideMerge(PGlite.layer),
  ),
);

afterAll(() => runtime.dispose());

conformanceSuite('PostgreSQL via PGlite', {
  minRootShare: 0.4,
  run: (f, onQuery) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* SqlStore.SqlStore;
        yield* sql.unsafe(`DELETE FROM ${store.tables.quads}`);
        yield* sql.unsafe(`DELETE FROM ${store.tables.graphs}`);
        listener = onQuery;
        return yield* f(store);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            listener = undefined;
          }),
        ),
      ),
    ),
});
