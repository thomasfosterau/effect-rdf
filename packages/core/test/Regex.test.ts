import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import { describe, expect, it } from 'vite-plus/test';
import * as Regex from '../src/internal/regex.ts';

/** Compiles a pattern the test expects to be valid. */
const compiled = (pattern: string, dialect: Regex.Dialect, flags = ''): Regex.Regex =>
  Result.getOrElse(Regex.compile(pattern, dialect, flags), (reason) => expect.fail(reason));

/** The reason a pattern is rejected (empty when it compiles). */
const rejection = (pattern: string, dialect: Regex.Dialect, flags = ''): string =>
  Result.match(Regex.compile(pattern, dialect, flags), {
    onFailure: (reason) => reason,
    onSuccess: () => '',
  });

const xpath = (pattern: string, input: string, flags = ''): boolean =>
  Regex.test(compiled(pattern, 'xpath', flags), input);

/** The groups of the first match (`undefined` for one that took no part), or `null`. */
const groupsOf = (re: Regex.Regex, input: string): ReadonlyArray<string | undefined> | null =>
  Option.match(Regex.first(re, input), {
    onNone: () => null,
    onSome: (captures) =>
      Arr.makeBy(re.groups + 1, (n) => Option.getOrUndefined(Regex.group(input, captures, n))),
  });

const milliseconds = (run: () => void): number => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

// Patterns the engine and the JavaScript engine must agree on (ECMAScript syntax, Unicode mode).
const PATTERNS = [
  'a',
  'abc',
  'a|b',
  'a*',
  'a+b',
  '(a|b)*c',
  '^abc$',
  '^a.c$',
  'a{2,3}',
  'a{2,}',
  'a{2}',
  'a{0}b',
  '(a+)+$',
  '[a-c]+',
  '[^a-c]+',
  '[\\]a]+',
  '\\d+',
  '\\D+',
  '\\w+\\s\\w+',
  '\\S+',
  'a??b',
  'a*?b',
  'a{1,2}?',
  '(a)(b)?',
  '(?:ab)+',
  '(a|ab)(c|bcd)(d*)',
  '\\bfoo\\b',
  '\\Boo',
  'x*',
  '(a*)*b',
  '(a|b|)+c',
  'a(?=b)',
  'a(?!b)',
  '(?=(a))a',
  '(a)\\1',
  '(?<n>a+)\\k<n>',
  '[\\d.]+',
  '\\.',
  '\\u0041',
  '\\u{1F600}',
  '\\x41',
  '\\cJ',
  '\\0',
  '\\t|\\n|\\r|\\f|\\v',
  'colou?r',
  '^$',
  '$',
  '^',
  '(^a|b$)',
  'é+',
  '[😀-😂]+',
  '.',
  '(.*)(\\d+)',
  '(.*?)(\\d+)',
  '(a+?)(a*)',
  '\\p{Lu}+',
  '\\P{L}+',
];

const INPUTS = [
  '',
  'a',
  'b',
  'abc',
  'aab',
  'aaa',
  'abab',
  'xabcx',
  'foo bar',
  'a foo b',
  'aa',
  'ab',
  'ac',
  'abcd',
  'aaaa!',
  '12.5',
  'color colour',
  'éé',
  '😁😀x',
  'x\ny',
  'ba',
  'abc123',
  'cab',
  'A\tB\n',
  '\0]',
  'ABc',
];

