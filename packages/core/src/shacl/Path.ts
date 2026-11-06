/**
 * SHACL property paths (§2.3.1): a typed model, evaluation against a data
 * graph, and conversion to and from their RDF encoding.
 *
 * @since 0.1.0
 */
import { Dataset, Term, Vocab } from '../index.ts';
import * as Arr from 'effect/Array';
import { constVoid, pipe } from 'effect/Function';
import * as Iterable from 'effect/Iterable';
import * as Match from 'effect/Match';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Result from 'effect/Result';
import { sh } from './Vocabulary.ts';

const { rdf } = Vocab;

/**
 * A SHACL property path.
 *
 * @since 0.1.0
 * @category models
 */
export type Path =
  | PredicatePath
  | SequencePath
  | AlternativePath
  | InversePath
  | ZeroOrMorePath
  | OneOrMorePath
  | ZeroOrOnePath;

/**
 * A predicate path: a single IRI.
 *
 * @since 0.1.0
 * @category models
 */
export interface PredicatePath {
  readonly _tag: 'PredicatePath';
  readonly predicate: Term.NamedNode;
}

/**
 * A sequence path: an RDF list of at least two paths.
 *
 * @since 0.1.0
 * @category models
 */
export interface SequencePath {
  readonly _tag: 'SequencePath';
  readonly paths: ReadonlyArray<Path>;
}

/**
 * An alternative path (`sh:alternativePath`).
 *
 * @since 0.1.0
 * @category models
 */
export interface AlternativePath {
  readonly _tag: 'AlternativePath';
  readonly paths: ReadonlyArray<Path>;
}

/**
 * An inverse path (`sh:inversePath`).
 *
 * @since 0.1.0
 * @category models
 */
export interface InversePath {
  readonly _tag: 'InversePath';
  readonly path: Path;
}

/**
 * A zero-or-more path (`sh:zeroOrMorePath`).
 *
 * @since 0.1.0
 * @category models
 */
export interface ZeroOrMorePath {
  readonly _tag: 'ZeroOrMorePath';
  readonly path: Path;
}

/**
 * A one-or-more path (`sh:oneOrMorePath`).
 *
 * @since 0.1.0
 * @category models
 */
export interface OneOrMorePath {
  readonly _tag: 'OneOrMorePath';
  readonly path: Path;
}

/**
 * A zero-or-one path (`sh:zeroOrOnePath`).
 *
 * @since 0.1.0
 * @category models
 */
export interface ZeroOrOnePath {
  readonly _tag: 'ZeroOrOnePath';
  readonly path: Path;
}

// -----------------------------------------------------------------------------
// Constructors
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category constructors
 */
export const predicate = (iri: Term.NamedNode): PredicatePath => ({
  _tag: 'PredicatePath',
  predicate: iri,
});

/**
 * @since 0.1.0
 * @category constructors
 */
export const sequence = (...paths: ReadonlyArray<Path>): SequencePath => ({
  _tag: 'SequencePath',
  paths,
});

/**
 * @since 0.1.0
 * @category constructors
 */
export const alternative = (...paths: ReadonlyArray<Path>): AlternativePath => ({
  _tag: 'AlternativePath',
  paths,
});

/**
 * @since 0.1.0
 * @category constructors
 */
export const inverse = (path: Path): InversePath => ({ _tag: 'InversePath', path });

/**
 * @since 0.1.0
 * @category constructors
 */
export const zeroOrMore = (path: Path): ZeroOrMorePath => ({ _tag: 'ZeroOrMorePath', path });

/**
 * @since 0.1.0
 * @category constructors
 */
export const oneOrMore = (path: Path): OneOrMorePath => ({ _tag: 'OneOrMorePath', path });

/**
 * @since 0.1.0
 * @category constructors
 */
export const zeroOrOne = (path: Path): ZeroOrOnePath => ({ _tag: 'ZeroOrOnePath', path });

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

const isPredicatePath = (p: Path): p is PredicatePath => Predicate.isTagged(p, 'PredicatePath');
const isSequencePath = (p: Path): p is SequencePath => Predicate.isTagged(p, 'SequencePath');
const isAlternativePath = (p: Path): p is AlternativePath =>
  Predicate.isTagged(p, 'AlternativePath');

