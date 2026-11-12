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
import * as Match from 'effect/Match';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Result from 'effect/Result';
import * as Order from 'effect/Order';
import * as Dataset from '../Dataset.ts';
import * as Iri from '../Iri.ts';
import * as PrefixMap from '../PrefixMap.ts';
import * as Serialization from '../Serialization.ts';
import * as Term from '../Term.ts';
import * as Xml from './Xml.ts';
import * as XmlParser from './internal/builder.ts';

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

// Spans are named `RdfXml.parse`, `RdfXml.serialize`.
const trace: Serialization.SpanTarget = { module: 'RdfXml', format };

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

/** The core syntax terms and the old terms, which are never node, property or attribute names. */
const RESERVED_TERMS = MutableHashSet.fromIterable(
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
    'aboutEach',
    'aboutEachPrefix',
    'bagID',
  ].map(rdf),
);
const UNQUALIFIED_RDF_ATTRIBUTES = MutableHashSet.make(
  'ID',
  'about',
  'resource',
  'parseType',
  'type',
  'version',
);

const RDF_DESCRIPTION = rdf('Description');
const RDF_LI = rdf('li');
const RDF_TYPE = rdf('type');
const RDF_ID = rdf('ID');
const RDF_NODE_ID = rdf('nodeID');
const RDF_ABOUT = rdf('about');
const RDF_VERSION = rdf('version');
const RDF_ANNOTATION = rdf('annotation');
const RDF_ANNOTATION_NODE_ID = rdf('annotationNodeID');
const RDF_PARSE_TYPE = rdf('parseType');
const RDF_RESOURCE = rdf('resource');
const RDF_DATATYPE = rdf('datatype');

const isReserved = (iri: string): boolean => MutableHashSet.has(RESERVED_TERMS, iri);
const isForbiddenNodeElement = (iri: string) => isReserved(iri) || iri === RDF_LI;
const isForbiddenPropertyElement = (iri: string) => isReserved(iri) || iri === RDF_DESCRIPTION;
const isForbiddenPropertyAttribute = (iri: string) =>
  isReserved(iri) || iri === RDF_DESCRIPTION || iri === RDF_LI;

const isElement = Predicate.isTagged('Element');
const isText = Predicate.isTagged('Text');

class ParseFailure {
  readonly message: string;
  readonly position: Xml.Position;
  constructor(message: string, position: Xml.Position) {
    this.message = message;
    this.position = position;
  }
}

interface Context {
  readonly base: Option.Option<string>;
  readonly language: string;
  readonly direction: '' | Term.Direction;
  readonly version: Option.Option<string>;
}

/** Resolves `reference` against the base IRI of `ctx`, if it has one. */
const resolveIn = (reference: string, base: Option.Option<string>): string =>
  Iri.resolve(reference, Option.getOrUndefined(base));

interface Attr {
  readonly iri: string;
  readonly value: string;
  readonly attribute: Xml.Attribute;
}

const isRdf12 = (version: Option.Option<string>): boolean =>
  Option.isSome(version) && version.value !== '1.0' && version.value !== '1.1';

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

/** The syntax attributes of a node element, gathered by `nodeAttribute`. */
interface NodeAttributes {
  idAttr: Option.Option<Attr>;
  readonly props: Array<Attr>;
}

/**
 * Adds an attribute that is not a syntax attribute of its element to `props`
 * (`rdf:version` aside, which `context` reads).
 */
const propertyAttr = (a: Attr, parser: RdfXmlParser, props: Array<Attr>): void => {
  if (a.iri === RDF_VERSION) return;
  if (isForbiddenPropertyAttribute(a.iri)) {
    parser.fail(`${a.attribute.name} is not allowed as a property attribute`, a.attribute);
  }
  props.push(a);
};

/** Gathers an attribute of a node element (run for every one, so a chain of comparisons). */
const nodeAttribute = (a: Attr, parser: RdfXmlParser, attrs: NodeAttributes): void => {
  const iri = a.iri;
  if (iri !== RDF_ID && iri !== RDF_NODE_ID && iri !== RDF_ABOUT) {
    propertyAttr(a, parser, attrs.props);
    return;
  }
  if (Option.isSome(attrs.idAttr)) {
    parser.fail(
      `rdf:${attrs.idAttr.value.attribute.localName} and rdf:${a.attribute.localName} cannot be used together`,
      a.attribute,
    );
  }
  attrs.idAttr = Option.some(a);
};

/** The syntax attributes of a property element, gathered by `propertyAttribute`. */
interface PropertyAttributes {
  id: Option.Option<Attr>;
  annotation: Option.Option<Attr>;
  parseType: Option.Option<Attr>;
  resource: Option.Option<Attr>;
  nodeId: Option.Option<Attr>;
  datatype: Option.Option<Attr>;
  readonly props: Array<Attr>;
}

/** Gathers an attribute of a property element (run for every one, so a chain of comparisons). */
const propertyAttribute = (a: Attr, parser: RdfXmlParser, attrs: PropertyAttributes): void => {
  const iri = a.iri;
  if (iri === RDF_ID) attrs.id = Option.some(a);
  else if (iri === RDF_ANNOTATION || iri === RDF_ANNOTATION_NODE_ID) {
    if (Option.isSome(attrs.annotation)) {
      parser.fail('rdf:annotation and rdf:annotationNodeID cannot be used together', a.attribute);
    }
    attrs.annotation = Option.some(a);
  } else if (iri === RDF_PARSE_TYPE) attrs.parseType = Option.some(a);
  else if (iri === RDF_RESOURCE) attrs.resource = Option.some(a);
  else if (iri === RDF_NODE_ID) attrs.nodeId = Option.some(a);
  else if (iri === RDF_DATATYPE) attrs.datatype = Option.some(a);
  else propertyAttr(a, parser, attrs.props);
};

