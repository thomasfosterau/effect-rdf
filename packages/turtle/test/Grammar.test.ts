import { describe, expect, it } from '@effect/vitest';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Result from 'effect/Result';
import { Grammar } from '../src/index.ts';

const parse = <A>(p: Parser.Parser<A>, input: string) =>
  Result.getOrUndefined(Parser.parse(p, input));
const fails = <A>(p: Parser.Parser<A>, input: string) => Result.isFailure(Parser.parse(p, input));

describe('Grammar', () => {
  it('IRIREF decodes UCHARs', () => {
    expect(parse(Grammar.iriRef, '<http://a.example/\\u0041\\U0001F600>')).toBe(
      'http://a.example/A😀',
    );
    expect(parse(Grammar.iriRef, '<>')).toBe('');
    expect(fails(Grammar.iriRef, '<a b>')).toBe(true);
    expect(fails(Grammar.iriRef, '<a\\n>')).toBe(true);
  });

  it('prefixed names follow PN_PREFIX and PN_LOCAL', () => {
    expect(parse(Grammar.prefixedName, 'ex:a.b')).toEqual({ prefix: 'ex', local: 'a.b' });
    expect(parse(Grammar.prefixedName, ':')).toEqual({ prefix: '', local: '' });
    expect(parse(Grammar.prefixedName, 'é.x:%41\\~:0')).toEqual({
      prefix: 'é.x',
      local: '%41~:0',
    });
    expect(Parser.parsePeek(Grammar.prefixedName, 'ex:a.')).toEqual(
      Result.succeed(['.', { prefix: 'ex', local: 'a' }]),
    );
    expect(fails(Grammar.prefixedName, '.ex:a')).toBe(true);
  });

  it('blank node labels cannot end with a dot', () => {
    expect(parse(Grammar.blankNodeLabel, '_:b.1')).toBe('b.1');
    expect(Parser.parsePeek(Grammar.blankNodeLabel, '_:b1.')).toEqual(Result.succeed(['.', 'b1']));
    expect(parse(Grammar.blankNodeLabel, '_:0')).toBe('0');
  });

  it('language tags, with RDF 1.2 base directions', () => {
    expect(parse(Grammar.langTag, '@en-GB')).toBe('en-GB');
    expect(parse(Grammar.langDir, '@ar--rtl')).toEqual({ language: 'ar', direction: 'rtl' });
    expect(parse(Grammar.langDir, '@en')).toEqual({ language: 'en', direction: undefined });
  });

  it('string literals decode ECHAR and UCHAR', () => {
    expect(parse(Grammar.stringLiteral, '"a\\tb\\"\\u0041"')).toBe('a\tb"A');
    expect(parse(Grammar.stringLiteral, "'''a''b\nc'''")).toBe("a''b\nc");
    expect(parse(Grammar.stringLiteral, '""')).toBe('');
    expect(fails(Grammar.stringLiteral, '"a\nb"')).toBe(true);
    expect(fails(Grammar.stringLiteral, '"\\q"')).toBe(true);
    expect(fails(Grammar.stringLiteral, '"\\U00110000"')).toBe(true);
  });

  it('numeric literals take the longest form', () => {
    expect(parse(Grammar.numericLiteral, '-12')).toEqual(['-12', 'integer']);
    expect(parse(Grammar.numericLiteral, '.5')).toEqual(['.5', 'decimal']);
    expect(parse(Grammar.numericLiteral, '1.e5')).toEqual(['1.e5', 'double']);
    expect(parse(Grammar.numericLiteral, '+.5E-3')).toEqual(['+.5E-3', 'double']);
    expect(Parser.parsePeek(Grammar.numericLiteral, '1.')).toEqual(
      Result.succeed(['.', ['1', 'integer']]),
    );
  });

  it('skips whitespace and comments', () => {
    expect(Parser.parsePeek(Grammar.skip, ' \t# c\n\r\n x')).toEqual(
      Result.succeed(['x', undefined]),
    );
    expect(parse(Grammar.booleanLiteral, 'true')).toBe('true');
    expect(fails(Grammar.booleanLiteral, 'trueish')).toBe(true);
  });
});
