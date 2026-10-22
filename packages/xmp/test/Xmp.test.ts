import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import { pipe } from 'effect/Function';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { Dataset, Isomorphism, PrefixMap, Term } from '@thomasfosterau/effect-rdf';
import { Metadata, Namespaces, Packet, Xmp } from '../src/index.ts';
import { deprecated, pdfA2b, rdf, some, svg } from './fixtures.ts';

const { DC, XMP, XMP_MM, ST_REF, PDF, PDFA_ID } = Namespaces;
const EX = 'http://example.org/ns/';

const parseError = (input: string) => Effect.flip(Xmp.parseMetadata(input));

describe('Xmp.parseMetadata', () => {
  it.effect('reads a PDF/A packet into the XMP data model', () =>
    Effect.gen(function* () {
      const meta = yield* Xmp.parseMetadata(pdfA2b);
      expect(meta.about).toBe('');
      expect(meta.properties.map(([iri]) => iri)).toEqual(
        expect.arrayContaining([
          `${DC}format`,
          `${DC}title`,
          `${DC}creator`,
          `${DC}subject`,
          `${XMP}CreateDate`,
          `${XMP}CreatorTool`,
          `${XMP}ModifyDate`,
          `${PDF}Producer`,
          `${PDFA_ID}part`,
          `${PDFA_ID}conformance`,
        ]),
      );
      expect(Metadata.getLocalized(meta, `${DC}title`)).toEqual(Option.some('Annual report'));
      expect(Metadata.getLocalized(meta, `${DC}title`, 'DE')).toEqual(Option.some('Jahresbericht'));
      expect(Metadata.getLocalized(meta, `${DC}title`, 'fr')).toEqual(Option.some('Annual report'));
      expect(Metadata.getItems(meta, `${DC}creator`)).toEqual(
        Option.some(['Ada Lovelace', 'Charles Babbage']),
      );
      expect(
        Option.map(Metadata.get(meta, `${DC}creator`), (v) => Metadata.isArray(v) && v.form),
      ).toEqual(Option.some('Seq'));
      expect(Metadata.getText(meta, `${XMP}CreateDate`)).toEqual(
        Option.some('2026-10-01T09:30:00+10:00'),
      );
    }),
  );

  it.effect('reads the packet out of bytes, or the whole bytes without one', () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode(`\u0000\u0001binary${pdfA2b}binary`);
      const meta = yield* Xmp.parseMetadata(bytes);
      expect(Metadata.getText(meta, `${PDF}Producer`)).toEqual(Option.some('effect-pdf 0.1.0'));
      const sidecar = yield* Xmp.parseMetadata(new TextEncoder().encode(svg));
      expect(Metadata.getText(sidecar, `${DC}format`)).toEqual(Option.some('image/svg+xml'));
    }),
  );

  it.effect('accepts the deprecated forms ISO 16684-1 requires readers to accept', () =>
    Effect.gen(function* () {
      const meta = yield* Xmp.parseMetadata(deprecated);
      // Differing rdf:about values and a description without one are merged.
      expect(meta.about).toBe('uuid:6ec119d0-7f5b-11d9-8f5c-000d936e7b4a');
      expect(Metadata.getText(meta, `${XMP_MM}DocumentID`)).toEqual(Option.some('xmp.did:1234'));
      expect(Metadata.get(meta, `${XMP_MM}DerivedFrom`)).toEqual(
        Option.some(
          Metadata.struct([
            [`${ST_REF}documentID`, Metadata.text('xmp.did:0001')],
            [`${ST_REF}instanceID`, Metadata.text('xmp.iid:0001')],
          ]),
        ),
      );
      expect(Metadata.get(meta, `${DC}creator`)).toEqual(
        Option.some(
          Metadata.array('Seq', [
            Metadata.withQualifiers(Metadata.text('Ada Lovelace'), [
              [`${EX}role`, Metadata.text('author')],
            ]),
          ]),
        ),
      );
      expect(Metadata.get(meta, `${EX}homepage`)).toEqual(
        Option.some(Metadata.uri('http://example.org/ada')),
      );
    }),
  );

  it.effect('reads XMP embedded in another XML document', () =>
    Effect.gen(function* () {
      const meta = yield* Xmp.parseMetadata(svg);
      expect(Metadata.getText(meta, `${DC}format`)).toEqual(Option.some('image/svg+xml'));
    }),
  );

  it.effect('keeps only the lexical form of a typed literal', () =>
    Effect.gen(function* () {
      const meta = yield* Xmp.parseMetadata(
        rdf(
          `<rdf:Description rdf:about=""><ex:n rdf:datatype="http://www.w3.org/2001/XMLSchema#integer">7</ex:n></rdf:Description>`,
        ),
      );
      expect(Metadata.getText(meta, `${EX}n`)).toEqual(Option.some('7'));
    }),
  );

  it.effect('reads an empty description as empty metadata', () =>
    Effect.gen(function* () {
      const meta = yield* Xmp.parseMetadata(rdf('<rdf:Description rdf:about=""/>'));
      expect(meta).toEqual(Metadata.empty);
    }),
  );

  it.effect('fails on XML and RDF/XML errors with a position', () =>
    Effect.gen(function* () {
      const xml = yield* parseError('<x:xmpmeta xmlns:x="adobe:ns:meta/">\n<rdf:RDF');
      expect(xml.format).toBe('XMP');
      expect(xml.line).toBe(2);
      const rdfXml = yield* parseError(rdf('<rdf:Description rdf:about="" rdf:ID="a"/>'));
      expect(rdfXml.format).toBe('XMP');
      expect(rdfXml.message).toContain('cannot be used together');
      const none = yield* parseError('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
      expect(none.message).toBe('No rdf:RDF element found');
    }),
  );

  it.effect('fails on RDF outside the XMP data model', () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, string]> = [
        [
          `<rdf:Description rdf:about=""><ex:a rdf:nodeID="n"/></rdf:Description>
           <rdf:Description rdf:nodeID="n"><ex:b rdf:nodeID="n"/></rdf:Description>`,
          'contains itself',
        ],
        [
          `<rdf:Description rdf:about=""><ex:a>1</ex:a></rdf:Description>
           <rdf:Description rdf:about=""><ex:a>2</ex:a></rdf:Description>`,
          'is given more than once',
        ],
        [
          `<rdf:Description rdf:about=""><ex:a><rdf:Bag><ex:b>1</ex:b></rdf:Bag></ex:a></rdf:Description>`,
          'non-member property',
        ],
        [
          `<rdf:Description rdf:about=""><ex:a rdf:parseType="Triple"><rdf:Description rdf:about="http://example.org/s"><ex:p>o</ex:p></rdf:Description></ex:a></rdf:Description>`,
          'triple terms',
        ],
      ];
      const errors = yield* Effect.forEach(
        cases,
        ([body]) => parseError(rdf(body, ' rdf:version="1.2"')),
        { concurrency: 1 },
      );
      errors.forEach((error, i) => expect(error.message).toContain(cases[i]?.[1]));
    }),
  );
});

