/**
 * Immutable, indexed RDF datasets.
 *
 * A `Dataset` is a persistent set of quads backed by Effect `HashMap`s, with
 * per-position indexes so that pattern matching only scans the most
 * selective index. Datasets implement `Equal` (set equality — use
 * `Isomorphism.isomorphic` for blank-node-aware comparison), `Hash`,
 * `Iterable<Quad>` and `Pipeable`.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import { dual } from 'effect/Function';
import * as Equal from 'effect/Equal';
import * as Hash from 'effect/Hash';
import * as HashMap from 'effect/HashMap';
import { NodeInspectSymbol, type Inspectable } from 'effect/Inspectable';
import * as Option from 'effect/Option';
import { pipeArguments, type Pipeable } from 'effect/Pipeable';
import { hasProperty } from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import * as Term from './Term.ts';
import { rdf } from './Vocab.ts';

/**
 * @since 0.1.0
 * @category symbols
 */
export const TypeId: unique symbol = Symbol.for('@thomasfosterau/effect-rdf/Dataset');

/**
 * @since 0.1.0
 * @category symbols
 */
export type TypeId = typeof TypeId;

type Index = HashMap.HashMap<string, HashMap.HashMap<string, Term.Quad>>;

/**
 * @since 0.1.0
 * @category models
 */
export interface Dataset extends Iterable<Term.Quad>, Equal.Equal, Pipeable, Inspectable {
  readonly [TypeId]: TypeId;
  readonly size: number;
  /** @internal */
  readonly quads: HashMap.HashMap<string, Term.Quad>;
}

/**
 * A quad pattern. Omitted positions, `undefined` and variables match any
 * term.
 *
 * @since 0.1.0
 * @category models
 */
export interface Pattern {
  readonly subject?: Term.Subject | Term.Variable | undefined;
  readonly predicate?: Term.Predicate | Term.Variable | undefined;
  readonly object?: Term.Object | Term.Variable | undefined;
  readonly graph?: Term.Graph | Term.Variable | undefined;
}

/** `isDataset` for a value already known to be an object. */
const hasDatasetTypeId = (u: Equal.Equal | Iterable<Term.Quad>): u is Dataset => TypeId in u;

type Spog = readonly [Index, Index, Index, Index];

/**
 * The indexes of the datasets that have been matched against, built on
 * first use: parsing a document and serializing it never pays for them. A
 * `WeakMap` rather than a field, so a dataset's own properties do not depend
 * on whether it has been matched.
 */
const indexes = new WeakMap<Dataset, Spog>();

const Proto: Omit<Dataset, 'size' | 'quads'> = {
  [TypeId]: TypeId,
  [Symbol.iterator](this: Dataset): Iterator<Term.Quad> {
    return HashMap.values(this.quads)[Symbol.iterator]();
  },
  [Equal.symbol](this: Dataset, that: Equal.Equal): boolean {
    if (!hasDatasetTypeId(that) || that.size !== this.size) return false;
    for (const key of HashMap.keys(this.quads)) {
      if (!HashMap.has(that.quads, key)) return false;
    }
    return true;
  },
  [Hash.symbol](this: Dataset): number {
    let h = 0;
    for (const q of this) h = (h + Hash.hash(q)) | 0;
    return Hash.optimize(h);
  },
  pipe() {
    return pipeArguments(this, arguments);
  },
  toString(this: Dataset) {
    return toNQuads(this);
  },
  toJSON(this: Dataset) {
    return { _id: 'Dataset', size: this.size, quads: Array.from(this, (q) => q.toString()) };
  },
  [NodeInspectSymbol](this: Dataset) {
    return this.toJSON();
  },
};

const makeDataset = (quads: HashMap.HashMap<string, Term.Quad>): Dataset => {
  const self = Object.create(Proto);
  self.quads = quads;
  self.size = HashMap.size(quads);
  return self;
};

const emptyIndex: Index = HashMap.empty();

const emptySpog: Spog = [emptyIndex, emptyIndex, emptyIndex, emptyIndex];

/**
 * @since 0.1.0
 * @category guards
 */
export const isDataset = (u: unknown): u is Dataset => hasProperty(u, TypeId);

/**
 * @since 0.1.0
 * @category constructors
 */
export const empty: Dataset = makeDataset(HashMap.empty());

