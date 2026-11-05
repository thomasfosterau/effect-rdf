/**
 * IRI utilities: RFC 3986 reference resolution, relativisation and
 * validation.
 *
 * @since 0.1.0
 */
import * as Equal from 'effect/Equal';
import * as Str from 'effect/String';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { loop } from './internal/loop.ts';

interface Parts {
  readonly scheme: Option.Option<string>;
  readonly authority: Option.Option<string>;
  readonly path: string;
  readonly query: Option.Option<string>;
  readonly fragment: Option.Option<string>;
}

const PARTS =
  /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s;

const parse = (iri: string): Parts => {
  // Every part of the pattern is optional, so it matches any string
  const m = PARTS.exec(iri) ?? [];
  return {
    scheme: Option.fromUndefinedOr(m[1]),
    authority: Option.fromUndefinedOr(m[2]),
    path: m[3] ?? '',
    query: Option.fromUndefinedOr(m[4]),
    fragment: Option.fromUndefinedOr(m[5]),
  };
};

// A document resolves many references against one base, so the last base's
// parts are kept. `Parts` are never mutated once parsed.
let lastBase = '';
let lastBaseParts: Parts = parse('');

const parseBase = (base: string): Parts => {
  if (base !== lastBase) {
    lastBaseParts = parse(base);
    lastBase = base;
  }
  return lastBaseParts;
};

/** `part` between `before` and `after`, or nothing when it is absent. */
const affix = (part: Option.Option<string>, before: string, after: string): string =>
  Option.match(part, { onNone: () => '', onSome: (v) => `${before}${v}${after}` });

const recompose = (p: Parts): string =>
  affix(p.scheme, '', ':') +
  affix(p.authority, '//', '') +
  p.path +
  affix(p.query, '?', '') +
  affix(p.fragment, '#', '');

// A `.` or `..` segment: the only thing `removeDotSegments` changes.
const DOT_SEGMENT = /(?:^|\/)\.\.?(?:\/|$)/;

/**
 * Removes `.` and `..` segments from a path (RFC 3986 §5.2.4).
 *
 * @since 0.1.0
 */
export const removeDotSegments = (path: string): string => {
  // Most paths have no dot segment, and the algorithm leaves those unchanged.
  if (!DOT_SEGMENT.test(path)) return path;
  let input = path;
  const output: Array<string> = [];
  loop(() => {
    if (!Str.isNonEmpty(input)) return false;
    if (input.startsWith('../')) input = input.slice(3);
    else if (input.startsWith('./')) input = input.slice(2);
    else if (input.startsWith('/./')) input = input.slice(2);
    else if (input === '/.') input = '/';
    else if (input.startsWith('/../')) {
      input = input.slice(3);
      output.pop();
    } else if (input === '/..') {
      input = '/';
      output.pop();
    } else if (input === '.' || input === '..') input = '';
    else {
      const start = input.startsWith('/') ? 1 : 0;
      const next = input.indexOf('/', start);
      const segment = next === -1 ? input : input.slice(0, next);
      output.push(segment);
      input = next === -1 ? '' : input.slice(next);
    }
    return true;
  });
  return output.join('');
};

const merge = (base: Parts, ref: string): string => {
  if (Option.isSome(base.authority) && base.path === '') return `/${ref}`;
  const i = base.path.lastIndexOf('/');
  return i === -1 ? ref : base.path.slice(0, i + 1) + ref;
};

// Hoisted: a regex literal makes a new `RegExp` each time it is evaluated.
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Whether a string is an absolute IRI (has a scheme).
 *
 * @since 0.1.0
 */
export const isAbsolute = (iri: string): boolean => SCHEME.test(iri);

const SCHEME_THEN_PATH = /^[A-Za-z][A-Za-z0-9+.-]*:(?!\.)/;

/**
 * Whether `iri` has a scheme and no `.` or `..` segment anywhere, without
 * splitting it into its parts: such a reference resolves to itself
 * (RFC 3986 §5.2.2), and most references in a document are like that. A
 * `/.` anywhere (even in the query or fragment) or a path starting with `.`
 * sends the reference down the full algorithm.
 */
