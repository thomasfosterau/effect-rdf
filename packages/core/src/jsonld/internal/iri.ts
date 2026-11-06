/** @internal */
import * as Iri from '../../Iri.ts';

/**
 * Resolves `reference` against `base`; a `null` base (`"@base": null`, or no
 * document URL) leaves it unchanged.
 *
 * @internal
 */
export const resolveIri = (reference: string, base: string | null): string =>
  base === null ? reference : Iri.resolve(reference, base);

const PARTS =
  /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s;

/**
 * Turns an absolute IRI into a reference relative to `base`, when possible.
 *
 * @internal
 */
export const removeBase = (base: string | null, iri: string): string => {
  if (base === null) return iri;
  const b = PARTS.exec(base);
  if (b === null) return iri;
  let root = '';
  if (base !== '') {
    if (b[1] === undefined) return iri;
    root = `${b[1]}:${b[2] !== undefined ? `//${b[2]}` : ''}`;
  }
  if (!iri.startsWith(root)) return iri;
  const restStart = iri.charAt(root.length);
  if (root !== '' && restStart !== '' && !'/?#'.includes(restStart)) return iri;
  const rel = PARTS.exec(iri.slice(root.length));
  if (rel === null) return iri;
  const baseSegments = Iri.removeDotSegments(b[3] ?? '').split('/');
  const iriSegments = Iri.removeDotSegments(rel[3] ?? '').split('/');
  const last = rel[5] !== undefined || rel[4] !== undefined ? 0 : 1;
  // The leading segments the two paths share, keeping at least `last` of the IRI's.
  const differs = baseSegments.findIndex(
    (segment, i) => iriSegments.length - i <= last || segment !== iriSegments[i],
  );
  const common = differs === -1 ? baseSegments.length : differs;
  const baseRest = baseSegments.length - common;
  let out = baseRest > 0 ? '../'.repeat(baseRest - 1) : '';
  out += iriSegments.slice(common).join('/');
  if (rel[4] !== undefined) out += `?${rel[4]}`;
  if (rel[5] !== undefined) out += `#${rel[5]}`;
  if (out === '') out = './';
  if (/^[^/?#]*:/.test(out)) out = `./${out}`;
  if (/^@[a-zA-Z]+$/.test(out)) out = `./${out}`;
  return base === '' || resolveIri(out, base) === iri ? out : iri;
};
