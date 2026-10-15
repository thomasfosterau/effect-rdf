/**
 * The W3C SPARQL evaluation tests against the SQLite backend (a fresh
 * in-memory database per test).
 */
import * as Effect from 'effect/Effect';
import * as SqlStore from '../src/SqlStore.ts';
import { conformanceSuite } from './support/conformance.ts';

conformanceSuite('SQLite', {
  minRootShare: 0.5,
  run: (f, onQuery) =>
    Effect.runPromise(
      Effect.flatMap(Effect.service(SqlStore.SqlStore), f).pipe(
        Effect.provide(SqlStore.layerSqlite({ filename: ':memory:', onQuery })),
      ),
    ),
});
