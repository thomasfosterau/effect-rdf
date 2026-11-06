/**
 * Incremental parsing of SPARQL results documents: solutions are emitted as
 * soon as they have been received, without buffering the whole response.
 *
 * - JSON (`application/sparql-results+json`): an incremental scanner finds
 *   the `head`, `boolean` and each element of `results.bindings`, decoded
 *   with `Results.JsonTermSchema`;
 * - XML (`application/sparql-results+xml`): complete `<result>` elements are
 *   cut from the input and parsed with `Results.Xml.parse`;
 * - TSV (`text/tab-separated-values`): line by line with
 *   `Results.parseTerm`;
 * - CSV (`text/csv`): complete records (whose quoted cells may span lines)
 *   are parsed with `Results.Csv.parse` as they arrive.
 *
 * @since 0.1.0
 */
import * as Match from 'effect/Match';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Iterable from 'effect/Iterable';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import type * as Term from '../Term.ts';
import * as B from './Bindings.ts';
import * as Json from './internal/json.ts';
import * as Results from './Results.ts';

/**
 * An event of a results document.
 *
 * @since 0.1.0
 * @category models
 */
export type ResultEvent =
  | { readonly _tag: 'Variables'; readonly variables: ReadonlyArray<string> }
  | { readonly _tag: 'Solution'; readonly bindings: B.Bindings }
  | { readonly _tag: 'Boolean'; readonly value: boolean };

/**
 * An incremental parser: `push` consumes a chunk of text and returns the
 * events it completes; `end` flushes the remaining input. Both throw
 * `Results.ResultsParseError` on malformed input.
 *
 * @since 0.1.0
 * @category models
 */
export interface Incremental {
  readonly push: (chunk: string) => ReadonlyArray<ResultEvent>;
  readonly end: () => ReadonlyArray<ResultEvent>;
}

const fail: (format: string, message: string) => never = (format, message) => {
  throw new Results.ResultsParseError({ format, message });
};

const variablesEvent = (variables: ReadonlyArray<string>): ResultEvent => ({
  _tag: 'Variables',
  variables,
});

const isBooleanResult = Predicate.isTagged('Boolean');

const fromParsed = (parsed: Results.ParsedResult): Array<ResultEvent> =>
  isBooleanResult(parsed)
    ? [{ _tag: 'Boolean', value: parsed.value }]
    : [
        variablesEvent(parsed.variables),
        ...parsed.bindings.map((bindings) => ({ _tag: 'Solution', bindings }) as const),
      ];

/** Appends a solution event per row of a parsed result set (none for a boolean). */
const pushSolutions = (parsed: Results.ParsedResult, out: Array<ResultEvent>): void => {
  if (isBooleanResult(parsed)) return;
  parsed.bindings.forEach((bindings) => {
    out.push({ _tag: 'Solution', bindings });
  });
};

const runSyncParse = (
  effect: Effect.Effect<Results.ParsedResult, Results.ResultsParseError>,
): Results.ParsedResult => {
  const result = Effect.runSync(Effect.result(effect));
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

// -----------------------------------------------------------------------------
// JSON
// -----------------------------------------------------------------------------

const decodeJsonString = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.String));
const decodeRow = Schema.decodeUnknownResult(Schema.Record(Schema.String, Results.JsonTermSchema));
const decodeHead = Schema.decodeUnknownResult(
  Schema.Struct({ vars: Schema.optional(Schema.Array(Schema.String)) }),
);

interface Frame {
  readonly type: 'object' | 'array';
  /** The last key read in an object (`''` before the first). */
  key: string;
  expectKey: boolean;
}

type CaptureKind = 'head' | 'boolean' | 'binding';

/**
 * One token of JSON outside a string, as capture groups: (1) a run of
 * whitespace, (2) an opening and (3) a closing bracket, (4) `:` or `,`, (5)
 * the body of a string that starts here, followed by (6) its closing quote or
 * (7) a lone backslash at the end of the chunk (neither: the chunk ends inside
 * the string); no group: a run of primitive (number, literal) characters.
 */
