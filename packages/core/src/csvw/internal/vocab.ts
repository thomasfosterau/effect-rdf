/**
 * The fixed CSVW JSON-LD context (`http://www.w3.org/ns/csvw`): its prefixes
 * (the RDFa 1.1 initial context plus `csvw`), its terms, prefixed-name
 * expansion and URL compaction (Metadata Vocabulary §URL Compaction).
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Record from 'effect/Record';

/** @internal */
export const CSVW = 'http://www.w3.org/ns/csvw#';
/** @internal */
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
/** @internal */
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
/** @internal */
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

/**
 * The prefixes of the CSVW context, which metadata MUST NOT override.
 *
 * @internal
 */
export const prefixes: Readonly<Record<string, string>> = {
  as: 'https://www.w3.org/ns/activitystreams#',
  cc: 'http://creativecommons.org/ns#',
  csvw: CSVW,
  ctag: 'http://commontag.org/ns#',
  dc: 'http://purl.org/dc/terms/',
  dc11: 'http://purl.org/dc/elements/1.1/',
  dcat: 'http://www.w3.org/ns/dcat#',
  dcterms: 'http://purl.org/dc/terms/',
  dctypes: 'http://purl.org/dc/dcmitype/',
  dqv: 'http://www.w3.org/ns/dqv#',
  duv: 'https://www.w3.org/TR/vocab-duv#',
  foaf: 'http://xmlns.com/foaf/0.1/',
  gr: 'http://purl.org/goodrelations/v1#',
  grddl: 'http://www.w3.org/2003/g/data-view#',
  ical: 'http://www.w3.org/2002/12/cal/icaltzd#',
  ldp: 'http://www.w3.org/ns/ldp#',
  ma: 'http://www.w3.org/ns/ma-ont#',
  oa: 'http://www.w3.org/ns/oa#',
  og: 'http://ogp.me/ns#',
  org: 'http://www.w3.org/ns/org#',
  owl: 'http://www.w3.org/2002/07/owl#',
  prov: 'http://www.w3.org/ns/prov#',
  qb: 'http://purl.org/linked-data/cube#',
  rdf: RDF,
  rdfa: 'http://www.w3.org/ns/rdfa#',
  rdfs: RDFS,
  rev: 'http://purl.org/stuff/rev#',
  rif: 'http://www.w3.org/2007/rif#',
  rr: 'http://www.w3.org/ns/r2rml#',
  schema: 'http://schema.org/',
  sd: 'http://www.w3.org/ns/sparql-service-description#',
  sioc: 'http://rdfs.org/sioc/ns#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  skosxl: 'http://www.w3.org/2008/05/skos-xl#',
  v: 'http://rdf.data-vocabulary.org/#',
  vcard: 'http://www.w3.org/2006/vcard/ns#',
  void: 'http://rdfs.org/ns/void#',
  wdr: 'http://www.w3.org/2007/05/powder#',
  wrds: 'http://www.w3.org/2007/05/powder-s#',
  xhv: 'http://www.w3.org/1999/xhtml/vocab#',
  xsd: XSD,
};

const xsdTerms = [
  'anyURI',
  'base64Binary',
  'boolean',
  'byte',
  'date',
  'dateTime',
  'dayTimeDuration',
  'dateTimeStamp',
  'decimal',
  'double',
  'duration',
  'float',
  'gDay',
  'gMonth',
  'gMonthDay',
  'gYear',
  'gYearMonth',
  'hexBinary',
  'int',
  'integer',
  'language',
  'long',
  'Name',
  'NCName',
  'NMTOKEN',
  'negativeInteger',
  'nonNegativeInteger',
  'nonPositiveInteger',
  'normalizedString',
  'positiveInteger',
  'QName',
  'short',
  'string',
  'time',
  'token',
  'unsignedByte',
  'unsignedInt',
  'unsignedLong',
  'unsignedShort',
  'yearMonthDuration',
] as const;

const csvwClasses = [
  'Cell',
  'Column',
  'Datatype',
  'Dialect',
  'Direction',
  'ForeignKey',
  'NumericFormat',
  'Row',
  'Schema',
  'Table',
  'TableGroup',
  'TableReference',
  'Transformation',
  'JSON',
  'uriTemplate',
] as const;

