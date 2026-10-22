/**
 * XMP packets (ISO 16684-1 §7.3): finding `<?xpacket begin=… ?>` …
 * `<?xpacket end="w"?>` in arbitrary bytes, and wrapping serialized XMP in
 * a packet with the whitespace padding that lets a writer update it in
 * place.
 *
 * Packets are found in UTF-8, UTF-16BE and UTF-16LE, the encodings the
 * packet header's byte-order mark can announce and a byte scanner can
 * recognise without parsing the host file.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';

/**
 * The `id` attribute every packet header carries.
 *
 * @since 0.1.0
 * @category constants
 */
export const PACKET_ID = 'W5M0MpCehiHzreSzNTczkc9d';

/**
 * The padding a writable packet gets by default: 2 KiB, as the XMP
 * specification recommends.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_PADDING = 2048;

/**
 * The text encoding of a packet.
 *
 * @since 0.1.0
 * @category models
 */
export type Encoding = 'utf-8' | 'utf-16be' | 'utf-16le';

/**
 * A packet found in a byte sequence.
 *
 * @since 0.1.0
 * @category models
 */
export interface Packet {
  /** The byte offset of `<?xpacket begin`. */
  readonly offset: number;
  /** The byte length, through the end of the `<?xpacket end …?>` trailer. */
  readonly length: number;
  readonly encoding: Encoding;
  /** Whether the trailer is `end="w"` (the packet may be updated in place). */
  readonly writable: boolean;
  /** The decoded packet, header to trailer. */
  readonly text: string;
}

/**
 * The parts of a packet's text.
 *
 * @since 0.1.0
 * @category models
 */
export interface Unwrapped {
  /** The serialized XMP between the header and the padding. */
  readonly xml: string;
  /** The number of whitespace characters of padding before the trailer. */
  readonly padding: number;
  readonly writable: boolean;
}

const HEADER = '<?xpacket begin=';
const TRAILER = '<?xpacket end=';
const PI_END = '?>';

const ENCODINGS: ReadonlyArray<Encoding> = ['utf-8', 'utf-16be', 'utf-16le'];

const encodeAscii = (text: string, encoding: Encoding): Uint8Array => {
  const codes = Arr.map(Arr.fromIterable(text), (c) => c.charCodeAt(0));
  return Uint8Array.from(
    encoding === 'utf-8'
      ? codes
      : Arr.flatMap(codes, (c) => (encoding === 'utf-16be' ? [0, c] : [c, 0])),
  );
};

// windows-1252 decodes every byte to exactly one UTF-16 code unit, so a
// string search over the decoded bytes finds byte offsets natively.
const bytesToString = (bytes: Uint8Array): string => new TextDecoder('windows-1252').decode(bytes);

const marker = (text: string, encoding: Encoding): string =>
  bytesToString(encodeAscii(text, encoding));

const indexIn = (haystack: string, needle: string, from: number): Option.Option<number> => {
  const i = haystack.indexOf(needle, from);
  return i < 0 ? Option.none() : Option.some(i);
};

const isWritable = (text: string, trailer: number): boolean =>
  text.charAt(trailer + TRAILER.length + 1) === 'w';

const findIn = (bytes: Uint8Array, haystack: string, from: number): Option.Option<Packet> => {
  const starts = Arr.getSomes(
    Arr.map(ENCODINGS, (encoding) =>
      Option.map(indexIn(haystack, marker(HEADER, encoding), from), (offset) => ({
        offset,
        encoding,
      })),
    ),
  );
  const first = Arr.head(
    Arr.sort(
      starts,
      Order.mapInput(Order.Number, (s: { readonly offset: number }) => s.offset),
    ),
  );
  return Option.flatMap(first, ({ offset, encoding }) => {
    const width = encoding === 'utf-8' ? 1 : 2;
    const end = Option.flatMap(
      indexIn(haystack, marker(TRAILER, encoding), offset + HEADER.length * width),
      (trailer) =>
        Option.map(
          indexIn(haystack, marker(PI_END, encoding), trailer + TRAILER.length * width),
          (close) => close + PI_END.length * width,
        ),
    );
    // A header with no trailer after it is not a packet, and neither is any
    // later header.
    return Option.map(end, (close): Packet => {
      const text = new TextDecoder(encoding).decode(bytes.subarray(offset, close));
      return {
        offset,
        length: close - offset,
        encoding,
        writable: isWritable(text, text.lastIndexOf(TRAILER)),
        text,
      };
    });
  });
};

