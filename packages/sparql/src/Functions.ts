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
import * as BigDecimal from 'effect/BigDecimal';
import * as Data from 'effect/Data';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Xsd from '@thomasfosterau/effect-rdf/Xsd';
import type * as Ast from './Ast.ts';
import type { Bindings } from './Bindings.ts';
import * as Hash from './internal/hash.ts';
import * as V from './internal/values.ts';

/**
 * An expression evaluation error (a SPARQL "type error"): unbound
 * variables, wrong argument types, division by zero, …
 *
 * @since 0.1.0
 * @category errors
 */
export class ExpressionError extends Data.TaggedError('ExpressionError')<{
  readonly message: string;
}> {}

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
  new Map(Object.entries(functions));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const literalArg = (t: Term.Term): Term.Literal =>
  t._tag === 'Literal' ? t : V.fail('Expected a literal');

const stringArg = (t: Term.Term): Term.Literal =>
  V.isStringLiteral(t) ? t : V.fail('Expected a string literal');

const simpleArg = (t: Term.Term): Term.Literal =>
  V.isSimpleString(t) ? t : V.fail('Expected a simple literal');

/** Argument compatibility (SPARQL 1.1 §17.4.3.1.2). */
const compatible = (a: Term.Literal, b: Term.Literal): boolean =>
  b.language === '' || (a.language === b.language && a.direction === b.direction);

const codepoints = (s: string): Array<string> => Array.from(s);

const intLiteral = (n: number | bigint): Term.Literal =>
  new Term.Literal(BigInt(n).toString(), V.dt.integer);

const numArg = (t: Term.Term): V.Num => V.numeric(t) ?? V.fail('Expected a numeric literal');

const roundNum = (
  t: Term.Term,
  mode: 'ceil' | 'floor' | 'half-ceil',
  fn: (x: number) => number,
): Term.Literal => {
  const n = numArg(t);
  switch (n.kind) {
    case 0:
      return V.numLiteral(n);
    case 1:
      return V.numLiteral({ kind: 1, v: BigDecimal.round(n.v, { scale: 0, mode }) });
    default:
      return V.numLiteral({ kind: n.kind, v: fn(n.v) });
  }
};

const xpathRound = (x: number): number => {
  if (!Number.isFinite(x) || Object.is(x, -0)) return x;
  const r = Math.floor(x + 0.5);
  return r === 0 && x < 0 ? -0 : r;
};

const regexCache = new Map<string, RegExp>();

/** Compiles an XPath regular expression with XPath flags to a JS RegExp. */
export const compileRegex = (pattern: string, flags: string, global = false): RegExp => {
  const key = `${global ? 'g' : ''}${flags}/${pattern}`;
  const cached = regexCache.get(key);
  if (cached !== undefined) return cached;
  let source = pattern;
  let jsFlags = global ? 'g' : '';
  for (const f of flags) {
    switch (f) {
      case 'i':
      case 's':
      case 'm':
        if (!jsFlags.includes(f)) jsFlags += f;
        break;
      case 'x':
        source = source.replace(/[\t\n\r ]/g, '');
        break;
      case 'q':
        source = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        break;
      default:
        return V.fail(`Invalid regex flag '${f}'`);
    }
  }
  let re: RegExp;
  try {
    re = new RegExp(source, `${jsFlags}u`);
  } catch {
    try {
      re = new RegExp(source, jsFlags);
    } catch {
      return V.fail('Invalid regular expression');
    }
  }
  if (regexCache.size > 1000) regexCache.clear();
  regexCache.set(key, re);
  return re;
};

const regexFlags = (t: Term.Term | undefined): string =>
  t === undefined ? '' : simpleArg(t).value;