const csvwProperties: Readonly<Record<string, string>> = {
  aboutUrl: 'aboutUrl',
  base: 'base',
  columnReference: 'columnReference',
  columns: 'column',
  commentPrefix: 'commentPrefix',
  datatype: 'datatype',
  decimalChar: 'decimalChar',
  default: 'default',
  describes: 'describes',
  delimiter: 'delimiter',
  dialect: 'dialect',
  doubleQuote: 'doubleQuote',
  encoding: 'encoding',
  foreignKeys: 'foreignKey',
  format: 'format',
  groupChar: 'groupChar',
  header: 'header',
  headerRowCount: 'headerRowCount',
  lang: 'lang',
  length: 'length',
  lineTerminators: 'lineTerminators',
  maxExclusive: 'maxExclusive',
  maxInclusive: 'maxInclusive',
  maxLength: 'maxLength',
  minExclusive: 'minExclusive',
  minInclusive: 'minInclusive',
  minLength: 'minLength',
  name: 'name',
  notes: 'note',
  null: 'null',
  ordered: 'ordered',
  pattern: 'pattern',
  primaryKey: 'primaryKey',
  propertyUrl: 'propertyUrl',
  quoteChar: 'quoteChar',
  reference: 'reference',
  referencedRows: 'referencedRow',
  required: 'required',
  resource: 'resource',
  row: 'row',
  rowTitles: 'rowTitle',
  rownum: 'rownum',
  scriptFormat: 'scriptFormat',
  schemaReference: 'schemaReference',
  separator: 'separator',
  skipBlankRows: 'skipBlankRows',
  skipColumns: 'skipColumns',
  skipInitialSpace: 'skipInitialSpace',
  skipRows: 'skipRows',
  source: 'source',
  suppressOutput: 'suppressOutput',
  tables: 'table',
  tableDirection: 'tableDirection',
  tableSchema: 'tableSchema',
  targetFormat: 'targetFormat',
  transformations: 'transformations',
  textDirection: 'textDirection',
  titles: 'title',
  trim: 'trim',
  url: 'url',
  valueUrl: 'valueUrl',
  virtual: 'virtual',
};

/**
 * Every term of the CSVW context mapped to its absolute IRI.
 *
 * @internal
 */
export const terms: Readonly<Record<string, string>> = {
  ...Record.map(prefixes, (iri) => iri),
  xml: `${RDF}XMLLiteral`,
  html: `${RDF}HTML`,
  json: `${CSVW}JSON`,
  any: `${XSD}anyAtomicType`,
  anyAtomicType: `${XSD}anyAtomicType`,
  binary: `${XSD}base64Binary`,
  datetime: `${XSD}dateTime`,
  number: `${XSD}double`,
  describedby: 'http://www.w3.org/2007/05/powder-s#describedby',
  license: 'http://www.w3.org/1999/xhtml/vocab#license',
  role: 'http://www.w3.org/1999/xhtml/vocab#role',
  maximum: `${CSVW}maxInclusive`,
  minimum: `${CSVW}minInclusive`,
  ...Record.fromEntries(Arr.map(xsdTerms, (t) => [t, `${XSD}${t}`] as const)),
  ...Record.fromEntries(Arr.map(csvwClasses, (t) => [t, `${CSVW}${t}`] as const)),
  ...Record.map(csvwProperties, (local) => `${CSVW}${local}`),
};

const PREFIXED = /^([A-Za-z][\w.-]*):(.*)$/;

/**
 * The expansion of `value` if it is a prefixed name with a CSVW prefix.
 *
 * @internal
 */
export const expandPrefixed = (value: string): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(PREFIXED.exec(value)), (m) =>
    Option.map(Record.get(prefixes, m[1] ?? ''), (ns) => ns + (m[2] ?? '')),
  );

/**
 * Expands a term or prefixed name of the CSVW context; anything else is
 * returned unchanged.
 *
 * @internal
 */
export const expand = (value: string): string =>
  Option.getOrElse(Record.get(terms, value), () =>
    Option.getOrElse(expandPrefixed(value), () => value),
  );

/**
 * Whether `value` is an absolute URL (has a scheme).
 *
 * @internal
 */
export const isAbsoluteUrl = (value: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);

// Longest namespace first; `dc` and `dcterms` share one, and `dc` wins.
const compactable: ReadonlyArray<readonly [string, string]> = Arr.sort(
  Arr.filter(Record.toEntries(prefixes), ([prefix]) => prefix !== 'dcterms'),
  Order.mapInput(Order.Number, ([, ns]: readonly [string, string]) => -ns.length),
);

const termOf: Readonly<Record<string, string>> = Record.fromEntries(
  Arr.map(
    Arr.filter(Record.toEntries(terms), ([term]) => !Record.has(prefixes, term)),
    ([term, iri]) => [iri, term] as const,
  ),
);

/**
 * URL compaction (Metadata Vocabulary §URL Compaction): an absolute URL to a
 * term or prefixed name of the CSVW context; `rdf:type` becomes `@type`.
 *
 * @internal
 */
export const compact = (url: string): string =>
  url === `${RDF}type`
    ? '@type'
    : Option.getOrElse(Record.get(termOf, url), () =>
        Option.getOrElse(
          Option.map(
            Arr.findFirst(compactable, ([, ns]) => url.startsWith(ns) && url.length > ns.length),
            ([prefix, ns]) => `${prefix}:${url.slice(ns.length)}`,
          ),
          () => url,
        ),
      );