const JSON_TOKEN =
  /([ \t\n\r]+)|([{[])|([}\]])|([:,])|"([^"\\]*(?:\\[^][^"\\]*)*)(?:(")|(\\))?|[^ \t\n\r{}[\]:,"]+/g;

/** The rest of a string a chunk starts inside: up to its closing quote, a lone final backslash or the end. */
const STRING_REST = /[^"\\]*(?:\\[^][^"\\]*)*/y;

/**
 * An incremental parser for SPARQL JSON results.
 *
 * @since 0.1.0
 * @category parsers
 */
export const json = (): Incremental => {
  const stack: Array<Frame> = [];
  let inString = false;
  let escape = false;
  let stringIsKey = false;
  let keyRaw = '';
  let primitive = false;
  let capturing = false;
  let capture: CaptureKind = 'head';
  let captureDepth = 0;
  let captureBuf = '';
  let captureStart = -1;
  let done = false;
  let sawHead = false;
  let sawBody = false;
  // The chunk being scanned and the events it completes.
  let chunk = '';
  let out: Array<ResultEvent> = [];

  /** Whether a value starting here is one to capture, and which. */
  const interesting = (): Option.Option<CaptureKind> => {
    const top = stack[stack.length - 1];
    if (top === undefined) return Option.none();
    if (stack.length === 1 && top.type === 'object') {
      if (top.key === 'head') return Option.some('head');
      if (top.key === 'boolean') return Option.some('boolean');
      return Option.none();
    }
    if (
      stack.length === 3 &&
      top.type === 'array' &&
      stack[0]?.key === 'results' &&
      stack[1]?.type === 'object' &&
      stack[1].key === 'bindings'
    ) {
      return Option.some('binding');
    }
    return Option.none();
  };

  const emit = (kind: CaptureKind, text: string) => {
    const parsed = Json.parse(text);
    if (Result.isFailure(parsed)) fail('json', `Invalid JSON: ${parsed.failure}`);
    const value = parsed.success;
    if (kind === 'head') {
      const head = decodeHead(value);
      if (Result.isFailure(head)) fail('json', `Invalid head: ${head.failure.message}`);
      sawHead = true;
      out.push(variablesEvent(head.success.vars ?? []));
    } else if (kind === 'boolean') {
      if (!Predicate.isBoolean(value)) fail('json', '"boolean" must be true or false');
      sawBody = true;
      out.push({ _tag: 'Boolean', value });
    } else {
      const row = decodeRow(value);
      if (Result.isFailure(row)) fail('json', `Invalid binding: ${row.failure.message}`);
      sawBody = true;
      out.push({
        _tag: 'Solution',
        bindings: B.fromEntries(
          Arr.map(Record.toEntries(row.success), ([k, v]) => [k, Results.termFromJson(v)] as const),
        ),
      });
    }
  };

  /** Emits the captured value if it ends (exclusively) at `end` of the chunk. */
  const finish = (end: number) => {
    if (!capturing || stack.length !== captureDepth) return;
    const text = captureBuf + chunk.slice(captureStart, end);
    capturing = false;
    captureBuf = '';
    captureStart = -1;
    emit(capture, text);
  };
  const valueStart = (i: number) => {
    if (capturing) return;
    const kind = interesting();
    if (Option.isSome(kind)) {
      capturing = true;
      capture = kind.value;
      captureDepth = stack.length;
      captureStart = i;
      captureBuf = '';
    }
  };
  const endPrimitive = (i: number) => {
    if (!primitive) return;
    primitive = false;
    finish(i);
  };
  /** Ends the current string at its closing quote, `quote`. */
  const endString = (quote: number) => {
    inString = false;
    if (stringIsKey) {
      const key = decodeJsonString(`"${keyRaw}"`);
      if (Result.isFailure(key)) fail('json', 'Invalid object key');
      const top = stack[stack.length - 1];
      if (top !== undefined) {
        top.key = key.success;
        top.expectKey = false;
      }
    } else {
      finish(quote + 1);
    }
  };
  /** Continues a string that the previous chunk ended inside; returns where it stops. */
  const continueString = (): number => {
    let start = 0;
    if (escape) {
      escape = false;
      if (stringIsKey) keyRaw += chunk[0];
      start = 1;
    }
    STRING_REST.lastIndex = start;
    const body = STRING_REST.exec(chunk)?.[0] ?? '';
    const end = start + body.length;
    if (stringIsKey) keyRaw += body;
    if (end >= chunk.length) return end;
    if (chunk.charCodeAt(end) === 34 /* " */) {
      endString(end);
      return end + 1;
    }
    // A lone backslash ends the chunk: the next one starts with the escaped character.
    escape = true;
    if (stringIsKey) keyRaw += '\\';
    return chunk.length;
  };

  /** Scans one token at `i` of the chunk (the groups are `JSON_TOKEN`'s, absent when unmatched). */
  const token = (
    i: number,
    ws?: string,
    open?: string,
    close?: string,
    punct?: string,
    body?: string,
    quote?: string,
    backslash?: string,
  ): void => {
    if (done) {
      if (ws === undefined) fail('json', 'Trailing data');
      return;
    }
    if (ws !== undefined) {
      endPrimitive(i);
    } else if (open !== undefined) {
      endPrimitive(i);
      valueStart(i);
      const isObject = open === '{';
      stack.push({ type: isObject ? 'object' : 'array', key: '', expectKey: isObject });
    } else if (close !== undefined) {
      endPrimitive(i);
      const frame = stack.pop();
      if (frame === undefined || frame.type !== (close === '}' ? 'object' : 'array')) {
        fail('json', 'Unbalanced brackets');
      }
      finish(i + 1);
      if (Arr.isReadonlyArrayEmpty(stack)) done = true;
    } else if (punct !== undefined) {
      endPrimitive(i);
      const top = stack[stack.length - 1];
      if (punct === ',' && top !== undefined && top.type === 'object') top.expectKey = true;
    } else if (body !== undefined) {
      endPrimitive(i);
      const top = stack[stack.length - 1];
      inString = true;
      if (top !== undefined && top.type === 'object' && top.expectKey) {
        stringIsKey = true;
        keyRaw = body;
      } else {
        stringIsKey = false;
        valueStart(i);
      }
      if (quote !== undefined) {
        endString(i + 1 + body.length);
      } else if (backslash !== undefined) {
        escape = true;
        if (stringIsKey) keyRaw += '\\';
      }
    } else {
      if (Arr.isReadonlyArrayEmpty(stack)) fail('json', 'Expected a JSON object');
      if (!primitive) {
        primitive = true;
        valueStart(i);
      }
    }
  };

  const push = (text: string): ReadonlyArray<ResultEvent> => {
    out = [];
    chunk = text;
    if (capturing) captureStart = 0;
    const from = inString && chunk !== '' ? continueString() : 0;
    if (from < chunk.length) {
      // `replace` drives the scan: one callback per token, nothing is kept.
      (from === 0 ? chunk : chunk.slice(from)).replace(
        JSON_TOKEN,
        (_m, ws, open, close, punct, body, quote, backslash, offset: number) => {
          token(from + offset, ws, open, close, punct, body, quote, backslash);
          return '';
        },
      );
    }
    if (capturing) {
      captureBuf += chunk.slice(captureStart);
      captureStart = 0;
    }
    chunk = '';
    return out;
  };

  return {
    push,
    end: () => {
      if (!done || inString) fail('json', 'Unexpected end of document');
      if (!sawHead && !sawBody) fail('json', 'Missing "head"');
      return [];
    },
  };
};

