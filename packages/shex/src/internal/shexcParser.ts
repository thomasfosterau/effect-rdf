/**
 * A hand-written recursive-descent parser for the ShEx compact syntax
 * (ShExC), producing ShExJ. The construction of ShExJ objects mirrors the
 * reference grammar (shex.js `ShExJison.jison`) so that the output matches
 * the ShExJ representations of the shexTest suite.
 *
 * @internal
 */
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import type * as ShExJ from '../ShExJ.ts';
import {
  Failure,
  matchAt,
  RE,
  unescapeCode,
  unescapeLocal,
  unescapeRegexp,
  unescapeString,
  unescapeUchar,
} from './lexer.ts';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_INTEGER = `${XSD}integer`;
const XSD_DECIMAL = `${XSD}decimal`;
const XSD_DOUBLE = `${XSD}double`;
const XSD_FLOAT = `${XSD}float`;
const XSD_BOOLEAN = `${XSD}boolean`;

const numericDatatypes = new Set(
  [
    'integer',
    'decimal',
    'float',
    'double',
    'string',
    'boolean',
    'dateTime',
    'nonPositiveInteger',
    'negativeInteger',
    'long',
    'int',
    'short',
    'byte',
    'nonNegativeInteger',
    'unsignedLong',
    'unsignedInt',
    'unsignedShort',
    'unsignedByte',
    'positiveInteger',
  ].map((l) => XSD + l),
);

const numericFacetNames = ['mininclusive', 'minexclusive', 'maxinclusive', 'maxexclusive'];

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

type TokenType =
  | 'ATPNAME_LN'
  | 'ATPNAME_NS'
  | 'LANGTAG'
  | 'PNAME_LN'
  | 'PNAME_NS'
  | 'DOUBLE'
  | 'DECIMAL'
  | 'INTEGER'
  | 'IRIREF'
  | 'REGEXP'
  | 'BLANK_NODE_LABEL'
  | 'STRING'
  | 'LANG_STRING'
  | 'KEYWORD'
  | 'PUNCT'
  | 'EOF';

interface Token {
  readonly type: TokenType;
  /** Raw token text (for KEYWORD: upper-cased keyword; for PUNCT: the punctuation). */
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** For strings: the quote length (1 or 3). */
  readonly quote?: number;
}

const PUNCTS = [
  '//',
  '^^',
  '||',
  '=',
  '{',
  '}',
  '&',
  '|',
  ',',
  '(',
  ')',
  '[',
  ']',
  '$',
  '!',
  '^',
  '.',
  '~',
  ';',
  '*',
  '+',
  '?',
  '-',
  '%',
  '@',
];

/** A placeholder for the empty shape `.` / `{ }` (omitted as a value expression). */
const EMPTY: ShExJ.Shape = { type: 'Shape' };

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type AnyShapeExpr = ShExJ.ShapeExprOrRef;

/** Options for the ShExC parser. */
export interface ParserOptions {
  readonly baseIri?: string | undefined;
  readonly prefixes?: Readonly<Record<string, string>> | undefined;
}

/** The result of parsing ShExC. */
export interface ParserResult {
  readonly schema: ShExJ.Schema;
  readonly prefixes: ReadonlyMap<string, string>;
  readonly baseIri: string | undefined;
}

class Parser {
  pos = 0;
  tok: Token | undefined;
  base: string | undefined;
  readonly prefixes = new Map<string, string>();
  readonly imports: Array<string> = [];
  readonly shapes = new Map<string, ShExJ.ShapeDecl>();
  readonly productions = new Set<string>();
  start: AnyShapeExpr | undefined;
  startActs: ReadonlyArray<ShExJ.SemAct> | undefined;
  readonly nested = new WeakSet<object>();

  constructor(
    readonly input: string,
    options: ParserOptions,
  ) {
    this.base = options.baseIri;
    for (const [k, v] of Object.entries(options.prefixes ?? {})) this.prefixes.set(k, v);
  }

  // ---------------------------------------------------------------------------
  // Lexing
  // ---------------------------------------------------------------------------

  fail(message: string, pos: number = this.peek().start): never {
    throw new Failure(message, pos);
  }

  skip(pos: number): number {
    const m = matchAt(RE.SKIP, this.input, pos);
    return m === undefined ? pos : pos + m.length;
  }

