/**
 * Namespace utilities for RDF vocabularies.
 *
 * A `Namespace` is a function that maps a local name to a fully-qualified
 * `IRI`.  Pre-built namespaces are provided for the most common vocabularies:
 * `rdf`, `rdfs`, `owl`, `xsd`, `dcterms`, `foaf`, `skos`, and `schema`.
 *
 * @example
 * ```ts
 * import * as NS from "./Namespace.js"
 *
 * const personIRI = NS.schema("Person")
 * // IRI { value: "https://schema.org/Person" }
 *
 * const myNS = NS.namespace("https://example.org/vocab#")
 * const myTerm = myNS("myTerm")
 * // IRI { value: "https://example.org/vocab#myTerm" }
 * ```
 *
 * @since 0.1.0
 */
import { IRI, makeUnsafe } from "./IRI.js"

// ---------------------------------------------------------------------------
// Namespace factory
// ---------------------------------------------------------------------------

/**
 * A function that maps a local name to an `IRI` by appending it to a base URI.
 *
 * @since 0.1.0
 * @category models
 */
export type Namespace = (localName: string) => IRI

/**
 * Creates a `Namespace` from a base IRI string.
 *
 * @example
 * ```ts
 * const ex = namespace("https://example.org/")
 * ex("Alice") // IRI { value: "https://example.org/Alice" }
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const namespace = (base: string): Namespace =>
  (localName: string) => makeUnsafe(`${base}${localName}`)

// ---------------------------------------------------------------------------
// Common vocabularies
// ---------------------------------------------------------------------------

/**
 * RDF Core vocabulary — `http://www.w3.org/1999/02/22-rdf-syntax-ns#`
 *
 * Includes `rdf:type`, `rdf:langString`, `rdf:nil`, etc.
 *
 * @since 0.1.0
 */
export const rdf = namespace("http://www.w3.org/1999/02/22-rdf-syntax-ns#")

/**
 * Frequently-used RDF core IRIs.
 *
 * @since 0.1.0
 */
export const RDF = {
  type: rdf("type"),
  Property: rdf("Property"),
  Statement: rdf("Statement"),
  subject: rdf("subject"),
  predicate: rdf("predicate"),
  object: rdf("object"),
  Bag: rdf("Bag"),
  Seq: rdf("Seq"),
  Alt: rdf("Alt"),
  li: rdf("li"),
  nil: rdf("nil"),
  first: rdf("first"),
  rest: rdf("rest"),
  langString: rdf("langString"),
  HTML: rdf("HTML"),
  PlainLiteral: rdf("PlainLiteral")
} as const satisfies Record<string, IRI>

/**
 * RDFS vocabulary — `http://www.w3.org/2000/01/rdf-schema#`
 *
 * @since 0.1.0
 */
export const rdfs = namespace("http://www.w3.org/2000/01/rdf-schema#")

/**
 * Frequently-used RDFS IRIs.
 *
 * @since 0.1.0
 */
export const RDFS = {
  Resource: rdfs("Resource"),
  Class: rdfs("Class"),
  subClassOf: rdfs("subClassOf"),
  subPropertyOf: rdfs("subPropertyOf"),
  comment: rdfs("comment"),
  label: rdfs("label"),
  domain: rdfs("domain"),
  range: rdfs("range"),
  seeAlso: rdfs("seeAlso"),
  isDefinedBy: rdfs("isDefinedBy"),
  Literal: rdfs("Literal"),
  Container: rdfs("Container"),
  ContainerMembershipProperty: rdfs("ContainerMembershipProperty"),
  member: rdfs("member"),
  Datatype: rdfs("Datatype")
} as const satisfies Record<string, IRI>

/**
 * OWL vocabulary — `http://www.w3.org/2002/07/owl#`
 *
 * @since 0.1.0
 */
export const owl = namespace("http://www.w3.org/2002/07/owl#")

/**
 * Frequently-used OWL IRIs.
 *
 * @since 0.1.0
 */
export const OWL = {
  Class: owl("Class"),
  Individual: owl("Individual"),
  ObjectProperty: owl("ObjectProperty"),
  DatatypeProperty: owl("DatatypeProperty"),
  AnnotationProperty: owl("AnnotationProperty"),
  equivalentClass: owl("equivalentClass"),
  equivalentProperty: owl("equivalentProperty"),
  sameAs: owl("sameAs"),
  differentFrom: owl("differentFrom"),
  inverseOf: owl("inverseOf"),
  SymmetricProperty: owl("SymmetricProperty"),
  TransitiveProperty: owl("TransitiveProperty"),
  FunctionalProperty: owl("FunctionalProperty"),
  Thing: owl("Thing"),
  Nothing: owl("Nothing"),
  Ontology: owl("Ontology"),
  imports: owl("imports"),
  versionInfo: owl("versionInfo")
} as const satisfies Record<string, IRI>

/**
 * XML Schema Datatypes — `http://www.w3.org/2001/XMLSchema#`
 *
 * @since 0.1.0
 */
export const xsd = namespace("http://www.w3.org/2001/XMLSchema#")

/**
 * Frequently-used XSD datatype IRIs.
 *
 * @since 0.1.0
 */
