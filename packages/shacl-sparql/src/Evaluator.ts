/**
 * The SHACL-SPARQL evaluator: an implementation of the
 * `Sparql.SparqlConstraintEvaluator` service of `@thomasfosterau/effect-shacl`
 * on the `@thomasfosterau/effect-sparql` engine. With it in the context,
 * `Validator.validate` supports
 *
 * - SPARQL-based constraints (`sh:sparql`, §5),
 * - SPARQL-based constraint components with `SELECT` validators
 *   (`sh:nodeValidator`, `sh:propertyValidator`) and `ASK` validators
 *   (`sh:validator`), with mandatory and optional parameters (§6),
 * - SPARQL-based targets (`sh:SPARQLTarget`) and target types
 *   (`sh:SPARQLTargetType`) of SHACL Advanced Features,
 *
 * with the pre-bound variables `$this`, `$value`, `$currentShape`,
 * `$shapesGraph` and the parameters, `$PATH` substitution, prefix
 * declarations (`sh:prefixes` / `sh:declare`) and the `?path`, `?value`,
 * `?message` and `?failure` result variables.
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Validator } from "@thomasfosterau/effect-shacl"
 * import { Evaluator } from "@thomasfosterau/effect-shacl-sparql"
 *
 * const report = Validator.validate(dataGraph, shapesGraph).pipe(
 *   Effect.provide(Evaluator.layer()),
 * )
 * ```
 *
 * The data graph is queried as the default graph; the shapes graph is
 * available as the named graph `$shapesGraph` (`GRAPH $shapesGraph { … }`).
 *
 * @since 0.1.0
 */
import { Dataset, Term, Vocab } from '@thomasfosterau/effect-rdf';
import { Message, Path, Shapes, Sparql, Vocabulary } from '@thomasfosterau/effect-shacl';
import { type Ast, Bindings, Engine, Store } from '@thomasfosterau/effect-sparql';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import * as Query from './Query.ts';

const { sh } = Vocabulary;
const { rdf, xsd } = Vocab;

/**
 * Evaluator configuration.
 *
 * @since 0.1.0
 * @category models
 */
export interface EvaluatorOptions {
  /**
   * The IRI under which the shapes graph is visible as a named graph
   * (`$shapesGraph`). Defaults to `urn:x-shacl:shapesGraph`.
   */
  readonly shapesGraphIri?: string | undefined;
  /** Options of the SPARQL engine (e.g. extension `functions`). */
  readonly engine?: Omit<Engine.EngineOptions, 'unionDefaultGraph'> | undefined;
}

/**
 * The default IRI of the shapes graph as seen from SPARQL queries.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaultShapesGraphIri = 'urn:x-shacl:shapesGraph';

/** The variables pre-bound for every constraint query. */
const constraintVariables = ['this', 'shapesGraph', 'currentShape'] as const;
/** Parameter names that would clash with SHACL-SPARQL variables. */
const reservedNames = new Set(['this', 'shapesGraph', 'currentShape', 'path', 'PATH', 'value']);
const varName = /^[\p{L}\p{N}_][\p{L}\p{N}_\p{M}]*$/u;

type Node = Term.NamedNode | Term.BlankNode;
type Solution = ReadonlyMap<string, Term.GroundTerm>;

const isNode = (t: Term.Term): t is Node => t._tag === 'NamedNode' || t._tag === 'BlankNode';

const evaluationError = (message: string, cause?: unknown) =>
  new Sparql.SparqlEvaluationError(cause === undefined ? { message } : { message, cause });

const TRUE = Term.literal('true', xsd.boolean).key;

interface Parameter {
  readonly path: Term.NamedNode;
  readonly name: string;
  readonly optional: boolean;
}

