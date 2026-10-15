import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import {
  Dataset,
  Isomorphism,
  Namespace,
  Serialization,
  Term,
  Vocab,
} from '@thomasfosterau/effect-rdf';
import { RdfJson } from '../src/index.ts';

const ex = Namespace.make('http://example.org/');
const { xsd, rdf } = Vocab;

// The example from https://www.w3.org/TR/rdf-json/#section-examples
const specExample = `{
  "http://example.org/about" : {
      "http://purl.org/dc/terms/title" : [ { "value" : "Anna's Homepage",
                                             "type" : "literal",
                                             "lang" : "en" } ]
  }
}`;

const nquads = (ds: Dataset.Dataset) => Dataset.toNQuads(Isomorphism.relabel(ds));

describe('RdfJson.parse', () => {
  it.effect('parses the specification example', () =>
    Effect.gen(function* () {
      const { dataset } = yield* RdfJson.parse(specExample);
      expect(Dataset.toNQuads(dataset)).toBe(
        '<http://example.org/about> <http://purl.org/dc/terms/title> "Anna\'s Homepage"@en .\n',
      );
    }),
  );

  it.effect('parses all value kinds', () =>
    Effect.gen(function* () {
      const { dataset } = yield* RdfJson.parse(
        JSON.stringify({
          'http://example.org/s': {
            'http://example.org/p': [
              { type: 'uri', value: 'http://example.org/o' },
              { type: 'bnode', value: '_:b1' },
              { type: 'literal', value: 'plain' },
              { type: 'literal', value: '1', datatype: xsd.integer.value },
              { type: 'literal', value: 'hi', lang: 'en-GB' },
            ],
          },
          '_:b1': { 'http://example.org/q': [{ type: 'bnode', value: '_:b1' }] },
        }),
        { blankNodePrefix: '' },
      );
      expect(Dataset.toSortedArray(dataset).map(String)).toEqual([
        '_:b1 <http://example.org/q> _:b1 .',
        '<http://example.org/s> <http://example.org/p> _:b1 .',
        '<http://example.org/s> <http://example.org/p> <http://example.org/o> .',
        '<http://example.org/s> <http://example.org/p> "1"^^<http://www.w3.org/2001/XMLSchema#integer> .',
        '<http://example.org/s> <http://example.org/p> "hi"@en-gb .',
        '<http://example.org/s> <http://example.org/p> "plain" .',
      ]);
    }),
  );

  it.effect('parses the RDF 1.2 extensions', () =>
    Effect.gen(function* () {
      const { dataset } = yield* RdfJson.parse(
        JSON.stringify({
          'http://example.org/s': {
            'http://example.org/p': [
              { type: 'literal', value: 'שלום', lang: 'he', direction: 'rtl' },
              {
                type: 'triple',
                value: {
                  subject: { type: 'bnode', value: '_:x' },
                  predicate: { type: 'uri', value: 'http://example.org/q' },
                  object: {
                    type: 'triple',
                    value: {
                      subject: { type: 'uri', value: 'http://example.org/a' },
                      predicate: { type: 'uri', value: 'http://example.org/b' },
                      object: { type: 'literal', value: 'c' },
                    },
                  },
                },
              },
            ],
          },
        }),
        { blankNodePrefix: '' },
      );
      expect(Dataset.toSortedArray(dataset).map(String)).toEqual([
        '<http://example.org/s> <http://example.org/p> "שלום"@he--rtl .',
        '<http://example.org/s> <http://example.org/p> <<( _:x <http://example.org/q> <<( <http://example.org/a> <http://example.org/b> "c" )>> )>> .',
      ]);
    }),
  );

  it.effect('places triples in the requested graph', () =>
    Effect.gen(function* () {
      const { dataset } = yield* RdfJson.parse(specExample, { graph: ex('g') });
      expect(Dataset.graphs(dataset)).toEqual([ex('g')]);
    }),
  );

  it.effect('reports JSON syntax errors with a position', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(RdfJson.parse('{\n  "a": [1,\n}'));
      expect(error).toBeInstanceOf(Serialization.RdfParseError);
      expect(error.message).toMatch(/^Invalid JSON/);
      expect(error.line).toBe(3);
      expect(error.column).toBe(1);
      const trailing = yield* Effect.flip(RdfJson.parse('{} x'));
      expect([trailing.line, trailing.column]).toEqual([1, 4]);
      const badString = yield* Effect.flip(RdfJson.parse('{"a\\q": 1}'));
      expect([badString.line, badString.column]).toEqual([1, 4]);
    }),
  );

  const invalid: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['a non-object document', [], /Expected object/],
    ['a non-array predicate value', { s: { p: { type: 'uri', value: 'o' } } }, /\["s"\]\["p"\]/],
    [
      'an unknown value type',
      { s: { p: [{ type: 'iri', value: 'o' }] } },
      /"type" must be .*\n.*\["s"\]\["p"\]\[0\]/,
    ],
    ['a missing value', { s: { p: [{ type: 'uri' }] } }, /\["value"\]/],
    ['a malformed blank node', { s: { p: [{ type: 'bnode', value: 'b1' }] } }, /_:label/],
    [
      'lang together with datatype',
      { s: { p: [{ type: 'literal', value: 'x', lang: 'en', datatype: xsd.string.value }] } },
      /cannot be combined/,
    ],
    [
      'direction without lang',
      { s: { p: [{ type: 'literal', value: 'x', direction: 'ltr' }] } },
      /requires "lang"/,
    ],
    [
      'an invalid direction',
      { s: { p: [{ type: 'literal', value: 'x', lang: 'en', direction: 'up' }] } },
      /\["direction"\]/,
    ],
    [
      'an invalid language tag',
      { s: { p: [{ type: 'literal', value: 'x', lang: 'en us' }] } },
      /Invalid language tag/,
    ],
    [
      'a literal triple term subject',
      {
        s: {
          p: [
            {
              type: 'triple',
              value: {
                subject: { type: 'literal', value: 'x' },
                predicate: { type: 'uri', value: 'p' },
                object: { type: 'uri', value: 'o' },
              },
            },
          ],
        },
      },
      /\["subject"\]/,
    ],
  ];

  for (const [name, json, message] of invalid) {
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(RdfJson.parse(JSON.stringify(json)));
        expect(error).toBeInstanceOf(Serialization.RdfParseError);
        expect(error.message).toMatch(message);
      }),
    );
  }

  it.effect('rejects the extensions in strict mode', () =>
    Effect.gen(function* () {
      const direction = JSON.stringify({
        s: { p: [{ type: 'literal', value: 'x', lang: 'ar', direction: 'rtl' }] },
      });
      const e1 = yield* Effect.flip(RdfJson.parse(direction, { strict: true }));
      expect(e1.message).toContain('extension');
      const triple = JSON.stringify({
        s: {
          p: [
            {
              type: 'triple',
              value: {
                subject: { type: 'uri', value: 's' },
                predicate: { type: 'uri', value: 'p' },
                object: { type: 'uri', value: 'o' },
              },
            },
          ],
        },
      });
      yield* Effect.flip(RdfJson.parse(triple, { strict: true }));
      const ok = yield* RdfJson.parse(specExample, { strict: true });
      expect(ok.dataset.size).toBe(1);
    }),
  );

  it.effect('parses streams of text chunks', () =>
    Effect.gen(function* () {
      const chunks = Stream.fromIterable([specExample.slice(0, 20), specExample.slice(20)]);
      const quads = yield* Stream.runCollect(RdfJson.parser.parseStream(chunks));
      expect(Array.from(quads)).toHaveLength(1);
    }),
  );
});