  peek(): Token {
    if (this.tok !== undefined) return this.tok;
    const input = this.input;
    const start = this.skip(this.pos);
    const t = (type: TokenType, text: string, end = start + text.length, quote?: number): Token =>
      quote === undefined ? { type, text, start, end } : { type, text, start, end, quote };
    if (start >= input.length) return (this.tok = t('EOF', '', start));
    const c = input[start]!;
    let m: string | undefined;
    if (c === '@') {
      if ((m = matchAt(RE.ATPNAME_LN, input, start)) !== undefined)
        return (this.tok = t('ATPNAME_LN', m));
      if ((m = matchAt(RE.ATPNAME_NS, input, start)) !== undefined)
        return (this.tok = t('ATPNAME_NS', m));
      if ((m = matchAt(RE.LANGTAG, input, start)) !== undefined)
        return (this.tok = t('LANGTAG', m));
      return (this.tok = t('PUNCT', '@'));
    }
    if ((m = matchAt(RE.PNAME_LN, input, start)) !== undefined) return (this.tok = t('PNAME_LN', m));
    if ((m = matchAt(RE.DOUBLE, input, start)) !== undefined) return (this.tok = t('DOUBLE', m));
    if ((m = matchAt(RE.DECIMAL, input, start)) !== undefined) return (this.tok = t('DECIMAL', m));
    if ((m = matchAt(RE.INTEGER, input, start)) !== undefined) return (this.tok = t('INTEGER', m));
    if (c === '<') {
      if ((m = matchAt(RE.IRIREF, input, start)) !== undefined) return (this.tok = t('IRIREF', m));
      this.fail('invalid IRI reference', start);
    }
    if ((m = matchAt(RE.PNAME_NS, input, start)) !== undefined) return (this.tok = t('PNAME_NS', m));
    if (c === '/' && input[start + 1] !== '/') {
      if ((m = matchAt(RE.REGEXP, input, start)) !== undefined) return (this.tok = t('REGEXP', m));
      this.fail('invalid regular expression', start);
    }
    if (c === '_' && (m = matchAt(RE.BLANK_NODE_LABEL, input, start)) !== undefined)
      return (this.tok = t('BLANK_NODE_LABEL', m));
    if (c === '"' || c === "'") {
      const long = c === "'" ? RE.STRING_LITERAL_LONG1 : RE.STRING_LITERAL_LONG2;
      const short = c === "'" ? RE.STRING_LITERAL1 : RE.STRING_LITERAL2;
      let quote = 3;
      m = input.startsWith(c.repeat(3), start) ? matchAt(long, input, start) : undefined;
      if (m === undefined) {
        quote = 1;
        m = matchAt(short, input, start);
      }
      if (m === undefined) this.fail('invalid string literal', start);
      const lang = matchAt(RE.LANGTAG_SUFFIX, input, start + m.length);
      if (lang !== undefined) return (this.tok = t('LANG_STRING', m + lang, undefined, quote));
      return (this.tok = t('STRING', m, undefined, quote));
    }
    if ((m = matchAt(RE.WORD, input, start)) !== undefined) {
      if (m === 'a' || m === 'true' || m === 'false') return (this.tok = t('PUNCT', m));
      const upper = m.toUpperCase();
      if (KEYWORDS.has(upper)) return (this.tok = t('KEYWORD', upper, start + m.length));
      this.fail(`unexpected word "${m}"`, start);
    }
    for (const p of PUNCTS) {
      if (input.startsWith(p, start)) return (this.tok = t('PUNCT', p));
    }
    return this.fail(`invalid character ${JSON.stringify(c)}`, start);
  }

  next(): Token {
    const tok = this.peek();
    this.pos = tok.end;
    this.tok = undefined;
    return tok;
  }

  isPunct(p: string): boolean {
    const t = this.peek();
    return t.type === 'PUNCT' && t.text === p;
  }

  isKeyword(...kw: ReadonlyArray<string>): boolean {
    const t = this.peek();
    return t.type === 'KEYWORD' && kw.includes(t.text);
  }

  acceptPunct(p: string): boolean {
    if (this.isPunct(p)) {
      this.next();
      return true;
    }
    return false;
  }

  acceptKeyword(kw: string): boolean {
    if (this.isKeyword(kw)) {
      this.next();
      return true;
    }
    return false;
  }

  expectPunct(p: string): Token {
    if (!this.isPunct(p)) this.unexpected(`'${p}'`);
    return this.next();
  }

  unexpected(expected: string): never {
    const t = this.peek();
    const found = t.type === 'EOF' ? 'end of input' : JSON.stringify(t.text);
    return this.fail(`expected ${expected}, found ${found}`, t.start);
  }

  /** Scans a `REPEAT_RANGE` at the current position, if any. */
  scanRepeatRange(): string | undefined {
    const start = this.skip(this.pos);
    const m = matchAt(RE.REPEAT_RANGE, this.input, start);
    if (m === undefined) return undefined;
    this.pos = start + m.length;
    this.tok = undefined;
    return m;
  }

  /** Scans a `CODE` block at the current position, if any. */
  scanCode(): string | undefined {
    const start = this.skip(this.pos);
    const m = matchAt(RE.CODE, this.input, start);
    if (m === undefined) return undefined;
    this.pos = start + m.length;
    this.tok = undefined;
    return m;
  }

  // ---------------------------------------------------------------------------
  // Terminals
  // ---------------------------------------------------------------------------

  resolve(iri: string): string {
    return this.base === undefined || Iri.isAbsolute(iri) ? iri : Iri.resolve(iri, this.base);
  }

  expandPrefix(prefix: string, pos: number): string {
    const ns = this.prefixes.get(prefix);
    if (ns === undefined) this.fail(`unknown prefix "${prefix}:"`, pos);
    return ns;
  }

  isIriStart(): boolean {
    const t = this.peek();
    return t.type === 'IRIREF' || t.type === 'PNAME_LN' || t.type === 'PNAME_NS';
  }

  iri(): string {
    const t = this.peek();
    switch (t.type) {
      case 'IRIREF':
        this.next();
        return this.resolve(unescapeUchar(t.text.slice(1, -1)));
      case 'PNAME_LN': {
        this.next();
        const i = t.text.indexOf(':');
        return this.expandPrefix(t.text.slice(0, i), t.start) + unescapeLocal(t.text.slice(i + 1));
      }
      case 'PNAME_NS':
        this.next();
        return this.expandPrefix(t.text.slice(0, -1), t.start);
      default:
        return this.unexpected('an IRI');
    }
  }

  isLabelStart(): boolean {
    return this.isIriStart() || this.peek().type === 'BLANK_NODE_LABEL';
  }

  /** shapeExprLabel / tripleExprLabel: iri | blankNode */
  label(): string {
    const t = this.peek();
    if (t.type === 'BLANK_NODE_LABEL') {
      this.next();
      return t.text;
    }
    return this.iri();
  }

  predicate(): string {
    if (this.acceptPunct('a')) return RDF_TYPE;
    return this.iri();
  }

