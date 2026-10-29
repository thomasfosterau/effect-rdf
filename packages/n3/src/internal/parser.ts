/**
 * The Notation3 parser, in two steps:
 *
 * 1. A compiled `@thomasfosterau/effect-parse` grammar over the input string
 *    (no separate lexer) produces a syntax tree. It is built on the Turtle
 *    terminals of `effect-turtle` (`Grammar`), as the N3 grammar is: N3 extends
 *    Turtle with formulas, paths, quick variables, `=`, `=>`, `<=`, `has`,
 *    `is … of` and the legacy `@forAll` / `@forSome`.
 * 2. A builder walks the tree in document order and does everything that
 *    depends on what came before: `@prefix` / `@base`, quantifier scopes,
 *    blank node allocation and the order in which statements are emitted
 *    (paths emit their statements as they are read).
 *
 * Keeping the grammar free of per-document state lets it be compiled.
 *
 * @internal
 */
import * as Ascii from '@thomasfosterau/effect-parse/Ascii';
import * as Compiler from '@thomasfosterau/effect-parse/Compiler';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Token from '@thomasfosterau/effect-parse/Token';
import * as TurtleGrammar from '@thomasfosterau/effect-turtle/Grammar';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { rdf, xsd } from '@thomasfosterau/effect-rdf/Vocab';
import * as Arr from 'effect/Array';
import * as Result from 'effect/Result';
import * as Model from '../Model.ts';
import { i18n, log, sameAs } from '../Vocab.ts';

/** @internal */
export class SyntaxFailure {
  readonly message: string;
  readonly line: number;
  readonly column: number;
  constructor(message: string, line: number, column: number) {
    this.message = message;
    this.line = line;
    this.column = column;
  }
}

/** @internal */
export interface ParserOptions {
  readonly baseIri?: string | undefined;
  readonly blankNodePrefix?: string | undefined;
}

// -----------------------------------------------------------------------------
// Character classes (also used by the writer)
// -----------------------------------------------------------------------------

/** @internal */
export const isPnCharsBase = (c: number): boolean =>
  (c >= 0x41 && c <= 0x5a) ||
  (c >= 0x61 && c <= 0x7a) ||
  (c >= 0xc0 && c <= 0xd6) ||
  (c >= 0xd8 && c <= 0xf6) ||
  (c >= 0xf8 && c <= 0x2ff) ||
  (c >= 0x370 && c <= 0x37d) ||
  (c >= 0x37f && c <= 0x1fff) ||
  (c >= 0x200c && c <= 0x200d) ||
  (c >= 0x2070 && c <= 0x218f) ||
  (c >= 0x2c00 && c <= 0x2fef) ||
  (c >= 0x3001 && c <= 0xd7ff) ||
  (c >= 0xf900 && c <= 0xfdcf) ||
  (c >= 0xfdf0 && c <= 0xfffd) ||
  (c >= 0x10000 && c <= 0xeffff);

/** @internal */
export const isPnCharsU = (c: number): boolean => c === 0x5f || isPnCharsBase(c);

/** @internal */
export const isPnChars = (c: number): boolean =>
  isPnCharsU(c) ||
  c === 0x2d ||
  (c >= 0x30 && c <= 0x39) ||
  c === 0xb7 ||
  (c >= 0x300 && c <= 0x36f) ||
  (c >= 0x203f && c <= 0x2040);

/** Whether a string is a valid `PN_PREFIX` (or empty). @internal */
export const isPnPrefix = (s: string): boolean => {
  const cps = Array.from(s, (ch) => ch.codePointAt(0)!);
  if (Arr.isReadonlyArrayEmpty(cps)) return true;
  if (!isPnCharsBase(cps[0]!)) return false;
  if (cps.length > 1 && cps[cps.length - 1] === 0x2e) return false;
  return cps.slice(1).every((c) => c === 0x2e || isPnChars(c));
};

