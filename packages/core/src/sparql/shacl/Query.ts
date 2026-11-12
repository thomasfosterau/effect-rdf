/**
 * SHACL-SPARQL queries: reading the `sh:select` / `sh:ask` queries of a
 * shapes graph with their prefix declarations (§5.2.1), enforcing the
 * syntactic restrictions of pre-binding (Appendix A) and substituting the
 * `$PATH` variable with a property path (§5.3, §6.3).
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Query } from "@thomasfosterau/effect-rdf/sparql/shacl"
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
import { Dataset, Term } from '../../index.ts';
import { Path, Sparql, Vocabulary } from '../../shacl/index.ts';
import { Ast, Parser } from '../index.ts';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import { pipe } from 'effect/Function';
import * as Match from 'effect/Match';
import * as HashSet from 'effect/HashSet';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
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
export const optionalPrebound: HashSet.HashSet<string> = HashSet.make(
  'shapesGraph',
  'currentShape',
);

const fail = (message: string): Result.Result<never, Sparql.SparqlEvaluationError> =>
  Result.fail(new Sparql.SparqlEvaluationError({ message }));

// -----------------------------------------------------------------------------
// Prefixes
// -----------------------------------------------------------------------------

const noPrefixes: Result.Result<
  Record.ReadonlyRecord<string, string>,
  Sparql.SparqlEvaluationError
> = Result.succeed({});

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
): Result.Result<Record.ReadonlyRecord<string, string>, Sparql.SparqlEvaluationError> =>
  Arr.reduce(
    Arr.flatMap(prefixNodes(shapesGraph, node), (current) =>
      Arr.map(
        Dataset.objectsOf(shapesGraph, current, sh.declare),
        (declaration) => [current, declaration] as const,
      ),
    ),
    noPrefixes,
    (acc, [current, declaration]) =>
      Result.flatMap(acc, (declared) => declare(shapesGraph, declared, current, declaration)),
  );

/**
 * The nodes reachable via `sh:prefixes/owl:imports*` from `node`, depth
 * first (the order in which their declarations are read).
 */
const prefixNodes = (
  shapesGraph: Dataset.Dataset,
  node: Term.NamedNode | Term.BlankNode,
): ReadonlyArray<Term.Resource> => {
  const seen = MutableHashSet.empty<string>();
  const visit = (
    stack: Arr.NonEmptyReadonlyArray<Term.GroundTerm>,
  ): readonly [Option.Option<Term.Resource>, ReadonlyArray<Term.GroundTerm>] => {
    const [rest, current] = Arr.unappend(stack);
    if (MutableHashSet.has(seen, current.key) || !Term.isResource(current))
      return [Option.none(), rest];
    MutableHashSet.add(seen, current.key);
    return [
      Option.some(current),
      [...rest, ...Dataset.objectsOf(shapesGraph, current, owlImports)],
    ];
  };
  return Arr.getSomes(
    Arr.unfold(Dataset.objectsOf(shapesGraph, node, sh.prefixes), (stack) =>
      Arr.isReadonlyArrayNonEmpty(stack) ? Option.some(visit(stack)) : Option.none(),
    ),
  );
};

const singleOf = <A extends Term.GroundTerm>(
  values: ReadonlyArray<Term.GroundTerm>,
  refinement: (t: Term.GroundTerm) => t is A,
): Option.Option<A> =>
  values.length === 1 ? Option.filter(Arr.head(values), refinement) : Option.none();

const isLiteralOrIri = (t: Term.GroundTerm): t is Term.Literal | Term.NamedNode =>
  Term.isLiteral(t) || Term.isNamedNode(t);

/** Adds one `sh:declare` prefix declaration to those read before it. */
const declare = (
  shapesGraph: Dataset.Dataset,
  declared: Record.ReadonlyRecord<string, string>,
  current: Term.Resource,
  declaration: Term.GroundTerm,
): Result.Result<Record.ReadonlyRecord<string, string>, Sparql.SparqlEvaluationError> => {
  if (!Term.isResource(declaration))
    return fail(`sh:declare of ${current.key} must be an IRI or blank node`);
  const prefix = singleOf(Dataset.objectsOf(shapesGraph, declaration, sh.prefix), Term.isLiteral);
  const namespace = singleOf(
    Dataset.objectsOf(shapesGraph, declaration, sh.namespace),
    isLiteralOrIri,
  );
  if (Option.isNone(prefix) || Option.isNone(namespace)) {
    return fail(
      `prefix declaration ${declaration.key} needs exactly one literal sh:prefix and sh:namespace`,
    );
  }
  const name = prefix.value.value;
  const iri = namespace.value.value;
  const existing = Record.get(declared, name);
  if (Option.isSome(existing) && existing.value !== iri) {
    return fail(
      `prefix "${name}" is declared with two namespaces: <${existing.value}> and <${iri}>`,
    );
  }
  return Result.succeed(Record.set(declared, name, iri));
};

