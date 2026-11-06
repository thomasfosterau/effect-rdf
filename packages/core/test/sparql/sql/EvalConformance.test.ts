/**
 * The W3C SPARQL evaluation tests against the SQLite backend (a fresh
 * in-memory database per test).
 */
import * as Effect from 'effect/Effect';
import * as SqlStore from '../../../src/sparql/sql/SqlStore.ts';
import { layerSqlite } from './support/sqlite.ts';
import { conformanceSuite } from './support/conformance.ts';
import { withLayer } from '../support/layer.ts';

conformanceSuite('SQLite', {
  minRootShare: 0.5,
  run: (f, onQuery) =>
    Effect.runPromise(
      Effect.flatMap(Effect.service(SqlStore.SqlStore), f).pipe(
        withLayer(layerSqlite({ filename: ':memory:', onQuery })),
      ),
    ),
});
