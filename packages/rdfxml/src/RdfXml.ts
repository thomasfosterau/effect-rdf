/**
 * RDF 1.2 XML Syntax (RDF/XML): parser and serializer.
 *
 * The parser implements the RDF/XML grammar of
 * https://www.w3.org/TR/rdf-syntax-grammar/ together with the RDF 1.2
 * additions: `rdf:version`, base direction via `its:dir`, triple terms via
 * `rdf:parseType="Triple"`, and annotations via `rdf:annotation` /
 * `rdf:annotationNodeID`. `rdf:parseType="Literal"` content is turned into
 * an `rdf:XMLLiteral` using Exclusive XML Canonicalization.
 *
 * The serializer writes readable RDF/XML: typed node elements, nested blank
 * nodes where a blank node is referenced exactly once, namespace
 * declarations taken from `options.prefixes` and generated namespaces for the
 * rest.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Xml from './Xml.ts';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const ITS = 'http://www.w3.org/2005/11/its';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const FORMAT_NAME = 'RDF/XML';

/**
 * The RDF/XML format description (`application/rdf+xml`).
 *
 * @since 0.1.0
 * @category formats
 */
export const format: Serialization.Format = Serialization.makeFormat({
  name: FORMAT_NAME,
  mediaType: 'application/rdf+xml',
  extensions: ['rdf', 'owl'],
  datasets: false,
});

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

/**
 * Options for parsing RDF/XML.
 *
 * @since 0.1.0
 * @category models
 */
export interface ParseOptions extends Serialization.ParseOptions {
  /**
   * The RDF version assumed when the document does not announce one with
   * `rdf:version`. RDF 1.2 features that require a version announcement
   * (base direction and triple terms) are only enabled when a version other
   * than `"1.0"`/`"1.1"` is in scope. Defaults to none.
   */
  readonly version?: string | undefined;
}

const rdf = (local: string) => RDF + local;

const CORE_SYNTAX_TERMS = new Set(
  [
    'RDF',
    'ID',
    'about',
    'annotation',
    'annotationNodeID',
    'parseType',
    'resource',
    'nodeID',
    'datatype',
    'version',
  ].map(rdf),
);
const OLD_TERMS = new Set(['aboutEach', 'aboutEachPrefix', 'bagID'].map(rdf));
const UNQUALIFIED_RDF_ATTRIBUTES = new Set([
  'ID',
  'about',
  'resource',
  'parseType',
  'type',
  'version',
]);

const isForbiddenNodeElement = (iri: string) =>
  CORE_SYNTAX_TERMS.has(iri) || OLD_TERMS.has(iri) || iri === rdf('li');
const isForbiddenPropertyElement = (iri: string) =>
  CORE_SYNTAX_TERMS.has(iri) || OLD_TERMS.has(iri) || iri === rdf('Description');
const isForbiddenPropertyAttribute = (iri: string) =>
  CORE_SYNTAX_TERMS.has(iri) ||
  OLD_TERMS.has(iri) ||
  iri === rdf('Description') ||
  iri === rdf('li');

class ParseFailure {
  readonly message: string;
  readonly position: Xml.Position | undefined;
  constructor(message: string, position: Xml.Position | undefined) {
    this.message = message;
    this.position = position;
  }
}

interface Context {
  readonly base: string | undefined;
  readonly language: string;
  readonly direction: '' | Term.Direction;
  readonly version: string | undefined;
}

interface Attr {
  readonly iri: string;
  readonly value: string;
  readonly attribute: Xml.Attribute;
}

const isRdf12 = (version: string | undefined): boolean =>
  version !== undefined && version !== '1.0' && version !== '1.1';

const rdfType = new Term.NamedNode(rdf('type'));
const rdfFirst = new Term.NamedNode(rdf('first'));
const rdfRest = new Term.NamedNode(rdf('rest'));
const rdfNil = new Term.NamedNode(rdf('nil'));
const rdfStatement = new Term.NamedNode(rdf('Statement'));
const rdfSubject = new Term.NamedNode(rdf('subject'));
const rdfPredicate = new Term.NamedNode(rdf('predicate'));
const rdfObject = new Term.NamedNode(rdf('object'));
const rdfReifies = new Term.NamedNode(rdf('reifies'));
const rdfXmlLiteral = new Term.NamedNode(rdf('XMLLiteral'));

class RdfXmlParser {
  sink: Array<Term.Triple> = [];
  readonly ids = new Set<string>();
  counter = 0;

  readonly blankNodePrefix: string;
  readonly defaultVersion: string | undefined;
  constructor(blankNodePrefix: string, defaultVersion: string | undefined) {
    this.blankNodePrefix = blankNodePrefix;
    this.defaultVersion = defaultVersion;
  }

  fail(message: string, node?: { readonly position: Xml.Position }): never {
    throw new ParseFailure(message, node?.position);
  }