  isLiteralStart(): boolean {
    const t = this.peek();
    return (
      t.type === 'STRING' ||
      t.type === 'LANG_STRING' ||
      t.type === 'INTEGER' ||
      t.type === 'DECIMAL' ||
      t.type === 'DOUBLE' ||
      (t.type === 'PUNCT' && (t.text === 'true' || t.text === 'false'))
    );
  }

  stringValue(t: Token): string {
    const q = t.quote ?? 1;
    return unescapeString(t.text.slice(q, -q));
  }

  literal(): ShExJ.ObjectLiteral {
    const t = this.peek();
    switch (t.type) {
      case 'INTEGER':
        this.next();
        return { value: t.text, type: XSD_INTEGER };
      case 'DECIMAL':
        this.next();
        return { value: t.text, type: XSD_DECIMAL };
      case 'DOUBLE':
        this.next();
        return { value: t.text, type: XSD_DOUBLE };
      case 'LANG_STRING': {
        this.next();
        const at = t.text.lastIndexOf('@');
        const q = t.quote ?? 1;
        return {
          value: unescapeString(t.text.slice(q, at - q)),
          language: t.text.slice(at + 1).toLowerCase(),
        };
      }
      case 'STRING': {
        this.next();
        const value = this.stringValue(t);
        if (this.acceptPunct('^^')) return { value, type: this.iri() };
        return { value };
      }
      case 'PUNCT':
        if (t.text === 'true' || t.text === 'false') {
          this.next();
          return { value: t.text, type: XSD_BOOLEAN };
        }
        break;
      default:
        break;
    }
    return this.unexpected('a literal');
  }

  // ---------------------------------------------------------------------------
  // Document
  // ---------------------------------------------------------------------------

  document(): ShExJ.Schema {
    let started = false;
    for (;;) {
      if (this.directive()) continue;
      const t = this.peek();
      if (t.type === 'EOF') break;
      if (!started && this.isPunct('%')) {
        this.startActs = this.codeDecls();
        started = true;
        continue;
      }
      if (this.isKeyword('START')) {
        this.startDecl();
      } else if (this.isKeyword('ABSTRACT') || this.isLabelStart()) {
        this.shapeExprDecl();
      } else {
        this.unexpected('a directive or shape declaration');
      }
      started = true;
    }
    const schema: Mutable<ShExJ.Schema> = { type: 'Schema' };
    if (this.imports.length > 0) schema.imports = this.imports;
    if (this.startActs !== undefined) schema.startActs = this.startActs;
    if (this.start !== undefined) schema.start = this.start;
    if (this.shapes.size > 0) schema.shapes = Array.from(this.shapes.values());
    return schema;
  }

  directive(): boolean {
    if (this.acceptKeyword('BASE')) {
      const t = this.peek();
      if (t.type !== 'IRIREF') this.unexpected('an IRI reference');
      this.next();
      this.base = this.resolve(unescapeUchar(t.text.slice(1, -1)));
      return true;
    }
    if (this.acceptKeyword('PREFIX')) {
      const t = this.peek();
      if (t.type !== 'PNAME_NS') this.unexpected('a prefix name');
      this.next();
      const ns = this.iri();
      this.prefixes.set(t.text.slice(0, -1), ns);
      return true;
    }
    if (this.acceptKeyword('IMPORT')) {
      this.imports.push(this.iri());
      return true;
    }
    return false;
  }

  startDecl(): void {
    const kw = this.next();
    this.expectPunct('=');
    if (this.start !== undefined) this.fail('start already defined', kw.start);
    const first = this.shapeAnd();
    const rest: Array<AnyShapeExpr> = [];
    while (this.acceptKeyword('OR')) rest.push(this.shapeAnd());
    this.start = this.junction('ShapeOr', first, rest);
  }

  shapeExprDecl(): void {
    const abstract = this.acceptKeyword('ABSTRACT');
    const labelPos = this.peek().start;
    const label = this.label();
    const restricts: Array<AnyShapeExpr> = [];
    while (this.isKeyword('RESTRICTS') || this.isPunct('-')) {
      this.next();
      restricts.push(this.shapeOrRef());
    }
    let shapeExpr: AnyShapeExpr;
    if (this.acceptKeyword('EXTERNAL')) {
      shapeExpr = { type: 'ShapeExternal' };
    } else if (this.isShapeRefStart()) {
      const ref = this.shapeRef();
      const rest = this.shapeOrOpt();
      if (rest === undefined) shapeExpr = ref;
      else {
        rest.needsAtom.unshift(ref);
        shapeExpr = rest.expr;
      }
    } else {
      shapeExpr = this.nonest(this.shapeExpressionBody());
    }
    if (shapeExpr === EMPTY) shapeExpr = { type: 'Shape' };
    const decl: Mutable<ShExJ.ShapeDecl> = { type: 'ShapeDecl', id: label, shapeExpr };
    if (abstract) decl.abstract = true;
    if (restricts.length > 0) decl.restricts = restricts;
    if (this.productions.has(label)) this.fail(`${label} is a triple expression`, labelPos);
    if (this.shapes.has(label)) this.fail(`${label} already defined`, labelPos);
    this.shapes.set(label, { id: label, ...decl });
  }

  // ---------------------------------------------------------------------------
  // Shape expressions
  // ---------------------------------------------------------------------------

  nonest<T extends AnyShapeExpr>(e: T): T {
    if (typeof e === 'object') this.nested.delete(e);
    return e;
  }

  isNested(e: AnyShapeExpr): boolean {
    return typeof e === 'object' && this.nested.has(e);
  }

