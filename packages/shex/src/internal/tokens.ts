/**
 * The ShEx 2 terminals (shared with Turtle and SPARQL) as
 * `@thomasfosterau/effect-parse` parsers: IRIs, prefixed names, blank node
 * labels, language tags, string and numeric literals, and the whitespace
 * and comments between tokens. String-valued terminals return their
 * unescaped value.
 *
 * @internal
 */
import * as Ascii from '@thomasfosterau/effect-parse/Ascii';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Token from '@thomasfosterau/effect-parse/Token';

// -----------------------------------------------------------------------------
// Character classes
// -----------------------------------------------------------------------------

const digit = Token.range('0', '9');
const hexDigit = [digit, Token.range('a', 'f'), Token.range('A', 'F')];
const alpha = [Token.range('a', 'z'), Token.range('A', 'Z')];
const alphanumeric = [...alpha, digit];

/** `PN_CHARS_BASE` */
export const pnCharsBase: Token.StringTokenSet = [
  ...alpha,
  Token.range('À', 'Ö'),
  Token.range('Ø', 'ö'),
  Token.range('ø', '˿'),
  Token.range('Ͱ', 'ͽ'),
  Token.range('Ϳ', '῿'),
  Token.range('‌', '‍'),
  Token.range('⁰', '↏'),
  Token.range('Ⰰ', '⿯'),
  Token.range('、', '퟿'),
  Token.range('豈', '﷏'),
  Token.range('ﷰ', '�'),
  Token.range('\u{10000}', '\u{effff}'),
];

/** `PN_CHARS_U` */
export const pnCharsU: Token.StringTokenSet = [pnCharsBase, '_'];

/** `PN_CHARS` */
export const pnChars: Token.StringTokenSet = [
  pnCharsU,
  '-·',
  digit,
  Token.range('̀', 'ͯ'),
  Token.range('‿', '⁀'),
];

/** The characters of ECMAScript's `\s`. */
const whitespace: Token.StringTokenSet = [' \t\n\v\f\r      　﻿', Token.range(' ', ' ')];

/**
 * Runs of `chars` in which dots may appear, but not at the end (the
 * `([chars.]* [chars])?` tail of `PN_PREFIX`, `PN_LOCAL` and
 * `BLANK_NODE_LABEL`).
 */
const dottedTail = (chars: Parser.Parser<unknown>) =>
  Parser.repeat(
    Parser.alt(
      Parser.repeat(chars, { min: 1 }),
      Parser.seq(Token.takeWhile('.', { min: 1 }), Parser.peek(chars)),
    ),
  );

// -----------------------------------------------------------------------------
// Whitespace and comments
// -----------------------------------------------------------------------------

const blockComment = Parser.seq(
  Token.literal('/*'),
  Parser.repeat(
    Parser.alt(Token.takeTill('*', { min: 1 }), Parser.seq(Token.literal('*'), Token.noneOf('/'))),
  ),
  Token.literal('*/'),
);

/** Whitespace, `#` line comments and block comments (possibly none). */
export const skip: Parser.Parser<void> = Parser.asVoid(
  Parser.repeat(
    Parser.alt(
      Token.takeWhile(whitespace, { min: 1 }),
      Parser.preceded(Token.literal('#'), Token.takeTill('\n\r')),
      blockComment,
    ).pipe(Parser.expected('whitespace or a comment')),
  ),
);

/** A token preceded by optional whitespace and comments. */
export const lexeme = <A, E, R>(self: Parser.Parser<A, E, R>): Parser.Parser<A, E, R> =>
  Parser.preceded(skip, self);

/** A case-insensitive keyword: a whole word of ASCII letters. */
export const keyword = (word: string): Parser.Parser<string> =>
  Token.takeWhile(alpha, { min: 1 }).pipe(
    Parser.filter((w) => w.toUpperCase() === word),
    Parser.expected(word),
  );

// -----------------------------------------------------------------------------
// Escapes
// -----------------------------------------------------------------------------

const codePoint = (digits: number) =>
  Token.takeWhile(hexDigit, digits).pipe(
    Parser.expected(`${digits} hex digits`),
    Parser.map((hex) => parseInt(hex, 16)),
    Parser.filter((cp) => cp <= 0x10ffff),
    Parser.map((cp) => String.fromCodePoint(cp)),
  );

/** What follows the backslash of a `UCHAR`. */
const uchar = Parser.dispatch(Token.any, {
  u: Parser.cut(codePoint(4)),
  U: Parser.cut(codePoint(8)),
});

/** What follows the backslash of an `ECHAR` or a `UCHAR`. */
const stringEscape = Parser.dispatch(Token.any, {
  t: Parser.succeed('\t'),
  b: Parser.succeed('\b'),
  n: Parser.succeed('\n'),
  r: Parser.succeed('\r'),
  f: Parser.succeed('\f'),
  '"': Parser.succeed('"'),
  "'": Parser.succeed("'"),
  '\\': Parser.succeed('\\'),
  u: Parser.cut(codePoint(4)),
  U: Parser.cut(codePoint(8)),
}).pipe(Parser.expected('escape sequence'));

// -----------------------------------------------------------------------------
// Terminals
// -----------------------------------------------------------------------------

