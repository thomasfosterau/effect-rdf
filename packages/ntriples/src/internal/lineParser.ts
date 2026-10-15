import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Lexical from '../Lexical.ts';

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
export interface LineParserOptions {
  readonly quads: boolean;
  readonly blankNodePrefix: string;
  readonly graph: Term.Graph;
}

/**
 * A parser for single N-Triples / N-Quads lines. Each line holds at most one
 * statement, so documents can be parsed incrementally line by line.
 *
 * @internal
 */
export class LineParser {
  private input = '';
  private pos = 0;
  private line = 0;
  private readonly blankNodes = new Map<string, Term.BlankNode>();

  constructor(readonly options: LineParserOptions) {}

  /** Parses one line (without its line terminator). */
  parseLine(input: string, line: number): Term.Quad | undefined {
    this.input = input;
    this.pos = 0;
    this.line = line;
    this.ws();
    if (this.atEnd() || this.peek() === 0x23) return undefined;
    if (this.input.startsWith('VERSION', this.pos)) {
      this.pos += 7;
      this.ws();
      const q = this.peek();
      if (q !== 0x22 && q !== 0x27) this.fail('Expected a version string after VERSION');
      this.string(q);
      this.end();
      return undefined;
    }
    const subject = this.subject();
    this.ws();
    const predicate = this.predicate();
    this.ws();
    const object = this.object();
    this.ws();
    let graph = this.options.graph;
    if (this.options.quads) {
      const c = this.peek();
      if (c === 0x3c || c === 0x5f) {
        graph = c === 0x3c ? this.iri() : this.blankNode();
        this.ws();
      }
    }
    if (this.peek() !== 0x2e) this.fail("Expected '.' at the end of the statement");
    this.pos++;
    this.end();
    return new Term.Quad(subject, predicate, object, graph);
  }

  private fail(message: string, pos: number = this.pos): never {
    throw new SyntaxFailure(message, this.line, pos + 1);
  }

  private atEnd(): boolean {
    return this.pos >= this.input.length;
  }

  private peek(): number {
    return this.input.charCodeAt(this.pos);
  }

  private ws(): void {
    while (this.pos < this.input.length) {
      const c = this.input.charCodeAt(this.pos);
      if (c !== 0x20 && c !== 0x09) break;
      this.pos++;
    }
  }

  /** Expects optional whitespace, an optional comment, then end of line. */
  private end(): void {
    this.ws();
    if (!this.atEnd() && this.peek() !== 0x23) this.fail('Unexpected content after statement');
  }

  private subject(): Term.Subject {
    const c = this.peek();
    if (c === 0x3c) {
      if (this.input.startsWith('<<', this.pos)) {
        this.fail('Triple terms are only allowed in the object position');
      }
      return this.iri();
    }
    if (c === 0x5f) return this.blankNode();
    return this.fail('Expected an IRI or blank node as subject');
  }

  private predicate(): Term.NamedNode {
    if (this.peek() !== 0x3c || this.input.startsWith('<<', this.pos)) {
      this.fail('Expected an IRI as predicate');
    }
    return this.iri();
  }

  private object(): Term.Object {
    const c = this.peek();
    if (c === 0x3c) {
      if (this.input.startsWith('<<(', this.pos)) return this.tripleTerm();
      if (this.input.startsWith('<<', this.pos)) {
        this.fail('Reified triples are not allowed in N-Triples; use <<( ... )>>');
      }
      return this.iri();
    }
    if (c === 0x5f) return this.blankNode();
    if (c === 0x22) return this.literal();
    return this.fail('Expected an IRI, blank node, literal or triple term as object');
  }

  private tripleTerm(): Term.Triple {
    this.pos += 3;
    this.ws();
    const s = this.subject();
    this.ws();
    const p = this.predicate();
    this.ws();
    const o = this.object();
    this.ws();
    if (!this.input.startsWith(')>>', this.pos)) this.fail("Expected ')>>'");
    this.pos += 3;
    return new Term.Triple(s, p, o);
  }

