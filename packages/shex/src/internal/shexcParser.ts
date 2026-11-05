/**
 * The ShEx compact syntax (ShExC) parser, producing ShExJ. It is written
 * with `@thomasfosterau/effect-parse` as a compiled grammar over the tokens
 * of `shexcLexer.ts` (whose IRIs are already resolved), followed by a pass
 * over the declarations in document order for the checks that depend on
 * what was declared before (duplicate labels, shape and triple expression
 * labels). The construction of ShExJ objects mirrors the reference grammar
 * (shex.js `ShExJison.jison`) so that the output matches the ShExJ
 * representations of the shexTest suite.
 *
 * Like the reference grammar, the parser is LL(1): every choice is made by
 * dispatching on the kind of the next token (and committing to it), never by
 * trying alternatives in turn.
 *
 * @internal
 */
import * as Compiler from '@thomasfosterau/effect-parse/Compiler';
import * as ParseError from '@thomasfosterau/effect-parse/ParseError';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Token from '@thomasfosterau/effect-parse/Token';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Arr from 'effect/Array';
import * as Match from 'effect/Match';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import type * as ShExJ from '../ShExJ.ts';
import { quote } from './lexer.ts';
import { resolve, type Tok, tokenize } from './shexcLexer.ts';
import * as Predicate from 'effect/Predicate';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_INTEGER = `${XSD}integer`;
const XSD_DECIMAL = `${XSD}decimal`;
const XSD_DOUBLE = `${XSD}double`;
const XSD_FLOAT = `${XSD}float`;
const XSD_BOOLEAN = `${XSD}boolean`;

const numericDatatypes = MutableHashSet.fromIterable(
  [
    'integer',
    'decimal',
    'float',
    'double',
    'string',
    'boolean',
    'dateTime',
    'nonPositiveInteger',
    'negativeInteger',
    'long',
    'int',
    'short',
    'byte',
    'nonNegativeInteger',
    'unsignedLong',
    'unsignedInt',
    'unsignedShort',
    'unsignedByte',
    'positiveInteger',
  ].map((l) => XSD + l),
);

const numericFacetNames = ['mininclusive', 'minexclusive', 'maxinclusive', 'maxexclusive'];

/** A placeholder for the empty shape `.` / `{ }` (omitted as a value expression). */
const EMPTY: ShExJ.Shape = { type: 'Shape' };

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type AnyShapeExpr = ShExJ.ShapeExprOrRef;

/** Options for the ShExC parser. */
export interface ParserOptions {
  readonly baseIri: Option.Option<string>;
  readonly prefixes: PrefixMap.PrefixMap;
}

/** The result of parsing ShExC. */
export interface ParserResult {
  readonly schema: ShExJ.Schema;
  readonly prefixes: PrefixMap.PrefixMap;
  readonly baseIri: Option.Option<string>;
}

/** A parse error at a character offset. */
export interface ShExCError {
  readonly message: string;
  readonly offset: number;
}

/** An error found by the grammar, at a token index. */
interface SemanticError {
  readonly message: string;
  readonly at: number;
}

type P<A> = Parser.Parser<A, SemanticError, never, ReadonlyArray<Tok>>;

// -----------------------------------------------------------------------------
// Token parsers
// -----------------------------------------------------------------------------

/** A token of the given kind (see `Tok.kind`). */
const tok = (kind: string, label = `'${kind}'`): P<Tok> =>
  Token.oneOf<ReadonlyArray<Tok>>((t) => t.kind === kind).pipe(Parser.expected(label));

const anyToken = Token.oneOf<ReadonlyArray<Tok>>(() => true);
const nextKind = Parser.peek(anyToken).pipe(Parser.map((t) => t.kind));

/**
 * Chooses a parser by the kind of the next token, failing (without consuming
 * input) when no case matches and there is no `otherwise`.
 */
const select = <A, B = never>(
  label: string,
  cases: ReadonlyArray<readonly [ReadonlyArray<string>, P<A>]>,
  otherwise?: P<B>,
): P<A | B> => {
  // The first case listing a kind wins, as `fromEntries` keeps the last entry for a key.
  const record = Record.fromEntries(
    Arr.flatMap(Arr.reverse(cases), ([kinds, p]) => Arr.map(kinds, (k) => [k, p] as const)),
  );
  const chosen: P<A | B> =
    otherwise === undefined
      ? Parser.dispatch(nextKind, record)
      : Parser.dispatch(nextKind, record, otherwise);
  return chosen.pipe(Parser.expected(label));
};

/** Fails with a semantic error at token index `at`. */
const failAt = <A>(message: string, at: number): Result.Result<A, SemanticError> =>
  Result.fail({ message, at });

/** Whether the next token is of one of `kinds` (consumed if so). */
const accept = (...kinds: ReadonlyArray<string>): P<boolean> =>
  Parser.opt(Token.oneOf<ReadonlyArray<Tok>>((t) => kinds.includes(t.kind))).pipe(
    Parser.map(Option.isSome),
  );

const IRI_KINDS = ['IRIREF', 'PNAME'];

/** The IRI of a resolved token (at token index `at`), or its resolution error. */
const tokenIri = (t: Tok, at: number): Result.Result<string, SemanticError> =>
  Option.isNone(t.error) ? Result.succeed(t.iri) : failAt(t.error.value, at);

/** The IRI of an IRIREF or PNAME token, or the token's resolution error. */
const iri: P<string> = Parser.seq(
  Parser.location,
  Token.oneOf<ReadonlyArray<Tok>>((t) => t.kind === 'IRIREF' || t.kind === 'PNAME'),
).pipe(
  Parser.tryMap(([at, t]) => tokenIri(t, at)),
  Parser.cut,
  Parser.expected('an IRI'),
);

const blankNode = tok('BLANK_NODE_LABEL', 'a blank node').pipe(Parser.map((t) => t.text));

/** shapeExprLabel / tripleExprLabel: iri | blankNode */
const label: P<string> = select('an IRI or a blank node', [
  [IRI_KINDS, iri],
  [['BLANK_NODE_LABEL'], blankNode],
]);

const predicate: P<string> = select('a predicate', [
  [['a'], anyToken.pipe(Parser.as(RDF_TYPE))],
  [IRI_KINDS, iri],
]);

const LITERAL_KINDS = ['STRING', 'LANG_STRING', 'INTEGER', 'DECIMAL', 'DOUBLE', 'true', 'false'];

