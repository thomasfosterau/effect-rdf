/**
 * Hand-written recursive-descent parser for Notation3.
 *
 * The parser works directly on the input string (no separate token stream)
 * and throws `SyntaxFailure` on the first error; the public API wraps it in
 * an `Effect`.
 *
 * @internal
 */
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { rdf, xsd } from '@thomasfosterau/effect-rdf/Vocab';
import * as Model from '../Model.ts';
import { i18n, log, sameAs } from '../Vocab.ts';

/** @internal */
export class SyntaxFailure {
  readonly message: string;
  readonly line: number;
  readonly column: number;
  constructor(message: string, line: number, column: number) {
    this.message = message;
    this.line = line;
    this.column = column;
  }
}

/** @internal */
export interface ParserOptions {
  readonly baseIri?: string | undefined;
  readonly blankNodePrefix?: string | undefined;
}

// -----------------------------------------------------------------------------
// Character classes
// -----------------------------------------------------------------------------

/** @internal */
export const isPnCharsBase = (c: number): boolean =>
  (c >= 0x41 && c <= 0x5a) ||
  (c >= 0x61 && c <= 0x7a) ||
  (c >= 0xc0 && c <= 0xd6) ||
  (c >= 0xd8 && c <= 0xf6) ||
  (c >= 0xf8 && c <= 0x2ff) ||
  (c >= 0x370 && c <= 0x37d) ||
  (c >= 0x37f && c <= 0x1fff) ||
  (c >= 0x200c && c <= 0x200d) ||
  (c >= 0x2070 && c <= 0x218f) ||
  (c >= 0x2c00 && c <= 0x2fef) ||
  (c >= 0x3001 && c <= 0xd7ff) ||
  (c >= 0xf900 && c <= 0xfdcf) ||
  (c >= 0xfdf0 && c <= 0xfffd) ||
  (c >= 0x10000 && c <= 0xeffff);

/** @internal */
export const isPnCharsU = (c: number): boolean => c === 0x5f || isPnCharsBase(c);

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

/** @internal */
export const isPnChars = (c: number): boolean =>
  isPnCharsU(c) ||
  c === 0x2d ||
  isDigit(c) ||
  c === 0xb7 ||
  (c >= 0x300 && c <= 0x36f) ||
  (c >= 0x203f && c <= 0x2040);

const isHex = (c: number): boolean =>
  isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

const isWs = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/** Whether a string is a valid `PN_PREFIX` (or empty). @internal */
export const isPnPrefix = (s: string): boolean => {
  const cps = Array.from(s, (ch) => ch.codePointAt(0)!);
  if (cps.length === 0) return true;
  if (!isPnCharsBase(cps[0]!)) return false;
  if (cps.length > 1 && cps[cps.length - 1] === 0x2e) return false;
  return cps.slice(1).every((c) => c === 0x2e || isPnChars(c));
};

/** Whether a string is a valid quick variable name (without `?`). @internal */
export const isVarName = (s: string): boolean => {
  const cps = Array.from(s, (ch) => ch.codePointAt(0)!);
  return cps.length > 0 && isPnCharsU(cps[0]!) && cps.slice(1).every(isPnChars);
};

const PN_LOCAL_ESCAPABLE = new Set("_~.-!$&'()*+,;=/?#@%");

const NUMBER = /[+-]?(?:\d+\.\d*[eE][+-]?\d+|\.\d+[eE][+-]?\d+|\d+[eE][+-]?\d+|\d*\.\d+|\d+)/y;
const LANGTAG = /[a-zA-Z]+(?:-[a-zA-Z0-9]+)*/y;
const I18N_DATATYPE = /^([a-zA-Z]+(?:-[a-zA-Z0-9]+)*)_(ltr|rtl)$/;

const TRUE = Term.literal('true', xsd.boolean);
const FALSE = Term.literal('false', xsd.boolean);

interface Verb {
  readonly predicate: Model.N3Term;
  readonly inverse: boolean;
}

type Name =
  | { readonly _tag: 'PName'; readonly prefix: string; readonly local: string }
  | { readonly _tag: 'Bare'; readonly word: string };