  emit(s: Term.Subject, p: Term.NamedNode, o: Term.Object): Term.Triple {
    const t = new Term.Triple(s, p, o);
    this.sink.push(t);
    return t;
  }

  fresh(): Term.BlankNode {
    return new Term.BlankNode(`${this.blankNodePrefix}${this.counter++}`);
  }

  blank(id: string, node: { readonly position: Xml.Position }): Term.BlankNode {
    if (!Xml.isNCName(id)) this.fail(`Invalid blank node identifier "${id}"`, node);
    return new Term.BlankNode(`${this.blankNodePrefix}${id}`);
  }

  iri(value: string, ctx: Context): Term.NamedNode {
    return new Term.NamedNode(Iri.resolve(value, ctx.base));
  }

  idIri(id: string, ctx: Context, node: { readonly position: Xml.Position }): Term.NamedNode {
    if (!Xml.isNCName(id)) this.fail(`Invalid rdf:ID "${id}"`, node);
    const iri = Iri.resolve(`#${id}`, ctx.base);
    if (this.ids.has(iri)) this.fail(`Duplicate rdf:ID "${id}"`, node);
    this.ids.add(iri);
    return new Term.NamedNode(iri);
  }

  literal(value: string, ctx: Context): Term.Literal {
    if (ctx.language === '') return Term.literal(value);
    return ctx.direction === ''
      ? Term.literal(value, ctx.language)
      : Term.literal(value, { language: ctx.language, direction: ctx.direction });
  }

  /** Computes the evaluation context of an element. */
  context(el: Xml.Element, parent: Context): Context {
    let base = parent.base;
    let language = parent.language;
    let direction = parent.direction;
    let version = parent.version;
    let dir: Xml.Attribute | undefined;
    for (const a of el.attributes) {
      if (a.namespace === Xml.XML_NAMESPACE) {
        if (a.localName === 'base') base = Iri.resolve(a.value, base);
        else if (a.localName === 'lang') language = a.value;
      } else if (a.namespace === ITS && a.localName === 'dir') {
        dir = a;
      } else if ((a.namespace === RDF || a.namespace === undefined) && a.localName === 'version') {
        version = a.value;
      }
    }
    if (dir !== undefined && isRdf12(version)) {
      if (dir.value !== 'ltr' && dir.value !== 'rtl' && dir.value !== '') {
        this.fail(`Invalid its:dir value "${dir.value}"`, dir);
      }
      direction = dir.value as Context['direction'];
    }
    return { base, language, direction, version };
  }

  /** The RDF-relevant attributes of an element, with their IRIs. */
  attributes(el: Xml.Element): Array<Attr> {
    const out: Array<Attr> = [];
    for (const a of el.attributes) {
      if (a.namespace === Xml.XML_NAMESPACE) continue;
      if (a.prefix.toLowerCase().startsWith('xml')) continue;
      if (a.namespace === undefined) {
        if (a.localName.toLowerCase().startsWith('xml')) continue;
        if (!UNQUALIFIED_RDF_ATTRIBUTES.has(a.localName)) {
          this.fail(`Unqualified attribute "${a.localName}" is not allowed`, a);
        }
        out.push({ iri: rdf(a.localName), value: a.value, attribute: a });
        continue;
      }
      if (a.namespace === ITS && (a.localName === 'dir' || a.localName === 'version')) continue;
      out.push({ iri: a.namespace + a.localName, value: a.value, attribute: a });
    }
    return out;
  }

  elementIri(el: Xml.Element): string {
    if (el.namespace === undefined) {
      this.fail(`Element "${el.name}" is not in a namespace`, el);
    }
    return el.namespace + el.localName;
  }

  document(doc: Xml.Document, base: string | undefined): void {
    const root = doc.root;
    const ctx: Context = { base, language: '', direction: '', version: this.defaultVersion };
    if (root.namespace === RDF && root.localName === 'RDF') {
      const rootCtx = this.context(root, ctx);
      for (const a of this.attributes(root)) {
        if (a.iri !== rdf('version')) this.fail(`Unexpected attribute on rdf:RDF`, a.attribute);
      }
      this.nodeElementList(root.children, rootCtx);
    } else {
      this.nodeElement(root, ctx);
    }
  }

  nodeElementList(children: ReadonlyArray<Xml.Node>, ctx: Context): Array<Term.Subject> {
    const subjects: Array<Term.Subject> = [];
    for (const c of children) {
      if (c._tag === 'Element') subjects.push(this.nodeElement(c, ctx));
      else if (c._tag === 'Text' && !Xml.isWhitespace(c.value)) {
        this.fail('Unexpected text where node elements are expected', c);
      }
    }
    return subjects;
  }

