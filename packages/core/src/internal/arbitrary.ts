/**
 * Generation representations for the term declarations' `toCodecArbitrary`
 * hooks: `TermJson`-shaped schemas whose native arbitraries produce realistic
 * values — IRIs from a small pool (so values collide across quads), BCP 47
 * language tags, both base directions, well-formed lexical forms for common
 * XSD datatypes, and triple terms nested at most two deep. Generated data is
 * RDF 1.2: triple terms appear only in the object position (of a quad or of
 * another triple term), never as subjects, as RDF 1.2 Concepts requires.
 *
 * Plain data only (no `Term` import), so `Term` can link to it without a
 * cycle; `Term` decodes these with `fromJson` and checks the result.
 */
import * as Schema from 'effect/Schema';
import type * as TermJson from '../TermJson.ts';

const XSD = 'http://www.w3.org/2001/XMLSchema#';

const NAMESPACES = [
  'http://example.org/',
  'http://example.org/vocab#',
  'https://example.com/a/b/',
  'urn:example:',
];
const LOCAL_NAMES = ['a', 'b', 'c', 'knows', 'name', 'Thing', 'x-1', 'é'];

/** The IRI pool: every namespace × local name. */
const IRIS = NAMESPACES.flatMap((ns) => LOCAL_NAMES.map((local) => `${ns}${local}`));

const pattern = (re: RegExp): Schema.String => Schema.String.check(Schema.isPattern(re));

const NamedNode: Schema.Codec<TermJson.NamedNode> = Schema.Struct({
  type: Schema.Literal('uri'),
  value: Schema.Literals(IRIS),
});

const BlankNode: Schema.Codec<TermJson.BlankNode> = Schema.Struct({
  type: Schema.Literal('bnode'),
  value: Schema.Literals(['b0', 'b1', 'b2', 'b3', 'node']),
});

const LANGUAGES = Schema.Literals([
  'en',
  'en-gb',
  'fr',
  'de-ch-1901',
  'ar',
  'zh-hant-tw',
  'x-private',
]);

const typedLiteral = (local: string, value: Schema.Codec<string>) =>
  Schema.Struct({
    type: Schema.Literal('literal'),
    value,
    datatype: Schema.Literal(`${XSD}${local}`),
  });

const DATE = '(19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|1[0-9]|2[0-8])';

const Literal: Schema.Codec<TermJson.Literal> = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('literal'),
    value: Schema.String.check(Schema.isMaxLength(8)),
  }),
  Schema.Struct({
    type: Schema.Literal('literal'),
    value: Schema.Literals(['', 'a', 'Alice', 'hello world', 'ünïcödé']),
    'xml:lang': LANGUAGES,
  }),
  Schema.Struct({
    type: Schema.Literal('literal'),
    value: Schema.Literals(['a', 'שלום', 'مرحبا']),
    'xml:lang': LANGUAGES,
    'its:dir': Schema.Literals(['ltr', 'rtl']),
  }),
  typedLiteral('integer', pattern(/^-?(0|[1-9][0-9]{0,5})$/)),
  typedLiteral('decimal', pattern(/^-?(0|[1-9][0-9]{0,3})\.[0-9]{1,3}$/)),
  typedLiteral('double', pattern(/^-?[1-9]\.[0-9]{1,3}E-?[0-9]$/)),
  typedLiteral('boolean', Schema.Literals(['true', 'false'])),
  typedLiteral('date', pattern(new RegExp(`^${DATE}$`))),
  typedLiteral(
    'dateTime',
    pattern(new RegExp(`^${DATE}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](Z|[+-]0[0-9]:00)?$`)),
  ),
]);

const Resource = Schema.Union([NamedNode, BlankNode]);

const tripleOf = (object: Schema.Codec<TermJson.GroundTerm>): Schema.Codec<TermJson.Triple> =>
  Schema.Struct({
    type: Schema.Literal('triple'),
    value: Schema.Struct({ subject: Resource, predicate: NamedNode, object }),
  });

// Depth one: no triple term inside; depth two: a triple term as the object.
const Triple1 = tripleOf(Schema.Union([NamedNode, BlankNode, Literal]));

const Triple: Schema.Codec<TermJson.Triple> = tripleOf(
  Schema.Union([NamedNode, BlankNode, Literal, Triple1]),
);

const Variable: Schema.Codec<TermJson.Variable> = Schema.Struct({
  type: Schema.Literal('variable'),
  value: Schema.Literals(['s', 'p', 'o', 'x']),
});

const DefaultGraph: Schema.Codec<TermJson.DefaultGraph> = Schema.Struct({
  type: Schema.Literal('default-graph'),
});

const GroundTerm: Schema.Codec<TermJson.GroundTerm> = Schema.Union([
  NamedNode,
  BlankNode,
  Literal,
  Triple,
]);

const Term: Schema.Codec<TermJson.Term> = Schema.Union([
  NamedNode,
  BlankNode,
  Literal,
  Triple,
  Variable,
  DefaultGraph,
]);

const Quad: Schema.Codec<TermJson.Quad> = Schema.Struct({
  subject: Resource,
  predicate: NamedNode,
  object: GroundTerm,
  graph: Schema.optionalKey(Resource),
});

/** The representation each term declaration's `toCodecArbitrary` links to. */
export const representations = {
  NamedNode,
  BlankNode,
  Literal,
  Triple,
  Variable,
  DefaultGraph,
  GroundTerm,
  Term,
  Quad,
} as const;

/** The most quads a generated dataset holds. */
export const MAX_DATASET_SIZE = 12;
