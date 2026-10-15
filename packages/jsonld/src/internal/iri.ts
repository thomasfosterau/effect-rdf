/** @internal */
import * as Iri from '@thomasfosterau/effect-rdf/Iri';

/** @internal */
export const resolveIri = (reference: string, base: string | null | undefined): string =>
  base === null || base === undefined ? reference : Iri.resolve(reference, base);

const PARTS =
  /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s;

/**
 * Turns an absolute IRI into a reference relative to `base`, when possible.
 *
 * @internal
 */
export const removeBase = (base: string | null, iri: string): string => {
  if (base === null) return iri;
  const b = PARTS.exec(base)!;
  let root = '';
  if (base !== '') {
    if (b[1] === undefined) return iri;
    root = `${b[1]}:${b[2] !== undefined ? `//${b[2]}` : ''}`;
  }
  if (!iri.startsWith(root)) return iri;
  const restStart = iri.charAt(root.length);
  if (root !== '' && restStart !== '' && !'/?#'.includes(restStart)) return iri;
  const rel = PARTS.exec(iri.slice(root.length))!;
  const relPath = Iri.removeDotSegments(rel[3] ?? '');
  const basePath = Iri.removeDotSegments(b[3] ?? '');
  const baseSegments = basePath.split('/');
  const iriSegments = relPath.split('/');
  const last = rel[5] !== undefined || rel[4] !== undefined ? 0 : 1;
  while (baseSegments.length > 0 && iriSegments.length > last) {
    if (baseSegments[0] !== iriSegments[0]) break;
    baseSegments.shift();
    iriSegments.shift();
  }
  let out = '';
  if (baseSegments.length > 0) {
    baseSegments.pop();
    for (let i = 0; i < baseSegments.length; i++) out += '../';
  }
  out += iriSegments.join('/');
  if (rel[4] !== undefined) out += `?${rel[4]}`;
  if (rel[5] !== undefined) out += `#${rel[5]}`;
  if (out === '') out = './';
  if (/^[^/?#]*:/.test(out)) out = `./${out}`;
  if (/^@[a-zA-Z]+$/.test(out)) out = `./${out}`;
  return base === '' || resolveIri(out, base) === iri ? out : iri;
};
