/**
 * URL helpers: resolution, RFC 3986 syntax- and scheme-based normalization
 * (Tabular Data Model §URL Normalization) and the percent-encoding of column
 * names derived from titles.
 *
 * @internal
 */
import { Iri } from '@thomasfosterau/effect-rdf';

/**
 * Resolves a reference against a base URL.
 *
 * @internal
 */
export const resolve = (reference: string, base: string): string => Iri.resolve(reference, base);

const URL_RE = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/;
const UNRESERVED = /[A-Za-z0-9\-._~]/;

const normalizePercent = (s: string): string =>
  s.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => {
    const c = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(c) ? c : `%${hex.toUpperCase()}`;
  });

const isDefaultPort = (scheme: string, port: string): boolean =>
  (scheme === 'http' && port === '80') || (scheme === 'https' && port === '443');

const normalizeAuthority = (authority: string, scheme: string): string => {
  const at = authority.lastIndexOf('@');
  const userinfo = at === -1 ? '' : authority.slice(0, at + 1);
  const hostPort = (at === -1 ? authority : authority.slice(at + 1)).toLowerCase();
  const m = /^(.*?)(?::(\d*))?$/.exec(hostPort);
  const host = m?.[1] ?? hostPort;
  const port = m?.[2];
  const keep = port !== undefined && port !== '' && !isDefaultPort(scheme, port);
  return `${userinfo}${host}${keep ? `:${port}` : ''}`;
};

/**
 * Normalizes a URL for comparison: lower-case scheme and host, upper-case
 * percent-encodings, decoded unreserved characters, no dot segments, no
 * default HTTP(S) port and a `/` path for an HTTP(S) URL with an authority.
 *
 * @internal
 */
export const normalize = (url: string): string => {
  const m = URL_RE.exec(url);
  if (m === null) return url;
  const scheme = (m[1] ?? '').toLowerCase();
  const authority = m[2];
  const rawPath = normalizePercent(m[3] ?? '');
  const path = Iri.removeDotSegments(rawPath);
  const query = m[4] === undefined ? '' : normalizePercent(m[4]);
  const fragment = m[5] === undefined ? '' : normalizePercent(m[5]);
  if (authority === undefined) return `${scheme}:${path}${query}${fragment}`;
  const p = path === '' && (scheme === 'http' || scheme === 'https') ? '/' : path;
  return `${scheme}://${normalizeAuthority(authority, scheme)}${p}${query}${fragment}`;
};

/**
 * Percent-encodes every character of a title that cannot appear in a URI
 * template variable name (anything but `A-Z`, `a-z`, `0-9`, `_` and `.`),
 * for a column name derived from it.
 *
 * @internal
 */
export const encodeName = (title: string): string =>
  encodeURIComponent(title).replace(
    /[!'()*~-]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * Percent-decodes a column name (`_name` and JSON property names).
 *
 * @internal
 */
export const decodeName = (name: string): string =>
  name.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = run.match(/%([0-9A-Fa-f]{2})/g) ?? [];
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(
      Uint8Array.from(bytes, (b) => Number.parseInt(b.slice(1), 16)),
    );
    return decoded;
  });

/**
 * Removes the fragment from a URL.
 *
 * @internal
 */
export const withoutFragment = (url: string): string => Iri.withoutFragment(url);
