/**
 * Numeric formats (Tabular Data Model §Formats for numeric types): the UAX 35
 * number-pattern subset (`0`, `#`, the decimal and group characters, `E`,
 * `+`, `-`, `%` and `‰`), the pattern-less grouped form, and the decimal
 * arithmetic that applies percent and per-mille signs.
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';

/**
 * A parsed number format pattern.
 *
 * @internal
 */
export interface Pattern {
  readonly prefix: string;
  readonly suffix: string;
  /** Minimum integer digits (the `0`s of the integer part). */
  readonly minInt: number;
  /** Primary and secondary grouping sizes, if the integer part is grouped. */
  readonly grouping: Option.Option<readonly [number, number]>;
  readonly minFrac: number;
  readonly maxFrac: number;
  /** The fraction's grouping size, if it is grouped. */
  readonly fracGrouping: Option.Option<number>;
  readonly hasDecimal: boolean;
  /** Minimum exponent digits, if the pattern has an exponent. */
  readonly exponent: Option.Option<number>;
}

/**
 * A numeric format: an optional pattern and the decimal and group characters.
 *
 * @internal
 */
export interface NumberFormat {
  readonly pattern: Option.Option<Pattern>;
  readonly decimalChar: string;
  readonly groupChar: Option.Option<string>;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const count = (s: string, c: string): number =>
  Arr.length(Arr.filter(Array.from(s), (x) => x === c));

/** Primary and secondary grouping sizes of a grouped integer pattern (`#,##,#00` → 3, 2). */
const integerGrouping = (
  segments: ReadonlyArray<string>,
): Option.Option<Option.Option<readonly [number, number]>> =>
  Arr.match(Arr.reverse(segments), {
    onEmpty: () => Option.some(Option.none()),
    onNonEmpty: ([primary, ...rest]) =>
      Arr.match(rest, {
        onEmpty: () => Option.some(Option.none()),
        onNonEmpty: ([secondary, ...others]) => {
          const size = Arr.isReadonlyArrayNonEmpty(others) ? secondary.length : primary.length;
          return primary === '' || size === 0
            ? Option.none()
            : Option.some(Option.some([primary.length, size] as const));
        },
      }),
  });

/** The grouping size of a grouped fraction pattern (`0.0#,#` → 2). */
const fractionGrouping = (segments: ReadonlyArray<string>): Option.Option<Option.Option<number>> =>
  Arr.match(segments, {
    onEmpty: () => Option.some(Option.none()),
    onNonEmpty: ([first, ...rest]) =>
      !Arr.isReadonlyArrayNonEmpty(rest)
        ? Option.some(Option.none())
        : first === ''
          ? Option.none()
          : Option.some(Option.some(first.length)),
  });

/** Whether `#`s precede the `0`s of the integer part and follow those of the fraction. */
const wellOrdered = (int: string, frac: string): boolean =>
  !/0[^0]*#/.test(int) && !/#[^#]*0/.test(frac);

/**
 * Parses a number format pattern; `None` when it uses anything this
 * implementation does not recognise.
 *
 * @internal
 */
export const parsePattern = (
  pattern: string,
  decimalChar: string,
  groupChar: string,
): Option.Option<Pattern> => {
  const g = escape(groupChar);
  const re = new RegExp(
    `^([+\\-%‰]*)([#0${g}]*[#0])(?:${escape(decimalChar)}([#0${g}]*))?(?:E(\\+?)([#0]+))?([%‰]*)$`,
    'u',
  );
  return Option.flatMap(Option.fromNullishOr(re.exec(pattern)), (m) => {
    const int = m[2] ?? '';
    const frac = Option.fromNullishOr(m[3]);
    const fracText = Option.getOrElse(frac, () => '');
    const fracDigits = digitsOf(fracText, groupChar);
    const affixes = (m[1] ?? '') + (m[6] ?? '');
    if (!wellOrdered(digitsOf(int, groupChar), fracDigits)) return Option.none();
    if (count(affixes, '%') + count(affixes, '‰') > 1) return Option.none();
    return Option.map(
      Option.all([
        integerGrouping(int.split(groupChar)),
        fractionGrouping(Option.isSome(frac) ? fracText.split(groupChar) : []),
      ]),
      ([grouping, fracGrouping]): Pattern => ({
        prefix: m[1] ?? '',
        suffix: m[6] ?? '',
        minInt: count(int, '0'),
        grouping,
        minFrac: count(fracDigits, '0'),
        maxFrac: fracDigits.length,
        fracGrouping,
        hasDecimal: Option.isSome(frac),
        exponent: Option.map(Option.fromNullishOr(m[5]), (e) => count(e, '0')),
      }),
    );
  });
};

/**
 * The parts of a number read from a cell.
 *
 * @internal
 */
export interface Parsed {
  /** The lexical form, with group characters removed and a `.` decimal point. */
  readonly lexical: string;
  readonly hasDecimal: boolean;
  readonly hasExponent: boolean;
  readonly special: boolean;
}

const checkIntegerGrouping = (
  int: string,
  groupChar: string,
  grouping: Option.Option<readonly [number, number]>,
): boolean => {
  const groups = int.split(groupChar);
  const ungrouped = !int.includes(groupChar);
  return Option.match(grouping, {
    onNone: () => ungrouped,
    onSome: ([primary, secondary]) => {
      if (ungrouped) return int.length <= primary;
      const reversed = Arr.reverse(groups);
      const last = Arr.length(reversed) - 1;
      return Arr.every(reversed, (group, i) => {
        const size = i === 0 ? primary : secondary;
        return i === last ? group !== '' && group.length <= size : group.length === size;
      });
    },
  });
};

const checkFractionGrouping = (
  frac: string,
  groupChar: string,
  grouping: Option.Option<number>,
): boolean => {
  const groups = frac.split(groupChar);
  return Option.match(grouping, {
    onNone: () => !frac.includes(groupChar),
    onSome: (size) =>
      Arr.every(groups, (group, i) =>
        i === Arr.length(groups) - 1 ? group !== '' && group.length <= size : group.length === size,
      ),
  });
};

const digitsOf = (s: string, groupChar: string): string => s.split(groupChar).join('');

/**
 * Shifts the decimal point of a decimal lexical form `places` to the left
 * (dividing by 10^places), returning a canonical decimal.
 *
 * @internal
 */
export const shiftDecimal = (lexical: string, places: number): string => {
  const negative = lexical.startsWith('-');
  const unsigned = lexical.replace(/^[+-]/, '');
  const [int = '', frac = ''] = unsigned.split('.');
  const padded = int.padStart(places + 1, '0');
  const newInt = padded.slice(0, padded.length - places).replace(/^0+(?=\d)/, '');
  const newFrac = (padded.slice(padded.length - places) + frac).replace(/0+$/, '');
  const body = newFrac === '' ? newInt : `${newInt}.${newFrac}`;
  return negative && /[1-9]/.test(body) ? `-${body}` : body;
};

const SPECIAL = /^(?:NaN|INF|-INF)$/;

interface Parts {
  readonly sign: string;
  readonly int: string;
  readonly frac: Option.Option<string>;
  readonly exp: Option.Option<string>;
}

/** The checks a number read with a pattern must pass, each failing with a reason. */
const patternChecks: ReadonlyArray<
  (parts: Parts, pattern: Pattern, g: string) => Option.Option<string>
> = [
  ({ int, frac }) =>
    int === '' && Option.isNone(frac) ? Option.some('does not match the pattern') : Option.none(),
  ({ int }, _, g) =>
    int.endsWith(g) || int.includes(g + g)
      ? Option.some('does not match the pattern')
      : Option.none(),
  ({ int }, pattern, g) =>
    checkIntegerGrouping(int, g, pattern.grouping)
      ? Option.none()
      : Option.some('does not match the grouping of the pattern'),
  ({ int }, pattern, g) =>
    digitsOf(int, g).length < pattern.minInt
      ? Option.some('has fewer integer digits than the pattern')
      : Option.none(),
  ({ frac }, pattern) =>
    Option.isSome(frac) && !pattern.hasDecimal
      ? Option.some('has a fraction the pattern does not allow')
      : Option.none(),
  ({ frac }, pattern, g) =>
    Option.exists(
      frac,
      (f) =>
        digitsOf(f, g).length > pattern.maxFrac ||
        !checkFractionGrouping(f, g, pattern.fracGrouping),
    )
      ? Option.some('does not match the fraction of the pattern')
      : Option.none(),
  ({ frac }, pattern, g) =>
    digitsOf(
      Option.getOrElse(frac, () => ''),
      g,
    ).length < pattern.minFrac
      ? Option.some('has fewer fraction digits than the pattern')
      : Option.none(),
  ({ exp }, pattern) =>
    Option.match(pattern.exponent, {
      onNone: () =>
        Option.isSome(exp)
          ? Option.some('has an exponent the pattern does not allow')
          : Option.none(),
      onSome: (min) =>
        Option.exists(exp, (e) => e.replace(/^[+-]/, '').length >= min)
          ? Option.none()
          : Option.some('does not have the exponent digits of the pattern'),
    }),
];

const partsOf = (body: string, format: NumberFormat, g: string): Option.Option<Parts> => {
  const re = new RegExp(
    `^([+-]?)(\\d[\\d${escape(g)}]*)?(?:${escape(format.decimalChar)}([\\d${escape(g)}]*))?(?:E([+-]?\\d+))?$`,
    'u',
  );
  return Option.map(Option.fromNullishOr(re.exec(body)), (m) => ({
    sign: m[1] ?? '',
    int: m[2] ?? '',
    frac: Option.fromNullishOr(m[3]),
    exp: Option.fromNullishOr(m[4]),
  }));
};

const parseWithPattern = (
  text: string,
  format: NumberFormat,
  pattern: Pattern,
): Result.Result<Parsed, string> => {
  const g = Option.getOrElse(format.groupChar, () => ',');
  const prefix = pattern.prefix.replace(/[+-]/g, '');
  const suffix = pattern.suffix;
  const parts =
    text.startsWith(prefix) && text.endsWith(suffix)
      ? partsOf(text.slice(prefix.length, text.length - suffix.length), format, g)
      : Option.none();
  return Option.match(parts, {
    onNone: () => Result.fail('does not match the pattern'),
    onSome: (p) =>
      Option.match(
        Arr.findFirst(patternChecks, (check) => Option.isSome(check(p, pattern, g))).pipe(
          Option.flatMap((check) => check(p, pattern, g)),
        ),
        {
          onSome: Result.fail,
          onNone: () =>
            Result.succeed(
              finish(
                p.sign,
                digitsOf(p.int, g),
                Option.map(p.frac, (f) => digitsOf(f, g)),
                p.exp,
                text,
              ),
            ),
        },
      ),
  });
};

const finish = (
  sign: string,
  int: string,
  frac: Option.Option<string>,
  exp: Option.Option<string>,
  text: string,
): Parsed => {
  const mantissa = `${sign}${int === '' ? '0' : int}${Option.match(frac, { onNone: () => '', onSome: (f) => `.${f}` })}`;
  const plain = Option.match(exp, { onNone: () => mantissa, onSome: (e) => `${mantissa}e${e}` });
  const percent = text.includes('%');
  const permille = text.includes('‰');
  const lexical =
    percent || permille
      ? Option.isNone(exp)
        ? shiftDecimal(mantissa, percent ? 2 : 3)
        : String(Number(plain) / (percent ? 100 : 1000))
      : plain;
  return {
    lexical,
    hasDecimal: Option.isSome(frac),
    hasExponent: Option.isSome(exp),
    special: false,
  };
};

const parseWithoutPattern = (text: string, format: NumberFormat): Result.Result<Parsed, string> => {
  if (SPECIAL.test(text))
    return Result.succeed({ lexical: text, hasDecimal: false, hasExponent: false, special: true });
  const g = Option.getOrUndefined(format.groupChar);
  const d = format.decimalChar;
  const groupClass = g === undefined ? '' : escape(g);
  const re = new RegExp(
    `^([+-]?)(\\d(?:\\d|${g === undefined ? '(?!)' : groupClass})*)?(?:${escape(d)}(\\d+))?(?:[Ee]([+-]?\\d+))?([%‰]?)$`,
    'u',
  );
  const m = re.exec(text);
  if (m === null || (m[2] === undefined && m[3] === undefined))
    return Result.fail('is not a number');
  const int = m[2] ?? '';
  if (g !== undefined && (int.includes(g + g) || int.endsWith(g)))
    return Result.fail('contains consecutive group characters');
  return Result.succeed(
    finish(
      m[1] ?? '',
      g === undefined ? int : digitsOf(int, g),
      Option.fromNullishOr(m[3]),
      Option.fromNullishOr(m[4]),
      text,
    ),
  );
};

/**
 * Parses a cell string with a numeric format.
 *
 * @internal
 */
export const parse = (text: string, format: NumberFormat): Result.Result<Parsed, string> =>
  Option.match(format.pattern, {
    onNone: () => parseWithoutPattern(text, format),
    onSome: (pattern) =>
      SPECIAL.test(text)
        ? Result.succeed({ lexical: text, hasDecimal: false, hasExponent: false, special: true })
        : parseWithPattern(text, format, pattern),
  });