  junction(type: 'ShapeAnd' | 'ShapeOr', atom: AnyShapeExpr, juncts: Array<AnyShapeExpr>) {
    if (juncts.length === 0) return this.nonest(atom);
    if (typeof atom === 'object' && atom.type === type && !this.isNested(atom)) {
      const a = atom as Mutable<ShExJ.ShapeAnd>;
      a.shapeExprs = a.shapeExprs.concat(juncts);
      return atom;
    }
    return { type, shapeExprs: [this.nonest(atom), ...juncts.map((j) => this.nonest(j))] };
  }

  isShapeRefStart(): boolean {
    const t = this.peek();
    return t.type === 'ATPNAME_LN' || t.type === 'ATPNAME_NS' || (t.type === 'PUNCT' && t.text === '@');
  }

  shapeRef(): string {
    const t = this.next();
    if (t.type === 'ATPNAME_LN') {
      const i = t.text.indexOf(':');
      return (
        this.expandPrefix(t.text.slice(1, i), t.start) + unescapeLocal(t.text.slice(i + 1))
      );
    }
    if (t.type === 'ATPNAME_NS') return this.expandPrefix(t.text.slice(1, -1), t.start);
    return this.label();
  }

  /**
   * shapeExpression ::= NOT? shapeAtomNoRef shapeOr? | NOT shapeRef shapeOr? | shapeRef shapeOr
   */
  shapeExpressionBody(): AnyShapeExpr {
    if (this.acceptKeyword('NOT')) {
      if (this.isShapeRefStart()) {
        const atom: AnyShapeExpr = { type: 'ShapeNot', shapeExpr: this.shapeRef() };
        const rest = this.shapeOrOpt();
        if (rest === undefined) return atom;
        rest.needsAtom.unshift(atom);
        return rest.expr;
      }
      const atom: AnyShapeExpr = { type: 'ShapeNot', shapeExpr: this.nonest(this.shapeAtom(false)) };
      return this.prependAtom(atom, this.shapeOrOpt());
    }
    if (this.isShapeRefStart()) {
      const ref = this.shapeRef();
      const rest = this.shapeOrOpt();
      if (rest === undefined) return this.unexpected("'AND' or 'OR'");
      rest.needsAtom.unshift(ref);
      return rest.expr;
    }
    const atom = this.shapeAtom(false);
    return this.prependAtom(atom, this.shapeOrOpt());
  }

  prependAtom(
    atom: AnyShapeExpr,
    rest: { expr: AnyShapeExpr; needsAtom: Array<AnyShapeExpr> } | undefined,
  ): AnyShapeExpr {
    if (rest === undefined) return atom;
    if (
      typeof atom === 'object' &&
      atom.type === 'ShapeAnd' &&
      typeof rest.expr === 'object' &&
      rest.expr.type === 'ShapeAnd' &&
      !this.isNested(atom) &&
      !this.isNested(rest.expr)
    ) {
      rest.needsAtom.unshift(...atom.shapeExprs);
    } else {
      rest.needsAtom.unshift(this.nonest(atom));
    }
    return rest.expr;
  }

  /**
   * shapeOr ::= (OR shapeAnd)+ | (AND shapeNot)+ (OR shapeAnd)*
   *
   * Returns the expression and the list into which the leading atom is to be
   * inserted.
   */
  shapeOrOpt(): { expr: AnyShapeExpr; needsAtom: Array<AnyShapeExpr> } | undefined {
    if (this.isKeyword('OR')) {
      const shapeExprs: Array<AnyShapeExpr> = [];
      while (this.acceptKeyword('OR')) shapeExprs.push(this.nonest(this.shapeAnd()));
      return { expr: { type: 'ShapeOr', shapeExprs }, needsAtom: shapeExprs };
    }
    if (this.isKeyword('AND')) {
      const conjuncts: Array<AnyShapeExpr> = [];
      while (this.acceptKeyword('AND')) conjuncts.push(this.shapeNot());
      const shapeExprs: Array<AnyShapeExpr> = [];
      for (const c of conjuncts) {
        if (typeof c === 'object' && c.type === 'ShapeAnd' && !this.isNested(c))
          shapeExprs.push(...c.shapeExprs);
        else shapeExprs.push(this.nonest(c));
      }
      const and: ShExJ.ShapeAnd = { type: 'ShapeAnd', shapeExprs };
      const ors: Array<AnyShapeExpr> = [];
      while (this.acceptKeyword('OR')) ors.push(this.nonest(this.shapeAnd()));
      return {
        expr: ors.length > 0 ? { type: 'ShapeOr', shapeExprs: [and, ...ors] } : and,
        needsAtom: shapeExprs,
      };
    }
    return undefined;
  }

  shapeAnd(): AnyShapeExpr {
    const first = this.shapeNot();
    const rest: Array<AnyShapeExpr> = [];
    while (this.acceptKeyword('AND')) rest.push(this.shapeNot());
    return this.junction('ShapeAnd', first, rest);
  }

  shapeNot(): AnyShapeExpr {
    if (this.acceptKeyword('NOT')) {
      return { type: 'ShapeNot', shapeExpr: this.nonest(this.shapeAtom(true)) };
    }
    return this.shapeAtom(true);
  }

  isNonLitNodeConstraintStart(): boolean {
    const t = this.peek();
    return (
      this.isKeyword('IRI', 'BNODE', 'NONLITERAL', 'LENGTH', 'MINLENGTH', 'MAXLENGTH') ||
      t.type === 'REGEXP'
    );
  }

  isLitNodeConstraintStart(): boolean {
    return (
      this.isKeyword(
        'LITERAL',
        'MININCLUSIVE',
        'MINEXCLUSIVE',
        'MAXINCLUSIVE',
        'MAXEXCLUSIVE',
        'TOTALDIGITS',
        'FRACTIONDIGITS',
      ) ||
      this.isIriStart() ||
      this.isPunct('[')
    );
  }

