/**
 * ShapeMaps: associations of nodes with shapes, used both as validation
 * input and output. Supports the ShapeMap compact syntax for fixed maps
 * (`node@shape`, `node@START`) and query maps with triple pattern node
 * selectors (`{FOCUS p _}`, `{_ p FOCUS}`), as well as the JSON form.
 *
 * @since 0.1.0
 */
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Result from 'effect/Result';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Token from '@thomasfosterau/effect-parse/Token';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import { RdfParseError } from '@thomasfosterau/effect-rdf/Serialization';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as TurtleGrammar from '@thomasfosterau/effect-turtle/Grammar';
import * as Tokens from './internal/tokens.ts';
import * as Predicate from 'effect/Predicate';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * The `START` shape of a schema.
 *
 * @since 0.1.0
 * @category models
 */
export interface Start {
  readonly _tag: 'Start';
}

/**
 * @since 0.1.0
 * @category constructors
 */
export const start: Start = { _tag: 'Start' };

/**
 * A shape label or `START`.
 *
 * @since 0.1.0
 * @category models
 */
export type ShapeSelector = string | Start;

/**
 * @since 0.1.0
 * @category guards
 */
export const isStart = (s: ShapeSelector): s is Start => !Predicate.isString(s);

/**
 * A triple pattern selecting focus nodes: exactly one of `subject` and
 * `object` is `'FOCUS'`; the other is a term or the wildcard `'_'`.
 *
 * @since 0.1.0
 * @category models
 */
export interface TriplePattern {
  readonly _tag: 'TriplePattern';
  readonly subject: Term.Subject | 'FOCUS' | '_';
  readonly predicate: Term.NamedNode;
  readonly object: Term.Object | 'FOCUS' | '_';
}

/**
 * @since 0.1.0
 * @category models
 */
export type NodeSelector = Term.GroundTerm | TriplePattern;

/**
 * An association in a query shape map.
 *
 * @since 0.1.0
 * @category models
 */
export interface QueryAssociation {
  readonly node: NodeSelector;
  readonly shape: ShapeSelector;
}

/**
 * An association in a fixed shape map.
 *
 * @since 0.1.0
 * @category models
 */
export interface Association {
  readonly node: Term.GroundTerm;
  readonly shape: ShapeSelector;
}

/**
 * @since 0.1.0
 * @category models
 */
export type QueryShapeMap = ReadonlyArray<QueryAssociation>;

/**
 * @since 0.1.0
 * @category models
 */
export type FixedShapeMap = ReadonlyArray<Association>;

/**
 * @since 0.1.0
 * @category models
 */
export interface ParseOptions {
  readonly baseIri?: string | undefined;
  readonly prefixes?: Readonly<Record<string, string>> | undefined;
  /** Prefixes used only for shape labels (e.g. those of the schema). */
  readonly shapePrefixes?: Readonly<Record<string, string>> | undefined;
}

/** The options of the current parse, for resolving IRIs. */
class Options extends Context.Service<Options, ParseOptions>()(
  '@thomasfosterau/effect-shex/ShapeMap/Options',
) {}

const lex = Tokens.lexeme;

/**
 * An IRI: an `IRIREF` resolved against the base IRI, or a prefixed name
 * expanded with `prefixes` (falling back to the options' prefixes).
 */
const iri = (
  prefixes: (options: ParseOptions) => Readonly<Record<string, string>> | undefined,
): Parser.Parser<string, string, Options> =>
  Parser.alt(
    Parser.seq(Parser.service(Options), TurtleGrammar.iriRef).pipe(
      Parser.map(([{ baseIri }, iri]) =>
        baseIri === undefined || Iri.isAbsolute(iri) ? iri : Iri.resolve(iri, baseIri),
      ),
    ),
    // Once a prefixed name has matched, an unknown prefix is an error.
    Parser.preceded(
      Parser.peek(TurtleGrammar.prefixedName),
      Parser.cut(
        Parser.seq(Parser.service(Options), TurtleGrammar.prefixedName).pipe(
          Parser.tryMap(([options, { prefix, local }]) => {
            const ns = prefixes(options)?.[prefix] ?? options.prefixes?.[prefix];
            return ns === undefined
              ? Result.fail(`unknown prefix "${prefix}:"`)
              : Result.succeed(ns + local);
          }),
        ),
      ),
    ),
  );

