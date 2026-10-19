import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { Term } from '@thomasfosterau/effect-rdf';
import * as Results from '../src/Results.ts';

const XSD = 'http://www.w3.org/2001/XMLSchema#';

const key = (text: string) => Option.map(Results.parseTerm(text), (t) => t.key);

describe('parseTerm', () => {
  it('parses IRIs, blank nodes and literals', () => {
    expect(Results.parseTerm('<http://example.org/a>')).toEqual(
      Option.some(Term.namedNode('http://example.org/a')),
    );
    expect(Results.parseTerm('_:b0')).toEqual(Option.some(Term.blankNode('b0')));
    expect(Results.parseTerm('"chat"@fr')).toEqual(Option.some(Term.literal('chat', 'fr')));
    expect(Results.parseTerm('"x"@ar--rtl')).toEqual(
      Option.some(Term.literal('x', { language: 'ar', direction: 'rtl' })),
    );
    expect(Results.parseTerm('"1"^^<http://t>')).toEqual(
      Option.some(Term.literal('1', Term.namedNode('http://t'))),
    );
    expect(Results.parseTerm("'''a'b''c'''")).toEqual(Option.some(Term.literal("a'b''c")));
  });

  it('unescapes ECHAR and UCHAR', () => {
    expect(Results.parseTerm('"a\\tb\\n\\"\\\\"')).toEqual(Option.some(Term.literal('a\tb\n"\\')));
    expect(Results.parseTerm('"\\u0041\\U0001F600"')).toEqual(Option.some(Term.literal('A😀')));
    expect(Results.parseTerm('<http://a/\\u0020>')).toEqual(
      Option.some(Term.namedNode('http://a/ ')),
    );
    expect(Results.parseTerm('"\\uZZZZ"')).toEqual(Option.none());
    expect(Results.parseTerm('"\\U00110000"')).toEqual(Option.none());
  });

  it('types numbers and booleans', () => {
    expect(Results.parseTerm('-12')).toEqual(
      Option.some(Term.literal('-12', Term.namedNode(`${XSD}integer`))),
    );
    expect(Results.parseTerm('.5')).toEqual(
      Option.some(Term.literal('.5', Term.namedNode(`${XSD}decimal`))),
    );
    expect(Results.parseTerm('1.e5')).toEqual(
      Option.some(Term.literal('1.e5', Term.namedNode(`${XSD}double`))),
    );
    expect(Results.parseTerm('true')).toEqual(
      Option.some(Term.literal('true', Term.namedNode(`${XSD}boolean`))),
    );
    expect(Results.parseTerm('truex')).toEqual(Option.none());
    expect(Results.parseTerm('12abc')).toEqual(Option.none());
  });

  it('parses nested triple terms', () => {
    expect(key('<<( <a> <b> <<( _:c <d> "e" )>> )>>')).toEqual(
      Option.some(
        Term.triple(
          Term.namedNode('a'),
          Term.namedNode('b'),
          Term.triple(Term.blankNode('c'), Term.namedNode('d'), Term.literal('e')),
        ).key,
      ),
    );
    expect(Results.parseTerm('<<( <a> <b> )>>')).toEqual(Option.none());
  });

  it('allows surrounding whitespace only', () => {
    expect(Results.parseTerm('  <a>  ')).toEqual(Option.some(Term.namedNode('a')));
    expect(Results.parseTerm('<a> <b>')).toEqual(Option.none());
    expect(Results.parseTerm('')).toEqual(Option.none());
  });
});

describe('TSV', () => {
  it.effect('reports the line and column of an invalid term', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Results.Tsv.parse('?a\t?b\n<http://a>\t"x\n'));
      expect(error.line).toBe(2);
      expect(error.column).toBe(14);
      expect(error.message).toContain('Invalid term: "x');
    }),
  );
});

describe('CSV', () => {
  it.effect('parses quoted fields, CR line endings and empty solutions', () =>
    Effect.gen(function* () {
      const parsed = yield* Results.Csv.parse('a,b\r"x ""y"",\nz",1\r\n\r\n_:b,""');
      expect(parsed._tag).toBe('ResultSet');
      if (parsed._tag !== 'ResultSet') return;
      expect(parsed.variables).toEqual(['a', 'b']);
      const rows = parsed.bindings.map((b) => ['a', 'b'].map((v) => b.map.get(v)?.key ?? null));
      expect(rows).toEqual([
        [Term.literal('x "y",\nz').key, Term.literal('1', Term.namedNode(`${XSD}integer`)).key],
        [null, null],
        [Term.blankNode('b').key, Term.literal('').key],
      ]);
    }),
  );

  it.effect('reports the line and column of a malformed field', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Results.Csv.parse('a,b\r\n"x"y,z\r\n'));
      expect(error.line).toBe(2);
      expect(error.column).toBe(4);
      const unterminated = yield* Effect.flip(Results.Csv.parse('a\r\n"x\r\n'));
      expect(unterminated.line).toBe(3);
    }),
  );
});
