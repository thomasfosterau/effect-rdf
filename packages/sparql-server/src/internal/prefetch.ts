import * as Cause from 'effect/Cause';
import * as Data from 'effect/Data';
import type * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Option from 'effect/Option';
import * as Queue from 'effect/Queue';
import * as Stream from 'effect/Stream';

/** Raised when a query exceeds its time limit. */
export class QueryTimeout extends Data.TaggedError('QueryTimeout')<{}> {}

/**
 * Starts evaluating a stream in the background and waits for its first
 * element (or its end or failure), so that errors raised before the first
 * result — and a timeout — can still be answered with a proper HTTP status.
 * The returned stream yields every element; the whole evaluation is limited
 * by `timeout` when given.
 */
export const prefetch = <A, E>(
  stream: Stream.Stream<A, E>,
  timeout: Duration.Duration | undefined,
): Effect.Effect<Stream.Stream<A, E | QueryTimeout>, E | QueryTimeout> =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<A, E | QueryTimeout | Cause.Done>(256);
    const run = Stream.runIntoQueue(stream, queue);
    const limited =
      timeout === undefined
        ? run
        : Effect.timeoutOrElse(run, {
            duration: timeout,
            orElse: () => Queue.fail(queue, new QueryTimeout()),
          });
    const fiber = yield* Effect.forkDetach(limited);
    const first = yield* Queue.take(queue).pipe(
      Effect.map(Option.some),
      Effect.catchIf(Cause.isDone, () => Effect.succeed(Option.none<A>())),
      Effect.onError(() => Fiber.interrupt(fiber)),
    );
    if (Option.isNone(first)) return Stream.empty;
    return Stream.concat(Stream.succeed(first.value), Stream.fromQueue(queue)).pipe(
      Stream.ensuring(Fiber.interrupt(fiber)),
    ) as Stream.Stream<A, E | QueryTimeout>;
  });
