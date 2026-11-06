/**
 * Knowledge-graph tools for `effect/ai`: a `Toolkit` of SPARQL and dataset
 * tools over the `SparqlEngine` service, for `LanguageModel.generateText`
 * and for MCP (see `Mcp`).
 *
 * | Tool                | What it does                                                          |
 * | ------------------- | --------------------------------------------------------------------- |
 * | `sparql_query`      | Runs a read-only SELECT / ASK / CONSTRUCT / DESCRIBE query            |
 * | `describe_resource` | The triples whose subject is an IRI (one hop)                         |
 * | `list_classes`      | Classes in use or declared (`rdfs:Class`, `owl:Class`), with counts   |
 * | `list_properties`   | Predicates in use or declared, with counts                            |
 * | `search_labels`     | IRIs whose `rdfs:label` / `skos:prefLabel` contains a string          |
 * | `sparql_update`     | Runs a SPARQL Update — only in `toolkitWithUpdate`, off by default    |
 *
 * Tool input is model-generated, so it is untrusted: queries are read-only
 * (the query tool only accepts queries; updates need the separate,
 * opt-in tool), every result is capped at `maxRows` rows or triples (and
 * reports whether it was truncated), every call has a `timeout`, and
 * `SERVICE` (federation) is refused unless `federation: true`. Failures are
 * returned to the model as a `SparqlToolError` rather than failing the
 * conversation.
 *
 * @since 0.1.0
 */
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Match from 'effect/Match';
import * as Record from 'effect/Record';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { Tool, Toolkit } from 'effect/ai';
import * as Iri from '../../Iri.ts';
import * as Term from '../../Term.ts';
import * as Algebra from '../Algebra.ts';
import type * as Ast from '../Ast.ts';
import * as Bindings from '../Bindings.ts';
import * as Engine from '../Engine.ts';
import * as Parser from '../Parser.ts';
import * as Results from '../Results.ts';
import * as Translate from '../Translate.ts';
import * as Turtle from '../../turtle/Turtle.ts';

// -----------------------------------------------------------------------------
// Errors and options
// -----------------------------------------------------------------------------

/**
 * Why a tool call failed (a syntax error, a refused `SERVICE`, a timeout, …),
 * returned to the model as the tool's result.
 *
 * @since 0.1.0
 * @category errors
 */
export class SparqlToolError extends Schema.TaggedError<SparqlToolError>()('SparqlToolError', {
  message: Schema.String,
}) {}

/**
 * Limits for the tool handlers.
 *
 * @since 0.1.0
 * @category models
 */
export interface ToolOptions {
  /** The most rows (or triples) a tool returns; a call may ask for fewer. Default 100. */
  readonly maxRows?: number | undefined;
  /** How long one call may run. Default 10 seconds. */
  readonly timeout?: Duration.Input | undefined;
  /** Allow `SERVICE` (federated) queries. Default `false`. */
  readonly federation?: boolean | undefined;
}

// -----------------------------------------------------------------------------
// Tools
// -----------------------------------------------------------------------------

const Limit = Schema.optional(
  Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description: 'The most rows or triples to return (capped by the server).',
  }),
);

const IriParam = Iri.IriSchema.annotate({
  description: 'An absolute IRI, e.g. http://example.org/alice',
});

/**
 * Runs a read-only SPARQL query. SELECT results are SPARQL JSON results,
 * ASK a boolean, CONSTRUCT / DESCRIBE a Turtle document.
 *
 * @since 0.1.0
 * @category tools
 */
export const SparqlQuery = Tool.make('sparql_query', {
  description:
    'Run a read-only SPARQL 1.1 query (SELECT, ASK, CONSTRUCT or DESCRIBE) against the knowledge graph. SELECT returns SPARQL JSON results, ASK a boolean, CONSTRUCT and DESCRIBE a Turtle document. Results are truncated to a row limit.',
  parameters: Schema.Struct({
    query: Schema.String.annotate({
      description: 'The SPARQL query text, with any PREFIX declarations.',
    }),
    limit: Limit,
  }),
  success: Schema.Union([
    Schema.Struct({
      type: Schema.Literal('select'),
      results: Results.JsonResultsSchema,
      isTruncated: Schema.Boolean,
    }),
    Schema.Struct({ type: Schema.Literal('ask'), isTrue: Schema.Boolean }),
    Schema.Struct({
      type: Schema.Literal('graph'),
      turtle: Schema.String,
      isTruncated: Schema.Boolean,
    }),
  ]),
  failure: SparqlToolError,
  failureMode: 'return',
});