// -----------------------------------------------------------------------------
// Walking queries
// -----------------------------------------------------------------------------

/** A check of a query part: the error it finds, if any. */
type Check<A extends ReadonlyArray<unknown>> = (...args: A) => Option.Option<string>;

interface Visitor {
  readonly pattern: Check<[p: Ast.Pattern]>;
  readonly query: Check<[q: Ast.Query, nested: boolean]>;
  readonly variable: Check<[name: string]>;
}

const noError = (): Option.Option<string> => Option.none();

const visitNothing: Visitor = { pattern: noError, query: noError, variable: noError };

const isSelect = (q: Ast.Query): q is Ast.SelectQuery => Predicate.isTagged(q, 'Select');

const termVariables = (t: Ast.TermPattern | Term.Term, out: (name: string) => void): void => {
  if (Predicate.isTagged(t, 'Variable')) out(t.value);
  else if (Predicate.isTagged(t, 'Triple')) {
    termVariables(t.subject, out);
    termVariables(t.predicate, out);
    termVariables(t.object, out);
  }
};

/** Visits every pattern, (sub-)query and variable occurrence; returns the first error. */
const walk = (root: Ast.Query, visitor: Partial<Visitor>): Option.Option<string> => {
  const visit: Visitor = { ...visitNothing, ...visitor };
  let error = Option.none<string>();
  const report = (e: Option.Option<string>) => {
    if (Option.isNone(error)) error = e;
  };
  const variable = (name: string) => report(visit.variable(name));
  const term = (t: Ast.TermPattern | Term.Term) => termVariables(t, variable);

  const expression = (expr: Ast.Expression): void => {
    return Match.value(expr).pipe(
      Match.tag('Variable', 'Triple', (e) => {
        term(e);
        return;
      }),
      Match.tag('Operation', 'FunctionCall', (e) => {
        e.args.forEach(expression);
        return;
      }),
      Match.tag('Aggregate', (e) => {
        if (e.expression !== '*') expression(e.expression);
        return;
      }),
      Match.tag('Exists', (e) => {
        pattern(e.pattern);
        return;
      }),
      Match.orElse(() => undefined),
    );
  };

  const pathTerms = (p: Ast.Path): void => {
    Match.value(p).pipe(
      Match.tag('PathLink', 'PathNegated', () => undefined),
      Match.tag('PathSequence', 'PathAlternative', (list) => list.paths.forEach(pathTerms)),
      Match.orElse((unary) => pathTerms(unary.path)),
    );
  };

  const pattern = (pat: Ast.Pattern): void => {
    report(visit.pattern(pat));
    return Match.value(pat).pipe(
      Match.tag('Bgp', (p) => {
        Arr.forEach(p.triples, (t) => {
          term(t.subject);
          if (Predicate.isTagged(t, 'TriplePattern')) term(t.predicate);
          else pathTerms(t.path);
          term(t.object);
        });
        return;
      }),
      Match.tag('Group', (p) => {
        p.patterns.forEach(pattern);
        return;
      }),
      Match.tag('Optional', 'Minus', (p) => {
        pattern(p.pattern);
        return;
      }),
      Match.tag('Union', (p) => {
        p.patterns.forEach(pattern);
        return;
      }),
      Match.tag('Graph', 'Service', (p) => {
        term(p.name);
        pattern(p.pattern);
        return;
      }),
      Match.tag('Filter', (p) => {
        expression(p.expression);
        return;
      }),
      Match.tag('Bind', (p) => {
        expression(p.expression);
        variable(p.variable.value);
        return;
      }),
      Match.tag('Values', (p) => {
        p.variables.forEach((v) => variable(v.value));
        return;
      }),
      Match.tag('SubSelect', (p) => {
        query(p.query, true);
        return;
      }),
      Match.exhaustive,
    );
  };

  const query = (q: Ast.Query, nested: boolean): void => {
    report(visit.query(q, nested));
    if (isSelect(q) && q.projection !== '*') {
      Arr.forEach(q.projection, (p) => {
        if (Predicate.isTagged(p, 'Variable')) variable(p.value);
        else {
          expression(p.expression);
          variable(p.variable.value);
        }
      });
    }
    if (Predicate.isTagged(q, 'Construct'))
      Arr.forEach(q.template, (t) => [t.subject, t.predicate, t.object].forEach(term));
    if (Predicate.isTagged(q, 'Describe') && q.terms !== '*') q.terms.forEach(term);
    pattern(q.where);
    Arr.forEach(q.groupBy, (g) => {
      expression(g.expression);
      if (g.variable !== undefined) variable(g.variable.value);
    });
    q.having.forEach(expression);
    Arr.forEach(q.orderBy, (o) => expression(o.expression));
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
  const ordered = Arr.dedupe(Arr.fromIterable(prebound));
  const potential = MutableHashSet.fromIterable(ordered);
  const rebinds = (v: Term.Variable): Option.Option<string> =>
    MutableHashSet.has(potential, v.value)
      ? Option.some(`the pre-bound variable ?${v.value} must not be assigned with AS`)
      : Option.none();
  const unprojected = (q: Ast.SelectQuery): Option.Option<string> => {
    const projected = MutableHashSet.fromIterable(Ast.projectedVariables(q));
    return Option.map(
      Arr.findFirst(
        ordered,
        (v) => !HashSet.has(optionalPrebound, v) && !MutableHashSet.has(projected, v),
      ),
      (v) => `sub-queries must project the pre-bound variable ?${v}`,
    );
  };
  const error = walk(query, {
    pattern: (pat) => {
      return Match.value(pat).pipe(
        Match.withReturnType<Option.Option<string>>(),
        Match.tag('Minus', () =>
          Option.some('MINUS is not allowed in SHACL-SPARQL queries with pre-bound variables'),
        ),
        Match.tag('Service', () =>
          Option.some('SERVICE is not allowed in SHACL-SPARQL queries with pre-bound variables'),
        ),
        Match.tag('Values', () =>
          Option.some('VALUES is not allowed in SHACL-SPARQL queries with pre-bound variables'),
        ),
        Match.tag('Bind', (p) => rebinds(p.variable)),
        Match.orElse(() => Option.none()),
      );
    },
    query: (q, nested) => {
      if (q.values !== undefined)
        return Option.some(
          'VALUES is not allowed in SHACL-SPARQL queries with pre-bound variables',
        );
      const projections =
        isSelect(q) && q.projection !== '*'
          ? Arr.filter(q.projection, (p): p is Ast.Projection =>
              Predicate.isTagged(p, 'Projection'),
            )
          : [];
      return pipe(
        Arr.findFirst(projections, (p) => rebinds(p.variable)),
        Option.orElse(() =>
          Arr.findFirst(q.groupBy, (g) =>
            g.variable === undefined ? Option.none() : rebinds(g.variable),
          ),
        ),
        Option.orElse(() => (nested && isSelect(q) ? unprojected(q) : Option.none())),
      );
    },
  });
  return Option.match(error, { onNone: () => Result.succeed(query), onSome: fail });
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
  return Match.value(path).pipe(
    Match.tag('PredicatePath', (step) => Ast.link(step.predicate)),
    Match.tag('SequencePath', (step) => Ast.sequence(...step.paths.map(toSparqlPath))),
    Match.tag('AlternativePath', (step) => Ast.alternative(...step.paths.map(toSparqlPath))),
    Match.tag('InversePath', (step) => Ast.inverse(toSparqlPath(step.path))),
    Match.tag('ZeroOrMorePath', (step) => Ast.zeroOrMore(toSparqlPath(step.path))),
    Match.tag('OneOrMorePath', (step) => Ast.oneOrMore(toSparqlPath(step.path))),
    Match.tag('ZeroOrOnePath', (step) => Ast.zeroOrOne(toSparqlPath(step.path))),
    Match.exhaustive,
  );
};

const PATH = 'PATH';

const isPathLink = (p: Ast.Path): p is Ast.PathLink => Predicate.isTagged(p, 'PathLink');

const mapGroup = (
  g: Ast.GroupPattern,
  f: (t: Ast.TriplePattern | Ast.PathPattern) => Ast.TriplePattern | Ast.PathPattern,
): Ast.GroupPattern => ({ ...g, patterns: g.patterns.map((p) => mapPattern(p, f)) });

const mapExpression = (
  expr: Ast.Expression,
  f: (t: Ast.TriplePattern | Ast.PathPattern) => Ast.TriplePattern | Ast.PathPattern,
): Ast.Expression => {
  return Match.value(expr).pipe(
    Match.tag('Operation', (e) => ({ ...e, args: e.args.map((a) => mapExpression(a, f)) })),
    Match.tag('FunctionCall', (e) => ({ ...e, args: e.args.map((a) => mapExpression(a, f)) })),
    Match.tag('Aggregate', (e) =>
      e.expression === '*' ? e : { ...e, expression: mapExpression(e.expression, f) },
    ),
    Match.tag('Exists', (e) => ({ ...e, pattern: mapGroup(e.pattern, f) })),
    Match.orElse((e) => e),
  );
};

const mapPattern = (
  pat: Ast.Pattern,
  f: (t: Ast.TriplePattern | Ast.PathPattern) => Ast.TriplePattern | Ast.PathPattern,
): Ast.Pattern => {
  return Match.value(pat).pipe(
    Match.tag('Bgp', (p) => ({ ...p, triples: p.triples.map(f) })),
    Match.tag('Group', (p) => mapGroup(p, f)),
    Match.tag('Optional', 'Minus', 'Graph', 'Service', (p) => ({
      ...p,
      pattern: mapGroup(p.pattern, f),
    })),
    Match.tag('Union', (p) => ({ ...p, patterns: p.patterns.map((g) => mapGroup(g, f)) })),
    Match.tag('Filter', (p) => ({ ...p, expression: mapExpression(p.expression, f) })),
    Match.tag('Bind', (p) => ({ ...p, expression: mapExpression(p.expression, f) })),
    Match.tag('Values', (p) => p),
    Match.tag('SubSelect', (p) => ({ ...p, query: mapQuery(p.query, f) })),
    Match.exhaustive,
  );
};

const mapQuery = <Q extends Ast.Query>(
  q: Q,
  f: (t: Ast.TriplePattern | Ast.PathPattern) => Ast.TriplePattern | Ast.PathPattern,
): Q => {
  const expression = (e: Ast.Expression) => mapExpression(e, f);
  const mapped: Q = {
    ...q,
    where: mapGroup(q.where, f),
    having: q.having.map(expression),
    orderBy: q.orderBy.map((o) => ({ ...o, expression: expression(o.expression) })),
    groupBy: q.groupBy.map((g) => ({ ...g, expression: expression(g.expression) })),
  };
  if (!isSelect(q) || q.projection === '*') return mapped;
  return {
    ...mapped,
    projection: q.projection.map((p) =>
      Predicate.isTagged(p, 'Projection') ? { ...p, expression: expression(p.expression) } : p,
    ),
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
    Predicate.isTagged(t, 'TriplePattern') &&
    Predicate.isTagged(t.predicate, 'Variable') &&
    t.predicate.value === PATH
      ? isPathLink(sparqlPath)
        ? Ast.triplePattern(t.subject, sparqlPath.iri, t.object)
        : Ast.pathPattern(t.subject, sparqlPath, t.object)
      : t,
  );
  const error = walk(substituted, {
    variable: (name) =>
      name === PATH
        ? Option.some('$PATH may only be used in the predicate position of triple patterns')
        : Option.none(),
  });
  return Option.match(error, { onNone: () => Result.succeed(substituted), onSome: fail });
};

// -----------------------------------------------------------------------------
// Compiling
// -----------------------------------------------------------------------------

/** The first of `required` that a `SELECT` query does not project. */
const unprojectedOf = (
  query: Ast.SelectQuery,
  required: ReadonlyArray<string>,
): Option.Option<string> => {
  const projected = MutableHashSet.fromIterable(Ast.projectedVariables(query));
  return Arr.findFirst(required, (v) => !MutableHashSet.has(projected, v));
};

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
  const literal = singleOf(Dataset.objectsOf(shapesGraph, node, property), Term.isLiteral);
  if (Option.isNone(literal)) {
    return fail(`${node.key} must have exactly one literal value for ${property.key}`);
  }
  const text = literal.value.value;
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
    if (!Predicate.isTagged(query, expected)) {
      return fail(
        `the ${property.key} query of ${node.key} must be a ${expected.toUpperCase()} query`,
      );
    }
    const missing = isSelect(query) ? unprojectedOf(query, options.project ?? []) : Option.none();
    if (Option.isSome(missing))
      return fail(`the query of ${node.key} must project ?${missing.value}`);
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
