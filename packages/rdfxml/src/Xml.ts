/**
 * A small, namespace-aware, non-validating XML 1.0 parser producing an
 * immutable document tree, plus Exclusive XML Canonicalization (with
 * comments) of element content.
 *
 * Supported: the XML declaration, a document type declaration whose internal
 * subset may declare general entities and attribute defaults, elements,
 * attributes (with attribute-value normalisation), Namespaces in XML 1.0,
 * CDATA sections, comments, processing instructions, and character and
 * entity references. External entities and parameter entities are not
 * loaded (they are reported as errors when referenced).
 *
 * The parser is pure and synchronous internally; the public `parse` API
 * returns an `Effect` failing with `XmlParseError`.
 *
 * @since 0.1.0
 */
import * as Effect from 'effect/Effect';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';

/**
 * The XML namespace, bound to the `xml` prefix.
 *
 * @since 0.1.0
 * @category constants
 */
export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';

/**
 * The namespace of namespace declarations (`xmlns`).
 *
 * @since 0.1.0
 * @category constants
 */
export const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

// -----------------------------------------------------------------------------
// Model
// -----------------------------------------------------------------------------

/**
 * A position in the (line-end normalised) input. Lines and columns are
 * 1-based; the column counts UTF-16 code units.
 *
 * @since 0.1.0
 * @category models
 */
export interface Position {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

/**
 * An attribute with its namespace-resolved name and normalised value.
 * Namespace declarations are not attributes; see
 * `Element.namespaceDeclarations`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Attribute {
  readonly _tag: 'Attribute';
  /** The qualified name as written. */
  readonly name: string;
  /** The prefix, or `""` for unprefixed attributes. */
  readonly prefix: string;
  readonly localName: string;
  /** The namespace name; unprefixed attributes have no namespace. */
  readonly namespace: string | undefined;
  readonly value: string;
  /** Whether the attribute was supplied by an `<!ATTLIST>` default. */
  readonly defaulted: boolean;
  readonly position: Position;
}

/**
 * A namespace declaration (`xmlns="…"` or `xmlns:p="…"`).
 *
 * @since 0.1.0
 * @category models
 */
export interface NamespaceDeclaration {
  /** The declared prefix, or `""` for the default namespace. */
  readonly prefix: string;
  /** The namespace name (`""` undeclares the default namespace). */
  readonly namespace: string;
}

/**
 * An element.
 *
 * @since 0.1.0
 * @category models
 */
export interface Element {
  readonly _tag: 'Element';
  /** The qualified name as written. */
  readonly name: string;
  /** The prefix, or `""` for unprefixed elements. */
  readonly prefix: string;
  readonly localName: string;
  /** The namespace name, or `undefined` when the element is in no namespace. */
  readonly namespace: string | undefined;
  readonly attributes: ReadonlyArray<Attribute>;
  readonly namespaceDeclarations: ReadonlyArray<NamespaceDeclaration>;
  /**
   * All namespace bindings in scope (prefix → namespace, `""` for the
   * default namespace). The implicit `xml` binding is not included and
   * undeclared default namespaces are absent.
   */
  readonly inScopeNamespaces: ReadonlyMap<string, string>;
  readonly children: ReadonlyArray<Node>;
  readonly position: Position;
}

/**
 * Character data. Adjacent character data, references and CDATA sections
 * are merged into a single text node.
 *
 * @since 0.1.0
 * @category models
 */
