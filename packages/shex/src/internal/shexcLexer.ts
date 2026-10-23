/**
 * The ShExC lexer, written with `@thomasfosterau/effect-parse`: a compiled
 * grammar turning a document into tokens, followed by a pass that resolves
 * IRIs (relative IRI references against the base, prefixed names against
 * the prefixes) in document order, as `BASE` and `PREFIX` directives are
 * met. The parser then works on resolved tokens, so neither grammar depends
 * on per-document state and both can be compiled.
 *
 * @internal
 */
import * as Compiler from '@thomasfosterau/effect-parse/Compiler';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Token from '@thomasfosterau/effect-parse/Token';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import { quote, unescapeCode, unescapeRegexp } from './lexer.ts';
import * as TurtleGrammar from '@thomasfosterau/effect-turtle/Grammar';
import * as Tokens from './tokens.ts';

/** The kinds of ShExC tokens. */
export type TokenType =
  | 'IRIREF'
  | 'PNAME'
  | 'ATPNAME'
  | 'BLANK_NODE_LABEL'
  | 'LANGTAG'
  | 'STRING'
  | 'LANG_STRING'
  | 'INTEGER'
  | 'DECIMAL'
  | 'DOUBLE'
  | 'REGEXP'
  | 'CODE'
  | 'REPEAT_RANGE'
  | 'KEYWORD'
  | 'PUNCT'
  | 'ERROR';

/** A ShExC token. */
export interface Tok {
  readonly type: TokenType;
  /**
   * KEYWORD: the upper-cased keyword; PUNCT: the punctuation (or `a`,
   * `true`, `false`); numbers: the lexical form; STRING / LANG_STRING: the
   * unescaped value; LANGTAG: the tag; BLANK_NODE_LABEL: `_:label`; REGEXP:
   * the pattern; CODE: the code; PNAME / ATPNAME: the prefix; ERROR: why
   * no token could be read.
   */
  readonly text: string;
  /** What the parser dispatches on: the text of a KEYWORD or PUNCT, else the type. */
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  /**
   * IRIREF: the (unescaped) IRI, resolved against the base by `resolve`;
   * PNAME / ATPNAME: the local part, expanded by `resolve`.
   */
  iri: string;
  /** PNAME / ATPNAME: why the name could not be expanded. */
  error: string | undefined;
  /** LANG_STRING: the language tag; REGEXP: the flags. */
  readonly suffix: string;
  /** REPEAT_RANGE: the bounds (`max` is -1 when unbounded). */
  readonly min: number;
  readonly max: number;
}

/** A token without its position. */
interface Partial {
  readonly type: TokenType;
  readonly text: string;
  readonly iri?: string;
  readonly suffix?: string;
  readonly min?: number;
  readonly max?: number;
}

/** A token, with every field present so that all tokens have the same shape. */
const make = (t: Partial, start: number, end: number): Tok => ({
  type: t.type,
  text: t.text,
  kind: t.type === 'KEYWORD' || t.type === 'PUNCT' ? t.text : t.type,
  start,
  end,
  iri: t.iri ?? '',
  error: undefined,
  suffix: t.suffix ?? '',
  min: t.min ?? 0,
  max: t.max ?? 0,
});

const KEYWORDS = new Set([
  'BASE',
  'PREFIX',
  'IMPORT',
  'START',
  'EXTERNAL',
  'ABSTRACT',
  'RESTRICTS',
  'EXTENDS',
  'CLOSED',
  'EXTRA',
  'LITERAL',
  'BNODE',
  'IRI',
  'NONLITERAL',
  'AND',
  'OR',
  'NOT',
  'MININCLUSIVE',
  'MINEXCLUSIVE',
  'MAXINCLUSIVE',
  'MAXEXCLUSIVE',
  'LENGTH',
  'MINLENGTH',
  'MAXLENGTH',
  'TOTALDIGITS',
  'FRACTIONDIGITS',
]);

const pname = (type: 'PNAME' | 'ATPNAME') =>
  Parser.map(TurtleGrammar.prefixedName, ({ prefix, local }): Partial => ({
    type,
    text: prefix,
    iri: local,
  }));

const numeric = Parser.map(TurtleGrammar.numericLiteral, ([text, type]): Partial => ({
  type: type === 'integer' ? 'INTEGER' : type === 'decimal' ? 'DECIMAL' : 'DOUBLE',
  text,
}));

