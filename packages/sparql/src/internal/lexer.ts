/**
 * The SPARQL lexer, written with `@thomasfosterau/effect-parse`: a compiled
 * grammar turning a query or update into tokens, built on the Turtle
 * grammar's terminals (`effect-turtle`'s `Grammar`), which SPARQL shares,
 * plus SPARQL's own (variables, keywords, punctuation). A pass then resolves
 * IRIs in document order, as `BASE` and `PREFIX` declarations are met, so
 * that the parser works on resolved tokens and needs no per-query state for
 * names.
 *
 * Where no token can be read, the tokens end with an `ERROR` token, which the
 * parser reports if it gets that far (as a lazy lexer would).
 *
 * @internal
 */
import * as Compiler from '@thomasfosterau/effect-parse/Compiler';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Token from '@thomasfosterau/effect-parse/Token';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as TurtleGrammar from '@thomasfosterau/effect-turtle/Grammar';
import * as Result from 'effect/Result';

/** The kinds of SPARQL tokens. */
export type TokenType =
  | 'IRI'
  | 'PNAME'
  | 'BNODE'
  | 'VAR'
  | 'STRING'
  | 'LANGTAG'
  | 'INTEGER'
  | 'DECIMAL'
  | 'DOUBLE'
  | 'WORD'
  | 'PUNCT'
  | 'ERROR';

/** A SPARQL token. Every token has every field, so that all have the same shape. */
export interface Tok {
  readonly type: TokenType;
  /**
   * The decoded value: the IRI (resolved by `resolve`), the local name, the
   * label, the variable name, the string value, the word, the punctuation,
   * the number's lexical form; for ERROR, why no token could be read.
   */
  value: string;
  /** PNAME: the prefix; STRING: `long` for a long string. */
  readonly extra: string;
  /**
   * What the parser dispatches on: the punctuation, the upper-cased word
   * (`a` stays `a`), else the type.
   */
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  /** PNAME: why the name could not be expanded (an undefined prefix). */
  error: string | undefined;
}

interface Partial {
  readonly type: TokenType;
  readonly value: string;
  readonly extra?: string;
  /** ERROR: where the error is, if not at the start of the token. */
  readonly at?: number;
}

const make = (t: Partial, start: number, end: number): Tok => ({
  type: t.type,
  value: t.value,
  extra: t.extra ?? '',
  kind:
    t.type === 'PUNCT'
      ? t.value
      : t.type === 'WORD'
        ? t.value === 'a'
          ? 'a'
          : t.value.toUpperCase()
        : t.type,
  start: t.at ?? start,
  end,
  error: undefined,
});

/** A token that ends the stream, with the reason. */
const errorToken = (value: string, at?: number): Partial =>
  at === undefined ? { type: 'ERROR', value } : { type: 'ERROR', value, at };

// -----------------------------------------------------------------------------
// Terminals
// -----------------------------------------------------------------------------

const hex4 = Token.takeWhile(TurtleGrammar.hex, 4);
const hex8 = Token.takeWhile(TurtleGrammar.hex, 8);

/** Decodes a `UCHAR`, rejecting surrogates and code points beyond U+10FFFF. */
const decodeUchar = (hex: string): string | undefined => {
  const code = parseInt(hex, 16);
  return (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff
    ? undefined
    : String.fromCodePoint(code);
};

// eslint-disable-next-line no-control-regex
const forbiddenInIri = /[<>"{}|^`\\\u0000- ]/;

/** `IRIREF`, decoding its `UCHAR`s (an escape may not produce a disallowed character). */
const iri: Parser.Parser<Partial> = Parser.delimited(
  Token.literal('<'),
  Parser.taken(
    Parser.repeat(
      Parser.alt(
        Token.takeTill([TurtleGrammar.iriExcluded, '\\'], { min: 1 }),
        Parser.seq(Token.literal('\\u'), hex4),
        Parser.seq(Token.literal('\\U'), hex8),
      ),
    ),
  ),
  Token.literal('>'),
).pipe(
  Parser.map((raw): Partial => {
    if (raw.indexOf('\\') === -1) return { type: 'IRI', value: raw };
    let bad: string | undefined;
    const value = raw.replace(/\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})/g, (_, a, b) => {
      const hex = a ?? b;
      const c = decodeUchar(hex);
      if (c === undefined) bad ??= `Invalid code point escape \\u${hex}`;
      return c ?? '';
    });
    if (bad !== undefined) return errorToken(bad);
    return forbiddenInIri.test(value)
      ? errorToken('Invalid character in IRI')
      : { type: 'IRI', value };
  }),
);

const varChars: Token.StringTokenSet = [
  TurtleGrammar.pnCharsU,
  TurtleGrammar.digit,
  '·',
  Token.range('̀', 'ͯ'),
  Token.range('‿', '⁀'),
];