describe('Metadata.fromDataset', () => {
  it('fails on a description about a triple term', () => {
    const s = Term.triple(
      Term.namedNode('http://example.org/s'),
      Term.namedNode('http://example.org/p'),
      Term.literal('o'),
    );
    const result = Metadata.fromDatasetResult(
      Dataset.make(Term.quad(s, Term.namedNode(`${EX}p`), Term.literal('x'))),
    );
    expect(Result.isFailure(result)).toBe(true);
  });
});

describe('Metadata', () => {
  it('looks up language alternatives', () => {
    expect(Metadata.localizedOf(Metadata.text('plain'), 'de')).toEqual(Option.some('plain'));
    expect(Metadata.localizedOf(Metadata.struct([]))).toEqual(Option.none());
    expect(Metadata.localizedOf(Metadata.array('Alt', []))).toEqual(Option.none());
    expect(Metadata.localizedOf(Metadata.languageAlternative([['de', 'Hallo']]), 'fr')).toEqual(
      Option.some('Hallo'),
    );
    expect(Metadata.textOf(Metadata.seq(['a']))).toEqual(Option.none());
    expect(Metadata.itemsOf(Metadata.text('a'))).toEqual(Option.none());
  });

  it('sets a language, treating an unqualified item as x-default', () => {
    const iri = `${DC}title`;
    const meta = Metadata.set(Metadata.empty, iri, Metadata.array('Alt', [Metadata.text('Old')]));
    const updated = Metadata.setLocalized(meta, iri, 'Neu', 'de');
    expect(Metadata.get(updated, iri)).toEqual(
      Option.some(
        Metadata.languageAlternative([
          ['x-default', 'Old'],
          ['de', 'Neu'],
        ]),
      ),
    );
    expect(Metadata.getLocalized(Metadata.setLocalized(updated, iri, 'New'), iri)).toEqual(
      Option.some('New'),
    );
  });

  it('gets, sets and removes properties data-first and data-last', () => {
    const meta = pipe(
      Metadata.empty,
      Metadata.set(`${EX}a`, Metadata.text('1')),
      Metadata.set(`${EX}b`, Metadata.text('2')),
      Metadata.set(`${EX}a`, Metadata.text('3')),
    );
    expect(meta.properties.map(([iri]) => iri)).toEqual([`${EX}a`, `${EX}b`]);
    expect(pipe(meta, Metadata.getText(`${EX}a`))).toEqual(Option.some('3'));
    expect(pipe(meta, Metadata.remove(`${EX}a`), Metadata.get(`${EX}a`))).toEqual(Option.none());
    expect(pipe(meta, Metadata.getItems(`${EX}a`))).toEqual(Option.none());
    expect(
      pipe(Metadata.text('v'), Metadata.withQualifiers([[`${EX}q`, Metadata.text('1')]]))
        .qualifiers,
    ).toEqual([[`${EX}q`, Metadata.text('1')]]);
  });
});

