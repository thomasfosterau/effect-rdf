/**
 * Schema indexing and the ShEx structural requirements: every reference
 * resolves, inclusions name triple expressions, shape expressions do not
 * refer to themselves except through triple constraints, there is no
 * reference cycle through negation (`NOT` or `EXTRA`), and the extension
 * hierarchy is acyclic.
 *
 * @since 0.1.0
 */
import * as Effect from 'effect/Effect';
import { ShExStructureError } from './ShExError.ts';
import type * as ShExJ from './ShExJ.ts';

/**
 * An index of the declarations of a schema.
 *
 * @since 0.1.0
 * @category models
 */
export interface SchemaIndex {
  readonly schema: ShExJ.Schema;
  /** Shape declarations by label. */
  readonly shapes: ReadonlyMap<string, ShExJ.ShapeDecl>;
  /** Labelled triple expressions by label. */
  readonly tripleExprs: ReadonlyMap<string, ShExJ.TripleExpr>;
  /**
   * The extension hierarchy: for each label, the labels of the declarations
   * that (directly or transitively) extend it.
   */
  readonly descendants: ReadonlyMap<string, ReadonlyArray<string>>;
}

const forEachShapeExprChild = (
  e: ShExJ.ShapeExpr,
  f: (child: ShExJ.ShapeExprOrRef) => void,
): void => {
  switch (e.type) {
    case 'ShapeAnd':
    case 'ShapeOr':
      e.shapeExprs.forEach(f);
      break;
    case 'ShapeNot':
      f(e.shapeExpr);
      break;
    default:
      break;
  }
};

/** Collects the labelled triple expressions of a shape expression tree. */
const collectTripleExprs = (
  root: ShExJ.ShapeExprOrRef,
  out: Map<string, ShExJ.TripleExpr>,
  duplicates: Array<string>,
): void => {
  const visitShape = (e: ShExJ.ShapeExprOrRef): void => {
    if (typeof e === 'string') return;
    if (e.type === 'Shape') {
      e.extends?.forEach(visitShape);
      if (e.expression !== undefined) visitTriple(e.expression);
      return;
    }
    forEachShapeExprChild(e, visitShape);
  };
  const visitTriple = (t: ShExJ.TripleExprOrRef): void => {
    if (typeof t === 'string') return;
    if (t.id !== undefined) {
      const existing = out.get(t.id);
      if (existing !== undefined && existing !== t) duplicates.push(t.id);
      out.set(t.id, t);
    }
    if (t.type === 'TripleConstraint') {
      if (t.valueExpr !== undefined) visitShape(t.valueExpr);
    } else {
      t.expressions.forEach(visitTriple);
    }
  };
  visitShape(root);
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
): ReadonlyArray<ShExJ.Shape> => {
  const out: Array<ShExJ.Shape> = [];
  const seen = new Set<string>();
  const go = (x: ShExJ.ShapeExprOrRef): void => {
    if (typeof x === 'string') {
      if (seen.has(x)) return;
      seen.add(x);
      const decl = shapes.get(x);
      if (decl !== undefined) go(decl.shapeExpr);
      return;
    }
    if (x.type === 'Shape') out.push(x);
    else forEachShapeExprChild(x, go);
  };
  go(e);
  return out;
};

