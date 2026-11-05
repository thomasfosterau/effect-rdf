/**
 * The annotated tabular data model (Tabular Data Model §Tabular Data Models):
 * an already-parsed table (`Source`, rows of cell strings in file order) is
 * read with its dialect's row-level flags (skipped rows, header rows, comment
 * rows, blank rows, skipped columns, trimming), its embedded metadata is
 * extracted and checked against the metadata, and every cell is parsed with
 * its column's datatype into an annotated table, with the cell, primary-key
 * and foreign-key errors in a validation report.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Data from 'effect/Data';
import * as HashMap from 'effect/HashMap';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import type * as Schema from 'effect/Schema';
import * as Datatype from './Datatype.ts';
import * as Metadata from './Metadata.ts';
import * as Report from './Report.ts';
import * as UriTemplate from './internal/uriTemplate.ts';
import * as Url from './internal/url.ts';
import * as Vocab from './internal/vocab.ts';

// -----------------------------------------------------------------------------
// Input
// -----------------------------------------------------------------------------

/**
 * An already-parsed tabular data file: its URL and its records, in file
 * order, as cell strings — every record, including skipped, header, comment
 * and blank ones, with quotes and escapes already removed. Trimming, comment
 * prefixes, skipped rows and columns and header rows are applied from the
 * table's dialect.
 *
 * @since 0.1.0
 * @category models
 */
