/**
 * A loop as a function, for the line parser's scans through escapes (runs
 * of plain characters are skipped with sticky patterns).
 *
 * @internal
 */
import * as Iterable from 'effect/Iterable';

const naturals: Iterable<number> = Iterable.makeBy((i) => i);

/** Calls `step` until it returns `false`. */
export const loop = (step: () => boolean): void => {
  Iterable.some(naturals, () => !step());
};
