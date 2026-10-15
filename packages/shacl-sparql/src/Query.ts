/**
 * SHACL-SPARQL queries: reading the `sh:select` / `sh:ask` queries of a
 * shapes graph with their prefix declarations (§5.2.1), enforcing the
 * syntactic restrictions of pre-binding (Appendix A) and substituting the
 * `$PATH` variable with a property path (§5.3, §6.3).
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Query } from "@thomasfosterau/effect-shacl-sparql"
 *
 * const program = Effect.gen(function* () {
 *   const query = yield* Query.compile(shapesGraph, constraintNode, {
 *     form: "select",
 *     prebound: ["this", "shapesGraph", "currentShape"],
 *     path: shape.path,
 *   })
 * })
 * ```
 *
 * @since 0.1.0
 */
import { Dataset, Term } from '@thomasfosterau/effect-rdf';
import { Path, Sparql, Vocabulary } from '@thomasfosterau/effect-shacl';
import { Ast, Parser } from '@thomasfosterau/effect-sparql';
import * as Effect from 'effect/Effect';
import * as Result from 'effect/Result';

const { sh } = Vocabulary;
const owlImports = Term.namedNode('http://www.w3.org/2002/07/owl#imports');

/**
 * The variables that are optional to pre-bind (and to project from
 * sub-queries): `$shapesGraph` and `$currentShape`.
 *
 * @since 0.1.0
 * @category constants
 */
export const optionalPrebound: ReadonlySet<string> = new Set(['shapesGraph', 'currentShape']);

const fail = (message: string): Result.Result<never, Sparql.SparqlEvaluationError> =>
  Result.fail(new Sparql.SparqlEvaluationError({ message }));

// -----------------------------------------------------------------------------
// Prefixes
// -----------------------------------------------------------------------------

/**
 * The prefix mappings of a SPARQL executable: the union of the
 * `sh:prefix` / `sh:namespace` pairs reachable via
 * `sh:prefixes/owl:imports* /sh:declare`. Fails when a prefix is declared
 * with two different namespaces (an ill-formed shapes graph) or a
 * declaration is malformed.
 *
 * @since 0.1.0
 * @category prefixes
 */
export const prefixes = (
  shapesGraph: Dataset.Dataset,
  node: Term.NamedNode | Term.BlankNode,
): Result.Result<Readonly<Record<string, string>>, Sparql.SparqlEvaluationError> => {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  const stack: Array<Term.GroundTerm> = [...Dataset.objectsOf(shapesGraph, node, sh.prefixes)];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current.key) || current._tag === 'Literal' || current._tag === 'Triple') continue;
    seen.add(current.key);
    stack.push(...Dataset.objectsOf(shapesGraph, current, owlImports));
    for (const declaration of Dataset.objectsOf(shapesGraph, current, sh.declare)) {
      if (declaration._tag === 'Literal' || declaration._tag === 'Triple') {
        return fail(`sh:declare of ${current.key} must be an IRI or blank node`);
      }
      const prefix = Dataset.objectsOf(shapesGraph, declaration, sh.prefix);
      const namespace = Dataset.objectsOf(shapesGraph, declaration, sh.namespace);
      if (
        prefix.length !== 1 ||
        namespace.length !== 1 ||
        prefix[0]!._tag !== 'Literal' ||
        (namespace[0]!._tag !== 'Literal' && namespace[0]!._tag !== 'NamedNode')
      ) {
        return fail(
          `prefix declaration ${declaration.key} needs exactly one literal sh:prefix and sh:namespace`,
        );
      }
      const name = prefix[0]!.value;
      const iri = namespace[0]!.value;
      const existing = out[name];
      if (existing !== undefined && existing !== iri) {
        return fail(`prefix "${name}" is declared with two namespaces: <${existing}> and <${iri}>`);
      }
      out[name] = iri;
    }
  }
  return Result.succeed(out);
};

// -----------------------------------------------------------------------------
// Walking queries
// -----------------------------------------------------------------------------

interface Visitor {
  readonly pattern?: (p: Ast.Pattern) => string | undefined;
  readonly query?: (q: Ast.Query, nested: boolean) => string | undefined;
  readonly variable?: (name: string) => string | undefined;
}

const termVariables = (t: Ast.TermPattern | Term.Term, out: (name: string) => void): void => {
  if (t._tag === 'Variable') out(t.value);
  else if (t._tag === 'Triple') {
    termVariables(t.subject, out);
    termVariables(t.predicate, out);
    termVariables(t.object, out);
  }
};