const isRdfRoot = (root: Xml.Element): boolean =>
  root.namespace === RDF && root.localName === 'RDF';

class RdfXmlParser {
  sink: Array<Term.Triple> = [];
  readonly ids = MutableHashSet.empty<string>();
  counter = 0;

  readonly blankNodePrefix: string;
  readonly defaultVersion: Option.Option<string>;
  constructor(blankNodePrefix: string, defaultVersion: Option.Option<string>) {
    this.blankNodePrefix = blankNodePrefix;
    this.defaultVersion = defaultVersion;
  }

  fail(message: string, node: { readonly position: Xml.Position }): never {
    throw new ParseFailure(message, node.position);
  }

  /** Fails if any of `attrs` is present: the first `<name> <why>`. */
  reject(attrs: Iterable<Option.Option<Attr>>, why: string): void {
    const other = Option.firstSomeOf(attrs);
    if (Option.isSome(other)) {
      const { attribute } = other.value;
      this.fail(`${attribute.name} ${why}`, attribute);
    }
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

  /** The IRIs of names and datatypes seen so far, which repeat throughout a document. */
  private readonly names = MutableHashMap.empty<string, Term.NamedNode>();

  /**
   * The IRIs of the names read so far, by local name, then namespace (a
   * local name rarely has more than one).
   */
  private readonly qualifiedNames = MutableHashMap.empty<
    string,
    Array<readonly [namespace: string, iri: string]>
  >();

  /**
   * The IRI of a name (`namespace` + `localName`), the same string each time
   * it is read: names repeat throughout a document, and each later lookup of
   * the IRI (in the reserved-term set, the node cache) then hashes nothing.
   */
  qualified(namespace: string, localName: string): string {
    const byLocalName = MutableHashMap.get(this.qualifiedNames, localName);
    if (Option.isNone(byLocalName)) {
      const iri = namespace + localName;
      MutableHashMap.set(this.qualifiedNames, localName, [[namespace, iri]]);
      return iri;
    }
    const byNamespace = byLocalName.value;
    const known = byNamespace.find(([ns]) => ns === namespace);
    if (known !== undefined) return known[1];
    const iri = namespace + localName;
    byNamespace.push([namespace, iri]);
    return iri;
  }

  /** The node for the IRI of an element or attribute name, or of a datatype. */
  named(iri: string): Term.NamedNode {
    const known = MutableHashMap.get(this.names, iri);
    if (Option.isSome(known)) return known.value;
    const node = new Term.NamedNode(iri);
    MutableHashMap.set(this.names, iri, node);
    return node;
  }

  iri(value: string, ctx: Context): Term.NamedNode {
    return new Term.NamedNode(resolveIn(value, ctx.base));
  }

  idIri(id: string, ctx: Context, node: { readonly position: Xml.Position }): Term.NamedNode {
    if (!Xml.isNCName(id)) this.fail(`Invalid rdf:ID "${id}"`, node);
    const iri = resolveIn(`#${id}`, ctx.base);
    if (MutableHashSet.has(this.ids, iri)) this.fail(`Duplicate rdf:ID "${id}"`, node);
    MutableHashSet.add(this.ids, iri);
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
    if (Arr.isReadonlyArrayEmpty(el.attributes)) return parent;
    let base = parent.base;
    let language = parent.language;
    let direction = parent.direction;
    let version = parent.version;
    let dir = Option.none<Xml.Attribute>();
    el.attributes.forEach((a) => {
      if (a.namespace === Xml.XML_NAMESPACE) {
        if (a.localName === 'base') base = Option.some(resolveIn(a.value, base));
        else if (a.localName === 'lang') language = a.value;
      } else if (a.namespace === ITS && a.localName === 'dir') {
        dir = Option.some(a);
      } else if ((a.namespace === RDF || a.namespace === undefined) && a.localName === 'version') {
        version = Option.some(a.value);
      }
    });
    if (Option.isSome(dir) && isRdf12(version)) {
      const value = dir.value.value;
      if (value !== 'ltr' && value !== 'rtl' && value !== '') {
        this.fail(`Invalid its:dir value "${value}"`, dir.value);
      }
      // SAFETY: the value was checked to be `ltr` or `rtl` above.
      direction = value;
    }
    return { base, language, direction, version };
  }

  /** The RDF-relevant attributes of an element, with their IRIs. */
  attributes(el: Xml.Element): Array<Attr> {
    const out: Array<Attr> = [];
    el.attributes.forEach((a) => {
      if (a.namespace === Xml.XML_NAMESPACE) return;
      if (a.prefix.toLowerCase().startsWith('xml')) return;
      if (a.namespace === undefined) {
        if (a.localName.toLowerCase().startsWith('xml')) return;
        if (!MutableHashSet.has(UNQUALIFIED_RDF_ATTRIBUTES, a.localName)) {
          this.fail(`Unqualified attribute "${a.localName}" is not allowed`, a);
        }
        out.push({ iri: this.qualified(RDF, a.localName), value: a.value, attribute: a });
        return;
      }
      if (a.namespace === ITS && (a.localName === 'dir' || a.localName === 'version')) return;
      out.push({ iri: this.qualified(a.namespace, a.localName), value: a.value, attribute: a });
    });
    return out;
  }

  elementIri(el: Xml.Element): string {
    if (el.namespace === undefined) {
      this.fail(`Element "${el.name}" is not in a namespace`, el);
    }
    return this.qualified(el.namespace, el.localName);
  }

  document(doc: Xml.Document, base: Option.Option<string>): void {
    const root = doc.root;
    const ctx: Context = { base, language: '', direction: '', version: this.defaultVersion };
    if (isRdfRoot(root)) this.nodeElementList(root.children, this.rdfRoot(root, ctx));
    else this.nodeElement(root, ctx);
  }

  /** The context of the node elements in an `rdf:RDF` root, after checking its attributes. */
  rdfRoot(root: Xml.Element, ctx: Context): Context {
    const rootCtx = this.context(root, ctx);
    this.attributes(root).forEach((a) => {
      if (a.iri !== RDF_VERSION) this.fail(`Unexpected attribute on rdf:RDF`, a.attribute);
    });
    return rootCtx;
  }

  nodeElementList(children: ReadonlyArray<Xml.Node>, ctx: Context): Array<Term.Subject> {
    const subjects: Array<Term.Subject> = [];
    children.forEach((c) => {
      if (isElement(c)) subjects.push(this.nodeElement(c, ctx));
      else if (isText(c) && !Xml.isWhitespace(c.value)) {
        this.fail('Unexpected text where node elements are expected', c);
      }
    });
    return subjects;
  }

  nodeElement(el: Xml.Element, parentCtx: Context): Term.Subject {
    const ctx = this.context(el, parentCtx);
    const iri = this.elementIri(el);
    if (isForbiddenNodeElement(iri)) this.fail(`<${el.name}> is not allowed as a node element`, el);
    const attrs: NodeAttributes = { idAttr: Option.none(), props: [] };
    this.attributes(el).forEach((a) => nodeAttribute(a, this, attrs));
    const s: Term.Subject = Option.match(attrs.idAttr, {
      onNone: () => this.fresh(),
      onSome: (idAttr) => {
        const local = idAttr.iri.slice(RDF.length);
        return local === 'ID'
          ? this.idIri(idAttr.value, ctx, idAttr.attribute)
          : local === 'nodeID'
            ? this.blank(idAttr.value, idAttr.attribute)
            : this.iri(idAttr.value, ctx);
      },
    });
    if (iri !== RDF_DESCRIPTION) this.emit(s, rdfType, this.named(iri));
    attrs.props.forEach((a) => {
      this.emit(
        s,
        this.named(a.iri),
        a.iri === RDF_TYPE ? this.iri(a.value, ctx) : this.literal(a.value, ctx),
      );
    });
    this.propertyEltList(el, s, ctx);
    return s;
  }

  propertyEltList(el: Xml.Element, subject: Term.Subject, ctx: Context): void {
    let li = 1;
    el.children.forEach((c) => {
      if (isElement(c)) {
        const name = this.elementIri(c);
        this.propertyElt(c, name === RDF_LI ? rdf(`_${li++}`) : name, subject, ctx);
      } else if (isText(c) && !Xml.isWhitespace(c.value)) {
        this.fail('Unexpected text where property elements are expected', c);
      }
    });
  }

  propertyElt(el: Xml.Element, iri: string, subject: Term.Subject, parentCtx: Context): void {
    if (isForbiddenPropertyElement(iri)) {
      this.fail(`<${el.name}> is not allowed as a property element`, el);
    }
    const ctx = this.context(el, parentCtx);
    const predicate = this.named(iri);
    const attrs: PropertyAttributes = {
      id: Option.none(),
      annotation: Option.none(),
      parseType: Option.none(),
      resource: Option.none(),
      nodeId: Option.none(),
      datatype: Option.none(),
      props: [],
    };
    this.attributes(el).forEach((a) => propertyAttribute(a, this, attrs));
    const { id, annotation, parseType, resource, nodeId, datatype, props } = attrs;
    const elements: Array<Xml.Element> = [];
    let text = '';
    let hasText = false;
    el.children.forEach((c) => {
      if (isElement(c)) elements.push(c);
      else if (isText(c)) {
        text += c.value;
        hasText = true;
      }
    });

    const finish = (object: Term.Object) => {
      const statement = this.emit(subject, predicate, object);
      this.reify(statement, id, annotation, ctx);
    };
    const firstProp = Arr.head(props);

    if (Option.isSome(parseType)) {
      this.reject([resource, nodeId, datatype, firstProp], 'cannot be used with rdf:parseType');
      Match.value(parseType.value.value).pipe(
        Match.when('Resource', () => {
          const n = this.fresh();
          finish(n);
          this.propertyEltList(el, n, ctx);
        }),
        Match.when('Collection', () => {
          const items = this.nodeElementList(el.children, ctx);
          if (!Arr.isArrayNonEmpty(items)) {
            finish(rdfNil);
            return;
          }
          const cells = Arr.map(items, () => this.fresh());
          finish(Arr.headNonEmpty(cells));
          Arr.zip(cells, items).forEach(([cell, item], i) => {
            this.emit(cell, rdfFirst, item);
            this.emit(cell, rdfRest, cells[i + 1] ?? rdfNil);
          });
        }),
        Match.when('Triple', () => {
          const saved = this.sink;
          this.sink = [];
          if (
            !Arr.isArrayNonEmpty(elements) ||
            elements.length !== 1 ||
            (hasText && !Xml.isWhitespace(text))
          ) {
            this.fail('rdf:parseType="Triple" must contain exactly one node element', el);
          }
          this.nodeElement(Arr.headNonEmpty(elements), ctx);
          const triples = this.sink;
          this.sink = saved;
          if (!isRdf12(ctx.version)) {
            // Triple terms require an RDF 1.2 version announcement; without
            // one the property element is ignored.
            return;
          }
          if (!Arr.isArrayNonEmpty(triples) || triples.length !== 1) {
            this.fail(
              `rdf:parseType="Triple" content must describe exactly one triple, found ${triples.length}`,
              el,
            );
          }
          finish(Arr.headNonEmpty(triples));
        }),
        Match.orElse(() => {
          finish(new Term.Literal(Xml.canonicalize(el.children), rdfXmlLiteral));
        }),
      );
      return;
    }

    if (Arr.isArrayNonEmpty(elements)) {
      if (elements.length > 1)
        this.fail('A property element can contain only one node element', el);
      if (!Xml.isWhitespace(text))
        this.fail('Mixed content is not allowed in a property element', el);
      this.reject(
        [resource, nodeId, datatype, firstProp],
        'is not allowed on a property element with content',
      );
      finish(this.nodeElement(Arr.headNonEmpty(elements), ctx));
      return;
    }

    if (hasText && text !== '') {
      this.reject([resource, nodeId, firstProp], 'is not allowed on a literal property element');
      finish(
        Option.isSome(datatype)
          ? Term.literal(text, this.named(resolveIn(datatype.value.value, ctx.base)))
          : this.literal(text, ctx),
      );
      return;
    }

    // empty property element
    if (Option.isSome(resource) && Option.isSome(nodeId)) {
      this.fail('rdf:resource and rdf:nodeID cannot be used together', nodeId.value.attribute);
    }
    if (Option.isSome(datatype)) {
      this.reject([resource, nodeId, firstProp], 'cannot be used with rdf:datatype');
      finish(Term.literal('', this.named(resolveIn(datatype.value.value, ctx.base))));
      return;
    }
    if (Option.isNone(resource) && Option.isNone(nodeId) && Arr.isReadonlyArrayEmpty(props)) {
      finish(this.literal('', ctx));
      return;
    }
    const r: Term.NamedNode | Term.BlankNode = Option.isSome(resource)
      ? this.iri(resource.value.value, ctx)
      : Option.isSome(nodeId)
        ? this.blank(nodeId.value.value, nodeId.value.attribute)
        : this.fresh();
    props.forEach((a) => {
      this.emit(
        r,
        this.named(a.iri),
        a.iri === RDF_TYPE ? this.iri(a.value, ctx) : this.literal(a.value, ctx),
      );
    });
    finish(r);
  }

  reify(
    statement: Term.Triple,
    id: Option.Option<Attr>,
    annotation: Option.Option<Attr>,
    ctx: Context,
  ) {
    if (Option.isSome(id)) {
      const i = this.idIri(id.value.value, ctx, id.value.attribute);
      this.emit(i, rdfType, rdfStatement);
      this.emit(i, rdfSubject, statement.subject);
      this.emit(i, rdfPredicate, statement.predicate);
      this.emit(i, rdfObject, statement.object);
    }
    if (Option.isSome(annotation)) {
      const { iri, value, attribute } = annotation.value;
      const reifier = iri === RDF_ANNOTATION ? this.iri(value, ctx) : this.blank(value, attribute);
      this.emit(reifier, rdfReifies, statement);
    }
  }
}

const toParseError = (message: string, position: Xml.Position) =>
  new Serialization.RdfParseError({
    format: FORMAT_NAME,
    message,
    line: position.line,
    column: position.column,
  });

const parseTriples = (
  doc: Xml.Document,
  options?: ParseOptions,
): Effect.Effect<ReadonlyArray<Term.Triple>, Serialization.RdfParseError> =>
  Effect.try({
    try: () => {
      const parser = new RdfXmlParser(
        options?.blankNodePrefix ?? Serialization.freshBlankNodePrefix(),
        Option.fromUndefinedOr(options?.version),
      );
      parser.document(doc, Option.fromUndefinedOr(options?.baseIri));
      return parser.sink;
    },
    catch: (e) => {
      if (e instanceof ParseFailure) return toParseError(e.message, e.position);
      throw e;
    },
  });

/** Prefixes in the order first declared, each with its first namespace. */
type Prefixes = Array<readonly [prefix: string, namespace: string]>;

/**
 * Adds the namespace declarations of the elements among `nodes` (at
 * `depth`, the root's being 0) and of their descendants down to `maxDepth`
 * to `prefixes`, keeping the first declaration of each prefix.
 */
const declarePrefixes = (
  prefixes: Prefixes,
  nodes: ReadonlyArray<Xml.Node>,
  depth: number,
  maxDepth: number,
): void => {
  nodes.forEach((node) => {
    if (!isElement(node)) return;
    node.namespaceDeclarations.forEach((d) => {
      if (d.prefix !== '' && d.namespace !== '' && !prefixes.some(([p]) => p === d.prefix)) {
        prefixes.push([d.prefix, d.namespace]);
      }
    });
    if (depth < maxDepth) declarePrefixes(prefixes, node.children, depth + 1, maxDepth);
  });
};

/** The prefixes declared on the root, its children and their children. */
const collectPrefixes = (doc: Xml.Document): PrefixMap.PrefixMap => {
  const prefixes: Prefixes = [];
  declarePrefixes(prefixes, [doc.root], 0, 2);
  return PrefixMap.make(prefixes);
};

/**
 * Converts the node elements of an `rdf:RDF` root while the XML is read, as
 * each one is closed, so that no more than one of them is held at a time.
 * The order of conversion (and so of triples, blank nodes and prefixes) and
 * which error is reported are as for a whole document: an XML error anywhere
 * comes first, so the first RDF/XML error is kept until the XML has been
 * read.
 */
class RootStream {
  readonly parser: RdfXmlParser;
  /** The context outside the root, and then that of its node elements. */
  private ctx: Context;
  readonly prefixes: Prefixes = [];
  readonly failures: Array<ParseFailure> = [];
  /** Whether the root has been seen, and whether it is `rdf:RDF`. */
  private started = false;
  private streaming = false;
  /** How many of the children the root kept have been converted. */
  private converted = 0;

