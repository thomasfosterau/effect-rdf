/**
 * Benchmarks the N3 parser on every `.n3` and `.ttl` file in the W3C N3
 * test suites, and on a large synthetic document.
 *
 *   node --experimental-strip-types bench/n3.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Order from 'effect/Order';
import * as N3 from '../../src/n3/N3.ts';
import { big } from './synthetic.ts';

const suites =
  process.env.RDF_TEST_SUITES ?? path.resolve(import.meta.dirname, '../../../../.test-suites');

const walk = (dir: string): Array<string> =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      })
    : [];

const docs = walk(path.join(suites, 'N3'))
  .filter((f) => f.endsWith('.n3') || f.endsWith('.ttl'))
  .map((f) => ({ text: fs.readFileSync(f, 'utf8'), baseIri: `file://${f}` }));

const bench = (name: string, inputs: ReadonlyArray<{ text: string; baseIri: string }>) => {
  const size = inputs.reduce((n, d) => n + d.text.length, 0);
  const run = () => {
    inputs.forEach((d) => Effect.runSync(Effect.result(N3.parse(d.text, { baseIri: d.baseIri }))));
  };
  Arr.makeBy(3, run);
  const samples = Arr.makeBy(9, () => {
    const t = performance.now();
    run();
    return performance.now() - t;
  });
  const sorted = Arr.sort(samples, Order.Number);
  const median = sorted[Math.floor(samples.length / 2)] ?? 0;
  // oxlint-disable-next-line no-console -- benchmark output
  console.log(
    `${name}: ${inputs.length} docs, ${(size / 1e6).toFixed(2)} MB, median ${median.toFixed(0)} ms` +
      ` (${(size / 1e3 / median).toFixed(1)} MB/s)`,
  );
};

bench('N3 suite', docs);
bench('synthetic', [{ text: big, baseIri: 'http://example.org/' }]);