/**
 * The triples whose subject is the given IRI, as Turtle.
 *
 * @since 0.1.0
 * @category tools
 */
export const DescribeResource = Tool.make('describe_resource', {
  description:
    'Describe a resource: the triples whose subject is the given IRI (one hop), as a Turtle document.',
  parameters: Schema.Struct({ iri: IriParam, limit: Limit }),
  success: Schema.Struct({ turtle: Schema.String, isTruncated: Schema.Boolean }),
  failure: SparqlToolError,
  failureMode: 'return',
});

const Counted = Schema.Array(Schema.Struct({ iri: Schema.String, count: Schema.Int }));

/**
 * The classes with instances (`rdf:type`) or declared as `rdfs:Class` /
 * `owl:Class`, by number of instances.
 *
 * @since 0.1.0
 * @category tools
 */
export const ListClasses = Tool.make('list_classes', {
  description:
    'List the classes in the knowledge graph (types in use, and declared rdfs:Class / owl:Class), with their number of instances, most used first.',
  parameters: Schema.Struct({ limit: Limit }),
  success: Counted,
  failure: SparqlToolError,
  failureMode: 'return',
});

/**
 * The predicates in use or declared as `rdf:Property` /
 * `owl:ObjectProperty` / `owl:DatatypeProperty`, by number of uses.
 *
 * @since 0.1.0
 * @category tools
 */
export const ListProperties = Tool.make('list_properties', {
  description:
    'List the properties (predicates) in the knowledge graph, in use or declared, with their number of uses, most used first.',
  parameters: Schema.Struct({ limit: Limit }),
  success: Counted,
  failure: SparqlToolError,
  failureMode: 'return',
});

/**
 * IRIs whose `rdfs:label` or `skos:prefLabel` contains a string
 * (case-insensitively).
 *
 * @since 0.1.0
 * @category tools
 */
export const SearchLabels = Tool.make('search_labels', {
  description:
    'Find resources by name: IRIs whose rdfs:label or skos:prefLabel contains the given text (case-insensitive).',
  parameters: Schema.Struct({
    text: Schema.String.check(Schema.isMinLength(1)).annotate({
      description: 'The text to look for.',
    }),
    limit: Limit,
  }),
  success: Schema.Array(Schema.Struct({ iri: Schema.String, label: Schema.String })),
  failure: SparqlToolError,
  failureMode: 'return',
});

/**
 * Runs a SPARQL Update. Only in `toolkitWithUpdate`: the read-only `toolkit`
 * does not offer it.
 *
 * @since 0.1.0
 * @category tools
 */
export const SparqlUpdate = Tool.make('sparql_update', {
  description:
    'Run a SPARQL 1.1 Update (INSERT DATA, DELETE / INSERT … WHERE, …) on the knowledge graph.',
  parameters: Schema.Struct({
    update: Schema.String.annotate({
      description: 'The SPARQL Update text, with any PREFIX declarations.',
    }),
  }),
  success: Schema.Struct({ isApplied: Schema.Boolean }),
  failure: SparqlToolError,
  failureMode: 'return',
});

/**
 * The read-only toolkit: `sparql_query`, `describe_resource`,
 * `list_classes`, `list_properties` and `search_labels`.
 *
 * @since 0.1.0
 * @category toolkits
 */
export const toolkit = Toolkit.make(
  SparqlQuery,
  DescribeResource,
  ListClasses,
  ListProperties,
  SearchLabels,
);

/**
 * The read-only toolkit plus `sparql_update`, for agents that may change
 * the graph.
 *
 * @since 0.1.0
 * @category toolkits
 */
export const toolkitWithUpdate = Toolkit.merge(toolkit, Toolkit.make(SparqlUpdate));

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

