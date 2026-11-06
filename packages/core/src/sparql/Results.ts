/**
 * SPARQL query results: the result models returned by the engine and the
 * standard results formats — JSON (`application/sparql-results+json`), XML
 * (`application/sparql-results+xml`), CSV and TSV — with streaming
 * serialisers and parsers, including SPARQL 1.2 triple terms and directional
 * language-tagged strings.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import type * as ParseError from '@thomasfosterau/effect-parse/ParseError';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Serialization from '../Serialization.ts';
import * as Term from '../Term.ts';
import * as TermJson from '../TermJson.ts';
import * as XmlParser from '../rdfxml/Xml.ts';
import * as B from './Bindings.ts';
import * as JsonText from './internal/json.ts';
import * as TextResults from './internal/textResults.ts';

type Bindings = B.Bindings;

// -----------------------------------------------------------------------------
// Models
// -----------------------------------------------------------------------------

/**
 * The result of a `SELECT` query: the projected variables and a (lazy)
 * stream of solutions.
 *
 * @since 0.1.0
 * @category models
 */
export interface SelectResult<E = never> {
  readonly _tag: 'Select';
  readonly variables: ReadonlyArray<Term.Variable>;
  readonly bindings: Stream.Stream<Bindings, E>;
}

/**
 * The result of an `ASK` query.
 *
 * @since 0.1.0
 * @category models
 */
export interface AskResult {
  readonly _tag: 'Ask';
  readonly value: boolean;
}

/**
 * The result of a `CONSTRUCT` or `DESCRIBE` query: a (lazy, duplicate-free)
 * stream of triples (as quads in the default graph).
 *
 * @since 0.1.0
 * @category models
 */
export interface GraphResult<E = never> {
  readonly _tag: 'Graph';
  readonly quads: Stream.Stream<Term.Quad, E>;
}

/**
 * Any query result.
 *
 * @since 0.1.0
 * @category models
 */
export type QueryResult<E = never> = SelectResult<E> | AskResult | GraphResult<E>;

/**
 * A fully materialised solution sequence (e.g. a parsed results document).
 *
 * @since 0.1.0
 * @category models
 */
export interface ResultSet {
  readonly _tag: 'ResultSet';
  readonly variables: ReadonlyArray<string>;
  readonly bindings: ReadonlyArray<Bindings>;
}

/**
 * A boolean (`ASK`) result document.
 *
 * @since 0.1.0
 * @category models
 */
export interface BooleanResult {
  readonly _tag: 'Boolean';
  readonly value: boolean;
}

/**
 * A parsed results document.
 *
 * @since 0.1.0
 * @category models
 */
export type ParsedResult = ResultSet | BooleanResult;

/**
 * Materialises a `SELECT` result.
 *
 * @since 0.1.0
 * @category conversions
 */
export const collect = <E>(result: SelectResult<E>): Effect.Effect<ResultSet, E> =>
  Effect.map(Stream.runCollect(result.bindings), (bindings) => ({
    _tag: 'ResultSet' as const,
    variables: result.variables.map((v) => v.value),
    bindings,
  }));

/**
 * Turns a materialised result set back into a streaming `SelectResult`.
 *
 * @since 0.1.0
 * @category conversions
 */
export const fromResultSet = (set: ResultSet): SelectResult => ({
  _tag: 'Select',
  variables: set.variables.map((v) => Term.variable(v)),
  bindings: Stream.fromIterable(set.bindings),
});

// -----------------------------------------------------------------------------
// Errors and formats
// -----------------------------------------------------------------------------

/**
 * An error parsing a results document. The text formats (TSV and CSV)
 * report the 1-based `line` and `column` of the error.
 *
 * @since 0.1.0
 * @category errors
 */
export class ResultsParseError extends Schema.TaggedError<ResultsParseError>()(
  'ResultsParseError',
  {
    format: Schema.String,
    message: Schema.String,
    line: Schema.optional(Schema.Number),
    column: Schema.optional(Schema.Number),
  },
) {}

/** The last line of a rendered `ParseError`: what was expected and found. */
const parseErrorSummary = (error: ParseError.ParseError): string =>
  error.message.slice(error.message.lastIndexOf('\n') + 1);