/** `VAR1` / `VAR2` */
const variable: Parser.Parser<Partial> = Parser.preceded(
  Token.oneOf('?$'),
  Parser.taken(
    Parser.seq(
      Token.oneOf([TurtleGrammar.pnCharsU, TurtleGrammar.digit]),
      Token.takeWhile(varChars),
    ),
  ),
).pipe(Parser.map((value): Partial => ({ type: 'VAR', value })));

/** Escape letters (the `t` of `\t`, …) and the characters they denote. */
interface EscapeTable {
  readonly [letter: string]: string;
}

const ECHAR: EscapeTable = {
  t: '\t',
  b: '\b',
  n: '\n',
  r: '\r',
  f: '\f',
  '"': '"',
  "'": "'",
  '\\': '\\',
};

const HEX = /^[0-9A-Fa-f]+$/;

/**
 * A string literal. Long strings may end with up to two quotes before the
 * closing delimiter (`"""a""""` is `a"`). Written as plain code: it is a
 * leaf, and its error reporting follows the reference lexer.
 */
const string: Parser.Parser<Partial> = Parser.make<Partial>((state) => {
  const input = state.input as string;
  const start = state.pos;
  const quote = input[start]!;
  const long = input.startsWith(quote.repeat(3), start);
  let i = start + (long ? 3 : 1);
  let out = '';
  const error = (message: string, at?: number): Partial => {
    state.pos = input.length;
    return errorToken(message, at);
  };
  for (;;) {
    if (i >= input.length) return error('Unterminated string literal');
    const c = input[i]!;
    if (c === '\\') {
      const e = input[i + 1];
      if (e === 'u' || e === 'U') {
        const len = e === 'u' ? 4 : 8;
        const hex = input.slice(i + 2, i + 2 + len);
        if (hex.length !== len || !HEX.test(hex)) return error('Invalid \\u escape', i);
        const decoded = decodeUchar(hex);
        if (decoded === undefined) return error(`Invalid code point escape \\u${hex}`, i);
        out += decoded;
        i += 2 + len;
        continue;
      }
      const decoded = e === undefined ? undefined : ECHAR[e];
      if (decoded === undefined) return error('Invalid escape sequence in string', i);
      out += decoded;
      i += 2;
      continue;
    }
    if (long) {
      if (input.startsWith(quote.repeat(3), i)) {
        let j = i;
        while (input[j + 3] === quote && j - i < 2) j++;
        out += input.slice(i, j);
        state.pos = j + 3;
        return { type: 'STRING', value: out, extra: 'long' };
      }
      out += c;
      i++;
    } else {
      if (c === quote) {
        state.pos = i + 1;
        return { type: 'STRING', value: out };
      }
      if (c === '\n' || c === '\r') return error('Newline in string literal', i);
      out += c;
      i++;
    }
  }
});

const digits0 = Token.takeWhile(TurtleGrammar.digit);
const digits1 = Token.takeWhile(TurtleGrammar.digit, { min: 1 });

/** An unsigned number (the sign is a separate token in SPARQL). */
const number: Parser.Parser<Partial> = Parser.alt(
  Parser.taken(
    Parser.alt(
      Parser.seq(
        digits1,
        Parser.opt(Parser.seq(Token.literal('.'), digits0)),
        TurtleGrammar.exponent,
      ),
      Parser.seq(Token.literal('.'), digits1, TurtleGrammar.exponent),
    ),
  ).pipe(Parser.map((value): Partial => ({ type: 'DOUBLE', value }))),
  Parser.taken(Parser.seq(digits0, Token.literal('.'), digits1)).pipe(
    Parser.map((value): Partial => ({ type: 'DECIMAL', value })),
  ),
  digits1.pipe(Parser.map((value): Partial => ({ type: 'INTEGER', value }))),
);

/** `LANG_DIR`: a language tag with an optional `--direction` (checked by the parser). */
const langTag: Parser.Parser<Partial> = Parser.alt(
  Parser.preceded(
    Token.literal('@'),
    Parser.taken(
      Parser.seq(
        Token.takeWhile(TurtleGrammar.alpha, { min: 1 }),
        Parser.repeat(
          Parser.preceded(
            Token.literal('-'),
            Token.takeWhile(TurtleGrammar.alphanumeric, { min: 1 }),
          ),
        ),
        Parser.opt(
          Parser.preceded(Token.literal('--'), Token.takeWhile(TurtleGrammar.alpha, { min: 1 })),
        ),
      ),
    ),
  ).pipe(Parser.map((value): Partial => ({ type: 'LANGTAG', value }))),
  Parser.preceded(Token.literal('@'), Parser.succeed(errorToken('Invalid language tag'))),
);

const blankNode: Parser.Parser<Partial> = Parser.alt(
  TurtleGrammar.blankNodeLabel.pipe(Parser.map((value): Partial => ({ type: 'BNODE', value }))),
  Parser.preceded(Token.literal('_:'), Parser.succeed(errorToken('Invalid blank node label'))),
);

