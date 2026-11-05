import { describe, expect, it } from '@effect/vitest';
import * as Equal from 'effect/Equal';
import * as Schema from 'effect/Schema';
import { Dataset, Term, TermJson } from '../src/index.ts';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const s = Term.namedNode('http://example.org/s');
const p = Term.namedNode('http://example.org/p');
const g = Term.namedNode('http://example.org/g');
const nested = Term.triple(
  Term.triple(s, p, Term.literal('o')),
  p,
  Term.triple(Term.blankNode('b'), p, Term.literal('1', Term.namedNode(`${XSD}integer`))),
);

const terms: ReadonlyArray<Term.Term> = [
  s,
  Term.blankNode('b0'),
  Term.literal('plain'),
  Term.literal('42', Term.namedNode(`${XSD}integer`)),
  Term.literal('hi', 'en'),
  Term.literal('مرحبا', { language: 'ar', direction: 'rtl' }),
  Term.literal('hi', { language: 'en', direction: 'ltr' }),
  Term.triple(s, p, Term.literal('o')),
  nested,
  Term.variable('x'),
  Term.defaultGraph,
];

// JSON text, through Schema rather than `JSON.parse` / `JSON.stringify`.
const JsonText = Schema.fromJsonString(Schema.Unknown);
const toText = Schema.encodeSync(JsonText);
const fromText = Schema.decodeSync(JsonText);

/** Encodes through `toCodecJson`, checks the result survives JSON text, and returns it. */
const encodeJson = <T, E>(schema: Schema.Codec<T, E>, value: T): Schema.Json => {
  const json = Schema.encodeSync(Schema.toCodecJson(schema))(value);
  expect(fromText(toText(json))).toStrictEqual(json);
  return json;
};

/** Whether `value` survives a `toCodecJson` encode / decode round trip. */
const roundTrips = <T, E>(schema: Schema.Codec<T, E>, value: T): boolean =>
  Equal.equals(Schema.decodeSync(Schema.toCodecJson(schema))(encodeJson(schema, value)), value);

const roundTrip = <T, E>(schema: Schema.Codec<T, E>, value: T): Schema.Json => {
  expect(roundTrips(schema, value)).toBe(true);
  return encodeJson(schema, value);
};