  constructor(parser: RdfXmlParser, ctx: Context) {
    this.parser = parser;
    this.ctx = ctx;
  }

  /** The `RootChildHook`: takes the child if the root is `rdf:RDF`. */
  readonly take = (child: Xml.Element, root: Xml.Element): boolean => {
    if (!this.begin(root)) return false;
    this.guard(() => {
      this.drain(root);
      declarePrefixes(this.prefixes, [child], 1, 2);
      this.parser.nodeElement(child, this.ctx);
    });
    return true;
  };

  /** Converts what is left once the document has been read. */
  finish(doc: Xml.Document): void {
    if (this.begin(doc.root)) {
      this.guard(() => this.drain(doc.root));
    } else {
      this.parser.document(doc, this.ctx.base);
      declarePrefixes(this.prefixes, [doc.root], 0, 2);
    }
    const failure = this.failures.at(0);
    if (failure !== undefined) throw failure;
  }

  private begin(root: Xml.Element): boolean {
    if (!this.started) {
      this.started = true;
      this.streaming = isRdfRoot(root);
      if (this.streaming) {
        declarePrefixes(this.prefixes, [root], 0, 0);
        this.guard(() => {
          this.ctx = this.parser.rdfRoot(root, this.ctx);
        });
      }
    }
    return this.streaming;
  }

