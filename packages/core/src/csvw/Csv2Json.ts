/**
 * Generating JSON from tabular data (CSV2JSON): an annotated table group to
 * JSON, in standard mode (an object with the group's tables and their rows,
 * notes and common properties) or minimal mode (an array of the objects the
 * rows describe), with nested objects where one cell's value URL is another
 * cell's subject.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as HashMap from 'effect/HashMap';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
import type * as Schema from 'effect/Schema';
import * as Datatype from './Datatype.ts';
import * as Table from './Table.ts';
import * as Json from './internal/json.ts';
import { optional } from './internal/object.ts';
import * as Url from './internal/url.ts';
import * as Vocab from './internal/vocab.ts';

/**
 * The conversion mode: `standard` describes the group, tables and rows;
 * `minimal` lists only the objects the rows describe.
 *
 * @since 0.1.0
 * @category models
 */
export type Mode = 'standard' | 'minimal';

/**
 * Options for `toJson`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  /** The conversion mode (default `standard`). */
  readonly mode?: Mode | undefined;
}

/** The JSON value of a cell value (Interpreting datatypes). */
const jsonOf = (value: Datatype.Value): Schema.Json => {
  const base = Datatype.canonicalName(value.base);
  if (base === 'boolean') return value.lexical === 'true';
  if (Datatype.isNumeric(base)) {
    const n = Number(value.lexical);
    return Number.isFinite(n) ? n : value.lexical;
  }
  return value.lexical;
};

// -----------------------------------------------------------------------------
// JSON-LD to JSON (notes and common properties)
// -----------------------------------------------------------------------------

const commonToJson = (value: Schema.Json): Schema.Json => {
  if (Json.isArray(value)) return Arr.map(value, commonToJson);
  if (!Json.isObject(value)) return value;
  if (Json.has(value, '@value')) return value['@value'] ?? null;
  const keys = Json.keys(value);
  const id = value['@id'];
  if (Arr.length(keys) === 1 && Predicate.isString(id)) return id;
  return Json.mapValues(value, (v, k) =>
    k === '@type'
      ? Json.isArray(v)
        ? Arr.map(v, (t) => (Predicate.isString(t) ? Vocab.compact(Vocab.expand(t)) : t))
        : Predicate.isString(v)
          ? Vocab.compact(Vocab.expand(v))
          : v
      : commonToJson(v),
  );
};

const annotations = (
  notes: ReadonlyArray<Schema.Json>,
  common: Readonly<Record<string, Schema.Json>>,
): Record<string, Schema.Json> => ({
  ...Record.map(common, commonToJson),
  ...optional(
    'notes',
    Option.map(Option.liftPredicate(notes, Arr.isReadonlyArrayNonEmpty), (ns) =>
      Arr.map(ns, commonToJson),
    ),
  ),
});

// -----------------------------------------------------------------------------
// Objects described by a row
// -----------------------------------------------------------------------------

interface Subject {
  readonly id: Option.Option<string>;
  readonly entries: ReadonlyArray<readonly [string, Entry]>;
}

type Entry = Data.TaggedEnum<{
  Url: { readonly url: string };
  Value: { readonly value: Schema.Json };
}>;

const Entry = Data.taggedEnum<Entry>();

const isUrl = Entry.$is('Url');

/** The subject a cell describes: its about URL, or `''` for the row's default subject. */
const subjectKey = (cell: Table.Cell): string => Option.getOrElse(cell.aboutUrl, () => '');

const flat = (v: Schema.Json): ReadonlyArray<Schema.Json> => (Json.isArray(v) ? v : [v]);

const entryOf = (table: Table.Table, cell: Table.Cell): Option.Option<readonly [string, Entry]> => {
  const column = table.columns[cell.column];
  if (column === undefined || column.isSuppressed) return Option.none();
  const name = Option.match(cell.propertyUrl, {
    onNone: () => Url.decodeName(column.name),
    onSome: Vocab.compact,
  });
  return Option.match(cell.valueUrl, {
    onSome: (url) =>
      Option.some([name, Entry.Url({ url: name === '@type' ? Vocab.compact(url) : url })] as const),
    onNone: () =>
      Table.CellValue.$match(cell.value, {
        Null: () => Option.none(),
        Single: ({ value }) => Option.some([name, Entry.Value({ value: jsonOf(value) })] as const),
        List: ({ values }) =>
          Arr.isReadonlyArrayNonEmpty(values)
            ? Option.some([name, Entry.Value({ value: Arr.map(values, jsonOf) })] as const)
            : Option.none(),
      }),
  });
};

const subjectsOf = (table: Table.Table, row: Table.Row): ReadonlyArray<Subject> => {
  const order = Arr.dedupe(Arr.map(row.cells, subjectKey));
  return Arr.flatMap(order, (key) => {
    const cells = Arr.filter(row.cells, (c) => subjectKey(c) === key);
    const entries = Arr.getSomes(Arr.map(cells, (c) => entryOf(table, c)));
    if (!Arr.isReadonlyArrayNonEmpty(entries)) return [];
    return [{ id: key === '' ? Option.none() : Option.some(key), entries }];
  });
};

