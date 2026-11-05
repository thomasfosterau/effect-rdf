import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Tracer from 'effect/Tracer';
import { DocumentLoader, JsonLd } from '../src/index.ts';

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
  it.effect('JsonLd.parse and DocumentLoader.load', () =>
    Effect.gen(function* () {
      const doc = '{"@id": "http://a/s", "http://a/p": "o"}';
      const { spans } = yield* traced(JsonLd.parse(doc));
      expect(named(spans, 'JsonLd.parse')?.attributes.get('rdf.quads')).toBe(1);
      const loader = DocumentLoader.fromFetch((url) =>
        Effect.succeed({ url, status: 200, contentType: 'application/ld+json', body: doc }),
      );
      const loaded = yield* traced(loader.load('http://a/doc'));
      expect(named(loaded.spans, 'DocumentLoader.load')?.attributes.get('url.full')).toBe(
        'http://a/doc',
      );
    }),
  );
});
