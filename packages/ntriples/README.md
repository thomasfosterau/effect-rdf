# @thomasfosterau/effect-ntriples

RDF 1.2 [N-Triples](https://www.w3.org/TR/rdf12-n-triples/) and
[N-Quads](https://www.w3.org/TR/rdf12-n-quads/) for
[`@thomasfosterau/effect-rdf`](../core).

- Strict parsers: absolute IRIs only, validated escapes (no surrogates),
  language tags with base direction (`"x"@en--ltr`), triple terms
  `<<( s p o )>>`, `VERSION` directives, and the RDF 1.1 subset.
- Streaming: `parseStream` consumes a `Stream<string>` line by line (chunk
  boundaries may fall anywhere), so large files are never buffered.
- Canonical serializers (RDF 1.2 canonical escapes, lower-case language tags)
  with a true `serializeStream`.
- Passes the full W3C rdf11/rdf12 N-Triples and N-Quads suites (syntax and
  canonicalisation).

```ts
import { Effect, Stream } from 'effect';
import { NQuads, NTriples } from '@thomasfosterau/effect-ntriples';

const program = Effect.gen(function* () {
  const { dataset } = yield* NTriples.parse(
    '<http://example.org/s> <http://example.org/p> "chat"@en--ltr .\n',
  );
  const text = yield* NQuads.serialize(dataset, { sort: true });

  // Incremental parsing of a text stream
  const quads = yield* Stream.runCollect(
    NQuads.parseStream(Stream.make(text.slice(0, 10), text.slice(10))),
  );
  return quads;
});
```

Each module exports `format`, `parser`, `serializer`, `codec` (with a
`Schema` from `string` to `Dataset`), `parse`, `parseQuads` (document order),
`parseStream`, `serialize` and `serializeStream`. The `Lexical` module holds
the character classes, escape decoding, language-tag validation and canonical
term formatting shared with the Turtle package.
