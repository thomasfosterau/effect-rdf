/**
 * CSVW processing (Tabular Data Model §Processing Tables): from a tabular
 * data file or a metadata file to an annotated table group and its
 * validation report. Tables and metadata documents are read through the
 * `Loader` service, which hands back already-parsed rows (this package has no
 * CSV scanner of its own).
 *
 * Metadata is taken from, in order: the user's metadata, the default
 * locations (`{+url}-metadata.json`, `csv-metadata.json`) through the
 * `Loader`, and the embedded metadata. HTTP `Link` headers and a site-wide
 * `/.well-known/csvm` configuration are not consulted.
 *
 * @since 0.1.0
 */
import { Iri } from '@thomasfosterau/effect-rdf';
import * as Arr from 'effect/Array';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import * as Schema from 'effect/Schema';
import * as Metadata from './Metadata.ts';
import * as Report from './Report.ts';
import * as Table from './Table.ts';
import * as UriTemplate from './internal/uriTemplate.ts';
import * as Url from './internal/url.ts';

/**
 * A table or metadata document that could not be read.
 *
 * @since 0.1.0
 * @category errors
 */
export class LoadError extends Schema.TaggedError<LoadError>()('LoadError', {
  message: Schema.String,
  url: Schema.String,
}) {}

/**
 * Reads the resources CSVW processing needs: a table's rows, parsed with its
 * dialect, and a metadata document's text (`None` when there is none at that
 * URL, as when probing default locations).
 *
 * @since 0.1.0
 * @category services
 */
export class Loader extends Context.Service<
  Loader,
  {
    readonly table: (
      url: string,
      dialect: Metadata.Dialect,
    ) => Effect.Effect<ReadonlyArray<ReadonlyArray<string>>, LoadError>;
    readonly document: (url: string) => Effect.Effect<Option.Option<string>, LoadError>;
  }
>()('@thomasfosterau/effect-csvw/Loader') {}

/**
 * A `Loader` over already-parsed tables and metadata documents held in
 * memory, keyed by URL (a table's dialect is not used: its rows are already
 * split).
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeLoader = (
  sources: ReadonlyArray<Table.Source>,
  documents: Readonly<Record<string, string>> = {},
): Loader['Service'] =>
  Loader.of({
    table: (url) =>
      Option.match(
        Arr.findFirst(sources, (s) => Url.normalize(s.url) === Url.normalize(url)),
        {
          onNone: () => Effect.fail(new LoadError({ message: `no table at ${url}`, url })),
          onSome: (s) => Effect.succeed(s.rows),
        },
      ),
    document: (url) => Effect.succeed(Record.get(documents, url)),
  });

/**
 * `makeLoader` as a layer.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerSources = (
  sources: ReadonlyArray<Table.Source>,
  documents: Readonly<Record<string, string>> = {},
): Layer.Layer<Loader> => Layer.succeed(Loader, makeLoader(sources, documents));

/**
 * Options for processing.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options extends Table.Options {
  /** User-supplied (overriding) metadata: its URL and text. */
  readonly metadata?: { readonly url: string; readonly text: string } | undefined;
  /** Look for metadata at the default locations (default `true`). */
  readonly locate?: boolean | undefined;
}

/**
 * The result of processing: the annotated group, the metadata it was
 * annotated with and the validation report.
 *
 * @since 0.1.0
 * @category models
 */
export interface Processed {
  readonly group: Table.TableGroup;
  readonly metadata: Metadata.TableGroup;
  readonly report: Report.Report;
}

/**
 * The default metadata locations for a tabular data file
 * (`{+url}-metadata.json`, then `csv-metadata.json`), resolved against it.
 *
 * @since 0.1.0
 * @category locating
 */
export const defaultLocations = (url: string): ReadonlyArray<string> => {
  const base = Iri.withoutFragment(url);
  return Arr.map(['{+url}-metadata.json', 'csv-metadata.json'], (template) =>
    Url.resolve(UriTemplate.expand(template, { url: base }), base),
  );
};

const fetchWith =
  (loader: Loader['Service']): Metadata.Fetch =>
  (url) =>
    loader.document(url).pipe(
      Effect.mapError((e) => new Metadata.MetadataError({ message: e.message, url })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new Metadata.MetadataError({ message: `no document at ${url}`, url })),
          onSome: Effect.succeed,
        }),
      ),
    );