/** Whether a string is a valid quick variable name (without `?`). @internal */
export const isVarName = (s: string): boolean => {
  const cps = Array.from(s, (ch) => ch.codePointAt(0)!);
  return Arr.isReadonlyArrayNonEmpty(cps) && isPnCharsU(cps[0]!) && cps.slice(1).every(isPnChars);
};

// -----------------------------------------------------------------------------
// Syntax tree
// -----------------------------------------------------------------------------

/** An IRI as written: an IRI reference or a prefixed name, at an offset. */
type IriNode =
  | {
      readonly _tag: 'IriRef';
      readonly value: string;
      readonly at: number;
      /** Whether the reference contains `UCHAR` escapes. */
      readonly escaped: boolean;
    }
  | {
      readonly _tag: 'PName';
      readonly prefix: string;
      readonly local: string;
      readonly at: number;
    };

type Item =
  | IriNode
  | { readonly _tag: 'Blank'; readonly label: string }
  | { readonly _tag: 'Anon'; readonly id: IriNode | undefined; readonly pol: ReadonlyArray<Pol> }
  | { readonly _tag: 'List'; readonly items: ReadonlyArray<Path> }
  | { readonly _tag: 'Formula'; readonly statements: ReadonlyArray<Statement> }
  | { readonly _tag: 'Var'; readonly name: string }
  /** A syntax error found while reading (reported in document order by the builder). */
  | { readonly _tag: 'Error'; readonly message: string; readonly at: number }
  | { readonly _tag: 'Literal'; readonly value: Term.Literal }
  | {
      readonly _tag: 'String';
      readonly value: string;
      readonly language: string | undefined;
      readonly datatype: IriNode | undefined;
    };

/** A path: an item, or an item followed by `!` (forward) and `^` (backward) steps. */
type Path =
  | Item
  | {
      readonly _tag: 'Path';
      readonly head: Item;
      readonly steps: ReadonlyArray<readonly ['!' | '^', Item]>;
    };

type Verb =
  | { readonly _tag: 'Fixed'; readonly predicate: Model.N3Term }
  | { readonly _tag: 'Path'; readonly path: Path; readonly inverse: boolean };

/** A verb and its objects. */
type Pol = readonly [verb: Verb, objects: ReadonlyArray<Path>];

type Statement =
  | { readonly _tag: 'Prefix'; readonly prefix: string; readonly iri: IriNode }
  | { readonly _tag: 'Base'; readonly iri: IriNode }
  | {
      readonly _tag: 'Quantifier';
      readonly universal: boolean;
      readonly iris: ReadonlyArray<IriNode>;
    }
  | { readonly _tag: 'Triples'; readonly subject: Path; readonly pol: ReadonlyArray<Pol> }
  | { readonly _tag: 'Error'; readonly message: string; readonly at: number };

// -----------------------------------------------------------------------------
// Grammar
// -----------------------------------------------------------------------------

/** A syntax error with its offset (the cause of a grammar failure). */
interface Fail {
  readonly message: string;
  readonly at: number;
}

type P<A> = Parser.Parser<A, Fail>;

const fail = <A>(message: string, at: number): Result.Result<A, Fail> =>
  Result.fail({ message, at });

const WHITESPACE = 'whitespace';

/** Whitespace and `#` comments (which also end at a form feed). */
const ws: P<void> = Parser.asVoid(
  Parser.repeat(
    Parser.alt(
      Token.takeWhile(' \t\r\n', { min: 1 }),
      Parser.preceded(Token.literal('#'), Token.takeTill('\n\r\f')),
    ).pipe(Parser.expected(WHITESPACE)),
  ),
);

const lit = (s: string): P<string> => Token.literal(s);

const closeBracket: P<string> = Parser.cut(Parser.preceded(ws, Token.literal(']'))).pipe(
  Parser.expected("']'"),
);

