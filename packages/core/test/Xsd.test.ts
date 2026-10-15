import { describe, expect, it } from '@effect/vitest';
import { Term, Vocab, Xsd } from '../src/index.ts';

const { xsd } = Vocab;

describe('Xsd', () => {
  it('validates lexical forms', () => {
    expect(Xsd.isValidLexical(xsd.integer.value, '-42')).toBe(true);
    expect(Xsd.isValidLexical(xsd.integer.value, '4.2')).toBe(false);
    expect(Xsd.isValidLexical(xsd.byte.value, '128')).toBe(false);
    expect(Xsd.isValidLexical(xsd.date.value, '2024-02-30')).toBe(false);
    expect(Xsd.isValidLexical(xsd.dateTime.value, '2024-02-29T12:00:00Z')).toBe(true);
    expect(Xsd.isValidLexical(xsd.boolean.value, 'yes')).toBe(false);
    expect(Xsd.isValidLexical(xsd.duration.value, 'P1Y2M3DT4H5M6.5S')).toBe(true);
    expect(Xsd.isValidLexical(xsd.duration.value, 'P')).toBe(false);
  });

  it('canonicalizes', () => {
    expect(Xsd.canonicalize(Term.literal('+007', xsd.integer)).value).toBe('7');
    expect(Xsd.canonicalize(Term.literal('1', xsd.boolean)).value).toBe('true');
    expect(Xsd.canonicalize(Term.literal('1.50', xsd.decimal)).value).toBe('1.5');
    expect(Xsd.canonicalize(Term.literal('100', xsd.double)).value).toBe('1.0E2');
    expect(Xsd.double(0.5).value).toBe('5.0E-1');
  });

  it('maps values', () => {
    expect(Xsd.toValue(Term.literal('12', xsd.int))).toEqual({ _tag: 'Integer', value: 12n });
    const dt = Xsd.toValue(Term.literal('2020-01-01T00:00:00+01:00', xsd.dateTime));
    expect(dt._tag === 'DateTime' && dt.epochMillis).toBe(Date.UTC(2019, 11, 31, 23));
    expect(Xsd.toValue(Term.literal('-P1DT1S', xsd.dayTimeDuration))).toEqual({
      _tag: 'Duration',
      months: 0,
      seconds: -86401,
    });
    expect(Xsd.fromJs(1.5).datatype.value).toBe(xsd.double.value);
    expect(Xsd.fromJs(3).key).toBe('"3"^^<http://www.w3.org/2001/XMLSchema#integer>');
  });
});