const literal: P<ShExJ.ObjectLiteral> = select('a literal', [
  [['INTEGER'], anyToken.pipe(Parser.map((t) => ({ value: t.text, type: XSD_INTEGER })))],
  [['DECIMAL'], anyToken.pipe(Parser.map((t) => ({ value: t.text, type: XSD_DECIMAL })))],
  [['DOUBLE'], anyToken.pipe(Parser.map((t) => ({ value: t.text, type: XSD_DOUBLE })))],
  [
    ['LANG_STRING'],
    anyToken.pipe(Parser.map((t) => ({ value: t.text, language: t.suffix.toLowerCase() }))),
  ],
  [
    ['STRING'],
    Parser.seq(anyToken, Parser.opt(Parser.preceded(tok('^^'), Parser.cut(iri)))).pipe(
      Parser.map(([t, datatype]): ShExJ.ObjectLiteral =>
        Option.isSome(datatype) ? { value: t.text, type: datatype.value } : { value: t.text },
      ),
    ),
  ],
  [['true', 'false'], anyToken.pipe(Parser.map((t) => ({ value: t.text, type: XSD_BOOLEAN })))],
]);

// -----------------------------------------------------------------------------
// Shape expression helpers
// -----------------------------------------------------------------------------

/**
 * A shape expression, and whether it was written in parentheses: a
 * parenthesised `AND` is not merged into an enclosing `AND`.
 */
interface Atom {
  readonly e: AnyShapeExpr;
  readonly nested: boolean;
}

const plain = (e: AnyShapeExpr): Atom => ({ e, nested: false });

const isJunction = (e: AnyShapeExpr): e is ShExJ.ShapeAnd | ShExJ.ShapeOr =>
  !Predicate.isString(e) && (e.type === 'ShapeAnd' || e.type === 'ShapeOr');

const junction = (
  type: 'ShapeAnd' | 'ShapeOr',
  atom: Atom,
  juncts: ReadonlyArray<AnyShapeExpr>,
): AnyShapeExpr => {
  if (Arr.isReadonlyArrayEmpty(juncts)) return atom.e;
  const e = atom.e;
  if (isJunction(e) && e.type === type && !atom.nested) {
    return { ...e, shapeExprs: e.shapeExprs.concat(juncts) };
  }
  return { type, shapeExprs: [e, ...juncts] };
};

/**
 * What follows the first atom of a shape expression: `(OR shapeAnd)+` or
 * `(AND shapeNot)+ (OR shapeAnd)*`. The atom is inserted in front of the
 * disjuncts or the conjuncts respectively.
 */
type Rest =
  | { readonly _tag: 'Or'; readonly ors: ReadonlyArray<AnyShapeExpr> }
  | {
      readonly _tag: 'And';
      readonly ands: ReadonlyArray<AnyShapeExpr>;
      readonly ors: ReadonlyArray<AnyShapeExpr>;
    };

const isAndRest = Predicate.isTagged('And');

const prepend = (rest: Rest, atoms: ReadonlyArray<AnyShapeExpr>): AnyShapeExpr => {
  if (!isAndRest(rest)) return { type: 'ShapeOr', shapeExprs: [...atoms, ...rest.ors] };
  const and: ShExJ.ShapeAnd = { type: 'ShapeAnd', shapeExprs: [...atoms, ...rest.ands] };
  return Arr.isReadonlyArrayNonEmpty(rest.ors)
    ? { type: 'ShapeOr', shapeExprs: [and, ...rest.ors] }
    : and;
};

const prependAtom = (atom: Atom, rest: Option.Option<Rest>): AnyShapeExpr =>
  Option.match(rest, {
    onNone: () => atom.e,
    onSome: (r) => {
      const e = atom.e;
      return !Predicate.isString(e) &&
        e.type === 'ShapeAnd' &&
        isAndRest(r) &&
        Arr.isReadonlyArrayEmpty(r.ors) &&
        !atom.nested
        ? prepend(r, e.shapeExprs)
        : prepend(r, [e]);
    },
  });

// -----------------------------------------------------------------------------
// Annotations, semantic actions and cardinalities
// -----------------------------------------------------------------------------

const annotations: P<Array<ShExJ.Annotation>> = Parser.repeat(
  Parser.preceded(
    tok('//'),
    Parser.cut(
      Parser.seq(predicate, select('an IRI or a literal', [[IRI_KINDS, iri]], literal)).pipe(
        Parser.map(([pred, object]): ShExJ.Annotation => ({
          type: 'Annotation',
          predicate: pred,
          object,
        })),
      ),
    ),
  ),
);

const codeDecls: P<Array<ShExJ.SemAct>> = Parser.repeat(
  Parser.preceded(
    tok('%'),
    Parser.cut(
      Parser.seq(
        iri,
        select('code or %', [
          [['CODE'], anyToken.pipe(Parser.map((t) => Option.some(t.text)))],
          [['%'], anyToken.pipe(Parser.as(Option.none<string>()))],
        ]),
      ).pipe(
        Parser.map(([name, code]): ShExJ.SemAct =>
          Option.match(code, {
            onNone: () => ({ type: 'SemAct', name }),
            onSome: (c) => ({ type: 'SemAct', name, code: c }),
          }),
        ),
      ),
    ),
  ),
  { min: 1 },
);

const semanticActions: P<Option.Option<Array<ShExJ.SemAct>>> = Parser.opt(codeDecls);

const cardinality: P<Option.Option<{ min: number; max: number }>> = Parser.opt(
  select('a cardinality', [
    [['*'], anyToken.pipe(Parser.as({ min: 0, max: -1 }))],
    [['+'], anyToken.pipe(Parser.as({ min: 1, max: -1 }))],
    [['?'], anyToken.pipe(Parser.as({ min: 0, max: 1 }))],
    [['REPEAT_RANGE'], anyToken.pipe(Parser.map((t) => ({ min: t.min, max: t.max })))],
  ]),
);

// -----------------------------------------------------------------------------
// Node constraints
// -----------------------------------------------------------------------------

const integer = Parser.cut(tok('INTEGER', 'an integer')).pipe(
  Parser.map((t) => parseInt(t.text, 10)),
);

