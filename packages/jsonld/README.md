# @thomasfosterau/effect-jsonld

A self-contained, Effect-idiomatic [JSON-LD 1.1](https://www.w3.org/TR/json-ld11-api/) processor
for [`@thomasfosterau/effect-rdf`](../core): context processing, expansion, compaction,
flattening, [framing](https://www.w3.org/TR/json-ld11-framing/), conversion to and from RDF, and a
`Serialization.Codec` for `application/ld+json`.

It passes the W3C JSON-LD 1.1 test suites for expand, compact, flatten, toRdf, fromRdf,
remote-doc and framing. The only tests it skips are JSON-LD 1.0-only tests and the ones that need
generalized RDF.

## Usage

```ts
import { Effect } from 'effect';
import { DocumentLoader, JsonLd } from '@thomasfosterau/effect-jsonld';

const doc = {
  '@context': { '@vocab': 'http://schema.org/', knows: { '@type': '@id' } },
  '@id': 'http://example.org/alice',
  name: 'Alice',
  knows: 'http://example.org/bob',
};

const program = Effect.gen(function* () {
  const expanded = yield* JsonLd.expand(doc);
  const compacted = yield* JsonLd.compact(doc, { schema: 'http://schema.org/' });
  const flattened = yield* JsonLd.flatten(doc);
  const framed = yield* JsonLd.frame(doc, { '@context': doc['@context'], name: {} });
  const dataset = yield* JsonLd.toRdf(doc, { rdfDirection: 'i18n-datatype' });
  const json = yield* JsonLd.fromRdf(dataset, { useNativeTypes: true });
});
```

Every algorithm returns an `Effect` that fails with a `JsonLdError`. The error's `code` is one of
the JSON-LD error codes, such as `"invalid @id value"` or `"loading remote context failed"`.

## Remote documents and contexts

Remote contexts and documents (a string input is treated as a URL) are loaded through the
`DocumentLoader` service:

```ts
import { FetchHttpClient } from 'effect/http';

// Over HTTP. This follows the JSON-LD content-type and Link-header rules, extracts JSON-LD from
// HTML, and caches documents.
const live = DocumentLoader.layerHttp.pipe(Layer.provide(FetchHttpClient.layer));

// From memory, useful for tests and for pinning well-known contexts.
const pinned = DocumentLoader.layerStatic({
  'https://schema.org/': { '@context': { '@vocab': 'https://schema.org/' } },
});

JsonLd.expand('https://example.org/data.jsonld').pipe(Effect.provide(live));
```

Without a `DocumentLoader` in the environment, any remote reference fails with
`loading document failed` or `loading remote context failed`. You can also pass a loader for a
single call with `options.documentLoader`. `DocumentLoader.fromFetch` builds a loader from any
function that returns raw responses.

## Codec

`JsonLd.codec` implements `Serialization.Codec` for the `application/ld+json` media type and the
`.jsonld` extension.

- **Parsing** runs toRdf.
- **Serialising** runs fromRdf. When you pass a `context` option, or `prefixes` (which become term
  definitions), the result is then compacted.

```ts
const roundTrip = (text: string) =>
  Effect.gen(function* () {
    const { dataset } = yield* JsonLd.parse(text, { baseIri: 'http://example.org/' });
    return yield* JsonLd.serialize(dataset, {
      prefixes: PrefixMap.make({ ex: 'http://example.org/' }),
    });
  });
```

## Notes

- Generalized RDF, where a blank node is used as a predicate, cannot be represented by the core
  term model, so `produceGeneralizedRdf` has no effect.
- When `rdfDirection` is not set, `@direction` is dropped and the value becomes a plain
  language-tagged literal. `fromRdf` turns RDF 1.2 directional language-tagged literals into
  `@direction`.