// Built once: `equals` recurses through every sub-path.
const equalsMatch: (a: Path, b: Path) => boolean = Match.fn((a: Path, _b: Path) => a).pipe(
  Match.tag(
    'PredicatePath',
    (first, _a, b) => isPredicatePath(b) && first.predicate.value === b.predicate.value,
  ),
  Match.tag(
    'SequencePath',
    (first, _a, b) => isSequencePath(b) && pathsEqual(first.paths, b.paths),
  ),
  Match.tag(
    'AlternativePath',
    (first, _a, b) => isAlternativePath(b) && pathsEqual(first.paths, b.paths),
  ),
  Match.orElse(
    (first, _a, b) => 'path' in b && first._tag === b._tag && equals(first.path, b.path),
  ),
);

const pathsEqual = Arr.makeEquivalence<Path>((a, b) => equals(a, b));

/**
 * Structural equality of paths.
 *
 * @since 0.1.0
 * @category equivalence
 */
export const equals = (a: Path, b: Path): boolean => equalsMatch(a, b);

/**
 * Renders a path in SPARQL property path syntax, e.g. `^<p>/<q>*`.
 *
 * @since 0.1.0
 * @category formatting
 */
export const toSparql = (self: Path): string => {
  const wrap = (p: Path) => ('paths' in p ? `(${toSparql(p)})` : toSparql(p));
  return Match.value(self).pipe(
    Match.tag('PredicatePath', (node) => node.predicate.key),
    Match.tag('SequencePath', (node) => node.paths.map(wrap).join('/')),
    Match.tag('AlternativePath', (node) => node.paths.map(wrap).join('|')),
    Match.tag('InversePath', (node) => `^${wrap(node.path)}`),
    Match.tag('ZeroOrMorePath', (node) => `${wrap(node.path)}*`),
    Match.tag('OneOrMorePath', (node) => `${wrap(node.path)}+`),
    Match.tag('ZeroOrOnePath', (node) => `${wrap(node.path)}?`),
    Match.exhaustive,
  );
};

// -----------------------------------------------------------------------------
// Evaluation
// -----------------------------------------------------------------------------

type Node = Term.GroundTerm;

/** Nodes keyed by their N-Triples form, in discovery order. */
type Nodes = MutableHashMap.MutableHashMap<string, Node>;

const addNode = (out: Nodes, node: Node): void => {
  MutableHashMap.set(out, node.key, node);
};

const addAll = (out: Nodes, from: Nodes): void =>
  MutableHashMap.forEach(from, (node, key) => {
    MutableHashMap.set(out, key, node);
  });

/**
 * The breadth-first closure of `path` from the one-step successors in
 * `first`, added to `out`.
 */
const closure = (
  data: Dataset.Dataset,
  path: Path,
  first: Nodes,
  isInverse: boolean,
  out: Nodes,
): void => {
  const advance = (frontier: Nodes): Option.Option<readonly [void, Nodes]> => {
    if (MutableHashMap.isEmpty(frontier)) return Option.none();
    const next: Nodes = MutableHashMap.empty();
    MutableHashMap.forEach(frontier, (node, key) => {
      if (MutableHashMap.has(out, key)) return;
      MutableHashMap.set(out, key, node);
      MutableHashMap.set(next, key, node);
    });
    return Option.some([
      undefined,
      MutableHashMap.isEmpty(next) ? next : step(path, data, next, isInverse),
    ]);
  };
  Iterable.forEach(Iterable.unfold(first, advance), constVoid);
};

const isInversePath = (p: Path): p is InversePath => Predicate.isTagged(p, 'InversePath');
const isZeroOrOnePath = (p: Path): p is ZeroOrOnePath => Predicate.isTagged(p, 'ZeroOrOnePath');

