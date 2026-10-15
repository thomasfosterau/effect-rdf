# @thomasfosterau/effect-sparql

SPARQL 1.1 (and SPARQL 1.2) for [Effect](https://effect.website), built on
[`@thomasfosterau/effect-rdf`](../core): a complete parser and generator, the
SPARQL algebra with an optimizer, a streaming query and update engine over a
pluggable storage service, the standard results formats, and a strongly-typed
query builder.

- **`Parser`** — hand-written recursive-descent parser for SPARQL 1.1 Query and
  Update plus SPARQL 1.2 (triple terms `<<( s p o )>>`, reified triples
  `<< s p o ~ r >>`, annotations `{| … |}`, `VERSION`, `@lang--dir`), with all
  static checks (blank node scoping, grouping, `BIND`/`AS` scoping, `VALUES`
  arity, `DELETE` blank nodes, …) and `SparqlParseError`s carrying
  line/column.
- **`Ast`** — typed AST (`Select`/`Construct`/`Ask`/`Describe`, all update
  operations) over core `Term`s, with constructors.
- **`Generator`** — prints any AST back to SPARQL; parse → print → parse is
  stable.
- **`Algebra`**, **`Translate`** — translation to the SPARQL algebra exactly
  per §18 (BGP, Path, Join, LeftJoin, Filter, Union, Graph, Extend, Minus,
  Group/aggregation, OrderBy, Project, Distinct, Reduced, Slice, Values,
  Service), S-expression formatting and tree utilities.
- **`Optimizer`** — semantics-preserving filter pushdown and BGP join
  ordering by selectivity (using store estimates when available).
- **`Expression`**, **`Functions`** — every SPARQL 1.1 operator and function
  (string, numeric, date/time, hashes, `RAND`/`NOW`/`UUID`/`STRUUID`/`BNODE`
  with per-query semantics), effective boolean value, XSD casts, the
  `ORDER BY` ordering, SPARQL 1.2 `TRIPLE`/`SUBJECT`/`PREDICATE`/`OBJECT`/
  `isTRIPLE`/`LANGDIR`/`hasLANG`/`hasLANGDIR`/`STRLANGDIR`, and extension
  functions registered by IRI.
- **`Store`** — the `QuadStore` service implemented by backends, and an
  in-memory `QuadStore` (`Store.layerMemory`) on the core `Dataset`.
- **`Engine`** — the `SparqlEngine` service: streaming `SELECT`, `ASK`,
  `CONSTRUCT`, `DESCRIBE` and atomic updates.
- **`Results`** — SPARQL results in JSON (via Effect `Schema`), XML, CSV and
  TSV: streaming serialisers and parsers, including triple terms and base
  directions; media-type lookup and `Accept` negotiation.
- **`QueryBuilder`**, **`TermSchema`** — an immutable, typed builder whose
  `SELECT` rows are typed from the projection, and schemas decoding terms to
  JS values.

## Querying

```ts
import { Effect, Layer, Stream } from 'effect';
import { Dataset, Term } from '@thomasfosterau/effect-rdf';
import { Bindings, Engine, Store } from '@thomasfosterau/effect-sparql';

const data = Dataset.make(/* … quads … */);
const SparqlLive = Engine.layer({ baseIri: 'http://example.org/' }).pipe(
  Layer.provideMerge(Store.layerMemory(data)),
);

const program = Effect.gen(function* () {
  const engine = yield* Engine.SparqlEngine;

  // SELECT: a lazy Stream of solutions (LIMIT stops evaluation early).
  const result = yield* engine.select(`
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>
    SELECT ?name WHERE { ?p foaf:name ?name } ORDER BY ?name LIMIT 10`);
  yield* Stream.runForEach(result.bindings, (b) => Effect.log(Bindings.get(b, 'name')));

  const known = yield* engine.ask('ASK { ?s ?p ?o }');
  const triples = yield* engine.construct('CONSTRUCT WHERE { ?s ?p ?o }');

  yield* engine.update(`
    PREFIX ex: <http://example.org/>
    INSERT { ?s ex:seen true } WHERE { ?s ?p ?o }`);
});

Effect.runPromise(program.pipe(Effect.provide(SparqlLive)));
```

`EngineOptions`: `unionDefaultGraph` (the default graph is the union of all
graphs when there is no `FROM`), `baseIri`, `functions` (extension functions
by IRI), `service` (federation), `load` (`LOAD` support) and `optimize`.
`RequestOptions.dataset` overrides the dataset per request (the protocol's
`default-graph-uri` / `named-graph-uri`); `FROM`/`FROM NAMED` in the query
take precedence.

## Typed query builder

```ts
import { Schema, Stream } from 'effect';
import { Namespace } from '@thomasfosterau/effect-rdf';
import { QueryBuilder as Q, TermSchema } from '@thomasfosterau/effect-sparql';

const foaf = Namespace.make('http://xmlns.com/foaf/0.1/');
const v = Q.vars('person', 'name', 'email'); // or the untyped proxy Q.v

const query = Q.select('person', 'name', Q.maybe('email'), Q.as(Q.strlen(v.name), 'length'))
  .where(Q.triple(v.person, foaf('name'), v.name))
  .optional(Q.triple(v.person, foaf('mbox'), v.email))
  .filter(Q.gt(Q.strlen(v.name), 3))
  .orderBy(Q.desc(v.name))
  .limit(10);

query.build(); // Ast.SelectQuery
query.toString(); // SPARQL text

// Stream<{ readonly person: GroundTerm; readonly name: GroundTerm;
//          readonly length: GroundTerm; readonly email?: GroundTerm }>
const rows = Q.execute(query);

// Decoding rows to JS values with schemas.
const people = Q.decode(
  query,
  Schema.Struct({ name: TermSchema.string, email: Schema.optional(TermSchema.iri) }),
);
```

## Results formats

```ts
import { Results } from '@thomasfosterau/effect-sparql';

const codec = Results.negotiate(request.headers.accept); // Option<ResultsCodec>
const body = Results.Json.serialize(selectResult); // Stream<string>
const parsed = yield * Results.Xml.parse(text); // ResultSet | BooleanResult
```

## Extension points

These are the seams for the packages built on top of this one.

### Storage backends (`Store.QuadStore`)

A backend provides the `QuadStore` service:

| member                              | purpose                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `match(pattern)`                    | stream the quads matching a quad pattern (`undefined` = wildcard; `graph` may be the default graph) |
| `estimate?(pattern)`                | cheap cardinality estimate used by the optimizer to order joins                                     |
| `graphs`, `hasGraph`                | named graph listing (including empty graphs the backend tracks)                                     |
| `insert`, `delete`                  | quad updates                                                                                        |
| `createGraph`, `dropGraph`, `clear` | graph management for `CREATE`, `DROP`, `CLEAR`, `ADD`, `MOVE`, `COPY`                               |
| `transaction(effect)`               | run an effect atomically (each update request runs in one transaction)                              |
| `query?`                            | optional native algebra evaluation (`QueryCapability`)                                              |

### Native algebra evaluation (SPARQL-to-SQL)

`QueryCapability.evaluate(op, context)` is offered **every algebra node,
top-down**, before the generic evaluator handles it. Returning
`Option.some(stream)` takes over the whole subtree; `Option.none()` lets the
engine evaluate the node itself, offering its children again. A SQL backend
can therefore translate the largest subtrees it supports (BGPs, joins,
filters, …) to SQL and leave the rest (e.g. property paths, exotic functions)
to the engine. The `context` carries the `DatasetSpec` (default and named
graphs), the active graph, and `evaluate(op, graph?)` to delegate children
back to the engine. The algebra types live in `Algebra` (with `format`,
`transform`, `variables`, `certainVariables` helpers); internal variables
(blank nodes, path steps, aggregates) start with `@`.

### Federation (`SERVICE`) and `LOAD`

`EngineOptions.service` receives the endpoint IRI and the `Algebra.Service`
node (whose `pattern` holds the original syntax, printable with
`Generator.printPattern`) and returns the remote solutions — the hook for an
HTTP client. `EngineOptions.load` fetches documents for `LOAD`.

### Protocol servers and clients

- `Parser.parse` accepts a query or an update; errors carry positions.
- `Results.codecs`, `Results.codecFor`, `Results.negotiate` and the streaming
  `serialize` functions implement the results side of the protocol; the
  parsers (`Results.Json.parse`, …) are what a client needs.
- `Engine.RequestOptions.dataset` maps the protocol's dataset parameters.
- `Generator.print` turns builder or parsed ASTs into query text for remote
  endpoints.

## Conformance

The W3C test suites are run from `.test-suites/rdf-tests/sparql` (or
`$RDF_TEST_SUITES`), using the `@thomasfosterau/effect-turtle`,
`effect-ntriples` and `effect-rdfxml` packages to read manifests and data:

- **Syntax**: 574 / 574 (SPARQL 1.0, 1.1 query and update, 1.2) — every
  positive test also round-trips through `Generator.print`.
- **Evaluation**: 707 / 707 runnable query, update and CSV/TSV result tests
  (SPARQL 1.0, 1.1, 1.2). Result sets are compared up to blank node renaming
  (numeric literals by value); ordered results check the `ORDER BY` keys.
- **Skipped** (77): `sparql11/entailment` (70; entailment regimes are not
  supported) and `sparql11/service` (7; federation needs remote endpoints).
  Protocol, Graph Store Protocol and service description tests belong to the
  future HTTP packages.