/** @internal */
export const parse = (input: string, options?: ParserOptions): Model.Document =>
  new N3Parser(input, options).parseDocument();

class N3Parser {
  private i = 0;
  private readonly prefixes = new Map<string, string>();
  private base: string | undefined;
  private readonly bnodePrefix: string;
  private readonly bnodes = new Map<string, Term.BlankNode>();
  private anonCounter = 0;
  /** Statement collectors, one per open formula (innermost last). */
  private readonly out: Array<Array<Model.Statement>> = [];
  /** Explicit quantifier scopes (legacy `@forAll` / `@forSome`). */
  private readonly scopes: Array<Map<string, Model.N3Term>> = [];
  private readonly variableNames = new Set<string>();

  private readonly input: string;
  constructor(input: string, options?: ParserOptions) {
    this.input = input;
    this.base = options?.baseIri;
    this.bnodePrefix = options?.blankNodePrefix ?? '';
    // Labels written in the document; generated labels avoid them.
    for (const m of input.matchAll(/_:([^\s<>"{}()[\],;^!]+)/g)) {
      this.reserved.add(`${this.bnodePrefix}${m[1]!}`);
    }
  }

  private readonly reserved = new Set<string>();

  // ---------------------------------------------------------------------------
  // Errors and low-level helpers
  // ---------------------------------------------------------------------------

  private fail(message: string, at: number = this.i): never {
    let line = 1;
    let lineStart = 0;
    const end = Math.min(at, this.input.length);
    for (let k = 0; k < end; k++) {
      if (this.input.charCodeAt(k) === 0x0a) {
        line++;
        lineStart = k + 1;
      }
    }
    throw new SyntaxFailure(message, line, end - lineStart + 1);
  }

  private describe(at: number = this.i): string {
    if (at >= this.input.length) return 'end of input';
    const cp = this.input.codePointAt(at)!;
    return `'${String.fromCodePoint(cp)}'`;
  }

  private eof(): boolean {
    return this.i >= this.input.length;
  }

  private peek(offset = 0): number {
    return this.input.charCodeAt(this.i + offset);
  }

  private peekCp(): number {
    return this.input.codePointAt(this.i) ?? -1;
  }

  private ch(offset = 0): string {
    return this.input.charAt(this.i + offset);
  }

  private startsWith(s: string): boolean {
    return this.input.startsWith(s, this.i);
  }

  private ws(): void {
    const input = this.input;
    while (this.i < input.length) {
      const c = input.charCodeAt(this.i);
      if (isWs(c)) this.i++;
      else if (c === 0x23 /* # */) {
        while (this.i < input.length) {
          const d = input.charCodeAt(this.i);
          if (d === 0x0a || d === 0x0d || d === 0x0c) break;
          this.i++;
        }
      } else break;
    }
  }

  private expect(s: string, what?: string): void {
    this.ws();
    if (!this.startsWith(s)) this.fail(`Expected ${what ?? `'${s}'`} but found ${this.describe()}`);
    this.i += s.length;
  }

  private emit(subject: Model.N3Term, predicate: Model.N3Term, object: Model.N3Term): void {
    this.out[this.out.length - 1]!.push(new Model.Statement(subject, predicate, object));
  }

  private freshBlank(): Term.BlankNode {
    for (;;) {
      const label = `${this.bnodePrefix}b${(this.anonCounter++).toString(36)}`;
      if (!this.reserved.has(label)) return new Term.BlankNode(label);
    }
  }

  private labelledBlank(label: string): Term.BlankNode {
    let b = this.bnodes.get(label);
    if (b === undefined) {
      b = new Term.BlankNode(`${this.bnodePrefix}${label}`);
      this.bnodes.set(label, b);
    }
    return b;
  }

  private resolveIri(value: string): string {
    return this.base === undefined ? value : Iri.resolve(value, this.base);
  }

  /** Applies explicit-quantifier substitutions to an IRI. */
  private named(iri: string): Model.N3Term {
    for (let k = this.scopes.length - 1; k >= 0; k--) {
      const t = this.scopes[k]!.get(iri);
      if (t !== undefined) return t;
    }
    return new Term.NamedNode(iri);
  }

  // ---------------------------------------------------------------------------
  // Document structure
  // ---------------------------------------------------------------------------

  parseDocument(): Model.Document {
    this.out.push([]);
    this.scopes.push(new Map());
    this.statements(false);
    const statements = this.out.pop()!;
    return {
      formula: new Model.Formula(statements),
      prefixes: PrefixMap.make(this.prefixes),
      baseIri: this.base,
    };
  }

  /** Parses statements until end of input (top level) or a closing `}`. */
  private statements(inFormula: boolean): void {
    for (;;) {
      this.ws();
      if (this.eof()) {
        if (inFormula) this.fail("Unterminated formula: expected '}'");
        return;
      }
      if (inFormula && this.peek() === 0x7d /* } */) return;
      if (this.sparqlDirective()) continue;
      this.statement();
      this.ws();
      if (this.peek() === 0x2e /* . */) {
        this.i++;
        continue;
      }
      if (inFormula && this.peek() === 0x7d) return;
      this.fail(`Expected '.' but found ${this.describe()}`);
    }
  }

  /** `PREFIX` / `BASE` (case-insensitive, no trailing '.'). */
  private sparqlDirective(): boolean {
    const r = /(PREFIX|BASE)/iy;
    r.lastIndex = this.i;
    const m = r.exec(this.input);
    if (m === null) return false;
    const after = this.input.codePointAt(this.i + m[0].length) ?? -1;
    if (after === 0x3a || after === 0x2e || isPnChars(after)) return false;
    this.i += m[0].length;
    if (m[1]!.toUpperCase() === 'PREFIX') this.prefixBody();
    else this.baseBody();
    return true;
  }

  private statement(): void {
    if (this.peek() === 0x40 /* @ */) {
      const word = this.atWord();
      switch (word) {
        case '@prefix':
          this.i += word.length;
          return this.prefixBody();
        case '@base':
          this.i += word.length;
          return this.baseBody();
        case '@forAll':
        case '@forSome':
          this.i += word.length;
          return this.quantifier(word === '@forAll');
        case '@keywords':
          return this.fail('@keywords is not supported by Notation3');
        default:
          break;
      }
    }
    this.triples();
  }

  private atWord(): string {
    const m = /@[A-Za-z]+/y;
    m.lastIndex = this.i;
    return m.exec(this.input)?.[0] ?? '@';
  }

  private prefixBody(): void {
    this.ws();
    const start = this.i;
    let prefix = '';
    if (isPnCharsBase(this.peekCp())) prefix = this.pnPrefix();
    if (this.peek() !== 0x3a /* : */) this.fail('Expected a prefix name ending in ":"', start);
    this.i++;
    this.ws();
    if (this.peek() !== 0x3c /* < */) this.fail(`Expected an IRI but found ${this.describe()}`);
    const iri = this.iriRef();
    this.prefixes.set(prefix, this.resolveIri(iri));
  }

  private baseBody(): void {
    this.ws();
    if (this.peek() !== 0x3c) this.fail(`Expected an IRI but found ${this.describe()}`);
    this.base = this.resolveIri(this.iriRef());
  }

  private quantifier(universal: boolean): void {
    const scope = this.scopes[this.scopes.length - 1]!;
    this.ws();
    if (this.peek() === 0x2e || this.peek() === 0x7d) return;
    for (;;) {
      this.ws();
      const iri = this.iriValue();
      scope.set(iri, universal ? this.variableFor(iri) : this.freshBlank());
      this.ws();
      if (this.peek() !== 0x2c /* , */) return;
      this.i++;
    }
  }

  private variableFor(iri: string): Term.Variable {
    const local = /[^#/:]*$/.exec(iri)?.[0] ?? '';
    let name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(local) ? local : 'v';
    if (this.variableNames.has(name)) {
      let n = 1;
      while (this.variableNames.has(`${name}_${n}`)) n++;
      name = `${name}_${n}`;
    }
    this.variableNames.add(name);
    return new Term.Variable(name);
  }

  // ---------------------------------------------------------------------------
  // Triples
  // ---------------------------------------------------------------------------

  private triples(): void {
    const subject = this.path();
    this.ws();
    const c = this.peek();
    if (this.eof() || c === 0x2e || c === 0x7d) return;
    this.predicateObjectList(subject);
  }

  private predicateObjectList(subject: Model.N3Term): void {
    for (;;) {
      const verb = this.verb();
      this.objectList(subject, verb);
      this.ws();
      if (this.peek() !== 0x3b /* ; */) return;
      while (this.peek() === 0x3b) {
        this.i++;
        this.ws();
      }
      const c = this.peek();
      if (this.eof() || c === 0x2e || c === 0x5d || c === 0x7d) return;
    }
  }

  private objectList(subject: Model.N3Term, verb: Verb): void {
    for (;;) {
      this.ws();
      const c = this.peek();
      const endOfList = c === 0x2e && !isDigit(this.peek(1));
      if (this.eof() || endOfList || c === 0x3b || c === 0x2c || c === 0x5d || c === 0x7d) {
        this.fail(`Expected an object but found ${this.describe()}`);
      }
      const object = this.path();
      if (verb.inverse) this.emit(object, verb.predicate, subject);
      else this.emit(subject, verb.predicate, object);
      this.ws();
      if (this.peek() !== 0x2c /* , */) return;
      this.i++;
    }
  }

  private verb(): Verb {
    this.ws();
    const c = this.peek();
    if (c === 0x3d /* = */) {
      if (this.peek(1) === 0x3e /* > */) {
        this.i += 2;
        return { predicate: log.implies, inverse: false };
      }
      this.i++;
      return { predicate: sameAs, inverse: false };
    }
    if (c === 0x3c /* < */ && !this.looksLikeIriRef()) {
      if (this.peek(1) === 0x3d) {
        this.i += 2;
        return { predicate: log.isImpliedBy, inverse: false };
      }
      if (this.peek(1) === 0x2d /* - */) {
        this.i += 2;
        return { predicate: this.path(), inverse: true };
      }
    }
    const start = this.i;
    let word: string | undefined;
    if (c === 0x40 /* @ */) {
      word = this.atWord();
      this.i += word.length;
    } else if (isPnCharsBase(this.peekCp())) {
      const name = this.name();
      if (name._tag === 'Bare') word = name.word;
    }
    switch (word) {
      case 'a':
      case '@a':
        return { predicate: rdf.type, inverse: false };
      case 'has':
      case '@has':
        return { predicate: this.path(), inverse: false };
      case 'is':
      case '@is': {
        const predicate = this.path();
        this.ws();
        const ofStart = this.i;
        let of: string | undefined;
        if (this.peek() === 0x40) {
          of = this.atWord();
          this.i += of.length;
        } else if (isPnCharsBase(this.peekCp())) {
          const name = this.name();
          if (name._tag === 'Bare') of = name.word;
        }
        if (of !== 'of' && of !== '@of') this.fail("Expected 'of' after 'is ...'", ofStart);
        return { predicate, inverse: true };
      }
      default:
        this.i = start;
        return { predicate: this.path(), inverse: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Expressions
  // ---------------------------------------------------------------------------

  private path(): Model.N3Term {
    let item = this.pathItem();
    for (;;) {
      this.ws();
      const c = this.peek();
      if (c === 0x21 /* ! */) {
        this.i++;
        const predicate = this.pathItem();
        const b = this.freshBlank();
        this.emit(item, predicate, b);
        item = b;
      } else if (c === 0x5e /* ^ */ && this.peek(1) !== 0x5e) {
        this.i++;
        const predicate = this.pathItem();
        const b = this.freshBlank();
        this.emit(b, predicate, item);
        item = b;
      } else return item;
    }
  }

  private pathItem(): Model.N3Term {
    this.ws();
    if (this.eof()) this.fail('Unexpected end of input');
    const c = this.peek();
    switch (c) {
      case 0x3c /* < */:
        if (!this.looksLikeIriRef()) this.fail(`Unexpected ${this.describe()}`);
        return this.named(this.resolveIri(this.iriRef()));
      case 0x5b /* [ */:
        return this.bracket();
      case 0x28 /* ( */:
        return this.collection();
      case 0x7b /* { */:
        return this.formula();
      case 0x22 /* " */:
      case 0x27 /* ' */:
        return this.rdfLiteral();
      case 0x3f /* ? */:
        return this.quickVar();
      case 0x40 /* @ */: {
        const word = this.atWord();
        if (word === '@true' || word === '@false') {
          this.i += word.length;
          return word === '@true' ? TRUE : FALSE;
        }
        return this.fail(`Unexpected keyword ${word}`);
      }
      default:
        break;
    }
    if (c === 0x5f /* _ */ && this.peek(1) === 0x3a /* : */) return this.blankNodeLabel();
    if (isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e) {
      NUMBER.lastIndex = this.i;
      const m = NUMBER.exec(this.input);
      if (m !== null) {
        this.i += m[0].length;
        const lexical = m[0];
        const datatype = /[eE]/.test(lexical)
          ? xsd.double
          : lexical.includes('.')
            ? xsd.decimal
            : xsd.integer;
        return Term.literal(lexical, datatype);
      }
      return this.fail(`Unexpected ${this.describe()}`);
    }
    if (c === 0x3a || isPnCharsBase(this.peekCp())) {
      const start = this.i;
      const name = this.name();
      if (name._tag === 'PName') return this.named(this.expandPName(name, start));
      switch (name.word) {
        case 'true':
          return TRUE;
        case 'false':
          return FALSE;
        default:
          return this.fail(`Unexpected keyword or undeclared prefix '${name.word}'`, start);
      }
    }
    return this.fail(`Unexpected ${this.describe()}`);
  }

  private bracket(): Model.N3Term {
    this.i++; // [
    this.ws();
    if (this.peek() === 0x5d /* ] */) {
      this.i++;
      return this.freshBlank();
    }
    // iriPropertyList: `[ id <iri> predicateObjectList ]`
    const start = this.i;
    if (isPnCharsBase(this.peekCp())) {
      const name = this.name();
      if (name._tag === 'Bare' && name.word === 'id') {
        this.ws();
        const iri = this.named(this.iriValue());
        this.ws();
        this.predicateObjectList(iri);
        this.expect(']');
        return iri;
      }
      this.i = start;
    }
    const b = this.freshBlank();
    this.predicateObjectList(b);
    this.expect(']');
    return b;
  }

  private collection(): Model.N3Term {
    this.i++; // (
    const items: Array<Model.N3Term> = [];
    for (;;) {
      this.ws();
      if (this.eof()) this.fail("Unterminated collection: expected ')'");
      if (this.peek() === 0x29 /* ) */) {
        this.i++;
        return new Model.Collection(items);
      }
      items.push(this.path());
    }
  }

  private formula(): Model.N3Term {
    this.i++; // {
    this.out.push([]);
    this.scopes.push(new Map());
    this.statements(true);
    this.i++; // }
    this.scopes.pop();
    const statements = this.out.pop()!;
    // An empty graph term is the literal `true` (N3 test suite: graph/empty_graph).
    return statements.length === 0 ? TRUE : new Model.Formula(statements);
  }

  private quickVar(): Model.N3Term {
    const start = this.i;
    this.i++; // ?
    if (!isPnCharsU(this.peekCp())) this.fail('Invalid variable name', start);
    while (!this.eof() && isPnChars(this.peekCp())) this.i += this.peekCp() > 0xffff ? 2 : 1;
    const name = this.input.slice(start + 1, this.i);
    this.variableNames.add(name);
    return new Term.Variable(name);
  }

  private blankNodeLabel(): Model.N3Term {
    const start = this.i;
    this.i += 2; // _:
    const first = this.peekCp();
    if (!(isPnCharsU(first) || isDigit(first))) this.fail('Invalid blank node label', start);
    this.i += first > 0xffff ? 2 : 1;
    let lastGood = this.i;
    while (!this.eof()) {
      const c = this.peekCp();
      if (c === 0x2e) this.i++;
      else if (isPnChars(c)) {
        this.i += c > 0xffff ? 2 : 1;
        lastGood = this.i;
      } else break;
    }
    this.i = lastGood;
    return this.labelledBlank(this.input.slice(start + 2, this.i));
  }

  // ---------------------------------------------------------------------------
  // Literals
  // ---------------------------------------------------------------------------

  private rdfLiteral(): Model.N3Term {
    const value = this.string();
    if (this.peek() === 0x40 /* @ */) {
      this.i++;
      LANGTAG.lastIndex = this.i;
      const m = LANGTAG.exec(this.input);
      if (m === null) this.fail('Invalid language tag');
      this.i += m[0].length;
      return Term.literal(value, m[0]);
    }
    const save = this.i;
    this.ws();
    if (this.startsWith('^^')) {
      this.i += 2;
      this.ws();
      const datatype = this.iriValue();
      const dir = datatype.startsWith(i18n.base)
        ? I18N_DATATYPE.exec(datatype.slice(i18n.base.length))
        : null;
      if (dir !== null) {
        return Term.literal(value, { language: dir[1]!, direction: dir[2] as Term.Direction });
      }
      return Term.literal(value, new Term.NamedNode(datatype));
    }
    this.i = save;
    return Term.literal(value);
  }

  private string(): string {
    const q = this.ch();
    const long = this.startsWith(q + q + q);
    const start = this.i;
    this.i += long ? 3 : 1;
    let out = '';
    const input = this.input;
    for (;;) {
      if (this.i >= input.length) this.fail('Unterminated string literal', start);
      const c = input.charAt(this.i);
      if (c === q) {
        if (!long) {
          this.i++;
          return out;
        }
        if (input.startsWith(q + q + q, this.i)) {
          this.i += 3;
          return out;
        }
        out += q;
        this.i++;
        continue;
      }
      if (c === '\\') {
        out += this.stringEscape();
        continue;
      }
      if (!long && (c === '\n' || c === '\r')) this.fail('Line break in short string literal');
      out += c;
      this.i++;
    }
  }

  private stringEscape(): string {
    const e = this.ch(1);
    switch (e) {
      case 't':
        this.i += 2;
        return '\t';
      case 'b':
        this.i += 2;
        return '\b';
      case 'n':
        this.i += 2;
        return '\n';
      case 'r':
        this.i += 2;
        return '\r';
      case 'f':
        this.i += 2;
        return '\f';
      case '"':
      case "'":
      case '\\':
        this.i += 2;
        return e;
      case 'u':
      case 'U':
        return this.uchar();
      default:
        return this.fail(`Invalid escape sequence '\\${e}'`);
    }
  }

  private uchar(): string {
    const n = this.ch(1) === 'u' ? 4 : 8;
    const hex = this.input.slice(this.i + 2, this.i + 2 + n);
    if (hex.length !== n || !/^[0-9A-Fa-f]+$/.test(hex)) {
      this.fail('Invalid unicode escape');
    }
    const cp = parseInt(hex, 16);
    if (cp > 0x10ffff) this.fail('Invalid unicode code point');
    this.i += 2 + n;
    return String.fromCodePoint(cp);
  }

  // ---------------------------------------------------------------------------
  // IRIs and names
  // ---------------------------------------------------------------------------

  /** Whether the `<` at the cursor starts an IRIREF (as opposed to `<=`/`<-`). */
  private looksLikeIriRef(): boolean {
    const input = this.input;
    for (let k = this.i + 1; k < input.length; k++) {
      const c = input.charCodeAt(k);
      if (c === 0x3e) return true;
      if (c <= 0x20 || c === 0x3c || c === 0x22 || c === 0x7b || c === 0x7d) return false;
      if (c === 0x7c || c === 0x5e || c === 0x60) return false;
    }
    return false;
  }

  /** Parses an IRIREF and returns its (unresolved, unescaped) value. */
  private iriRef(): string {
    const start = this.i;
    this.i++; // <
    let out = '';
    const input = this.input;
    for (;;) {
      if (this.i >= input.length) this.fail('Unterminated IRI', start);
      const c = input.charCodeAt(this.i);
      if (c === 0x3e) {
        this.i++;
        return out;
      }
      if (c === 0x5c /* \ */) {
        const e = this.ch(1);
        if (e !== 'u' && e !== 'U') this.fail('Invalid escape in IRI');
        const decoded = this.uchar();
        const d = decoded.codePointAt(0)!;
        if (d <= 0x20 || '<>"{}|^`\\'.includes(decoded))
          this.fail('Invalid escaped character in IRI');
        out += decoded;
        continue;
      }
      if (c <= 0x20 || c === 0x3c || c === 0x22 || c === 0x7b || c === 0x7d || c === 0x7c) {
        this.fail('Invalid character in IRI');
      }
      if (c === 0x5e || c === 0x60) this.fail('Invalid character in IRI');
      out += input.charAt(this.i);
      this.i++;
    }
  }

  /** An IRI in `iri` position: an IRIREF or a prefixed name, resolved. */
  private iriValue(): string {
    if (this.peek() === 0x3c) {
      if (!this.looksLikeIriRef()) this.fail(`Expected an IRI but found ${this.describe()}`);
      return this.resolveIri(this.iriRef());
    }
    const start = this.i;
    if (this.peek() === 0x3a || isPnCharsBase(this.peekCp())) {
      const name = this.name();
      if (name._tag === 'PName') return this.expandPName(name, start);
    }
    return this.fail(`Expected an IRI but found ${this.describe(start)}`, start);
  }

  private expandPName(name: Extract<Name, { _tag: 'PName' }>, at: number): string {
    const ns = this.prefixes.get(name.prefix);
    if (ns !== undefined) return ns + name.local;
    // The empty prefix defaults to `<#>` (the current document), as in cwm.
    if (name.prefix === '') return this.resolveIri('#') + name.local;
    return this.fail(`Undeclared prefix '${name.prefix}:'`, at);
  }

  private pnPrefix(): string {
    const start = this.i;
    this.i += this.peekCp() > 0xffff ? 2 : 1;
    let lastGood = this.i;
    while (!this.eof()) {
      const c = this.peekCp();
      if (c === 0x2e) this.i++;
      else if (isPnChars(c)) {
        this.i += c > 0xffff ? 2 : 1;
        lastGood = this.i;
      } else break;
    }
    this.i = lastGood;
    return this.input.slice(start, this.i);
  }

  /** Reads a prefixed name or a bare word (keyword). */
  private name(): Name {
    const prefix = this.peek() === 0x3a ? '' : this.pnPrefix();
    if (this.peek() !== 0x3a) return { _tag: 'Bare', word: prefix };
    this.i++; // :
    return { _tag: 'PName', prefix, local: this.pnLocal() };
  }

  private pnLocal(): string {
    let out = '';
    let lastGoodI = this.i;
    let lastGoodLen = 0;
    let first = true;
    const input = this.input;
    while (this.i < input.length) {
      const c = this.peekCp();
      if (c === 0x5c /* \ */) {
        const e = this.ch(1);
        if (!PN_LOCAL_ESCAPABLE.has(e)) this.fail(`Invalid escape '\\${e}' in local name`);
        out += e;
        this.i += 2;
      } else if (c === 0x25 /* % */) {
        if (!isHex(this.peek(1)) || !isHex(this.peek(2))) this.fail('Invalid percent escape');
        out += input.slice(this.i, this.i + 3);
        this.i += 3;
      } else if (c === 0x2e /* . */) {
        if (first) break;
        out += '.';
        this.i++;
        first = false;
        continue;
      } else if (c === 0x3a || (first ? isPnCharsU(c) || isDigit(c) : isPnChars(c))) {
        const s = String.fromCodePoint(c);
        out += s;
        this.i += s.length;
      } else break;
      first = false;
      lastGoodI = this.i;
      lastGoodLen = out.length;
    }
    this.i = lastGoodI;
    return out.slice(0, lastGoodLen);
  }
}
