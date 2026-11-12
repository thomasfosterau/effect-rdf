/**
 * Schema indexing and the ShEx structural requirements: every reference
 * resolves, inclusions name triple expressions, shape expressions do not
 * refer to themselves except through triple constraints, there is no
 * reference cycle through negation (`NOT` or `EXTRA`), and the extension
 * hierarchy is acyclic.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as HashMap from 'effect/HashMap';
import * as Iterable from 'effect/Iterable';
import * as Match from 'effect/Match';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import { iterate } from './internal/iterate.ts';
import { ShExStructureError } from './ShExError.ts';
import type * as ShExJ from './ShExJ.ts';
import * as Predicate from 'effect/Predicate';

/**
 * An index of the declarations of a schema.
 *
 * @since 0.1.0
 * @category models
 */
export interface SchemaIndex {
  readonly schema: ShExJ.Schema;
  /** Shape declarations by label. */
  readonly shapes: HashMap.HashMap<string, ShExJ.ShapeDecl>;
  /** Labelled triple expressions by label. */
  readonly tripleExprs: HashMap.HashMap<string, ShExJ.TripleExpr>;
  /**
   * The extension hierarchy: for each label, the labels of the declarations
   * that (directly or transitively) extend it.
   */
  readonly descendants: HashMap.HashMap<string, ReadonlyArray<string>>;
}

const forEachShapeExprChild: (
  e: ShExJ.ShapeExpr,
  f: (child: ShExJ.ShapeExprOrRef) => void,
) => void = Match.fn((e: ShExJ.ShapeExpr, _f: (child: ShExJ.ShapeExprOrRef) => void) => e).pipe(
  Match.when({ type: Match.is('ShapeAnd', 'ShapeOr') }, (e, _e, f) => e.shapeExprs.forEach(f)),
  Match.when({ type: 'ShapeNot' }, (e, _e, f) => f(e.shapeExpr)),
  Match.orElse(() => undefined),
);

type Labels<A> = MutableHashMap.MutableHashMap<string, A>;

/** Collects the labelled triple expressions of a shape expression tree. */
const collectTripleExprs = (
  root: ShExJ.ShapeExprOrRef,
  out: Labels<ShExJ.TripleExpr>,
  duplicates: Array<string>,
): void => {
  const visitShape = (e: ShExJ.ShapeExprOrRef): void => {
    if (Predicate.isString(e)) return;
    if (e.type === 'Shape') {
      e.extends?.forEach(visitShape);
      if (e.expression !== undefined) visitTriple(e.expression);
      return;
    }
    forEachShapeExprChild(e, visitShape);
  };
  const visitTriple = (t: ShExJ.TripleExprOrRef): void => {
    if (Predicate.isString(t)) return;
    if (t.id !== undefined) {
      const id = t.id;
      if (Option.exists(MutableHashMap.get(out, id), (existing) => existing !== t))
        duplicates.push(id);
      MutableHashMap.set(out, id, t);
    }
    if (t.type === 'TripleConstraint') {
      if (t.valueExpr !== undefined) visitShape(t.valueExpr);
    } else {
      t.expressions.forEach(visitTriple);
    }
  };
  visitShape(root);
};

/** The labelled triple expressions of a schema, and the labels declared more than once. */
interface TripleExprIndex {
  readonly tripleExprs: Labels<ShExJ.TripleExpr>;
  readonly duplicates: Array<string>;
}

const tripleExprsOf = (schema: ShExJ.Schema): TripleExprIndex => {
  const tripleExprs = MutableHashMap.empty<string, ShExJ.TripleExpr>();
  const duplicates: Array<string> = [];
  schema.shapes?.forEach((d) => {
    collectTripleExprs(d.shapeExpr, tripleExprs, duplicates);
    d.restricts?.forEach((r) => collectTripleExprs(r, tripleExprs, duplicates));
  });
  if (schema.start !== undefined) collectTripleExprs(schema.start, tripleExprs, duplicates);
  return { tripleExprs, duplicates };
};

/** `nestedShapes`, with the declarations looked up by `declOf`. */
const nestedShapesBy = (
  declOf: (label: string) => Option.Option<ShExJ.ShapeDecl>,
  e: ShExJ.ShapeExprOrRef,
): ReadonlyArray<ShExJ.Shape> => {
  const out: Array<ShExJ.Shape> = [];
  const seen = MutableHashSet.empty<string>();
  const go = (x: ShExJ.ShapeExprOrRef): void => {
    if (Predicate.isString(x)) {
      if (MutableHashSet.has(seen, x)) return;
      MutableHashSet.add(seen, x);
      Option.map(declOf(x), (decl) => go(decl.shapeExpr));
      return;
    }
    if (x.type === 'Shape') out.push(x);
    else forEachShapeExprChild(x, go);
  };
  go(e);
  return out;
};

