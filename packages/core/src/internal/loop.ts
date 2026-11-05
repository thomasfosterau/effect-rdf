/**
 * A loop as a function, for the scans and searches that step a cursor until
 * a condition holds (hashing a string, probing a hash table, walking a list,
 * a depth-first search).
 *
 * @internal
 */
import * as Iterable from 'effect/Iterable';

const BLOCK = 1024;

/** `0 … BLOCK - 1`: the steps of one block run as an array scan, which engines optimise well. */
const offsets: ReadonlyArray<number> = Array.from({ length: BLOCK }, (_, i) => i);

/** The first step of each block after the first: `BLOCK, 2 * BLOCK, …`. */
const blocks: Iterable<number> = Iterable.makeBy((b) => (b + 1) * BLOCK);

/** Calls `step` with 0, 1, 2, … until it returns `false`. */
export const loop = (step: (i: number) => boolean): void => {
  // Most loops end within the first block, which needs no iterator
  if (offsets.every((i) => step(i))) {
    Iterable.some(blocks, (base) => offsets.some((i) => !step(base + i)));
  }
};
