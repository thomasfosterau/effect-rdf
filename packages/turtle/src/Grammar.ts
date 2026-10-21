/**
 * The Turtle grammar's terminals as `@thomasfosterau/effect-parse` parsers
 * over strings, for the grammars that include them: TriG, SPARQL, N3, ShExC
 * and the SPARQL results TSV format all reuse Turtle's terminals, each with
 * a few additions of its own. Names follow the grammar: `iriRef` is
 * `IRIREF`, `pnLocal` is `PN_LOCAL`, and so on.
 *
 * String-valued terminals return their *value*: escapes are decoded and
 * delimiters removed. The parsers neither skip whitespace nor resolve IRIs;
 * a grammar adds its own whitespace (`skip` here, for Turtle) and resolves
 * prefixed names and relative IRIs, typically after parsing so that the
 * grammar itself can be compiled with `Parser.compile`.
 *
 * @since 0.1.0
 */
import * as Ascii from '@thomasfosterau/effect-parse/Ascii';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Token from '@thomasfosterau/effect-parse/Token';
import {
  alphanumeric,
  digit,
  dottedTail,
  hex,
  pnChars,
  pnCharsBase,
  pnCharsU,
  stringEscape,
  stringLiteralQuote,
} from '@thomasfosterau/effect-ntriples/Grammar';

/**
 * The N-Triples terminals and character classes (`iriRef`,
 * `blankNodeLabel`, `langTag`, `langDir`, `stringLiteralQuote`, `uchar`,
 * `echar`, `pnChars`, …), which Turtle includes.
 *
 * @since 0.1.0
 * @category terminals
 */
export * from '@thomasfosterau/effect-ntriples/Grammar';

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
// IRIs and names
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Literals
// -----------------------------------------------------------------------------

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
