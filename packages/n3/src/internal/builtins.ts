/**
 * A small library of N3 builtins (`math:`, `string:`, `list:`, `log:`).
 *
 * A builtin receives its subject and object with the current bindings
 * applied and returns the extended bindings for each solution, or
 * `undefined` when it cannot be evaluated yet (an input is still unbound).
 *
 * @internal
 */
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { xsd } from '@thomasfosterau/effect-rdf/Vocab';
import * as Xsd from '@thomasfosterau/effect-rdf/Xsd';
import * as Model from '../Model.ts';
import { list, log, math, string } from '../Vocab.ts';

/** @internal */
export type Bindings = ReadonlyMap<string, Model.N3Term>;

/** @internal */
export interface Context {
  readonly unify: (pattern: Model.N3Term, term: Model.N3Term, b: Bindings) => Array<Bindings>;
  /** Solves `goals` against the statements of `scope`. */
  readonly query: (
    scope: Model.Formula,
    goals: ReadonlyArray<Model.Statement>,
    b: Bindings,
    builtins: boolean,
  ) => Array<Bindings>;
  /** The formula of the document being reasoned over (the default scope). */
  readonly document: () => Model.Formula;
  /** The deductive closure of a formula (for `log:conclusion`). */
  readonly conclusion: (formula: Model.Formula) => Model.Formula;
}

/** @internal */
export type Builtin = (
  subject: Model.N3Term,
  object: Model.N3Term,
  b: Bindings,
  ctx: Context,
) => Array<Bindings> | undefined;

const TRUE = Term.literal('true', xsd.boolean);

/** Whether a term contains no variables (blank nodes count as ground). */
const ground = (t: Model.N3Term): boolean => Model.isGround(t);

// -----------------------------------------------------------------------------
// Numbers
// -----------------------------------------------------------------------------

type Num =
  | { readonly kind: 'integer'; readonly value: bigint }
  | { readonly kind: 'decimal' | 'double'; readonly value: number };

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

const toNum = (t: Model.N3Term): Num | undefined => {
  if (t._tag !== 'Literal') return undefined;
  const v = t.value.trim();
  const dt = t.datatype.value;
  if ((dt === xsd.double.value || dt === xsd.float.value) && /^(?:[+-]?INF|NaN)$/.test(v)) {
    return { kind: 'double', value: v === 'NaN' ? NaN : v.startsWith('-') ? -Infinity : Infinity };
  }
  if (!NUMERIC.test(v)) return undefined;
  if (Xsd.isIntegerDatatype(dt) || (dt === Term.XSD_STRING && /^[+-]?\d+$/.test(v))) {
    return { kind: 'integer', value: BigInt(v) };
  }
  if (dt === xsd.double.value || dt === xsd.float.value || /[eE]/.test(v)) {
    return { kind: 'double', value: Number(v) };
  }
  if (dt === xsd.decimal.value || dt === Term.XSD_STRING)
    return { kind: 'decimal', value: Number(v) };
  return undefined;
};

const asNumber = (n: Num): number => (n.kind === 'integer' ? Number(n.value) : n.value);

const fromNum = (n: Num): Term.Literal => {
  switch (n.kind) {
    case 'integer':
      return Term.literal(n.value.toString(), xsd.integer);
    case 'decimal': {
      const s = String(Number(n.value.toPrecision(15)));
      return Number.isFinite(n.value) && !/e/i.test(s)
        ? Term.literal(s.includes('.') ? s : `${s}.0`, xsd.decimal)
        : Term.literal(Xsd.canonicalDouble(n.value), xsd.double);
    }
    case 'double':
      return Term.literal(Xsd.canonicalDouble(n.value), xsd.double);
  }
};

const numEquals = (a: Num, b: Num): boolean => {
  if (a.kind === 'integer' && b.kind === 'integer') return a.value === b.value;
  const x = asNumber(a);
  const y = asNumber(b);
  if (x === y) return true;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= 1e-12 * Math.max(Math.abs(x), Math.abs(y));
};

