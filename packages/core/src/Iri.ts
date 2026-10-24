/**
 * IRI utilities: RFC 3986 reference resolution, relativisation and
 * validation.
 *
 * @since 0.1.0
 */
import * as Option from 'effect/Option';

interface Parts {
  scheme: string | undefined;
  authority: string | undefined;
  path: string;
  query: string | undefined;
  fragment: string | undefined;
}

const PARTS =
  /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s;

const parse = (iri: string): Parts => {
  const m = PARTS.exec(iri)!;
  return {
    scheme: m[1],
    authority: m[2],
    path: m[3] ?? '',
    query: m[4],
    fragment: m[5],
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

const recompose = (p: Parts): string => {
  let out = '';
  if (p.scheme !== undefined) out += `${p.scheme}:`;
  if (p.authority !== undefined) out += `//${p.authority}`;
  out += p.path;
  if (p.query !== undefined) out += `?${p.query}`;
  if (p.fragment !== undefined) out += `#${p.fragment}`;
  return out;
};

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
  while (input.length > 0) {
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
  }
  return output.join('');
};

const merge = (base: Parts, ref: string): string => {
  if (base.authority !== undefined && base.path === '') return `/${ref}`;
  const i = base.path.lastIndexOf('/');
  return i === -1 ? ref : base.path.slice(0, i + 1) + ref;
};

/**
 * Whether a string is an absolute IRI (has a scheme).
 *
 * @since 0.1.0
 */
export const isAbsolute = (iri: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(iri);

/**
 * Resolves a (possibly relative) IRI reference against a base IRI, following
 * RFC 3986 §5.2.
 *
 * @since 0.1.0
 */
export const resolve = (reference: string, base: string | undefined): string => {
  if (base === undefined || base === '') return reference;
  const r = parse(reference);
  // An absolute reference without dot segments resolves to itself (§5.2.2:
  // only its path is rewritten, by `removeDotSegments`).
  if (r.scheme !== undefined && !DOT_SEGMENT.test(r.path)) return reference;
  const b = parseBase(base);
  const t: Parts = {
    scheme: undefined,
    authority: undefined,
    path: '',
    query: undefined,
    fragment: r.fragment,
  };
  if (r.scheme !== undefined) {
    t.scheme = r.scheme;
    t.authority = r.authority;
    t.path = removeDotSegments(r.path);
    t.query = r.query;
  } else {
    if (r.authority !== undefined) {
      t.authority = r.authority;
      t.path = removeDotSegments(r.path);
      t.query = r.query;
    } else {
      if (r.path === '') {
        t.path = b.path;
        t.query = r.query !== undefined ? r.query : b.query;
      } else {
        t.path = r.path.startsWith('/')
          ? removeDotSegments(r.path)
          : removeDotSegments(merge(b, r.path));
        t.query = r.query;
      }
      t.authority = b.authority;
    }
    t.scheme = b.scheme;
  }
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
  if (i.scheme !== b.scheme || i.authority !== b.authority || i.scheme === undefined) {
    return Option.none();
  }
  let candidate: string | undefined;
  if (i.path === b.path) {
    if (i.query === b.query) {
      candidate = i.fragment !== undefined ? `#${i.fragment}` : undefined;
    } else if (i.query !== undefined) {
      candidate = recompose({
        scheme: undefined,
        authority: undefined,
        path: '',
        query: i.query,
        fragment: i.fragment,
      });
    }
  } else {
    const dir = b.path.slice(0, b.path.lastIndexOf('/') + 1);
    if (dir !== '' && i.path.startsWith(dir)) {
      const rest = i.path.slice(dir.length);
      // Avoid references whose first segment looks like a scheme.
      if (rest !== '' && !/^[^/]*:/.test(rest)) {
        candidate = recompose({
          scheme: undefined,
          authority: undefined,
          path: rest,
          query: i.query,
          fragment: i.fragment,
        });
      }
    }
    if (candidate === undefined && i.path.startsWith('/') && !i.path.startsWith('//')) {
      candidate = recompose({
        scheme: undefined,
        authority: undefined,
        path: i.path,
        query: i.query,
        fragment: i.fragment,
      });
    }
  }
  return candidate !== undefined && resolve(candidate, base) === iri
    ? Option.some(candidate)
    : Option.none();
};

// IRI grammar (RFC 3987) character classes, used for validation.
const UCSCHAR =
  '\\u00A0-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFEF\\u{10000}-\\u{1FFFD}\\u{20000}-\\u{2FFFD}\\u{30000}-\\u{3FFFD}\\u{40000}-\\u{4FFFD}\\u{50000}-\\u{5FFFD}\\u{60000}-\\u{6FFFD}\\u{70000}-\\u{7FFFD}\\u{80000}-\\u{8FFFD}\\u{90000}-\\u{9FFFD}\\u{A0000}-\\u{AFFFD}\\u{B0000}-\\u{BFFFD}\\u{C0000}-\\u{CFFFD}\\u{D0000}-\\u{DFFFD}\\u{E1000}-\\u{EFFFD}';
const IPRIVATE = '\\uE000-\\uF8FF\\u{F0000}-\\u{FFFFD}\\u{100000}-\\u{10FFFD}';
const IUNRESERVED = `A-Za-z0-9\\-._~${UCSCHAR}`;
const SUBDELIMS = "!$&'()*+,;=";
const PCT = '%[0-9A-Fa-f]{2}';
const IPCHAR = `(?:[${IUNRESERVED}${SUBDELIMS}:@]|${PCT})`;
const IRI_RE = new RegExp(
  `^[A-Za-z][A-Za-z0-9+.\\-]*:` +
    `(?://(?:(?:[${IUNRESERVED}${SUBDELIMS}:]|${PCT})*@)?(?:\\[[0-9A-Fa-f:.vV${IUNRESERVED}${SUBDELIMS}]*\\]|(?:[${IUNRESERVED}${SUBDELIMS}]|${PCT})*)(?::[0-9]*)?)?` +
    `(?:/?${IPCHAR}*)*` +
    `(?:\\?(?:${IPCHAR}|[/?${IPRIVATE}])*)?` +
    `(?:#(?:${IPCHAR}|[/?])*)?$`,
  'u',
);

/**
 * Whether a string is a syntactically valid absolute IRI (RFC 3987).
 *
 * @since 0.1.0
 */
export const isValid = (iri: string): boolean => IRI_RE.test(iri);
