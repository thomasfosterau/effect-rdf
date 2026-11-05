import { assert, describe, expect, it, layer } from '@effect/vitest';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as Sink from 'effect/Sink';
import * as Stream from 'effect/Stream';
import { Dataset, PrefixMap, Serialization, Term } from '../src/index.ts';

// A toy syntax: the whole document becomes the object of one quad, so tests can see exactly the
// text the byte decoder produced (and the base IRI it was parsed against).
const format = Serialization.makeFormat({
  name: 'Text',
  mediaType: 'text/x-test',
  extensions: ['txt'],
  datasets: false,
});
const text = Term.namedNode('urn:text');
const parser = Serialization.makeParser({
  format,
  parse: (input, options) =>
    Effect.succeed({
      dataset: Dataset.make(
        Term.quad(Term.namedNode(options?.baseIri ?? 'urn:base'), text, Term.literal(input)),
      ),
      prefixes: PrefixMap.empty,
      baseIri: options?.baseIri,
    }),
});
const serializer = Serialization.makeSerializer({
  format,
  serialize: (quads) =>
    Effect.succeed(
      Array.from(quads, (q) => (Term.isLiteral(q.object) ? q.object.value : '')).join(''),
    ),
});

const objectText = (q: Term.Quad): string => (Term.isLiteral(q.object) ? q.object.value : '');

const encoder = new TextEncoder();
const bytes = (s: string): Uint8Array => encoder.encode(s);
const chunks = (all: Uint8Array, ...cuts: ReadonlyArray<number>): ReadonlyArray<Uint8Array> =>
  [0, ...cuts, all.length]
    .slice(0, -1)
    .map((start, i) => all.subarray(start, [...cuts, all.length][i]));

const decoded = (input: ReadonlyArray<Uint8Array>, charset?: string) =>
  Stream.runCollect(
    Serialization.parseBytes(
      parser,
      Stream.fromIterable(input),
      charset === undefined ? {} : { charset },
    ),
  ).pipe(Effect.map((quads) => Array.from(quads, objectText).join('')));

describe('Serialization bytes', () => {
  it.effect('decodes multi-byte UTF-8 split across every chunk boundary', () =>
    Effect.gen(function* () {
      const source = 'aé€😀\nz';
      const all = bytes(source);
      const cuts = Array.from({ length: all.length - 1 }, (_, i) => i + 1);
      const results = yield* Effect.forEach(cuts, (cut) => decoded(chunks(all, cut)), {
        concurrency: 1,
      });
      expect(results.filter((r) => r !== source)).toStrictEqual([]);
      expect(yield* decoded(Array.from(all, (b) => Uint8Array.of(b)))).toBe(source);
    }),
  );

  it.effect('strips a byte order mark, even one split across chunks', () =>
    Effect.gen(function* () {
      const all = Uint8Array.of(0xef, 0xbb, 0xbf, ...bytes('hi'));
      expect(yield* decoded([all])).toBe('hi');
      expect(yield* decoded(chunks(all, 1, 2))).toBe('hi');
      expect(yield* decoded([Uint8Array.of(0xef, 0xbb, 0xbf)])).toBe('');
    }),
  );

  it.effect('fails on invalid UTF-8 with the position of the bad byte', () =>
    Effect.gen(function* () {
      const bad = Uint8Array.of(...bytes('ab\ncd'), 0xff, ...bytes('e'));
      const error = yield* Effect.flip(decoded(chunks(bad, 2)));
      expect(error).toMatchObject({ _tag: 'RdfParseError', format: 'Text', line: 2, column: 3 });
      expect(error.message).toContain('0xff');
      // An overlong encoding, a surrogate, and a sequence cut off by the end of the input.
      expect((yield* Effect.flip(decoded([Uint8Array.of(0xc0, 0x80)]))).column).toBe(1);
      expect((yield* Effect.flip(decoded([Uint8Array.of(0x61, 0xed, 0xa0, 0x80)]))).column).toBe(2);
      const truncated = yield* Effect.flip(decoded([Uint8Array.of(0x61, 0xe2, 0x82)]));
      expect(truncated.message).toContain('ends inside');
      expect(truncated.column).toBe(2);
      expect((yield* Effect.flip(decoded([Uint8Array.of(0xef, 0xbb)]))).message).toContain(
        'ends inside',
      );
    }),
  );

  it.effect('decodes other charsets through TextDecoder', () =>
    Effect.gen(function* () {
      expect(yield* decoded([Uint8Array.of(0x63, 0x61, 0x66, 0xe9)], 'iso-8859-1')).toBe('café');
      expect(yield* decoded([Uint8Array.of(0x68, 0x00, 0x69, 0x00)], 'utf-16le')).toBe('hi');
      const error = yield* Effect.flip(decoded([bytes('x')], 'no-such-charset'));
      expect(error.message).toContain('Unsupported charset');
      const invalid = yield* Effect.flip(decoded([Uint8Array.of(0x00, 0xd8)], 'utf-16le'));
      expect(invalid.message).toContain('not well formed');
    }),
  );

  it.effect('parseBytesDocument and serializeBytes', () =>
    Effect.gen(function* () {
      const result = yield* Serialization.parseBytesDocument(parser, bytes('﻿doc'));
      expect(Array.from(result.dataset, objectText)).toStrictEqual(['doc']);
      const error = yield* Effect.flip(
        Serialization.parseBytesDocument(parser, Uint8Array.of(0xe2)),
      );
      expect(error.message).toContain('ends inside');
      const out = yield* Stream.runCollect(
        Serialization.serializeBytes(serializer, [Term.quad(text, text, Term.literal('é'))]),
      );
      expect(new TextDecoder().decode(out[0])).toBe('é');
    }),
  );
});

