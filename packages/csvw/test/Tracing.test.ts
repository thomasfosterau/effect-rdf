import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Tracer from 'effect/Tracer';
import { Csv2Json, Csv2Rdf, Processor } from '../src/index.ts';

// A tracer that records every span, so tests can assert names and attributes.
const traced = <A, E, R>(self: Effect.Effect<A, E, R>) =>
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

const loader = Processor.makeLoader([
  {
    url: 'http://example.org/t.csv',
    rows: [
      ['a', 'b'],
      ['1', '2'],
    ],
  },
]);

describe('spans', () => {
  it.effect('Processor.fromTabular, Csv2Rdf.convert and Csv2Json.convert', () =>
    Effect.gen(function* () {
      const { spans } = yield* traced(
        Effect.flatMap(Processor.fromTabular('http://example.org/t.csv'), ({ group }) =>
          Effect.zip(Csv2Rdf.convert(group, { mode: 'minimal' }), Csv2Json.convert(group)),
        ),
      );
      expect(named(spans, 'Processor.fromTabular')).toBeDefined();
      expect(named(spans, 'Csv2Rdf.convert')?.attributes.get('rdf.quads')).toBe(2);
      expect(named(spans, 'Csv2Json.convert')).toBeDefined();
    }).pipe(Effect.provideService(Processor.Loader, loader)),
  );
});