interface Forest {
  /** The parent of each subject placed in the forest (`None` for a root). */
  readonly parent: HashMap.HashMap<number, Option.Option<number>>;
  /** Root subjects, in the order they became roots. */
  readonly roots: ReadonlyArray<number>;
}

/** The nesting algorithm (§Generating Nested Objects). */
const nest = (subjects: ReadonlyArray<Subject>): ReadonlyArray<Schema.Json> => {
  const urls = Arr.flatMap(subjects, (s) =>
    Arr.flatMap(s.entries, ([, e]) => (isUrl(e) ? [e.url] : [])),
  );
  const counts = Arr.reduce(urls, HashMap.empty<string, number>(), (m, u) =>
    HashMap.set(m, u, Option.getOrElse(HashMap.get(m, u), () => 0) + 1),
  );
  const unique = (u: string) => Option.getOrElse(HashMap.get(counts, u), () => 0) === 1;
  const indexOfId = (id: string, except: number): Option.Option<number> =>
    Arr.findFirstIndex(subjects, (s, j) => j !== except && Option.exists(s.id, (x) => x === id));
  const rootOf = (forest: Forest, i: number): number =>
    Option.match(Option.flatten(HashMap.get(forest.parent, i)), {
      onNone: () => i,
      onSome: (p) => rootOf(forest, p),
    });
  const empty: Forest = { parent: HashMap.empty(), roots: [] };
  const forest = Arr.reduce(subjects, empty, (acc, subject, i) => {
    const placed: Forest = HashMap.has(acc.parent, i)
      ? acc
      : { parent: HashMap.set(acc.parent, i, Option.none()), roots: Arr.append(acc.roots, i) };
    return Arr.reduce(subject.entries, placed, (f, [, e]) => {
      if (!isUrl(e) || !unique(e.url)) return f;
      return Option.match(indexOfId(e.url, i), {
        onNone: () => f,
        onSome: (j) => {
          if (rootOf(f, i) === j) return f;
          if (Arr.contains(f.roots, j))
            return {
              parent: HashMap.set(f.parent, j, Option.some(i)),
              roots: Arr.filter(f.roots, (r) => r !== j),
            };
          if (HashMap.has(f.parent, j)) return f;
          return { parent: HashMap.set(f.parent, j, Option.some(i)), roots: f.roots };
        },
      });
    });
  });
  const isChildOf = (j: number, i: number): boolean =>
    Option.exists(Option.flatten(HashMap.get(forest.parent, j)), (p) => p === i);
  const render = (i: number): Schema.Json => {
    const s = subjects[i];
    if (s === undefined) return null;
    const pairs = Arr.map(s.entries, ([name, e]): readonly [string, Schema.Json] => {
      if (!isUrl(e)) return [name, e.value];
      return Option.match(
        Option.filter(indexOfId(e.url, i), (j) => unique(e.url) && isChildOf(j, i)),
        { onNone: () => [name, e.url], onSome: (j) => [name, render(j)] },
      );
    });
    const none: Record<string, Schema.Json> = {};
    const merged = Arr.reduce(pairs, none, (acc, [name, value]) =>
      Option.match(Record.get(acc, name), {
        onNone: () => ({ ...acc, [name]: value }),
        onSome: (existing) => ({ ...acc, [name]: [...flat(existing), ...flat(value)] }),
      }),
    );
    return Option.match(s.id, {
      onNone: () => merged,
      onSome: (id) => ({ '@id': id, ...merged }),
    });
  };
  return Arr.map(forest.roots, render);
};

/**
 * Converts an annotated table group to JSON.
 *
 * @since 0.1.0
 * @category converting
 */
export const toJson = (group: Table.TableGroup, options: Options = {}): Schema.Json => {
  const tables = Arr.filter(group.tables, (t) => !t.isSuppressed);
  if ((options.mode ?? 'standard') === 'minimal')
    return Arr.flatMap(tables, (table) =>
      Arr.flatMap(table.rows, (row) => nest(subjectsOf(table, row))),
    );
  return {
    ...Option.match(group.id, { onNone: () => ({}), onSome: (id) => ({ '@id': id }) }),
    ...annotations(group.notes, group.common),
    tables: Arr.map(tables, (table) => ({
      ...Option.match(table.id, { onNone: () => ({}), onSome: (id) => ({ '@id': id }) }),
      url: table.url,
      ...annotations(table.notes, table.common),
      row: Arr.map(table.rows, (row) => ({
        url: `${Url.withoutFragment(table.url)}#row=${row.sourceNumber}`,
        rownum: row.number,
        ...Arr.match(row.titles, {
          onEmpty: () => ({}),
          onNonEmpty: (titles) => ({
            titles:
              Arr.length(titles) === 1
                ? Arr.headNonEmpty(titles).lexical
                : Arr.map(titles, (t) => t.lexical),
          }),
        }),
        describes: nest(subjectsOf(table, row)),
      })),
    })),
  };
};

/**
 * `toJson` as an Effect, with a span.
 *
 * @since 0.1.0
 * @category converting
 */
export const convert = (
  group: Table.TableGroup,
  options: Options = {},
): Effect.Effect<Schema.Json> =>
  Effect.sync(() => toJson(group, options)).pipe(Effect.withSpan('Csv2Json.convert'));