  nodeElement(el: Xml.Element, parentCtx: Context, given?: Term.Subject): Term.Subject {
    const ctx = given === undefined ? this.context(el, parentCtx) : parentCtx;
    const iri = given === undefined ? this.elementIri(el) : rdf('Description');
    if (isForbiddenNodeElement(iri)) this.fail(`<${el.name}> is not allowed as a node element`, el);
    let subject: Term.Subject | undefined = given;
    let idAttr: Attr | undefined;
    const props: Array<Attr> = [];
    if (given === undefined) {
      for (const a of this.attributes(el)) {
        switch (a.iri) {
          case rdf('ID'):
          case rdf('nodeID'):
          case rdf('about'): {
            if (idAttr !== undefined) {
              this.fail(
                `rdf:${idAttr.attribute.localName} and rdf:${a.attribute.localName} cannot be used together`,
                a.attribute,
              );
            }
            idAttr = a;
            break;
          }
          case rdf('version'):
            break;
          default:
            if (isForbiddenPropertyAttribute(a.iri)) {
              this.fail(`${a.attribute.name} is not allowed as a property attribute`, a.attribute);
            }
            props.push(a);
        }
      }
      if (idAttr !== undefined) {
        const local = idAttr.iri.slice(RDF.length);
        subject =
          local === 'ID'
            ? this.idIri(idAttr.value, ctx, idAttr.attribute)
            : local === 'nodeID'
              ? this.blank(idAttr.value, idAttr.attribute)
              : this.iri(idAttr.value, ctx);
      }
    }
    const s = subject ?? this.fresh();
    if (iri !== rdf('Description')) this.emit(s, rdfType, new Term.NamedNode(iri));
    for (const a of props) {
      this.emit(
        s,
        new Term.NamedNode(a.iri),
        a.iri === rdf('type') ? this.iri(a.value, ctx) : this.literal(a.value, ctx),
      );
    }
    this.propertyEltList(el, s, ctx);
    return s;
  }

  propertyEltList(el: Xml.Element, subject: Term.Subject, ctx: Context): void {
    let li = 1;
    for (const c of el.children) {
      if (c._tag === 'Element') {
        let iri = this.elementIri(c);
        if (iri === rdf('li')) iri = rdf(`_${li++}`);
        this.propertyElt(c, iri, subject, ctx);
      } else if (c._tag === 'Text' && !Xml.isWhitespace(c.value)) {
        this.fail('Unexpected text where property elements are expected', c);
      }
    }
  }

