import { describe, expect, it } from '@effect/vitest';
import { Dataset, Isomorphism, PrefixMap, Term, Vocab } from '@thomasfosterau/effect-rdf';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import { Manifest, TriG, Turtle } from '../src/index.ts';

const ex = (s: string) => Term.namedNode(`http://example.org/${s}`);
const prefixes = PrefixMap.make({ ex: 'http://example.org/' });

const document = `
@prefix ex: <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:alice a ex:Person ;
  ex:age 42 ;
  ex:height 1.70 ;
  ex:knows [ ex:name "Bob"@en ], ex:carol ;
  ex:likes ( ex:a ex:b ) ;
  ex:active true ;
  ex:bio """line one
line "two\\"""" .
ex:alice ex:says "hi" {| ex:source ex:web |} .
`;

describe('Turtle parser', () => {
  it.effect('returns prefixes and the final base IRI', () =>
    Effect.gen(function* () {
      const result = yield* Turtle.parse(
        '@base <http://example.org/a/> .\nPREFIX p: <q/>\nBASE <b/>\n<x> p:y <z> .',
      );
      expect(result.baseIri).toBe('http://example.org/a/b/');
      expect(Option.getOrThrow(PrefixMap.get(result.prefixes, 'p'))).toBe(
        'http://example.org/a/q/',
      );
      expect(
        Dataset.has(
          result.dataset,
          Term.quad(
            Term.namedNode('http://example.org/a/b/x'),
            Term.namedNode('http://example.org/a/q/y'),
            Term.namedNode('http://example.org/a/b/z'),
          ),
        ),
      ).toBe(true);
    }),
  );

  it.effect('parses RDF 1.2 reification and annotations', () =>
    Effect.gen(function* () {
      const { dataset } = yield* Turtle.parse(
        'PREFIX : <http://example.org/>\n:s :p :o ~ :r {| :q 1 |} .\n<< :a :b "c"@en--ltr >> :z <<( :x :y :w )>> .',
      );
      expect(dataset.size).toBe(5);
      const t = Term.triple(ex('s'), ex('p'), ex('o'));
      expect(Dataset.has(dataset, Term.quad(ex('r'), Vocab.rdf.reifies, t))).toBe(true);
      expect(Dataset.objectsOf(dataset, ex('r'), ex('q'))).toEqual([
        Term.literal('1', Vocab.xsd.integer),
      ]);
    }),
  );

  it.effect('reports syntax errors with line and column', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Turtle.parse('PREFIX : <http://ex/>\n:a :b <rel> .'));
      expect(error.line).toBe(2);
      expect(error.column).toBe(7);
      const undefinedPrefix = yield* Effect.flip(Turtle.parse('ex:a ex:b ex:c .'));
      expect(undefinedPrefix.message).toContain('Undefined prefix');
    }),
  );

  it.effect('emits statements incrementally while streaming', () =>
    Effect.gen(function* () {
      const input = Stream.concat(
        Stream.make('PREFIX : <http://ex/>\n:a :b :', 'c .\n:d :e '),
        Stream.fail('boom'),
      );
      const first = yield* Stream.runCollect(Stream.take(Turtle.parseStream(input), 1));
      expect(first[0]!.object).toEqual(Term.namedNode('http://ex/c'));
      const failure = yield* Effect.flip(Stream.runCollect(Turtle.parseStream(input)));
      expect(failure).toBe('boom');
    }),
  );
});

