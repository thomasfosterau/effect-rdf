import { describe, expect, it } from '@effect/vitest';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import { pipe } from 'effect/Function';
import * as Option from 'effect/Option';
import {
  DublinCore,
  Metadata,
  Namespaces,
  Pdf,
  PdfA,
  Xmp,
  XmpBasic,
  XmpMM,
  XmpRights,
} from '../src/index.ts';
import { extension, pdfA2b } from './fixtures.ts';

const roundTrip = (meta: Metadata.Metadata) =>
  Effect.flatMap(Xmp.serializeMetadata(meta), (text) => Xmp.parseMetadata(text));

describe('DublinCore', () => {
  it.effect('reads the core properties of a PDF/A packet', () =>
    Effect.gen(function* () {
      const meta = yield* Xmp.parseMetadata(pdfA2b);
      expect(DublinCore.title(meta)).toEqual(Option.some('Annual report'));
      expect(DublinCore.title(meta, 'de')).toEqual(Option.some('Jahresbericht'));
      expect(DublinCore.creator(meta)).toEqual(Option.some(['Ada Lovelace', 'Charles Babbage']));
      expect(DublinCore.subject(meta)).toEqual(Option.some(['engines']));
      expect(DublinCore.format(meta)).toEqual(Option.some('application/pdf'));
      expect(DublinCore.description(meta)).toEqual(Option.none());
    }),
  );

  it.effect('writes them data-first and data-last', () =>
    Effect.gen(function* () {
      const meta = pipe(
        Metadata.empty,
        DublinCore.setTitle('Report'),
        DublinCore.setTitle('Bericht', 'de'),
        DublinCore.setDescription('About things'),
        DublinCore.setRights('CC BY 4.0'),
        DublinCore.setCreator(['Ada']),
        DublinCore.setSubject(['a', 'b']),
        DublinCore.setPublisher(['Pub']),
        DublinCore.setFormat('application/pdf'),
        DublinCore.setIdentifier('urn:isbn:0'),
      );
      const updated = DublinCore.setTitle(meta, 'New report');
      const read = yield* roundTrip(updated);
      expect(DublinCore.title(read)).toEqual(Option.some('New report'));
      expect(DublinCore.title(read, 'de')).toEqual(Option.some('Bericht'));
      expect(DublinCore.description(read)).toEqual(Option.some('About things'));
      expect(DublinCore.rights(read)).toEqual(Option.some('CC BY 4.0'));
      expect(DublinCore.creator(read)).toEqual(Option.some(['Ada']));
      expect(DublinCore.subject(read)).toEqual(Option.some(['a', 'b']));
      expect(DublinCore.publisher(read)).toEqual(Option.some(['Pub']));
      expect(DublinCore.identifier(read)).toEqual(Option.some('urn:isbn:0'));
      // x-default stays the first alternative.
      expect(
        Option.map(Metadata.get(updated, `${Namespaces.DC}title`), (v) =>
          Metadata.isArray(v) ? v.items.map((i) => Metadata.isSimple(i) && i.value) : [],
        ),
      ).toEqual(Option.some(['New report', 'Bericht']));
    }),
  );
});

describe('XmpBasic, XmpRights, XmpMM and Pdf', () => {
  it.effect('read and write their properties', () =>
    Effect.gen(function* () {
      const created = DateTime.makeZonedUnsafe('2026-10-01T00:00:00Z', {
        timeZone: 10 * 60 * 60 * 1000,
      });
      const meta = pipe(
        Metadata.empty,
        XmpBasic.setCreateDate(created),
        XmpBasic.setModifyDate('2026-10-02'),
        XmpBasic.setMetadataDate(DateTime.makeUnsafe(0)),
        XmpBasic.setCreatorTool('effect-document'),
        XmpRights.setMarked(true),
        XmpRights.setOwner(['Ada']),
        XmpRights.setUsageTerms('Ask first'),
        XmpRights.setWebStatement('https://example.org/rights'),
        XmpMM.setDocumentId('uuid:doc'),
        XmpMM.setInstanceId('uuid:instance'),
        XmpMM.setOriginalDocumentId('uuid:original'),
        XmpMM.setVersionId('2'),
        Pdf.setProducer('effect-pdf'),
        Pdf.setKeywords('a, b'),
        Pdf.setPdfVersion('1.7'),
        Pdf.setTrapped('False'),
        Pdf.setUaPart(1),
      );
      const read = yield* roundTrip(meta);
      expect(XmpBasic.createDate(read)).toEqual(Option.some('2026-10-01T10:00:00.000+10:00'));
      expect(XmpBasic.modifyDate(read)).toEqual(Option.some('2026-10-02'));
      expect(XmpBasic.metadataDate(read)).toEqual(Option.some('1970-01-01T00:00:00.000Z'));
      expect(XmpBasic.creatorTool(read)).toEqual(Option.some('effect-document'));
      expect(XmpRights.marked(read)).toEqual(Option.some(true));
      expect(XmpRights.marked(XmpRights.setMarked(read, false))).toEqual(Option.some(false));
      expect(
        XmpRights.marked(Metadata.set(read, `${Namespaces.XMP_RIGHTS}Marked`, Metadata.text('x'))),
      ).toEqual(Option.none());
      expect(XmpRights.owner(read)).toEqual(Option.some(['Ada']));
      expect(XmpRights.usageTerms(read)).toEqual(Option.some('Ask first'));
      expect(XmpRights.webStatement(read)).toEqual(Option.some('https://example.org/rights'));
      expect(XmpMM.documentId(read)).toEqual(Option.some('uuid:doc'));
      expect(XmpMM.instanceId(read)).toEqual(Option.some('uuid:instance'));
      expect(XmpMM.originalDocumentId(read)).toEqual(Option.some('uuid:original'));
      expect(XmpMM.versionId(read)).toEqual(Option.some('2'));
      expect(Pdf.producer(read)).toEqual(Option.some('effect-pdf'));
      expect(Pdf.keywords(read)).toEqual(Option.some('a, b'));
      expect(Pdf.pdfVersion(read)).toEqual(Option.some('1.7'));
      expect(Pdf.trapped(read)).toEqual(Option.some('False'));
      expect(Pdf.uaPart(read)).toEqual(Option.some(1));
      expect(
        Pdf.uaPart(Metadata.set(read, `${Namespaces.PDFUA_ID}part`, Metadata.text('one'))),
      ).toEqual(Option.none());
    }),
  );
});

