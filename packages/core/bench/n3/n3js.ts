/**
 * Compares the N3 parser with N3.js (the `n3` package, a devDependency for
 * this file only) on the same synthetic document (effect-rdf#73).
 *
 *   node --experimental-strip-types bench/n3/n3js.ts
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Order from 'effect/Order';
import * as N3js from 'n3';
import * as N3 from '../../src/n3/N3.ts';
import { big } from './synthetic.ts';

const baseIri = 'http://example.org/';

/** The median of nine timed runs, after three to warm up. */
const median = (run: () => void): number => {
  Arr.makeBy(3, run);
  const samples = Arr.makeBy(9, () => {
    const t = performance.now();
    run();
    return performance.now() - t;
  });
  return Arr.sort(samples, Order.Number)[4] ?? 0;
};

const report = (name: string, ms: number) => {
  console.log(
    `${name}: ${(big.length / 1e6).toFixed(2)} MB, median ${ms.toFixed(0)} ms` +
      ` (${(big.length / 1e3 / ms).toFixed(1)} MB/s)`,
  );
};

report(
  'effect-rdf N3.parse',
  median(() => {
    Effect.runSync(N3.parse(big, { baseIri }));
  }),
);
report(
  'N3.js Parser (text/n3)',
  median(() => {
    new N3js.Parser({ format: 'text/n3', baseIRI: baseIri }).parse(big);
  }),
);
