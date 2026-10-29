/**
 * RDF 1.2 / RDF-star reification helpers.
 *
 * RDF 1.2 relates a *reifier* to a triple term with `rdf:reifies`; the
 * Turtle annotation syntax `:s :p :o {| :source :x |}` is shorthand for
 * asserting `:s :p :o` and `_:r rdf:reifies <<( :s :p :o )>> . _:r :source :x`.
 *
 * This module provides helpers for building and reading such reifications,
 * and for converting triple terms to and from classic RDF reification
 * (`rdf:Statement`) for consumers that do not support triple terms.
 *
 * @since 0.1.0
 */
import * as Dataset from './Dataset.ts';
import * as Term from './Term.ts';
import { rdf } from './Vocab.ts';

/**
 * Builds the quads for an annotated (asserted and reified) triple.
 *
 * @since 0.1.0
 * @category constructors
 */
export const annotate = (
  triple: Term.Triple,
  annotations: ReadonlyArray<readonly [Term.Predicate, Term.Object]>,
  options: { readonly reifier?: Term.Resource; readonly graph?: Term.Graph } = {},
): ReadonlyArray<Term.Quad> => {
  const graph = options.graph ?? Term.defaultGraph;
  const reifier = options.reifier ?? Term.blankNode();
  return [
    new Term.Quad(triple.subject, triple.predicate, triple.object, graph),
    new Term.Quad(reifier, rdf.reifies, triple, graph),
    ...annotations.map(([p, o]) => new Term.Quad(reifier, p, o, graph)),
  ];
};

/**
 * The reifiers of a triple term in a dataset.
 *
 * @since 0.1.0
 * @category queries
 */
export const reifiers = (
  self: Dataset.Dataset,
  triple: Term.Triple,
  graph?: Term.Graph,
): ReadonlyArray<Term.Subject> => Dataset.subjectsOf(self, rdf.reifies, triple, graph);

/**
 * The annotations (predicate/object pairs on all reifiers) of a triple.
 *
 * @since 0.1.0
 * @category queries
 */
export const annotations = (
  self: Dataset.Dataset,
  triple: Term.Triple,
  graph?: Term.Graph,
): ReadonlyArray<readonly [Term.Predicate, Term.Object]> =>
  reifiers(self, triple, graph).flatMap((r) =>
    Dataset.match(self, { subject: r, graph })
      .filter((q) => q.predicate.value !== rdf.reifies.value)
      .map((q) => [q.predicate, q.object] as const),
  );

/**
 * Replaces every triple term with a blank node described using classic RDF
 * reification (`rdf:Statement`, `rdf:subject`, `rdf:predicate`,
 * `rdf:object`). Nested triple terms are converted recursively.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toStandardReification = (self: Dataset.Dataset): Dataset.Dataset => {
  const nodes = new Map<string, Term.BlankNode>();
  const extra: Array<Term.Quad> = [];
  const convert = <T extends Term.Term>(t: T, graph: Term.Graph): T | Term.BlankNode => {
    if (t._tag !== 'Triple') return t;
    const existing = nodes.get(t.key + graph.key);
    if (existing !== undefined) return existing;
    const node = Term.blankNode();
    nodes.set(t.key + graph.key, node);
    // SAFETY: conversion maps a subject to a subject and an object to an object.
    extra.push(
      new Term.Quad(node, rdf.type, rdf.Statement, graph),
      new Term.Quad(node, rdf.subject, convert(t.subject, graph) as Term.Subject, graph),
      new Term.Quad(node, rdf.predicate, t.predicate, graph),
      new Term.Quad(node, rdf.object, convert(t.object, graph) as Term.Object, graph),
    );
    return node;
  };
  // SAFETY: conversion maps a subject to a subject and an object to an object.
  const converted = Dataset.map(
    self,
    (q) =>
      new Term.Quad(
        convert(q.subject, q.graph) as Term.Subject,
        q.predicate,
        convert(q.object, q.graph) as Term.Object,
        q.graph,
      ),
  );
  return Dataset.addAll(converted, extra);
};
