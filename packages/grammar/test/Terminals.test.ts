import { describe, expect, it } from '@effect/vitest';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Result from 'effect/Result';
import { Terminals } from '../src/index.ts';

const parse = <A>(p: Parser.Parser<A>, input: string) =>
  Result.getOrUndefined(Parser.parse(p, input));
const fails = <A>(p: Parser.Parser<A>, input: string) => Result.isFailure(Parser.parse(p, input));

describe('Terminals', () => {
  it('IRIREF decodes UCHARs', () => {
    expect(parse(Terminals.iriRef, '<http://a.example/\\u0041\\U0001F600>')).toBe(
      'http://a.example/A😀',
    );
    expect(parse(Terminals.iriRef, '<>')).toBe('');
    expect(fails(Terminals.iriRef, '<a b>')).toBe(true);
    expect(fails(Terminals.iriRef, '<a\\n>')).toBe(true);
  });

  it('prefixed names follow PN_PREFIX and PN_LOCAL', () => {
    expect(parse(Terminals.prefixedName, 'ex:a.b')).toEqual({ prefix: 'ex', local: 'a.b' });
    expect(parse(Terminals.prefixedName, ':')).toEqual({ prefix: '', local: '' });
    expect(parse(Terminals.prefixedName, 'é.x:%41\\~:0')).toEqual({
      prefix: 'é.x',
      local: '%41~:0',
    });
    expect(Parser.parsePeek(Terminals.prefixedName, 'ex:a.')).toEqual(
      Result.succeed(['.', { prefix: 'ex', local: 'a' }]),
    );
    expect(fails(Terminals.prefixedName, '.ex:a')).toBe(true);
  });

  it('blank node labels cannot end with a dot', () => {
    expect(parse(Terminals.blankNodeLabel, '_:b.1')).toBe('b.1');
    expect(Parser.parsePeek(Terminals.blankNodeLabel, '_:b1.')).toEqual(
      Result.succeed(['.', 'b1']),
    );
    expect(parse(Terminals.blankNodeLabel, '_:0')).toBe('0');
  });

  it('language tags, with RDF 1.2 base directions', () => {
    expect(parse(Terminals.langTag, '@en-GB')).toBe('en-GB');
    expect(parse(Terminals.langDir, '@ar--rtl')).toEqual({ language: 'ar', direction: 'rtl' });
    expect(parse(Terminals.langDir, '@en')).toEqual({ language: 'en', direction: undefined });
  });

  it('string literals decode ECHAR and UCHAR', () => {
    expect(parse(Terminals.stringLiteral, '"a\\tb\\"\\u0041"')).toBe('a\tb"A');
    expect(parse(Terminals.stringLiteral, "'''a''b\nc'''")).toBe("a''b\nc");
    expect(parse(Terminals.stringLiteral, '""')).toBe('');
    expect(fails(Terminals.stringLiteral, '"a\nb"')).toBe(true);
    expect(fails(Terminals.stringLiteral, '"\\q"')).toBe(true);
    expect(fails(Terminals.stringLiteral, '"\\U00110000"')).toBe(true);
  });

  it('numeric literals take the longest form', () => {
    expect(parse(Terminals.numericLiteral, '-12')).toEqual(['-12', 'integer']);
    expect(parse(Terminals.numericLiteral, '.5')).toEqual(['.5', 'decimal']);
    expect(parse(Terminals.numericLiteral, '1.e5')).toEqual(['1.e5', 'double']);
    expect(parse(Terminals.numericLiteral, '+.5E-3')).toEqual(['+.5E-3', 'double']);
    expect(Parser.parsePeek(Terminals.numericLiteral, '1.')).toEqual(
      Result.succeed(['.', ['1', 'integer']]),
    );
  });

  it('skips whitespace and comments', () => {
    expect(Parser.parsePeek(Terminals.skip, ' \t# c\n\r\n x')).toEqual(
      Result.succeed(['x', undefined]),
    );
    expect(parse(Terminals.booleanLiteral, 'true')).toBe('true');
    expect(fails(Terminals.booleanLiteral, 'trueish')).toBe(true);
  });
});