// -----------------------------------------------------------------------------
// TSV
// -----------------------------------------------------------------------------

/**
 * An incremental parser for SPARQL TSV results.
 *
 * @since 0.1.0
 * @category parsers
 */
export const tsv = (): Incremental => {
  let buffer = '';
  /** Whether the first line (the variables, or a boolean) has been read. */
  let started = false;
  let variables: ReadonlyArray<string> = [];
  let boolean = false;
  const line = (raw: string, out: Array<ResultEvent>) => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!started) {
      started = true;
      const first = text.trim();
      if (first === 'true' || first === 'false') {
        boolean = true;
        out.push({ _tag: 'Boolean', value: first === 'true' });
        return;
      }
      variables = text === '' ? [] : text.split('\t').map((v) => v.trim().replace(/^[?$]/, ''));
      out.push(variablesEvent(variables));
      return;
    }
    if (boolean) {
      if (text.trim() !== '') fail('tsv', 'Unexpected data after a boolean result');
      return;
    }
    const cells = text.split('\t');
    const entries: Array<readonly [string, Term.GroundTerm]> = [];
    variables.forEach((variable, i) => {
      const cell = (cells[i] ?? '').trim();
      if (cell === '') return;
      const term = Results.parseTerm(cell);
      if (Option.isNone(term)) fail('tsv', `Invalid term: ${cell}`);
      entries.push([variable, term.value]);
    });
    out.push({ _tag: 'Solution', bindings: B.fromEntries(entries) });
  };
  return {
    push: (chunk) => {
      const out: Array<ResultEvent> = [];
      buffer += chunk;
      const nl = buffer.lastIndexOf('\n');
      if (nl >= 0) {
        const complete = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        complete.split('\n').forEach((l) => line(l, out));
      }
      return out;
    },
    end: () => {
      const out: Array<ResultEvent> = [];
      if (buffer !== '') line(buffer, out);
      buffer = '';
      if (!started) fail('tsv', 'Empty document');
      return out;
    },
  };
};

