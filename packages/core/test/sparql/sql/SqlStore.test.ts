import { assert, expect, layer } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import * as Arr from 'effect/Array';
import * as Order from 'effect/Order';
import { Dataset, Namespace, Term, Xsd } from '@thomasfosterau/effect-rdf';
import * as Bindings from '@thomasfosterau/effect-rdf/sparql/Bindings';
import * as Engine from '@thomasfosterau/effect-rdf/sparql/Engine';
import * as Store from '@thomasfosterau/effect-rdf/sparql/Store';
import { layerSqlite } from './support/sqlite.ts';

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

const StoreLayer = layerSqlite({ filename: ':memory:' });
const TestLayer = Engine.layer({ baseIri: 'http://example.org/' }).pipe(
  Layer.provideMerge(StoreLayer),
);

/** The lexical form of a bound non-triple term (`'undefined'` when there is none). */
const lex = (t: Option.Option<Term.GroundTerm>): string =>
  Option.match(
    Option.filter(t, (x) => !Term.isTriple(x)),
    { onNone: () => 'undefined', onSome: (x) => x.value },
  );

// A fresh in-memory database for each test.
layer(TestLayer, { buildPerTest: true })('SqlStore', (test) => {
  test.effect('stores, matches and counts quads', () =>
    Effect.gen(function* () {
      const store = yield* Store.QuadStore;
      const count = store.count ?? assert.fail('the SQL store counts quads');
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
      expect(yield* count({ predicate: foaf('name'), graph: undefined })).toBe(3);
      expect(yield* count({ subject: ex('nobody') })).toBe(0);
      const graphs = yield* Stream.runCollect(store.graphs);
      expect(graphs.map((g) => g.value)).toEqual([ex('g1').value]);
      yield* store.delete(data.slice(0, 1));
      expect(yield* count({})).toBe(data.length - 1);
      yield* store.createGraph(ex('empty'));
      expect(yield* store.hasGraph(ex('empty'))).toBe(true);
      yield* store.dropGraph(ex('g1'));
      expect(yield* store.hasGraph(ex('g1'))).toBe(false);
    }),
  );

  test.effect('rolls back failed transactions', () =>
    Effect.gen(function* () {
      const store = yield* Store.QuadStore;
      const count = store.count ?? assert.fail('the SQL store counts quads');
      yield* store.insert(data.slice(0, 2));
      const result = yield* Effect.result(
        store.transaction(
          Effect.andThen(store.insert(data.slice(2)), Effect.fail('boom' as const)),
        ),
      );
      expect(result._tag).toBe('Failure');
      expect(yield* count({})).toBe(2);
    }),
  );

  test.effect('evaluates queries in SQL', () =>
    Effect.gen(function* () {
      const store = yield* Store.QuadStore;
      yield* store.insert(data);
      const engine = yield* Engine.SparqlEngine;
      const result = yield* engine.select(
        'PREFIX foaf: <http://xmlns.com/foaf/0.1/> SELECT ?name ?age WHERE { ?p foaf:name ?name OPTIONAL { ?p foaf:age ?age FILTER(?age > 26) } }',
      );
      const rows = yield* Stream.runCollect(result.bindings);
      expect(
        Arr.sort(
          rows.map((b) => `${lex(Bindings.get(b, 'name'))}:${lex(Bindings.get(b, 'age'))}`),
          Order.String,
        ),
      ).toEqual(['Alice:30', 'Bob:undefined']);
      const count = yield* engine.select('SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }');
      const c = yield* Stream.runCollect(count.bindings);
      expect(lex(Bindings.get(c[0] ?? assert.fail('expected a COUNT row'), 'n'))).toBe('1');
      const since = yield* engine.select(
        'SELECT ?y WHERE { <<( ?a <http://xmlns.com/foaf/0.1/knows> ?b )>> <http://example.org/since> ?y }',
      );
      const s = yield* Stream.runCollect(since.bindings);
      expect(s.map((b) => lex(Bindings.get(b, 'y')))).toEqual(['2020']);
    }),
  );
});
