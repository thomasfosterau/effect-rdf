---
'@thomasfosterau/effect-rdfxml': patch
---

`RdfXml.parse` carries the `RdfXml.parse` tracing span again (it had landed on `parseQuads`, whose result has no dataset, which broke the type check).
