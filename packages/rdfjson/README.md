# @thomasfosterau/effect-rdf-rdfjson

[RDF/JSON](https://www.w3.org/TR/rdf-json/) (`application/rdf+json`) for
[`@thomasfosterau/effect-rdf`](../core), built on Effect `Schema`.

## Schemas

| Schema                                   | Type                                     |
| ---------------------------------------- | ---------------------------------------- |
| `RdfJson.Document` / `StrictDocument`    | `Document` (validates the JSON shape)    |
| `RdfJson.ObjectValue`, `LiteralValue`, … | individual value objects                 |
| `RdfJson.RdfJsonFromString`              | `string ⇄ Document`                      |
| `RdfJson.DatasetFromRdfJson`             | `Document ⇄ Dataset`                     |
| `RdfJson.DatasetFromString`              | `string ⇄ Dataset` (also `codec.schema`) |
| `RdfJson.makeDatasetSchema(options)`     | `Document ⇄ Dataset` with options        |

```ts
import { Effect, Schema } from 'effect';
import { RdfJson } from '@thomasfosterau/effect-rdf-rdfjson';

const program = Effect.gen(function* () {
  const dataset = yield* Schema.decodeEffect(RdfJson.DatasetFromString)(`{
    "http://example.org/about": {
      "http://purl.org/dc/terms/title": [
        { "type": "literal", "value": "Anna's Homepage", "lang": "en" }
      ]
    }
  }`);
  const text = yield* Schema.encodeEffect(RdfJson.DatasetFromString)(dataset);
});
```

Invalid documents fail with precise messages, e.g.
`Expected an RDF/JSON value ("type" must be "uri", "bnode", "literal" or "triple") at ["s"]["p"][0]`.

## Parser and serializer

`RdfJson.parse(text, options?)` / `RdfJson.serialize(quads, options?)` implement the core
`Serialization` interfaces (`parser`, `serializer`, `codec`, `format`). Parse errors are
`RdfParseError`s (JSON syntax errors carry `line`/`column`); serialisation errors are
`RdfSerializeError`s.

- `parse` options: `blankNodePrefix`, `graph`, `strict` (reject the RDF 1.2 extensions).
- `serialize` options: `extensions` (default `false`), `mergeGraphs` (default `false`),
  `space` (JSON indentation, default 2).

RDF/JSON describes a single graph, so quads in named graphs are rejected unless
`mergeGraphs: true`.

## RDF 1.2 extensions

Output is strict RDF/JSON by default; data that needs the extensions fails unless
`extensions: true`. Parsing accepts them unless `strict: true`.

- **Base direction**: a literal with `"lang"` may carry `"direction": "ltr" | "rtl"`.
- **Triple terms**: `{ "type": "triple", "value": { "subject": …, "predicate": …, "object": … } }`,
  where `subject` is a `uri` or `bnode` value, `predicate` a `uri` value and `object` any value
  (including another triple term). Triple terms cannot be subjects.

```json
{
  "http://example.org/s": {
    "http://example.org/claims": [
      {
        "type": "triple",
        "value": {
          "subject": { "type": "uri", "value": "http://example.org/a" },
          "predicate": { "type": "uri", "value": "http://example.org/b" },
          "object": { "type": "literal", "value": "مرحبا", "lang": "ar", "direction": "rtl" }
        }
      }
    ]
  }
}
```
