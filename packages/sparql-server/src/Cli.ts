/**
 * The command line entry point: serves RDF files loaded into an in-memory
 * store.
 *
 * ```sh
 * effect-sparql-server --port 3030 data.ttl more.trig
 * ```
 *
 * Files are parsed with the default formats, chosen by file extension.
 * Triples go to the default graph, or with `--graph-per-file` to a named
 * graph per file (named by the file URL); quads keep their graph.
 *
 * @since 0.1.0
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import type * as HttpServerError from 'effect/http/HttpServerError';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Formats from './Formats.ts';
import type * as Options from './Options.ts';
import * as SparqlServer from './SparqlServer.ts';

/**
 * A command line usage error.
 *
 * @since 0.1.0
 * @category errors
 */
export class CliError extends Schema.TaggedError<CliError>()('CliError', {
  message: Schema.String,
}) {}

/**
 * The usage text.
 *
 * @since 0.1.0
 * @category cli
 */
export const usage = `Usage: effect-sparql-server [options] [files...]

Serves the given RDF files from an in-memory store over the SPARQL 1.1
Protocol and the Graph Store HTTP Protocol.

Options:
  -p, --port <port>          port to listen on (default 3030)
      --host <host>          host to bind (default all interfaces)
      --path <path>          SPARQL endpoint path (default /sparql)
      --update-path <path>   separate update endpoint path
      --graph-store <path>   Graph Store Protocol path (default /rdf-graph-store)
      --no-graph-store       disable the Graph Store Protocol
      --read-only            reject updates and graph store writes
      --timeout <ms>         query timeout in milliseconds
      --max-results <n>      maximum number of results per query
      --cors                 enable permissive CORS
      --union-default-graph  query the union of all graphs by default
      --graph-per-file       load each file into a named graph (its file URL)
      --base-url <url>       public origin of the server
  -h, --help                 show this help
`;

/**
 * Parsed command line arguments.
 *
 * @since 0.1.0
 * @category models
 */
export interface Arguments {
  readonly help: boolean;
  readonly files: ReadonlyArray<string>;
  readonly graphPerFile: boolean;
  readonly unionDefaultGraph: boolean;
  readonly serve: SparqlServer.ServeOptions;
}

const positiveInt = (name: string, value: string | undefined) =>
  Effect.suspend(() => {
    if (value === undefined) return Effect.succeed(undefined);
    const n = Number(value);
    return Number.isInteger(n) && n >= 0
      ? Effect.succeed(n)
      : Effect.fail(new CliError({ message: `--${name} expects a non-negative integer` }));
  });

// SAFETY: checked to start with `/` just above.
const pathOption = (name: string, value: string | undefined) =>
  value === undefined
    ? Effect.succeed(undefined)
    : value.startsWith('/')
      ? Effect.succeed(value as `/${string}`)
      : Effect.fail(new CliError({ message: `--${name} must start with '/'` }));

/**
 * Parses command line arguments.
 *
 * @since 0.1.0
 * @category cli
 */
export const parse = (argv: ReadonlyArray<string>): Effect.Effect<Arguments, CliError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () =>
        parseArgs({
          args: [...argv],
          allowPositionals: true,
          options: {
            port: { type: 'string', short: 'p' },
            host: { type: 'string' },
            path: { type: 'string' },
            'update-path': { type: 'string' },
            'graph-store': { type: 'string' },
            'no-graph-store': { type: 'boolean' },
            'read-only': { type: 'boolean' },
            timeout: { type: 'string' },
            'max-results': { type: 'string' },
            cors: { type: 'boolean' },
            'union-default-graph': { type: 'boolean' },
            'graph-per-file': { type: 'boolean' },
            'base-url': { type: 'string' },
            help: { type: 'boolean', short: 'h' },
          },
        }),
      catch: (e) =>
        new CliError({
          message:
            Predicate.hasProperty(e, 'message') && Predicate.isString(e.message)
              ? e.message
              : String(e),
        }),
    });
    const v = parsed.values;
    const port = (yield* positiveInt('port', v.port)) ?? 3030;
    const timeout = yield* positiveInt('timeout', v.timeout);
    const maxResults = yield* positiveInt('max-results', v['max-results']);
    const graphStore = yield* pathOption('graph-store', v['graph-store']);
    const options: Options.Options = {
      path: yield* pathOption('path', v.path),
      updatePath: yield* pathOption('update-path', v['update-path']),
      graphStorePath: v['no-graph-store'] === true ? false : graphStore,
      readOnly: v['read-only'] === true,
      queryTimeout: timeout,
      maxResults,
      cors: v.cors === true,
      logging: true,
      baseUrl: v['base-url'],
      unionDefaultGraph: v['union-default-graph'] === true,
    };
    return {
      help: v.help === true,
      files: parsed.positionals,
      graphPerFile: v['graph-per-file'] === true,
      unionDefaultGraph: v['union-default-graph'] === true,
      serve: { ...options, port, host: v.host },
    };
  });

/**
 * Loads RDF files into a dataset, choosing parsers by file extension.
 *
 * @since 0.1.0
 * @category cli
 */
export const load = (
  files: ReadonlyArray<string>,
  graphPerFile: boolean,
): Effect.Effect<Dataset.Dataset, CliError | Serialization.RdfParseError, Serialization.Formats> =>
  Effect.gen(function* () {
    const formats = yield* Serialization.Formats;
    const perFile = yield* Effect.forEach(
      files,
      Effect.fnUntraced(function* (file) {
        const ext = path.extname(file);
        const parser = Serialization.parserForExtension(formats, ext);
        if (Option.isNone(parser)) {
          return yield* new CliError({ message: `Unknown RDF file extension: ${file}` });
        }
        const text = yield* Effect.tryPromise({
          try: () => fs.readFile(file, 'utf8'),
          catch: (e) =>
            new CliError({
              message: `Cannot read ${file}: ${
                Predicate.hasProperty(e, 'message') && Predicate.isString(e.message)
                  ? e.message
                  : String(e)
              }`,
            }),
        });
        const url = pathToFileURL(path.resolve(file)).href;
        const graph = graphPerFile ? Term.namedNode(url) : undefined;
        const result = yield* parser.value.parse(text, { baseIri: url });
        const quads = Array.from(result.dataset, (q) =>
          graph !== undefined && q.graph._tag === 'DefaultGraph'
            ? new Term.Quad(q.subject, q.predicate, q.object, graph)
            : q,
        );
        yield* Effect.logInfo(`Loaded ${result.dataset.size} quads from ${file}`);
        return quads;
      }),
      { concurrency: 1 },
    );
    return Dataset.fromIterable(perFile.flat());
  });

/**
 * Runs the command line program: parses arguments, loads the files and
 * serves them until interrupted.
 *
 * @since 0.1.0
 * @category cli
 */
export const run = (
  argv: ReadonlyArray<string>,
): Effect.Effect<void, CliError | Serialization.RdfParseError | HttpServerError.ServeError> =>
  Effect.gen(function* () {
    const args = yield* parse(argv);
    if (args.help) {
      yield* Effect.sync(() => process.stdout.write(usage));
      return;
    }
    const data = yield* Effect.provide(load(args.files, args.graphPerFile), Formats.layer);
    const server = SparqlServer.layerMemory({
      ...args.serve,
      data,
      engine: { unionDefaultGraph: args.unionDefaultGraph },
    });
    return yield* Layer.launch(server);
  });