describe('Xmp.serializeMetadata', () => {
  const meta = Metadata.make([
    [
      `${DC}title`,
      Metadata.languageAlternative([
        ['de', 'Bericht'],
        ['x-default', 'Report'],
      ]),
    ],
    [`${XMP}CreatorTool`, Metadata.text('effect-xmp')],
    [`${DC}creator`, Metadata.seq(['Ada <Lovelace> & co'])],
  ]);

  it.effect('writes the canonical XMP form', () =>
    Effect.gen(function* () {
      const text = yield* Xmp.serializeMetadata(meta, {
        packet: false,
        toolkit: 'effect-xmp',
      });
      expect(text).toBe(
        [
          '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="effect-xmp">',
          ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
          '  <rdf:Description rdf:about=""',
          '    xmlns:dc="http://purl.org/dc/elements/1.1/">',
          '   <dc:title>',
          '    <rdf:Alt>',
          '     <rdf:li xml:lang="x-default">Report</rdf:li>',
          '     <rdf:li xml:lang="de">Bericht</rdf:li>',
          '    </rdf:Alt>',
          '   </dc:title>',
          '   <dc:creator>',
          '    <rdf:Seq>',
          '     <rdf:li>Ada &lt;Lovelace&gt; &amp; co</rdf:li>',
          '    </rdf:Seq>',
          '   </dc:creator>',
          '  </rdf:Description>',
          '  <rdf:Description rdf:about=""',
          '    xmlns:xmp="http://ns.adobe.com/xap/1.0/">',
          '   <xmp:CreatorTool>effect-xmp</xmp:CreatorTool>',
          '  </rdf:Description>',
          ' </rdf:RDF>',
          '</x:xmpmeta>',
          '',
        ].join('\n'),
      );
    }),
  );

  it.effect('wraps the XMP in a padded packet by default', () =>
    Effect.gen(function* () {
      const text = yield* Xmp.serializeMetadata(meta);
      const unwrapped = some(Packet.unwrap(text));
      expect(unwrapped.writable).toBe(true);
      expect(unwrapped.padding).toBe(Packet.DEFAULT_PADDING + 1);
      const sized = yield* Xmp.serializeMetadata(meta, { size: 4096, writable: false });
      expect(Packet.byteLength(sized)).toBe(4096);
      const tooSmall = yield* Effect.flip(Xmp.serializeMetadata(meta, { size: 100 }));
      expect(tooSmall.message).toBe('The XMP packet does not fit in 100 bytes');
    }),
  );

  it.effect('round-trips every kind of value, reading entries in IRI order', () =>
    Effect.gen(function* () {
      const all = Metadata.make(
        [
          [`${EX}bag`, Metadata.array('Bag', [])],
          [`${EX}empty`, Metadata.struct([])],
          [`${EX}lang`, Metadata.text('Bonjour', 'fr')],
          [
            `${EX}qualified`,
            Metadata.withQualifiers(Metadata.text('v', 'en'), [
              [`${EX}q`, Metadata.uri('http://example.org/q')],
            ]),
          ],
          [
            `${EX}qualifiedArray`,
            Metadata.withQualifiers(Metadata.seq(['a']), [[`${EX}q`, Metadata.struct([])]]),
          ],
          [
            `${EX}struct`,
            Metadata.struct([
              [`${EX}a`, Metadata.text('1')],
              [`${ST_REF}documentID`, Metadata.bag(['x', 'y'])],
            ]),
          ],
          [`${EX}text`, Metadata.text('plain')],
          [`${EX}uri`, Metadata.uri('http://example.org/a?b=c&d')],
          [`${Namespaces.RDF}type`, Metadata.uri('http://example.org/Type')],
        ],
        'uuid:1',
      );
      const text = yield* Xmp.serializeMetadata(all);
      expect(yield* Xmp.parseMetadata(text)).toEqual(all);
      const parsed = yield* Xmp.parse(text);
      expect(Isomorphism.isomorphic(parsed.dataset, Metadata.toDataset(all))).toBe(true);
      expect(text).toContain('xmlns:stRef="http://ns.adobe.com/xap/1.0/sType/ResourceRef#"');
    }),
  );

  it.effect('writes empty metadata as one empty description', () =>
    Effect.gen(function* () {
      const text = yield* Xmp.serializeMetadata(Metadata.empty, { packet: false });
      expect(text).toContain('<rdf:Description rdf:about=""/>');
      expect(yield* Xmp.parseMetadata(text)).toEqual(Metadata.empty);
    }),
  );

  it.effect('takes prefixes from the options, then the conventional ones, then nsN', () =>
    Effect.gen(function* () {
      const text = yield* Xmp.serializeMetadata(
        Metadata.make([
          [`${EX}a`, Metadata.text('1')],
          ['http://example.org/other#b', Metadata.text('2')],
          ['http://example.org/third#c', Metadata.text('3')],
          [`${DC}format`, Metadata.text('x')],
        ]),
        {
          packet: false,
          prefixes: PrefixMap.make({ ex: EX, rdf: 'http://example.org/not-rdf#', '': DC, x: DC }),
          indent: '\t',
        },
      );
      expect(text).toContain('xmlns:ex="http://example.org/ns/"');
      expect(text).toContain('xmlns:ns1="http://example.org/other#"');
      expect(text).toContain('xmlns:ns2="http://example.org/third#"');
      expect(text).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"');
      expect(text).toContain('\t<rdf:RDF');
    }),
  );

  it.effect('generates a prefix when the preferred one is taken', () =>
    Effect.gen(function* () {
      const text = yield* Xmp.serializeMetadata(
        Metadata.make([
          [`${EX}a`, Metadata.text('1')],
          [`${DC}format`, Metadata.text('x')],
        ]),
        { packet: false, prefixes: PrefixMap.make({ dc: EX }) },
      );
      expect(text).toContain('xmlns:dc="http://example.org/ns/"');
      expect(text).toContain('xmlns:ns1="http://purl.org/dc/elements/1.1/"');
      expect(yield* Xmp.parseMetadata(text)).toEqual(
        Metadata.make([
          [`${EX}a`, Metadata.text('1')],
          [`${DC}format`, Metadata.text('x')],
        ]),
      );
    }),
  );

  it.effect('fails on an IRI that is not an XML name', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Xmp.serializeMetadata(Metadata.make([['http://example.org/1', Metadata.text('x')]])),
      );
      expect(error.message).toContain('cannot be written as an XML element name');
    }),
  );
});

