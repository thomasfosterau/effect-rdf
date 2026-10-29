import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Schema from 'effect/Schema';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as CoreIsomorphism from '@thomasfosterau/effect-rdf/Isomorphism';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { rdf, xsd } from '@thomasfosterau/effect-rdf/Vocab';
import { Isomorphism, Mapping, Model, N3, Reasoner, Vocab } from '../src/index.ts';

const EX = 'http://example.org/';
const ex = (local: string) => Term.namedNode(EX + local);
const prefix = `@prefix : <${EX}> .\n`;

const parse = (text: string) => Effect.runSync(N3.parse(prefix + text));
const statements = (text: string) => parse(text).formula.statements;
const keys = (text: string) => statements(text).map((s) => s.key);

describe('N3.parse', () => {
  it.effect('parses Turtle-style triples', () =>
    Effect.gen(function* () {
      const doc = yield* N3.parse(`${prefix}:a :b :c, :d ; a :T .`);
      expect(doc.formula.statements.map((s) => s.key)).toEqual([
        `<${EX}a> <${EX}b> <${EX}c>`,
        `<${EX}a> <${EX}b> <${EX}d>`,
        `<${EX}a> <${rdf.type.value}> <${EX}T>`,
      ]);
      expect(PrefixMap.get(doc.prefixes, '')._tag).toBe('Some');
    }),
  );

  it('parses formulas, variables and rule shorthands', () => {
    const [rule] = statements('{ ?x a :Man } => { ?x a :Mortal } .');
    expect(rule!.predicate).toEqual(Vocab.log.implies);
    expect(Model.isFormula(rule!.subject)).toBe(true);
    expect(Model.variables(rule!).map((v) => v.value)).toEqual(['x']);
    expect(statements(':a <= :b .')[0]!.predicate).toEqual(Vocab.log.isImpliedBy);
    expect(statements(':a = :b .')[0]!.predicate).toEqual(Vocab.sameAs);
  });

  it('treats the empty formula as the literal true', () => {
    expect(statements(':a :b {} .')[0]!.object).toEqual(Term.literal('true', xsd.boolean));
  });

  it('expands paths left to right', () => {
    const [s1, s2, s3] = statements(':joe!:hasMother^:hasMother a :Person .');
    expect(s1!.subject).toEqual(ex('joe'));
    expect(s1!.predicate).toEqual(ex('hasMother'));
    const m = s1!.object;
    expect(s2!.predicate).toEqual(ex('hasMother'));
    expect(s2!.object).toEqual(m);
    expect(s3!.subject).toEqual(s2!.subject);
    expect(s3!.object).toEqual(ex('Person'));
  });

  it('supports inverse predicates', () => {
    const expected = [`<${EX}b> <${EX}p> <${EX}a>`];
    expect(keys(':a is :p of :b .')).toEqual(expected);
    expect(keys(':a <- :p :b .')).toEqual(expected);
    expect(keys(':a @is :p @of :b .')).toEqual(expected);
    expect(keys(':a has :p :b .')).toEqual([`<${EX}a> <${EX}p> <${EX}b>`]);
  });

  it('supports IRI property lists', () => {
    expect(keys(':s :p [ id :o :q 1 ] .')).toEqual([
      `<${EX}o> <${EX}q> "1"^^<${xsd.integer.value}>`,
      `<${EX}s> <${EX}p> <${EX}o>`,
    ]);
  });

  it('allows literals, formulas and collections in any position', () => {
    const [s] = statements('"x" ( 1 2 ) { :a :b :c } .');
    expect(s!.subject).toEqual(Term.literal('x'));
    expect(Model.isCollection(s!.predicate)).toBe(true);
    expect(Model.isFormula(s!.object)).toBe(true);
  });

  it('parses literals', () => {
    const objects = statements(
      ':s :p 1, -2.5, 1e3, true, "a"@EN, "b"^^:dt, """multi\nline""", \'q\', "x"^^<https://www.w3.org/ns/i18n#ar-eg_rtl> .',
    ).map((s) => s.object.key);
    expect(objects).toEqual([
      `"1"^^<${xsd.integer.value}>`,
      `"-2.5"^^<${xsd.decimal.value}>`,
      `"1e3"^^<${xsd.double.value}>`,
      `"true"^^<${xsd.boolean.value}>`,
      '"a"@en',
      `"b"^^<${EX}dt>`,
      '"multi\\nline"',
      '"q"',
      '"x"@ar-eg--rtl',
    ]);
  });

  it('defaults the empty prefix to <#>', () => {
    const doc = Effect.runSync(N3.parse(':a :b :c .', { baseIri: 'http://x.org/doc' }));
    expect(doc.formula.statements[0]!.subject).toEqual(Term.namedNode('http://x.org/doc#a'));
  });

  it('resolves relative IRIs against @base and BASE', () => {
    const doc = Effect.runSync(
      N3.parse('@base <http://a.org/x/> . <y> <p> <z> . BASE <q/> <r> <p> <s> .'),
    );
    expect(doc.formula.statements.map((s) => s.subject.key)).toEqual([
      '<http://a.org/x/y>',
      '<http://a.org/x/q/r>',
    ]);
    expect(doc.baseIri).toBe('http://a.org/x/q/');
  });

  it('scopes blank node labels to the document', () => {
    const [a] = statements('_:x :p { _:x :q :r } .');
    expect(a!.subject).toEqual((a!.object as Model.Formula).statements[0]!.subject);
  });

  it('maps legacy @forAll / @forSome', () => {
    const [s] = statements('@forAll :x . @forSome :y . :x :p :y .');
    expect(s!.subject).toEqual(Term.variable('x'));
    expect(s!.object._tag).toBe('BlankNode');
  });

  it('rejects IRIs whose escapes encode disallowed characters', () => {
    const error = Effect.runSync(Effect.flip(N3.parse('<a> <b> <c\\u0020d> .')));
    expect(error).toMatchObject({ line: 1, column: 9 });
    expect(error.message).toContain('Invalid escaped character in IRI');
    expect(Exit.isSuccess(Effect.runSyncExit(N3.parse('<a> <b> <c\\u0041d> .')))).toBe(true);
  });

  it('parses deeply nested formulas, lists and blank nodes', () => {
    const depth = 300;
    const text =
      '<a> <b> ' + '{ <a> <b> '.repeat(depth) + '( [ <p> <o> ] )' + ' }'.repeat(depth) + ' .';
    const exit = Effect.runSyncExit(N3.parse(text));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it('reports syntax errors with positions', () => {
    const exit = Effect.runSyncExit(N3.parse('@prefix : <http://e/> .\n:a :b .'));
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Effect.runSync(Effect.flip(N3.parse('@prefix : <http://e/> .\n:a :b .')));
    expect(error._tag).toBe('RdfParseError');
    expect(error.line).toBe(2);
    expect(error.column).toBe(7);
    for (const bad of [
      '@keywords a .',
      ':a :b :c',
      'nope:a :b :c .',
      ':a :b "unterminated .',
      ':a :b "\\q" .',
      '<a b> <c> <d> .',
      ':a :b :c. .',
      '[ id _:b :p :o ] .',
    ]) {
      expect({ bad, failed: Exit.isFailure(Effect.runSyncExit(N3.parse(bad))) }).toEqual({
        bad,
        failed: true,
      });
    }
  });
});

describe('N3.serializeDocument', () => {
  it('pretty-prints with prefixes, formulas, variables and collections', () => {
    const doc = parse(
      '{ ?x a :Man ; :age 42 } => { ?x a :Mortal ; :knows [ :name "Bob" ] } . :l :items ( 1 2 ) .',
    );
    const text = N3.serializeDocument(doc);
    expect(text).toBe(
      [
        '@prefix : <http://example.org/> .',
        '',
        '{',
        '    ?x a :Man ;',
        '        :age 42 .',
        '} => {',
        '    ?x a :Mortal ;',
        '        :knows [ :name "Bob" ] .',
        '} .',
        ':l :items ( 1 2 ) .',
        '',
      ].join('\n'),
    );
    const again = Effect.runSync(N3.parse(text));
    expect(Isomorphism.isomorphic(doc.formula, again.formula)).toBe(true);
  });

  it('writes single-statement formulas inline and keeps cycles of blank nodes', () => {
    const doc = parse('{ :a :b :c } :says _:x . _:x :p _:y . _:y :p _:x .');
    const text = N3.serializeDocument(doc);
    expect(text).toContain('{ :a :b :c } :says');
    const again = Effect.runSync(N3.parse(text));
    expect(Isomorphism.isomorphic(doc.formula, again.formula)).toBe(true);
  });

  it('serialises formulas built programmatically', () => {
    const f = Model.formula([
      Model.statement(
        Model.formula([Model.statement(Term.variable('s'), ex('p'), Term.literal('x\ny'))]),
        Vocab.log.implies,
        Model.emptyFormula,
      ),
    ]);
    expect(N3.serializeDocument(f)).toBe(
      '{\n    ?s <http://example.org/p> """x\ny""" .\n} => {} .\n',
    );
  });
});

describe('Mapping', () => {
  it.effect('maps formulas to blank-node named graphs and back', () =>
    Effect.gen(function* () {
      const doc = parse(':alice :believes { :bob :knows :carol } . :l :p ( :a ( :b ) ) .');
      const dataset = yield* Mapping.toDataset(doc);
      const graphs = Dataset.graphs(dataset).filter((g) => g._tag === 'BlankNode');
      expect(graphs.length).toBe(1);
      expect(Dataset.count(dataset, { graph: graphs[0]! })).toBe(1);
      const back = yield* Mapping.fromDataset(dataset);
      expect(Isomorphism.isomorphic(back, doc.formula)).toBe(true);
      expect(back.statements.some((s) => Model.isCollection(s.object))).toBe(true);
    }),
  );

  it.effect('rejects constructs that are not RDF', () =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        ['{ ?x :p :o } => {:a :b :c} .', '"lit" :p :o .', ':s [] :o .'],
        Effect.fnUntraced(function* (text) {
          const error = yield* Effect.flip(Mapping.toDataset(parse(text)));
          expect(error._tag).toBe('N3UnrepresentableError');
        }),
        { concurrency: 1, discard: true },
      );
      expect(Mapping.isRdfCompatible(parse(':a :b :c .').formula)).toBe(true);
      const named = Dataset.make(Term.quad(ex('a'), ex('b'), ex('c'), ex('g')));
      const error = yield* Effect.flip(Mapping.fromDataset(named));
      expect(error.message).toContain('Named graph');
    }),
  );
});