const noPrefixes = () => undefined;

const namedNode = iri(noPrefixes).pipe(Parser.map((value) => Term.namedNode(value)));

const literal = Parser.seq(
  TurtleGrammar.stringLiteral,
  Parser.opt(
    Parser.alt(
      TurtleGrammar.langTag,
      Parser.preceded(
        Token.literal('^^'),
        Parser.cut(lex(namedNode).pipe(Parser.expected('a datatype IRI'))),
      ),
    ),
  ),
).pipe(
  Parser.map(([value, suffix]) =>
    suffix._tag === 'None'
      ? Term.literal(value)
      : Term.literal(value, suffix.value as string | Term.NamedNode),
  ),
);

const term: Parser.Parser<Term.GroundTerm, string, Options> = lex(
  Parser.alt(
    namedNode,
    TurtleGrammar.blankNodeLabel.pipe(Parser.map((label) => Term.blankNode(label))),
    literal,
    TurtleGrammar.numericLiteral.pipe(
      Parser.map(([value, type]) => Term.literal(value, Term.namedNode(XSD + type))),
    ),
    TurtleGrammar.booleanLiteral.pipe(
      Parser.map((value) => Term.literal(value, Term.namedNode(`${XSD}boolean`))),
    ),
  ),
);

const predicate = lex(
  Parser.alt(
    Parser.terminated(
      Token.literal('a'),
      Parser.not(Token.oneOf([TurtleGrammar.pnChars, ':'])),
    ).pipe(Parser.as(Term.namedNode(RDF_TYPE))),
    namedNode,
  ),
).pipe(Parser.expected('a predicate'));

const focus = lex(Tokens.keyword('FOCUS')).pipe(Parser.as('FOCUS' as const));
const wildcard = lex(Parser.terminated(Token.literal('_'), Parser.not(Token.literal(':'))));

const triplePattern = Parser.preceded(
  lex(Token.literal('{')),
  Parser.cut(
    Parser.terminated(
      Parser.seq(
        Parser.alt(
          focus,
          wildcard,
          term.pipe(
            Parser.filter((t): t is Term.Subject => t._tag !== 'Literal'),
            Parser.expected('a subject'),
          ),
        ),
        predicate,
        Parser.alt(focus, wildcard, term.pipe(Parser.expected('an object'))),
      ),
      lex(Token.literal('}')),
    ).pipe(
      Parser.tryMap(([subject, predicate, object]) =>
        (subject === 'FOCUS') === (object === 'FOCUS')
          ? Result.fail('a triple pattern needs exactly one FOCUS')
          : Result.succeed<NodeSelector>({ _tag: 'TriplePattern', subject, predicate, object }),
      ),
    ),
  ),
);

const nodeSelector: Parser.Parser<NodeSelector, string, Options> = Parser.alt(
  triplePattern,
  term,
).pipe(Parser.expected('a node selector'));

const shapeSelector: Parser.Parser<ShapeSelector, string, Options> = Parser.preceded(
  lex(Token.literal('@')),
  Parser.cut(
    Parser.alt(
      lex(Tokens.keyword('START')).pipe(Parser.as(start)),
      lex(iri((options) => options.shapePrefixes)),
      lex(TurtleGrammar.blankNodeLabel).pipe(Parser.map((label) => `_:${label}`)),
    ).pipe(Parser.expected('a shape label')),
  ),
);

const shapeMap: Parser.Parser<QueryShapeMap, string, Options> = Parser.terminated(
  Parser.separated(
    Parser.struct({ node: nodeSelector, shape: shapeSelector }),
    lex(Token.literal(',')),
  ),
  Tokens.skip,
);