export interface Source {
  readonly url: string;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

// -----------------------------------------------------------------------------
// Annotated model
// -----------------------------------------------------------------------------

/**
 * An annotated column, with every inherited property resolved.
 *
 * @since 0.1.0
 * @category models
 */
export interface Column {
  /** Position among the table's columns, from 1. */
  readonly number: number;
  /** Position in the source file, from 1 (`None` for a virtual column). */
  readonly sourceNumber: Option.Option<number>;
  readonly id: Option.Option<string>;
  /** The column name (percent-encoded when derived from a title). */
  readonly name: string;
  readonly titles: Metadata.LanguageMap;
  readonly isVirtual: boolean;
  readonly isSuppressed: boolean;
  readonly datatype: Datatype.Datatype;
  readonly default: string;
  readonly lang: string;
  readonly null: ReadonlyArray<string>;
  readonly ordered: boolean;
  readonly required: boolean;
  readonly separator: Option.Option<string>;
  readonly textDirection: 'ltr' | 'rtl' | 'auto';
  readonly aboutUrl: Option.Option<string>;
  readonly propertyUrl: Option.Option<string>;
  readonly valueUrl: Option.Option<string>;
  readonly common: Metadata.CommonProperties;
}

/**
 * The value of a cell: null, a single value, or a list of values (a column
 * with a `separator`).
 *
 * @since 0.1.0
 * @category models
 */
export type CellValue = Data.TaggedEnum<{
  /** No value (a variant without fields). */
  Null: { readonly value?: never };
  Single: { readonly value: Datatype.Value };
  List: { readonly values: ReadonlyArray<Datatype.Value> };
}>;

/**
 * Constructors and matchers for `CellValue`.
 *
 * @since 0.1.0
 * @category models
 */
export const CellValue = Data.taggedEnum<CellValue>();

const nullValue: CellValue = CellValue.Null({});

/**
 * An annotated cell.
 *
 * @since 0.1.0
 * @category models
 */
export interface Cell {
  /** Index of the cell's column in `Table.columns`. */
  readonly column: number;
  readonly stringValue: string;
  readonly value: CellValue;
  readonly errors: ReadonlyArray<string>;
  readonly aboutUrl: Option.Option<string>;
  readonly propertyUrl: Option.Option<string>;
  readonly valueUrl: Option.Option<string>;
  readonly ordered: boolean;
  readonly textDirection: 'ltr' | 'rtl' | 'auto';
}

/**
 * An annotated row.
 *
 * @since 0.1.0
 * @category models
 */
export interface Row {
  /** Position among the table's rows, from 1. */
  readonly number: number;
  /** Position in the source file, from 1. */
  readonly sourceNumber: number;
  readonly cells: ReadonlyArray<Cell>;
  /** The row titles (from the schema's `rowTitles` columns). */
  readonly titles: ReadonlyArray<Datatype.Value>;
}

/**
 * An annotated table.
 *
 * @since 0.1.0
 * @category models
 */
export interface Table {
  readonly url: string;
  readonly id: Option.Option<string>;
  readonly schemaId: Option.Option<string>;
  readonly isSuppressed: boolean;
  readonly tableDirection: Metadata.TableDirection;
  readonly dialect: Metadata.Dialect;
  readonly notes: ReadonlyArray<Schema.Json>;
  /** Non-core annotations: the table description's common properties. */
  readonly common: Metadata.CommonProperties;
  readonly columns: ReadonlyArray<Column>;
  readonly rows: ReadonlyArray<Row>;
  readonly primaryKey: ReadonlyArray<string>;
  readonly foreignKeys: ReadonlyArray<Metadata.ForeignKey>;
  readonly transformations: ReadonlyArray<Metadata.Transformation>;
}

/**
 * An annotated group of tables.
 *
 * @since 0.1.0
 * @category models
 */
export interface TableGroup {
  readonly id: Option.Option<string>;
  readonly notes: ReadonlyArray<Schema.Json>;
  readonly common: Metadata.CommonProperties;
  readonly tables: ReadonlyArray<Table>;
}

// -----------------------------------------------------------------------------
// Reading rows and embedded metadata
// -----------------------------------------------------------------------------

/**
 * A data row as read from a source: its source row number and its cells
 * (after skipped columns, trimmed).
 *
 * @since 0.1.0
 * @category models
 */
export interface SourceRow {
  readonly sourceNumber: number;
  readonly cells: ReadonlyArray<string>;
}

/**
 * What reading a source with a dialect yields: the embedded metadata (column
 * titles from the header rows, comment rows) and the data rows.
 *
 * @since 0.1.0
 * @category models
 */
export interface Embedded {
  readonly columns: ReadonlyArray<Metadata.Column>;
  readonly comments: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<SourceRow>;
}

interface Reading {
  readonly headers: Array<ReadonlyArray<string>>;
  readonly comments: Array<string>;
  readonly rows: Array<SourceRow>;
}

const trimCell = (value: string, trim: Metadata.Trim): string =>
  trim === 'true'
    ? value.trim()
    : trim === 'start'
      ? value.trimStart()
      : trim === 'end'
        ? value.trimEnd()
        : value;

const emptyColumn = (titles: Metadata.LanguageMap): Metadata.Column => ({
  ...Option.match(Option.flatMap(Arr.head(Record.values(titles)), Arr.head), {
    onNone: () => ({}),
    onSome: (titleName) => ({ titleName }),
  }),
  titles,
  isVirtual: false,
  isSuppressed: false,
  inherited: {},
  common: {},
});

/**
 * Reads a source with a dialect (Tabular Data Model §Parsing Tabular Data,
 * from the point a row's cells are known): skipped rows and comment rows
 * become comments, header rows become column titles in `lang`, and the
 * remaining rows (less blank ones when `skipBlankRows`) are the data.
 *
 * @since 0.1.0
 * @category reading
 */
export const read = (source: Source, dialect: Metadata.Dialect, lang: string): Embedded => {
  const prefix = Option.fromNullishOr(dialect.commentPrefix);
  const content = (cells: ReadonlyArray<string>) => Arr.join(cells, dialect.delimiter);
  const comment = (cells: ReadonlyArray<string>): Option.Option<string> =>
    Option.flatMap(prefix, (p) => {
      const c = content(cells);
      return c.startsWith(p) ? Option.some(c.slice(p.length).trim()) : Option.none();
    });
  const cellsOf = (cells: ReadonlyArray<string>) =>
    Arr.map(Arr.drop(cells, dialect.skipColumns), (c) => trimCell(c, dialect.trim));
  const numbered = Arr.map(source.rows, (cells, i) => ({ cells, sourceNumber: i + 1 }));
  const [skipped, rest] = Arr.splitAt(numbered, dialect.skipRows);
  const skippedComments = Arr.flatMap(skipped, ({ cells }) =>
    Option.match(comment(cells), {
      onSome: (c) => [c],
      onNone: () => {
        const c = content(cells).trim();
        return c === '' ? [] : [c];
      },
    }),
  );
  // Header rows are the first `headerRowCount` rows that are not comments.
  const initial: Reading = { headers: [], comments: [], rows: [] };
  const state = Arr.reduce(rest, initial, (acc, { cells, sourceNumber }) => {
    const c = comment(cells);
    if (Option.isSome(c)) {
      acc.comments.push(c.value);
      return acc;
    }
    if (Arr.length(acc.headers) < dialect.headerRowCount) {
      acc.headers.push(cellsOf(cells));
      return acc;
    }
    const data = cellsOf(cells);
    if (dialect.shouldSkipBlankRows && Arr.every(data, (v) => v === '')) return acc;
    acc.rows.push({ sourceNumber, cells: data });
    return acc;
  });
  const width = Math.max(
    0,
    ...Arr.map(state.headers, Arr.length),
    ...Arr.map(Arr.take(state.rows, 1), (r) => Arr.length(r.cells)),
  );
  const columns = Arr.makeBy(width, (i) => {
    const titles = Arr.filter(
      Arr.map(state.headers, (h) => ((h[i] ?? '').trim() === '' ? '' : (h[i] ?? ''))),
      (t) => t !== '',
    );
    return emptyColumn(Arr.isReadonlyArrayNonEmpty(titles) ? { [lang]: titles } : {});
  });
  return {
    columns: dialect.headerRowCount === 0 ? Arr.map(columns, () => emptyColumn({})) : columns,
    comments: Arr.appendAll(skippedComments, state.comments),
    rows: state.rows,
  };
};

// -----------------------------------------------------------------------------
// Columns
// -----------------------------------------------------------------------------

const nameOf = (column: Metadata.Column, number: number): string =>
  column.name ??
  (column.titleName === undefined ? `_col.${number}` : Url.encodeName(column.titleName));

const annotateColumn = (
  column: Metadata.Column,
  number: number,
  sourceNumber: Option.Option<number>,
  inherited: ReadonlyArray<Metadata.Inherited>,
  tableDirection: Metadata.TableDirection,
): Column => {
  const p = Metadata.inherit(column.inherited, ...inherited);
  const direction = p.textDirection ?? 'inherit';
  return {
    number,
    sourceNumber,
    id: Option.fromNullishOr(column.id),
    name: nameOf(column, number),
    titles: column.titles,
    isVirtual: column.isVirtual,
    isSuppressed: column.isSuppressed,
    datatype: p.datatype ?? Datatype.string,
    default: p.default ?? '',
    lang: p.lang ?? 'und',
    null: p.null ?? [''],
    ordered: p.ordered ?? false,
    required: p.required ?? false,
    separator: Option.fromNullishOr(p.separator),
    textDirection: direction === 'inherit' ? tableDirection : direction,
    aboutUrl: Option.fromNullishOr(p.aboutUrl),
    propertyUrl: Option.fromNullishOr(p.propertyUrl),
    valueUrl: Option.fromNullishOr(p.valueUrl),
    common: column.common,
  };
};

// -----------------------------------------------------------------------------
// Cells
// -----------------------------------------------------------------------------

const keepsWhitespace = (base: string): boolean =>
  Arr.contains(['string', 'json', 'xml', 'html', 'anyAtomicType'], Datatype.canonicalName(base));

const normalizeWhitespace = (value: string, base: string): string => {
  if (keepsWhitespace(base)) return value;
  const spaced = value.replace(/[\r\n\t]/g, ' ');
  return Datatype.canonicalName(base) === 'normalizedString'
    ? spaced
    : spaced.trim().replace(/ {2,}/g, ' ');
};

interface Parsed {
  readonly value: CellValue;
  readonly errors: ReadonlyArray<string>;
}

interface ParsedItem {
  readonly value: Option.Option<Datatype.Value>;
  readonly errors: ReadonlyArray<string>;
}

const parseItem = (text: string, column: Column): ParsedItem => {
  const s = text === '' ? column.default : text;
  if (Arr.contains(column.null, s)) return { value: Option.none(), errors: [] };
  const language = Option.some(column.lang);
  return Result.match(Datatype.parse(s, column.datatype, language), {
    onSuccess: (value) => ({ value: Option.some(value), errors: [] }),
    onFailure: (errors) => ({
      value: Option.some(
        Datatype.stringValue(
          s,
          Datatype.canonicalName(column.datatype.base) === 'string' ? language : Option.none(),
        ),
      ),
      errors,
    }),
  });
};

/**
 * Parses a cell's string value with its column (Tabular Data Model §Parsing
 * Cells): whitespace normalization, `default`, `null`, `separator` lists,
 * the datatype and its constraints, and `required`.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseCell = (stringValue: string, column: Column): Parsed => {
  const base = column.datatype.base;
  const normalized = normalizeWhitespace(stringValue, base);
  const s = normalized === '' ? column.default : normalized;
  const required = (value: CellValue, errors: ReadonlyArray<string>): Parsed => ({
    value,
    errors:
      column.required && CellValue.$is('Null')(value)
        ? Arr.append(errors, 'a required cell is null')
        : errors,
  });
  return Option.match(column.separator, {
    onNone: () => {
      const item = parseItem(s, column);
      return required(
        Option.match(item.value, {
          onNone: () => nullValue,
          onSome: (value) => CellValue.Single({ value }),
        }),
        item.errors,
      );
    },
    onSome: (separator) => {
      if (s === '')
        return {
          value: CellValue.List({ values: [] }),
          errors: column.required ? ['a required cell is empty'] : [],
        };
      if (Arr.contains(column.null, s)) return required(nullValue, []);
      const strip = !Arr.contains(['string', 'anyAtomicType'], Datatype.canonicalName(base));
      const items = Arr.map(s.split(separator), (part) =>
        parseItem(strip ? part.trim() : part, column),
      );
      return {
        value: CellValue.List({ values: Arr.getSomes(Arr.map(items, (i) => i.value)) }),
        errors: Arr.flatMap(items, (i) => i.errors),
      };
    },
  });
};

const templateValue = (value: CellValue): Option.Option<UriTemplate.Value> =>
  CellValue.$match(value, {
    Null: () => Option.none(),
    Single: ({ value: v }) => Option.some(v.lexical),
    List: ({ values }) => Option.some(Arr.map(values, (v) => v.lexical)),
  });

const expandTemplate = (
  template: string,
  variables: Readonly<Record<string, UriTemplate.Value>>,
  tableUrl: string,
): string => {
  const expanded = UriTemplate.expand(template, variables);
  return Url.resolve(
    Option.getOrElse(Vocab.expandPrefixed(expanded), () => expanded),
    tableUrl,
  );
};

// -----------------------------------------------------------------------------
// Annotating a table
// -----------------------------------------------------------------------------

/**
 * Options for annotating tables.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  /**
   * Validate (default `false`): metadata incompatible with the data and
   * invalid cells are errors rather than warnings, and primary and foreign
   * keys are checked.
   */
  readonly validate?: boolean | undefined;
}