const toolError = (e: { readonly message: string }): SparqlToolError =>
  e instanceof SparqlToolError ? e : new SparqlToolError({ message: e.message });

// Whether a query's algebra has a `SERVICE` (federated) pattern.
const usesService = (query: Ast.Query): boolean => {
  let found = false;
  Algebra.transform(Translate.translateQuery(query).input, (op) =>
    Match.value(op).pipe(
      Match.tag('Service', (service) => {
        found = true;
        return service;
      }),
      Match.orElse(() => op),
    ),
  );
  return found;
};

// At most `rows` elements of a stream, and whether there were more.
const take = <A, E>(stream: Stream.Stream<A, E>, rows: number) =>
  Effect.map(Stream.runCollect(Stream.take(stream, rows + 1)), (all) => ({
    items: all.slice(0, rows),
    truncated: all.length > rows,
  }));

const turtleOf = (quads: ReadonlyArray<Term.Quad>) =>
  Turtle.serialize(quads.map((q) => Term.quad(q.subject, q.predicate, q.object)));

const rowsToJson = (
  variables: ReadonlyArray<string>,
  rows: ReadonlyArray<Bindings.Bindings>,
): Results.JsonResults => ({
  head: { vars: [...variables] },
  results: {
    bindings: rows.map((row) => Record.map(Bindings.toRecord(row), Results.termToJson)),
  },
});

const countOf = (row: Bindings.Bindings, name: string): number => {
  const term = Bindings.getUndefined(row, name);
  return term !== undefined && Term.isLiteral(term) ? Number(term.value) : 0;
};

/**
 * The handlers of the tools, over the `SparqlEngine` in context.
 *
 * @since 0.1.0
 * @category handlers
 */