/** The declared parameters of a constraint component or target type, with their names. */
const parametersOf = (
  shapes: Dataset.Dataset,
  declaration: Node,
): Effect.Effect<ReadonlyArray<Parameter>, Sparql.SparqlEvaluationError> =>
  Effect.suspend(() => {
    const out: Array<Parameter> = [];
    for (const parameter of Dataset.objectsOf(shapes, declaration, sh.parameter)) {
      const paths = isNode(parameter) ? Dataset.objectsOf(shapes, parameter, sh.path) : [];
      const path = paths[0];
      if (paths.length !== 1 || path === undefined || path._tag !== 'NamedNode') {
        return Effect.fail(
          evaluationError(`parameter ${parameter.key} of ${declaration.key} needs one IRI sh:path`),
        );
      }
      const name = Message.localName(path);
      if (!varName.test(name) || reservedNames.has(name)) {
        return Effect.fail(
          evaluationError(`parameter ${path.key} of ${declaration.key} has invalid name "${name}"`),
        );
      }
      if (out.some((p) => p.name === name)) {
        return Effect.fail(
          evaluationError(`${declaration.key} declares two parameters named "${name}"`),
        );
      }
      const optional = isNode(parameter)
        ? Dataset.objectsOf(shapes, parameter, sh.optional).some((o) => o.key === TRUE)
        : false;
      out.push({ path, name, optional });
    }
    return Effect.succeed(out);
  });

const literals = (shapes: Dataset.Dataset, node: Node, p: Term.NamedNode) =>
  Dataset.objectsOf(shapes, node, p).filter(Term.isLiteral);

