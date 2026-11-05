/**
 * Result comparison for the conformance tests: result sets are compared up
 * to blank node renaming (by encoding them as RDF graphs and using graph
 * isomorphism), optionally respecting order.
 */
import * as Arr from 'effect/Array';
import * as Iterable from 'effect/Iterable';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import { Dataset, Isomorphism, Term, Xsd } from '@thomasfosterau/effect-rdf';
import type { Bindings } from '../../src/Bindings.ts';
import * as B from '../../src/Bindings.ts';
import type * as Results from '../../src/Results.ts';

const RS = 'http://www.w3.org/2001/sw/DataAccess/tests/result-set#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

/** Numeric literals are compared by value (canonical form). */
export const normalize = (t: Term.GroundTerm): Term.GroundTerm =>
  Term.isLiteral(t) && Xsd.isNumericDatatype(t.datatype.value) ? Xsd.canonicalize(t) : t;

// Makes every encoded row's blank node label unique.
let encoded = 0;

/** Encodes solutions as a graph: one fresh blank node per row. */
const encode = (bindings: ReadonlyArray<Bindings>, ordered: boolean): Dataset.Dataset => {
  const quads: Array<Term.Quad> = [];
  bindings.forEach((b, i) => {
    const row = Term.blankNode(`row${i}_${encoded++}`);
    quads.push(Term.quad(row, Term.namedNode('urn:row'), Term.literal(ordered ? String(i) : 'x')));
    Iterable.forEach(b, ([k, v]) =>
      quads.push(Term.quad(row, Term.namedNode(`urn:var:${k}`), normalize(v))),
    );
  });
  return Dataset.fromIterable(quads);
};

const dedupeBindings = (bs: ReadonlyArray<Bindings>) => {
  const seen = MutableHashMap.empty<string, Bindings>();
  bs.forEach((b) => MutableHashMap.set(seen, b.key, b));
  return Array.from(MutableHashMap.values(seen));
};

export const sameResults = (
  actual: ReadonlyArray<Bindings>,
  expected: ReadonlyArray<Bindings>,
  options: { readonly ordered?: boolean; readonly lax?: boolean } = {},
): boolean => {
  if (options.lax) {
    return sameResults(dedupeBindings(actual), dedupeBindings(expected));
  }
  if (actual.length !== expected.length) return false;
  return Isomorphism.isomorphic(
    encode(actual, options.ordered ?? false),
    encode(expected, options.ordered ?? false),
  );
};

/** A literal's value (`rs:resultVariable`, `rs:variable` and `rs:index` values are literals). */
const literalValue = (t: Option.Option<Term.Term>): string =>
  Option.match(Option.filter(t, Term.isLiteral), { onNone: () => '', onSome: (l) => l.value });

/** Reads a result set (or boolean) encoded with the `rs:` vocabulary. */
export const fromRdf = (quads: ReadonlyArray<Term.Quad>): Results.ParsedResult | undefined => {
  const bySubject = MutableHashMap.empty<string, Array<Term.Quad>>();
  quads.forEach((q) =>
    Option.match(MutableHashMap.get(bySubject, q.subject.key), {
      onNone: () => MutableHashMap.set(bySubject, q.subject.key, [q]),
      onSome: (l) => l.push(q),
    }),
  );
  const objects = (s: Term.Term, p: string) =>
    Option.getOrElse(MutableHashMap.get(bySubject, s.key), () => [])
      .filter((q) => q.predicate.value === p)
      .map((q) => q.object);
  const rs = quads.find(
    (q) => q.predicate.value === `${RDF}type` && q.object.key === `<${RS}ResultSet>`,
  )?.subject;
  if (rs === undefined) return undefined;
  const bool = objects(rs, `${RS}boolean`)[0];
  if (Term.isLiteral(bool)) return { _tag: 'Boolean', value: bool.value === 'true' };
  const variables = objects(rs, `${RS}resultVariable`).map((v) => literalValue(Option.some(v)));
  const solutions = objects(rs, `${RS}solution`).map((sol) => {
    const index = objects(sol, `${RS}index`)[0];
    const bindings = B.fromEntries(
      objects(sol, `${RS}binding`).map(
        (b) =>
          [
            literalValue(Arr.head(objects(b, `${RS}variable`))),
            objects(b, `${RS}value`)[0],
          ] as const,
      ),
    );
    return { index: index === undefined ? 0 : Number(literalValue(Option.some(index))), bindings };
  });
  const ordered = Arr.sort(
    solutions,
    Order.mapInput(Order.Number, (s: (typeof solutions)[number]) => s.index),
  );
  return { _tag: 'ResultSet', variables, bindings: ordered.map((s) => s.bindings) };
};
