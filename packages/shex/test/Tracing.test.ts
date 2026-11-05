import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Tracer from 'effect/Tracer';
import { Dataset, Term } from '@thomasfosterau/effect-rdf';
import { ShExC, Validator } from '../src/index.ts';

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
  it.effect('ShEx.validate records associations and conformance', () =>
    Effect.gen(function* () {
      const schema = yield* ShExC.parse('<http://a/S> { <http://a/p> . }');
      const data = Dataset.make(
        Term.quad(Term.namedNode('http://a/x'), Term.namedNode('http://a/p'), Term.literal('o')),
      );
      const { spans } = yield* traced(
        Validator.validate(data, schema, [
          { node: Term.namedNode('http://a/x'), shape: 'http://a/S' },
          { node: Term.namedNode('http://a/y'), shape: 'http://a/S' },
        ]),
      );
      const span = named(spans, 'ShEx.validate');
      expect(span?.attributes.get('shex.associations')).toBe(2);
      expect(span?.attributes.get('shex.nonconformant')).toBe(1);
      expect(span?.attributes.get('shex.conformant')).toBe(false);
    }),
  );
});
