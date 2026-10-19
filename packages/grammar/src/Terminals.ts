/**
 * The terminals shared by the RDF syntaxes of the Turtle family, as
 * `@thomasfosterau/effect-parse` parsers over strings. Turtle and TriG
 * define them; SPARQL, N3, ShExC and the SPARQL results TSV format reuse
 * them (each with a few additions of its own). Names follow the grammars:
 * `iriRef` is `IRIREF`, `pnLocal` is `PN_LOCAL`, and so on.
 *
 * String-valued terminals return their *value*: escapes are decoded and
 * delimiters removed. The parsers neither skip whitespace nor resolve IRIs;
 * a grammar adds its own whitespace (`skip` here, for Turtle) and resolves
 * prefixed names and relative IRIs, typically after parsing.
 *
 * @since 0.1.0
 */
import * as Ascii from '@thomasfosterau/effect-parse/Ascii';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Token from '@thomasfosterau/effect-parse/Token';

// -----------------------------------------------------------------------------
// Character classes
// -----------------------------------------------------------------------------

/**
 * `[0-9]`
 *
 * @since 0.1.0
 * @category character classes
 */
export const digit: Token.StringTokenSet = Token.range('0', '9');

/**
 * `HEX`: `[0-9A-Fa-f]`
 *
 * @since 0.1.0
 * @category character classes
 */
export const hex: Token.StringTokenSet = [digit, Token.range('a', 'f'), Token.range('A', 'F')];

/**
 * `[A-Za-z]`
 *
 * @since 0.1.0
 * @category character classes
 */
export const alpha: Token.StringTokenSet = [Token.range('a', 'z'), Token.range('A', 'Z')];

/**
 * `[A-Za-z0-9]`
 *
 * @since 0.1.0
 * @category character classes
 */
export const alphanumeric: Token.StringTokenSet = [alpha, digit];

/**
 * `PN_CHARS_BASE`
 *
 * @since 0.1.0
 * @category character classes
 */
