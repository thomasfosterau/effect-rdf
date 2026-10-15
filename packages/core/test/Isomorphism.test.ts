import { describe, expect, it } from '@effect/vitest';
import { Dataset, Isomorphism, Term } from '../src/index.ts';

const p = Term.namedNode('http://example.org/p');
const b = Term.blankNode;

describe('Isomorphism', () => {
  it('detects isomorphic graphs with renamed blank nodes', () => {
    const x = Dataset.make(
      Term.quad(b('a'), p, b('b')),
      Term.quad(b('b'), p, b('a')),
      Term.quad(b('a'), p, Term.literal('1')),
    );
    const y = Dataset.make(
      Term.quad(b('y'), p, b('x')),
      Term.quad(b('x'), p, b('y')),
      Term.quad(b('x'), p, Term.literal('1')),
    );
    expect(Isomorphism.isomorphic(x, y)).toBe(true);
  });

  it('rejects non-isomorphic graphs', () => {
    // a 6-cycle vs two 3-cycles: indistinguishable by naive refinement
    const cycle = (labels: ReadonlyArray<string>) =>
      labels.map((l, i) => Term.quad(b(l), p, b(labels[(i + 1) % labels.length]!)));
    const six = Dataset.fromIterable(cycle(['1', '2', '3', '4', '5', '6']));
    const threes = Dataset.fromIterable([...cycle(['a', 'b', 'c']), ...cycle(['d', 'e', 'f'])]);
    expect(Isomorphism.isomorphic(six, threes)).toBe(false);
    expect(
      Isomorphism.isomorphic(six, Dataset.fromIterable(cycle(['f', 'e', 'd', 'c', 'b', 'a']))),
    ).toBe(true);
  });

  it('handles blank nodes inside triple terms', () => {
    const x = Dataset.make(Term.quad(b('r'), p, Term.triple(b('s'), p, Term.literal('o'))));
    const y = Dataset.make(Term.quad(b('q'), p, Term.triple(b('t'), p, Term.literal('o'))));
    const z = Dataset.make(Term.quad(b('q'), p, Term.triple(b('q'), p, Term.literal('o'))));
    expect(Isomorphism.isomorphic(x, y)).toBe(true);
    expect(Isomorphism.isomorphic(x, z)).toBe(false);
  });

  it('relabels deterministically', () => {
    const x = Dataset.make(Term.quad(b('a'), p, Term.literal('1')));
    const y = Dataset.make(Term.quad(b('zz'), p, Term.literal('1')));
    expect(Dataset.toNQuads(Isomorphism.relabel(x))).toBe(Dataset.toNQuads(Isomorphism.relabel(y)));
  });
});
