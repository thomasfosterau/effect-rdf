/**
 * The N-Triples grammar's terminals as `@thomasfosterau/effect-parse`
 * parsers over strings, for the grammars that include them: N-Quads,
 * Turtle and TriG (whose `Grammar` module re-exports these and adds its
 * own), and through Turtle N3, SPARQL and ShExC. Names follow the grammar:
 * `iriRef` is `IRIREF`, `blankNodeLabel` is `BLANK_NODE_LABEL`, and so on.
 *
 * The character classes are the token-set counterparts of the `Lexical`
 * predicates (`pnCharsBase` and `Lexical.isPnCharsBase` accept the same
 * code points). String-valued terminals return their *value*: escapes are
 * decoded and delimiters removed; IRIs are not resolved.
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

/**
 * `STRING_LITERAL_QUOTE`, returning the value.
 *
 * @since 0.1.0
 * @category terminals
 */
export const stringLiteralQuote: Parser.Parser<string> = Parser.delimited(
  Token.literal('"'),
  Parser.cut(Ascii.escaped(Token.takeTill(['\\', '"', '\n\r'], { min: 1 }), '\\', stringEscape)),
  Parser.cut(Token.literal('"')),
);

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