const stepPredicate = (
  path: PredicatePath,
  data: Dataset.Dataset,
  nodes: Nodes,
  isInverse: boolean,
): Nodes => {
  const out: Nodes = MutableHashMap.empty();
  MutableHashMap.forEach(nodes, (node) => {
    if (isInverse)
      Arr.forEach(Dataset.match(data, { predicate: path.predicate, object: node }), (q) =>
        addNode(out, q.subject),
      );
    else if (!Term.isLiteral(node))
      Arr.forEach(Dataset.match(data, { subject: node, predicate: path.predicate }), (q) =>
        addNode(out, q.object),
      );
  });
  return out;
};

const stepAlternative = (
  path: AlternativePath,
  data: Dataset.Dataset,
  nodes: Nodes,
  isInverse: boolean,
): Nodes => {
  const out: Nodes = MutableHashMap.empty();
  Arr.forEach(path.paths, (p) => addAll(out, step(p, data, nodes, isInverse)));
  return out;
};

/** `sh:zeroOrOnePath`, `sh:zeroOrMorePath` and `sh:oneOrMorePath`. */
const stepRepeat = (
  path: ZeroOrOnePath | ZeroOrMorePath | OneOrMorePath,
  data: Dataset.Dataset,
  nodes: Nodes,
  isInverse: boolean,
): Nodes => {
  const out: Nodes = MutableHashMap.empty();
  if (!Predicate.isTagged(path, 'OneOrMorePath')) addAll(out, nodes);
  const first = step(path.path, data, nodes, isInverse);
  if (isZeroOrOnePath(path)) addAll(out, first);
  else closure(data, path.path, first, isInverse, out);
  return out;
};

// Plain guards rather than a `Match`: `step` runs for every path segment of
// every focus node.
const step = (segment: Path, data: Dataset.Dataset, nodes: Nodes, isInverse: boolean): Nodes => {
  if (isPredicatePath(segment)) return stepPredicate(segment, data, nodes, isInverse);
  if (isSequencePath(segment))
    return Arr.reduce(isInverse ? segment.paths.toReversed() : segment.paths, nodes, (current, p) =>
      step(p, data, current, isInverse),
    );
  if (isAlternativePath(segment)) return stepAlternative(segment, data, nodes, isInverse);
  if (isInversePath(segment)) return step(segment.path, data, nodes, !isInverse);
  return stepRepeat(segment, data, nodes, isInverse);
};

/**
 * The value nodes reachable from `focus` by following `path` in `data`
 * (duplicates removed, in discovery order).
 *
 * @since 0.1.0
 * @category evaluation
 */
export const evaluate = (
  data: Dataset.Dataset,
  focus: Term.GroundTerm,
  path: Path,
): ReadonlyArray<Term.GroundTerm> =>
  Arr.fromIterable(
    MutableHashMap.values(step(path, data, MutableHashMap.make([focus.key, focus]), false)),
  );

// -----------------------------------------------------------------------------
// RDF encoding
// -----------------------------------------------------------------------------

/**
 * Why a path node could not be read.
 *
 * @since 0.1.0
 * @category models
 */
export class PathSyntaxError {
  readonly _tag = 'PathSyntaxError';
  readonly node: Term.Term;
  readonly message: string;
  constructor(node: Term.Term, message: string) {
    this.node = node;
    this.message = message;
  }
}

/**
 * Reads the SHACL path rooted at `node` from a shapes graph, failing with a
 * `PathSyntaxError` when the node is not a well-formed path.
 *
 * @since 0.1.0
 * @category decoding
 */