describe('PdfA', () => {
  it.effect('reads and writes the identification', () =>
    Effect.gen(function* () {
      const meta = yield* Xmp.parseMetadata(pdfA2b);
      expect(PdfA.identification(meta)).toEqual(
        Option.some({
          part: 2,
          conformance: Option.some('B'),
          amendment: Option.none(),
          revision: Option.none(),
        }),
      );
      const pdfA4 = PdfA.setIdentification(meta, {
        part: 4,
        conformance: Option.none(),
        amendment: Option.some('2021:1'),
        revision: Option.some('2020'),
      });
      const read = yield* roundTrip(pdfA4);
      expect(PdfA.identification(read)).toEqual(
        Option.some({
          part: 4,
          conformance: Option.none(),
          amendment: Option.some('2021:1'),
          revision: Option.some('2020'),
        }),
      );
      expect(PdfA.identification(Metadata.empty)).toEqual(Option.none());
    }),
  );

  it.effect('reads extension schema descriptions, skipping malformed entries', () =>
    Effect.gen(function* () {
      const meta = yield* Xmp.parseMetadata(extension);
      expect(PdfA.extensionSchemas(meta)).toEqual([
        {
          schema: 'Example schema',
          namespaceUri: 'http://example.org/ns/',
          prefix: 'ex',
          properties: [
            {
              name: 'role',
              valueType: 'Text',
              category: 'external',
              description: "A creator's role",
            },
          ],
          valueTypes: [],
        },
      ]);
      expect(PdfA.extensionSchemas(Metadata.empty)).toEqual([]);
      const odd = Metadata.set(
        Metadata.empty,
        `${Namespaces.PDFA_EXTENSION}schemas`,
        Metadata.array('Bag', [
          Metadata.struct([[`${Namespaces.PDFA_SCHEMA}property`, Metadata.text('not an array')]]),
        ]),
      );
      expect(PdfA.extensionSchemas(odd)).toEqual([
        { schema: '', namespaceUri: '', prefix: '', properties: [], valueTypes: [] },
      ]);
    }),
  );

  it.effect('writes extension schemas with value types, and removes them', () =>
    Effect.gen(function* () {
      const schema: PdfA.ExtensionSchema = {
        schema: 'Example schema',
        namespaceUri: 'http://example.org/ns/',
        prefix: 'ex',
        properties: [
          { name: 'contact', valueType: 'Contact', category: 'external', description: 'Who' },
        ],
        valueTypes: [
          {
            type: 'Contact',
            namespaceUri: 'http://example.org/contact#',
            prefix: 'exc',
            description: 'A contact',
            fields: [{ name: 'email', valueType: 'Text', description: 'Address' }],
          },
          {
            type: 'Empty',
            namespaceUri: 'http://example.org/empty#',
            prefix: 'exe',
            description: 'No fields',
            fields: [],
          },
        ],
      };
      const meta = PdfA.setExtensionSchemas(Metadata.empty, [schema]);
      const text = yield* Xmp.serializeMetadata(meta);
      expect(text).toContain('xmlns:pdfaType="http://www.aiim.org/pdfa/ns/type#"');
      expect(PdfA.extensionSchemas(yield* Xmp.parseMetadata(text))).toEqual([schema]);
      expect(pipe(meta, PdfA.setExtensionSchemas([]))).toEqual(Metadata.empty);
    }),
  );
});
