import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Tracer from 'effect/Tracer';
import { RdfXml } from '../../src/rdfxml/index.ts';

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
  it.effect('RdfXml.parse and RdfXml.serialize', () =>
    Effect.gen(function* () {
      const xml =
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:p="http://a/"><rdf:Description rdf:about="http://a/s"><p:p>o</p:p></rdf:Description></rdf:RDF>';
      const { spans } = yield* traced(
        Effect.flatMap(RdfXml.parse(xml), (r) => RdfXml.serialize(r.dataset)),
      );
      expect(named(spans, 'RdfXml.parse')?.attributes.get('rdf.quads')).toBe(1);
      expect(named(spans, 'RdfXml.serialize')).toBeDefined();
    }),
  );
});
