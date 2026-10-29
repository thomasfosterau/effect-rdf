/**
 * Incremental parsing of SPARQL results documents: solutions are emitted as
 * soon as they have been received, without buffering the whole response.
 *
 * - JSON (`application/sparql-results+json`): an incremental scanner finds
 *   the `head`, `boolean` and each element of `results.bindings`, decoded
 *   with the `Results.JsonTermSchema` of the sparql package;
 * - XML (`application/sparql-results+xml`): complete `<result>` elements are
 *   cut from the input and parsed with `Results.Xml.parse`;
 * - TSV (`text/tab-separated-values`): line by line with
 *   `Results.parseTerm`;
 * - CSV (`text/csv`): complete records (whose quoted cells may span lines)
 *   are parsed with `Results.Csv.parse` as they arrive.
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
import type * as Term from '@thomasfosterau/effect-rdf/Term';
import * as B from '@thomasfosterau/effect-sparql/Bindings';
import * as Json from './internal/json.ts';
import * as Results from '@thomasfosterau/effect-sparql/Results';

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

const fail = (format: string, message: string): never => {
  throw new Results.ResultsParseError({ format, message });
};

const variablesEvent = (variables: ReadonlyArray<string>): ResultEvent => ({
  _tag: 'Variables',
  variables,
});

const fromParsed = (parsed: Results.ParsedResult): Array<ResultEvent> =>
  parsed._tag === 'Boolean'
    ? [{ _tag: 'Boolean', value: parsed.value }]
    : [
        variablesEvent(parsed.variables),
        ...parsed.bindings.map((bindings) => ({ _tag: 'Solution', bindings }) as const),
      ];

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
  key: string | undefined;
  expectKey: boolean;
}

type CaptureKind = 'head' | 'boolean' | 'binding';

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
  let capture: CaptureKind | undefined;
  let captureDepth = 0;
  let captureBuf = '';
  let captureStart = -1;
  let done = false;
  let sawHead = false;
  let sawBody = false;

  const interesting = (): CaptureKind | undefined => {
    const top = stack[stack.length - 1];
    if (top === undefined) return undefined;
    if (stack.length === 1 && top.type === 'object') {
      if (top.key === 'head') return 'head';
      if (top.key === 'boolean') return 'boolean';
      return undefined;
    }
    if (
      stack.length === 3 &&
      top.type === 'array' &&
      stack[0]!.key === 'results' &&
      stack[1]!.type === 'object' &&
      stack[1]!.key === 'bindings'
    ) {
      return 'binding';
    }
    return undefined;
  };

  const emit = (kind: CaptureKind, text: string, out: Array<ResultEvent>) => {
    const parsed = Json.parse(text);
    if (Result.isFailure(parsed)) return fail('json', `Invalid JSON: ${String(parsed.failure)}`);
    const value = parsed.success;
    switch (kind) {
      case 'head': {
        const head = decodeHead(value);
        if (Result.isFailure(head)) return fail('json', `Invalid head: ${head.failure.message}`);
        sawHead = true;
        out.push(variablesEvent(head.success.vars ?? []));
        return;
      }
      case 'boolean':
        if (!Predicate.isBoolean(value)) return fail('json', '"boolean" must be true or false');
        sawBody = true;
        out.push({ _tag: 'Boolean', value });
        return;
      case 'binding': {
        const row = decodeRow(value);
        if (Result.isFailure(row)) return fail('json', `Invalid binding: ${row.failure.message}`);
        sawBody = true;
        const entries: Array<readonly [string, Term.GroundTerm]> = [];
        for (const [k, v] of Object.entries(row.success)) {
          entries.push([k, Results.termFromJson(v)]);
        }
        out.push({ _tag: 'Solution', bindings: B.fromEntries(entries) });
        return;
      }
    }
  };

  const push = (chunk: string): ReadonlyArray<ResultEvent> => {
    const out: Array<ResultEvent> = [];
    if (capture !== undefined) captureStart = 0;
    const finish = (endExclusive: number) => {
      const text = captureBuf + chunk.slice(captureStart, endExclusive);
      const kind = capture!;
      capture = undefined;
      captureBuf = '';
      captureStart = -1;
      emit(kind, text, out);
    };
    const valueStart = (i: number) => {
      if (capture !== undefined) return;
      const kind = interesting();
      if (kind !== undefined) {
        capture = kind;
        captureDepth = stack.length;
        captureStart = i;
        captureBuf = '';
      }
    };
    const endPrimitive = (i: number) => {
      if (!primitive) return;
      primitive = false;
      if (capture !== undefined && stack.length === captureDepth) finish(i);
    };
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (inString) {
        if (escape) {
          escape = false;
          if (stringIsKey) keyRaw += chunk[i];
        } else if (c === 92 /* \ */) {
          escape = true;
          if (stringIsKey) keyRaw += '\\';
        } else if (c === 34 /* " */) {
          inString = false;
          if (stringIsKey) {
            const top = stack[stack.length - 1]!;
            const key = decodeJsonString(`"${keyRaw}"`);
            if (Result.isFailure(key)) return fail('json', 'Invalid object key');
            top.key = key.success;
            top.expectKey = false;
          } else if (capture !== undefined && stack.length === captureDepth) {
            finish(i + 1);
          }
        } else if (stringIsKey) {
          keyRaw += chunk[i];
        }
        continue;
      }
      if (done) {
        if (c !== 32 && c !== 9 && c !== 10 && c !== 13) fail('json', 'Trailing data');
        continue;
      }
      switch (c) {
        case 32:
        case 9:
        case 10:
        case 13:
          endPrimitive(i);
          break;
        case 123 /* { */:
        case 91 /* [ */:
          endPrimitive(i);
          valueStart(i);
          stack.push({
            type: c === 123 ? 'object' : 'array',
            key: undefined,
            expectKey: c === 123,
          });
          break;
        case 125 /* } */:
        case 93 /* ] */: {
          endPrimitive(i);
          const frame = stack.pop();
          if (frame === undefined || frame.type !== (c === 125 ? 'object' : 'array')) {
            fail('json', 'Unbalanced brackets');
          }
          if (capture !== undefined && stack.length === captureDepth) finish(i + 1);
          if (Arr.isReadonlyArrayEmpty(stack)) done = true;
          break;
        }
        case 58 /* : */:
          endPrimitive(i);
          break;
        case 44 /* , */: {
          endPrimitive(i);
          const top = stack[stack.length - 1];
          if (top !== undefined && top.type === 'object') top.expectKey = true;
          break;
        }
        case 34 /* " */: {
          endPrimitive(i);
          const top = stack[stack.length - 1];
          inString = true;
          if (top !== undefined && top.type === 'object' && top.expectKey) {
            stringIsKey = true;
            keyRaw = '';
          } else {
            stringIsKey = false;
            valueStart(i);
          }
          break;
        }
        default:
          if (Arr.isReadonlyArrayEmpty(stack)) fail('json', 'Expected a JSON object');
          if (!primitive) {
            primitive = true;
            valueStart(i);
          }
      }
    }
    if (capture !== undefined) {
      captureBuf += chunk.slice(captureStart);
      captureStart = 0;
    }
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
  let variables: ReadonlyArray<string> | undefined;
  let boolean = false;
  const line = (raw: string, out: Array<ResultEvent>) => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (variables === undefined) {
      const first = text.trim();
      if (first === 'true' || first === 'false') {
        boolean = true;
        variables = [];
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
    for (let i = 0; i < variables.length; i++) {
      const cell = (cells[i] ?? '').trim();
      if (cell === '') continue;
      const term = Results.parseTerm(cell);
      if (Option.isNone(term)) return fail('tsv', `Invalid term: ${cell}`);
      entries.push([variables[i]!, term.value]);
    }
    out.push({ _tag: 'Solution', bindings: B.fromEntries(entries) });
  };
  return {
    push: (chunk) => {
      const out: Array<ResultEvent> = [];
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        line(buffer.slice(0, nl), out);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
      return out;
    },
    end: () => {
      const out: Array<ResultEvent> = [];
      if (buffer !== '') line(buffer, out);
      buffer = '';
      if (variables === undefined) fail('tsv', 'Empty document');
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
  const parse = (doc: string) => runSyncParse(Results.Xml.parse(doc));
  const step = (out: Array<ResultEvent>): boolean => {
    switch (phase) {
      case 'root': {
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
      }
      case 'head': {
        const m = HEAD_END.exec(buffer);
        if (m === null) return false;
        head = buffer.slice(0, m.index + m[0].length);
        buffer = buffer.slice(m.index + m[0].length);
        const parsed = parse(`${root}${head}</sparql>`);
        out.push(variablesEvent(parsed._tag === 'ResultSet' ? parsed.variables : []));
        phase = 'body';
        return true;
      }
      case 'body': {
        const results = RESULTS_START.exec(buffer);
        const boolean = buffer.indexOf('<boolean');
        if (boolean >= 0 && (results === null || boolean < results.index)) {
          const end = buffer.indexOf('</boolean>');
          if (end < 0) return false;
          const parsed = parse(`${root}<head/>${buffer.slice(boolean, end + 10)}</sparql>`);
          if (parsed._tag === 'Boolean') out.push({ _tag: 'Boolean', value: parsed.value });
          buffer = '';
          phase = 'done';
          return false;
        }
        if (results === null) return false;
        buffer = buffer.slice(results.index + results[0].length);
        phase = results[1] === '/' ? 'done' : 'results';
        return true;
      }
      case 'results': {
        let last = -1;
        RESULT_END.lastIndex = 0;
        for (let m = RESULT_END.exec(buffer); m !== null; m = RESULT_END.exec(buffer)) {
          last = m.index + m[0].length;
        }
        if (last < 0) return false;
        const parsed = parse(`${root}<head/><results>${buffer.slice(0, last)}</results></sparql>`);
        if (parsed._tag === 'ResultSet') {
          for (const bindings of parsed.bindings) out.push({ _tag: 'Solution', bindings });
        }
        buffer = buffer.slice(last);
        return false;
      }
      default:
        return false;
    }
  };
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
      while (step(out)) {
        // keep consuming
      }
      if ((phase as string) === 'whole') {
        whole = buffer;
        buffer = '';
      }
      return out;
    },
    end: () => {
      if (phase === 'whole' || phase === 'root') {
        return fromParsed(parse(whole + buffer));
      }
      if (phase === 'head' || phase === 'body') {
        // No <results> or <boolean>: let the full parser report the problem.
        if (phase === 'head') fail('xml', 'Unexpected end of document');
        const parsed = parse(`${root}${head}${buffer}`);
        return parsed._tag === 'Boolean' ? [{ _tag: 'Boolean', value: parsed.value }] : [];
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
  let header: string | undefined;
  let boolean = false;
  /** The lines of the header, and of the records parsed so far (header included). */
  let headerLines = 0;
  let lines = 0;
  const parse = (records: string): Results.ParsedResult => {
    const parsed = Result.try(() =>
      runSyncParse(Results.Csv.parse(header === undefined ? records : header + records)),
    );
    if (Result.isSuccess(parsed)) return parsed.success;
    const e = parsed.failure;
    // Report lines of the whole document, not of the records parsed
    if (e instanceof Results.ResultsParseError && e.line !== undefined && header !== undefined) {
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
  const records = (text: string, out: Array<ResultEvent>) => {
    if (boolean || text === '') return;
    if (header === undefined) {
      // The first record is the header (or a boolean)
      const end = recordEnd(text);
      const first = text.slice(0, end);
      const parsed = parse(first);
      if (parsed._tag === 'Boolean') {
        boolean = true;
        out.push({ _tag: 'Boolean', value: parsed.value });
        return;
      }
      out.push(variablesEvent(parsed.variables));
      header = first;
      headerLines = countLines(first);
      lines = headerLines;
      text = text.slice(end);
      if (text === '') return;
    }
    const parsed = parse(text);
    if (parsed._tag === 'ResultSet') {
      for (const bindings of parsed.bindings) out.push({ _tag: 'Solution', bindings });
    }
    lines += countLines(text);
  };
  return {
    push: (chunk) => {
      const out: Array<ResultEvent> = [];
      buffer += chunk;
      let last = -1;
      for (let i = scanned; i < buffer.length; i++) {
        const c = buffer.charCodeAt(i);
        if (c === 0x22) quoted = !quoted;
        else if (c === 0x0a && !quoted) last = i;
      }
      scanned = buffer.length;
      if (last >= 0) {
        records(buffer.slice(0, last + 1), out);
        buffer = buffer.slice(last + 1);
        scanned = buffer.length;
      }
      return out;
    },
    end: () => {
      const out: Array<ResultEvent> = [];
      if (header === undefined && !boolean) return fromParsed(parse(buffer));
      records(buffer, out);
      buffer = '';
      return out;
    },
  };
};

/** The end of the first record of complete records (after its line break). */
const recordEnd = (text: string): number => {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22) quoted = !quoted;
    else if (c === 0x0a && !quoted) return i + 1;
  }
  return text.length;
};

const countLines = (text: string): number => {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0x0a) n++;
  return n;
};

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
): Stream.Stream<ResultEvent, E | Results.ResultsParseError, R> =>
  Stream.suspend(() => {
    const parser = make();
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
    return Stream.concat(
      Stream.flattenIterable(Stream.mapEffect(input, (chunk) => step(() => parser.push(chunk)))),
      Stream.flattenIterable(Stream.fromEffect(step(() => parser.end()))),
    );
  });

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
  switch (codec.value) {
    case Results.Json:
      return Option.some({ make: json, format: 'json' });
    case Results.Xml:
      return Option.some({ make: xml, format: 'xml' });
    case Results.Tsv:
      return Option.some({ make: tsv, format: 'tsv' });
    case Results.Csv:
      return Option.some({ make: csv, format: 'csv' });
    default: {
      const c = codec.value;
      return Option.some({ make: () => buffered(c), format: c.format.extensions[0] ?? 'csv' });
    }
  }
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
