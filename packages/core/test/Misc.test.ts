import { describe, expect, it } from '@effect/vitest';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Schema from 'effect/Schema';
import {
  Dataset,
  Namespace,
  PrefixMap,
  RdfJs,
  Rdfs,
  Reification,
  Serialization,
  Term,
  Vocab,
} from '../src/index.ts';

const ex = Namespace.make('http://example.org/');
const { rdf, rdfs } = Vocab;

describe('Namespace', () => {
  it('builds typed vocabularies', () => {
    const foaf = Namespace.vocabulary('http://xmlns.com/foaf/0.1/', ['name', 'knows']);
    const name: Term.NamedNode<'http://xmlns.com/foaf/0.1/name'> = foaf.name;
    expect(name.value).toBe('http://xmlns.com/foaf/0.1/name');
    expect(foaf.localName(foaf.knows)).toBe('knows');
    expect(ex('x')).toBe(ex('x'));
  });
});

describe('PrefixMap', () => {
  it('expands and compacts', () => {
    const pm = PrefixMap.set(PrefixMap.common, 'ex', 'http://example.org/');
    expect(Option.map(PrefixMap.expand(pm, 'ex:a'), (t) => t.value)).toEqual(
      Option.some('http://example.org/a'),
    );
    expect(PrefixMap.compact(pm, rdf.type)).toEqual(Option.some(['rdf', 'type']));
    expect(Option.isNone(PrefixMap.compact(pm, 'http://example.org/a/b'))).toBe(true);
  });
});

describe('Rdfs', () => {
  it('computes the RDFS closure', () => {
    const ds = Dataset.make(
      Term.quad(ex('Dog'), rdfs.subClassOf, ex('Mammal')),
      Term.quad(ex('Mammal'), rdfs.subClassOf, ex('Animal')),
      Term.quad(ex('hasOwner'), rdfs.domain, ex('Pet')),
      Term.quad(ex('hasOwner'), rdfs.subPropertyOf, ex('related')),
      Term.quad(ex('rex'), rdf.type, ex('Dog')),
      Term.quad(ex('rex'), ex('hasOwner'), ex('alice')),
    );
    const closed = Rdfs.closure(ds);
    expect(Dataset.has(closed, Term.quad(ex('rex'), rdf.type, ex('Animal')))).toBe(true);
    expect(Dataset.has(closed, Term.quad(ex('rex'), rdf.type, ex('Pet')))).toBe(true);
    expect(Dataset.has(closed, Term.quad(ex('rex'), ex('related'), ex('alice')))).toBe(true);
    expect(Dataset.has(closed, Term.quad(ex('Dog'), rdfs.subClassOf, ex('Animal')))).toBe(true);
    expect(Rdfs.isInstanceOf(ds, ex('rex'), ex('Animal'))).toBe(true);
    expect(Rdfs.instancesOf(ds, ex('Mammal'))).toEqual([ex('rex')]);
  });
});

describe('Reification', () => {
  it('annotates and reads annotations', () => {
    const t = Term.triple(ex('s'), ex('p'), ex('o'));
    const ds = Dataset.fromIterable(Reification.annotate(t, [[ex('source'), ex('doc')]]));
    expect(Reification.annotations(ds, t)).toEqual([[ex('source'), ex('doc')]]);
    const classic = Reification.toStandardReification(ds);
    expect(Dataset.some(classic, (q) => q.object._tag === 'Triple')).toBe(false);
    expect(Dataset.count(classic, { predicate: rdf.subject })).toBe(1);
  });
});

describe('RdfJs', () => {
  it('round-trips', () => {
    const q = Term.quad(
      ex('s'),
      ex('p'),
      Term.triple(ex('a'), ex('b'), Term.literal('c', 'en')),
      ex('g'),
    );
    expect(RdfJs.fromQuad(RdfJs.toQuad(q)).key).toBe(q.key);
  });
});

describe('Serialization', () => {
  it('negotiates media types', () => {
    const available = ['text/turtle', 'application/n-triples', 'application/ld+json'];
    expect(Serialization.negotiate('application/ld+json;q=0.5, text/turtle', available)).toEqual(
      Option.some('text/turtle'),
    );
    expect(Serialization.negotiate('application/*', available)).toEqual(
      Option.some('application/n-triples'),
    );
    expect(Serialization.negotiate('image/png', available)).toEqual(Option.none());
    expect(Serialization.negotiate(undefined, available)).toEqual(Option.some('text/turtle'));
  });

  it.effect('builds schemas from parsers and serializers', () =>
    Effect.gen(function* () {
      const format = Serialization.makeFormat({
        name: 'Lines',
        mediaType: 'text/x-lines',
        extensions: ['lines'],
        datasets: false,
      });
      const parser = Serialization.makeParser({
        format,
        parse: (input) =>
          input.includes('!')
            ? Effect.fail(
                new Serialization.RdfParseError({ format: 'Lines', message: 'bang', line: 1 }),
              )
            : Effect.succeed({
                dataset: Dataset.fromIterable(
                  input
                    .split('\n')
                    .filter((l) => l !== '')
                    .map((l) => Term.quad(ex(l), rdf.type, ex('Line'))),
                ),
                prefixes: PrefixMap.empty,
                baseIri: undefined,
              }),
      });
      const serializer = Serialization.makeSerializer({
        format,
        serialize: (quads) =>
          Effect.succeed(
            Array.from(quads, (q) => (q.subject as Term.NamedNode).value.slice(19)).join('\n'),
          ),
      });
      const codec = Serialization.makeCodec(parser, serializer);
      const ds = yield* Schema.decodeEffect(codec.schema)('a\nb');
      expect(ds.size).toBe(2);
      expect(
        Arr.sort((yield* Schema.encodeEffect(codec.schema)(ds)).split('\n'), Order.String),
      ).toEqual(['a', 'b']);
      const failure = yield* Effect.flip(Schema.decodeEffect(codec.schema)('a!'));
      expect(String(failure)).toContain('bang');
    }),
  );
});
