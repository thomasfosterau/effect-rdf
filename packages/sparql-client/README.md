# @thomasfosterau/effect-sparql-client

A strongly-typed [SPARQL 1.1 Protocol](https://www.w3.org/TR/sparql11-protocol/)
and [Graph Store HTTP Protocol](https://www.w3.org/TR/sparql11-http-rdf-update/)
client for [Effect](https://effect.website), built on the `effect/http`
`HttpClient` and the query model of
[`@thomasfosterau/effect-sparql`](../sparql).

- **Queries** as strings, parsed `Ast` values or `QueryBuilder` builders —
  the typed rows of `QueryBuilder.select(…)` flow through to `select`, and
  rows can be decoded with an Effect `Schema`.
- **Streaming**: `SELECT` results are parsed incrementally (JSON, XML and
  TSV; CSV is buffered) and emitted as a `Stream`; `CONSTRUCT` / `DESCRIBE`
  results are parsed with the `Serialization.Formats` parser for the response
  media type (N-Triples is preferred and parsed incrementally).
- **Updates** with `using-graph-uri` / `using-named-graph-uri`, and the
  **Graph Store Protocol**: `getGraph`, `hasGraph`, `putGraph`, `postGraph`,
  `createGraph`, `deleteGraph`.
- **Typed errors** (`SparqlClientError`): `HttpStatusError` (with the
  response body), `MalformedResponseError`, `UnsupportedMediaTypeError`,
  `TransportError`, `TimeoutError`, `ConfigurationError`.
- **Timeouts and retries** configured with a `Duration` and an Effect
  `Schedule` (transient failures only, by default).
- **Federation**: a `SERVICE` handler and a `LOAD` loader for the in-memory
  engine, so that it evaluates `SERVICE <url> { … }` remotely.

## Querying

```ts
import { Effect, Layer, Schedule, Schema, Stream } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Namespace } from '@thomasfosterau/effect-rdf';
import { QueryBuilder as Q, TermSchema } from '@thomasfosterau/effect-sparql';
import { SparqlClient } from '@thomasfosterau/effect-sparql-client';

const ClientLive = SparqlClient.layer({
  endpoint: 'https://query.wikidata.org/sparql',
  headers: { 'user-agent': 'my-app/1.0' },
  method: 'auto', // GET for short queries, POST otherwise
  timeout: '30 seconds',
  retry: Schedule.max([Schedule.exponential('200 millis'), Schedule.recurs(3)]),
}).pipe(Layer.provide(FetchHttpClient.layer));

const foaf = Namespace.make('http://xmlns.com/foaf/0.1/');
const v = Q.vars('person', 'name', 'mbox');
const query = Q.select('person', 'name', Q.maybe('mbox'))
  .where(Q.triple(v.person, foaf('name'), v.name))
  .optional(Q.triple(v.person, foaf('mbox'), v.mbox))
  .limit(10);

const program = Effect.gen(function* () {
  const client = yield* SparqlClient.SparqlClient;

  // Stream<{ person: GroundTerm; name: GroundTerm; mbox?: GroundTerm }>
  yield* Stream.runForEach(client.select(query), (row) => Effect.log(row.name));

  // Untyped rows from a string (or an Ast.Query).
  const rows = yield* Stream.runCollect(client.select('SELECT * { ?s ?p ?o } LIMIT 3'));

  // Rows decoded with a schema.
  const people = yield* Stream.runCollect(
    SparqlClient.decode(query, Schema.Struct({ name: TermSchema.string })),
  );

  const exists = yield* client.ask('ASK { ?s ?p ?o }');
  const graph = yield* client.constructDataset('CONSTRUCT WHERE { ?s ?p ?o } LIMIT 10');
  const triples = client.describe(Q.describe(foaf('Person'))); // Stream<Quad>

  // Protocol dataset parameters.
  yield* Stream.runDrain(
    client.select('SELECT * { ?s ?p ?o }', { defaultGraphs: ['http://example.org/g'] }),
  );
});

Effect.runPromise(program.pipe(Effect.provide(ClientLive)));
```

`selectAll` collects a result set with its variables, `results` exposes the
raw stream of events (`Variables`, `Solution`, `Boolean`), and `query`
evaluates any query form and dispatches on the response media type.

## Updates and the Graph Store

```ts
import { Effect } from 'effect';
import { Term } from '@thomasfosterau/effect-rdf';
import { SparqlClient } from '@thomasfosterau/effect-sparql-client';

const ClientLive = SparqlClient.layer({
  endpoint: 'http://localhost:3030/sparql',
  updateEndpoint: 'http://localhost:3030/sparql',
  graphStoreEndpoint: 'http://localhost:3030/rdf-graph-store',
});

const program = Effect.gen(function* () {
  const client = yield* SparqlClient.SparqlClient;
  yield* client.update('INSERT DATA { <urn:a> <urn:b> "c" }');
  yield* client.update('DELETE WHERE { ?s ?p ?o }', { usingGraphs: ['urn:g'] });

  const g = Term.namedNode('http://example.org/people');
  yield* client.putGraph(g, [
    Term.quad(Term.namedNode('urn:x'), Term.namedNode('urn:p'), Term.literal('v')),
  ]);
  yield* client.postGraph(g, [], { mediaType: 'text/turtle' });
  const dataset = yield* client.getGraphDataset(g);
  const exists = yield* client.hasGraph(g);
  const created = yield* client.createGraph([]); // POST to the store: the new graph's IRI
  yield* client.deleteGraph(g);
  yield* client.getGraphDataset('default');
});
```

## Errors

```ts
const result = client.ask('ASK {').pipe(
  Effect.catchTag('HttpStatusError', (e) => Effect.logError(e.status, e.body)),
  Effect.catchTag('TimeoutError', () => Effect.succeed(false)),
);
```

`Errors.isTransient` decides what `retry` retries (transport errors,
timeouts, `408`, `429`, `502`, `503`, `504`); override it with `retryWhile`.

## Federation

```ts
import { Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Store } from '@thomasfosterau/effect-sparql';
import { Federation } from '@thomasfosterau/effect-sparql-client';

// SERVICE <url> { … } is sent to the remote endpoint; LOAD <url> fetches
// documents over HTTP.
const EngineLive = Federation.layerEngine({ baseIri: 'http://example.org/' }).pipe(
  Layer.provide(Store.layerMemory()),
  Layer.provide(FetchHttpClient.layer),
);
```

`Federation.serviceHandler(config)` and `Federation.loader(config)` give the
`Engine.EngineOptions.service` / `load` functions on their own. Each remote
pattern is sent as `SELECT * WHERE { … }` with the prefixes of the original
query; `SERVICE SILENT` swallows failures, and `SERVICE ?endpoint` works once
`?endpoint` is bound by an earlier pattern.

## Formats

The client uses the `Serialization.Formats` service when one is provided and
falls back to `Formats.defaults` (N-Triples, Turtle, N-Quads, TriG, RDF/XML,
JSON-LD, N3, RDF/JSON). `ResultsStream` exposes the incremental results
parsers.

## Tests and conformance

The tests run the client against
[`@thomasfosterau/effect-sparql-server`](../sparql-server) in-process (and
against a mocked `HttpClient` for error cases):

- **SPARQL evaluation over HTTP**: all 707 runnable W3C query, update and
  CSV/TSV evaluation tests (SPARQL 1.0, 1.1, 1.2) pass with each test's data
  loaded into a server and every query sent by the client, with results
  parsed from JSON, XML and TSV. Skipped: `sparql11/entailment` (entailment
  regimes are not supported) and `sparql11/service` (run separately below).
- **Federation** (`sparql11/service`): 7 / 7, with one in-process server per
  endpoint (the servers are federated themselves, for nested `SERVICE`).