describe('N3 codec', () => {
  it.effect('parses datasets and fails for non-RDF documents', () =>
    Effect.gen(function* () {
      const result = yield* N3.parser.parse(`${prefix}:a :b { :c :d :e } .`);
      expect(result.dataset.size).toBe(2);
      const error = yield* Effect.flip(N3.parser.parse('{ ?x :p :o } => { ?x :q :o } .'));
      expect(error._tag).toBe('RdfParseError');
      expect(error.message).toContain('Variable');
    }),
  );

  it.effect('serialises datasets with nested formulas', () =>
    Effect.gen(function* () {
      const g = Term.blankNode('g');
      const dataset = Dataset.make(
        Term.quad(ex('alice'), ex('says'), g),
        Term.quad(ex('bob'), ex('knows'), ex('carol'), g),
      );
      const text = yield* N3.serialize(dataset, { prefixes: PrefixMap.make({ '': EX }) });
      expect(text).toBe(
        '@prefix : <http://example.org/> .\n\n:alice :says { :bob :knows :carol } .\n',
      );
      const back = yield* N3.parser.parse(text);
      expect(CoreIsomorphism.isomorphic(back.dataset, dataset)).toBe(true);
    }),
  );

  it('provides a Schema codec', () => {
    const dataset = Schema.decodeUnknownSync(N3.codec.schema)(`${prefix}:a :b "c" .`);
    expect(dataset.size).toBe(1);
    expect(N3.format.mediaType).toBe('text/n3');
  });
});