/** `s` after whitespace. */
const sym = (s: string): P<string> => Parser.preceded(ws, Token.literal(s));

/** A character that ends a statement, a list of objects or a formula. */
const endOf = (chars: string): P<unknown> =>
  Parser.preceded(ws, Parser.alt(Parser.eof, Parser.peek(Token.oneOf(chars))));

/** An `@` keyword: `@` followed by letters. */
const atWord: P<string> = Parser.taken(
  Parser.preceded(lit('@'), Token.takeWhile(TurtleGrammar.alpha, { min: 1 })),
);

const atKeyword = (word: string): P<string> => atWord.pipe(Parser.filter((w) => w === word));

/** A `PN_PREFIX` not followed by `:` (a bare word such as `a`, `is`, `true`). */
const bareWord: P<string> = Parser.terminated(TurtleGrammar.pnPrefix, Parser.not(lit(':')));

const word = (w: string): P<string> => bareWord.pipe(Parser.filter((x) => x === w));

// eslint-disable-next-line no-control-regex
const forbiddenInIri = /[\u0000- <>"{}|^`\\]/u;

/** IRIREF (escapes of characters not allowed in IRIs are rejected by the builder). */
const iriRef: P<IriNode> = Parser.seq(Parser.location, TurtleGrammar.iriRef, Parser.location).pipe(
  Parser.map(([at, value, end]): IriNode => ({
    _tag: 'IriRef',
    value,
    at,
    escaped: end - at - 2 !== value.length,
  })),
);

const pname: P<IriNode> = Parser.seq(Parser.location, TurtleGrammar.prefixedName).pipe(
  Parser.map(([at, { prefix, local }]): IriNode => ({ _tag: 'PName', prefix, local, at })),
);

/** `iri`: an IRI reference or a prefixed name. */
const iri: P<IriNode> = Parser.alt(iriRef, pname).pipe(Parser.expected('an IRI'));

const path: P<Path> = Parser.suspend(() => path_);
const pol: P<ReadonlyArray<Pol>> = Parser.suspend(() => pol_);
const statementList = (inFormula: boolean): P<ReadonlyArray<Statement>> =>
  Parser.suspend(() => (inFormula ? formulaStatements : documentStatements));

const TRUE = Term.literal('true', xsd.boolean);
const FALSE = Term.literal('false', xsd.boolean);

/**
 * Where a numeric literal can start: a digit, or `.`, `+` or `-` followed by
 * one. Checking up front (without consuming input) reports errors at a `.`
 * that ends a statement, rather than after it.
 */
const numberStart: P<void> = Parser.make<void>((state) => {
  // SAFETY: the N3 parser runs on string input, never bytes.
  const input = state.input as string;
  const isDigit = (k: number) => {
    const c = input.charCodeAt(k);
    return c >= 0x30 && c <= 0x39;
  };
  const c = input.charCodeAt(state.pos);
  const ok =
    isDigit(state.pos) ||
    (c === 0x2e && isDigit(state.pos + 1)) ||
    ((c === 0x2b || c === 0x2d) &&
      (isDigit(state.pos + 1) ||
        (input.charCodeAt(state.pos + 1) === 0x2e && isDigit(state.pos + 2))));
  return ok ? undefined : state.backtrack('Token', expectedNumber);
});

const expectedNumber = ['a number'];

const numeric: P<Item> = Parser.preceded(numberStart, TurtleGrammar.numericLiteral).pipe(
  Parser.map(([lexical, type]): Item => ({
    _tag: 'Literal',
    value: Term.literal(
      lexical,
      type === 'double' ? xsd.double : type === 'decimal' ? xsd.decimal : xsd.integer,
    ),
  })),
);

const rdfLiteral: P<Item> = Parser.seq(
  TurtleGrammar.stringLiteral,
  Parser.alt(
    Parser.preceded(Parser.peek(lit('@')), Parser.cut(TurtleGrammar.langTag)).pipe(
      Parser.map((language) => ({ language, datatype: undefined })),
    ),
    Parser.preceded(sym('^^'), Parser.cut(Parser.preceded(ws, iri))).pipe(
      Parser.map((datatype) => ({ language: undefined, datatype })),
    ),
    Parser.succeed({ language: undefined, datatype: undefined }),
  ),
).pipe(
  Parser.map(([value, { language, datatype }]): Item => ({
    _tag: 'String',
    value,
    language,
    datatype,
  })),
);

const quickVar: P<Item> = Parser.preceded(
  lit('?'),
  Parser.cut(
    Parser.taken(
      Parser.seq(Token.oneOf(TurtleGrammar.pnCharsU), Token.takeWhile(TurtleGrammar.pnChars)),
    ),
  ).pipe(Parser.expected('a variable name')),
).pipe(Parser.map((name): Item => ({ _tag: 'Var', name })));

const blank: P<Item> = Parser.preceded(
  Parser.peek(lit('_:')),
  Parser.cut(TurtleGrammar.blankNodeLabel.pipe(Parser.expected('a blank node label'))),
).pipe(Parser.map((label): Item => ({ _tag: 'Blank', label })));

/** `[ … ]`: an anonymous node, or `[ id <iri> … ]`. */
const bracket: P<Item> = Parser.preceded(
  lit('['),
  Parser.cut(
    Parser.alt(
      sym(']').pipe(Parser.as<Item>({ _tag: 'Anon', id: undefined, pol: [] })),
      Parser.seq(
        Parser.preceded(Parser.seq(ws, word('id')), Parser.cut(Parser.preceded(ws, iri))),
        Parser.cut(Parser.terminated(pol, closeBracket)),
      ).pipe(Parser.map(([id, pol]): Item => ({ _tag: 'Anon', id, pol }))),
      Parser.terminated(pol, closeBracket).pipe(
        Parser.map((pol): Item => ({ _tag: 'Anon', id: undefined, pol })),
      ),
    ),
  ),
);

/** `( … )`: a collection. */
const collection: P<Item> = Parser.delimited(
  lit('('),
  Parser.cut(Parser.repeat(Parser.preceded(Parser.not(sym(')')), path))),
  Parser.cut(sym(')').pipe(Parser.expected("')'"))),
).pipe(Parser.map((items): Item => ({ _tag: 'List', items })));

/** `{ … }`: a formula. */
const formula: P<Item> = Parser.delimited(
  lit('{'),
  Parser.cut(statementList(true)),
  Parser.cut(sym('}').pipe(Parser.expected("'}'"))),
).pipe(Parser.map((statements): Item => ({ _tag: 'Formula', statements })));

/** A prefixed name, or the bare words `true` and `false`. */
const nameItem: P<Item> = Parser.alt(
  pname,
  Parser.seq(Parser.location, bareWord).pipe(
    Parser.map(([at, w]): Item =>
      w === 'true'
        ? { _tag: 'Literal', value: TRUE }
        : w === 'false'
          ? { _tag: 'Literal', value: FALSE }
          : { _tag: 'Error', message: `Unexpected keyword or undeclared prefix '${w}'`, at },
    ),
  ),
);

/**
 * A grammar rule compiled to a function of its own. Formulas, collections and
 * `[ … ]` nest, so the compiled functions on that path recurse; keeping the
 * leaf terms out of them keeps their stack frames small, and the nesting
 * depth the parser supports large.
 */
const rule = <A>(p: P<A>): P<A> => Parser.suspend(() => p);

const leafItem: P<Item> = rule(
  Parser.alt(
    iriRef,
    rdfLiteral,
    quickVar,
    atKeyword('@true').pipe(Parser.as<Item>({ _tag: 'Literal', value: TRUE })),
    atKeyword('@false').pipe(Parser.as<Item>({ _tag: 'Literal', value: FALSE })),
    blank,
    numeric,
    nameItem,
  ),
);

const pathItem: P<Item> = Parser.preceded(
  ws,
  Parser.alt(bracket, collection, formula, leafItem).pipe(Parser.expected('a term')),
);

// SAFETY: the alternatives only match `!` or `^`.
const path_: P<Path> = Parser.seq(
  pathItem,
  Parser.repeat(
    Parser.seq(
      Parser.preceded(
        ws,
        Parser.alt(lit('!'), Parser.terminated(lit('^'), Parser.not(lit('^')))),
      ) as P<'!' | '^'>,
      Parser.cut(pathItem),
    ),
  ),
).pipe(
  Parser.map(([head, steps]): Path =>
    Arr.isReadonlyArrayEmpty(steps) ? head : { _tag: 'Path', head, steps },
  ),
);

const fixed = (predicate: Model.N3Term): Verb => ({ _tag: 'Fixed', predicate });

const fixedVerb: P<Verb> = rule(
  Parser.alt(
    lit('=>').pipe(Parser.as(fixed(log.implies))),
    lit('=').pipe(Parser.as(fixed(sameAs))),
    // `<=` unless the `<` starts an IRI reference.
    Parser.preceded(Parser.not(iriRef), lit('<=')).pipe(Parser.as(fixed(log.isImpliedBy))),
    Parser.alt(word('a'), atKeyword('@a')).pipe(Parser.as(fixed(rdf.type))),
  ),
);

const verb: P<Verb> = Parser.preceded(
  ws,
  Parser.alt(
    fixedVerb,
    Parser.preceded(Parser.seq(Parser.not(iriRef), lit('<-')), Parser.cut(path)).pipe(
      Parser.map((path): Verb => ({ _tag: 'Path', path, inverse: true })),
    ),
    Parser.preceded(Parser.alt(word('has'), atKeyword('@has')), Parser.cut(path)).pipe(
      Parser.map((path): Verb => ({ _tag: 'Path', path, inverse: false })),
    ),
    Parser.preceded(
      Parser.alt(word('is'), atKeyword('@is')),
      Parser.cut(
        Parser.terminated(
          path,
          Parser.preceded(ws, Parser.alt(word('of'), atKeyword('@of'))).pipe(
            Parser.expected("'of' after 'is ...'"),
          ),
        ),
      ),
    ).pipe(Parser.map((path): Verb => ({ _tag: 'Path', path, inverse: true }))),
    path.pipe(Parser.map((path): Verb => ({ _tag: 'Path', path, inverse: false }))),
  ),
);

const objectList: P<ReadonlyArray<Path>> = Parser.separated(path, sym(','), { min: 1 }).pipe(
  Parser.expected('an object'),
);

const semicolons = Parser.repeat(sym(';'), { min: 1 });

const pol_: P<ReadonlyArray<Pol>> = Parser.terminated(
  Parser.seq(
    Parser.seq(verb, Parser.cut(objectList)),
    Parser.repeat(
      Parser.preceded(
        semicolons,
        Parser.preceded(Parser.not(endOf('.]}')), Parser.cut(Parser.seq(verb, objectList))),
      ),
    ),
  ),
  Parser.opt(semicolons),
).pipe(
  Parser.map(([first, rest]): ReadonlyArray<Pol> =>
    Arr.isReadonlyArrayEmpty(rest) ? [first] : [first, ...rest],
  ),
);

const triples: P<Statement> = Parser.seq(
  path,
  Parser.alt(Parser.preceded(Parser.peek(endOf('.}')), Parser.succeed([])), pol),
).pipe(Parser.map(([subject, pol]): Statement => ({ _tag: 'Triples', subject, pol })));

/** The body of `@prefix` / `PREFIX`: `PN_PREFIX? ':' IRIREF`. */
const prefixBody: P<Statement> = Parser.seq(
  Parser.preceded(
    ws,
    Parser.terminated(
      Parser.opt(TurtleGrammar.pnPrefix),
      lit(':').pipe(Parser.expected('a prefix name ending in ":"')),
    ),
  ),
  Parser.preceded(ws, iriRef),
).pipe(
  Parser.map(([prefix, iri]): Statement => ({
    _tag: 'Prefix',
    prefix: prefix._tag === 'Some' ? prefix.value : '',
    iri,
  })),
);

const baseBody: P<Statement> = Parser.preceded(ws, iriRef).pipe(
  Parser.map((iri): Statement => ({ _tag: 'Base', iri })),
);

const quantifier = (universal: boolean): P<Statement> =>
  Parser.alt(
    Parser.preceded(Parser.peek(endOf('.}')), Parser.succeed<ReadonlyArray<IriNode>>([])),
    Parser.separated(Parser.preceded(ws, iri), sym(','), { min: 1 }),
  ).pipe(Parser.map((iris): Statement => ({ _tag: 'Quantifier', universal, iris })));

/** `PREFIX` / `BASE` (case-insensitive, no trailing `.`). */
const sparqlDirective: P<Statement> = rule(
  Parser.preceded(
    ws,
    Parser.alt(
      Parser.preceded(
        Parser.terminated(
          Ascii.caseless('PREFIX'),
          Parser.not(Token.oneOf([':.', TurtleGrammar.pnChars])),
        ),
        Parser.cut(prefixBody),
      ),
      Parser.preceded(
        Parser.terminated(
          Ascii.caseless('BASE'),
          Parser.not(Token.oneOf([':.', TurtleGrammar.pnChars])),
        ),
        Parser.cut(baseBody),
      ),
    ),
  ),
);

const atDirective: P<Statement> = rule(
  Parser.alt(
    Parser.preceded(atKeyword('@prefix'), Parser.cut(prefixBody)),
    Parser.preceded(atKeyword('@base'), Parser.cut(baseBody)),
    Parser.preceded(atKeyword('@forAll'), Parser.cut(quantifier(true))),
    Parser.preceded(atKeyword('@forSome'), Parser.cut(quantifier(false))),
    Parser.preceded(
      Parser.peek(atKeyword('@keywords')),
      Parser.cut(
        Parser.location.pipe(
          Parser.tryMap((at) => fail<Statement>('@keywords is not supported by Notation3', at)),
        ),
      ),
    ),
  ),
);

const statement: P<Statement> = Parser.preceded(ws, Parser.alt(atDirective, triples));

/** Statements, each ended by `.` (optional before the `}` of a formula). */
const statements = (inFormula: boolean): P<ReadonlyArray<Statement>> =>
  Parser.repeat(
    Parser.preceded(
      Parser.not(inFormula ? endOf('}') : Parser.preceded(ws, Parser.eof)),
      Parser.alt(
        sparqlDirective,
        Parser.cut(
          Parser.terminated(
            statement,
            (inFormula ? Parser.alt(sym('.'), Parser.peek(sym('}'))) : sym('.')).pipe(
              Parser.expected("'.'"),
            ),
          ),
        ),
      ),
    ),
  );

const formulaStatements = statements(true);
const documentStatements = statements(false);

const document = Compiler.jit(
  Parser.terminated(documentStatements, Parser.preceded(ws, Parser.eof)),
);

// -----------------------------------------------------------------------------
// Builder
// -----------------------------------------------------------------------------

const I18N_DATATYPE = /^([a-zA-Z]+(?:-[a-zA-Z0-9]+)*)_(ltr|rtl)$/;

class Builder {
  private readonly prefixes = new Map<string, string>();
  base: string | undefined;
  private readonly bnodePrefix: string;
  private readonly bnodes = new Map<string, Term.BlankNode>();
  private readonly reserved = new Set<string>();
  private anonCounter = 0;
  /** Statement collectors, one per open formula (innermost last). */
  private readonly out: Array<Array<Model.Statement>> = [];
  /** Explicit quantifier scopes (legacy `@forAll` / `@forSome`). */
  private readonly scopes: Array<Map<string, Model.N3Term>> = [];
  private readonly variableNames = new Set<string>();

  readonly input: string;
  constructor(input: string, options: ParserOptions | undefined) {
    this.input = input;
    this.base = options?.baseIri;
    this.bnodePrefix = options?.blankNodePrefix ?? '';
    // Labels written in the document; generated labels avoid them.
    for (const m of input.matchAll(/_:([^\s<>"{}()[\],;^!]+)/g)) {
      this.reserved.add(`${this.bnodePrefix}${m[1]!}`);
    }
  }

  document(statements: ReadonlyArray<Statement>): Model.Document {
    const formula = this.formula(statements);
    return {
      formula,
      prefixes: PrefixMap.make(this.prefixes),
      baseIri: this.base,
    };
  }

  private formula(statements: ReadonlyArray<Statement>): Model.Formula {
    this.out.push([]);
    this.scopes.push(new Map());
    for (const s of statements) this.statement(s);
    this.scopes.pop();
    return new Model.Formula(this.out.pop()!);
  }

  private statement(s: Statement): void {
    switch (s._tag) {
      case 'Prefix':
        this.prefixes.set(s.prefix, this.iri(s.iri));
        return;
      case 'Base':
        this.base = this.iri(s.iri);
        return;
      case 'Quantifier': {
        const scope = this.scopes[this.scopes.length - 1]!;
        for (const node of s.iris) {
          const iri = this.iri(node);
          scope.set(iri, s.universal ? this.variableFor(iri) : this.freshBlank());
        }
        return;
      }
      case 'Triples': {
        const subject = this.path(s.subject);
        this.pol(subject, s.pol);
        return;
      }
      case 'Error':
        return failAt(this.input, s.message, s.at);
    }
  }

  private pol(subject: Model.N3Term, pol: ReadonlyArray<Pol>): void {
    for (const [verb, objects] of pol) {
      const predicate = verb._tag === 'Fixed' ? verb.predicate : this.path(verb.path);
      const inverse = verb._tag === 'Path' && verb.inverse;
      for (const o of objects) {
        const object = this.path(o);
        if (inverse) this.emit(object, predicate, subject);
        else this.emit(subject, predicate, object);
      }
    }
  }

  private path(p: Path): Model.N3Term {
    if (p._tag !== 'Path') return this.item(p);
    let item = this.item(p.head);
    for (const [dir, step] of p.steps) {
      const predicate = this.item(step);
      const b = this.freshBlank();
      if (dir === '!') this.emit(item, predicate, b);
      else this.emit(b, predicate, item);
      item = b;
    }
    return item;
  }

  private item(item: Item): Model.N3Term {
    switch (item._tag) {
      case 'IriRef':
      case 'PName':
        return this.named(this.iri(item));
      case 'Blank':
        return this.labelledBlank(item.label);
      case 'Anon': {
        if (item.id !== undefined) {
          const node = this.named(this.iri(item.id));
          this.pol(node, item.pol);
          return node;
        }
        const b = this.freshBlank();
        this.pol(b, item.pol);
        return b;
      }
      case 'List':
        return new Model.Collection(item.items.map((p) => this.path(p)));
      case 'Formula': {
        const f = this.formula(item.statements);
        // An empty graph term is the literal `true` (N3 test suite: graph/empty_graph).
        return f.size === 0 ? TRUE : f;
      }
      case 'Error':
        return failAt(this.input, item.message, item.at);
      case 'Var':
        this.variableNames.add(item.name);
        return new Term.Variable(item.name);
      case 'Literal':
        return item.value;
      case 'String': {
        if (item.language !== undefined) return Term.literal(item.value, item.language);
        if (item.datatype === undefined) return Term.literal(item.value);
        const datatype = this.iri(item.datatype);
        const dir = datatype.startsWith(i18n.base)
          ? I18N_DATATYPE.exec(datatype.slice(i18n.base.length))
          : null;
        if (dir !== null) {
          // SAFETY: the base-direction regex only captures `ltr` or `rtl`.
          return Term.literal(item.value, {
            language: dir[1]!,
            direction: dir[2] as Term.Direction,
          });
        }
        return Term.literal(item.value, new Term.NamedNode(datatype));
      }
    }
  }

  private iri(node: IriNode): string {
    if (node._tag === 'IriRef') {
      if (node.escaped && forbiddenInIri.test(node.value)) {
        return failAt(this.input, 'Invalid escaped character in IRI', node.at);
      }
      return this.resolveIri(node.value);
    }
    const ns = this.prefixes.get(node.prefix);
    if (ns !== undefined) return ns + node.local;
    // The empty prefix defaults to `<#>` (the current document), as in cwm.
    if (node.prefix === '') return this.resolveIri('#') + node.local;
    return failAt(this.input, `Undeclared prefix '${node.prefix}:'`, node.at);
  }

  private resolveIri(value: string): string {
    return this.base === undefined ? value : Iri.resolve(value, this.base);
  }

  /** Applies explicit-quantifier substitutions to an IRI. */
  private named(iri: string): Model.N3Term {
    for (let k = this.scopes.length - 1; k >= 0; k--) {
      const t = this.scopes[k]!.get(iri);
      if (t !== undefined) return t;
    }
    return new Term.NamedNode(iri);
  }

  private emit(subject: Model.N3Term, predicate: Model.N3Term, object: Model.N3Term): void {
    this.out[this.out.length - 1]!.push(new Model.Statement(subject, predicate, object));
  }

  private freshBlank(): Term.BlankNode {
    for (;;) {
      const label = `${this.bnodePrefix}b${(this.anonCounter++).toString(36)}`;
      if (!this.reserved.has(label)) return new Term.BlankNode(label);
    }
  }

  private labelledBlank(label: string): Term.BlankNode {
    let b = this.bnodes.get(label);
    if (b === undefined) {
      b = new Term.BlankNode(`${this.bnodePrefix}${label}`);
      this.bnodes.set(label, b);
    }
    return b;
  }

  private variableFor(iri: string): Term.Variable {
    const local = /[^#/:]*$/.exec(iri)?.[0] ?? '';
    let name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(local) ? local : 'v';
    if (this.variableNames.has(name)) {
      let n = 1;
      while (this.variableNames.has(`${name}_${n}`)) n++;
      name = `${name}_${n}`;
    }
    this.variableNames.add(name);
    return new Term.Variable(name);
  }
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

const failAt = (input: string, message: string, at: number): never => {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(at, input.length);
  for (let k = 0; k < end; k++) {
    if (input.charCodeAt(k) === 0x0a) {
      line++;
      lineStart = k + 1;
    }
  }
  throw new SyntaxFailure(message, line, end - lineStart + 1);
};

const describe = (input: string, at: number): string =>
  at >= input.length ? 'end of input' : `'${String.fromCodePoint(input.codePointAt(at)!)}'`;

/** @internal */
export const parse = (input: string, options?: ParserOptions): Model.Document => {
  const result = Parser.parse(document, input);
  if (Result.isFailure(result)) {
    const error = result.failure;
    if (error.cause !== undefined) return failAt(input, error.cause.message, error.cause.at);
    const found = describe(input, error.offset);
    const expected = error.expected.filter((e) => e !== WHITESPACE);
    const message =
      Arr.isReadonlyArrayEmpty(expected) || expected.length > 3
        ? `Unexpected ${found}`
        : `Expected ${expected.join(' or ')} but found ${found}`;
    return failAt(input, message, error.offset);
  }
  return new Builder(input, options).document(result.success);
};
