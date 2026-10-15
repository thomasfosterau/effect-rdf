import { describe, expect, it } from '@effect/vitest';
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
