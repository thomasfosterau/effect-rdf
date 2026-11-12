import { expect, layer } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import { Dataset, Namespace, Term } from '@thomasfosterau/effect-rdf';
import * as Bindings from '../../src/sparql/Bindings.ts';
import * as Engine from '../../src/sparql/Engine.ts';
import * as Store from '../../src/sparql/Store.ts';

const ex = Namespace.make('http://example.org/');
const hostile = `${'a'.repeat(32)}!`;
const matching = 'a'.repeat(32);

const data = Dataset.make(
  Term.quad(ex('hostile'), ex('v'), Term.literal(hostile)),
  Term.quad(ex('matching'), ex('v'), Term.literal(matching)),
);

const TestLayer = Engine.layer({ baseIri: 'http://example.org/' }).pipe(
  Layer.provideMerge(Store.layerMemory(data)),
);

layer(TestLayer)('SPARQL regular expression bounds', (test) => {
  test.effect('REGEX with a catastrophic pattern runs in linear time', () =>
    Effect.gen(function* () {
      const engine = yield* Engine.SparqlEngine;
      const start = performance.now();
      const result = yield* engine.select(
        'SELECT ?s WHERE { ?s <http://example.org/v> ?v FILTER REGEX(?v, "^(a+)+$") }',
      );
      const rows = yield* Stream.runCollect(result.bindings);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(2000);
      expect(
        rows.map((b) => Option.map(Bindings.get(b, 's'), (t) => (Term.isTriple(t) ? '' : t.value))),
      ).toEqual([Option.some('http://example.org/matching')]);
    }),
  );

  test.effect('REPLACE with a catastrophic pattern runs in linear time', () =>
    Effect.gen(function* () {
      const engine = yield* Engine.SparqlEngine;
      const start = performance.now();
      const result = yield* engine.select(
        'SELECT ?r WHERE { ?s <http://example.org/v> ?v FILTER(STRSTARTS(?v, "aaa")) BIND(REPLACE(?v, "(a+)+$", "x") AS ?r) } ORDER BY ?r',
      );
      const rows = yield* Stream.runCollect(result.bindings);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(2000);
      expect(
        rows.map((b) => Option.map(Bindings.get(b, 'r'), (t) => (Term.isTriple(t) ? '' : t.value))),
      ).toEqual([Option.some(`${'a'.repeat(32)}!`), Option.some('x')]);
    }),
  );
});
