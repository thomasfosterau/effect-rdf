/**
 * Runs an effect with the services of a layer that is built for that one run:
 * the layer gets a scope of its own, closed when the effect completes, so each
 * call starts from fresh services (an empty store, a new server) and nothing
 * outlives it. Tests use it where the layer depends on per-test data.
 */
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

export const withLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(effect, context)),
    );
