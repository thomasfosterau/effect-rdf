import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Tracer from 'effect/Tracer';
import { RdfJson } from '../../src/rdfjson/index.ts';

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
  it.effect('RdfJson.parse and RdfJson.serialize', () =>
    Effect.gen(function* () {
      const json = '{"http://a/s": {"http://a/p": [{"type": "literal", "value": "o"}]}}';
      const { spans } = yield* traced(
        Effect.flatMap(RdfJson.parse(json), (r) => RdfJson.serialize(r.dataset)),
      );
      expect(named(spans, 'RdfJson.parse')?.attributes.get('rdf.quads')).toBe(1);
      expect(named(spans, 'RdfJson.serialize')).toBeDefined();
    }),
  );
});