const rawNumeric: P<number> = select('a numeric literal', [
  [['INTEGER'], anyToken.pipe(Parser.map((t) => parseInt(t.text, 10)))],
  [['DECIMAL', 'DOUBLE'], anyToken.pipe(Parser.map((t) => parseFloat(t.text)))],
  [
    ['STRING'],
    Parser.seq(
      anyToken,
      Parser.cut(Parser.preceded(tok('^^'), Parser.seq(Parser.location, iri))),
    ).pipe(
      Parser.tryMap(([t, [at, dt]]) => {
        const value = t.text;
        if (dt === XSD_DECIMAL || dt === XSD_FLOAT || dt === XSD_DOUBLE) {
          return Result.succeed(parseFloat(value));
        }
        if (MutableHashSet.has(numericDatatypes, dt)) return Result.succeed(parseInt(value, 10));
        return failAt<number>(`numeric range facet expected numeric datatype instead of ${dt}`, at);
      }),
      Parser.cut,
    ),
  ],
]);

type Facet = readonly [key: string, value: number | string, at: number, flags?: string];

const LENGTH_FACETS = ['LENGTH', 'MINLENGTH', 'MAXLENGTH'];
const DIGITS_FACETS = ['TOTALDIGITS', 'FRACTIONDIGITS'];
const RANGE_FACETS = ['MININCLUSIVE', 'MINEXCLUSIVE', 'MAXINCLUSIVE', 'MAXEXCLUSIVE'];
const NUMERIC_FACETS = [...DIGITS_FACETS, ...RANGE_FACETS];

/** Facet name → its value, as the facets are read. */
interface FacetValues {
  [facet: string]: number | string;
}

type FacetCase = readonly [ReadonlyArray<string>, P<Facet>];

const integerFacet: P<Facet> = Parser.seq(Parser.location, anyToken, integer).pipe(
  Parser.map(([at, t, n]): Facet => [t.text.toLowerCase(), n, at]),
);

const stringFacetCases: ReadonlyArray<FacetCase> = [
  [
    ['REGEXP'],
    Parser.seq(Parser.location, anyToken).pipe(
      Parser.map(([at, t]): Facet => ['pattern', t.text, at, t.suffix]),
    ),
  ],
  [LENGTH_FACETS, integerFacet],
];

const numericFacetCases: ReadonlyArray<FacetCase> = [
  [DIGITS_FACETS, integerFacet],
  [
    RANGE_FACETS,
    Parser.seq(Parser.location, anyToken, Parser.cut(rawNumeric)).pipe(
      Parser.map(([at, t, n]): Facet => [t.text.toLowerCase(), n, at]),
    ),
  ],
];

const noFacets = (): Result.Result<FacetValues, SemanticError> => Result.succeed({});

const facets = (strings: boolean, numerics: boolean): P<Mutable<ShExJ.Facets>> =>
  Parser.repeat(
    select('a facet', [
      ...(strings ? stringFacetCases : []),
      ...(numerics ? numericFacetCases : []),
    ]),
  ).pipe(
    Parser.tryMap((list) =>
      Arr.reduce(list, noFacets(), (acc, [key, value, at, flags]) =>
        Result.flatMap(acc, (out) => {
          if (key in out) return failAt<FacetValues>(`facet ${key} defined multiple times`, at);
          out[key] = value;
          if (flags !== undefined && flags !== '') out['flags'] = flags;
          return Result.succeed(out);
        }),
      ),
    ),
    Parser.cut,
  );

// Value sets ---------------------------------------------------------------------

const tilde = accept('~');

const exclusion = <A>(p: P<A>): P<A> => Parser.preceded(tok('-'), Parser.cut(p));

const iriExclusion: P<string | ShExJ.IriStem> = exclusion(
  Parser.seq(iri, tilde).pipe(
    Parser.map(([base, stem]) => (stem ? { type: 'IriStem', stem: base } : base)),
  ),
);

const literalExclusion: P<string | ShExJ.LiteralStem> = exclusion(
  Parser.seq(literal, tilde).pipe(
    Parser.map(([lit, stem]) => (stem ? { type: 'LiteralStem', stem: lit.value } : lit.value)),
  ),
);

const langTag = tok('LANGTAG', 'a language tag').pipe(Parser.map((t) => t.text));

const languageExclusion: P<string | ShExJ.LanguageStem> = exclusion(
  Parser.seq(langTag, tilde).pipe(
    Parser.map(([tag, stem]) => (stem ? { type: 'LanguageStem', stem: tag } : tag)),
  ),
);

const stemmed = <A, X>(
  head: P<A>,
  exclude: P<X>,
  build: (head: A, stem: boolean, exclusions: Array<X>) => ShExJ.ValueSetValue,
): P<ShExJ.ValueSetValue> =>
  Parser.seq(head, Parser.opt(Parser.preceded(tok('~'), Parser.repeat(exclude)))).pipe(
    Parser.map(([h, exclusions]) =>
      build(
        h,
        Option.isSome(exclusions),
        Option.getOrElse(exclusions, () => []),
      ),
    ),
  );

/** The exclusions after a `.` wildcard: their kind is chosen by the first one. */
// SAFETY: each branch builds the value set value for its exclusion kind.
const wildcardExclusions: P<ShExJ.ValueSetValue> = Parser.preceded(
  Parser.peek(tok('-')),
  Parser.dispatch(
    Parser.peek(Parser.preceded(anyToken, anyToken)).pipe(Parser.map((t) => t.kind)),
    {
      LANGTAG: Parser.repeat(languageExclusion).pipe(
        Parser.map((exclusions): ShExJ.ValueSetValue => ({
          type: 'LanguageStemRange',
          stem: { type: 'Wildcard' },
          exclusions,
        })),
      ),
      ...Record.fromEntries(
        Arr.map(
          IRI_KINDS,
          (k) =>
            [
              k,
              Parser.repeat(iriExclusion).pipe(
                Parser.map((exclusions): ShExJ.ValueSetValue => ({
                  type: 'IriStemRange',
                  stem: { type: 'Wildcard' },
                  exclusions,
                })),
              ),
            ] as const,
        ),
      ),
    },
    Parser.repeat(literalExclusion).pipe(
      Parser.map((exclusions): ShExJ.ValueSetValue => ({
        type: 'LiteralStemRange',
        stem: { type: 'Wildcard' },
        exclusions,
      })),
    ),
  ),
).pipe(Parser.expected("'-'"));