  isShapeDefinitionStart(): boolean {
    return (
      this.isPunct('{') ||
      this.isPunct('&') ||
      this.isKeyword('EXTENDS', 'EXTRA', 'CLOSED')
    );
  }

  /**
   * shapeAtom (allowRef) / shapeAtomNoRef (!allowRef).
   */
  shapeAtom(allowRef: boolean): AnyShapeExpr {
    if (this.isNonLitNodeConstraintStart()) {
      const nc = this.withAnnotations(this.nonLitInlineNodeConstraint());
      if (this.isShapeDefinitionStart() || this.isShapeRefStart()) {
        const ref = this.shapeOrRef();
        return { type: 'ShapeAnd', shapeExprs: [{ ...nc }, ref] };
      }
      return nc;
    }
    if (this.isLitNodeConstraintStart()) {
      return this.withAnnotations(this.litInlineNodeConstraint());
    }
    if (this.isShapeDefinitionStart() || (allowRef && this.isShapeRefStart())) {
      const sor = this.shapeOrRef();
      if (this.isNonLitNodeConstraintStart()) {
        const nc = this.withAnnotations(this.nonLitInlineNodeConstraint());
        return this.junction('ShapeAnd', sor, [nc]);
      }
      return sor;
    }
    if (this.acceptPunct('(')) {
      const e = this.shapeExpressionBody();
      this.expectPunct(')');
      if (typeof e === 'object') this.nested.add(e);
      return e;
    }
    if (this.acceptPunct('.')) return EMPTY;
    return this.unexpected('a shape expression');
  }

  shapeOrRef(): AnyShapeExpr {
    if (this.isShapeRefStart()) return this.shapeRef();
    return this.shapeDefinition();
  }

  withAnnotations(nc: ShExJ.NodeConstraint): ShExJ.NodeConstraint {
    const annotations = this.annotations();
    const semActs = this.semanticActions();
    if (annotations.length === 0 && semActs === undefined) return nc;
    const out: Mutable<ShExJ.NodeConstraint> = nc;
    if (annotations.length > 0) out.annotations = annotations;
    if (semActs !== undefined) out.semActs = semActs;
    return out;
  }

  // Inline shape expressions -----------------------------------------------------

  inlineShapeExpression(): AnyShapeExpr {
    const first = this.inlineShapeAnd();
    const rest: Array<AnyShapeExpr> = [];
    while (this.acceptKeyword('OR')) rest.push(this.inlineShapeAnd());
    return this.junction('ShapeOr', first, rest);
  }

  inlineShapeAnd(): AnyShapeExpr {
    const first = this.inlineShapeNot();
    const rest: Array<AnyShapeExpr> = [];
    while (this.acceptKeyword('AND')) rest.push(this.inlineShapeNot());
    return this.junction('ShapeAnd', first, rest);
  }

  inlineShapeNot(): AnyShapeExpr {
    if (this.acceptKeyword('NOT')) {
      return { type: 'ShapeNot', shapeExpr: this.nonest(this.inlineShapeAtom()) };
    }
    return this.inlineShapeAtom();
  }

  inlineShapeAtom(): AnyShapeExpr {
    if (this.isNonLitNodeConstraintStart()) {
      const nc = this.nonLitInlineNodeConstraint();
      if (this.isShapeDefinitionStart() || this.isShapeRefStart()) {
        const ref = this.inlineShapeOrRef();
        return { type: 'ShapeAnd', shapeExprs: [{ ...nc }, ref] };
      }
      return nc;
    }
    if (this.isLitNodeConstraintStart()) return this.litInlineNodeConstraint();
    if (this.isShapeDefinitionStart() || this.isShapeRefStart()) {
      const sor = this.inlineShapeOrRef();
      if (this.isNonLitNodeConstraintStart()) {
        const nc = this.nonLitInlineNodeConstraint();
        return { type: 'ShapeAnd', shapeExprs: [sor, nc] };
      }
      return sor;
    }
    if (this.acceptPunct('(')) {
      const e = this.shapeExpressionBody();
      this.expectPunct(')');
      if (typeof e === 'object') this.nested.add(e);
      return e;
    }
    if (this.acceptPunct('.')) return EMPTY;
    return this.unexpected('a shape expression');
  }

  inlineShapeOrRef(): AnyShapeExpr {
    if (this.isShapeRefStart()) return this.shapeRef();
    return this.inlineShapeDefinition();
  }

  // Extends shape expressions ----------------------------------------------------

  extendsShapeOr(): AnyShapeExpr {
    const first = this.extendsShapeAnd();
    const rest: Array<AnyShapeExpr> = [];
    while (this.acceptKeyword('OR')) rest.push(this.extendsShapeAnd());
    return this.junction('ShapeOr', first, rest);
  }

  extendsShapeAnd(): AnyShapeExpr {
    const first = this.extendsShapeNot();
    const rest: Array<AnyShapeExpr> = [];
    while (this.acceptKeyword('AND')) rest.push(this.extendsShapeNot());
    return this.junction('ShapeAnd', first, rest);
  }

  extendsShapeNot(): AnyShapeExpr {
    if (this.acceptKeyword('NOT')) {
      return { type: 'ShapeNot', shapeExpr: this.nonest(this.extendsShapeAtom()) };
    }
    return this.extendsShapeAtom();
  }