/**
 * Creates the evaluator service.
 *
 * Per data graph (and shapes graph) the evaluator builds an in-memory
 * SPARQL store once and caches compiled queries, so validating many focus
 * nodes does not re-parse queries.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  options: EvaluatorOptions = {},
): Sparql.SparqlConstraintEvaluator['Service'] => {
  const shapesGraphNode = Term.namedNode(options.shapesGraphIri ?? defaultShapesGraphIri);

  interface Context {
    readonly engine: Engine.SparqlEngineShape;
    readonly queries: Map<string, Ast.Query>;
  }
  const contexts = new WeakMap<Dataset.Dataset, WeakMap<Dataset.Dataset, Context>>();

  const contextFor = (
    data: Dataset.Dataset,
    shapes: Dataset.Dataset,
  ): Effect.Effect<Context, never> =>
    Effect.suspend(() => {
      let byShapes = contexts.get(data);
      if (byShapes === undefined) contexts.set(data, (byShapes = new WeakMap()));
      const cached = byShapes.get(shapes);
      if (cached !== undefined) return Effect.succeed(cached);
      const quads: Array<Term.Quad> = [];
      for (const q of data)
        quads.push(new Term.Quad(q.subject, q.predicate, q.object, Term.defaultGraph));
      for (const q of shapes)
        quads.push(new Term.Quad(q.subject, q.predicate, q.object, shapesGraphNode));
      return Effect.map(Store.makeMemory(Dataset.fromIterable(quads)), (store) => {
        const context: Context = {
          engine: Engine.make(store, { ...options.engine, unionDefaultGraph: false }),
          queries: new Map(),
        };
        byShapes.set(shapes, context);
        return context;
      });
    });

  const compile = (
    context: Context,
    shapes: Dataset.Dataset,
    node: Node,
    compileOptions: Query.CompileOptions,
  ): Effect.Effect<Ast.Query, Sparql.SparqlEvaluationError> => {
    const key = [
      compileOptions.form,
      node.key,
      compileOptions.path === undefined ? '' : Path.toSparql(compileOptions.path),
      ...compileOptions.prebound,
    ].join(' ');
    const cached = context.queries.get(key);
    if (cached !== undefined) return Effect.succeed(cached);
    return Effect.tap(Query.compile(shapes, node, compileOptions), (q) =>
      Effect.sync(() => context.queries.set(key, q)),
    );
  };

  const prebinding = (record: Iterable<readonly [string, Term.GroundTerm | undefined]>) => ({
    bindings: Bindings.fromEntries(record),
  });

  const select = (
    context: Context,
    query: Ast.Query,
    bound: Iterable<readonly [string, Term.GroundTerm | undefined]>,
  ): Effect.Effect<ReadonlyArray<Solution>, Sparql.SparqlEvaluationError> =>
    context.engine.select(query, prebinding(bound)).pipe(
      Effect.flatMap((result) => Stream.runCollect(result.bindings)),
      Effect.map((solutions) => solutions.map((s) => s.map)),
      Effect.mapError((e) => evaluationError(`SPARQL evaluation failed: ${e.message}`, e)),
    );

  const ask = (
    context: Context,
    query: Ast.Query,
    bound: Iterable<readonly [string, Term.GroundTerm | undefined]>,
  ): Effect.Effect<boolean, Sparql.SparqlEvaluationError> =>
    context.engine
      .ask(query, prebinding(bound))
      .pipe(Effect.mapError((e) => evaluationError(`SPARQL evaluation failed: ${e.message}`, e)));

  /** Maps a solution to a violation (§5.3.2 "Mapping of Solution Bindings to Result Properties"). */
  const toViolation = (
    solution: Solution,
    shape: Shapes.Shape,
    messages: ReadonlyArray<Term.Literal>,
    parameters: ReadonlyArray<readonly [string, Term.GroundTerm]>,
  ): Effect.Effect<Sparql.Violation, Sparql.SparqlEvaluationError> => {
    const failure = solution.get('failure');
    if (failure !== undefined && failure.key === TRUE) {
      return Effect.fail(
        evaluationError(`a SPARQL constraint of ${shape.id.key} reported a failure`),
      );
    }
    const path = solution.get('path');
    const value = solution.get('value');
    const message = solution.get('message');
    const bindings = new Map<string, Term.GroundTerm>(parameters);
    for (const [k, v] of solution) bindings.set(k, v);
    return Effect.succeed({
      focusNode: solution.get('this'),
      path: path !== undefined && path._tag === 'NamedNode' ? Path.predicate(path) : undefined,
      value: value ?? (shape._tag === 'NodeShape' ? solution.get('this') : undefined),
      messages: message !== undefined && message._tag === 'Literal' ? [message] : messages,
      bindings,
    });
  };

  const evaluateSparqlConstraint = Effect.fnUntraced(function* (
    input: Sparql.ConstraintInput,
    constraint: Shapes.SparqlConstraint,
  ) {
    const shapes = input.shapesGraph.dataset;
    const context = yield* contextFor(input.dataGraph, shapes);
    const query = yield* compile(context, shapes, constraint.node, {
      form: 'select',
      prebound: constraintVariables,
      project: ['this'],
      path: input.shape._tag === 'PropertyShape' ? input.shape.path : undefined,
    });
    const solutions = yield* select(context, query, [
      ['this', input.focusNode],
      ['shapesGraph', shapesGraphNode],
      ['currentShape', input.shape.id],
    ]);
    const messages = literals(shapes, constraint.node, sh.message);
    return yield* Effect.forEach(solutions, (s) => toViolation(s, input.shape, messages, []));
  });

  /** Selects the validator of a constraint component for a shape (§6.2.3). */
  const validatorOf = (
    shapes: Dataset.Dataset,
    component: Node,
    shape: Shapes.Shape,
  ): { readonly node: Node; readonly form: 'select' | 'ask' } | undefined => {
    const withQuery = (p: Term.NamedNode, query: Term.NamedNode) =>
      Dataset.objectsOf(shapes, component, p)
        .filter(isNode)
        .find((v) => Dataset.objectsOf(shapes, v, query).length > 0);
    const specific =
      shape._tag === 'NodeShape'
        ? withQuery(sh.nodeValidator, sh.select)
        : withQuery(sh.propertyValidator, sh.select);
    if (specific !== undefined) return { node: specific, form: 'select' };
    const general = withQuery(sh.validator, sh.ask);
    return general === undefined ? undefined : { node: general, form: 'ask' };
  };

  const evaluateComponent = Effect.fnUntraced(function* (
    input: Sparql.ConstraintInput,
    constraint: Shapes.ComponentConstraint,
  ) {
    const shapes = input.shapesGraph.dataset;
    const validator = validatorOf(shapes, constraint.component, input.shape);
    if (validator === undefined) return [];
    const declared = yield* parametersOf(shapes, constraint.component);
    const parameters = constraint.parameters.map((p) => {
      const name =
        declared.find((d) => d.path.key === p.path.key)?.name ?? Message.localName(p.path);
      return [name, p.value] as const;
    });
    const context = yield* contextFor(input.dataGraph, shapes);
    const potentiallyBound = [
      ...constraintVariables,
      ...declared.map((d) => d.name),
      ...(validator.form === 'ask' ? ['value'] : []),
    ];
    const query = yield* compile(context, shapes, validator.node, {
      form: validator.form,
      prebound: potentiallyBound,
      project: validator.form === 'select' ? ['this'] : [],
      path:
        validator.form === 'select' && input.shape._tag === 'PropertyShape'
          ? input.shape.path
          : undefined,
    });
    const validatorMessages = literals(shapes, validator.node, sh.message);
    const messages =
      validatorMessages.length > 0
        ? validatorMessages
        : literals(shapes, constraint.component, sh.message);
    const bound: Array<readonly [string, Term.GroundTerm]> = [
      ['this', input.focusNode],
      ['shapesGraph', shapesGraphNode],
      ['currentShape', input.shape.id],
      ...parameters,
    ];
    if (validator.form === 'select') {
      const solutions = yield* select(context, query, bound);
      return yield* Effect.forEach(solutions, (s) =>
        toViolation(s, input.shape, messages, parameters),
      );
    }
    const violations: Array<Sparql.Violation> = [];
    for (const value of input.valueNodes) {
      if (!(yield* ask(context, query, [...bound, ['value', value]]))) {
        violations.push(
          yield* toViolation(
            new Map([
              ['this', input.focusNode],
              ['value', value],
            ]),
            input.shape,
            messages,
            parameters,
          ),
        );
      }
    }
    return violations;
  });

  const evaluateConstraint: Sparql.SparqlConstraintEvaluator['Service']['evaluateConstraint'] = (
    input,
  ) =>
    input.constraint._tag === 'Sparql'
      ? evaluateSparqlConstraint(input, input.constraint)
      : evaluateComponent(input, input.constraint);

  const selectTargets: Sparql.SparqlConstraintEvaluator['Service']['selectTargets'] =
    Effect.fnUntraced(function* (input) {
      const shapes = input.shapesGraph.dataset;
      const target = input.target;
      if (!isNode(target)) {
        return yield* Effect.fail(
          evaluationError(`sh:target of ${input.shape.id.key} must be an IRI or blank node`),
        );
      }
      const context = yield* contextFor(input.dataGraph, shapes);
      const focusNodes = (solutions: ReadonlyArray<Solution>) =>
        solutions.flatMap((s) => {
          const t = s.get('this');
          return t === undefined ? [] : [t];
        });

      // SPARQL-based target: the target node carries the query.
      if (Dataset.objectsOf(shapes, target, sh.select).length > 0) {
        const query = yield* compile(context, shapes, target, {
          form: 'select',
          prebound: [],
          project: ['this'],
        });
        return focusNodes(yield* select(context, query, []));
      }

      // SPARQL-based target type: a type of the target node carries the query.
      const type = Dataset.objectsOf(shapes, target, rdf.type)
        .filter(isNode)
        .find((t) => Dataset.objectsOf(shapes, t, sh.select).length > 0);
      if (type === undefined) {
        return yield* Effect.fail(
          evaluationError(
            `unsupported custom target ${target.key} of ${input.shape.id.key} (neither a sh:SPARQLTarget nor an instance of a sh:SPARQLTargetType)`,
          ),
        );
      }
      const declared = yield* parametersOf(shapes, type);
      const bound: Array<readonly [string, Term.GroundTerm]> = [];
      for (const parameter of declared) {
        const values = Dataset.objectsOf(shapes, target, parameter.path);
        if (values.length > 1 || values.some((v) => v._tag === 'BlankNode')) {
          return yield* Effect.fail(
            evaluationError(
              `target ${target.key} needs at most one non-blank value for ${parameter.path.key}`,
            ),
          );
        }
        if (values.length === 0) {
          if (parameter.optional) continue;
          return [];
        }
        bound.push([parameter.name, values[0]!]);
      }
      const query = yield* compile(context, shapes, type, {
        form: 'select',
        prebound: declared.map((d) => d.name),
        project: ['this'],
      });
      return focusNodes(yield* select(context, query, bound));
    });

  return Sparql.SparqlConstraintEvaluator.of({ evaluateConstraint, selectTargets });
};

/**
 * A layer providing the SHACL-SPARQL evaluator.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options?: EvaluatorOptions): Layer.Layer<Sparql.SparqlConstraintEvaluator> =>
  Layer.sync(Sparql.SparqlConstraintEvaluator, () => make(options));