// -----------------------------------------------------------------------------
// Mutation (internal builder)
// -----------------------------------------------------------------------------

/**
 * A transient builder used by `mutate` to apply many updates efficiently.
 *
 * @since 0.1.0
 * @category models
 */
export interface Builder {
  readonly add: (quad: Term.Quad) => Builder;
  readonly addAll: (quads: Iterable<Term.Quad>) => Builder;
  readonly remove: (quad: Term.Quad) => Builder;
  readonly has: (quad: Term.Quad) => boolean;
  readonly size: () => number;
}

/** The inner maps of one index made mutable during a batch, by term key. */
type Transients = Map<string, HashMap.HashMap<string, Term.Quad>>;

const transients = (): Transients => new Map();

const positions = (q: Term.Quad): readonly [string, string, string, string] => [
  q.subject.key,
  q.predicate.key,
  q.object.key,
  q.graph.key,
];

/** Updates to a dataset's four indexes, applied in place until `finish`. */
interface IndexBatch {
  readonly add: (quad: Term.Quad, key: string) => void;
  readonly remove: (quad: Term.Quad, key: string) => void;
  readonly finish: () => Spog;
}

const indexBatch = (spog: Spog): IndexBatch => {
  const idx: [Index, Index, Index, Index] = [
    HashMap.beginMutation(spog[0]),
    HashMap.beginMutation(spog[1]),
    HashMap.beginMutation(spog[2]),
    HashMap.beginMutation(spog[3]),
  ];
  // The inner maps this batch has made mutable, per position, so that adding
  // a quad updates its four inner maps in place instead of copying a path of
  // each (they are frozen again by `finish`).
  const open: [Transients, Transients, Transients, Transients] = [
    transients(),
    transients(),
    transients(),
    transients(),
  ];
  const inner = (i: 0 | 1 | 2 | 3, termKey: string): HashMap.HashMap<string, Term.Quad> => {
    const opened = open[i];
    let map = opened.get(termKey);
    if (map === undefined) {
      map = HashMap.beginMutation(
        Option.getOrElse(HashMap.get(idx[i], termKey), () => HashMap.empty<string, Term.Quad>()),
      );
      opened.set(termKey, map);
      idx[i] = HashMap.set(idx[i], termKey, map);
    }
    return map;
  };
  // A mutable map is updated in place, so the results of `set` and `remove` are the map itself
  const addAt = (i: 0 | 1 | 2 | 3, termKey: string, key: string, quad: Term.Quad): void => {
    HashMap.set(inner(i, termKey), key, quad);
  };
  const removeAt = (i: 0 | 1 | 2 | 3, termKey: string, key: string): void => {
    if (open[i].has(termKey) || HashMap.has(idx[i], termKey)) {
      HashMap.remove(inner(i, termKey), key);
    }
  };
  const close = (i: 0 | 1 | 2 | 3): void => {
    open[i].forEach((map, termKey) => {
      HashMap.endMutation(map);
      if (HashMap.size(map) === 0) idx[i] = HashMap.remove(idx[i], termKey);
    });
  };
  return {
    add(quad, key) {
      addAt(0, quad.subject.key, key, quad);
      addAt(1, quad.predicate.key, key, quad);
      addAt(2, quad.object.key, key, quad);
      addAt(3, quad.graph.key, key, quad);
    },
    remove(quad, key) {
      removeAt(0, quad.subject.key, key);
      removeAt(1, quad.predicate.key, key);
      removeAt(2, quad.object.key, key);
      removeAt(3, quad.graph.key, key);
    },
    finish() {
      close(0);
      close(1);
      close(2);
      close(3);
      return [
        HashMap.endMutation(idx[0]),
        HashMap.endMutation(idx[1]),
        HashMap.endMutation(idx[2]),
        HashMap.endMutation(idx[3]),
      ];
    },
  };
};

/** The indexes of a dataset, built the first time they are needed. */
const indexesOf = (self: Dataset): Spog => {
  const built = indexes.get(self);
  if (built !== undefined) return built;
  const batch = indexBatch(emptySpog);
  HashMap.forEach(self.quads, (quad, key) => batch.add(quad, key));
  const spog = batch.finish();
  indexes.set(self, spog);
  return spog;
};

/**
 * Applies a batch of updates to a dataset using a transient builder.
 *
 * @since 0.1.0
 * @category combinators
 */