const isPlainAbsolute = (iri: string): boolean => SCHEME_THEN_PATH.test(iri) && !iri.includes('/.');

/**
 * Resolves a (possibly relative) IRI reference against a base IRI, following
 * RFC 3986 §5.2.
 *
 * @since 0.1.0
 */
export const resolve = (reference: string, base: string | undefined): string => {
  if (base === undefined || base === '') return reference;
  if (isPlainAbsolute(reference)) return reference;
  const r = parse(reference);
  // An absolute reference without dot segments resolves to itself (§5.2.2:
  // only its path is rewritten, by `removeDotSegments`).
  if (Option.isSome(r.scheme) && !DOT_SEGMENT.test(r.path)) return reference;
  const b = parseBase(base);
  const fragment = r.fragment;
  const t: Parts = Option.isSome(r.scheme)
    ? {
        scheme: r.scheme,
        authority: r.authority,
        path: removeDotSegments(r.path),
        query: r.query,
        fragment,
      }
    : Option.isSome(r.authority)
      ? {
          scheme: b.scheme,
          authority: r.authority,
          path: removeDotSegments(r.path),
          query: r.query,
          fragment,
        }
      : r.path === ''
        ? {
            scheme: b.scheme,
            authority: b.authority,
            path: b.path,
            query: Option.orElse(r.query, () => b.query),
            fragment,
          }
        : {
            scheme: b.scheme,
            authority: b.authority,
            path: r.path.startsWith('/')
              ? removeDotSegments(r.path)
              : removeDotSegments(merge(b, r.path)),
            query: r.query,
            fragment,
          };
  return recompose(t);
};

/**
 * Removes the fragment from an IRI.
 *
 * @since 0.1.0
 */
export const withoutFragment = (iri: string): string => {
  const i = iri.indexOf('#');
  return i === -1 ? iri : iri.slice(0, i);
};

/**
 * Computes a relative reference for `iri` with respect to `base`, if a
 * simple one exists (same scheme and authority). Resolving the result against
 * `base` always yields `iri`.
 *
 * @since 0.1.0
 */
export const relativize = (iri: string, base: string): Option.Option<string> => {
  if (iri === base) return Option.some('');
  const i = parse(iri);
  const b = parse(base);
  if (
    !Equal.equals(i.scheme, b.scheme) ||
    !Equal.equals(i.authority, b.authority) ||
    Option.isNone(i.scheme)
  ) {
    return Option.none();
  }
  // `iri` as a reference with only `path` and its query and fragment
  const relative = (path: string): string =>
    recompose({
      scheme: Option.none(),
      authority: Option.none(),
      path,
      query: i.query,
      fragment: i.fragment,
    });
  const dir = b.path.slice(0, b.path.lastIndexOf('/') + 1);
  const rest = i.path.slice(dir.length);
  const candidate: Option.Option<string> =
    i.path === b.path
      ? Equal.equals(i.query, b.query)
        ? Option.map(i.fragment, (f) => `#${f}`)
        : Option.isSome(i.query)
          ? Option.some(relative(''))
          : Option.none()
      : Option.orElse(
          // Avoid references whose first segment looks like a scheme.
          dir !== '' && i.path.startsWith(dir) && rest !== '' && !/^[^/]*:/.test(rest)
            ? Option.some(relative(rest))
            : Option.none(),
          () =>
            i.path.startsWith('/') && !i.path.startsWith('//')
              ? Option.some(relative(i.path))
              : Option.none(),
        );
  return Option.filter(candidate, (c) => resolve(c, base) === iri);
};

// IRI grammar (RFC 3987) character classes, used for validation.
const UCSCHAR =
  '\\u00A0-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFEF\\u{10000}-\\u{1FFFD}\\u{20000}-\\u{2FFFD}\\u{30000}-\\u{3FFFD}\\u{40000}-\\u{4FFFD}\\u{50000}-\\u{5FFFD}\\u{60000}-\\u{6FFFD}\\u{70000}-\\u{7FFFD}\\u{80000}-\\u{8FFFD}\\u{90000}-\\u{9FFFD}\\u{A0000}-\\u{AFFFD}\\u{B0000}-\\u{BFFFD}\\u{C0000}-\\u{CFFFD}\\u{D0000}-\\u{DFFFD}\\u{E1000}-\\u{EFFFD}';
