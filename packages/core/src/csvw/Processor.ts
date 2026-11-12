/**
 * CSVW processing (Tabular Data Model §Processing Tables): from a tabular
 * data file or a metadata file to an annotated table group and its
 * validation report. Tables and metadata documents are read through the
 * `Loader` service, which hands back already-parsed rows (this package has no
 * CSV scanner of its own).
 *
 * Metadata is taken from, in order (Model for Tabular Data and Metadata on the
 * Web, §5 Locating Metadata): the user's metadata; a metadata document named
 * by a `Link` header with `rel="describedby"` on the tabular data file's
 * response; the locations of the site-wide `/.well-known/csvm` configuration
 * (URI templates, one per line, expanded with the file's `url`), or, when
 * the site has none, the defaults `{+url}-metadata.json` and
 * `csv-metadata.json`; and the embedded metadata. A located document that
 * does not describe the file is ignored with a warning. This module performs
 * no network I/O: the `Loader` supplies the `Link` header
 * (`linkHeader`) and the text of the documents (`document`).
 *
 * @since 0.1.0
 */
import { LinkHeader, WellKnown } from '@thomasfosterau/effect-ext/UriTemplate';
import { Iri } from '../index.ts';
import * as Arr from 'effect/Array';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
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
export class LoadError extends Schema.TaggedError<LoadError, { readonly brand: unique symbol }>()(
  'LoadError',
  {
    message: Schema.String,
    url: Schema.String,
  },
) {}

/**
 * Reads the resources CSVW processing needs: a table's rows, parsed with its
 * dialect; a metadata document's text (`None` when there is none at that URL,
 * as when probing metadata locations, `/.well-known/csvm` included); and the
 * `Link` header value of the response that served a tabular data file (`None`
 * when it had none, or the file was not served over HTTP). An HTTP loader
 * joins several `Link` headers with `,`.
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
    /** @since 0.3.0 */
    readonly linkHeader: (url: string) => Effect.Effect<Option.Option<string>, LoadError>;
  }
>()('@thomasfosterau/effect-rdf/csvw/Loader') {}

/**
 * A `Loader` over already-parsed tables and metadata documents held in
 * memory, keyed by URL (a table's dialect is not used: its rows are already
 * split). `linkHeaders` holds the `Link` header value of a table's response by
 * the table's URL; a table without an entry had no `Link` header. A site-wide
 * `/.well-known/csvm` file is a document like any other, under the URL
 * `<origin>/.well-known/csvm`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeLoader = (
  sources: ReadonlyArray<Table.Source>,
  documents: Readonly<Record<string, string>> = {},
  linkHeaders: Readonly<Record<string, string>> = {},
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
    linkHeader: (url) => Effect.succeed(Record.get(linkHeaders, url)),
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
  linkHeaders: Readonly<Record<string, string>> = {},
): Layer.Layer<Loader> => Layer.succeed(Loader, makeLoader(sources, documents, linkHeaders));

/**
 * Options for processing.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options extends Table.Options {
  /** User-supplied (overriding) metadata: its URL and text. */
  readonly metadata?: { readonly url: string; readonly text: string } | undefined;
  /**
   * Look for metadata through the `Link` header, `/.well-known/csvm` and the
   * default locations (default `true`).
   */
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

const defaultTemplates: ReadonlyArray<string> = ['{+url}-metadata.json', 'csv-metadata.json'];

/** Each template expanded with the file's `url` and resolved against it. */
const expandLocations = (url: string, templates: ReadonlyArray<string>): ReadonlyArray<string> => {
  const base = Iri.withoutFragment(url);
  return Arr.map(templates, (template) =>
    Url.resolve(UriTemplate.expand(template, { url: base }), base),
  );
};

/**
 * The default metadata locations for a tabular data file
 * (`{+url}-metadata.json`, then `csv-metadata.json`), resolved against it.
 *
 * @since 0.1.0
 * @category locating
 */
