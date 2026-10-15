/**
 * A complete, hand-written recursive-descent parser for SPARQL 1.1 Query and
 * Update, including the SPARQL 1.2 additions (triple terms, reified triples,
 * annotations, `VERSION`, directional language tags and the new built-in
 * functions).
 *
 * The parser expands all abbreviations (prefixed names, relative IRIs,
 * `a`, blank node property lists, collections, reifiers and annotations)
 * and enforces the static constraints of the specification (blank node
 * label scoping, grouping rules, `BIND`/`AS` scoping, `VALUES` arity,
 * variable-free `INSERT DATA`, blank-node-free `DELETE` templates, …).
 *
 * @since 0.1.0
 */
import * as Effect from 'effect/Effect';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Ast from './Ast.ts';

// -----------------------------------------------------------------------------
// Errors and options
// -----------------------------------------------------------------------------

/**
 * A syntax (or static semantic) error in a SPARQL query or update.
 *
 * @since 0.1.0
 * @category errors
 */
export class SparqlParseError extends Schema.TaggedError<SparqlParseError>()('SparqlParseError', {
  message: Schema.String,
  /** 1-based line of the error. */
  line: Schema.Number,
  /** 1-based column of the error. */
  column: Schema.Number,
  /** 0-based character offset of the error. */
  offset: Schema.Number,
}) {}

/**
 * @since 0.1.0
 * @category models
 */
export interface ParseOptions {
  /** The base IRI used to resolve relative IRIs (unless overridden by `BASE`). */
  readonly baseIri?: string | undefined;
  /** Prefixes available without declaration. */
  readonly prefixes?: Readonly<Record<string, string>> | undefined;
}

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const rdfType = Term.namedNode(`${RDF}type`);
const rdfFirst = Term.namedNode(`${RDF}first`);
const rdfRest = Term.namedNode(`${RDF}rest`);
const rdfNil = Term.namedNode(`${RDF}nil`);
const rdfReifies = Term.namedNode(`${RDF}reifies`);
const xsdInteger = Term.namedNode(`${XSD}integer`);
const xsdDecimal = Term.namedNode(`${XSD}decimal`);
const xsdDouble = Term.namedNode(`${XSD}double`);
const xsdBoolean = Term.namedNode(`${XSD}boolean`);

// -----------------------------------------------------------------------------
// Lexer
// -----------------------------------------------------------------------------

type TokenType =
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
  | 'EOF';

interface Token {
  readonly type: TokenType;
  /** Decoded value: IRI text, local name, label, variable name, string value, … */
  readonly value: string;
  /** For PNAME tokens: the prefix. For STRING tokens: `long` when a long string. */
  readonly extra: string;
  readonly start: number;
  readonly end: number;
}

const PN_CHARS_BASE =
  'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const PN_CHARS_U = `${PN_CHARS_BASE}_`;