  extendsShapeAtom(): AnyShapeExpr {
    if (this.isNonLitNodeConstraintStart()) {
      const nc = this.nonLitInlineNodeConstraint();
      const ref = this.inlineShapeOrRef();
      return { type: 'ShapeAnd', shapeExprs: [{ ...nc }, ref] };
    }
    if (this.isLitNodeConstraintStart()) return this.litInlineNodeConstraint();
    if (this.isShapeDefinitionStart() || this.isShapeRefStart()) {
      const sor = this.inlineShapeOrRef();
      if (this.isNonLitNodeConstraintStart()) {
        const nc = this.nonLitInlineNodeConstraint();
        return { type: 'ShapeAnd', shapeExprs: [sor, nc] };
      }
      return sor;
    }
    if (this.acceptPunct('(')) {
      const e = this.shapeExpressionBody();
      this.expectPunct(')');
      if (typeof e === 'object') this.nested.add(e);
      return e;
    }
    if (this.acceptPunct('.')) return EMPTY;
    return this.unexpected('a shape expression');
  }

  // Node constraints ---------------------------------------------------------------

  litInlineNodeConstraint(): ShExJ.NodeConstraint {
    if (this.acceptKeyword('LITERAL')) {
      return { type: 'NodeConstraint', nodeKind: 'literal', ...this.facets(true, true) };
    }
    if (this.isIriStart()) {
      const pos = this.peek().start;
      const datatype = this.iri();
      const facets = this.facets(true, true);
      if (!numericDatatypes.has(datatype)) {
        for (const f of numericFacetNames) {
          if (f in facets) this.fail(`facet ${f} not allowed for unknown datatype ${datatype}`, pos);
        }
      }
      return { type: 'NodeConstraint', datatype, ...facets };
    }
    if (this.isPunct('[')) {
      const values = this.valueSet();
      this.facets(true, true);
      return { type: 'NodeConstraint', values };
    }
    const facets = this.facets(false, true);
    if (Object.keys(facets).length === 0) this.unexpected('a node constraint');
    return { type: 'NodeConstraint', ...facets };
  }

  nonLitInlineNodeConstraint(): ShExJ.NodeConstraint {
    let kind: ShExJ.NodeKind | undefined;
    if (this.acceptKeyword('IRI')) kind = 'iri';
    else if (this.acceptKeyword('BNODE')) kind = 'bnode';
    else if (this.acceptKeyword('NONLITERAL')) kind = 'nonliteral';
    const facets = this.facets(true, false);
    return kind === undefined
      ? { type: 'NodeConstraint', ...facets }
      : { type: 'NodeConstraint', nodeKind: kind, ...facets };
  }

  facets(strings: boolean, numerics: boolean): Mutable<ShExJ.Facets> {
    const out: Mutable<ShExJ.Facets> = {};
    const set = (key: keyof ShExJ.Facets, value: number | string, pos: number) => {
      if (key in out) this.fail(`facet ${key} defined multiple times`, pos);
      (out as Record<string, unknown>)[key] = value;
    };
    for (;;) {
      const t = this.peek();
      if (strings && t.type === 'REGEXP') {
        this.next();
        const end = t.text.lastIndexOf('/');
        if ('pattern' in out) this.fail('facet pattern defined multiple times', t.start);
        out.pattern = unescapeRegexp(t.text.slice(1, end));
        if (end + 1 < t.text.length) out.flags = t.text.slice(end + 1);
        continue;
      }
      if (t.type !== 'KEYWORD') break;
      if (strings && (t.text === 'LENGTH' || t.text === 'MINLENGTH' || t.text === 'MAXLENGTH')) {
        this.next();
        const n = this.peek();
        if (n.type !== 'INTEGER') this.unexpected('an integer');
        this.next();
        set(t.text.toLowerCase() as keyof ShExJ.Facets, parseInt(n.text, 10), t.start);
        continue;
      }
      if (numerics && (t.text === 'TOTALDIGITS' || t.text === 'FRACTIONDIGITS')) {
        this.next();
        const n = this.peek();
        if (n.type !== 'INTEGER') this.unexpected('an integer');
        this.next();
        set(t.text.toLowerCase() as keyof ShExJ.Facets, parseInt(n.text, 10), t.start);
        continue;
      }
      if (
        numerics &&
        (t.text === 'MININCLUSIVE' ||
          t.text === 'MINEXCLUSIVE' ||
          t.text === 'MAXINCLUSIVE' ||
          t.text === 'MAXEXCLUSIVE')
      ) {
        this.next();
        set(t.text.toLowerCase() as keyof ShExJ.Facets, this.rawNumeric(), t.start);
        continue;
      }
      break;
    }
    return out;
  }

  rawNumeric(): number {
    const t = this.peek();
    switch (t.type) {
      case 'INTEGER':
        this.next();
        return parseInt(t.text, 10);
      case 'DECIMAL':
      case 'DOUBLE':
        this.next();
        return parseFloat(t.text);
      case 'STRING': {
        this.next();
        const value = this.stringValue(t);
        this.expectPunct('^^');
        const pos = this.peek().start;
        const dt = this.iri();
        if (dt === XSD_DECIMAL || dt === XSD_FLOAT || dt === XSD_DOUBLE) return parseFloat(value);
        if (numericDatatypes.has(dt)) return parseInt(value, 10);
        return this.fail(
          `numeric range facet expected numeric datatype instead of ${dt}`,
          pos,
        );
      }
      default:
        return this.unexpected('a numeric literal');
    }
  }

  // Value sets ---------------------------------------------------------------------

  valueSet(): Array<ShExJ.ValueSetValue> {
    this.expectPunct('[');
    const values: Array<ShExJ.ValueSetValue> = [];
    while (!this.acceptPunct(']')) values.push(this.valueSetValue());
    return values;
  }

