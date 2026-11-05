import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Tracer from 'effect/Tracer';
import { Shapes, Validator } from '../src/index.ts';
import { parseTurtle } from './utils/turtle.ts';

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
  it.effect('Shacl.validate records shapes, results and conformance', () =>
    Effect.gen(function* () {
      const shapes = parseTurtle(
        '@prefix sh: <http://www.w3.org/ns/shacl#> . <http://a/S> a sh:NodeShape ; sh:targetNode <http://a/x> ; sh:property [ sh:path <http://a/p> ; sh:minCount 1 ] .',
      );
      const data = parseTurtle('<http://a/y> <http://a/p> 1 .');
      const { spans, value } = yield* traced(Validator.validate(data, shapes));
      const span = named(spans, 'Shacl.validate');
      expect(span?.attributes.get('shacl.conforms')).toBe(value.conforms);
      expect(span?.attributes.get('shacl.results')).toBe(1);
      expect(span?.attributes.get('shacl.shapes')).toBe(
        (yield* Shapes.parse(shapes)).shapes.length,
      );
    }),
  );
});
