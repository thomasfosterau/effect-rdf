# @thomasfosterau/effect-xmp

XMP (Extensible Metadata Platform, ISO 16684-1) packets as RDF: packet scanning and padding (`Packet`), the XMP data model over a `Dataset` (`Metadata`), the syntax (`Xmp`), typed accessors for the core schemas (`DublinCore`, `XmpBasic`, `XmpRights`, `XmpMM`, `Pdf`, `PdfA`) and the image ones (`Photoshop`, `Exif`, `Tiff`), and JPEG / PNG extraction (`Extract`).

## Boundary

Peers: `@thomasfosterau/effect-parse` (through effect-rdfxml), `effect`. Imports from this workspace: core, rdfxml — `.fallowrc.json` zone `xmp`.

## Invariants

- **One parser seam:** only `src/internal/xml.ts` imports effect-rdfxml (`Xml`, `RdfXml.parseDocument`, `splitIri`, the escapes). Moving to the effect-sax DOM replaces that file and nothing else; keep every other module free of XML-parser types.
- **The serializer writes the canonical XMP form** — `<x:xmpmeta>`, one `rdf:Description` per schema namespace, property elements only, `rdf:parseType="Resource"` structures and the `rdf:value` qualifier form — never the RDF/XML abbreviations a non-RDF XMP reader may reject.
- **Readers are lenient where ISO 16684-1 says so:** `<x:xapmeta>`, a missing wrapper, `rdf:RDF` anywhere in the document, differing or absent `rdf:about` values (merged), property attributes. RDF outside the data model (cycles, triple terms, a property twice, non-member properties on an array) fails with `XmpModelError`.
- **Entry order carries no meaning:** `fromDataset` sorts entries by IRI (the dataset is unordered), so output is deterministic.

## Terms

- **Packet** — `<?xpacket begin=… id="W5M0MpCehiHzreSzNTczkc9d"?>` … `<?xpacket end="w"?>`, with whitespace padding for in-place updates.
- **Language alternative** — an `rdf:Alt` of text items qualified by `xml:lang`, `x-default` first.
- **Extended XMP** — a JPEG's packet continued across further APP1 segments, named by `xmpNote:HasExtendedXMP`.
