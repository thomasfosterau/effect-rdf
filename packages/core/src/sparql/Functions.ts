/**
 * SPARQL built-in functions, XSD casts and the registry of extension
 * functions.
 *
 * Extension functions are plain synchronous functions from argument terms
 * to a term, registered by IRI and passed to the engine (see
 * `Engine.EngineOptions.functions`). They signal type errors by throwing
 * `ExpressionError` (or calling `Functions.error`).
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as BigDecimal from 'effect/BigDecimal';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Iri from '../Iri.ts';
import * as Term from '../Term.ts';
import * as Xsd from '../Xsd.ts';
import type * as Ast from './Ast.ts';
import type { Bindings } from './Bindings.ts';
import * as Hash from './internal/hash.ts';
import * as Regex from '../internal/regex.ts';
import * as StringMap from './internal/stringMap.ts';
import * as V from './internal/values.ts';

/**
 * An expression evaluation error (a SPARQL "type error"): unbound
 * variables, wrong argument types, division by zero, …
 *
 * @since 0.1.0
 * @category errors
 */
export class ExpressionError extends Schema.TaggedError<
  ExpressionError,
  { readonly brand: unique symbol }
>()('ExpressionError', {
  message: Schema.String,
}) {}

/**
 * Signals an expression error from inside a function implementation.
 *
 * @since 0.1.0
 * @category errors
 */
export const error = (message: string): never => V.fail(message);

/**
 * The per-query context of expression evaluation.
 *
 * @since 0.1.0
 * @category models
 */
export interface FunctionContext {
  /** The value of `NOW()`: constant for the whole query. */
  readonly now: Date;
  /** The base IRI used by `IRI()` / `URI()`. */
  readonly baseIri?: string | undefined;
  /** A random number generator in [0, 1). */
  readonly random: () => number;
  /** Returns the blank node for `BNODE(label)` within the current solution. */
  readonly blankNode: (label: string | undefined, solution: Bindings) => Term.BlankNode;
}

/**
 * An extension function: receives the evaluated arguments.
 *
 * @since 0.1.0
 * @category models
 */
export type ExtensionFunction = (
  args: ReadonlyArray<Term.GroundTerm>,
  context: FunctionContext,
) => Term.GroundTerm;

/**
 * A registry of extension functions keyed by IRI.
 *
 * @since 0.1.0
 * @category models
 */
export type Registry = ReadonlyMap<string, ExtensionFunction>;

/**
 * Creates a registry from a record of IRI → function.
 *
 * @since 0.1.0
 * @category constructors
 */
export const registry = (functions: Readonly<Record<string, ExtensionFunction>>): Registry =>
  StringMap.fromEntries(Record.toEntries(functions));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** An argument position: absent when the call has fewer arguments (the array type cannot say). */
type Slot<T extends Term.Term = Term.Term> = T | undefined;

/** The term in a position, failing when the call has no such argument. */
const arg = <T extends Term.Term>(t: Slot<T>): T => t ?? V.fail('Missing argument');

const literalArg = (t: Slot): Term.Literal => {
  const x = arg(t);
  return Term.isLiteral(x) ? x : V.fail('Expected a literal');
};

const stringArg = (t: Slot): Term.Literal => {
  const x = arg(t);
  return V.isStringLiteral(x) ? x : V.fail('Expected a string literal');
};

const simpleArg = (t: Slot): Term.Literal => {
  const x = arg(t);
  return V.isSimpleString(x) ? x : V.fail('Expected a simple literal');
};

/** Argument compatibility (SPARQL 1.1 §17.4.3.1.2). */
const compatible = (a: Term.Literal, b: Term.Literal): boolean =>
  b.language === '' || (a.language === b.language && a.direction === b.direction);

const codepoints = (s: string): Array<string> => Array.from(s);

const intLiteral = (n: number | bigint): Term.Literal =>
  new Term.Literal(BigInt(n).toString(), V.dt.integer);

const numArg = (t: Slot): V.Num => V.requireNum(arg(t));

