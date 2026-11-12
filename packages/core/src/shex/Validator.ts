/**
 * ShEx validation: checks node/shape associations of a shape map against an
 * RDF dataset per the ShEx 2.1 semantics (with the ShEx 2.2 `EXTENDS`,
 * `ABSTRACT` and `RESTRICTS` extensions).
 *
 * Recursive references are evaluated coinductively (the maximal typing) and
 * memoised; schemas are checked for the structural requirements, which
 * guarantee a stratification so that negation is well-defined. Imports are
 * loaded through the `SchemaLoader` service and semantic actions are
 * dispatched to the `SemAct.SemActHandler` service.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as HashMap from 'effect/HashMap';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import type * as SchemaAST from 'effect/SchemaAST';
import * as SchemaIssue from 'effect/SchemaIssue';
import * as SchemaTransformation from 'effect/SchemaTransformation';
import * as Dataset from '../Dataset.ts';
import type * as Term from '../Term.ts';
import { Engine } from './internal/engine.ts';
import * as SemAct from './SemAct.ts';
import { ShExImportError, type ShExStructureError, ShExValidationError } from './ShExError.ts';
import type * as ShExJ from './ShExJ.ts';
import * as ShapeMap from './ShapeMap.ts';
import * as Structure from './Structure.ts';

// -----------------------------------------------------------------------------
// Services
// -----------------------------------------------------------------------------

/**
 * Loads imported schemas by IRI.
 *
 * @since 0.1.0
 * @category models
 */
export interface Loader {
  readonly load: (iri: string) => Effect.Effect<ShExJ.Schema, ShExImportError>;
}

/**
 * The service used to resolve `IMPORT`s. The default loader fails for every
 * import.
 *
 * @since 0.1.0
 * @category services
 */
export const SchemaLoader: Context.Reference<Loader> = Context.Reference<Loader>(
  '@thomasfosterau/effect-rdf/shex/SchemaLoader',
  {
    defaultValue: () => ({
      load: (iri) =>
        Effect.fail(new ShExImportError({ iri, message: 'no SchemaLoader is configured' })),
    }),
  },
);

/**
 * A layer providing a `SchemaLoader`.
 *
 * @since 0.1.0
 * @category layers
 */
export const loaderLayer = (loader: Loader): Layer.Layer<never> =>
  Layer.succeed(SchemaLoader, loader);

/**
 * A loader serving schemas from a map of IRIs (useful for tests and bundled
 * schemas).
 *
 * @since 0.1.0
 * @category constructors
 */
export const loaderFromRecord = (schemas: Readonly<Record<string, ShExJ.Schema>>): Loader => ({
  load: (iri) => {
    const s = schemas[iri];
    return s === undefined
      ? Effect.fail(new ShExImportError({ iri, message: 'unknown schema' }))
      : Effect.succeed(s);
  },
});

// -----------------------------------------------------------------------------
// Models
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category models
 */
export interface Options {
  /**
   * Definitions for shapes declared `EXTERNAL`, given as a schema whose
   * declarations share the external labels.
   */
  readonly externalShapes?: ShExJ.Schema | undefined;
  /**
   * Code for semantic actions written without code (`%<name>%`), matched by
   * action name.
   */
  readonly externalSemActs?: ReadonlyArray<ShExJ.SemAct> | undefined;
  /** The IRI of the schema itself, so that circular imports of it are ignored. */
  readonly schemaIri?: string | undefined;
}

/**
 * The validation result of one node/shape association.
 *
 * @since 0.1.0
 * @category models
 */
export interface ShapeResult {
  readonly node: Term.GroundTerm;
  readonly shape: ShapeMap.ShapeSelector;
  readonly status: 'conformant' | 'nonconformant';
  /** Why the node does not conform. */
  readonly reason?: string;
}

/**
 * A validation report: one result per association of the (fixed) shape map.
 *
 * @since 0.1.0
 * @category models
 */
export interface ValidationReport {
  readonly results: ReadonlyArray<ShapeResult>;
  /** Whether every association conforms. */
  readonly conformant: boolean;
}

/**
 * A validator for one (import-resolved, structurally checked) schema.
 *
 * @since 0.1.0
 * @category models
 */
export interface Validator {
  /** The schema with the declarations of its imports merged in. */
  readonly schema: ShExJ.Schema;
  readonly index: Structure.SchemaIndex;
  /** Validates a fixed or query shape map against a dataset. */
  readonly validate: (
    dataset: Dataset.Dataset,
    shapeMap: ShapeMap.QueryShapeMap,
  ) => Effect.Effect<ValidationReport, ShExValidationError>;
}

// -----------------------------------------------------------------------------
// Imports
// -----------------------------------------------------------------------------

