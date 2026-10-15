/**
 * A resumable recursive-descent parser shared by Turtle and TriG (RDF 1.2).
 *
 * The parser works directly on the input string. It can be fed text
 * incrementally: when a statement runs into the end of the buffered input
 * before the input is known to be complete, the statement is rolled back and
 * retried once more text is available.
 *
 * @internal
 */
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { rdf, xsd } from '@thomasfosterau/effect-rdf/Vocab';
import * as Lexical from '@thomasfosterau/effect-ntriples/Lexical';

/** Thrown when more input is needed to finish the current statement. */
class NeedMore {}
const needMore = new NeedMore();

/** @internal */
export class SyntaxFailure extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
  }
}

/** @internal */
export interface ParserOptions {
  readonly trig: boolean;
  readonly baseIri: string | undefined;
  readonly blankNodePrefix: string;
  /** The graph for triples outside graph blocks. */
  readonly graph: Term.Graph;
}

const C_LT = 0x3c;
const C_GT = 0x3e;
const C_DOT = 0x2e;
const C_COLON = 0x3a;
const C_SEMI = 0x3b;
const C_COMMA = 0x2c;
const C_LBRACKET = 0x5b;
const C_RBRACKET = 0x5d;
const C_LPAREN = 0x28;
const C_RPAREN = 0x29;
const C_LBRACE = 0x7b;
const C_RBRACE = 0x7d;
const C_UNDERSCORE = 0x5f;
const C_DQUOTE = 0x22;
const C_SQUOTE = 0x27;
const C_BACKSLASH = 0x5c;
const C_HASH = 0x23;
const C_AT = 0x40;
const C_CARET = 0x5e;
const C_TILDE = 0x7e;
const C_PIPE = 0x7c;
const C_PERCENT = 0x25;
const C_PLUS = 0x2b;
const C_MINUS = 0x2d;

const LOCAL_ESCAPES = new Set("_~.-!$&'()*+,;=/?#@%");

const isWs = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/** @internal */
export class Parser {
  private input = '';
  private pos = 0;
  private final = true;
  /** Lines and columns consumed before the start of `input`. */
  private lineOffset = 0;
  private columnOffset = 0;
  private started = false;

  readonly prefixes = new Map<string, string>();
  base: string | undefined;
  private out: Array<Term.Quad> = [];
  private readonly labels = new Map<string, Term.BlankNode>();
  private counter = 0;
  private graph: Term.Graph;
  private inGraph = false;

  constructor(readonly options: ParserOptions) {
    this.base = options.baseIri;
    this.graph = options.graph;
  }

  // ---------------------------------------------------------------------------
  // Driving
  // ---------------------------------------------------------------------------

  /** Parses a complete document. */
  parseDocument(input: string): Array<Term.Quad> {
    this.input = input;
    this.pos = 0;
    this.final = true;
    this.skipBom();
    this.run();
    return this.finish();
  }

  /** Adds a chunk of input and returns the statements completed so far. */
  feed(chunk: string): Array<Term.Quad> {
    this.discardConsumed();
    this.input += chunk;
    this.final = false;
    this.skipBom();
    this.run();
    return this.take();
  }

  /** Signals the end of input and returns the remaining statements. */
  end(): Array<Term.Quad> {
    this.final = true;
    this.run();
    return this.finish();
  }

  private finish(): Array<Term.Quad> {
    if (this.inGraph) this.fail("Unterminated graph block: expected '}'");
    return this.take();
  }

  private take(): Array<Term.Quad> {
    const out = this.out;
    this.out = [];
    return out;
  }

  private skipBom(): void {
    if (this.started) return;
    if (this.input.length === 0) return;
    this.started = true;
    if (this.input.charCodeAt(0) === 0xfeff) this.pos = 1;
  }

  private discardConsumed(): void {
    if (this.pos === 0) return;
    const consumed = this.input.slice(0, this.pos);
    const lastBreak = Math.max(consumed.lastIndexOf('\n'), consumed.lastIndexOf('\r'));
    if (lastBreak === -1) {
      this.columnOffset += consumed.length;
    } else {
      this.lineOffset += countLines(consumed);
      this.columnOffset = consumed.length - lastBreak - 1;
    }
    this.input = this.input.slice(this.pos);
    this.pos = 0;
  }