const roundNum = (
  t: Slot,
  mode: 'ceil' | 'floor' | 'half-ceil',
  fn: (x: number) => number,
): Term.Literal => {
  const n = numArg(t);
  return V.numLiteral(
    n.kind === 0
      ? n
      : n.kind === 1
        ? { kind: 1, v: BigDecimal.round(n.v, { scale: 0, mode }) }
        : n.kind === 2
          ? { kind: 2, v: fn(n.v) }
          : { kind: 3, v: fn(n.v) },
  );
};

const xpathRound = (x: number): number => {
  if (!Number.isFinite(x) || Object.is(x, -0)) return x;
  const r = Math.floor(x + 0.5);
  return r === 0 && x < 0 ? -0 : r;
};

/**
 * Compiles an XPath regular expression with XPath flags. Matching it takes
 * time linear in the string (`internal/regex.ts`), whatever the pattern.
 */
const compileRegex = (pattern: string, flags: string): Regex.Regex =>
  Result.getOrElse(Regex.compileCached(pattern, 'xpath', flags), (reason) =>
    V.fail(`Invalid regular expression: ${reason}`),
  );

/** A search that used up its step budget (a pattern with back-references or lookahead) is an error. */
const exhausted = (): never => V.fail('Regular expression exceeded its step budget');

/** The flags argument of `REGEX` / `REPLACE`, absent beyond the arguments given. */
const regexFlags = (args: BuiltInArgs, i: number): string => {
  const t = Option.fromUndefinedOr(args[i]);
  return Option.isSome(t) ? simpleArg(t.value).value : '';
};

const parseDateParts = (t: Slot) => {
  const lit = literalArg(t);
  const d = lit.datatype.value;
  if (
    !(
      d === `${V.XSD}dateTime` ||
      d === `${V.XSD}date` ||
      d === `${V.XSD}time` ||
      d === `${V.XSD}dateTimeStamp`
    ) ||
    !Xsd.isValidLexical(d, lit.value)
  ) {
    return V.fail('Expected an xsd:dateTime');
  }
  const m =
    /^(?:(-?\d{4,})-(\d\d)-(\d\d))?T?(?:(\d\d):(\d\d):(\d\d(?:\.\d+)?))?(Z|[+-]\d\d:\d\d)?$/.exec(
      lit.value,
    );
  if (m === null) return V.fail('Invalid date/time');
  return {
    year: m[1],
    month: m[2],
    day: m[3],
    hours: m[4],
    minutes: m[5],
    seconds: m[6],
    tz: m[7],
  };
};

const timezoneDuration = (tz: string): string => {
  if (tz === 'Z') return 'PT0S';
  const sign = tz.startsWith('-') ? '-' : '';
  const h = Number(tz.slice(1, 3));
  const mi = Number(tz.slice(4, 6));
  if (h === 0 && mi === 0) return 'PT0S';
  return `${sign}PT${h > 0 ? `${h}H` : ''}${mi > 0 ? `${mi}M` : ''}`;
};