  propertyElt(el: Xml.Element, iri: string, subject: Term.Subject, parentCtx: Context): void {
    if (isForbiddenPropertyElement(iri)) {
      this.fail(`<${el.name}> is not allowed as a property element`, el);
    }
    const ctx = this.context(el, parentCtx);
    const predicate = new Term.NamedNode(iri);
    let id: Attr | undefined;
    let annotation: Attr | undefined;
    let parseType: Attr | undefined;
    let resource: Attr | undefined;
    let nodeId: Attr | undefined;
    let datatype: Attr | undefined;
    const props: Array<Attr> = [];
    for (const a of this.attributes(el)) {
      switch (a.iri) {
        case rdf('ID'):
          id = a;
          break;
        case rdf('annotation'):
        case rdf('annotationNodeID'):
          if (annotation !== undefined) {
            this.fail(
              'rdf:annotation and rdf:annotationNodeID cannot be used together',
              a.attribute,
            );
          }
          annotation = a;
          break;
        case rdf('parseType'):
          parseType = a;
          break;
        case rdf('resource'):
          resource = a;
          break;
        case rdf('nodeID'):
          nodeId = a;
          break;
        case rdf('datatype'):
          datatype = a;
          break;
        case rdf('version'):
          break;
        default:
          if (isForbiddenPropertyAttribute(a.iri)) {
            this.fail(`${a.attribute.name} is not allowed as a property attribute`, a.attribute);
          }
          props.push(a);
      }
    }
    const elements: Array<Xml.Element> = [];
    let text = '';
    let hasText = false;
    for (const c of el.children) {
      if (c._tag === 'Element') elements.push(c);
      else if (c._tag === 'Text') {
        text += c.value;
        hasText = true;
      }
    }

    const finish = (object: Term.Object) => {
      const statement = this.emit(subject, predicate, object);
      this.reify(statement, id, annotation, ctx);
    };

    if (parseType !== undefined) {
      const other = resource ?? nodeId ?? datatype ?? props[0];
      if (other !== undefined) {
        this.fail(`${other.attribute.name} cannot be used with rdf:parseType`, other.attribute);
      }
      switch (parseType.value) {
        case 'Resource': {
          const n = this.fresh();
          finish(n);
          this.nodeElement(el, ctx, n);
          return;
        }
        case 'Collection': {
          const items = this.nodeElementList(el.children, ctx);
          if (Arr.isReadonlyArrayEmpty(items)) {
            finish(rdfNil);
            return;
          }
          const cells = items.map(() => this.fresh());
          finish(cells[0]!);
          cells.forEach((cell, i) => {
            this.emit(cell, rdfFirst, items[i]!);
            this.emit(cell, rdfRest, cells[i + 1] ?? rdfNil);
          });
          return;
        }
        case 'Triple': {
          const saved = this.sink;
          this.sink = [];
          const nodes = elements.length;
          if (nodes !== 1 || (hasText && !Xml.isWhitespace(text))) {
            this.fail('rdf:parseType="Triple" must contain exactly one node element', el);
          }
          this.nodeElement(elements[0]!, ctx);
          const triples = this.sink;
          this.sink = saved;
          if (!isRdf12(ctx.version)) {
            // Triple terms require an RDF 1.2 version announcement; without
            // one the property element is ignored.
            return;
          }
          if (triples.length !== 1) {
            this.fail(
              `rdf:parseType="Triple" content must describe exactly one triple, found ${triples.length}`,
              el,
            );
          }
          finish(triples[0]!);
          return;
        }
        default: {
          finish(new Term.Literal(Xml.canonicalize(el.children), rdfXmlLiteral));
          return;
        }
      }
    }

    if (Arr.isReadonlyArrayNonEmpty(elements)) {
      if (elements.length > 1)
        this.fail('A property element can contain only one node element', el);
      if (!Xml.isWhitespace(text))
        this.fail('Mixed content is not allowed in a property element', el);
      const other = resource ?? nodeId ?? datatype ?? props[0];
      if (other !== undefined) {
        this.fail(
          `${other.attribute.name} is not allowed on a property element with content`,
          other.attribute,
        );
      }
      finish(this.nodeElement(elements[0]!, ctx));
      return;
    }

    if (hasText && text !== '') {
      const other = resource ?? nodeId ?? props[0];
      if (other !== undefined) {
        this.fail(
          `${other.attribute.name} is not allowed on a literal property element`,
          other.attribute,
        );
      }
      finish(
        datatype !== undefined
          ? Term.literal(text, this.iri(datatype.value, ctx))
          : this.literal(text, ctx),
      );
      return;
    }

    // empty property element
    if (resource !== undefined && nodeId !== undefined) {
      this.fail('rdf:resource and rdf:nodeID cannot be used together', nodeId.attribute);
    }
    if (datatype !== undefined) {
      const other = resource ?? nodeId ?? props[0];
      if (other !== undefined) {
        this.fail(`${other.attribute.name} cannot be used with rdf:datatype`, other.attribute);
      }
      finish(Term.literal('', this.iri(datatype.value, ctx)));
      return;
    }
    if (resource === undefined && nodeId === undefined && Arr.isReadonlyArrayEmpty(props)) {
      finish(this.literal('', ctx));
      return;
    }
    const r: Term.NamedNode | Term.BlankNode =
      resource !== undefined
        ? this.iri(resource.value, ctx)
        : nodeId !== undefined
          ? this.blank(nodeId.value, nodeId.attribute)
          : this.fresh();
    for (const a of props) {
      this.emit(
        r,
        new Term.NamedNode(a.iri),
        a.iri === rdf('type') ? this.iri(a.value, ctx) : this.literal(a.value, ctx),
      );
    }
    finish(r);
  }

  reify(statement: Term.Triple, id: Attr | undefined, annotation: Attr | undefined, ctx: Context) {
    if (id !== undefined) {
      const i = this.idIri(id.value, ctx, id.attribute);
      this.emit(i, rdfType, rdfStatement);
      this.emit(i, rdfSubject, statement.subject);
      this.emit(i, rdfPredicate, statement.predicate);
      this.emit(i, rdfObject, statement.object);
    }
    if (annotation !== undefined) {
      const reifier =
        annotation.iri === rdf('annotation')
          ? this.iri(annotation.value, ctx)
          : this.blank(annotation.value, annotation.attribute);
      this.emit(reifier, rdfReifies, statement);
    }
  }
}

const toParseError = (message: string, position: Xml.Position | undefined) =>
  position === undefined
    ? new Serialization.RdfParseError({ format: FORMAT_NAME, message })
    : new Serialization.RdfParseError({
        format: FORMAT_NAME,
        message,
        line: position.line,
        column: position.column,
      });

const parseTriples = (
  doc: Xml.Document,
  options: ParseOptions | undefined,
): Effect.Effect<ReadonlyArray<Term.Triple>, Serialization.RdfParseError> =>
  Effect.try({
    try: () => {
      const parser = new RdfXmlParser(
        options?.blankNodePrefix ?? Serialization.freshBlankNodePrefix(),
        options?.version,
      );
      parser.document(doc, options?.baseIri);
      return parser.sink;
    },
    catch: (e) => {
      if (e instanceof ParseFailure) return toParseError(e.message, e.position);
      throw e;
    },
  });

const collectPrefixes = (doc: Xml.Document): PrefixMap.PrefixMap => {
  const prefixes = new Map<string, string>();
  const go = (el: Xml.Element, depth: number) => {
    for (const d of el.namespaceDeclarations) {
      if (d.prefix !== '' && d.namespace !== '' && !prefixes.has(d.prefix)) {
        prefixes.set(d.prefix, d.namespace);
      }
    }
    if (depth < 2) for (const c of el.children) if (c._tag === 'Element') go(c, depth + 1);
  };
  go(doc.root, 0);
  return PrefixMap.make(prefixes);
};

