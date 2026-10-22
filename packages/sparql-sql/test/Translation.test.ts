/**
 * Tests that representative queries are executed entirely in SQL (the root
 * of the algebra is translated into one statement), that untranslatable
 * parts fall back to the engine, and the PostgreSQL SQL generation.
 */
import { assert, describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Result from 'effect/Result';
import * as Stream from 'effect/Stream';
import * as Arr from 'effect/Array';
import * as Order from 'effect/Order';
import { Namespace, Term, Xsd } from '@thomasfosterau/effect-rdf';
import * as Engine from '@thomasfosterau/effect-sparql/Engine';
import * as Parser from '@thomasfosterau/effect-sparql/Parser';
import * as Translate from '@thomasfosterau/effect-sparql/Translate';
import * as Dialect from '../src/Dialect.ts';
import * as SqlStore from '../src/SqlStore.ts';
import * as Translation from '../src/Translation.ts';

const ex = Namespace.make('http://example.org/');

const data = [
  Term.quad(ex('alice'), ex('name'), Term.literal('Alice')),
  Term.quad(ex('alice'), ex('age'), Xsd.integer(30)),
  Term.quad(ex('alice'), ex('knows'), ex('bob')),
  Term.quad(ex('bob'), ex('name'), Term.literal('Bob', 'en')),
  Term.quad(ex('bob'), ex('age'), Xsd.integer(25)),
  Term.quad(ex('bob'), ex('knows'), ex('carol')),
  Term.quad(ex('carol'), ex('name'), Term.literal('Carol')),
  Term.quad(ex('carol'), ex('age'), Xsd.decimal('41.5')),
  Term.quad(ex('dave'), ex('name'), Term.literal('Dave'), ex('g1')),
  Term.quad(ex('dave'), ex('knows'), ex('alice'), ex('g1')),
];

const PREFIX = 'PREFIX ex: <http://example.org/> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> ';

/** Runs a query and returns the solutions (as strings) and the store's events. */
const run = (query: string, quads: ReadonlyArray<Term.Quad> = data) => {
  const events: Array<SqlStore.QueryEvent> = [];
  return Effect.gen(function* () {
    const store = yield* SqlStore.SqlStore;
    yield* store.insert(quads);
    events.length = 0;
    const engine = Engine.make(store);
    const result = yield* engine.query(PREFIX + query);
    const rows =
      result._tag === 'Select'
        ? Arr.sort(
            (yield* Stream.runCollect(result.bindings)).map((b) => b.toString()),
            Order.String,
          )
        : result._tag === 'Ask'
          ? [String(result.value)]
          : [];
    return { rows, events };
  }).pipe(
    Effect.provide(SqlStore.layerSqlite({ filename: ':memory:', onQuery: (e) => events.push(e) })),
  );
};

const executedSql = (events: ReadonlyArray<SqlStore.QueryEvent>): string => {
  const first = events[0];
  assert(
    first?._tag === 'Executed',
    `Not executed in SQL: ${first?._tag === 'Declined' ? first.reason : 'no event'}`,
  );
  return first.sql;
};

describe('SQL execution', () => {
  const cases: ReadonlyArray<readonly [string, string, ReadonlyArray<string | RegExp>]> = [
    ['a BGP', 'SELECT ?p ?n WHERE { ?p ex:knows ?q . ?q ex:name ?n }', ['JOIN rdf_quads']],
    [
      'OPTIONAL with a filter',
      'SELECT * WHERE { ?p ex:name ?n OPTIONAL { ?p ex:age ?a FILTER(?a > 26) } }',
      [/LEFT JOIN \(SELECT .*\) s\d+ ON .*num/],
    ],
    [
      'UNION',
      'SELECT ?x WHERE { { ?x ex:knows ex:bob } UNION { ?x ex:name "Carol" } }',
      ['UNION ALL'],
    ],
    ['MINUS', 'SELECT ?p WHERE { ?p ex:name ?n MINUS { ?p ex:age ?a } }', ['NOT EXISTS']],
    [
      'FILTER NOT EXISTS',
      'SELECT ?p WHERE { ?p ex:name ?n FILTER NOT EXISTS { ?p ex:knows ?q } }',
      ['NOT EXISTS'],
    ],
    ['GRAPH ?g', 'SELECT ?g ?s WHERE { GRAPH ?g { ?s ex:knows ?o } }', ['g <> 0']],
    [
      'VALUES and BIND',
      'SELECT ?p ?x WHERE { VALUES ?p { ex:alice ex:zed } ?p ex:name ?n BIND(?n AS ?x) }',
      ['VALUES'],
    ],
    [
      'GROUP BY with COUNT',
      'SELECT ?p (COUNT(?q) AS ?c) WHERE { ?p ex:knows ?q } GROUP BY ?p HAVING (COUNT(?q) >= 1)',
      ['GROUP BY', 'COUNT('],
    ],
    [
      'DISTINCT and LIMIT',
      'SELECT DISTINCT ?p WHERE { ?p ?x ?y } LIMIT 2 OFFSET 1',
      ['DISTINCT', 'LIMIT 2 OFFSET 1'],
    ],
    [
      'string functions',
      'SELECT ?p WHERE { ?p ex:name ?n FILTER(STRSTARTS(?n, "A") || LANGMATCHES(LANG(?n), "en")) }',
      ['substr', 'lower('],
    ],
    ['triple terms', 'SELECT ?s WHERE { ?s ex:p <<( ex:a ex:b ?o )>> }', ['kind = 4']],
    ['ASK', 'ASK { ?p ex:age ?a FILTER(?a = 25) }', ['num']],
  ];

  for (const [name, query, patterns] of cases) {
    it.effect(`runs ${name} as one SQL statement`, () =>
      Effect.gen(function* () {
        const { events } = yield* run(query);
        const sql = executedSql(events);
        // A string is a substring of the SQL; a RegExp matches it.
        for (const p of patterns) expect(sql).toMatch(p);
        // The root was translated: no other node was offered.
        expect(events.length).toBe(1);
      }),
    );
  }

  it.effect('computes the right answers in SQL', () =>
    Effect.gen(function* () {
      const optional = yield* run(
        'SELECT ?n ?a WHERE { ?p ex:name ?n OPTIONAL { ?p ex:age ?a FILTER(?a > 26) } }',
      );
      expect(optional.rows).toEqual([
        '{ ?n → "Alice", ?a → "30"^^<http://www.w3.org/2001/XMLSchema#integer> }',
        '{ ?n → "Bob"@en }',
        '{ ?n → "Carol", ?a → "41.5"^^<http://www.w3.org/2001/XMLSchema#decimal> }',
      ]);
      const count = yield* run('SELECT (COUNT(*) AS ?c) WHERE { ?s ex:knows ?o }');
      expect(count.rows).toEqual(['{ ?c → "2"^^<http://www.w3.org/2001/XMLSchema#integer> }']);
      const graphs = yield* run('SELECT ?g WHERE { GRAPH ?g { ?s ex:knows ?o } }');
      expect(graphs.rows).toEqual(['{ ?g → <http://example.org/g1> }']);
      const values = yield* run('SELECT ?x WHERE { VALUES ?x { "new" ex:alice } }');
      expect(values.rows).toEqual(['{ ?x → "new" }', '{ ?x → <http://example.org/alice> }']);
    }),
  );

  it.effect('leaves untranslatable nodes to the engine, translating their children', () =>
    Effect.gen(function* () {
      const { rows, events } = yield* run(
        'SELECT ?n WHERE { ?p ex:name ?n FILTER(REGEX(?n, "^[AB]")) } ORDER BY ?n',
      );
      expect(rows.length).toBe(2);
      expect(events[0]).toMatchObject({ _tag: 'Declined' });
      expect(events.some((e) => e._tag === 'Executed' && e.operation._tag === 'Bgp')).toBe(true);
    }),
  );

  it.effect('falls back to the engine when the data needs exact comparisons SQL cannot do', () =>
    Effect.gen(function* () {
      const quads = [
        ...data,
        Term.quad(ex('x'), ex('age'), Xsd.float(25)),
        Term.quad(
          ex('y'),
          ex('age'),
          Term.literal('2020-01-01', Term.namedNode('http://www.w3.org/2001/XMLSchema#date')),
        ),
      ];
      const { rows, events } = yield* run(
        'SELECT ?p WHERE { ?p ex:age ?a . ?q ex:age ?b FILTER(?a < ?b) }',
        quads,
      );
      expect(events[0]).toMatchObject({
        _tag: 'Declined',
        reason: 'The data contains values SQL cannot compare exactly',
      });
      expect(rows.length).toBeGreaterThan(0);
      // Comparisons with constants of a known class remain in SQL.
      const constant = yield* run('SELECT ?p WHERE { ?p ex:age ?a FILTER(?a < 26) }', quads);
      expect(constant.events[0]?._tag).toBe('Executed');
      expect(constant.rows).toEqual([
        '{ ?p → <http://example.org/bob> }',
        '{ ?p → <http://example.org/x> }',
      ]);
    }),
  );
});

describe('PostgreSQL SQL generation', () => {
  const compile = (query: string) => {
    const algebra = Translate.translateQuery(Parser.parseQueryUnsafe(PREFIX + query));
    let next = 1;
    const ids = new Map<string, number>();
    return Translation.compile(
      algebra.input,
      {
        dialect: Dialect.postgres,
        tables: Dialect.tables(),
        dataset: { defaultGraph: 'default', namedGraphs: 'all' },
        activeGraph: { _tag: 'DefaultGraph' },
      },
      (t) => {
        let id = ids.get(t.key);
        if (id === undefined) ids.set(t.key, (id = next++));
        return id;
      },
    );
  };

  it('uses numbered placeholders, typed NULLs and binary collation', () => {
    const result = compile(
      'SELECT ?n ?m WHERE { ?p ex:name ?n OPTIONAL { ?p ex:nick ?m } FILTER(?n < "B" && CONTAINS(?n, "o")) }',
    );
    assert(Result.isSuccess(result));
    const { sql, params } = result.success;
    expect(sql).not.toContain('?');
    expect(sql).toContain('$1');
    expect(sql).toContain('COLLATE "C"');
    expect(sql).toContain('strpos(');
    expect(params).toEqual(expect.arrayContaining(['B', 'o']));
    const union = compile('SELECT * WHERE { { ?a ex:p ?b } UNION { ?a ex:q ?c } }');
    assert(Result.isSuccess(union));
    expect(union.success.sql).toContain('CAST(NULL AS BIGINT)');
  });

  it('declares a schema with an md5 key index', () => {
    const ddl = Dialect.postgres.schema(Dialect.tables()).join('\n');
    expect(ddl).toContain('md5(value)');
    expect(ddl).toContain('GENERATED BY DEFAULT AS IDENTITY');
    expect(Dialect.sqlite.schema(Dialect.tables('x_')).join('\n')).toContain('WITHOUT ROWID');
  });

  it('reports untranslatable algebra', () => {
    const result = compile('SELECT ?s WHERE { ?s ex:p+ ?o }');
    expect(Result.isFailure(result)).toBe(true);
  });
});
