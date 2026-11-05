import { describe, expect, it } from '@effect/vitest';
import * as BigDecimal from 'effect/BigDecimal';
import * as DateTime from 'effect/DateTime';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { Term, TermCodec, Xsd } from '../src/index.ts';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const typed = (value: string, local: string) =>
  Term.literal(value, Term.namedNode(`${XSD}${local}`));

const decodes = <A>(
  codec: TermCodec.TermCodec<A>,
  term: Term.GroundTerm,
): Result.Result<A, unknown> => Schema.decodeResult(codec)(term);
const encodes = <A>(codec: TermCodec.TermCodec<A>, value: A): string =>
  Schema.encodeSync(codec)(value).key;

describe('TermCodec', () => {
  it('decodes and encodes the basic codecs', () => {
    expect(decodes(TermCodec.string, Term.literal('hi', 'en'))).toStrictEqual(Result.succeed('hi'));
    expect(Result.isFailure(decodes(TermCodec.string, Xsd.integer(1)))).toBe(true);
    expect(decodes(TermCodec.integer, Xsd.integer(42))).toStrictEqual(Result.succeed(42));
    expect(decodes(TermCodec.bigint, Xsd.integer(42))).toStrictEqual(Result.succeed(42n));
    expect(decodes(TermCodec.boolean, Xsd.boolean(true))).toStrictEqual(Result.succeed(true));
    expect(decodes(TermCodec.iri, Term.namedNode('http://a'))).toStrictEqual(
      Result.succeed('http://a'),
    );
    expect(Result.isFailure(decodes(TermCodec.iri, Term.blankNode('b')))).toBe(true);
    expect(encodes(TermCodec.number, 1.5)).toBe(Xsd.double(1.5).key);
    expect(encodes(TermCodec.decimal, BigDecimal.fromStringUnsafe('1.50'))).toContain('decimal');
    expect(decodes(TermCodec.typed(`${XSD}gYear`), typed('2024', 'gYear'))).toStrictEqual(
      Result.succeed('2024'),
    );
  });

  it('decodes the moved term, resource, literal, lexical, value and date codecs', () => {
    const iri = Term.namedNode('http://a');
    const bnode = Term.blankNode('b');
    expect(decodes(TermCodec.term, bnode)).toStrictEqual(Result.succeed(bnode));
    expect(decodes(TermCodec.namedNode, iri)).toStrictEqual(Result.succeed(iri));
    expect(Result.isFailure(decodes(TermCodec.namedNode, bnode))).toBe(true);
    expect(decodes(TermCodec.resource, bnode)).toStrictEqual(Result.succeed(bnode));
    expect(Result.isFailure(decodes(TermCodec.resource, Term.literal('x')))).toBe(true);
    expect(decodes(TermCodec.literal, Xsd.integer(1))).toStrictEqual(
      Result.succeed(Xsd.integer(1)),
    );
    expect(Result.isFailure(decodes(TermCodec.literal, iri))).toBe(true);
    expect(decodes(TermCodec.lexical, iri)).toStrictEqual(Result.succeed('http://a'));
    expect(decodes(TermCodec.lexical, Xsd.integer(3))).toStrictEqual(Result.succeed('3'));
    expect(Result.isFailure(decodes(TermCodec.lexical, bnode))).toBe(true);
    expect(decodes(TermCodec.value, Xsd.boolean(false))).toStrictEqual(Result.succeed(false));
    expect(Result.isFailure(decodes(TermCodec.value, iri))).toBe(true);
    expect(decodes(TermCodec.number, typed('2.5', 'decimal'))).toStrictEqual(Result.succeed(2.5));
    expect(Result.isFailure(decodes(TermCodec.number, Term.literal('x')))).toBe(true);
    const d = Schema.decodeSync(TermCodec.decimal)(Xsd.integer(4));
    expect(BigDecimal.format(d)).toBe('4');
    expect(Result.isFailure(decodes(TermCodec.decimal, Term.literal('x')))).toBe(true);
    expect(Result.isFailure(decodes(TermCodec.boolean, Xsd.integer(1)))).toBe(true);
    const date = Schema.decodeSync(TermCodec.date)(typed('2024-06-15', 'date'));
    expect(date.toISOString()).toBe('2024-06-15T00:00:00.000Z');
    expect(Result.isFailure(decodes(TermCodec.date, typed('12:00:00', 'time')))).toBe(true);
    expect(Result.isFailure(decodes(TermCodec.date, iri))).toBe(true);
    expect(encodes(TermCodec.date, date)).toBe(`"2024-06-15T00:00:00.000Z"^^<${XSD}dateTime>`);
    expect(Result.isFailure(decodes(TermCodec.integer, typed('1.5', 'decimal')))).toBe(true);
    expect(Result.isFailure(decodes(TermCodec.bigint, typed('x', 'integer')))).toBe(true);
    expect(Result.isFailure(decodes(TermCodec.typed(`${XSD}gYear`), Term.literal('2024')))).toBe(
      true,
    );
  });

  it('dateTime decodes to DateTime.Utc or DateTime.Zoned', () => {
    const utc = Schema.decodeSync(TermCodec.dateTime)(typed('2024-06-15T14:30:00Z', 'dateTime'));
    expect(DateTime.isUtc(utc)).toBe(true);
    expect(DateTime.formatIso(utc)).toBe('2024-06-15T14:30:00.000Z');
    const local = Schema.decodeSync(TermCodec.dateTime)(typed('2024-06-15T14:30:00', 'dateTime'));
    expect(DateTime.isUtc(local)).toBe(true);
    const zoned = Schema.decodeSync(TermCodec.dateTime)(
      typed('2024-06-15T14:30:00+02:00', 'dateTime'),
    );
    expect(DateTime.isZoned(zoned)).toBe(true);
    expect(DateTime.toEpochMillis(zoned)).toBe(
      DateTime.toEpochMillis(DateTime.makeUnsafe('2024-06-15T12:30:00Z')),
    );
    expect(encodes(TermCodec.dateTime, zoned)).toBe(
      `"2024-06-15T14:30:00.000+02:00"^^<${XSD}dateTime>`,
    );
    expect(encodes(TermCodec.dateTime, utc)).toBe(`"2024-06-15T14:30:00.000Z"^^<${XSD}dateTime>`);
    expect(Result.isFailure(decodes(TermCodec.dateTime, typed('2024-06-15', 'date')))).toBe(true);
    expect(Result.isFailure(decodes(TermCodec.dateTime, typed('nonsense', 'dateTime')))).toBe(true);
  });

  it('double and float keep their datatype', () => {
    expect(decodes(TermCodec.double, typed('1.5E0', 'double'))).toStrictEqual(Result.succeed(1.5));
    expect(Result.isFailure(decodes(TermCodec.double, typed('1.5', 'float')))).toBe(true);
    expect(Result.isFailure(decodes(TermCodec.double, Xsd.integer(1)))).toBe(true);
    expect(encodes(TermCodec.double, 2)).toBe(Xsd.double(2).key);
    expect(decodes(TermCodec.float, typed('0.5', 'float'))).toStrictEqual(Result.succeed(0.5));
    expect(encodes(TermCodec.float, 0.5)).toBe(Xsd.float(0.5).key);
  });

  it('localized covers plain, language-tagged and directional strings', () => {
    expect(decodes(TermCodec.localized, Term.literal('a'))).toStrictEqual(
      Result.succeed({ value: 'a' }),
    );
    expect(decodes(TermCodec.localized, Term.literal('a', 'en'))).toStrictEqual(
      Result.succeed({ value: 'a', language: 'en' }),
    );
    const rtl = Term.literal('a', { language: 'ar', direction: 'rtl' });
    expect(decodes(TermCodec.localized, rtl)).toStrictEqual(
      Result.succeed({ value: 'a', language: 'ar', direction: 'rtl' }),
    );
    expect(encodes(TermCodec.localized, { value: 'a', language: 'ar', direction: 'rtl' })).toBe(
      rtl.key,
    );
    expect(encodes(TermCodec.localized, { value: 'a' })).toBe('"a"');
    expect(Result.isFailure(decodes(TermCodec.localized, Xsd.integer(1)))).toBe(true);
    expect(decodes(TermCodec.langString, rtl)).toStrictEqual(
      Result.succeed({ value: 'a', language: 'ar', direction: 'rtl' }),
    );
  });

  it('typedOneOf accepts any of its datatypes and restores the literal', () => {
    const codec = TermCodec.typedOneOf([`${XSD}date`, Term.namedNode(`${XSD}gYear`)]);
    expect(decodes(codec, typed('2024', 'gYear'))).toStrictEqual(
      Result.succeed({ value: '2024', datatype: `${XSD}gYear` }),
    );
    expect(Result.isFailure(decodes(codec, typed('2024', 'integer')))).toBe(true);
    expect(encodes(codec, { value: '2024-01-01', datatype: `${XSD}date` })).toBe(
      typed('2024-01-01', 'date').key,
    );
  });

  it('a struct of codecs has a JSON codec through the term JSON shape', () => {
    const Person = Schema.Struct({ name: TermCodec.string, age: TermCodec.integer });
    const json = Schema.encodeSync(Schema.toCodecJson(Person))({ name: 'Ann', age: 7 });
    expect(json).toStrictEqual({
      name: { type: 'literal', value: 'Ann' },
      age: { type: 'literal', value: '7', datatype: `${XSD}integer` },
    });
    expect(Schema.decodeSync(Schema.toCodecJson(Person))(json)).toStrictEqual({
      name: 'Ann',
      age: 7,
    });
  });
});