  valueSetValue(): ShExJ.ValueSetValue {
    const t = this.peek();
    if (this.isIriStart()) {
      const stem = this.iri();
      if (!this.acceptPunct('~')) return stem;
      const exclusions: Array<string | ShExJ.IriStem> = [];
      while (this.isPunct('-')) exclusions.push(this.iriExclusion());
      return exclusions.length > 0
        ? { type: 'IriStemRange', stem, exclusions }
        : { type: 'IriStem', stem };
    }
    if (this.isLiteralStart()) {
      const lit = this.literal();
      if (!this.acceptPunct('~')) return lit;
      const exclusions: Array<string | ShExJ.LiteralStem> = [];
      while (this.isPunct('-')) exclusions.push(this.literalExclusion());
      return exclusions.length > 0
        ? { type: 'LiteralStemRange', stem: lit.value, exclusions }
        : { type: 'LiteralStem', stem: lit.value };
    }
    if (t.type === 'LANGTAG') {
      this.next();
      const tag = t.text.slice(1);
      if (!this.acceptPunct('~')) return { type: 'Language', languageTag: tag };
      const exclusions: Array<string | ShExJ.LanguageStem> = [];
      while (this.isPunct('-')) exclusions.push(this.languageExclusion());
      return exclusions.length > 0
        ? { type: 'LanguageStemRange', stem: tag, exclusions }
        : { type: 'LanguageStem', stem: tag };
    }
    if (this.acceptPunct('@')) {
      this.expectPunct('~');
      const exclusions: Array<string | ShExJ.LanguageStem> = [];
      while (this.isPunct('-')) exclusions.push(this.languageExclusion());
      return exclusions.length > 0
        ? { type: 'LanguageStemRange', stem: '', exclusions }
        : { type: 'LanguageStem', stem: '' };
    }
    if (this.acceptPunct('.')) {
      if (!this.isPunct('-')) this.unexpected("'-'");
      this.next();
      const kind = this.peek();
      this.pos = t.end;
      this.tok = undefined;
      // Re-scan from after the '.', choosing the exclusion kind from the first one.
      if (kind.type === 'LANGTAG') {
        const exclusions: Array<string | ShExJ.LanguageStem> = [];
        while (this.isPunct('-')) exclusions.push(this.languageExclusion());
        return { type: 'LanguageStemRange', stem: { type: 'Wildcard' }, exclusions };
      }
      if (kind.type === 'IRIREF' || kind.type === 'PNAME_LN' || kind.type === 'PNAME_NS') {
        const exclusions: Array<string | ShExJ.IriStem> = [];
        while (this.isPunct('-')) exclusions.push(this.iriExclusion());
        return { type: 'IriStemRange', stem: { type: 'Wildcard' }, exclusions };
      }
      const exclusions: Array<string | ShExJ.LiteralStem> = [];
      while (this.isPunct('-')) exclusions.push(this.literalExclusion());
      return { type: 'LiteralStemRange', stem: { type: 'Wildcard' }, exclusions };
    }
    return this.unexpected('a value set value');
  }

  iriExclusion(): string | ShExJ.IriStem {
    this.expectPunct('-');
    const iri = this.iri();
    return this.acceptPunct('~') ? { type: 'IriStem', stem: iri } : iri;
  }

  literalExclusion(): string | ShExJ.LiteralStem {
    this.expectPunct('-');
    const lit = this.literal();
    return this.acceptPunct('~') ? { type: 'LiteralStem', stem: lit.value } : lit.value;
  }

  languageExclusion(): string | ShExJ.LanguageStem {
    this.expectPunct('-');
    const t = this.peek();
    if (t.type !== 'LANGTAG') this.unexpected('a language tag');
    this.next();
    const tag = t.text.slice(1);
    return this.acceptPunct('~') ? { type: 'LanguageStem', stem: tag } : tag;
  }

  // Shape definitions --------------------------------------------------------------

  shapeDefinition(): AnyShapeExpr {
    const def = this.inlineShapeDefinition();
    const annotations = this.annotations();
    const semActs = this.semanticActions();
    const out: Mutable<ShExJ.Shape> = def === EMPTY ? { type: 'Shape' } : def;
    if (annotations.length > 0) out.annotations = annotations;
    if (semActs !== undefined) out.semActs = semActs;
    return out;
  }

  inlineShapeDefinition(): ShExJ.Shape {
    const qualifiers: {
      extends?: Array<AnyShapeExpr>;
      extra?: Array<string>;
      closed?: boolean;
    } = {};
    let any = false;
    for (;;) {
      if (this.isKeyword('EXTENDS') || this.isPunct('&')) {
        this.next();
        (qualifiers.extends ??= []).push(this.extendsShapeOr());
        any = true;
      } else if (this.acceptKeyword('EXTRA')) {
        const extra = (qualifiers.extra ??= []);
        extra.push(this.predicate());
        while (this.isIriStart() || this.isPunct('a')) extra.push(this.predicate());
        any = true;
      } else if (this.acceptKeyword('CLOSED')) {
        qualifiers.closed = true;
        any = true;
      } else break;
    }
    this.expectPunct('{');
    let expression: ShExJ.TripleExprOrRef | undefined;
    if (!this.isPunct('}')) expression = this.tripleExpression();
    this.expectPunct('}');
    if (expression === undefined && !any) return EMPTY;
    const shape: Mutable<ShExJ.Shape> = { type: 'Shape' };
    if (expression !== undefined) shape.expression = expression;
    if (qualifiers.extends !== undefined) shape.extends = qualifiers.extends;
    if (qualifiers.extra !== undefined) shape.extra = qualifiers.extra;
    if (qualifiers.closed !== undefined) shape.closed = qualifiers.closed;
    return shape;
  }