describe('Xmp codec', () => {
  it.effect('parses to the RDF of the data model and serializes it back', () =>
    Effect.gen(function* () {
      const parsed = yield* Xmp.parse(pdfA2b);
      const meta = yield* Metadata.fromDataset(parsed.dataset);
      expect(Isomorphism.isomorphic(parsed.dataset, Metadata.toDataset(meta))).toBe(true);
      const text = yield* Xmp.serialize(parsed.dataset);
      const again = yield* Xmp.parse(text);
      expect(Isomorphism.isomorphic(parsed.dataset, again.dataset)).toBe(true);
      expect(Xmp.format.extensions).toEqual(['xmp']);
    }),
  );

  it.effect('decodes and encodes through the codec schema', () =>
    Effect.gen(function* () {
      const dataset = yield* Schema.decodeEffect(Xmp.codec.schema)(pdfA2b);
      const text = yield* Schema.encodeEffect(Xmp.codec.schema)(dataset);
      expect(text.startsWith('<?xpacket begin=')).toBe(true);
    }),
  );

  it.effect('fails to serialize RDF outside the data model', () =>
    Effect.gen(function* () {
      const node = Term.blankNode();
      const error = yield* Effect.flip(
        Xmp.serialize([
          Term.quad(Term.namedNode(''), Term.namedNode(`${EX}a`), node),
          Term.quad(node, Term.namedNode(`${EX}b`), node),
        ]),
      );
      expect(error._tag).toBe('RdfSerializeError');
      expect(error.message).toContain('contains itself');
    }),
  );
});
