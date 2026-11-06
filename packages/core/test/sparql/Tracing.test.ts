import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Tracer from 'effect/Tracer';
import * as Stream from 'effect/Stream';
import { Dataset, Term } from '@thomasfosterau/effect-rdf';
import { Engine, Store } from '../../src/sparql/index.ts';

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
  const data = Dataset.make(
    Term.quad(Term.namedNode('http://a/s'), Term.namedNode('http://a/p'), Term.literal('o')),
  );
  it.effect('SparqlEngine.query and update, without query text by default', () =>
    Effect.gen(function* () {
      const store = yield* Store.makeMemory(data);
      const engine = Engine.make(store);
      const { spans } = yield* traced(
        Effect.flatMap(engine.select('SELECT * WHERE { ?s ?p ?o }'), (r) =>
          Stream.runCollect(r.bindings),
        ),
      );
      const query = named(spans, 'SparqlEngine.query');
      expect(query?.attributes.get('sparql.query.form')).toBe('Select');
      expect(query?.attributes.has('sparql.query.text')).toBe(false);
      const update = yield* traced(engine.update('INSERT DATA { <http://a/x> <http://a/p> 1 }'));
      expect(
        named(update.spans, 'SparqlEngine.update')?.attributes.get('sparql.update.operations'),
      ).toBe(1);
      const verbose = Engine.make(store, { traceQueryText: true });
      const ask = yield* traced(verbose.ask('ASK {}'));
      expect(named(ask.spans, 'SparqlEngine.query')?.attributes.get('sparql.query.text')).toBe(
        'ASK {}',
      );
    }),
  );
});
