/**
 * Typed accessors for PDF/A (ISO 19005): the identification schema
 * (`pdfaid:part`, `pdfaid:conformance`, …) every PDF/A file declares, and
 * the extension schema descriptions (`pdfaExtension:schemas`) that PDF/A-1
 * through PDF/A-3 require for every property outside the predefined
 * schemas.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';
import * as Accessors from './internal/accessors.ts';
import * as Metadata from './Metadata.ts';
import {
  PDFA_EXTENSION,
  PDFA_FIELD,
  PDFA_ID,
  PDFA_PROPERTY,
  PDFA_SCHEMA,
  PDFA_TYPE,
} from './Namespaces.ts';

/**
 * The PDF/A identification of a document.
 *
 * @since 0.1.0
 * @category models
 */
export interface Identification {
  /** The part of ISO 19005, such as `2` for PDF/A-2 (`pdfaid:part`). */
  readonly part: number;
  /** The conformance level, such as `"B"`, `"U"` or `"A"` (`pdfaid:conformance`). */
  readonly conformance: Option.Option<string>;
  /** The amendment identifier (`pdfaid:amd`). */
  readonly amendment: Option.Option<string>;
  /** The revision year, from PDF/A-4 on (`pdfaid:rev`). */
  readonly revision: Option.Option<string>;
}

const PART = `${PDFA_ID}part`;
const CONFORMANCE = `${PDFA_ID}conformance`;
const AMENDMENT = `${PDFA_ID}amd`;
const REVISION = `${PDFA_ID}rev`;

/**
 * The PDF/A identification, when `pdfaid:part` is present and an integer.
 *
 * @since 0.1.0
 * @category getters
 */
export const identification = (self: Metadata.Metadata): Option.Option<Identification> =>
  Option.map(Accessors.integer(PART)(self), (part) => ({
    part,
    conformance: Metadata.getText(self, CONFORMANCE),
    amendment: Metadata.getText(self, AMENDMENT),
    revision: Metadata.getText(self, REVISION),
  }));

const setOptional = (self: Metadata.Metadata, iri: string, value: Option.Option<string>) =>
  Option.match(value, {
    onNone: () => Metadata.remove(self, iri),
    onSome: (v) => Metadata.set(self, iri, Metadata.text(v)),
  });

/**
 * Sets the PDF/A identification, removing the optional properties that are
 * `None`.
 *
 * @since 0.1.0
 * @category setters
 */
export const setIdentification: Metadata.Setter<Identification> = Accessors.dualSetter(
  (self: Metadata.Metadata, id: Identification) =>
    setOptional(
      setOptional(
        setOptional(
          Metadata.set(self, PART, Metadata.text(String(id.part))),
          CONFORMANCE,
          id.conformance,
        ),
        AMENDMENT,
        id.amendment,
      ),
      REVISION,
      id.revision,
    ),
);

// -----------------------------------------------------------------------------
// Extension schemas
// -----------------------------------------------------------------------------

/**
 * A property of an extension schema (`pdfaProperty:` fields).
 *
 * @since 0.1.0
 * @category models
 */
export interface ExtensionProperty {
  /** The property's local name. */
  readonly name: string;
  /** Its value type, such as `"Text"`, `"Date"` or `"seq Text"`. */
  readonly valueType: string;
  /** `"internal"` or `"external"`. */
  readonly category: string;
  readonly description: string;
}

/**
 * A field of an extension value type (`pdfaField:` fields).
 *
 * @since 0.1.0
 * @category models
 */
export interface ExtensionField {
  readonly name: string;
  readonly valueType: string;
  readonly description: string;
}

/**
 * A structured value type an extension schema defines (`pdfaType:` fields).
 *
 * @since 0.1.0
 * @category models
 */
export interface ExtensionValueType {
  /** The type's name. */
  readonly type: string;
  readonly namespaceUri: string;
  readonly prefix: string;
  readonly description: string;
  readonly fields: ReadonlyArray<ExtensionField>;
}

/**
 * An extension schema description (`pdfaSchema:` fields), one entry of
 * `pdfaExtension:schemas`.
 *
 * @since 0.1.0
 * @category models
 */
export interface ExtensionSchema {
  /** The schema's human-readable name. */
  readonly schema: string;
  readonly namespaceUri: string;
  readonly prefix: string;
  readonly properties: ReadonlyArray<ExtensionProperty>;
  readonly valueTypes: ReadonlyArray<ExtensionValueType>;
}

const SCHEMAS = `${PDFA_EXTENSION}schemas`;

const fieldsOf = (value: Metadata.Value): Option.Option<Metadata.Entries> =>
  Metadata.isStruct(value) ? Option.some(value.fields) : Option.none();

const readText = (fields: Metadata.Entries, iri: string): string =>
  Option.getOrElse(Option.flatMap(Metadata.lookup(fields, iri), Metadata.textOf), () => '');

