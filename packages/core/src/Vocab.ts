/**
 * Standard vocabularies: RDF, RDFS, XSD and OWL.
 *
 * @since 0.1.0
 */
import * as Namespace from './Namespace.ts';

/**
 * The RDF 1.2 vocabulary.
 *
 * @since 0.1.0
 * @category vocabularies
 */
export const rdf = Namespace.vocabulary('http://www.w3.org/1999/02/22-rdf-syntax-ns#', [
  'type',
  'Property',
  'Statement',
  'subject',
  'predicate',
  'object',
  'reifies',
  'Bag',
  'Seq',
  'Alt',
  'value',
  'List',
  'first',
  'rest',
  'nil',
  'XMLLiteral',
  'HTML',
  'JSON',
  'langString',
  'dirLangString',
  'CompoundLiteral',
  'language',
  'direction',
  'PlainLiteral',
]);

/**
 * The RDF Schema vocabulary.
 *
 * @since 0.1.0
 * @category vocabularies
 */
export const rdfs = Namespace.vocabulary('http://www.w3.org/2000/01/rdf-schema#', [
  'Resource',
  'Class',
  'subClassOf',
  'subPropertyOf',
  'comment',
  'label',
  'domain',
  'range',
  'seeAlso',
  'isDefinedBy',
  'Literal',
  'Container',
  'ContainerMembershipProperty',
  'member',
  'Datatype',
]);

/**
 * The XML Schema datatypes used by RDF.
 *
 * @since 0.1.0
 * @category vocabularies
 */
export const xsd = Namespace.vocabulary('http://www.w3.org/2001/XMLSchema#', [
  'string',
  'boolean',
  'decimal',
  'integer',
  'double',
  'float',
  'date',
  'time',
  'dateTime',
  'dateTimeStamp',
  'gYear',
  'gMonth',
  'gDay',
  'gYearMonth',
  'gMonthDay',
  'duration',
  'yearMonthDuration',
  'dayTimeDuration',
  'byte',
  'short',
  'int',
  'long',
  'unsignedByte',
  'unsignedShort',
  'unsignedInt',
  'unsignedLong',
  'positiveInteger',
  'nonNegativeInteger',
  'negativeInteger',
  'nonPositiveInteger',
  'hexBinary',
  'base64Binary',
  'anyURI',
  'language',
  'normalizedString',
  'token',
  'NMTOKEN',
  'Name',
  'NCName',
]);

/**
 * The OWL 2 vocabulary (commonly used terms).
 *
 * @since 0.1.0
 * @category vocabularies
 */
export const owl = Namespace.vocabulary('http://www.w3.org/2002/07/owl#', [
  'Class',
  'Thing',
  'Nothing',
  'Ontology',
  'ObjectProperty',
  'DatatypeProperty',
  'AnnotationProperty',
  'FunctionalProperty',
  'InverseFunctionalProperty',
  'TransitiveProperty',
  'SymmetricProperty',
  'equivalentClass',
  'equivalentProperty',
  'sameAs',
  'differentFrom',
  'inverseOf',
  'imports',
  'versionIRI',
  'Restriction',
  'onProperty',
  'someValuesFrom',
  'allValuesFrom',
  'hasValue',
  'unionOf',
  'intersectionOf',
  'complementOf',
  'oneOf',
  'NamedIndividual',
]);

/**
 * Well-known prefixes, suitable for seeding a `PrefixMap`.
 *
 * @since 0.1.0
 * @category prefixes
 */
export const commonPrefixes = {
  rdf: rdf.base,
  rdfs: rdfs.base,
  xsd: xsd.base,
  owl: owl.base,
} as const;
