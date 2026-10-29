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
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import type * as ParseError from '@thomasfosterau/effect-parse/ParseError';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as XmlParser from '@thomasfosterau/effect-rdfxml/Xml';
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
  result._tag === 'ResultSet'
    ? fromResultSet(result)
    : result._tag === 'Boolean'
      ? { _tag: 'Ask', value: result.value }
      : result;

// SAFETY: the chunks come from an in-memory serializer that does not fail; the error type is only
// erased for `runSync`.
const stringify = <E>(chunks: Stream.Stream<string, E>): string =>
  Effect.runSync(Stream.mkString(chunks as Stream.Stream<string>));

const ordered = <E>(
  result: SelectResult<E>,
  row: (b: Bindings, index: number) => string,
): Stream.Stream<string, E> => Stream.map(result.bindings, (b, i) => row(b, i));

// -----------------------------------------------------------------------------
// JSON
// -----------------------------------------------------------------------------

/**
 * The JSON encoding of an RDF term in SPARQL results.
 *
 * @since 0.1.0
 * @category json
 */
export type JsonTerm =
  | { readonly type: 'uri'; readonly value: string }
  | { readonly type: 'bnode'; readonly value: string }
  | {
      readonly type: 'literal' | 'typed-literal';
      readonly value: string;
      readonly 'xml:lang'?: string | undefined;
      readonly 'its:dir'?: string | undefined;
      readonly datatype?: string | undefined;
    }
  | {
      readonly type: 'triple';
      readonly value: {
        readonly subject: JsonTerm;
        readonly predicate: JsonTerm;
        readonly object: JsonTerm;
      };
    };

/**
 * Schema of an RDF term in SPARQL JSON results (SPARQL 1.2, including
 * triple terms).
 *
 * @since 0.1.0
 * @category json
 */
export const JsonTermSchema: Schema.Codec<JsonTerm> = Schema.Union([
  Schema.Struct({ type: Schema.Literal('uri'), value: Schema.String }),
  Schema.Struct({ type: Schema.Literal('bnode'), value: Schema.String }),
  Schema.Struct({
    type: Schema.Literals(['literal', 'typed-literal']),
    value: Schema.String,
    'xml:lang': Schema.optional(Schema.String),
    'its:dir': Schema.optional(Schema.String),
    datatype: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal('triple'),
    value: Schema.Struct({
      subject: Schema.suspend((): Schema.Codec<JsonTerm> => JsonTermSchema),
      predicate: Schema.suspend((): Schema.Codec<JsonTerm> => JsonTermSchema),
      object: Schema.suspend((): Schema.Codec<JsonTerm> => JsonTermSchema),
    }),
  }),
]);

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
 * Encodes a term as SPARQL JSON.
 *
 * @since 0.1.0
 * @category json
 */
export const termToJson = (t: Term.GroundTerm): JsonTerm => {
  switch (t._tag) {
    case 'NamedNode':
      return { type: 'uri', value: t.value };
    case 'BlankNode':
      return { type: 'bnode', value: t.value };
    case 'Literal':
      if (t.language !== '') {
        return t.direction !== undefined
          ? { type: 'literal', value: t.value, 'xml:lang': t.language, 'its:dir': t.direction }
          : { type: 'literal', value: t.value, 'xml:lang': t.language };
      }
      return t.datatype.value === Term.XSD_STRING
        ? { type: 'literal', value: t.value }
        : { type: 'literal', value: t.value, datatype: t.datatype.value };
    case 'Triple':
      return {
        type: 'triple',
        value: {
          subject: termToJson(t.subject),
          predicate: termToJson(t.predicate),
          object: termToJson(t.object),
        },
      };
  }
};

/**
 * Decodes a SPARQL JSON term.
 *
 * @since 0.1.0
 * @category json
 */
