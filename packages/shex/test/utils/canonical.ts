import type * as ShExJ from '../../src/ShExJ.ts';

/**
 * Canonicalises a ShExJ schema for comparison modulo blank node labels and
 * the order of `extra` predicates (which ShExR cannot preserve): blank node
 * labels are renamed in order of first appearance, and blank-node triple
 * expression labels that are never referenced are dropped (RDF cannot
 * distinguish them from anonymous expressions).
 */
export const canonical = (schema: ShExJ.Schema): unknown => {
  const referencedTe = new Set<string>();
  const collectRefs = (v: unknown, key: string | undefined): void => {
    if (typeof v === 'string') {
      if ((key === 'expression' || key === 'expressions') && v.startsWith('_:'))
        referencedTe.add(v);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x) => collectRefs(x, key));
      return;
    }
    if (v !== null && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) collectRefs(x, k);
  };
  collectRefs(schema, undefined);
  const names = new Map<string, string>();
  const rename = (label: string) => {
    let n = names.get(label);
    if (n === undefined) names.set(label, (n = `_:c${names.size}`));
    return n;
  };
  const go = (v: unknown, key: string | undefined): unknown => {
    if (typeof v === 'string') return v.startsWith('_:') && key !== 'value' ? rename(v) : v;
    if (Array.isArray(v)) {
      const items = v.map((x) => go(x, key));
      return key === 'extra'
        ? [...items].sort((a, b) => String(a).localeCompare(String(b)))
        : items;
    }
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      const entries = Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const isTe =
        'type' in v &&
        ((v as { type: string }).type === 'TripleConstraint' ||
          (v as { type: string }).type === 'EachOf' ||
          (v as { type: string }).type === 'OneOf');
      for (const [k, x] of entries) {
        if (
          isTe &&
          k === 'id' &&
          typeof x === 'string' &&
          x.startsWith('_:') &&
          !referencedTe.has(x)
        )
          continue;
        out[k] = go(x, k);
      }
      return out;
    }
    return v;
  };
  return go(schema, undefined);
};