const valueSetValue: P<ShExJ.ValueSetValue> = select('a value set value', [
  [
    IRI_KINDS,
    Parser.cut(
      stemmed(iri, iriExclusion, (stem, isStem, exclusions) =>
        !isStem
          ? stem
          : Arr.isReadonlyArrayNonEmpty(exclusions)
            ? { type: 'IriStemRange', stem, exclusions }
            : { type: 'IriStem', stem },
      ),
    ),
  ],
  [
    LITERAL_KINDS,
    Parser.cut(
      stemmed(literal, literalExclusion, (lit, isStem, exclusions) =>
        !isStem
          ? lit
          : Arr.isReadonlyArrayNonEmpty(exclusions)
            ? { type: 'LiteralStemRange', stem: lit.value, exclusions }
            : { type: 'LiteralStem', stem: lit.value },
      ),
    ),
  ],
  [
    ['LANGTAG'],
    Parser.cut(
      stemmed(langTag, languageExclusion, (tag, isStem, exclusions) =>
        !isStem
          ? { type: 'Language', languageTag: tag }
          : Arr.isReadonlyArrayNonEmpty(exclusions)
            ? { type: 'LanguageStemRange', stem: tag, exclusions }
            : { type: 'LanguageStem', stem: tag },
      ),
    ),
  ],
  [
    ['@'],
    Parser.preceded(
      anyToken,
      Parser.cut(Parser.preceded(tok('~'), Parser.repeat(languageExclusion))),
    ).pipe(
      Parser.map((exclusions): ShExJ.ValueSetValue =>
        Arr.isReadonlyArrayNonEmpty(exclusions)
          ? { type: 'LanguageStemRange', stem: '', exclusions }
          : { type: 'LanguageStem', stem: '' },
      ),
    ),
  ],
  [['.'], Parser.preceded(anyToken, Parser.cut(wildcardExclusions))],
]);

const valueSet: P<Array<ShExJ.ValueSetValue>> = Parser.delimited(
  tok('['),
  Parser.cut(Parser.repeat(valueSetValue)),
  Parser.cut(tok(']')),
);

const litInlineNodeConstraint: P<ShExJ.NodeConstraint> = select('a node constraint', [
  [
    ['LITERAL'],
    Parser.preceded(anyToken, facets(true, true)).pipe(
      Parser.map((f): ShExJ.NodeConstraint => ({
        type: 'NodeConstraint',
        nodeKind: 'literal',
        ...f,
      })),
    ),
  ],
  [
    IRI_KINDS,
    Parser.seq(Parser.location, iri, facets(true, true)).pipe(
      Parser.tryMap(([at, datatype, f]) =>
        Option.match(
          MutableHashSet.has(numericDatatypes, datatype)
            ? Option.none()
            : Arr.findFirst(numericFacetNames, (name) => name in f),
          {
            onNone: () =>
              Result.succeed<ShExJ.NodeConstraint>({ type: 'NodeConstraint', datatype, ...f }),
            onSome: (name) =>
              failAt<ShExJ.NodeConstraint>(
                `facet ${name} not allowed for unknown datatype ${datatype}`,
                at,
              ),
          },
        ),
      ),
      Parser.cut,
    ),
  ],
  [
    ['['],
    Parser.terminated(valueSet, facets(true, true)).pipe(
      Parser.map((values): ShExJ.NodeConstraint => ({ type: 'NodeConstraint', values })),
    ),
  ],
  [
    NUMERIC_FACETS,
    facets(false, true).pipe(
      Parser.map((f): ShExJ.NodeConstraint => ({ type: 'NodeConstraint', ...f })),
    ),
  ],
]);

const NODE_KINDS = ['IRI', 'BNODE', 'NONLITERAL'];
const NON_LIT_KINDS = [...NODE_KINDS, 'LENGTH', 'MINLENGTH', 'MAXLENGTH', 'REGEXP'];
const LIT_KINDS = ['LITERAL', ...NUMERIC_FACETS, ...IRI_KINDS, '['];

const nodeKindOf = (kind: string): ShExJ.NodeKind =>
  kind === 'IRI' ? 'iri' : kind === 'BNODE' ? 'bnode' : 'nonliteral';

const nonLitInlineNodeConstraint: P<ShExJ.NodeConstraint> = Parser.seq(
  Parser.opt(select('a node kind', [[NODE_KINDS, anyToken.pipe(Parser.map((t) => t.text))]])),
  facets(true, false),
).pipe(
  Parser.map(([kind, f]): ShExJ.NodeConstraint =>
    Option.isSome(kind)
      ? { type: 'NodeConstraint', nodeKind: nodeKindOf(kind.value), ...f }
      : { type: 'NodeConstraint', ...f },
  ),
);

/** A non-literal node constraint, if one starts here. */
const nonLitNodeConstraintOpt: P<Option.Option<ShExJ.NodeConstraint>> = Parser.opt(
  select('a node constraint', [[NON_LIT_KINDS, Parser.cut(nonLitInlineNodeConstraint)]]),
);

const withAnnotations = (nc: P<ShExJ.NodeConstraint>): P<ShExJ.NodeConstraint> =>
  Parser.seq(nc, annotations, semanticActions).pipe(
    Parser.map(([constraint, annots, semActs]) => {
      if (Arr.isReadonlyArrayEmpty(annots) && Option.isNone(semActs)) return constraint;
      const out: Mutable<ShExJ.NodeConstraint> = constraint;
      if (Arr.isReadonlyArrayNonEmpty(annots)) out.annotations = annots;
      if (Option.isSome(semActs)) out.semActs = semActs.value;
      return out;
    }),
  );

/** A non-literal node constraint with its annotations, if one starts here. */
const annotatedNonLitNodeConstraintOpt: P<Option.Option<ShExJ.NodeConstraint>> = Parser.opt(
  select('a node constraint', [
    [NON_LIT_KINDS, Parser.cut(withAnnotations(nonLitInlineNodeConstraint))],
  ]),
);

// -----------------------------------------------------------------------------
// Shape expressions
// -----------------------------------------------------------------------------

const REF_KINDS = ['ATPNAME', '@'];
const SHAPE_DEF_KINDS = ['{', '&', 'EXTENDS', 'EXTRA', 'CLOSED'];

const shapeRef: P<string> = select('a shape reference', [
  [
    ['ATPNAME'],
    Parser.seq(Parser.location, anyToken).pipe(
      Parser.tryMap(([at, t]) => tokenIri(t, at)),
      Parser.cut,
    ),
  ],
  [['@'], Parser.preceded(anyToken, Parser.cut(label))],
]);

const shapeExpressionBody: P<AnyShapeExpr> = Parser.suspend(() => shapeExpressionBodyDef);
const tripleExpression: P<ShExJ.TripleExprOrRef> = Parser.suspend(() => tripleExpressionDef);
const extendsShapeOr: P<AnyShapeExpr> = Parser.suspend(() => extendsShapeOrDef);
const inlineShapeExpression: P<AnyShapeExpr> = Parser.suspend(() => inlineShapeExpressionDef);