  // Triple expressions -------------------------------------------------------------

  tripleExpression(): ShExJ.TripleExprOrRef {
    const first = this.groupTripleExpr();
    if (!this.isPunct('|')) return first;
    const expressions = [first];
    while (this.acceptPunct('|')) expressions.push(this.groupTripleExpr());
    return { type: 'OneOf', expressions };
  }

  isUnaryTripleExprStart(): boolean {
    return (
      this.isPunct('$') ||
      this.isPunct('&') ||
      this.isPunct('(') ||
      this.isPunct('^') ||
      this.isPunct('a') ||
      this.isIriStart()
    );
  }

  groupTripleExpr(): ShExJ.TripleExprOrRef {
    const first = this.unaryTripleExpr();
    const expressions = [first];
    for (;;) {
      if (this.isPunct(';') || this.isPunct(',')) {
        this.next();
        if (this.isUnaryTripleExprStart()) {
          expressions.push(this.unaryTripleExpr());
          continue;
        }
      }
      break;
    }
    return expressions.length === 1 ? first : { type: 'EachOf', expressions };
  }

  unaryTripleExpr(): ShExJ.TripleExprOrRef {
    if (this.acceptPunct('&')) return this.label();
    let id: string | undefined;
    let idPos = 0;
    if (this.acceptPunct('$')) {
      idPos = this.peek().start;
      id = this.label();
    }
    const expr = this.isPunct('(') ? this.bracketedTripleExpr() : this.tripleConstraint();
    if (id === undefined) return expr;
    if (typeof expr === 'string')
      this.fail(`a group containing only the inclusion &<${expr}> can't take a label`, idPos);
    if (this.shapes.has(id)) this.fail(`${id} is a shape expression`, idPos);
    if (this.productions.has(id)) this.fail(`${id} already defined`, idPos);
    this.productions.add(id);
    return { id, ...expr };
  }

  bracketedTripleExpr(): ShExJ.TripleExprOrRef {
    const open = this.expectPunct('(');
    let expr = this.tripleExpression();
    this.expectPunct(')');
    const card = this.cardinality();
    const annotations = this.annotations();
    const semActs = this.semanticActions();
    if (card !== undefined || annotations.length > 0 || semActs !== undefined) {
      if (typeof expr === 'string')
        this.fail(
          `a group containing only the inclusion &<${expr}> can't take a cardinality, an annotation or a semantic action`,
          open.start,
        );
      if (
        card !== undefined &&
        expr.type === 'TripleConstraint' &&
        (expr.min !== undefined || expr.max !== undefined)
      ) {
        expr = { type: 'EachOf', expressions: [expr] };
      }
      const out = expr as Mutable<ShExJ.EachOf>;
      if (card !== undefined) {
        out.min = card.min;
        out.max = card.max;
      }
      if (annotations.length > 0) out.annotations = annotations;
      if (semActs !== undefined) out.semActs = [...(out.semActs ?? []), ...semActs];
    }
    return expr;
  }

  tripleConstraint(): ShExJ.TripleConstraint {
    const inverse = this.acceptPunct('^');
    const predicate = this.predicate();
    const valueExpr = this.inlineShapeExpression();
    const card = this.cardinality();
    const annotations = this.annotations();
    const semActs = this.semanticActions();
    const tc: Mutable<ShExJ.TripleConstraint> = { type: 'TripleConstraint' };
    if (inverse) tc.inverse = true;
    tc.predicate = predicate;
    if (valueExpr !== EMPTY) tc.valueExpr = valueExpr;
    if (card !== undefined) {
      tc.min = card.min;
      tc.max = card.max;
    }
    if (semActs !== undefined) tc.semActs = semActs;
    if (annotations.length > 0) tc.annotations = annotations;
    return tc;
  }

  cardinality(): { min: number; max: number } | undefined {
    if (this.acceptPunct('*')) return { min: 0, max: -1 };
    if (this.acceptPunct('+')) return { min: 1, max: -1 };
    if (this.acceptPunct('?')) return { min: 0, max: 1 };
    const range = this.scanRepeatRange();
    if (range === undefined) return undefined;
    const body = range.slice(1, -1);
    const nums = body.match(/\d+/g)!;
    const min = parseInt(nums[0]!, 10);
    if (nums.length === 2) return { min, max: parseInt(nums[1]!, 10) };
    if (body.indexOf(',') === -1) return { min, max: min };
    return { min, max: -1 };
  }

  annotations(): Array<ShExJ.Annotation> {
    const out: Array<ShExJ.Annotation> = [];
    while (this.acceptPunct('//')) {
      const predicate = this.predicate();
      const object: ShExJ.ObjectValue = this.isIriStart() ? this.iri() : this.literal();
      out.push({ type: 'Annotation', predicate, object });
    }
    return out;
  }

  semanticActions(): Array<ShExJ.SemAct> | undefined {
    if (!this.isPunct('%')) return undefined;
    return this.codeDecls();
  }

  codeDecls(): Array<ShExJ.SemAct> {
    const out: Array<ShExJ.SemAct> = [];
    while (this.acceptPunct('%')) {
      const name = this.iri();
      const code = this.scanCode();
      if (code !== undefined) {
        out.push({ type: 'SemAct', name, code: unescapeCode(code.slice(1, -2)) });
      } else {
        this.expectPunct('%');
        out.push({ type: 'SemAct', name });
      }
    }
    return out;
  }
}

/** Parses a ShExC document, throwing `Failure` on errors. */
export const parseShExC = (input: string, options: ParserOptions = {}): ParserResult => {
  const parser = new Parser(input, options);
  const schema = parser.document();
  return { schema, prefixes: parser.prefixes, baseIri: parser.base };
};