const resultKind = (ns: ReadonlyArray<Num>): Num['kind'] =>
  ns.some((n) => n.kind === 'double')
    ? 'double'
    : ns.some((n) => n.kind === 'decimal')
      ? 'decimal'
      : 'integer';

const numbersOf = (t: Model.N3Term): Array<Num> | undefined => {
  if (t._tag !== 'Collection') return undefined;
  const out: Array<Num> = [];
  for (const i of t.items) {
    const n = toNum(i);
    if (n === undefined) return undefined;
    out.push(n);
  }
  return out;
};

/** Unifies the object with a computed value (or checks it). */
const output = (
  object: Model.N3Term,
  value: Model.N3Term | undefined,
  b: Bindings,
  ctx: Context,
): Array<Bindings> => {
  if (value === undefined) return [];
  if (ground(object)) {
    const on = toNum(object);
    const vn = toNum(value);
    if (on !== undefined && vn !== undefined) return numEquals(on, vn) ? [b] : [];
  }
  return ctx.unify(object, value, b);
};

const ready = (t: Model.N3Term): boolean => ground(t);

const listFunction =
  (f: (ns: Array<Num>) => Num | undefined, arity?: number): Builtin =>
  (s, o, b, ctx) => {
    if (!ready(s)) return undefined;
    const ns = numbersOf(s);
    if (ns === undefined || (arity !== undefined && ns.length !== arity)) return [];
    const r = f(ns);
    return r === undefined ? [] : output(o, fromNum(r), b, ctx);
  };

const unaryFunction =
  (f: (n: Num) => Num | undefined, inverse?: (n: Num) => Num | undefined): Builtin =>
  (s, o, b, ctx) => {
    if (!ready(s)) {
      if (inverse === undefined || !ready(o)) return undefined;
      const n = toNum(o);
      const r = n === undefined ? undefined : inverse(n);
      return r === undefined ? [] : ctx.unify(s, fromNum(r), b);
    }
    const n = toNum(s);
    const r = n === undefined ? undefined : f(n);
    return r === undefined ? [] : output(o, fromNum(r), b, ctx);
  };

const real =
  (f: (x: number) => number) =>
  (n: Num): Num => ({ kind: 'double', value: f(asNumber(n)) });

const comparison =
  (test: (c: number) => boolean): Builtin =>
  (s, o, b) => {
    if (!ready(s) || !ready(o)) return undefined;
    const x = toNum(s);
    const y = toNum(o);
    if (x === undefined || y === undefined) return [];
    // NaN is unordered: only `notEqualTo` holds.
    const c =
      Number.isNaN(asNumber(x)) || Number.isNaN(asNumber(y))
        ? NaN
        : numEquals(x, y)
          ? 0
          : asNumber(x) < asNumber(y)
            ? -1
            : 1;
    return test(c) ? [b] : [];
  };

const sum = (ns: Array<Num>): Num => {
  const kind = resultKind(ns);
  return kind === 'integer'
    ? { kind, value: ns.reduce((a, n) => a + (n.value as bigint), 0n) }
    : { kind, value: ns.reduce((a, n) => a + asNumber(n), 0) };
};

const product = (ns: Array<Num>): Num => {
  const kind = resultKind(ns);
  return kind === 'integer'
    ? { kind, value: ns.reduce((a, n) => a * (n.value as bigint), 1n) }
    : { kind, value: ns.reduce((a, n) => a * asNumber(n), 1) };
};

