import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { describe, expect, it, layer } from '@effect/vitest';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Order from 'effect/Order';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import { DocumentLoader, JsonLd, JsonLdError } from '../../src/jsonld/index.ts';
import { parseJsonText, toJsonText } from './support.ts';

const ex = (s: string) => Term.namedNode(`http://example.org/${s}`);

const doc = {
  '@context': { '@vocab': 'http://example.org/', knows: { '@type': '@id' } },
  '@id': 'http://example.org/alice',
  name: 'Alice',
  knows: 'http://example.org/bob',
};

const isJsonArray = (v: JsonLd.JsonValue): v is JsonLd.JsonArray => Array.isArray(v);
// How many `knows` objects are embedded below `node` (-1 when it is not an object).
const depth = (node: JsonLd.JsonValue): number => {
  if (
    node === null ||
    Predicate.isString(node) ||
    Predicate.isNumber(node) ||
    Predicate.isBoolean(node) ||
    isJsonArray(node)
  ) {
    return -1;
  }
  return 1 + depth(node['knows'] ?? null);
};

describe('JsonLd', () => {
  it.effect('expands a document', () =>
    Effect.gen(function* () {
      const expanded = yield* JsonLd.expand(doc);
      expect(expanded).toEqual([
        {
          '@id': 'http://example.org/alice',
          'http://example.org/name': [{ '@value': 'Alice' }],
          'http://example.org/knows': [{ '@id': 'http://example.org/bob' }],
        },
      ]);
    }),
  );

  it.effect('compacts with a context', () =>
    Effect.gen(function* () {
      const compacted = yield* JsonLd.compact(doc, { ex: 'http://example.org/' });
      expect(compacted).toEqual({
        '@context': { ex: 'http://example.org/' },
        '@id': 'ex:alice',
        'ex:name': 'Alice',
        'ex:knows': { '@id': 'ex:bob' },
      });
    }),
  );

  it.effect('flattens nested nodes', () =>
    Effect.gen(function* () {
      const flattened = yield* JsonLd.flatten(
        {
          '@context': { '@vocab': 'http://example.org/' },
          '@id': 'http://example.org/a',
          child: { name: 'nested' },
        },
        undefined,
        { ordered: true },
      );
      expect(flattened).toEqual([
        { '@id': '_:b0', 'http://example.org/name': [{ '@value': 'nested' }] },
        { '@id': 'http://example.org/a', 'http://example.org/child': [{ '@id': '_:b0' }] },
      ]);
    }),
  );

  it.effect('frames a document', () =>
    Effect.gen(function* () {
      const framed = yield* JsonLd.frame(
        {
          '@context': { '@vocab': 'http://example.org/' },
          '@graph': [
            {
              '@id': 'http://example.org/lib',
              '@type': 'Library',
              contains: { '@id': 'http://example.org/book' },
            },
            { '@id': 'http://example.org/book', '@type': 'Book', title: 'T' },
          ],
        },
        { '@context': { '@vocab': 'http://example.org/' }, '@type': 'Library' },
      );
      expect(framed).toEqual({
        '@context': { '@vocab': 'http://example.org/' },
        '@id': 'http://example.org/lib',
        '@type': 'Library',
        contains: { '@id': 'http://example.org/book', '@type': 'Book', title: 'T' },
      });
    }),
  );

  // #108: framing a long chain overflowed the stack with a `RangeError`.
  describe('deep structures', () => {
    const vocab = { '@vocab': 'http://example.org/' };
    const chain = (n: number) => ({
      '@context': vocab,
      '@graph': Arr.makeBy(n, (i) => ({
        '@id': `http://example.org/n${i}`,
        knows: i + 1 < n ? { '@id': `http://example.org/n${i + 1}` } : 'end',
      })),
    });

    it.effect('frames a 256-level chain with the default @embed', () =>
      Effect.gen(function* () {
        const framed = yield* JsonLd.frame(chain(256), {
          '@context': vocab,
          '@id': 'http://example.org/n0',
        });
        expect(depth(framed)).toBe(255);
      }),
    );

    it.effect('fails a 20k-node chain with a typed error, not a stack overflow', () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          JsonLd.frame(chain(20_000), { '@context': vocab, '@id': 'http://example.org/n0' }),
        );
        expect(error.code).toBe('maximum nesting exceeded');
      }),
    );

    it.effect('frames a 20k-node chain without embedding (@embed @never)', () =>
      Effect.gen(function* () {
        const framed = yield* JsonLd.frame(chain(20_000), {
          '@context': vocab,
          '@embed': '@never',
        });
        expect(framed['@graph']).toHaveLength(20_000);
      }),
    );

    it.effect('fails deeply nested input with a typed error in every algorithm', () =>
      Effect.gen(function* () {
        const nested = Arr.makeBy(100_000, () => 0).reduce<object>(
          (inner) => ({ 'http://example.org/p': inner }),
          { '@value': 'leaf' },
        );
        const error = yield* Effect.flip(JsonLd.expand(nested));
        expect(error.code).toBe('maximum nesting exceeded');
      }),
    );
  });

  it.effect('converts to and from RDF', () =>
    Effect.gen(function* () {
      const dataset = yield* JsonLd.toRdf(doc);
      expect(Dataset.toNQuads(dataset)).toBe(
        [
          '<http://example.org/alice> <http://example.org/knows> <http://example.org/bob> .',
          '<http://example.org/alice> <http://example.org/name> "Alice" .',
          '',
        ].join('\n'),
      );
      const back = yield* JsonLd.fromRdf(dataset);
      expect(back).toContainEqual({
        '@id': 'http://example.org/alice',
        'http://example.org/knows': [{ '@id': 'http://example.org/bob' }],
        'http://example.org/name': [{ '@value': 'Alice' }],
      });
    }),
  );

  it.effect('supports rdfDirection and @json literals', () =>
    Effect.gen(function* () {
      const quads = yield* JsonLd.toQuads(
        {
          'http://example.org/label': { '@value': 'abc', '@language': 'ar', '@direction': 'rtl' },
          'http://example.org/data': { '@value': { b: 1, a: [true] }, '@type': '@json' },
        },
        { rdfDirection: 'i18n-datatype' },
      );
      const objects = Arr.sort(
        quads.map((q) => q.object.key),
        Order.String,
      );
      expect(objects).toEqual([
        '"abc"^^<https://www.w3.org/ns/i18n#ar_rtl>',
        '"{\\"a\\":[true],\\"b\\":1}"^^<http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON>',
      ]);
    }),
  );

  it.effect('fails with tagged JSON-LD errors', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(JsonLd.expand({ '@id': 42 }));
      expect(error._tag).toBe('JsonLdError');
      expect(error.code).toBe('invalid @id value');
      expect(JsonLdError.isJsonLdError(error)).toBe(true);
    }),
  );

  it.effect('fails to load remote contexts without a loader', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        JsonLd.expand({ '@context': 'http://example.org/ctx', name: 'x' }),
      );
      expect(error.code).toBe('loading remote context failed');
    }),
  );
});