/** `IRIREF`, returning the IRI between the angle brackets, unescaped. */
export const iriRef: Parser.Parser<string> = Parser.delimited(
  Token.literal('<'),
  Ascii.escaped(
    Token.takeTill([Token.range('\u0000', ' '), '<>"{}|^`\\'], { min: 1 }),
    '\\',
    uchar,
  ),
  Token.literal('>'),
);

const pnPrefix = Parser.taken(
  Parser.seq(Token.oneOf(pnCharsBase), dottedTail(Token.oneOf(pnChars))),
);

const plx = Parser.alt(
  Parser.seq(Token.literal('%'), Token.takeWhile(hexDigit, 2)),
  Parser.seq(Token.literal('\\'), Token.oneOf("_~.-!$&'()*+,;=/?#@%")),
);

const pnLocal = Parser.taken(
  Parser.seq(
    Parser.alt(Token.oneOf([pnCharsU, ':', digit]), plx),
    dottedTail(Parser.alt(Token.oneOf([pnChars, ':']), plx)),
  ),
).pipe(Parser.map((s) => (s.indexOf('\\') === -1 ? s : s.replace(/\\(.)/gu, '$1'))));

/** A prefixed name. */
export interface PrefixedName {
  readonly prefix: string;
  /** The local part, with reserved character escapes removed. */
  readonly local: string;
}

/** `PNAME_LN` or `PNAME_NS` (with an empty local part). */
export const prefixedName: Parser.Parser<PrefixedName> = Parser.seq(
  Parser.opt(pnPrefix),
  Token.literal(':'),
  Parser.opt(pnLocal),
).pipe(
  Parser.map(([prefix, , local]) => ({
    prefix: prefix._tag === 'Some' ? prefix.value : '',
    local: local._tag === 'Some' ? local.value : '',
  })),
);

/** `BLANK_NODE_LABEL`, returning the label after `_:`. */
export const blankNodeLabel: Parser.Parser<string> = Parser.preceded(
  Token.literal('_:'),
  Parser.taken(Parser.seq(Token.oneOf([pnCharsU, digit]), dottedTail(Token.oneOf(pnChars)))),
);

/** `LANGTAG`, returning the tag after `@`. */
export const langTag: Parser.Parser<string> = Parser.preceded(
  Token.literal('@'),
  Parser.taken(
    Parser.seq(
      Token.takeWhile(alpha, { min: 1 }),
      Parser.repeat(Parser.preceded(Token.literal('-'), Token.takeWhile(alphanumeric, { min: 1 }))),
    ),
  ),
);

const shortString = (q: '"' | "'") =>
  Parser.delimited(
    Token.literal(q),
    Parser.cut(Ascii.escaped(Token.takeTill(['\\', q, '\n\r'], { min: 1 }), '\\', stringEscape)),
    Parser.cut(Token.literal(q)),
  );

const longString = (q: '"' | "'") =>
  Parser.delimited(
    Token.literal(q.repeat(3)),
    Parser.cut(
      Ascii.escaped(
        Parser.alt(
          Token.takeTill(['\\', q], { min: 1 }),
          Parser.terminated(Token.literal(q), Parser.not(Token.literal(q + q))),
        ),
        '\\',
        stringEscape,
      ),
    ),
    Parser.cut(Token.literal(q.repeat(3))),
  );

/**
 * `STRING_LITERAL_LONG1`, `STRING_LITERAL_LONG2`, `STRING_LITERAL1` or
 * `STRING_LITERAL2`, returning the unescaped value.
 */
export const stringLiteral: Parser.Parser<string> = Parser.alt(
  longString('"'),
  longString("'"),
  shortString('"'),
  shortString("'"),
).pipe(Parser.expected('string literal'));

/** The XSD datatype of a numeric literal (`integer`, `decimal` or `double`). */
export type NumericType = 'integer' | 'decimal' | 'double';

const sign = Parser.opt(Token.oneOf('+-'));
const exponent = Parser.seq(Token.oneOf('eE'), sign, Ascii.digit1);

/** `DOUBLE`, `DECIMAL` or `INTEGER`, returning the lexical form and type. */
export const numericLiteral: Parser.Parser<readonly [string, NumericType]> = Parser.alt(
  Parser.taken(
    Parser.seq(
      sign,
      Parser.alt(
        Parser.seq(Ascii.digit1, Token.literal('.'), Ascii.digit0, exponent),
        Parser.seq(Parser.opt(Token.literal('.')), Ascii.digit1, exponent),
      ),
    ),
  ).pipe(Parser.map((v) => [v, 'double'] as const)),
  Parser.taken(Parser.seq(sign, Ascii.digit0, Token.literal('.'), Ascii.digit1)).pipe(
    Parser.map((v) => [v, 'decimal'] as const),
  ),
  Parser.taken(Parser.seq(sign, Ascii.digit1)).pipe(Parser.map((v) => [v, 'integer'] as const)),
);

/** `true` or `false`, not followed by a word character. */
export const booleanLiteral: Parser.Parser<'true' | 'false'> = Parser.terminated(
  Parser.alt(Token.literal('true'), Token.literal('false')),
  Parser.not(Token.oneOf([...alphanumeric, '_'])),
);
