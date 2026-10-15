import { describe, expect, it } from '@effect/vitest';
import * as Option from 'effect/Option';
import { Iri } from '../src/index.ts';

// RFC 3986 §5.4 reference resolution examples.
const base = 'http://a/b/c/d;p?q';
const examples: ReadonlyArray<readonly [string, string]> = [
  ['g:h', 'g:h'],
  ['g', 'http://a/b/c/g'],
  ['./g', 'http://a/b/c/g'],
  ['g/', 'http://a/b/c/g/'],
  ['/g', 'http://a/g'],
  ['//g', 'http://g'],
  ['?y', 'http://a/b/c/d;p?y'],
  ['g?y', 'http://a/b/c/g?y'],
  ['#s', 'http://a/b/c/d;p?q#s'],
  ['g#s', 'http://a/b/c/g#s'],
  [';x', 'http://a/b/c/;x'],
  ['', 'http://a/b/c/d;p?q'],
  ['.', 'http://a/b/c/'],
  ['./', 'http://a/b/c/'],
  ['..', 'http://a/b/'],
  ['../', 'http://a/b/'],
  ['../g', 'http://a/b/g'],
  ['../..', 'http://a/'],
  ['../../g', 'http://a/g'],
  ['../../../g', 'http://a/g'],
  ['/./g', 'http://a/g'],
  ['/../g', 'http://a/g'],
  ['g.', 'http://a/b/c/g.'],
  ['.g', 'http://a/b/c/.g'],
  ['g..', 'http://a/b/c/g..'],
  ['..g', 'http://a/b/c/..g'],
  ['./../g', 'http://a/b/g'],
  ['./g/.', 'http://a/b/c/g/'],
  ['g/./h', 'http://a/b/c/g/h'],
  ['g/../h', 'http://a/b/c/h'],
  ['g;x=1/./y', 'http://a/b/c/g;x=1/y'],
  ['g;x=1/../y', 'http://a/b/c/y'],
];

describe('Iri', () => {
  it.each(examples)('resolves %s', (ref, expected) => {
    expect(Iri.resolve(ref, base)).toBe(expected);
  });

  it('relativizes', () => {
    const b = 'http://example.org/a/b';
    for (const iri of [
      'http://example.org/a/c',
      'http://example.org/a/b#x',
      'http://example.org/z',
      'http://example.org/a/b?q',
    ]) {
      const rel = Iri.relativize(iri, b);
      expect(Option.isSome(rel)).toBe(true);
      expect(Iri.resolve(Option.getOrThrow(rel), b)).toBe(iri);
    }
    expect(Option.isNone(Iri.relativize('https://other/', b))).toBe(true);
  });

  it('validates', () => {
    expect(Iri.isValid('http://example.org/a b')).toBe(false);
    expect(Iri.isValid('http://example.org/ä?x#y')).toBe(true);
    expect(Iri.isValid('urn:isbn:123')).toBe(true);
    expect(Iri.isValid('relative')).toBe(false);
  });
});
