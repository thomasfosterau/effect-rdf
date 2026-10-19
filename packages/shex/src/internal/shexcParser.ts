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
import * as ParseError from '@thomasfosterau/effect-parse/ParseError';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Token from '@thomasfosterau/effect-parse/Token';
import * as Result from 'effect/Result';
import type * as ShExJ from '../ShExJ.ts';
import { resolve, type Tok, tokenize } from './shexcLexer.ts';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_INTEGER = `${XSD}integer`;
const XSD_DECIMAL = `${XSD}decimal`;
const XSD_DOUBLE = `${XSD}double`;
const XSD_FLOAT = `${XSD}float`;
const XSD_BOOLEAN = `${XSD}boolean`;

const numericDatatypes = new Set(
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
  readonly baseIri?: string | undefined;
  readonly prefixes?: Readonly<Record<string, string>> | undefined;
}

/** The result of parsing ShExC. */
export interface ParserResult {
  readonly schema: ShExJ.Schema;
  readonly prefixes: ReadonlyMap<string, string>;
  readonly baseIri: string | undefined;
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
  const record: Record<string, P<A | B>> = {};
  for (const [kinds, p] of cases) for (const k of kinds) record[k] ??= p;
  const chosen: P<A | B> =
    otherwise === undefined
      ? Parser.dispatch(nextKind, record)
      : Parser.dispatch(nextKind, record, otherwise);
  return chosen.pipe(Parser.expected(label));
};

/** Fails with a semantic error at token index `at`. */
const failAt = <A>(message: string, at: number): Result.Result<A, SemanticError> =>
  Result.fail({ message, at });

const optional = <A>(p: P<A>): P<A | undefined> =>
  Parser.opt(p).pipe(Parser.map((o) => (o._tag === 'Some' ? o.value : undefined)));

/** Whether the next token is of one of `kinds` (consumed if so). */
const accept = (...kinds: ReadonlyArray<string>): P<boolean> =>
  Parser.opt(Token.oneOf<ReadonlyArray<Tok>>((t) => kinds.includes(t.kind))).pipe(
    Parser.map((o) => o._tag === 'Some'),
  );

const IRI_KINDS = ['IRIREF', 'PNAME'];

