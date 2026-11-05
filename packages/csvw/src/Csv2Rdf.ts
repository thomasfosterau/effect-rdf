/**
 * Generating RDF from tabular data (CSV2RDF): an annotated table group to a
 * core `Dataset`, in standard mode (the table group, tables and rows framing
 * the cells' triples, with notes and common properties) or minimal mode (the
 * cells' triples only).
 *
 * @since 0.1.0
 */
import { Dataset, Term, Xsd } from '@thomasfosterau/effect-rdf';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
import type * as Schema from 'effect/Schema';
import * as Datatype from './Datatype.ts';
import * as Table from './Table.ts';
import * as Json from './internal/json.ts';
import * as Url from './internal/url.ts';
import * as Vocab from './internal/vocab.ts';

/**
 * The conversion mode: `standard` frames the cells' triples with the group,
 * table and row; `minimal` emits only the cells' triples.
 *
 * @since 0.1.0
 * @category models
 */
export type Mode = 'standard' | 'minimal';

/**
 * Options for `toDataset`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  /** The conversion mode (default `standard`). */
  readonly mode?: Mode | undefined;
}

const csvw = (local: string) => Term.namedNode(`${Vocab.CSVW}${local}`);
const rdfType = Term.namedNode(`${Vocab.RDF}type`);
const rdfFirst = Term.namedNode(`${Vocab.RDF}first`);
const rdfRest = Term.namedNode(`${Vocab.RDF}rest`);
const rdfNil = Term.namedNode(`${Vocab.RDF}nil`);
const xsdInteger = Term.namedNode(`${Vocab.XSD}integer`);

type Quads = Array<Term.Quad>;

const emit = (out: Quads, s: Term.Subject, p: Term.NamedNode, o: Term.Object): void => {
  out.push(Term.quad(s, p, o));
};

/** The RDF literal of a cell value (Interpreting datatypes). */
const literalOf = (value: Datatype.Value): Term.Literal =>
  Option.match(
    Option.filter(value.language, (l) => l !== 'und' && value.datatype === `${Vocab.XSD}string`),
    {
      onSome: (language) => Term.literal(value.lexical, language),
      onNone: () => Term.literal(value.lexical, Term.namedNode(value.datatype)),
    },
  );

const nodeOf = (url: string): Term.Subject =>
  url.startsWith('_:') ? Term.blankNode(url.slice(2)) : Term.namedNode(url);

// -----------------------------------------------------------------------------
// JSON-LD to RDF (notes and common properties)
// -----------------------------------------------------------------------------

const jsonLiteral = (value: Schema.Json): Option.Option<Term.Literal> => {
  if (Predicate.isBoolean(value)) return Option.some(Xsd.boolean(value));
  if (Predicate.isNumber(value))
    return Option.some(
      Number.isInteger(value)
        ? Term.literal(String(value), xsdInteger)
        : Term.literal(Xsd.canonicalDouble(value), Term.namedNode(`${Vocab.XSD}double`)),
    );
  if (Predicate.isString(value)) return Option.some(Term.literal(value));
  return Option.none();
};

/** The literal of a value object (`{"@value": …, "@language"|"@type": …}`). */
const valueObjectLiteral = (value: Schema.JsonObject): Term.Literal => {
  const v = value['@value'] ?? '';
  const lexical = Predicate.isString(v) ? v : Json.describe(v);
  const language = value['@language'];
  const type = value['@type'];
  if (Predicate.isString(language)) return Term.literal(lexical, language);
  if (Predicate.isString(type)) return Term.literal(lexical, Term.namedNode(Vocab.expand(type)));
  return Option.getOrElse(jsonLiteral(v), () => Term.literal(lexical));
};

const typesOf = (node: Schema.JsonObject): ReadonlyArray<string> =>
  Arr.filter(
    Option.match(Json.get(node, '@type'), {
      onNone: () => [],
      onSome: (t) => (Json.isArray(t) ? t : [t]),
    }),
    Predicate.isString,
  );

/** A node object: its node, its types and its properties. */
const nodeToRdf = (
  out: Quads,
  subject: Term.Subject,
  predicate: Term.NamedNode,
  value: Schema.JsonObject,
  base: string,
): void => {
  const id = value['@id'];
  const node = Predicate.isString(id) ? nodeOf(id) : Term.blankNode();
  emit(out, subject, predicate, node);
  Arr.forEach(typesOf(value), (t) =>
    emit(out, node, rdfType, Term.namedNode(Url.resolve(Vocab.expand(t), base))),
  );
  Arr.forEach(
    Arr.filter(Json.entries(value), ([k]) => !k.startsWith('@')),
    ([k, v]) => commonToRdf(out, node, k, v, base),
  );
};

/** JSON-LD to RDF (CSV2RDF §JSON-LD to RDF) for one property of a description. */
const commonToRdf = (
  out: Quads,
  subject: Term.Subject,
  property: string,
  value: Schema.Json,
  base: string,
): void => {
  const predicate = Term.namedNode(Url.resolve(Vocab.expand(property), base));
  if (Json.isArray(value)) Arr.forEach(value, (v) => commonToRdf(out, subject, property, v, base));
  else if (Json.isObject(value) && Json.has(value, '@value'))
    emit(out, subject, predicate, valueObjectLiteral(value));
  else if (Json.isObject(value)) nodeToRdf(out, subject, predicate, value, base);
  else Option.map(jsonLiteral(value), (l) => emit(out, subject, predicate, l));
};