export const handlers = Effect.fnUntraced(function* (options: ToolOptions = {}) {
  const engine = yield* Engine.SparqlEngine;
  const maxRows = options.maxRows ?? 100;
  const timeout = Duration.fromInputUnsafe(options.timeout ?? '10 seconds');
  const rowsFor = (limit: number | undefined) => Math.min(limit ?? maxRows, maxRows);

  // Every call: a timeout, and any failure as a `SparqlToolError`.
  const guard = <A, E extends { readonly message: string }, R>(
    self: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, SparqlToolError, R> =>
    self.pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            new SparqlToolError({
              message: `the call took longer than ${Duration.format(timeout)}`,
            }),
          ),
      }),
      Effect.mapError(toolError),
    );

  const select = (query: string, rows: number) =>
    Effect.flatMap(engine.select(query), (result) => take(result.bindings, rows));

  const sparqlQuery = (query: string, limit: number | undefined) =>
    guard(
      Effect.gen(function* () {
        const ast = yield* Parser.parseQuery(query);
        if (options.federation !== true && usesService(ast)) {
          return yield* new SparqlToolError({
            message: 'SERVICE (federated) queries are not allowed by this server',
          });
        }
        const rows = rowsFor(limit);
        const result = yield* engine.query(ast);
        return yield* Match.value(result).pipe(
          Match.tag('Ask', (ask) => Effect.succeed({ type: 'ask' as const, isTrue: ask.value })),
          Match.tag('Select', (selected) =>
            Effect.map(take(selected.bindings, rows), ({ items, truncated }) => ({
              type: 'select' as const,
              results: rowsToJson(
                selected.variables.map((v) => v.value),
                items,
              ),
              isTruncated: truncated,
            })),
          ),
          Match.tag('Graph', (graph) =>
            Effect.flatMap(take(graph.quads, rows), ({ items, truncated }) =>
              Effect.map(turtleOf(items), (turtle) => ({
                type: 'graph' as const,
                turtle,
                isTruncated: truncated,
              })),
            ),
          ),
          Match.exhaustive,
        );
      }),
    );

  const describeResource = (iri: string, limit: number | undefined) =>
    guard(
      Effect.gen(function* () {
        const subject = Term.namedNode(iri);
        const { items, truncated } = yield* select(
          `SELECT ?p ?o WHERE { ${subject.key} ?p ?o } ORDER BY ?p ?o`,
          rowsFor(limit),
        );
        const quads = items.flatMap((row) => {
          const p = Bindings.getUndefined(row, 'p');
          const o = Bindings.getUndefined(row, 'o');
          return p !== undefined && Term.isNamedNode(p) && o !== undefined
            ? [Term.quad(subject, p, o)]
            : [];
        });
        return { turtle: yield* turtleOf(quads), isTruncated: truncated };
      }),
    );

  const counted = (query: string, name: string, limit: number | undefined) =>
    guard(
      Effect.map(select(query, rowsFor(limit)), ({ items }) =>
        items.flatMap((row) => {
          const term = Bindings.getUndefined(row, name);
          return term !== undefined && Term.isNamedNode(term)
            ? [{ iri: term.value, count: countOf(row, 'count') }]
            : [];
        }),
      ),
    );

  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
  const OWL = 'http://www.w3.org/2002/07/owl#';
  const SKOS = 'http://www.w3.org/2004/02/skos/core#';

  return {
    sparql_query: ({
      query,
      limit,
    }: {
      readonly query: string;
      readonly limit?: number | undefined;
    }) => sparqlQuery(query, limit),
    describe_resource: ({
      iri,
      limit,
    }: {
      readonly iri: string;
      readonly limit?: number | undefined;
    }) => describeResource(iri, limit),
    list_classes: ({ limit }: { readonly limit?: number | undefined }) =>
      counted(
        `SELECT ?class (COUNT(?s) AS ?count) WHERE {
          { ?s a ?class } UNION { ?class a <${RDFS}Class> } UNION { ?class a <${OWL}Class> }
          FILTER(isIRI(?class))
        } GROUP BY ?class ORDER BY DESC(?count) ?class`,
        'class',
        limit,
      ),
    list_properties: ({ limit }: { readonly limit?: number | undefined }) =>
      counted(
        `SELECT ?property (COUNT(?s) AS ?count) WHERE {
          { ?s ?property ?o } UNION { ?property a <${RDF}Property> }
          UNION { ?property a <${OWL}ObjectProperty> } UNION { ?property a <${OWL}DatatypeProperty> }
        } GROUP BY ?property ORDER BY DESC(?count) ?property`,
        'property',
        limit,
      ),
    search_labels: ({
      text,
      limit,
    }: {
      readonly text: string;
      readonly limit?: number | undefined;
    }) =>
      guard(
        Effect.map(
          select(
            `SELECT DISTINCT ?resource ?label WHERE {
              ?resource <${RDFS}label>|<${SKOS}prefLabel> ?label
              FILTER(isIRI(?resource) && CONTAINS(LCASE(STR(?label)), LCASE(${Term.literal(text).key})))
            } ORDER BY ?resource ?label`,
            rowsFor(limit),
          ),
          ({ items }) =>
            items.flatMap((row) => {
              const resource = Bindings.getUndefined(row, 'resource');
              const label = Bindings.getUndefined(row, 'label');
              return resource !== undefined &&
                Term.isNamedNode(resource) &&
                label !== undefined &&
                Term.isLiteral(label)
                ? [{ iri: resource.value, label: label.value }]
                : [];
            }),
        ),
      ),
    sparql_update: ({ update }: { readonly update: string }) =>
      guard(Effect.as(engine.update(update), { isApplied: true })),
  };
});

/**
 * The handlers of the read-only `toolkit` as a layer, over the
 * `SparqlEngine` in context.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options?: ToolOptions) =>
  toolkit.toLayer(
    Effect.map(handlers(options), (h) =>
      toolkit.of({
        sparql_query: h.sparql_query,
        describe_resource: h.describe_resource,
        list_classes: h.list_classes,
        list_properties: h.list_properties,
        search_labels: h.search_labels,
      }),
    ),
  );

/**
 * The handlers of `toolkitWithUpdate` (the read-only tools plus
 * `sparql_update`) as a layer, over the `SparqlEngine` in context.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerWithUpdate = (options?: ToolOptions) =>
  toolkitWithUpdate.toLayer(Effect.map(handlers(options), (h) => toolkitWithUpdate.of(h)));