const string = Parser.map(
  Parser.seq(TurtleGrammar.stringLiteral, Parser.opt(TurtleGrammar.langTag)),
  ([text, lang]): Partial =>
    lang._tag === 'Some'
      ? { type: 'LANG_STRING', text, suffix: lang.value }
      : { type: 'STRING', text },
);

const regexp = Parser.preceded(
  Token.literal('/'),
  Parser.seq(
    Parser.taken(
      Parser.repeat(
        Parser.alt(
          Token.takeTill('/\\\n\r', { min: 1 }),
          Parser.seq(Token.literal('\\'), Token.oneOf('nrt\\|.?*+(){}$-[]^/')),
          Parser.seq(Token.literal('\\u'), Token.takeWhile(TurtleGrammar.hex, 4)),
          Parser.seq(Token.literal('\\U'), Token.takeWhile(TurtleGrammar.hex, 8)),
        ),
        { min: 1 },
      ),
    ),
    Parser.preceded(Token.literal('/'), Token.takeWhile('smix')),
  ),
).pipe(
  Parser.map(([body, flags]): Partial => ({
    type: 'REGEXP',
    text: unescapeRegexp(body),
    suffix: flags,
  })),
);

const code = Parser.delimited(
  Token.literal('{'),
  Parser.taken(
    Parser.repeat(
      Parser.alt(
        Token.takeTill('%\\', { min: 1 }),
        Parser.seq(Token.literal('\\'), Token.oneOf('%\\')),
        Parser.seq(Token.literal('\\u'), Token.takeWhile(TurtleGrammar.hex, 4)),
        Parser.seq(Token.literal('\\U'), Token.takeWhile(TurtleGrammar.hex, 8)),
      ),
    ),
  ),
  Token.literal('%}'),
).pipe(Parser.map((body): Partial => ({ type: 'CODE', text: unescapeCode(body) })));

const bound = Parser.preceded(
  Parser.opt(Token.oneOf('+-')),
  Token.takeWhile(TurtleGrammar.digit, { min: 1 }),
);

const repeatRange = Parser.delimited(
  Token.literal('{'),
  Parser.seq(
    bound,
    Parser.opt(
      Parser.preceded(Token.literal(','), Parser.opt(Parser.alt(bound, Token.literal('*')))),
    ),
  ),
  Token.literal('}'),
).pipe(
  Parser.map(([min, rest]): Partial => {
    const lo = parseInt(min, 10);
    const hi =
      rest._tag === 'None'
        ? lo
        : rest.value._tag === 'None' || rest.value.value === '*'
          ? -1
          : parseInt(rest.value.value, 10);
    return { type: 'REPEAT_RANGE', text: '', min: lo, max: hi };
  }),
);

const word = Token.takeWhile(TurtleGrammar.alpha, { min: 1 }).pipe(
  Parser.filterMap((w): Option.Option<Partial> => {
    if (w === 'a' || w === 'true' || w === 'false') return Option.some({ type: 'PUNCT', text: w });
    const upper = w.toUpperCase();
    return KEYWORDS.has(upper) ? Option.some({ type: 'KEYWORD', text: upper }) : Option.none();
  }),
);

/** One token, in the order of preference of the ShEx 2 lexer. */
const punctuation = (...ps: ReadonlyArray<string>): Parser.Parser<Partial> =>
  Parser.alt(...ps.map((p) => Token.literal(p))).pipe(
    Parser.map((text): Partial => ({ type: 'PUNCT', text })),
  );

const prefixedOrWord = Parser.alt(pname('PNAME'), word);

const numericOr = (p: string) => Parser.alt(numeric, punctuation(p));

/**
 * One token. The first character selects the candidates, which are tried in
 * the order of preference of the ShEx 2 lexer.
 */
const token: Parser.Parser<Partial> = Parser.dispatch(
  Parser.peek(Token.any),
  {
    '@': Parser.alt(
      Parser.preceded(Token.literal('@'), pname('ATPNAME')),
      TurtleGrammar.langTag.pipe(Parser.map((text): Partial => ({ type: 'LANGTAG', text }))),
      punctuation('@'),
    ),
    '<': TurtleGrammar.iriRef.pipe(
      Parser.map((iri): Partial => ({ type: 'IRIREF', text: '', iri })),
    ),
    '/': Parser.alt(punctuation('//'), regexp),
    _: TurtleGrammar.blankNodeLabel.pipe(
      Parser.map((label): Partial => ({ type: 'BLANK_NODE_LABEL', text: `_:${label}` })),
    ),
    '"': string,
    "'": string,
    '{': Parser.alt(repeatRange, code, punctuation('{')),
    '^': punctuation('^^', '^'),
    '|': punctuation('||', '|'),
    '.': numericOr('.'),
    '+': numericOr('+'),
    '-': numericOr('-'),
    ...Object.fromEntries('0123456789'.split('').map((d) => [d, numeric])),
    ...Object.fromEntries('=}&,()[]$!~;*?%'.split('').map((p) => [p, punctuation(p)])),
  },
  prefixedOrWord,
);

