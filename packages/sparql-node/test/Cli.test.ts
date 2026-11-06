/**
 * The `effect-sparql-server` command (`Cli`), the routes served over a real
 * socket by `@effect/platform-node`'s HTTP server, and `NodeSparqlServer`.
 */
import { describe, expect, it, layer } from '@effect/vitest';
import * as Arr from 'effect/Array';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Path from 'effect/Path';
import * as PlatformError from 'effect/PlatformError';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpServer from 'effect/http/HttpServer';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import { Dataset, Term } from '@thomasfosterau/effect-rdf';
import * as ServerFormats from '@thomasfosterau/effect-rdf/sparql/ServerFormats';
import * as SparqlServer from '@thomasfosterau/effect-rdf/sparql/SparqlServer';
import * as Cli from '../src/Cli.ts';
import * as NodeSparqlServer from '../src/NodeSparqlServer.ts';

const ex = (s: string) => Term.namedNode(`http://example.org/${s}`);
const data = Dataset.make(Term.quad(ex('alice'), ex('name'), Term.literal('Alice')));

describe('CLI', () => {
  it.effect('parses arguments', () =>
    Effect.gen(function* () {
      const args = yield* Cli.parse(['-p', '8080', '--read-only', '--timeout', '1000', 'a.ttl']);
      expect(args.serve.port).toBe(8080);
      expect(args.serve.readOnly).toBe(true);
      expect(args.serve.queryTimeout).toBe(1000);
      expect(args.files).toEqual(['a.ttl']);
      const error = yield* Effect.flip(Cli.parse(['--port', 'x']));
      expect(error._tag).toBe('CliError');
      const unknown = yield* Effect.flip(Cli.parse(['--nope']));
      expect(unknown._tag).toBe('CliError');
    }),
  );

  it.effect('reads unset flags from SPARQL_SERVER_* environment variables', () =>
    Effect.gen(function* () {
      const env = ConfigProvider.fromEnvRecord({
        SPARQL_SERVER_PORT: '4040',
        SPARQL_SERVER_HOST: '127.0.0.1',
        SPARQL_SERVER_PATH: '/query',
        SPARQL_SERVER_READ_ONLY: 'true',
        SPARQL_SERVER_MAX_RESULTS: '10',
        SPARQL_SERVER_NO_GRAPH_STORE: 'true',
        SPARQL_SERVER_BASE_URL: 'https://example.org',
      });
      const fromEnv = yield* Cli.parse(['a.ttl']).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, env),
      );
      expect(fromEnv.serve).toMatchObject({
        port: 4040,
        host: '127.0.0.1',
        path: '/query',
        readOnly: true,
        maxResults: 10,
        graphStorePath: false,
        baseUrl: 'https://example.org',
      });
      // A flag wins over the environment.
      const flagged = yield* Cli.parse(['-p', '1', '--path', '/sparql']).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, env),
      );
      expect(flagged.serve.port).toBe(1);
      expect(flagged.serve.path).toBe('/sparql');
      const invalid = yield* Effect.flip(
        Cli.parse([]).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord({ SPARQL_SERVER_BASE_URL: 'not an iri' }),
          ),
        ),
      );
      expect(invalid.message).toContain('--base-url must be an absolute IRI');
      expect((yield* Effect.flip(Cli.parse(['--path', 'x']))).message).toContain(
        "must start with '/'",
      );
    }),
  );

  it.effect('prints generated --help listing every flag and its environment variable', () =>
    Effect.gen(function* () {
      const lines: Array<string> = [];
      const capture: Console.Console = Object.assign(Object.create(globalThis.console), {
        log: (...args: ReadonlyArray<unknown>) => lines.push(args.join(' ')),
      });
      yield* Cli.run(['--help']).pipe(Effect.provideService(Console.Console, capture));
      const help = lines.join('\n');
      const flags = ['--port', '--read-only', '--graph-store', '--no-graph-store', '--base-url'];
      expect(flags.filter((flag) => !help.includes(flag))).toEqual([]);
      expect(help).toContain('[SPARQL_SERVER_MAX_RESULTS]');
      expect((yield* Cli.parse(['--help'])).help).toBe(true);
    }),
  );
});