/**
 * Metadata of a results format.
 *
 * @since 0.1.0
 * @category models
 */
export interface ResultsFormat {
  readonly name: string;
  readonly mediaType: string;
  readonly mediaTypes: ReadonlyArray<string>;
  readonly extensions: ReadonlyArray<string>;
  /** Whether the format can represent boolean (`ASK`) results. */
  readonly booleans: boolean;
}

/**
 * A results format: streaming serialiser and parser.
 *
 * @since 0.1.0
 * @category models
 */
export interface ResultsCodec {
  readonly format: ResultsFormat;
  /** Serialises a (streaming) select or ask result to text chunks. */
  readonly serialize: <E>(result: SelectResult<E> | AskResult) => Stream.Stream<string, E>;
  /** Serialises a materialised result to a string. */
  readonly serializeString: (result: ParsedResult | AskResult) => string;
  /** Parses a complete document. */
  readonly parse: (input: string) => Effect.Effect<ParsedResult, ResultsParseError>;
}

const toSelect = (result: ParsedResult | AskResult): SelectResult | AskResult =>
  Predicate.isTagged(result, 'ResultSet')
    ? fromResultSet(result)
    : Predicate.isTagged(result, 'Boolean')
      ? { _tag: 'Ask', value: result.value }
      : result;

// The chunks come from an in-memory serializer that does not fail, so `runSync` returns.
const stringify = <E>(chunks: Stream.Stream<string, E>): string =>
  Effect.runSync(Stream.mkString(chunks));

const ordered = <E>(
  result: SelectResult<E>,
  row: (b: Bindings, index: number) => string,
): Stream.Stream<string, E> => Stream.map(result.bindings, (b, i) => row(b, i));

// -----------------------------------------------------------------------------
// JSON
// -----------------------------------------------------------------------------

/**
 * The JSON encoding of an RDF term in SPARQL results (re-exported from core's
 * `TermJson.GroundTerm`).
 *
 * @since 0.1.0
 * @category json
 */
export type JsonTerm = TermJson.GroundTerm;

/**
 * Schema of an RDF term in SPARQL JSON results (SPARQL 1.2, including
 * triple terms; core's `TermJson.GroundTermSchema`).
 *
 * @since 0.1.0
 * @category json
 */
export const JsonTermSchema: Schema.Codec<JsonTerm> = TermJson.GroundTermSchema;

/**
 * The type `JsonTermSchema` decodes to (the same as `JsonTerm`).
 *
 * @since 0.1.0
 * @category json
 */
export type JsonTermSchema = typeof JsonTermSchema.Type;

/**
 * Schema of a SPARQL JSON results document.
 *
 * @since 0.1.0
 * @category json
 */
export const JsonResultsSchema = Schema.Struct({
  head: Schema.Struct({
    vars: Schema.optional(Schema.Array(Schema.String)),
    link: Schema.optional(Schema.Array(Schema.String)),
  }),
  results: Schema.optional(
    Schema.Struct({
      bindings: Schema.Array(Schema.Record(Schema.String, JsonTermSchema)),
    }),
  ),
  boolean: Schema.optional(Schema.Boolean),
});

/**
 * @since 0.1.0
 * @category json
 */
export type JsonResults = typeof JsonResultsSchema.Type;

/**
 * The type `JsonResultsSchema` decodes to (the same as `JsonResults`).
 *
 * @since 0.1.0
 * @category json
 */
export type JsonResultsSchema = typeof JsonResultsSchema.Type;

/**
 * Encodes a term as SPARQL JSON (core's `Term.toJson`).
 *
 * @since 0.1.0
 * @category json
 */
export const termToJson = (t: Term.GroundTerm): JsonTerm => Term.toJson(t);

/**
 * Decodes a SPARQL JSON term (core's `Term.fromJson`); the positions of a
 * triple term are trusted.
 *
 * @since 0.1.0
 * @category json
 */
export const termFromJson = (j: JsonTerm): Term.GroundTerm => Term.fromJson(j);

const decodeJsonResults = Schema.decodeUnknownResult(JsonResultsSchema);