/**
 * Loads the imports of a schema (transitively, each IRI once) and merges
 * their declarations into it. The importing schema's `start` and `startActs`
 * are kept.
 *
 * @since 0.1.0
 * @category imports
 */
export const resolveImports = Effect.fnUntraced(function* (
  schema: ShExJ.Schema,
  schemaIri?: string,
) {
  if (schema.imports === undefined || Arr.isReadonlyArrayEmpty(schema.imports)) return schema;
  const loader = yield* SchemaLoader;
  const seen = MutableHashSet.fromIterable(schemaIri === undefined ? [] : [schemaIri]);
  const shapes: Array<ShExJ.ShapeDecl> = [...(schema.shapes ?? [])];
  const labels = MutableHashSet.fromIterable(shapes.map((s) => s.id));
  // Breadth first, each IRI once: the queue holds the imports still to load.
  const load = (queue: ReadonlyArray<string>): Effect.Effect<void, ShExImportError> =>
    Arr.match(queue, {
      onEmpty: () => Effect.void,
      onNonEmpty: ([iri, ...rest]) => {
        if (MutableHashSet.has(seen, iri)) return load(rest);
        MutableHashSet.add(seen, iri);
        return Effect.flatMap(loader.load(iri), (imported) => {
          imported.shapes?.forEach((d) => {
            if (MutableHashSet.has(labels, d.id)) return;
            MutableHashSet.add(labels, d.id);
            shapes.push(d);
          });
          return load([...rest, ...(imported.imports ?? [])]);
        });
      },
    });
  yield* load(schema.imports);
  const { imports: _, ...rest } = schema;
  // SAFETY: dropping the optional `imports` (and re-adding `shapes` only when non-empty) leaves a
  // valid `ShExJ.Schema`; the spread just loses the nominal type.
  return Arr.isReadonlyArrayNonEmpty(shapes) ? { ...rest, shapes } : rest;
});

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

const isFixedMap = (map: ShapeMap.QueryShapeMap): map is ShapeMap.FixedShapeMap =>
  map.every((a) => !Predicate.isTagged(a.node, 'TriplePattern'));

/**
 * Prepares a validator: loads imports through `SchemaLoader`, checks the
 * structural requirements and indexes the schema. Semantic actions are
 * dispatched to the `SemAct.SemActHandler` in scope when the validator is
 * made.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = Effect.fnUntraced(function* (schema: ShExJ.Schema, options: Options = {}) {
  const resolved = yield* resolveImports(schema, options.schemaIri);
  yield* Structure.check(resolved);
  const index = Structure.makeIndex(resolved);
  const baseHandler = yield* SemAct.SemActHandler;
  const handler =
    options.externalSemActs === undefined
      ? baseHandler
      : SemAct.withExternalCode(baseHandler, options.externalSemActs);
  const externs = MutableHashMap.fromIterable(
    Arr.map(options.externalShapes?.shapes ?? [], (d) => [d.id, d] as const),
  );

  const validate = (
    dataset: Dataset.Dataset,
    shapeMap: ShapeMap.QueryShapeMap,
  ): Effect.Effect<ValidationReport, ShExValidationError> =>
    Effect.suspend(() => {
      const fixed = isFixedMap(shapeMap) ? shapeMap : ShapeMap.resolve(shapeMap, dataset);
      const invalid = Arr.findFirst(fixed, (a) =>
        ShapeMap.isStart(a.shape)
          ? resolved.start === undefined
            ? Option.some('the shape map uses START but the schema has no start')
            : Option.none()
          : HashMap.has(index.shapes, a.shape)
            ? Option.none()
            : Option.some(`the schema does not declare shape ${a.shape}`),
      );
      if (Option.isSome(invalid)) {
        return Effect.fail(new ShExValidationError({ message: invalid.value }));
      }
      const engine = new Engine(index, dataset, handler, externs);
      const startFailure = engine.runSemActs(resolved.startActs, {
        site: 'start',
        node: undefined,
      });
      const results: Array<ShapeResult> = fixed.map((a) => {
        const reason = Option.orElse(startFailure, () =>
          ShapeMap.isStart(a.shape)
            ? engine.validateStart(a.node, MutableHashSet.empty())
            : engine.validateLabel(a.node, a.shape, MutableHashSet.empty()),
        );
        return Option.match(reason, {
          onNone: (): ShapeResult => ({ node: a.node, shape: a.shape, status: 'conformant' }),
          onSome: (why): ShapeResult => ({
            node: a.node,
            shape: a.shape,
            status: 'nonconformant',
            reason: why,
          }),
        });
      });
      const conformant = results.every((r) => r.status === 'conformant');
      return Effect.as(
        Effect.annotateCurrentSpan({
          'shex.associations': results.length,
          'shex.nonconformant': results.filter((r) => r.status === 'nonconformant').length,
          'shex.conformant': conformant,
        }),
        { results, conformant },
      );
    }).pipe(Effect.withSpan('ShEx.validate'));

  // SAFETY: `satisfies Validator` checks the literal; the assertion only widens it to the
  // interface.
  return { schema: resolved, index, validate } satisfies Validator;
});

/**
 * Validates a shape map against a dataset with a schema.
 *
 * @since 0.1.0
 * @category validation
 */
