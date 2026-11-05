import { describe, expect, it } from '@effect/vitest';
import * as Arr from 'effect/Array';
import * as Equal from 'effect/Equal';
import * as HashSet from 'effect/HashSet';
import { Term } from '../src/index.ts';

describe('Term', () => {
  it('equality and hashing', () => {
    const a = Term.namedNode('http://example.org/a');
    expect(Equal.equals(a, Term.namedNode('http://example.org/a'))).toBe(true);
    expect(HashSet.size(HashSet.make(a, Term.namedNode('http://example.org/a')))).toBe(1);
    expect(a.key).toBe('<http://example.org/a>');
  });
  it('literals', () => {
    expect(Term.literal('a"b\n').key).toBe('"a\\"b\\n"');
    expect(Term.literal('hi', 'EN').key).toBe('"hi"@en');
    // RDF 1.2 canonical N-Triples escapes U+FFFE and U+FFFF
    expect(Term.literal('\u0000\b\u007f￾￿').key).toBe('"\\u0000\\b\\u007F\\uFFFE\\uFFFF"');
    expect(Term.literal('hi', { language: 'ar', direction: 'rtl' }).key).toBe('"hi"@ar--rtl');
  });
  it('triple terms', () => {
    const t = Term.triple(Term.namedNode('s'), Term.namedNode('p'), Term.literal('o'));
    expect(t.key).toBe('<<( <s> <p> "o" )>>');
    const q = Term.quad(Term.blankNode('x'), Term.namedNode('p'), t, Term.namedNode('g'));
    expect(q.toString()).toBe('_:x <p> <<( <s> <p> "o" )>> <g> .');
  });
});

describe('Term instances', () => {
  const terms = [
    Term.variable('v'),
    Term.triple(Term.namedNode('s'), Term.namedNode('p'), Term.literal('o')),
    Term.literal('a', 'en'),
    Term.namedNode('b'),
    Term.namedNode('a'),
    Term.blankNode('x'),
    Term.defaultGraph,
  ];
  it('Order agrees with compare on every pair', () => {
    const disagreements = Arr.flatMap(terms, (a) =>
      Arr.filter(terms, (b) => Term.Order(a, b) !== Term.compare(a, b)),
    );
    expect(disagreements).toStrictEqual([]);
    expect(Arr.sort(terms, Term.Order)[0]).toBe(Term.defaultGraph);
  });
  it('QuadOrder sorts by graph, then subject, predicate and object', () => {
    const p = Term.namedNode('p');
    const quads = [
      Term.quad(Term.namedNode('b'), p, Term.literal('1')),
      Term.quad(Term.namedNode('a'), p, Term.literal('2'), Term.namedNode('g')),
      Term.quad(Term.namedNode('a'), p, Term.literal('1')),
    ];
    expect(Arr.sort(quads, Term.QuadOrder).map((q) => q.key)).toStrictEqual([
      '<a> <p> "1"',
      '<b> <p> "1"',
      '<a> <p> "2" <g>',
    ]);
  });
  it('Equivalence agrees with Equal', () => {
    expect(Term.Equivalence(Term.literal('a', 'EN'), Term.literal('a', 'en'))).toBe(true);
    expect(Term.Equivalence(Term.literal('a'), Term.namedNode('a'))).toBe(false);
    const q = Term.quad(Term.namedNode('s'), Term.namedNode('p'), Term.literal('o'));
    expect(
      Term.QuadEquivalence(
        q,
        Term.quad(Term.namedNode('s'), Term.namedNode('p'), Term.literal('o')),
      ),
    ).toBe(true);
    expect(
      Term.QuadEquivalence(q, Term.quad(q.subject, q.predicate, q.object, Term.namedNode('g'))),
    ).toBe(false);
    expect(Arr.dedupeWith(terms.concat(terms), Term.Equivalence)).toHaveLength(terms.length);
  });
});