/**
 * The shapes nested in a shape expression (following references but not
 * triple constraints), per the ShEx 2.2 `nestedShapes` definition.
 *
 * @since 0.1.0
 * @category utils
 */
export const nestedShapes = (
  shapes: ReadonlyMap<string, ShExJ.ShapeDecl>,
  e: ShExJ.ShapeExprOrRef,
): ReadonlyArray<ShExJ.Shape> =>
  nestedShapesBy((label) => Option.fromUndefinedOr(shapes.get(label)), e);

/** All shape labels referenced inside a shape expression (anywhere). */
const refsOf = (e: ShExJ.ShapeExprOrRef, out: Array<string>): void => {
  if (Predicate.isString(e)) {
    out.push(e);
    return;
  }
  if (e.type === 'Shape') {
    // only the extends clause, not the triple expression
    e.extends?.forEach((x) => refsOf(x, out));
    return;
  }
  forEachShapeExprChild(e, (c) => refsOf(c, out));
};

/** The labels a declaration extends: the references in the `EXTENDS` of its nested shapes. */
const parentsOf = (
  declOf: (label: string) => Option.Option<ShExJ.ShapeDecl>,
  d: ShExJ.ShapeDecl,
): Array<string> => {
  const parents: Array<string> = [];
  nestedShapesBy(declOf, d.shapeExpr).forEach((s) =>
    s.extends?.forEach((ext) => refsOf(ext, parents)),
  );
  return parents;
};

/** Appends `value` to the list of `key`, starting the list if there is none. */
const append = <A>(map: Labels<Array<A>>, key: string, value: A): void =>
  Option.match(MutableHashMap.get(map, key), {
    onNone: () => {
      MutableHashMap.set(map, key, [value]);
    },
    onSome: (list) => {
      list.push(value);
    },
  });

/** The labels reachable from `label` in `children` (depth first, each once). */
const descendantsOf = (children: Labels<Array<string>>, label: string): ReadonlyArray<string> => {
  const out: Array<string> = [];
  const seen = MutableHashSet.make(label);
  const stack = [label];
  iterate(stack, (pending) => {
    const l = pending.pop();
    if (l === undefined) return Option.none();
    Option.getOrElse(MutableHashMap.get(children, l), () => []).forEach((c) => {
      if (MutableHashSet.has(seen, c)) return;
      MutableHashSet.add(seen, c);
      out.push(c);
      pending.push(c);
    });
    return Option.some(pending);
  });
  return out;
};

/**
 * Builds the index of a schema (which should already include the
 * declarations of its imports).
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeIndex = (schema: ShExJ.Schema): SchemaIndex => {
  const decls = MutableHashMap.fromIterable(
    Arr.map(schema.shapes ?? [], (d) => [d.id, d] as const),
  );
  const declOf = (label: string) => MutableHashMap.get(decls, label);
  const { tripleExprs } = tripleExprsOf(schema);
  // Extension hierarchy: parent label -> direct children (each once, in order).
  const children = MutableHashMap.empty<string, Array<string>>();
  schema.shapes?.forEach((d) =>
    parentsOf(declOf, d).forEach((p) => {
      if (!Option.exists(MutableHashMap.get(children, p), (l) => l.includes(d.id)))
        append(children, p, d.id);
    }),
  );
  return {
    schema,
    shapes: HashMap.fromIterable(decls),
    tripleExprs: HashMap.fromIterable(tripleExprs),
    descendants: HashMap.fromIterable(
      Arr.map(Arr.fromIterable(MutableHashMap.keys(children)), (label) => [
        label,
        descendantsOf(children, label),
      ]),
    ),
  };
};

// -----------------------------------------------------------------------------
// Structural checks
// -----------------------------------------------------------------------------

interface Edge {
  readonly to: string;
  readonly negative: boolean;
}

/** The cycles of a dependency graph, each rendered as `a -> b -> a`. */
const cyclesOf = (graph: Labels<ReadonlyArray<string>>): ReadonlyArray<string> => {
  // 1: on the current path; 2: done.
  const state = MutableHashMap.empty<string, number>();
  const found: Array<string> = [];
  const visit = (n: string, path: Array<string>): void => {
    const s = MutableHashMap.get(state, n);
    if (Option.contains(s, 2)) return;
    if (Option.contains(s, 1)) {
      found.push([...path.slice(path.indexOf(n)), n].join(' -> '));
      return;
    }
    MutableHashMap.set(state, n, 1);
    path.push(n);
    Option.getOrElse(MutableHashMap.get(graph, n), () => []).forEach((m) => visit(m, path));
    path.pop();
    MutableHashMap.set(state, n, 2);
  };
  Iterable.forEach(MutableHashMap.keys(graph), (n) => visit(n, []));
  return found;
};

