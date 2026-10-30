/**
 * SHACL property paths (§2.3.1): a typed model, evaluation against a data
 * graph, and conversion to and from their RDF encoding.
 *
 * @since 0.1.0
 */
import { Dataset, Term, Vocab } from '@thomasfosterau/effect-rdf';
import * as Match from 'effect/Match';
import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';
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
export const predicate = (predicate: Term.NamedNode): PredicatePath => ({
  _tag: 'PredicatePath',
  predicate,
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

/**
 * Structural equality of paths.
 *
 * @since 0.1.0
 * @category equivalence
 */
export const equals = (a: Path, b: Path): boolean => {
  if (a._tag !== b._tag) return false;
  return Match.value(a).pipe(
    Match.tag('PredicatePath', (a) => {
      // SAFETY: `equals` compared the tags first, so `b` has the same kind as `a`.
      return a.predicate.value === (b as PredicatePath).predicate.value;
    }),
    Match.tag('SequencePath', 'AlternativePath', (a) => {
      // SAFETY: `equals` compared the tags first, so `b` has the same kind as `a`.
      const bs = (b as SequencePath | AlternativePath).paths;
      return a.paths.length === bs.length && a.paths.every((p, i) => equals(p, bs[i]!));
    }),
    Match.orElse((a) => {
      // SAFETY: `equals` compared the tags first, so `b` has the same kind as `a`.
      return equals(a.path, (b as InversePath).path);
    }),
  );
};

/**
 * Renders a path in SPARQL property path syntax, e.g. `^<p>/<q>*`.
 *
 * @since 0.1.0
 * @category formatting
 */
export const toSparql = (self: Path): string => {
  const wrap = (p: Path) =>
    p._tag === 'SequencePath' || p._tag === 'AlternativePath' ? `(${toSparql(p)})` : toSparql(p);
  return Match.value(self).pipe(
    Match.tag('PredicatePath', (self) => self.predicate.key),
    Match.tag('SequencePath', (self) => self.paths.map(wrap).join('/')),
    Match.tag('AlternativePath', (self) => self.paths.map(wrap).join('|')),
    Match.tag('InversePath', (self) => `^${wrap(self.path)}`),
    Match.tag('ZeroOrMorePath', (self) => `${wrap(self.path)}*`),
    Match.tag('OneOrMorePath', (self) => `${wrap(self.path)}+`),
    Match.tag('ZeroOrOnePath', (self) => `${wrap(self.path)}?`),
    Match.exhaustive,
  );
};

// -----------------------------------------------------------------------------
// Evaluation
// -----------------------------------------------------------------------------

type Node = Term.GroundTerm;

const step = (
  data: Dataset.Dataset,
  nodes: ReadonlyMap<string, Node>,
  path: Path,
  inverse: boolean,
): Map<string, Node> => {
  const out = new Map<string, Node>();
  return Match.value(path).pipe(
    Match.tag('PredicatePath', (path) => {
      for (const node of nodes.values()) {
        if (inverse) {
          // SAFETY: path values are nodes, which can be objects.
          for (const q of Dataset.match(data, {
            predicate: path.predicate,
            object: node as Term.Object,
          })) {
            out.set(q.subject.key, q.subject);
          }
        } else {
          if (node._tag === 'Literal') continue;
          for (const q of Dataset.match(data, { subject: node, predicate: path.predicate })) {
            out.set(q.object.key, q.object);
          }
        }
      }
      return out;
    }),
    Match.tag('SequencePath', (path) => {
      const parts = inverse ? path.paths.toReversed() : path.paths;
      let current: ReadonlyMap<string, Node> = nodes;
      for (const p of parts) current = step(data, current, p, inverse);
      // SAFETY: `step` returns a fresh map for every path kind.
      return current as Map<string, Node>;
    }),
    Match.tag('AlternativePath', (path) => {
      for (const p of path.paths) for (const [k, v] of step(data, nodes, p, inverse)) out.set(k, v);
      return out;
    }),
    Match.tag('InversePath', (path) => step(data, nodes, path.path, !inverse)),
    Match.tag('ZeroOrOnePath', (path) => {
      for (const [k, v] of nodes) out.set(k, v);
      for (const [k, v] of step(data, nodes, path.path, inverse)) out.set(k, v);
      return out;
    }),
    Match.tag('ZeroOrMorePath', 'OneOrMorePath', (path) => {
      if (path._tag === 'ZeroOrMorePath') for (const [k, v] of nodes) out.set(k, v);
      // Breadth-first closure, starting from each node's one-step successors.
      let frontier = step(data, nodes, path.path, inverse);
      while (frontier.size > 0) {
        const next = new Map<string, Node>();
        for (const [k, v] of frontier) {
          if (out.has(k)) continue;
          out.set(k, v);
          next.set(k, v);
        }
        frontier = next.size > 0 ? step(data, next, path.path, inverse) : next;
      }
      return out;
    }),
    Match.exhaustive,
  );
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
  Array.from(step(data, new Map([[focus.key, focus]]), path, false).values());

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
  const visiting = new Set<string>();
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
    if (n._tag === 'NamedNode') return predicate(n);
    if (n._tag !== 'BlankNode') return bad(n, `${n.key} is not a valid SHACL path`);
    if (visiting.has(n.key)) return bad(n, `${n.key} is a recursive path`);
    visiting.add(n.key);
    const read = Result.try(() => readNode(n));
    visiting.delete(n.key);
    if (Result.isFailure(read)) throw read.failure;
    return read.success;
  };
  const readNode = (n: Term.BlankNode): Path => {
    if (Arr.isReadonlyArrayNonEmpty(Dataset.match(graph, { subject: n, predicate: rdf.first }))) {
      return sequence(...readList(n, n, 'sequence'));
    }
    const single = (p: Term.NamedNode): Term.Term | undefined => {
      const values = Dataset.objectsOf(graph, n, p);
      if (values.length > 1) bad(n, `${n.key} has multiple values for ${p.key}`);
      return values[0];
    };
    const alt = single(sh.alternativePath);
    if (alt !== undefined) return alternative(...readList(n, alt, 'alternative'));
    const inv = single(sh.inversePath);
    if (inv !== undefined) return inverse(go(inv));
    const zom = single(sh.zeroOrMorePath);
    if (zom !== undefined) return zeroOrMore(go(zom));
    const oom = single(sh.oneOrMorePath);
    if (oom !== undefined) return oneOrMore(go(oom));
    const zoo = single(sh.zeroOrOnePath);
    if (zoo !== undefined) return zeroOrOne(go(zoo));
    return bad(n, `${n.key} is not a valid SHACL path`);
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
    items.forEach((item, i) => {
      quads.push(Term.quad(nodes[i]!, rdf.first, go(item), graph));
      quads.push(Term.quad(nodes[i]!, rdf.rest, nodes[i + 1] ?? rdf.nil, graph));
    });
    return nodes[0] ?? rdf.nil;
  };
  const unary = (p: Term.NamedNode, inner: Path) => {
    const b = Term.blankNode();
    quads.push(Term.quad(b, p, go(inner), graph));
    return b;
  };
  const go = (p: Path): Term.NamedNode | Term.BlankNode => {
    return Match.value(p).pipe(
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