describe('Regex (the linear-time engine)', () => {
  describe('agreement with the JavaScript engine', () => {
    it.each(PATTERNS)('/%s/u', (pattern) => {
      const re = compiled(pattern, 'ecma');
      const native = new RegExp(pattern, 'u');
      const global = new RegExp(pattern, 'gu');
      INPUTS.forEach((input) => {
        const expected = native.exec(input);
        expect(Regex.test(re, input), `test on "${input}"`).toBe(expected !== null);
        expect(groupsOf(re, input), `groups on "${input}"`).toEqual(
          expected === null ? null : Array.from(expected),
        );
        expect(
          Option.getOrUndefined(Regex.replaceAll(re, input, () => '<>')),
          `replace on "${input}"`,
        ).toBe(input.replace(global, '<>'));
      });
    });

    it('ignores letter case with the i flag, as the JavaScript engine does', () => {
      ['abc', 'é', '[a-c]+', 'ß', '(a)\\1', 'k'].forEach((pattern) => {
        const re = compiled(pattern, 'ecma', 'i');
        const native = new RegExp(pattern, 'iu');
        ['ABC', 'abc', 'É', 'aBcA', 'ẞ', 'aA', 'K', 'x'].forEach((input) => {
          expect(Regex.test(re, input), `/${pattern}/i on "${input}"`).toBe(native.test(input));
        });
      });
    });

    it('keeps the last iteration of a group, where the JavaScript engine resets inner groups', () => {
      // `((a)|(b))+` on "ab": ECMAScript clears group 2 when the second iteration takes the
      // other branch; XPath (and this engine, in both dialects) keeps what it last matched.
      expect(groupsOf(compiled('((a)|(b))+', 'ecma'), 'ab')).toEqual(['ab', 'b', 'a', 'b']);
    });
  });

  describe('the XPath dialect', () => {
    it('uses the XML Schema character classes', () => {
      expect(xpath('^\\d+$', '٣٤')).toBe(true);
      expect(xpath('^\\D+$', '٣')).toBe(false);
      expect(xpath('^\\w+$', 'né€')).toBe(true);
      expect(xpath('^\\W$', '-')).toBe(true);
      expect(xpath('^\\s\\S$', '\tx')).toBe(true);
      expect(xpath('^\\i\\c*$', 'xs:string')).toBe(true);
      expect(xpath('^\\i', '1a')).toBe(false);
      expect(xpath('^\\I\\C$', '1 ')).toBe(true);
      expect(xpath('^\\p{IsGreek}+$', 'αβγ')).toBe(true);
      expect(xpath('^\\P{IsBasicLatin}$', 'a')).toBe(false);
      expect(xpath('^\\p{Lu}\\p{Ll}$', 'Ab')).toBe(true);
    });

    it('subtracts classes and unions complemented escapes', () => {
      expect(xpath('^[a-z-[aeiou]]+$', 'xyz')).toBe(true);
      expect(xpath('^[a-z-[aeiou]]+$', 'xyza')).toBe(false);
      expect(xpath('^[^a-z-[aeiou]]$', 'A')).toBe(true);
      expect(xpath('^[\\D1]+$', 'a1b')).toBe(true);
      expect(xpath('^[\\D1]+$', '2')).toBe(false);
      expect(xpath('^[^\\D1]$', '2')).toBe(true);
      expect(xpath('^[^\\D1]$', '1')).toBe(false);
      expect(xpath('^[\\d\\s]+$', '1 2')).toBe(true);
      expect(xpath('^[-a]+$', 'a-')).toBe(true);
      expect(xpath('^[a-]+$', '-a')).toBe(true);
      expect(xpath('^[a\\-z]+$', 'a-z')).toBe(true);
      expect(xpath('^[a\\-z]+$', 'b')).toBe(false);
      expect(xpath('^[]]$', ']')).toBe(true);
      expect(xpath('^[\\p{L}-[\\p{Lu}]]$', 'a')).toBe(true);
      expect(xpath('^[\\p{L}-[\\p{Lu}]]$', 'A')).toBe(false);
    });

    it('applies the flags', () => {
      expect(xpath('a.c', 'a\nc')).toBe(false);
      expect(xpath('a.c', 'a c')).toBe(true);
      expect(xpath('a.c', 'a\nc', 's')).toBe(true);
      expect(xpath('^b$', 'a\nb\nc')).toBe(false);
      expect(xpath('^b$', 'a\nb\nc', 'm')).toBe(true);
      expect(xpath('^c$', 'a\nb\nc', 'm')).toBe(true);
      expect(xpath('ABC', 'xabcx', 'i')).toBe(true);
      expect(xpath('a b\tc', 'abc', 'x')).toBe(true);
      expect(xpath('a[ ]b', 'a b', 'x')).toBe(true);
      expect(xpath('a.c(', 'xa.c(x', 'q')).toBe(true);
      expect(xpath('a.c', 'abc', 'q')).toBe(false);
      expect(xpath('A.C', 'a.c', 'qi')).toBe(true);
    });

    it('accepts what the JavaScript engine it replaces accepted', () => {
      expect(xpath('\\bfoo\\b', 'a foo b')).toBe(true);
      expect(xpath('foo(?!bar)', 'foobar')).toBe(false);
      expect(xpath('foo(?=bar)', 'foobar')).toBe(true);
      expect(xpath('a\\/b\\-c\\_d', 'a/b-c_d')).toBe(true);
      expect(xpath('\\x41\\u0042\\u{43}', 'ABC')).toBe(true);
      expect(xpath('a{', 'a{')).toBe(true);
      expect(xpath('(a)\\1', 'aa')).toBe(true);
      expect(xpath('(a)\\10', 'aa0')).toBe(true);
      expect(xpath(`${'(a)'.repeat(10)}\\10`, 'a'.repeat(11))).toBe(true);
      expect(xpath(`${'(a)'.repeat(10)}\\10`, `${'a'.repeat(10)}b`)).toBe(false);
    });
  });

  describe('rejected patterns', () => {
    it.each([
      ['(a', 'xpath', 'unterminated group'],
      ['a)', 'xpath', 'unmatched )'],
      ['*a', 'xpath', 'nothing to repeat'],
      ['a{3,2}', 'xpath', 'out of order'],
      ['[a', 'xpath', 'unterminated character class'],
      ['[a', 'ecma', 'unterminated character class'],
      ['[z-a]', 'xpath', 'invalid range'],
      ['[a-\\d]', 'xpath', 'invalid range'],
      ['[\\b]', 'xpath', 'invalid escape in a character class'],
      ['[a-z-[b]x]', 'xpath', 'expected ] after class subtraction'],
      ['\\q', 'xpath', 'invalid escape \\q'],
      ['\\i', 'ecma', 'invalid escape \\i'],
      ['\\', 'xpath', 'unexpected end of pattern'],
      ['\\p{IsNowhere}', 'xpath', 'unsupported block'],
      ['\\pL', 'xpath', 'invalid property escape'],
      ['\\p{Nonsense}', 'xpath', 'invalid character class'],
      ['\\xZZ', 'xpath', 'invalid hexadecimal escape'],
      ['\\u{110000}', 'xpath', 'invalid Unicode escape'],
      ['\\u{12', 'xpath', 'invalid Unicode escape'],
      ['\\2', 'xpath', 'no group 2'],
      ['\\k<x>', 'ecma', 'invalid named back-reference'],
      ['(?<1>a)', 'ecma', 'invalid group'],
      ['(?<=a)b', 'xpath', 'lookbehind is not supported'],
      ['(?<!a)b', 'ecma', 'lookbehind is not supported'],
      ['[z-a]', 'ecma', 'invalid character class'],
    ] as const)('%s (%s): %s', (pattern, dialect, reason) => {
      expect(rejection(pattern, dialect)).toContain(reason);
    });

    it('names an unsupported flag', () => {
      expect(rejection('a', 'xpath', 'g')).toBe("unsupported regular expression flag 'g'");
      expect(rejection('a', 'ecma', 's')).toBe("unsupported regular expression flag 's'");
    });

    it('caps the size of the program', () => {
      expect(rejection('(a{100}){100}', 'xpath')).toContain('pattern is too large');
      expect(rejection('a{1,20000}', 'xpath')).toContain('pattern is too large');
      expect(rejection('a{99999999}', 'xpath')).toContain('pattern is too large');
      expect(rejection('(a|b)'.repeat(2000), 'xpath')).toContain('pattern is too large');
      expect(rejection('a'.repeat(Regex.MAX_INSTRUCTIONS + 1), 'xpath', 'q')).toContain(
        'pattern is too large',
      );
      expect(rejection('a{1,2000}', 'xpath')).toBe('');
    });

    it('caps how deeply groups nest, instead of overflowing the stack', () => {
      expect(rejection(`${'('.repeat(5000)}a${')'.repeat(5000)}`, 'xpath')).toContain(
        'groups nest too deeply',
      );
      expect(rejection(`${'('.repeat(100)}a${')'.repeat(100)}`, 'xpath')).toBe('');
    });
  });

  describe('bounded running time', () => {
    // Each pattern backtracks exponentially (or worse than linearly) in a backtracking engine;
    // the input is long enough that one would not finish.
    it.each([
      ['^(a+)+$', `${'a'.repeat(50_000)}!`],
      ['^(a|a)*$', `${'a'.repeat(50_000)}!`],
      ['^(a|aa)+$', `${'a'.repeat(50_000)}!`],
      ['(.*)*x', 'a'.repeat(50_000)],
      ['^(\\w+\\s?)*$', `${'word '.repeat(10_000)}!`],
      ['a*a*a*a*a*b', 'a'.repeat(20_000)],
      ['(x+x+)+y', 'x'.repeat(20_000)],
    ])('%s is linear in the input', (pattern, input) => {
      const re = compiled(pattern, 'xpath');
      expect(re.linear).toBe(true);
      const elapsed = milliseconds(() => expect(Regex.search(re, input)).toBe(Regex.UNMATCHED));
      expect(elapsed).toBeLessThan(5000);
    });

    it('finds captures and replaces in linear time too', () => {
      const re = compiled('(a+)+b', 'xpath');
      const input = 'a'.repeat(20_000);
      const elapsed = milliseconds(() => {
        expect(Option.isNone(Regex.first(re, input))).toBe(true);
        expect(Regex.replaceAll(re, `${input}b`, () => 'x')).toEqual(Option.some('x'));
      });
      expect(elapsed).toBeLessThan(5000);
    });

    it('gives a pattern with back-references a step budget, and reports running out', () => {
      const re = compiled('^(a+)+\\1$', 'xpath');
      expect(re.linear).toBe(false);
      const hostile = `${'a'.repeat(40)}!`;
      const elapsed = milliseconds(() => {
        expect(Regex.search(re, hostile)).toBe(Regex.EXHAUSTED);
        expect(Regex.test(re, hostile)).toBe(false);
        expect(Option.isNone(Regex.first(re, hostile))).toBe(true);
        expect(Option.isNone(Regex.replaceAll(re, hostile, () => ''))).toBe(true);
      });
      expect(elapsed).toBeLessThan(5000);
      expect(Regex.search(re, 'aaaa')).toBe(Regex.MATCHED);
    });

    it('gives lookahead the same budget', () => {
      const re = compiled('^(?=(a+)+$)', 'xpath');
      expect(re.linear).toBe(false);
      expect(Regex.search(re, `${'a'.repeat(40)}!`)).toBe(Regex.EXHAUSTED);
      expect(Regex.search(re, 'aaa')).toBe(Regex.MATCHED);
    });

    it('ends a loop whose body matches nothing', () => {
      expect(Regex.search(compiled('(a*)*\\1b', 'xpath'), 'c')).toBe(Regex.UNMATCHED);
      expect(Regex.search(compiled('(?:(?=a))*\\bb', 'xpath'), 'b')).toBe(Regex.MATCHED);
      expect(Regex.search(compiled('(a*)*b', 'xpath'), 'c')).toBe(Regex.UNMATCHED);
    });
  });

  describe('matches, groups and replacement', () => {
    it('takes a literal pattern through String.includes', () => {
      const re = compiled('needle', 'xpath');
      expect(Option.isSome(re.literal)).toBe(true);
      expect(Regex.test(re, 'haystack with a needle in it')).toBe(true);
      expect(Regex.test(re, 'haystack')).toBe(false);
      expect(Option.isNone(compiled('needle', 'xpath', 'i').literal)).toBe(true);
    });

    it('reports groups that took no part as absent', () => {
      const re = compiled('(a)|(b)', 'xpath');
      expect(groupsOf(re, 'b')).toEqual(['b', undefined, 'b']);
      expect(groupsOf(re, 'c')).toBeNull();
    });

    it('keeps the captures of a positive lookahead and drops those of a negative one', () => {
      expect(groupsOf(compiled('(?=(a))a\\1', 'xpath'), 'aa')).toEqual(['aa', 'a']);
      expect(groupsOf(compiled('(?!(b))a', 'xpath'), 'a')).toEqual(['a', undefined]);
    });

    it('matches a back-reference to an unset group as empty, and ignores case under i', () => {
      expect(groupsOf(compiled('(?:(a)|b)\\1c', 'xpath'), 'bc')).toEqual(['bc', undefined]);
      expect(Regex.test(compiled('(a)\\1', 'xpath', 'i'), 'aA')).toBe(true);
      expect(Regex.test(compiled('(a)\\1', 'xpath'), 'aA')).toBe(false);
    });

    it('searches from an offset and stops an anchored search at the start', () => {
      const re = compiled('(?:^a|b\\b)(?=.)', 'xpath');
      const captures: Array<number> = [];
      expect(Regex.exec(re, 'ab c', 1, captures)).toBe(Regex.MATCHED);
      expect(captures.slice(0, 2)).toEqual([1, 2]);
      expect(Regex.search(compiled('^a\\b(?=.)', 'xpath'), 'ba c')).toBe(Regex.UNMATCHED);
    });

    it('expands replacement templates', () => {
      const re = compiled('(\\w)(\\w)', 'xpath');
      const input = 'ab cd';
      const replace = (template: string) =>
        Option.getOrUndefined(
          Regex.replaceAll(re, input, (captures) => Regex.expand(re, template, input, captures)),
        );
      expect(replace('$2$1')).toBe('ba dc');
      expect(replace('[$&]')).toBe('[ab] [cd]');
      expect(replace('$$1')).toBe('$1 $1');
      expect(replace('$3$10$0')).toBe('$3a0$0 $3c0$0');
      expect(replace('$20')).toBe('b0 d0');
    });

    it('advances past an empty match by one code point', () => {
      const re = compiled('x*', 'xpath');
      expect(Regex.replaceAll(re, 'a😀b', () => '-')).toEqual(Option.some('-a-😀-b-'));
    });

    it('remembers compiled patterns', () => {
      const once = Regex.compileCached('a+b', 'xpath', 'i');
      expect(Regex.compileCached('a+b', 'xpath', 'i')).toBe(once);
      expect(Regex.compileCached('a+b', 'xpath')).not.toBe(once);
      Arr.makeBy(1001, (n) => Regex.compileCached(`a{${n}}`, 'ecma'));
      expect(Regex.compileCached('a+b', 'xpath', 'i')).not.toBe(once);
    });
  });
});