const binary =
  (
    int: ((a: bigint, b: bigint) => bigint | undefined) | undefined,
    real: (a: number, b: number) => number | undefined,
    forceReal = false,
  ) =>
  (ns: Array<Num>): Num | undefined => {
    const [a, c] = ns as [Num, Num];
    const kind = resultKind(ns);
    let outKind: Num['kind'] = kind === 'integer' ? 'decimal' : kind;
    if (kind === 'integer' && int !== undefined && !forceReal) {
      const r = int(a.value as bigint, c.value as bigint);
      if (r !== undefined) return { kind, value: r };
      outKind = 'double';
    }
    const r = real(asNumber(a), asNumber(c));
    if (r === undefined || (outKind !== 'double' && !Number.isFinite(r))) return undefined;
    return { kind: outKind, value: r };
  };

const mathBuiltins: Record<string, Builtin> = {
  sum: listFunction(sum),
  product: listFunction(product),
  difference: listFunction(
    binary(
      (a, b) => a - b,
      (a, b) => a - b,
    ),
    2,
  ),
  quotient: listFunction(
    binary(undefined, (a, b) => a / b, true),
    2,
  ),
  integerQuotient: listFunction((ns) => {
    const [a, b] = ns.map(asNumber) as [number, number];
    return b === 0 ? undefined : { kind: 'integer', value: BigInt(Math.trunc(a / b)) };
  }, 2),
  remainder: listFunction((ns) => {
    const [a, b] = ns as [Num, Num];
    if (a.kind !== 'integer' || b.kind !== 'integer' || b.value === 0n) return undefined;
    // The result has the sign of the divisor (floored division).
    return { kind: 'integer', value: ((a.value % b.value) + b.value) % b.value };
  }, 2),
  exponentiation: listFunction(
    binary(
      (a, b) => (b >= 0n ? a ** b : undefined),
      (a, b) => a ** b,
    ),
    2,
  ),
  negation: unaryFunction(
    (n) =>
      n.kind === 'integer' ? { kind: n.kind, value: -n.value } : { kind: n.kind, value: -n.value },
    (n) =>
      n.kind === 'integer' ? { kind: n.kind, value: -n.value } : { kind: n.kind, value: -n.value },
  ),
  absoluteValue: unaryFunction((n) =>
    n.kind === 'integer'
      ? { kind: n.kind, value: n.value < 0n ? -n.value : n.value }
      : { kind: n.kind, value: Math.abs(n.value) },
  ),
  rounded: unaryFunction((n) =>
    n.kind === 'integer' ? n : { kind: n.kind, value: Math.round(n.value) },
  ),
  floor: unaryFunction((n) => ({ kind: 'integer', value: BigInt(Math.floor(asNumber(n))) })),
  ceiling: unaryFunction((n) => ({ kind: 'integer', value: BigInt(Math.ceil(asNumber(n))) })),
  sin: unaryFunction(real(Math.sin), real(Math.asin)),
  cos: unaryFunction(real(Math.cos), real(Math.acos)),
  tan: unaryFunction(real(Math.tan), real(Math.atan)),
  asin: unaryFunction(real(Math.asin), real(Math.sin)),
  acos: unaryFunction(real(Math.acos), real(Math.cos)),
  atan: unaryFunction(real(Math.atan), real(Math.tan)),
  sinh: unaryFunction(real(Math.sinh), real(Math.asinh)),
  cosh: unaryFunction(real(Math.cosh)),
  tanh: unaryFunction(real(Math.tanh), real(Math.atanh)),
  degrees: unaryFunction(
    real((x) => (x * 180) / Math.PI),
    real((x) => (x * Math.PI) / 180),
  ),
  greaterThan: comparison((c) => c > 0),
  lessThan: comparison((c) => c < 0),
  notGreaterThan: comparison((c) => c <= 0),
  notLessThan: comparison((c) => c >= 0),
  equalTo: comparison((c) => c === 0),
  notEqualTo: comparison((c) => !(c === 0)),
};

// -----------------------------------------------------------------------------
// Strings
// -----------------------------------------------------------------------------