/** Visits every pattern, (sub-)query and variable occurrence; returns the first error. */
const walk = (root: Ast.Query, visitor: Visitor): string | undefined => {
  let error: string | undefined;
  const report = (e: string | undefined) => {
    if (error === undefined && e !== undefined) error = e;
  };
  const variable = (name: string) => report(visitor.variable?.(name));
  const term = (t: Ast.TermPattern | Term.Term) => termVariables(t, variable);

  const expression = (e: Ast.Expression): void => {
    switch (e._tag) {
      case 'Variable':
      case 'Triple':
        term(e);
        return;
      case 'Operation':
      case 'FunctionCall':
        e.args.forEach(expression);
        return;
      case 'Aggregate':
        if (e.expression !== '*') expression(e.expression);
        return;
      case 'Exists':
        pattern(e.pattern);
        return;
      default:
        return;
    }
  };

  const pathTerms = (p: Ast.Path): void => {
    switch (p._tag) {
      case 'PathLink':
      case 'PathNegated':
        return;
      case 'PathSequence':
      case 'PathAlternative':
        p.paths.forEach(pathTerms);
        return;
      default:
        pathTerms(p.path);
    }
  };

  const pattern = (p: Ast.Pattern): void => {
    report(visitor.pattern?.(p));
    switch (p._tag) {
      case 'Bgp':
        for (const t of p.triples) {
          term(t.subject);
          if (t._tag === 'TriplePattern') term(t.predicate);
          else pathTerms(t.path);
          term(t.object);
        }
        return;
      case 'Group':
        p.patterns.forEach(pattern);
        return;
      case 'Optional':
      case 'Minus':
        pattern(p.pattern);
        return;
      case 'Union':
        p.patterns.forEach(pattern);
        return;
      case 'Graph':
      case 'Service':
        term(p.name);
        pattern(p.pattern);
        return;
      case 'Filter':
        expression(p.expression);
        return;
      case 'Bind':
        expression(p.expression);
        variable(p.variable.value);
        return;
      case 'Values':
        p.variables.forEach((v) => variable(v.value));
        return;
      case 'SubSelect':
        query(p.query, true);
        return;
    }
  };

  const query = (q: Ast.Query, nested: boolean): void => {
    report(visitor.query?.(q, nested));
    if (q._tag === 'Select' && q.projection !== '*') {
      for (const p of q.projection) {
        if (p._tag === 'Variable') variable(p.value);
        else {
          expression(p.expression);
          variable(p.variable.value);
        }
      }
    }
    if (q._tag === 'Construct')
      for (const t of q.template) [t.subject, t.predicate, t.object].forEach(term);
    if (q._tag === 'Describe' && q.terms !== '*') q.terms.forEach(term);
    pattern(q.where);
    for (const g of q.groupBy) {
      expression(g.expression);
      if (g.variable !== undefined) variable(g.variable.value);
    }
    q.having.forEach(expression);
    for (const o of q.orderBy) expression(o.expression);
    if (q.values !== undefined) pattern(q.values);
  };

  query(root, false);
  return error;
};

/**
 * Checks the restrictions that SHACL places on queries evaluated with
 * pre-bound variables (Appendix A "Pre-binding of Variables in SPARQL
 * Queries"): no `MINUS`, no `SERVICE`, no `VALUES`, no `AS ?var` for a
 * potentially pre-bound variable, and sub-queries must project every
 * potentially pre-bound variable (except `shapesGraph` and `currentShape`).
 *
 * @since 0.1.0
 * @category validation
 */
export const checkPrebinding = (
  query: Ast.Query,
  prebound: Iterable<string>,
): Result.Result<Ast.Query, Sparql.SparqlEvaluationError> => {
  const potential = new Set(prebound);
  const rebinds = (v: Term.Variable) =>
    potential.has(v.value)
      ? `the pre-bound variable ?${v.value} must not be assigned with AS`
      : undefined;
  const error = walk(query, {
    pattern: (p) => {
      switch (p._tag) {
        case 'Minus':
          return 'MINUS is not allowed in SHACL-SPARQL queries with pre-bound variables';
        case 'Service':
          return 'SERVICE is not allowed in SHACL-SPARQL queries with pre-bound variables';
        case 'Values':
          return 'VALUES is not allowed in SHACL-SPARQL queries with pre-bound variables';
        case 'Bind':
          return rebinds(p.variable);
        default:
          return undefined;
      }
    },
    query: (q, nested) => {
      if (q.values !== undefined)
        return 'VALUES is not allowed in SHACL-SPARQL queries with pre-bound variables';
      if (q._tag === 'Select' && q.projection !== '*') {
        for (const p of q.projection) {
          if (p._tag === 'Projection') {
            const e = rebinds(p.variable);
            if (e !== undefined) return e;
          }
        }
      }
      for (const g of q.groupBy) {
        if (g.variable !== undefined) {
          const e = rebinds(g.variable);
          if (e !== undefined) return e;
        }
      }
      if (nested && q._tag === 'Select') {
        const projected = new Set(Ast.projectedVariables(q));
        for (const v of potential) {
          if (!optionalPrebound.has(v) && !projected.has(v))
            return `sub-queries must project the pre-bound variable ?${v}`;
        }
      }
      return undefined;
    },
  });
  return error === undefined ? Result.succeed(query) : fail(error);
};

