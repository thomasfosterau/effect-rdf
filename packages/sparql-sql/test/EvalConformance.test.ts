/**
 * The W3C SPARQL evaluation tests against the SQLite backend (a fresh
 * in-memory database per test).
 */
import * as Effect from 'effect/Effect';
import * as SqlStore from '../src/SqlStore.ts';
import { conformanceSuite } from './support/conformance.ts';
import { withLayer } from '../../sparql/test/support/layer.ts';

conformanceSuite('SQLite', {
  minRootShare: 0.5,
  run: (f, onQuery) =>
    Effect.runPromise(
      Effect.flatMap(Effect.service(SqlStore.SqlStore), f).pipe(
        withLayer(SqlStore.layerSqlite({ filename: ':memory:', onQuery })),
      ),
    ),
});
