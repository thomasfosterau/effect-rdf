import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { SemAct, ShapeMap, ShExC, ShExJ, ShExR, Structure, Validator } from '../src/index.ts';

const ex = (l: string) => Term.namedNode(`http://ex.example/${l}`);

const schemaText = `
PREFIX ex: <http://ex.example/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
start = @ex:Person
ex:Person CLOSED {
  ex:name xsd:string MINLENGTH 1 ;
  ex:age xsd:integer MININCLUSIVE 0 ? ;
  ex:knows @ex:Person *
}
`;

const data = Dataset.make(
  Term.quad(ex('alice'), ex('name'), Term.literal('Alice')),
  Term.quad(ex('alice'), ex('knows'), ex('bob')),
  Term.quad(ex('bob'), ex('name'), Term.literal('Bob')),
  Term.quad(ex('bob'), ex('knows'), ex('alice')),
  Term.quad(ex('carol'), ex('name'), Term.literal('')),
  Term.quad(ex('dave'), ex('name'), Term.literal('Dave')),
  Term.quad(ex('dave'), ex('likes'), ex('alice')),
);

describe('ShExC', () => {
  it.effect('parses and reports prefixes', () =>
    Effect.gen(function* () {
      const r = yield* ShExC.parseWithMetadata(schemaText);
      expect(r.schema.shapes?.[0]?.id).toBe('http://ex.example/Person');
      expect(r.prefixes.prefixes.get('ex')).toBe('http://ex.example/');
    }),
  );

  it.effect('reports syntax errors with positions', () =>
    Effect.gen(function* () {
      const e = yield* Effect.flip(ShExC.parse('<http://a/S> {\n  <http://a/p> \n}'));
      expect(e._tag).toBe('RdfParseError');
      expect(e.line).toBe(3);
    }),
  );

  it.effect('prints parseable ShExC', () =>
    Effect.gen(function* () {
      const schema = yield* ShExC.parse(schemaText);
      const again = yield* ShExC.parse(ShExC.print(schema));
      expect(again).toEqual(schema);
    }),
  );
});

