import { describe, expect, it } from '@effect/vitest';
import * as Equal from 'effect/Equal';
import * as Option from 'effect/Option';
import { Dataset, Namespace, Term, Vocab } from '../src/index.ts';

const ex = Namespace.make('http://example.org/');
const { rdf } = Vocab;

describe('Dataset', () => {
  const a = Term.quad(ex('a'), ex('p'), ex('b'));
  const b = Term.quad(ex('a'), ex('q'), Term.literal('x'), ex('g'));
  const c = Term.quad(ex('c'), ex('p'), ex('b'));

  it('adds, removes and deduplicates', () => {
    const ds = Dataset.make(a, b, a);
    expect(ds.size).toBe(2);
    expect(Dataset.has(ds, b)).toBe(true);
    const removed = Dataset.remove(ds, b);
    expect(removed.size).toBe(1);
    expect(ds.size).toBe(2);
    expect(Dataset.has(removed, b)).toBe(false);
  });

  it('matches patterns using indexes', () => {
    const ds = Dataset.make(a, b, c);
    expect(Dataset.match(ds, { subject: ex('a') })).toHaveLength(2);
    expect(Dataset.match(ds, { predicate: ex('p'), object: ex('b') })).toHaveLength(2);
    expect(Dataset.match(ds, { graph: ex('g') })).toEqual([b]);
    expect(Dataset.match(ds, { graph: Term.defaultGraph })).toHaveLength(2);
    expect(Dataset.match(ds, { subject: Term.variable('s'), predicate: ex('q') })).toEqual([b]);
    expect(Dataset.match(ds, { subject: ex('zzz') })).toEqual([]);
  });

  it('has value equality', () => {
    expect(Equal.equals(Dataset.make(a, b), Dataset.make(b, a))).toBe(true);
    expect(Equal.equals(Dataset.make(a, b), Dataset.make(a))).toBe(false);
  });

  it('set operations', () => {
    const x = Dataset.make(a, b);
    const y = Dataset.make(b, c);
    expect(Dataset.union(x, y).size).toBe(3);
    expect(Dataset.toArray(Dataset.intersection(x, y))).toEqual([b]);
    expect(Dataset.toArray(Dataset.difference(x, y))).toEqual([a]);
  });

  it('reads RDF lists', () => {
    const l1 = Term.blankNode('l1');
    const l2 = Term.blankNode('l2');
    const ds = Dataset.make(
      Term.quad(l1, rdf.first, Term.literal('1')),
      Term.quad(l1, rdf.rest, l2),
      Term.quad(l2, rdf.first, Term.literal('2')),
      Term.quad(l2, rdf.rest, rdf.nil),
    );
    expect(Option.getOrThrow(Dataset.list(ds, l1)).map((t) => t.key)).toEqual(['"1"', '"2"']);
    expect(Dataset.toNQuads(ds).split('\n')).toHaveLength(5);
  });

  it('distinct terms', () => {
    const ds = Dataset.make(a, b, c);
    expect(Dataset.subjects(ds)).toHaveLength(2);
    expect(Dataset.graphs(ds)).toHaveLength(2);
    expect(Dataset.objectsOf(ds, ex('a'), ex('p'))).toEqual([ex('b')]);
  });
});
