/**
 * Reading the XMP packet embedded in an image file, as XMP Specification
 * Part 3 places it: a JPEG's APP1 segment (with Extended XMP split across
 * further APP1 segments) or a PNG's `iTXt` chunk with the keyword
 * `XML:com.adobe.xmp` (stored or, read with `png`, zlib-compressed). Any
 * other format (TIFF, WebP, GIF, MP4, PDF, …) can
 * be scanned for its packet with `Packet.find`.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';

/**
 * A malformed image file.
 *
 * @since 0.1.0
 * @category errors
 */
export class XmpExtractError extends Schema.TaggedError<XmpExtractError>()('XmpExtractError', {
  message: Schema.String,
}) {}

/**
 * The XMP of a JPEG file: the standard packet and, when the packet does not
 * fit one segment, the Extended XMP document its `xmpNote:HasExtendedXMP`
 * names.
 *
 * @since 0.1.0
 * @category models
 */
export interface JpegXmp {
  readonly standard: string;
  readonly extended: Option.Option<string>;
}

const fail = (message: string): never => {
  throw new XmpExtractError({ message });
};

const ascii = (text: string): Uint8Array =>
  Uint8Array.from(Arr.map(Arr.fromIterable(text), (c) => c.charCodeAt(0)));

const startsWith = (bytes: Uint8Array, prefix: Uint8Array): boolean =>
  bytes.length >= prefix.length && Arr.every(Arr.fromIterable(prefix), (b, i) => bytes[i] === b);

const utf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const latin1 = (bytes: Uint8Array): string => new TextDecoder('windows-1252').decode(bytes);

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const catchExtract = <A>(f: () => A): Result.Result<A, XmpExtractError> =>
  Result.try({
    try: f,
    catch: (e) => {
      if (e instanceof XmpExtractError) return e;
      throw e;
    },
  });

// -----------------------------------------------------------------------------
// JPEG
// -----------------------------------------------------------------------------

const STANDARD = ascii('http://ns.adobe.com/xap/1.0/\0');
const EXTENSION = ascii('http://ns.adobe.com/xmp/extension/\0');
const APP1 = 0xe1;

interface Segment {
  readonly marker: number;
  readonly data: Uint8Array;
}

const isStandalone = (marker: number) =>
  marker === 0x01 || marker === 0xff || (marker >= 0xd0 && marker <= 0xd7);

/** The segments before the image data (SOS) or the end of the image (EOI). */
const jpegSegments = (bytes: Uint8Array): ReadonlyArray<Segment> => {
  const data = view(bytes);
  return Arr.getSomes(
    Arr.unfold(2, (pos): Option.Option<readonly [Option.Option<Segment>, number]> => {
      if (pos + 2 > bytes.length) return Option.none();
      if (data.getUint8(pos) !== 0xff) return fail(`Expected a JPEG marker at offset ${pos}`);
      const marker = data.getUint8(pos + 1);
      if (marker === 0xd9 || marker === 0xda) return Option.none();
      // A fill byte (0xFF) or a marker without a length.
      if (isStandalone(marker))
        return Option.some([Option.none(), marker === 0xff ? pos + 1 : pos + 2]);
      if (pos + 4 > bytes.length) return fail(`Truncated JPEG segment at offset ${pos}`);
      const length = data.getUint16(pos + 2);
      const end = pos + 2 + length;
      if (length < 2 || end > bytes.length) return fail(`Truncated JPEG segment at offset ${pos}`);
      return Option.some([Option.some({ marker, data: bytes.subarray(pos + 4, end) }), end]);
    }),
  );
};

interface Chunk {
  readonly guid: string;
  readonly length: number;
  readonly offset: number;
  readonly data: Uint8Array;
}

const extensionChunk = (payload: Uint8Array): Chunk => {
  const header = EXTENSION.length + 40;
  if (payload.length < header) return fail('Truncated Extended XMP segment');
  const data = view(payload);
  return {
    guid: latin1(payload.subarray(EXTENSION.length, EXTENSION.length + 32)),
    length: data.getUint32(EXTENSION.length + 32),
    offset: data.getUint32(EXTENSION.length + 36),
    data: payload.subarray(header),
  };
};

/** Reassembles the Extended XMP whose GUID the standard packet names. */
const extended = (standard: string, chunks: ReadonlyArray<Chunk>): Option.Option<string> =>
  Option.map(
    Arr.findFirst(chunks, (c) => standard.includes(c.guid)),
    ({ guid, length }) => {
      const whole = new Uint8Array(length);
      Arr.filter(chunks, (c) => c.guid === guid).forEach((c) => {
        if (c.offset + c.data.length > length) fail('Extended XMP chunk out of bounds');
        whole.set(c.data, c.offset);
      });
      return utf8(whole);
    },
  );

/**
 * Reads the XMP of a JPEG file, returning a `Result`: `None` when the file
 * has no XMP.
 *
 * @since 0.1.0
 * @category extraction
 */
export const jpegResult = (
  bytes: Uint8Array,
): Result.Result<Option.Option<JpegXmp>, XmpExtractError> =>
  catchExtract(() => {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return fail('Not a JPEG file');
    const app1 = Arr.map(
      Arr.filter(jpegSegments(bytes), (s) => s.marker === APP1),
      (s) => s.data,
    );
    const chunks = Arr.map(
      Arr.filter(app1, (d) => startsWith(d, EXTENSION)),
      extensionChunk,
    );
    return Option.map(
      Arr.findFirst(app1, (d) => startsWith(d, STANDARD)),
      (d) => {
        const standard = utf8(d.subarray(STANDARD.length));
        return { standard, extended: extended(standard, chunks) };
      },
    );
  });