export const validate = (
  dataset: Dataset.Dataset,
  schema: ShExJ.Schema,
  shapeMap: ShapeMap.QueryShapeMap,
  options: Options = {},
): Effect.Effect<ValidationReport, ShExValidationError | ShExImportError | ShExStructureError> =>
  Effect.flatMap(make(schema, options), (v) => v.validate(dataset, shapeMap));

/**
 * Validates a single node against a shape label (or `START`).
 *
 * @since 0.1.0
 * @category validation
 */
export const validateNode = (
  dataset: Dataset.Dataset,
  schema: ShExJ.Schema,
  node: Term.GroundTerm,
  shape: ShapeMap.ShapeSelector,
  options: Options = {},
): Effect.Effect<ShapeResult, ShExValidationError | ShExImportError | ShExStructureError> =>
  // A one-association shape map yields exactly one result.
  Effect.map(validate(dataset, schema, [{ node, shape }], options), (r) =>
    Arr.getUnsafe(r.results, 0),
  );

// -----------------------------------------------------------------------------
// Schema integration
// -----------------------------------------------------------------------------

/**
 * Formats a shape result on one line: `<node>@<shape>` and, when it does
 * not conform, why.
 *
 * @since 0.1.0
 * @category formatting
 */
export const formatResult = (result: ShapeResult): string => {
  const label = ShapeMap.isStart(result.shape) ? 'START' : `<${result.shape}>`;
  const association = `${result.node.key}@${label}`;
  return result.reason === undefined
    ? `${association}: ${result.status}`
    : `${association}: ${result.reason}`;
};

// One `InvalidValue` per nonconformant association, annotated with its message and result.
const nonconformance = (
  failing: Arr.NonEmptyReadonlyArray<ShapeResult>,
  data: Dataset.Dataset,
  options: SchemaAST.ParseOptions,
): SchemaIssue.Issue => {
  const issues = Arr.map(
    failing,
    (result) =>
      new SchemaIssue.InvalidValue({ message: formatResult(result), result }, result, options),
  );
  return new SchemaIssue.Composite(Dataset.DatasetSchema.ast, issues, data);
};

/**
 * A `Schema` that accepts a `Dataset` only if every association of the
 * shape map (or the single `{ node, shape }`) conforms, so ShEx validation
 * fits into `Schema.decode` pipelines. It takes a prepared `Validator`
 * (`make`), so imports are resolved before the schema is built and decoding
 * needs no services.
 *
 * Decoding fails with a `SchemaIssue.Composite` holding one `InvalidValue`
 * issue per nonconformant association: its `message` annotation is the
 * formatted result (`formatResult`) and its `result` annotation the
 * `ShapeResult`. A shape map naming an undeclared shape fails with one
 * `InvalidValue`. Encoding is the identity.
 *
 * Compose it with a syntax codec to parse and validate in one decode:
 * `Turtle.codec.schema.pipe(Schema.decodeTo(Validator.schema(validator, map)))`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const schema = (
  validator: Validator,
  shapeMap: ShapeMap.QueryShapeMap | ShapeMap.Association,
): Schema.decodeTo<Schema.declare<Dataset.Dataset>, Schema.declare<Dataset.Dataset>> => {
  const map: ShapeMap.QueryShapeMap = 'node' in shapeMap ? [shapeMap] : shapeMap;
  return Dataset.DatasetSchema.pipe(
    Schema.decodeTo(
      Dataset.DatasetSchema,
      SchemaTransformation.transformEffect({
        decode: (data: Dataset.Dataset, options) =>
          validator.validate(data, map).pipe(
            Effect.mapError(
              (e) => new SchemaIssue.InvalidValue({ message: e.message }, data, options),
            ),
            Effect.flatMap((report) => {
              const failing = Arr.filter(report.results, (r) => r.status === 'nonconformant');
              return Arr.isReadonlyArrayNonEmpty(failing)
                ? Effect.fail(nonconformance(failing, data, options))
                : Effect.succeed(data);
            }),
          ),
        encode: (data: Dataset.Dataset) => Effect.succeed(data),
      }),
    ),
  );
};