/**
 * An annotated table and the issues raised while annotating it.
 *
 * @since 0.1.0
 * @category models
 */
export interface Annotated {
  readonly table: Table;
  readonly issues: ReadonlyArray<Report.Issue>;
}

/**
 * Annotates one table of a group from its source: reads it with the table's
 * dialect, checks the metadata against the embedded metadata, and parses
 * every cell. Returns the annotated table and its issues.
 *
 * @since 0.1.0
 * @category annotating
 */
export const annotate = (
  group: Metadata.TableGroup,
  table: Metadata.Table,
  source: Source,
  options: Options = {},
): Annotated => {
  const validate = options.validate ?? false;
  const level = validate ? Report.error : Report.warning;
  const schema = Metadata.schemaOfTable(group, table);
  const dialect = Metadata.dialectOfTable(group, table);
  const tableInherited = Metadata.inherit(table.inherited, group.inherited);
  const schemaInherited = Option.match(schema, { onNone: () => ({}), onSome: (s) => s.inherited });
  const lang = Metadata.inherit(schemaInherited, tableInherited).lang ?? 'und';
  const embedded = read(source, dialect, lang);
  const tableDirection = table.tableDirection ?? group.tableDirection ?? 'auto';
  const compatibility = Option.flatMap(schema, (s) =>
    Metadata.checkCompatible(s.columns, embedded.columns, validate),
  );
  const described = Option.match(schema, {
    onNone: () => embedded.columns,
    onSome: (s) => s.columns,
  });
  const real = Arr.filter(described, (c) => !c.isVirtual);
  const virtual = Arr.filter(described, (c) => c.isVirtual);
  const width = Math.max(Arr.length(real), Arr.length(embedded.columns));
  const inherited = [schemaInherited, table.inherited, group.inherited];
  const realColumns = Arr.makeBy(width, (i) =>
    annotateColumn(
      real[i] ?? emptyColumn({}),
      i + 1,
      Option.some(dialect.skipColumns + i + 1),
      inherited,
      tableDirection,
    ),
  );
  const columns = Arr.appendAll(
    realColumns,
    Arr.map(virtual, (c, i) =>
      annotateColumn(c, width + i + 1, Option.none(), inherited, tableDirection),
    ),
  );
  const rowTitles = Option.getOrElse(
    Option.flatMap(schema, (s) => Option.fromNullishOr(s.rowTitles)),
    () => [],
  );
  const issues: Array<Report.Issue> = Arr.fromOption(
    Option.map(compatibility, (message) => level(message, { table: table.url })),
  );
  const rows = Arr.map(embedded.rows, ({ sourceNumber, cells }, index): Row => {
    const parsed = Arr.map(columns, (column, i) =>
      parseCell(column.isVirtual ? '' : (cells[i] ?? ''), column),
    );
    const variables: Record<string, UriTemplate.Value> = Record.fromEntries(
      Arr.flatMap(columns, (c, i) =>
        Arr.fromOption(
          Option.map(templateValue(parsed[i]?.value ?? nullValue), (v) => [c.name, v] as const),
        ),
      ),
    );
    const annotated = Arr.map(columns, (column, i): Cell => {
      const p = parsed[i] ?? { value: nullValue, errors: [] };
      const vars = {
        ...variables,
        _column: String(column.number),
        _sourceColumn: String(Option.getOrElse(column.sourceNumber, () => column.number)),
        _row: String(index + 1),
        _sourceRow: String(sourceNumber),
        _name: Url.decodeName(column.name),
      };
      const expand = (t: Option.Option<string>) =>
        Option.map(t, (template) => expandTemplate(template, vars, table.url));
      Arr.forEach(p.errors, (message) =>
        issues.push(
          level(`${column.name}: ${message}`, {
            table: table.url,
            row: sourceNumber,
            column: Option.getOrElse(column.sourceNumber, () => column.number),
          }),
        ),
      );
      return {
        column: i,
        stringValue: column.isVirtual ? '' : (cells[i] ?? ''),
        value: p.value,
        errors: p.errors,
        aboutUrl: expand(column.aboutUrl),
        propertyUrl: expand(column.propertyUrl),
        valueUrl:
          CellValue.$is('Null')(p.value) && !column.isVirtual
            ? Option.none()
            : expand(column.valueUrl),
        ordered: column.ordered,
        textDirection: column.textDirection,
      };
    });
    const titles = Arr.flatMap(rowTitles, (name) =>
      Option.match(
        Arr.findFirstIndex(columns, (c) => c.name === name),
        {
          onNone: () => [],
          onSome: (i) =>
            CellValue.$match(annotated[i]?.value ?? nullValue, {
              Null: () => [],
              Single: ({ value }) => [value],
              List: ({ values }) => values,
            }),
        },
      ),
    );
    return { number: index + 1, sourceNumber, cells: annotated, titles };
  });
  const common = Arr.isReadonlyArrayNonEmpty(embedded.comments)
    ? {
        ...table.common,
        'rdfs:comment': Arr.appendAll(
          Arr.ensure(table.common['rdfs:comment'] ?? []),
          Arr.map(embedded.comments, (c): Schema.Json => ({ '@value': c })),
        ),
      }
    : table.common;
  return {
    table: {
      url: table.url,
      id: Option.fromNullishOr(table.id),
      schemaId: Option.flatMap(schema, (s) => Option.fromNullishOr(s.id)),
      isSuppressed: table.isSuppressed,
      tableDirection,
      dialect,
      notes: table.notes,
      common,
      columns,
      rows,
      primaryKey: Option.getOrElse(
        Option.flatMap(schema, (s) => Option.fromNullishOr(s.primaryKey)),
        () => [],
      ),
      foreignKeys: Option.match(schema, { onNone: () => [], onSome: (s) => s.foreignKeys }),
      transformations: Arr.appendAll(table.transformations, group.transformations),
    },
    issues,
  };
};