/**
 * Parses an already-parsed XML document as RDF/XML. The root element is
 * `rdf:RDF` or a single node element; `xml:base` on it is returned as the
 * base IRI and namespace declarations on it (and its children) as prefixes.
 * Formats that embed RDF/XML in a larger XML document (XMP, SVG metadata)
 * pass a document whose root is the embedded `rdf:RDF` element.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseDocument = (
  doc: Xml.Document,
  options?: ParseOptions,
): Effect.Effect<Serialization.ParseResult, Serialization.RdfParseError> =>
  Effect.gen(function* () {
    const triples = yield* parseTriples(doc, options);
    const graph = options?.graph ?? Term.defaultGraph;
    let baseIri = options?.baseIri;
    const xmlBase = doc.root.attributes.find(
      (a) => a.namespace === Xml.XML_NAMESPACE && a.localName === 'base',
    );
    if (xmlBase !== undefined) baseIri = Iri.resolve(xmlBase.value, baseIri);
    const prefixes = collectPrefixes(doc);
    return {
      dataset: Dataset.mutate(Dataset.empty, (b) => {
        for (const t of triples) b.add(new Term.Quad(t.subject, t.predicate, t.object, graph));
      }),
      prefixes,
      baseIri,
    };
  });

/**
 * Parses a complete RDF/XML document. Namespace declarations on the root
 * element (and its children) are returned as prefixes.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (
  input: string,
  options?: ParseOptions,
): Effect.Effect<Serialization.ParseResult, Serialization.RdfParseError> =>
  Effect.gen(function* () {
    const doc = yield* Xml.parse(input).pipe(
      Effect.mapError((e) =>
        toParseError(e.message, { offset: e.offset, line: e.line, column: e.column }),
      ),
    );
    return yield* parseDocument(doc, options);
  });

/**
 * The RDF/XML parser.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parser: Serialization.Parser<ParseOptions> = Serialization.makeParser({
  format,
  parse,
});

// -----------------------------------------------------------------------------
// Serializing
// -----------------------------------------------------------------------------

/**
 * Options for serialising RDF/XML.
 *
 * @since 0.1.0
 * @category models
 */
export interface SerializeOptions extends Serialization.SerializeOptions {
  /** The indentation unit. Defaults to two spaces. */
  readonly indent?: string | undefined;
  /**
   * Whether to nest blank nodes that are the object of exactly one triple
   * inside the referencing property element. Defaults to `true`.
   */
  readonly nestBlankNodes?: boolean | undefined;
  /**
   * Whether to use typed node elements (`<ex:Person>`) for an `rdf:type`
   * of each node. Defaults to `true`.
   */
  readonly typedNodes?: boolean | undefined;
  /** Whether to write the `<?xml …?>` declaration. Defaults to `true`. */
  readonly xmlDeclaration?: boolean | undefined;
}

class SerializeFailure {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

const LOCAL_SUFFIX_RE = new RegExp(`[${Xml.NAME_START}][${Xml.NAME_CHAR}]*$`, 'u');

/**
 * Splits an IRI into a namespace and a local name that is an XML `NCName`,
 * choosing the longest possible local name. Returns `None` when the IRI does
 * not end with an `NCName` (such IRIs cannot be used as element or
 * attribute names).
 *
 * @since 0.1.0
 * @category serializing
 */
export const splitIri = (iri: string): Option.Option<readonly [string, string]> => {
  // The leftmost match is the longest NCName suffix.
  const m = LOCAL_SUFFIX_RE.exec(iri);
  if (m === null || m.index === 0) return Option.none();
  return Option.some([iri.slice(0, m.index), m[0]] as const);
};

const escapeAttr = Xml.escapeAttribute;

interface Namespaces {
  /** namespace → prefix, for configured and generated prefixes. */
  readonly byNamespace: Map<string, string>;
  /** Prefixes taken (configured, generated or reserved). */
  readonly used: Set<string>;
  /** Namespaces actually referenced by the output. */
  readonly declared: Set<string>;
  counter: number;
}

class Writer {
  readonly namespaces: Namespaces;
  readonly blankLabels = new Map<string, string>();
  needsVersion = false;
  needsIts = false;

  readonly options: SerializeOptions;
  constructor(options: SerializeOptions, prefixes: PrefixMap.PrefixMap) {
    this.options = options;
    const byNamespace = new Map<string, string>();
    const used = new Set<string>();
    for (const [prefix, ns] of prefixes.prefixes) {
      if (
        Xml.isNCName(prefix) &&
        !prefix.toLowerCase().startsWith('xml') &&
        !byNamespace.has(ns) &&
        !used.has(prefix) &&
        ns !== ITS &&
        Xml.isValidText(ns)
      ) {
        if (ns === RDF && prefix !== 'rdf') continue;
        if (prefix === 'rdf' && ns !== RDF) continue;
        if (prefix === 'its') continue;
        byNamespace.set(ns, prefix);
        used.add(prefix);
      }
    }
    if (!byNamespace.has(RDF)) {
      byNamespace.set(RDF, 'rdf');
      used.add('rdf');
    }
    used.add('its');
    this.namespaces = { byNamespace, used, declared: new Set([RDF]), counter: 0 };
  }

