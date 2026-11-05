/**
 * A loop as a function: the cursor-driven scans of the engine, the
 * structural checks and the regular expression translator step a state
 * until it is done.
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';

/** Steps `f` from `initial` until it returns none. */
export const iterate = <S>(initial: S, f: (s: S) => Option.Option<S>): void => {
  Arr.unfold(initial, (s) => Option.map(f(s), (next) => [undefined, next] as const));
};