/** The XPath string value of a term (numbers and booleans in canonical form). */
const str = (t: Model.N3Term): string | undefined => {
  switch (t._tag) {
    case 'Literal': {
      const dt = t.datatype.value;
      if (dt === xsd.boolean.value) return t.value === '1' || t.value === 'true' ? 'true' : 'false';
      if (dt !== Term.XSD_STRING && Xsd.isNumericDatatype(dt)) {
        const n = toNum(t);
        if (n !== undefined) {
          if (n.kind === 'integer') return n.value.toString();
          if (Number.isNaN(n.value)) return 'NaN';
          if (!Number.isFinite(n.value)) return n.value > 0 ? 'INF' : '-INF';
          return String(n.value);
        }
      }
      return t.value;
    }
    case 'NamedNode':
      return t.value;
    default:
      return undefined;
  }
};

const stringTest =
  (test: (a: string, b: string) => boolean): Builtin =>
  (s, o, b) => {
    if (!ready(s) || !ready(o)) return undefined;
    const x = str(s);
    const y = str(o);
    return x !== undefined && y !== undefined && test(x, y) ? [b] : [];
  };

const stringsOf = (t: Model.N3Term): Array<string> | undefined => {
  if (t._tag !== 'Collection') return undefined;
  const out: Array<string> = [];
  for (const i of t.items) {
    const v = str(i);
    if (v === undefined) return undefined;
    out.push(v);
  }
  return out;
};

const stringFunction =
  (f: (args: Array<string>) => string | undefined): Builtin =>
  (s, o, b, ctx) => {
    if (!ready(s)) return undefined;
    const args = stringsOf(s);
    const r = args === undefined ? undefined : f(args);
    return r === undefined ? [] : ctx.unify(o, Term.literal(r), b);
  };

const regex = (pattern: string, flags = ''): RegExp | undefined => {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return undefined;
  }
};

const stringBuiltins: Record<string, Builtin> = {
  concatenation: stringFunction((args) => args.join('')),
  contains: stringTest((a, b) => a.includes(b)),
  containsIgnoringCase: stringTest((a, b) => a.toLowerCase().includes(b.toLowerCase())),
  startsWith: stringTest((a, b) => a.startsWith(b)),
  endsWith: stringTest((a, b) => a.endsWith(b)),
  equalIgnoringCase: stringTest((a, b) => a.toLowerCase() === b.toLowerCase()),
  notEqualIgnoringCase: stringTest((a, b) => a.toLowerCase() !== b.toLowerCase()),
  greaterThan: stringTest((a, b) => a > b),
  lessThan: stringTest((a, b) => a < b),
  notGreaterThan: stringTest((a, b) => a <= b),
  notLessThan: stringTest((a, b) => a >= b),
  matches: stringTest((a, b) => regex(b)?.test(a) ?? false),
  notMatches: stringTest((a, b) => !(regex(b)?.test(a) ?? true)),
  replace: stringFunction(([s, p, r]) => {
    if (s === undefined || p === undefined || r === undefined) return undefined;
    const re = regex(p, 'g');
    return re === undefined ? undefined : s.replace(re, r.replace(/\\(\d)/g, '$$$1'));
  }),
  scrape: stringFunction(([s, p]) => {
    if (s === undefined || p === undefined) return undefined;
    return regex(p)?.exec(s)?.[1];
  }),
  format: stringFunction(([fmt, ...args]) => {
    if (fmt === undefined) return undefined;
    let i = 0;
    return fmt.replace(/%s/g, () => args[i++] ?? '');
  }),
};

// -----------------------------------------------------------------------------
// Lists
// -----------------------------------------------------------------------------

const integerLiteral = (n: number): Term.Literal => Term.literal(String(n), xsd.integer);

