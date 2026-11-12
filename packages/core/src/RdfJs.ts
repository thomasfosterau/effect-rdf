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
 * A structural RDF/JS named node.
 *
 * @since 0.1.0
 * @category models
 */
export interface RdfJsNamedNode {
  readonly termType: 'NamedNode';
  readonly value: string;
}

/**
 * A structural RDF/JS blank node.
 *
 * @since 0.1.0
 * @category models
 */
export interface RdfJsBlankNode {
  readonly termType: 'BlankNode';
  readonly value: string;
}

/**
 * A structural RDF/JS literal.
 *
 * @since 0.1.0
 * @category models
 */
export interface RdfJsLiteral {
  readonly termType: 'Literal';
  readonly value: string;
  readonly language: string;
  readonly direction?: 'ltr' | 'rtl' | '' | null | undefined;
  readonly datatype: RdfJsNamedNode;
}

/**
 * A structural RDF/JS variable.
 *
 * @since 0.1.0
 * @category models
 */
export interface RdfJsVariable {
  readonly termType: 'Variable';
  readonly value: string;
}

/**
 * The structural RDF/JS default graph.
 *
 * @since 0.1.0
 * @category models
 */
export interface RdfJsDefaultGraph {
  readonly termType: 'DefaultGraph';
  readonly value: '';
}

/**
 * A structural RDF/JS term.
 *
 * @since 0.1.0
 * @category models
 */
export type RdfJsTerm =
  | RdfJsNamedNode
  | RdfJsBlankNode
  | RdfJsLiteral
  | RdfJsVariable
  | RdfJsDefaultGraph
  | RdfJsQuad;

/**
 * An RDF/JS term allowed in the subject position of a quad.
 *
 * @since 0.1.0
 * @category models
 */
export type RdfJsSubject = RdfJsNamedNode | RdfJsBlankNode | RdfJsQuad;

/**
 * An RDF/JS term allowed in the object position of a quad.
 *
 * @since 0.1.0
 * @category models
 */
export type RdfJsObject = RdfJsNamedNode | RdfJsBlankNode | RdfJsLiteral | RdfJsQuad;

/**
 * An RDF/JS term allowed as a graph name.
 *
 * @since 0.1.0
 * @category models
 */
export type RdfJsGraph = RdfJsNamedNode | RdfJsBlankNode | RdfJsDefaultGraph;

/**
 * A structural RDF/JS quad (also used for quoted triples). Its positions are
 * the ones RDF allows, so variables cannot appear in a quad.
 *
 * @since 0.1.0
 * @category models
 */
export interface RdfJsQuad {
  readonly termType: 'Quad';
  readonly value: '';
  readonly subject: RdfJsSubject;
  readonly predicate: RdfJsNamedNode;
  readonly object: RdfJsObject;
  readonly graph: RdfJsGraph;
}

const fromNamedNode = (term: RdfJsNamedNode): Term.NamedNode => new Term.NamedNode(term.value);
const fromBlankNode = (term: RdfJsBlankNode): Term.BlankNode => new Term.BlankNode(term.value);
const fromLiteral = (term: RdfJsLiteral): Term.Literal =>
  term.language !== ''
    ? Term.literal(term.value, {
        language: term.language,
        direction:
          term.direction === 'ltr' || term.direction === 'rtl' ? term.direction : undefined,
      })
    : Term.literal(term.value, fromNamedNode(term.datatype));
const fromQuadTerm = (term: RdfJsQuad): Term.Triple =>
  new Term.Triple(
    fromSubjectMatch(term.subject),
    fromNamedNode(term.predicate),
    fromObjectMatch(term.object),
  );

// Built once: `fromTerm` runs for every term of every quad converted.
const fromSubjectMatch: (term: RdfJsSubject) => Term.Subject = Match.type<RdfJsSubject>().pipe(
  Match.withReturnType<Term.Subject>(),
  Match.when({ termType: 'NamedNode' }, fromNamedNode),
  Match.when({ termType: 'BlankNode' }, fromBlankNode),
  Match.when({ termType: 'Quad' }, (term) => fromQuadTerm(term)),
  Match.exhaustive,
);

const fromObjectMatch: (term: RdfJsObject) => Term.Object = Match.type<RdfJsObject>().pipe(
  Match.withReturnType<Term.Object>(),
  Match.when({ termType: 'NamedNode' }, fromNamedNode),
  Match.when({ termType: 'BlankNode' }, fromBlankNode),
  Match.when({ termType: 'Literal' }, fromLiteral),
  Match.when({ termType: 'Quad' }, (term) => fromQuadTerm(term)),
  Match.exhaustive,
);