// -----------------------------------------------------------------------------
// Keys
// -----------------------------------------------------------------------------

const keyOf = (row: Row, indexes: ReadonlyArray<number>): string =>
  Arr.join(
    Arr.map(indexes, (i) =>
      CellValue.$match(row.cells[i]?.value ?? nullValue, {
        Null: () => '\u0000',
        Single: ({ value }) => value.lexical,
        List: ({ values }) =>
          Arr.join(
            Arr.map(values, (v) => v.lexical),
            '\u0001',
          ),
      }),
    ),
    '\u0002',
  );

const indexesOf = (
  table: Table,
  names: ReadonlyArray<string>,
): Option.Option<ReadonlyArray<number>> =>
  Option.all(Arr.map(names, (n) => Arr.findFirstIndex(table.columns, (c) => c.name === n)));

const countKeys = (table: Table, indexes: ReadonlyArray<number>): HashMap.HashMap<string, number> =>
  Arr.reduce(table.rows, HashMap.empty<string, number>(), (map, row) => {
    const key = keyOf(row, indexes);
    return HashMap.set(map, key, Option.getOrElse(HashMap.get(map, key), () => 0) + 1);
  });

/**
 * Finds the table a foreign key references: by `resource` URL or by
 * `schemaReference` (exactly one table must use that schema).
 *
 * @since 0.1.0
 * @category keys
 */
