import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Tracer from 'effect/Tracer';
import { Turtle } from '../../src/turtle/index.ts';

// A tracer that records every span, so tests can assert names and attributes.
const traced = <A, E>(self: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const value = yield* Effect.withTracer(self, tracer);
    return { value, spans };
  });

const named = (spans: ReadonlyArray<Tracer.NativeSpan>, name: string) =>
  spans.find((span) => span.name === name);

describe('spans', () => {
  it.effect('Turtle.parse and Turtle.serialize', () =>
    Effect.gen(function* () {
      const { spans } = yield* traced(
        Effect.flatMap(Turtle.parse('<http://a/s> <http://a/p> 1, 2 .'), (r) =>
          Turtle.serialize(r.dataset),
        ),
      );
      expect(named(spans, 'Turtle.parse')?.attributes.get('rdf.quads')).toBe(2);
      expect(named(spans, 'Turtle.serialize')?.attributes.get('rdf.format')).toBe('Turtle');
    }),
  );
});