describe('TermJson', () => {
  it('round-trips every term kind through TermSchema', () => {
    expect(terms.filter((term) => !roundTrips(Term.TermSchema, term))).toStrictEqual([]);
  });

  it('uses the SPARQL JSON results shape plus the extensions', () => {
    expect(roundTrip(Term.TermSchema, s)).toStrictEqual({ type: 'uri', value: s.value });
    expect(roundTrip(Term.TermSchema, Term.literal('hi', 'en'))).toStrictEqual({
      type: 'literal',
      value: 'hi',
      'xml:lang': 'en',
    });
    expect(
      roundTrip(Term.TermSchema, Term.literal('hi', { language: 'ar', direction: 'rtl' })),
    ).toStrictEqual({ type: 'literal', value: 'hi', 'xml:lang': 'ar', 'its:dir': 'rtl' });
    expect(
      roundTrip(Term.TermSchema, Term.literal('1', Term.namedNode(`${XSD}integer`))),
    ).toStrictEqual({ type: 'literal', value: '1', datatype: `${XSD}integer` });
    expect(roundTrip(Term.TermSchema, Term.variable('x'))).toStrictEqual({
      type: 'variable',
      value: 'x',
    });
    expect(roundTrip(Term.TermSchema, Term.defaultGraph)).toStrictEqual({
      type: 'default-graph',
    });
  });

  it('round-trips through the narrower declarations', () => {
    expect(roundTrips(Term.NamedNodeSchema, s)).toBe(true);
    expect(roundTrips(Term.BlankNodeSchema, Term.blankNode('b'))).toBe(true);
    expect(roundTrips(Term.LiteralSchema, Term.literal('x', 'fr'))).toBe(true);
    expect(roundTrips(Term.VariableSchema, Term.variable('v'))).toBe(true);
    expect(roundTrips(Term.TripleSchema, nested)).toBe(true);
    expect(roundTrips(Term.GroundTermSchema, nested)).toBe(true);
  });

  it('rejects the wrong kind and ill-formed triple terms', () => {
    const decodeNamed = Schema.decodeUnknownResult(Schema.toCodecJson(Term.NamedNodeSchema));
    expect(decodeNamed({ type: 'bnode', value: 'b' })._tag).toBe('Failure');
    const decodeGround = Schema.decodeUnknownResult(Schema.toCodecJson(Term.GroundTermSchema));
    expect(decodeGround({ type: 'variable', value: 'x' })._tag).toBe('Failure');
    const literalSubject = {
      type: 'triple',
      value: {
        subject: { type: 'literal', value: 'x' },
        predicate: { type: 'uri', value: p.value },
        object: { type: 'literal', value: 'y' },
      },
    };
    const decodeTerm = Schema.decodeUnknownResult(Schema.toCodecJson(Term.TermSchema));
    expect(decodeTerm(literalSubject)._tag).toBe('Failure');
    const deep = { type: 'triple', value: { ...literalSubject.value, subject: literalSubject } };
    expect(decodeTerm(deep)._tag).toBe('Failure');
  });

  it('round-trips quads, omitting the default graph', () => {
    expect(roundTrip(Term.QuadSchema, Term.quad(s, p, Term.literal('o')))).toStrictEqual({
      subject: { type: 'uri', value: s.value },
      predicate: { type: 'uri', value: p.value },
      object: { type: 'literal', value: 'o' },
    });
    expect(roundTrip(Term.QuadSchema, Term.quad(Term.blankNode('x'), p, nested, g))).toMatchObject({
      graph: { type: 'uri', value: g.value },
    });
    roundTrip(Term.QuadSchema, Term.quad(nested, p, s, Term.blankNode('g')));
  });

  it('round-trips datasets with named graphs, in sorted order', () => {
    const ds = Dataset.make(
      Term.quad(s, p, Term.literal('b'), g),
      Term.quad(s, p, Term.literal('a')),
      Term.quad(nested, p, Term.literal('c', 'en'), Term.blankNode('g2')),
    );
    const json = roundTrip(Dataset.DatasetSchema, ds);
    expect(json).toStrictEqual(Dataset.toSortedArray(ds).map(Term.quadToJson));
    roundTrip(Dataset.DatasetSchema, Dataset.make());
  });

  it('fromJson / toJson agree with the codec', () => {
    expect(
      terms.filter((term) => !Equal.equals(Term.fromJson(Term.toJson(term)), term)),
    ).toStrictEqual([]);
    expect(Term.fromJson({ type: 'typed-literal', value: 'v' }).key).toBe('"v"');
    expect(Term.isWellFormed(nested)).toBe(true);
    expect(
      Term.isWellFormed(
        Term.fromJson({
          type: 'triple',
          value: {
            subject: { type: 'uri', value: 's' },
            predicate: { type: 'bnode', value: 'p' },
            object: { type: 'uri', value: 'o' },
          },
        }),
      ),
    ).toBe(false);
  });

  it('derives a non-empty JSON Schema', () => {
    const doc = Schema.toJsonSchemaDocument(Term.TermSchema);
    const text = toText(doc);
    const types = ['uri', 'bnode', 'literal', 'triple', 'variable', 'default-graph'];
    expect(types.filter((type) => !text.includes(`"${type}"`))).toStrictEqual([]);
    expect(text).toContain('xml:lang');
    const named = toText(Schema.toJsonSchemaDocument(Term.NamedNodeSchema));
    expect(named).toContain('"uri"');
    expect(named).not.toContain('"bnode"');
    const dataset = toText(Schema.toJsonSchemaDocument(Dataset.DatasetSchema));
    expect(dataset).toContain('"array"');
    expect(dataset).toContain('predicate');
  });

  it('exposes the plain JSON schemas', () => {
    const decode = Schema.decodeUnknownSync(TermJson.GroundTermSchema);
    expect(decode({ type: 'bnode', value: 'b' })).toStrictEqual({ type: 'bnode', value: 'b' });
    expect(() => decode({ type: 'variable', value: 'x' })).toThrow('Expected');
    expect(Schema.decodeSync(TermJson.TermSchema)({ type: 'default-graph' })).toStrictEqual({
      type: 'default-graph',
    });
  });
});
