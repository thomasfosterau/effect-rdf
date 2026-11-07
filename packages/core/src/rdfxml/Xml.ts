/**
 * A namespace-aware, non-validating XML 1.0 parser producing an immutable
 * document tree with a position on every node, plus Exclusive XML
 * Canonicalization (with comments) of element content.
 *
 * Supported: the XML declaration, a document type declaration whose internal
 * subset may declare general entities and attribute defaults, elements,
 * attributes (with attribute-value normalisation), Namespaces in XML 1.0,
 * CDATA sections, comments, processing instructions, and character and
 * entity references. External entities and parameter entities are not
 * loaded (they are reported as errors when referenced).
 *
 * The tree is built from the SAX events of `@thomasfosterau/effect-xml`'s
 * tokenizer, an optional peer of effect-rdf needed by this subpath; it is
 * pure and synchronous internally, and the public `parse` API returns an
 * `Effect` failing with `XmlParseError`. It is safe on hostile input:
 * entity replacement text may add at most 1,000,000 characters to a
 * document, entity references nest at most 64 deep and elements at most
 * 1,024 deep. Positions count UTF-16 code units of the input after any byte
 * order mark, with line breaks as written.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as HashMap from 'effect/HashMap';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import type * as Ordering from 'effect/Ordering';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Builder from './internal/builder.ts';
import * as Chars from './internal/chars.ts';

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
 * A position in the input (after any byte order mark). Lines and columns
 * are 1-based; `\r\n`, `\r` and `\n` each end a line, and the offset and
 * column count UTF-16 code units.
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
export const NAME_START: string = Chars.NAME_START;
/**
 * The XML `NameChar` production as a regular expression character class
 * body (without brackets), excluding `:`. Requires the `u` flag.
 *
 * @since 0.1.0
 * @category constants
 */
export const NAME_CHAR: string = Chars.NAME_CHAR;

/**
 * Whether a string is an XML `NCName` (a name without colons), as required
 * for namespace prefixes, local names, `rdf:ID` and `rdf:nodeID`.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isNCName: (value: string) => boolean = Chars.isNCName;

/**
 * Whether a string is an XML `Name`.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isName: (value: string) => boolean = Chars.isName;

/**
 * Whether a string consists only of characters allowed in XML 1.0 documents.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isValidText: (value: string) => boolean = Chars.isValidText;

/**
 * Whether a string consists only of XML white space (`S`).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isWhitespace: (value: string) => boolean = Builder.isWhitespace;

// -----------------------------------------------------------------------------
// Parser
// -----------------------------------------------------------------------------

/**
 * Normalises line ends (`\r\n` and `\r` become `\n`) and strips a leading
 * byte order mark, as an XML processor does before parsing.
 *
 * @since 0.1.0
 * @category parsing
 */
export const normalizeInput: (input: string) => string = Builder.normalizeInput;

/**
 * Parses an XML document, returning a `Result`.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseResult = (input: string): Result.Result<Document, XmlParseError> =>
  Result.try({
    try: () => Builder.parseText(input),
    catch: (e) => {
      if (e instanceof Builder.Failure) {
        return new XmlParseError({
          message: e.message,
          offset: e.position.offset,
          line: e.position.line,
          column: e.position.column,
        });
      }
      throw e;
    },
  });

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

const compareStrings = (a: string, b: string): Ordering.Ordering => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Serialises a sequence of nodes (with all their descendants, but none of
 * their ancestors) using Exclusive XML Canonicalization 1.0 with comments
 * and an empty InclusiveNamespaces PrefixList. This is how RDF/XML computes
 * the lexical form of `rdf:parseType="Literal"` content.
 *
 * @since 0.1.0
 * @category canonicalization
 */
export const canonicalize = (nodes: ReadonlyArray<Node>): string =>
  nodes.map((n) => canonicalNode(n, HashMap.empty())).join('');

const byPrefix = Order.make<readonly [string, string]>((a, b) => compareStrings(a[0], b[0]));

const byExpandedName = Order.make<Attribute>(
  (a, b) =>
    compareStrings(a.namespace ?? '', b.namespace ?? '') ||
    compareStrings(a.localName, b.localName),
);

/** The prefixes an element visibly utilises: its own, and those of its prefixed attributes. */
const utilizedPrefixes = (node: Element): ReadonlyArray<string> =>
  Arr.dedupe(
    Arr.filter(
      [node.prefix, ...node.attributes.map((a) => a.prefix).filter((p) => p !== '')],
      (p) => p !== 'xml',
    ),
  );

// Built once: `canonicalize` runs it for every node of an XML literal.
const canonicalNode: (node: Node, rendered: HashMap.HashMap<string, string>) => string = Match.fn(
  (node: Node, _rendered: HashMap.HashMap<string, string>) => node,
).pipe(
  Match.withReturnType<string>(),
  Match.tag('Text', (node) => escapeText(node.value)),
  Match.tag('Comment', (node) => `<!--${node.value}-->`),
  Match.tag('ProcessingInstruction', (node) =>
    node.data === '' ? `<?${node.target}?>` : `<?${node.target} ${node.data}?>`,
  ),
  Match.tag('Element', (node, _node, rendered) => {
    const decls = Arr.sort(
      Arr.filterMap(utilizedPrefixes(node), (p) => {
        const uri = node.inScopeNamespaces.get(p) ?? '';
        return Option.getOrElse(HashMap.get(rendered, p), () => '') === uri
          ? Result.failVoid
          : Result.succeed([p, uri] as const);
      }),
      byPrefix,
    );
    const next = decls.reduce((m, [p, uri]) => HashMap.set(m, p, uri), rendered);
    const namespaces = decls
      .map(([p, uri]) =>
        p === '' ? ` xmlns="${escapeAttribute(uri)}"` : ` xmlns:${p}="${escapeAttribute(uri)}"`,
      )
      .join('');
    const attributes = Arr.sort(node.attributes, byExpandedName)
      .map((a) => ` ${a.name}="${escapeAttribute(a.value)}"`)
      .join('');
    const children = node.children.map((c) => canonicalNode(c, next)).join('');
    return `<${node.name}${namespaces}${attributes}>${children}</${node.name}>`;
  }),
  Match.exhaustive,
);
