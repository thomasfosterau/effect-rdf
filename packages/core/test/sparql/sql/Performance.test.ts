import { assert, describe, expect, layer } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';
import { Namespace, Term, Xsd } from '@thomasfosterau/effect-rdf';
import * as Bindings from '@thomasfosterau/effect-rdf/sparql/Bindings';
import * as Engine from '@thomasfosterau/effect-rdf/sparql/Engine';
import * as SqlStore from '../../../src/sparql/sql/SqlStore.ts';
import { layerSqlite } from './support/sqlite.ts';

const ex = Namespace.make('http://example.org/');

const N = 100_000;

const triples = (): Array<Term.Quad> => {
  const people = N / 4;
  return Array.from({ length: people }, (_, i) => {
    const p = ex(`person/${i}`);
    return [
      Term.quad(p, ex('name'), Term.literal(`Person ${i}`)),
      Term.quad(p, ex('age'), Xsd.integer(i % 90)),
      Term.quad(p, ex('knows'), ex(`person/${(i * 7 + 1) % people}`)),
      Term.quad(p, ex('type'), ex(i % 3 === 0 ? 'Student' : 'Employee')),
    ];
  }).flat();
};

describe('Performance', () => {
  layer(layerSqlite({ filename: ':memory:' }))((test) => {
    test.effect(
      `bulk loads ${N} triples and queries them in SQL`,
      () =>
        Effect.gen(function* () {
          const store = yield* SqlStore.SqlStore;
          const data = triples();
          const start = performance.now();
          yield* store.insert(data);
          const loaded = performance.now() - start;
          const count = store.count ?? assert.fail('the SQL store counts quads');
          expect(yield* count({})).toBe(N);
          // Loading 100k triples into SQLite takes a few seconds at most.
          expect(loaded).toBeLessThan(30_000);

          const engine = Engine.make(store);
          const queryStart = performance.now();
          const result = yield* engine.select(`
          PREFIX ex: <http://example.org/>
          SELECT (COUNT(*) AS ?n) WHERE {
            ?a ex:knows ?b . ?b ex:type ex:Student . ?a ex:age ?age FILTER(?age >= 18 && ?age < 30)
          }`);
          const rows = yield* Stream.runCollect(result.bindings);
          const queried = performance.now() - queryStart;
          const n = Bindings.getUndefined(rows[0] ?? assert.fail('expected a COUNT row'), 'n');
          expect(Term.isLiteral(n) && Number(n.value) > 0).toBe(true);
          expect(queried).toBeLessThan(10_000);
          yield* Effect.logInfo(
            `Loaded ${N} triples in ${loaded.toFixed(0)} ms; join + filter + count in ${queried.toFixed(0)} ms`,
          );
        }),
      120_000,
    );
  });
});
