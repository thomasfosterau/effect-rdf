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
 * The command is built with `effect/cli` (generated `--help`, `--version`
 * and shell completions), and every flag also reads an environment variable
 * through `Config`: `SPARQL_SERVER_` followed by the flag name in upper
 * snake case (`--max-results` is `SPARQL_SERVER_MAX_RESULTS`). A flag on the
 * command line wins over the environment, which wins over the default.
 *
 * @since 0.1.0
 */
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import * as Config from 'effect/Config';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as PlatformError from 'effect/PlatformError';
import * as Ref from 'effect/Ref';
import * as Schema from 'effect/Schema';
import { Argument, Command, Flag } from 'effect/cli';
import * as CliErrors from 'effect/cli/CliError';
import type * as HttpServerError from 'effect/http/HttpServerError';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as ServerFormats from '@thomasfosterau/effect-rdf/sparql/ServerFormats';
import type * as Options from '@thomasfosterau/effect-rdf/sparql/Options';
import * as NodeSparqlServer from './NodeSparqlServer.ts';

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
 * The prefix of the environment variables that back the flags:
 * `SPARQL_SERVER_PORT`, `SPARQL_SERVER_READ_ONLY`, …
 *
 * @since 0.1.0
 * @category cli
 */
export const envPrefix = 'SPARQL_SERVER_';

const envName = (flag: string): string => `${envPrefix}${flag.toUpperCase().replaceAll('-', '_')}`;

/**
 * A summary of the flags and their environment variables; `--help` prints
 * the full, generated help.
 *
 * @since 0.1.0
 * @category cli
 */