export const fromRdf = (
  graph: Dataset.Dataset,
  node: Term.Term,
): Result.Result<Path, PathSyntaxError> => {
  const visiting = MutableHashSet.empty<string>();
  const bad = (n: Term.Term, message: string): never => {
    throw new PathSyntaxError(n, message);
  };
  const readList = (owner: Term.Term, head: Term.Term, kind: string): ReadonlyArray<Path> => {
    const items = Term.isObject(head) ? Dataset.list(graph, head) : Option.none();
    if (Option.isNone(items)) return bad(owner, `${head.key} is not a well-formed list`);
    if (items.value.length < 2)
      return bad(owner, `${kind} path ${owner.key} must have at least two members`);
    return items.value.map(go);
  };
  const go = (n: Term.Term): Path => {
    if (Term.isNamedNode(n)) return predicate(n);
    if (!Term.isBlankNode(n)) return bad(n, `${n.key} is not a valid SHACL path`);
    if (MutableHashSet.has(visiting, n.key)) return bad(n, `${n.key} is a recursive path`);
    MutableHashSet.add(visiting, n.key);
    const read = Result.try(() => readNode(n));
    MutableHashSet.remove(visiting, n.key);
    if (Result.isFailure(read)) throw read.failure;
    return read.success;
  };
  const readNode = (n: Term.BlankNode): Path => {
    if (Arr.isReadonlyArrayNonEmpty(Dataset.match(graph, { subject: n, predicate: rdf.first }))) {
      return sequence(...readList(n, n, 'sequence'));
    }
    const single = (p: Term.NamedNode): Option.Option<Term.Term> => {
      const values = Dataset.objectsOf(graph, n, p);
      if (values.length > 1) bad(n, `${n.key} has multiple values for ${p.key}`);
      return Arr.head(values);
    };
    const unary = (p: Term.NamedNode, make: (inner: Path) => Path) => (): Option.Option<Path> =>
      Option.map(single(p), (inner) => make(go(inner)));
    return pipe(
      Option.map(single(sh.alternativePath), (alt) =>
        alternative(...readList(n, alt, 'alternative')),
      ),
      Option.orElse(unary(sh.inversePath, inverse)),
      Option.orElse(unary(sh.zeroOrMorePath, zeroOrMore)),
      Option.orElse(unary(sh.oneOrMorePath, oneOrMore)),
      Option.orElse(unary(sh.zeroOrOnePath, zeroOrOne)),
      Option.getOrElse(() => bad(n, `${n.key} is not a valid SHACL path`)),
    );
  };
  return Result.try({
    try: () => go(node),
    catch: (e) => {
      if (e instanceof PathSyntaxError) return e;
      throw e;
    },
  });
};

/**
 * A path encoded as RDF: its root term and the quads describing it.
 *
 * @since 0.1.0
 * @category encoding
 */
export interface PathRdf {
  readonly node: Term.NamedNode | Term.BlankNode;
  readonly quads: ReadonlyArray<Term.Quad>;
}

/**
 * Encodes a path as RDF, returning the path's root term and the triples
 * describing it (using fresh blank nodes for non-predicate paths).
 *
 * @since 0.1.0
 * @category encoding
 */
export const toRdf = (self: Path, graph: Term.Graph = Term.defaultGraph): PathRdf => {
  const quads: Array<Term.Quad> = [];
  const list = (items: ReadonlyArray<Path>): Term.NamedNode | Term.BlankNode => {
    const nodes = items.map(() => Term.blankNode());
    Arr.forEach(Arr.zip(nodes, items), ([node, item], i) => {
      quads.push(Term.quad(node, rdf.first, go(item), graph));
      quads.push(Term.quad(node, rdf.rest, nodes[i + 1] ?? rdf.nil, graph));
    });
    return nodes[0] ?? rdf.nil;
  };
  const unary = (p: Term.NamedNode, inner: Path) => {
    const b = Term.blankNode();
    quads.push(Term.quad(b, p, go(inner), graph));
    return b;
  };
  const go = (node: Path): Term.NamedNode | Term.BlankNode => {
    return Match.value(node).pipe(
      Match.tag('PredicatePath', (p) => p.predicate),
      Match.tag('SequencePath', (p) => list(p.paths)),
      Match.tag('AlternativePath', (p) => {
        const b = Term.blankNode();
        quads.push(Term.quad(b, sh.alternativePath, list(p.paths), graph));
        return b;
      }),
      Match.tag('InversePath', (p) => unary(sh.inversePath, p.path)),
      Match.tag('ZeroOrMorePath', (p) => unary(sh.zeroOrMorePath, p.path)),
      Match.tag('OneOrMorePath', (p) => unary(sh.oneOrMorePath, p.path)),
      Match.tag('ZeroOrOnePath', (p) => unary(sh.zeroOrOnePath, p.path)),
      Match.exhaustive,
    );
  };
  const node = go(self);
  return { node, quads };
};