// -----------------------------------------------------------------------------
// XML
// -----------------------------------------------------------------------------

const ROOT = /<([A-Za-z_][\w.-]*:)?sparql\b[^>]*>/;
const HEAD_END = /<\/head\s*>|<head\b[^>]*\/>/;
const RESULTS_START = /<results\b[^>]*?(\/?)>/;
const RESULT_END = /<result\b[^>]*\/>|<\/result\s*>/g;

const parseXmlResults = (doc: string) => runSyncParse(Results.Xml.parse(doc));

/**
 * An incremental parser for SPARQL XML results.
 *
 * @since 0.1.0
 * @category parsers
 */
export const xml = (): Incremental => {
  let buffer = '';
  let phase: 'root' | 'head' | 'body' | 'results' | 'whole' | 'done' = 'root';
  let root = '';
  let head = '';
  const step = (out: Array<ResultEvent>): boolean => {
    return Match.value(phase).pipe(
      Match.when('root', () => {
        const m = ROOT.exec(buffer);
        if (m === null) return false;
        if (m[1] !== undefined || m[0].endsWith('/>')) {
          phase = 'whole';
          return false;
        }
        root = buffer.slice(0, m.index + m[0].length);
        buffer = buffer.slice(m.index + m[0].length);
        phase = 'head';
        return true;
      }),
      Match.when('head', () => {
        const m = HEAD_END.exec(buffer);
        if (m === null) return false;
        head = buffer.slice(0, m.index + m[0].length);
        buffer = buffer.slice(m.index + m[0].length);
        const parsed = parseXmlResults(`${root}${head}</sparql>`);
        out.push(variablesEvent(isBooleanResult(parsed) ? [] : parsed.variables));
        phase = 'body';
        return true;
      }),
      Match.when('body', () => {
        const results = RESULTS_START.exec(buffer);
        const boolean = buffer.indexOf('<boolean');
        if (boolean >= 0 && (results === null || boolean < results.index)) {
          const end = buffer.indexOf('</boolean>');
          if (end < 0) return false;
          const parsed = parseXmlResults(
            `${root}<head/>${buffer.slice(boolean, end + 10)}</sparql>`,
          );
          if (isBooleanResult(parsed)) out.push({ _tag: 'Boolean', value: parsed.value });
          buffer = '';
          phase = 'done';
          return false;
        }
        if (results === null) return false;
        buffer = buffer.slice(results.index + results[0].length);
        phase = results[1] === '/' ? 'done' : 'results';
        return true;
      }),
      Match.when('results', () => {
        // The end of the last complete `<result>` element.
        const last = Iterable.reduce(
          buffer.matchAll(RESULT_END),
          -1,
          (_, m) => m.index + m[0].length,
        );
        if (last < 0) return false;
        pushSolutions(
          parseXmlResults(`${root}<head/><results>${buffer.slice(0, last)}</results></sparql>`),
          out,
        );
        buffer = buffer.slice(last);
        return false;
      }),
      Match.orElse(() => false),
    );
  };
  /** Steps until a phase waits for more input (each `true` is a phase change). */
  const drain = (out: Array<ResultEvent>): void => {
    if (step(out)) drain(out);
  };
  /** Read through a function: `drain` may move `phase` to `whole`, which TypeScript cannot see. */
  const isWhole = (): boolean => phase === 'whole';
  let whole = '';
  return {
    push: (chunk) => {
      const out: Array<ResultEvent> = [];
      if (phase === 'whole') {
        whole += chunk;
        return out;
      }
      if (phase === 'done') return out;
      buffer += chunk;
      drain(out);
      if (isWhole()) {
        whole = buffer;
        buffer = '';
      }
      return out;
    },
    end: () => {
      if (phase === 'whole' || phase === 'root') {
        return fromParsed(parseXmlResults(whole + buffer));
      }
      if (phase === 'head' || phase === 'body') {
        // No <results> or <boolean>: let the full parser report the problem.
        if (phase === 'head') fail('xml', 'Unexpected end of document');
        const parsed = parseXmlResults(`${root}${head}${buffer}`);
        return isBooleanResult(parsed) ? [{ _tag: 'Boolean', value: parsed.value }] : [];
      }
      if (phase === 'results' && !/<\/results\s*>/.test(buffer)) {
        fail('xml', 'Unexpected end of document');
      }
      return [];
    },
  };
};