/** All shape labels referenced inside a shape expression (anywhere). */
const refsOf = (e: ShExJ.ShapeExprOrRef, out: Array<string>): void => {
  if (typeof e === 'string') {
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

/**
 * Builds the index of a schema (which should already include the
 * declarations of its imports).
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeIndex = (schema: ShExJ.Schema): SchemaIndex => {
  const shapes = new Map<string, ShExJ.ShapeDecl>();
  for (const d of schema.shapes ?? []) shapes.set(d.id, d);
  const tripleExprs = new Map<string, ShExJ.TripleExpr>();
  const duplicates: Array<string> = [];
  for (const d of schema.shapes ?? []) {
    collectTripleExprs(d.shapeExpr, tripleExprs, duplicates);
    d.restricts?.forEach((r) => collectTripleExprs(r, tripleExprs, duplicates));
  }
  if (schema.start !== undefined) collectTripleExprs(schema.start, tripleExprs, duplicates);
  // Extension hierarchy: parent label -> direct children.
  const children = new Map<string, Set<string>>();
  for (const d of schema.shapes ?? []) {
    for (const s of nestedShapes(shapes, d.shapeExpr)) {
      for (const ext of s.extends ?? []) {
        const parents: Array<string> = [];
        refsOf(ext, parents);
        for (const p of parents) {
          let set = children.get(p);
          if (set === undefined) children.set(p, (set = new Set()));
          set.add(d.id);
        }
      }
    }
  }
  const descendants = new Map<string, ReadonlyArray<string>>();
  for (const label of children.keys()) {
    const out: Array<string> = [];
    const seen = new Set<string>([label]);
    const stack = [label];
    while (stack.length > 0) {
      const l = stack.pop()!;
      for (const c of children.get(l) ?? []) {
        if (!seen.has(c)) {
          seen.add(c);
          out.push(c);
          stack.push(c);
        }
      }
    }
    descendants.set(label, out);
  }
  return { schema, shapes, tripleExprs, descendants };
};

// -----------------------------------------------------------------------------
// Structural checks
// -----------------------------------------------------------------------------

interface Edge {
  readonly to: string;
  readonly negative: boolean;
}

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
  const shapes = new Map<string, ShExJ.ShapeDecl>();
  for (const d of schema.shapes ?? []) {
    if (shapes.has(d.id)) errors.push(`shape ${d.id} is declared more than once`);
    shapes.set(d.id, d);
  }
  const tripleExprs = new Map<string, ShExJ.TripleExpr>();
  const duplicates: Array<string> = [];
  for (const d of schema.shapes ?? []) {
    collectTripleExprs(d.shapeExpr, tripleExprs, duplicates);
    d.restricts?.forEach((r) => collectTripleExprs(r, tripleExprs, duplicates));
  }
  if (schema.start !== undefined) collectTripleExprs(schema.start, tripleExprs, duplicates);
  for (const d of duplicates) errors.push(`triple expression ${d} is declared more than once`);
  for (const l of tripleExprs.keys()) {
    if (shapes.has(l)) errors.push(`${l} labels both a shape and a triple expression`);
  }

  const checkRef = (label: string) => {
    if (!shapes.has(label) && options.allowUnresolved !== true)
      errors.push(`reference to undeclared shape ${label}`);
  };
  const checkInclude = (label: string) => {
    if (tripleExprs.has(label)) return;
    if (shapes.has(label)) errors.push(`inclusion &${label} names a shape, not a triple expression`);
    else if (options.allowUnresolved !== true)
      errors.push(`inclusion of undeclared triple expression ${label}`);
  };

  // Dependency graph with polarity, and the direct (non-triple) reference graph.
  const deps = new Map<string, Array<Edge>>();
  const direct = new Map<string, Array<string>>();

  const walkShape = (
    from: string,
    e: ShExJ.ShapeExprOrRef,
    negative: boolean,
    isDirect: boolean,
    visitingIncludes: Set<string>,
  ): void => {
    if (typeof e === 'string') {
      checkRef(e);
      deps.get(from)!.push({ to: e, negative });
      if (isDirect) direct.get(from)!.push(e);
      return;
    }
    switch (e.type) {
      case 'ShapeAnd':
      case 'ShapeOr':
        for (const c of e.shapeExprs) walkShape(from, c, negative, isDirect, visitingIncludes);
        return;
      case 'ShapeNot':
        walkShape(from, e.shapeExpr, true, isDirect, visitingIncludes);
        return;
      case 'Shape': {
        for (const x of e.extends ?? []) walkShape(from, x, negative, false, visitingIncludes);
        const extra = new Set(e.extra ?? []);
        if (e.expression !== undefined)
          walkTriple(from, e.expression, negative, extra, visitingIncludes);
        return;
      }
      default:
        return;
    }
  };
  const walkTriple = (
    from: string,
    t: ShExJ.TripleExprOrRef,
    negative: boolean,
    extra: ReadonlySet<string>,
    visitingIncludes: Set<string>,
  ): void => {
    if (typeof t === 'string') {
      checkInclude(t);
      const target = tripleExprs.get(t);
      if (target !== undefined && !visitingIncludes.has(t)) {
        visitingIncludes.add(t);
        walkTriple(from, target, negative, extra, visitingIncludes);
        visitingIncludes.delete(t);
      }
      return;
    }
    if (t.type === 'TripleConstraint') {
      if (t.valueExpr !== undefined) {
        const neg = negative || (extra.has(t.predicate) && t.inverse !== true);
        walkShape(from, t.valueExpr, neg, false, visitingIncludes);
      }
      return;
    }
    for (const c of t.expressions) walkTriple(from, c, negative, extra, visitingIncludes);
  };

  const roots: Array<readonly [string, ShExJ.ShapeExprOrRef]> = [];
  for (const d of schema.shapes ?? []) {
    roots.push([d.id, d.shapeExpr]);
    for (const r of d.restricts ?? []) roots.push([d.id, r]);
  }
  for (const [label] of roots) {
    deps.set(label, []);
    direct.set(label, []);
  }
  for (const [label, expr] of roots) walkShape(label, expr, false, true, new Set());
  if (schema.start !== undefined) {
    deps.set('\u0000start', []);
    direct.set('\u0000start', []);
    walkShape('\u0000start', schema.start, false, true, new Set());
  }

  // Direct self-reference cycles.
  const cyclic = (graph: ReadonlyMap<string, ReadonlyArray<string>>): ReadonlyArray<string> => {
    const state = new Map<string, number>();
    const found: Array<string> = [];
    const visit = (n: string, path: Array<string>): void => {
      const s = state.get(n);
      if (s === 2) return;
      if (s === 1) {
        found.push([...path.slice(path.indexOf(n)), n].join(' -> '));
        return;
      }
      state.set(n, 1);
      path.push(n);
      for (const m of graph.get(n) ?? []) visit(m, path);
      path.pop();
      state.set(n, 2);
    };
    for (const n of graph.keys()) visit(n, []);
    return found;
  };
  for (const c of cyclic(direct)) errors.push(`shape expression refers to itself: ${c}`);

  // Negation requirement: no strongly connected component contains a negative edge.
  const sccOf = tarjan(Array.from(deps.keys()), (n) => (deps.get(n) ?? []).map((e) => e.to));
  for (const [from, edges] of deps) {
    for (const e of edges) {
      if (e.negative && sccOf.get(from) !== undefined && sccOf.get(from) === sccOf.get(e.to)) {
        errors.push(`reference cycle through negation between ${from} and ${e.to}`);
      }
    }
  }

  // Acyclic extension hierarchy.
  const extendsGraph = new Map<string, Array<string>>();
  for (const d of schema.shapes ?? []) {
    const parents: Array<string> = [];
    for (const s of nestedShapes(shapes, d.shapeExpr)) {
      for (const ext of s.extends ?? []) refsOf(ext, parents);
    }
    extendsGraph.set(d.id, parents);
  }
  for (const c of cyclic(extendsGraph)) errors.push(`cyclic extension hierarchy: ${c}`);
  return Array.from(new Set(errors));
};

const tarjan = (
  nodes: ReadonlyArray<string>,
  succ: (n: string) => ReadonlyArray<string>,
): ReadonlyMap<string, number> => {
  let index = 0;
  let component = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: Array<string> = [];
  const result = new Map<string, number>();
  const strong = (v: string): void => {
    indices.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of succ(v)) {
      if (!indices.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, indices.get(w)!));
      }
    }
    if (low.get(v) === indices.get(v)) {
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        result.set(w, component);
      } while (w !== v);
      component++;
    }
  };
  for (const n of nodes) if (!indices.has(n)) strong(n);
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
    return errs.length === 0
      ? Effect.succeed(schema)
      : Effect.fail(new ShExStructureError({ message: errs.join('; ') }));
  });
