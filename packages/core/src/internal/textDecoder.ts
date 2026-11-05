/**
 * Incremental, strict text decoding for the byte entry points of
 * `Serialization`. Validation is `TextDecoder`'s `fatal` mode; when it
 * rejects UTF-8, a binary search over prefixes finds the exact bad byte, so
 * the failure carries the line and column reached before it. A leading byte
 * order mark is dropped. Other charsets go through a fatal `TextDecoder` too,
 * with failures positioned at the start of the failing chunk.
 */
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Result from 'effect/Result';

/** Where decoding failed: a message, and the 1-based line and column of the bad input. */
export interface DecodeFailure {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

/** A stateful decoder: `push` each chunk in order, then `end`. */
export interface Decoder {
  /** Decodes a chunk; a sequence split across chunks is completed by the next one. */
  readonly push: (chunk: Uint8Array) => string | DecodeFailure;
  /** Flushes the decoder; fails if the input ended inside a sequence. */
  readonly end: () => string | DecodeFailure;
}

const isUtf8 = (charset: string): boolean => /^utf-?8$/i.test(charset.trim());

/** The byte at `i` from the end of `bytes` (1 is the last), if there is one. */
const fromEnd = (bytes: Uint8Array, i: number): Option.Option<number> =>
  Option.fromUndefinedOr(bytes[bytes.length - i]);

const isContinuation = (b: Option.Option<number>): boolean =>
  Option.exists(b, (byte) => byte >= 0x80 && byte < 0xc0);

// The length of the sequence a lead byte starts (1 for anything that is not a multi-byte lead).
const sequenceLength = (lead: Option.Option<number>): number =>
  Option.match(lead, {
    onNone: () => 1,
    onSome: (l) => (l < 0xc2 ? 1 : l < 0xe0 ? 2 : l < 0xf0 ? 3 : l < 0xf5 ? 4 : 1),
  });

/**
 * How many trailing bytes start a sequence the chunk does not finish (0–3):
 * they are held back for the next chunk. Whether they are well formed is
 * left to the decoder.
 */
const incompleteTail = (bytes: Uint8Array): number => {
  if (sequenceLength(fromEnd(bytes, 1)) > 1) return 1;
  if (sequenceLength(fromEnd(bytes, 2)) > 2 && isContinuation(fromEnd(bytes, 1))) return 2;
  if (
    sequenceLength(fromEnd(bytes, 3)) > 3 &&
    isContinuation(fromEnd(bytes, 2)) &&
    isContinuation(fromEnd(bytes, 1))
  )
    return 3;
  return 0;
};

const fatalUtf8 = (bytes: Uint8Array, stream: boolean): Result.Result<string, unknown> =>
  Result.try(() =>
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream }),
  );

/**
 * The length of the longest prefix of `bytes` with no ill-formed byte (an
 * incomplete sequence at its end is allowed), given that `bytes.subarray(0,
 * valid)` has none and `bytes.subarray(0, invalid)` has one.
 */
const validPrefix = (bytes: Uint8Array, valid: number, invalid: number): number => {
  if (invalid - valid <= 1) return valid;
  const mid = Math.floor((valid + invalid) / 2);
  return Result.isSuccess(fatalUtf8(bytes.subarray(0, mid), true))
    ? validPrefix(bytes, mid, invalid)
    : validPrefix(bytes, valid, mid);
};

class Position {
  line = 1;
  column = 1;
  advance(text: string): void {
    const lines = text.split('\n');
    const last = lines.at(-1) ?? '';
    if (lines.length === 1) this.column += last.length;
    else {
      this.line += lines.length - 1;
      this.column = last.length + 1;
    }
  }
  fail(message: string): DecodeFailure {
    return { message, line: this.line, column: this.column };
  }
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (a.byteLength === 0) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
};

const utf8Decoder = (): Decoder => {
  const position = new Position();
  let carry: Uint8Array = new Uint8Array(0);
  let atStart = true;
  // Drop a byte order mark at the very start of the input.
  const withoutBom = (text: string): string =>
    atStart && text.startsWith('﻿') ? text.slice(1) : text;
  const decode = (bytes: Uint8Array): string | DecodeFailure =>
    Result.match(fatalUtf8(bytes, false), {
      onSuccess: (text) => {
        const out = withoutBom(text);
        if (text !== '') atStart = false;
        position.advance(out);
        return out;
      },
      onFailure: () => {
        // Either the bytes end inside a sequence (a streaming decode accepts them) or one is bad.
        const bad = Result.isSuccess(fatalUtf8(bytes, true))
          ? bytes.length
          : validPrefix(bytes, 0, bytes.length);
        // The text before the bad byte: the valid prefix, without a sequence it leaves unfinished.
        position.advance(
          withoutBom(Result.getOrElse(fatalUtf8(bytes.subarray(0, bad), true), () => '')),
        );
        const byte = bytes[bad];
        return position.fail(
          byte === undefined
            ? 'Invalid UTF-8: the input ends inside a multi-byte sequence'
            : `Invalid UTF-8: byte 0x${byte.toString(16).padStart(2, '0')} cannot appear here`,
        );
      },
    });
  return {
    push: (chunk) => {
      const bytes = concat(carry, chunk);
      const complete = bytes.byteLength - incompleteTail(bytes);
      carry = bytes.slice(complete);
      return decode(bytes.subarray(0, complete));
    },
    end: () => (carry.byteLength === 0 ? '' : decode(carry)),
  };
};

const otherDecoder = (charset: string): Decoder => {
  const position = new Position();
  let text: Option.Option<TextDecoder> = Option.none();
  const run = (chunk: Option.Option<Uint8Array>): string | DecodeFailure =>
    Result.match(
      Result.try({
        try: () => {
          const decoder = Option.getOrElse(text, () => new TextDecoder(charset, { fatal: true }));
          text = Option.some(decoder);
          return Option.match(chunk, {
            onNone: () => decoder.decode(),
            onSome: (bytes) => decoder.decode(bytes, { stream: true }),
          });
        },
        catch: (error) =>
          error instanceof RangeError
            ? `Unsupported charset: ${charset}`
            : `Invalid ${charset}: the input is not well formed`,
      }),
      {
        onSuccess: (decoded) => {
          position.advance(decoded);
          return decoded;
        },
        onFailure: (message) => position.fail(message),
      },
    );
  return { push: (chunk) => run(Option.some(chunk)), end: () => run(Option.none()) };
};

/** A decoder for `charset` (default UTF-8). */
export const make = (charset: string = 'utf-8'): Decoder =>
  isUtf8(charset) ? utf8Decoder() : otherDecoder(charset);

/** Whether `push` / `end` failed. */
export const isFailure = (result: string | DecodeFailure): result is DecodeFailure =>
  !Predicate.isString(result);