const files = [
  ['/data/a.ttl', '<s> <http://example.org/p> "a" .'],
  ['/data/b.nt', '<http://example.org/s> <http://example.org/p> "b" .\n'],
] as const;

const fileSystem = FileSystem.layerNoop({
  readFile: (file) =>
    Option.match(
      Arr.findFirst(files, ([name]) => name === file),
      {
        onNone: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: 'NotFound',
              module: 'FileSystem',
              method: 'readFile',
              pathOrDescriptor: file,
            }),
          ),
        onSome: ([, text]) => Effect.succeed(new TextEncoder().encode(text)),
      },
    ),
});

layer(Layer.mergeAll(ServerFormats.layer, Path.layer, fileSystem))('CLI files', (withFiles) => {
  withFiles.effect('loads files through the FileSystem service, one graph per file', () =>
    Effect.gen(function* () {
      const loaded = yield* Cli.load(['/data/a.ttl', '/data/b.nt'], true);
      expect(loaded.size).toBe(2);
      const graphs = Arr.map(Arr.fromIterable(loaded), (quad) => quad.graph.value);
      expect(Arr.sort(graphs, Order.String)).toEqual(['file:///data/a.ttl', 'file:///data/b.nt']);
      // Relative IRIs resolve against the file's URL.
      expect(Arr.map(Arr.fromIterable(loaded), (quad) => quad.subject.key)).toContain(
        '<file:///data/s>',
      );
      const merged = yield* Cli.load(['/data/a.ttl'], false);
      expect(
        Option.map(Arr.head(Arr.fromIterable(merged)), (quad) => quad.graph._tag),
      ).toStrictEqual(Option.some('DefaultGraph'));
      const unknown = yield* Effect.flip(Cli.load(['/data/c.unknown'], false));
      expect(unknown.message).toContain('Unknown RDF file extension');
      const missing = yield* Effect.flip(Cli.load(['/data/missing.ttl'], false));
      expect(missing.message).toContain('Cannot read /data/missing.ttl');
    }),
  );
});

layer(
  SparqlServer.layerServe({ logging: false }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(SparqlServer.layerMemoryServices(data)),
  ),
  { buildPerTest: true },
)('Node server', (test) => {
  test.effect('serves over a real socket via the HttpRouter', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const r = yield* client.execute(
        HttpClientRequest.get(`/sparql/?query=${encodeURIComponent('ASK { ?s ?p "Alice" }')}`),
      );
      expect(r.status).toBe(200);
      expect(yield* r.text).toContain('true');
      const g = yield* client.execute(
        HttpClientRequest.get('/rdf-graph-store?default', {
          headers: { accept: 'application/n-triples' },
        }),
      );
      expect(g.status).toBe(200);
      const direct = yield* client.execute(HttpClientRequest.get('/rdf-graph-store/missing'));
      expect(direct.status).toBe(404);
    }),
  );
});

layer(
  HttpServer.layerTestClient.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(
      NodeSparqlServer.layerMemory({
        port: 0,
        host: '127.0.0.1',
        data,
        logging: false,
        engine: { unionDefaultGraph: true },
      }),
    ),
  ),
)('NodeSparqlServer', (test) => {
  test.effect('serves an in-memory store on a node:http socket', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const r = yield* client.execute(
        HttpClientRequest.get(`/sparql?query=${encodeURIComponent('ASK { ?s ?p "Alice" }')}`),
      );
      expect(r.status).toBe(200);
      expect(yield* r.text).toContain('true');
      // The engine's `unionDefaultGraph` is advertised in the service description.
      const description = yield* client.execute(
        HttpClientRequest.get('/sparql', { headers: { accept: 'application/n-triples' } }),
      );
      expect(yield* description.text).toContain('UnionDefaultGraph');
    }),
  );
});