const files = MutableHashMap.empty<string, Uint8Array>();
const fileSystem = FileSystem.layerNoop({
  readFile: (path) =>
    Effect.succeed(Option.getOrElse(MutableHashMap.get(files, path), () => new Uint8Array(0))),
  sink: (path) =>
    Sink.forEach((chunk: Uint8Array) => Effect.sync(() => MutableHashMap.set(files, path, chunk))),
});
const withFormats = Effect.provideService(Serialization.Formats, {
  parsers: [parser],
  serializers: [serializer],
});
const firstQuad = (result: Serialization.ParseResult): Option.Option<Term.Quad> =>
  Arr.head(Arr.fromIterable(result.dataset));

layer(Layer.mergeAll(fileSystem, Path.layer))('Serialization files', (withFiles) => {
  withFiles.effect('writes and reads a file, choosing the syntax by extension', () =>
    Effect.gen(function* () {
      yield* Serialization.writeFile('/data/a.txt', [Term.quad(text, text, Term.literal('saved'))]);
      const result = yield* Serialization.readFile('/data/a.txt');
      expect(Option.map(firstQuad(result), objectText)).toStrictEqual(Option.some('saved'));
      // Relative IRIs resolve against the file's URL.
      expect(Option.map(firstQuad(result), (q) => q.subject.key)).toStrictEqual(
        Option.some('<file:///data/a.txt>'),
      );
      expect(result.baseIri).toBe('file:///data/a.txt');
    }).pipe(withFormats),
  );

  withFiles.effect('takes an explicit parser or media type, and fails for unknown extensions', () =>
    Effect.gen(function* () {
      MutableHashMap.set(files, '/x.bin', bytes('raw'));
      const explicit = yield* Serialization.readFile('/x.bin', { parser, baseIri: 'urn:b' });
      expect(Option.map(firstQuad(explicit), (q) => q.subject.key)).toStrictEqual(
        Option.some('<urn:b>'),
      );
      const byType = yield* Serialization.readFile('/x.bin', { mediaType: 'text/x-test' }).pipe(
        withFormats,
      );
      expect(byType.dataset.size).toBe(1);
      const unknown = yield* Effect.exit(Serialization.readFile('/x.bin'));
      assert(Exit.isFailure(unknown));
      const noWriter = yield* Effect.flip(Serialization.writeFile('/out.bin', []));
      expect(noWriter._tag).toBe('RdfSerializeError');
      yield* Serialization.writeFile('/out.bin', [], { serializer });
    }),
  );
});
