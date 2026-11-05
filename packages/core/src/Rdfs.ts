/**
 * RDF Schema: class and property hierarchies, and RDFS entailment.
 *
 * @since 0.1.0
 */
import * as Dataset from './Dataset.ts';
import * as Term from './Term.ts';
import { rdf, rdfs } from './Vocab.ts';
import * as Arr from 'effect/Array';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as Option from 'effect/Option';
import { loop } from './internal/loop.ts';

const transitiveClosure = (
  self: Dataset.Dataset,
  start: Term.Object,
  property: Term.NamedNode,
  direction: 'up' | 'down',
): ReadonlyArray<Term.Object> => {
  const seen = MutableHashMap.empty<string, Term.Object>();
  const stack: Array<Term.Object> = [start];
  // Depth-first, with an explicit stack: hierarchies can be deep
  loop(() => {
    const node = stack.pop();
    if (node === undefined) return false;
    const next: ReadonlyArray<Term.Object> =
      direction === 'up'
        ? Term.isLiteral(node)
          ? []
          : Dataset.objectsOf(self, node, property)
        : Dataset.subjectsOf(self, property, node);
    next.forEach((n) => {
      if (!MutableHashMap.has(seen, n.key) && n.key !== start.key) {
        MutableHashMap.set(seen, n.key, n);
        stack.push(n);
      }
    });
    return true;
  });
  return Arr.fromIterable(MutableHashMap.values(seen));
};

/**
 * All (transitive) superclasses of a class, excluding the class itself.
 *
 * @since 0.1.0
 * @category hierarchy
 */
export const superClasses = (
  self: Dataset.Dataset,
  cls: Term.Resource,
): ReadonlyArray<Term.Object> => transitiveClosure(self, cls, rdfs.subClassOf, 'up');

/**
 * All (transitive) subclasses of a class, excluding the class itself.
 *
 * @since 0.1.0
 * @category hierarchy
 */
export const subClasses = (self: Dataset.Dataset, cls: Term.Resource): ReadonlyArray<Term.Object> =>
  transitiveClosure(self, cls, rdfs.subClassOf, 'down');

/**
 * All (transitive) superproperties of a property, excluding itself.
 *
 * @since 0.1.0
 * @category hierarchy
 */
export const superProperties = (
  self: Dataset.Dataset,
  property: Term.Resource,
): ReadonlyArray<Term.Object> => transitiveClosure(self, property, rdfs.subPropertyOf, 'up');

/**
 * All (transitive) subproperties of a property, excluding itself.
 *
 * @since 0.1.0
 * @category hierarchy
 */
export const subProperties = (
  self: Dataset.Dataset,
  property: Term.Resource,
): ReadonlyArray<Term.Object> => transitiveClosure(self, property, rdfs.subPropertyOf, 'down');

/**
 * The asserted types (`rdf:type` values) of a resource.
 *
 * @since 0.1.0
 * @category hierarchy
 */
export const types = (self: Dataset.Dataset, resource: Term.Subject): ReadonlyArray<Term.Object> =>
  Dataset.objectsOf(self, resource, rdf.type);

/**
 * Whether `resource` is an instance of `cls`, taking `rdfs:subClassOf` into
 * account.
 *
 * @since 0.1.0
 * @category hierarchy
 */
export const isInstanceOf = (
  self: Dataset.Dataset,
  resource: Term.Subject,
  cls: Term.Resource,
): boolean => {
  const asserted = types(self, resource);
  if (asserted.some((t) => t.key === cls.key)) return true;
  return asserted.some(
    (t) =>
      !Term.isLiteral(t) &&
      transitiveClosure(self, t, rdfs.subClassOf, 'up').some((s) => s.key === cls.key),
  );
};

/**
 * All instances of a class, including instances of its subclasses.
 *
 * @since 0.1.0
 * @category hierarchy
 */
export const instancesOf = (
  self: Dataset.Dataset,
  cls: Term.Resource,
): ReadonlyArray<Term.Subject> => {
  const classes = [cls, ...subClasses(self, cls)];
  const out = MutableHashMap.empty<string, Term.Subject>();
  classes.forEach((c) =>
    Dataset.subjectsOf(self, rdf.type, c).forEach((s) => {
      MutableHashMap.set(out, s.key, s);
    }),
  );
  return Arr.fromIterable(MutableHashMap.values(out));
};

/**
 * Options for RDFS entailment.
 *
 * @since 0.1.0
 * @category entailment
 */
