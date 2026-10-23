import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import { deflateSync } from 'node:zlib';
import { Extract, Metadata, Namespaces, Xmp } from '../src/index.ts';
import { pdfA2b, some } from './fixtures.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

const concat = (...parts: ReadonlyArray<Uint8Array | ReadonlyArray<number>>): Uint8Array => {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, p) => n + p.length, 0));
  arrays.reduce((offset, p) => {
    out.set(p, offset);
    return offset + p.length;
  }, 0);
  return out;
};

const u16 = (n: number) => [n >> 8, n & 0xff];
const u32 = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

const segment = (marker: number, payload: Uint8Array) =>
  concat([0xff, marker, ...u16(payload.length + 2)], payload);

const SOI = [0xff, 0xd8];
const APP0 = segment(0xe0, bytes('JFIF\0\x01\x02'));
const SOS_AND_DATA = [0xff, 0xda, 0x00, 0x02, 0x12, 0x34, 0xff, 0xd9];

const GUID = '0123456789ABCDEF0123456789ABCDEF';

const standard = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmpNote="http://ns.adobe.com/xmp/note/" xmpNote:HasExtendedXMP="${GUID}"/></rdf:RDF></x:xmpmeta>`;

const extendedXmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" dc:format="image/jpeg"/></rdf:RDF></x:xmpmeta>`;

const extensionSegment = (guid: string, whole: Uint8Array, offset: number, length: number) =>
  segment(
    0xe1,
    concat(
      bytes('http://ns.adobe.com/xmp/extension/\0'),
      bytes(guid),
      u32(whole.length),
      u32(offset),
      whole.subarray(offset, offset + length),
    ),
  );

