# @thomasfosterau/effect-xmp

[XMP](https://www.iso.org/standard/75163.html) (Extensible Metadata Platform, ISO 16684-1) for
[`@thomasfosterau/effect-rdf`](../core): the metadata format of PDF (the catalog's `/Metadata`
stream, required by PDF/A and PDF/UA), JPEG, PNG, TIFF, WebP, SVG and MP4. XMP is a constrained
profile of RDF/XML, so the parser is
[`@thomasfosterau/effect-rdfxml`](../rdfxml); this package adds the packet wrapper, the XMP data
model, typed accessors for the core schemas and a serializer that writes the canonical form XMP
consumers expect.

| Module                                                        | Contents                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Xmp`                                                         | `parse` / `serialize` (the core `Serialization` interfaces), `parseMetadata`, `serializeMetadata` |
| `Metadata`                                                    | the data model: `Simple`, `Struct`, `ArrayValue`, qualifiers; `fromDataset` / `toDataset`         |
| `Packet`                                                      | `find` / `findAll` packets in bytes (UTF-8, UTF-16, UTF-32), `unwrap`, `wrap`, `wrapToSize`       |
| `Extract`                                                     | `jpeg` (APP1, with Extended XMP) and `png` (`iTXt`, stored or compressed)                         |
| `DublinCore`, `XmpBasic`, `XmpRights`, `XmpMM`, `Pdf`, `PdfA` | typed getters and setters                                                                         |
| `Photoshop`, `Exif`, `Tiff`                                   | typed getters and setters for the image schemas' common properties                                |
| `Namespaces`                                                  | the schema namespace IRIs and their conventional prefixes                                         |

Peers: `effect` and `@thomasfosterau/effect-parse` (the XML grammar behind effect-rdfxml).

## Reading

```ts
import { Effect, Option } from 'effect';
import { DublinCore, PdfA, Xmp, XmpBasic } from '@thomasfosterau/effect-xmp';

const program = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    // The first packet in any file, or the whole input when it has none.
    const meta = yield* Xmp.parseMetadata(bytes);
    const title = DublinCore.title(meta); // Option<string>, the x-default alternative
    const german = DublinCore.title(meta, 'de');
    const authors = DublinCore.creator(meta); // Option<ReadonlyArray<string>>
    const created = XmpBasic.createDate(meta); // the ISO 8601 string XMP stores
    const pdfa = PdfA.identification(meta); // Option<{ part, conformance, amendment, revision }>
  });
```

`Xmp.parse(text)` returns the RDF itself (a `Serialization.ParseResult`). It accepts a packet,
a bare `<x:xmpmeta>` (or the older `<x:xapmeta>`), a bare `rdf:RDF`, or any XML document with
an `rdf:RDF` inside (an SVG's `<metadata>`), and the forms ISO 16684-1 still requires readers to
accept: descriptions with differing or no `rdf:about` (merged into one resource) and property
attributes. Errors are `RdfParseError`s with `line` / `column`; RDF that does not fit the XMP
data model (a cycle, a triple term, a property given twice) fails too.

`Metadata.fromDataset` reads the data model from RDF: literals and `rdf:resource` URIs are
`Simple` values (`xml:lang` is `Simple.language`), `rdf:parseType="Resource"` nodes are
`Struct`s, `rdf:Bag` / `rdf:Seq` / `rdf:Alt` are `ArrayValue`s, and an `rdf:value` node carries
its other properties as qualifiers. Entry order carries no meaning in XMP; `fromDataset` sorts
entries by IRI so serialization is deterministic.

## Writing

```ts
import { DateTime, Effect, Option, pipe } from 'effect';
import { DublinCore, Metadata, PdfA, Xmp, XmpBasic } from '@thomasfosterau/effect-xmp';

const meta = pipe(
  Metadata.empty,
  DublinCore.setTitle('Annual report'),
  DublinCore.setTitle('Jahresbericht', 'de'),
  DublinCore.setCreator(['Ada Lovelace']),
  XmpBasic.setCreateDate(DateTime.makeUnsafe('2026-10-01T09:30:00Z')),
  PdfA.setIdentification({
    part: 2,
    conformance: Option.some('B'),
    amendment: Option.none(),
    revision: Option.none(),
  }),
);

const packet = Xmp.serializeMetadata(meta, { toolkit: 'my-app 1.0' });
```

The serializer writes the canonical XMP form: an `<x:xmpmeta>` wrapper, one `rdf:Description`
per schema namespace with that namespace declared on it, property elements only (never
attributes or typed nodes), structures as `rdf:parseType="Resource"` and qualifiers in the
`rdf:value` form, wrapped in an `<?xpacket?>` packet. Options:

- `packet` (default `true`) — wrap in a packet.
- `writable` (default `true`) — `end="w"` or `end="r"`.
- `padding` (default 2048 bytes for a writable packet) — whitespace for in-place edits.
- `size` — the exact byte length of the packet, for rewriting a packet in place; fails when the
  XMP does not fit.
- `toolkit` — the `x:xmptk` attribute; `prefixes` — prefixes to prefer over the conventional
  ones (`Namespaces.prefixes`); `indent` (default one space).

`PdfA.setExtensionSchemas` writes the `pdfaExtension:schemas` descriptions PDF/A-1 to PDF/A-3
require for properties outside the predefined schemas; `PdfA.extensionSchemas` reads them.

## Packets and image files

```ts
import { Extract, Packet } from '@thomasfosterau/effect-xmp';

Packet.find(bytes); // Option<Packet>: offset, length, encoding, writable, text
Packet.findAll(bytes);
Extract.jpeg(bytes); // Effect<Option<{ standard, extended }>, XmpExtractError>
Extract.png(bytes); // Effect<Option<string>, XmpExtractError>
```

`Packet.find` scans any file (TIFF, WebP, GIF, MP4, PDF, …) for a UTF-8, UTF-16 or UTF-32
packet (either byte order) without parsing it. `Extract.jpeg` reads the APP1 packet and
reassembles Extended XMP; `Extract.png` reads the `iTXt` chunk with the keyword
`XML:com.adobe.xmp`, inflating a compressed one with the platform's `DecompressionStream` up to `maxXmpBytes` (4 MiB by default). Each
has a synchronous `…Result` variant; `Extract.pngResult` fails on a compressed chunk, since
inflating is asynchronous.

## Conformance

There is no public XMP conformance suite; the unit tests are modelled on the ISO 16684-1
examples. `scripts/fetch-test-suites.sh` checks out the metadata sections of
[veraPDF's PDF/A and PDF/UA corpus](https://github.com/veraPDF/veraPDF-corpus), and
`test/Conformance.test.ts` reads the packet of every file in them: all 497 files that should
pass validation parse (and give the PDF/A part their section tests), and none of the 568 that
should fail makes the reader throw. The ISO 16684-1 examples are not freely published, and the
Adobe XMP Toolkit SDK ships no sample XMP files, only the C++ samples that generate them.