/** The IRI of an IRIREF or PNAME token, or the token's resolution error. */
const iri: P<string> = Parser.seq(
  Parser.location,
  Token.oneOf<ReadonlyArray<Tok>>((t) => t.kind === 'IRIREF' || t.kind === 'PNAME'),
).pipe(
  Parser.tryMap(([at, t]) =>
    t.error === undefined ? Result.succeed(t.iri) : failAt<string>(t.error, at),
  ),
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
    Parser.seq(anyToken, optional(Parser.preceded(tok('^^'), Parser.cut(iri)))).pipe(
      Parser.map(([t, type]): ShExJ.ObjectLiteral =>
        type === undefined ? { value: t.text } : { value: t.text, type },
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

const junction = (
  type: 'ShapeAnd' | 'ShapeOr',
  atom: Atom,
  juncts: ReadonlyArray<AnyShapeExpr>,
): AnyShapeExpr => {
  if (juncts.length === 0) return atom.e;
  const e = atom.e;
  if (typeof e === 'object' && e.type === type && !atom.nested) {
    return { ...e, shapeExprs: (e as ShExJ.ShapeAnd).shapeExprs.concat(juncts) };
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

const prepend = (rest: Rest, atoms: ReadonlyArray<AnyShapeExpr>): AnyShapeExpr => {
  if (rest._tag === 'Or') return { type: 'ShapeOr', shapeExprs: [...atoms, ...rest.ors] };
  const and: ShExJ.ShapeAnd = { type: 'ShapeAnd', shapeExprs: [...atoms, ...rest.ands] };
  return rest.ors.length > 0 ? { type: 'ShapeOr', shapeExprs: [and, ...rest.ors] } : and;
};

const prependAtom = (atom: Atom, rest: Rest | undefined): AnyShapeExpr => {
  if (rest === undefined) return atom.e;
  const e = atom.e;
  if (
    typeof e === 'object' &&
    e.type === 'ShapeAnd' &&
    rest._tag === 'And' &&
    rest.ors.length === 0 &&
    !atom.nested
  ) {
    return prepend(rest, e.shapeExprs);
  }
  return prepend(rest, [e]);
};

// -----------------------------------------------------------------------------
// Annotations, semantic actions and cardinalities
// -----------------------------------------------------------------------------

const annotations: P<Array<ShExJ.Annotation>> = Parser.repeat(
  Parser.preceded(
    tok('//'),
    Parser.cut(
      Parser.seq(predicate, select('an IRI or a literal', [[IRI_KINDS, iri]], literal)).pipe(
        Parser.map(([predicate, object]): ShExJ.Annotation => ({
          type: 'Annotation',
          predicate,
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
          [['CODE'], anyToken.pipe(Parser.map((t) => t.text))],
          [['%'], anyToken.pipe(Parser.as(undefined))],
        ]),
      ).pipe(
        Parser.map(([name, code]): ShExJ.SemAct =>
          code === undefined ? { type: 'SemAct', name } : { type: 'SemAct', name, code },
        ),
      ),
    ),
  ),
  { min: 1 },
);

const semanticActions: P<Array<ShExJ.SemAct> | undefined> = optional(codeDecls);

const cardinality: P<{ min: number; max: number } | undefined> = optional(
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
        if (numericDatatypes.has(dt)) return Result.succeed(parseInt(value, 10));
        return failAt<number>(`numeric range facet expected numeric datatype instead of ${dt}`, at);
      }),
      Parser.cut,
    ),
  ],
]);

type Facet = readonly [key: string, value: number | string, at: number, flags?: string];

const STRING_FACETS = ['REGEXP', 'LENGTH', 'MINLENGTH', 'MAXLENGTH'];
const NUMERIC_FACETS = [
  'TOTALDIGITS',
  'FRACTIONDIGITS',
  'MININCLUSIVE',
  'MINEXCLUSIVE',
  'MAXINCLUSIVE',
  'MAXEXCLUSIVE',
];

const facetCases: Record<string, P<Facet>> = {
  REGEXP: Parser.seq(Parser.location, anyToken).pipe(
    Parser.map(([at, t]): Facet => ['pattern', t.text, at, t.suffix]),
  ),
  ...Object.fromEntries(
    ['LENGTH', 'MINLENGTH', 'MAXLENGTH', 'TOTALDIGITS', 'FRACTIONDIGITS'].map((k) => [
      k,
      Parser.seq(Parser.location, anyToken, integer).pipe(
        Parser.map(([at, t, n]): Facet => [t.text.toLowerCase(), n, at]),
      ),
    ]),
  ),
  ...Object.fromEntries(
    ['MININCLUSIVE', 'MINEXCLUSIVE', 'MAXINCLUSIVE', 'MAXEXCLUSIVE'].map((k) => [
      k,
      Parser.seq(Parser.location, anyToken, Parser.cut(rawNumeric)).pipe(
        Parser.map(([at, t, n]): Facet => [t.text.toLowerCase(), n, at]),
      ),
    ]),
  ),
};

const facets = (strings: boolean, numerics: boolean): P<Mutable<ShExJ.Facets>> =>
  Parser.repeat(
    select(
      'a facet',
      [...(strings ? STRING_FACETS : []), ...(numerics ? NUMERIC_FACETS : [])].map(
        (k) => [[k], facetCases[k]!] as const,
      ),
    ),
  ).pipe(
    Parser.tryMap((list) => {
      const out: Record<string, unknown> = {};
      for (const [key, value, at, flags] of list) {
        if (key in out) {
          return failAt<Mutable<ShExJ.Facets>>(`facet ${key} defined multiple times`, at);
        }
        out[key] = value;
        if (flags !== undefined && flags !== '') out.flags = flags;
      }
      return Result.succeed(out as Mutable<ShExJ.Facets>);
    }),
    Parser.cut,
  );

// Value sets ---------------------------------------------------------------------

const tilde = accept('~');

const exclusion = <A>(p: P<A>): P<A> => Parser.preceded(tok('-'), Parser.cut(p));

const iriExclusion: P<string | ShExJ.IriStem> = exclusion(
  Parser.seq(iri, tilde).pipe(
    Parser.map(([iri, stem]) => (stem ? { type: 'IriStem', stem: iri } : iri)),
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
  exclusion: P<X>,
  build: (head: A, stem: boolean, exclusions: Array<X>) => ShExJ.ValueSetValue,
): P<ShExJ.ValueSetValue> =>
  Parser.seq(head, optional(Parser.preceded(tok('~'), Parser.repeat(exclusion)))).pipe(
    Parser.map(([h, exclusions]) => build(h, exclusions !== undefined, exclusions ?? [])),
  );

/** The exclusions after a `.` wildcard: their kind is chosen by the first one. */
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
      ...Object.fromEntries(
        IRI_KINDS.map((k) => [
          k,
          Parser.repeat(iriExclusion).pipe(
            Parser.map((exclusions): ShExJ.ValueSetValue => ({
              type: 'IriStemRange',
              stem: { type: 'Wildcard' },
              exclusions,
            })),
          ),
        ]),
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
).pipe(Parser.expected("'-'")) as P<ShExJ.ValueSetValue>;

const valueSetValue: P<ShExJ.ValueSetValue> = select('a value set value', [
  [
    IRI_KINDS,
    Parser.cut(
      stemmed(iri, iriExclusion, (stem, isStem, exclusions) =>
        !isStem
          ? stem
          : exclusions.length > 0
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
          : exclusions.length > 0
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
          : exclusions.length > 0
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
        exclusions.length > 0
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
      Parser.tryMap(([at, datatype, f]) => {
        if (!numericDatatypes.has(datatype)) {
          for (const name of numericFacetNames) {
            if (name in f) {
              return failAt<ShExJ.NodeConstraint>(
                `facet ${name} not allowed for unknown datatype ${datatype}`,
                at,
              );
            }
          }
        }
        return Result.succeed<ShExJ.NodeConstraint>({ type: 'NodeConstraint', datatype, ...f });
      }),
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

const nonLitInlineNodeConstraint: P<ShExJ.NodeConstraint> = Parser.seq(
  optional(select('a node kind', [[NODE_KINDS, anyToken.pipe(Parser.map((t) => t.text))]])),
  facets(true, false),
).pipe(
  Parser.map(([kind, f]): ShExJ.NodeConstraint => {
    const nodeKind: ShExJ.NodeKind | undefined =
      kind === undefined
        ? undefined
        : kind === 'IRI'
          ? 'iri'
          : kind === 'BNODE'
            ? 'bnode'
            : 'nonliteral';
    return nodeKind === undefined
      ? { type: 'NodeConstraint', ...f }
      : { type: 'NodeConstraint', nodeKind, ...f };
  }),
);

/** A non-literal node constraint, if one starts here. */
const nonLitNodeConstraintOpt: P<ShExJ.NodeConstraint | undefined> = optional(
  select('a node constraint', [[NON_LIT_KINDS, Parser.cut(nonLitInlineNodeConstraint)]]),
);

const withAnnotations = (nc: P<ShExJ.NodeConstraint>): P<ShExJ.NodeConstraint> =>
  Parser.seq(nc, annotations, semanticActions).pipe(
    Parser.map(([nc, annotations, semActs]) => {
      if (annotations.length === 0 && semActs === undefined) return nc;
      const out: Mutable<ShExJ.NodeConstraint> = nc;
      if (annotations.length > 0) out.annotations = annotations;
      if (semActs !== undefined) out.semActs = semActs;
      return out;
    }),
  );

/** A non-literal node constraint with its annotations, if one starts here. */
const annotatedNonLitNodeConstraintOpt: P<ShExJ.NodeConstraint | undefined> = optional(
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
      Parser.tryMap(([at, t]) =>
        t.error === undefined ? Result.succeed(t.iri) : failAt<string>(t.error, at),
      ),
      Parser.cut,
    ),
  ],
  [['@'], Parser.preceded(anyToken, Parser.cut(label))],
]);

const shapeExpressionBody: P<AnyShapeExpr> = Parser.suspend(() => shapeExpressionBody_);
const tripleExpression: P<ShExJ.TripleExprOrRef> = Parser.suspend(() => tripleExpression_);
const extendsShapeOr: P<AnyShapeExpr> = Parser.suspend(() => extendsShapeOr_);
const inlineShapeExpression: P<AnyShapeExpr> = Parser.suspend(() => inlineShapeExpression_);

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
      [[['}'], Parser.succeed(undefined)]],
      Parser.cut(tripleExpression),
    ),
    Parser.cut(tok('}')),
  ),
).pipe(
  Parser.map(([qualifiers, expression]): ShExJ.Shape => {
    if (expression === undefined && qualifiers.length === 0) return EMPTY;
    let extendsList: Array<AnyShapeExpr> | undefined;
    let extra: Array<string> | undefined;
    let closed: boolean | undefined;
    for (const q of qualifiers) {
      if (q._tag === 'Extends') (extendsList ??= []).push(q.e);
      else if (q._tag === 'Extra') (extra ??= []).push(...q.predicates);
      else closed = true;
    }
    const shape: Mutable<ShExJ.Shape> = { type: 'Shape' };
    if (expression !== undefined) shape.expression = expression;
    if (extendsList !== undefined) shape.extends = extendsList;
    if (extra !== undefined) shape.extra = extra;
    if (closed !== undefined) shape.closed = closed;
    return shape;
  }),
);

const shapeDefinition: P<AnyShapeExpr> = Parser.seq(
  inlineShapeDefinition,
  annotations,
  semanticActions,
).pipe(
  Parser.map(([def, annotations, semActs]) => {
    const out: Mutable<ShExJ.Shape> = def === EMPTY ? { type: 'Shape' } : def;
    if (annotations.length > 0) out.annotations = annotations;
    if (semActs !== undefined) out.semActs = semActs;
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
const shapeOrRefOpt = (p: P<AnyShapeExpr>): P<AnyShapeExpr | undefined> =>
  optional(
    select('a shape definition or reference', [
      [[...SHAPE_DEF_KINDS, ...REF_KINDS], Parser.cut(p)],
    ]),
  );

/** shapeAtom (with `allowRef`) and shapeAtomNoRef. */
const shapeAtom = (allowRef: boolean): P<Atom> =>
  select('a shape expression', [
    [
      NON_LIT_KINDS,
      Parser.cut(
        Parser.seq(withAnnotations(nonLitInlineNodeConstraint), shapeOrRefOpt(shapeOrRef)).pipe(
          Parser.map(([nc, ref]) =>
            plain(ref === undefined ? nc : { type: 'ShapeAnd', shapeExprs: [{ ...nc }, ref] }),
          ),
        ),
      ),
    ],
    [LIT_KINDS, Parser.cut(withAnnotations(litInlineNodeConstraint)).pipe(Parser.map(plain))],
    [
      allowRef ? [...SHAPE_DEF_KINDS, ...REF_KINDS] : SHAPE_DEF_KINDS,
      Parser.cut(
        Parser.seq(shapeOrRef, annotatedNonLitNodeConstraintOpt).pipe(
          Parser.map(([sor, nc]) =>
            plain(nc === undefined ? sor : junction('ShapeAnd', plain(sor), [nc])),
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
  [['OR'], ors.pipe(Parser.map((ors): Rest => ({ _tag: 'Or', ors })))],
  [
    ['AND'],
    Parser.seq(Parser.repeat(Parser.preceded(tok('AND'), Parser.cut(shapeNot))), ors).pipe(
      Parser.map(([conjuncts, ors]): Rest => {
        const ands: Array<AnyShapeExpr> = [];
        for (const c of conjuncts) {
          if (typeof c.e === 'object' && c.e.type === 'ShapeAnd' && !c.nested) {
            ands.push(...c.e.shapeExprs);
          } else ands.push(c.e);
        }
        return { _tag: 'And', ands, ors };
      }),
    ),
  ],
]);

/**
 * shapeExpression ::= NOT? shapeAtomNoRef shapeOr? | NOT shapeRef shapeOr? | shapeRef shapeOr
 */
const shapeExpressionBody_: P<AnyShapeExpr> = select(
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
                Parser.seq(shapeRef, optional(shapeOrRest)).pipe(
                  Parser.map(([ref, rest]) =>
                    prependAtom(plain({ type: 'ShapeNot', shapeExpr: ref }), rest),
                  ),
                ),
              ],
            ],
            Parser.seq(shapeAtom(false), optional(shapeOrRest)).pipe(
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
  Parser.seq(shapeAtom(false), optional(shapeOrRest)).pipe(
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
              Parser.map(([nc, ref]) =>
                plain(ref === undefined ? nc : { type: 'ShapeAnd', shapeExprs: [{ ...nc }, ref] }),
              ),
            ),
      ),
    ],
    [LIT_KINDS, Parser.cut(litInlineNodeConstraint).pipe(Parser.map(plain))],
    [
      [...SHAPE_DEF_KINDS, ...REF_KINDS],
      Parser.cut(
        Parser.seq(inlineShapeOrRef, nonLitNodeConstraintOpt).pipe(
          Parser.map(([sor, nc]) =>
            plain(nc === undefined ? sor : { type: 'ShapeAnd', shapeExprs: [sor, nc] }),
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

const inlineShapeExpression_: P<AnyShapeExpr> = junctions(inlineAtom(false));
const extendsShapeOr_: P<AnyShapeExpr> = junctions(inlineAtom(true));

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
  Parser.map(([inverse, predicate, valueExpr, card, annotations, semActs]) => {
    const tc: Mutable<ShExJ.TripleConstraint> = inverse
      ? { type: 'TripleConstraint', inverse: true, predicate }
      : { type: 'TripleConstraint', predicate };
    if (valueExpr !== EMPTY) tc.valueExpr = valueExpr;
    if (card !== undefined) {
      tc.min = card.min;
      tc.max = card.max;
    }
    if (semActs !== undefined) tc.semActs = semActs;
    if (annotations.length > 0) tc.annotations = annotations;
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
  Parser.tryMap(([at, expr, card, annotations, semActs]) => {
    if (card === undefined && annotations.length === 0 && semActs === undefined) {
      return Result.succeed(expr);
    }
    if (typeof expr === 'string') {
      return failAt<ShExJ.TripleExprOrRef>(
        `a group containing only the inclusion &<${expr}> can't take a cardinality, an annotation or a semantic action`,
        at,
      );
    }
    let out = expr as Mutable<ShExJ.EachOf>;
    if (
      card !== undefined &&
      expr.type === 'TripleConstraint' &&
      (expr.min !== undefined || expr.max !== undefined)
    ) {
      out = { type: 'EachOf', expressions: [expr] };
    }
    if (card !== undefined) {
      out.min = card.min;
      out.max = card.max;
    }
    if (annotations.length > 0) out.annotations = annotations;
    if (semActs !== undefined) out.semActs = [...(out.semActs ?? []), ...semActs];
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
        if (typeof expr === 'string') {
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
    rest.length === 0 ? first : { type: 'EachOf', expressions: [first, ...rest] },
  ),
);

const tripleExpression_: P<ShExJ.TripleExprOrRef> = Parser.seq(
  groupTripleExpr,
  Parser.repeat(Parser.preceded(tok('|'), Parser.cut(groupTripleExpr))),
).pipe(
  Parser.map(([first, rest]) =>
    rest.length === 0 ? first : { type: 'OneOf', expressions: [first, ...rest] },
  ),
);

// -----------------------------------------------------------------------------
// Document
// -----------------------------------------------------------------------------

type Statement =
  | { readonly _tag: 'Import'; readonly iri: string }
  | { readonly _tag: 'Start'; readonly expr: AnyShapeExpr; readonly at: number }
  | { readonly _tag: 'Decl'; readonly decl: ShExJ.ShapeDecl; readonly at: number };

const directiveCases: ReadonlyArray<readonly [ReadonlyArray<string>, P<Statement | undefined>]> = [
  [
    ['BASE'],
    Parser.preceded(anyToken, Parser.cut(tok('IRIREF', 'an IRI reference'))).pipe(
      Parser.as(undefined),
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
    ).pipe(Parser.as(undefined)),
  ],
  [
    ['IMPORT'],
    Parser.preceded(anyToken, Parser.cut(iri)).pipe(
      Parser.map((iri): Statement => ({ _tag: 'Import', iri })),
    ),
  ],
];

const directive: P<Statement | undefined> = select('a directive', directiveCases);

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
        Parser.seq(shapeRef, optional(shapeOrRest)).pipe(
          Parser.map(([ref, rest]) => (rest === undefined ? ref : prepend(rest, [ref]))),
        ),
      ],
    ],
    shapeExpressionBody,
  ),
).pipe(
  Parser.map(([abstract, at, label, restricts, body]): Statement => {
    const shapeExpr = body === EMPTY ? { type: 'Shape' as const } : body;
    const decl: Mutable<ShExJ.ShapeDecl> = { type: 'ShapeDecl', id: label, shapeExpr };
    if (abstract) decl.abstract = true;
    if (restricts.length > 0) decl.restricts = restricts;
    return { _tag: 'Decl', decl, at };
  }),
);

const statement: P<Statement | undefined> = select('a directive or shape declaration', [
  ...directiveCases,
  [['START'], startDecl],
  [['ABSTRACT', 'BLANK_NODE_LABEL', ...IRI_KINDS], Parser.cut(shapeExprDecl)],
]);

const document = Parser.compile(
  Parser.terminated(
    Parser.seq(Parser.repeat(directive), optional(codeDecls), Parser.repeat(statement)),
    Parser.eof,
  ),
);

// -----------------------------------------------------------------------------
// Checks in document order
// -----------------------------------------------------------------------------

/**
 * Calls `f` on each labelled triple expression of a shape expression, in
 * document order (each after the labelled expressions it contains).
 */
const eachLabelled = (e: AnyShapeExpr, f: (t: ShExJ.TripleExpr) => void): void => {
  const shape = (s: AnyShapeExpr): void => {
    if (typeof s === 'string') return;
    switch (s.type) {
      case 'ShapeOr':
      case 'ShapeAnd':
        s.shapeExprs.forEach(shape);
        break;
      case 'ShapeNot':
        shape(s.shapeExpr);
        break;
      case 'Shape':
        s.extends?.forEach(shape);
        if (s.expression !== undefined) triple(s.expression);
        break;
      default:
        break;
    }
  };
  const triple = (t: ShExJ.TripleExprOrRef): void => {
    if (typeof t === 'string') return;
    if (t.type === 'TripleConstraint') {
      if (t.valueExpr !== undefined) shape(t.valueExpr);
    } else t.expressions.forEach(triple);
    if (t.id !== undefined) f(t);
  };
  shape(e);
};

const assemble = (
  statements: ReadonlyArray<Statement | undefined>,
  startActs: ReadonlyArray<ShExJ.SemAct> | undefined,
): Result.Result<ShExJ.Schema, SemanticError> => {
  const imports: Array<string> = [];
  const shapes = new Map<string, ShExJ.ShapeDecl>();
  const productions = new Set<string>();
  let start: AnyShapeExpr | undefined;
  let error: SemanticError | undefined;
  const production = (t: ShExJ.TripleExpr) => {
    if (error !== undefined) return;
    const id = t.id!;
    const at = labelAt.get(t) ?? 0;
    if (shapes.has(id)) error = { message: `${id} is a shape expression`, at };
    else if (productions.has(id)) error = { message: `${id} already defined`, at };
    else productions.add(id);
  };
  for (const s of statements) {
    if (s === undefined) continue;
    if (s._tag === 'Import') imports.push(s.iri);
    else if (s._tag === 'Start') {
      if (start !== undefined) return failAt('start already defined', s.at);
      eachLabelled(s.expr, production);
      if (error !== undefined) return Result.fail(error);
      start = s.expr;
    } else {
      const { decl, at } = s;
      decl.restricts?.forEach((r) => eachLabelled(r, production));
      eachLabelled(decl.shapeExpr, production);
      if (error !== undefined) return Result.fail(error);
      if (productions.has(decl.id)) return failAt(`${decl.id} is a triple expression`, at);
      if (shapes.has(decl.id)) return failAt(`${decl.id} already defined`, at);
      shapes.set(decl.id, decl);
    }
  }
  const schema: Mutable<ShExJ.Schema> = { type: 'Schema' };
  if (imports.length > 0) schema.imports = imports;
  if (startActs !== undefined) schema.startActs = startActs;
  if (start !== undefined) schema.start = start;
  if (shapes.size > 0) schema.shapes = Array.from(shapes.values());
  return Result.succeed(schema);
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
  const found = t === undefined ? 'end of input' : JSON.stringify(input.slice(t.start, t.end));
  const expected = ParseError.formatExpected(error.expected);
  return {
    message: expected === '' ? `unexpected ${found}` : `expected ${expected}, found ${found}`,
    offset: offsetOf(tokens, input, error.offset),
  };
};

/** Parses a ShExC document. Errors carry the character offset. */
export const parseShExC = (
  input: string,
  options: ParserOptions = {},
): Result.Result<ParserResult, ShExCError> => {
  const tokens = tokenize(input);
  const resolved = resolve(tokens, options.baseIri, options.prefixes);
  const parsed = Parser.parse(document, tokens);
  if (Result.isFailure(parsed)) return Result.fail(grammarError(input, tokens, parsed.failure));
  const [directives, startActs, statements] = parsed.success;
  const schema = assemble([...directives, ...statements], startActs);
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