// -----------------------------------------------------------------------------
// $PATH substitution
// -----------------------------------------------------------------------------

/**
 * Converts a SHACL property path to a SPARQL property path.
 *
 * @since 0.1.0
 * @category paths
 */
export const toSparqlPath = (path: Path.Path): Ast.Path => {
  switch (path._tag) {
    case 'PredicatePath':
      return Ast.link(path.predicate);
    case 'SequencePath':
      return Ast.sequence(...path.paths.map(toSparqlPath));
    case 'AlternativePath':
      return Ast.alternative(...path.paths.map(toSparqlPath));
    case 'InversePath':
      return Ast.inverse(toSparqlPath(path.path));
    case 'ZeroOrMorePath':
      return Ast.zeroOrMore(toSparqlPath(path.path));
    case 'OneOrMorePath':
      return Ast.oneOrMore(toSparqlPath(path.path));
    case 'ZeroOrOnePath':
      return Ast.zeroOrOne(toSparqlPath(path.path));
  }
};

const PATH = 'PATH';

const mapGroup = (
  g: Ast.GroupPattern,
  f: (t: Ast.TriplePattern | Ast.PathPattern) => Ast.TriplePattern | Ast.PathPattern,
): Ast.GroupPattern => ({ ...g, patterns: g.patterns.map((p) => mapPattern(p, f)) });

const mapExpression = (
  e: Ast.Expression,
  f: (t: Ast.TriplePattern | Ast.PathPattern) => Ast.TriplePattern | Ast.PathPattern,
): Ast.Expression => {
  switch (e._tag) {
    case 'Operation':
      return { ...e, args: e.args.map((a) => mapExpression(a, f)) };
    case 'FunctionCall':
      return { ...e, args: e.args.map((a) => mapExpression(a, f)) };
    case 'Aggregate':
      return e.expression === '*' ? e : { ...e, expression: mapExpression(e.expression, f) };
    case 'Exists':
      return { ...e, pattern: mapGroup(e.pattern, f) };
    default:
      return e;
  }
};

const mapPattern = (
  p: Ast.Pattern,
  f: (t: Ast.TriplePattern | Ast.PathPattern) => Ast.TriplePattern | Ast.PathPattern,
): Ast.Pattern => {
  switch (p._tag) {
    case 'Bgp':
      return { ...p, triples: p.triples.map(f) };
    case 'Group':
      return mapGroup(p, f);
    case 'Optional':
    case 'Minus':
    case 'Graph':
    case 'Service':
      return { ...p, pattern: mapGroup(p.pattern, f) };
    case 'Union':
      return { ...p, patterns: p.patterns.map((g) => mapGroup(g, f)) };
    case 'Filter':
      return { ...p, expression: mapExpression(p.expression, f) };
    case 'Bind':
      return { ...p, expression: mapExpression(p.expression, f) };
    case 'Values':
      return p;
    case 'SubSelect':
      return { ...p, query: mapQuery(p.query, f) };
  }
};

const mapQuery = <Q extends Ast.Query>(
  q: Q,
  f: (t: Ast.TriplePattern | Ast.PathPattern) => Ast.TriplePattern | Ast.PathPattern,
): Q => {
  const expression = (e: Ast.Expression) => mapExpression(e, f);
  return {
    ...q,
    where: mapGroup(q.where, f),
    having: q.having.map(expression),
    orderBy: q.orderBy.map((o) => ({ ...o, expression: expression(o.expression) })),
    groupBy: q.groupBy.map((g) => ({ ...g, expression: expression(g.expression) })),
    ...(q._tag === 'Select' && q.projection !== '*'
      ? {
          projection: q.projection.map((p) =>
            p._tag === 'Projection' ? { ...p, expression: expression(p.expression) } : p,
          ),
        }
      : {}),
  };
};