  private iri(): Term.NamedNode {
    const start = this.pos;
    this.pos++;
    let value = '';
    let chunk = this.pos;
    for (;;) {
      if (this.atEnd()) this.fail('Unterminated IRI', start);
      const c = this.input.charCodeAt(this.pos);
      if (c === 0x3e) break;
      if (c === 0x5c) {
        value += this.input.slice(chunk, this.pos);
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
    if (!Lexical.isAbsoluteIri(value)) this.fail(`Relative IRI <${value}> is not allowed`, start);
    return new Term.NamedNode(value);
  }

  private blankNode(): Term.BlankNode {
    const start = this.pos;
    if (this.input.charCodeAt(this.pos + 1) !== 0x3a) this.fail('Expected a blank node label');
    this.pos += 2;
    const first = this.input.codePointAt(this.pos);
    if (first === undefined || (!Lexical.isPnCharsU(first) && !Lexical.isDigit(first))) {
      this.fail('Invalid blank node label');
    }
    this.pos += first > 0xffff ? 2 : 1;
    for (;;) {
      const c = this.input.codePointAt(this.pos);
      if (c === undefined || !(Lexical.isPnChars(c) || c === 0x2e)) break;
      this.pos += c > 0xffff ? 2 : 1;
    }
    while (this.input.charCodeAt(this.pos - 1) === 0x2e) this.pos--;
    const label = this.input.slice(start + 2, this.pos);
    let node = this.blankNodes.get(label);
    if (node === undefined) {
      node = new Term.BlankNode(
        this.options.blankNodePrefix + (label.startsWith('_') ? `_${label}` : label),
      );
      this.blankNodes.set(label, node);
    }
    return node;
  }

  /** Parses a short string starting at the opening quote `q`. */
  private string(q: number): string {
    const start = this.pos;
    this.pos++;
    let value = '';
    let chunk = this.pos;
    for (;;) {
      if (this.atEnd()) this.fail('Unterminated string literal', start);
      const c = this.input.charCodeAt(this.pos);
      if (c === q) break;
      if (c === 0x5c) {
        value += this.input.slice(chunk, this.pos);
        const e = this.input.charCodeAt(this.pos + 1);
        const echar = Lexical.decodeEchar(e);
        if (echar !== undefined) {
          value += echar;
          this.pos += 2;
        } else {
          const decoded = Lexical.decodeUchar(this.input, this.pos);
          if (decoded._tag === 'Error') this.fail(decoded.message);
          value += decoded.value;
          this.pos += decoded.length;
        }
        chunk = this.pos;
        continue;
      }
      if (c === 0x0a || c === 0x0d) this.fail('Line break in string literal');
      this.pos++;
    }
    value += this.input.slice(chunk, this.pos);
    this.pos++;
    return value;
  }

  private literal(): Term.Literal {
    const start = this.pos;
    const value = this.string(0x22);
    let annotation: Lexical.LanguageTag | Term.NamedNode | undefined;
    this.ws();
    const c = this.peek();
    if (c === 0x40) {
      const tagStart = ++this.pos;
      while (this.pos < this.input.length) {
        const d = this.input.charCodeAt(this.pos);
        if (
          !(
            (d >= 0x61 && d <= 0x7a) ||
            (d >= 0x41 && d <= 0x5a) ||
            (d >= 0x30 && d <= 0x39) ||
            d === 0x2d
          )
        ) {
          break;
        }
        this.pos++;
      }
      annotation = Lexical.parseLanguageTag(this.input.slice(tagStart, this.pos));
      if (annotation === undefined) this.fail('Invalid language tag', tagStart);
    } else if (c === 0x5e) {
      if (this.input.charCodeAt(this.pos + 1) !== 0x5e) this.fail("Expected '^^'");
      this.pos += 2;
      this.ws();
      if (this.peek() !== 0x3c) this.fail('Expected a datatype IRI');
      annotation = this.iri();
    }
    const literal = Lexical.makeLiteral(value, annotation);
    if (typeof literal === 'string') this.fail(literal, start);
    return literal;
  }
}

/**
 * Splits text into lines on `\n`, `\r` and `\r\n`.
 *
 * @internal
 */
export const splitLines = (input: string): Array<string> => input.split(/\r\n|\r|\n/);