// Any JSON value as its text (exactly `JSON.stringify`).
const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const jsonFormat: ResultsFormat = {
  name: 'SPARQL Results JSON',
  mediaType: 'application/sparql-results+json',
  mediaTypes: ['application/sparql-results+json', 'application/json'],
  extensions: ['srj', 'json'],
  booleans: true,
};

const serializeJson = <E>(result: SelectResult<E> | AskResult): Stream.Stream<string, E> => {
  if (Predicate.isTagged(result, 'Ask')) {
    return Stream.succeed(`{"head":{},"boolean":${result.value}}\n`);
  }
  const vars = result.variables.map((v) => v.value);
  const head = `{"head":{"vars":${encodeJsonText(vars)}},"results":{"bindings":[`;
  return Stream.concat(
    Stream.concat(
      Stream.succeed(head),
      ordered(result, (b, i) => {
        const row: Record<string, JsonTerm> = {};
        vars.forEach((v) => {
          const t = b.map.get(v);
          if (t !== undefined) row[v] = termToJson(t);
        });
        // Variables bound but not projected are not serialised.
        return `${i > 0 ? ',' : ''}\n${encodeJsonText(row)}`;
      }),
    ),
    Stream.succeed('\n]}}\n'),
  );
};

const parseJson = (input: string): Effect.Effect<ParsedResult, ResultsParseError> =>
  Effect.suspend((): Effect.Effect<ParsedResult, ResultsParseError> => {
    const err = (message: string) =>
      Effect.fail(new ResultsParseError({ format: 'json', message }));
    const raw = JsonText.parse(input);
    if (Result.isFailure(raw)) return err(`Invalid JSON: ${raw.failure}`);
    const decoded = decodeJsonResults(raw.success);
    if (Result.isFailure(decoded)) return err(decoded.failure.message);
    const doc = decoded.success;
    if (doc.boolean !== undefined)
      return Effect.succeed({ _tag: 'Boolean', value: doc.boolean } as const);
    if (doc.results === undefined) return err('Missing results');
    return Effect.succeed({
      _tag: 'ResultSet',
      variables: doc.head.vars ?? [],
      bindings: doc.results.bindings.map((row) =>
        B.fromEntries(Record.toEntries(row).map(([k, v]) => [k, termFromJson(v)] as const)),
      ),
    } as const);
  });

/**
 * SPARQL 1.1 Query Results JSON Format.
 *
 * @since 0.1.0
 * @category formats
 */
export const Json: ResultsCodec = {
  format: jsonFormat,
  serialize: serializeJson,
  serializeString: (r) => stringify(serializeJson(toSelect(r))),
  parse: parseJson,
};

// -----------------------------------------------------------------------------
// XML
// -----------------------------------------------------------------------------

const SRX = 'http://www.w3.org/2005/sparql-results#';
const ITS = 'http://www.w3.org/2005/11/its';

const xmlLiteral = (l: Term.Literal): string => {
  const attrs =
    l.language !== ''
      ? ` xml:lang="${XmlParser.escapeAttribute(l.language)}"${l.direction !== undefined ? ` its:dir="${l.direction}"` : ''}`
      : l.datatype.value !== Term.XSD_STRING
        ? ` datatype="${XmlParser.escapeAttribute(l.datatype.value)}"`
        : '';
  return `<literal${attrs}>${XmlParser.escapeText(l.value)}</literal>`;
};

/** A term as an XML results element. Plain branches: it runs for every term of every row. */
const xmlTerm = (t: Term.GroundTerm): string => {
  if (Term.isLiteral(t)) return xmlLiteral(t);
  if (Term.isNamedNode(t)) return `<uri>${XmlParser.escapeText(t.value)}</uri>`;
  if (Term.isBlankNode(t)) return `<bnode>${XmlParser.escapeText(t.value)}</bnode>`;
  return `<triple><subject>${xmlTerm(t.subject)}</subject><predicate>${xmlTerm(t.predicate)}</predicate><object>${xmlTerm(t.object)}</object></triple>`;
};

