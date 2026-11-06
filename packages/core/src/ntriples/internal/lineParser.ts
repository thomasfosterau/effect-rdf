import * as Term from '../../Term.ts';
import * as Lexical from '../Lexical.ts';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import { loop } from './loop.ts';

/** Spaces and tabs (sticky: matched from `lastIndex`). */
const WS = /[ \t]*/y;

/** Runs of string characters that need no decoding, in `"…"` and `'…'` strings (sticky). */
const PLAIN_DOUBLE = /[^"\\\n\r]*/y;
const PLAIN_SINGLE = /[^'\\\n\r]*/y;

/**
 * The rest of a blank node label: `PN_CHARS` and `.` (sticky, by code point).
 * Spelt as a string, so that its escapes stay escapes.
 */
const LABEL_REST = new RegExp(
  '[A-Za-z0-9_.\\u00B7\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u037D\\u037F-\\u1FFF' +
    '\\u200C\\u200D\\u203F\\u2040\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF' +
    '\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}-]*',
  'uy',
);

/** The `.`s a label ends with, which end the statement instead. */
const TRAILING_DOTS = /\.+$/;

/** The characters a language tag (with its direction) may hold (sticky). */
const LANGUAGE_CHARS = /[a-zA-Z0-9-]*/y;

/** @internal */
export class SyntaxFailure extends Error {
  readonly line: number;
  readonly column: number;
  constructor(message: string, line: number, column: number) {
    super(message);
    this.line = line;
    this.column = column;
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
  private readonly blankNodes = MutableHashMap.empty<string, Term.BlankNode>();

  readonly options: LineParserOptions;
  constructor(options: LineParserOptions) {
    this.options = options;
  }

  /** Parses one line (without its line terminator): its statement, if it holds one. */
  parseLine(input: string, line: number): Option.Option<Term.Quad> {
    this.input = input;
    this.pos = 0;
    this.line = line;
    this.ws();
    if (this.atEnd() || this.peek() === 0x23) return Option.none();
    if (this.input.startsWith('VERSION', this.pos)) {
      this.pos += 7;
      this.ws();
      const q = this.peek();
      if (q !== 0x22 && q !== 0x27) this.fail('Expected a version string after VERSION');
      this.string(q);
      this.end();
      return Option.none();
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
    return Option.some(new Term.Quad(subject, predicate, object, graph));
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

  /** Skips `pattern` (sticky, matching the empty string too) from the current position. */
  private skip(pattern: RegExp): void {
    pattern.lastIndex = this.pos;
    pattern.test(this.input);
    this.pos = pattern.lastIndex;
  }

  private ws(): void {
    // Usually there is no space, or one: test the first character before running the pattern
    const c = this.input.charCodeAt(this.pos);
    if (c === 0x20 || c === 0x09) this.skip(WS);
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
    // Most IRIs have no escapes or invalid characters: the first `>` ends them. `escapeIri`
    // returns its argument when it holds none of the characters `isIriChar` rejects, nor `\`.
    const end = this.input.indexOf('>', start + 1);
    if (end !== -1) {
      const plain = this.input.slice(start + 1, end);
      if (Term.escapeIri(plain) === plain && Lexical.isAbsoluteIri(plain)) {
        this.pos = end + 1;
        return new Term.NamedNode(plain);
      }
    }
    this.pos++;
    let value = '';
    let chunk = this.pos;
    // Up to the closing `>`, decoding numeric escapes
    loop(() => {
      if (this.atEnd()) this.fail('Unterminated IRI', start);
      const c = this.input.charCodeAt(this.pos);
      if (c === 0x3e) return false;
      if (c === 0x5c) {
        value += this.input.slice(chunk, this.pos);
        const decoded = Lexical.decodeUchar(this.input, this.pos);
        if (Predicate.isTagged(decoded, 'Error')) return this.fail(decoded.message);
        // A decoded escape is one code point
        if (!Lexical.isIriChar(decoded.value.codePointAt(0) ?? 0)) {
          this.fail('Escaped character is not allowed in an IRI');
        }
        value += decoded.value;
        this.pos += decoded.length;
        chunk = this.pos;
        return true;
      }
      if (!Lexical.isIriChar(c)) this.fail('Invalid character in IRI');
      this.pos++;
      return true;
    });
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
    this.skip(LABEL_REST);
    // A label does not end with `.`: that is the statement's
    const label = this.input.slice(start + 2, this.pos).replace(TRAILING_DOTS, '');
    this.pos = start + 2 + label.length;
    const known = MutableHashMap.get(this.blankNodes, label);
    if (Option.isSome(known)) return known.value;
    const node = new Term.BlankNode(
      this.options.blankNodePrefix + (label.startsWith('_') ? `_${label}` : label),
    );
    MutableHashMap.set(this.blankNodes, label, node);
    return node;
  }

  /** Parses a short string starting at the opening quote `q`. */
  private string(q: number): string {
    const start = this.pos;
    this.pos++;
    let value = '';
    let chunk = this.pos;
    const plain = q === 0x22 ? PLAIN_DOUBLE : PLAIN_SINGLE;
    // Most strings have no escapes: one run of plain characters, then the closing quote
    this.skip(plain);
    if (this.peek() === q) {
      this.pos++;
      return this.input.slice(start + 1, this.pos - 1);
    }
    // Up to the closing quote, decoding escapes
    loop(() => {
      this.skip(plain);
      if (this.atEnd()) this.fail('Unterminated string literal', start);
      const c = this.input.charCodeAt(this.pos);
      if (c === q) return false;
      if (c === 0x5c) {
        value += this.input.slice(chunk, this.pos);
        const e = this.input.charCodeAt(this.pos + 1);
        const echar = Lexical.decodeEchar(e);
        if (echar !== undefined) {
          value += echar;
          this.pos += 2;
        } else {
          const decoded = Lexical.decodeUchar(this.input, this.pos);
          if (Predicate.isTagged(decoded, 'Error')) return this.fail(decoded.message);
          value += decoded.value;
          this.pos += decoded.length;
        }
        chunk = this.pos;
        return true;
      }
      if (c === 0x0a || c === 0x0d) this.fail('Line break in string literal');
      this.pos++;
      return true;
    });
    value += this.input.slice(chunk, this.pos);
    this.pos++;
    return value;
  }

  private literal(): Term.Literal {
    const start = this.pos;
    const value = this.string(0x22);
    this.ws();
    const c = this.peek();
    if (c === 0x40) {
      const tagStart = ++this.pos;
      this.skip(LANGUAGE_CHARS);
      const tag = Lexical.parseLanguageTag(this.input.slice(tagStart, this.pos));
      if (tag === undefined) return this.fail('Invalid language tag', tagStart);
      return this.made(Lexical.makeLiteral(value, tag), start);
    }
    if (c === 0x5e) {
      if (this.input.charCodeAt(this.pos + 1) !== 0x5e) this.fail("Expected '^^'");
      this.pos += 2;
      this.ws();
      if (this.peek() !== 0x3c) this.fail('Expected a datatype IRI');
      return this.made(Lexical.makeLiteral(value, this.iri()), start);
    }
    return this.made(Lexical.makeLiteral(value, undefined), start);
  }

  /** The literal `makeLiteral` made, or a failure at `start` with its message. */
  private made(literal: Term.Literal | string, start: number): Term.Literal {
    return Predicate.isString(literal) ? this.fail(literal, start) : literal;
  }
}

/**
 * Splits text into lines on `\n`, `\r` and `\r\n`.
 *
 * @internal
 */
export const splitLines = (input: string): Array<string> =>
  input.includes('\r') ? input.split(LINE_END) : input.split('\n');

const LINE_END = /\r\n|\r|\n/;