  /** Converts the children the root kept (text, and elements from entities) since the last time. */
  private drain(root: Xml.Element): void {
    const pending = root.children.slice(this.converted);
    this.converted = root.children.length;
    declarePrefixes(this.prefixes, pending, 1, 2);
    this.parser.nodeElementList(pending, this.ctx);
  }

  /** Runs a conversion step unless one has failed, keeping its failure. */
  private guard(step: () => void): void {
    if (Arr.isReadonlyArrayNonEmpty(this.failures)) return;
    const outcome = Result.try({ try: step, catch: (e) => e });
    if (Result.isSuccess(outcome)) return;
    if (!(outcome.failure instanceof ParseFailure)) throw outcome.failure;
    this.failures.push(outcome.failure);
  }
}

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
  Effect.map(parseTriples(doc, options), (triples) =>
    toResult(toQuadsResult(triples, doc, collectPrefixes(doc), options)),
  );

/** The result of a parse: the triples in their graph, with the document's prefixes and base. */
/** The quads of a parse, in their graph, with the document's prefixes and base. */
const toQuadsResult = (
  triples: ReadonlyArray<Term.Triple>,
  doc: Xml.Document,
  prefixes: PrefixMap.PrefixMap,
  options?: ParseOptions,
): QuadsResult => {
  const graph = options?.graph ?? Term.defaultGraph;
  let baseIri = options?.baseIri;
  const xmlBase = doc.root.attributes.find(
    (a) => a.namespace === Xml.XML_NAMESPACE && a.localName === 'base',
  );
  if (xmlBase !== undefined) baseIri = Iri.resolve(xmlBase.value, baseIri);
  return {
    quads: triples.map((t) => new Term.Quad(t.subject, t.predicate, t.object, graph)),
    prefixes,
    baseIri,
  };
};

const toResult = (quads: QuadsResult): Serialization.ParseResult => ({
  dataset: Dataset.fromIterable(quads.quads),
  prefixes: quads.prefixes,
  baseIri: quads.baseIri,
});

/**
 * The statements of an RDF/XML document in document order (duplicates
 * kept), with the namespace declarations on the root element (and its
 * children) as prefixes and the document's base IRI.
 *
 * @since 0.1.0
 * @category models
 */
export interface QuadsResult extends Omit<Serialization.ParseResult, 'dataset'> {
  readonly quads: ReadonlyArray<Term.Quad>;
}

/**
 * Parses a complete RDF/XML document into its statements in document order,
 * without building a dataset. Node elements are converted as they are read,
 * so the XML tree is never held whole.
 *
 * @since 0.1.0
 * @category parsing
 * @example
 * ```ts
 * import * as Effect from 'effect/Effect';
 * import { RdfXml } from '@thomasfosterau/effect-rdf/rdfxml';
 *
 * const { quads } = Effect.runSync(
 *   RdfXml.parseQuads(
 *     `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
 *               xmlns:ex="http://example.org/">
 *        <rdf:Description rdf:about="http://example.org/a" ex:p="1"/>
 *      </rdf:RDF>`,
 *   ),
 * );
 * // quads.length === 1
 * ```
 */
export const parseQuads = (
  input: string,
  options?: ParseOptions,
): Effect.Effect<QuadsResult, Serialization.RdfParseError> =>
  Effect.try({
    try: () => {
      const version = Option.fromUndefinedOr(options?.version);
      const parser = new RdfXmlParser(
        options?.blankNodePrefix ?? Serialization.freshBlankNodePrefix(),
        version,
      );
      const stream = new RootStream(parser, {
        base: Option.fromUndefinedOr(options?.baseIri),
        language: '',
        direction: '',
        version,
      });
      const doc = XmlParser.parseText(input, stream.take);
      stream.finish(doc);
      return toQuadsResult(parser.sink, doc, PrefixMap.make(stream.prefixes), options);
    },
    catch: (e) => {
      if (e instanceof XmlParser.Failure) return toParseError(e.message, e.position);
      if (e instanceof ParseFailure) return toParseError(e.message, e.position);
      throw e;
    },
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
  Effect.map(parseQuads(input, options), toResult).pipe(Serialization.withParseSpan(trace, input));

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

// The trailing run of name characters. The lookbehind fails at once inside a run, so the match is
// attempted in full only at each run's start: linear, where `[start][char]*$` was quadratic.
const TRAILING_NAME_CHARS_RE = new RegExp(`(?<![${Xml.NAME_CHAR}])[${Xml.NAME_CHAR}]*$`, 'u');
const NAME_START_RE = new RegExp(`[${Xml.NAME_START}]`, 'u');

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
  // The longest NCName suffix starts at the first name-start character of the trailing run.
  const run = TRAILING_NAME_CHARS_RE.exec(iri);
  const first = run === null ? null : NAME_START_RE.exec(run[0]);
  if (run === null || first === null) return Option.none();
  const start = run.index + first.index;
  if (start === 0) return Option.none();
  return Option.some([iri.slice(0, start), iri.slice(start)] as const);
};

const escapeAttr = Xml.escapeAttribute;

interface Namespaces {
  /** namespace → prefix, for configured and generated prefixes. */
  readonly byNamespace: MutableHashMap.MutableHashMap<string, string>;
  /** Prefixes taken (configured, generated or reserved). */
  readonly used: MutableHashSet.MutableHashSet<string>;
  /** Namespaces actually referenced by the output. */
  readonly declared: MutableHashSet.MutableHashSet<string>;
  counter: number;
}

/** Whether `prefix` may be declared for `ns` as configured in `options.prefixes`. */
const isConfigurable = (prefix: string, ns: string): boolean =>
  Xml.isNCName(prefix) &&
  !prefix.toLowerCase().startsWith('xml') &&
  ns !== ITS &&
  Xml.isValidText(ns) &&
  (ns === RDF) === (prefix === 'rdf') &&
  prefix !== 'its';

/** The first of `name(1)`, `name(2)`, … (counting on from `from`) that `taken` does not hold. */
const freshName = (
  taken: MutableHashSet.MutableHashSet<string>,
  from: number,
  name: (n: number) => string,
): readonly [name: string, n: number] => {
  const candidate = name(from + 1);
  return MutableHashSet.has(taken, candidate)
    ? freshName(taken, from + 1, name)
    : [candidate, from + 1];
};

class Writer {
  readonly namespaces: Namespaces;
  readonly blankLabels = MutableHashMap.empty<string, string>();
  /** The QName of each IRI written so far, while no namespace has been added since. */
  private readonly qnames = MutableHashMap.empty<string, string>();
  needsVersion = false;
  needsIts = false;

  readonly options: SerializeOptions;
  constructor(options: SerializeOptions, prefixes: PrefixMap.PrefixMap) {
    this.options = options;
    const byNamespace = MutableHashMap.empty<string, string>();
    const used = MutableHashSet.empty<string>();
    PrefixMap.entries(prefixes).forEach(([prefix, ns]) => {
      if (
        isConfigurable(prefix, ns) &&
        !MutableHashMap.has(byNamespace, ns) &&
        !MutableHashSet.has(used, prefix)
      ) {
        MutableHashMap.set(byNamespace, ns, prefix);
        MutableHashSet.add(used, prefix);
      }
    });
    if (!MutableHashMap.has(byNamespace, RDF)) {
      MutableHashMap.set(byNamespace, RDF, 'rdf');
      MutableHashSet.add(used, 'rdf');
    }
    MutableHashSet.add(used, 'its');
    this.namespaces = { byNamespace, used, declared: MutableHashSet.make(RDF), counter: 0 };
  }

  fail(message: string): never {
    throw new SerializeFailure(message);
  }

  qname(iri: string, what: string): string {
    const known = MutableHashMap.get(this.qnames, iri);
    if (Option.isSome(known)) return known.value;
    const name = this.newQname(iri, what);
    MutableHashMap.set(this.qnames, iri, name);
    return name;
  }

  private newQname(iri: string, what: string): string {
    if (!Xml.isValidText(iri)) this.fail(`The ${what} <${iri}> contains invalid XML characters`);
    const { byNamespace, used, declared } = this.namespaces;
    // Prefer the longest configured namespace that leaves an NCName.
    const configured = Arr.reduce(
      Arr.fromIterable(MutableHashMap.keys(byNamespace)),
      Option.none<readonly [string, string]>(),
      (best, ns) =>
        iri.startsWith(ns) &&
        (Option.isNone(best) || ns.length > best.value[0].length) &&
        Xml.isNCName(iri.slice(ns.length))
          ? Option.some([ns, iri.slice(ns.length)] as const)
          : best,
    );
    const [ns, local] = Option.getOrElse(
      Option.orElse(configured, () => splitIri(iri)),
      () => this.fail(`The ${what} <${iri}> cannot be written as an XML QName`),
    );
    MutableHashSet.add(declared, ns);
    const prefix = Option.getOrElse(MutableHashMap.get(byNamespace, ns), () => {
      const [generated, n] = freshName(used, this.namespaces.counter, (i) => `ns${i}`);
      this.namespaces.counter = n;
      MutableHashSet.add(used, generated);
      MutableHashMap.set(byNamespace, ns, generated);
      // A new namespace may be a better choice for the IRIs already named
      MutableHashMap.clear(this.qnames);
      return generated;
    });
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
    const known = MutableHashMap.get(this.blankLabels, node.value);
    if (Option.isSome(known)) return known.value;
    const label =
      Xml.isNCName(node.value) && !MutableHashSet.has(this.usedLabels, node.value)
        ? node.value
        : this.freshLabel();
    MutableHashSet.add(this.usedLabels, label);
    MutableHashMap.set(this.blankLabels, node.value, label);
    return label;
  }

  private freshLabel(): string {
    // `b0`, `b1`, …: `freshName` counts on from the one before the next
    const [label, n] = freshName(this.usedLabels, this.labelCounter - 1, (i) => `b${i}`);
    this.labelCounter = n + 1;
    return label;
  }

  readonly usedLabels = MutableHashSet.empty<string>();
  labelCounter = 0;
}

/** A subject with the triples it is the subject of. */
interface Description {
  readonly subject: Term.Subject;
  readonly triples: Array<Term.Triple>;
}

interface Graph {
  readonly bySubject: MutableHashMap.MutableHashMap<string, Description>;
  readonly references: MutableHashMap.MutableHashMap<string, number>;
}

const text = (value: string, writer: Writer): string => {
  if (!Xml.isValidText(value)) writer.fail('A literal contains characters not allowed in XML 1.0');
  return Xml.escapeText(value);
};

const sortByPredicateObject = (ts: ReadonlyArray<Term.Triple>) =>
  Arr.sort(
    ts,
    Order.combine(
      Order.mapInput(Term.Order, (t: Term.Triple) => t.predicate),
      Order.mapInput(Term.Order, (t: Term.Triple) => t.object),
    ),
  );

/** Whether `t` gives its subject an `rdf:type` that can be the name of a typed node element. */
const isTypeTriple = (t: Term.Triple): t is Term.Triple & { readonly object: Term.NamedNode } =>
  t.predicate.value === RDF_TYPE &&
  Term.isNamedNode(t.object) &&
  !isForbiddenNodeElement(t.object.value) &&
  Option.isSome(splitIri(t.object.value));

const serializeGraph = (triples: ReadonlyArray<Term.Triple>, options: SerializeOptions): string => {
  const writer = new Writer(options, options.prefixes ?? PrefixMap.empty);
  const indentUnit = options.indent ?? '  ';
  const nest = options.nestBlankNodes ?? true;
  const typed = options.typedNodes ?? true;

  const graph: Graph = { bySubject: MutableHashMap.empty(), references: MutableHashMap.empty() };
  const referenceCount = (label: string): number => {
    const count = MutableHashMap.get(graph.references, label);
    return Option.isSome(count) ? count.value : 0;
  };
  const inTripleTerm = MutableHashSet.empty<string>();
  const markTripleTerm = (t: Term.Term): void => {
    if (Term.isBlankNode(t)) MutableHashSet.add(inTripleTerm, t.value);
    else if (Term.isTriple(t)) {
      markTripleTerm(t.subject);
      markTripleTerm(t.object);
    }
  };
  triples.forEach((t) => {
    if (Term.isTriple(t.subject)) {
      writer.fail('RDF/XML cannot represent triple terms in the subject position');
    }
    const subject = t.subject;
    const key = subject.key;
    const entry = MutableHashMap.get(graph.bySubject, key);
    if (Option.isSome(entry)) entry.value.triples.push(t);
    else MutableHashMap.set(graph.bySubject, key, { subject, triples: [t] });
    const o = t.object;
    if (Term.isBlankNode(o)) {
      MutableHashMap.set(graph.references, o.value, referenceCount(o.value) + 1);
    } else if (Term.isTriple(o)) {
      markTripleTerm(o);
    }
  });

  // Blank nodes that can be written inline, inside their only reference.
  const nested = MutableHashSet.empty<string>();
  if (nest) {
    MutableHashMap.forEach(graph.references, (count, label) => {
      if (count === 1 && !MutableHashSet.has(inTripleTerm, label)) {
        MutableHashSet.add(nested, label);
      }
    });
    // Break cycles: every nested node must be reachable from a top-level node.
    const reachable = MutableHashSet.empty<string>();
    const visit = (subjectKey: string): void => {
      const entry = MutableHashMap.get(graph.bySubject, subjectKey);
      if (Option.isNone(entry)) return;
      entry.value.triples.forEach((t) => {
        const o = t.object;
        if (
          Term.isBlankNode(o) &&
          MutableHashSet.has(nested, o.value) &&
          !MutableHashSet.has(reachable, o.value)
        ) {
          MutableHashSet.add(reachable, o.value);
          visit(o.key);
        }
      });
    };
    MutableHashMap.forEach(graph.bySubject, (entry, key) => {
      const s = entry.subject;
      if (!Term.isBlankNode(s) || !MutableHashSet.has(nested, s.value)) visit(key);
    });
    MutableHashMap.forEach(graph.bySubject, (entry) => {
      const s = entry.subject;
      if (
        Term.isBlankNode(s) &&
        MutableHashSet.has(nested, s.value) &&
        !MutableHashSet.has(reachable, s.value)
      ) {
        MutableHashSet.remove(nested, s.value);
        visit(s.key);
      }
    });
  }

  const body: Array<string> = [];

  /** Writes a node element for `subject` at `depth`. */
  const node = (subject: Term.Subject, depth: number, inline: boolean, lines: Array<string>) => {
    const pad = indentUnit.repeat(depth);
    const sorted = Option.match(MutableHashMap.get(graph.bySubject, subject.key), {
      onNone: (): ReadonlyArray<Term.Triple> => [],
      onSome: (entry) => sortByPredicateObject(entry.triples),
    });
    const typeTriple = typed
      ? Arr.findFirst(sorted, (t) =>
          isTypeTriple(t) && Xml.isValidText(t.object.value)
            ? Option.some([t, t.object.value] as const)
            : Option.none(),
        )
      : Option.none();
    const element = Option.match(typeTriple, {
      onNone: () => 'rdf:Description',
      onSome: ([, type]) => writer.qname(type, 'type'),
    });
    const ts = Option.match(typeTriple, {
      onNone: () => sorted,
      onSome: ([typeT]) => sorted.filter((t) => t !== typeT),
    });
    const attrs = Term.isNamedNode(subject)
      ? ` rdf:about="${writer.iriRef(subject.value)}"`
      : Term.isBlankNode(subject) &&
          !inline &&
          (referenceCount(subject.value) > 0 || MutableHashSet.has(inTripleTerm, subject.value))
        ? ` rdf:nodeID="${writer.blankLabel(subject)}"`
        : '';
    if (Arr.isReadonlyArrayEmpty(ts)) {
      lines.push(`${pad}<${element}${attrs}/>`);
      return;
    }
    lines.push(`${pad}<${element}${attrs}>`);
    ts.forEach((t) => property(t, depth + 1, lines));
    lines.push(`${pad}</${element}>`);
  };
  const property = (t: Term.Triple, depth: number, lines: Array<string>) => {
    const pad = indentUnit.repeat(depth);
    const p = t.predicate.value;
    if (isForbiddenPropertyElement(p) || p === RDF_LI) {
      writer.fail(`The predicate <${p}> cannot be used as an RDF/XML property element`);
    }
    const name = writer.qname(p, 'predicate');
    propertyObject(t.object, pad, name, depth, lines);
  };

  // Built once per serialisation, not per triple.
  const propertyObject = Match.fn(
    (o: Term.Object, _pad: string, _name: string, _depth: number, _lines: Array<string>) => o,
  ).pipe(
    Match.withReturnType<void>(),
    Match.tag('NamedNode', (o, _o, pad, name, _depth, lines) => {
      lines.push(`${pad}<${name} rdf:resource="${writer.iriRef(o.value)}"/>`);
    }),
    Match.tag('BlankNode', (o, _o, pad, name, depth, lines) => {
      if (MutableHashSet.has(nested, o.value) && !MutableHashSet.has(inTripleTerm, o.value)) {
        const described = Option.match(MutableHashMap.get(graph.bySubject, o.key), {
          onNone: (): ReadonlyArray<Term.Triple> => [],
          onSome: (entry) => entry.triples,
        });
        if (Arr.isReadonlyArrayEmpty(described)) {
          lines.push(`${pad}<${name} rdf:parseType="Resource"/>`);
          return;
        }
        if (!(typed && described.some(isTypeTriple))) {
          lines.push(`${pad}<${name} rdf:parseType="Resource">`);
          sortByPredicateObject(described).forEach((x) => property(x, depth + 1, lines));
          lines.push(`${pad}</${name}>`);
          return;
        }
        lines.push(`${pad}<${name}>`);
        node(o, depth + 1, true, lines);
        lines.push(`${pad}</${name}>`);
        return;
      }
      lines.push(`${pad}<${name} rdf:nodeID="${writer.blankLabel(o)}"/>`);
    }),
    Match.tag('Literal', (o, _o, pad, name, _depth, lines) => {
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
    }),
    Match.tag('Triple', (o, _o, pad, name, depth, lines) => {
      writer.needsVersion = true;
      lines.push(`${pad}<${name} rdf:parseType="Triple">`);
      tripleTerm(o, depth + 1, lines);
      lines.push(`${pad}</${name}>`);
    }),
    Match.exhaustive,
  );

  const tripleTerm = (t: Term.Triple, depth: number, lines: Array<string>) => {
    const pad = indentUnit.repeat(depth);
    const s = t.subject;
    const attrs = Term.isNamedNode(s)
      ? ` rdf:about="${writer.iriRef(s.value)}"`
      : Term.isBlankNode(s)
        ? ` rdf:nodeID="${writer.blankLabel(s)}"`
        : writer.fail('RDF/XML cannot represent triple terms in the subject position');
    lines.push(`${pad}<rdf:Description${attrs}>`);
    const o = t.object;
    if (Term.isBlankNode(o)) {
      const name = writer.qname(t.predicate.value, 'predicate');
      if (isForbiddenPropertyElement(t.predicate.value) || t.predicate.value === RDF_LI) {
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
    Arr.map(Arr.fromIterable(MutableHashMap.values(graph.bySubject)), (e) => e.subject),
    // Not `Term.Order`, which puts blank nodes first: IRI subjects come first here, so named
    // descriptions lead the document and unnested blank nodes follow.
    Order.make<Term.Term>((a, b) =>
      a._tag === b._tag ? Term.compare(a, b) : Term.isNamedNode(a) ? -1 : 1,
    ),
  );
  subjects.forEach((s) => {
    if (!Term.isBlankNode(s) || !MutableHashSet.has(nested, s.value)) node(s, 1, false, body);
  });

  const nsEntries = Arr.sort(
    Arr.filter(Arr.fromIterable(writer.namespaces.byNamespace), ([ns]) =>
      MutableHashSet.has(writer.namespaces.declared, ns),
    ),
    Order.make<readonly [string, string]>((a, b) =>
      a[1] === 'rdf' ? -1 : b[1] === 'rdf' ? 1 : a[1] < b[1] ? -1 : 1,
    ),
  );
  const decls: Array<string> = [
    ...nsEntries.map(([ns, prefix]) => `xmlns:${prefix}="${escapeAttr(ns)}"`),
    ...(writer.needsIts ? [`xmlns:its="${ITS}"`, 'its:version="2.0"'] : []),
    ...(options.baseIri === undefined ? [] : [`xml:base="${escapeAttr(options.baseIri)}"`]),
    ...(writer.needsVersion ? ['rdf:version="1.2"'] : []),
  ];
  const sep = `\n${' '.repeat('<rdf:RDF '.length)}`;
  const declaration =
    (options.xmlDeclaration ?? true) ? ['<?xml version="1.0" encoding="utf-8"?>'] : [];
  // Not `push(...body)`, which passes every line as an argument and overflows the stack
  const out = Arr.isReadonlyArrayEmpty(body)
    ? [...declaration, `<rdf:RDF ${decls.join(sep)}/>`]
    : [...declaration, `<rdf:RDF ${decls.join(sep)}>`, ...body, '</rdf:RDF>'];
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
    const all = Arr.fromIterable(quads);
    const named = Arr.findFirst(all, (q) => !Term.isDefaultGraph(q.graph));
    if (Option.isSome(named)) {
      return Effect.fail(
        new Serialization.RdfSerializeError({
          format: FORMAT_NAME,
          message: `RDF/XML cannot represent named graphs (found graph ${named.value.graph.key})`,
        }),
      );
    }
    const triples = all.map((q) => q.triple);
    return Effect.try({
      try: () => serializeGraph(triples, options ?? {}),
      catch: (e) => {
        if (e instanceof SerializeFailure) {
          return new Serialization.RdfSerializeError({ format: FORMAT_NAME, message: e.message });
        }
        throw e;
      },
    });
  }).pipe(Serialization.withSerializeSpan(trace));

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