export const mutate: {
  (f: (builder: Builder) => void): (self: Dataset) => Dataset;
  (self: Dataset, f: (builder: Builder) => void): Dataset;
} = dual(2, (self: Dataset, f: (builder: Builder) => void): Dataset => {
  let quads = HashMap.beginMutation(self.quads);
  // Indexes already built are kept up to date; otherwise the result builds its own when matched
  const spog = indexes.get(self);
  const batch = spog === undefined ? undefined : indexBatch(spog);
  const builder: Builder = {
    add(quad) {
      const key = quad.key;
      // One lookup: `set` on the mutable map grows it only if the quad is new. A duplicate
      // replaces the stored quad with an equal one.
      const before = HashMap.size(quads);
      quads = HashMap.set(quads, key, quad);
      if (HashMap.size(quads) !== before) batch?.add(quad, key);
      return builder;
    },
    addAll(iterable) {
      for (const q of iterable) builder.add(q);
      return builder;
    },
    remove(quad) {
      const key = quad.key;
      if (!HashMap.has(quads, key)) return builder;
      quads = HashMap.remove(quads, key);
      batch?.remove(quad, key);
      return builder;
    },
    has: (quad) => HashMap.has(quads, quad.key),
    size: () => HashMap.size(quads),
  };
  f(builder);
  const result = makeDataset(HashMap.endMutation(quads));
  if (batch !== undefined) indexes.set(result, batch.finish());
  return result;
});

// -----------------------------------------------------------------------------
// Constructors
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category constructors
 */
export const fromIterable = (quads: Iterable<Term.Quad>): Dataset =>
  hasDatasetTypeId(quads) ? quads : mutate(empty, (b) => b.addAll(quads));

/**
 * @since 0.1.0
 * @category constructors
 */
export const make = (...quads: ReadonlyArray<Term.Quad>): Dataset => fromIterable(quads);

/**
 * Creates a dataset from triples, placing them in the given graph (the
 * default graph when omitted).
 *
 * @since 0.1.0
 * @category constructors
 */
export const fromTriples = (
  triples: Iterable<Term.Triple>,
  graph: Term.Graph = Term.defaultGraph,
): Dataset =>
  mutate(empty, (b) => {
    for (const t of triples) b.add(new Term.Quad(t.subject, t.predicate, t.object, graph));
  });

// -----------------------------------------------------------------------------
// Updates
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category combinators
 */
export const add: {
  (quad: Term.Quad): (self: Dataset) => Dataset;
  (self: Dataset, quad: Term.Quad): Dataset;
} = dual(2, (self: Dataset, quad: Term.Quad): Dataset =>
  HashMap.has(self.quads, quad.key) ? self : mutate(self, (b) => b.add(quad)),
);

/**
 * @since 0.1.0
 * @category combinators
 */
export const addAll: {
  (quads: Iterable<Term.Quad>): (self: Dataset) => Dataset;
  (self: Dataset, quads: Iterable<Term.Quad>): Dataset;
} = dual(2, (self: Dataset, quads: Iterable<Term.Quad>): Dataset =>
  mutate(self, (b) => b.addAll(quads)),
);

/**
 * @since 0.1.0
 * @category combinators
 */
export const remove: {
  (quad: Term.Quad): (self: Dataset) => Dataset;
  (self: Dataset, quad: Term.Quad): Dataset;
} = dual(2, (self: Dataset, quad: Term.Quad): Dataset =>
  HashMap.has(self.quads, quad.key) ? mutate(self, (b) => b.remove(quad)) : self,
);

/**
 * Removes every quad matching a pattern.
 *
 * @since 0.1.0
 * @category combinators
 */
export const removeMatches: {
  (pattern: Pattern): (self: Dataset) => Dataset;
  (self: Dataset, pattern: Pattern): Dataset;
} = dual(2, (self: Dataset, pattern: Pattern): Dataset => {
  const matches = match(self, pattern);
  return Arr.isReadonlyArrayEmpty(matches) ? self : mutate(self, (b) => matches.forEach(b.remove));
});

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category predicates
 */
export const has: {
  (quad: Term.Quad): (self: Dataset) => boolean;
  (self: Dataset, quad: Term.Quad): boolean;
} = dual(2, (self: Dataset, quad: Term.Quad): boolean => HashMap.has(self.quads, quad.key));