  fail(message: string): never {
    throw new SerializeFailure(message);
  }

  qname(iri: string, what: string): string {
    if (!Xml.isValidText(iri)) this.fail(`The ${what} <${iri}> contains invalid XML characters`);
    // Prefer the longest configured namespace that leaves an NCName.
    let best: readonly [string, string] | undefined;
    for (const ns of this.namespaces.byNamespace.keys()) {
      if (
        iri.startsWith(ns) &&
        (best === undefined || ns.length > best[0].length) &&
        Xml.isNCName(iri.slice(ns.length))
      ) {
        best = [ns, iri.slice(ns.length)];
      }
    }
    if (best === undefined) {
      const split = splitIri(iri);
      if (Option.isNone(split)) this.fail(`The ${what} <${iri}> cannot be written as an XML QName`);
      best = split.value;
    }
    const [ns, local] = best;
    this.namespaces.declared.add(ns);
    let prefix = this.namespaces.byNamespace.get(ns);
    if (prefix === undefined) {
      do prefix = `ns${++this.namespaces.counter}`;
      while (this.namespaces.used.has(prefix));
      this.namespaces.used.add(prefix);
      this.namespaces.byNamespace.set(ns, prefix);
    }
    return `${prefix}:${local}`;
  }

  iriRef(iri: string): string {
    if (!Xml.isValidText(iri)) this.fail(`The IRI <${iri}> contains characters not allowed in XML`);
    const base = this.options.baseIri;
    if (base !== undefined) {
      const rel = Iri.relativize(iri, base);
      if (Option.isSome(rel)) return escapeAttr(rel.value);
    }
    return escapeAttr(iri);
  }

