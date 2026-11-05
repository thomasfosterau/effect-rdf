import { describe, expect, it } from '@effect/vitest';
import * as Arbitrary from 'effect/Arbitrary';
import * as Effect from 'effect/Effect';
import * as Equal from 'effect/Equal';
import * as Schema from 'effect/Schema';
import { Dataset, Iri, Isomorphism, LanguageTag, Term, Xsd } from '../src/index.ts';

const runs = { arbitrary: { runs: 100 } };

const relabel = (ds: Dataset.Dataset, prefix: string): Dataset.Dataset =>
  Dataset.map(ds, (q) =>
    Term.mapTerms(q, (t) => (Term.isBlankNode(t) ? Term.blankNode(`${prefix}${t.value}`) : t)),
  );

describe('Arbitrary', () => {
  it.effect('derives arbitraries for terms, ground terms, quads and datasets', () =>
    Effect.gen(function* () {
      const terms = yield* Arbitrary.sampleEffect(Arbitrary.schema(Term.TermSchema), { count: 50 });
      expect(terms.every(Term.isTerm)).toBe(true);
      const ground = yield* Arbitrary.sampleEffect(Arbitrary.schema(Term.GroundTermSchema), {
        count: 50,
      });
      expect(ground.every(Term.isGroundTerm)).toBe(true);
      const quads = yield* Arbitrary.sampleEffect(Arbitrary.schema(Term.QuadSchema), { count: 50 });
      expect(quads.every((q) => Term.isQuad(q) && Term.isWellFormed(q))).toBe(true);
      const datasets = yield* Arbitrary.sampleEffect(Arbitrary.schema(Dataset.DatasetSchema), {
        count: 20,
      });
      expect(datasets.every(Dataset.isDataset)).toBe(true);
      expect(datasets.some((ds) => ds.size > 1)).toBe(true);
    }),
  );

  it.prop(
    'generates realistic IRIs, language tags and lexical forms',
    { term: Term.TermSchema },
    ({ term }) => {
      if (Term.isNamedNode(term)) return Iri.isValid(term.value);
      if (Term.isLiteral(term)) {
        return term.language === ''
          ? Xsd.isValidLexical(term.datatype.value, term.value)
          : LanguageTag.isWellFormed(term.language);
      }
      return true;
    },
    runs,
  );

  it.prop(
    'Term.compare is a total order consistent with Equal',
    { a: Term.TermSchema, b: Term.TermSchema, c: Term.TermSchema },
    ({ a, b, c }) =>
      Term.compare(a, a) === 0 &&
      Term.compare(a, b) === -Term.compare(b, a) &&
      (Term.compare(a, b) === 0) === Equal.equals(a, b) &&
      (Term.compare(a, b) > 0 || Term.compare(b, c) > 0 || Term.compare(a, c) <= 0),
    runs,
  );

  it.prop(
    'isomorphism is invariant under blank-node relabelling',
    { ds: Dataset.DatasetSchema },
    ({ ds }) => Isomorphism.isomorphic(ds, relabel(ds, 'r')),
    runs,
  );

  it.prop(
    'datasets round-trip through their JSON codec',
    { ds: Dataset.DatasetSchema },
    ({ ds }) => {
      const codec = Schema.toCodecJson(Dataset.DatasetSchema);
      return Equal.equals(Schema.decodeSync(codec)(Schema.encodeSync(codec)(ds)), ds);
    },
    runs,
  );
});
