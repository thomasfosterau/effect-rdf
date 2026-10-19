/**
 * Grammars of the SPARQL results text formats, written with
 * `@thomasfosterau/effect-parse`: RDF terms in the Turtle / SPARQL syntax
 * used by TSV results, and the rows of CSV results (RFC 4180).
 *
 * @internal
 */
import * as Ascii from '@thomasfosterau/effect-parse/Ascii';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Token from '@thomasfosterau/effect-parse/Token';
import * as Term from '@thomasfosterau/effect-rdf/Term';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const xsdInteger = Term.namedNode(`${XSD}integer`);
const xsdDecimal = Term.namedNode(`${XSD}decimal`);
const xsdDouble = Term.namedNode(`${XSD}double`);
const xsdBoolean = Term.namedNode(`${XSD}boolean`);

// -----------------------------------------------------------------------------
// Terms
// -----------------------------------------------------------------------------

/** The characters of ECMAScript's `\s`. */
const whitespace: Token.StringTokenSet = [' \t\n\v\f\r      　﻿', Token.range(' ', ' ')];

const ws = Token.takeWhile(whitespace);

const hexDigit = [Token.range('0', '9'), Token.range('a', 'f'), Token.range('A', 'F')];

const codePoint = (digits: number) =>
  Token.takeWhile(hexDigit, digits).pipe(
    Parser.expected(`${digits} hex digits`),
    Parser.map((hex) => parseInt(hex, 16)),
    Parser.filter((cp) => cp <= 0x10ffff),
    Parser.map((cp) => String.fromCodePoint(cp)),
  );

/**
 * What follows a backslash: `UCHAR` (which must be a valid code point),
 * `ECHAR`, and (leniently) any other character standing for itself.
 */
const escape = Parser.alt(
  Parser.dispatch(Token.any, {
    t: Parser.succeed('\t'),
    n: Parser.succeed('\n'),
    r: Parser.succeed('\r'),
    b: Parser.succeed('\b'),
    f: Parser.succeed('\f'),
    u: Parser.cut(codePoint(4)),
    U: Parser.cut(codePoint(8)),
  }),
  Token.any,
);

const iri = Parser.delimited(
  Token.literal('<'),
  Parser.cut(Ascii.escaped(Token.takeTill('\\>', { min: 1 }), '\\', escape)),
  Parser.cut(Token.literal('>')),
).pipe(Parser.map((value) => Term.namedNode(value)));

const blankNode = Parser.preceded(
  Token.literal('_:'),
  Parser.cut(Token.takeTill([whitespace, ')'], { min: 1 })),
).pipe(Parser.map((label) => Term.blankNode(label)));

const quoted = (q: '"' | "'") => {
  const long = q.repeat(3);
  return Parser.alt(
    Parser.delimited(
      Token.literal(long),
      Parser.cut(
        Ascii.escaped(
          Parser.alt(
            Token.takeTill(['\\', q], { min: 1 }),
            Parser.terminated(Token.literal(q), Parser.not(Token.literal(q + q))),
          ),
          '\\',
          escape,
        ),
      ),
      Parser.cut(Token.literal(long)),
    ),
    Parser.delimited(
      Token.literal(q),
      Parser.cut(Ascii.escaped(Token.takeTill(['\\', q], { min: 1 }), '\\', escape)),
      Parser.cut(Token.literal(q)),
    ),
  );
};

const alpha = [Token.range('a', 'z'), Token.range('A', 'Z')];
const alphanumeric = [...alpha, Token.range('0', '9')];

const langTag = Parser.preceded(
  Token.literal('@'),
  Parser.seq(
    Parser.taken(
      Parser.seq(
        Token.takeWhile(alpha, { min: 1 }),
        Parser.repeat(
          Parser.preceded(Token.literal('-'), Token.takeWhile(alphanumeric, { min: 1 })),
        ),
      ),
    ),
    Parser.opt(
      Parser.preceded(Token.literal('--'), Parser.alt(Token.literal('ltr'), Token.literal('rtl'))),
    ),
  ),
);

const datatype = Parser.preceded(Token.literal('^^'), Parser.preceded(ws, Parser.cut(iri)));