const pname: Parser.Parser<Partial> = TurtleGrammar.prefixedName.pipe(
  Parser.map(({ prefix, local }): Partial => ({ type: 'PNAME', value: local, extra: prefix })),
);

const word: Parser.Parser<Partial> = Parser.taken(
  Parser.seq(Token.oneOf(TurtleGrammar.alpha), Token.takeWhile([TurtleGrammar.alphanumeric, '_'])),
).pipe(Parser.map((value): Partial => ({ type: 'WORD', value })));

const PUNCTUATION = [
  '<<(',
  ')>>',
  '{|',
  '|}',
  '<<',
  '>>',
  '^^',
  '&&',
  '||',
  '!=',
  '<=',
  '>=',
  ...'{}()[].,;=<>!+-*/^|?~'.split(''),
];

const punctuation: Parser.Parser<Partial> = Parser.alt(
  ...PUNCTUATION.map((p) => Token.literal(p)),
).pipe(Parser.map((value): Partial => ({ type: 'PUNCT', value })));

const unexpected: Parser.Parser<Partial> = Token.any.pipe(
  Parser.map((c) => errorToken(`Unexpected character '${c}'`)),
);

/** One token, in the order of preference of the reference lexer. */
const token: Parser.Parser<Partial> = Parser.alt(
  Parser.preceded(Parser.peek(Token.literal('<')), Parser.backtrack(iri)),
  Parser.preceded(Parser.peek(Token.oneOf('?$')), variable),
  Parser.preceded(Token.literal('$'), Parser.succeed(errorToken('Invalid variable'))),
  Parser.preceded(Parser.peek(Token.oneOf('"\'')), string),
  Parser.preceded(
    Parser.peek(
      Parser.alt(
        Token.oneOf(TurtleGrammar.digit),
        Parser.seq(Token.literal('.'), Token.oneOf(TurtleGrammar.digit)),
      ),
    ),
    number,
  ),
  Parser.preceded(Parser.peek(Token.literal('@')), langTag),
  Parser.preceded(Parser.peek(Token.literal('_:')), blankNode),
  pname,
  word,
  punctuation,
  unexpected,
);

const lexer = Compiler.jit(
  Parser.seq(
    Parser.repeat(
      Parser.preceded(
        Parser.seq(TurtleGrammar.skip, Parser.not(Parser.eof)),
        Parser.withSpan(token).pipe(Parser.map(([t, { start, end }]) => make(t, start, end))),
      ),
    ),
    Parser.preceded(TurtleGrammar.skip, Parser.location),
  ),
);

/** Splits a query or update into tokens (ending at the first `ERROR` token, if any). */
export const tokenize = (input: string): Array<Tok> => {
  // The lexer is total (where no token can be read it emits an ERROR token),
  // so the failure branch is unreachable; it still ends in an ERROR token.
  const tokens = Result.match(Parser.parsePeek(lexer, input), {
    onSuccess: ([, [lexed]]) => lexed,
    onFailure: (): Array<Tok> => [make(errorToken('No token could be read'), 0, 0)],
  });
  const error = tokens.findIndex((t) => t.type === 'ERROR');
  if (error !== -1) tokens.length = error + 1;
  return tokens;
};

// -----------------------------------------------------------------------------
// Names
// -----------------------------------------------------------------------------

/** Prefix labels and the namespace IRIs they expand to. */
interface PrefixTable {
  [prefix: string]: string;
}

/** The base IRI and prefixes after resolving the tokens. */
export interface Resolved {
  readonly base: string | undefined;
  readonly prefixes: Record<string, string>;
}

/**
 * Resolves the IRIs of `tokens` in place, in document order: IRI references
 * against the base and prefixed names against the prefixes, as `BASE` and
 * `PREFIX` declarations set them. The name a `PREFIX` declares is left
 * alone; a prefixed name with an undefined prefix gets an `error`.
 */
export const resolve = (
  tokens: Array<Tok>,
  baseIri: string | undefined,
  initialPrefixes: Readonly<Record<string, string>> | undefined,
): Resolved => {
  let base = baseIri;
  const prefixes: PrefixTable = { ...initialPrefixes };
  const resolveIri = (iri: string) => (base !== undefined ? Iri.resolve(iri, base) : iri);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t.type) {
      case 'IRI':
        t.value = resolveIri(t.value);
        break;
      case 'PNAME': {
        const ns = prefixes[t.extra];
        if (ns === undefined) t.error = `Undefined prefix '${t.extra}:'`;
        else t.value = ns + t.value;
        break;
      }
      case 'WORD': {
        const next = tokens[i + 1];
        if (t.kind === 'BASE' && next?.type === 'IRI') {
          next.value = resolveIri(next.value);
          base = next.value;
          i++;
        } else if (t.kind === 'PREFIX' && next?.type === 'PNAME' && next.value === '') {
          const value = tokens[i + 2];
          if (value?.type === 'IRI') {
            value.value = resolveIri(value.value);
            prefixes[next.extra] = value.value;
            i += 2;
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return { base, prefixes };
};