const serializeXml = <E>(result: SelectResult<E> | AskResult): Stream.Stream<string, E> => {
  const open = `<?xml version="1.0"?>\n<sparql xmlns="${SRX}" xmlns:its="${ITS}">\n`;
  if (Predicate.isTagged(result, 'Ask')) {
    return Stream.succeed(`${open}<head/>\n<boolean>${result.value}</boolean>\n</sparql>\n`);
  }
  const vars = result.variables.map((v) => v.value);
  const head = `${open}<head>${vars.map((v) => `<variable name="${XmlParser.escapeAttribute(v)}"/>`).join('')}</head>\n<results>\n`;
  return Stream.concat(
    Stream.concat(
      Stream.succeed(head),
      ordered(result, (b) => {
        const cells = vars.map((v) => {
          const t = b.map.get(v);
          return t === undefined
            ? ''
            : `<binding name="${XmlParser.escapeAttribute(v)}">${xmlTerm(t)}</binding>`;
        });
        return `<result>${cells.join('')}</result>\n`;
      }),
    ),
    Stream.succeed('</results>\n</sparql>\n'),
  );
};

const elements = (e: XmlParser.Element): Array<XmlParser.Element> =>
  e.children.filter((c): c is XmlParser.Element => Predicate.isTagged(c, 'Element'));

const textOf = (e: XmlParser.Element): string =>
  e.children.map((c) => (Predicate.isTagged(c, 'Text') ? c.value : '')).join('');

/** An attribute's value, by local name (and namespace, when given). */
const attribute = (e: XmlParser.Element, local: string, ns?: string): Option.Option<string> =>
  Option.map(
    Arr.findFirst(
      e.attributes,
      (a) => a.localName === local && (ns === undefined || a.namespace === ns),
    ),
    (a) => a.value,
  );

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

const xmlTriplePart = (e: XmlParser.Element, name: string): Term.GroundTerm => {
  const p = elements(e).find((c) => c.localName === name);
  const inner = p === undefined ? undefined : elements(p)[0];
  if (inner === undefined) {
    throw new ResultsParseError({ format: 'xml', message: `Missing ${name} in triple term` });
  }
  return xmlToTerm(inner);
};

const xmlToTerm = (e: XmlParser.Element): Term.GroundTerm => {
  return Match.value(e.localName).pipe(
    Match.when('uri', (): Term.GroundTerm => Term.namedNode(textOf(e))),
    Match.when('bnode', () => Term.blankNode(textOf(e))),
    Match.when('literal', () => {
      const lang = Option.getOrElse(attribute(e, 'lang', XML_NS), () => '');
      const dir = Option.orElse(attribute(e, 'dir', ITS), () => attribute(e, 'dir'));
      const datatype = attribute(e, 'datatype');
      if (lang !== '') {
        return Option.isSome(dir) && (dir.value === 'ltr' || dir.value === 'rtl')
          ? Term.literal(textOf(e), { language: lang, direction: dir.value })
          : Term.literal(textOf(e), lang);
      }
      return Option.isSome(datatype)
        ? Term.literal(textOf(e), Term.namedNode(datatype.value))
        : Term.literal(textOf(e));
    }),
    // The XML results grammar puts a subject, an IRI predicate and an object in a triple
    // term's three parts; like the other formats, the parts are not checked again.
    Match.when('triple', () =>
      Term.triple<any, any, any>(
        xmlTriplePart(e, 'subject'),
        xmlTriplePart(e, 'predicate'),
        xmlTriplePart(e, 'object'),
      ),
    ),
    Match.orElse((name) => {
      throw new ResultsParseError({
        format: 'xml',
        message: `Unexpected element <${name}>`,
      });
    }),
  );
};