const parenthesised: P<Atom> = Parser.delimited(
  anyToken,
  Parser.cut(shapeExpressionBody),
  Parser.cut(tok(')')),
).pipe(Parser.map((e) => ({ e, nested: true })));

const empty: P<Atom> = anyToken.pipe(Parser.as(plain(EMPTY)));

type Qualifier =
  | { readonly _tag: 'Extends'; readonly e: AnyShapeExpr }
  | { readonly _tag: 'Extra'; readonly predicates: Array<string> }
  | { readonly _tag: 'Closed' };

const inlineShapeDefinition: P<ShExJ.Shape> = Parser.seq(
  Parser.repeat(
    select<Qualifier>('a shape qualifier', [
      [
        ['EXTENDS', '&'],
        Parser.preceded(anyToken, Parser.cut(extendsShapeOr)).pipe(
          Parser.map((e): Qualifier => ({ _tag: 'Extends', e })),
        ),
      ],
      [
        ['EXTRA'],
        Parser.preceded(anyToken, Parser.cut(Parser.repeat(predicate, { min: 1 }))).pipe(
          Parser.map((predicates): Qualifier => ({ _tag: 'Extra', predicates })),
        ),
      ],
      [['CLOSED'], anyToken.pipe(Parser.as<Qualifier>({ _tag: 'Closed' }))],
    ]),
  ),
  Parser.delimited(
    Parser.cut(tok('{')),
    select(
      'a triple expression',
      [[['}'], Parser.succeed(Option.none<ShExJ.TripleExprOrRef>())]],
      Parser.cut(tripleExpression).pipe(Parser.map(Option.some)),
    ),
    Parser.cut(tok('}')),
  ),
).pipe(
  Parser.map(([qualifiers, expression]): ShExJ.Shape => {
    if (Option.isNone(expression) && Arr.isReadonlyArrayEmpty(qualifiers)) return EMPTY;
    const extendsList = Arr.filterMap(qualifiers, (q) =>
      Predicate.isTagged(q, 'Extends') ? Result.succeed(q.e) : Result.failVoid,
    );
    const extra = Arr.flatMap(qualifiers, (q) =>
      Predicate.isTagged(q, 'Extra') ? q.predicates : [],
    );
    const shape: Mutable<ShExJ.Shape> = { type: 'Shape' };
    if (Option.isSome(expression)) shape.expression = expression.value;
    if (Arr.isReadonlyArrayNonEmpty(extendsList)) shape.extends = extendsList;
    if (Arr.some(qualifiers, (q) => Predicate.isTagged(q, 'Extra'))) shape.extra = extra;
    if (Arr.some(qualifiers, (q) => Predicate.isTagged(q, 'Closed'))) shape.closed = true;
    return shape;
  }),
);

const shapeDefinition: P<AnyShapeExpr> = Parser.seq(
  inlineShapeDefinition,
  annotations,
  semanticActions,
).pipe(
  Parser.map(([def, annots, semActs]) => {
    const out: Mutable<ShExJ.Shape> = def === EMPTY ? { type: 'Shape' } : def;
    if (Arr.isReadonlyArrayNonEmpty(annots)) out.annotations = annots;
    if (Option.isSome(semActs)) out.semActs = semActs.value;
    return out;
  }),
);

const shapeOrRef: P<AnyShapeExpr> = select(
  'a shape definition or reference',
  [[REF_KINDS, shapeRef]],
  shapeDefinition,
);

const inlineShapeOrRef: P<AnyShapeExpr> = select(
  'a shape definition or reference',
  [[REF_KINDS, shapeRef]],
  inlineShapeDefinition,
);

/** A shape definition or reference, if one starts here. */
const shapeOrRefOpt = (p: P<AnyShapeExpr>): P<Option.Option<AnyShapeExpr>> =>
  Parser.opt(
    select('a shape definition or reference', [
      [[...SHAPE_DEF_KINDS, ...REF_KINDS], Parser.cut(p)],
    ]),
  );

/** A node constraint, conjoined with the shape definition or reference after it if any. */
const andRef = (nc: ShExJ.NodeConstraint, ref: Option.Option<AnyShapeExpr>): AnyShapeExpr =>
  Option.isSome(ref) ? { type: 'ShapeAnd', shapeExprs: [{ ...nc }, ref.value] } : nc;

/** shapeAtom (with `allowRef`) and shapeAtomNoRef. */
const shapeAtom = (allowRef: boolean): P<Atom> =>
  select('a shape expression', [
    [
      NON_LIT_KINDS,
      Parser.cut(
        Parser.seq(withAnnotations(nonLitInlineNodeConstraint), shapeOrRefOpt(shapeOrRef)).pipe(
          Parser.map(([nc, ref]) => plain(andRef(nc, ref))),
        ),
      ),
    ],
    [LIT_KINDS, Parser.cut(withAnnotations(litInlineNodeConstraint)).pipe(Parser.map(plain))],
    [
      allowRef ? [...SHAPE_DEF_KINDS, ...REF_KINDS] : SHAPE_DEF_KINDS,
      Parser.cut(
        Parser.seq(shapeOrRef, annotatedNonLitNodeConstraintOpt).pipe(
          Parser.map(([sor, nc]) =>
            plain(
              Option.match(nc, {
                onNone: () => sor,
                onSome: (c) => junction('ShapeAnd', plain(sor), [c]),
              }),
            ),
          ),
        ),
      ),
    ],
    [['('], parenthesised],
    [['.'], empty],
  ]);

const shapeNot: P<Atom> = select(
  'a shape expression',
  [
    [
      ['NOT'],
      Parser.preceded(anyToken, Parser.cut(shapeAtom(true))).pipe(
        Parser.map((a) => plain({ type: 'ShapeNot', shapeExpr: a.e })),
      ),
    ],
  ],
  shapeAtom(true),
);

const shapeAnd: P<AnyShapeExpr> = Parser.seq(
  shapeNot,
  Parser.repeat(Parser.preceded(tok('AND'), Parser.cut(shapeNot))),
).pipe(
  Parser.map(([first, rest]) =>
    junction(
      'ShapeAnd',
      first,
      rest.map((a) => a.e),
    ),
  ),
);

const ors = Parser.repeat(Parser.preceded(tok('OR'), Parser.cut(shapeAnd)));

