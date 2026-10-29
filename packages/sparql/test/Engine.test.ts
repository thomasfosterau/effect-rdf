import * as crypto from 'node:crypto';
import { assert, describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { Dataset, Namespace, Term, Xsd } from '@thomasfosterau/effect-rdf';
import * as Algebra from '../src/Algebra.ts';
import * as Bindings from '../src/Bindings.ts';
import * as Engine from '../src/Engine.ts';
import * as Hash from '../src/internal/hash.ts';
import * as Parser from '../src/Parser.ts';
import * as Q from '../src/QueryBuilder.ts';
import * as Results from '../src/Results.ts';
import * as Store from '../src/Store.ts';
import * as TermSchema from '../src/TermSchema.ts';
import * as Translate from '../src/Translate.ts';

const lex = (t: Term.GroundTerm | undefined): string | undefined =>
  t === undefined || t._tag === 'Triple' ? undefined : t.value;

const ex = Namespace.make('http://example.org/');
const foaf = Namespace.make('http://xmlns.com/foaf/0.1/');

const data = Dataset.make(
  Term.quad(ex('alice'), foaf('name'), Term.literal('Alice')),
  Term.quad(ex('alice'), foaf('age'), Xsd.integer(30)),
  Term.quad(ex('alice'), foaf('knows'), ex('bob')),
  Term.quad(ex('bob'), foaf('name'), Term.literal('Bob')),
  Term.quad(ex('bob'), foaf('mbox'), Term.namedNode('mailto:bob@example.org')),
  Term.quad(ex('bob'), foaf('age'), Xsd.integer(25)),
  Term.quad(ex('carol'), foaf('name'), Term.literal('Carol'), ex('g1')),
);

const TestLayer = Engine.layer({ baseIri: 'http://example.org/' }).pipe(
  Layer.provideMerge(Store.layerMemory(data)),
);

describe('Engine', () => {
  it.effect('evaluates SELECT queries as streams', () =>
    Effect.gen(function* () {
      const engine = yield* Engine.SparqlEngine;
      const result = yield* engine.select(
        'PREFIX foaf: <http://xmlns.com/foaf/0.1/> SELECT ?name WHERE { ?p foaf:name ?name } ORDER BY ?name',
      );
      const rows = yield* Stream.runCollect(result.bindings);
      expect(rows.map((b) => lex(Bindings.getUndefined(b, 'name')))).toEqual(['Alice', 'Bob']);
      expect(result.variables.map((v) => v.value)).toEqual(['name']);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('evaluates ASK, CONSTRUCT and GRAPH patterns', () =>
    Effect.gen(function* () {
      const engine = yield* Engine.SparqlEngine;
      expect(yield* engine.ask('ASK { <http://example.org/alice> ?p ?o }')).toBe(true);
      expect(yield* engine.ask('ASK { GRAPH ?g { ?s ?p "Carol" } }')).toBe(true);
      expect(yield* engine.ask('ASK { ?s ?p "Carol" }')).toBe(false);
      const quads = yield* Stream.runCollect(
        yield* engine.construct(
          'PREFIX foaf: <http://xmlns.com/foaf/0.1/> CONSTRUCT { ?b foaf:knownBy ?a } WHERE { ?a foaf:knows ?b }',
        ),
      );
      expect(quads.map((q) => q.toString())).toEqual([
        '<http://example.org/bob> <http://xmlns.com/foaf/0.1/knownBy> <http://example.org/alice> .',
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('supports the union default graph option', () =>
    Effect.gen(function* () {
      const engine = Engine.make(yield* Store.makeMemory(data), { unionDefaultGraph: true });
      expect(yield* engine.ask('ASK { ?s ?p "Carol" }')).toBe(true);
    }),
  );

  it.effect('executes updates atomically', () =>
    Effect.gen(function* () {
      const store = yield* Store.makeMemory(data);
      const engine = Engine.make(store);
      yield* engine.update(
        'PREFIX ex: <http://example.org/> INSERT DATA { ex:dave ex:p 1 } ; DELETE WHERE { ex:bob ?p ?o }',
      );
      const after = yield* store.snapshot;
      expect(Dataset.match(after, { subject: ex('bob') })).toHaveLength(0);
      expect(Dataset.match(after, { subject: ex('dave') })).toHaveLength(1);
      // A failing request leaves the store unchanged.
      const failure = yield* Effect.result(
        engine.update(
          'PREFIX ex: <http://example.org/> INSERT DATA { ex:erin ex:p 1 } ; CREATE GRAPH ex:g1 ; CREATE GRAPH ex:g1',
        ),
      );
      assert.isTrue(Result.isFailure(failure));
      expect(Dataset.match(yield* store.snapshot, { subject: ex('erin') })).toHaveLength(0);
    }),
  );

  it.effect('reports parse errors with positions', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Parser.parseQuery('SELECT * WHERE {\n  ?s ?p \n}'));
      expect(error._tag).toBe('SparqlParseError');
      expect(error.line).toBe(3);
      expect(error.column).toBe(1);
    }),
  );

  it.effect('streams lazily: LIMIT stops evaluation early', () =>
    Effect.gen(function* () {
      const big = Dataset.fromIterable(
        Array.from({ length: 20_000 }, (_, i) => Term.quad(ex(`s${i}`), ex('p'), Xsd.integer(i))),
      );
      let matched = 0;
      const base = yield* Store.makeMemory(big);
      const counting: Store.QuadStoreShape = {
        ...base,
        match: (pattern) => Stream.tap(base.match(pattern), () => Effect.sync(() => matched++)),
      };
      const engine = Engine.make(counting);
      const result = yield* engine.select(
        'SELECT ?s WHERE { ?s <http://example.org/p> ?o } LIMIT 5',
      );
      const rows = yield* Stream.runCollect(result.bindings);
      expect(rows).toHaveLength(5);
      expect(matched).toBeLessThan(20_000);
    }),
  );

  it.effect('offers algebra to a store query capability first', () =>
    Effect.gen(function* () {
      const base = yield* Store.makeMemory(data);
      const seen: Array<string> = [];
      const store: Store.QuadStoreShape = {
        ...base,
        query: {
          evaluate: (op) => {
            seen.push(op._tag);
            return op._tag === 'Bgp' && op.patterns.length === 1
              ? Option.some(Stream.succeed(Bindings.make({ name: Term.literal('native') })))
              : Option.none();
          },
        },
      };
      const engine = Engine.make(store);
      const result = yield* engine.select(
        'SELECT ?name WHERE { ?p <http://xmlns.com/foaf/0.1/name> ?name }',
      );
      const rows = yield* Stream.runCollect(result.bindings);
      expect(rows.map((r) => lex(Bindings.getUndefined(r, 'name')))).toEqual(['native']);
      expect(seen).toContain('Project');
      expect(seen).toContain('Bgp');
    }),
  );
});

describe('Pre-binding', () => {
  const run = (query: string, bindings: Record<string, Term.GroundTerm>) =>
    Effect.gen(function* () {
      const engine = yield* Engine.SparqlEngine;
      const result = yield* engine.select(`PREFIX foaf: <http://xmlns.com/foaf/0.1/>\n${query}`, {
        bindings: Bindings.make(bindings),
      });
      return (yield* Stream.runCollect(result.bindings)).map((b) => b.toString());
    });

  it.effect('makes pre-bound values visible in FILTERs of empty groups', () =>
    Effect.gen(function* () {
      expect(
        yield* run('SELECT $this WHERE { FILTER ($this = <http://example.org/alice>) }', {
          this: ex('alice'),
        }),
      ).toEqual(['{ ?this → <http://example.org/alice> }']);
      expect(
        yield* run('SELECT $this WHERE { FILTER ($this = <http://example.org/alice>) }', {
          this: ex('bob'),
        }),
      ).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('pre-binds BGPs, UNION branches, BIND and nested groups', () =>
    Effect.gen(function* () {
      expect(
        yield* run('SELECT ?name WHERE { $this foaf:name ?name }', { this: ex('bob') }),
      ).toEqual(['{ ?name → "Bob" }']);
      expect(
        yield* run(
          'SELECT $this ?x WHERE { { FILTER (false) } UNION { BIND ($this AS ?x) } FILTER bound($this) }',
          { this: ex('bob') },
        ),
      ).toEqual(['{ ?this → <http://example.org/bob>, ?x → <http://example.org/bob> }']);
      expect(
        yield* run(
          'SELECT ?n WHERE { ?p foaf:knows ?q . FILTER EXISTS { $this foaf:name ?n0 } ?q foaf:name ?n }',
          { this: ex('carol') },
        ),
      ).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('pre-binds GRAPH ?g, ASK and algebra evaluation', () =>
    Effect.gen(function* () {
      const engine = yield* Engine.SparqlEngine;
      expect(
        yield* engine.ask('ASK { GRAPH ?g { ?s ?p "Carol" } }', {
          bindings: Bindings.make({ g: ex('g1') }),
        }),
      ).toBe(true);
      expect(
        yield* engine.ask('ASK { GRAPH ?g { ?s ?p "Carol" } }', {
          bindings: Bindings.make({ g: ex('g2') }),
        }),
      ).toBe(false);
      const op = Translate.translatePattern(
        (yield* Parser.parseQuery('SELECT * WHERE { ?s ?p ?o }')).where,
      );
      const rows = yield* Stream.runCollect(
        engine.evaluate(op, { bindings: Bindings.make({ s: ex('alice'), p: foaf('age') }) }),
      );
      expect(rows.map((r) => lex(Bindings.getUndefined(r, 'o')))).toEqual(['30']);
    }).pipe(Effect.provide(TestLayer)),
  );

  it('rewrites the algebra by values insertion', () => {
    const op = Algebra.prebind(
      Translate.translatePattern(
        Effect.runSync(Parser.parseQuery('SELECT * WHERE { ?s ?p ?o FILTER (?o != 1) }')).where,
      ),
      Bindings.make({ s: ex('alice') }),
    );
    expect(Algebra.format(op)).toContain('<http://example.org/alice> ?p ?o');
    expect(Algebra.format(op)).toContain('table');
  });
});

describe('QueryBuilder', () => {
  const v = Q.vars('person', 'name', 'email', 'p', 'age');
  const query = Q.select('person', 'name', Q.maybe('email'))
    .where(Q.triple(v.person, foaf('name'), v.name))
    .optional(Q.triple(v.person, foaf('mbox'), v.email))
    .orderBy(Q.desc(v.name));

  it('builds ASTs that print as SPARQL', () => {
    const text = query.toString();
    expect(text).toContain('OPTIONAL');
    const reparsed = Parser.parseQueryUnsafe(text);
    expect(reparsed._tag).toBe('Select');
    expect(Algebra.format(Translate.translateQuery(reparsed).input)).toContain('leftjoin');
  });

  it.effect('executes with typed rows', () =>
    Effect.gen(function* () {
      const rows = yield* Q.executeAll(query);
      const first = rows[0]!;
      // Type-level: name is required, email optional.
      const name: Term.GroundTerm = first.name;
      const email: Term.GroundTerm | undefined = first.email;
      expect(lex(name)).toBe('Bob');
      expect(lex(email)).toBe('mailto:bob@example.org');
      expect(rows[1]!.email).toBeUndefined();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('decodes rows with schemas', () =>
    Effect.gen(function* () {
      const people = Q.select('name', 'age')
        .where(Q.triple(v.p, foaf('name'), v.name), Q.triple(v.p, foaf('age'), v.age))
        .filter(Q.gt(v.age, 26));
      const decoded = yield* Stream.runCollect(
        Q.decode(people, Schema.Struct({ name: TermSchema.string, age: TermSchema.integer })),
      );
      expect(decoded).toEqual([{ name: 'Alice', age: 30 }]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('supports aggregates and grouping', () =>
    Effect.gen(function* () {
      const q = Q.select(Q.as(Q.count(), 'n'), Q.as(Q.sum(v.age), 'total')).where(
        Q.triple(v.p, foaf('age'), v.age),
      );
      const [row] = yield* Q.executeAll(q);
      expect(lex(row!.n)).toBe('2');
      expect(lex(row!.total)).toBe('55');
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('Results formats', () => {
  const tt = Term.triple(ex('a'), ex('b'), Term.literal('c', { language: 'ar', direction: 'rtl' }));
  const set: Results.ResultSet = {
    _tag: 'ResultSet',
    variables: ['x', 'y', 'z'],
    bindings: [
      Bindings.make({ x: ex('a'), y: Term.literal('hello, "world"\n', 'en'), z: tt }),
      Bindings.make({ x: Term.blankNode('b0'), y: Xsd.integer(42) }),
      Bindings.make({ y: Term.literal('5', ex('dt')) }),
    ],
  };

  [Results.Json, Results.Xml, Results.Tsv].forEach((codec) => {
    it.effect(`round-trips ${codec.format.name}`, () =>
      Effect.gen(function* () {
        const text = codec.serializeString(set);
        const parsed = yield* codec.parse(text);
        assert.strictEqual(parsed._tag, 'ResultSet');
        // SAFETY: asserted to be a `ResultSet` on the line above.
        const back = parsed as Results.ResultSet;
        expect(back.variables).toEqual(set.variables);
        expect(back.bindings.map((b) => b.key)).toEqual(set.bindings.map((b) => b.key));
        const bool = yield* codec.parse(codec.serializeString({ _tag: 'Ask', value: true }));
        expect(bool).toEqual({ _tag: 'Boolean', value: true });
      }),
    );
  });

  it.effect('writes and reads CSV', () =>
    Effect.gen(function* () {
      const text = Results.Csv.serializeString(set);
      expect(text.split('\r\n')[0]).toBe('x,y,z');
      // SAFETY: the CSV serialization of a result set parses back to a result set.
      const parsed = (yield* Results.Csv.parse(text)) as Results.ResultSet;
      expect(lex(Bindings.getUndefined(parsed.bindings[0]!, 'y'))).toBe('hello, "world"\n');
      expect(Bindings.getUndefined(parsed.bindings[1]!, 'x')?._tag).toBe('BlankNode');
    }),
  );

  it('negotiates media types', () => {
    expect(
      Option.map(
        Results.negotiate('text/csv;q=0.5, application/sparql-results+xml'),
        (c) => c.format.name,
      ),
    ).toEqual(Option.some('SPARQL Results XML'));
  });
});

describe('Hash functions', () => {
  const inputs = ['', 'abc', 'hello world', 'é漢字👾', 'x'.repeat(200)];
  it.each(inputs)('match node:crypto for %s', (input) => {
    const node = (alg: string) => crypto.createHash(alg).update(input, 'utf8').digest('hex');
    expect(Hash.md5(input)).toBe(node('md5'));
    expect(Hash.sha1(input)).toBe(node('sha1'));
    expect(Hash.sha256(input)).toBe(node('sha256'));
    expect(Hash.sha384(input)).toBe(node('sha384'));
    expect(Hash.sha512(input)).toBe(node('sha512'));
  });
});

describe('SERVICE with a variable endpoint', () => {
  const remote = (endpoint: Term.NamedNode) =>
    Stream.make(Bindings.make({ title: Term.literal(`from ${endpoint.value}`) }));
  const FederatedLayer = Engine.layer({ service: (endpoint) => remote(endpoint) }).pipe(
    Layer.provideMerge(
      Store.layerMemory(
        Dataset.make(
          Term.quad(ex('p1'), ex('endpoint'), Term.namedNode('http://one.example/sparql')),
          Term.quad(ex('p2'), ex('endpoint'), Term.namedNode('http://two.example/sparql')),
        ),
      ),
    ),
  );

  it.effect('evaluates the remote pattern once per bound endpoint', () =>
    Effect.gen(function* () {
      const engine = yield* Engine.SparqlEngine;
      const result = yield* engine.select(
        'SELECT ?p ?title { ?p <http://example.org/endpoint> ?e SERVICE ?e { ?x ?y ?title } } ORDER BY ?p',
      );
      const rows = yield* Stream.runCollect(result.bindings);
      expect(rows.map((b) => lex(b.map.get('title')))).toEqual([
        'from http://one.example/sparql',
        'from http://two.example/sparql',
      ]);
    }).pipe(Effect.provide(FederatedLayer)),
  );

  it.effect('fails when the endpoint variable is unbound', () =>
    Effect.gen(function* () {
      const engine = yield* Engine.SparqlEngine;
      const result = yield* engine.select('SELECT * { SERVICE ?e { ?x ?y ?z } }');
      const error = yield* Effect.flip(Stream.runCollect(result.bindings));
      expect(error._tag).toBe('EvaluationError');
    }).pipe(Effect.provide(FederatedLayer)),
  );
});