  private run(): void {
    for (;;) {
      if (!this.skipTopLevel()) return;
      const pos = this.pos;
      const counter = this.counter;
      const outLength = this.out.length;
      const inGraph = this.inGraph;
      const graph = this.graph;
      try {
        this.statement();
      } catch (e) {
        if (e === needMore) {
          this.pos = pos;
          this.counter = counter;
          this.out.length = outLength;
          this.inGraph = inGraph;
          this.graph = graph;
          return;
        }
        throw e;
      }
    }
  }

  /**
   * Skips whitespace and complete comments between statements. Returns
   * `false` when no further statement can be started yet.
   */
  private skipTopLevel(): boolean {
    const input = this.input;
    for (;;) {
      if (this.pos >= input.length) return false;
      const c = input.charCodeAt(this.pos);
      if (isWs(c)) {
        this.pos++;
      } else if (c === C_HASH) {
        let i = this.pos + 1;
        while (i < input.length) {
          const d = input.charCodeAt(i);
          if (d === 0x0a || d === 0x0d) break;
          i++;
        }
        if (i >= input.length && !this.final) return false;
        this.pos = i;
      } else {
        return true;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Low-level scanning
  // ---------------------------------------------------------------------------

  private fail(message: string, pos: number = this.pos): never {
    const before = this.input.slice(0, pos);
    const lines = countLines(before);
    const lastBreak = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'));
    const column = lines === 0 ? this.columnOffset + pos + 1 : pos - lastBreak;
    throw new SyntaxFailure(message, this.lineOffset + lines + 1, column);
  }

  /** The UTF-16 code unit at `pos + offset`, or -1 at the end of input. */
  private peek(offset = 0): number {
    const i = this.pos + offset;
    if (i >= this.input.length) {
      if (!this.final) throw needMore;
      return -1;
    }
    return this.input.charCodeAt(i);
  }

  /** The code point at `pos`, or -1 at the end of input. */
  private peekCodePoint(): number {
    const c = this.peek();
    if (c >= 0xd800 && c <= 0xdbff) {
      this.peek(1);
      return this.input.codePointAt(this.pos)!;
    }
    return c;
  }

  private lookingAt(s: string): boolean {
    for (let k = 0; k < s.length; k++) {
      if (this.peek(k) !== s.charCodeAt(k)) return false;
    }
    return true;
  }

  private expect(c: number, what: string): void {
    if (this.peek() !== c) this.fail(`Expected ${what}`);
    this.pos++;
  }

  /** Skips whitespace and comments. */
  private ws(): void {
    const input = this.input;
    for (;;) {
      if (this.pos >= input.length) return;
      const c = input.charCodeAt(this.pos);
      if (isWs(c)) {
        this.pos++;
      } else if (c === C_HASH) {
        while (this.pos < input.length) {
          const d = input.charCodeAt(this.pos);
          if (d === 0x0a || d === 0x0d) break;
          this.pos++;
        }
      } else {
        return;
      }
    }
  }

  /** Whether `c` may continue a name (for keyword boundaries). */
  private static isNameChar(c: number): boolean {
    return c !== -1 && (Lexical.isPnChars(c) || c === C_COLON);
  }

  /** Matches a case-insensitive keyword followed by a non-name character. */
  private keyword(word: string): boolean {
    for (let k = 0; k < word.length; k++) {
      const c = this.peek(k);
      if (c === -1 || (c | 0x20) !== word.charCodeAt(k)) return false;
    }
    const next = this.peek(word.length);
    if (next >= 0xd800 && next <= 0xdbff) {
      this.peek(word.length + 1);
      return !Parser.isNameChar(this.input.codePointAt(this.pos + word.length)!);
    }
    return !Parser.isNameChar(next);
  }

  /** Matches a case-sensitive keyword followed by a non-name character. */
  private exactKeyword(word: string): boolean {
    return this.lookingAt(word) && !Parser.isNameChar(this.peek(word.length));
  }

  /** Matches an `@` keyword (a `LANGTAG`-like token). */
  private atKeyword(word: string): boolean {
    if (!this.lookingAt(word)) return false;
    const c = this.peek(word.length);
    return !(
      (c >= 0x61 && c <= 0x7a) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x30 && c <= 0x39) ||
      c === C_MINUS
    );
  }

  // ---------------------------------------------------------------------------
  // Statements
  // ---------------------------------------------------------------------------

  private emit(s: Term.Subject, p: Term.Predicate, o: Term.Object): void {
    this.out.push(new Term.Quad(s, p, o, this.graph));
  }

  private statement(): void {
    if (this.inGraph) {
      if (this.peek() === C_RBRACE) {
        this.pos++;
        this.inGraph = false;
        this.graph = this.options.graph;
        return;
      }
      this.triples();
      this.ws();
      const c = this.peek();
      if (c === C_DOT) this.pos++;
      else if (c !== C_RBRACE) this.fail("Expected '.' or '}'");
      return;
    }
    const c = this.peek();
    if (c === C_AT) return this.atDirective();
    if (this.keyword('prefix')) {
      this.pos += 6;
      return this.prefixDirective(false);
    }
    if (this.keyword('base')) {
      this.pos += 4;
      return this.baseDirective(false);
    }
    if (this.keyword('version')) {
      this.pos += 7;
      return this.versionDirective(false);
    }
    if (this.options.trig) return this.block();
    this.triples();
    this.ws();
    this.expect(C_DOT, "'.' at the end of the statement");
  }

  private atDirective(): void {
    if (this.atKeyword('@prefix')) {
      this.pos += 7;
      return this.prefixDirective(true);
    }
    if (this.atKeyword('@base')) {
      this.pos += 5;
      return this.baseDirective(true);
    }
    if (this.atKeyword('@version')) {
      this.pos += 8;
      return this.versionDirective(true);
    }
    this.fail('Unknown directive');
  }

  private prefixDirective(turtleStyle: boolean): void {
    this.ws();
    const start = this.pos;
    const prefix = this.prefixName();
    if (this.peek() !== C_COLON) this.fail('Expected a prefix name ending with ":"', start);
    this.pos++;
    this.ws();
    if (this.peek() !== C_LT) this.fail('Expected an IRI');
    const iri = this.iri();
    if (turtleStyle) {
      this.ws();
      this.expect(C_DOT, "'.' after @prefix");
    }
    this.prefixes.set(prefix, iri.value);
  }

  private baseDirective(turtleStyle: boolean): void {
    this.ws();
    if (this.peek() !== C_LT) this.fail('Expected an IRI');
    const iri = this.iri();
    if (turtleStyle) {
      this.ws();
      this.expect(C_DOT, "'.' after @base");
    }
    this.base = iri.value;
  }

  private versionDirective(turtleStyle: boolean): void {
    this.ws();
    const q = this.peek();
    if (q !== C_DQUOTE && q !== C_SQUOTE) this.fail('Expected a version string');
    if (this.peek(1) === q && this.peek(2) === q) {
      this.fail('Long strings are not allowed as version specifiers');
    }
    this.string();
    if (turtleStyle) {
      this.ws();
      this.expect(C_DOT, "'.' after @version");
    }
  }

  /** TriG top-level block. */
  private block(): void {
    const c = this.peek();
    if (c === C_LBRACE) {
      this.pos++;
      this.openGraph(Term.defaultGraph);
      return;
    }
    if (this.keyword('graph')) {
      this.pos += 5;
      this.ws();
      const label = this.graphLabel();
      this.ws();
      if (this.peek() !== C_LBRACE) this.fail("Expected '{' after graph name");
      this.pos++;
      this.openGraph(label);
      return;
    }
    if (c === C_LBRACKET) {
      if (this.anonAhead()) {
        const node = this.anon();
        this.ws();
        if (this.peek() === C_LBRACE) {
          this.pos++;
          this.openGraph(node);
          return;
        }
        this.predicateObjectList(node);
      } else {
        const node = this.blankNodePropertyList();
        this.ws();
        if (this.peek() !== C_DOT) this.predicateObjectList(node);
      }
    } else if (c === C_LPAREN) {
      const node = this.collection();
      this.ws();
      this.predicateObjectList(node);
    } else if (c === C_LT && this.peek(1) === C_LT) {
      if (this.peek(2) === C_LPAREN) this.fail('Triple terms are not allowed as subjects');
      const node = this.reifiedTriple();
      this.ws();
      if (this.peek() !== C_DOT) this.predicateObjectList(node);
    } else {
      const node = this.resource();
      this.ws();
      if (this.peek() === C_LBRACE) {
        this.pos++;
        this.openGraph(node);
        return;
      }
      this.predicateObjectList(node);
    }
    this.ws();
    this.expect(C_DOT, "'.' at the end of the statement");
  }

  private openGraph(graph: Term.Graph): void {
    this.inGraph = true;
    this.graph = graph;
  }

  private graphLabel(): Term.NamedNode | Term.BlankNode {
    if (this.peek() === C_LBRACKET) {
      if (!this.anonAhead()) this.fail('Expected a graph name');
      return this.anon();
    }
    return this.resource();
  }

  /** An IRI or blank node label (no anonymous nodes). */
  private resource(): Term.NamedNode | Term.BlankNode {
    const c = this.peek();
    if (c === C_LT) {
      if (this.peek(1) === C_LT) this.fail('Unexpected triple');
      return this.iri();
    }
    if (c === C_UNDERSCORE && this.peek(1) === C_COLON) return this.blankNodeLabel();
    return this.prefixedName();
  }

  private triples(): void {
    const c = this.peek();
    if (c === C_LBRACKET) {
      if (this.anonAhead()) {
        const node = this.anon();
        this.ws();
        this.predicateObjectList(node);
      } else {
        const node = this.blankNodePropertyList();
        this.ws();
        const d = this.peek();
        if (d !== C_DOT && d !== C_RBRACE) this.predicateObjectList(node);
      }
      return;
    }
    if (c === C_LPAREN) {
      const node = this.collection();
      this.ws();
      this.predicateObjectList(node);
      return;
    }
    if (c === C_LT && this.peek(1) === C_LT) {
      if (this.peek(2) === C_LPAREN) this.fail('Triple terms are not allowed as subjects');
      const node = this.reifiedTriple();
      this.ws();
      const d = this.peek();
      if (d !== C_DOT && d !== C_RBRACE) this.predicateObjectList(node);
      return;
    }
    const subject = this.resource();
    this.ws();
    this.predicateObjectList(subject);
  }

  private predicateObjectList(subject: Term.Subject): void {
    for (;;) {
      const predicate = this.verb();
      this.ws();
      this.objectList(subject, predicate);
      this.ws();
      if (this.peek() !== C_SEMI) return;
      while (this.peek() === C_SEMI) {
        this.pos++;
        this.ws();
      }
      if (!this.startsVerb()) return;
    }
  }

  private startsVerb(): boolean {
    const c = this.peek();
    if (c === C_LT) return this.peek(1) !== C_LT;
    if (c === C_COLON) return true;
    return Lexical.isPnCharsBase(this.peekCodePoint());
  }

  private verb(): Term.NamedNode {
    const c = this.peek();
    if (c === C_LT) {
      if (this.peek(1) === C_LT) this.fail('Triples are not allowed as predicates');
      return this.iri();
    }
    if (c === 0x61 && !Parser.isNameChar(this.peek(1))) {
      this.pos++;
      return rdf.type;
    }
    if (c === C_COLON || Lexical.isPnCharsBase(this.peekCodePoint())) return this.prefixedName();
    return this.fail('Expected a predicate');
  }

  private objectList(subject: Term.Subject, predicate: Term.Predicate): void {
    for (;;) {
      const object = this.object();
      this.emit(subject, predicate, object);
      this.annotation(subject, predicate, object);
      this.ws();
      if (this.peek() !== C_COMMA) return;
      this.pos++;
      this.ws();
    }
  }

  private annotation(subject: Term.Subject, predicate: Term.Predicate, object: Term.Object): void {
    let reifier: Term.NamedNode | Term.BlankNode | undefined;
    let triple: Term.Triple | undefined;
    for (;;) {
      this.ws();
      const c = this.peek();
      if (c === C_TILDE) {
        this.pos++;
        this.ws();
        reifier = this.startsReifierId() ? this.reifierId() : this.fresh();
        triple ??= new Term.Triple(subject, predicate, object);
        this.emit(reifier, rdf.reifies, triple);
      } else if (c === C_LBRACE && this.peek(1) === C_PIPE) {
        this.pos += 2;
        if (reifier === undefined) {
          reifier = this.fresh();
          triple ??= new Term.Triple(subject, predicate, object);
          this.emit(reifier, rdf.reifies, triple);
        }
        this.ws();
        this.predicateObjectList(reifier);
        this.ws();
        if (!(this.peek() === C_PIPE && this.peek(1) === C_RBRACE)) this.fail("Expected '|}'");
        this.pos += 2;
        reifier = undefined;
      } else {
        return;
      }
    }
  }

  private startsReifierId(): boolean {
    const c = this.peek();
    if (c === C_LT) return this.peek(1) !== C_LT;
    if (c === C_UNDERSCORE) return this.peek(1) === C_COLON;
    if (c === C_LBRACKET) return this.anonAhead();
    if (c === C_COLON) return true;
    return Lexical.isPnCharsBase(this.peekCodePoint());
  }

  private reifierId(): Term.NamedNode | Term.BlankNode {
    return this.peek() === C_LBRACKET ? this.anon() : this.resource();
  }

  // ---------------------------------------------------------------------------
  // Terms
  // ---------------------------------------------------------------------------

  private object(): Term.Object {
    const c = this.peek();
    switch (c) {
      case C_LT:
        if (this.peek(1) === C_LT) {
          return this.peek(2) === C_LPAREN ? this.tripleTerm() : this.reifiedTriple();
        }
        return this.iri();
      case C_UNDERSCORE:
        if (this.peek(1) !== C_COLON) return this.prefixedName();
        return this.blankNodeLabel();
      case C_LBRACKET:
        return this.anonAhead() ? this.anon() : this.blankNodePropertyList();
      case C_LPAREN:
        return this.collection();
      case C_DQUOTE:
      case C_SQUOTE:
        return this.rdfLiteral();
      default:
        return this.simpleObject(c);
    }
  }

  /** Numbers, booleans and prefixed names. */
  private simpleObject(c: number): Term.Object {
    if ((c >= 0x30 && c <= 0x39) || c === C_PLUS || c === C_MINUS || c === C_DOT) {
      return this.numericLiteral();
    }
    if (this.exactKeyword('true')) {
      this.pos += 4;
      return new Term.Literal('true', xsd.boolean);
    }
    if (this.exactKeyword('false')) {
      this.pos += 5;
      return new Term.Literal('false', xsd.boolean);
    }
    if (c === C_COLON || Lexical.isPnCharsBase(this.peekCodePoint())) return this.prefixedName();
    return this.fail('Expected an object');
  }

  /** `iri | BlankNode` including `[]`. */
  private iriOrBlankNode(what: string): Term.NamedNode | Term.BlankNode {
    const c = this.peek();
    if (c === C_LBRACKET) {
      if (!this.anonAhead()) this.fail(`Blank node property lists are not allowed in ${what}`);
      return this.anon();
    }
    if (c === C_LT && this.peek(1) === C_LT) this.fail(`Unexpected triple in ${what}`);
    if (c === C_LPAREN) this.fail(`Collections are not allowed in ${what}`);
    if (c === C_LT || c === C_UNDERSCORE || c === C_COLON) return this.resource();
    if (c !== -1 && Lexical.isPnCharsBase(this.peekCodePoint()) && !this.isBooleanKeyword()) {
      return this.resource();
    }
    return this.fail(`Expected an IRI or blank node in ${what}`);
  }

  private isBooleanKeyword(): boolean {
    return this.exactKeyword('true') || this.exactKeyword('false');
  }

  private reifiedTriple(): Term.NamedNode | Term.BlankNode {
    this.pos += 2;
    this.ws();
    const subject: Term.Subject =
      this.peek() === C_LT && this.peek(1) === C_LT && this.peek(2) !== C_LPAREN
        ? this.reifiedTriple()
        : this.iriOrBlankNode('the subject of a reified triple');
    this.ws();
    const predicate = this.verb();
    this.ws();
    const object = this.innerObject(true);
    this.ws();
    let reifier: Term.NamedNode | Term.BlankNode | undefined;
    if (this.peek() === C_TILDE) {
      this.pos++;
      this.ws();
      if (this.startsReifierId()) reifier = this.reifierId();
      this.ws();
    }
    if (!(this.peek() === C_GT && this.peek(1) === C_GT)) this.fail("Expected '>>'");
    this.pos += 2;
    reifier ??= this.fresh();
    this.emit(reifier, rdf.reifies, new Term.Triple(subject, predicate, object));
    return reifier;
  }

  private tripleTerm(): Term.Triple {
    this.pos += 3;
    this.ws();
    const subject = this.iriOrBlankNode('the subject of a triple term');
    this.ws();
    const predicate = this.verb();
    this.ws();
    const object = this.innerObject(false);
    this.ws();
    if (!(this.peek() === C_RPAREN && this.peek(1) === C_GT && this.peek(2) === C_GT)) {
      this.fail("Expected ')>>'");
    }
    this.pos += 3;
    return new Term.Triple(subject, predicate, object);
  }

  /** The object of a reified triple or triple term. */
  private innerObject(reified: boolean): Term.Object {
    const c = this.peek();
    const what = reified ? 'reified triples' : 'triple terms';
    if (c === C_LT && this.peek(1) === C_LT) {
      if (this.peek(2) === C_LPAREN) return this.tripleTerm();
      if (!reified) this.fail('Reified triples are not allowed in triple terms');
      return this.reifiedTriple();
    }
    if (c === C_LT || c === C_UNDERSCORE) return this.resource();
    if (c === C_LBRACKET) {
      if (!this.anonAhead()) this.fail(`Blank node property lists are not allowed in ${what}`);
      return this.anon();
    }
    if (c === C_LPAREN) this.fail(`Collections are not allowed in ${what}`);
    if (c === C_DQUOTE || c === C_SQUOTE) return this.rdfLiteral();
    return this.simpleObject(c);
  }

  private fresh(): Term.BlankNode {
    return new Term.BlankNode(`${this.options.blankNodePrefix}_${(this.counter++).toString(36)}`);
  }

  /** Whether the input continues with `[` WS* `]`. */
  private anonAhead(): boolean {
    let k = 1;
    for (;;) {
      const c = this.peek(k);
      if (c === C_RBRACKET) return true;
      if (!isWs(c)) return false;
      k++;
    }
  }

  private anon(): Term.BlankNode {
    this.pos++;
    while (this.peek() !== C_RBRACKET) this.pos++;
    this.pos++;
    return this.fresh();
  }

  private blankNodePropertyList(): Term.BlankNode {
    this.pos++;
    const node = this.fresh();
    this.ws();
    this.predicateObjectList(node);
    this.ws();
    this.expect(C_RBRACKET, "']'");
    return node;
  }

  private collection(): Term.NamedNode | Term.BlankNode {
    this.pos++;
    this.ws();
    const items: Array<Term.Object> = [];
    while (this.peek() !== C_RPAREN) {
      if (this.peek() === -1) this.fail("Expected ')'");
      items.push(this.object());
      this.ws();
    }
    this.pos++;
    if (items.length === 0) return rdf.nil;
    const nodes = items.map(() => this.fresh());
    for (let i = 0; i < items.length; i++) {
      this.emit(nodes[i]!, rdf.first, items[i]!);
      this.emit(nodes[i]!, rdf.rest, i + 1 < nodes.length ? nodes[i + 1]! : rdf.nil);
    }
    return nodes[0]!;
  }

  private blankNodeLabel(): Term.BlankNode {
    const start = this.pos;
    this.pos += 2;
    const first = this.peekCodePoint();
    if (first === -1 || (!Lexical.isPnCharsU(first) && !Lexical.isDigit(first))) {
      this.fail('Invalid blank node label');
    }
    this.pos += first > 0xffff ? 2 : 1;
    let end = this.pos;
    for (;;) {
      const c = this.peekCodePoint();
      if (c === C_DOT) {
        this.pos++;
      } else if (c !== -1 && Lexical.isPnChars(c)) {
        this.pos += c > 0xffff ? 2 : 1;
        end = this.pos;
      } else {
        break;
      }
    }
    this.pos = end;
    const label = this.input.slice(start + 2, end);
    let node = this.labels.get(label);
    if (node === undefined) {
      node = new Term.BlankNode(
        this.options.blankNodePrefix + (label.startsWith('_') ? `_${label}` : label),
      );
      this.labels.set(label, node);
    }
    return node;
  }

  private iri(): Term.NamedNode {
    const start = this.pos;
    this.pos++;
    let value = '';
    let chunk = this.pos;
    for (;;) {
      const c = this.peek();
      if (c === C_GT) break;
      if (c === -1) this.fail('Unterminated IRI', start);
      if (c === C_BACKSLASH) {
        value += this.input.slice(chunk, this.pos);
        this.peek(1);
        this.peek(this.input.charCodeAt(this.pos + 1) === 0x55 ? 9 : 5);
        const decoded = Lexical.decodeUchar(this.input, this.pos);
        if (decoded._tag === 'Error') this.fail(decoded.message);
        if (!Lexical.isIriChar(decoded.value.codePointAt(0)!)) {
          this.fail('Escaped character is not allowed in an IRI');
        }
        value += decoded.value;
        this.pos += decoded.length;
        chunk = this.pos;
        continue;
      }
      if (!Lexical.isIriChar(c)) this.fail('Invalid character in IRI');
      this.pos++;
    }
    value += this.input.slice(chunk, this.pos);
    this.pos++;
    return new Term.NamedNode(this.resolve(value, start));
  }

  private resolve(value: string, pos: number): string {
    if (this.base === undefined) {
      if (!Lexical.isAbsoluteIri(value)) {
        this.fail(`Relative IRI <${value}> cannot be resolved without a base IRI`, pos);
      }
      return value;
    }
    return Iri.resolve(value, this.base);
  }

  /** Reads a `PN_PREFIX` (possibly empty), stopping before the colon. */
  private prefixName(): string {
    const start = this.pos;
    const first = this.peekCodePoint();
    if (first === C_COLON) return '';
    if (first === -1 || !Lexical.isPnCharsBase(first)) this.fail('Invalid prefix name');
    this.pos += first > 0xffff ? 2 : 1;
    for (;;) {
      const c = this.peekCodePoint();
      if (c === C_DOT || (c !== -1 && Lexical.isPnChars(c))) this.pos += c > 0xffff ? 2 : 1;
      else break;
    }
    if (this.input.charCodeAt(this.pos - 1) === C_DOT) {
      this.fail('A prefix name must not end with "."', start);
    }
    return this.input.slice(start, this.pos);
  }

  private prefixedName(): Term.NamedNode {
    const start = this.pos;
    const prefix = this.prefixName();
    if (this.peek() !== C_COLON) this.fail('Expected a prefixed name', start);
    this.pos++;
    let local = '';
    let goodLocal = '';
    let goodPos = this.pos;
    let first = true;
    for (;;) {
      const c = this.peekCodePoint();
      if (c === -1) break;
      if (c === C_PERCENT) {
        const h1 = this.peek(1);
        const h2 = this.peek(2);
        if (!Lexical.isHex(h1) || !Lexical.isHex(h2)) this.fail('Invalid percent escape');
        local += this.input.slice(this.pos, this.pos + 3);
        this.pos += 3;
      } else if (c === C_BACKSLASH) {
        const e = this.peek(1);
        const ch = String.fromCharCode(e);
        if (e === -1 || !LOCAL_ESCAPES.has(ch)) this.fail('Invalid escape in local name');
        local += ch;
        this.pos += 2;
      } else if (
        first
          ? Lexical.isPnCharsU(c) || c === C_COLON || Lexical.isDigit(c)
          : Lexical.isPnChars(c) || c === C_COLON || c === C_DOT
      ) {
        local += String.fromCodePoint(c);
        this.pos += c > 0xffff ? 2 : 1;
        if (c === C_DOT) {
          first = false;
          continue;
        }
      } else {
        break;
      }
      first = false;
      goodLocal = local;
      goodPos = this.pos;
    }
    this.pos = goodPos;
    const ns = this.prefixes.get(prefix);
    if (ns === undefined) this.fail(`Undefined prefix "${prefix}:"`, start);
    return new Term.NamedNode(ns + goodLocal);
  }

  /** Parses any of the four string forms, starting at the opening quote. */
  private string(): string {
    const start = this.pos;
    const q = this.peek();
    const long = this.peek(1) === q && this.peek(2) === q;
    if (!long && this.peek(1) === q) {
      this.pos += 2;
      return '';
    }
    this.pos += long ? 3 : 1;
    let value = '';
    let chunk = this.pos;
    for (;;) {
      const c = this.peek();
      if (c === -1) this.fail('Unterminated string literal', start);
      if (c === q) {
        if (!long) break;
        if (this.peek(1) === q && this.peek(2) === q) break;
        this.pos++;
        continue;
      }
      if (c === C_BACKSLASH) {
        value += this.input.slice(chunk, this.pos);
        const e = this.peek(1);
        const echar = Lexical.decodeEchar(e);
        if (echar !== undefined) {
          value += echar;
          this.pos += 2;
        } else {
          this.peek(e === 0x55 ? 9 : 5);
          const decoded = Lexical.decodeUchar(this.input, this.pos);
          if (decoded._tag === 'Error') this.fail(decoded.message);
          value += decoded.value;
          this.pos += decoded.length;
        }
        chunk = this.pos;
        continue;
      }
      if (!long && (c === 0x0a || c === 0x0d)) this.fail('Line break in string literal');
      this.pos++;
    }
    value += this.input.slice(chunk, this.pos);
    this.pos += long ? 3 : 1;
    return value;
  }

  private rdfLiteral(): Term.Literal {
    const start = this.pos;
    const value = this.string();
    this.ws();
    let annotation: Lexical.LanguageTag | Term.NamedNode | undefined;
    const c = this.peek();
    if (c === C_AT) {
      const tagStart = ++this.pos;
      for (;;) {
        const d = this.peek();
        if (
          (d >= 0x61 && d <= 0x7a) ||
          (d >= 0x41 && d <= 0x5a) ||
          (d >= 0x30 && d <= 0x39) ||
          d === C_MINUS
        ) {
          this.pos++;
        } else {
          break;
        }
      }
      annotation = Lexical.parseLanguageTag(this.input.slice(tagStart, this.pos));
      if (annotation === undefined) this.fail('Invalid language tag', tagStart);
    } else if (c === C_CARET) {
      if (this.peek(1) !== C_CARET) this.fail("Expected '^^'");
      this.pos += 2;
      this.ws();
      const d = this.peek();
      if (d === C_LT && this.peek(1) !== C_LT) annotation = this.iri();
      else if (d === C_COLON || (d !== -1 && Lexical.isPnCharsBase(this.peekCodePoint()))) {
        annotation = this.prefixedName();
      } else this.fail('Expected a datatype IRI');
    }
    const literal = Lexical.makeLiteral(value, annotation);
    if (typeof literal === 'string') this.fail(literal, start);
    return literal;
  }

  private digits(): number {
    let n = 0;
    for (;;) {
      const c = this.peek();
      if (c < 0x30 || c > 0x39) return n;
      this.pos++;
      n++;
    }
  }

  private exponent(): boolean {
    const c = this.peek();
    if (c !== 0x65 && c !== 0x45) return false;
    let k = 1;
    const s = this.peek(1);
    if (s === C_PLUS || s === C_MINUS) k = 2;
    const d = this.peek(k);
    if (d < 0x30 || d > 0x39) return false;
    this.pos += k;
    this.digits();
    return true;
  }

  private numericLiteral(): Term.Literal {
    const start = this.pos;
    const sign = this.peek();
    if (sign === C_PLUS || sign === C_MINUS) this.pos++;
    const intDigits = this.digits();
    let datatype: Term.NamedNode = xsd.integer;
    if (this.peek() === C_DOT) {
      const next = this.peek(1);
      if (next >= 0x30 && next <= 0x39) {
        this.pos++;
        this.digits();
        datatype = xsd.decimal;
      } else if (intDigits > 0 && (next === 0x65 || next === 0x45)) {
        const save = this.pos;
        this.pos++;
        if (this.exponent()) return new Term.Literal(this.input.slice(start, this.pos), xsd.double);
        this.pos = save;
      }
    }
    if (intDigits === 0 && datatype !== xsd.decimal) this.fail('Invalid number', start);
    if (this.exponent()) datatype = xsd.double;
    return new Term.Literal(this.input.slice(start, this.pos), datatype);
  }
}

const countLines = (text: string): number => {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) n++;
    else if (c === 0x0d && text.charCodeAt(i + 1) !== 0x0a) n++;
  }
  return n;
};