export const termFromJson = (j: JsonTerm): Term.GroundTerm => {
  switch (j.type) {
    case 'uri':
      return Term.namedNode(j.value);
    case 'bnode':
      return Term.blankNode(j.value);
    case 'literal':
    case 'typed-literal': {
      const lang = j['xml:lang'];
      if (lang !== undefined && lang !== '') {
        const dir = j['its:dir'];
        return dir === 'ltr' || dir === 'rtl'
          ? Term.literal(j.value, { language: lang, direction: dir })
          : Term.literal(j.value, lang);
      }
      return j.datatype !== undefined
        ? Term.literal(j.value, Term.namedNode(j.datatype))
        : Term.literal(j.value);
    }
    case 'triple':
      // SAFETY: the JSON results grammar puts a subject, an IRI predicate and an object in a triple
      // term's three fields.
      return Term.triple(
        termFromJson(j.value.subject) as Term.Subject,
        termFromJson(j.value.predicate) as Term.Predicate,
        termFromJson(j.value.object) as Term.Object,
      );
  }
};

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
  if (result._tag === 'Ask') {
    return Stream.succeed(`{"head":{},"boolean":${result.value}}\n`);
  }
  const vars = result.variables.map((v) => v.value);
  const head = `{"head":{"vars":${encodeJsonText(vars)}},"results":{"bindings":[`;
  return Stream.concat(
    Stream.concat(
      Stream.succeed(head),
      ordered(result, (b, i) => {
        const row: Record<string, JsonTerm> = {};
        for (const v of vars) {
          const t = b.map.get(v);
          if (t !== undefined) row[v] = termToJson(t);
        }
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
        B.fromEntries(Object.entries(row).map(([k, v]) => [k, termFromJson(v)] as const)),
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

const xmlTerm = (t: Term.GroundTerm): string => {
  switch (t._tag) {
    case 'NamedNode':
      return `<uri>${XmlParser.escapeText(t.value)}</uri>`;
    case 'BlankNode':
      return `<bnode>${XmlParser.escapeText(t.value)}</bnode>`;
    case 'Literal': {
      let attrs = '';
      if (t.language !== '') {
        attrs += ` xml:lang="${XmlParser.escapeAttribute(t.language)}"`;
        if (t.direction !== undefined) attrs += ` its:dir="${t.direction}"`;
      } else if (t.datatype.value !== Term.XSD_STRING) {
        attrs += ` datatype="${XmlParser.escapeAttribute(t.datatype.value)}"`;
      }
      return `<literal${attrs}>${XmlParser.escapeText(t.value)}</literal>`;
    }
    case 'Triple':
      return `<triple><subject>${xmlTerm(t.subject)}</subject><predicate>${xmlTerm(t.predicate)}</predicate><object>${xmlTerm(t.object)}</object></triple>`;
  }
};

const serializeXml = <E>(result: SelectResult<E> | AskResult): Stream.Stream<string, E> => {
  const open = `<?xml version="1.0"?>\n<sparql xmlns="${SRX}" xmlns:its="${ITS}">\n`;
  if (result._tag === 'Ask') {
    return Stream.succeed(`${open}<head/>\n<boolean>${result.value}</boolean>\n</sparql>\n`);
  }
  const vars = result.variables.map((v) => v.value);
  const head = `${open}<head>${vars.map((v) => `<variable name="${XmlParser.escapeAttribute(v)}"/>`).join('')}</head>\n<results>\n`;
  return Stream.concat(
    Stream.concat(
      Stream.succeed(head),
      ordered(result, (b) => {
        let out = '<result>';
        for (const v of vars) {
          const t = b.map.get(v);
          if (t !== undefined)
            out += `<binding name="${XmlParser.escapeAttribute(v)}">${xmlTerm(t)}</binding>`;
        }
        return `${out}</result>\n`;
      }),
    ),
    Stream.succeed('</results>\n</sparql>\n'),
  );
};

const elements = (e: XmlParser.Element): Array<XmlParser.Element> =>
  e.children.filter((c): c is XmlParser.Element => c._tag === 'Element');

const textOf = (e: XmlParser.Element): string =>
  e.children.map((c) => (c._tag === 'Text' ? c.value : '')).join('');

const attribute = (e: XmlParser.Element, local: string, ns?: string): string | undefined =>
  e.attributes.find((a) => a.localName === local && (ns === undefined || a.namespace === ns))
    ?.value;

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

const xmlToTerm = (e: XmlParser.Element): Term.GroundTerm => {
  switch (e.localName) {
    case 'uri':
      return Term.namedNode(textOf(e));
    case 'bnode':
      return Term.blankNode(textOf(e));
    case 'literal': {
      const lang = attribute(e, 'lang', XML_NS);
      const dir = attribute(e, 'dir', ITS) ?? attribute(e, 'dir');
      const datatype = attribute(e, 'datatype');
      if (lang !== undefined && lang !== '') {
        return dir === 'ltr' || dir === 'rtl'
          ? Term.literal(textOf(e), { language: lang, direction: dir })
          : Term.literal(textOf(e), lang);
      }
      return datatype !== undefined
        ? Term.literal(textOf(e), Term.namedNode(datatype))
        : Term.literal(textOf(e));
    }
    case 'triple': {
      const part = (name: string) => {
        const p = elements(e).find((c) => c.localName === name);
        const inner = p === undefined ? undefined : elements(p)[0];
        if (inner === undefined) {
          throw new ResultsParseError({ format: 'xml', message: `Missing ${name} in triple term` });
        }
        return xmlToTerm(inner);
      };
      // SAFETY: the XML results grammar puts a subject, an IRI predicate and an object in a triple
      // term's three parts.
      return Term.triple(
        part('subject') as Term.Subject,
        part('predicate') as Term.Predicate,
        part('object') as Term.Object,
      );
    }
    default:
      throw new ResultsParseError({
        format: 'xml',
        message: `Unexpected element <${e.localName}>`,
      });
  }
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
                .map((c) => attribute(c, 'name') ?? '');
        const boolean = elements(root).find((c) => c.localName === 'boolean');
        if (boolean !== undefined) {
          return { _tag: 'Boolean', value: textOf(boolean).trim() === 'true' } as const;
        }
        const results = elements(root).find((c) => c.localName === 'results');
        const bindings = (results === undefined ? [] : elements(results)).map((r) =>
          B.fromEntries(
            elements(r)
              .filter((c) => c.localName === 'binding')
              .map((c) => [attribute(c, 'name') ?? '', xmlToTerm(elements(c)[0]!)] as const),
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
  if (t._tag === 'Literal' && t.language === '') {
    const dt = t.datatype.value;
    if (dt === `${XSD}integer` && /^[+-]?\d+$/.test(t.value)) return t.value;
    if (dt === `${XSD}decimal` && /^[+-]?\d*\.\d+$/.test(t.value)) return t.value;
    if (dt === `${XSD}double` && /^[+-]?(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(t.value))
      return t.value;
    if (dt === `${XSD}boolean` && (t.value === 'true' || t.value === 'false')) return t.value;
  }
  if (t._tag === 'Triple') {
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

const serializeTsv = <E>(result: SelectResult<E> | AskResult): Stream.Stream<string, E> => {
  if (result._tag === 'Ask') return Stream.succeed(`${result.value}\n`);
  const vars = result.variables.map((v) => v.value);
  return Stream.concat(
    Stream.succeed(`${vars.map((v) => `?${v}`).join('\t')}\n`),
    ordered(result, (b) => {
      const cells = vars.map((v) => {
        const t = b.map.get(v);
        return t === undefined ? '' : termToTsv(t);
      });
      return `${cells.join('\t')}\n`;
    }),
  );
};

const splitLines = (input: string): Array<string> => {
  const lines = input.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const parseTsv = (input: string): Effect.Effect<ParsedResult, ResultsParseError> =>
  Effect.suspend((): Effect.Effect<ParsedResult, ResultsParseError> => {
    const lines = splitLines(input);
    if (Arr.isReadonlyArrayEmpty(lines)) {
      return Effect.fail(new ResultsParseError({ format: 'tsv', message: 'Empty document' }));
    }
    const first = lines[0]!.trim();
    if (first === 'true' || first === 'false') {
      return Effect.succeed({ _tag: 'Boolean', value: first === 'true' } as const);
    }
    const vars = lines[0]!.split('\t').map((v) => v.trim().replace(/^[?$]/, ''));
    const bindings: Array<Bindings> = [];
    for (let row = 1; row < lines.length; row++) {
      const cells = lines[row]!.split('\t');
      const entries: Array<readonly [string, Term.GroundTerm | undefined]> = [];
      let offset = 0;
      for (let i = 0; i < vars.length; i++) {
        const cell = cells[i] ?? '';
        const start = offset;
        offset += cell.length + 1;
        if (cell.trim() === '') continue;
        const t = Parser.parse(TextResults.groundTerm, cell);
        if (Result.isFailure(t)) {
          return Effect.fail(
            new ResultsParseError({
              format: 'tsv',
              message: `Invalid term: ${cell.trim()}: ${parseErrorSummary(t.failure)}`,
              line: row + 1,
              column: start + t.failure.position.column,
            }),
          );
        }
        entries.push([vars[i]!, t.success]);
      }
      bindings.push(B.fromEntries(entries));
    }
    return Effect.succeed({ _tag: 'ResultSet', variables: vars, bindings } as const);
  });

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

const csvTerm = (t: Term.GroundTerm): string => {
  switch (t._tag) {
    case 'NamedNode':
    case 'Literal':
      return t.value;
    case 'BlankNode':
      return `_:${t.value}`;
    case 'Triple':
      return `<<( ${termToTsv(t.subject)} ${termToTsv(t.predicate)} ${termToTsv(t.object)} )>>`;
  }
};

const serializeCsv = <E>(result: SelectResult<E> | AskResult): Stream.Stream<string, E> => {
  if (result._tag === 'Ask') return Stream.succeed(`${result.value}\r\n`);
  const vars = result.variables.map((v) => v.value);
  return Stream.concat(
    Stream.succeed(`${vars.map(csvField).join(',')}\r\n`),
    ordered(result, (b) => {
      const cells = vars.map((v) => {
        const t = b.map.get(v);
        return t === undefined ? '' : csvField(csvTerm(t));
      });
      return `${cells.join(',')}\r\n`;
    }),
  );
};

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
    const rows = parsed.success;
    if (Arr.isReadonlyArrayEmpty(rows)) {
      return Effect.fail(new ResultsParseError({ format: 'csv', message: 'Empty document' }));
    }
    const first = rows[0]!;
    if (first.length === 1 && (first[0]!.value === 'true' || first[0]!.value === 'false')) {
      return Effect.succeed({ _tag: 'Boolean', value: first[0]!.value === 'true' } as const);
    }
    const vars = first.map((c) => c.value);
    const bindings = rows.slice(1).map((r) =>
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
  const mt = mediaType.split(';')[0]!.trim().toLowerCase();
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
