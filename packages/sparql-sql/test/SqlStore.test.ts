import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import { Dataset, Namespace, Term, Xsd } from '@thomasfosterau/effect-rdf';
import * as Bindings from '@thomasfosterau/effect-sparql/Bindings';
import * as Engine from '@thomasfosterau/effect-sparql/Engine';
import * as Store from '@thomasfosterau/effect-sparql/Store';
import * as SqlStore from '../src/SqlStore.ts';

const ex = Namespace.make('http://example.org/');
const foaf = Namespace.make('http://xmlns.com/foaf/0.1/');

const data = [
  Term.quad(ex('alice'), foaf('name'), Term.literal('Alice')),
  Term.quad(ex('alice'), foaf('age'), Xsd.integer(30)),
  Term.quad(ex('alice'), foaf('knows'), ex('bob')),
  Term.quad(ex('bob'), foaf('name'), Term.literal('Bob')),
  Term.quad(ex('bob'), foaf('mbox'), Term.namedNode('mailto:bob@example.org')),
  Term.quad(ex('bob'), foaf('age'), Xsd.integer(25)),
  Term.quad(ex('carol'), foaf('name'), Term.literal('Carol', 'en'), ex('g1')),
  Term.quad(Term.triple(ex('alice'), foaf('knows'), ex('bob')), ex('since'), Xsd.integer(2020)),
];

const StoreLayer = SqlStore.layerSqlite({ filename: ':memory:' });
const TestLayer = Engine.layer({ baseIri: 'http://example.org/' }).pipe(
  Layer.provideMerge(StoreLayer),
);

const lex = (t: Term.GroundTerm | undefined): string | undefined =>
  t === undefined || t._tag === 'Triple' ? undefined : t.value;

describe('SqlStore', () => {
  it.effect('stores, matches and counts quads', () =>
    Effect.gen(function* () {
      const store = yield* Store.QuadStore;
      yield* store.insert(data);
      yield* store.insert(data);
      const all = yield* Store.toDataset(store);
      expect(Dataset.toNQuads(all)).toBe(Dataset.toNQuads(Dataset.fromIterable(data)));
      const names = yield* Stream.runCollect(store.match({ predicate: foaf('name') }));
      expect(names.length).toBe(3);
      const defaultNames = yield* Stream.runCollect(
        store.match({ predicate: foaf('name'), graph: Term.defaultGraph }),
      );
      expect(defaultNames.length).toBe(2);
      expect(yield* store.count!({ predicate: foaf('name'), graph: undefined })).toBe(3);
      expect(yield* store.count!({ subject: ex('nobody') })).toBe(0);
      const graphs = yield* Stream.runCollect(store.graphs);
      expect(graphs.map((g) => g.value)).toEqual([ex('g1').value]);
      yield* store.delete([data[0]!]);
      expect(yield* store.count!({})).toBe(data.length - 1);
      yield* store.createGraph(ex('empty'));
      expect(yield* store.hasGraph(ex('empty'))).toBe(true);
      yield* store.dropGraph(ex('g1'));
      expect(yield* store.hasGraph(ex('g1'))).toBe(false);
    }).pipe(Effect.provide(StoreLayer)),
  );

  it.effect('rolls back failed transactions', () =>
    Effect.gen(function* () {
      const store = yield* Store.QuadStore;
      yield* store.insert(data.slice(0, 2));
      const result = yield* Effect.result(
        store.transaction(
          Effect.andThen(store.insert(data.slice(2)), Effect.fail('boom' as const)),
        ),
      );
      expect(result._tag).toBe('Failure');
      expect(yield* store.count!({})).toBe(2);
    }).pipe(Effect.provide(StoreLayer)),
  );

  it.effect('evaluates queries in SQL', () =>
    Effect.gen(function* () {
      const store = yield* Store.QuadStore;
      yield* store.insert(data);
      const engine = yield* Engine.SparqlEngine;
      const result = yield* engine.select(
        'PREFIX foaf: <http://xmlns.com/foaf/0.1/> SELECT ?name ?age WHERE { ?p foaf:name ?name OPTIONAL { ?p foaf:age ?age FILTER(?age > 26) } }',
      );
      const rows = yield* Stream.runCollect(result.bindings);
      expect(
        rows
          .map(
            (b) =>
              `${lex(Bindings.getUndefined(b, 'name'))}:${lex(Bindings.getUndefined(b, 'age'))}`,
          )
          .sort(),
      ).toEqual(['Alice:30', 'Bob:undefined']);
      const count = yield* engine.select('SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }');
      const c = yield* Stream.runCollect(count.bindings);
      expect(lex(Bindings.getUndefined(c[0]!, 'n'))).toBe('1');
      const since = yield* engine.select(
        'SELECT ?y WHERE { <<( ?a <http://xmlns.com/foaf/0.1/knows> ?b )>> <http://example.org/since> ?y }',
      );
      const s = yield* Stream.runCollect(since.bindings);
      expect(s.map((b) => lex(Bindings.getUndefined(b, 'y')))).toEqual(['2020']);
    }).pipe(Effect.provide(TestLayer)),
  );
});
