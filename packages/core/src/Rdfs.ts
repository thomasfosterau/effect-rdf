/**
 * RDF Schema: class and property hierarchies, and RDFS entailment.
 *
 * @since 0.1.0
 */
import * as Dataset from './Dataset.ts';
import * as Term from './Term.ts';
import { rdf, rdfs } from './Vocab.ts';

const transitiveClosure = (
  self: Dataset.Dataset,
  start: Term.Object,
  property: Term.NamedNode,
  direction: 'up' | 'down',
): ReadonlyArray<Term.Object> => {
  const seen = new Map<string, Term.Object>();
  const stack: Array<Term.Object> = [start];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const next: ReadonlyArray<Term.Object> =
      direction === 'up'
        ? node._tag === 'Literal'
          ? []
          : Dataset.objectsOf(self, node, property)
        : Dataset.subjectsOf(self, property, node);
    for (const n of next) {
      if (!seen.has(n.key) && n.key !== start.key) {
        seen.set(n.key, n);
        stack.push(n);
      }
    }
  }
  return Array.from(seen.values());
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
      t._tag !== 'Literal' && superClasses(self, t as Term.Resource).some((s) => s.key === cls.key),
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
  const out = new Map<string, Term.Subject>();
  for (const c of classes) for (const s of Dataset.subjectsOf(self, rdf.type, c)) out.set(s.key, s);
  return Array.from(out.values());
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
  let result = self;
  for (const graph of Dataset.graphs(self)) {
    result = Dataset.union(
      result,
      closeGraph(Dataset.graph(self, graph), graph, options.full === true),
    );
  }
  return result;
};

const closeGraph = (input: Dataset.Dataset, graph: Term.Graph, full: boolean): Dataset.Dataset => {
  let ds = input;
  const q = (s: Term.Subject, p: Term.Predicate, o: Term.Object) => new Term.Quad(s, p, o, graph);
  const asSubject = (o: Term.Object): Term.Subject | undefined =>
    o._tag === 'Literal' ? undefined : o;
  let changed = true;
  while (changed) {
    const before = ds.size;
    ds = Dataset.mutate(ds, (b) => {
      const add = (s: Term.Subject | undefined, p: Term.Predicate, o: Term.Object) => {
        if (s !== undefined) b.add(q(s, p, o));
      };
      const all = Array.from(ds);
      for (const t of all) {
        const { subject: s, predicate: p, object: o } = t;
        if (full) {
          add(p, rdf.type, rdf.Property);
          add(s, rdf.type, rdfs.Resource);
          add(asSubject(o), rdf.type, rdfs.Resource);
        }
        // rdfs2 / rdfs3
        for (const d of Dataset.objectsOf(ds, p, rdfs.domain, graph)) add(s, rdf.type, d);
        for (const r of Dataset.objectsOf(ds, p, rdfs.range, graph)) add(asSubject(o), rdf.type, r);
        // rdfs7
        for (const sp of Dataset.objectsOf(ds, p, rdfs.subPropertyOf, graph)) {
          if (sp._tag === 'NamedNode') add(s, sp, o);
        }
        if (p.value === rdfs.subPropertyOf.value) {
          // rdfs5
          const os = asSubject(o);
          if (os !== undefined)
            for (const x of Dataset.objectsOf(ds, os, rdfs.subPropertyOf, graph))
              add(s, rdfs.subPropertyOf, x);
        } else if (p.value === rdfs.subClassOf.value) {
          // rdfs11
          const os = asSubject(o);
          if (os !== undefined)
            for (const x of Dataset.objectsOf(ds, os, rdfs.subClassOf, graph))
              add(s, rdfs.subClassOf, x);
        } else if (p.value === rdf.type.value) {
          // rdfs9
          const os = asSubject(o);
          if (os !== undefined)
            for (const x of Dataset.objectsOf(ds, os, rdfs.subClassOf, graph)) add(s, rdf.type, x);
          if (full) {
            if (o.key === rdf.Property.key) add(s, rdfs.subPropertyOf, s as Term.Object); // rdfs6
            if (o.key === rdfs.Class.key) {
              add(s, rdfs.subClassOf, rdfs.Resource); // rdfs8
              add(s, rdfs.subClassOf, s as Term.Object); // rdfs10
            }
            if (o.key === rdfs.ContainerMembershipProperty.key)
              add(s, rdfs.subPropertyOf, rdfs.member); // rdfs12
            if (o.key === rdfs.Datatype.key) add(s, rdfs.subClassOf, rdfs.Literal); // rdfs13
          }
        }
      }
    });
    changed = ds.size !== before;
  }
  return ds;
};