describe('Turtle serializer', () => {
  it.effect('writes idiomatic Turtle', () =>
    Effect.gen(function* () {
      const { dataset } = yield* Turtle.parse(document);
      const text = yield* Turtle.serialize(dataset, { prefixes });
      expect(text).toBe(
        [
          '@prefix ex: <http://example.org/> .',
          '',
          'ex:alice a ex:Person ;',
          '    ex:active true ;',
          '    ex:age 42 ;',
          '    ex:bio """line one',
          'line \\"two\\"""" ;',
          '    ex:height 1.70 ;',
          '    ex:knows ex:carol, [ ex:name "Bob"@en ] ;',
          '    ex:likes ( ex:a ex:b ) ;',
          '    ex:says "hi" {| ex:source ex:web |} .',
          '',
        ].join('\n'),
      );
      const again = yield* Turtle.parse(text);
      expect(Isomorphism.isomorphic(again.dataset, dataset)).toBe(true);
    }),
  );

  it.effect('relativises IRIs against the base and detects prefixes', () =>
    Effect.gen(function* () {
      const quads = [
        Term.quad(
          Term.namedNode('http://example.org/doc#me'),
          Vocab.rdf.type,
          Term.namedNode('http://xmlns.com/foaf/0.1/Person'),
        ),
        Term.quad(
          Term.namedNode('http://example.org/doc#me'),
          Term.namedNode('http://xmlns.com/foaf/0.1/age'),
          Term.literal('7', Vocab.xsd.gYear),
        ),
      ];
      const text = yield* Turtle.serialize(quads, {
        baseIri: 'http://example.org/doc',
        autoPrefixes: true,
        sparqlDirectives: true,
      });
      expect(text).toBe(
        [
          'BASE <http://example.org/doc>',
          'PREFIX ns0: <http://xmlns.com/foaf/0.1/>',
          'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>',
          '',
          '<#me> a ns0:Person ;',
          '    ns0:age "7"^^xsd:gYear .',
          '',
        ].join('\n'),
      );
    }),
  );

  it.effect('writes unreferenced blank nodes and reified triples', () =>
    Effect.gen(function* () {
      const { dataset } = yield* Turtle.parse(
        'PREFIX ex: <http://example.org/>\n[ ex:p 1 ] .\n<< ex:a ex:b ex:c >> ex:q ex:z .',
      );
      const text = yield* Turtle.serialize(dataset, { prefixes });
      expect(text).toBe(
        [
          '@prefix ex: <http://example.org/> .',
          '',
          '[ ex:p 1 ] .',
          '',
          '<< ex:a ex:b ex:c >> ex:q ex:z .',
          '',
        ].join('\n'),
      );
    }),
  );

  it.effect('rejects named graphs', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Turtle.serialize([Term.quad(ex('s'), ex('p'), ex('o'), ex('g'))]),
      );
      expect(error._tag).toBe('RdfSerializeError');
    }),
  );

  it.effect('serialises streams incrementally', () =>
    Effect.gen(function* () {
      const quads = [
        Term.quad(ex('s'), Vocab.rdf.type, ex('T')),
        Term.quad(ex('s'), ex('p'), Term.literal('1')),
        Term.quad(ex('s'), ex('p'), Term.literal('2')),
        Term.quad(ex('t'), ex('p'), Term.blankNode('x')),
      ];
      const text = yield* Stream.mkString(
        Turtle.serializeStream(Stream.fromIterable(quads), { prefixes }),
      );
      expect(text).toBe(
        [
          '@prefix ex: <http://example.org/> .',
          '',
          'ex:s a ex:T ;',
          '    ex:p "1", "2" .',
          'ex:t ex:p _:x .',
          '',
        ].join('\n'),
      );
    }),
  );
});

describe('TriG', () => {
  it.effect('parses and serialises named graphs', () =>
    Effect.gen(function* () {
      const { dataset } = yield* TriG.parse(
        'PREFIX ex: <http://example.org/>\nex:s ex:p ex:o .\nGRAPH ex:g { ex:s ex:p ( 1 2 ) }\n_:b { ex:x ex:y ex:z }',
      );
      const text = yield* TriG.serialize(dataset, { prefixes });
      expect(text).toBe(
        [
          '@prefix ex: <http://example.org/> .',
          '',
          'ex:s ex:p ex:o .',
          '',
          'ex:g {',
          '    ex:s ex:p ( 1 2 ) .',
          '}',
          '',
          '_:b0 {',
          '    ex:x ex:y ex:z .',
          '}',
          '',
        ].join('\n'),
      );
      const streamed = yield* Stream.mkString(
        TriG.serializeStream(Stream.fromIterable(Dataset.toSortedArray(dataset)), { prefixes }),
      );
      const again = yield* TriG.parse(streamed);
      expect(Isomorphism.isomorphic(again.dataset, dataset)).toBe(true);
    }),
  );
});

describe('Manifest', () => {
  it.effect('reads entries and includes', () =>
    Effect.gen(function* () {
      const files: Record<string, string> = {
        'http://t/manifest.ttl': `
          PREFIX mf: <http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#>
          PREFIX rdft: <http://www.w3.org/ns/rdftest#>
          <> a mf:Manifest ; mf:include ( <sub/manifest.ttl> ) ;
            mf:entries ( <#t1> ) .
          <#t1> a rdft:TestTurtleEval ; mf:name "t1" ; mf:action <a.ttl> ; mf:result <a.nt> .`,
        'http://t/sub/manifest.ttl': `
          PREFIX mf: <http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#>
          PREFIX rdft: <http://www.w3.org/ns/rdftest#>
          <> a mf:Manifest ; mf:entries ( <#t2> ) .
          <#t2> a rdft:TestTurtleNegativeSyntax ; mf:action <b.ttl> .`,
      };
      const entries = yield* Manifest.load('http://t/manifest.ttl', (iri) =>
        Effect.succeed(files[iri]!),
      );
      expect(entries.map((e) => [e.name, e.kind, Option.getOrNull(e.action)])).toEqual([
        ['t1', 'TestTurtleEval', 'http://t/a.ttl'],
        ['t2', 'TestTurtleNegativeSyntax', 'http://t/sub/b.ttl'],
      ]);
      expect(Option.getOrNull(entries[0]!.result)).toBe('http://t/a.nt');
      expect(Manifest.toPath('http://t/sub/b.ttl', 'http://t/', '/suite/')).toBe(
        '/suite/sub/b.ttl',
      );
    }),
  );
});