/**
 * @since 0.1.0
 * @category predicates
 */
export const isEmpty = (self: Dataset): boolean => self.size === 0;

const bound = (t: Term.Term | undefined): t is Exclude<Term.Term, Term.Variable> =>
  t !== undefined && t._tag !== 'Variable';

/**
 * Returns all quads matching a pattern, using the most selective index.
 *
 * @since 0.1.0
 * @category queries
 */
export const match: {
  (pattern: Pattern): (self: Dataset) => ReadonlyArray<Term.Quad>;
  (self: Dataset, pattern: Pattern): ReadonlyArray<Term.Quad>;
} = dual(2, (self: Dataset, pattern: Pattern): ReadonlyArray<Term.Quad> => {
  const terms = [pattern.subject, pattern.predicate, pattern.object, pattern.graph] as const;
  let candidates: HashMap.HashMap<string, Term.Quad> | undefined;
  let candidateSize = Infinity;
  const checks: Array<readonly [number, string]> = [];
  for (let i = 0; i < 4; i++) {
    const t = terms[i];
    if (!bound(t)) continue;
    const key = t.key;
    checks.push([i, key]);
    const inner = HashMap.get(indexesOf(self)[i]!, key);
    if (Option.isNone(inner)) return [];
    const size = HashMap.size(inner.value);
    if (size < candidateSize) {
      candidates = inner.value;
      candidateSize = size;
    }
  }
  const source = candidates ?? self.quads;
  const out: Array<Term.Quad> = [];
  for (const q of HashMap.values(source)) {
    let ok = true;
    if (checks.length > 1) {
      const ks = positions(q);
      for (const [i, key] of checks) {
        if (ks[i] !== key) {
          ok = false;
          break;
        }
      }
    }
    if (ok) out.push(q);
  }
  return out;
});

/**
 * Counts the quads matching a pattern.
 *
 * @since 0.1.0
 * @category queries
 */
export const count: {
  (pattern: Pattern): (self: Dataset) => number;
  (self: Dataset, pattern: Pattern): number;
} = dual(2, (self: Dataset, pattern: Pattern): number => match(self, pattern).length);

/**
 * Returns a dataset containing only the quads matching a pattern.
 *
 * @since 0.1.0
 * @category queries
 */
export const filterMatches: {
  (pattern: Pattern): (self: Dataset) => Dataset;
  (self: Dataset, pattern: Pattern): Dataset;
} = dual(2, (self: Dataset, pattern: Pattern): Dataset => fromIterable(match(self, pattern)));

/**
 * The objects of all quads with the given subject and predicate (in any
 * graph unless one is specified).
 *
 * @since 0.1.0
 * @category queries
 */
export const objectsOf = (
  self: Dataset,
  subject: Term.Subject,
  predicate: Term.Predicate,
  graph?: Term.Graph,
): ReadonlyArray<Term.Object> =>
  uniqueTerms(match(self, { subject, predicate, graph }).map((q) => q.object));

/**
 * The first object of a subject/predicate pair, if any.
 *
 * @since 0.1.0
 * @category queries
 */
export const objectOf = (
  self: Dataset,
  subject: Term.Subject,
  predicate: Term.Predicate,
  graph?: Term.Graph,
): Option.Option<Term.Object> =>
  Option.fromNullishOr(match(self, { subject, predicate, graph })[0]?.object);

/**
 * The subjects of all quads with the given predicate and object.
 *
 * @since 0.1.0
 * @category queries
 */
export const subjectsOf = (
  self: Dataset,
  predicate: Term.Predicate,
  object: Term.Object,
  graph?: Term.Graph,
): ReadonlyArray<Term.Subject> =>
  uniqueTerms(match(self, { predicate, object, graph }).map((q) => q.subject));

const uniqueTerms = <T extends Term.Term>(terms: ReadonlyArray<T>): ReadonlyArray<T> => {
  if (terms.length < 2) return terms;
  const seen = new Map<string, T>();
  for (const t of terms) if (!seen.has(t.key)) seen.set(t.key, t);
  return Array.from(seen.values());
};

const termsAt = <T extends Term.Term>(
  self: Dataset,
  i: number,
  pick: (q: Term.Quad) => T,
): ReadonlyArray<T> =>
  Array.from(HashMap.values(indexesOf(self)[i]!), (inner) =>
    // SAFETY: an inner map is removed from the index when its last quad goes, so it always holds
    // one.
    pick(HashMap.values(inner).next().value as Term.Quad),
  );