const listBuiltins: Record<string, Builtin> = {
  in: (s, o, b, ctx) => {
    if (o._tag !== 'Collection') return ready(o) ? [] : undefined;
    return o.items.flatMap((item) => ctx.unify(s, item, b));
  },
  member: (s, o, b, ctx) => {
    if (s._tag !== 'Collection') return ready(s) ? [] : undefined;
    return s.items.flatMap((item) => ctx.unify(o, item, b));
  },
  length: (s, o, b, ctx) =>
    s._tag !== 'Collection'
      ? ready(s)
        ? []
        : undefined
      : output(o, integerLiteral(s.items.length), b, ctx),
  first: (s, o, b, ctx) =>
    s._tag !== 'Collection' ? (ready(s) ? [] : undefined) : output(o, s.items[0], b, ctx),
  last: (s, o, b, ctx) =>
    s._tag !== 'Collection' ? (ready(s) ? [] : undefined) : output(o, s.items.at(-1), b, ctx),
  rest: (s, o, b, ctx) =>
    s._tag !== 'Collection' || s.items.length === 0
      ? ready(s)
        ? []
        : undefined
      : ctx.unify(o, new Model.Collection(s.items.slice(1)), b),
  append: (s, o, b, ctx) => {
    if (!ready(s)) return undefined;
    if (s._tag !== 'Collection' || !s.items.every(Model.isCollection)) return [];
    return ctx.unify(
      o,
      new Model.Collection(s.items.flatMap((l) => (l as Model.Collection).items)),
      b,
    );
  },
  iterate: (s, o, b, ctx) => {
    if (s._tag !== 'Collection') return ready(s) ? [] : undefined;
    return s.items.flatMap((item, i) =>
      ctx.unify(o, new Model.Collection([integerLiteral(i), item]), b),
    );
  },
  memberAt: (s, o, b, ctx) => {
    if (!ready(s)) return undefined;
    if (s._tag !== 'Collection' || s.items.length !== 2) return [];
    const [l, idx] = s.items as [Model.N3Term, Model.N3Term];
    const n = toNum(idx);
    if (l._tag !== 'Collection' || n === undefined) return [];
    return output(o, l.items[asNumber(n)], b, ctx);
  },
  remove: (s, o, b, ctx) => {
    if (!ready(s)) return undefined;
    if (s._tag !== 'Collection' || s.items.length !== 2) return [];
    const [l, x] = s.items as [Model.N3Term, Model.N3Term];
    if (l._tag !== 'Collection') return [];
    return ctx.unify(o, new Model.Collection(l.items.filter((i) => i.key !== x.key)), b);
  },
};

// -----------------------------------------------------------------------------
// Log
// -----------------------------------------------------------------------------

const scopeOf = (t: Model.N3Term, ctx: Context): Model.Formula | undefined =>
  Model.isFormula(t)
    ? t
    : t._tag === 'Literal' && t.key === TRUE.key
      ? Model.emptyFormula
      : t._tag === 'BlankNode'
        ? ctx.document()
        : undefined;

const goalsOf = (t: Model.N3Term): ReadonlyArray<Model.Statement> | undefined =>
  Model.isFormula(t) ? t.statements : t.key === TRUE.key ? [] : undefined;