/**
 * Parses a (query) shape map in the compact syntax.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (
  input: string,
  options: ParseOptions = {},
): Effect.Effect<QueryShapeMap, RdfParseError> =>
  Effect.suspend(() => {
    const result = Parser.parse(Parser.provideService(shapeMap, Options, options), input);
    if (Result.isSuccess(result)) return Effect.succeed(result.success);
    const error = result.failure;
    const { line, column } = error.position;
    const message = error.cause ?? error.message.slice(error.message.lastIndexOf('\n') + 1);
    return Effect.fail(new RdfParseError({ format: 'ShapeMap', message, line, column }));
  });

const groundTerm = Parser.terminated(term, Tokens.skip);

/**
 * Parses a single RDF term in N-Triples / Turtle notation (`<iri>`,
 * `_:label`, `"lexical"^^<dt>`, …), as used by the JSON form of shape maps.
 * A bare string that is not a term is taken as an IRI.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseTerm = (input: string, options: ParseOptions = {}): Term.GroundTerm => {
  const result = Parser.parse(Parser.provideService(groundTerm, Options, options), input);
  if (Result.isSuccess(result)) return result.success;
  if (input.startsWith('_:')) return Term.blankNode(input.slice(2));
  return Term.namedNode(
    options.baseIri === undefined || Iri.isAbsolute(input)
      ? input
      : Iri.resolve(input, options.baseIri),
  );
};

/**
 * Reads the JSON form of a fixed shape map: an array of
 * `{ "node": term, "shape": label | "START" }` objects. Node terms use
 * N-Triples notation or are bare IRIs.
 *
 * @since 0.1.0
 * @category parsing
 */
export const fromJson = (json: unknown, options: ParseOptions = {}): FixedShapeMap => {
  if (!Array.isArray(json)) return [];
  return json.map((entry: { node: string; shape: string }) => ({
    node: parseTerm(entry.node, options),
    shape:
      entry.shape === 'START'
        ? start
        : entry.shape.startsWith('_:') ||
            options.baseIri === undefined ||
            Iri.isAbsolute(entry.shape)
          ? entry.shape
          : Iri.resolve(entry.shape, options.baseIri),
  }));
};

/**
 * Resolves a query shape map against a dataset, producing a fixed shape map
 * (duplicates removed, order preserved).
 *
 * @since 0.1.0
 * @category combinators
 */
export const resolve = (map: QueryShapeMap, dataset: Dataset.Dataset): FixedShapeMap => {
  const out: Array<Association> = [];
  const seen = new Set<string>();
  const push = (node: Term.GroundTerm, shape: ShapeSelector) => {
    const key = `${node.key} ${isStart(shape) ? '' : shape}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ node, shape });
  };
  for (const { node, shape } of map) {
    if (node._tag !== 'TriplePattern') {
      push(node, shape);
      continue;
    }
    const pattern: Dataset.Pattern = {
      predicate: node.predicate,
      subject: node.subject !== 'FOCUS' && node.subject !== '_' ? node.subject : undefined,
      object: node.object !== 'FOCUS' && node.object !== '_' ? node.object : undefined,
    };
    for (const q of Dataset.match(dataset, pattern)) {
      push(node.subject === 'FOCUS' ? q.subject : q.object, shape);
    }
  }
  return out;
};

/**
 * Formats a shape selector for display.
 *
 * @since 0.1.0
 * @category formatting
 */
export const formatShape = (shape: ShapeSelector): string =>
  isStart(shape) ? 'START' : shape.startsWith('_:') ? shape : `<${shape}>`;

/**
 * Formats a fixed shape map in the compact syntax.
 *
 * @since 0.1.0
 * @category formatting
 */
export const format = (map: FixedShapeMap): string =>
  map.map((a) => `${a.node.key}@${formatShape(a.shape)}`).join(',\n');