/**
 * Returns the structural problems of a schema (empty when it is
 * well-formed). When `allowUnresolved` is set, references to undeclared
 * labels are tolerated (e.g. before imports have been loaded).
 *
 * @since 0.1.0
 * @category checks
 */
export const problems = (
  schema: ShExJ.Schema,
  options: { readonly allowUnresolved?: boolean } = {},
): ReadonlyArray<string> => {
  const errors: Array<string> = [];
  const shapes = MutableHashMap.empty<string, ShExJ.ShapeDecl>();
  schema.shapes?.forEach((d) => {
    if (MutableHashMap.has(shapes, d.id)) errors.push(`shape ${d.id} is declared more than once`);
    MutableHashMap.set(shapes, d.id, d);
  });
  const isShape = (label: string) => MutableHashMap.has(shapes, label);
  const { tripleExprs, duplicates } = tripleExprsOf(schema);
  duplicates.forEach((d) => errors.push(`triple expression ${d} is declared more than once`));
  Iterable.forEach(MutableHashMap.keys(tripleExprs), (l) => {
    if (isShape(l)) errors.push(`${l} labels both a shape and a triple expression`);
  });

  const checkRef = (label: string) => {
    if (!isShape(label) && options.allowUnresolved !== true)
      errors.push(`reference to undeclared shape ${label}`);
  };
  const checkInclude = (label: string) => {
    if (MutableHashMap.has(tripleExprs, label)) return;
    if (isShape(label)) errors.push(`inclusion &${label} names a shape, not a triple expression`);
    else if (options.allowUnresolved !== true)
      errors.push(`inclusion of undeclared triple expression ${label}`);
  };

  // Dependency graph with polarity, and the direct (non-triple) reference graph.
  const deps = MutableHashMap.empty<string, Array<Edge>>();
  const direct = MutableHashMap.empty<string, Array<string>>();

  const walkShape = (
    from: string,
    e: ShExJ.ShapeExprOrRef,
    negative: boolean,
    isDirect: boolean,
    visitingIncludes: MutableHashSet.MutableHashSet<string>,
  ): void => {
    if (Predicate.isString(e)) {
      checkRef(e);
      append(deps, from, { to: e, negative });
      if (isDirect) append(direct, from, e);
      return;
    }
    Match.value(e).pipe(
      Match.discriminator('type')('ShapeAnd', 'ShapeOr', (expr) =>
        expr.shapeExprs.forEach((c) => walkShape(from, c, negative, isDirect, visitingIncludes)),
      ),
      Match.discriminator('type')('ShapeNot', (expr) =>
        walkShape(from, expr.shapeExpr, true, isDirect, visitingIncludes),
      ),
      Match.discriminator('type')('Shape', (expr) => {
        expr.extends?.forEach((x) => walkShape(from, x, negative, false, visitingIncludes));
        const extra = MutableHashSet.fromIterable(expr.extra ?? []);
        if (expr.expression !== undefined)
          walkTriple(from, expr.expression, negative, extra, visitingIncludes);
      }),
      Match.orElse(() => undefined),
    );
  };
  const walkTriple = (
    from: string,
    t: ShExJ.TripleExprOrRef,
    negative: boolean,
    extra: MutableHashSet.MutableHashSet<string>,
    visitingIncludes: MutableHashSet.MutableHashSet<string>,
  ): void => {
    if (Predicate.isString(t)) {
      checkInclude(t);
      if (MutableHashSet.has(visitingIncludes, t)) return;
      Option.map(MutableHashMap.get(tripleExprs, t), (target) => {
        MutableHashSet.add(visitingIncludes, t);
        walkTriple(from, target, negative, extra, visitingIncludes);
        MutableHashSet.remove(visitingIncludes, t);
      });
      return;
    }
    if (t.type === 'TripleConstraint') {
      if (t.valueExpr !== undefined) {
        const neg = negative || (MutableHashSet.has(extra, t.predicate) && t.inverse !== true);
        walkShape(from, t.valueExpr, neg, false, visitingIncludes);
      }
      return;
    }
    t.expressions.forEach((c) => walkTriple(from, c, negative, extra, visitingIncludes));
  };

  const roots = Arr.flatMap(schema.shapes ?? [], (d) => [
    [d.id, d.shapeExpr] as const,
    ...Arr.map(d.restricts ?? [], (r) => [d.id, r] as const),
  ]);
  roots.forEach(([label]) => {
    MutableHashMap.set(deps, label, []);
    MutableHashMap.set(direct, label, []);
  });
  roots.forEach(([label, expr]) => walkShape(label, expr, false, true, MutableHashSet.empty()));
  if (schema.start !== undefined) {
    MutableHashMap.set(deps, '\u0000start', []);
    MutableHashMap.set(direct, '\u0000start', []);
    walkShape('\u0000start', schema.start, false, true, MutableHashSet.empty());
  }

  // Direct self-reference cycles.
  cyclesOf(direct).forEach((c) => errors.push(`shape expression refers to itself: ${c}`));

  // Negation requirement: no strongly connected component contains a negative edge.
  const sccOf = tarjan(Arr.fromIterable(MutableHashMap.keys(deps)), (n) =>
    Arr.map(
      Option.getOrElse(MutableHashMap.get(deps, n), () => []),
      (e) => e.to,
    ),
  );
  Iterable.forEach(deps, ([from, edges]) =>
    edges.forEach((e) => {
      const component = MutableHashMap.get(sccOf, from);
      if (
        e.negative &&
        Option.exists(component, (c) => Option.contains(MutableHashMap.get(sccOf, e.to), c))
      ) {
        errors.push(`reference cycle through negation between ${from} and ${e.to}`);
      }
    }),
  );

  // Acyclic extension hierarchy.
  const declOf = (label: string) => MutableHashMap.get(shapes, label);
  const extendsGraph = MutableHashMap.empty<string, ReadonlyArray<string>>();
  schema.shapes?.forEach((d) => MutableHashMap.set(extendsGraph, d.id, parentsOf(declOf, d)));
  cyclesOf(extendsGraph).forEach((c) => errors.push(`cyclic extension hierarchy: ${c}`));
  return Arr.dedupe(errors);
};