const logBuiltins: Record<string, Builtin> = {
  equalTo: (s, o, b, ctx) => ctx.unify(s, o, b),
  notEqualTo: (s, o, b) => (!ready(s) || !ready(o) ? undefined : s.key !== o.key ? [b] : []),
  includes: (s, o, b, ctx) => {
    const scope = scopeOf(s, ctx);
    const goals = goalsOf(o);
    if (scope === undefined || goals === undefined) return ready(s) ? [] : undefined;
    return ctx.query(scope, goals, b, false);
  },
  notIncludes: (s, o, b, ctx) => {
    const scope = scopeOf(s, ctx);
    const goals = goalsOf(o);
    if (scope === undefined || goals === undefined) return ready(s) ? [] : undefined;
    return ctx.query(scope, goals, b, false).length === 0 ? [b] : [];
  },
  conjunction: (s, o, b, ctx) => {
    if (!ready(s)) return undefined;
    if (s._tag !== 'Collection') return [];
    const parts = s.items.map(goalsOf);
    if (parts.some((p) => p === undefined)) return [];
    return ctx.unify(o, new Model.Formula(parts.flatMap((p) => p!)), b);
  },
  conclusion: (s, o, b, ctx) => {
    const f = s.key === TRUE.key ? Model.emptyFormula : s;
    if (!Model.isFormula(f)) return ready(s) ? [] : undefined;
    return ctx.unify(o, ctx.conclusion(f), b);
  },
  uri: (s, o, b, ctx) => {
    if (s._tag === 'NamedNode') return ctx.unify(o, Term.literal(s.value), b);
    if (o._tag === 'Literal') return ctx.unify(s, Term.namedNode(o.value), b);
    return ready(s) ? [] : undefined;
  },
  dtlit: (s, o, b, ctx) => {
    if (s._tag === 'Collection' && s.items.length === 2 && ready(s)) {
      const [lex, dt] = s.items as [Model.N3Term, Model.N3Term];
      if (lex._tag !== 'Literal' || dt._tag !== 'NamedNode') return [];
      return ctx.unify(o, Term.literal(lex.value, dt), b);
    }
    if (o._tag === 'Literal') {
      return ctx.unify(s, new Model.Collection([Term.literal(o.value), o.datatype]), b);
    }
    return undefined;
  },
  langlit: (s, o, b, ctx) => {
    if (s._tag === 'Collection' && s.items.length === 2 && ready(s)) {
      const [lex, lang] = s.items as [Model.N3Term, Model.N3Term];
      if (lex._tag !== 'Literal' || lang._tag !== 'Literal') return [];
      return ctx.unify(o, Term.literal(lex.value, lang.value), b);
    }
    if (o._tag === 'Literal' && o.language !== '') {
      return ctx.unify(
        s,
        new Model.Collection([Term.literal(o.value), Term.literal(o.language)]),
        b,
      );
    }
    return undefined;
  },
  rawType: (s, o, b, ctx) => {
    if (!ready(s)) return undefined;
    const type =
      s._tag === 'Formula'
        ? log.Formula
        : s._tag === 'Literal'
          ? log.Literal
          : s._tag === 'Collection'
            ? log.List
            : log.Other;
    return ctx.unify(o, type, b);
  },
  collectAllIn: (s, o, b, ctx) => {
    if (s._tag !== 'Collection' || s.items.length !== 3) return [];
    const [template, where, result] = s.items as [Model.N3Term, Model.N3Term, Model.N3Term];
    const scope = scopeOf(o, ctx);
    const goals = goalsOf(where);
    if (scope === undefined || goals === undefined) return [];
    const values = ctx
      .query(scope, goals, b, true)
      .map((sol) => Model.substitute(template, sol) as Model.N3Term);
    return ctx.unify(result, new Model.Collection(values), b);
  },
  forAllIn: (s, o, b, ctx) => {
    if (s._tag !== 'Collection' || s.items.length !== 2) return [];
    const [where, then] = s.items.map(goalsOf);
    const scope = scopeOf(o, ctx);
    if (scope === undefined || where === undefined || then === undefined) return [];
    return ctx
      .query(scope, where, b, true)
      .every((sol) => ctx.query(scope, then, sol, true).length > 0)
      ? [b]
      : [];
  },
};

const table = new Map<string, Builtin>();
for (const [ns, builtins] of [
  [math.base, mathBuiltins],
  [string.base, stringBuiltins],
  [list.base, listBuiltins],
  [log.base, logBuiltins],
] as const) {
  for (const [name, f] of Object.entries(builtins)) table.set(ns + name, f);
}

/** @internal */
export const builtinFor = (predicate: Model.N3Term): Builtin | undefined =>
  predicate._tag === 'NamedNode' ? table.get(predicate.value) : undefined;

/** The IRIs of all supported builtins. @internal */
export const builtinIris: ReadonlyArray<string> = Array.from(table.keys());