const parseXml = (input: string): Effect.Effect<ParsedResult, ResultsParseError> =>
  Effect.suspend((): Effect.Effect<ParsedResult, ResultsParseError> => {
    const doc = XmlParser.parseResult(input);
    if (Result.isFailure(doc)) {
      return Effect.fail(new ResultsParseError({ format: 'xml', message: doc.failure.message }));
    }
    return Effect.try({
      try: (): ParsedResult => {
        const root = doc.success.root;
        const head = elements(root).find((c) => c.localName === 'head');
        const vars =
          head === undefined
            ? []
            : elements(head)
                .filter((c) => c.localName === 'variable')
                .map((c) => Option.getOrElse(attribute(c, 'name'), () => ''));
        const boolean = elements(root).find((c) => c.localName === 'boolean');
        if (boolean !== undefined) {
          return { _tag: 'Boolean', value: textOf(boolean).trim() === 'true' } as const;
        }
        const results = elements(root).find((c) => c.localName === 'results');
        const bindings = (results === undefined ? [] : elements(results)).map((r) =>
          B.fromEntries(
            elements(r)
              .filter((c) => c.localName === 'binding')
              .map(
                (c) =>
                  [
                    Option.getOrElse(attribute(c, 'name'), () => ''),
                    xmlToTerm(
                      Option.getOrThrowWith(
                        Arr.head(elements(c)),
                        () =>
                          new ResultsParseError({
                            format: 'xml',
                            message: 'Missing term in binding',
                          }),
                      ),
                    ),
                  ] as const,
              ),
          ),
        );
        return { _tag: 'ResultSet', variables: vars, bindings } as const;
      },
      catch: (cause) =>
        new ResultsParseError({
          format: 'xml',
          message: Predicate.isError(cause) ? cause.message : String(cause),
        }),
    });
  });

/**
 * SPARQL Query Results XML Format.
 *
 * @since 0.1.0
 * @category formats
 */
export const Xml: ResultsCodec = {
  format: {
    name: 'SPARQL Results XML',
    mediaType: 'application/sparql-results+xml',
    mediaTypes: ['application/sparql-results+xml', 'application/xml', 'text/xml'],
    extensions: ['srx', 'xml'],
    booleans: true,
  },
  serialize: serializeXml,
  serializeString: (r) => stringify(serializeXml(toSelect(r))),
  parse: parseXml,
};

// -----------------------------------------------------------------------------
// TSV
// -----------------------------------------------------------------------------

const XSD = 'http://www.w3.org/2001/XMLSchema#';

/**
 * Formats a term in the Turtle / SPARQL syntax used by TSV results.
 *
 * @since 0.1.0
 * @category tsv
 */