export interface EntailmentOptions {
  /**
   * Include the axiomatic and "every resource is an rdfs:Resource" style
   * triples (rules rdfs4a/4b, rdfs8, rdfs10, rdfs12, rdfs13, rdf1). These
   * produce many uninteresting triples; disabled by default.
   */
  readonly full?: boolean;
}

/**
 * Computes the RDFS closure of the default graph (or every graph
 * independently) by forward chaining the RDFS entailment rules to a fixpoint.
 *
 * Implemented rules: rdfs2 (domain), rdfs3 (range), rdfs5 (subPropertyOf
 * transitivity), rdfs7 (subproperty inheritance), rdfs9 (type inheritance),
 * rdfs11 (subClassOf transitivity), and — when `full` is set — rdf1, rdfs4a,
 * rdfs4b, rdfs6, rdfs8, rdfs10, rdfs12 and rdfs13.
 *
 * @since 0.1.0
 * @category entailment
 */
export const closure = (
  self: Dataset.Dataset,
  options: EntailmentOptions = {},
): Dataset.Dataset => {
  return Arr.reduce(Dataset.graphs(self), self, (result, graph) =>
    Dataset.union(result, closeGraph(Dataset.graph(self, graph), graph, options.full === true)),
  );
};

const asSubject = (o: Term.Object): Option.Option<Term.Subject> =>
  Term.isLiteral(o) ? Option.none() : Option.some(o);

const closeGraph = (input: Dataset.Dataset, graph: Term.Graph, full: boolean): Dataset.Dataset => {
  let ds = input;
  const q = (s: Term.Subject, p: Term.Predicate, o: Term.Object) => new Term.Quad(s, p, o, graph);
  // Apply the rules until a round adds nothing
  loop(() => {
    const before = ds.size;
    ds = Dataset.mutate(ds, (b) => {
      const add = (s: Term.Subject, p: Term.Predicate, o: Term.Object) => {
        b.add(q(s, p, o));
      };
      const addFrom = (s: Option.Option<Term.Subject>, p: Term.Predicate, o: Term.Object) => {
        if (Option.isSome(s)) add(s.value, p, o);
      };
      const all = Array.from(ds);
      all.forEach((t) => {
        const { subject: s, predicate: p, object: o } = t;
        const os = asSubject(o);
        if (full) {
          add(p, rdf.type, rdf.Property);
          add(s, rdf.type, rdfs.Resource);
          addFrom(os, rdf.type, rdfs.Resource);
        }
        // rdfs2 / rdfs3
        Dataset.objectsOf(ds, p, rdfs.domain, graph).forEach((d) => add(s, rdf.type, d));
        Dataset.objectsOf(ds, p, rdfs.range, graph).forEach((r) => addFrom(os, rdf.type, r));
        // rdfs7
        Dataset.objectsOf(ds, p, rdfs.subPropertyOf, graph).forEach((sp) => {
          if (Term.isNamedNode(sp)) add(s, sp, o);
        });
        if (p.value === rdfs.subPropertyOf.value) {
          // rdfs5
          if (Option.isSome(os))
            Dataset.objectsOf(ds, os.value, rdfs.subPropertyOf, graph).forEach((x) =>
              add(s, rdfs.subPropertyOf, x),
            );
        } else if (p.value === rdfs.subClassOf.value) {
          // rdfs11
          if (Option.isSome(os))
            Dataset.objectsOf(ds, os.value, rdfs.subClassOf, graph).forEach((x) =>
              add(s, rdfs.subClassOf, x),
            );
        } else if (p.value === rdf.type.value) {
          // rdfs9
          if (Option.isSome(os))
            Dataset.objectsOf(ds, os.value, rdfs.subClassOf, graph).forEach((x) =>
              add(s, rdf.type, x),
            );
          if (full) {
            if (o.key === rdf.Property.key) {
              // SAFETY: a subject is also a valid object.
              add(s, rdfs.subPropertyOf, s); // rdfs6
            }
            if (o.key === rdfs.Class.key) {
              add(s, rdfs.subClassOf, rdfs.Resource); // rdfs8
              // SAFETY: a subject is also a valid object.
              add(s, rdfs.subClassOf, s); // rdfs10
            }
            if (o.key === rdfs.ContainerMembershipProperty.key)
              add(s, rdfs.subPropertyOf, rdfs.member); // rdfs12
            if (o.key === rdfs.Datatype.key) add(s, rdfs.subClassOf, rdfs.Literal); // rdfs13
          }
        }
      });
    });
    return ds.size !== before;
  });
  return ds;
};
