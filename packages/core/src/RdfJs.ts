/**
 * Conversions to and from the RDF/JS data model
 * (https://rdf.js.org/data-model-spec/), for interoperability with the wider
 * JavaScript RDF ecosystem. No RDF/JS packages are required: the interfaces
 * below are structural.
 *
 * @since 0.1.0
 */
import * as Match from 'effect/Match';
import * as Term from './Term.ts';

/**
 * A structural RDF/JS term.
 *
 * @since 0.1.0
 * @category models
 */
export type RdfJsTerm =
  | { readonly termType: 'NamedNode'; readonly value: string }
  | { readonly termType: 'BlankNode'; readonly value: string }
  | {
      readonly termType: 'Literal';
      readonly value: string;
      readonly language: string;
      readonly direction?: 'ltr' | 'rtl' | '' | null | undefined;
      readonly datatype: { readonly termType: 'NamedNode'; readonly value: string };
    }
  | { readonly termType: 'Variable'; readonly value: string }
  | { readonly termType: 'DefaultGraph'; readonly value: '' }
  | RdfJsQuad;

/**
 * A structural RDF/JS quad (also used for quoted triples).
 *
 * @since 0.1.0
 * @category models
 */
export interface RdfJsQuad {
  readonly termType: 'Quad';
  readonly value: '';
  readonly subject: RdfJsTerm;
  readonly predicate: RdfJsTerm;
  readonly object: RdfJsTerm;
  readonly graph: RdfJsTerm;
}

// Built once: `fromTerm` runs for every term of every quad converted.
const fromTermMatch: (term: RdfJsTerm) => Term.Term = Match.type<RdfJsTerm>().pipe(
  Match.withReturnType<Term.Term>(),
  Match.when({ termType: 'NamedNode' }, (term) => new Term.NamedNode(term.value)),
  Match.when({ termType: 'BlankNode' }, (term) => new Term.BlankNode(term.value)),
  Match.when({ termType: 'Literal' }, (term) =>
    term.language !== ''
      ? Term.literal(term.value, {
          language: term.language,
          direction:
            term.direction === 'ltr' || term.direction === 'rtl' ? term.direction : undefined,
        })
      : Term.literal(term.value, new Term.NamedNode(term.datatype.value)),
  ),
  Match.when({ termType: 'Variable' }, (term) => new Term.Variable(term.value)),
  Match.when({ termType: 'DefaultGraph' }, () => Term.defaultGraph),
  // SAFETY: an RDF/JS quad term's components are a subject, a predicate and an object.
  Match.when(
    { termType: 'Quad' },
    (term) =>
      new Term.Triple(
        fromTerm(term.subject) as Term.Subject,
        fromTerm(term.predicate) as Term.Predicate,
        fromTerm(term.object) as Term.Object,
      ),
  ),
  Match.exhaustive,
);

/**
 * Converts an RDF/JS term. Quads appearing as terms become triple terms.
 *
 * @since 0.1.0
 * @category conversions
 */
export const fromTerm = (term: RdfJsTerm): Term.Term => fromTermMatch(term);

/**
 * Converts an RDF/JS quad to a `Quad`.
 *
 * @since 0.1.0
 * @category conversions
 */
// SAFETY: an RDF/JS quad's components are a subject, a predicate, an object and a graph.
export const fromQuad = (quad: RdfJsQuad): Term.Quad =>
  new Term.Quad(
    fromTerm(quad.subject) as Term.Subject,
    fromTerm(quad.predicate) as Term.Predicate,
    fromTerm(quad.object) as Term.Object,
    fromTerm(quad.graph) as Term.Graph,
  );

// Built once: `toTerm` runs for every term of every quad converted.
const toTermMatch: (term: Term.Term) => RdfJsTerm = Match.type<Term.Term>().pipe(
  Match.withReturnType<RdfJsTerm>(),
  Match.tag('NamedNode', 'BlankNode', 'Variable', (term) => ({
    termType: term._tag,
    value: term.value,
  })),
  Match.tag('DefaultGraph', () => ({ termType: 'DefaultGraph', value: '' })),
  Match.tag('Literal', (term) => ({
    termType: 'Literal',
    value: term.value,
    language: term.language,
    direction: term.direction ?? '',
    datatype: { termType: 'NamedNode', value: term.datatype.value },
  })),
  Match.tag('Triple', (term) => ({
    termType: 'Quad',
    value: '',
    subject: toTerm(term.subject),
    predicate: toTerm(term.predicate),
    object: toTerm(term.object),
    graph: { termType: 'DefaultGraph', value: '' },
  })),
  Match.exhaustive,
);

/**
 * Converts a term to a plain RDF/JS term object.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toTerm = (term: Term.Term): RdfJsTerm => toTermMatch(term);

/**
 * Converts a quad to a plain RDF/JS quad object.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toQuad = (quad: Term.Quad): RdfJsQuad => ({
  termType: 'Quad',
  value: '',
  subject: toTerm(quad.subject),
  predicate: toTerm(quad.predicate),
  object: toTerm(quad.object),
  graph: toTerm(quad.graph),
});