// -----------------------------------------------------------------------------
// CSV and buffering
// -----------------------------------------------------------------------------

/** Where a scan of CSV text found line breaks outside quotes, and the quote state at its end. */
interface RecordScan {
  quoted: boolean;
  /** The first and last line break outside quotes (`-1`: none). */
  first: number;
  last: number;
}

const QUOTE_OR_LINE_BREAK = /["\n]/g;

/** Scans `text` from `from`, starting inside quotes or not, for the line breaks that end records. */
const scanRecords = (text: string, from: number, quoted: boolean): RecordScan => {
  const scan: RecordScan = { quoted, first: -1, last: -1 };
  // `replace` drives the scan: one callback per quote or line break, nothing is kept.
  (from === 0 ? text : text.slice(from)).replace(QUOTE_OR_LINE_BREAK, (c, offset: number) => {
    if (c === '"') {
      scan.quoted = !scan.quoted;
    } else if (!scan.quoted) {
      if (scan.first < 0) scan.first = from + offset;
      scan.last = from + offset;
    }
    return '';
  });
  return scan;
};

/**
 * An incremental parser for SPARQL CSV results: records are parsed (with the
 * header, by `Results.Csv.parse`) once they are complete, that is, once a line
 * break outside quotes has arrived.
 *
 * @since 0.1.0
 * @category parsers
 */
export const csv = (): Incremental => {
  let buffer = '';
  /** How far `buffer` has been scanned for record ends, and whether that is inside quotes. */
  let scanned = 0;
  let quoted = false;
  let header: Option.Option<string> = Option.none();
  let boolean = false;
  /** The lines of the header, and of the records parsed so far (header included). */
  let headerLines = 0;
  let lines = 0;
  const parse = (records: string): Results.ParsedResult => {
    const parsed = Result.try(() =>
      runSyncParse(
        Results.Csv.parse(
          Option.match(header, { onNone: () => records, onSome: (h) => h + records }),
        ),
      ),
    );
    if (Result.isSuccess(parsed)) return parsed.success;
    const e = parsed.failure;
    // Report lines of the whole document, not of the records parsed
    if (e instanceof Results.ResultsParseError && e.line !== undefined && Option.isSome(header)) {
      const line = e.line - headerLines + lines;
      throw e.column === undefined
        ? new Results.ResultsParseError({ format: e.format, message: e.message, line })
        : new Results.ResultsParseError({
            format: e.format,
            message: e.message,
            line,
            column: e.column,
          });
    }
    throw e;
  };
  const records = (input: string, out: Array<ResultEvent>) => {
    if (boolean || input === '') return;
    let text = input;
    if (Option.isNone(header)) {
      // The first record is the header (or a boolean)
      const end = recordEnd(text);
      const first = text.slice(0, end);
      const parsed = parse(first);
      if (isBooleanResult(parsed)) {
        boolean = true;
        out.push({ _tag: 'Boolean', value: parsed.value });
        return;
      }
      out.push(variablesEvent(parsed.variables));
      header = Option.some(first);
      headerLines = countLines(first);
      lines = headerLines;
      text = text.slice(end);
      if (text === '') return;
    }
    pushSolutions(parse(text), out);
    lines += countLines(text);
  };
  return {
    push: (chunk) => {
      const out: Array<ResultEvent> = [];
      buffer += chunk;
      const scan = scanRecords(buffer, scanned, quoted);
      quoted = scan.quoted;
      scanned = buffer.length;
      if (scan.last >= 0) {
        records(buffer.slice(0, scan.last + 1), out);
        buffer = buffer.slice(scan.last + 1);
        scanned = buffer.length;
      }
      return out;
    },
    end: () => {
      const out: Array<ResultEvent> = [];
      if (Option.isNone(header) && !boolean) return fromParsed(parse(buffer));
      records(buffer, out);
      buffer = '';
      return out;
    },
  };
};

/** The end of the first record of complete records (after its line break). */
const recordEnd = (text: string): number => {
  const { first } = scanRecords(text, 0, false);
  return first < 0 ? text.length : first + 1;
};

const countLines = (text: string): number => text.split('\n').length - 1;

/**
 * A parser that buffers the whole document and parses it with a complete
 * results codec (used for CSV).
 *
 * @since 0.1.0
 * @category parsers
 */
export const buffered = (codec: Results.ResultsCodec): Incremental => {
  let buffer = '';
  return {
    push: (chunk) => {
      buffer += chunk;
      return [];
    },
    end: () => fromParsed(runSyncParse(codec.parse(buffer))),
  };
};

// -----------------------------------------------------------------------------
// Streams
// -----------------------------------------------------------------------------

/**
 * Runs an incremental parser over a stream of text chunks.
 *
 * @since 0.1.0
 * @category streams
 */
export const run = <E, R>(
  input: Stream.Stream<string, E, R>,
  make: () => Incremental,
  format: string,
): Stream.Stream<ResultEvent, E | Results.ResultsParseError, R> => {
  const step = (f: () => ReadonlyArray<ResultEvent>) =>
    Effect.try({
      try: f,
      catch: (e) =>
        e instanceof Results.ResultsParseError
          ? e
          : new Results.ResultsParseError({
              format,
              message:
                Predicate.hasProperty(e, 'message') && Predicate.isString(e.message)
                  ? e.message
                  : String(e),
            }),
    });
  return Stream.suspend(() => {
    const parser = make();
    return Stream.concat(
      Stream.flattenIterable(Stream.mapEffect(input, (chunk) => step(() => parser.push(chunk)))),
      Stream.flattenIterable(Stream.fromEffect(step(() => parser.end()))),
    );
  });
};

/**
 * Finds the incremental parser for a results media type.
 *
 * @since 0.1.0
 * @category streams
 */
export const parserFor = (
  mediaType: string,
): Option.Option<{ readonly make: () => Incremental; readonly format: string }> => {
  const codec = Results.codecFor(mediaType);
  if (Option.isNone(codec)) return Option.none();
  return Match.value(codec).pipe(
    Match.when(
      ({ value }) => value === Results.Json,
      () => Option.some({ make: json, format: 'json' }),
    ),
    Match.when(
      ({ value }) => value === Results.Xml,
      () => Option.some({ make: xml, format: 'xml' }),
    ),
    Match.when(
      ({ value }) => value === Results.Tsv,
      () => Option.some({ make: tsv, format: 'tsv' }),
    ),
    Match.when(
      ({ value }) => value === Results.Csv,
      () => Option.some({ make: csv, format: 'csv' }),
    ),
    Match.orElse((found) => {
      const c = found.value;
      return Option.some({ make: () => buffered(c), format: c.format.extensions[0] ?? 'csv' });
    }),
  );
};

/**
 * Parses a results document of the given media type incrementally.
 * Returns `None` for unsupported media types.
 *
 * @since 0.1.0
 * @category streams
 */
export const parse = <E, R>(
  mediaType: string,
  input: Stream.Stream<string, E, R>,
): Option.Option<Stream.Stream<ResultEvent, E | Results.ResultsParseError, R>> =>
  Option.map(parserFor(mediaType), ({ make, format }) => run(input, make, format));