describe('DocumentLoader', () => {
  const contexts = DocumentLoader.layerStatic({
    'http://example.org/ctx': { '@context': { name: 'http://schema.org/name' } },
    'http://example.org/doc': '{"@context": "ctx", "name": "Remote"}',
  });

  layer(contexts)((test) => {
    test.effect('resolves remote contexts and documents from a static map', () =>
      Effect.gen(function* () {
        const expanded = yield* JsonLd.expand('http://example.org/doc');
        expect(expanded).toEqual([{ 'http://schema.org/name': [{ '@value': 'Remote' }] }]);
      }),
    );

    test.effect('reports missing documents', () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(JsonLd.expand('http://example.org/missing'));
        expect(error.code).toBe('loading document failed');
      }),
    );
  });

  it('parses Link headers', () => {
    expect(
      DocumentLoader.parseLinkHeader(
        '<ctx.jsonld>; rel="http://www.w3.org/ns/json-ld#context", <alt>; rel=alternate; type="application/ld+json"',
      ),
    ).toEqual([
      { target: 'ctx.jsonld', params: { rel: 'http://www.w3.org/ns/json-ld#context' } },
      { target: 'alt', params: { rel: 'alternate', type: 'application/ld+json' } },
    ]);
  });

  it.effect('applies context Link headers to JSON documents', () =>
    Effect.gen(function* () {
      const result = yield* DocumentLoader.fromResponse({
        url: 'http://example.org/data.json',
        contentType: 'application/json',
        link: '<ctx>; rel="http://www.w3.org/ns/json-ld#context"',
        body: '{}',
      });
      expect(result).toEqual({
        _tag: 'Document',
        document: {
          documentUrl: 'http://example.org/data.json',
          document: {},
          contentType: 'application/json',
          contextUrl: 'http://example.org/ctx',
          profile: undefined,
        },
      });
    }),
  );

  it.effect('extracts JSON-LD from HTML', () =>
    Effect.gen(function* () {
      const result = yield* DocumentLoader.fromResponse({
        url: 'http://example.org/page',
        contentType: 'text/html',
        body: '<html><script type="application/ld+json">{"@id": "x"}</script></html>',
      });
      expect(Predicate.isTagged(result, 'Document') && result.document.document).toEqual({
        '@id': 'x',
      });
    }),
  );

  const requested: Array<string> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requested.push(request.url);
      const body = request.url.endsWith('/ctx')
        ? '{"@context": {"name": "http://schema.org/name"}}'
        : '{"@context": "/ctx", "name": "Over HTTP"}';
      return HttpClientResponse.fromWeb(
        request,
        new Response(body, { headers: { 'content-type': 'application/ld+json' } }),
      );
    }),
  );
  const httpLoader = DocumentLoader.layerHttp.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );

  layer(httpLoader)((test) => {
    test.effect('loads documents over HttpClient', () =>
      Effect.gen(function* () {
        const expanded = yield* JsonLd.expand('http://example.org/doc');
        expect(expanded).toEqual([{ 'http://schema.org/name': [{ '@value': 'Over HTTP' }] }]);
        // documents are cached by the HTTP loader
        yield* JsonLd.expand('http://example.org/doc');
        expect(requested).toEqual(['http://example.org/doc', 'http://example.org/ctx']);
      }),
    );
  });
});