const literal = Parser.seq(
  Parser.alt(quoted('"'), quoted("'")),
  Parser.opt(Parser.alt(langTag, datatype)),
).pipe(
  Parser.map(([lex, suffix]): Term.Literal => {
    if (suffix._tag === 'None') return Term.literal(lex);
    const s = suffix.value;
    if (Array.isArray(s)) {
      const [language, direction] = s;
      return direction._tag === 'Some'
        ? Term.literal(lex, { language, direction: direction.value })
        : Term.literal(lex, language);
    }
    return Term.literal(lex, s as Term.NamedNode);
  }),
);

const sign = Parser.opt(Token.oneOf('+-'));
const exponent = Parser.seq(Token.oneOf('eE'), sign, Ascii.digit1);

const number = Parser.taken(
  Parser.seq(
    sign,
    Parser.alt(
      Parser.seq(Ascii.digit1, Parser.opt(Token.literal('.')), Ascii.digit0, exponent),
      Parser.seq(Token.literal('.'), Ascii.digit1, exponent),
      Parser.seq(Ascii.digit0, Token.literal('.'), Ascii.digit1),
      Ascii.digit1,
    ),
  ),
).pipe(
  Parser.map((v) =>
    Term.literal(v, /[eE]/.test(v) ? xsdDouble : v.includes('.') ? xsdDecimal : xsdInteger),
  ),
);

const boolean = Parser.terminated(
  Parser.alt(Token.literal('true'), Token.literal('false')),
  Parser.not(Token.oneOf([...alphanumeric, '_'])),
).pipe(Parser.map((v) => Term.literal(v, xsdBoolean)));

const tripleTerm: Parser.Parser<Term.Triple> = Parser.preceded(
  Token.literal('<<('),
  Parser.cut(
    Parser.terminated(
      Parser.seq(
        Parser.suspend(() => term),
        Parser.suspend(() => term),
        Parser.suspend(() => term),
      ),
      Parser.preceded(ws, Token.literal(')>>')),
    ),
  ),
).pipe(
  Parser.map(([s, p, o]) => Term.triple(s as Term.Subject, p as Term.Predicate, o as Term.Object)),
);

const term: Parser.Parser<Term.GroundTerm> = Parser.preceded(
  ws,
  Parser.alt(tripleTerm, iri, blankNode, literal, number, boolean).pipe(
    Parser.expected('RDF term'),
  ),
);

/**
 * A complete term, with optional surrounding whitespace: IRIs in `<>`,
 * blank nodes, quoted literals, numbers, booleans and triple terms.
 */
export const groundTerm: Parser.Parser<Term.GroundTerm> = Parser.compile(
  Parser.terminated(term, ws),
);

// -----------------------------------------------------------------------------
// CSV
// -----------------------------------------------------------------------------

/** A CSV field, and whether it was quoted. */
export interface CsvField {
  readonly value: string;
  readonly quoted: boolean;
}

const quotedField = Parser.delimited(
  Token.literal('"'),
  Parser.cut(
    Parser.repeat(Parser.alt(Token.takeTill('"', { min: 1 }), Parser.as(Token.literal('""'), '"'))),
  ),
  Parser.cut(Token.literal('"')),
).pipe(Parser.map((parts): CsvField => ({ value: parts.join(''), quoted: true })));

const plainField = Token.takeTill(',\r\n').pipe(
  Parser.map((value): CsvField => ({ value, quoted: false })),
);

const csvRow = Parser.separated(Parser.alt(quotedField, plainField), Token.literal(','));

const csvLineEnding = Parser.alt(Token.literal('\r\n'), Token.literal('\r'), Token.literal('\n'));

/**
 * The rows of a CSV document. Lines end with CRLF, CR or LF, and the line
 * ending of the last row is optional.
 */
export const csvRows: Parser.Parser<Array<Array<CsvField>>> = Parser.compile(
  Parser.repeat(
    Parser.preceded(
      Parser.not(Parser.eof),
      Parser.terminated(csvRow, Parser.alt(csvLineEnding, Parser.eof)),
    ),
  ),
);
