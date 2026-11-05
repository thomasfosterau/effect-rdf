import { assert, describe, expect, it } from '@effect/vitest';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
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

  it('normalizes the dot segments of an absolute reference', () => {
    expect(Iri.resolve('http://x/a/./b/../c', base)).toBe('http://x/a/c');
    expect(Iri.resolve('g:./h', base)).toBe('g:h');
    expect(Iri.resolve('http://x/a/b?c=./..#.', base)).toBe('http://x/a/b?c=./..#.');
    expect(Iri.resolve('g:.', base)).toBe('g:');
    expect(Iri.resolve('HTTP+s.x-y://h/p', base)).toBe('HTTP+s.x-y://h/p');
    expect(Iri.resolve('1g:h', base)).toBe('http://a/b/c/1g:h');
    expect(Iri.resolve('g', base)).toBe('http://a/b/c/g');
  });

  it('resolves against alternating bases', () => {
    // Each call's base, not a remembered one, decides the result.
    expect(Iri.resolve('g', 'http://one/a/b')).toBe('http://one/a/g');
    expect(Iri.resolve('g', 'http://two/x/')).toBe('http://two/x/g');
    expect(Iri.resolve('g', 'http://one/a/b')).toBe('http://one/a/g');
    expect(Iri.resolve('?q', 'http://two/x/y?p')).toBe('http://two/x/y?q');
  });

  it.each(['', '/', '/a/b', 'a/b/', '/a..b/.c/d.', '/a/...'])(
    'leaves %j (no dot segments) unchanged',
    (path) => {
      expect(Iri.removeDotSegments(path)).toBe(path);
    },
  );

  it('removes dot segments', () => {
    expect(Iri.removeDotSegments('/a/b/../c/./d')).toBe('/a/c/d');
  });

  it('relativizes', () => {
    const b = 'http://example.org/a/b';
    [
      'http://example.org/a/c',
      'http://example.org/a/b#x',
      'http://example.org/z',
      'http://example.org/a/b?q',
    ].forEach((iri) => {
      const rel = Iri.relativize(iri, b);
      assert(Option.isSome(rel));
      expect(Iri.resolve(rel.value, b)).toBe(iri);
    });
    expect(Option.isNone(Iri.relativize('https://other/', b))).toBe(true);
  });

  it('validates', () => {
    expect(Iri.isValid('http://example.org/a b')).toBe(false);
    expect(Iri.isValid('http://example.org/ä?x#y')).toBe(true);
    expect(Iri.isValid('urn:isbn:123')).toBe(true);
    expect(Iri.isValid('relative')).toBe(false);
  });
});

describe('Iri schemas', () => {
  it('isValidReference accepts IRIs and relative references', () => {
    const valid = [
      'http://a/b',
      'g',
      './g',
      '../g?q#f',
      '//host/p',
      '/abs',
      '',
      '#frag',
      '?q',
      'a/b:c',
      'é/ü',
    ];
    const invalid = ['a:b c', 'g h', '1a:b', 'x<y', 'http://a/%zz'];
    expect(valid.filter((r) => !Iri.isValidReference(r))).toStrictEqual([]);
    expect(invalid.filter((r) => Iri.isValidReference(r))).toStrictEqual([]);
  });
  it('IriSchema accepts only absolute IRIs, with format iri', () => {
    const decode = Schema.decodeUnknownResult(Iri.IriSchema);
    expect(decode('http://example.org/a')._tag).toBe('Success');
    expect(decode('relative')._tag).toBe('Failure');
    expect(decode('http://exa mple.org/')._tag).toBe('Failure');
    expect(Schema.toJsonSchemaDocument(Iri.IriSchema).definitions['Iri']).toMatchObject({
      type: 'string',
      format: 'iri',
    });
  });
  it('IriReferenceSchema accepts relative references, with format iri-reference', () => {
    const decode = Schema.decodeUnknownResult(Iri.IriReferenceSchema);
    expect(decode('../a')._tag).toBe('Success');
    expect(decode('http://example.org/a')._tag).toBe('Success');
    expect(decode('a b')._tag).toBe('Failure');
    expect(
      Schema.toJsonSchemaDocument(Iri.IriReferenceSchema).definitions['IriReference'],
    ).toMatchObject({
      type: 'string',
      format: 'iri-reference',
    });
  });
});