export const termToTsv = (t: Term.GroundTerm): string => {
  if (Term.isLiteral(t) && t.language === '') {
    const dt = t.datatype.value;
    if (dt === `${XSD}integer` && /^[+-]?\d+$/.test(t.value)) return t.value;
    if (dt === `${XSD}decimal` && /^[+-]?\d*\.\d+$/.test(t.value)) return t.value;
    if (dt === `${XSD}double` && /^[+-]?(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(t.value))
      return t.value;
    if (dt === `${XSD}boolean` && (t.value === 'true' || t.value === 'false')) return t.value;
  }
  if (Term.isTriple(t)) {
    return `<<( ${termToTsv(t.subject)} ${termToTsv(t.predicate)} ${termToTsv(t.object)} )>>`;
  }
  return t.key.replace(/\t/g, '\\t');
};

/**
 * Parses a term written in the Turtle / SPARQL syntax used by TSV results
 * (IRIs in `<>`, blank nodes, quoted literals, numbers, booleans, triple
 * terms).
 *
 * @since 0.1.0
 * @category tsv
 */
export const parseTerm = (text: string): Option.Option<Term.GroundTerm> =>
  Result.getSuccess(Parser.parse(TextResults.groundTerm, text));

/** The layout of a delimited (TSV / CSV) results document. */
interface Delimited {
  readonly separator: string;
  readonly newline: string;
  readonly header: (variable: string) => string;
  readonly cell: (t: Term.GroundTerm) => string;
}

const serializeDelimited =
  (layout: Delimited) =>
  <E>(result: SelectResult<E> | AskResult): Stream.Stream<string, E> => {
    if (Predicate.isTagged(result, 'Ask'))
      return Stream.succeed(`${result.value}${layout.newline}`);
    const vars = result.variables.map((v) => v.value);
    return Stream.concat(
      Stream.succeed(`${vars.map(layout.header).join(layout.separator)}${layout.newline}`),
      ordered(result, (b) => {
        const cells = vars.map((v) => {
          const t = b.map.get(v);
          return t === undefined ? '' : layout.cell(t);
        });
        return `${cells.join(layout.separator)}${layout.newline}`;
      }),
    );
  };

const serializeTsv = serializeDelimited({
  separator: '\t',
  newline: '\n',
  header: (v) => `?${v}`,
  cell: termToTsv,
});

const splitLines = (input: string): Array<string> => {
  const lines = input.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const parseTsv = (input: string): Effect.Effect<ParsedResult, ResultsParseError> =>
  Effect.suspend((): Effect.Effect<ParsedResult, ResultsParseError> => {
    const [header, ...rows] = splitLines(input);
    if (header === undefined) {
      return Effect.fail(new ResultsParseError({ format: 'tsv', message: 'Empty document' }));
    }
    const first = header.trim();
    if (first === 'true' || first === 'false') {
      return Effect.succeed({ _tag: 'Boolean', value: first === 'true' } as const);
    }
    const vars = header.split('\t').map((v) => v.trim().replace(/^[?$]/, ''));
    const bindings: Array<Bindings> = [];
    // The first invalid cell, if any (the rows before it are parsed on the way).
    const failure = Arr.findFirst(rows, (line, index) =>
      Result.match(tsvRow(vars, line, index + 2), {
        onFailure: Option.some,
        onSuccess: (b) => {
          bindings.push(b);
          return Option.none();
        },
      }),
    );
    return Option.isSome(failure)
      ? Effect.fail(failure.value)
      : Effect.succeed({ _tag: 'ResultSet', variables: vars, bindings } as const);
  });

/** A TSV row (on 1-based line `line`) as a solution, or the error at its first invalid cell. */
const tsvRow = (
  vars: ReadonlyArray<string>,
  line: string,
  lineNumber: number,
): Result.Result<Bindings, ResultsParseError> => {
  const cells = line.split('\t');
  const entries: Array<readonly [string, Term.GroundTerm]> = [];
  let offset = 0;
  const failure = Arr.findFirst(vars, (v, i) => {
    const cell = cells[i] ?? '';
    const start = offset;
    offset += cell.length + 1;
    if (cell.trim() === '') return Option.none();
    const t = Parser.parse(TextResults.groundTerm, cell);
    if (Result.isFailure(t)) {
      return Option.some(
        new ResultsParseError({
          format: 'tsv',
          message: `Invalid term: ${cell.trim()}: ${parseErrorSummary(t.failure)}`,
          line: lineNumber,
          column: start + t.failure.position.column,
        }),
      );
    }
    entries.push([v, t.success]);
    return Option.none();
  });
  return Option.isSome(failure)
    ? Result.fail(failure.value)
    : Result.succeed(B.fromEntries(entries));
};

/**
 * SPARQL 1.1 Query Results TSV Format.
 *
 * @since 0.1.0
 * @category formats
 */
export const Tsv: ResultsCodec = {
  format: {
    name: 'SPARQL Results TSV',
    mediaType: 'text/tab-separated-values',
    mediaTypes: ['text/tab-separated-values'],
    extensions: ['tsv'],
    booleans: true,
  },
  serialize: serializeTsv,
  serializeString: (r) => stringify(serializeTsv(toSelect(r))),
  parse: parseTsv,
};

// -----------------------------------------------------------------------------
// CSV
// -----------------------------------------------------------------------------

const csvField = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** A term as a CSV cell. Plain branches: it runs for every term of every row. */
const csvTerm = (t: Term.GroundTerm): string => {
  if (Term.isNamedNode(t) || Term.isLiteral(t)) return t.value;
  if (Term.isBlankNode(t)) return `_:${t.value}`;
  return `<<( ${termToTsv(t.subject)} ${termToTsv(t.predicate)} ${termToTsv(t.object)} )>>`;
};

const serializeCsv = serializeDelimited({
  separator: ',',
  newline: '\r\n',
  header: csvField,
  cell: (t) => csvField(csvTerm(t)),
});

/**
 * Interprets a CSV cell. The CSV format is lossy: blank nodes are recognised
 * by `_:`, absolute IRIs (with a scheme) become IRIs, numbers and booleans
 * become typed literals and everything else a plain string.
 */
const csvCell = (cell: string): Term.GroundTerm => {
  if (cell.startsWith('_:')) return Term.blankNode(cell.slice(2));
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]*$/.test(cell) && !/^\d/.test(cell)) {
    return Term.namedNode(cell);
  }
  if (/^[+-]?\d+$/.test(cell)) return Term.literal(cell, Term.namedNode(`${XSD}integer`));
  if (/^[+-]?\d*\.\d+$/.test(cell)) return Term.literal(cell, Term.namedNode(`${XSD}decimal`));
  if (/^[+-]?(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(cell)) {
    return Term.literal(cell, Term.namedNode(`${XSD}double`));
  }
  return Term.literal(cell);
};

const parseCsv = (input: string): Effect.Effect<ParsedResult, ResultsParseError> =>
  Effect.suspend((): Effect.Effect<ParsedResult, ResultsParseError> => {
    const parsed = Parser.parse(TextResults.csvRows, input);
    if (Result.isFailure(parsed)) {
      const { line, column } = parsed.failure.position;
      return Effect.fail(
        new ResultsParseError({
          format: 'csv',
          message: parseErrorSummary(parsed.failure),
          line,
          column,
        }),
      );
    }
    const [first, ...rows] = parsed.success;
    if (first === undefined) {
      return Effect.fail(new ResultsParseError({ format: 'csv', message: 'Empty document' }));
    }
    const [only, ...others] = first;
    if (
      only !== undefined &&
      Arr.isReadonlyArrayEmpty(others) &&
      (only.value === 'true' || only.value === 'false')
    ) {
      return Effect.succeed({ _tag: 'Boolean', value: only.value === 'true' } as const);
    }
    const vars = first.map((c) => c.value);
    const bindings = rows.map((r) =>
      B.fromEntries(
        vars.map((v, i) => {
          const cell = r[i];
          return [
            v,
            cell === undefined || (cell.value === '' && !cell.quoted)
              ? undefined
              : csvCell(cell.value),
          ] as const;
        }),
      ),
    );
    return Effect.succeed({ _tag: 'ResultSet', variables: vars, bindings } as const);
  });

/**
 * SPARQL 1.1 Query Results CSV Format (lossy: parsing recovers IRIs, blank
 * nodes, numbers and strings heuristically).
 *
 * @since 0.1.0
 * @category formats
 */
export const Csv: ResultsCodec = {
  format: {
    name: 'SPARQL Results CSV',
    mediaType: 'text/csv',
    mediaTypes: ['text/csv'],
    extensions: ['csv'],
    booleans: true,
  },
  serialize: serializeCsv,
  serializeString: (r) => stringify(serializeCsv(toSelect(r))),
  parse: parseCsv,
};

// -----------------------------------------------------------------------------
// Registry and negotiation
// -----------------------------------------------------------------------------

/**
 * All results formats, in order of preference.
 *
 * @since 0.1.0
 * @category formats
 */
export const codecs: ReadonlyArray<ResultsCodec> = [Json, Xml, Csv, Tsv];

/**
 * Finds a results codec for a media type (parameters are ignored).
 *
 * @since 0.1.0
 * @category formats
 */
export const codecFor = (mediaType: string): Option.Option<ResultsCodec> => {
  const mt = (mediaType.split(';')[0] ?? '').trim().toLowerCase();
  return Option.fromNullishOr(codecs.find((c) => c.format.mediaTypes.includes(mt)));
};

/**
 * Finds a results codec for a file extension.
 *
 * @since 0.1.0
 * @category formats
 */
export const codecForExtension = (extension: string): Option.Option<ResultsCodec> => {
  const ext = extension.replace(/^\./, '').toLowerCase();
  return Option.fromNullishOr(codecs.find((c) => c.format.extensions.includes(ext)));
};

/**
 * Chooses the best results codec for an HTTP `Accept` header.
 *
 * @since 0.1.0
 * @category formats
 */
export const negotiate = (accept: string | undefined): Option.Option<ResultsCodec> =>
  Option.flatMap(
    Serialization.negotiate(
      accept,
      codecs.flatMap((c) => c.format.mediaTypes),
    ),
    codecFor,
  );