/**
 * All distinct subjects.
 *
 * @since 0.1.0
 * @category queries
 */
export const subjects = (self: Dataset): ReadonlyArray<Term.Subject> =>
  termsAt(self, 0, (q) => q.subject);

/**
 * All distinct predicates.
 *
 * @since 0.1.0
 * @category queries
 */
export const predicates = (self: Dataset): ReadonlyArray<Term.Predicate> =>
  termsAt(self, 1, (q) => q.predicate);

/**
 * All distinct objects.
 *
 * @since 0.1.0
 * @category queries
 */
export const objects = (self: Dataset): ReadonlyArray<Term.Object> =>
  termsAt(self, 2, (q) => q.object);

/**
 * All distinct graph names (including the default graph if it is non-empty).
 *
 * @since 0.1.0
 * @category queries
 */
export const graphs = (self: Dataset): ReadonlyArray<Term.Graph> =>
  termsAt(self, 3, (q) => q.graph);

/**
 * The quads of one graph.
 *
 * @since 0.1.0
 * @category queries
 */
export const graph: {
  (graph: Term.Graph): (self: Dataset) => Dataset;
  (self: Dataset, graph: Term.Graph): Dataset;
} = dual(2, (self: Dataset, graph: Term.Graph): Dataset => filterMatches(self, { graph }));

/**
 * The triples of the dataset, ignoring graph names (duplicates across graphs
 * are merged).
 *
 * @since 0.1.0
 * @category conversions
 */
export const triples = (self: Dataset): ReadonlyArray<Term.Triple> => {
  const seen = new Map<string, Term.Triple>();
  for (const q of self) {
    const t = q.triple;
    if (!seen.has(t.key)) seen.set(t.key, t);
  }
  return Array.from(seen.values());
};

/**
 * Moves every quad into a single graph.
 *
 * @since 0.1.0
 * @category combinators
 */
export const withGraph: {
  (graph: Term.Graph): (self: Dataset) => Dataset;
  (self: Dataset, graph: Term.Graph): Dataset;
} = dual(2, (self: Dataset, graph: Term.Graph): Dataset =>
  fromIterable(Array.from(self, (q) => new Term.Quad(q.subject, q.predicate, q.object, graph))),
);

/**
 * Reads an RDF collection (`rdf:first`/`rdf:rest` list) starting at `head`.
 * Returns `None` if the list is malformed (missing or multiple `first`/`rest`
 * values, or cyclic).
 *
 * @since 0.1.0
 * @category queries
 */
export const list = (
  self: Dataset,
  head: Term.Object,
  graph?: Term.Graph,
): Option.Option<ReadonlyArray<Term.Object>> => {
  const items: Array<Term.Object> = [];
  const seen = new Set<string>();
  let node: Term.Object = head;
  while (!(node._tag === 'NamedNode' && node.value === rdf.nil.value)) {
    if (node._tag === 'Literal' || seen.has(node.key)) return Option.none();
    seen.add(node.key);
    const first = objectsOf(self, node, rdf.first, graph);
    const rest = objectsOf(self, node, rdf.rest, graph);
    if (first.length !== 1 || rest.length !== 1) return Option.none();
    items.push(first[0]!);
    node = rest[0]!;
  }
  return Option.some(items);
};

// -----------------------------------------------------------------------------
// Set operations and folds
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category combinators
 */
export const union: {
  (that: Dataset): (self: Dataset) => Dataset;
  (self: Dataset, that: Dataset): Dataset;
} = dual(2, (self: Dataset, that: Dataset): Dataset =>
  self.size >= that.size ? addAll(self, that) : addAll(that, self),
);

/**
 * @since 0.1.0
 * @category combinators
 */
export const intersection: {
  (that: Dataset): (self: Dataset) => Dataset;
  (self: Dataset, that: Dataset): Dataset;
} = dual(2, (self: Dataset, that: Dataset): Dataset => filter(self, (q) => has(that, q)));

/**
 * @since 0.1.0
 * @category combinators
 */
