---
'@thomasfosterau/effect-rdf': minor
---

Tracing spans on the public, coarse-grained operations: every syntax's `parse` / `parseStream` / `serialize` / `serializeStream` (`Turtle.parse`, `NQuads.serializeStream`, …, with the format, media type, input length and quad or output counts), `SparqlEngine.query` / `update` (query form and operation count; the query text only with the new `EngineOptions.traceQueryText`), `Shacl.validate`, `ShEx.validate`, `Reasoner.reason` and `DocumentLoader.load`. Core's `Serialization` gains `SpanTarget` and the `withParseSpan`, `withSerializeSpan` and `withStreamSpan` combinators the syntax packages use.
