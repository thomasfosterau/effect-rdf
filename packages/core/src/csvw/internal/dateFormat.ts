/**
 * Date and time formats (Tabular Data Model §Formats for dates and times):
 * the UAX 35 date field symbols the specification requires (`yyyy`, `MM`,
 * `M`, `dd`, `d`, `HH`, `mm`, `ss`, `S…`, `X…`, `x…`), compiled to a matcher
 * that yields the XML Schema lexical form.
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';

type Field = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'fraction' | 'tz';

interface Token {
  readonly field: Option.Option<Field>;
  readonly source: string;
}

/**
 * A compiled date/time pattern.
 *
 * @internal
 */
export interface DatePattern {
  readonly regex: RegExp;
  readonly fields: ReadonlyArray<Field>;
  readonly hasDate: boolean;
  readonly hasTime: boolean;
}

/** Timezone offsets by marker length (`x`, `xx`, `xxx`); `X…` also allows `Z`. */
const TZ_OFFSETS = ['[+-]\\d{2}(?:\\d{2})?', '[+-]\\d{4}', '[+-]\\d{2}:\\d{2}'];

const field = (f: Field, source: string): Option.Option<Token> =>
  Option.some({ field: Option.some(f), source: `(${source})` });

const tzOffset = (n: number, allowZ: boolean): Option.Option<Token> =>
  Option.flatMap(Arr.get(TZ_OFFSETS, n - 1), (offset) =>
    field('tz', allowZ ? `Z|${offset}` : offset),
  );

const tokenize = (pattern: string): ReadonlyArray<string> => pattern.match(/(.)\1*/gu) ?? [];

/** A field symbol of exactly `n` letters (`yyyy`, `HH`, …). */
const exactly =
  (n: number, f: Field, source: string) =>
  (length: number): Option.Option<Token> =>
    length === n ? field(f, source) : Option.none();

/** A one- or two-letter numeric field (`M` / `MM`, `d` / `dd`). */
const oneOrTwo =
  (f: Field) =>
  (length: number): Option.Option<Token> =>
    length > 2 ? Option.none() : field(f, length === 2 ? '\\d{2}' : '\\d{1,2}');

/** The field symbols this implementation recognises, by letter. */
const symbols: Readonly<Record<string, (length: number) => Option.Option<Token>>> = {
  y: exactly(4, 'year', '\\d{4}'),
  M: oneOrTwo('month'),
  d: oneOrTwo('day'),
  H: exactly(2, 'hour', '\\d{2}'),
  m: exactly(2, 'minute', '\\d{2}'),
  s: exactly(2, 'second', '\\d{2}'),
  S: (length) => field('fraction', `\\d{1,${length}}`),
  X: (length) => tzOffset(length, true),
  x: (length) => tzOffset(length, false),
};

const literal = (run: string): Option.Option<Token> =>
  /^[-/.: T]+$/.test(run)
    ? Option.some({ field: Option.none(), source: run.replace(/[.]/g, '\\.') })
    : Option.none();

const compileToken = (run: string): Option.Option<Token> =>
  Option.match(Record.get(symbols, run.charAt(0)), {
    onNone: () => literal(run),
    onSome: (symbol) => symbol(run.length),
  });

/**
 * Compiles a date/time pattern; `None` when it uses a symbol this
 * implementation does not recognise.
 *
 * @internal
 */
export const compile = (pattern: string): Option.Option<DatePattern> => {
  const tokens = Arr.map(tokenize(pattern), compileToken);
  if (!Arr.every(tokens, Option.isSome) || !Arr.isReadonlyArrayNonEmpty(tokens))
    return Option.none();
  const compiled = Arr.getSomes(tokens);
  const fields = Arr.getSomes(Arr.map(compiled, (t) => t.field));
  const has = (f: Field) => Arr.contains(fields, f);
  const hasDate = has('year') || has('month') || has('day');
  const hasTime = has('hour') || has('minute') || has('second');
  if (Arr.length(Arr.dedupe(fields)) !== Arr.length(fields)) return Option.none();
  if (has('fraction') && !has('second')) return Option.none();
  return Option.some({
    regex: new RegExp(
      `^${Arr.join(
        Arr.map(compiled, (t) => t.source),
        '',
      )}$`,
      'u',
    ),
    fields,
    hasDate,
    hasTime,
  });
};

const pad = (s: string, n: number): string => s.padStart(n, '0');

const timezone = (tz: string): string => {
  if (tz === 'Z') return 'Z';
  const sign = tz.charAt(0);
  const digits = tz.slice(1).replace(':', '');
  const hh = digits.slice(0, 2);
  const mm = digits.length > 2 ? digits.slice(2, 4) : '00';
  return `${sign}${hh}:${mm}`;
};

const daysInMonth = (year: number, month: number): number =>
  month === 2
    ? (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31;

interface Fields {
  readonly date: string;
  readonly time: string;
  readonly tz: string;
}

const fieldsOf = (m: RegExpExecArray, pattern: DatePattern): Fields => {
  const values = Arr.map(pattern.fields, (f, i) => [f, m[i + 1] ?? ''] as const);
  const get = (f: Field, otherwise: string): string =>
    Option.getOrElse(
      Option.map(
        Arr.findFirst(values, ([g]) => g === f),
        ([, v]) => v,
      ),
      () => otherwise,
    );
  const fraction = get('fraction', '');
  const tz = get('tz', '');
  return {
    date: `${get('year', '')}-${pad(get('month', ''), 2)}-${pad(get('day', ''), 2)}`,
    time: `${get('hour', '00')}:${get('minute', '00')}:${get('second', '00')}${fraction === '' ? '' : `.${fraction}`}`,
    tz: tz === '' ? '' : timezone(tz),
  };
};

const validDate = (date: string): boolean => {
  const [y = 0, mo = 0, d = 0] = Arr.map(date.split('-'), Number);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
};

const validTime = (time: string): boolean => {
  const [h = 0, mi = 0, s = 0] = Arr.map(time.split(':'), Number);
  return h <= 23 && mi <= 59 && s < 60;
};

const lexicalFor = (
  fields: Fields,
  pattern: DatePattern,
  base: string,
): Result.Result<string, string> => {
  if (base === 'date')
    return pattern.hasDate ? Result.succeed(fields.date + fields.tz) : Result.fail('has no date');
  if (base === 'time')
    return pattern.hasTime ? Result.succeed(fields.time + fields.tz) : Result.fail('has no time');
  if (!pattern.hasDate) return Result.fail('has no date');
  if (base === 'dateTimeStamp' && fields.tz === '') return Result.fail('has no timezone');
  return Result.succeed(`${fields.date}T${fields.time}${fields.tz}`);
};

/**
 * Matches a cell string against a compiled pattern and returns the XML Schema
 * lexical form for the base datatype (`date`, `time`, `dateTime` or
 * `dateTimeStamp`).
 *
 * @internal
 */
export const parse = (
  text: string,
  pattern: DatePattern,
  base: string,
): Result.Result<string, string> =>
  Option.match(Option.fromNullishOr(pattern.regex.exec(text)), {
    onNone: () => Result.fail('does not match the format'),
    onSome: (m) => {
      const fields = fieldsOf(m, pattern);
      if (pattern.hasDate && !validDate(fields.date)) return Result.fail('is not a valid date');
      if (pattern.hasTime && !validTime(fields.time)) return Result.fail('is not a valid time');
      return lexicalFor(fields, pattern, base);
    },
  });
