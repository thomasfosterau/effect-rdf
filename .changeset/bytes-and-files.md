---
'@thomasfosterau/effect-rdf': minor
'@thomasfosterau/effect-sparql-server': patch
---

`Serialization` gains byte entry points and file helpers. `parseBytes` parses a `Stream<Uint8Array>` (strict UTF-8 across chunk boundaries, or a `charset`; a BOM is dropped; ill-formed bytes fail with a positioned `RdfParseError`), `parseBytesDocument` parses a whole document's bytes, and `serializeBytes` writes UTF-8. `readFile` / `writeFile` read and write RDF files through Effect's platform-agnostic `FileSystem` and `Path`, choosing the syntax by extension or media type from the `Formats` service (new: `serializerForExtension`). `effect-sparql-server`'s `Cli.load` now reads files through `FileSystem` (its `run` provides the Node layers).