/**
 * Finds the first packet at or after `fromIndex` in a byte sequence: a file
 * of any format, scanned without parsing it (ISO 16684-1 §7.3.2's packet
 * scanning).
 *
 * @since 0.1.0
 * @category scanning
 */
export const find = (bytes: Uint8Array, fromIndex: number = 0): Option.Option<Packet> =>
  findIn(bytes, bytesToString(bytes), fromIndex);

/**
 * Finds every packet in a byte sequence, in order.
 *
 * @since 0.1.0
 * @category scanning
 */
export const findAll = (bytes: Uint8Array): ReadonlyArray<Packet> => {
  const haystack = bytesToString(bytes);
  return Arr.unfold(0, (from) =>
    Option.map(findIn(bytes, haystack, from), (p) => [p, p.offset + p.length] as const),
  );
};

/**
 * Splits a packet's text into the serialized XMP, the padding and the
 * writability of its trailer. Returns `None` when the text is not a packet.
 *
 * @since 0.1.0
 * @category parsing
 */
export const unwrap = (text: string): Option.Option<Unwrapped> =>
  Option.flatMap(indexIn(text, HEADER, 0), (start) =>
    Option.flatMap(indexIn(text, PI_END, start), (headerEnd) => {
      const trailer = text.lastIndexOf(TRAILER);
      if (trailer < headerEnd) return Option.none();
      const content = text.slice(headerEnd + PI_END.length, trailer).replace(/^\r?\n/, '');
      const xml = content.trimEnd();
      return Option.some({
        xml,
        padding: content.length - xml.length,
        writable: isWritable(text, trailer),
      });
    }),
  );

/**
 * Options for wrapping serialized XMP in a packet.
 *
 * @since 0.1.0
 * @category models
 */
export interface WrapOptions {
  /**
   * Bytes of whitespace padding before the trailer. Defaults to
   * `DEFAULT_PADDING` for a writable packet and 0 for a read-only one.
   */
  readonly padding?: number | undefined;
  /** Whether the trailer is `end="w"` rather than `end="r"`. Defaults to `true`. */
  readonly writable?: boolean | undefined;
}

const header = `<?xpacket begin="﻿" id="${PACKET_ID}"?>\n`;
const trailerOf = (writable: boolean) => `<?xpacket end="${writable ? 'w' : 'r'}"?>`;

/**
 * Whitespace padding of exactly `bytes` bytes: lines of 99 spaces and a
 * newline, as XMP writers lay it out.
 *
 * @since 0.1.0
 * @category serializing
 */
export const padding = (bytes: number): string => {
  const lines = Math.floor(bytes / 100);
  return `${`${' '.repeat(99)}\n`.repeat(lines)}${' '.repeat(bytes - lines * 100)}`;
};

const body = (xml: string) => (xml.endsWith('\n') ? xml : `${xml}\n`);

/**
 * Wraps serialized XMP (an `<x:xmpmeta>` element) in a UTF-8 packet.
 *
 * @since 0.1.0
 * @category serializing
 */
export const wrap = (xml: string, options?: WrapOptions): string => {
  const writable = options?.writable ?? true;
  const pad = options?.padding ?? (writable ? DEFAULT_PADDING : 0);
  return `${header}${body(xml)}${padding(pad)}${trailerOf(writable)}`;
};

/**
 * The UTF-8 byte length of a string.
 *
 * @since 0.1.0
 * @category serializing
 */
export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Wraps serialized XMP in a UTF-8 packet of exactly `size` bytes, padding the
 * difference: how an XMP packet is updated in place in a file. Returns
 * `None` when the XMP does not fit.
 *
 * @since 0.1.0
 * @category serializing
 */
export const wrapToSize = (
  xml: string,
  size: number,
  options?: { readonly writable?: boolean | undefined },
): Option.Option<string> => {
  const writable = options?.writable ?? true;
  const fixed = byteLength(`${header}${body(xml)}${trailerOf(writable)}`);
  return fixed > size ? Option.none() : Option.some(wrap(xml, { writable, padding: size - fixed }));
};