export const difference: {
  (that: Dataset): (self: Dataset) => Dataset;
  (self: Dataset, that: Dataset): Dataset;
} = dual(2, (self: Dataset, that: Dataset): Dataset =>
  mutate(self, (b) => {
    for (const q of that) b.remove(q);
  }),
);

/**
 * @since 0.1.0
 * @category combinators
 */
export const filter: {
  (predicate: (quad: Term.Quad) => boolean): (self: Dataset) => Dataset;
  (self: Dataset, predicate: (quad: Term.Quad) => boolean): Dataset;
} = dual(2, (self: Dataset, predicate: (quad: Term.Quad) => boolean): Dataset =>
  mutate(empty, (b) => {
    for (const q of self) if (predicate(q)) b.add(q);
  }),
);

/**
 * @since 0.1.0
 * @category combinators
 */
export const map: {
  (f: (quad: Term.Quad) => Term.Quad): (self: Dataset) => Dataset;
  (self: Dataset, f: (quad: Term.Quad) => Term.Quad): Dataset;
} = dual(2, (self: Dataset, f: (quad: Term.Quad) => Term.Quad): Dataset =>
  mutate(empty, (b) => {
    for (const q of self) b.add(f(q));
  }),
);

/**
 * @since 0.1.0
 * @category combinators
 */
export const flatMap: {
  (f: (quad: Term.Quad) => Iterable<Term.Quad>): (self: Dataset) => Dataset;
  (self: Dataset, f: (quad: Term.Quad) => Iterable<Term.Quad>): Dataset;
} = dual(2, (self: Dataset, f: (quad: Term.Quad) => Iterable<Term.Quad>): Dataset =>
  mutate(empty, (b) => {
    for (const q of self) b.addAll(f(q));
  }),
);

/**
 * @since 0.1.0
 * @category folding
 */
export const reduce: {
  <B>(initial: B, f: (acc: B, quad: Term.Quad) => B): (self: Dataset) => B;
  <B>(self: Dataset, initial: B, f: (acc: B, quad: Term.Quad) => B): B;
} = dual(3, <B>(self: Dataset, initial: B, f: (acc: B, quad: Term.Quad) => B): B => {
  let acc = initial;
  for (const q of self) acc = f(acc, q);
  return acc;
});

/**
 * @since 0.1.0
 * @category predicates
 */
export const some: {
  (predicate: (quad: Term.Quad) => boolean): (self: Dataset) => boolean;
  (self: Dataset, predicate: (quad: Term.Quad) => boolean): boolean;
} = dual(2, (self: Dataset, predicate: (quad: Term.Quad) => boolean): boolean => {
  for (const q of self) if (predicate(q)) return true;
  return false;
});

/**
 * @since 0.1.0
 * @category predicates
 */
export const every: {
  (predicate: (quad: Term.Quad) => boolean): (self: Dataset) => boolean;
  (self: Dataset, predicate: (quad: Term.Quad) => boolean): boolean;
} = dual(2, (self: Dataset, predicate: (quad: Term.Quad) => boolean): boolean => {
  for (const q of self) if (!predicate(q)) return false;
  return true;
});

/**
 * Whether every quad of `self` is in `that`.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isSubset: {
  (that: Dataset): (self: Dataset) => boolean;
  (self: Dataset, that: Dataset): boolean;
} = dual(2, (self: Dataset, that: Dataset): boolean => every(self, (q) => has(that, q)));

// -----------------------------------------------------------------------------
// Conversions
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category conversions
 */
export const toArray = (self: Dataset): ReadonlyArray<Term.Quad> => Array.from(self);

/**
 * The quads in a deterministic order (graph, subject, predicate, object).
 *
 * @since 0.1.0
 * @category conversions
 */
export const toSortedArray = (self: Dataset): ReadonlyArray<Term.Quad> =>
  Arr.sort(self, Term.compareQuads);

/**
 * Serialises to canonical, sorted N-Quads (one statement per line).
 *
 * @since 0.1.0
 * @category conversions
 */
export const toNQuads = (self: Dataset): string =>
  toSortedArray(self)
    .map((q) => `${q.toString()}\n`)
    .join('');

/**
 * @since 0.1.0
 * @category schemas
 */
export const DatasetSchema: Schema.declare<Dataset> = Schema.declare(isDataset, {
  identifier: 'Dataset',
});

/**
 * The type `DatasetSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type DatasetSchema = typeof DatasetSchema.Type;