/**
 * Annotates every table of a normalized table group, reading each through
 * the `Loader`, and checks its keys.
 *
 * @since 0.1.0
 * @category processing
 */
export const processGroup = Effect.fnUntraced(function* (
  metadata: Metadata.TableGroup,
  warnings: ReadonlyArray<Report.Issue>,
  options: Table.Options = {},
): Effect.fn.Return<Processed, Metadata.MetadataError | LoadError, Loader> {
  const loader = yield* Loader;
  const annotated = yield* Effect.forEach(
    metadata.tables,
    (table) =>
      Effect.map(loader.table(table.url, Metadata.dialectOfTable(metadata, table)), (rows) =>
        Table.annotate(metadata, table, { url: table.url, rows }, options),
      ),
    { concurrency: 1 },
  );
  const tables = Arr.map(annotated, (a) => a.table);
  const targetErrors = Table.checkForeignKeyTargets(tables);
  if (Arr.isReadonlyArrayNonEmpty(targetErrors))
    return yield* new Metadata.MetadataError({ message: targetErrors[0] });
  const keys = options.validate === true ? Table.validateKeys(tables) : [];
  return {
    group: {
      id: Option.fromNullishOr(metadata.id),
      notes: metadata.notes,
      common: metadata.common,
      tables,
    },
    metadata,
    report: Report.make([...warnings, ...Arr.flatMap(annotated, (a) => a.issues), ...keys]),
  };
});

/**
 * Processes starting from a metadata document: decodes it (fetching any
 * referenced schemas and dialects through the `Loader`) and annotates every
 * table it describes.
 *
 * @since 0.1.0
 * @category processing
 */
export const fromMetadata = Effect.fn('Processor.fromMetadata')(function* (
  url: string,
  text: string,
  options: Table.Options = {},
): Effect.fn.Return<Processed, Metadata.MetadataError | LoadError, Loader> {
  const loader = yield* Loader;
  const decoded = yield* Metadata.decode(text, url, fetchWith(loader));
  return yield* processGroup(decoded.group, decoded.warnings, options);
});

interface Located {
  readonly found: Option.Option<Metadata.Decoded>;
  readonly warnings: ReadonlyArray<Report.Issue>;
}

const embeddedOnly = (url: string): Metadata.TableGroup => ({
  tables: [
    {
      url,
      notes: [],
      isSuppressed: false,
      transformations: [],
      inherited: {},
      common: {},
    },
  ],
  notes: [],
  transformations: [],
  inherited: {},
  common: {},
});

/**
 * Processes starting from a tabular data file: uses the user's metadata if
 * given, else the first metadata document at a default location that
 * describes the file, else the file's embedded metadata.
 *
 * @since 0.1.0
 * @category processing
 */
export const fromTabular = Effect.fn('Processor.fromTabular')(function* (
  url: string,
  options: Options = {},
): Effect.fn.Return<Processed, Metadata.MetadataError | LoadError, Loader> {
  const loader = yield* Loader;
  const fetch = fetchWith(loader);
  if (options.metadata !== undefined) {
    const decoded = yield* Metadata.decode(options.metadata.text, options.metadata.url, fetch);
    return yield* processGroup(decoded.group, decoded.warnings, options);
  }
  const candidates = options.locate === false ? [] : defaultLocations(url);
  const located = yield* Effect.reduce(
    candidates,
    (): Located => ({ found: Option.none(), warnings: [] }),
    (acc, candidate): Effect.Effect<Located, Metadata.MetadataError | LoadError> =>
      Option.isSome(acc.found)
        ? Effect.succeed(acc)
        : Effect.flatMap(loader.document(candidate), (doc) =>
            Option.match(doc, {
              onNone: () => Effect.succeed(acc),
              onSome: (text) =>
                Effect.map(Metadata.decode(text, candidate, fetch), (decoded) =>
                  Metadata.describes(decoded.group, url)
                    ? { found: Option.some(decoded), warnings: acc.warnings }
                    : {
                        found: Option.none(),
                        warnings: Arr.append(
                          acc.warnings,
                          Report.warning(`${candidate} does not describe ${url}`, {
                            table: candidate,
                          }),
                        ),
                      },
                ),
            }),
          ),
  );
  return yield* Option.match(located.found, {
    onNone: () => processGroup(embeddedOnly(url), located.warnings, options),
    onSome: (decoded) =>
      processGroup(decoded.group, [...located.warnings, ...decoded.warnings], options),
  });
});