export interface Text {
  readonly _tag: 'Text';
  readonly value: string;
  readonly position: Position;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface Comment {
  readonly _tag: 'Comment';
  readonly value: string;
  readonly position: Position;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface ProcessingInstruction {
  readonly _tag: 'ProcessingInstruction';
  readonly target: string;
  readonly data: string;
  readonly position: Position;
}

/**
 * A child of an element.
 *
 * @since 0.1.0
 * @category models
 */
export type Node = Element | Text | Comment | ProcessingInstruction;

/**
 * The document type declaration, if present.
 *
 * @since 0.1.0
 * @category models
 */
export interface DocumentType {
  readonly name: string;
  readonly publicId: string | undefined;
  readonly systemId: string | undefined;
  /** Internal general entities (name → replacement text). */
  readonly entities: ReadonlyMap<string, string>;
}

/**
 * A parsed XML document.
 *
 * @since 0.1.0
 * @category models
 */
export interface Document {
  readonly _tag: 'Document';
  readonly version: string | undefined;
  readonly encoding: string | undefined;
  readonly standalone: boolean | undefined;
  readonly doctype: DocumentType | undefined;
  /** Comments and processing instructions before the root element. */
  readonly prolog: ReadonlyArray<Comment | ProcessingInstruction>;
  readonly root: Element;
  /** Comments and processing instructions after the root element. */
  readonly epilog: ReadonlyArray<Comment | ProcessingInstruction>;
}

/**
 * A well-formedness or namespace error.
 *
 * @since 0.1.0
 * @category errors
 */
export class XmlParseError extends Schema.TaggedError<XmlParseError>()('XmlParseError', {
  message: Schema.String,
  offset: Schema.Number,
  line: Schema.Number,
  column: Schema.Number,
}) {}

// -----------------------------------------------------------------------------
// Character classes
// -----------------------------------------------------------------------------

/**
 * The XML `NameStartChar` production as a regular expression character
 * class body (without brackets), excluding `:`. Requires the `u` flag.
 *
 * @since 0.1.0
 * @category constants
 */
export const NAME_START =
  'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
/**
 * The XML `NameChar` production as a regular expression character class
 * body (without brackets), excluding `:`. Requires the `u` flag.
 *
 * @since 0.1.0
 * @category constants
 */
export const NAME_CHAR = `${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;

const NAME_RE = new RegExp(`[:${NAME_START}][:${NAME_CHAR}]*`, 'uy');
const NCNAME_RE = new RegExp(`^[${NAME_START}][${NAME_CHAR}]*$`, 'u');
const NMTOKEN_RE = new RegExp(`^[:${NAME_CHAR}]+$`, 'u');

const INVALID_CHAR_RE = new RegExp(
  '[^\\t\\n\\r\\u0020-\\uD7FF\\uE000-\\uFFFD\\u{10000}-\\u{10FFFF}]',
  'u',
);
const PUBID_RE = /^[ \r\na-zA-Z0-9\-'()+,./:=?;!*#@$_%]*$/;

/**
 * Whether a string is an XML `NCName` (a name without colons), as required
 * for namespace prefixes, local names, `rdf:ID` and `rdf:nodeID`.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isNCName = (value: string): boolean => NCNAME_RE.test(value);

/**
 * Whether a string is an XML `Name`.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isName = (value: string): boolean => {
  NAME_RE.lastIndex = 0;
  const m = NAME_RE.exec(value);
  return m !== null && m[0].length === value.length;
};

/**
 * Whether a string consists only of characters allowed in XML 1.0 documents.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isValidText = (value: string): boolean => !INVALID_CHAR_RE.test(value);

const isWs = (c: string | undefined): boolean =>
  c === ' ' || c === '\n' || c === '\t' || c === '\r';

/**
 * Whether a string consists only of XML white space (`S`).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isWhitespace = (value: string): boolean => /^[ \t\r\n]*$/.test(value);

// -----------------------------------------------------------------------------
// Parser
// -----------------------------------------------------------------------------

class Failure {
  constructor(
    readonly message: string,
    readonly offset: number,
  ) {}
}

interface AttributeDefault {
  readonly name: string;
  readonly value: string;
  readonly tokenized: boolean;
}

interface RawAttribute {
  readonly name: string;
  value: string;
  readonly offset: number;
  readonly defaulted: boolean;
}

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' };

const MAX_ENTITY_EXPANSION = 1_000_000;

class Parser {
  pos = 0;
  readonly entities = new Map<string, string>();
  readonly externalEntities = new Set<string>();
  readonly attributeDefaults = new Map<string, Array<AttributeDefault>>();
  readonly attributeTypes = new Map<string, Map<string, boolean>>();
  expanded = 0;
  hasExternalSubset = false;

  constructor(
    readonly src: string,
    private readonly lineStarts: Array<number>,
  ) {}

  fail(message: string, offset = this.pos): never {
    throw new Failure(message, offset);
  }

  position(offset: number): Position {
    // binary search over line starts
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { offset, line: lo + 1, column: offset - this.lineStarts[lo]! + 1 };
  }

  startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  expect(s: string): void {
    if (!this.startsWith(s)) this.fail(`Expected "${s}"`);
    this.pos += s.length;
  }

  skipWs(): boolean {
    const start = this.pos;
    while (isWs(this.src[this.pos])) this.pos++;
    return this.pos > start;
  }

  requireWs(): void {
    if (!this.skipWs()) this.fail('Expected white space');
  }

  name(): string {
    NAME_RE.lastIndex = this.pos;
    const m = NAME_RE.exec(this.src);
    if (m === null) this.fail('Expected a name');
    this.pos += m[0].length;
    return m[0];
  }

  quoted(): string {
    const q = this.src[this.pos];
    if (q !== '"' && q !== "'") this.fail('Expected a quoted string');
    const end = this.src.indexOf(q, this.pos + 1);
    if (end === -1) this.fail('Unterminated quoted string');
    const value = this.src.slice(this.pos + 1, end);
    this.pos = end + 1;
    return value;
  }

  // --- Document ------------------------------------------------------------

  document(): Document {
    let version: string | undefined;
    let encoding: string | undefined;
    let standalone: boolean | undefined;
    if (this.startsWith('<?xml') && isWs(this.src[this.pos + 5])) {
      this.pos += 5;
      this.requireWs();
      this.expect('version');
      this.eq();
      version = this.quoted();
      if (!/^1\.[0-9]+$/.test(version)) this.fail(`Unsupported XML version "${version}"`);
      let ws = this.skipWs();
      if (this.startsWith('encoding')) {
        if (!ws) this.fail('Expected white space');
        this.pos += 8;
        this.eq();
        encoding = this.quoted();
        if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(encoding)) this.fail('Invalid encoding name');
        ws = this.skipWs();
      }
      if (this.startsWith('standalone')) {
        if (!ws) this.fail('Expected white space');
        this.pos += 10;
        this.eq();
        const sd = this.quoted();
        if (sd !== 'yes' && sd !== 'no') this.fail('standalone must be "yes" or "no"');
        standalone = sd === 'yes';
        this.skipWs();
      }
      this.expect('?>');
    }
    const prolog: Array<Comment | ProcessingInstruction> = [];
    let doctype: DocumentType | undefined;
    let root: Element | undefined;
    const epilog: Array<Comment | ProcessingInstruction> = [];
    while (this.pos < this.src.length) {
      if (this.skipWs()) continue;
      if (this.startsWith('<!--')) {
        (root === undefined ? prolog : epilog).push(this.comment());
      } else if (this.startsWith('<?')) {
        (root === undefined ? prolog : epilog).push(this.pi());
      } else if (this.startsWith('<!DOCTYPE')) {
        if (doctype !== undefined || root !== undefined) this.fail('Unexpected DOCTYPE');
        doctype = this.doctype();
      } else if (this.startsWith('<')) {
        if (root !== undefined) this.fail('Only one root element is allowed');
        root = this.element(new Map());
      } else {
        this.fail(
          root === undefined ? 'Expected the root element' : 'Content after the root element',
        );
      }
    }
    if (root === undefined) this.fail('No root element');
    return { _tag: 'Document', version, encoding, standalone, doctype, prolog, root, epilog };
  }

  eq(): void {
    this.skipWs();
    this.expect('=');
    this.skipWs();
  }

  comment(): Comment {
    const start = this.pos;
    this.pos += 4;
    const end = this.src.indexOf('--', this.pos);
    if (end === -1) this.fail('Unterminated comment', start);
    if (this.src[end + 2] !== '>') this.fail('"--" is not allowed in comments', end);
    const value = this.src.slice(this.pos, end);
    this.pos = end + 3;
    return { _tag: 'Comment', value, position: this.position(start) };
  }

  pi(): ProcessingInstruction {
    const start = this.pos;
    this.pos += 2;
    const target = this.name();
    if (target.toLowerCase() === 'xml') this.fail('Reserved processing instruction target', start);
    if (target.includes(':')) this.fail('Processing instruction targets cannot contain ":"');
    let data = '';
    if (!this.startsWith('?>')) {
      this.requireWs();
      const end = this.src.indexOf('?>', this.pos);
      if (end === -1) this.fail('Unterminated processing instruction', start);
      data = this.src.slice(this.pos, end);
      this.pos = end;
    }
    this.pos += 2;
    return { _tag: 'ProcessingInstruction', target, data, position: this.position(start) };
  }

  // --- DTD -----------------------------------------------------------------

  doctype(): DocumentType {
    this.pos += 9;
    this.requireWs();
    const name = this.name();
    const ws = this.skipWs();
    let publicId: string | undefined;
    let systemId: string | undefined;
    if (this.startsWith('SYSTEM') || this.startsWith('PUBLIC')) {
      if (!ws) this.fail('Expected white space');
      [publicId, systemId] = this.externalId(false);
      this.hasExternalSubset = true;
      this.skipWs();
    }
    if (this.startsWith('[')) {
      this.pos++;
      this.internalSubset();
      this.skipWs();
    }
    this.expect('>');
    return { name, publicId, systemId, entities: new Map(this.entities) };
  }

  externalId(allowPublicOnly: boolean): [string | undefined, string | undefined] {
    if (this.startsWith('SYSTEM')) {
      this.pos += 6;
      this.requireWs();
      return [undefined, this.quoted()];
    }
    this.expect('PUBLIC');
    this.requireWs();
    const pub = this.quoted();
    if (!PUBID_RE.test(pub)) this.fail('Invalid public identifier');
    const ws = this.skipWs();
    if (allowPublicOnly && (this.startsWith('>') || !ws)) return [pub, undefined];
    if (!ws) this.fail('Expected white space');
    return [pub, this.quoted()];
  }

  internalSubset(): void {
    for (;;) {
      this.skipWs();
      if (this.startsWith(']')) {
        this.pos++;
        return;
      }
      if (this.pos >= this.src.length) this.fail('Unterminated internal subset');
      if (this.startsWith('<!ENTITY')) this.entityDecl();
      else if (this.startsWith('<!ATTLIST')) this.attlistDecl();
      else if (this.startsWith('<!ELEMENT') || this.startsWith('<!NOTATION')) this.skipDecl();
      else if (this.startsWith('<!--')) this.comment();
      else if (this.startsWith('<?')) this.pi();
      else if (this.startsWith('%')) {
        this.fail('Parameter entity references are not supported');
      } else this.fail('Invalid markup in the internal subset');
    }
  }

  skipDecl(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (c === '>') {
        this.pos++;
        return;
      }
      if (c === '"' || c === "'") this.quoted();
      else this.pos++;
    }
    this.fail('Unterminated markup declaration');
  }

  entityDecl(): void {
    this.pos += 8;
    this.requireWs();
    let parameter = false;
    if (this.startsWith('%')) {
      parameter = true;
      this.pos++;
      this.requireWs();
    }
    const name = this.name();
    if (name.includes(':')) this.fail('Entity names cannot contain ":"');
    this.requireWs();
    let value: string | undefined;
    if (this.startsWith('"') || this.startsWith("'")) {
      const start = this.pos + 1;
      const raw = this.quoted();
      if (raw.includes('%')) this.fail('Parameter entity references are not supported', start);
      value = this.expandCharRefs(raw, start);
    } else {
      this.externalId(false);
      if (this.skipWs() && this.startsWith('NDATA')) {
        this.pos += 5;
        this.requireWs();
        this.name();
      }
    }
    this.skipWs();
    this.expect('>');
    if (parameter) return;
    if (this.entities.has(name) || this.externalEntities.has(name)) return; // first wins
    if (value === undefined) this.externalEntities.add(name);
    else this.entities.set(name, value);
  }

  /** Expands character references in an entity value, leaving entity references. */
  expandCharRefs(raw: string, offset: number): string {
    return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[^;]*);|&/g, (m, body: string | undefined, i) => {
      if (body === undefined) this.fail('Invalid reference', offset + i);
      if (body.startsWith('#')) return this.charRef(body, offset + i);
      if (!isName(body)) this.fail('Invalid entity reference', offset + i);
      return m;
    });
  }

  charRef(body: string, offset: number): string {
    const code = body.startsWith('#x') ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!(code <= 0x10ffff)) this.fail('Invalid character reference', offset);
    const ch = String.fromCodePoint(code);
    if (!isValidText(ch)) this.fail('Character reference to an invalid character', offset);
    return ch;
  }

  attlistDecl(): void {
    this.pos += 9;
    this.requireWs();
    const element = this.name();
    let defaults = this.attributeDefaults.get(element);
    if (defaults === undefined) this.attributeDefaults.set(element, (defaults = []));
    let types = this.attributeTypes.get(element);
    if (types === undefined) this.attributeTypes.set(element, (types = new Map()));
    for (;;) {
      const ws = this.skipWs();
      if (this.startsWith('>')) {
        this.pos++;
        return;
      }
      if (!ws) this.fail('Expected white space');
      const name = this.name();
      this.requireWs();
      let tokenized = true;
      if (this.startsWith('(')) {
        this.skipParens();
      } else {
        const type = this.name();
        if (type === 'CDATA') tokenized = false;
        else if (type === 'NOTATION') {
          this.requireWs();
          this.skipParens();
        } else if (
          !['ID', 'IDREF', 'IDREFS', 'ENTITY', 'ENTITIES', 'NMTOKEN', 'NMTOKENS'].includes(type)
        ) {
          this.fail(`Unknown attribute type "${type}"`);
        }
      }
      this.requireWs();
      let value: string | undefined;
      if (this.startsWith('#REQUIRED')) this.pos += 9;
      else if (this.startsWith('#IMPLIED')) this.pos += 8;
      else {
        if (this.startsWith('#FIXED')) {
          this.pos += 6;
          this.requireWs();
        }
        value = this.attributeValue();
      }
      if (!types.has(name)) {
        types.set(name, tokenized);
        if (value !== undefined) {
          defaults.push({
            name,
            value: tokenized ? collapse(value) : value,
            tokenized,
          });
        }
      }
    }
  }

  skipParens(): void {
    this.expect('(');
    const end = this.src.indexOf(')', this.pos);
    if (end === -1) this.fail('Unterminated enumeration');
    const tokens = this.src.slice(this.pos, end).split('|');
    for (const t of tokens) {
      if (!NMTOKEN_RE.test(t.trim())) this.fail('Invalid enumeration');
    }
    this.pos = end + 1;
  }

  // --- Elements ------------------------------------------------------------

  /** Parses an attribute value literal, normalising it (XML 1.0 §3.3.3). */
  attributeValue(): string {
    const q = this.src[this.pos];
    if (q !== '"' && q !== "'") this.fail('Expected a quoted attribute value');
    const start = this.pos + 1;
    const end = this.src.indexOf(q, start);
    if (end === -1) this.fail('Unterminated attribute value');
    const raw = this.src.slice(start, end);
    this.pos = end + 1;
    return this.normalizeAttribute(raw, start, new Set());
  }

  normalizeAttribute(raw: string, offset: number, stack: Set<string>): string {
    let out = '';
    let i = 0;
    while (i < raw.length) {
      const c = raw[i]!;
      if (c === '<') this.fail('"<" is not allowed in attribute values', offset + i);
      if (c === '&') {
        const semi = raw.indexOf(';', i);
        if (semi === -1) this.fail('Unterminated reference', offset + i);
        const body = raw.slice(i + 1, semi);
        if (body.startsWith('#')) {
          if (!/^#(x[0-9a-fA-F]+|[0-9]+)$/.test(body)) {
            this.fail('Invalid character reference', offset + i);
          }
          out += this.charRef(body, offset + i);
        } else {
          const replacement = this.entityText(body, offset + i, stack);
          out += this.normalizeAttribute(replacement, offset + i, withEntry(stack, body));
        }
        i = semi + 1;
      } else {
        out += c === '\t' || c === '\n' || c === '\r' ? ' ' : c;
        i++;
      }
    }
    return out;
  }

  entityText(name: string, offset: number, stack: Set<string>): string {
    if (!isName(name)) this.fail('Invalid entity reference', offset);
    const predefined = PREDEFINED[name];
    if (predefined !== undefined)
      return predefined === '<' ? '&#60;' : predefined === '&' ? '&#38;' : predefined;
    if (this.externalEntities.has(name)) {
      this.fail(`External entity "${name}" is not supported`, offset);
    }
    const value = this.entities.get(name);
    if (value === undefined) this.fail(`Undefined entity "${name}"`, offset);
    if (stack.has(name)) this.fail(`Recursive entity "${name}"`, offset);
    this.expanded += value.length;
    if (this.expanded > MAX_ENTITY_EXPANSION) this.fail('Entity expansion limit exceeded', offset);
    return value;
  }

  element(parentNs: ReadonlyMap<string, string>): Element {
    const start = this.pos;
    this.pos++; // <
    const qname = this.name();
    const raw: Array<RawAttribute> = [];
    const seen = new Set<string>();
    for (;;) {
      const ws = this.skipWs();
      if (this.startsWith('>') || this.startsWith('/>')) break;
      if (!ws) this.fail('Expected white space between attributes');
      const offset = this.pos;
      const name = this.name();
      this.eq();
      const value = this.attributeValue();
      if (seen.has(name)) this.fail(`Duplicate attribute "${name}"`, offset);
      seen.add(name);
      raw.push({ name, value, offset, defaulted: false });
    }
    // attribute types and defaults from the internal subset
    const types = this.attributeTypes.get(qname);
    if (types !== undefined) {
      for (const a of raw) if (types.get(a.name) === true) a.value = collapse(a.value);
    }
    for (const d of this.attributeDefaults.get(qname) ?? []) {
      if (!seen.has(d.name))
        raw.push({ name: d.name, value: d.value, offset: start, defaulted: true });
    }

    // namespace declarations
    let inScope = parentNs;
    const declarations: Array<NamespaceDeclaration> = [];
    for (const a of raw) {
      let prefix: string | undefined;
      if (a.name === 'xmlns') prefix = '';
      else if (a.name.startsWith('xmlns:')) prefix = a.name.slice(6);
      if (prefix === undefined) continue;
      if (prefix !== '' && !isNCName(prefix)) this.fail('Invalid namespace prefix', a.offset);
      if (prefix === 'xmlns') this.fail('The "xmlns" prefix cannot be declared', a.offset);
      if (prefix === 'xml' && a.value !== XML_NAMESPACE) {
        this.fail('The "xml" prefix cannot be rebound', a.offset);
      }
      if (prefix !== 'xml' && a.value === XML_NAMESPACE) {
        this.fail('The XML namespace cannot be bound to another prefix', a.offset);
      }
      if (a.value === XMLNS_NAMESPACE) {
        this.fail('The xmlns namespace cannot be declared', a.offset);
      }
      if (prefix !== '' && a.value === '') {
        this.fail('Prefixed namespace declarations cannot be empty', a.offset);
      }
      if (prefix === 'xml') continue;
      if (inScope === parentNs) inScope = new Map(parentNs);
      if (a.value === '') (inScope as Map<string, string>).delete('');
      else (inScope as Map<string, string>).set(prefix, a.value);
      declarations.push({ prefix, namespace: a.value });
    }

    const [prefix, localName, namespace] = this.resolveName(qname, inScope, true, start + 1);
    const attributes: Array<Attribute> = [];
    const expanded = new Set<string>();
    for (const a of raw) {
      if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
      const [ap, al, ans] = this.resolveName(a.name, inScope, false, a.offset);
      const key = `${ans ?? ''} ${al}`;
      if (expanded.has(key)) this.fail(`Duplicate attribute "{${ans ?? ''}}${al}"`, a.offset);
      expanded.add(key);
      attributes.push({
        _tag: 'Attribute',
        name: a.name,
        prefix: ap,
        localName: al,
        namespace: ans,
        value: a.value,
        defaulted: a.defaulted,
        position: this.position(a.offset),
      });
    }

    let children: Array<Node> = [];
    if (this.startsWith('/>')) {
      this.pos += 2;
    } else {
      this.pos++;
      children = this.content(inScope, new Set(), false);
      const endOffset = this.pos;
      this.expect('</');
      const endName = this.name();
      if (endName !== qname) {
        this.fail(`Mismatched end tag: expected </${qname}> but found </${endName}>`, endOffset);
      }
      this.skipWs();
      this.expect('>');
    }
    return {
      _tag: 'Element',
      name: qname,
      prefix,
      localName,
      namespace,
      attributes,
      namespaceDeclarations: declarations,
      inScopeNamespaces: inScope,
      children,
      position: this.position(start),
    };
  }

  resolveName(
    qname: string,
    ns: ReadonlyMap<string, string>,
    isElement: boolean,
    offset: number,
  ): [string, string, string | undefined] {
    const i = qname.indexOf(':');
    if (i === -1) {
      if (!isNCName(qname)) this.fail(`Invalid name "${qname}"`, offset);
      return ['', qname, isElement ? ns.get('') : undefined];
    }
    const prefix = qname.slice(0, i);
    const local = qname.slice(i + 1);
    if (!isNCName(prefix) || !isNCName(local))
      this.fail(`Invalid qualified name "${qname}"`, offset);
    if (prefix === 'xmlns')
      this.fail('Elements and attributes cannot use the "xmlns" prefix', offset);
    if (prefix === 'xml') return [prefix, local, XML_NAMESPACE];
    const uri = ns.get(prefix);
    if (uri === undefined) this.fail(`Unbound namespace prefix "${prefix}"`, offset);
    return [prefix, local, uri];
  }

  /**
   * Parses element content until an end tag (or end of input when
   * `toEnd`, used for entity replacement text).
   */
  content(ns: ReadonlyMap<string, string>, stack: Set<string>, toEnd: boolean): Array<Node> {
    const children: Array<Node> = [];
    let text = '';
    let textStart = -1;
    const pushText = (s: string, at: number) => {
      if (s === '') return;
      if (textStart === -1) textStart = at;
      text += s;
    };
    const flush = () => {
      if (text !== '') {
        const prev = children[children.length - 1];
        if (prev !== undefined && prev._tag === 'Text') {
          children[children.length - 1] = { ...prev, value: prev.value + text };
        } else {
          children.push({ _tag: 'Text', value: text, position: this.position(textStart) });
        }
      }
      text = '';
      textStart = -1;
    };
    for (;;) {
      if (this.pos >= this.src.length) {
        if (toEnd) break;
        this.fail('Unexpected end of input: unclosed element');
      }
      const c = this.src[this.pos]!;
      if (c === '<') {
        if (this.startsWith('</')) {
          if (toEnd) this.fail('Unbalanced end tag in entity replacement text');
          break;
        }
        if (this.startsWith('<!--')) {
          flush();
          children.push(this.comment());
        } else if (this.startsWith('<![CDATA[')) {
          const start = this.pos;
          const end = this.src.indexOf(']]>', this.pos + 9);
          if (end === -1) this.fail('Unterminated CDATA section');
          pushText(this.src.slice(this.pos + 9, end), start);
          this.pos = end + 3;
        } else if (this.startsWith('<?')) {
          flush();
          children.push(this.pi());
        } else if (this.startsWith('<!')) {
          this.fail('Unexpected markup declaration in content');
        } else {
          flush();
          children.push(this.element(ns));
        }
      } else if (c === '&') {
        const start = this.pos;
        const semi = this.src.indexOf(';', this.pos);
        if (semi === -1) this.fail('Unterminated reference');
        const body = this.src.slice(this.pos + 1, semi);
        this.pos = semi + 1;
        if (body.startsWith('#')) {
          if (!/^#(x[0-9a-fA-F]+|[0-9]+)$/.test(body))
            this.fail('Invalid character reference', start);
          pushText(this.charRef(body, start), start);
        } else if (PREDEFINED[body] !== undefined) {
          pushText(PREDEFINED[body], start);
        } else {
          const replacement = this.entityText(body, start, stack);
          if (!replacement.includes('<') && !replacement.includes('&')) {
            pushText(replacement, start);
          } else {
            flush();
            const sub = new Parser(replacement, [0]);
            sub.entities.clear();
            for (const [k, v] of this.entities) sub.entities.set(k, v);
            for (const k of this.externalEntities) sub.externalEntities.add(k);
            for (const [k, v] of this.attributeDefaults) sub.attributeDefaults.set(k, v);
            for (const [k, v] of this.attributeTypes) sub.attributeTypes.set(k, v);
            sub.expanded = this.expanded;
            let nodes: Array<Node>;
            try {
              nodes = sub.content(ns, withEntry(stack, body), true);
            } catch (e) {
              if (e instanceof Failure) this.fail(`In entity "${body}": ${e.message}`, start);
              throw e;
            }
            this.expanded = sub.expanded;
            for (const n of nodes) {
              const positioned = { ...n, position: this.position(start) } as Node;
              if (positioned._tag === 'Text') {
                pushText(positioned.value, start);
              } else {
                flush();
                children.push(positioned);
              }
            }
          }
        }
      } else {
        const start = this.pos;
        let end = this.pos;
        while (end < this.src.length && this.src[end] !== '<' && this.src[end] !== '&') end++;
        const chunk = this.src.slice(start, end);
        const bad = chunk.indexOf(']]>');
        if (bad !== -1) this.fail('"]]>" is not allowed in character data', start + bad);
        pushText(chunk, start);
        this.pos = end;
      }
    }
    flush();
    return children;
  }
}

const withEntry = (set: ReadonlySet<string>, entry: string): Set<string> => {
  const next = new Set(set);
  next.add(entry);
  return next;
};

const collapse = (value: string): string => value.replace(/ +/g, ' ').replace(/^ | $/g, '');

const lineStartsOf = (text: string): Array<number> => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
};

/**
 * Normalises line ends (`\r\n` and `\r` become `\n`) and strips a leading
 * byte order mark, as an XML processor does before parsing.
 *
 * @since 0.1.0
 * @category parsing
 */
export const normalizeInput = (input: string): string => {
  const noBom = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  return noBom.includes('\r') ? noBom.replace(/\r\n?/g, '\n') : noBom;
};

/**
 * Parses an XML document, returning a `Result`.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseResult = (input: string): Result.Result<Document, XmlParseError> => {
  const text = normalizeInput(input);
  const lineStarts = lineStartsOf(text);
  const parser = new Parser(text, lineStarts);
  try {
    const bad = INVALID_CHAR_RE.exec(text);
    if (bad !== null) parser.fail('Invalid XML character', bad.index);
    return Result.succeed(parser.document());
  } catch (e) {
    if (e instanceof Failure) {
      const p = parser.position(Math.min(e.offset, text.length));
      return Result.fail(
        new XmlParseError({ message: e.message, offset: p.offset, line: p.line, column: p.column }),
      );
    }
    throw e;
  }
};

/**
 * Parses an XML document.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (input: string): Effect.Effect<Document, XmlParseError> =>
  Effect.suspend(() => Effect.fromResult(parseResult(input)));

// -----------------------------------------------------------------------------
// Exclusive XML Canonicalization
// -----------------------------------------------------------------------------

/**
 * Escapes character data as in Canonical XML.
 *
 * @since 0.1.0
 * @category canonicalization
 */
export const escapeText = (value: string): string =>
  value.replace(/[&<>\r]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&#xD;',
  );

/**
 * Escapes an attribute value as in Canonical XML.
 *
 * @since 0.1.0
 * @category canonicalization
 */
export const escapeAttribute = (value: string): string =>
  value.replace(/[&<"\t\n\r]/g, (c) =>
    c === '&'
      ? '&amp;'
      : c === '<'
        ? '&lt;'
        : c === '"'
          ? '&quot;'
          : c === '\t'
            ? '&#x9;'
            : c === '\n'
              ? '&#xA;'
              : '&#xD;',
  );

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Serialises a sequence of nodes (with all their descendants, but none of
 * their ancestors) using Exclusive XML Canonicalization 1.0 with comments
 * and an empty InclusiveNamespaces PrefixList. This is how RDF/XML computes
 * the lexical form of `rdf:parseType="Literal"` content.
 *
 * @since 0.1.0
 * @category canonicalization
 */
export const canonicalize = (nodes: ReadonlyArray<Node>): string => {
  let out = '';
  const go = (node: Node, rendered: ReadonlyMap<string, string>): void => {
    switch (node._tag) {
      case 'Text':
        out += escapeText(node.value);
        return;
      case 'Comment':
        out += `<!--${node.value}-->`;
        return;
      case 'ProcessingInstruction':
        out += node.data === '' ? `<?${node.target}?>` : `<?${node.target} ${node.data}?>`;
        return;
      case 'Element': {
        const utilized = new Set<string>([node.prefix]);
        for (const a of node.attributes)
          if (a.prefix !== '' && a.prefix !== 'xml') utilized.add(a.prefix);
        utilized.delete('xml');
        const decls: Array<readonly [string, string]> = [];
        for (const p of utilized) {
          const uri = node.inScopeNamespaces.get(p) ?? '';
          if ((rendered.get(p) ?? '') !== uri) decls.push([p, uri]);
        }
        decls.sort((a, b) => compareStrings(a[0], b[0]));
        let next = rendered;
        if (decls.length > 0) {
          const m = new Map(rendered);
          for (const [p, uri] of decls) m.set(p, uri);
          next = m;
        }
        out += `<${node.name}`;
        for (const [p, uri] of decls) {
          out +=
            p === '' ? ` xmlns="${escapeAttribute(uri)}"` : ` xmlns:${p}="${escapeAttribute(uri)}"`;
        }
        const attrs = [...node.attributes].sort(
          (a, b) =>
            compareStrings(a.namespace ?? '', b.namespace ?? '') ||
            compareStrings(a.localName, b.localName),
        );
        for (const a of attrs) out += ` ${a.name}="${escapeAttribute(a.value)}"`;
        out += '>';
        for (const c of node.children) go(c, next);
        out += `</${node.name}>`;
        return;
      }
    }
  };
  for (const n of nodes) go(n, new Map());
  return out;
};