describe('codec', () => {
  it.effect('parses JSON-LD text into a dataset', () =>
    Effect.gen(function* () {
      const result = yield* JsonLd.parse(toJsonText(doc), { blankNodePrefix: 'x' });
      expect(result.dataset.size).toBe(2);
      expect(Dataset.has(result.dataset, Term.quad(ex('alice'), ex('knows'), ex('bob')))).toBe(
        true,
      );
    }),
  );

  it.effect('reports JSON syntax errors with a position', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(JsonLd.parse('{\n  "a": }'));
      expect(error._tag).toBe('RdfParseError');
      expect(error.line).toBe(2);
    }),
  );

  it.effect('serializes compacted JSON-LD using prefixes', () =>
    Effect.gen(function* () {
      const text = yield* JsonLd.serialize(
        [Term.quad(ex('alice'), ex('name'), Term.literal('Alice'))],
        { prefixes: PrefixMap.make({ ex: 'http://example.org/' }), indent: 0 },
      );
      expect(parseJsonText(text)).toEqual({
        '@context': { ex: 'http://example.org/' },
        '@id': 'ex:alice',
        'ex:name': 'Alice',
      });
    }),
  );

  it.effect('round-trips through the codec schema', () =>
    Effect.gen(function* () {
      const dataset = Dataset.make(Term.quad(ex('s'), ex('p'), Term.literal('o', 'en')));
      const text = yield* Schema.encodeEffect(JsonLd.codec.schema)(dataset);
      const decoded = yield* Schema.decodeEffect(JsonLd.codec.schema)(text);
      expect(Dataset.toNQuads(decoded)).toBe(Dataset.toNQuads(dataset));
      expect(JsonLd.format.mediaType).toBe('application/ld+json');
      expect(JsonLd.format.extensions).toEqual(['jsonld']);
    }),
  );
});