export const referencedTable = (
  tables: ReadonlyArray<Table>,
  reference: Metadata.Reference,
): Option.Option<Table> => {
  if (reference.resource !== undefined) {
    const url = Url.normalize(reference.resource);
    return Arr.findFirst(tables, (t) => Url.normalize(t.url) === url);
  }
  const schema = reference.schemaReference;
  const matching = Arr.filter(tables, (t) => Option.exists(t.schemaId, (id) => id === schema));
  return Arr.length(matching) === 1 ? Arr.head(matching) : Option.none();
};

/**
 * Checks that every foreign key of a group references an existing table and
 * columns, returning the errors (these stop processing).
 *
 * @since 0.1.0
 * @category keys
 */
export const checkForeignKeyTargets = (tables: ReadonlyArray<Table>): ReadonlyArray<string> =>
  Arr.flatMap(tables, (table) =>
    Arr.flatMap(table.foreignKeys, (fk) =>
      Option.match(referencedTable(tables, fk.reference), {
        onNone: () => [`${table.url}: a foreign key references a table that is not in the group`],
        onSome: (target) =>
          Option.isSome(indexesOf(target, fk.reference.columnReference))
            ? []
            : [`${table.url}: a foreign key references a column that is not in ${target.url}`],
      }),
    ),
  );

