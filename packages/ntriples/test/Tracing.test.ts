import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Tracer from 'effect/Tracer';
import * as Stream from 'effect/Stream';
import { NQuads, NTriples } from '../src/index.ts';

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
  it.effect('NTriples.parse / serialize, NQuads.parseStream', () =>
    Effect.gen(function* () {
      const input = '<http://a/s> <http://a/p> "o" .\n';
      const { spans } = yield* traced(
        Effect.flatMap(NTriples.parse(input), (r) => NTriples.serialize(r.dataset)),
      );
      const parse = named(spans, 'NTriples.parse');
      expect(parse?.attributes.get('rdf.format')).toBe('N-Triples');
      expect(parse?.attributes.get('rdf.input.length')).toBe(input.length);
      expect(parse?.attributes.get('rdf.quads')).toBe(1);
      expect(named(spans, 'NTriples.serialize')?.attributes.get('rdf.output.length')).toBe(
        input.length,
      );
      const stream = yield* traced(Stream.runCollect(NQuads.parseStream(Stream.make(input))));
      expect(named(stream.spans, 'NQuads.parseStream')?.attributes.get('rdf.media_type')).toBe(
        'application/n-quads',
      );
    }),
  );
});
