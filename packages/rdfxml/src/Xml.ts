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
 * The parser is a compiled `@thomasfosterau/effect-parse` grammar; it is
 * pure and synchronous internally, and the public `parse` API returns an
 * `Effect` failing with `XmlParseError`. It is safe on hostile input:
 * entity replacement text may add at most 1,000,000 characters to a
 * document, entity references nest at most 64 deep and elements at most
 * 1,024 deep, and the time it takes grows with the text it expands.
 *
 * @since 0.1.0
 */
import * as Effect from 'effect/Effect';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Chars from './internal/chars.ts';
import * as Internal from './internal/parser.ts';

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
export const isWhitespace = (value: string): boolean => /^[ \t\r\n]*$/.test(value);

// -----------------------------------------------------------------------------
// Parser
// -----------------------------------------------------------------------------

const position = (lineStarts: ReadonlyArray<number>, offset: number): Position => {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { offset, line: lo + 1, column: offset - lineStarts[lo]! + 1 };
};

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
  try {
    const bad = Chars.INVALID_CHAR_RE.exec(text);
    if (bad !== null) throw new Internal.Failure('Invalid XML character', bad.index);
    return Result.succeed(Internal.parse(text, lineStarts));
  } catch (e) {
    if (e instanceof Internal.Failure) {
      const p = position(lineStarts, Math.min(e.offset, text.length));
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