export const usage = `Usage: effect-sparql-server [flags] [files...]

Serves the given RDF files from an in-memory store over the SPARQL 1.1
Protocol and the Graph Store HTTP Protocol.

Flags (environment variable in brackets; a flag wins over the environment):
  -p, --port <port>          port to listen on (default 3030) [SPARQL_SERVER_PORT]
      --host <host>          host to bind (default all interfaces) [SPARQL_SERVER_HOST]
      --path <path>          SPARQL endpoint path (default /sparql) [SPARQL_SERVER_PATH]
      --update-path <path>   separate update endpoint path [SPARQL_SERVER_UPDATE_PATH]
      --graph-store <path>   Graph Store Protocol path (default /rdf-graph-store) [SPARQL_SERVER_GRAPH_STORE]
      --no-graph-store       disable the Graph Store Protocol [SPARQL_SERVER_NO_GRAPH_STORE]
      --read-only            reject updates and graph store writes [SPARQL_SERVER_READ_ONLY]
      --timeout <ms>         query timeout in milliseconds [SPARQL_SERVER_TIMEOUT]
      --max-results <n>      maximum number of results per query [SPARQL_SERVER_MAX_RESULTS]
      --cors                 enable permissive CORS [SPARQL_SERVER_CORS]
      --union-default-graph  query the union of all graphs by default [SPARQL_SERVER_UNION_DEFAULT_GRAPH]
      --graph-per-file       load each file into a named graph (its file URL) [SPARQL_SERVER_GRAPH_PER_FILE]
      --base-url <url>       public origin of the server [SPARQL_SERVER_BASE_URL]
  -h, --help                 show the full help
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
  readonly serve: NodeSparqlServer.ServeOptions;
}

// A string flag, falling back to its environment variable, absent when neither is set.
const stringFlag = (name: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withDescription(`${description} [${envName(name)}]`),
    Flag.withFallbackConfig(Config.String(envName(name))),
    Flag.optional,
  );

// An integer flag, falling back to its environment variable.
const intFlag = (name: string, description: string) =>
  Flag.Int(name).pipe(
    Flag.withDescription(`${description} [${envName(name)}]`),
    Flag.withFallbackConfig(Config.Int(envName(name))),
    Flag.optional,
  );

// A boolean flag, falling back to its environment variable, then to false.
const booleanFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(
    Flag.withDescription(`${description} [${envName(name)}]`),
    Flag.withFallbackConfig(Config.Boolean(envName(name))),
    Flag.withDefault(false),
  );

/**
 * The command's flags and arguments.
 *
 * @since 0.1.0
 * @category cli
 */
export const config = {
  port: intFlag('port', 'port to listen on (default 3030)').pipe(Flag.withAlias('p')),
  host: stringFlag('host', 'host to bind (default all interfaces)'),
  path: stringFlag('path', 'SPARQL endpoint path (default /sparql)'),
  updatePath: stringFlag('update-path', 'separate update endpoint path'),
  graphStore: stringFlag('graph-store', 'Graph Store Protocol path (default /rdf-graph-store)'),
  noGraphStore: booleanFlag('no-graph-store', 'disable the Graph Store Protocol'),
  readOnly: booleanFlag('read-only', 'reject updates and graph store writes'),
  timeout: intFlag('timeout', 'query timeout in milliseconds'),
  maxResults: intFlag('max-results', 'maximum number of results per query'),
  cors: booleanFlag('cors', 'enable permissive CORS'),
  unionDefaultGraph: booleanFlag('union-default-graph', 'query the union of all graphs by default'),
  graphPerFile: booleanFlag('graph-per-file', 'load each file into a named graph (its file URL)'),
  baseUrl: stringFlag('base-url', 'public origin of the server'),
  files: Argument.String('files').pipe(
    Argument.withDescription('RDF files to load, in any syntax the server reads'),
    Argument.variadic(),
  ),
} as const;

/**
 * The values of the flags and arguments, as `effect/cli` parses them.
 *
 * @since 0.1.0
 * @category models
 */
export type Flags = Command.Command.Config.Infer<typeof config>;

const nonNegative = (name: string, value: Option.Option<number>) =>
  Option.match(value, {
    onNone: () => Effect.undefined,
    onSome: (n) =>
      Number.isInteger(n) && n >= 0
        ? Effect.succeed(n)
        : Effect.fail(new CliError({ message: `--${name} expects a non-negative integer` })),
  });

const endpointPath = (name: string, value: Option.Option<string>) =>
  Option.match(value, {
    onNone: () => Effect.undefined,
    onSome: (path) =>
      Schema.is(EndpointPath)(path)
        ? Effect.succeed(path)
        : Effect.fail(new CliError({ message: `--${name} must start with '/'` })),
  });

const EndpointPath = Schema.TemplateLiteral(['/', Schema.String]);

/**
 * Validates parsed flags into `Arguments`: integers must be non-negative,
 * paths must start with `/`, and `--base-url` must be an absolute IRI.
 *
 * @since 0.1.0
 * @category cli
 */
export const toArguments = (flags: Flags): Effect.Effect<Arguments, CliError> =>
  Effect.gen(function* () {
    const baseUrl = Option.getOrUndefined(flags.baseUrl);
    if (baseUrl !== undefined && !Iri.isValid(baseUrl)) {
      return yield* new CliError({ message: `--base-url must be an absolute IRI: ${baseUrl}` });
    }
    const graphStore = yield* endpointPath('graph-store', flags.graphStore);
    const options: Options.Options = {
      path: yield* endpointPath('path', flags.path),
      updatePath: yield* endpointPath('update-path', flags.updatePath),
      graphStorePath: flags.noGraphStore ? false : graphStore,
      readOnly: flags.readOnly,
      queryTimeout: yield* nonNegative('timeout', flags.timeout),
      maxResults: yield* nonNegative('max-results', flags.maxResults),
      cors: flags.cors,
      logging: true,
      baseUrl,
      unionDefaultGraph: flags.unionDefaultGraph,
    };
    return {
      help: false,
      files: flags.files,
      graphPerFile: flags.graphPerFile,
      unionDefaultGraph: flags.unionDefaultGraph,
      serve: {
        ...options,
        port: (yield* nonNegative('port', flags.port)) ?? 3030,
        host: Option.getOrUndefined(flags.host),
      },
    };
  });

// The `effect/cli` errors as this module's `CliError` (a help request has no message).
const fromCliError = (error: CliErrors.CliError): CliError =>
  new CliError({
    message: Match.value(error).pipe(
      Match.tag('ShowHelp', (help) => help.errors.map((e) => e.message).join('\n')),
      Match.orElse((e) => e.message),
    ),
  });

const quiet = (): void => undefined;
const silentConsole: Console.Console = Object.assign(Object.create(globalThis.console), {
  log: quiet,
  error: quiet,
  info: quiet,
  warn: quiet,
});

const isHelp = (argv: ReadonlyArray<string>): boolean =>
  argv.includes('--help') || argv.includes('-h');

/**
 * Parses command line arguments, reading unset flags from the environment
 * (`SPARQL_SERVER_*`). `-h` / `--help` sets `help` instead.
 *
 * @since 0.1.0
 * @category cli
 */
export const parse = (argv: ReadonlyArray<string>): Effect.Effect<Arguments, CliError> =>
  isHelp(argv)
    ? Effect.succeed({
        help: true,
        files: [],
        graphPerFile: false,
        unionDefaultGraph: false,
        serve: { port: 3030 },
      })
    : Effect.gen(function* () {
        const parsed = yield* Ref.make(Option.none<Arguments>());
        const capture = Command.make('effect-sparql-server', config, (flags) =>
          Effect.flatMap(toArguments(flags), (args) => Ref.set(parsed, Option.some(args))),
        );
        yield* Command.runWith(capture, { version: '', renderErrors: false })(argv).pipe(
          Effect.catchIf(CliErrors.isCliError, (e) => Effect.fail(fromCliError(e))),
          // Parsing is programmatic: the help `effect/cli` prints for a usage error stays quiet.
          Effect.provideService(Console.Console, silentConsole),
          Effect.provide(NodeServices.layer),
        );
        return yield* Effect.flatMap(Ref.get(parsed), Effect.fromOption).pipe(
          Effect.mapError(() => new CliError({ message: 'no arguments were parsed' })),
        );
      });

/**
 * Loads RDF files into a dataset through Effect's `FileSystem`, choosing
 * parsers by file extension from the `Formats` service. Relative IRIs
 * resolve against each file's `file:` URL; with `graphPerFile`, a file's
 * default-graph triples go into a graph named by that URL.
 *
 * @since 0.1.0
 * @category cli
 */
export const load = (
  files: ReadonlyArray<string>,
  graphPerFile: boolean,
): Effect.Effect<
  Dataset.Dataset,
  CliError | Serialization.RdfParseError,
  Serialization.Formats | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const formats = yield* Serialization.Formats;
    const paths = yield* Path.Path;
    const perFile = yield* Effect.forEach(
      files,
      Effect.fnUntraced(function* (file) {
        const parser = Serialization.parserForExtension(formats, paths.extname(file));
        if (Option.isNone(parser)) {
          return yield* new CliError({ message: `Unknown RDF file extension: ${file}` });
        }
        const cannotRead = (e: PlatformError.PlatformError) =>
          new CliError({ message: `Cannot read ${file}: ${e.message}` });
        const url = (yield* paths
          .toFileUrl(paths.resolve(file))
          .pipe(Effect.mapError((e) => cannotRead(new PlatformError.PlatformError(e))))).href;
        const result = yield* Serialization.readFile(file, {
          parser: parser.value,
          baseIri: url,
        }).pipe(Effect.catchTag('PlatformError', (e) => Effect.fail(cannotRead(e))));
        const graph = graphPerFile ? Term.namedNode(url) : undefined;
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
 * The `effect/cli` command: parses the flags (and their environment
 * variables), loads the files and serves them until interrupted.
 *
 * @since 0.1.0
 * @category cli
 */
export const command = Command.make('effect-sparql-server', config, (flags) =>
  Effect.gen(function* () {
    const args = yield* toArguments(flags);
    const data = yield* Effect.provide(
      load(args.files, args.graphPerFile),
      Layer.mergeAll(ServerFormats.layer, NodeFileSystem.layer, NodePath.layer),
    );
    const server = NodeSparqlServer.layerMemory({
      ...args.serve,
      data,
      engine: { unionDefaultGraph: args.unionDefaultGraph },
    });
    return yield* Layer.launch(server);
  }),
).pipe(
  Command.withDescription(
    'Serves the given RDF files from an in-memory store over the SPARQL 1.1 Protocol and the Graph Store HTTP Protocol.',
  ),
);

/**
 * Runs the command line program: parses arguments (printing the generated
 * help for `--help` or a usage error), loads the files and serves them
 * until interrupted. `version` is what `--version` prints.
 *
 * @since 0.1.0
 * @category cli
 */
export const run = (
  argv: ReadonlyArray<string>,
  options?: { readonly version?: string | undefined },
): Effect.Effect<void, CliError | Serialization.RdfParseError | HttpServerError.ServeError> =>
  Command.runWith(command, { version: options?.version ?? 'unknown', renderErrors: false })(
    argv,
  ).pipe(
    Effect.catchIf(CliErrors.isCliError, (e) => Effect.fail(fromCliError(e))),
    Effect.provide(NodeServices.layer),
  );
