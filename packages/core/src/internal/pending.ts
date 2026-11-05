/**
 * The quads of the datasets whose quad set has not been built yet
 * (`Dataset.fromIterable` builds it on first use), shared by `Dataset` and
 * the tracing in `Serialization`, which counts them without building it.
 *
 * @internal
 */
import type * as Term from '../Term.ts';

/** @internal */
export const pendingQuads: WeakMap<object, ReadonlyArray<Term.Quad>> = new WeakMap();

/**
 * How many statements a dataset was made from: its size, or for one not yet
 * built, the number of quads given (counting any duplicates).
 *
 * @internal
 */
export const statementCount = (dataset: { readonly size: number }): number =>
  pendingQuads.get(dataset)?.length ?? dataset.size;
