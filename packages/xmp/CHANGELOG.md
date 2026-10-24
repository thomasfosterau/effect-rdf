# @thomasfosterau/effect-xmp

## 0.1.0

### Minor Changes

- [#24](https://github.com/thomasfosterau/effect-rdf/pull/24) [`f8f7598`](https://github.com/thomasfosterau/effect-rdf/commit/f8f7598d85ea8e7069c6a87a9b14a4a4ab6ff75a) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Require `@thomasfosterau/effect-parse` `^0.2.0` (was `^0.1.0`). The peer range moves to the 0.2 line, so a consumer must upgrade its own `@thomasfosterau/effect-parse` with these packages. The grammars now compile with `Compiler.jit` (0.2.0 removed `Parser.compile`), and the SPARQL grammar matches each token kind as a compiled token set instead of an interpreted hook, which speeds up query and update parsing; error messages are unchanged.

- [#23](https://github.com/thomasfosterau/effect-rdf/pull/23) [`b4d704c`](https://github.com/thomasfosterau/effect-rdf/commit/b4d704cd8d4b48d8a47413e90cef46366ff6b1cf) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - New package `@thomasfosterau/effect-xmp`: XMP (ISO 16684-1) packets as RDF — packet scanning, unwrapping and padding; the XMP data model over a `Dataset` (simple values, structures, `rdf:Bag` / `rdf:Seq` / `rdf:Alt` arrays, qualifiers); a serializer for the canonical XMP form; typed accessors for Dublin Core, XMP Basic, XMP Rights, XMP Media Management, PDF, PDF/UA and PDF/A (identification and extension schemas); and XMP extraction from JPEG (with Extended XMP) and PNG files. `@thomasfosterau/effect-rdfxml` gains `RdfXml.parseDocument`, which reads RDF/XML from an already-parsed `Xml.Document`.

- [#27](https://github.com/thomasfosterau/effect-rdf/pull/27) [`bd7b393`](https://github.com/thomasfosterau/effect-rdf/commit/bd7b393cbcc2cf8e7d0936206d164469d12928e5) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `effect-xmp` reads more of the XMP found in files: `Packet.find` / `findAll` find UTF-32 packets (either byte order; `Packet.Encoding` gains `'utf-32be'` and `'utf-32le'`), and `Extract.png` inflates a zlib-compressed `iTXt` chunk with the platform's `DecompressionStream`, up to `maxXmpBytes` (default `Extract.DEFAULT_MAX_XMP_BYTES`, 4 MiB) so a deflate bomb fails instead of exhausting memory (`Extract.pngResult`, which is synchronous, still fails on one, now saying to use `Extract.png`). New `Photoshop`, `Exif` and `Tiff` modules give typed getters and setters for those schemas' common properties.

### Patch Changes

- Updated dependencies [[`f8f7598`](https://github.com/thomasfosterau/effect-rdf/commit/f8f7598d85ea8e7069c6a87a9b14a4a4ab6ff75a), [`b4d704c`](https://github.com/thomasfosterau/effect-rdf/commit/b4d704cd8d4b48d8a47413e90cef46366ff6b1cf), [`7fc6de8`](https://github.com/thomasfosterau/effect-rdf/commit/7fc6de832606e5765c196f1495e0607f23af0f7e), [`ea22360`](https://github.com/thomasfosterau/effect-rdf/commit/ea2236084cc473130a73ecf9bbcea34e207be0d3)]:
  - @thomasfosterau/effect-rdfxml@0.1.0
  - @thomasfosterau/effect-rdf@0.1.0
