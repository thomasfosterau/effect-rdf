/**
 * RFC 6570 URI Template expansion (all four levels) over string and list
 * values, for the `aboutUrl`, `propertyUrl` and `valueUrl` templates.
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';

/**
 * A template variable's value: a string, a list of strings, or absent.
 *
 * @internal
 */
export type Value = string | ReadonlyArray<string>;

interface Operator {
  readonly first: string;
  readonly sep: string;
  readonly named: boolean;
  readonly ifEmpty: string;
  readonly reserved: boolean;
}

const operators: Readonly<Record<string, Operator>> = {
  '': { first: '', sep: ',', named: false, ifEmpty: '', reserved: false },
  '+': { first: '', sep: ',', named: false, ifEmpty: '', reserved: true },
  '.': { first: '.', sep: '.', named: false, ifEmpty: '', reserved: false },
  '/': { first: '/', sep: '/', named: false, ifEmpty: '', reserved: false },
  ';': { first: ';', sep: ';', named: true, ifEmpty: '', reserved: false },
  '?': { first: '?', sep: '&', named: true, ifEmpty: '=', reserved: false },
  '&': { first: '&', sep: '&', named: true, ifEmpty: '=', reserved: false },
  '#': { first: '#', sep: ',', named: false, ifEmpty: '', reserved: true },
};

const utf8 = new TextEncoder();

const pct = (c: string): string =>
  Arr.join(
    Arr.map(Array.from(utf8.encode(c)), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`),
    '',
  );

const encodeUnreserved = (s: string): string => s.replace(/[^A-Za-z0-9\-._~]/gu, (c) => pct(c));

const encodeReserved = (s: string): string =>
  s.replace(/%[0-9A-Fa-f]{2}|[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]/gu, (c) =>
    c.startsWith('%') && c.length === 3 ? c : pct(c),
  );

interface VarSpec {
  readonly name: string;
  readonly prefix: Option.Option<number>;
  readonly explode: boolean;
}

const parseVarSpec = (spec: string): VarSpec => {
  const explode = spec.endsWith('*');
  const body = explode ? spec.slice(0, -1) : spec;
  const colon = body.indexOf(':');
  return colon === -1
    ? { name: body, prefix: Option.none(), explode }
    : {
        name: body.slice(0, colon),
        prefix: Option.some(Number.parseInt(body.slice(colon + 1), 10)),
        explode,
      };
};

const expandVar = (
  op: Operator,
  spec: VarSpec,
  defined: Option.Option<Value>,
): ReadonlyArray<string> => {
  const enc = op.reserved ? encodeReserved : encodeUnreserved;
  if (Option.isNone(defined)) return [];
  const value = defined.value;
  if (Predicate.isString(value)) {
    const v = Option.match(spec.prefix, {
      onNone: () => value,
      onSome: (n) => Arr.join(Arr.take(Array.from(value), n), ''),
    });
    if (!op.named) return [enc(v)];
    return [v === '' ? `${spec.name}${op.ifEmpty}` : `${spec.name}=${enc(v)}`];
  }
  if (!Arr.isReadonlyArrayNonEmpty(value)) return [];
  if (!spec.explode) {
    const joined = Arr.join(Arr.map(value, enc), ',');
    return [op.named ? `${spec.name}=${joined}` : joined];
  }
  return Arr.map(value, (item) =>
    op.named
      ? item === ''
        ? `${spec.name}${op.ifEmpty}`
        : `${spec.name}=${enc(item)}`
      : enc(item),
  );
};

const expandExpression = (
  expression: string,
  variables: Readonly<Record<string, Value>>,
): string => {
  const head = expression.charAt(0);
  const op = Record.get(operators, head);
  const [operator, body] = Option.match(op, {
    onNone: () => [operators[''], expression] as const,
    onSome: (o) => [o, expression.slice(1)] as const,
  });
  const resolved = operator ?? { first: '', sep: ',', named: false, ifEmpty: '', reserved: false };
  const parts = Arr.flatMap(body.split(','), (raw) => {
    const spec = parseVarSpec(raw);
    return expandVar(resolved, spec, Record.get(variables, spec.name));
  });
  return Arr.match(parts, {
    onEmpty: () => '',
    onNonEmpty: (ps) => resolved.first + Arr.join(ps, resolved.sep),
  });
};

/**
 * Expands a URI template with the given variables (an absent variable is
 * undefined).
 *
 * @internal
 */
export const expand = (template: string, variables: Readonly<Record<string, Value>>): string =>
  template.replace(/\{([^}]*)\}/g, (_, e: string) => expandExpression(e, variables));