const parseDateParts = (t: Term.Term) => {
  const lit = literalArg(t);
  const d = lit.datatype.value;
  if (
    !(d === `${V.XSD}dateTime` || d === `${V.XSD}date` || d === `${V.XSD}time` || d === `${V.XSD}dateTimeStamp`) ||
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
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const uuid = (random: () => number): string => {
  const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const LANG_TAG = /^[a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*$/;

// -----------------------------------------------------------------------------
// Built-in functions (strict: all arguments evaluated, errors propagate)
// -----------------------------------------------------------------------------

/**
 * Implementation of a strict built-in function.
 *
 * @since 0.1.0
 * @category models
 */
export type BuiltIn = (
  args: ReadonlyArray<Term.GroundTerm>,
  context: FunctionContext,
  solution: Bindings,
) => Term.GroundTerm;

const hashFn =
  (f: (s: string) => string): BuiltIn =>
  ([a]) =>
    V.simple(f(simpleArg(a!).value));

/**
 * The strict built-in functions, keyed by canonical name. Functional forms
 * (`BOUND`, `IF`, `COALESCE`, `&&`, `||`, `IN`, `EXISTS`) are handled by the
 * expression evaluator.
 *
 * @since 0.1.0
 * @category built-ins
 */
export const builtIns: Partial<Record<Ast.BuiltInName, BuiltIn>> = {
  STR: ([a]) => {
    switch (a!._tag) {
      case 'NamedNode':
        return V.simple(a.value);
      case 'Literal':
        return V.simple(a.value);
      default:
        return V.fail('STR of a blank node or triple term');
    }
  },
  LANG: ([a]) => V.simple(literalArg(a!).language),
  LANGDIR: ([a]) => V.simple(literalArg(a!).direction ?? ''),
  LANGMATCHES: ([tag, range]) => {
    const t = simpleArg(tag!).value.toLowerCase();
    const r = simpleArg(range!).value.toLowerCase();
    if (r === '*') return V.bool(t !== '');
    return V.bool(t === r || t.startsWith(`${r}-`));
  },
  DATATYPE: ([a]) => literalArg(a!).datatype,
  IRI: ([a], ctx) => {
    if (a!._tag === 'NamedNode') return a;
    const s = simpleArg(a!).value;
    return Term.namedNode(ctx.baseIri !== undefined ? Iri.resolve(s, ctx.baseIri) : s);
  },
  URI: (args, ctx, sol) => builtIns.IRI!(args, ctx, sol),
  BNODE: (args, ctx, sol) =>
    ctx.blankNode(args.length === 0 ? undefined : simpleArg(args[0]!).value, sol),
  RAND: (_, ctx) => V.numLiteral({ kind: 3, v: ctx.random() }),
  ABS: ([a]) => {
    const n = numArg(a!);
    switch (n.kind) {
      case 0:
        return V.numLiteral({ kind: 0, v: n.v < 0n ? -n.v : n.v });
      case 1:
        return V.numLiteral({ kind: 1, v: BigDecimal.abs(n.v) });
      default:
        return V.numLiteral({ kind: n.kind, v: Math.abs(n.v) });
    }
  },
  CEIL: ([a]) => roundNum(a!, 'ceil', Math.ceil),
  FLOOR: ([a]) => roundNum(a!, 'floor', Math.floor),
  ROUND: ([a]) => roundNum(a!, 'half-ceil', xpathRound),
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
    const str = stringArg(s!);
    const chars = codepoints(str.value);
    const st = V.toNumber(numArg(start!));
    const from = xpathRound(st);
    let to = Infinity;
    if (len !== undefined) to = from + xpathRound(V.toNumber(numArg(len)));
    if (Number.isNaN(from) || Number.isNaN(to)) return V.stringLike('', str);
    const out = chars.filter((_, i) => i + 1 >= from && i + 1 < to).join('');
    return V.stringLike(out, str);
  },
  STRLEN: ([a]) => intLiteral(codepoints(stringArg(a!).value).length),
  REPLACE: ([s, pattern, replacement, flags]) => {
    const str = stringArg(s!);
    const re = compileRegex(simpleArg(pattern!).value, regexFlags(flags), true);
    if (re.test('')) {
      re.lastIndex = 0;
      return V.fail('REPLACE pattern matches the empty string');
    }
    re.lastIndex = 0;
    const repl = simpleArg(replacement!).value.replace(/\\(\$|\\)|\$/g, (m, esc) =>
      esc === '$' ? '$$' : esc === '\\' ? '\\' : m,
    );
    return V.stringLike(str.value.replace(re, repl), str);
  },
  UCASE: ([a]) => {
    const s = stringArg(a!);
    return V.stringLike(s.value.toUpperCase(), s);
  },
  LCASE: ([a]) => {
    const s = stringArg(a!);
    return V.stringLike(s.value.toLowerCase(), s);
  },
  ENCODE_FOR_URI: ([a]) => V.simple(encodeForUri(stringArg(a!).value)),
  CONTAINS: ([a, b]) => {
    const x = stringArg(a!);
    const y = stringArg(b!);
    if (!compatible(x, y)) return V.fail('Incompatible arguments');
    return V.bool(x.value.includes(y.value));
  },
  STRSTARTS: ([a, b]) => {
    const x = stringArg(a!);
    const y = stringArg(b!);
    if (!compatible(x, y)) return V.fail('Incompatible arguments');
    return V.bool(x.value.startsWith(y.value));
  },
  STRENDS: ([a, b]) => {
    const x = stringArg(a!);
    const y = stringArg(b!);
    if (!compatible(x, y)) return V.fail('Incompatible arguments');
    return V.bool(x.value.endsWith(y.value));
  },
  STRBEFORE: ([a, b]) => {
    const x = stringArg(a!);
    const y = stringArg(b!);
    if (!compatible(x, y)) return V.fail('Incompatible arguments');
    const i = x.value.indexOf(y.value);
    if (i === -1) return V.simple('');
    return V.stringLike(x.value.slice(0, i), x);
  },
  STRAFTER: ([a, b]) => {
    const x = stringArg(a!);
    const y = stringArg(b!);
    if (!compatible(x, y)) return V.fail('Incompatible arguments');
    const i = x.value.indexOf(y.value);
    if (i === -1) return V.simple('');
    return V.stringLike(x.value.slice(i + y.value.length), x);
  },
  YEAR: ([a]) => {
    const p = parseDateParts(a!);
    return p.year !== undefined ? intLiteral(BigInt(p.year)) : V.fail('No year');
  },
  MONTH: ([a]) => {
    const p = parseDateParts(a!);
    return p.month !== undefined ? intLiteral(Number(p.month)) : V.fail('No month');
  },
  DAY: ([a]) => {
    const p = parseDateParts(a!);
    return p.day !== undefined ? intLiteral(Number(p.day)) : V.fail('No day');
  },
  HOURS: ([a]) => {
    const p = parseDateParts(a!);
    return p.hours !== undefined ? intLiteral(Number(p.hours)) : V.fail('No hours');
  },
  MINUTES: ([a]) => {
    const p = parseDateParts(a!);
    return p.minutes !== undefined ? intLiteral(Number(p.minutes)) : V.fail('No minutes');
  },
  SECONDS: ([a]) => {
    const p = parseDateParts(a!);
    if (p.seconds === undefined) return V.fail('No seconds');
    return V.numLiteral({ kind: 1, v: BigDecimal.fromStringUnsafe(p.seconds) });
  },
  TIMEZONE: ([a]) => {
    const p = parseDateParts(a!);
    if (p.tz === undefined) return V.fail('No timezone');
    return new Term.Literal(timezoneDuration(p.tz), V.dt.dayTimeDuration);
  },
  TZ: ([a]) => V.simple(parseDateParts(a!).tz ?? ''),
  NOW: (_, ctx) => new Term.Literal(ctx.now.toISOString(), V.dt.dateTime),
  UUID: (_, ctx) => Term.namedNode(`urn:uuid:${uuid(ctx.random)}`),
  STRUUID: (_, ctx) => V.simple(uuid(ctx.random)),
  MD5: hashFn(Hash.md5),
  SHA1: hashFn(Hash.sha1),
  SHA256: hashFn(Hash.sha256),
  SHA384: hashFn(Hash.sha384),
  SHA512: hashFn(Hash.sha512),
  STRLANG: ([s, lang]) => {
    const lex = simpleArg(s!).value;
    const tag = simpleArg(lang!).value;
    if (!LANG_TAG.test(tag)) return V.fail('Invalid language tag');
    return Term.literal(lex, tag);
  },
  STRLANGDIR: ([s, lang, dir]) => {
    const lex = simpleArg(s!).value;
    const tag = simpleArg(lang!).value;
    const d = simpleArg(dir!).value;
    if (!LANG_TAG.test(tag)) return V.fail('Invalid language tag');
    if (d !== 'ltr' && d !== 'rtl') return V.fail('Invalid base direction');
    return Term.literal(lex, { language: tag, direction: d });
  },
  STRDT: ([s, datatype]) => {
    const lex = simpleArg(s!).value;
    if (datatype!._tag !== 'NamedNode') return V.fail('STRDT requires an IRI');
    if (datatype.value === V.dt.langString.value || datatype.value === V.dt.dirLangString.value) {
      return V.fail('STRDT cannot create language-tagged strings');
    }
    return new Term.Literal(lex, datatype);
  },
  SAMETERM: ([a, b]) => V.bool(a!.key === b!.key),
  ISIRI: ([a]) => V.bool(a!._tag === 'NamedNode'),
  ISURI: ([a]) => V.bool(a!._tag === 'NamedNode'),
  ISBLANK: ([a]) => V.bool(a!._tag === 'BlankNode'),
  ISLITERAL: ([a]) => V.bool(a!._tag === 'Literal'),
  ISNUMERIC: ([a]) => V.bool(V.isNumeric(a!)),
  HASLANG: ([a]) => V.bool(a!._tag === 'Literal' && a.language !== ''),
  HASLANGDIR: ([a]) => V.bool(a!._tag === 'Literal' && a.direction !== undefined),
  REGEX: ([s, pattern, flags]) => {
    const str = stringArg(s!);
    const re = compileRegex(simpleArg(pattern!).value, regexFlags(flags));
    return V.bool(re.test(str.value));
  },
  ISTRIPLE: ([a]) => V.bool(a!._tag === 'Triple'),
  TRIPLE: ([s, p, o]) => {
    if (s!._tag !== 'NamedNode' && s!._tag !== 'BlankNode') {
      return V.fail('TRIPLE subject must be an IRI or blank node');
    }
    if (p!._tag !== 'NamedNode') return V.fail('TRIPLE predicate must be an IRI');
    return Term.triple(s!, p, o!);
  },
  SUBJECT: ([a]) => (a!._tag === 'Triple' ? a.subject : V.fail('Not a triple term')),
  PREDICATE: ([a]) => (a!._tag === 'Triple' ? a.predicate : V.fail('Not a triple term')),
  OBJECT: ([a]) => (a!._tag === 'Triple' ? a.object : V.fail('Not a triple term')),
};

// -----------------------------------------------------------------------------
// Casts
// -----------------------------------------------------------------------------

const XSD_INTEGER_TYPES = new Set(
  [
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
  ].map((t) => V.XSD + t),
);

const castString = (a: Term.Term): string => {
  if (a._tag === 'NamedNode') return a.value;
  const l = literalArg(a);
  const n = V.numeric(l);
  if (n !== undefined) {
    if (n.kind === 0) return n.v.toString();
    if (n.kind === 1) {
      const s = Xsd.canonicalDecimal(n.v);
      return s.endsWith('.0') ? s.slice(0, -2) : s;
    }
    return Xsd.canonicalDouble(n.v);
  }
  if (l.datatype.value === V.dt.boolean.value && Xsd.isValidLexical(l.datatype.value, l.value)) {
    return l.value === 'true' || l.value === '1' ? 'true' : 'false';
  }
  return l.value;
};

const castTo = (target: string, a: Term.Term): Term.Literal => {
  const dtNode = Term.namedNode(target);
  if (target === Term.XSD_STRING) {
    if (a._tag === 'Literal' && a.language !== '') return V.fail('Cannot cast a language-tagged string');
    return V.simple(castString(a));
  }
  const l = literalArg(a);
  if (l.language !== '') return V.fail('Cannot cast a language-tagged string');
  const n = V.numeric(l);
  const isBool =
    l.datatype.value === V.dt.boolean.value && Xsd.isValidLexical(l.datatype.value, l.value);
  const boolValue = isBool && (l.value === 'true' || l.value === '1');
  const fromString = V.isSimpleString(l);
  const lexical = l.value.trim();

  if (target === V.dt.boolean.value) {
    if (isBool) return V.bool(boolValue);
    if (n !== undefined) return V.bool(V.ebv(l));
    if (fromString && /^(true|false|1|0)$/.test(lexical)) {
      return V.bool(lexical === 'true' || lexical === '1');
    }
    return V.fail('Invalid boolean cast');
  }
  if (XSD_INTEGER_TYPES.has(target)) {
    let value: bigint;
    if (isBool) value = boolValue ? 1n : 0n;
    else if (n !== undefined) {
      if (n.kind === 0) value = n.v;
      else if (n.kind === 1) value = BigInt(BigDecimal.format(BigDecimal.truncate(n.v)).split('.')[0]!);
      else {
        if (!Number.isFinite(n.v)) return V.fail('Cannot cast NaN/INF to integer');
        value = BigInt(Math.trunc(n.v));
      }
    } else if (fromString && /^[+-]?\d+$/.test(lexical)) value = BigInt(lexical);
    else return V.fail('Invalid integer cast');
    const lit = new Term.Literal(value.toString(), dtNode);
    return Xsd.isValidLexical(target, lit.value) ? lit : V.fail('Integer out of range');
  }
  if (target === V.dt.decimal.value) {
    if (isBool) return V.numLiteral({ kind: 1, v: BigDecimal.fromBigInt(boolValue ? 1n : 0n) });
    if (n !== undefined) {
      if (n.kind <= 1) return V.numLiteral({ kind: 1, v: V.toDecimal(n) });
      if (!Number.isFinite(n.v)) return V.fail('Cannot cast NaN/INF to decimal');
      return V.numLiteral({ kind: 1, v: BigDecimal.fromNumberUnsafe(n.v) });
    }
    if (fromString && /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(lexical)) {
      return V.numLiteral({ kind: 1, v: BigDecimal.fromStringUnsafe(lexical.replace(/\.$/, '')) });
    }
    return V.fail('Invalid decimal cast');
  }
  if (target === V.dt.double.value || target === V.dt.float.value) {
    const kind = target === V.dt.double.value ? 3 : 2;
    let value: number;
    if (isBool) value = boolValue ? 1 : 0;
    else if (n !== undefined) value = V.toNumber(n);
    else if (fromString && Xsd.isValidLexical(target, lexical)) {
      value = lexical === 'INF' || lexical === '+INF' ? Infinity : lexical === '-INF' ? -Infinity : Number(lexical);
    } else return V.fail('Invalid floating point cast');
    return V.numLiteral({ kind, v: kind === 2 ? Math.fround(value) : value });
  }
  if (target === V.dt.dateTime.value) {
    if (l.datatype.value === target && Xsd.isValidLexical(target, l.value)) return l;
    if (l.datatype.value === `${V.XSD}date` && Xsd.isValidLexical(l.datatype.value, l.value)) {
      const m = /^(-?\d+-\d\d-\d\d)(.*)$/.exec(l.value)!;
      return new Term.Literal(`${m[1]}T00:00:00${m[2]}`, dtNode);
    }
    if (fromString && Xsd.isValidLexical(target, lexical)) return new Term.Literal(lexical, dtNode);
    return V.fail('Invalid dateTime cast');
  }
  // Other XSD types: from strings with a valid lexical form, or same type.
  if (l.datatype.value === target) return l;
  if (fromString && Xsd.isValidLexical(target, lexical)) return new Term.Literal(lexical, dtNode);
  return V.fail(`Invalid cast to ${target}`);
};

const CASTABLE = new Set([
  Term.XSD_STRING,
  `${V.XSD}boolean`,
  `${V.XSD}decimal`,
  `${V.XSD}float`,
  `${V.XSD}double`,
  `${V.XSD}dateTime`,
  `${V.XSD}date`,
  `${V.XSD}time`,
  ...XSD_INTEGER_TYPES,
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
  if (term._tag === 'BlankNode' || term._tag === 'Triple') return V.fail('Cannot cast');
  if (term._tag === 'NamedNode' && datatype !== Term.XSD_STRING) return V.fail('Cannot cast an IRI');
  return castTo(datatype, term);
};
