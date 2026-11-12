---
'@thomasfosterau/effect-rdf': minor
'@thomasfosterau/effect-sparql-node': minor
---

Tagged error classes are now nominally branded (`Schema.TaggedError<Self, { readonly brand: unique symbol }>`): a structurally identical object is no longer assignable to an error class type such as `RdfParseError`, `ShExError` or `SparqlError`.

Integer-valued error fields now use `Schema.Int` and reject `NaN`, `Infinity` and fractional values when decoded or constructed: `line`, `column` and `offset` of `RdfParseError`, `RdfSerializeError`-style position fields, `XmlError`, `SparqlParseError` and `SparqlResultsError`, and `status` of `SparqlHttpError` and `ProtocolError`. ShEx JSON `mininclusive`, `minexclusive`, `maxinclusive` and `maxexclusive`, and the `TermCodec.integer` codec's schema, now use `Schema.Finite` and reject `NaN` and the infinities. `TermCodec.number`, `TermCodec.value` and the `xsd:double` / `xsd:float` codec keep `Schema.Number` because `NaN` and `INF` are valid XSD values.