describe('Extract.jpeg', () => {
  it.effect('reads the standard packet of a JPEG file', () =>
    Effect.gen(function* () {
      const jpeg = concat(
        SOI,
        [0xff, 0xff], // a fill byte before the next marker
        APP0,
        [0xff, 0xd0], // a marker without a length
        segment(0xe1, concat(bytes('Exif\0\0'), [1, 2, 3])),
        segment(0xe1, concat(bytes('http://ns.adobe.com/xap/1.0/\0'), bytes(pdfA2b))),
        SOS_AND_DATA,
      );
      const xmp = some(yield* Extract.jpeg(jpeg));
      expect(xmp.standard).toBe(pdfA2b);
      expect(xmp.extended).toEqual(Option.none());
    }),
  );

  it.effect('reassembles Extended XMP from out-of-order chunks', () =>
    Effect.gen(function* () {
      const whole = bytes(extendedXmp);
      const half = Math.floor(whole.length / 2);
      const jpeg = concat(
        SOI,
        segment(0xe1, concat(bytes('http://ns.adobe.com/xap/1.0/\0'), bytes(standard))),
        extensionSegment(GUID, whole, half, whole.length - half),
        extensionSegment('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', whole, 0, 10),
        extensionSegment(GUID, whole, 0, half),
        SOS_AND_DATA,
      );
      const xmp = some(yield* Extract.jpeg(jpeg));
      expect(xmp.extended).toEqual(Option.some(extendedXmp));
    }),
  );

  it('is None for a JPEG without XMP', () => {
    expect(Extract.jpegResult(concat(SOI, APP0, [0xff, 0xd9]))).toEqual(
      Result.succeed(Option.none()),
    );
    expect(Extract.jpegResult(concat(SOI, APP0))).toEqual(Result.succeed(Option.none()));
  });

  it.effect('fails on a malformed JPEG', () =>
    Effect.gen(function* () {
      const failures = [
        [bytes('GIF89a'), 'Not a JPEG file'],
        [concat(SOI, [0x00, 0x00]), 'Expected a JPEG marker at offset 2'],
        [concat(SOI, [0xff, 0xe1, 0x00]), 'Truncated JPEG segment at offset 2'],
        [concat(SOI, [0xff, 0xe1, 0x00, 0x40, 0x00]), 'Truncated JPEG segment at offset 2'],
        [
          concat(SOI, segment(0xe1, bytes('http://ns.adobe.com/xmp/extension/\0short'))),
          'Truncated Extended XMP segment',
        ],
        [
          concat(
            SOI,
            segment(0xe1, concat(bytes('http://ns.adobe.com/xap/1.0/\0'), bytes(standard))),
            segment(
              0xe1,
              concat(
                bytes('http://ns.adobe.com/xmp/extension/\0'),
                bytes(GUID),
                u32(4),
                u32(2),
                [1, 2, 3],
              ),
            ),
          ),
          'Extended XMP chunk out of bounds',
        ],
      ] as const;
      const errors = yield* Effect.forEach(
        failures,
        ([input]) => Effect.flip(Extract.jpeg(input)),
        { concurrency: 1 },
      );
      expect(errors.map((e) => e.message)).toEqual(failures.map(([, message]) => message));
    }),
  );
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const chunk = (type: string, data: Uint8Array) =>
  concat(u32(data.length), bytes(type), data, [0, 0, 0, 0]);

const itxt = (keyword: string, text: string | Uint8Array, compressed = 0, method = 0) =>
  chunk(
    'iTXt',
    concat(
      bytes(keyword),
      [0, compressed, method],
      bytes('en'),
      [0],
      bytes('XMP'),
      [0],
      text instanceof Uint8Array ? text : bytes(text),
    ),
  );

const IHDR = chunk('IHDR', new Uint8Array(13));
const IEND = chunk('IEND', new Uint8Array(0));

describe('Extract.png', () => {
  it.effect('reads the packet of the XMP iTXt chunk', () =>
    Effect.gen(function* () {
      const png = concat(
        PNG_SIGNATURE,
        IHDR,
        itxt('Comment', 'not XMP'),
        itxt('XML:com.adobe.xmp', pdfA2b),
        IEND,
      );
      const text = some(yield* Extract.png(png));
      expect(text).toBe(pdfA2b);
      const meta = yield* Xmp.parseMetadata(text);
      expect(Metadata.getText(meta, `${Namespaces.PDF}Producer`)).toEqual(
        Option.some('effect-pdf 0.1.0'),
      );
    }),
  );

  it.effect('inflates a compressed XMP iTXt chunk', () =>
    Effect.gen(function* () {
      const png = concat(
        PNG_SIGNATURE,
        IHDR,
        itxt('XML:com.adobe.xmp', deflateSync(bytes(pdfA2b)), 1),
        IEND,
      );
      expect(some(yield* Extract.png(png))).toBe(pdfA2b);
      // Inflating is asynchronous, so the synchronous reader says to use `png`.
      const sync = Extract.pngResult(png);
      expect(Result.isFailure(sync) && sync.failure.message).toBe(
        'A compressed XMP iTXt chunk needs Extract.png, which inflates it',
      );
    }),
  );

  it('is None for a PNG without XMP', () => {
    expect(Extract.pngResult(concat(PNG_SIGNATURE, IHDR, IEND))).toEqual(
      Result.succeed(Option.none()),
    );
    expect(Extract.pngResult(concat(PNG_SIGNATURE, IHDR))).toEqual(Result.succeed(Option.none()));
  });

  it.effect('fails on a malformed PNG', () =>
    Effect.gen(function* () {
      const failures = [
        [bytes('GIF89a'), 'Not a PNG file'],
        [concat(PNG_SIGNATURE, [0, 0, 0]), 'Truncated PNG chunk at offset 8'],
        [
          concat(PNG_SIGNATURE, u32(100), bytes('IDAT'), [0, 0, 0, 0]),
          'Truncated PNG chunk at offset 8',
        ],
        [
          concat(PNG_SIGNATURE, itxt('XML:com.adobe.xmp', 'not zlib', 1)),
          'Malformed compressed iTXt chunk',
        ],
        [
          concat(PNG_SIGNATURE, itxt('XML:com.adobe.xmp', 'x', 1, 7)),
          'Unknown iTXt compression method',
        ],
        [
          concat(
            PNG_SIGNATURE,
            chunk('iTXt', concat(bytes('XML:com.adobe.xmp'), [0, 0, 0], bytes('en'))),
          ),
          'Malformed iTXt chunk',
        ],
      ] as const;
      const errors = yield* Effect.forEach(failures, ([input]) => Effect.flip(Extract.png(input)), {
        concurrency: 1,
      });
      expect(errors.map((e) => e.message)).toEqual(failures.map(([, message]) => message));
    }),
  );
});