/** The structures in an array, skipping items that are not structures. */
const structsOf = (value: Metadata.Value): ReadonlyArray<Metadata.Entries> =>
  Metadata.isArray(value) ? Arr.getSomes(Arr.map(value.items, fieldsOf)) : [];

const readStructs = (fields: Metadata.Entries, iri: string): ReadonlyArray<Metadata.Entries> =>
  Option.match(Metadata.lookup(fields, iri), { onNone: () => [], onSome: structsOf });

const readProperty = (fields: Metadata.Entries): ExtensionProperty => ({
  name: readText(fields, `${PDFA_PROPERTY}name`),
  valueType: readText(fields, `${PDFA_PROPERTY}valueType`),
  category: readText(fields, `${PDFA_PROPERTY}category`),
  description: readText(fields, `${PDFA_PROPERTY}description`),
});

const readField = (fields: Metadata.Entries): ExtensionField => ({
  name: readText(fields, `${PDFA_FIELD}name`),
  valueType: readText(fields, `${PDFA_FIELD}valueType`),
  description: readText(fields, `${PDFA_FIELD}description`),
});

const readValueType = (fields: Metadata.Entries): ExtensionValueType => ({
  type: readText(fields, `${PDFA_TYPE}type`),
  namespaceUri: readText(fields, `${PDFA_TYPE}namespaceURI`),
  prefix: readText(fields, `${PDFA_TYPE}prefix`),
  description: readText(fields, `${PDFA_TYPE}description`),
  fields: Arr.map(readStructs(fields, `${PDFA_TYPE}field`), readField),
});

const readSchema = (fields: Metadata.Entries): ExtensionSchema => ({
  schema: readText(fields, `${PDFA_SCHEMA}schema`),
  namespaceUri: readText(fields, `${PDFA_SCHEMA}namespaceURI`),
  prefix: readText(fields, `${PDFA_SCHEMA}prefix`),
  properties: Arr.map(readStructs(fields, `${PDFA_SCHEMA}property`), readProperty),
  valueTypes: Arr.map(readStructs(fields, `${PDFA_SCHEMA}valueType`), readValueType),
});

/**
 * The extension schema descriptions (`pdfaExtension:schemas`). Missing text
 * fields read as `""`.
 *
 * @since 0.1.0
 * @category getters
 */
export const extensionSchemas = (self: Metadata.Metadata): ReadonlyArray<ExtensionSchema> =>
  Arr.map(readStructs(self.properties, SCHEMAS), readSchema);

const texts = (ns: string, entries: ReadonlyArray<readonly [string, string]>) =>
  Metadata.struct(Arr.map(entries, ([local, value]) => [`${ns}${local}`, Metadata.text(value)]));

const withArrays = (
  base: Metadata.Struct,
  arrays: ReadonlyArray<readonly [string, ReadonlyArray<Metadata.Value>]>,
): Metadata.Struct =>
  Metadata.struct([
    ...base.fields,
    ...Arr.map(
      Arr.filter(arrays, ([, items]) => Arr.isReadonlyArrayNonEmpty(items)),
      ([iri, items]) => [iri, Metadata.array('Seq', items)] as const,
    ),
  ]);

const writeSchema = (schema: ExtensionSchema): Metadata.Struct =>
  withArrays(
    texts(PDFA_SCHEMA, [
      ['schema', schema.schema],
      ['namespaceURI', schema.namespaceUri],
      ['prefix', schema.prefix],
    ]),
    [
      [
        `${PDFA_SCHEMA}property`,
        Arr.map(schema.properties, (p) =>
          texts(PDFA_PROPERTY, [
            ['name', p.name],
            ['valueType', p.valueType],
            ['category', p.category],
            ['description', p.description],
          ]),
        ),
      ],
      [
        `${PDFA_SCHEMA}valueType`,
        Arr.map(schema.valueTypes, (t) =>
          withArrays(
            texts(PDFA_TYPE, [
              ['type', t.type],
              ['namespaceURI', t.namespaceUri],
              ['prefix', t.prefix],
              ['description', t.description],
            ]),
            [
              [
                `${PDFA_TYPE}field`,
                Arr.map(t.fields, (f) =>
                  texts(PDFA_FIELD, [
                    ['name', f.name],
                    ['valueType', f.valueType],
                    ['description', f.description],
                  ]),
                ),
              ],
            ],
          ),
        ),
      ],
    ],
  );

/**
 * Sets the extension schema descriptions (`pdfaExtension:schemas`, an
 * unordered array of structures), or removes them when given none.
 *
 * @since 0.1.0
 * @category setters
 */
export const setExtensionSchemas: Metadata.Setter<ReadonlyArray<ExtensionSchema>> =
  Accessors.dualSetter((self: Metadata.Metadata, schemas: ReadonlyArray<ExtensionSchema>) =>
    Arr.isReadonlyArrayNonEmpty(schemas)
      ? Metadata.set(self, SCHEMAS, Metadata.array('Bag', Arr.map(schemas, writeSchema)))
      : Metadata.remove(self, SCHEMAS),
  );