describe('ShExJ', () => {
  it.effect('decodes and encodes', () =>
    Effect.gen(function* () {
      const schema = yield* ShExC.parse(schemaText);
      const decoded = yield* ShExJ.parse(ShExJ.stringify(schema));
      expect(decoded).toEqual({ ...schema, '@context': ShExJ.context });
    }),
  );

  it('rejects invalid ShExJ', () => {
    const exit = Effect.runSyncExit(ShExJ.decode({ type: 'Schema', shapes: [{ type: 'Nope' }] }));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe('ShExR', () => {
  it.effect('round-trips through RDF', () =>
    Effect.gen(function* () {
      const schema = yield* ShExC.parse(schemaText);
      const back = yield* ShExR.fromDataset(ShExR.toDataset(schema));
      expect(back).toEqual(schema);
    }),
  );
});

describe('Structure', () => {
  it('detects negation cycles and missing references', () => {
    const schema = Effect.runSync(
      ShExC.parse('<http://a/S> NOT { <http://a/p> @<http://a/S> } <http://a/T> @<http://a/U>'),
    );
    const problems = Structure.problems(schema);
    expect(problems.some((p) => p.includes('negation'))).toBe(true);
    expect(problems.some((p) => p.includes('undeclared'))).toBe(true);
  });
});

describe('ShapeMap', () => {
  it.effect('parses fixed and query maps', () =>
    Effect.gen(function* () {
      const map = yield* ShapeMap.parse(
        'ex:alice@ex:Person, {FOCUS ex:name _}@START, "x"@en@<http://ex.example/S>',
        { prefixes: { ex: 'http://ex.example/' } },
      );
      expect(map).toHaveLength(3);
      expect(map[1]!.shape).toEqual(ShapeMap.start);
      const fixed = ShapeMap.resolve(map, data);
      expect(fixed.map((a) => a.node.key)).toContain('<http://ex.example/dave>');
    }),
  );

  it.effect('parses terms, comments and blank node subjects', () =>
    Effect.gen(function* () {
      const map = yield* ShapeMap.parse(
        `# a comment
        {_:b a FOCUS}@_:S, /* block */ 1.5e3@<S>, '''a''b'''@<T>,
        "\\u0041"^^<http://dt>@START, ex:a\\.b@ex:S`,
        {
          baseIri: 'http://base.example/',
          prefixes: { ex: 'http://ex.example/' },
          shapePrefixes: { ex: 'http://shapes.example/' },
        },
      );
      expect(map.map((a) => a.node)).toEqual([
        {
          _tag: 'TriplePattern',
          subject: Term.blankNode('b'),
          predicate: Term.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
          object: 'FOCUS',
        },
        Term.literal('1.5e3', Term.namedNode('http://www.w3.org/2001/XMLSchema#double')),
        Term.literal("a''b"),
        Term.literal('A', Term.namedNode('http://dt')),
        ex('a.b'),
      ]);
      expect(map.map((a) => a.shape)).toEqual([
        '_:S',
        'http://base.example/S',
        'http://base.example/T',
        ShapeMap.start,
        'http://shapes.example/S',
      ]);
    }),
  );

  it.effect('reports errors with line and column', () =>
    Effect.gen(function* () {
      const unknown = yield* Effect.flip(ShapeMap.parse('<a>@START,\n  foo:b@START'));
      expect(unknown).toMatchObject({ message: 'unknown prefix "foo:"', line: 2, column: 3 });
      const focus = yield* Effect.flip(ShapeMap.parse('{FOCUS <p> FOCUS}@START'));
      expect(focus.message).toBe('a triple pattern needs exactly one FOCUS');
      const escape = yield* Effect.flip(ShapeMap.parse('"x\\q"@START'));
      expect(escape).toMatchObject({ line: 1, column: 4 });
      const label = yield* Effect.flip(ShapeMap.parse('<a>@'));
      expect(label.message).toContain('expected a shape label');
      expect(yield* ShapeMap.parse('  ')).toEqual([]);
    }),
  );

  it('parses JSON shape map terms, falling back to IRIs', () => {
    expect(ShapeMap.parseTerm('"x"@en')).toEqual(Term.literal('x', 'en'));
    expect(ShapeMap.parseTerm('s', { baseIri: 'http://base.example/' })).toEqual(
      Term.namedNode('http://base.example/s'),
    );
  });
});

describe('Validator', () => {
  it.effect('validates recursive shapes, closed shapes and facets', () =>
    Effect.gen(function* () {
      const schema = yield* ShExC.parse(schemaText);
      const person = 'http://ex.example/Person';
      const report = yield* Validator.validate(
        data,
        schema,
        ['alice', 'bob', 'carol', 'dave'].map((n) => ({ node: ex(n), shape: person })),
      );
      expect(report.results.map((r) => r.status)).toEqual([
        'conformant',
        'conformant',
        'nonconformant',
        'nonconformant',
      ]);
      const start = yield* Validator.validateNode(data, schema, ex('alice'), ShapeMap.start);
      expect(start.status).toBe('conformant');
    }),
  );

  it.effect('loads imports through SchemaLoader', () =>
    Effect.gen(function* () {
      const imported = yield* ShExC.parse('<http://a/T> { <http://a/q> . }');
      const main = yield* ShExC.parse(
        'IMPORT <http://a/lib> <http://a/S> { <http://a/p> @<http://a/T> }',
      );
      const d = Dataset.make(
        Term.quad(
          Term.namedNode('http://a/s'),
          Term.namedNode('http://a/p'),
          Term.namedNode('http://a/o'),
        ),
        Term.quad(Term.namedNode('http://a/o'), Term.namedNode('http://a/q'), Term.literal('v')),
      );
      const r = yield* Validator.validateNode(
        d,
        main,
        Term.namedNode('http://a/s'),
        'http://a/S',
      ).pipe(
        Effect.provide(
          Validator.loaderLayer(Validator.loaderFromRecord({ 'http://a/lib': imported })),
        ),
      );
      expect(r.status).toBe('conformant');
      const missing = yield* Effect.flip(
        Validator.validateNode(d, main, Term.namedNode('http://a/s'), 'http://a/S'),
      );
      expect(missing._tag).toBe('ShExImportError');
    }),
  );

  it.effect('dispatches semantic actions to the SemActHandler', () =>
    Effect.gen(function* () {
      const schema = yield* ShExC.parse(
        '<http://a/S> { <http://a/p> . %<http://a/check>{ ok %} %<http://a/unknown>{ ignored %} }',
      );
      const d = Dataset.make(
        Term.quad(Term.namedNode('http://a/s'), Term.namedNode('http://a/p'), Term.literal('v')),
      );
      const run = (verdict: boolean) =>
        Validator.validateNode(d, schema, Term.namedNode('http://a/s'), 'http://a/S').pipe(
          Effect.provideService(
            SemAct.SemActHandler,
            SemAct.make({
              'http://a/check': (code, ctx) =>
                verdict && code === ' ok ' && ctx.triple !== undefined,
            }),
          ),
        );
      expect((yield* run(true)).status).toBe('conformant');
      expect((yield* run(false)).status).toBe('nonconformant');
      expect(
        Option.isNone(
          SemAct.make({})({ type: 'SemAct', name: 'x' }, { site: 'start', node: undefined }),
        ),
      ).toBe(true);
    }),
  );
});