/**
 * Validates the primary keys and foreign keys of a group's tables: each row's
 * primary key is unique, and each row's foreign keys reference exactly one
 * row.
 *
 * @since 0.1.0
 * @category keys
 */
export const validateKeys = (tables: ReadonlyArray<Table>): ReadonlyArray<Report.Issue> => {
  const primary = Arr.flatMap(tables, (table) =>
    Option.match(indexesOf(table, table.primaryKey), {
      onNone: () => [],
      onSome: (indexes) => {
        if (!Arr.isReadonlyArrayNonEmpty(indexes)) return [];
        const counts = countKeys(table, indexes);
        return Arr.flatMap(table.rows, (row) =>
          Option.getOrElse(HashMap.get(counts, keyOf(row, indexes)), () => 0) > 1
            ? [Report.error('duplicate primary key', { table: table.url, row: row.sourceNumber })]
            : [],
        );
      },
    }),
  );
  const foreign = Arr.flatMap(tables, (table) =>
    Arr.flatMap(table.foreignKeys, (fk) =>
      Option.match(
        Option.all([
          indexesOf(table, fk.columnReference),
          Option.flatMap(referencedTable(tables, fk.reference), (target) =>
            Option.map(
              indexesOf(target, fk.reference.columnReference),
              (ix) => [target, ix] as const,
            ),
          ),
        ]),
        {
          onNone: () => [],
          onSome: ([indexes, [target, targetIndexes]]) => {
            const counts = countKeys(target, targetIndexes);
            return Arr.flatMap(table.rows, (row) => {
              const n = Option.getOrElse(HashMap.get(counts, keyOf(row, indexes)), () => 0);
              return n === 1
                ? []
                : [
                    Report.error(
                      n === 0
                        ? `foreign key references no row of ${target.url}`
                        : `foreign key references ${n} rows of ${target.url}`,
                      { table: table.url, row: row.sourceNumber },
                    ),
                  ];
            });
          },
        },
      ),
    ),
  );
  return Arr.appendAll(primary, foreign);
};