describe('RdfJson.serialize', () => {
  const data = [
    Term.quad(ex('s'), ex('p'), ex('o')),
    Term.quad(ex('s'), ex('p'), Term.literal('x', 'en')),
    Term.quad(ex('s'), ex('q'), Term.literal('1', xsd.integer)),
    Term.quad(Term.blankNode('b'), rdf.type, ex('T')),
    Term.quad(ex('s'), ex('r'), Term.blankNode('b')),
  ];

  it.effect('writes strict RDF/JSON', () =>
    Effect.gen(function* () {
      const json = yield* RdfJson.serialize(data);
      expect(JSON.parse(json)).toEqual({
        '_:b': {
          'http://www.w3.org/1999/02/22-rdf-syntax-ns#type': [
            { type: 'uri', value: 'http://example.org/T' },
          ],
        },
        'http://example.org/s': {
          'http://example.org/p': [
            { type: 'uri', value: 'http://example.org/o' },
            { type: 'literal', value: 'x', lang: 'en' },
          ],
          'http://example.org/q': [
            { type: 'literal', value: '1', datatype: 'http://www.w3.org/2001/XMLSchema#integer' },
          ],
          'http://example.org/r': [{ type: 'bnode', value: '_:b' }],
        },
      });
      expect(json.endsWith('\n')).toBe(true);
    }),
  );

  it.effect('round-trips through parse', () =>
    Effect.gen(function* () {
      const json = yield* RdfJson.serialize(data, { space: 0 });
      expect(json).not.toContain('\n  ');
      const { dataset } = yield* RdfJson.parse(json);
      expect(Isomorphism.isomorphic(dataset, Dataset.fromIterable(data))).toBe(true);
    }),
  );

  const extended = [
    Term.quad(ex('s'), ex('p'), Term.literal('مرحبا', { language: 'ar', direction: 'rtl' })),
    Term.quad(
      ex('s'),
      ex('says'),
      Term.triple(Term.blankNode('x'), ex('q'), Term.triple(ex('a'), ex('b'), Term.literal('c'))),
    ),
  ];

  it.effect('requires the extensions for RDF 1.2 data', () =>
    Effect.gen(function* () {
      for (const q of extended) {
        const error = yield* Effect.flip(RdfJson.serialize([q]));
        expect(error).toBeInstanceOf(Serialization.RdfSerializeError);
        expect(error.message).toContain('extensions');
      }
      const json = yield* RdfJson.serialize(extended, { extensions: true });
      expect(JSON.parse(json)['http://example.org/s']['http://example.org/p']).toEqual([
        { type: 'literal', value: 'مرحبا', lang: 'ar', direction: 'rtl' },
      ]);
      const { dataset } = yield* RdfJson.parse(json);
      expect(nquads(dataset)).toBe(nquads(Dataset.fromIterable(extended)));
    }),
  );

  it.effect('rejects named graphs unless merging', () =>
    Effect.gen(function* () {
      const quads = [
        Term.quad(ex('s'), ex('p'), ex('o'), ex('g1')),
        Term.quad(ex('s'), ex('p'), ex('o'), ex('g2')),
        Term.quad(ex('s'), ex('p'), ex('o2')),
      ];
      const error = yield* Effect.flip(RdfJson.serialize(quads));
      expect(error.message).toContain('named graphs');
      const json = yield* RdfJson.serialize(quads, { mergeGraphs: true });
      expect(JSON.parse(json)).toEqual({
        'http://example.org/s': {
          'http://example.org/p': [
            { type: 'uri', value: 'http://example.org/o2' },
            { type: 'uri', value: 'http://example.org/o' },
          ],
        },
      });
    }),
  );

  it.effect('rejects triple terms as subjects', () =>
    Effect.gen(function* () {
      const t = Term.triple(ex('a'), ex('b'), ex('c'));
      yield* Effect.flip(RdfJson.serialize([Term.quad(t, ex('p'), ex('o'))], { extensions: true }));
      yield* Effect.flip(
        RdfJson.serialize([Term.quad(ex('s'), ex('p'), Term.triple(t, ex('q'), ex('r')))], {
          extensions: true,
        }),
      );
    }),
  );
});

