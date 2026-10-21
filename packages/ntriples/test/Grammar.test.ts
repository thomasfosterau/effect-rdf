import { describe, expect, it } from '@effect/vitest';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Token from '@thomasfosterau/effect-parse/Token';
import * as Result from 'effect/Result';
import { Grammar, Lexical } from '../src/index.ts';

const parse = <A>(p: Parser.Parser<A>, input: string) =>
  Result.getOrUndefined(Parser.parse(p, input));
const fails = <A>(p: Parser.Parser<A>, input: string) => Result.isFailure(Parser.parse(p, input));

describe('Grammar', () => {
  it('has the character classes of Lexical', () => {
    const sets: ReadonlyArray<readonly [Token.StringTokenSet, (c: number) => boolean]> = [
      [Grammar.pnCharsBase, Lexical.isPnCharsBase],
      [Grammar.pnCharsU, Lexical.isPnCharsU],
      [Grammar.pnChars, Lexical.isPnChars],
      [Grammar.digit, Lexical.isDigit],
      [Grammar.hex, Lexical.isHex],
    ];
    const mismatches: Array<string> = [];
    for (const [set, predicate] of sets) {
      const one = Parser.compile(Token.oneOf(set));
      for (let c = 0; c <= 0x10ffff; c += c < 0x10000 ? 1 : 97) {
        if (c >= 0xd800 && c <= 0xdfff) continue;
        if (Result.isSuccess(Parser.parse(one, String.fromCodePoint(c))) !== predicate(c)) {
          mismatches.push(`U+${c.toString(16)}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('reads the N-Triples terminals', () => {
    expect(parse(Grammar.iriRef, '<http://a.example/\\u0041>')).toBe('http://a.example/A');
    expect(fails(Grammar.iriRef, '<a b>')).toBe(true);
    expect(parse(Grammar.blankNodeLabel, '_:b1.x')).toBe('b1.x');
    expect(fails(Grammar.blankNodeLabel, '_:b.')).toBe(true);
    expect(parse(Grammar.langDir, '@en-GB--rtl')).toEqual({ language: 'en-GB', direction: 'rtl' });
    expect(parse(Grammar.stringLiteralQuote, '"a\\tb\\u00e9"')).toBe('a\tbé');
    expect(fails(Grammar.stringLiteralQuote, '"a\nb"')).toBe(true);
    expect(parse(Grammar.uchar, '\\U0001F600')).toBe('😀');
    expect(parse(Grammar.echar, '\\n')).toBe('\n');
  });
});