const PN_CHARS = `${PN_CHARS_U}\\-0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const PLX = `%[0-9A-Fa-f]{2}|\\\\[_~.\\-!$&'()*+,;=/?#@%]`;
const PN_PREFIX = `[${PN_CHARS_BASE}](?:[${PN_CHARS}.]*[${PN_CHARS}])?`;
const PN_LOCAL = `(?:[${PN_CHARS_U}:0-9]|${PLX})(?:(?:[${PN_CHARS}.:]|${PLX})*(?:[${PN_CHARS}:]|${PLX}))?`;

const RE_PNAME = new RegExp(`(${PN_PREFIX})?:(${PN_LOCAL})?`, 'uy');
const RE_BNODE = new RegExp(`_:([${PN_CHARS_U}0-9](?:[${PN_CHARS}.]*[${PN_CHARS}])?)`, 'uy');
const RE_VAR = new RegExp(
  `[?$]([${PN_CHARS_U}0-9][${PN_CHARS_U}0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*)`,
  'uy',
);
const RE_WORD = /[A-Za-z][A-Za-z0-9_]*/y;
const RE_LANGTAG = /@([a-zA-Z]+(?:-[a-zA-Z0-9]+)*(?:--[a-zA-Z]+)?)/y;
const RE_NUMBER =
  /(?:[0-9]+(?:\.[0-9]*)?[eE][+-]?[0-9]+|\.[0-9]+[eE][+-]?[0-9]+)|[0-9]*\.[0-9]+|[0-9]+/y;
// eslint-disable-next-line no-control-regex
const RE_IRIREF = /<((?:[^<>"{}|^`\\\u0000- ]|\\u[0-9A-Fa-f]{4}|\\U[0-9A-Fa-f]{8})*)>/y;
const RE_WS = /(?:[ \t\r\n]|#[^\r\n]*)*/y;

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
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  '.',
  ',',
  ';',
  '=',
  '<',
  '>',
  '!',
  '+',
  '-',
  '*',
  '/',
  '^',
  '|',
  '?',
  '~',
] as const;

class Failure {
  constructor(
    readonly message: string,
    readonly offset: number,
  ) {}
}

const fail = (message: string, offset: number): never => {
  throw new Failure(message, offset);
};

const decodeUchar = (hex: string, offset: number): string => {
  const code = parseInt(hex, 16);
  if ((code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
    fail(`Invalid code point escape \\u${hex}`, offset);
  }
  return String.fromCodePoint(code);
};

const ECHAR: Record<string, string> = {
  t: '\t',
  b: '\b',
  n: '\n',
  r: '\r',
  f: '\f',
  '"': '"',
  "'": "'",
  '\\': '\\',
};

class Lexer {
  pos = 0;
  constructor(readonly input: string) {}

  skipWs(): void {
    RE_WS.lastIndex = this.pos;
    RE_WS.exec(this.input);
    this.pos = RE_WS.lastIndex;
  }

  next(): Token {
    this.skipWs();
    const input = this.input;
    const start = this.pos;
    if (start >= input.length) return { type: 'EOF', value: '', extra: '', start, end: start };
    const ch = input[start]!;
    const tok = (type: TokenType, value: string, end: number, extra = ''): Token => {
      this.pos = end;
      return { type, value, extra, start, end };
    };
    // IRIs
    if (ch === '<') {
      RE_IRIREF.lastIndex = start;
      const m = RE_IRIREF.exec(input);
      if (m !== null) {
        const raw = m[1]!;
        const value = raw.includes('\\')
          ? raw.replace(/\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})/g, (_, a, b) =>
              decodeUchar(a ?? b, start),
            )
          : raw;
        // eslint-disable-next-line no-control-regex
        if (/[<>"{}|^`\\\u0000- ]/.test(value) && raw.includes('\\')) {
          fail('Invalid character in IRI', start);
        }
        return tok('IRI', value, RE_IRIREF.lastIndex);
      }
    }
    // Variables
    if (ch === '?' || ch === '$') {
      RE_VAR.lastIndex = start;
      const m = RE_VAR.exec(input);
      if (m !== null) return tok('VAR', m[1]!, RE_VAR.lastIndex);
      if (ch === '$') fail('Invalid variable', start);
    }
    // Strings
    if (ch === '"' || ch === "'") return this.string(start, ch);
    // Numbers
    if ((ch >= '0' && ch <= '9') || (ch === '.' && /[0-9]/.test(input[start + 1] ?? ''))) {
      RE_NUMBER.lastIndex = start;
      const m = RE_NUMBER.exec(input)!;
      const text = m[0];
      const type: TokenType = /[eE]/.test(text)
        ? 'DOUBLE'
        : text.includes('.')
          ? 'DECIMAL'
          : 'INTEGER';
      return tok(type, text, RE_NUMBER.lastIndex);
    }
    // Language tags
    if (ch === '@') {
      RE_LANGTAG.lastIndex = start;
      const m = RE_LANGTAG.exec(input);
      if (m === null) fail('Invalid language tag', start);
      return tok('LANGTAG', m![1]!, RE_LANGTAG.lastIndex);
    }
    // Blank node labels
    if (ch === '_' && input[start + 1] === ':') {
      RE_BNODE.lastIndex = start;
      const m = RE_BNODE.exec(input);
      if (m === null) fail('Invalid blank node label', start);
      return tok('BNODE', m![1]!, RE_BNODE.lastIndex);
    }
    // Prefixed names and keywords
    RE_PNAME.lastIndex = start;
    const pm = RE_PNAME.exec(input);
    if (pm !== null && pm[0].length > 0 && pm[0].includes(':')) {
      const local = pm[2] ?? '';
      return tok(
        'PNAME',
        local.includes('\\') ? local.replace(/\\(.)/g, '$1') : local,
        RE_PNAME.lastIndex,
        pm[1] ?? '',
      );
    }
    RE_WORD.lastIndex = start;
    const wm = RE_WORD.exec(input);
    if (wm !== null) return tok('WORD', wm[0], RE_WORD.lastIndex);
    for (const p of PUNCTUATION) {
      if (input.startsWith(p, start)) return tok('PUNCT', p, start + p.length);
    }
    return fail(`Unexpected character '${String.fromCodePoint(input.codePointAt(start)!)}'`, start);
  }

  string(start: number, quote: string): Token {
    const input = this.input;
    const long = input.startsWith(quote.repeat(3), start);
    let i = start + (long ? 3 : 1);
    let out = '';
    for (;;) {
      if (i >= input.length) fail('Unterminated string literal', start);
      const c = input[i]!;
      if (c === '\\') {
        const e = input[i + 1];
        if (e === 'u' || e === 'U') {
          const len = e === 'u' ? 4 : 8;
          const hex = input.slice(i + 2, i + 2 + len);
          if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) fail('Invalid \\u escape', i);
          out += decodeUchar(hex, i);
          i += 2 + len;
          continue;
        }
        const decoded = e === undefined ? undefined : ECHAR[e];
        if (decoded === undefined) fail('Invalid escape sequence in string', i);
        out += decoded;
        i += 2;
        continue;
      }
      if (long) {
        if (input.startsWith(quote.repeat(3), i)) {
          // Allow up to two additional quotes before the closing delimiter.
          let j = i;
          while (input[j + 3] === quote && j - i < 2) j++;
          out += input.slice(i, j);
          this.pos = j + 3;
          return { type: 'STRING', value: out, extra: 'long', start, end: this.pos };
        }
        out += c;
        i++;
      } else {
        if (c === quote) {
          this.pos = i + 1;
          return { type: 'STRING', value: out, extra: '', start, end: this.pos };
        }
        if (c === '\n' || c === '\r') fail('Newline in string literal', i);
        out += c;
        i++;
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Parser
// -----------------------------------------------------------------------------

const KEYWORD_STARTS_GPNT = new Set([
  'OPTIONAL',
  'MINUS',
  'GRAPH',
  'SERVICE',
  'FILTER',
  'BIND',
  'VALUES',
]);

const AGGREGATES = new Set(['COUNT', 'SUM', 'MIN', 'MAX', 'AVG', 'SAMPLE', 'GROUP_CONCAT']);

type Triples = Array<Ast.TriplePattern | Ast.PathPattern>;

interface TripleContext {
  /** Whether property paths are allowed (WHERE patterns). */
  readonly paths: boolean;
  /** Whether variables are allowed (false for INSERT/DELETE DATA). */
  readonly variables: boolean;
  /** Whether blank nodes are allowed (false for DELETE templates / data). */
  readonly blankNodes: boolean;
  /** Scope identifier for blank node label checks. */
  readonly scope: number;
  /** Label map to check against. */
  readonly labels: Map<string, number>;
}

class SparqlParser {
  readonly lexer: Lexer;
  tok: Token;
  base: string | undefined;
  prefixes: Record<string, string>;
  version: string | undefined;
  private bnodeCounter = 0;
  private readonly usedLabels: Set<string>;
  private scopeCounter = 0;
  /** Blank node labels in query patterns, mapped to their BGP scope. */
  private readonly patternLabels = new Map<string, number>();
  /** Blank node labels in templates / data, mapped to their operation. */
  private readonly templateLabels = new Map<string, number>();
  private aggregatesAllowed = false;
  private inAggregate = false;

  constructor(
    readonly input: string,
    options: ParseOptions | undefined,
  ) {
    this.lexer = new Lexer(input);
    this.base = options?.baseIri;
    this.prefixes = { ...options?.prefixes };
    this.usedLabels = new Set(Array.from(input.matchAll(/_:([^\s.;,(){}[\]]+)/g), (m) => m[1]!));
    this.tok = this.lexer.next();
  }

  // --- token helpers --------------------------------------------------------

  /** The type of the current token (a method, so that TypeScript does not narrow it). */
  type(): TokenType {
    return this.tok.type;
  }

  advance(): Token {
    const t = this.tok;
    this.tok = this.lexer.next();
    return t;
  }

  /** Looks at the token after the current one without consuming anything. */
  peek2(): Token {
    const saved = this.lexer.pos;
    const t = this.lexer.next();
    this.lexer.pos = saved;
    return t;
  }

  isPunct(p: string): boolean {
    return this.type() === 'PUNCT' && this.tok.value === p;
  }

  isWord(w: string): boolean {
    return this.type() === 'WORD' && this.tok.value.toUpperCase() === w;
  }

  eatPunct(p: string): boolean {
    if (this.isPunct(p)) {
      this.advance();
      return true;
    }
    return false;
  }

  eatWord(w: string): boolean {
    if (this.isWord(w)) {
      this.advance();
      return true;
    }
    return false;
  }

  expectPunct(p: string): Token {
    if (!this.isPunct(p)) this.unexpected(`'${p}'`);
    return this.advance();
  }

  expectWord(w: string): Token {
    if (!this.isWord(w)) this.unexpected(w);
    return this.advance();
  }

  describe(t: Token): string {
    switch (t.type) {
      case 'EOF':
        return 'end of input';
      case 'STRING':
        return 'string literal';
      default:
        return `'${this.input.slice(t.start, t.end)}'`;
    }
  }

  unexpected(expected?: string): never {
    return fail(
      `Unexpected ${this.describe(this.tok)}${expected !== undefined ? `, expected ${expected}` : ''}`,
      this.tok.start,
    );
  }

  /** Whether the next token immediately follows the current one (no whitespace). */
  adjacent(): boolean {
    return this.peek2().start === this.tok.end;
  }

  // --- IRIs and terms -------------------------------------------------------

  /** Resolves an IRI reference; relative references without a base are kept as written. */
  resolve(iri: string): string {
    return this.base !== undefined ? Iri.resolve(iri, this.base) : iri;
  }

  isIriStart(): boolean {
    return this.type() === 'IRI' || this.type() === 'PNAME';
  }

  iri(): Term.NamedNode {
    const t = this.tok;
    if (t.type === 'IRI') {
      this.advance();
      return Term.namedNode(this.resolve(t.value));
    }
    if (t.type === 'PNAME') {
      this.advance();
      const ns = this.prefixes[t.extra];
      if (ns === undefined) fail(`Undefined prefix '${t.extra}:'`, t.start);
      return Term.namedNode(ns + t.value);
    }
    return this.unexpected('an IRI');
  }

  variable(): Term.Variable {
    if (this.type() !== 'VAR') this.unexpected('a variable');
    return Term.variable(this.advance().value);
  }

  freshBlankNode(): Term.BlankNode {
    let label: string;
    do label = `g${this.bnodeCounter++}`;
    while (this.usedLabels.has(label));
    return Term.blankNode(label);
  }

  blankNodeLabel(ctx: TripleContext): Term.BlankNode {
    const t = this.advance();
    if (!ctx.blankNodes) fail('Blank nodes are not allowed here', t.start);
    const existing = ctx.labels.get(t.value);
    if (existing !== undefined && existing !== ctx.scope) {
      fail(`Blank node label _:${t.value} is used in more than one scope`, t.start);
    }
    ctx.labels.set(t.value, ctx.scope);
    return Term.blankNode(t.value);
  }

  string(): { value: string; token: Token } {
    if (this.type() !== 'STRING') this.unexpected('a string');
    const token = this.advance();
    return { value: token.value, token };
  }

  rdfLiteral(): Term.Literal {
    const { value } = this.string();
    if (this.type() === 'LANGTAG') {
      const tag = this.advance().value;
      const i = tag.indexOf('--');
      if (i !== -1) {
        const dir = tag.slice(i + 2).toLowerCase();
        if (dir !== 'ltr' && dir !== 'rtl') fail(`Invalid base direction '${dir}'`, this.tok.start);
        return Term.literal(value, { language: tag.slice(0, i), direction: dir as Term.Direction });
      }
      return Term.literal(value, tag);
    }
    if (this.eatPunct('^^')) return Term.literal(value, this.iri());
    return Term.literal(value);
  }

  isNumberToken(t: Token = this.tok): boolean {
    return t.type === 'INTEGER' || t.type === 'DECIMAL' || t.type === 'DOUBLE';
  }

  numericLiteral(sign = ''): Term.Literal {
    const t = this.advance();
    const datatype =
      t.type === 'INTEGER' ? xsdInteger : t.type === 'DECIMAL' ? xsdDecimal : xsdDouble;
    return Term.literal(sign + t.value, datatype);
  }

  /** A signed numeric literal starting at a `+` / `-` token, if adjacent. */
  signedNumber(): Term.Literal | undefined {
    if (
      (this.isPunct('+') || this.isPunct('-')) &&
      this.adjacent() &&
      this.isNumberToken(this.peek2())
    ) {
      const sign = this.advance().value;
      return this.numericLiteral(sign);
    }
    return undefined;
  }

  booleanLiteral(): Term.Literal | undefined {
    if (this.type() === 'WORD') {
      const w = this.tok.value.toLowerCase();
      if (w === 'true' || w === 'false') {
        this.advance();
        return Term.literal(w, xsdBoolean);
      }
    }
    return undefined;
  }

  /** NIL `()` */
  isNil(): boolean {
    return this.isPunct('(') && this.peek2().type === 'PUNCT' && this.peek2().value === ')';
  }

  /** ANON `[]` */
  isAnon(): boolean {
    return this.isPunct('[') && this.peek2().type === 'PUNCT' && this.peek2().value === ']';
  }

  // --- prologue -------------------------------------------------------------

  prologue(): void {
    for (;;) {
      if (this.isWord('BASE')) {
        this.advance();
        if (this.type() !== 'IRI') this.unexpected('an IRI');
        const t = this.advance();
        this.base = this.base !== undefined ? Iri.resolve(t.value, this.base) : t.value;
      } else if (this.isWord('PREFIX')) {
        this.advance();
        if (this.type() !== 'PNAME' || this.tok.value !== '') this.unexpected('a prefix name');
        const prefix = this.advance().extra;
        if (this.type() !== 'IRI') this.unexpected('an IRI');
        const t = this.advance();
        this.prefixes[prefix] = this.resolve(t.value);
      } else if (this.isWord('VERSION')) {
        this.advance();
        if (this.type() !== 'STRING' || this.tok.extra === 'long')
          this.unexpected('a version string');
        this.version = this.advance().value;
      } else return;
    }
  }

  prologueValue(): Ast.Prologue {
    return {
      ...(this.base !== undefined ? { base: this.base } : {}),
      prefixes: { ...this.prefixes },
      ...(this.version !== undefined ? { version: this.version } : {}),
    };
  }

  // --- queries --------------------------------------------------------------

  queryUnit(): Ast.Query {
    this.prologue();
    const prologue = this.prologueValue();
    let query: Ast.Query;
    if (this.isWord('SELECT')) query = this.selectQuery(prologue, false);
    else if (this.isWord('CONSTRUCT')) query = this.constructQuery(prologue);
    else if (this.isWord('DESCRIBE')) query = this.describeQuery(prologue);
    else if (this.isWord('ASK')) query = this.askQuery(prologue);
    else return this.unexpected('SELECT, CONSTRUCT, DESCRIBE or ASK');
    const values = this.valuesClause();
    if (this.type() !== 'EOF') this.unexpected();
    if (values !== undefined) query = { ...query, values };
    if (query._tag === 'Select') this.validateSelect(query, 0);
    else this.validateGrouping(query, 0);
    return query;
  }

  selectQuery(prologue: Ast.Prologue, sub: boolean): Ast.SelectQuery {
    const start = this.tok.start;
    this.expectWord('SELECT');
    let distinct = false;
    let reduced = false;
    if (this.eatWord('DISTINCT')) distinct = true;
    else if (this.eatWord('REDUCED')) reduced = true;
    let projection: Ast.SelectQuery['projection'];
    if (this.eatPunct('*')) projection = '*';
    else {
      const items: Array<Term.Variable | Ast.Projection> = [];
      for (;;) {
        if (this.type() === 'VAR') items.push(this.variable());
        else if (this.isPunct('(')) {
          this.advance();
          const expression = this.withAggregates(() => this.expression());
          this.expectWord('AS');
          const variable = this.variable();
          this.expectPunct(')');
          items.push({ _tag: 'Projection', expression, variable });
        } else break;
      }
      if (items.length === 0) this.unexpected('a variable, expression or *');
      projection = items;
    }
    const dataset = sub ? undefined : this.datasetClauses();
    this.eatWord('WHERE');
    const where = this.groupGraphPattern();
    const modifiers = this.solutionModifiers();
    const query: Ast.SelectQuery = {
      _tag: 'Select',
      prologue,
      ...(dataset !== undefined ? { dataset } : {}),
      distinct,
      reduced,
      projection,
      where,
      ...modifiers,
    };
    void start;
    return query;
  }

  constructQuery(prologue: Ast.Prologue): Ast.ConstructQuery {
    this.expectWord('CONSTRUCT');
    if (this.isPunct('{')) {
      const template = this.constructTemplate();
      const dataset = this.datasetClauses();
      this.eatWord('WHERE');
      const where = this.groupGraphPattern();
      const modifiers = this.solutionModifiers();
      return {
        _tag: 'Construct',
        prologue,
        ...(dataset !== undefined ? { dataset } : {}),
        template,
        where,
        ...modifiers,
      };
    }
    const dataset = this.datasetClauses();
    this.expectWord('WHERE');
    this.expectPunct('{');
    const triples: Triples = [];
    const ctx = this.patternContext(false);
    this.triplesTemplate(triples, ctx, '}');
    this.expectPunct('}');
    const template = triples as Array<Ast.TriplePattern>;
    const modifiers = this.solutionModifiers();
    return {
      _tag: 'Construct',
      prologue,
      ...(dataset !== undefined ? { dataset } : {}),
      template,
      where: Ast.group(template.length > 0 ? [Ast.bgp(template)] : []),
      short: true,
      ...modifiers,
    };
  }

  describeQuery(prologue: Ast.Prologue): Ast.DescribeQuery {
    this.expectWord('DESCRIBE');
    let terms: Ast.DescribeQuery['terms'];
    if (this.eatPunct('*')) terms = '*';
    else {
      const list: Array<Ast.VarOrIri> = [];
      while (this.type() === 'VAR' || this.isIriStart()) {
        list.push(this.type() === 'VAR' ? this.variable() : this.iri());
      }
      if (list.length === 0) this.unexpected('a variable, IRI or *');
      terms = list;
    }
    const dataset = this.datasetClauses();
    let where = Ast.group([]);
    if (this.isWord('WHERE') || this.isPunct('{')) {
      this.eatWord('WHERE');
      where = this.groupGraphPattern();
    }
    const modifiers = this.solutionModifiers();
    return {
      _tag: 'Describe',
      prologue,
      ...(dataset !== undefined ? { dataset } : {}),
      terms,
      where,
      ...modifiers,
    };
  }

  askQuery(prologue: Ast.Prologue): Ast.AskQuery {
    this.expectWord('ASK');
    const dataset = this.datasetClauses();
    this.eatWord('WHERE');
    const where = this.groupGraphPattern();
    const modifiers = this.solutionModifiers();
    return {
      _tag: 'Ask',
      prologue,
      ...(dataset !== undefined ? { dataset } : {}),
      where,
      ...modifiers,
    };
  }

  datasetClauses(): Ast.DatasetClause | undefined {
    const def: Array<Term.NamedNode> = [];
    const named: Array<Term.NamedNode> = [];
    let any = false;
    while (this.eatWord('FROM')) {
      any = true;
      if (this.eatWord('NAMED')) named.push(this.iri());
      else def.push(this.iri());
    }
    return any ? { default: def, named } : undefined;
  }

  solutionModifiers(): Pick<Ast.QueryBase, 'groupBy' | 'having' | 'orderBy' | 'limit' | 'offset'> {
    const groupBy: Array<Ast.GroupCondition> = [];
    const having: Array<Ast.Expression> = [];
    const orderBy: Array<Ast.OrderCondition> = [];
    let limit: number | undefined;
    let offset: number | undefined;
    if (this.isWord('GROUP')) {
      this.advance();
      this.expectWord('BY');
      for (;;) {
        if (this.type() === 'VAR') groupBy.push({ expression: this.variable() });
        else if (this.isPunct('(')) {
          this.advance();
          const expression = this.expression();
          let variable: Term.Variable | undefined;
          if (this.eatWord('AS')) variable = this.variable();
          this.expectPunct(')');
          groupBy.push(variable !== undefined ? { expression, variable } : { expression });
        } else if (this.startsBuiltIn() || this.isIriStart()) {
          groupBy.push({ expression: this.constraint() });
        } else break;
      }
      if (groupBy.length === 0) this.unexpected('a grouping condition');
    }
    if (this.isWord('HAVING')) {
      this.advance();
      this.withAggregates(() => {
        for (;;) {
          if (this.isPunct('(') || this.startsBuiltIn() || this.isIriStart()) {
            having.push(this.constraint());
          } else break;
        }
      });
      if (having.length === 0) this.unexpected('a HAVING condition');
    }
    if (this.isWord('ORDER')) {
      this.advance();
      this.expectWord('BY');
      this.withAggregates(() => {
        for (;;) {
          if (this.isWord('ASC') || this.isWord('DESC')) {
            const descending = this.advance().value.toUpperCase() === 'DESC';
            if (!this.isPunct('(')) this.unexpected("'('");
            orderBy.push({ expression: this.brackettedExpression(), descending });
          } else if (this.type() === 'VAR') {
            orderBy.push({ expression: this.variable(), descending: false });
          } else if (this.isPunct('(') || this.startsBuiltIn() || this.isIriStart()) {
            orderBy.push({ expression: this.constraint(), descending: false });
          } else break;
        }
      });
      if (orderBy.length === 0) this.unexpected('an ORDER BY condition');
    }
    for (let i = 0; i < 2; i++) {
      if (limit === undefined && this.isWord('LIMIT')) {
        this.advance();
        if (this.type() !== 'INTEGER') this.unexpected('an integer');
        limit = Number(this.advance().value);
      } else if (offset === undefined && this.isWord('OFFSET')) {
        this.advance();
        if (this.type() !== 'INTEGER') this.unexpected('an integer');
        offset = Number(this.advance().value);
      }
    }
    return {
      groupBy,
      having,
      orderBy,
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    };
  }

  valuesClause(): Ast.ValuesPattern | undefined {
    if (!this.isWord('VALUES')) return undefined;
    this.advance();
    return this.dataBlock();
  }

  withAggregates<A>(f: () => A): A {
    const saved = this.aggregatesAllowed;
    this.aggregatesAllowed = true;
    try {
      return f();
    } finally {
      this.aggregatesAllowed = saved;
    }
  }

  // --- static checks --------------------------------------------------------

  validateSelect(query: Ast.SelectQuery, offset: number): void {
    // Variables introduced by AS must not already be in scope.
    if (query.projection !== '*') {
      const grouped =
        query.groupBy.length > 0 ||
        query.projection.some((p) => p._tag !== 'Variable' && Ast.containsAggregate(p.expression));
      // With grouping only the group keys are in scope; otherwise the
      // pattern's variables are.
      const inScope = new Set<string>(grouped ? [] : Ast.inScopeVariables(query.where));
      for (const g of query.groupBy) {
        if (g.variable !== undefined) inScope.add(g.variable.value);
        else if (g.expression._tag === 'Variable') inScope.add(g.expression.value);
      }
      // Variables of a trailing VALUES clause are joined before projection.
      for (const v of query.values?.variables ?? []) inScope.add(v.value);
      const seen = new Set<string>();
      for (const item of query.projection) {
        if (item._tag !== 'Variable') {
          const name = item.variable.value;
          if (inScope.has(name) || seen.has(name)) {
            fail(`Variable ?${name} is already in scope`, offset);
          }
          seen.add(name);
        } else seen.add(item.value);
      }
    }
    this.validateGrouping(query, offset);
  }

  validateGrouping(query: Ast.Query, offset: number): void {
    const projectionExprs =
      query._tag === 'Select' && query.projection !== '*'
        ? query.projection.flatMap((p) => (p._tag === 'Variable' ? [] : [p.expression]))
        : [];
    const grouped =
      query.groupBy.length > 0 ||
      projectionExprs.some(Ast.containsAggregate) ||
      query.having.some(Ast.containsAggregate) ||
      query.orderBy.some((o) => Ast.containsAggregate(o.expression));
    for (const g of query.groupBy) {
      if (Ast.containsAggregate(g.expression))
        fail('Aggregates are not allowed in GROUP BY', offset);
    }
    if (!grouped || query._tag !== 'Select') return;
    if (query.projection === '*')
      fail('SELECT * is not allowed with GROUP BY or aggregates', offset);
    const allowed = new Set<string>(query.values?.variables.map((v) => v.value) ?? []);
    for (const g of query.groupBy) {
      if (g.variable !== undefined) allowed.add(g.variable.value);
      else if (g.expression._tag === 'Variable') allowed.add(g.expression.value);
    }
    const checkExpr = (e: Ast.Expression): void => {
      switch (e._tag) {
        case 'Variable':
          if (!allowed.has(e.value)) fail(`Variable ?${e.value} is not grouped`, offset);
          return;
        case 'Operation':
        case 'FunctionCall':
          e.args.forEach(checkExpr);
          return;
        case 'Triple':
          for (const v of Ast.expressionVariables(e)) {
            if (!allowed.has(v)) fail(`Variable ?${v} is not grouped`, offset);
          }
          return;
        default:
          return;
      }
    };
    for (const item of query.projection as ReadonlyArray<Term.Variable | Ast.Projection>) {
      if (item._tag === 'Variable') {
        if (!allowed.has(item.value)) fail(`Variable ?${item.value} is not grouped`, offset);
      } else {
        checkExpr(item.expression);
        allowed.add(item.variable.value);
      }
    }
  }

  // --- graph patterns -------------------------------------------------------

  patternContext(paths: boolean): TripleContext {
    return {
      paths,
      variables: true,
      blankNodes: true,
      scope: ++this.scopeCounter,
      labels: this.patternLabels,
    };
  }

  groupGraphPattern(): Ast.GroupPattern {
    this.expectPunct('{');
    if (this.isWord('SELECT')) {
      const savedAgg = this.aggregatesAllowed;
      this.aggregatesAllowed = false;
      const query = this.selectQuery(this.prologueValue(), true);
      const values = this.valuesClause();
      this.aggregatesAllowed = savedAgg;
      this.expectPunct('}');
      const sub = values !== undefined ? { ...query, values } : query;
      this.validateSelect(sub, this.tok.start);
      return Ast.group([Ast.subSelect(sub)]);
    }
    const patterns: Array<Ast.Pattern> = [];
    let ctx = this.patternContext(true);
    let afterTriplesWithoutDot = false;
    while (!this.isPunct('}')) {
      if (this.startsGraphPatternNotTriples()) {
        const start = this.tok.start;
        const p = this.graphPatternNotTriples();
        if (p._tag === 'Bind') {
          const inScope = new Set<string>();
          for (const q of patterns) for (const v of Ast.inScopeVariables(q)) inScope.add(v);
          if (inScope.has(p.variable.value)) {
            fail(`BIND variable ?${p.variable.value} is already in scope`, start);
          }
        }
        patterns.push(p);
        if (p._tag !== 'Filter') ctx = this.patternContext(true);
        this.eatPunct('.');
        afterTriplesWithoutDot = false;
        continue;
      }
      if (afterTriplesWithoutDot) this.unexpected("'.' or '}'");
      if (!this.startsTriples()) this.unexpected();
      const triples: Triples = [];
      const endedWithDot = this.triplesBlock(triples, ctx);
      const last = patterns[patterns.length - 1];
      if (last !== undefined && last._tag === 'Bgp') {
        patterns[patterns.length - 1] = Ast.bgp([...last.triples, ...triples]);
      } else patterns.push(Ast.bgp(triples));
      afterTriplesWithoutDot = !endedWithDot;
    }
    this.expectPunct('}');
    return Ast.group(patterns);
  }

  startsGraphPatternNotTriples(): boolean {
    if (this.isPunct('{')) return true;
    return this.type() === 'WORD' && KEYWORD_STARTS_GPNT.has(this.tok.value.toUpperCase());
  }

  graphPatternNotTriples(): Ast.Pattern {
    if (this.isPunct('{')) {
      const first = this.groupGraphPattern();
      if (!this.isWord('UNION')) return first;
      const groups = [first];
      while (this.eatWord('UNION')) groups.push(this.groupGraphPattern());
      return Ast.union(groups);
    }
    const word = this.advance().value.toUpperCase();
    switch (word) {
      case 'OPTIONAL':
        return Ast.optional(this.groupGraphPattern());
      case 'MINUS':
        return Ast.minus(this.groupGraphPattern());
      case 'GRAPH': {
        const name = this.varOrIri();
        return Ast.graph(name, this.groupGraphPattern());
      }
      case 'SERVICE': {
        const silent = this.eatWord('SILENT');
        const name = this.varOrIri();
        return Ast.service(name, this.groupGraphPattern(), silent);
      }
      case 'FILTER':
        return Ast.filter(this.constraint());
      case 'BIND': {
        this.expectPunct('(');
        const expression = this.expression();
        this.expectWord('AS');
        const variable = this.variable();
        this.expectPunct(')');
        return Ast.bind(expression, variable);
      }
      case 'VALUES':
        return this.dataBlock();
      default:
        return this.unexpected();
    }
  }

  varOrIri(): Ast.VarOrIri {
    return this.type() === 'VAR' ? this.variable() : this.iri();
  }

  dataBlock(): Ast.ValuesPattern {
    const variables: Array<Term.Variable> = [];
    const rows: Array<Array<Term.GroundTerm | undefined>> = [];
    if (this.type() === 'VAR') {
      variables.push(this.variable());
      this.expectPunct('{');
      while (!this.isPunct('}')) rows.push([this.dataBlockValue()]);
      this.expectPunct('}');
      return Ast.values(variables, rows);
    }
    this.expectPunct('(');
    while (this.type() === 'VAR') {
      const v = this.variable();
      if (variables.some((x) => x.value === v.value)) {
        fail(`Duplicate variable ?${v.value} in VALUES`, this.tok.start);
      }
      variables.push(v);
    }
    this.expectPunct(')');
    this.expectPunct('{');
    while (!this.isPunct('}')) {
      const start = this.tok.start;
      this.expectPunct('(');
      const row: Array<Term.GroundTerm | undefined> = [];
      while (!this.isPunct(')')) row.push(this.dataBlockValue());
      this.advance();
      if (row.length !== variables.length) {
        fail(`VALUES row has ${row.length} values but ${variables.length} variables`, start);
      }
      rows.push(row);
    }
    this.expectPunct('}');
    return Ast.values(variables, rows);
  }

  dataBlockValue(): Term.GroundTerm | undefined {
    if (this.eatWord('UNDEF')) return undefined;
    if (this.isPunct('<<(')) return this.tripleTermData();
    return this.dataTerm();
  }

  /** iri | RDFLiteral | NumericLiteral | BooleanLiteral */
  dataTerm(): Term.NamedNode | Term.Literal {
    if (this.isIriStart()) return this.iri();
    if (this.type() === 'STRING') return this.rdfLiteral();
    if (this.isNumberToken()) return this.numericLiteral();
    const signed = this.signedNumber();
    if (signed !== undefined) return signed;
    const bool = this.booleanLiteral();
    if (bool !== undefined) return bool;
    return this.unexpected('an RDF term');
  }

  tripleTermData(): Term.Triple {
    this.expectPunct('<<(');
    const subject = this.iri();
    const predicate =
      this.isWord('a') && this.tok.value === 'a' ? (this.advance(), rdfType) : this.iri();
    const object = this.isPunct('<<(') ? this.tripleTermData() : this.dataTerm();
    this.expectPunct(')>>');
    return Term.triple(subject, predicate, object);
  }

  // --- triples --------------------------------------------------------------

  startsTriples(): boolean {
    const t = this.tok;
    switch (t.type) {
      case 'VAR':
      case 'IRI':
      case 'PNAME':
      case 'BNODE':
      case 'STRING':
      case 'INTEGER':
      case 'DECIMAL':
      case 'DOUBLE':
        return true;
      case 'WORD':
        return t.value.toLowerCase() === 'true' || t.value.toLowerCase() === 'false';
      case 'PUNCT':
        return (
          t.value === '(' ||
          t.value === '[' ||
          t.value === '<<' ||
          t.value === '<<(' ||
          ((t.value === '+' || t.value === '-') && this.isNumberToken(this.peek2()))
        );
      default:
        return false;
    }
  }

  /** TriplesBlock: returns whether it ended with a '.' */
  triplesBlock(out: Triples, ctx: TripleContext): boolean {
    for (;;) {
      this.triplesSameSubject(out, ctx);
      if (!this.eatPunct('.')) return false;
      if (!this.startsTriples()) return true;
    }
  }

  /** TriplesTemplate / ConstructTriples (no paths); stops before `end`. */
  triplesTemplate(out: Triples, ctx: TripleContext, end: string): void {
    while (!this.isPunct(end)) {
      if (!this.startsTriples()) return;
      this.triplesSameSubject(out, ctx);
      if (!this.eatPunct('.')) return;
    }
  }

  constructTemplate(): Array<Ast.TriplePattern> {
    this.expectPunct('{');
    const out: Triples = [];
    const ctx: TripleContext = {
      paths: false,
      variables: true,
      blankNodes: true,
      scope: ++this.scopeCounter,
      labels: this.templateLabels,
    };
    this.triplesTemplate(out, ctx, '}');
    this.expectPunct('}');
    return out as Array<Ast.TriplePattern>;
  }

  triplesSameSubject(out: Triples, ctx: TripleContext): void {
    const startTok = this.tok;
    if (this.isPunct('<<')) {
      const subject = this.reifiedTriple(out, ctx);
      if (this.startsVerb(ctx)) this.propertyList(subject, out, ctx);
      return;
    }
    if ((this.isPunct('(') && !this.isNil()) || (this.isPunct('[') && !this.isAnon())) {
      const subject = this.triplesNode(out, ctx);
      if (this.startsVerb(ctx)) this.propertyList(subject, out, ctx);
      return;
    }
    const subject = this.varOrTerm(ctx);
    if (!this.startsVerb(ctx)) {
      this.unexpected(`a predicate after ${this.describe(startTok)}`);
    }
    this.propertyList(subject, out, ctx);
  }

  startsVerb(ctx: TripleContext): boolean {
    const t = this.tok;
    if (t.type === 'VAR' || t.type === 'IRI' || t.type === 'PNAME') return true;
    if (t.type === 'WORD' && t.value === 'a') return true;
    if (ctx.paths && t.type === 'PUNCT' && (t.value === '^' || t.value === '!' || t.value === '('))
      return true;
    return false;
  }

  propertyList(subject: Ast.TermPattern, out: Triples, ctx: TripleContext): void {
    for (;;) {
      const { predicate, simple } = this.verb(ctx);
      this.objectList(subject, predicate, simple, out, ctx);
      if (!this.isPunct(';')) return;
      while (this.eatPunct(';'));
      if (!this.startsVerb(ctx)) return;
    }
  }

  verb(ctx: TripleContext): { predicate: Ast.VarOrIri | Ast.Path; simple: boolean } {
    if (this.type() === 'VAR') {
      if (!ctx.variables) fail('Variables are not allowed here', this.tok.start);
      const v = this.variable();
      if (ctx.paths && this.isPathContinuation()) {
        // ?p is a "VerbSimple"; it cannot start a longer path.
        this.unexpected();
      }
      return { predicate: v, simple: true };
    }
    if (!ctx.paths) {
      if (this.type() === 'WORD' && this.tok.value === 'a') {
        this.advance();
        return { predicate: rdfType, simple: true };
      }
      return { predicate: this.iri(), simple: true };
    }
    const path = this.path();
    if (path._tag === 'PathLink') return { predicate: path.iri, simple: true };
    return { predicate: path, simple: false };
  }

  isPathContinuation(): boolean {
    return this.isPunct('/') || this.isPunct('|');
  }

  objectList(
    subject: Ast.TermPattern,
    predicate: Ast.VarOrIri | Ast.Path,
    simple: boolean,
    out: Triples,
    ctx: TripleContext,
  ): void {
    for (;;) {
      const object = this.graphNode(out, ctx);
      const triple: Ast.TriplePattern | Ast.PathPattern = Ast.isPath(predicate)
        ? Ast.pathPattern(subject, predicate, object)
        : Ast.triplePattern(subject, predicate, object);
      out.push(triple);
      if (this.isPunct('~') || this.isPunct('{|')) {
        if (!simple || triple._tag !== 'TriplePattern') {
          return fail('Reifiers and annotations require a simple predicate', this.tok.start);
        }
        this.annotation(triple, out, ctx);
      }
      if (!this.eatPunct(',')) return;
    }
  }

  annotation(triple: Ast.TriplePattern, out: Triples, ctx: TripleContext): void {
    const tripleTerm = Term.triple(
      triple.subject as any,
      triple.predicate as any,
      triple.object as any,
    );
    let current: Ast.TermPattern | undefined;
    for (;;) {
      if (this.isPunct('~')) {
        current = this.reifier(ctx);
        out.push(Ast.triplePattern(current, rdfReifies, tripleTerm));
      } else if (this.isPunct('{|')) {
        this.advance();
        if (current === undefined) {
          current = this.freshPatternBlankNode(ctx);
          out.push(Ast.triplePattern(current, rdfReifies, tripleTerm));
        }
        this.propertyList(current, out, ctx);
        this.expectPunct('|}');
        current = undefined;
      } else return;
    }
  }

  freshPatternBlankNode(ctx: TripleContext): Term.BlankNode {
    if (!ctx.blankNodes) fail('Blank nodes are not allowed here', this.tok.start);
    return this.freshBlankNode();
  }

  reifier(ctx: TripleContext): Ast.TermPattern {
    this.expectPunct('~');
    if (this.type() === 'VAR') {
      if (!ctx.variables) fail('Variables are not allowed here', this.tok.start);
      return this.variable();
    }
    if (this.isIriStart()) return this.iri();
    if (this.type() === 'BNODE') return this.blankNodeLabel(ctx);
    if (this.isAnon()) {
      this.advance();
      this.advance();
      return this.freshPatternBlankNode(ctx);
    }
    return this.freshPatternBlankNode(ctx);
  }

  reifiedTriple(out: Triples, ctx: TripleContext): Ast.TermPattern {
    this.expectPunct('<<');
    const subject = this.reifiedTripleComponent(out, ctx);
    let predicate: Ast.VarOrIri;
    if (this.type() === 'VAR') {
      if (!ctx.variables) fail('Variables are not allowed here', this.tok.start);
      predicate = this.variable();
    } else if (this.type() === 'WORD' && this.tok.value === 'a') {
      this.advance();
      predicate = rdfType;
    } else predicate = this.iri();
    const object = this.reifiedTripleComponent(out, ctx);
    const reifier = this.isPunct('~') ? this.reifier(ctx) : this.freshPatternBlankNode(ctx);
    this.expectPunct('>>');
    out.push(
      Ast.triplePattern(
        reifier,
        rdfReifies,
        Term.triple(subject as any, predicate as any, object as any),
      ),
    );
    return reifier;
  }

  reifiedTripleComponent(out: Triples, ctx: TripleContext): Ast.TermPattern {
    if (this.isPunct('<<')) return this.reifiedTriple(out, ctx);
    if (this.isPunct('<<(')) return this.tripleTerm(ctx);
    if (this.isPunct('(') || (this.isPunct('[') && !this.isAnon())) this.unexpected();
    return this.varOrTerm(ctx, false);
  }

  tripleTerm(ctx: TripleContext): Term.Triple<any, any, any> {
    this.expectPunct('<<(');
    const component = (): Ast.TermPattern => {
      if (this.isPunct('<<(')) return this.tripleTerm(ctx);
      if (this.isPunct('(') || this.isPunct('<<') || (this.isPunct('[') && !this.isAnon())) {
        this.unexpected();
      }
      return this.varOrTerm(ctx, false);
    };
    const subject = component();
    let predicate: Ast.VarOrIri;
    if (this.type() === 'VAR') {
      if (!ctx.variables) fail('Variables are not allowed here', this.tok.start);
      predicate = this.variable();
    } else if (this.type() === 'WORD' && this.tok.value === 'a') {
      this.advance();
      predicate = rdfType;
    } else predicate = this.iri();
    const object = component();
    this.expectPunct(')>>');
    return Term.triple(subject as any, predicate as any, object as any);
  }

  /** GraphNode / GraphNodePath */
  graphNode(out: Triples, ctx: TripleContext): Ast.TermPattern {
    if (this.isPunct('<<')) return this.reifiedTriple(out, ctx);
    if ((this.isPunct('(') && !this.isNil()) || (this.isPunct('[') && !this.isAnon())) {
      return this.triplesNode(out, ctx);
    }
    return this.varOrTerm(ctx);
  }

  triplesNode(out: Triples, ctx: TripleContext): Ast.TermPattern {
    if (this.eatPunct('[')) {
      const node = this.freshPatternBlankNode(ctx);
      this.propertyList(node, out, ctx);
      this.expectPunct(']');
      return node;
    }
    this.expectPunct('(');
    const items: Array<Ast.TermPattern> = [];
    while (!this.isPunct(')')) items.push(this.graphNode(out, ctx));
    this.advance();
    if (items.length === 0) return rdfNil;
    const nodes = items.map(() => this.freshPatternBlankNode(ctx));
    items.forEach((item, i) => {
      out.push(Ast.triplePattern(nodes[i]!, rdfFirst, item));
      out.push(Ast.triplePattern(nodes[i]!, rdfRest, nodes[i + 1] ?? rdfNil));
    });
    return nodes[0]!;
  }

  varOrTerm(ctx: TripleContext, allowNil = true): Ast.TermPattern {
    const t = this.tok;
    switch (t.type) {
      case 'VAR':
        if (!ctx.variables) fail('Variables are not allowed here', t.start);
        return this.variable();
      case 'IRI':
      case 'PNAME':
        return this.iri();
      case 'BNODE':
        return this.blankNodeLabel(ctx);
      case 'STRING':
        return this.rdfLiteral();
      case 'INTEGER':
      case 'DECIMAL':
      case 'DOUBLE':
        return this.numericLiteral();
      case 'WORD': {
        const b = this.booleanLiteral();
        if (b !== undefined) return b;
        break;
      }
      case 'PUNCT': {
        if (t.value === '+' || t.value === '-') {
          const n = this.signedNumber();
          if (n !== undefined) return n;
        }
        if (t.value === '(' && allowNil && this.isNil()) {
          this.advance();
          this.advance();
          return rdfNil;
        }
        if (t.value === '[' && this.isAnon()) {
          this.advance();
          this.advance();
          return this.freshPatternBlankNode(ctx);
        }
        if (t.value === '<<(') return this.tripleTerm(ctx);
        break;
      }
      default:
        break;
    }
    return this.unexpected('an RDF term or variable');
  }

  // --- property paths -------------------------------------------------------

  path(): Ast.Path {
    const first = this.pathSequence();
    if (!this.isPunct('|')) return first;
    const paths = [first];
    while (this.eatPunct('|')) paths.push(this.pathSequence());
    return Ast.alternative(...paths);
  }

  pathSequence(): Ast.Path {
    const first = this.pathEltOrInverse();
    if (!this.isPunct('/')) return first;
    const paths = [first];
    while (this.eatPunct('/')) paths.push(this.pathEltOrInverse());
    return Ast.sequence(...paths);
  }

  pathEltOrInverse(): Ast.Path {
    if (this.eatPunct('^')) return Ast.inverse(this.pathElt());
    return this.pathElt();
  }

  pathElt(): Ast.Path {
    const primary = this.pathPrimary();
    if (this.isPunct('?') || this.isPunct('*') || this.isPunct('+')) {
      // `?x` would have been lexed as a variable, so a bare '?' is a modifier.
      const mod = this.advance().value;
      return mod === '?'
        ? Ast.zeroOrOne(primary)
        : mod === '*'
          ? Ast.zeroOrMore(primary)
          : Ast.oneOrMore(primary);
    }
    return primary;
  }

  pathPrimary(): Ast.Path {
    if (this.type() === 'WORD' && this.tok.value === 'a') {
      this.advance();
      return Ast.link(rdfType);
    }
    if (this.isIriStart()) return Ast.link(this.iri());
    if (this.eatPunct('!')) return this.pathNegatedPropertySet();
    if (this.eatPunct('(')) {
      const p = this.path();
      this.expectPunct(')');
      return p;
    }
    return this.unexpected('a property path');
  }

  pathNegatedPropertySet(): Ast.Path {
    const iris: Array<Term.NamedNode> = [];
    const inverse: Array<Term.NamedNode> = [];
    const one = (): void => {
      const inv = this.eatPunct('^');
      let iri: Term.NamedNode;
      if (this.type() === 'WORD' && this.tok.value === 'a') {
        this.advance();
        iri = rdfType;
      } else iri = this.iri();
      (inv ? inverse : iris).push(iri);
    };
    if (this.eatPunct('(')) {
      if (!this.isPunct(')')) {
        one();
        while (this.eatPunct('|')) one();
      }
      this.expectPunct(')');
    } else one();
    return Ast.negated(iris, inverse);
  }

  // --- expressions ----------------------------------------------------------

  constraint(): Ast.Expression {
    if (this.isPunct('(')) return this.brackettedExpression();
    if (this.startsBuiltIn()) return this.builtInCall();
    if (this.isIriStart()) {
      const iri = this.iri();
      if (!this.isPunct('(')) this.unexpected("'('");
      return this.functionCall(iri);
    }
    return this.unexpected('a constraint');
  }

  brackettedExpression(): Ast.Expression {
    this.expectPunct('(');
    const e = this.expression();
    this.expectPunct(')');
    return e;
  }

  expression(): Ast.Expression {
    let left = this.conditionalAnd();
    while (this.eatPunct('||')) left = Ast.operation('||', left, this.conditionalAnd());
    return left;
  }

  conditionalAnd(): Ast.Expression {
    let left = this.relational();
    while (this.eatPunct('&&')) left = Ast.operation('&&', left, this.relational());
    return left;
  }

  relational(): Ast.Expression {
    const left = this.additive();
    const t = this.tok;
    if (t.type === 'PUNCT') {
      switch (t.value) {
        case '=':
        case '!=':
        case '<':
        case '>':
        case '<=':
        case '>=':
          this.advance();
          return Ast.operation(t.value, left, this.additive());
      }
    }
    if (this.isWord('IN')) {
      this.advance();
      return Ast.operation('IN', left, ...this.expressionList());
    }
    if (this.isWord('NOT')) {
      const next = this.peek2();
      if (next.type === 'WORD' && next.value.toUpperCase() === 'IN') {
        this.advance();
        this.advance();
        return Ast.operation('NOT IN', left, ...this.expressionList());
      }
    }
    return left;
  }

  expressionList(): Array<Ast.Expression> {
    this.expectPunct('(');
    const out: Array<Ast.Expression> = [];
    if (this.eatPunct(')')) return out;
    out.push(this.expression());
    while (this.eatPunct(',')) out.push(this.expression());
    this.expectPunct(')');
    return out;
  }

  additive(): Ast.Expression {
    let left = this.multiplicative();
    for (;;) {
      // `?a +1` and `?a -1` (signed numbers in the grammar) are additions and
      // subtractions of the unsigned number, which is what this produces.
      if (this.isPunct('+') || this.isPunct('-')) {
        const op = this.advance().value as '+' | '-';
        left = Ast.operation(op, left, this.multiplicative());
      } else return left;
    }
  }

  multiplicative(): Ast.Expression {
    let left = this.unary();
    for (;;) {
      if (this.isPunct('*') || this.isPunct('/')) {
        const op = this.advance().value as '*' | '/';
        left = Ast.operation(op, left, this.unary());
      } else return left;
    }
  }

  unary(): Ast.Expression {
    if (this.eatPunct('!')) return Ast.operation('!', this.unary());
    if (this.isPunct('+') || this.isPunct('-')) {
      const signed = this.signedNumber();
      if (signed !== undefined) return signed;
      const op = this.advance().value;
      return Ast.operation(op === '+' ? 'UPLUS' : 'UMINUS', this.primary());
    }
    return this.primary();
  }

  primary(): Ast.Expression {
    const t = this.tok;
    switch (t.type) {
      case 'VAR':
        return this.variable();
      case 'IRI':
      case 'PNAME': {
        const iri = this.iri();
        if (this.isPunct('(')) return this.functionCall(iri);
        return iri;
      }
      case 'STRING':
        return this.rdfLiteral();
      case 'INTEGER':
      case 'DECIMAL':
      case 'DOUBLE':
        return this.numericLiteral();
      case 'WORD': {
        const b = this.booleanLiteral();
        if (b !== undefined) return b;
        if (this.startsBuiltIn()) return this.builtInCall();
        break;
      }
      case 'PUNCT':
        if (t.value === '(') return this.brackettedExpression();
        if (t.value === '<<(') return this.exprTripleTerm();
        break;
      default:
        break;
    }
    return this.unexpected('an expression');
  }

  exprTripleTerm(): Term.Triple<any, any, any> {
    this.expectPunct('<<(');
    const subject = this.type() === 'VAR' ? this.variable() : this.iri();
    let predicate: Ast.VarOrIri;
    if (this.type() === 'WORD' && this.tok.value === 'a') {
      this.advance();
      predicate = rdfType;
    } else predicate = this.varOrIri();
    let object: Ast.TermPattern;
    if (this.isPunct('<<(')) object = this.exprTripleTerm();
    else if (this.type() === 'VAR') object = this.variable();
    else object = this.dataTerm();
    this.expectPunct(')>>');
    return Term.triple(subject as any, predicate as any, object as any);
  }

  functionCall(iri: Term.NamedNode): Ast.Expression {
    if (this.isNil()) {
      this.advance();
      this.advance();
      return Ast.functionCall(iri, []);
    }
    this.expectPunct('(');
    let distinct = false;
    if (this.isWord('DISTINCT')) {
      if (!this.aggregatesAllowed || this.inAggregate) {
        fail('DISTINCT is only allowed in aggregate function calls', this.tok.start);
      }
      this.advance();
      distinct = true;
    }
    const args = [this.expression()];
    while (this.eatPunct(',')) args.push(this.expression());
    this.expectPunct(')');
    return Ast.functionCall(iri, args, distinct);
  }

  startsBuiltIn(): boolean {
    if (this.type() !== 'WORD') return false;
    const w = this.tok.value.toUpperCase();
    return Ast.isBuiltInName(w) || AGGREGATES.has(w) || w === 'EXISTS' || w === 'NOT';
  }

  builtInCall(): Ast.Expression {
    const t = this.advance();
    const name = t.value.toUpperCase();
    if (AGGREGATES.has(name)) return this.aggregate(name as Ast.AggregateName, t);
    if (name === 'EXISTS') return Ast.exists(this.groupGraphPatternInExpression(), false);
    if (name === 'NOT') {
      this.expectWord('EXISTS');
      return Ast.exists(this.groupGraphPatternInExpression(), true);
    }
    const builtIn = name as Ast.BuiltInName;
    if (builtIn === 'BOUND') {
      this.expectPunct('(');
      const v = this.variable();
      this.expectPunct(')');
      return Ast.operation('BOUND', v);
    }
    if (builtIn === 'CONCAT' || builtIn === 'COALESCE') {
      return Ast.operation(builtIn, ...this.expressionList());
    }
    const [min, max] = Ast.builtInArity[builtIn];
    if (max === 0 || (min === 0 && this.isNil())) {
      // NIL form, e.g. RAND(), NOW(), BNODE()
      if (!this.isNil()) this.unexpected("'()'");
      this.advance();
      this.advance();
      return Ast.operation(builtIn);
    }
    const args = this.expressionList();
    if (args.length < min || args.length > max) {
      fail(`${builtIn} expects ${min === max ? min : `${min} to ${max}`} arguments`, t.start);
    }
    return Ast.operation(builtIn, ...args);
  }

  groupGraphPatternInExpression(): Ast.GroupPattern {
    const savedAgg = this.aggregatesAllowed;
    const savedIn = this.inAggregate;
    this.aggregatesAllowed = false;
    this.inAggregate = false;
    try {
      return this.groupGraphPattern();
    } finally {
      this.aggregatesAllowed = savedAgg;
      this.inAggregate = savedIn;
    }
  }

  aggregate(name: Ast.AggregateName, t: Token): Ast.Expression {
    if (!this.aggregatesAllowed) fail(`Aggregate ${name} is not allowed here`, t.start);
    if (this.inAggregate) fail('Aggregates cannot be nested', t.start);
    this.expectPunct('(');
    const distinct = this.eatWord('DISTINCT');
    this.inAggregate = true;
    try {
      if (name === 'COUNT' && this.eatPunct('*')) {
        this.expectPunct(')');
        return Ast.aggregate('COUNT', '*', { distinct });
      }
      const expression = this.expression();
      let separator: string | undefined;
      if (name === 'GROUP_CONCAT' && this.eatPunct(';')) {
        this.expectWord('SEPARATOR');
        this.expectPunct('=');
        separator = this.string().value;
      }
      this.expectPunct(')');
      return Ast.aggregate(name, expression, {
        distinct,
        ...(separator !== undefined ? { separator } : {}),
      });
    } finally {
      this.inAggregate = false;
    }
  }

  // --- updates --------------------------------------------------------------

  updateUnit(): Ast.Update {
    const operations: Array<Ast.UpdateOperation> = [];
    this.prologue();
    let opIndex = 0;
    while (this.type() !== 'EOF') {
      operations.push(this.update1(opIndex++));
      if (this.type() === 'EOF') break;
      this.expectPunct(';');
      this.prologue();
    }
    return Ast.update(operations, this.prologueValue());
  }

  update1(opIndex: number): Ast.UpdateOperation {
    if (this.type() !== 'WORD') this.unexpected('an update operation');
    const word = this.tok.value.toUpperCase();
    switch (word) {
      case 'LOAD': {
        this.advance();
        const silent = this.eatWord('SILENT');
        const source = this.iri();
        if (this.eatWord('INTO')) {
          this.expectWord('GRAPH');
          return { _tag: 'Load', silent, source, destination: this.iri() };
        }
        return { _tag: 'Load', silent, source };
      }
      case 'CLEAR':
      case 'DROP': {
        this.advance();
        const silent = this.eatWord('SILENT');
        const target = this.graphRefAll();
        return { _tag: word === 'CLEAR' ? 'Clear' : 'Drop', silent, target };
      }
      case 'CREATE': {
        this.advance();
        const silent = this.eatWord('SILENT');
        this.expectWord('GRAPH');
        return { _tag: 'Create', silent, graph: this.iri() };
      }
      case 'ADD':
      case 'MOVE':
      case 'COPY': {
        this.advance();
        const silent = this.eatWord('SILENT');
        const source = this.graphOrDefault();
        this.expectWord('TO');
        const destination = this.graphOrDefault();
        const tag = word === 'ADD' ? 'Add' : word === 'MOVE' ? 'Move' : 'Copy';
        return { _tag: tag, silent, source, destination };
      }
      case 'INSERT': {
        this.advance();
        if (this.eatWord('DATA')) {
          return { _tag: 'InsertData', quads: this.quadData(opIndex, true) };
        }
        return this.modify(undefined, opIndex);
      }
      case 'DELETE': {
        if (this.peek2().type === 'WORD' && this.peek2().value.toUpperCase() === 'DATA') {
          this.advance();
          this.advance();
          return { _tag: 'DeleteData', quads: this.quadData(opIndex, false) };
        }
        if (this.peek2().type === 'WORD' && this.peek2().value.toUpperCase() === 'WHERE') {
          this.advance();
          this.advance();
          const ctx: TripleContext = {
            paths: false,
            variables: true,
            blankNodes: false,
            scope: ++this.scopeCounter,
            labels: this.patternLabels,
          };
          return { _tag: 'DeleteWhere', patterns: this.quadPattern(ctx) };
        }
        this.advance();
        return this.modify(undefined, opIndex, true);
      }
      case 'WITH': {
        this.advance();
        const iri = this.iri();
        if (this.eatWord('DELETE')) return this.modify(iri, opIndex, true);
        this.expectWord('INSERT');
        return this.modify(iri, opIndex);
      }
      default:
        return this.unexpected('an update operation');
    }
  }

  graphRefAll(): Ast.GraphTarget {
    if (this.eatWord('DEFAULT')) return { _tag: 'Default' };
    if (this.eatWord('NAMED')) return { _tag: 'Named' };
    if (this.eatWord('ALL')) return { _tag: 'All' };
    this.expectWord('GRAPH');
    return this.iri();
  }

  graphOrDefault(): Ast.GraphOrDefault {
    if (this.eatWord('DEFAULT')) return Term.defaultGraph;
    this.eatWord('GRAPH');
    return this.iri();
  }

  /** `DELETE` (already consumed when `deleteFirst`) … `INSERT` … `WHERE` */
  modify(
    withIri: Term.NamedNode | undefined,
    opIndex: number,
    deleteFirst = false,
  ): Ast.ModifyOperation {
    let del: Array<Ast.QuadPattern> = [];
    let ins: Array<Ast.QuadPattern> = [];
    const templateCtx = (blankNodes: boolean): TripleContext => ({
      paths: false,
      variables: true,
      blankNodes,
      scope: opIndex,
      labels: this.templateLabels,
    });
    if (deleteFirst) {
      del = this.quadPattern(templateCtx(false));
      if (this.eatWord('INSERT')) ins = this.quadPattern(templateCtx(true));
    } else {
      ins = this.quadPattern(templateCtx(true));
    }
    const def: Array<Term.NamedNode> = [];
    const named: Array<Term.NamedNode> = [];
    let using = false;
    while (this.eatWord('USING')) {
      using = true;
      if (this.eatWord('NAMED')) named.push(this.iri());
      else def.push(this.iri());
    }
    this.expectWord('WHERE');
    const where = this.groupGraphPattern();
    return {
      _tag: 'Modify',
      ...(withIri !== undefined ? { with: withIri } : {}),
      delete: del,
      insert: ins,
      ...(using ? { using: { default: def, named } } : {}),
      where,
    };
  }

  quadPattern(ctx: TripleContext): Array<Ast.QuadPattern> {
    this.expectPunct('{');
    const out: Array<Ast.QuadPattern> = [];
    const add = (triples: Triples, graph: Ast.QuadPattern['graph']) => {
      for (const t of triples) {
        const tp = t as Ast.TriplePattern;
        out.push(Ast.quadPattern(tp.subject, tp.predicate, tp.object, graph));
      }
    };
    for (;;) {
      if (this.isPunct('}')) break;
      if (this.isWord('GRAPH')) {
        this.advance();
        if (this.type() === 'VAR' && !ctx.variables) {
          fail('Variables are not allowed here', this.tok.start);
        }
        const g = this.varOrIri();
        this.expectPunct('{');
        const triples: Triples = [];
        this.triplesTemplate(triples, ctx, '}');
        this.expectPunct('}');
        add(triples, g);
        this.eatPunct('.');
        continue;
      }
      if (!this.startsTriples()) this.unexpected();
      const triples: Triples = [];
      this.triplesTemplate(triples, ctx, '}');
      add(triples, Term.defaultGraph);
      if (!this.isPunct('}') && !this.isWord('GRAPH')) this.unexpected("'.' or '}'");
    }
    this.expectPunct('}');
    return out;
  }

  quadData(opIndex: number, blankNodes: boolean): Array<Term.Quad> {
    const ctx: TripleContext = {
      paths: false,
      variables: false,
      blankNodes,
      scope: opIndex,
      labels: this.templateLabels,
    };
    return this.quadPattern(ctx).map(
      (q) => new Term.Quad(q.subject as any, q.predicate as any, q.object as any, q.graph as any),
    );
  }
}

// -----------------------------------------------------------------------------
// Entry points
// -----------------------------------------------------------------------------

const position = (input: string, offset: number): { line: number; column: number } => {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < input.length; i++) {
    if (input[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
};

const run = <A>(
  input: string,
  options: ParseOptions | undefined,
  f: (p: SparqlParser) => A,
): Result.Result<A, SparqlParseError> => {
  try {
    const parser = new SparqlParser(input, options);
    return Result.succeed(f(parser));
  } catch (e) {
    if (e instanceof Failure) {
      const { line, column } = position(input, e.offset);
      return Result.fail(
        new SparqlParseError({
          message: `${e.message} (line ${line}, column ${column})`,
          line,
          column,
          offset: e.offset,
        }),
      );
    }
    throw e;
  }
};

/**
 * Parses a SPARQL query, returning a `Result`.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseQueryResult = (
  input: string,
  options?: ParseOptions,
): Result.Result<Ast.Query, SparqlParseError> => run(input, options, (p) => p.queryUnit());

/**
 * Parses a SPARQL update request, returning a `Result`.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseUpdateResult = (
  input: string,
  options?: ParseOptions,
): Result.Result<Ast.Update, SparqlParseError> => run(input, options, (p) => p.updateUnit());

/**
 * Parses a SPARQL query.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseQuery = (
  input: string,
  options?: ParseOptions,
): Effect.Effect<Ast.Query, SparqlParseError> =>
  Effect.suspend(() => Effect.fromResult(parseQueryResult(input, options)));

/**
 * Parses a SPARQL update request.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseUpdate = (
  input: string,
  options?: ParseOptions,
): Effect.Effect<Ast.Update, SparqlParseError> =>
  Effect.suspend(() => Effect.fromResult(parseUpdateResult(input, options)));

/**
 * Parses either a query or an update request: the text is parsed as a query
 * first and, if that fails, as an update.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (
  input: string,
  options?: ParseOptions,
): Effect.Effect<Ast.Query | Ast.Update, SparqlParseError> =>
  Effect.suspend((): Effect.Effect<Ast.Query | Ast.Update, SparqlParseError> => {
    const q = parseQueryResult(input, options);
    if (Result.isSuccess(q)) return Effect.succeed(q.success);
    const u = parseUpdateResult(input, options);
    if (Result.isSuccess(u)) return Effect.succeed(u.success);
    // Report the error of the parse that got further.
    return Effect.fail(q.failure.offset >= u.failure.offset ? q.failure : u.failure);
  });

/**
 * Parses a SPARQL query, throwing a `SparqlParseError` on failure.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseQueryUnsafe = (input: string, options?: ParseOptions): Ast.Query => {
  const r = parseQueryResult(input, options);
  if (Result.isFailure(r)) throw r.failure;
  return r.success;
};

/**
 * Parses a SPARQL update request, throwing a `SparqlParseError` on failure.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseUpdateUnsafe = (input: string, options?: ParseOptions): Ast.Update => {
  const r = parseUpdateResult(input, options);
  if (Result.isFailure(r)) throw r.failure;
  return r.success;
};