const IPRIVATE = '\\uE000-\\uF8FF\\u{F0000}-\\u{FFFFD}\\u{100000}-\\u{10FFFD}';
const IUNRESERVED = `A-Za-z0-9\\-._~${UCSCHAR}`;
const SUBDELIMS = "!$&'()*+,;=";
const PCT = '%[0-9A-Fa-f]{2}';
const IPCHAR = `(?:[${IUNRESERVED}${SUBDELIMS}:@]|${PCT})`;
// `ihier-part` / `irelative-part` (optional authority, then a path), query and fragment: the
// IRI grammar after the scheme, shared by absolute IRIs and relative references.
const IRI_AFTER_SCHEME =
  `(?://(?:(?:[${IUNRESERVED}${SUBDELIMS}:]|${PCT})*@)?(?:\\[[0-9A-Fa-f:.vV${IUNRESERVED}${SUBDELIMS}]*\\]|(?:[${IUNRESERVED}${SUBDELIMS}]|${PCT})*)(?::[0-9]*)?)?` +
  `(?:/?${IPCHAR}*)*` +
  `(?:\\?(?:${IPCHAR}|[/?${IPRIVATE}])*)?` +
  `(?:#(?:${IPCHAR}|[/?])*)?`;
const IRI_RE = new RegExp(`^[A-Za-z][A-Za-z0-9+.\\-]*:${IRI_AFTER_SCHEME}$`, 'u');

/**
 * Whether a string is a syntactically valid absolute IRI (RFC 3987).
 *
 * @since 0.1.0
 */
export const isValid = (iri: string): boolean => IRI_RE.test(iri);

// A relative reference (RFC 3987 `irelative-ref`): the IRI grammar without the scheme.
const RELATIVE_RE = new RegExp(`^${IRI_AFTER_SCHEME}$`, 'u');

/**
 * Whether a string is a syntactically valid IRI reference (RFC 3987): an
 * absolute IRI, or a relative reference whose first path segment has no `:`.
 *
 * @since 0.1.0
 */
export const isValidReference = (reference: string): boolean =>
  isAbsolute(reference)
    ? isValid(reference)
    : !/^[^/?#]*:/.test(reference) && RELATIVE_RE.test(reference);

/**
 * Schema of an absolute IRI (`isValid`): a string, with JSON Schema
 * `format: "iri"`. Use it to validate IRIs from `Config`, CLI flags or HTTP
 * parameters.
 *
 * @since 0.1.0
 * @category schemas
 */
export const IriSchema: Schema.String = Schema.String.check(
  Schema.makeFilter((s: string) => isValid(s), {
    identifier: 'isIri',
    title: 'IRI',
    description: 'An absolute IRI (RFC 3987).',
    expected: 'an absolute IRI',
    toJsonSchema: () => ({ format: 'iri' }),
  }),
).annotate({ identifier: 'Iri' });

/**
 * The type `IriSchema` decodes to: a string.
 *
 * @since 0.1.0
 * @category schemas
 */
export type IriSchema = typeof IriSchema.Type;

/**
 * Schema of an IRI reference, absolute or relative (`isValidReference`): a
 * string, with JSON Schema `format: "iri-reference"`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const IriReferenceSchema: Schema.String = Schema.String.check(
  Schema.makeFilter((s: string) => isValidReference(s), {
    identifier: 'isIriReference',
    title: 'IRI reference',
    description: 'An absolute IRI or relative reference (RFC 3987).',
    expected: 'an IRI reference',
    toJsonSchema: () => ({ format: 'iri-reference' }),
  }),
).annotate({ identifier: 'IriReference' });

/**
 * The type `IriReferenceSchema` decodes to: a string.
 *
 * @since 0.1.0
 * @category schemas
 */
export type IriReferenceSchema = typeof IriReferenceSchema.Type;