describe('Isomorphism', () => {
  it('relabels blank nodes and variables, including inside formulas', () => {
    const a = parse('{ ?x :p _:b } => { ?x :q _:b } . _:c :r ( 1 _:c ) .').formula;
    const b = parse('{ ?y :p _:z } => { ?y :q _:z } . _:d :r ( 1 _:d ) .').formula;
    const c = parse('{ ?y :p _:z } => { ?w :q _:z } . _:d :r ( 1 _:d ) .').formula;
    expect(Isomorphism.isomorphic(a, b)).toBe(true);
    expect(Isomorphism.isomorphic(a, c)).toBe(false);
  });

  it('compares collections with explicit RDF lists', () => {
    const a = parse(':s :p ( 1 2 ) .').formula;
    const b = parse(
      `:s :p _:l1 . _:l1 <${rdf.first.value}> 1 ; <${rdf.rest.value}> _:l2 . _:l2 <${rdf.first.value}> 2 ; <${rdf.rest.value}> <${rdf.nil.value}> .`,
    ).formula;
    expect(Isomorphism.isomorphic(a, b)).toBe(true);
  });
});

describe('Reasoner', () => {
  it.effect('applies rules to a fixpoint, chaining rules', () =>
    Effect.gen(function* () {
      const infinite = parse(`
        :socrates a :Man .
        { ?x a :Man } => { ?x a :Mortal } .
        { ?x a :Mortal } => { ?x :parent [ a :Mortal ] } .
      `);
      const error = yield* Effect.flip(Reasoner.reason(infinite, { maxRounds: 5 }));
      expect(error.message).toContain('No fixpoint');
      const finite = parse(`
        :socrates a :Man .
        { ?x a :Man } => { ?x a :Mortal } .
        { ?x a :Mortal } => { ?x :fate :death ; :has [ a :Soul ] } .
      `);
      const { inferred, rounds } = yield* Reasoner.reason(finite);
      expect(rounds).toBe(3);
      expect(
        Isomorphism.isomorphic(
          inferred,
          parse(':socrates a :Mortal ; :fate :death ; :has [ a :Soul ] .').formula,
        ),
      ).toBe(true);
    }),
  );

  it.effect('evaluates builtins and derived rules', () =>
    Effect.gen(function* () {
      const doc = parse(`
        @prefix math: <http://www.w3.org/2000/10/swap/math#> .
        @prefix string: <http://www.w3.org/2000/10/swap/string#> .
        @prefix list: <http://www.w3.org/2000/10/swap/list#> .
        :a :cm 180 ; :name "Ann" .
        { ?p :cm ?cm . (?cm 100) math:quotient ?m . ?m math:greaterThan 1.5 } => { ?p :tall true ; :m ?m } .
        { ?p :name ?n . ("Hello, " ?n) string:concatenation ?g } => { ?p :greeting ?g } .
        { (1 2 3) list:member ?x . ?x math:notLessThan 3 } => { :big :item ?x } .
        { :a :tall true } => { { ?y :cm ?c } => { ?y :measured true } } .
      `);
      const { inferred } = yield* Reasoner.reason(doc);
      const keys = inferred.statements.map((s) => s.key);
      expect(keys).toContain(`<${EX}a> <${EX}m> "1.8"^^<${xsd.decimal.value}>`);
      expect(keys).toContain(`<${EX}a> <${EX}greeting> "Hello, Ann"`);
      expect(keys).toContain(`<${EX}big> <${EX}item> "3"^^<${xsd.integer.value}>`);
      expect(keys).toContain(`<${EX}a> <${EX}measured> "true"^^<${xsd.boolean.value}>`);
    }),
  );

  it.effect('reports inconsistencies', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Reasoner.reason(parse(':a a :B . { ?x a :B } => false .')));
      expect(error._tag).toBe('N3ReasonerError');
    }),
  );

  it('answers queries', () => {
    const doc = parse(':a :knows :b . :b :knows :c .');
    const answers = Reasoner.query(doc.formula, parse('?x :knows [ :knows ?z ] .').formula);
    expect(answers.map((b) => [b.get('x')!.key, b.get('z')!.key])).toEqual([
      [`<${EX}a>`, `<${EX}c>`],
    ]);
  });
});
