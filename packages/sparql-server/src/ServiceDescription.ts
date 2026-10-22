/**
 * SPARQL 1.1 Service Description: the RDF description of the endpoint
 * returned for a `GET` request without a query.
 *
 * @since 0.1.0
 */
import * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import * as Results from '@thomasfosterau/effect-sparql/Results';

/**
 * The service description namespace.
 *
 * @since 0.1.0
 * @category vocabulary
 */
export const SD = 'http://www.w3.org/ns/sparql-service-description#';

const RDF_TYPE = Term.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
const FORMATS = 'http://www.w3.org/ns/formats/';
const ENTAILMENT = 'http://www.w3.org/ns/entailment/';

/**
 * A table from media type to its `http://www.w3.org/ns/formats/` IRI.
 *
 * @since 0.1.0
 * @category vocabulary
 */
export interface FormatIris {
  readonly [mediaType: string]: string;
}

/**
 * The `http://www.w3.org/ns/formats/` IRIs of well-known media types.
 *
 * @since 0.1.0
 * @category vocabulary
 */
export const formatIris: FormatIris = {
  'text/turtle': `${FORMATS}Turtle`,
  'application/n-triples': `${FORMATS}N-Triples`,
  'application/rdf+xml': `${FORMATS}RDF_XML`,
  'application/ld+json': `${FORMATS}JSON-LD`,
  'text/n3': `${FORMATS}N3`,
  'application/trig': `${FORMATS}TriG`,
  'application/n-quads': `${FORMATS}N-Quads`,
  'application/rdf+json': `${FORMATS}RDF_JSON`,
  'application/sparql-results+json': `${FORMATS}SPARQL_Results_JSON`,
  'application/sparql-results+xml': `${FORMATS}SPARQL_Results_XML`,
  'text/csv': `${FORMATS}SPARQL_Results_CSV`,
  'text/tab-separated-values': `${FORMATS}SPARQL_Results_TSV`,
};

/**
 * What the description advertises.
 *
 * @since 0.1.0
 * @category models
 */
export interface DescriptionOptions {
  /** The query endpoint URL. */
  readonly endpoint: string;
  /** The update endpoint URL, when updates are enabled. */
  readonly updateEndpoint: string | undefined;
  readonly formats: Serialization.Formats['Service'];
  readonly unionDefaultGraph: boolean;
  readonly federation: boolean;
  /** Named graphs of the default dataset to list. */
  readonly namedGraphs: ReadonlyArray<Term.NamedNode | Term.BlankNode>;
}

/**
 * Builds the service description as triples.
 *
 * @since 0.1.0
 * @category constructors
 */
export const describe = (options: DescriptionOptions): ReadonlyArray<Term.Quad> => {
  const sd = (local: string) => Term.namedNode(`${SD}${local}`);
  const quads: Array<Term.Quad> = [];
  const add = (s: Term.Subject, p: Term.NamedNode, o: Term.Object) =>
    quads.push(Term.quad(s, p, o));
  const endpoints = [options.endpoint];
  if (options.updateEndpoint !== undefined && options.updateEndpoint !== options.endpoint) {
    endpoints.push(options.updateEndpoint);
  }
  for (const endpoint of endpoints) {
    const service = Term.blankNode();
    add(service, RDF_TYPE, sd('Service'));
    add(service, sd('endpoint'), Term.namedNode(endpoint));
    if (endpoint === options.endpoint) {
      add(service, sd('supportedLanguage'), sd('SPARQL10Query'));
      add(service, sd('supportedLanguage'), sd('SPARQL11Query'));
    }
    if (options.updateEndpoint === endpoint) {
      add(service, sd('supportedLanguage'), sd('SPARQL11Update'));
    }
    const resultFormats = new Set<string>();
    for (const codec of Results.codecs) resultFormats.add(codec.format.mediaType);
    for (const s of options.formats.serializers) resultFormats.add(s.format.mediaType);
    for (const mt of resultFormats) {
      const iri = formatIris[mt];
      if (iri !== undefined) add(service, sd('resultFormat'), Term.namedNode(iri));
    }
    for (const p of options.formats.parsers) {
      const iri = formatIris[p.format.mediaType];
      if (iri !== undefined) add(service, sd('inputFormat'), Term.namedNode(iri));
    }
    if (options.unionDefaultGraph) add(service, sd('feature'), sd('UnionDefaultGraph'));
    if (options.federation) add(service, sd('feature'), sd('BasicFederatedQuery'));
    add(service, sd('feature'), sd('EmptyGraphs'));
    add(service, sd('defaultEntailmentRegime'), Term.namedNode(`${ENTAILMENT}Simple`));
    const dataset = Term.blankNode();
    add(service, sd('defaultDataset'), dataset);
    add(dataset, RDF_TYPE, sd('Dataset'));
    const defaultGraph = Term.blankNode();
    add(dataset, sd('defaultGraph'), defaultGraph);
    add(defaultGraph, RDF_TYPE, sd('Graph'));
    for (const g of options.namedGraphs) {
      const named = Term.blankNode();
      add(dataset, sd('namedGraph'), named);
      add(named, RDF_TYPE, sd('NamedGraph'));
      add(named, sd('name'), g);
    }
  }
  return quads;
};
