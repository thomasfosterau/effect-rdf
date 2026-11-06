---
'@thomasfosterau/effect-rdf': minor
'@thomasfosterau/effect-jsonld': minor
'@thomasfosterau/effect-n3': minor
'@thomasfosterau/effect-ntriples': minor
'@thomasfosterau/effect-rdfxml': minor
'@thomasfosterau/effect-shacl-sparql': minor
'@thomasfosterau/effect-shacl': minor
'@thomasfosterau/effect-shex': minor
'@thomasfosterau/effect-sparql': minor
'@thomasfosterau/effect-sparql-sql': minor
'@thomasfosterau/effect-turtle': minor
'@thomasfosterau/effect-xmp': minor
---

Breaking: the `effect` peer floor rises from `>=4.0.0-rc.118` to `>=4.1.0` for every package. Effect 4.1 is needed for `effect/http-api` response schemas that list several content types, which the SPARQL server's `HttpApi` definition uses (#60). Upgrade `effect` to 4.1 or later.