/** Tarjan's bookkeeping for one node. */
interface Visited {
  readonly index: number;
  low: number;
  onStack: boolean;
}

/** The strongly connected component of every node, by Tarjan's algorithm. */
const tarjan = (
  nodes: ReadonlyArray<string>,
  succ: (n: string) => ReadonlyArray<string>,
): Labels<number> => {
  let index = 0;
  let component = 0;
  const visited = MutableHashMap.empty<string, Visited>();
  const stack: Array<string> = [];
  const result = MutableHashMap.empty<string, number>();
  const strong = (v: string): Visited => {
    const nv: Visited = { index, low: index, onStack: true };
    MutableHashMap.set(visited, v, nv);
    index++;
    stack.push(v);
    succ(v).forEach((w) =>
      Option.match(MutableHashMap.get(visited, w), {
        onNone: () => {
          nv.low = Math.min(nv.low, strong(w).low);
        },
        onSome: (nw) => {
          if (nw.onStack) nv.low = Math.min(nv.low, nw.index);
        },
      }),
    );
    if (nv.low === nv.index) {
      // Pop the component, down to and including `v`.
      iterate(stack, (pending) => {
        const w = pending.pop();
        if (w === undefined) return Option.none();
        Option.map(MutableHashMap.get(visited, w), (nw) => {
          nw.onStack = false;
        });
        MutableHashMap.set(result, w, component);
        return w === v ? Option.none() : Option.some(pending);
      });
      component++;
    }
    return nv;
  };
  nodes.forEach((n) => {
    if (!MutableHashMap.has(visited, n)) strong(n);
  });
  return result;
};

/**
 * Checks the structural requirements of a schema, failing with a
 * `ShExStructureError` listing the problems.
 *
 * @since 0.1.0
 * @category checks
 */
export const check = (
  schema: ShExJ.Schema,
  options: { readonly allowUnresolved?: boolean } = {},
): Effect.Effect<ShExJ.Schema, ShExStructureError> =>
  Effect.suspend(() => {
    const errs = problems(schema, options);
    return Arr.isReadonlyArrayEmpty(errs)
      ? Effect.succeed(schema)
      : Effect.fail(new ShExStructureError({ message: errs.join('; ') }));
  });
