import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Tracer from 'effect/Tracer';
import { N3, Reasoner } from '../../src/n3/index.ts';

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
  it.effect('N3.parse and Reasoner.reason', () =>
    Effect.gen(function* () {
      const { spans } = yield* traced(
        Effect.flatMap(
          N3.parse('@prefix : <http://a/> . :x a :Man . { ?x a :Man } => { ?x a :Mortal } .'),
          (doc) => Reasoner.reason(doc),
        ),
      );
      expect(named(spans, 'N3.parse')?.attributes.get('n3.statements')).toBe(2);
      expect(named(spans, 'Reasoner.reason')?.attributes.get('n3.statements')).toBe(3);
    }),
  );
});