export const pnCharsBase: Token.StringTokenSet = [
  alpha,
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

/**
 * `PN_CHARS_U`: `PN_CHARS_BASE | '_'`
 *
 * @since 0.1.0
 * @category character classes
 */
export const pnCharsU: Token.StringTokenSet = [pnCharsBase, '_'];

/**
 * `PN_CHARS`
 *
 * @since 0.1.0
 * @category character classes
 */
export const pnChars: Token.StringTokenSet = [
  pnCharsU,
  '-·',
  digit,
  Token.range('̀', 'ͯ'),
  Token.range('‿', '⁀'),
];

/**
 * The characters `IRIREF` excludes (besides `\`, which starts a `UCHAR`):
 * `[#x00-#x20<>"{}|^`]`.
 *
 * @since 0.1.0
 * @category character classes
 */
export const iriExcluded: Token.StringTokenSet = [Token.range('\u0000', ' '), '<>"{}|^`'];

/**
 * Runs of `chars` in which dots may appear, but not at the end: the
 * `((chars | '.')* chars)?` tail of `PN_PREFIX`, `PN_LOCAL` and
 * `BLANK_NODE_LABEL`.
 *
 * @since 0.1.0
 * @category combinators
 */
export const dottedTail = <E, R>(chars: Parser.Parser<unknown, E, R>): Parser.Parser<void, E, R> =>
  Parser.asVoid(
    Parser.repeat(
      Parser.alt(
        Parser.repeat(chars, { min: 1 }),
        Parser.seq(Token.takeWhile('.', { min: 1 }), Parser.peek(chars)),
      ),
    ),
  );

// -----------------------------------------------------------------------------
// Whitespace and comments
// -----------------------------------------------------------------------------

/**
 * `WS`: one space, tab, carriage return or line feed.
 *
 * @since 0.1.0
 * @category whitespace
 */
export const ws: Parser.Parser<string> = Token.oneOf(' \t\r\n');

/**
 * A comment: `#` up to the end of the line (not included).
 *
 * @since 0.1.0
 * @category whitespace
 */
export const comment: Parser.Parser<string> = Parser.preceded(
  Token.literal('#'),
  Token.takeTill('\n\r'),
);

/**
 * Whitespace and comments between Turtle tokens (possibly none).
 *
 * @since 0.1.0
 * @category whitespace
 */
export const skip: Parser.Parser<void> = Parser.asVoid(
  Parser.repeat(
    Parser.alt(Token.takeWhile(' \t\r\n', { min: 1 }), comment).pipe(
      Parser.expected('whitespace or a comment'),
    ),
  ),
);

// -----------------------------------------------------------------------------
// Escapes
// -----------------------------------------------------------------------------

const codePoint = (digits: number): Parser.Parser<string> =>
  Token.takeWhile(hex, digits).pipe(
    Parser.expected(`${digits} hex digits`),
    Parser.map((h) => parseInt(h, 16)),
    Parser.filter((cp) => cp <= 0x10ffff),
    Parser.map((cp) => String.fromCodePoint(cp)),
  );

/**
 * What follows the backslash of a `UCHAR` (`uXXXX` or `UXXXXXXXX`),
 * returning the character. For use as the escape of `Ascii.escaped`.
 *
 * @since 0.1.0
 * @category escapes
 */
export const ucharEscape: Parser.Parser<string> = Parser.dispatch(Token.any, {
  u: Parser.cut(codePoint(4)),
  U: Parser.cut(codePoint(8)),
}).pipe(Parser.expected('a unicode escape'));

/**
 * What follows the backslash of an `ECHAR` or a `UCHAR`, returning the
 * character. For use as the escape of `Ascii.escaped`.
 *
 * @since 0.1.0
 * @category escapes
 */
export const stringEscape: Parser.Parser<string> = Parser.dispatch(Token.any, {
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
}).pipe(Parser.expected('an escape sequence'));

/**
 * `UCHAR`: `\uXXXX` or `\UXXXXXXXX`, returning the character.
 *
 * @since 0.1.0
 * @category escapes
 */
export const uchar: Parser.Parser<string> = Parser.preceded(Token.literal('\\'), ucharEscape);

/**
 * `ECHAR`: `\` followed by one of `tbnrf"'\`, returning the character.
 *
 * @since 0.1.0
 * @category escapes
 */
export const echar: Parser.Parser<string> = Parser.preceded(
  Token.literal('\\'),
  Parser.dispatch(Token.any, {
    t: Parser.succeed('\t'),
    b: Parser.succeed('\b'),
    n: Parser.succeed('\n'),
    r: Parser.succeed('\r'),
    f: Parser.succeed('\f'),
    '"': Parser.succeed('"'),
    "'": Parser.succeed("'"),
    '\\': Parser.succeed('\\'),
  }),
);

// -----------------------------------------------------------------------------
// IRIs and names
// -----------------------------------------------------------------------------

/**
 * `IRIREF`, returning the IRI between the angle brackets with its `UCHAR`s
 * decoded (not resolved against a base).
 *
 * @since 0.1.0
 * @category terminals
 */
export const iriRef: Parser.Parser<string> = Parser.delimited(
  Token.literal('<'),
  Ascii.escaped(Token.takeTill([iriExcluded, '\\'], { min: 1 }), '\\', ucharEscape),
  Token.literal('>'),
);

/**
 * `PN_PREFIX`
 *
 * @since 0.1.0
 * @category terminals
 */
export const pnPrefix: Parser.Parser<string> = Parser.taken(
  Parser.seq(Token.oneOf(pnCharsBase), dottedTail(Token.oneOf(pnChars))),
);

/**
 * `PLX`: a `PERCENT` (`%` and two hex digits) or a `PN_LOCAL_ESC` (`\` and
 * a reserved character).
 *
 * @since 0.1.0
 * @category terminals
 */
export const plx: Parser.Parser<unknown> = Parser.alt(
  Parser.seq(Token.literal('%'), Token.takeWhile(hex, 2)),
  Parser.seq(Token.literal('\\'), Token.oneOf("_~.-!$&'()*+,;=/?#@%")),
);

/**
 * `PN_LOCAL`, with its `PN_LOCAL_ESC`s decoded (percent-encoding is kept, as
 * it is part of the IRI).
 *
 * @since 0.1.0
 * @category terminals
 */
export const pnLocal: Parser.Parser<string> = Parser.taken(
  Parser.seq(
    Parser.alt(Token.oneOf([pnCharsU, ':', digit]), plx),
    dottedTail(Parser.alt(Token.oneOf([pnChars, ':']), plx)),
  ),
).pipe(Parser.map((s) => (s.indexOf('\\') === -1 ? s : s.replace(/\\(.)/gu, '$1'))));

/**
 * A prefixed name, unexpanded.
 *
 * @since 0.1.0
 * @category models
 */
export interface PrefixedName {
  readonly prefix: string;
  /** The local part (empty for a `PNAME_NS`), with reserved character escapes removed. */
  readonly local: string;
}

/**
 * `PNAME_LN` or `PNAME_NS` (with an empty local part).
 *
 * @since 0.1.0
 * @category terminals
 */
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

/**
 * `BLANK_NODE_LABEL`, returning the label after `_:`.
 *
 * @since 0.1.0
 * @category terminals
 */
export const blankNodeLabel: Parser.Parser<string> = Parser.preceded(
  Token.literal('_:'),
  Parser.taken(Parser.seq(Token.oneOf([pnCharsU, digit]), dottedTail(Token.oneOf(pnChars)))),
);

// -----------------------------------------------------------------------------
// Literals
// -----------------------------------------------------------------------------

const languageTag = Parser.taken(
  Parser.seq(
    Token.takeWhile(alpha, { min: 1 }),
    Parser.repeat(Parser.preceded(Token.literal('-'), Token.takeWhile(alphanumeric, { min: 1 }))),
  ),
);

/**
 * `LANGTAG` (RDF 1.1), returning the tag after `@`.
 *
 * @since 0.1.0
 * @category terminals
 */
export const langTag: Parser.Parser<string> = Parser.preceded(Token.literal('@'), languageTag);

/**
 * A language tag with its base direction.
 *
 * @since 0.1.0
 * @category models
 */
export interface LangDir {
  readonly language: string;
  readonly direction: 'ltr' | 'rtl' | undefined;
}

/**
 * `LANG_DIR` (RDF 1.2): a language tag optionally followed by `--ltr` or
 * `--rtl`.
 *
 * @since 0.1.0
 * @category terminals
 */
export const langDir: Parser.Parser<LangDir> = Parser.seq(
  langTag,
  Parser.opt(
    Parser.preceded(Token.literal('--'), Parser.alt(Token.literal('ltr'), Token.literal('rtl'))),
  ),
).pipe(
  Parser.map(([language, direction]) => ({
    language,
    direction: direction._tag === 'Some' ? direction.value : undefined,
  })),
);

const shortString = (q: '"' | "'"): Parser.Parser<string> =>
  Parser.delimited(
    Token.literal(q),
    Parser.cut(Ascii.escaped(Token.takeTill(['\\', q, '\n\r'], { min: 1 }), '\\', stringEscape)),
    Parser.cut(Token.literal(q)),
  );

const longString = (q: '"' | "'"): Parser.Parser<string> =>
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
 * `STRING_LITERAL_QUOTE` (`STRING_LITERAL2` in SPARQL), returning the value.
 *
 * @since 0.1.0
 * @category terminals
 */
export const stringLiteralQuote: Parser.Parser<string> = shortString('"');

/**
 * `STRING_LITERAL_SINGLE_QUOTE` (`STRING_LITERAL1`), returning the value.
 *
 * @since 0.1.0
 * @category terminals
 */
export const stringLiteralSingleQuote: Parser.Parser<string> = shortString("'");

/**
 * `STRING_LITERAL_LONG_QUOTE` (`STRING_LITERAL_LONG2`), returning the value.
 *
 * @since 0.1.0
 * @category terminals
 */
export const stringLiteralLongQuote: Parser.Parser<string> = longString('"');

/**
 * `STRING_LITERAL_LONG_SINGLE_QUOTE` (`STRING_LITERAL_LONG1`), returning the
 * value.
 *
 * @since 0.1.0
 * @category terminals
 */
export const stringLiteralLongSingleQuote: Parser.Parser<string> = longString("'");

/**
 * Any of the four string literals (Turtle's `String`), returning the value.
 *
 * @since 0.1.0
 * @category terminals
 */
export const stringLiteral: Parser.Parser<string> = Parser.alt(
  stringLiteralLongQuote,
  stringLiteralLongSingleQuote,
  stringLiteralQuote,
  stringLiteralSingleQuote,
).pipe(Parser.expected('a string literal'));

/**
 * The XSD datatype of a numeric literal.
 *
 * @since 0.1.0
 * @category models
 */
export type NumericType = 'integer' | 'decimal' | 'double';

const sign = Parser.opt(Token.oneOf('+-'));

/**
 * `EXPONENT`
 *
 * @since 0.1.0
 * @category terminals
 */
export const exponent: Parser.Parser<string> = Parser.taken(
  Parser.seq(Token.oneOf('eE'), sign, Ascii.digit1),
);

/**
 * `DOUBLE`, returning the lexical form.
 *
 * @since 0.1.0
 * @category terminals
 */
export const double: Parser.Parser<string> = Parser.taken(
  Parser.seq(
    sign,
    Parser.alt(
      Parser.seq(Ascii.digit1, Token.literal('.'), Ascii.digit0, exponent),
      Parser.seq(Parser.opt(Token.literal('.')), Ascii.digit1, exponent),
    ),
  ),
);

/**
 * `DECIMAL`, returning the lexical form.
 *
 * @since 0.1.0
 * @category terminals
 */
export const decimal: Parser.Parser<string> = Parser.taken(
  Parser.seq(sign, Ascii.digit0, Token.literal('.'), Ascii.digit1),
);

/**
 * `INTEGER`, returning the lexical form.
 *
 * @since 0.1.0
 * @category terminals
 */
export const integer: Parser.Parser<string> = Parser.taken(Parser.seq(sign, Ascii.digit1));

/**
 * `DOUBLE`, `DECIMAL` or `INTEGER` (the longest that matches), returning the
 * lexical form and the datatype.
 *
 * @since 0.1.0
 * @category terminals
 */
export const numericLiteral: Parser.Parser<readonly [string, NumericType]> = Parser.alt(
  double.pipe(Parser.map((v) => [v, 'double'] as const)),
  decimal.pipe(Parser.map((v) => [v, 'decimal'] as const)),
  integer.pipe(Parser.map((v) => [v, 'integer'] as const)),
);

/**
 * `true` or `false`, not followed by a letter, digit or `_`.
 *
 * @since 0.1.0
 * @category terminals
 */
export const booleanLiteral: Parser.Parser<'true' | 'false'> = Parser.terminated(
  Parser.alt(Token.literal('true'), Token.literal('false')),
  Parser.not(Token.oneOf([alphanumeric, '_'])),
);
