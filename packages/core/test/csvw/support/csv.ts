/**
 * TEST SUPPORT ONLY — a minimal RFC 4180 record splitter standing in for
 * `@thomasfosterau/effect-csv` (unpublished) so the conformance suite can feed
 * `effect-rdf/csvw` already-parsed tables. It honours the dialect fields the W3C
 * tests use (`encoding`, `delimiter`, `quoteChar`, `doubleQuote`,
 * `lineTerminators`) and returns every record, untrimmed; the row-level
 * flags (skipped rows, header rows, comments, trimming) are applied by
 * `Table.read`.
 */
import * as Arr from 'effect/Array';
import * as Order from 'effect/Order';
import type { Metadata } from '@thomasfosterau/effect-rdf/csvw';

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface State {
  readonly rows: Array<ReadonlyArray<string>>;
  readonly row: Array<string>;
  readonly cell: string;
  /** Whether anything has been read since the last record ended. */
  readonly open: boolean;
}

/** Decodes bytes with the dialect's encoding, dropping a byte order mark. */
export const decode = (bytes: Uint8Array, encoding: string): string =>
  new TextDecoder(encoding).decode(bytes);

/** Splits CSV text into records of cell strings. */
export const parse = (
  text: string,
  dialect: Metadata.Dialect,
): ReadonlyArray<ReadonlyArray<string>> => {
  const q = dialect.quoteChar;
  const terminators = Arr.sort(
    dialect.lineTerminators,
    Order.mapInput(Order.Number, (t: string) => -t.length),
  );
  const alternatives = [
    ...(q === null
      ? []
      : [
          dialect.isDoubleQuoted
            ? `${escape(q)}(?:[^${escape(q)}]|${escape(q)}${escape(q)})*${escape(q)}`
            : `${escape(q)}(?:[^${escape(q)}\\\\]|\\\\[\\s\\S])*${escape(q)}`,
        ]),
    escape(dialect.delimiter),
    ...Arr.map(terminators, escape),
    `(?:(?!${Arr.join([escape(dialect.delimiter), ...Arr.map(terminators, escape), ...(q === null ? [] : [escape(q)])], '|')})[\\s\\S])+`,
  ];
  const tokens = Array.from(text.matchAll(new RegExp(alternatives.join('|'), 'gu')), (m) => m[0]);
  const unquote = (token: string): string => {
    const body = token.slice(q?.length ?? 0, token.length - (q?.length ?? 0));
    return q === null
      ? token
      : dialect.isDoubleQuoted
        ? body.split(q + q).join(q)
        : body.replace(/\\([\s\S])/g, '$1');
  };
  const start: State = { rows: [], row: [], cell: '', open: false };
  const final = Arr.reduce(tokens, start, (s, token) => {
    if (token === dialect.delimiter) {
      s.row.push(s.cell);
      return { ...s, cell: '', open: true };
    }
    if (Arr.contains(terminators, token)) {
      s.rows.push([...s.row, s.cell]);
      return { rows: s.rows, row: [], cell: '', open: false };
    }
    if (q !== null && token.startsWith(q) && token.length >= 2 * q.length && token.endsWith(q))
      return { ...s, cell: s.cell + unquote(token), open: true };
    return { ...s, cell: s.cell + token, open: true };
  });
  return final.open ? [...final.rows, [...final.row, final.cell]] : final.rows;
};