const shapeOrRest: P<Rest> = select("'AND' or 'OR'", [
  [['OR'], ors.pipe(Parser.map((operands): Rest => ({ _tag: 'Or', ors: operands })))],
  [
    ['AND'],
    Parser.seq(Parser.repeat(Parser.preceded(tok('AND'), Parser.cut(shapeNot))), ors).pipe(
      Parser.map(([conjuncts, operands]): Rest => ({
        _tag: 'And',
        ands: Arr.flatMap(conjuncts, (c) =>
          !Predicate.isString(c.e) && c.e.type === 'ShapeAnd' && !c.nested ? c.e.shapeExprs : [c.e],
        ),
        ors: operands,
      })),
    ),
  ],
]);

/**
 * shapeExpression ::= NOT? shapeAtomNoRef shapeOr? | NOT shapeRef shapeOr? | shapeRef shapeOr
 */
const shapeExpressionBodyDef: P<AnyShapeExpr> = select(
  'a shape expression',
  [
    [
      ['NOT'],
      Parser.preceded(
        anyToken,
        Parser.cut(
          select(
            'a shape expression',
            [
              [
                REF_KINDS,
                Parser.seq(shapeRef, Parser.opt(shapeOrRest)).pipe(
                  Parser.map(([ref, rest]) =>
                    prependAtom(plain({ type: 'ShapeNot', shapeExpr: ref }), rest),
                  ),
                ),
              ],
            ],
            Parser.seq(shapeAtom(false), Parser.opt(shapeOrRest)).pipe(
              Parser.map(([a, rest]) =>
                prependAtom(plain({ type: 'ShapeNot', shapeExpr: a.e }), rest),
              ),
            ),
          ),
        ),
      ),
    ],
    [
      REF_KINDS,
      Parser.seq(shapeRef, Parser.cut(shapeOrRest)).pipe(
        Parser.map(([ref, rest]) => prepend(rest, [ref])),
      ),
    ],
  ],
  Parser.seq(shapeAtom(false), Parser.opt(shapeOrRest)).pipe(
    Parser.map(([a, rest]) => prependAtom(a, rest)),
  ),
);

// Inline shape expressions -----------------------------------------------------

/** The atoms of inline and EXTENDS shape expressions, which differ in one case. */
const inlineAtom = (extendsAtom: boolean): P<Atom> =>
  select('a shape expression', [
    [
      NON_LIT_KINDS,
      Parser.cut(
        extendsAtom
          ? Parser.seq(nonLitInlineNodeConstraint, inlineShapeOrRef).pipe(
              Parser.map(([nc, ref]) => plain({ type: 'ShapeAnd', shapeExprs: [{ ...nc }, ref] })),
            )
          : Parser.seq(nonLitInlineNodeConstraint, shapeOrRefOpt(inlineShapeOrRef)).pipe(
              Parser.map(([nc, ref]) => plain(andRef(nc, ref))),
            ),
      ),
    ],
    [LIT_KINDS, Parser.cut(litInlineNodeConstraint).pipe(Parser.map(plain))],
    [
      [...SHAPE_DEF_KINDS, ...REF_KINDS],
      Parser.cut(
        Parser.seq(inlineShapeOrRef, nonLitNodeConstraintOpt).pipe(
          Parser.map(([sor, nc]) =>
            plain(
              Option.match(nc, {
                onNone: () => sor,
                onSome: (c): AnyShapeExpr => ({ type: 'ShapeAnd', shapeExprs: [sor, c] }),
              }),
            ),
          ),
        ),
      ),
    ],
    [['('], parenthesised],
    [['.'], empty],
  ]);

const junctions = (atom: P<Atom>) => {
  const not: P<Atom> = select(
    'a shape expression',
    [
      [
        ['NOT'],
        Parser.preceded(anyToken, Parser.cut(atom)).pipe(
          Parser.map((a) => plain({ type: 'ShapeNot', shapeExpr: a.e })),
        ),
      ],
    ],
    atom,
  );
  const and: P<AnyShapeExpr> = Parser.seq(
    not,
    Parser.repeat(Parser.preceded(tok('AND'), Parser.cut(not))),
  ).pipe(
    Parser.map(([first, rest]) =>
      junction(
        'ShapeAnd',
        first,
        rest.map((a) => a.e),
      ),
    ),
  );
  return Parser.seq(and, Parser.repeat(Parser.preceded(tok('OR'), Parser.cut(and)))).pipe(
    Parser.map(([first, rest]) => junction('ShapeOr', plain(first), rest)),
  );
};

const inlineShapeExpressionDef: P<AnyShapeExpr> = junctions(inlineAtom(false));
const extendsShapeOrDef: P<AnyShapeExpr> = junctions(inlineAtom(true));

// -----------------------------------------------------------------------------
// Triple expressions
// -----------------------------------------------------------------------------

/** The token index of the label of each labelled triple expression. */
const labelAt = new WeakMap<object, number>();

const tripleConstraint: P<ShExJ.TripleConstraint> = Parser.seq(
  accept('^'),
  predicate,
  inlineShapeExpression,
  cardinality,
  annotations,
  semanticActions,
).pipe(
  Parser.map(([inverse, pred, valueExpr, card, annots, semActs]) => {
    const tc: Mutable<ShExJ.TripleConstraint> = inverse
      ? { type: 'TripleConstraint', inverse: true, predicate: pred }
      : { type: 'TripleConstraint', predicate: pred };
    if (valueExpr !== EMPTY) tc.valueExpr = valueExpr;
    if (Option.isSome(card)) {
      tc.min = card.value.min;
      tc.max = card.value.max;
    }
    if (Option.isSome(semActs)) tc.semActs = semActs.value;
    if (Arr.isReadonlyArrayNonEmpty(annots)) tc.annotations = annots;
    return tc;
  }),
);

const bracketedTripleExpr: P<ShExJ.TripleExprOrRef> = Parser.seq(
  Parser.location,
  Parser.delimited(anyToken, Parser.cut(tripleExpression), Parser.cut(tok(')'))),
  cardinality,
  annotations,
  semanticActions,
).pipe(
  Parser.tryMap(([at, expr, card, annots, semActs]) => {
    if (Option.isNone(card) && Arr.isReadonlyArrayEmpty(annots) && Option.isNone(semActs)) {
      return Result.succeed(expr);
    }
    if (Predicate.isString(expr)) {
      return failAt<ShExJ.TripleExprOrRef>(
        `a group containing only the inclusion &<${expr}> can't take a cardinality, an annotation or a semantic action`,
        at,
      );
    }
    const out: Mutable<ShExJ.TripleExpr> =
      Option.isSome(card) &&
      expr.type === 'TripleConstraint' &&
      (expr.min !== undefined || expr.max !== undefined)
        ? { type: 'EachOf', expressions: [expr] }
        : expr;
    if (Option.isSome(card)) {
      out.min = card.value.min;
      out.max = card.value.max;
    }
    if (Arr.isReadonlyArrayNonEmpty(annots)) out.annotations = annots;
    if (Option.isSome(semActs)) out.semActs = [...(out.semActs ?? []), ...semActs.value];
    return Result.succeed<ShExJ.TripleExprOrRef>(out);
  }),
  Parser.cut,
);