/**
 * Reads the XMP of a JPEG file: `None` when the file has no XMP.
 *
 * @since 0.1.0
 * @category extraction
 */
export const jpeg = (bytes: Uint8Array): Effect.Effect<Option.Option<JpegXmp>, XmpExtractError> =>
  Effect.suspend(() => Effect.fromResult(jpegResult(bytes)));

// -----------------------------------------------------------------------------
// PNG
// -----------------------------------------------------------------------------

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const XMP_KEYWORD = 'XML:com.adobe.xmp';

interface PngChunk {
  readonly type: string;
  readonly data: Uint8Array;
}

const pngChunks = (bytes: Uint8Array): ReadonlyArray<PngChunk> => {
  const data = view(bytes);
  return Arr.unfold(PNG_SIGNATURE.length, (pos): Option.Option<readonly [PngChunk, number]> => {
    if (pos >= bytes.length) return Option.none();
    if (pos + 12 > bytes.length) return fail(`Truncated PNG chunk at offset ${pos}`);
    const length = data.getUint32(pos);
    const type = latin1(bytes.subarray(pos + 4, pos + 8));
    const end = pos + 12 + length;
    if (end > bytes.length) return fail(`Truncated PNG chunk at offset ${pos}`);
    if (type === 'IEND') return Option.none();
    return Option.some([{ type, data: bytes.subarray(pos + 8, pos + 8 + length) }, end]);
  });
};

/** The text of an XMP `iTXt` chunk: stored, or zlib-compressed. */
interface XmpChunk {
  readonly compressed: boolean;
  readonly text: Uint8Array;
}

/** The XMP of an `iTXt` chunk, when its keyword is XMP's. */
const xmpChunk = (chunk: Uint8Array): Option.Option<XmpChunk> => {
  const keywordEnd = chunk.indexOf(0);
  if (keywordEnd < 0 || latin1(chunk.subarray(0, keywordEnd)) !== XMP_KEYWORD) {
    return Option.none();
  }
  const compressed = chunk[keywordEnd + 1] !== 0;
  // Compression method 0 (zlib) is the only one PNG defines.
  if (compressed && chunk[keywordEnd + 2] !== 0) return fail('Unknown iTXt compression method');
  const languageEnd = chunk.indexOf(0, keywordEnd + 3);
  const translatedEnd = languageEnd < 0 ? -1 : chunk.indexOf(0, languageEnd + 1);
  if (translatedEnd < 0) return fail('Malformed iTXt chunk');
  return Option.some({ compressed, text: chunk.subarray(translatedEnd + 1) });
};

const pngXmpChunk = (bytes: Uint8Array): Option.Option<XmpChunk> => {
  if (!startsWith(bytes, PNG_SIGNATURE)) return fail('Not a PNG file');
  return Option.firstSomeOf(
    Arr.map(
      Arr.filter(pngChunks(bytes), (c) => c.type === 'iTXt'),
      (c) => xmpChunk(c.data),
    ),
  );
};

/** Inflates zlib data with the platform's `DecompressionStream`. */
const inflate = (data: Uint8Array): Effect.Effect<Uint8Array, XmpExtractError> =>
  Effect.tryPromise({
    try: async () =>
      new Uint8Array(
        await new Response(
          new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate')),
        ).arrayBuffer(),
      ),
    catch: () => new XmpExtractError({ message: 'Malformed compressed iTXt chunk' }),
  });

/**
 * Reads the XMP packet of a PNG file, returning a `Result`: `None` when the
 * file has no XMP. Decompression is asynchronous, so a compressed `iTXt`
 * chunk fails here; `png` inflates it. (The XMP specification writes the
 * chunk uncompressed, so a scanner can find the packet.)
 *
 * @since 0.1.0
 * @category extraction
 */
export const pngResult = (
  bytes: Uint8Array,
): Result.Result<Option.Option<string>, XmpExtractError> =>
  catchExtract(() =>
    Option.map(pngXmpChunk(bytes), (chunk) =>
      chunk.compressed
        ? fail('A compressed XMP iTXt chunk needs Extract.png, which inflates it')
        : utf8(chunk.text),
    ),
  );

/**
 * Reads the XMP packet of a PNG file: `None` when the file has no XMP. A
 * zlib-compressed `iTXt` chunk is inflated with the platform's
 * `DecompressionStream` (Node, browsers and Workers all provide it).
 *
 * @since 0.1.0
 * @category extraction
 */
export const png = (bytes: Uint8Array): Effect.Effect<Option.Option<string>, XmpExtractError> =>
  Effect.flatMap(
    Effect.suspend(() => Effect.fromResult(catchExtract(() => pngXmpChunk(bytes)))),
    Option.match({
      onNone: () => Effect.succeed(Option.none()),
      onSome: (chunk) =>
        chunk.compressed
          ? Effect.map(inflate(chunk.text), (text) => Option.some(utf8(text)))
          : Effect.succeed(Option.some(utf8(chunk.text))),
    }),
  );