const encodeForUri = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const uuid = (random: () => number): string => {
  // Version 4 (byte 6) and the RFC 4122 variant (byte 8).
  const bytes = Array.from({ length: 16 }, (_, i) => {
    const b = Math.floor(random() * 256);
    return i === 6 ? (b & 0x0f) | 0x40 : i === 8 ? (b & 0x3f) | 0x80 : b;
  });
  const h = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const LANG_TAG = /^[a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*$/;

// -----------------------------------------------------------------------------
// Built-in functions (strict: all arguments evaluated, errors propagate)
// -----------------------------------------------------------------------------

/**
 * The evaluated arguments of a built-in function. Positions beyond the
 * function's arity are absent (`undefined` under `noUncheckedIndexedAccess`).
 *
 * @since 0.1.0
 * @category models
 */
export type BuiltInArgs = ReadonlyArray<Term.GroundTerm>;

/**
 * Implementation of a strict built-in function.
 *
 * @since 0.1.0
 * @category models
 */
export type BuiltIn = (
  args: BuiltInArgs,
  context: FunctionContext,
  solution: Bindings,
) => Term.GroundTerm;

/** The two string arguments of a string function, which must be compatible (§17.4.3.1.2). */
const compatibleStrings = ([a, b]: BuiltInArgs): readonly [Term.Literal, Term.Literal] => {
  const x = stringArg(a);
  const y = stringArg(b);
  return compatible(x, y) ? [x, y] : V.fail('Incompatible arguments');
};

/**
 * `STRBEFORE` / `STRAFTER`: `part` of the first string around the first
 * occurrence of the second, or the empty simple literal if there is none.
 */
const around = (
  args: BuiltInArgs,
  part: (value: string, search: string, index: number) => string,
): Term.Literal => {
  const [x, y] = compatibleStrings(args);
  const i = x.value.indexOf(y.value);
  return i === -1 ? V.simple('') : V.stringLike(part(x.value, y.value, i), x);
};

const iriFn: BuiltIn = ([a], ctx) => {
  if (Term.isNamedNode(a)) return a;
  const s = simpleArg(a).value;
  return Term.namedNode(ctx.baseIri !== undefined ? Iri.resolve(s, ctx.baseIri) : s);
};

const hashFn =
  (f: (s: string) => string): BuiltIn =>
  ([a]) =>
    V.simple(f(simpleArg(a).value));

/**
 * The strict built-in functions, keyed by canonical name. Functional forms
 * (`BOUND`, `IF`, `COALESCE`, `&&`, `||`, `IN`, `EXISTS`) are handled by the
 * expression evaluator.
 *
 * @since 0.1.0
 * @category built-ins
 */
export const builtIns: Partial<Record<Ast.BuiltInName, BuiltIn>> = {
  STR: ([a]) =>
    Term.isNamedNode(a) || Term.isLiteral(a)
      ? V.simple(a.value)
      : V.fail('STR of a blank node or triple term'),
  LANG: ([a]) => V.simple(literalArg(a).language),
  LANGDIR: ([a]) => V.simple(literalArg(a).direction ?? ''),
  LANGMATCHES: ([tag, range]) => {
    const t = simpleArg(tag).value.toLowerCase();
    const r = simpleArg(range).value.toLowerCase();
    if (r === '*') return V.bool(t !== '');
    return V.bool(t === r || t.startsWith(`${r}-`));
  },
  DATATYPE: ([a]) => literalArg(a).datatype,
  IRI: iriFn,
  URI: iriFn,
  BNODE: (args, ctx, sol) =>
    ctx.blankNode(Arr.isReadonlyArrayEmpty(args) ? undefined : simpleArg(args[0]).value, sol),
  RAND: (_, ctx) => V.numLiteral({ kind: 3, v: ctx.random() }),
  ABS: ([a]) => {
    const n = numArg(a);
    return V.numLiteral(
      n.kind === 0
        ? { kind: 0, v: n.v < 0n ? -n.v : n.v }
        : n.kind === 1
          ? { kind: 1, v: BigDecimal.abs(n.v) }
          : n.kind === 2
            ? { kind: 2, v: Math.abs(n.v) }
            : { kind: 3, v: Math.abs(n.v) },
    );
  },
  CEIL: ([a]) => roundNum(a, 'ceil', Math.ceil),
  FLOOR: ([a]) => roundNum(a, 'floor', Math.floor),
  ROUND: ([a]) => roundNum(a, 'half-ceil', xpathRound),
  CONCAT: (args) => {
    const lits = args.map(stringArg);
    const first = lits[0];
    const sameLang =
      first !== undefined &&
      first.language !== '' &&
      lits.every((l) => l.language === first.language && l.direction === first.direction);
    const value = lits.map((l) => l.value).join('');
    return sameLang ? V.stringLike(value, first) : V.simple(value);
  },
  SUBSTR: ([s, start, len]) => {
    const str = stringArg(s);
    const chars = codepoints(str.value);
    const st = V.toNumber(numArg(start));
    const from = xpathRound(st);
    let to = Infinity;
    if (len !== undefined) to = from + xpathRound(V.toNumber(numArg(len)));
    if (Number.isNaN(from) || Number.isNaN(to)) return V.stringLike('', str);
    const out = chars.filter((_, i) => i + 1 >= from && i + 1 < to).join('');
    return V.stringLike(out, str);
  },
  STRLEN: ([a]) => intLiteral(codepoints(stringArg(a).value).length),
  REPLACE: (args) => {
    const [s, pattern, replacement] = args;
    const str = stringArg(s);
    const re = compileRegex(simpleArg(pattern).value, regexFlags(args, 3));
    if (Regex.test(re, '')) return V.fail('REPLACE pattern matches the empty string');
    const repl = simpleArg(replacement).value.replace(/\\(\$|\\)|\$/g, (m, esc) =>
      esc === '$' ? '$$' : esc === '\\' ? '\\' : m,
    );
    const replaced = Regex.replaceAll(re, str.value, (captures) =>
      Regex.expand(re, repl, str.value, captures),
    );
    return V.stringLike(Option.getOrElse(replaced, exhausted), str);
  },
  UCASE: ([a]) => {
    const s = stringArg(a);
    return V.stringLike(s.value.toUpperCase(), s);
  },
  LCASE: ([a]) => {
    const s = stringArg(a);
    return V.stringLike(s.value.toLowerCase(), s);
  },
  ENCODE_FOR_URI: ([a]) => V.simple(encodeForUri(stringArg(a).value)),
  CONTAINS: (args) => {
    const [x, y] = compatibleStrings(args);
    return V.bool(x.value.includes(y.value));
  },
  STRSTARTS: (args) => {
    const [x, y] = compatibleStrings(args);
    return V.bool(x.value.startsWith(y.value));
  },
  STRENDS: (args) => {
    const [x, y] = compatibleStrings(args);
    return V.bool(x.value.endsWith(y.value));
  },
  STRBEFORE: (args) => around(args, (x, _y, i) => x.slice(0, i)),
  STRAFTER: (args) => around(args, (x, y, i) => x.slice(i + y.length)),
  YEAR: ([a]) => {
    const p = parseDateParts(a);
    return p.year !== undefined ? intLiteral(BigInt(p.year)) : V.fail('No year');
  },
  MONTH: ([a]) => {
    const p = parseDateParts(a);
    return p.month !== undefined ? intLiteral(Number(p.month)) : V.fail('No month');
  },
  DAY: ([a]) => {
    const p = parseDateParts(a);
    return p.day !== undefined ? intLiteral(Number(p.day)) : V.fail('No day');
  },
  HOURS: ([a]) => {
    const p = parseDateParts(a);
    return p.hours !== undefined ? intLiteral(Number(p.hours)) : V.fail('No hours');
  },
  MINUTES: ([a]) => {
    const p = parseDateParts(a);
    return p.minutes !== undefined ? intLiteral(Number(p.minutes)) : V.fail('No minutes');
  },
  SECONDS: ([a]) => {
    const p = parseDateParts(a);
    if (p.seconds === undefined) return V.fail('No seconds');
    return V.numLiteral({ kind: 1, v: BigDecimal.fromStringUnsafe(p.seconds) });
  },
  TIMEZONE: ([a]) => {
    const p = parseDateParts(a);
    if (p.tz === undefined) return V.fail('No timezone');
    return new Term.Literal(timezoneDuration(p.tz), V.dt.dayTimeDuration);
  },
  TZ: ([a]) => V.simple(parseDateParts(a).tz ?? ''),
  NOW: (_, ctx) => new Term.Literal(ctx.now.toISOString(), V.dt.dateTime),
  UUID: (_, ctx) => Term.namedNode(`urn:uuid:${uuid(ctx.random)}`),
  STRUUID: (_, ctx) => V.simple(uuid(ctx.random)),
  MD5: hashFn(Hash.md5),
  SHA1: hashFn(Hash.sha1),
  SHA256: hashFn(Hash.sha256),
  SHA384: hashFn(Hash.sha384),
  SHA512: hashFn(Hash.sha512),
  STRLANG: ([s, lang]) => {
    const lex = simpleArg(s).value;
    const tag = simpleArg(lang).value;
    if (!LANG_TAG.test(tag)) return V.fail('Invalid language tag');
    return Term.literal(lex, tag);
  },
  STRLANGDIR: ([s, lang, dir]) => {
    const lex = simpleArg(s).value;
    const tag = simpleArg(lang).value;
    const d = simpleArg(dir).value;
    if (!LANG_TAG.test(tag)) return V.fail('Invalid language tag');
    if (d !== 'ltr' && d !== 'rtl') return V.fail('Invalid base direction');
    return Term.literal(lex, { language: tag, direction: d });
  },
  STRDT: ([s, datatype]) => {
    const lex = simpleArg(s).value;
    if (!Term.isNamedNode(datatype)) return V.fail('STRDT requires an IRI');
    if (datatype.value === V.dt.langString.value || datatype.value === V.dt.dirLangString.value) {
      return V.fail('STRDT cannot create language-tagged strings');
    }
    return new Term.Literal(lex, datatype);
  },
  SAMETERM: ([a, b]) => V.bool(arg(a).key === arg(b).key),
  ISIRI: ([a]) => V.bool(Term.isNamedNode(a)),
  ISURI: ([a]) => V.bool(Term.isNamedNode(a)),
  ISBLANK: ([a]) => V.bool(Term.isBlankNode(a)),
  ISLITERAL: ([a]) => V.bool(Term.isLiteral(a)),
  ISNUMERIC: ([a]) => V.bool(V.isNumeric(arg(a))),
  HASLANG: ([a]) => V.bool(Term.isLiteral(a) && a.language !== ''),
  HASLANGDIR: ([a]) => V.bool(Term.isLiteral(a) && a.direction !== undefined),
  REGEX: (args) => {
    const [s, pattern] = args;
    const str = stringArg(s);
    const re = compileRegex(simpleArg(pattern).value, regexFlags(args, 2));
    const outcome = Regex.search(re, str.value);
    return outcome === Regex.EXHAUSTED ? exhausted() : V.bool(outcome === Regex.MATCHED);
  },
  ISTRIPLE: ([a]) => V.bool(Term.isTriple(a)),
  TRIPLE: ([s, p, o]) => {
    if (!Term.isNamedNode(s) && !Term.isBlankNode(s)) {
      return V.fail('TRIPLE subject must be an IRI or blank node');
    }
    if (!Term.isNamedNode(p)) return V.fail('TRIPLE predicate must be an IRI');
    return Term.triple(s, p, arg(o));
  },
  SUBJECT: ([a]) => (Term.isTriple(a) ? a.subject : V.fail('Not a triple term')),
  PREDICATE: ([a]) => (Term.isTriple(a) ? a.predicate : V.fail('Not a triple term')),
  OBJECT: ([a]) => (Term.isTriple(a) ? a.object : V.fail('Not a triple term')),
};

// -----------------------------------------------------------------------------
// Casts
// -----------------------------------------------------------------------------

const XSD_INTEGER_TYPE_NAMES: ReadonlyArray<string> = [
  'integer',
  'long',
  'int',
  'short',
  'byte',
  'nonNegativeInteger',
  'positiveInteger',
  'nonPositiveInteger',
  'negativeInteger',
  'unsignedLong',
  'unsignedInt',
  'unsignedShort',
  'unsignedByte',
].map((t) => V.XSD + t);
const XSD_INTEGER_TYPES = StringMap.setOf(XSD_INTEGER_TYPE_NAMES);

/** The XPath string form of a float/double (`fn:string`). */
const xpathDoubleString = (v: number): string => {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'INF' : '-INF';
  const abs = Math.abs(v);
  if (abs === 0) return Object.is(v, -0) ? '-0' : '0';
  if (abs >= 1e-6 && abs < 1e6) return String(v);
  return Xsd.canonicalDouble(v);
};

const castString = (a: Term.Term): string => {
  if (Term.isNamedNode(a)) return a.value;
  const l = literalArg(a);
  const numeric = V.numeric(l);
  if (Option.isSome(numeric)) {
    const n = numeric.value;
    if (n.kind === 0) return n.v.toString();
    if (n.kind === 1) {
      const s = Xsd.canonicalDecimal(n.v);
      return s.endsWith('.0') ? s.slice(0, -2) : s;
    }
    return xpathDoubleString(n.v);
  }
  if (l.datatype.value === V.dt.boolean.value && Xsd.isValidLexical(l.datatype.value, l.value)) {
    return l.value === 'true' || l.value === '1' ? 'true' : 'false';
  }
  return l.value;
};

/** A literal being cast, with the readings of it the casts share. */
interface CastSource {
  readonly target: string;
  readonly dtNode: Term.NamedNode;
  readonly l: Term.Literal;
  readonly numeric: Option.Option<V.Num>;
  /** Whether it is a valid `xsd:boolean`, and if so its value. */
  readonly isBool: boolean;
  readonly boolValue: boolean;
  /** Whether it is a simple literal, and its trimmed lexical form. */
  readonly fromString: boolean;
  readonly lexical: string;
}

const castBoolean = ({ l, numeric, isBool, boolValue, fromString, lexical }: CastSource) => {
  if (isBool) return V.bool(boolValue);
  if (Option.isSome(numeric)) return V.bool(V.ebv(l));
  if (fromString && /^(true|false|1|0)$/.test(lexical)) {
    return V.bool(lexical === 'true' || lexical === '1');
  }
  return V.fail('Invalid boolean cast');
};

const integerOf = (n: V.Num): bigint => {
  if (n.kind === 0) return n.v;
  if (n.kind === 1) return BigInt(BigDecimal.format(BigDecimal.truncate(n.v)).split('.')[0] ?? '0');
  if (!Number.isFinite(n.v)) return V.fail('Cannot cast NaN/INF to integer');
  return BigInt(Math.trunc(n.v));
};

const castInteger = (source: CastSource): Term.Literal => {
  const { target, dtNode, numeric, isBool, boolValue, fromString, lexical } = source;
  const value: bigint = isBool
    ? boolValue
      ? 1n
      : 0n
    : Option.isSome(numeric)
      ? integerOf(numeric.value)
      : fromString && /^[+-]?\d+$/.test(lexical)
        ? BigInt(lexical)
        : V.fail('Invalid integer cast');
  const lit = new Term.Literal(value.toString(), dtNode);
  return Xsd.isValidLexical(target, lit.value) ? lit : V.fail('Integer out of range');
};

const castDecimal = ({ numeric, isBool, boolValue, fromString, lexical }: CastSource) => {
  if (isBool) return V.numLiteral({ kind: 1, v: BigDecimal.fromBigInt(boolValue ? 1n : 0n) });
  if (Option.isSome(numeric)) {
    const n = numeric.value;
    if (n.kind === 0 || n.kind === 1) return V.numLiteral({ kind: 1, v: V.toDecimal(n) });
    if (!Number.isFinite(n.v)) return V.fail('Cannot cast NaN/INF to decimal');
    return V.numLiteral({ kind: 1, v: BigDecimal.fromNumberUnsafe(n.v) });
  }
  if (fromString && /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(lexical)) {
    return V.numLiteral({ kind: 1, v: BigDecimal.fromStringUnsafe(lexical.replace(/\.$/, '')) });
  }
  return V.fail('Invalid decimal cast');
};

const floatingOf = (lexical: string): number =>
  lexical === 'INF' || lexical === '+INF'
    ? Infinity
    : lexical === '-INF'
      ? -Infinity
      : Number(lexical);

const castFloating = (source: CastSource): Term.Literal => {
  const { target, numeric, isBool, boolValue, fromString, lexical } = source;
  const kind = target === V.dt.double.value ? 3 : 2;
  const value = isBool
    ? boolValue
      ? 1
      : 0
    : Option.isSome(numeric)
      ? V.toNumber(numeric.value)
      : fromString && Xsd.isValidLexical(target, lexical)
        ? floatingOf(lexical)
        : V.fail('Invalid floating point cast');
  return V.numLiteral({ kind, v: kind === 2 ? Math.fround(value) : value });
};

const castDateTime = ({ target, dtNode, l, fromString, lexical }: CastSource): Term.Literal => {
  if (l.datatype.value === target && Xsd.isValidLexical(target, l.value)) return l;
  if (l.datatype.value === `${V.XSD}date` && Xsd.isValidLexical(l.datatype.value, l.value)) {
    // A valid `xsd:date` always matches.
    const m = /^(-?\d+-\d\d-\d\d)(.*)$/.exec(l.value);
    if (m === null) return V.fail('Invalid date');
    return new Term.Literal(`${m[1]}T00:00:00${m[2]}`, dtNode);
  }
  if (fromString && Xsd.isValidLexical(target, lexical)) return new Term.Literal(lexical, dtNode);
  return V.fail('Invalid dateTime cast');
};

/** Other XSD types: from strings with a valid lexical form, or the same type. */
const castOther = ({ target, dtNode, l, fromString, lexical }: CastSource): Term.Literal => {
  if (l.datatype.value === target) return l;
  if (fromString && Xsd.isValidLexical(target, lexical)) return new Term.Literal(lexical, dtNode);
  return V.fail(`Invalid cast to ${target}`);
};

const castTo = (target: string, a: Term.Term): Term.Literal => {
  if (target === Term.XSD_STRING) {
    if (Term.isLiteral(a) && a.language !== '')
      return V.fail('Cannot cast a language-tagged string');
    return V.simple(castString(a));
  }
  const l = literalArg(a);
  if (l.language !== '') return V.fail('Cannot cast a language-tagged string');
  const isBool =
    l.datatype.value === V.dt.boolean.value && Xsd.isValidLexical(l.datatype.value, l.value);
  const source: CastSource = {
    target,
    dtNode: Term.namedNode(target),
    l,
    numeric: V.numeric(l),
    isBool,
    boolValue: isBool && (l.value === 'true' || l.value === '1'),
    fromString: V.isSimpleString(l),
    lexical: l.value.trim(),
  };
  if (target === V.dt.boolean.value) return castBoolean(source);
  if (XSD_INTEGER_TYPES.has(target)) return castInteger(source);
  if (target === V.dt.decimal.value) return castDecimal(source);
  if (target === V.dt.double.value || target === V.dt.float.value) return castFloating(source);
  if (target === V.dt.dateTime.value) return castDateTime(source);
  return castOther(source);
};

const CASTABLE: ReadonlyMap<string, true> = StringMap.setOf([
  Term.XSD_STRING,
  `${V.XSD}boolean`,
  `${V.XSD}decimal`,
  `${V.XSD}float`,
  `${V.XSD}double`,
  `${V.XSD}dateTime`,
  `${V.XSD}date`,
  `${V.XSD}time`,
  ...XSD_INTEGER_TYPE_NAMES,
]);

/**
 * Whether an IRI is an XSD constructor function (cast) supported by this
 * implementation.
 *
 * @since 0.1.0
 * @category casts
 */
export const isCast = (iri: string): boolean => CASTABLE.has(iri);

/**
 * Casts a term to an XSD datatype (`xsd:integer(?x)` etc.). Throws an
 * expression error when the cast is not possible.
 *
 * @since 0.1.0
 * @category casts
 */
export const cast = (datatype: string, term: Term.GroundTerm): Term.Literal => {
  if (Term.isBlankNode(term) || Term.isTriple(term)) return V.fail('Cannot cast');
  if (Term.isNamedNode(term) && datatype !== Term.XSD_STRING) return V.fail('Cannot cast an IRI');
  return castTo(datatype, term);
};
