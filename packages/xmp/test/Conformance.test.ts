/**
 * Reads the XMP of every PDF in veraPDF's PDF/A and PDF/UA corpus
 * (`veraPDF-corpus`, its metadata sections; `scripts/fetch-test-suites.sh`).
 * PDF/A forbids a filter on the metadata stream, so `Packet.findAll` finds the
 * packet in the file's bytes. Skipped when the corpus is not present.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, describe, expect, it } from '@effect/vitest';
import * as Arr from 'effect/Array';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import { Packet, PdfA, Xmp } from '../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = process.env['RDF_TEST_SUITES'] ?? path.resolve(here, '../../../.test-suites');
const corpus = path.join(suites, 'veraPDF-corpus');
const exists = fs.existsSync(corpus);

const walk = (dir: string): Array<string> =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? (e.name === '.git' ? [] : walk(p)) : [p];
  });

const files = exists ? walk(corpus).filter((f) => f.endsWith('.pdf')) : [];
const isPass = (f: string) => /-pass-/.test(path.basename(f));
const passing = files.filter(isPass);
const failing = files.filter((f) => !isPass(f));

/** The last packet of a file: an incremental update appends the newer one. */
const lastPacket = (file: string) =>
  Arr.last(Packet.findAll(new Uint8Array(fs.readFileSync(file))));

/** The PDF/A part a corpus section tests (`PDF_A-2b/…`, `Isartor test files/PDFA-1b/…`). */
const sectionPart = (file: string): Option.Option<number> =>
  Option.map(Option.fromNullishOr(/PDF_?A-(\d)/.exec(path.relative(corpus, file))), (m) =>
    Number(m[1]),
  );

describe.skipIf(!exists)('veraPDF corpus', () => {
  it('has the metadata sections', () => {
    expect(passing.length).toBeGreaterThan(400);
  });

  const read = (file: string) => {
    const packet = lastPacket(file);
    assert(Option.isSome(packet), 'no XMP packet');
    return Effect.runSyncExit(Xmp.parseMetadata(packet.value.text));
  };

  it.each(passing.map((f) => [path.relative(corpus, f), f] as const))(
    'reads the XMP of %s',
    (_, file) => {
      expect(Exit.isSuccess(read(file))).toBe(true);
    },
  );

  it.each(
    passing
      .filter((f) => f.includes('identification'))
      .map((f) => [path.relative(corpus, f), f] as const),
  )('reads the PDF/A identification of %s', (_, file) => {
    const exit = read(file);
    assert(Exit.isSuccess(exit));
    expect(Option.map(PdfA.identification(exit.value), (id) => id.part)).toEqual(sectionPart(file));
  });

  it('fails a malformed packet with an error, never a defect', () => {
    const defects = failing.filter((file) =>
      Option.match(lastPacket(file), {
        onNone: () => false,
        onSome: (p) => {
          const exit = Effect.runSyncExit(Xmp.parseMetadata(p.text));
          return Exit.isFailure(exit) && Cause.hasDies(exit.cause);
        },
      }),
    );
    expect(defects).toEqual([]);
  });
});