const annotationsToRdf = (
  out: Quads,
  subject: Term.Subject,
  notes: ReadonlyArray<Schema.Json>,
  common: Readonly<Record<string, Schema.Json>>,
  base: string,
): void => {
  Arr.forEach(notes, (note) => commonToRdf(out, subject, 'notes', note, base));
  Arr.forEach(Record.toEntries(common), ([property, value]) =>
    commonToRdf(out, subject, property, value, base),
  );
};

// -----------------------------------------------------------------------------
// Cells
// -----------------------------------------------------------------------------

const listOf = (out: Quads, values: ReadonlyArray<Datatype.Value>): Term.Object =>
  Arr.reduceRight(values, listEnd, (rest, value) => {
    const node = Term.blankNode();
    emit(out, node, rdfFirst, literalOf(value));
    emit(out, node, rdfRest, rest);
    return node;
  });

const listEnd: Term.NamedNode | Term.BlankNode = rdfNil;

const rowToRdf = (
  out: Quads,
  table: Table.Table,
  row: Table.Row,
  rowNode: Option.Option<Term.BlankNode>,
): void => {
  const defaultSubject = Term.blankNode();
  Arr.forEach(row.cells, (cell) => {
    const column = table.columns[cell.column];
    if (column === undefined || column.isSuppressed) return;
    const subject = Option.match(cell.aboutUrl, {
      onNone: (): Term.Subject => defaultSubject,
      onSome: nodeOf,
    });
    Option.map(rowNode, (r) => emit(out, r, csvw('describes'), subject));
    const predicate = Term.namedNode(
      Option.getOrElse(cell.propertyUrl, () => `${Url.withoutFragment(table.url)}#${column.name}`),
    );
    Option.match(cell.valueUrl, {
      onSome: (url) => emit(out, subject, predicate, nodeOf(url)),
      onNone: () =>
        Table.CellValue.$match(cell.value, {
          Null: () => undefined,
          Single: ({ value }) => emit(out, subject, predicate, literalOf(value)),
          List: ({ values }) =>
            cell.ordered
              ? emit(out, subject, predicate, listOf(out, values))
              : Arr.forEach(values, (value) => emit(out, subject, predicate, literalOf(value))),
        }),
    });
  });
};

/**
 * Converts an annotated table group to RDF.
 *
 * @since 0.1.0
 * @category converting
 */
export const toDataset = (group: Table.TableGroup, options: Options = {}): Dataset.Dataset => {
  const standard = (options.mode ?? 'standard') === 'standard';
  const out: Quads = [];
  const groupNode = Option.match(group.id, {
    onNone: (): Term.Subject => Term.blankNode(),
    onSome: nodeOf,
  });
  const base = Option.getOrElse(
    Option.map(Arr.head(group.tables), (t) => t.url),
    () => '',
  );
  if (standard) {
    emit(out, groupNode, rdfType, csvw('TableGroup'));
    annotationsToRdf(out, groupNode, group.notes, group.common, base);
  }
  Arr.forEach(
    Arr.filter(group.tables, (t) => !t.isSuppressed),
    (table) => {
      const tableNode = Option.match(table.id, {
        onNone: (): Term.Subject => Term.blankNode(),
        onSome: nodeOf,
      });
      if (standard) {
        emit(out, groupNode, csvw('table'), tableNode);
        emit(out, tableNode, rdfType, csvw('Table'));
        emit(out, tableNode, csvw('url'), Term.namedNode(table.url));
        annotationsToRdf(out, tableNode, table.notes, table.common, table.url);
      }
      Arr.forEach(table.rows, (row) => {
        const rowNode = standard ? Option.some(Term.blankNode()) : Option.none();
        Option.map(rowNode, (r) => {
          emit(out, tableNode, csvw('row'), r);
          emit(out, r, rdfType, csvw('Row'));
          emit(out, r, csvw('rownum'), Term.literal(String(row.number), xsdInteger));
          emit(
            out,
            r,
            csvw('url'),
            Term.namedNode(`${Url.withoutFragment(table.url)}#row=${row.sourceNumber}`),
          );
          Arr.forEach(row.titles, (title) => emit(out, r, csvw('title'), literalOf(title)));
        });
        rowToRdf(out, table, row, rowNode);
      });
    },
  );
  return Dataset.fromIterable(out);
};

/**
 * `toDataset` as an Effect, with a span.
 *
 * @since 0.1.0
 * @category converting
 */
export const convert = (
  group: Table.TableGroup,
  options: Options = {},
): Effect.Effect<Dataset.Dataset> =>
  Effect.sync(() => toDataset(group, options)).pipe(
    Effect.tap((dataset) => Effect.annotateCurrentSpan('rdf.quads', dataset.size)),
    Effect.withSpan('Csv2Rdf.convert'),
  );
