/**
 * Result comparison for the conformance tests: result sets are compared up
 * to blank node renaming (by encoding them as RDF graphs and using graph
 * isomorphism), optionally respecting order.
 */
import * as Arr from 'effect/Array';
import * as Order from 'effect/Order';
import { Dataset, Isomorphism, Term, Xsd } from '@thomasfosterau/effect-rdf';
import type { Bindings } from '../../src/Bindings.ts';
import * as B from '../../src/Bindings.ts';
import type * as Results from '../../src/Results.ts';

const RS = 'http://www.w3.org/2001/sw/DataAccess/tests/result-set#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

/** Numeric literals are compared by value (canonical form). */
export const normalize = (t: Term.GroundTerm): Term.GroundTerm =>
  t._tag === 'Literal' && Xsd.isNumericDatatype(t.datatype.value) ? Xsd.canonicalize(t) : t;

// Makes every encoded row's blank node label unique.
let encoded = 0;

/** Encodes solutions as a graph: one fresh blank node per row. */
const encode = (bindings: ReadonlyArray<Bindings>, ordered: boolean): Dataset.Dataset => {
  const quads: Array<Term.Quad> = [];
  bindings.forEach((b, i) => {
    const row = Term.blankNode(`row${i}_${encoded++}`);
    quads.push(Term.quad(row, Term.namedNode('urn:row'), Term.literal(ordered ? String(i) : 'x')));
    for (const [k, v] of b)
      quads.push(Term.quad(row, Term.namedNode(`urn:var:${k}`), normalize(v)));
  });
  return Dataset.fromIterable(quads);
};

export const sameResults = (
  actual: ReadonlyArray<Bindings>,
  expected: ReadonlyArray<Bindings>,
  options: { readonly ordered?: boolean; readonly lax?: boolean } = {},
): boolean => {
  if (options.lax) {
    const dedupe = (bs: ReadonlyArray<Bindings>) => {
      const seen = new Map<string, Bindings>();
      for (const b of bs) seen.set(b.key, b);
      return Array.from(seen.values());
    };
    return sameResults(dedupe(actual), dedupe(expected));
  }
  if (actual.length !== expected.length) return false;
  return Isomorphism.isomorphic(
    encode(actual, options.ordered ?? false),
    encode(expected, options.ordered ?? false),
  );
};

/** Reads a result set (or boolean) encoded with the `rs:` vocabulary. */
export const fromRdf = (quads: ReadonlyArray<Term.Quad>): Results.ParsedResult | undefined => {
  const bySubject = new Map<string, Array<Term.Quad>>();
  for (const q of quads) {
    let l = bySubject.get(q.subject.key);
    if (l === undefined) bySubject.set(q.subject.key, (l = []));
    l.push(q);
  }
  const objects = (s: Term.Term, p: string) =>
    (bySubject.get(s.key) ?? []).filter((q) => q.predicate.value === p).map((q) => q.object);
  const rs = quads.find(
    (q) => q.predicate.value === `${RDF}type` && q.object.key === `<${RS}ResultSet>`,
  )?.subject;
  if (rs === undefined) return undefined;
  const bool = objects(rs, `${RS}boolean`)[0];
  if (bool !== undefined && bool._tag === 'Literal')
    return { _tag: 'Boolean', value: bool.value === 'true' };
  const variables = objects(rs, `${RS}resultVariable`).map((v) => (v as Term.Literal).value);
  const solutions = objects(rs, `${RS}solution`).map((sol) => {
    const index = objects(sol, `${RS}index`)[0];
    const bindings = B.fromEntries(
      objects(sol, `${RS}binding`).map((b) => {
        const name = (objects(b, `${RS}variable`)[0] as Term.Literal).value;
        return [name, objects(b, `${RS}value`)[0] as Term.GroundTerm] as const;
      }),
    );
    return { index: index === undefined ? 0 : Number((index as Term.Literal).value), bindings };
  });
  const ordered = Arr.sort(
    solutions,
    Order.mapInput(Order.Number, (s: (typeof solutions)[number]) => s.index),
  );
  return { _tag: 'ResultSet', variables, bindings: ordered.map((s) => s.bindings) };
};