const bracketedOrConstraint: P<ShExJ.TripleExprOrRef> = select(
  'a triple expression',
  [[['('], bracketedTripleExpr]],
  tripleConstraint,
);

const UNARY_KINDS = ['$', '&', '(', '^', 'a', ...IRI_KINDS];

const unaryTripleExpr: P<ShExJ.TripleExprOrRef> = select('a triple expression', [
  [['&'], Parser.preceded(anyToken, Parser.cut(label))],
  [
    ['$'],
    Parser.seq(
      Parser.preceded(anyToken, Parser.cut(Parser.seq(Parser.location, label))),
      Parser.cut(bracketedOrConstraint),
    ).pipe(
      Parser.tryMap(([[at, id], expr]) => {
        if (Predicate.isString(expr)) {
          return failAt<ShExJ.TripleExprOrRef>(
            `a group containing only the inclusion &<${expr}> can't take a label`,
            at,
          );
        }
        const labelled = { id, ...expr };
        labelAt.set(labelled, at);
        return Result.succeed<ShExJ.TripleExprOrRef>(labelled);
      }),
      Parser.cut,
    ),
  ],
  [['(', '^', 'a', ...IRI_KINDS], Parser.cut(bracketedOrConstraint)],
]);

const separator = select('; or ,', [[[';', ','], anyToken]]);

const groupTripleExpr: P<ShExJ.TripleExprOrRef> = Parser.terminated(
  Parser.seq(
    unaryTripleExpr,
    Parser.repeat(
      Parser.preceded(separator, select('a triple expression', [[UNARY_KINDS, unaryTripleExpr]])),
    ),
  ),
  Parser.opt(separator),
).pipe(
  Parser.map(([first, rest]) =>
    Arr.isReadonlyArrayEmpty(rest) ? first : { type: 'EachOf', expressions: [first, ...rest] },
  ),
);

const tripleExpressionDef: P<ShExJ.TripleExprOrRef> = Parser.seq(
  groupTripleExpr,
  Parser.repeat(Parser.preceded(tok('|'), Parser.cut(groupTripleExpr))),
).pipe(
  Parser.map(([first, rest]) =>
    Arr.isReadonlyArrayEmpty(rest) ? first : { type: 'OneOf', expressions: [first, ...rest] },
  ),
);

// -----------------------------------------------------------------------------
// Document
// -----------------------------------------------------------------------------

type Statement =
  | { readonly _tag: 'Import'; readonly iri: string }
  | { readonly _tag: 'Start'; readonly expr: AnyShapeExpr; readonly at: number }
  | { readonly _tag: 'Decl'; readonly decl: ShExJ.ShapeDecl; readonly at: number };

const noStatement = Option.none<Statement>();

const directiveCases: ReadonlyArray<readonly [ReadonlyArray<string>, P<Option.Option<Statement>>]> =
  [
    [
      ['BASE'],
      Parser.preceded(anyToken, Parser.cut(tok('IRIREF', 'an IRI reference'))).pipe(
        Parser.as(noStatement),
      ),
    ],
    [
      ['PREFIX'],
      Parser.preceded(
        anyToken,
        Parser.cut(
          Parser.seq(
            Token.oneOf<ReadonlyArray<Tok>>((t) => t.type === 'PNAME' && t.iri === '').pipe(
              Parser.expected('a prefix name'),
            ),
            iri,
          ),
        ),
      ).pipe(Parser.as(noStatement)),
    ],
    [
      ['IMPORT'],
      Parser.preceded(anyToken, Parser.cut(iri)).pipe(
        Parser.map((base) => Option.some<Statement>({ _tag: 'Import', iri: base })),
      ),
    ],
  ];

const directive: P<Option.Option<Statement>> = select('a directive', directiveCases);

const startDecl: P<Statement> = Parser.seq(
  Parser.location,
  Parser.preceded(anyToken, Parser.cut(Parser.preceded(tok('='), Parser.seq(shapeAnd, ors)))),
).pipe(
  Parser.map(([at, [first, rest]]): Statement => ({
    _tag: 'Start',
    expr: junction('ShapeOr', plain(first), rest),
    at,
  })),
);

const shapeExprDecl: P<Statement> = Parser.seq(
  accept('ABSTRACT'),
  Parser.location,
  label,
  Parser.repeat(
    Parser.preceded(
      select("'RESTRICTS' or '-'", [[['RESTRICTS', '-'], anyToken]]),
      Parser.cut(shapeOrRef),
    ),
  ),
  select(
    'a shape expression',
    [
      [['EXTERNAL'], anyToken.pipe(Parser.as<AnyShapeExpr>({ type: 'ShapeExternal' }))],
      [
        REF_KINDS,
        Parser.seq(shapeRef, Parser.opt(shapeOrRest)).pipe(
          Parser.map(([ref, rest]) =>
            Option.match(rest, { onNone: () => ref, onSome: (r) => prepend(r, [ref]) }),
          ),
        ),
      ],
    ],
    shapeExpressionBody,
  ),
).pipe(
  Parser.map(([abstract, at, name, restricts, body]): Statement => {
    const shapeExpr = body === EMPTY ? { type: 'Shape' as const } : body;
    const decl: Mutable<ShExJ.ShapeDecl> = { type: 'ShapeDecl', id: name, shapeExpr };
    if (abstract) decl.abstract = true;
    if (Arr.isReadonlyArrayNonEmpty(restricts)) decl.restricts = restricts;
    return { _tag: 'Decl', decl, at };
  }),
);

const statement: P<Option.Option<Statement>> = select('a directive or shape declaration', [
  ...directiveCases,
  [['START'], startDecl.pipe(Parser.map(Option.some))],
  [
    ['ABSTRACT', 'BLANK_NODE_LABEL', ...IRI_KINDS],
    Parser.cut(shapeExprDecl).pipe(Parser.map(Option.some)),
  ],
]);

