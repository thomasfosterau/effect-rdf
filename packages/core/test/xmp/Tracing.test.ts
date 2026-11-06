import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Tracer from 'effect/Tracer';
import { Xmp } from '../../src/xmp/index.ts';

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
  it.effect('Xmp.parse and Xmp.serialize', () =>
    Effect.gen(function* () {
      const xml =
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Description rdf:about="" dc:format="image/png"/></rdf:RDF></x:xmpmeta>';
      const { spans } = yield* traced(
        Effect.flatMap(Xmp.parse(xml), (r) => Xmp.serialize(r.dataset)),
      );
      expect(named(spans, 'Xmp.parse')?.attributes.get('rdf.quads')).toBe(1);
      expect(named(spans, 'Xmp.serialize')).toBeDefined();
    }),
  );
});