const fromGraphMatch: (term: RdfJsGraph) => Term.Graph = Match.type<RdfJsGraph>().pipe(
  Match.withReturnType<Term.Graph>(),
  Match.when({ termType: 'NamedNode' }, fromNamedNode),
  Match.when({ termType: 'BlankNode' }, fromBlankNode),
  Match.when({ termType: 'DefaultGraph' }, () => Term.defaultGraph),
  Match.exhaustive,
);

const fromTermMatch: (term: RdfJsTerm) => Term.Term = Match.type<RdfJsTerm>().pipe(
  Match.withReturnType<Term.Term>(),
  Match.when({ termType: 'NamedNode' }, fromNamedNode),
  Match.when({ termType: 'BlankNode' }, fromBlankNode),
  Match.when({ termType: 'Literal' }, fromLiteral),
  Match.when({ termType: 'Variable' }, (term) => new Term.Variable(term.value)),
  Match.when({ termType: 'DefaultGraph' }, () => Term.defaultGraph),
  Match.when({ termType: 'Quad' }, (term) => fromQuadTerm(term)),
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
export const fromQuad = (quad: RdfJsQuad): Term.Quad =>
  new Term.Quad(
    fromSubjectMatch(quad.subject),
    fromNamedNode(quad.predicate),
    fromObjectMatch(quad.object),
    fromGraphMatch(quad.graph),
  );

const toNamedNode = (term: Term.NamedNode): RdfJsNamedNode => ({
  termType: 'NamedNode',
  value: term.value,
});
const toBlankNode = (term: Term.BlankNode): RdfJsBlankNode => ({
  termType: 'BlankNode',
  value: term.value,
});
const toDefaultGraph = (): RdfJsDefaultGraph => ({ termType: 'DefaultGraph', value: '' });
const toLiteral = (term: Term.Literal): RdfJsLiteral => ({
  termType: 'Literal',
  value: term.value,
  language: term.language,
  direction: term.direction ?? '',
  datatype: { termType: 'NamedNode', value: term.datatype.value },
});
const toQuadTerm = (term: Term.Triple): RdfJsQuad => ({
  termType: 'Quad',
  value: '',
  subject: toSubjectMatch(term.subject),
  predicate: toNamedNode(term.predicate),
  object: toObjectMatch(term.object),
  graph: toDefaultGraph(),
});

// Built once: `toTerm` runs for every term of every quad converted.
const toSubjectMatch: (term: Term.Subject) => RdfJsSubject = Match.type<Term.Subject>().pipe(
  Match.withReturnType<RdfJsSubject>(),
  Match.tag('NamedNode', toNamedNode),
  Match.tag('BlankNode', toBlankNode),
  Match.tag('Triple', (term) => toQuadTerm(term)),
  Match.exhaustive,
);

const toObjectMatch: (term: Term.Object) => RdfJsObject = Match.type<Term.Object>().pipe(
  Match.withReturnType<RdfJsObject>(),
  Match.tag('NamedNode', toNamedNode),
  Match.tag('BlankNode', toBlankNode),
  Match.tag('Literal', toLiteral),
  Match.tag('Triple', (term) => toQuadTerm(term)),
  Match.exhaustive,
);

const toGraphMatch: (term: Term.Graph) => RdfJsGraph = Match.type<Term.Graph>().pipe(
  Match.withReturnType<RdfJsGraph>(),
  Match.tag('NamedNode', toNamedNode),
  Match.tag('BlankNode', toBlankNode),
  Match.tag('DefaultGraph', toDefaultGraph),
  Match.exhaustive,
);

const toTermMatch: (term: Term.Term) => RdfJsTerm = Match.type<Term.Term>().pipe(
  Match.withReturnType<RdfJsTerm>(),
  Match.tag('NamedNode', toNamedNode),
  Match.tag('BlankNode', toBlankNode),
  Match.tag('Literal', toLiteral),
  Match.tag('Variable', (term) => ({ termType: 'Variable', value: term.value })),
  Match.tag('DefaultGraph', toDefaultGraph),
  Match.tag('Triple', (term) => toQuadTerm(term)),
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
  subject: toSubjectMatch(quad.subject),
  predicate: toNamedNode(quad.predicate),
  object: toObjectMatch(quad.object),
  graph: toGraphMatch(quad.graph),
});