/**
 * Substitutes the variable `$PATH` in the predicate position of triple
 * patterns with a property path (the `sh:path` of the current property
 * shape). Any other use of `$PATH` makes the query ill-formed.
 *
 * @since 0.1.0
 * @category paths
 */
export const substitutePath = <Q extends Ast.Query>(
  query: Q,
  path: Path.Path,
): Result.Result<Q, Sparql.SparqlEvaluationError> => {
  const sparqlPath = toSparqlPath(path);
  const substituted = mapQuery(query, (t) =>
    t._tag === 'TriplePattern' && t.predicate._tag === 'Variable' && t.predicate.value === PATH
      ? sparqlPath._tag === 'PathLink'
        ? Ast.triplePattern(t.subject, sparqlPath.iri, t.object)
        : Ast.pathPattern(t.subject, sparqlPath, t.object)
      : t,
  );
  const error = walk(substituted, {
    variable: (name) =>
      name === PATH
        ? '$PATH may only be used in the predicate position of triple patterns'
        : undefined,
  });
  return error === undefined ? Result.succeed(substituted) : fail(error);
};

// -----------------------------------------------------------------------------
// Compiling
// -----------------------------------------------------------------------------

/**
 * How to compile a SHACL-SPARQL query.
 *
 * @since 0.1.0
 * @category models
 */
export interface CompileOptions {
  /** Read `sh:select` (a `SELECT` query) or `sh:ask` (an `ASK` query). */
  readonly form: 'select' | 'ask';
  /** The potentially pre-bound variables (checked against the pre-binding restrictions). */
  readonly prebound: ReadonlyArray<string>;
  /** The property path substituted for `$PATH`, for property shapes. */
  readonly path?: Path.Path | undefined;
  /** Variables a `SELECT` query must project (e.g. `this`). */
  readonly project?: ReadonlyArray<string> | undefined;
}

/**
 * Reads, parses and checks the `sh:select` or `sh:ask` query of a node of
 * the shapes graph (a SPARQL-based constraint, validator, target or target
 * type), using its prefix declarations. Fails with a
 * `SparqlEvaluationError` when the query is missing, ambiguous, does not
 * parse, has the wrong form or violates the pre-binding restrictions.
 *
 * @since 0.1.0
 * @category compiling
 */
export const compileResult = (
  shapesGraph: Dataset.Dataset,
  node: Term.NamedNode | Term.BlankNode,
  options: CompileOptions,
): Result.Result<Ast.Query, Sparql.SparqlEvaluationError> => {
  const property = options.form === 'select' ? sh.select : sh.ask;
  const texts = Dataset.objectsOf(shapesGraph, node, property);
  if (texts.length !== 1 || texts[0]!._tag !== 'Literal') {
    return fail(`${node.key} must have exactly one literal value for ${property.key}`);
  }
  const text = texts[0]!.value;
  return Result.flatMap(prefixes(shapesGraph, node), (declared) => {
    const parsed = Parser.parseQueryResult(text, { prefixes: declared });
    if (Result.isFailure(parsed)) {
      return Result.fail(
        new Sparql.SparqlEvaluationError({
          message: `the ${property.key} query of ${node.key} does not parse: ${parsed.failure.message}`,
          cause: parsed.failure,
        }),
      );
    }
    const query = parsed.success;
    const expected = options.form === 'select' ? 'Select' : 'Ask';
    if (query._tag !== expected) {
      return fail(
        `the ${property.key} query of ${node.key} must be a ${expected.toUpperCase()} query`,
      );
    }
    if (query._tag === 'Select') {
      const projected = new Set(Ast.projectedVariables(query));
      for (const v of options.project ?? []) {
        if (!projected.has(v)) return fail(`the query of ${node.key} must project ?${v}`);
      }
    }
    return Result.flatMap(checkPrebinding(query, options.prebound), (checked) =>
      options.path === undefined ? Result.succeed(checked) : substitutePath(checked, options.path),
    );
  });
};

/**
 * `compileResult` as an `Effect`.
 *
 * @since 0.1.0
 * @category compiling
 */
export const compile = (
  shapesGraph: Dataset.Dataset,
  node: Term.NamedNode | Term.BlankNode,
  options: CompileOptions,
): Effect.Effect<Ast.Query, Sparql.SparqlEvaluationError> =>
  Effect.suspend(() => Effect.fromResult(compileResult(shapesGraph, node, options)));
