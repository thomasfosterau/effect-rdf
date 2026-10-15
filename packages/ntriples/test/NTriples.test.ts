import { describe, expect, it } from '@effect/vitest';
import { Dataset, Isomorphism, Term, Vocab } from '@thomasfosterau/effect-rdf';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { Lexical, NQuads, NTriples } from '../src/index.ts';

const ex = (s: string) => Term.namedNode(`http://example.org/${s}`);

describe('NTriples', () => {
  it.effect('parses RDF 1.2 features', () =>
    Effect.gen(function* () {
      const { dataset } = yield* NTriples.parse(
        [
          'VERSION "1.2"',
          '<http://example.org/s> <http://example.org/p> "chat"@EN-gb--rtl . # comment',
          '_:r <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> <<( <http://example.org/s> <http://example.org/p> "1"^^<http://www.w3.org/2001/XMLSchema#integer> )>> .',
          '',
        ].join('\n'),
        { blankNodePrefix: '' },
      );
      expect(dataset.size).toBe(2);
      const literal = Term.literal('chat', { language: 'en-gb', direction: 'rtl' });
      expect(Dataset.has(dataset, Term.quad(ex('s'), ex('p'), literal))).toBe(true);
      const triple = Term.triple(ex('s'), ex('p'), Term.literal('1', Vocab.xsd.integer));
      expect(Dataset.has(dataset, Term.quad(Term.blankNode('r'), Vocab.rdf.reifies, triple))).toBe(
        true,
      );
    }),
  );

  it.effect('reports errors with positions', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        NTriples.parse('<http://example.org/s> <http://example.org/p> <o> .\n'),
      );
      expect(error.line).toBe(1);
      expect(error.column).toBe(47);
      expect(error.message).toContain('Relative IRI');
      const bad = yield* Effect.flip(NTriples.parse('\n\n<http://a/s> <http://a/p> "x"@en--up .'));
      expect(bad.line).toBe(3);
    }),
  );

  it.effect('parses streams with arbitrary chunk boundaries', () =>
    Effect.gen(function* () {
      const text =
        '<http://a/s> <http://a/p> "caf\\u00E9" .\r\n<http://a/s> <http://a/p> "\u{1F600}" .\n';
      const chunks = Array.from(text);
      const quads = yield* Stream.runCollect(NTriples.parseStream(Stream.fromIterable(chunks)));
      expect(quads.map((q) => (q.object as Term.Literal).value)).toEqual(['café', '\u{1F600}']);
      const error = yield* Effect.flip(
        Stream.runCollect(NTriples.parseStream(Stream.make('<http://a/s> <http://a/p>\n', 'x'))),
      );
      expect(error.line).toBe(1);
    }),
  );

  it.effect('serialises canonically', () =>
    Effect.gen(function* () {
      const quads = [
        Term.quad(ex('s'), ex('p'), Term.literal('a\tb\u0001"\\')),
        Term.quad(ex('s'), ex('p'), Term.literal('x', 'EN')),
        Term.quad(Term.blankNode('b0'), ex('p'), Term.triple(ex('a'), ex('b'), ex('c'))),
      ];
      const text = yield* NTriples.serialize(quads);
      expect(text).toBe(
        [
          '<http://example.org/s> <http://example.org/p> "a\\tb\\u0001\\"\\\\" .',
          '<http://example.org/s> <http://example.org/p> "x"@en .',
          '_:b0 <http://example.org/p> <<( <http://example.org/a> <http://example.org/b> <http://example.org/c> )>> .',
          '',
        ].join('\n'),
      );
      const sorted = yield* NTriples.serialize(quads, { sort: true });
      expect(sorted.startsWith('_:b0')).toBe(true);
      const streamed = yield* Stream.mkString(NTriples.serializeStream(Stream.fromIterable(quads)));
      expect(streamed).toBe(text);
    }),
  );

  it.effect('rejects what N-Triples cannot express', () =>
    Effect.gen(function* () {
      const named = yield* Effect.flip(
        NTriples.serialize([Term.quad(ex('s'), ex('p'), ex('o'), ex('g'))]),
      );
      expect(named._tag).toBe('RdfSerializeError');
      const subjectTriple = yield* Effect.flip(
        NTriples.serialize([Term.quad(Term.triple(ex('a'), ex('b'), ex('c')), ex('p'), ex('o'))]),
      );
      expect(subjectTriple.message).toContain('subject');
      const relative = yield* Effect.flip(
        NTriples.serialize([Term.quad(Term.namedNode('rel'), ex('p'), ex('o'))]),
      );
      expect(relative.message).toContain('IRI');
    }),
  );

  it.effect('provides a schema codec', () =>
    Effect.gen(function* () {
      const ds = yield* Schema.decodeEffect(NTriples.codec.schema)(
        '_:a <http://a/p> _:b .\n_:b <http://a/p> _:a .\n',
      );
      const text = yield* Schema.encodeEffect(NTriples.codec.schema)(ds);
      const again = yield* Schema.decodeEffect(NTriples.codec.schema)(text);
      expect(Isomorphism.isomorphic(ds, again)).toBe(true);
    }),
  );
});

describe('NQuads', () => {
  it.effect('round-trips named graphs', () =>
    Effect.gen(function* () {
      const input =
        '<http://a/s> <http://a/p> <http://a/o> <http://a/g> .\n_:s <http://a/p> "v" _:g .\n<http://a/s> <http://a/p> <http://a/o> .\n';
      const { dataset } = yield* NQuads.parse(input);
      expect(Dataset.graphs(dataset).length).toBe(3);
      const text = yield* NQuads.serialize(dataset, { sort: true });
      const again = yield* NQuads.parse(text);
      expect(Isomorphism.isomorphic(dataset, again.dataset)).toBe(true);
      expect(text.split('\n')[0]).toBe('<http://a/s> <http://a/p> <http://a/o> .');
    }),
  );

  it.effect('streams quads', () =>
    Effect.gen(function* () {
      const quads = yield* Stream.runCollect(
        NQuads.parseStream(
          Stream.make('<http://a/s> <http://a/p> <http://a/o> <http', '://a/g> .'),
        ),
      );
      expect(quads[0]!.graph).toEqual(Term.namedNode('http://a/g'));
    }),
  );
});

describe('Lexical', () => {
  it('validates language tags and labels', () => {
    expect(Lexical.parseLanguageTag('en-US--ltr')).toEqual({ language: 'en-US', direction: 'ltr' });
    expect(Lexical.parseLanguageTag('en--LTR')).toBeUndefined();
    expect(Lexical.parseLanguageTag('toolongtag')).toBeUndefined();
    expect(Lexical.isBlankNodeLabel('a.b')).toBe(true);
    expect(Lexical.isBlankNodeLabel('a.')).toBe(false);
    expect(Lexical.isBlankNodeLabel(Lexical.blankNodeLabel('a b'))).toBe(true);
    expect(Lexical.formatTerm(Term.literal('x', Vocab.xsd.integer))).toBe(
      '"x"^^<http://www.w3.org/2001/XMLSchema#integer>',
    );
  });
});