const document = Compiler.jit(
  Parser.terminated(
    Parser.seq(Parser.repeat(directive), Parser.opt(codeDecls), Parser.repeat(statement)),
    Parser.eof,
  ),
);

// -----------------------------------------------------------------------------
// Checks in document order
// -----------------------------------------------------------------------------

type Visit = (t: ShExJ.TripleExpr, id: string) => void;

const labelledShape = (s: AnyShapeExpr, f: Visit): void => {
  if (!Predicate.isString(s)) labelledShapeExpr(s, f);
};

const labelledTriple = (t: ShExJ.TripleExprOrRef, f: Visit): void => {
  if (Predicate.isString(t)) return;
  if (t.type === 'TripleConstraint') {
    if (t.valueExpr !== undefined) labelledShape(t.valueExpr, f);
  } else t.expressions.forEach((e) => labelledTriple(e, f));
  if (t.id !== undefined) f(t, t.id);
};

// Built once: it runs for every shape expression of every declaration.
const labelledShapeExpr: (s: ShExJ.ShapeExpr, f: Visit) => void = Match.fn(
  (s: ShExJ.ShapeExpr, _f: Visit) => s,
).pipe(
  Match.when({ type: Match.is('ShapeOr', 'ShapeAnd') }, (s, _s, f) =>
    s.shapeExprs.forEach((e) => labelledShape(e, f)),
  ),
  Match.when({ type: 'ShapeNot' }, (s, _s, f) => labelledShape(s.shapeExpr, f)),
  Match.when({ type: 'Shape' }, (s, _s, f) => {
    s.extends?.forEach((e) => labelledShape(e, f));
    if (s.expression !== undefined) labelledTriple(s.expression, f);
  }),
  Match.orElse(() => undefined),
);

/**
 * Calls `f` on each labelled triple expression of a shape expression, in
 * document order (each after the labelled expressions it contains).
 */
const eachLabelled = (e: AnyShapeExpr, f: Visit): void => labelledShape(e, f);

const assemble = (
  statements: ReadonlyArray<Statement>,
  startActs: Option.Option<ReadonlyArray<ShExJ.SemAct>>,
): Result.Result<ShExJ.Schema, SemanticError> => {
  const imports: Array<string> = [];
  // In document order, which the schema keeps.
  const shapes: Array<ShExJ.ShapeDecl> = [];
  const shapeIds = MutableHashSet.empty<string>();
  const productions = MutableHashSet.empty<string>();
  let error = Option.none<SemanticError>();
  const production: Visit = (t, id) => {
    if (Option.isSome(error)) return;
    const at = labelAt.get(t) ?? 0;
    if (MutableHashSet.has(shapeIds, id))
      error = Option.some({ message: `${id} is a shape expression`, at });
    else if (MutableHashSet.has(productions, id))
      error = Option.some({ message: `${id} already defined`, at });
    else MutableHashSet.add(productions, id);
  };
  const step = (
    start: Option.Option<AnyShapeExpr>,
    s: Statement,
  ): Result.Result<Option.Option<AnyShapeExpr>, SemanticError> => {
    if (Predicate.isTagged(s, 'Import')) {
      imports.push(s.iri);
      return Result.succeed(start);
    }
    if (Predicate.isTagged(s, 'Start')) {
      if (Option.isSome(start)) return failAt('start already defined', s.at);
      eachLabelled(s.expr, production);
      return Option.isSome(error) ? Result.fail(error.value) : Result.succeed(Option.some(s.expr));
    }
    const { decl, at } = s;
    decl.restricts?.forEach((r) => eachLabelled(r, production));
    eachLabelled(decl.shapeExpr, production);
    if (Option.isSome(error)) return Result.fail(error.value);
    if (MutableHashSet.has(productions, decl.id))
      return failAt(`${decl.id} is a triple expression`, at);
    if (MutableHashSet.has(shapeIds, decl.id)) return failAt(`${decl.id} already defined`, at);
    MutableHashSet.add(shapeIds, decl.id);
    shapes.push(decl);
    return Result.succeed(start);
  };
  const noStart: Result.Result<Option.Option<AnyShapeExpr>, SemanticError> = Result.succeed(
    Option.none(),
  );
  return Arr.reduce(statements, noStart, (acc, s) =>
    Result.flatMap(acc, (start) => step(start, s)),
  ).pipe(
    Result.map((start) => {
      const schema: Mutable<ShExJ.Schema> = { type: 'Schema' };
      if (Arr.isReadonlyArrayNonEmpty(imports)) schema.imports = imports;
      if (Option.isSome(startActs)) schema.startActs = startActs.value;
      if (Option.isSome(start)) schema.start = start.value;
      if (Arr.isReadonlyArrayNonEmpty(shapes)) schema.shapes = shapes;
      return schema;
    }),
  );
};

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

const offsetOf = (tokens: ReadonlyArray<Tok>, input: string, at: number): number =>
  tokens[at]?.start ?? input.length;

const grammarError = (
  input: string,
  tokens: ReadonlyArray<Tok>,
  error: ParseError.ParseError<SemanticError>,
): ShExCError => {
  if (error.cause !== undefined) {
    return { message: error.cause.message, offset: offsetOf(tokens, input, error.cause.at) };
  }
  const t = tokens[error.offset];
  if (t?.type === 'ERROR') return { message: t.text, offset: t.start };
  const found = t === undefined ? 'end of input' : quote(input.slice(t.start, t.end));
  const expected = ParseError.formatExpected(error.expected);
  return {
    message: expected === '' ? `unexpected ${found}` : `expected ${expected}, found ${found}`,
    offset: offsetOf(tokens, input, error.offset),
  };
};

/** Parses a ShExC document. Errors carry the character offset. */
export const parseShExC = (
  input: string,
  options: ParserOptions,
): Result.Result<ParserResult, ShExCError> => {
  const tokens = tokenize(input);
  const resolved = resolve(tokens, options.baseIri, options.prefixes);
  const parsed = Parser.parse(document, tokens);
  if (Result.isFailure(parsed)) return Result.fail(grammarError(input, tokens, parsed.failure));
  const [directives, startActs, statements] = parsed.success;
  const schema = assemble(Arr.getSomes([...directives, ...statements]), startActs);
  if (Result.isFailure(schema)) {
    return Result.fail({
      message: schema.failure.message,
      offset: offsetOf(tokens, input, schema.failure.at),
    });
  }
  return Result.succeed({
    schema: schema.success,
    prefixes: resolved.prefixes,
    baseIri: resolved.baseIri,
  });
};