export const defaultLocations = (url: string): ReadonlyArray<string> =>
  expandLocations(url, defaultTemplates);

const describedbyTypes: ReadonlyArray<string> = [
  'application/csvm+json',
  'application/ld+json',
  'application/json',
];

const isMetadataType = (type: string): boolean =>
  Arr.contains(describedbyTypes, type.replace(/;.*$/su, '').trim().toLowerCase());

/**
 * The metadata documents a `Link` header names for the file at `url`:
 * `rel="describedby"` links with no type or a metadata type, targets
 * resolved against the file.
 *
 * @since 0.3.0
 * @category locating
 */
export const linkedLocations = (url: string, header: string): ReadonlyArray<string> =>
  Arr.map(
    Arr.filter(
      LinkHeader.filterRel(LinkHeader.parse(header, Iri.withoutFragment(url)), 'describedby'),
      (link) => Option.match(link.type, { onNone: () => true, onSome: isMetadataType }),
    ),
    (link) => link.target,
  );

/** The templates a `/.well-known/csvm` file holds: one per non-blank line. */
const configuredTemplates = (text: string): ReadonlyArray<string> =>
  Arr.filter(
    Arr.map(text.split(/\r?\n/u), (line) => line.trim()),
    (line) => line !== '',
  );

/** The URL of the site-wide `csvm` configuration of the file's origin. */
const wellKnownUrl = (url: string): Result.Result<string, unknown> =>
  Result.map(
    Result.flatMap(
      Result.try(() => new URL(url)),
      (parsed) => WellKnown.url(parsed, 'csvm'),
    ),
    (wellKnown) => wellKnown.href,
  );

/**
 * The location templates in force for the site serving `url`: those of its
 * `/.well-known/csvm` file read through the `Loader`, else the defaults.
 */
const siteTemplates = (
  loader: Loader['Service'],
  url: string,
): Effect.Effect<ReadonlyArray<string>, LoadError> =>
  Result.match(wellKnownUrl(url), {
    onFailure: () => Effect.succeed(defaultTemplates),
    onSuccess: (wellKnown) =>
      Effect.map(loader.document(wellKnown), (text) =>
        Option.match(Option.map(text, configuredTemplates), {
          onNone: () => defaultTemplates,
          onSome: (templates) =>
            Arr.isReadonlyArrayNonEmpty(templates) ? templates : defaultTemplates,
        }),
      ),
  });

/** The candidate metadata locations in order: the `Link` header's, then the site's. */
const discover = (
  loader: Loader['Service'],
  url: string,
): Effect.Effect<ReadonlyArray<string>, LoadError> =>
  Effect.zipWith(loader.linkHeader(url), siteTemplates(loader, url), (header, templates) =>
    Arr.dedupe([
      ...Option.match(header, { onNone: () => [], onSome: (h) => linkedLocations(url, h) }),
      ...expandLocations(url, templates),
    ]),
  );

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

const locateFirst = (
  loader: Loader['Service'],
  fetch: Metadata.Fetch,
  url: string,
  candidates: ReadonlyArray<string>,
): Effect.Effect<Located, Metadata.MetadataError | LoadError> =>
  Effect.reduce(
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

/**
 * Processes starting from a tabular data file: uses the user's metadata if
 * given, else the first metadata document that describes the file, found
 * through the file's `Link` header, then the site's `/.well-known/csvm`
 * locations (or the defaults `{+url}-metadata.json` and `csv-metadata.json`
 * when the site has none), else the file's embedded metadata. A document
 * that does not describe the file is ignored with a warning.
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
  const candidates = options.locate === false ? [] : yield* discover(loader, url);
  const located = yield* locateFirst(loader, fetch, url, candidates);
  return yield* Option.match(located.found, {
    onNone: () => processGroup(embeddedOnly(url), located.warnings, options),
    onSome: (decoded) =>
      processGroup(decoded.group, [...located.warnings, ...decoded.warnings], options),
  });
});
