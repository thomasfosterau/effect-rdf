import { describe, expect, it } from '@effect/vitest';
import * as Arr from 'effect/Array';
import * as Graph from 'effect/Graph';
import * as HashMap from 'effect/HashMap';
import * as Option from 'effect/Option';
import { Dataset, Isomorphism, Namespace, Term, Vocab } from '../src/index.ts';

const ex = Namespace.make('http://example.org/');
const foaf = Namespace.make('http://xmlns.com/foaf/0.1/');
const { rdfs } = Vocab;

const index = (g: Dataset.TermGraph, term: Term.Subject | Term.Object): Graph.NodeIndex =>
  Option.getOrElse(HashMap.get(g.nodes, term), () => -1);
const termAt = (g: Dataset.TermGraph, i: Graph.NodeIndex): string =>
  Option.match(Graph.getNode(g.graph, i), { onNone: () => '', onSome: (t) => t.key });

describe('Dataset.toGraph', () => {
  const hierarchy = Dataset.make(
    Term.quad(ex('Cat'), rdfs.subClassOf, ex('Mammal')),
    Term.quad(ex('Dog'), rdfs.subClassOf, ex('Mammal')),
    Term.quad(ex('Mammal'), rdfs.subClassOf, ex('Animal')),
    Term.quad(ex('Cat'), rdfs.label, Term.literal('cat')),
    Term.quad(ex('felix'), foaf('knows'), ex('rex')),
  );

  it('orders a subclass hierarchy topologically', () => {
    const g = Dataset.toGraph(hierarchy, { predicates: [rdfs.subClassOf] });
    expect(Graph.nodeCount(g.graph)).toBe(4);
    expect(Graph.isAcyclic(g.graph)).toBe(true);
    const order = Arr.map(Arr.fromIterable(Graph.indices(Graph.topo()(g.graph))), (i) =>
      termAt(g, i),
    );
    // Every class comes before its superclasses.
    const position = (local: string) => order.indexOf(ex(local).key);
    expect(position('Cat')).toBeLessThan(position('Mammal'));
    expect(position('Dog')).toBeLessThan(position('Mammal'));
    expect(position('Mammal')).toBeLessThan(position('Animal'));
  });

  it('detects cycles', () => {
    const cyclic = Dataset.make(
      Term.quad(ex('A'), rdfs.subClassOf, ex('B')),
      Term.quad(ex('B'), rdfs.subClassOf, ex('C')),
      Term.quad(ex('C'), rdfs.subClassOf, ex('A')),
    );
    const g = Dataset.toGraph(cyclic);
    expect(Graph.isAcyclic(g.graph)).toBe(false);
    expect(Option.isSome(Graph.findCycle(g.graph))).toBe(true);
  });

  it('finds the shortest path over foaf:knows', () => {
    const people = Dataset.make(
      Term.quad(ex('a'), foaf('knows'), ex('b')),
      Term.quad(ex('b'), foaf('knows'), ex('c')),
      Term.quad(ex('c'), foaf('knows'), ex('d')),
      Term.quad(ex('a'), foaf('knows'), ex('e')),
      Term.quad(ex('e'), foaf('knows'), ex('d')),
      Term.quad(ex('a'), ex('worksWith'), ex('d')),
    );
    const g = Dataset.toGraph(people, { predicates: [foaf('knows')] });
    const path = Graph.dijkstra({
      source: index(g, ex('a')),
      target: index(g, ex('d')),
      cost: () => 1,
    })(g.graph);
    expect(Option.map(path, (p) => p.path.map((i) => termAt(g, i)))).toStrictEqual(
      Option.some([ex('a').key, ex('e').key, ex('d').key]),
    );
  });

  it('leaves literals out unless asked, and can restrict to one graph', () => {
    expect(Graph.nodeCount(Dataset.toGraph(hierarchy).graph)).toBe(6);
    const withLiterals = Dataset.toGraph(hierarchy, { literals: true });
    expect(Graph.nodeCount(withLiterals.graph)).toBe(7);
    expect(Graph.edgeCount(withLiterals.graph)).toBe(5);
    const named = Dataset.make(
      Term.quad(ex('s'), ex('p'), ex('o'), ex('g1')),
      Term.quad(ex('s'), ex('p'), ex('x'), ex('g2')),
    );
    expect(Graph.edgeCount(Dataset.toGraph(named, { graph: ex('g1') }).graph)).toBe(1);
    expect(Graph.edgeCount(Dataset.toGraph(named).graph)).toBe(2);
  });

  it('round-trips through fromGraph', () => {
    const g = Dataset.toGraph(hierarchy, { literals: true });
    expect(Isomorphism.isomorphic(Dataset.fromGraph(g.graph), hierarchy)).toBe(true);
    const inGraph = Dataset.fromGraph(g.graph, ex('g'));
    expect(Dataset.graphs(inGraph).map((t) => t.key)).toStrictEqual([ex('g').key]);
  });
});