describe('RdfJson schemas', () => {
  it.effect('RdfJsonFromString decodes and encodes typed documents', () =>
    Effect.gen(function* () {
      const document = yield* Schema.decodeEffect(RdfJson.RdfJsonFromString)(specExample);
      expect(document['http://example.org/about']!['http://purl.org/dc/terms/title']).toEqual([
        { type: 'literal', value: "Anna's Homepage", lang: 'en' },
      ]);
      const text = yield* Schema.encodeEffect(RdfJson.RdfJsonFromString)(document);
      expect(JSON.parse(text)).toEqual(JSON.parse(specExample));
      const error = yield* Effect.flip(Schema.decodeEffect(RdfJson.RdfJsonFromString)('{"s": 1}'));
      expect(error.message).toContain('["s"]');
    }),
  );

  it('validates values with Schema.is', () => {
    expect(Schema.is(RdfJson.ObjectValue)({ type: 'uri', value: 'http://x' })).toBe(true);
    expect(Schema.is(RdfJson.ObjectValue)({ type: 'bnode', value: 'x' })).toBe(false);
    expect(
      Schema.is(RdfJson.StrictObjectValue)({
        type: 'literal',
        value: 'x',
        lang: 'en',
        direction: 'ltr',
      }),
    ).toBe(false);
    expect(Schema.is(RdfJson.Document)({ s: { p: [] } })).toBe(true);
  });

  it.effect('DatasetFromRdfJson transforms documents and datasets', () =>
    Effect.gen(function* () {
      const dataset = yield* Schema.decodeUnknownEffect(RdfJson.DatasetFromRdfJson)(
        JSON.parse(specExample),
      );
      expect(dataset.size).toBe(1);
      const document = yield* Schema.encodeEffect(RdfJson.DatasetFromRdfJson)(dataset);
      expect(document).toEqual(JSON.parse(specExample));
      const named = Dataset.make(Term.quad(ex('s'), ex('p'), ex('o'), ex('g')));
      const error = yield* Effect.flip(Schema.encodeEffect(RdfJson.DatasetFromRdfJson)(named));
      expect(error.message).toContain('named graphs');
      const merged = yield* Schema.encodeEffect(RdfJson.makeDatasetSchema({ mergeGraphs: true }))(
        named,
      );
      expect(Object.keys(merged)).toEqual(['http://example.org/s']);
    }),
  );

  it.effect('the codec schema is DatasetFromString', () =>
    Effect.gen(function* () {
      const dataset = yield* Schema.decodeEffect(RdfJson.codec.schema)(specExample);
      const text = yield* Schema.encodeEffect(RdfJson.codec.schema)(dataset);
      const again = yield* Schema.decodeEffect(RdfJson.DatasetFromString)(text);
      expect(Isomorphism.isomorphic(dataset, again)).toBe(true);
    }),
  );

  it('toDataset converts validated documents', () => {
    const ds = RdfJson.toDataset(
      { '_:a': { 'http://example.org/p': [{ type: 'bnode', value: '_:a' }] } },
      { blankNodePrefix: 'x_' },
    );
    expect(Dataset.toNQuads(ds)).toBe('_:x_a <http://example.org/p> _:x_a .\n');
  });

  it('describes the format', () => {
    expect(RdfJson.format.mediaType).toBe('application/rdf+json');
    expect(RdfJson.codec.format.datasets).toBe(false);
  });
});