export const XSD = {
  string: xsd("string"),
  boolean: xsd("boolean"),
  decimal: xsd("decimal"),
  integer: xsd("integer"),
  long: xsd("long"),
  int: xsd("int"),
  short: xsd("short"),
  byte: xsd("byte"),
  float: xsd("float"),
  double: xsd("double"),
  dateTime: xsd("dateTime"),
  date: xsd("date"),
  time: xsd("time"),
  duration: xsd("duration"),
  anyURI: xsd("anyURI"),
  base64Binary: xsd("base64Binary"),
  hexBinary: xsd("hexBinary"),
  normalizedString: xsd("normalizedString"),
  token: xsd("token"),
  language: xsd("language"),
  NMTOKEN: xsd("NMTOKEN"),
  Name: xsd("Name"),
  NCName: xsd("NCName"),
  nonNegativeInteger: xsd("nonNegativeInteger"),
  positiveInteger: xsd("positiveInteger"),
  nonPositiveInteger: xsd("nonPositiveInteger"),
  negativeInteger: xsd("negativeInteger"),
  unsignedByte: xsd("unsignedByte"),
  unsignedShort: xsd("unsignedShort"),
  unsignedInt: xsd("unsignedInt"),
  unsignedLong: xsd("unsignedLong")
} as const satisfies Record<string, IRI>

/**
 * Dublin Core Terms — `http://purl.org/dc/terms/`
 *
 * @since 0.1.0
 */
export const dcterms = namespace("http://purl.org/dc/terms/")

/**
 * Frequently-used DCTerms IRIs.
 *
 * @since 0.1.0
 */
export const DCTERMS = {
  title: dcterms("title"),
  description: dcterms("description"),
  creator: dcterms("creator"),
  contributor: dcterms("contributor"),
  subject: dcterms("subject"),
  date: dcterms("date"),
  created: dcterms("created"),
  modified: dcterms("modified"),
  identifier: dcterms("identifier"),
  language: dcterms("language"),
  publisher: dcterms("publisher"),
  rights: dcterms("rights"),
  license: dcterms("license"),
  source: dcterms("source"),
  format: dcterms("format"),
  type: dcterms("type"),
  relation: dcterms("relation"),
  isPartOf: dcterms("isPartOf"),
  hasPart: dcterms("hasPart")
} as const satisfies Record<string, IRI>

/**
 * FOAF (Friend of a Friend) vocabulary — `http://xmlns.com/foaf/0.1/`
 *
 * @since 0.1.0
 */
export const foaf = namespace("http://xmlns.com/foaf/0.1/")

/**
 * Frequently-used FOAF IRIs.
 *
 * @since 0.1.0
 */
export const FOAF = {
  Person: foaf("Person"),
  Agent: foaf("Agent"),
  Organization: foaf("Organization"),
  Group: foaf("Group"),
  Document: foaf("Document"),
  Image: foaf("Image"),
  name: foaf("name"),
  firstName: foaf("firstName"),
  lastName: foaf("lastName"),
  nick: foaf("nick"),
  mbox: foaf("mbox"),
  homepage: foaf("homepage"),
  depiction: foaf("depiction"),
  member: foaf("member"),
  knows: foaf("knows"),
  primaryTopic: foaf("primaryTopic"),
  topic: foaf("topic"),
  title: foaf("title")
} as const satisfies Record<string, IRI>

/**
 * SKOS (Simple Knowledge Organization System) — `http://www.w3.org/2004/02/skos/core#`
 *
 * @since 0.1.0
 */
export const skos = namespace("http://www.w3.org/2004/02/skos/core#")

/**
 * Frequently-used SKOS IRIs.
 *
 * @since 0.1.0
 */
export const SKOS = {
  Concept: skos("Concept"),
  ConceptScheme: skos("ConceptScheme"),
  Collection: skos("Collection"),
  prefLabel: skos("prefLabel"),
  altLabel: skos("altLabel"),
  hiddenLabel: skos("hiddenLabel"),
  broader: skos("broader"),
  narrower: skos("narrower"),
  related: skos("related"),
  inScheme: skos("inScheme"),
  hasTopConcept: skos("hasTopConcept"),
  topConceptOf: skos("topConceptOf"),
  definition: skos("definition"),
  scopeNote: skos("scopeNote"),
  example: skos("example"),
  notation: skos("notation"),
  note: skos("note"),
  exactMatch: skos("exactMatch"),
  closeMatch: skos("closeMatch"),
  broadMatch: skos("broadMatch"),
  narrowMatch: skos("narrowMatch"),
  relatedMatch: skos("relatedMatch")
} as const satisfies Record<string, IRI>

/**
 * Schema.org vocabulary — `https://schema.org/`
 *
 * @since 0.1.0
 */
export const schema = namespace("https://schema.org/")

/**
 * A selection of commonly-used Schema.org IRIs.
 *
 * @since 0.1.0
 */
export const SCHEMA = {
  Thing: schema("Thing"),
  Person: schema("Person"),
  Organization: schema("Organization"),
  Place: schema("Place"),
  Event: schema("Event"),
  CreativeWork: schema("CreativeWork"),
  Article: schema("Article"),
  Book: schema("Book"),
  Dataset: schema("Dataset"),
  name: schema("name"),
  description: schema("description"),
  url: schema("url"),
  image: schema("image"),
  identifier: schema("identifier"),
  sameAs: schema("sameAs"),
  author: schema("author"),
  creator: schema("creator"),
  dateCreated: schema("dateCreated"),
  dateModified: schema("dateModified"),
  datePublished: schema("datePublished"),
  knows: schema("knows"),
  member: schema("member"),
  memberOf: schema("memberOf")
} as const satisfies Record<string, IRI>