const lexer = Compiler.jit(
  Parser.seq(
    Parser.repeat(
      Parser.preceded(
        Tokens.skip,
        // A malformed token ends the token stream (see `tokenize`).
        Parser.withSpan(Parser.backtrack(token)).pipe(
          Parser.map(([t, { start, end }]) => make(t, start, end)),
        ),
      ),
    ),
    Parser.preceded(Tokens.skip, Parser.location),
  ),
);

/** Why no token could be read at `offset` (the messages of the ShEx 2 lexer). */
const describe = (input: string, offset: number): string => {
  const c = input[offset]!;
  if (c === '<') return 'invalid IRI reference';
  if (c === '/') return 'invalid regular expression';
  if (c === '"' || c === "'") return 'invalid string literal';
  const w = /^[A-Za-z]+/.exec(input.slice(offset, offset + 64));
  if (w !== null) return `unexpected word "${w[0]}"`;
  return `invalid character ${quote(String.fromCodePoint(input.codePointAt(offset)!))}`;
};

/**
 * Splits a document into tokens. Where no token can be read, the tokens end
 * with an `ERROR` token whose text says why; no grammar rule accepts it, so
 * the parser reports it if it gets that far, as a lazy lexer would.
 */
export const tokenize = (input: string): Array<Tok> => {
  // The lexer always succeeds: it stops where no token can be read.
  const peeked = Parser.parsePeek(lexer, input);
  if (Result.isFailure(peeked)) throw peeked.failure;
  const [, [tokens, end]] = peeked.success;
  if (end < input.length) {
    tokens.push(make({ type: 'ERROR', text: describe(input, end) }, end, end));
  }
  return tokens;
};

/** The base IRI and prefixes after resolving a document's tokens. */
export interface Resolved {
  readonly baseIri: string | undefined;
  readonly prefixes: Map<string, string>;
}

/**
 * Resolves the IRIs of `tokens` in place, in document order: IRI references
 * against the base, and prefixed names against the prefixes, both as set by
 * the `BASE` and `PREFIX` directives met so far. The prefix name declared by
 * a `PREFIX` directive is left alone. A prefixed name with an unknown prefix
 * gets an `error`, which the parser reports when it reads the name.
 */
export const resolve = (
  tokens: Array<Tok>,
  baseIri: string | undefined,
  initialPrefixes: Readonly<Record<string, string>> | undefined,
): Resolved => {
  let base = baseIri;
  const prefixes = new Map(Object.entries(initialPrefixes ?? {}));
  const resolveRef = (iri: string) =>
    base === undefined || Iri.isAbsolute(iri) ? iri : Iri.resolve(iri, base);
  const expand = (t: Tok): boolean => {
    const ns = prefixes.get(t.text);
    if (ns === undefined) {
      t.error = `unknown prefix "${t.text}:"`;
      return false;
    }
    t.iri = ns + t.iri;
    return true;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t.type) {
      case 'IRIREF':
        t.iri = resolveRef(t.iri);
        break;
      case 'PNAME':
      case 'ATPNAME':
        expand(t);
        break;
      case 'KEYWORD': {
        const next = tokens[i + 1];
        if (t.text === 'BASE' && next?.type === 'IRIREF') {
          next.iri = resolveRef(next.iri);
          base = next.iri;
          i++;
        } else if (t.text === 'PREFIX' && next?.type === 'PNAME' && next.iri === '') {
          const value = tokens[i + 2];
          if (value?.type === 'IRIREF') value.iri = resolveRef(value.iri);
          else if (value?.type !== 'PNAME' || !expand(value)) break;
          prefixes.set(next.text, value.iri);
          i += 2;
        }
        break;
      }
      default:
        break;
    }
  }
  return { baseIri: base, prefixes };
};