  blankLabel(node: Term.BlankNode): string {
    let label = this.blankLabels.get(node.value);
    if (label === undefined) {
      label = Xml.isNCName(node.value) && !this.usedLabels.has(node.value) ? node.value : '';
      if (label === '') {
        do label = `b${this.labelCounter++}`;
        while (this.usedLabels.has(label));
      }
      this.usedLabels.add(label);
      this.blankLabels.set(node.value, label);
    }
    return label;
  }
  readonly usedLabels = new Set<string>();
  labelCounter = 0;
}

interface Graph {
  readonly bySubject: Map<string, { subject: Term.Subject; triples: Array<Term.Triple> }>;
  readonly references: Map<string, number>;
}

const text = (value: string, writer: Writer): string => {
  if (!Xml.isValidText(value)) writer.fail('A literal contains characters not allowed in XML 1.0');
  return Xml.escapeText(value);
};

const serializeGraph = (triples: ReadonlyArray<Term.Triple>, options: SerializeOptions): string => {
  const writer = new Writer(options, options.prefixes ?? PrefixMap.empty);
  const indentUnit = options.indent ?? '  ';
  const nest = options.nestBlankNodes ?? true;
  const typed = options.typedNodes ?? true;

  const graph: Graph = { bySubject: new Map(), references: new Map() };
  const inTripleTerm = new Set<string>();
  const markTripleTerm = (t: Term.Term): void => {
    if (t._tag === 'BlankNode') inTripleTerm.add(t.value);
    else if (t._tag === 'Triple') {
      markTripleTerm(t.subject);
      markTripleTerm(t.object);
    }
  };
  for (const t of triples) {
    if (t.subject._tag === 'Triple') {
      writer.fail('RDF/XML cannot represent triple terms in the subject position');
    }
    const key = t.subject.key;
    let entry = graph.bySubject.get(key);
    if (entry === undefined)
      graph.bySubject.set(key, (entry = { subject: t.subject, triples: [] }));
    entry.triples.push(t);
    if (t.object._tag === 'BlankNode') {
      graph.references.set(t.object.value, (graph.references.get(t.object.value) ?? 0) + 1);
    } else if (t.object._tag === 'Triple') {
      markTripleTerm(t.object);
    }
  }

  // Blank nodes that can be written inline, inside their only reference.
  const nested = new Set<string>();
  if (nest) {
    for (const [label, count] of graph.references) {
      if (count === 1 && !inTripleTerm.has(label)) nested.add(label);
    }
    // Break cycles: every nested node must be reachable from a top-level node.
    const reachable = new Set<string>();
    const visit = (subjectKey: string) => {
      const entry = graph.bySubject.get(subjectKey);
      if (entry === undefined) return;
      for (const t of entry.triples) {
        if (
          t.object._tag === 'BlankNode' &&
          nested.has(t.object.value) &&
          !reachable.has(t.object.value)
        ) {
          reachable.add(t.object.value);
          visit(t.object.key);
        }
      }
    };
    for (const [key, entry] of graph.bySubject) {
      if (entry.subject._tag !== 'BlankNode' || !nested.has(entry.subject.value)) visit(key);
    }
    for (const [, entry] of graph.bySubject) {
      const s = entry.subject;
      if (s._tag === 'BlankNode' && nested.has(s.value) && !reachable.has(s.value)) {
        nested.delete(s.value);
        visit(s.key);
      }
    }
  }

  const sortTriples = (ts: ReadonlyArray<Term.Triple>) =>
    Arr.sort(
      ts,
      Order.make<Term.Triple>(
        (a, b) => Term.compare(a.predicate, b.predicate) || Term.compare(a.object, b.object),
      ),
    );

  const body: Array<string> = [];

  /** Writes a node element for `subject` at `depth`. */
  const node = (subject: Term.Subject, depth: number, inline: boolean, lines: Array<string>) => {
    const pad = indentUnit.repeat(depth);
    const entry = graph.bySubject.get(subject.key);
    let ts = entry === undefined ? [] : sortTriples(entry.triples);
    let element = 'rdf:Description';
    if (typed) {
      const typeTriple = ts.find(
        (t) =>
          t.predicate.value === rdf('type') &&
          t.object._tag === 'NamedNode' &&
          !isForbiddenNodeElement(t.object.value) &&
          Option.isSome(splitIri(t.object.value)) &&
          Xml.isValidText(t.object.value),
      );
      if (typeTriple !== undefined) {
        element = writer.qname((typeTriple.object as Term.NamedNode).value, 'type');
        ts = ts.filter((t) => t !== typeTriple);
      }
    }
    let attrs = '';
    if (subject._tag === 'NamedNode') attrs = ` rdf:about="${writer.iriRef(subject.value)}"`;
    else if (subject._tag === 'BlankNode' && !inline) {
      if ((graph.references.get(subject.value) ?? 0) > 0 || inTripleTerm.has(subject.value)) {
        attrs = ` rdf:nodeID="${writer.blankLabel(subject)}"`;
      }
    }
    if (Arr.isReadonlyArrayEmpty(ts)) {
      lines.push(`${pad}<${element}${attrs}/>`);
      return;
    }
    lines.push(`${pad}<${element}${attrs}>`);
    for (const t of ts) property(t, depth + 1, lines);
    lines.push(`${pad}</${element}>`);
  };

  const property = (t: Term.Triple, depth: number, lines: Array<string>) => {
    const pad = indentUnit.repeat(depth);
    const p = t.predicate.value;
    if (isForbiddenPropertyElement(p) || p === rdf('li')) {
      writer.fail(`The predicate <${p}> cannot be used as an RDF/XML property element`);
    }
    const name = writer.qname(p, 'predicate');
    const o = t.object;
    switch (o._tag) {
      case 'NamedNode':
        lines.push(`${pad}<${name} rdf:resource="${writer.iriRef(o.value)}"/>`);
        return;
      case 'BlankNode': {
        if (nested.has(o.value) && !inTripleTerm.has(o.value)) {
          const entry = graph.bySubject.get(o.key);
          if (entry === undefined || Arr.isReadonlyArrayEmpty(entry.triples)) {
            lines.push(`${pad}<${name} rdf:parseType="Resource"/>`);
            return;
          }
          const hasType =
            typed &&
            entry.triples.some(
              (x) =>
                x.predicate.value === rdf('type') &&
                x.object._tag === 'NamedNode' &&
                !isForbiddenNodeElement(x.object.value) &&
                Option.isSome(splitIri(x.object.value)),
            );
          if (!hasType) {
            lines.push(`${pad}<${name} rdf:parseType="Resource">`);
            for (const x of sortTriples(entry.triples)) property(x, depth + 1, lines);
            lines.push(`${pad}</${name}>`);
            return;
          }
          lines.push(`${pad}<${name}>`);
          node(o, depth + 1, true, lines);
          lines.push(`${pad}</${name}>`);
          return;
        }
        lines.push(`${pad}<${name} rdf:nodeID="${writer.blankLabel(o)}"/>`);
        return;
      }
      case 'Literal': {
        let attrs = '';
        if (o.language !== '') {
          attrs += ` xml:lang="${escapeAttr(o.language)}"`;
          if (o.direction !== undefined) {
            writer.needsVersion = true;
            writer.needsIts = true;
            attrs += ` its:dir="${o.direction}"`;
          }
        } else if (o.datatype.value !== XSD_STRING) {
          attrs += ` rdf:datatype="${writer.iriRef(o.datatype.value)}"`;
        }
        if (o.value === '') lines.push(`${pad}<${name}${attrs}/>`);
        else lines.push(`${pad}<${name}${attrs}>${text(o.value, writer)}</${name}>`);
        return;
      }
      case 'Triple': {
        writer.needsVersion = true;
        lines.push(`${pad}<${name} rdf:parseType="Triple">`);
        tripleTerm(o, depth + 1, lines);
        lines.push(`${pad}</${name}>`);
        return;
      }
    }
  };

  const tripleTerm = (t: Term.Triple, depth: number, lines: Array<string>) => {
    const pad = indentUnit.repeat(depth);
    const s = t.subject;
    const attrs =
      s._tag === 'NamedNode'
        ? ` rdf:about="${writer.iriRef(s.value)}"`
        : s._tag === 'BlankNode'
          ? ` rdf:nodeID="${writer.blankLabel(s)}"`
          : writer.fail('RDF/XML cannot represent triple terms in the subject position');
    lines.push(`${pad}<rdf:Description${attrs}>`);
    const o = t.object;
    if (o._tag === 'BlankNode') {
      const name = writer.qname(t.predicate.value, 'predicate');
      if (isForbiddenPropertyElement(t.predicate.value) || t.predicate.value === rdf('li')) {
        writer.fail(
          `The predicate <${t.predicate.value}> cannot be used as an RDF/XML property element`,
        );
      }
      lines.push(`${pad}${indentUnit}<${name} rdf:nodeID="${writer.blankLabel(o)}"/>`);
    } else {
      property(t, depth + 1, lines);
    }
    lines.push(`${pad}</rdf:Description>`);
  };

  const subjects = Arr.sort(
    Arr.map([...graph.bySubject.values()], (e) => e.subject),
    Order.make<Term.Term>((a, b) =>
      a._tag === b._tag ? Term.compare(a, b) : a._tag === 'NamedNode' ? -1 : 1,
    ),
  );
  for (const s of subjects) {
    if (s._tag === 'BlankNode' && nested.has(s.value)) continue;
    node(s, 1, false, body);
  }

  const out: Array<string> = [];
  if (options.xmlDeclaration ?? true) out.push('<?xml version="1.0" encoding="utf-8"?>');
  const decls: Array<string> = [];
  const nsEntries = Arr.sort(
    Arr.filter([...writer.namespaces.byNamespace.entries()], ([ns]) =>
      writer.namespaces.declared.has(ns),
    ),
    Order.make<readonly [string, string]>((a, b) =>
      a[1] === 'rdf' ? -1 : b[1] === 'rdf' ? 1 : a[1] < b[1] ? -1 : 1,
    ),
  );
  for (const [ns, prefix] of nsEntries) decls.push(`xmlns:${prefix}="${escapeAttr(ns)}"`);
  if (writer.needsIts) decls.push(`xmlns:its="${ITS}"`, 'its:version="2.0"');
  if (options.baseIri !== undefined) decls.push(`xml:base="${escapeAttr(options.baseIri)}"`);
  if (writer.needsVersion) decls.push('rdf:version="1.2"');
  const sep = `\n${' '.repeat('<rdf:RDF '.length)}`;
  if (Arr.isReadonlyArrayEmpty(body)) {
    out.push(`<rdf:RDF ${decls.join(sep)}/>`);
  } else {
    out.push(`<rdf:RDF ${decls.join(sep)}>`);
    out.push(...body);
    out.push('</rdf:RDF>');
  }
  return `${out.join('\n')}\n`;
};

/**
 * Serialises quads as an RDF/XML document. Fails with `RdfSerializeError`
 * for quads in named graphs, triple terms in the subject position, and
 * predicates that cannot be written as XML QNames.
 *
 * @since 0.1.0
 * @category serializing
 */
export const serialize = (
  quads: Iterable<Term.Quad>,
  options?: SerializeOptions,
): Effect.Effect<string, Serialization.RdfSerializeError> =>
  Effect.suspend(() => {
    const triples: Array<Term.Triple> = [];
    for (const q of quads) {
      if (q.graph._tag !== 'DefaultGraph') {
        return Effect.fail(
          new Serialization.RdfSerializeError({
            format: FORMAT_NAME,
            message: `RDF/XML cannot represent named graphs (found graph ${q.graph.key})`,
          }),
        );
      }
      triples.push(q.triple);
    }
    return Effect.try({
      try: () => serializeGraph(triples, options ?? {}),
      catch: (e) => {
        if (e instanceof SerializeFailure) {
          return new Serialization.RdfSerializeError({ format: FORMAT_NAME, message: e.message });
        }
        throw e;
      },
    });
  });

/**
 * The RDF/XML serializer.
 *
 * @since 0.1.0
 * @category serializing
 */
export const serializer: Serialization.Serializer<SerializeOptions> = Serialization.makeSerializer({
  format,
  serialize,
});

/**
 * The RDF/XML codec, including a `Schema` transforming RDF/XML documents to
 * datasets and back.
 *
 * @since 0.1.0
 * @category codecs
 */
export const codec: Serialization.Codec<ParseOptions, SerializeOptions> = Serialization.makeCodec(
  parser,
  serializer,
);
