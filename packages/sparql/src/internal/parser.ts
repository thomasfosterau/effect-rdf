/**
 * The SPARQL 1.1 / 1.2 query and update grammar, written with
 * `@thomasfosterau/effect-parse` as a compiled LL(1) grammar over the tokens
 * of `lexer.ts` (whose names are already resolved). It builds the AST
 * directly, expanding every abbreviation and enforcing the static rules of
 * the specification.
 *
 * Three things depend on the order in which the input is read: the labels of
 * generated blank nodes, the scopes of blank node labels, and where
 * aggregates are allowed. They live in a per-parse context, which small
 * hooks (`Parser.make`) update at the points where the reference parser does,
 * and which is reset at the start of every run of the grammar.
 *
 * @internal
 */
import * as Compiler from '@thomasfosterau/effect-parse/Compiler';
import * as ParseError from '@thomasfosterau/effect-parse/ParseError';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Token from '@thomasfosterau/effect-parse/Token';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Arr from 'effect/Array';
import * as Match from 'effect/Match';
import * as Result from 'effect/Result';
import * as Ast from '../Ast.ts';
import { resolve, type Tok, tokenize } from './lexer.ts';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const rdfType = Term.namedNode(`${RDF}type`);
const rdfFirst = Term.namedNode(`${RDF}first`);
const rdfRest = Term.namedNode(`${RDF}rest`);
const rdfNil = Term.namedNode(`${RDF}nil`);
const rdfReifies = Term.namedNode(`${RDF}reifies`);
const xsdInteger = Term.namedNode(`${XSD}integer`);
const xsdDecimal = Term.namedNode(`${XSD}decimal`);
const xsdDouble = Term.namedNode(`${XSD}double`);
const xsdBoolean = Term.namedNode(`${XSD}boolean`);

/** A syntax or static error, at a character offset. */
export class Failure {
  readonly message: string;
  readonly offset: number;
  constructor(message: string, offset: number) {
    this.message = message;
    this.offset = offset;
  }
}

const fail = (message: string, offset: number): never => {
  throw new Failure(message, offset);
};

type P<A> = Parser.Parser<A, Failure, never, ReadonlyArray<Tok>>;
type Triples = Array<Ast.TriplePattern | Ast.PathPattern>;

// -----------------------------------------------------------------------------
// Per-parse context
// -----------------------------------------------------------------------------

interface TripleContext {
  /** Whether variables are allowed (false for INSERT/DELETE DATA). */
  readonly variables: boolean;
  /** Whether blank nodes are allowed (false for DELETE templates / data). */
  readonly blankNodes: boolean;
  /** Scope identifier for blank node label checks. */
  readonly scope: number;
  /** Label map to check against. */
  readonly labels: Map<string, number>;
}

class Context {
  readonly input: string;
  readonly usedLabels: Set<string>;
  bnodeCounter = 0;
  scopeCounter = 0;
  opIndex = 0;
  readonly patternLabels = new Map<string, number>();
  readonly templateLabels = new Map<string, number>();
  aggregatesAllowed = false;
  inAggregate = false;
  /** The aggregate flags saved by `withFlags`, in pairs. */
  readonly flags: Array<boolean> = [];
  /** The triple contexts in force, innermost last. */
  readonly triples: Array<TripleContext> = [];
  /** The last `VERSION` declared. */
  version: string | undefined;
  /** Whether the verbs being read are simple predicates, innermost last. */
  readonly verbs: Array<boolean> = [];
  /** The first token of the subject being read. */
  subjectStart: Tok | undefined;

  constructor(input: string) {
    this.input = input;
    this.usedLabels = new Set(Array.from(input.matchAll(/_:([^\s.;,(){}[\]]+)/g), (m) => m[1]!));
  }

  get tc(): TripleContext {
    return this.triples[this.triples.length - 1]!;
  }

  patternContext(): TripleContext {
    return {
      variables: true,
      blankNodes: true,
      scope: ++this.scopeCounter,
      labels: this.patternLabels,
    };
  }

  freshBlankNode(): Term.BlankNode {
    let label: string;
    do label = `g${this.bnodeCounter++}`;
    while (this.usedLabels.has(label));
    return Term.blankNode(label);
  }
}

let ctx: Context = new Context('');
let fresh: () => Context = () => new Context('');

/** Starts a run of the grammar with a new context (the compiled run and any re-run). */
const start: P<void> = Parser.make<void, Failure, never, ReadonlyArray<Tok>>(() => {
  ctx = fresh();
  return undefined;
});

const offsetOf = (t: Tok | undefined): number => t?.start ?? ctx.input.length;

/**
 * Runs `f`, returning a thrown `Failure` (a syntax error found while
 * building) as the failure; any other exception is a defect and propagates.
 */
const catchFailure = <A>(f: () => A): Result.Result<A, Failure> =>
  Result.try({
    try: f,
    catch: (cause) => {
      if (cause instanceof Failure) return cause;
      throw cause;
    },
  });

/**
 * A hook: runs `f` on the current token (without consuming it). A `Failure`
 * thrown by `f` is an unrecoverable error.
 */
const hook = <A>(f: (t: Tok | undefined) => A): P<A> =>
  Parser.make<A, Failure, never, ReadonlyArray<Tok>>((state) => {
    try {
      return f(state.input[state.pos]);
    } catch (e) {
      if (e instanceof Failure) return state.failCause('Cut', 'Verify', e);
      throw e;
    }
  });

/**
 * A token parser written as a hook: `f` returns the value for the current
 * token (consumed), or `undefined` to fail without consuming it.
 */
const take = <A>(label: string, f: (t: Tok, next: Tok | undefined) => A | undefined): P<A> => {
  const expected = [label];
  return Parser.make<A, Failure, never, ReadonlyArray<Tok>>((state) => {
    const t = state.input[state.pos];
    if (t === undefined || t.type === 'ERROR') return state.backtrack('Token', expected);
    try {
      const a = f(t, state.input[state.pos + 1]);
      if (a === undefined) return state.backtrack('Token', expected);
      state.pos++;
      return a;
    } catch (e) {
      if (e instanceof Failure) return state.failCause('Cut', 'Verify', e);
      throw e;
    }
  });
};

/** Runs `p` with the aggregate flags set, restoring them afterwards. */
const withFlags = <A>(
  aggregatesAllowed: boolean,
  inAggregate: boolean | undefined,
  p: P<A>,
): P<A> =>
  Parser.delimited(
    hook(() => {
      ctx.flags.push(ctx.aggregatesAllowed, ctx.inAggregate);
      ctx.aggregatesAllowed = aggregatesAllowed;
      if (inAggregate !== undefined) ctx.inAggregate = inAggregate;
    }),
    p,
    hook(() => {
      ctx.inAggregate = ctx.flags.pop()!;
      ctx.aggregatesAllowed = ctx.flags.pop()!;
    }),
  );

/** Runs `p` in a triple context, restoring the enclosing one afterwards. */
const inContext = <A>(make: () => TripleContext, p: P<A>): P<A> =>
  Parser.delimited(
    hook(() => {
      ctx.triples.push(make());
    }),
    p,
    hook(() => {
      ctx.triples.pop();
    }),
  );

// -----------------------------------------------------------------------------
// Token parsers
// -----------------------------------------------------------------------------

const describe = (t: Tok | undefined): string =>
  t === undefined
    ? 'end of input'
    : t.type === 'STRING'
      ? 'string literal'
      : `'${ctx.input.slice(t.start, t.end)}'`;

const unexpected = (t: Tok | undefined, expected?: string): never =>
  fail(
    `Unexpected ${describe(t)}${expected !== undefined ? `, expected ${expected}` : ''}`,
    offsetOf(t),
  );

/** The reference parser's "Unexpected …" error at `t` (or the lexer's, at an error token). */
const unexpectedAt = (t: Tok | undefined, expected?: string): never =>
  t?.type === 'ERROR' ? fail(t.value, t.start) : unexpected(t, expected);

/** Fails with the reference parser's "Unexpected …" message at the current token. */
const unexpectedHere = <A = never>(expected?: string): P<A> =>
  hook((t): A => unexpectedAt(t, expected));

/**
 * A token of the given kind (see `Tok.kind`). A token set rather than a
 * `Parser.make` hook, so the compiler inlines the match instead of calling
 * back into an interpreted step.
 */
const tok = (kind: string): P<Tok> =>
  Token.oneOf<ReadonlyArray<Tok>>((t) => t.kind === kind).pipe(Parser.expected(`'${kind}'`));

/** `kind`, or the "Unexpected …, expected …" error. */
const expect = (
  kind: string,
  label = kind === kind.toUpperCase() && /^[A-Z]/.test(kind) ? kind : `'${kind}'`,
): P<Tok> => Parser.alt(tok(kind), unexpectedHere<Tok>(label));

/** Whether the next token is of kind `kind` (consumed if so). */
const eat = (kind: string): P<boolean> =>
  Parser.opt(tok(kind)).pipe(Parser.map((o) => o._tag === 'Some'));

/**
 * Whether the next token's kind is one of `kinds` (not consumed). A peeked
 * token set, like `tok`, so the compiler inlines it.
 */
const peekKind = (kinds: ReadonlySet<string>): P<void> =>
  Parser.peek(Token.oneOf<ReadonlyArray<Tok>>((t) => kinds.has(t.kind))).pipe(
    Parser.asVoid,
    Parser.expected(Array.from(kinds, (k) => `'${k}'`).join(' or ')),
  );

/** Any token but a lexer error token (consumed). A token set, like `tok`. */
const anyToken: P<Tok> = Token.oneOf<ReadonlyArray<Tok>>((t) => t.type !== 'ERROR').pipe(
  Parser.expected('a token'),
);

/**
 * Chooses a parser by the kind of the next token; when no case matches,
 * `otherwise` (or a failure that consumes nothing).
 */
const select = <A, B = A>(
  cases: ReadonlyArray<readonly [ReadonlyArray<string>, P<A>]>,
  otherwise?: P<B>,
): P<A | B> => {
  // Guarded alternatives rather than `Parser.dispatch`, whose cases the JIT
  // leaves to the (slower) closure backend.
  const seen = new Set<string>();
  const branches: Array<P<A | B>> = [];
  for (const [kinds, p] of cases) {
    const own = new Set(kinds.filter((k) => !seen.has(k)));
    for (const k of own) seen.add(k);
    if (own.size > 0) branches.push(Parser.preceded(peekKind(own), p));
  }
  if (otherwise !== undefined) branches.push(otherwise);
  return Parser.alt(...branches);
};

/** Whether the next tokens are `a` then `b` (not consumed). */
const peek2 = (a: string, b: string): P<unknown> => Parser.peek(Parser.seq(tok(a), tok(b)));

const nil: P<unknown> = peek2('(', ')');
const anon: P<unknown> = peek2('[', ']');

const iri: P<Term.NamedNode> = take('an IRI', (t) => {
  if (t.type === 'IRI') return Term.namedNode(t.value);
  if (t.type === 'PNAME')
    return t.error !== undefined ? fail(t.error, t.start) : Term.namedNode(t.value);
  return undefined;
});

const iriOrError: P<Term.NamedNode> = Parser.alt(iri, unexpectedHere<Term.NamedNode>('an IRI'));

const variable: P<Term.Variable> = take('a variable', (t) =>
  t.type === 'VAR' ? Term.variable(t.value) : undefined,
);

const variableOrError: P<Term.Variable> = Parser.alt(
  variable,
  unexpectedHere<Term.Variable>('a variable'),
);

/** A variable in a pattern (checked against the triple context). */
const patternVariable: P<Term.Variable> = take('a variable', (t) => {
  if (t.type !== 'VAR') return undefined;
  if (!ctx.tc.variables) fail('Variables are not allowed here', t.start);
  return Term.variable(t.value);
});

const isIri = (t: Tok): boolean => t.type === 'IRI' || t.type === 'PNAME';
const isNumber = (t: Tok | undefined): boolean =>
  t !== undefined && (t.type === 'INTEGER' || t.type === 'DECIMAL' || t.type === 'DOUBLE');

const blankNodeLabel: P<Term.BlankNode> = take('a blank node', (t) => {
  if (t.type !== 'BNODE') return undefined;
  const tc = ctx.tc;
  if (!tc.blankNodes) fail('Blank nodes are not allowed here', t.start);
  const existing = tc.labels.get(t.value);
  if (existing !== undefined && existing !== tc.scope) {
    fail(`Blank node label _:${t.value} is used in more than one scope`, t.start);
  }
  tc.labels.set(t.value, tc.scope);
  return Term.blankNode(t.value);
});

/** A generated blank node in a pattern (checked against the triple context). */
const freshPatternBlankNode: P<Term.BlankNode> = hook((t) => {
  if (!ctx.tc.blankNodes) fail('Blank nodes are not allowed here', offsetOf(t));
  return ctx.freshBlankNode();
});

const string: P<Tok> = take('a string', (t) => (t.type === 'STRING' ? t : undefined));

const rdfLiteral: P<Term.Literal> = Parser.seq(
  string,
  Parser.alt(
    take('a language tag', (t, next) => {
      if (t.type !== 'LANGTAG') return undefined;
      const tag = t.value;
      const i = tag.indexOf('--');
      if (i === -1) return { tag, direction: undefined };
      const direction = tag.slice(i + 2).toLowerCase();
      if (direction !== 'ltr' && direction !== 'rtl') {
        fail(`Invalid base direction '${direction}'`, offsetOf(next));
      }
      // SAFETY: `direction` was checked to be `ltr` or `rtl` just above (the failing branch never
      // returns).
      return { tag: tag.slice(0, i), direction: direction as Term.Direction };
    }),
    Parser.preceded(tok('^^'), iriOrError),
    Parser.succeed(undefined),
  ),
).pipe(
  Parser.map(([s, suffix]): Term.Literal => {
    if (suffix === undefined) return Term.literal(s.value);
    if (suffix instanceof Term.NamedNode) return Term.literal(s.value, suffix);
    return suffix.direction !== undefined
      ? Term.literal(s.value, { language: suffix.tag, direction: suffix.direction })
      : Term.literal(s.value, suffix.tag);
  }),
);

const numberLiteral = (t: Tok, sign: string): Term.Literal =>
  Term.literal(
    sign + t.value,
    t.type === 'INTEGER' ? xsdInteger : t.type === 'DECIMAL' ? xsdDecimal : xsdDouble,
  );

const numericLiteral: P<Term.Literal> = take('a number', (t) =>
  isNumber(t) ? numberLiteral(t, '') : undefined,
);

/** `+` or `-` immediately followed by a number. */
const signedNumber: P<Term.Literal> = Parser.make<Term.Literal, Failure, never, ReadonlyArray<Tok>>(
  (state) => {
    const t = state.input[state.pos];
    const n = state.input[state.pos + 1];
    if (
      t !== undefined &&
      (t.kind === '+' || t.kind === '-') &&
      n !== undefined &&
      n.start === t.end &&
      isNumber(n)
    ) {
      state.pos += 2;
      return numberLiteral(n, t.value);
    }
    return state.backtrack('Token', ['a number']);
  },
);

const booleanLiteral: P<Term.Literal> = take('a boolean', (t) =>
  t.kind === 'TRUE' || t.kind === 'FALSE'
    ? Term.literal(t.value.toLowerCase(), xsdBoolean)
    : undefined,
);

/** `a`, or an IRI. */
const aOrIri: P<Term.NamedNode> = Parser.alt(tok('a').pipe(Parser.as(rdfType)), iriOrError);

// -----------------------------------------------------------------------------
// Data terms
// -----------------------------------------------------------------------------

/** iri | RDFLiteral | NumericLiteral | BooleanLiteral */
const dataTerm: P<Term.NamedNode | Term.Literal> = Parser.alt(
  iri,
  rdfLiteral,
  numericLiteral,
  signedNumber,
  booleanLiteral,
  unexpectedHere<Term.Literal>('an RDF term'),
);

// SAFETY: the object comes from `tripleTermData` or `dataTerm`, all object-position terms.
const tripleTermData: P<Term.Triple> = Parser.preceded(
  tok('<<('),
  Parser.seq(
    iriOrError,
    aOrIri,
    Parser.alt(
      Parser.suspend(() => tripleTermData),
      dataTerm,
    ),
    expect(')>>'),
  ),
).pipe(Parser.map(([s, p, o]) => Term.triple(s, p, o as Term.Object)));

const dataBlockValue: P<Term.GroundTerm | undefined> = Parser.alt(
  tok('UNDEF').pipe(Parser.as(undefined)),
  tripleTermData,
  dataTerm,
);

const dataBlock: P<Ast.ValuesPattern> = Parser.alt(
  Parser.seq(
    variable,
    Parser.preceded(
      expect('{'),
      Parser.terminated(
        Parser.repeat(Parser.preceded(Parser.not(tok('}')), dataBlockValue)),
        tok('}'),
      ),
    ),
  ).pipe(
    Parser.map(([v, values]) =>
      Ast.values(
        [v],
        values.map((x) => [x]),
      ),
    ),
  ),
  Parser.seq(
    Parser.preceded(
      expect('('),
      Parser.repeat(
        Parser.seq(
          variable,
          hook((t) => t),
        ),
      ).pipe(
        Parser.tryMap((vars) => {
          const out: Array<Term.Variable> = [];
          for (const [v, next] of vars) {
            if (out.some((x) => x.value === v.value)) {
              return Result.fail(
                new Failure(`Duplicate variable ?${v.value} in VALUES`, offsetOf(next)),
              );
            }
            out.push(v);
          }
          return Result.succeed(out);
        }),
        Parser.cut,
      ),
    ),
    Parser.preceded(
      Parser.seq(expect(')'), expect('{')),
      Parser.terminated(
        Parser.repeat(
          Parser.preceded(
            Parser.not(tok('}')),
            Parser.seq(
              hook((t) => offsetOf(t)),
              Parser.preceded(
                expect('('),
                Parser.terminated(
                  Parser.repeat(Parser.preceded(Parser.not(tok(')')), dataBlockValue)),
                  anyToken,
                ),
              ),
            ),
          ),
        ),
        expect('}'),
      ),
    ),
  ).pipe(
    Parser.tryMap(([variables, rows]) => {
      for (const [at, row] of rows) {
        if (row.length !== variables.length) {
          return Result.fail(
            new Failure(
              `VALUES row has ${row.length} values but ${variables.length} variables`,
              at,
            ),
          );
        }
      }
      return Result.succeed(
        Ast.values(
          variables,
          rows.map(([, row]) => row),
        ),
      );
    }),
    Parser.cut,
  ),
);

// -----------------------------------------------------------------------------
// Triples
// -----------------------------------------------------------------------------

interface Node {
  readonly term: Ast.TermPattern;
  /** The triples the node expands to, in the order the reference parser emits them. */
  readonly triples: Triples;
}

const node = (term: Ast.TermPattern, triples: Triples = []): Node => ({ term, triples });

interface Verb {
  readonly predicate: Ast.VarOrIri | Ast.Path;
  readonly simple: boolean;
}

/** `~ r` (and its `{| … |}`), or a `{| … |}` with a generated reifier. */
interface Annotation {
  readonly reifier: Ast.TermPattern;
  readonly block: PropertyList | undefined;
}

interface Obj {
  readonly node: Node;
  readonly annotation: ReadonlyArray<Annotation>;
}

/** A property list as read; `build` expands it once its subject is known. */
type PropertyList = ReadonlyArray<readonly [Verb, ReadonlyArray<Obj>]>;

/** The triples of a property list, in the order the reference parser emits them. */
const build = (subject: Ast.TermPattern, pl: PropertyList, out: Triples = []): Triples => {
  for (const [v, objects] of pl) {
    for (const { node: o, annotation } of objects) {
      for (const t of o.triples) out.push(t);
      if (Ast.isPath(v.predicate)) {
        out.push(Ast.pathPattern(subject, v.predicate, o.term));
        continue;
      }
      out.push(Ast.triplePattern(subject, v.predicate, o.term));
      if (Arr.isReadonlyArrayEmpty(annotation)) continue;
      const triple = Term.triple<any, any, any>(subject, v.predicate, o.term);
      for (const a of annotation) {
        out.push(Ast.triplePattern(a.reifier, rdfReifies, triple));
        if (a.block !== undefined) build(a.reifier, a.block, out);
      }
    }
  }
  return out;
};

/** Whether a token can start a triples block (`undefined`: it cannot). */
const startsTriplesToken = Match.fn((t: Tok, _next?: Tok) => t.type).pipe(
  Match.when(
    Match.is('VAR', 'IRI', 'PNAME', 'BNODE', 'STRING', 'INTEGER', 'DECIMAL', 'DOUBLE'),
    () => true as const,
  ),
  Match.when('WORD', (_type, t) => (t.kind === 'TRUE' || t.kind === 'FALSE' ? true : undefined)),
  Match.when('PUNCT', (_type, t, next) =>
    t.value === '(' ||
    t.value === '[' ||
    t.value === '<<' ||
    t.value === '<<(' ||
    ((t.value === '+' || t.value === '-') && isNumber(next))
      ? true
      : undefined,
  ),
  Match.orElse(() => undefined),
);

const startsTriples: P<unknown> = Parser.peek(
  take('triples', (t, next) => {
    return startsTriplesToken(t, next);
  }),
);

/** The triples productions, with or without property paths. */
interface TriplesGrammar {
  readonly triplesSameSubject: P<Triples>;
  readonly triplesBlock: P<readonly [Triples, boolean]>;
  readonly triplesTemplate: P<Triples>;
}

const path: P<Ast.Path> = Parser.suspend(() => path_);

const triplesGrammar = (paths: boolean): TriplesGrammar => {
  const graphNode: P<Node> = Parser.suspend(() => graphNode_);
  const propertyList: P<PropertyList> = Parser.suspend(() => propertyList_);

  const varOrTerm = (allowNil: boolean): P<Ast.TermPattern> =>
    Parser.alt(
      patternVariable,
      iri,
      blankNodeLabel,
      rdfLiteral,
      numericLiteral,
      booleanLiteral,
      signedNumber,
      ...(allowNil
        ? [Parser.preceded(Parser.seq(nil, anyToken, anyToken), Parser.succeed(rdfNil))]
        : []),
      Parser.preceded(Parser.seq(anon, anyToken, anyToken), freshPatternBlankNode),
      Parser.suspend(() => tripleTerm),
      unexpectedHere<Ast.TermPattern>('an RDF term or variable'),
    );

  const patternPredicate: P<Ast.VarOrIri> = Parser.alt(patternVariable, aOrIri);

  const tripleTermComponent: P<Ast.TermPattern> = Parser.alt(
    Parser.suspend(() => tripleTerm),
    Parser.preceded(
      Parser.peek(Parser.alt(tok('('), tok('<<'), Parser.preceded(Parser.not(anon), tok('[')))),
      unexpectedHere<Ast.TermPattern>(),
    ),
    varOrTerm(false),
  );

  const tripleTerm: P<Ast.TermPattern> = Parser.preceded(
    tok('<<('),
    Parser.seq(tripleTermComponent, patternPredicate, tripleTermComponent, expect(')>>')),
  ).pipe(Parser.map(([s, p, o]) => Term.triple<any, any, any>(s, p, o)));

  const reifier: P<Ast.TermPattern> = Parser.preceded(
    tok('~'),
    Parser.alt(
      patternVariable,
      iri,
      blankNodeLabel,
      Parser.preceded(Parser.seq(anon, anyToken, anyToken), freshPatternBlankNode),
      freshPatternBlankNode,
    ),
  );

  const reifiedTriple: P<Node> = Parser.suspend(() => reifiedTriple_);

  const reifiedTripleComponent: P<Node> = Parser.alt(
    reifiedTriple,
    Parser.suspend(() => tripleTerm).pipe(Parser.map((t) => node(t))),
    Parser.preceded(
      Parser.peek(Parser.alt(tok('('), Parser.preceded(Parser.not(anon), tok('[')))),
      unexpectedHere<Node>(),
    ),
    varOrTerm(false).pipe(Parser.map((t) => node(t))),
  );

  const reifiedTriple_: P<Node> = Parser.preceded(
    tok('<<'),
    Parser.seq(
      reifiedTripleComponent,
      patternPredicate,
      reifiedTripleComponent,
      Parser.alt(reifier, freshPatternBlankNode),
      expect('>>'),
    ),
  ).pipe(
    Parser.map(([s, p, o, r]) =>
      node(r, [
        ...s.triples,
        ...o.triples,
        Ast.triplePattern(r, rdfReifies, Term.triple<any, any, any>(s.term, p, o.term)),
      ]),
    ),
  );

  const triplesNode: P<Node> = Parser.alt(
    Parser.preceded(
      tok('['),
      Parser.seq(freshPatternBlankNode, Parser.terminated(propertyList, expect(']'))),
    ).pipe(Parser.map(([b, pl]) => node(b, build(b, pl)))),
    Parser.preceded(
      tok('('),
      Parser.seq(
        Parser.terminated(
          Parser.repeat(Parser.preceded(Parser.not(tok(')')), graphNode)),
          anyToken,
        ),
        hook((t) => t),
      ),
    ).pipe(
      Parser.map(([items, t]) => {
        if (Arr.isReadonlyArrayEmpty(items)) return node(rdfNil);
        if (!ctx.tc.blankNodes) fail('Blank nodes are not allowed here', offsetOf(t));
        const nodes = items.map(() => ctx.freshBlankNode());
        const triples: Triples = [];
        for (const item of items) for (const x of item.triples) triples.push(x);
        items.forEach((item, i) => {
          triples.push(Ast.triplePattern(nodes[i]!, rdfFirst, item.term));
          triples.push(Ast.triplePattern(nodes[i]!, rdfRest, nodes[i + 1] ?? rdfNil));
        });
        return node(nodes[0]!, triples);
      }),
    ),
  );

  /** GraphNode / GraphNodePath */
  const graphNode_: P<Node> = Parser.alt(
    reifiedTriple,
    Parser.preceded(
      Parser.alt(
        Parser.seq(Parser.not(nil), Parser.peek(tok('('))),
        Parser.seq(Parser.not(anon), Parser.peek(tok('['))),
      ),
      triplesNode,
    ),
    varOrTerm(true).pipe(Parser.map((t) => node(t))),
  );

  const startsVerb: P<unknown> = Parser.peek(
    take('a verb', (t) =>
      t.type === 'VAR' ||
      isIri(t) ||
      t.kind === 'a' ||
      (paths && (t.kind === '^' || t.kind === '!' || t.kind === '('))
        ? true
        : undefined,
    ),
  );

  /** A verb; whether it is simple is pushed on `ctx.verbs` until its objects are read. */
  const verb: P<Verb> = Parser.alt(
    Parser.seq(
      patternVariable,
      paths
        ? Parser.preceded(Parser.peek(Parser.alt(tok('/'), tok('|'))), unexpectedHere<void>()).pipe(
            Parser.opt,
          )
        : Parser.succeed(undefined),
    ).pipe(Parser.map(([v]): Verb => ({ predicate: v, simple: true }))),
    paths
      ? path.pipe(
          Parser.map((p): Verb =>
            p._tag === 'PathLink'
              ? { predicate: p.iri, simple: true }
              : { predicate: p, simple: false },
          ),
        )
      : aOrIri.pipe(Parser.map((predicate): Verb => ({ predicate, simple: true }))),
  ).pipe(
    Parser.map((v) => {
      ctx.verbs.push(v.simple);
      return v;
    }),
  );

  const annotationBlock: P<PropertyList> = Parser.terminated(propertyList, expect('|}'));

  // `~ r` names a reifier and `{| … |}` annotates it (a fresh one if none was named).
  const annotationItem: P<Annotation> = Parser.alt(
    Parser.seq(reifier, Parser.opt(Parser.preceded(tok('{|'), annotationBlock))).pipe(
      Parser.map(([reifier, block]): Annotation => ({
        reifier,
        block: block._tag === 'Some' ? block.value : undefined,
      })),
    ),
    Parser.preceded(tok('{|'), Parser.seq(freshPatternBlankNode, annotationBlock)).pipe(
      Parser.map(([reifier, block]): Annotation => ({ reifier, block })),
    ),
  );

  const annotation: P<ReadonlyArray<Annotation>> = Parser.alt(
    Parser.preceded(
      Parser.seq(
        Parser.peek(Parser.alt(tok('~'), tok('{|'))),
        hook((t) => {
          if (!ctx.verbs[ctx.verbs.length - 1]) {
            fail('Reifiers and annotations require a simple predicate', offsetOf(t));
          }
        }),
      ),
      Parser.repeat(annotationItem, { min: 1 }),
    ),
    Parser.succeed([]),
  );

  const objectList: P<ReadonlyArray<Obj>> = Parser.separated(
    Parser.seq(graphNode, annotation).pipe(
      Parser.map(([node, annotation]): Obj => ({ node, annotation })),
    ),
    tok(','),
    { min: 1 },
  );

  const verbObjects: P<readonly [Verb, ReadonlyArray<Obj>]> = Parser.seq(
    verb,
    Parser.terminated(
      objectList,
      hook(() => {
        ctx.verbs.pop();
      }),
    ),
  );

  const propertyList_: P<PropertyList> = Parser.seq(
    verbObjects,
    Parser.repeat(
      Parser.preceded(
        Parser.repeat(tok(';'), { min: 1 }),
        Parser.preceded(startsVerb, verbObjects),
      ),
    ),
    Parser.opt(Parser.repeat(tok(';'), { min: 1 })),
  ).pipe(Parser.map(([first, rest]) => [first, ...rest]));

  const withProperties = (subject: P<Node>): P<Triples> =>
    Parser.seq(subject, Parser.opt(Parser.preceded(startsVerb, propertyList))).pipe(
      Parser.map(([s, pl]) =>
        pl._tag === 'Some' ? build(s.term, pl.value, [...s.triples]) : s.triples,
      ),
    );

  const triplesSameSubject: P<Triples> = Parser.alt(
    withProperties(reifiedTriple),
    Parser.preceded(
      Parser.alt(
        Parser.seq(Parser.not(nil), Parser.peek(tok('('))),
        Parser.seq(Parser.not(anon), Parser.peek(tok('['))),
      ),
      withProperties(triplesNode),
    ),
    Parser.seq(
      hook((t) => {
        ctx.subjectStart = t;
      }),
      varOrTerm(true),
      Parser.alt(
        Parser.preceded(startsVerb, propertyList),
        hook((t): PropertyList =>
          unexpectedAt(t, `a predicate after ${describe(ctx.subjectStart)}`),
        ),
      ),
    ).pipe(Parser.map(([, subject, pl]) => build(subject, pl))),
  );

  /** TriplesBlock: the triples, and whether it ended with a '.' */
  const triplesBlock: P<readonly [Triples, boolean]> = Parser.seq(
    triplesSameSubject,
    Parser.repeat(Parser.preceded(Parser.seq(tok('.'), startsTriples), triplesSameSubject)),
    eat('.'),
  ).pipe(Parser.map(([first, rest, dot]) => [[...first, ...rest.flat()], dot] as const));

  /** TriplesTemplate / ConstructTriples (no paths); stops before `}`. */
  const triplesTemplate: P<Triples> = Parser.opt(
    Parser.preceded(
      Parser.seq(Parser.not(tok('}')), startsTriples),
      Parser.seq(
        triplesSameSubject,
        Parser.repeat(
          Parser.preceded(
            Parser.seq(tok('.'), Parser.not(tok('}')), startsTriples),
            triplesSameSubject,
          ),
        ),
        eat('.'),
      ),
    ),
  ).pipe(Parser.map((o) => (o._tag === 'None' ? [] : [...o.value[0], ...o.value[1].flat()])));

  return { triplesSameSubject, triplesBlock, triplesTemplate };
};

// -----------------------------------------------------------------------------
// Property paths
// -----------------------------------------------------------------------------

const negatedOne: P<readonly [boolean, Term.NamedNode]> = Parser.seq(eat('^'), aOrIri);

const negated: P<Ast.Path> = Parser.alt(
  Parser.preceded(
    tok('('),
    Parser.terminated(Parser.opt(Parser.separated(negatedOne, tok('|'), { min: 1 })), expect(')')),
  ).pipe(Parser.map((o) => (o._tag === 'Some' ? o.value : []))),
  negatedOne.pipe(Parser.map((one) => [one])),
).pipe(
  Parser.map((ones) =>
    Ast.negated(
      ones.filter(([inv]) => !inv).map(([, i]) => i),
      ones.filter(([inv]) => inv).map(([, i]) => i),
    ),
  ),
);

const pathPrimary: P<Ast.Path> = Parser.alt(
  tok('a').pipe(Parser.as(Ast.link(rdfType))),
  iri.pipe(Parser.map((i) => Ast.link(i))),
  Parser.preceded(tok('!'), negated),
  Parser.delimited(tok('('), path, expect(')')),
  unexpectedHere<Ast.Path>('a property path'),
);

const pathElt: P<Ast.Path> = Parser.seq(
  pathPrimary,
  Parser.opt(Parser.alt(tok('?'), tok('*'), tok('+'))),
).pipe(
  Parser.map(([primary, mod]) =>
    mod._tag === 'None'
      ? primary
      : mod.value.kind === '?'
        ? Ast.zeroOrOne(primary)
        : mod.value.kind === '*'
          ? Ast.zeroOrMore(primary)
          : Ast.oneOrMore(primary),
  ),
);

const pathEltOrInverse: P<Ast.Path> = Parser.alt(
  Parser.preceded(tok('^'), pathElt).pipe(Parser.map((p) => Ast.inverse(p))),
  pathElt,
);

const pathSequence: P<Ast.Path> = Parser.separated(pathEltOrInverse, tok('/'), { min: 1 }).pipe(
  Parser.map((ps) => (ps.length === 1 ? ps[0] : Ast.sequence(...ps))),
);

const path_: P<Ast.Path> = Parser.separated(pathSequence, tok('|'), { min: 1 }).pipe(
  Parser.map((ps) => (ps.length === 1 ? ps[0] : Ast.alternative(...ps))),
);

// -----------------------------------------------------------------------------
// Expressions
// -----------------------------------------------------------------------------

const expression: P<Ast.Expression> = Parser.suspend(() => expression_);
const groupGraphPattern: P<Ast.GroupPattern> = Parser.suspend(() => groupGraphPattern_);

const AGGREGATES = new Set(['COUNT', 'SUM', 'MIN', 'MAX', 'AVG', 'SAMPLE', 'GROUP_CONCAT']);

const isBuiltInStart = (t: Tok): boolean =>
  t.type === 'WORD' &&
  (Ast.isBuiltInName(t.kind) || AGGREGATES.has(t.kind) || t.kind === 'EXISTS' || t.kind === 'NOT');

const startsBuiltIn: P<unknown> = Parser.peek(
  take('a function', (t) => (isBuiltInStart(t) ? true : undefined)),
);

const brackettedExpression: P<Ast.Expression> = Parser.delimited(
  expect('('),
  expression,
  expect(')'),
);

const expressionList: P<Array<Ast.Expression>> = Parser.preceded(
  expect('('),
  Parser.alt(
    tok(')').pipe(Parser.as([])),
    Parser.terminated(Parser.separated(expression, tok(','), { min: 1 }), expect(')')),
  ),
);

/** The arguments of a function call, and whether they are DISTINCT. */
const functionArgs: P<readonly [ReadonlyArray<Ast.Expression>, boolean]> = Parser.alt(
  Parser.preceded(Parser.seq(nil, anyToken, anyToken), Parser.succeed([[], false] as const)),
  Parser.preceded(
    expect('('),
    Parser.seq(
      Parser.opt(
        take('DISTINCT', (t) => {
          if (t.kind !== 'DISTINCT') return undefined;
          if (!ctx.aggregatesAllowed || ctx.inAggregate) {
            fail('DISTINCT is only allowed in aggregate function calls', t.start);
          }
          return true;
        }),
      ),
      Parser.separated(expression, tok(','), { min: 1 }),
      expect(')'),
    ),
  ).pipe(Parser.map(([distinct, args]) => [args, distinct._tag === 'Some'] as const)),
);

const groupGraphPatternInExpression: P<Ast.GroupPattern> = withFlags(
  false,
  false,
  groupGraphPattern,
);

/** An aggregate, from its name. */
const aggregate = (name: Ast.AggregateName): P<Ast.Expression> =>
  Parser.preceded(
    hook((t) => {
      if (!ctx.aggregatesAllowed) fail(`Aggregate ${name} is not allowed here`, offsetOf(t));
      if (ctx.inAggregate) fail('Aggregates cannot be nested', offsetOf(t));
    }),
    Parser.seq(
      Parser.preceded(Parser.seq(anyToken, expect('(')), eat('DISTINCT')),
      Parser.preceded(
        hook(() => {
          ctx.inAggregate = true;
        }),
        Parser.alt(
          ...(name === 'COUNT'
            ? [Parser.preceded(tok('*'), expect(')')).pipe(Parser.as<'*'>('*'))]
            : []),
          Parser.seq(
            expression,
            name === 'GROUP_CONCAT'
              ? Parser.opt(
                  Parser.preceded(
                    Parser.seq(tok(';'), expect('SEPARATOR'), expect('=')),
                    Parser.alt(string, unexpectedHere<Tok>('a string')),
                  ),
                )
              : Parser.succeed({ _tag: 'None' } as const),
            expect(')'),
          ),
        ),
      ),
      hook(() => {
        ctx.inAggregate = false;
      }),
    ),
  ).pipe(
    Parser.map(([distinct, body]) => {
      if (body === '*') return Ast.aggregate('COUNT', '*', { distinct });
      const [e, sep] = body;
      return sep._tag === 'Some'
        ? Ast.aggregate(name, e, { distinct, separator: sep.value.value })
        : Ast.aggregate(name, e, { distinct });
    }),
  );

// SAFETY: `Object.keys` of the `builtInArity` record are exactly its `BuiltInName` keys.
const BUILT_INS = Object.keys(Ast.builtInArity) as Array<Ast.BuiltInName>;

const builtInCall: P<Ast.Expression> = Parser.alt(
  // Built-ins with arguments: the arity is checked against the name.
  Parser.preceded(
    peekKind(new Set(BUILT_INS.filter((n) => n !== 'BOUND' && Ast.builtInArity[n][1] > 0))),
    Parser.seq(anyToken, expressionList),
  ).pipe(
    Parser.map(([t, args]) => {
      // SAFETY: `peekKind(BUILT_INS)` only lets a token whose kind is a built-in name through.
      const name = t.kind as Ast.BuiltInName;
      const [min, max] = Ast.builtInArity[name];
      return args.length < min || args.length > max
        ? fail(`${name} expects ${min === max ? min : `${min} to ${max}`} arguments`, t.start)
        : Ast.operation(name, ...args);
    }),
  ),
  // SAFETY: `peekKind` admitted only built-in names (the zero-arity ones) here.
  Parser.preceded(
    peekKind(new Set(BUILT_INS.filter((n) => Ast.builtInArity[n][1] === 0))),
    Parser.seq(
      anyToken,
      Parser.alt(Parser.seq(nil, anyToken, anyToken), unexpectedHere<void>("'()'")),
    ),
  ).pipe(Parser.map(([t]) => Ast.operation(t.kind as Ast.BuiltInName))),
  Parser.preceded(
    Parser.seq(tok('BOUND'), expect('(')),
    Parser.terminated(variableOrError, expect(')')),
  ).pipe(Parser.map((v) => Ast.operation('BOUND', v))),
  Parser.preceded(tok('EXISTS'), groupGraphPatternInExpression).pipe(
    Parser.map((g) => Ast.exists(g, false)),
  ),
  Parser.preceded(Parser.seq(tok('NOT'), expect('EXISTS')), groupGraphPatternInExpression).pipe(
    Parser.map((g) => Ast.exists(g, true)),
  ),
  ...Array.from(AGGREGATES, (name) =>
    // SAFETY: `AGGREGATES` holds the aggregate names, so each one is an `Ast.AggregateName`.
    Parser.preceded(peekKind(new Set([name])), aggregate(name as Ast.AggregateName)),
  ),
);

const exprTripleTerm: P<Ast.Expression> = Parser.preceded(
  tok('<<('),
  Parser.seq(
    Parser.alt(variable, iriOrError),
    Parser.alt(tok('a').pipe(Parser.as(rdfType)), variable, iriOrError),
    Parser.alt(
      Parser.suspend(() => exprTripleTerm),
      variable,
      dataTerm,
    ),
    expect(')>>'),
  ),
).pipe(Parser.map(([s, p, o]) => Term.triple<any, any, any>(s, p, o)));

const primary: P<Ast.Expression> = Parser.alt(
  variable,
  Parser.seq(iri, Parser.opt(Parser.preceded(Parser.peek(tok('(')), functionArgs))).pipe(
    Parser.map(([i, args]): Ast.Expression =>
      args._tag === 'Some' ? Ast.functionCall(i, args.value[0], args.value[1]) : i,
    ),
  ),
  rdfLiteral,
  numericLiteral,
  booleanLiteral,
  Parser.preceded(startsBuiltIn, builtInCall),
  Parser.preceded(Parser.peek(tok('(')), brackettedExpression),
  exprTripleTerm,
  unexpectedHere<Ast.Expression>('an expression'),
);

const unary: P<Ast.Expression> = Parser.alt(
  Parser.preceded(
    tok('!'),
    Parser.suspend(() => unary),
  ).pipe(Parser.map((e) => Ast.operation('!', e))),
  signedNumber,
  Parser.seq(Parser.alt(tok('+'), tok('-')), primary).pipe(
    Parser.map(([op, e]) => Ast.operation(op.kind === '+' ? 'UPLUS' : 'UMINUS', e)),
  ),
  primary,
);

/** Matches the token of an operator, typed as that operator. */
const operator = <O extends Ast.Operator>(o: O): P<O> => tok(o).pipe(Parser.map(() => o));

const leftAssoc = (
  operand: P<Ast.Expression>,
  ops: ReadonlyArray<Ast.Operator>,
): P<Ast.Expression> =>
  Parser.seq(operand, Parser.repeat(Parser.seq(Parser.alt(...ops.map(operator)), operand))).pipe(
    Parser.map(([first, rest]) =>
      rest.reduce((left, [op, right]) => Ast.operation(op, left, right), first),
    ),
  );

const multiplicative = leftAssoc(unary, ['*', '/']);
const additive = leftAssoc(multiplicative, ['+', '-']);

const relational: P<Ast.Expression> = Parser.seq(
  additive,
  Parser.opt(
    Parser.alt(
      Parser.seq(
        Parser.alt(...(['=', '!=', '<', '>', '<=', '>='] as const).map(operator)),
        additive,
      ).pipe(
        Parser.map(
          ([op, right]) =>
            (left: Ast.Expression) =>
              Ast.operation(op, left, right),
        ),
      ),
      Parser.preceded(tok('IN'), expressionList).pipe(
        Parser.map((list) => (left: Ast.Expression) => Ast.operation('IN', left, ...list)),
      ),
      Parser.preceded(Parser.seq(tok('NOT'), tok('IN')), expressionList).pipe(
        Parser.map((list) => (left: Ast.Expression) => Ast.operation('NOT IN', left, ...list)),
      ),
    ),
  ),
).pipe(Parser.map(([left, rest]) => (rest._tag === 'Some' ? rest.value(left) : left)));

const conditionalAnd = leftAssoc(relational, ['&&']);
const expression_ = leftAssoc(conditionalAnd, ['||']);

const constraint: P<Ast.Expression> = Parser.alt(
  Parser.preceded(Parser.peek(tok('(')), brackettedExpression),
  Parser.preceded(startsBuiltIn, builtInCall),
  Parser.seq(
    iri,
    Parser.alt(
      Parser.preceded(Parser.peek(tok('(')), functionArgs),
      unexpectedHere<readonly [ReadonlyArray<Ast.Expression>, boolean]>("'('"),
    ),
  ).pipe(Parser.map(([i, [args, distinct]]) => Ast.functionCall(i, args, distinct))),
  unexpectedHere<Ast.Expression>('a constraint'),
);

/** Whether a constraint (`(`, a built-in, an IRI) starts here. */
const startsConstraint: P<unknown> = Parser.peek(
  take('a constraint', (t) => (t.kind === '(' || isBuiltInStart(t) || isIri(t) ? true : undefined)),
);

// -----------------------------------------------------------------------------
// Graph patterns
// -----------------------------------------------------------------------------

const patternTriples = triplesGrammar(true);
const templateTriples = triplesGrammar(false);

const varOrIri: P<Ast.VarOrIri> = Parser.alt(variable, iriOrError);

const GPNT = ['OPTIONAL', 'MINUS', 'GRAPH', 'SERVICE', 'FILTER', 'BIND', 'VALUES'];

const graphPatternNotTriples: P<Ast.Pattern> = select<Ast.Pattern>([
  [
    ['{'],
    Parser.seq(
      groupGraphPattern,
      Parser.repeat(Parser.preceded(tok('UNION'), groupGraphPattern)),
    ).pipe(
      Parser.map(([first, rest]) =>
        Arr.isReadonlyArrayEmpty(rest) ? first : Ast.union([first, ...rest]),
      ),
    ),
  ],
  [
    ['OPTIONAL'],
    Parser.preceded(anyToken, groupGraphPattern).pipe(Parser.map((g) => Ast.optional(g))),
  ],
  [['MINUS'], Parser.preceded(anyToken, groupGraphPattern).pipe(Parser.map((g) => Ast.minus(g)))],
  [
    ['GRAPH'],
    Parser.preceded(anyToken, Parser.seq(varOrIri, groupGraphPattern)).pipe(
      Parser.map(([name, g]) => Ast.graph(name, g)),
    ),
  ],
  [
    ['SERVICE'],
    Parser.preceded(anyToken, Parser.seq(eat('SILENT'), varOrIri, groupGraphPattern)).pipe(
      Parser.map(([silent, name, g]) => Ast.service(name, g, silent)),
    ),
  ],
  [['FILTER'], Parser.preceded(anyToken, constraint).pipe(Parser.map((e) => Ast.filter(e)))],
  [
    ['BIND'],
    Parser.preceded(
      Parser.seq(anyToken, expect('(')),
      Parser.seq(expression, Parser.preceded(expect('AS'), variableOrError), expect(')')),
    ).pipe(Parser.map(([e, v]) => Ast.bind(e, v))),
  ],
  [['VALUES'], Parser.preceded(anyToken, dataBlock)],
]);

const startsGPNT: P<unknown> = Parser.peek(
  take('a graph pattern', (t) =>
    t.kind === '{' || (t.type === 'WORD' && GPNT.includes(t.kind)) ? true : undefined,
  ),
);

type GroupItem =
  | { readonly _tag: 'Pattern'; readonly pattern: Ast.Pattern; readonly at: number }
  | { readonly _tag: 'Triples'; readonly triples: Triples };

const gpntItem: P<GroupItem> = Parser.preceded(
  startsGPNT,
  Parser.seq(
    hook((t) => offsetOf(t)),
    graphPatternNotTriples,
    eat('.'),
  ),
).pipe(
  Parser.map(([at, pattern]): GroupItem => {
    // After anything but a FILTER, the following triples are in a new BGP scope.
    if (pattern._tag !== 'Filter') ctx.triples[ctx.triples.length - 1] = ctx.patternContext();
    return { _tag: 'Pattern', pattern, at };
  }),
);

const isGPNTStart = (t: Tok | undefined): boolean =>
  t !== undefined &&
  t.type !== 'ERROR' &&
  (t.kind === '{' || (t.type === 'WORD' && GPNT.includes(t.kind)));

/** A triples block; one not ended by `.` must be followed by a pattern or `}`. */
const triplesItem: P<GroupItem> = Parser.preceded(
  startsTriples,
  Parser.seq(
    patternTriples.triplesBlock,
    hook((t) => t),
  ),
).pipe(
  Parser.map(([[triples, dot], t]): GroupItem => {
    if (!dot && t?.kind !== '}' && !isGPNTStart(t)) unexpectedAt(t, "'.' or '}'");
    return { _tag: 'Triples', triples };
  }),
);

/** The elements of a group, up to its `}` (not consumed). */
const groupItems: P<Array<GroupItem>> = Parser.repeat(
  Parser.preceded(
    Parser.not(tok('}')),
    Parser.alt(gpntItem, triplesItem, unexpectedHere<GroupItem>()),
  ),
);

const assembleGroup = (
  items: ReadonlyArray<GroupItem>,
): Result.Result<Ast.GroupPattern, Failure> => {
  const patterns: Array<Ast.Pattern> = [];
  for (const item of items) {
    if (item._tag === 'Pattern') {
      const p = item.pattern;
      if (p._tag === 'Bind') {
        const inScope = new Set<string>();
        for (const q of patterns) for (const v of Ast.inScopeVariables(q)) inScope.add(v);
        if (inScope.has(p.variable.value)) {
          return Result.fail(
            new Failure(`BIND variable ?${p.variable.value} is already in scope`, item.at),
          );
        }
      }
      patterns.push(p);
    } else {
      const last = patterns[patterns.length - 1];
      if (last !== undefined && last._tag === 'Bgp') {
        patterns[patterns.length - 1] = Ast.bgp([...last.triples, ...item.triples]);
      } else patterns.push(Ast.bgp(item.triples));
    }
  }
  return Result.succeed(Ast.group(patterns));
};

const subSelect: P<Ast.GroupPattern> = Parser.suspend(() => subSelect_);

const groupGraphPattern_: P<Ast.GroupPattern> = Parser.preceded(
  expect('{'),
  Parser.alt(
    Parser.preceded(Parser.peek(tok('SELECT')), subSelect),
    inContext(() => ctx.patternContext(), Parser.terminated(groupItems, expect('}'))).pipe(
      Parser.tryMap(assembleGroup),
      Parser.cut,
    ),
  ),
);

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------

interface Prologue {
  readonly value: () => Ast.Prologue;
}

let prologue: Prologue = { value: () => ({ prefixes: {} }) };

/** Skips the prologue (names are resolved by the lexer), recording `VERSION`. */
const prologueDecls: P<void> = Parser.asVoid(
  Parser.repeat(
    select<unknown>([
      [
        ['BASE'],
        Parser.preceded(
          anyToken,
          Parser.alt(
            take('an IRI', (t) => (t.type === 'IRI' ? t : undefined)),
            unexpectedHere('an IRI'),
          ),
        ),
      ],
      [
        ['PREFIX'],
        Parser.preceded(
          anyToken,
          Parser.seq(
            Parser.alt(
              take('a prefix name', (t) => (t.type === 'PNAME' && t.value === '' ? t : undefined)),
              unexpectedHere('a prefix name'),
            ),
            Parser.alt(
              take('an IRI', (t) => (t.type === 'IRI' ? t : undefined)),
              unexpectedHere('an IRI'),
            ),
          ),
        ),
      ],
      [
        ['VERSION'],
        Parser.preceded(
          anyToken,
          Parser.alt(
            take('a version string', (t) => {
              if (t.type !== 'STRING' || t.extra === 'long') return undefined;
              ctx.version = t.value;
              return t;
            }),
            unexpectedHere('a version string'),
          ),
        ),
      ],
    ]),
  ),
);

type Modifiers = Pick<Ast.QueryBase, 'groupBy' | 'having' | 'orderBy' | 'limit' | 'offset'>;

/** `query` with its dataset clause; an absent clause leaves the member absent. */
const withDataset = <Q extends Ast.QueryBase>(
  query: Q,
  dataset: Ast.DatasetClause | undefined,
): Q => (dataset === undefined ? query : { ...query, dataset });

const withAggregates = <A>(p: P<A>): P<A> => withFlags(true, undefined, p);

const groupCondition: P<Ast.GroupCondition> = Parser.alt(
  variable.pipe(Parser.map((v): Ast.GroupCondition => ({ expression: v }))),
  Parser.preceded(
    tok('('),
    Parser.seq(expression, Parser.opt(Parser.preceded(tok('AS'), variableOrError)), expect(')')),
  ).pipe(
    Parser.map(([expression, v]): Ast.GroupCondition =>
      v._tag === 'Some' ? { expression, variable: v.value } : { expression },
    ),
  ),
  Parser.preceded(
    Parser.peek(take('a constraint', (t) => (isBuiltInStart(t) || isIri(t) ? true : undefined))),
    constraint,
  ).pipe(Parser.map((expression): Ast.GroupCondition => ({ expression }))),
);

const orderCondition: P<Ast.OrderCondition> = Parser.alt(
  Parser.seq(
    Parser.alt(tok('ASC'), tok('DESC')),
    Parser.alt(
      Parser.preceded(Parser.peek(tok('(')), brackettedExpression),
      unexpectedHere<Ast.Expression>("'('"),
    ),
  ).pipe(
    Parser.map(([d, expression]): Ast.OrderCondition => ({
      expression,
      descending: d.kind === 'DESC',
    })),
  ),
  variable.pipe(
    Parser.map((expression): Ast.OrderCondition => ({ expression, descending: false })),
  ),
  Parser.preceded(startsConstraint, constraint).pipe(
    Parser.map((expression): Ast.OrderCondition => ({ expression, descending: false })),
  ),
);

const atLeastOne = <A>(p: P<A>, label: string): P<Array<A>> =>
  Parser.seq(
    Parser.repeat(p),
    hook((t) => t),
  ).pipe(
    Parser.tryMap(([items, t]) =>
      Arr.isReadonlyArrayEmpty(items)
        ? Result.fail(
            new Failure(
              t?.type === 'ERROR' ? t.value : `Unexpected ${describe(t)}, expected ${label}`,
              offsetOf(t),
            ),
          )
        : Result.succeed(items),
    ),
    Parser.cut,
  );

const integer: P<number> = Parser.alt(
  take('an integer', (t) => (t.type === 'INTEGER' ? Number(t.value) : undefined)),
  unexpectedHere<number>('an integer'),
);

const solutionModifiers: P<Modifiers> = Parser.seq(
  Parser.opt(
    Parser.preceded(
      Parser.seq(tok('GROUP'), expect('BY')),
      atLeastOne(groupCondition, 'a grouping condition'),
    ),
  ),
  Parser.opt(
    Parser.preceded(
      tok('HAVING'),
      Parser.seq(
        withAggregates(Parser.repeat(Parser.preceded(startsConstraint, constraint))),
        hook((t) => t),
      ),
    ).pipe(
      Parser.map(([having, t]) =>
        Arr.isReadonlyArrayNonEmpty(having) ? having : unexpectedAt(t, 'a HAVING condition'),
      ),
    ),
  ),
  Parser.opt(
    Parser.preceded(
      Parser.seq(tok('ORDER'), expect('BY')),
      Parser.seq(
        withAggregates(Parser.repeat(orderCondition)),
        hook((t) => t),
      ),
    ).pipe(
      Parser.map(([orderBy, t]) =>
        Arr.isReadonlyArrayNonEmpty(orderBy) ? orderBy : unexpectedAt(t, 'an ORDER BY condition'),
      ),
    ),
  ),
  Parser.alt(
    Parser.seq(
      Parser.preceded(tok('LIMIT'), integer).pipe(Parser.map((n) => ['limit', n] as const)),
      Parser.opt(Parser.preceded(tok('OFFSET'), integer)).pipe(
        Parser.map((o) => ['offset', o] as const),
      ),
    ).pipe(
      Parser.map(([[, limit], [, o]]) => ({
        limit,
        offset: o._tag === 'Some' ? o.value : undefined,
      })),
    ),
    Parser.seq(
      Parser.preceded(tok('OFFSET'), integer),
      Parser.opt(Parser.preceded(tok('LIMIT'), integer)),
    ).pipe(
      Parser.map(([offset, l]) => ({ limit: l._tag === 'Some' ? l.value : undefined, offset })),
    ),
    Parser.succeed({ limit: undefined, offset: undefined }),
  ),
).pipe(
  Parser.map(([groupBy, having, orderBy, { limit, offset }]): Modifiers => {
    const modifiers: Modifiers = {
      groupBy: groupBy._tag === 'Some' ? groupBy.value : [],
      having: having._tag === 'Some' ? having.value : [],
      orderBy: orderBy._tag === 'Some' ? orderBy.value : [],
    };
    const limited = limit === undefined ? modifiers : { ...modifiers, limit };
    return offset === undefined ? limited : { ...limited, offset };
  }),
);

const datasetClauses: P<Ast.DatasetClause | undefined> = Parser.repeat(
  Parser.preceded(tok('FROM'), Parser.seq(eat('NAMED'), iriOrError)),
).pipe(
  Parser.map((clauses) =>
    Arr.isReadonlyArrayEmpty(clauses)
      ? undefined
      : {
          default: clauses.filter(([named]) => !named).map(([, i]) => i),
          named: clauses.filter(([named]) => named).map(([, i]) => i),
        },
  ),
);

const valuesClause: P<Ast.ValuesPattern | undefined> = Parser.opt(
  Parser.preceded(tok('VALUES'), dataBlock),
).pipe(Parser.map((o) => (o._tag === 'Some' ? o.value : undefined)));

const projectionItem: P<Term.Variable | Ast.Projection> = Parser.alt(
  variable,
  Parser.preceded(
    tok('('),
    Parser.seq(
      withAggregates(expression),
      Parser.preceded(expect('AS'), variableOrError),
      expect(')'),
    ),
  ).pipe(
    Parser.map(([expression, v]): Ast.Projection => ({
      _tag: 'Projection',
      expression,
      variable: v,
    })),
  ),
);

const selectQuery = (sub: boolean): P<Ast.SelectQuery> =>
  Parser.preceded(
    expect('SELECT'),
    Parser.seq(
      Parser.alt(
        tok('DISTINCT').pipe(Parser.as([true, false] as const)),
        tok('REDUCED').pipe(Parser.as([false, true] as const)),
        Parser.succeed([false, false] as const),
      ),
      Parser.alt(
        tok('*').pipe(Parser.as<'*'>('*')),
        atLeastOne(projectionItem, 'a variable, expression or *'),
      ),
      sub ? Parser.succeed(undefined) : datasetClauses,
      Parser.preceded(eat('WHERE'), groupGraphPattern),
      solutionModifiers,
    ),
  ).pipe(
    Parser.map(([[distinct, reduced], projection, dataset, where, modifiers]): Ast.SelectQuery =>
      withDataset(
        {
          _tag: 'Select',
          prologue: prologue.value(),
          distinct,
          reduced,
          projection,
          where,
          ...modifiers,
        },
        dataset,
      ),
    ),
  );

// SAFETY: `templateTriples` parses no property paths, so a template yields triple patterns only.
const constructTemplate: P<Array<Ast.TriplePattern>> = Parser.delimited(
  tok('{'),
  Parser.cut(
    inContext(
      () => ({
        variables: true,
        blankNodes: true,
        scope: ++ctx.scopeCounter,
        labels: ctx.templateLabels,
      }),
      templateTriples.triplesTemplate,
    ),
  ),
  expect('}'),
).pipe(Parser.map((t) => t as Array<Ast.TriplePattern>));

const constructQuery: P<Ast.ConstructQuery> = Parser.preceded(
  tok('CONSTRUCT'),
  Parser.alt(
    Parser.seq(
      constructTemplate,
      datasetClauses,
      Parser.preceded(eat('WHERE'), groupGraphPattern),
      solutionModifiers,
    ).pipe(
      Parser.map(([template, dataset, where, modifiers]): Ast.ConstructQuery =>
        withDataset(
          { _tag: 'Construct', prologue: prologue.value(), template, where, ...modifiers },
          dataset,
        ),
      ),
    ),
    Parser.seq(
      datasetClauses,
      Parser.delimited(
        Parser.seq(expect('WHERE'), expect('{')),
        inContext(() => ctx.patternContext(), templateTriples.triplesTemplate),
        expect('}'),
      ),
      solutionModifiers,
    ).pipe(
      Parser.map(([dataset, triples, modifiers]): Ast.ConstructQuery => {
        // SAFETY: `templateTriples` parses no property paths, so the short-form template holds
        // triple patterns only.
        const template = triples as Array<Ast.TriplePattern>;
        return withDataset(
          {
            _tag: 'Construct',
            prologue: prologue.value(),
            template,
            where: Ast.group(Arr.isReadonlyArrayNonEmpty(template) ? [Ast.bgp(template)] : []),
            short: true,
            ...modifiers,
          },
          dataset,
        );
      }),
    ),
  ),
);

const describeQuery: P<Ast.DescribeQuery> = Parser.preceded(
  tok('DESCRIBE'),
  Parser.seq(
    Parser.alt(
      tok('*').pipe(Parser.as<'*'>('*')),
      atLeastOne(Parser.alt(variable, iri), 'a variable, IRI or *'),
    ),
    datasetClauses,
    Parser.alt(
      Parser.preceded(
        Parser.peek(Parser.alt(tok('WHERE'), tok('{'))),
        Parser.preceded(eat('WHERE'), groupGraphPattern),
      ),
      Parser.succeed(Ast.group([])),
    ),
    solutionModifiers,
  ),
).pipe(
  Parser.map(([terms, dataset, where, modifiers]): Ast.DescribeQuery =>
    withDataset(
      { _tag: 'Describe', prologue: prologue.value(), terms, where, ...modifiers },
      dataset,
    ),
  ),
);

const askQuery: P<Ast.AskQuery> = Parser.preceded(
  tok('ASK'),
  Parser.seq(datasetClauses, Parser.preceded(eat('WHERE'), groupGraphPattern), solutionModifiers),
).pipe(
  Parser.map(([dataset, where, modifiers]): Ast.AskQuery =>
    withDataset({ _tag: 'Ask', prologue: prologue.value(), where, ...modifiers }, dataset),
  ),
);

const subSelect_: P<Ast.GroupPattern> = Parser.seq(
  withFlags(false, undefined, Parser.seq(selectQuery(true), valuesClause)),
  Parser.preceded(
    expect('}'),
    hook((t) => offsetOf(t)),
  ),
).pipe(
  Parser.map(([[query, values], at]) => {
    const sub = values !== undefined ? { ...query, values } : query;
    validateSelect(sub, at);
    return Ast.group([Ast.subSelect(sub)]);
  }),
);

// -----------------------------------------------------------------------------
// Static checks
// -----------------------------------------------------------------------------

const validateSelect = (query: Ast.SelectQuery, offset: number): void => {
  // Variables introduced by AS must not already be in scope.
  if (query.projection !== '*') {
    const grouped =
      Arr.isReadonlyArrayNonEmpty(query.groupBy) ||
      query.projection.some((p) => p._tag !== 'Variable' && Ast.containsAggregate(p.expression));
    // With grouping only the group keys are in scope; otherwise the
    // pattern's variables are.
    const inScope = new Set<string>(grouped ? [] : Ast.inScopeVariables(query.where));
    for (const g of query.groupBy) {
      if (g.variable !== undefined) inScope.add(g.variable.value);
      else if (g.expression._tag === 'Variable') inScope.add(g.expression.value);
    }
    // Variables of a trailing VALUES clause are joined before projection.
    for (const v of query.values?.variables ?? []) inScope.add(v.value);
    const seen = new Set<string>();
    for (const item of query.projection) {
      if (item._tag !== 'Variable') {
        const name = item.variable.value;
        if (inScope.has(name) || seen.has(name)) {
          fail(`Variable ?${name} is already in scope`, offset);
        }
        seen.add(name);
      } else seen.add(item.value);
    }
  }
  validateGrouping(query, offset);
};

const validateGrouping = (query: Ast.Query, offset: number): void => {
  const projectionExprs =
    query._tag === 'Select' && query.projection !== '*'
      ? query.projection.flatMap((p) => (p._tag === 'Variable' ? [] : [p.expression]))
      : [];
  const grouped =
    Arr.isReadonlyArrayNonEmpty(query.groupBy) ||
    projectionExprs.some(Ast.containsAggregate) ||
    query.having.some(Ast.containsAggregate) ||
    query.orderBy.some((o) => Ast.containsAggregate(o.expression));
  for (const g of query.groupBy) {
    if (Ast.containsAggregate(g.expression)) fail('Aggregates are not allowed in GROUP BY', offset);
  }
  if (!grouped || query._tag !== 'Select') return;
  if (query.projection === '*') fail('SELECT * is not allowed with GROUP BY or aggregates', offset);
  const allowed = new Set<string>(query.values?.variables.map((v) => v.value) ?? []);
  for (const g of query.groupBy) {
    if (g.variable !== undefined) allowed.add(g.variable.value);
    else if (g.expression._tag === 'Variable') allowed.add(g.expression.value);
  }
  const checkExpr = (e: Ast.Expression): void => {
    Match.value(e).pipe(
      Match.tag('Variable', (v) => {
        if (!allowed.has(v.value)) fail(`Variable ?${v.value} is not grouped`, offset);
      }),
      Match.tag('Operation', 'FunctionCall', (call) => call.args.forEach(checkExpr)),
      Match.tag('Triple', (x) => {
        for (const v of Ast.expressionVariables(x)) {
          if (!allowed.has(v)) fail(`Variable ?${v} is not grouped`, offset);
        }
      }),
      Match.orElse(() => undefined),
    );
  };
  // SAFETY: `SELECT *` failed just above (`fail` throws), so the projection is a list of variables
  // and `(expr AS ?v)` items.
  for (const item of query.projection as ReadonlyArray<Term.Variable | Ast.Projection>) {
    if (item._tag === 'Variable') {
      if (!allowed.has(item.value)) fail(`Variable ?${item.value} is not grouped`, offset);
    } else {
      checkExpr(item.expression);
      allowed.add(item.variable.value);
    }
  }
};

const checked =
  <A>(f: (a: A) => void) =>
  (a: A): Result.Result<A, Failure> =>
    catchFailure(() => {
      f(a);
      return a;
    });

const queryUnit = Compiler.jit(
  Parser.preceded(
    Parser.seq(start, prologueDecls),
    Parser.seq(
      select<Ast.Query>(
        [
          [['SELECT'], selectQuery(false)],
          [['CONSTRUCT'], constructQuery],
          [['DESCRIBE'], describeQuery],
          [['ASK'], askQuery],
        ],
        unexpectedHere<Ast.Query>('SELECT, CONSTRUCT, DESCRIBE or ASK'),
      ),
      valuesClause,
      Parser.alt(Parser.eof, unexpectedHere<void>()),
    ).pipe(
      Parser.map(([query, values]): Ast.Query =>
        values !== undefined ? { ...query, values } : query,
      ),
      Parser.tryMap(
        checked((query: Ast.Query) => {
          if (query._tag === 'Select') validateSelect(query, 0);
          else validateGrouping(query, 0);
        }),
      ),
      Parser.cut,
    ),
  ),
);

// -----------------------------------------------------------------------------
// Updates
// -----------------------------------------------------------------------------

const quadPattern: P<Array<Ast.QuadPattern>> = Parser.delimited(
  expect('{'),
  Parser.repeat(
    Parser.preceded(
      Parser.not(tok('}')),
      Parser.alt(
        Parser.preceded(
          tok('GRAPH'),
          Parser.seq(
            Parser.preceded(
              hook((t) => {
                if (t?.type === 'VAR' && !ctx.tc.variables)
                  fail('Variables are not allowed here', t.start);
              }),
              varOrIri,
            ),
            Parser.delimited(expect('{'), templateTriples.triplesTemplate, expect('}')),
            eat('.'),
          ),
        ).pipe(
          Parser.map(([g, triples]) =>
            triples.map((t) => {
              // SAFETY: `templateTriples` parses no property paths, so every quad-data item is a
              // triple pattern.
              const tp = t as Ast.TriplePattern;
              return Ast.quadPattern(tp.subject, tp.predicate, tp.object, g);
            }),
          ),
        ),
        Parser.terminated(
          Parser.preceded(
            Parser.alt(startsTriples, unexpectedHere<void>()),
            templateTriples.triplesTemplate,
          ),
          Parser.alt(
            Parser.peek(Parser.alt(tok('}'), tok('GRAPH'))),
            unexpectedHere<void>("'.' or '}'"),
          ),
        ).pipe(
          Parser.map((triples) =>
            triples.map((t) => {
              // SAFETY: `templateTriples` parses no property paths, so every quad-data item is a
              // triple pattern.
              const tp = t as Ast.TriplePattern;
              return Ast.quadPattern(tp.subject, tp.predicate, tp.object, Term.defaultGraph);
            }),
          ),
        ),
      ),
    ),
  ),
  expect('}'),
).pipe(Parser.map((lists) => lists.flat()));

const templateContext = (blankNodes: boolean) => (): TripleContext => ({
  variables: true,
  blankNodes,
  scope: ctx.opIndex,
  labels: new Map(),
});

const quadData = (blankNodes: boolean): P<Array<Term.Quad>> =>
  inContext(
    () => ({ variables: false, blankNodes, scope: ctx.opIndex, labels: ctx.templateLabels }),
    quadPattern,
  ).pipe(
    Parser.map((quads) =>
      quads.map(
        (q) => new Term.Quad<any, any, any, any>(q.subject, q.predicate, q.object, q.graph),
      ),
    ),
  );

const usingClauses = Parser.repeat(
  Parser.preceded(tok('USING'), Parser.seq(eat('NAMED'), iriOrError)),
);

const modify = (deleteFirst: boolean): P<Ast.ModifyOperation> =>
  Parser.seq(
    deleteFirst
      ? Parser.seq(
          inContext(templateContext(false), quadPattern),
          Parser.opt(Parser.preceded(tok('INSERT'), inContext(templateContext(true), quadPattern))),
        ).pipe(Parser.map(([del, ins]) => [del, ins._tag === 'Some' ? ins.value : []] as const))
      : inContext(templateContext(true), quadPattern).pipe(Parser.map((ins) => [[], ins] as const)),
    usingClauses,
    Parser.preceded(expect('WHERE'), groupGraphPattern),
  ).pipe(
    Parser.map(([[del, ins], using, where]): Ast.ModifyOperation => {
      const modify: Ast.ModifyOperation = { _tag: 'Modify', delete: del, insert: ins, where };
      return Arr.isReadonlyArrayEmpty(using)
        ? modify
        : {
            ...modify,
            using: {
              default: using.filter(([named]) => !named).map(([, i]) => i),
              named: using.filter(([named]) => named).map(([, i]) => i),
            },
          };
    }),
  );

const graphRefAll: P<Ast.GraphTarget> = Parser.alt(
  tok('DEFAULT').pipe(Parser.as<Ast.GraphTarget>({ _tag: 'Default' })),
  tok('NAMED').pipe(Parser.as<Ast.GraphTarget>({ _tag: 'Named' })),
  tok('ALL').pipe(Parser.as<Ast.GraphTarget>({ _tag: 'All' })),
  Parser.preceded(expect('GRAPH'), iriOrError),
);

const graphOrDefault: P<Ast.GraphOrDefault> = Parser.alt(
  tok('DEFAULT').pipe(Parser.as<Ast.GraphOrDefault>(Term.defaultGraph)),
  Parser.preceded(eat('GRAPH'), iriOrError),
);

const update1: P<Ast.UpdateOperation> = select<Ast.UpdateOperation>(
  [
    [
      ['LOAD'],
      Parser.preceded(
        anyToken,
        Parser.seq(
          eat('SILENT'),
          iriOrError,
          Parser.opt(Parser.preceded(Parser.seq(tok('INTO'), expect('GRAPH')), iriOrError)),
        ),
      ).pipe(
        Parser.map(([silent, source, dest]): Ast.UpdateOperation =>
          dest._tag === 'Some'
            ? { _tag: 'Load', silent, source, destination: dest.value }
            : { _tag: 'Load', silent, source },
        ),
      ),
    ],
    [
      ['CLEAR', 'DROP'],
      Parser.seq(anyToken, eat('SILENT'), graphRefAll).pipe(
        Parser.map(([t, silent, target]): Ast.UpdateOperation => ({
          _tag: t.kind === 'CLEAR' ? 'Clear' : 'Drop',
          silent,
          target,
        })),
      ),
    ],
    [
      ['CREATE'],
      Parser.preceded(
        anyToken,
        Parser.seq(eat('SILENT'), Parser.preceded(expect('GRAPH'), iriOrError)),
      ).pipe(
        Parser.map(([silent, graph]): Ast.UpdateOperation => ({ _tag: 'Create', silent, graph })),
      ),
    ],
    [
      ['ADD', 'MOVE', 'COPY'],
      Parser.seq(
        anyToken,
        eat('SILENT'),
        graphOrDefault,
        Parser.preceded(expect('TO'), graphOrDefault),
      ).pipe(
        Parser.map(([t, silent, source, destination]): Ast.UpdateOperation => ({
          _tag: t.kind === 'ADD' ? 'Add' : t.kind === 'MOVE' ? 'Move' : 'Copy',
          silent,
          source,
          destination,
        })),
      ),
    ],
    [
      ['INSERT'],
      Parser.preceded(
        anyToken,
        Parser.alt(
          Parser.preceded(tok('DATA'), quadData(true)).pipe(
            Parser.map((quads): Ast.UpdateOperation => ({ _tag: 'InsertData', quads })),
          ),
          modify(false),
        ),
      ),
    ],
    [
      ['DELETE'],
      Parser.preceded(
        anyToken,
        Parser.alt(
          Parser.preceded(tok('DATA'), quadData(false)).pipe(
            Parser.map((quads): Ast.UpdateOperation => ({ _tag: 'DeleteData', quads })),
          ),
          Parser.preceded(
            tok('WHERE'),
            inContext(
              () => ({
                variables: true,
                blankNodes: false,
                scope: ++ctx.scopeCounter,
                labels: ctx.patternLabels,
              }),
              quadPattern,
            ),
          ).pipe(
            Parser.map((patterns): Ast.UpdateOperation => ({ _tag: 'DeleteWhere', patterns })),
          ),
          modify(true),
        ),
      ),
    ],
    [
      ['WITH'],
      Parser.seq(
        Parser.preceded(anyToken, iriOrError),
        Parser.alt(
          Parser.preceded(tok('DELETE'), modify(true)),
          Parser.preceded(expect('INSERT'), modify(false)),
        ),
      ).pipe(
        Parser.map(([i, { _tag, ...rest }]): Ast.UpdateOperation => ({ _tag, with: i, ...rest })),
      ),
    ],
  ],
  unexpectedHere<Ast.UpdateOperation>('an update operation'),
);

const update1Indexed: P<Ast.UpdateOperation> = Parser.terminated(
  update1,
  hook(() => {
    ctx.opIndex++;
  }),
);

const updateUnit = Compiler.jit(
  Parser.preceded(
    Parser.seq(start, prologueDecls),
    Parser.terminated(
      Parser.opt(
        Parser.preceded(
          Parser.not(Parser.eof),
          Parser.separated(
            update1Indexed,
            Parser.seq(tok(';'), prologueDecls, Parser.not(Parser.eof)),
            { min: 1 },
          ),
        ),
      ),
      Parser.seq(
        Parser.opt(Parser.seq(tok(';'), prologueDecls)),
        Parser.alt(Parser.eof, unexpectedHere<void>("';'")),
      ),
    ),
  ).pipe(Parser.map((ops) => Ast.update(ops._tag === 'Some' ? ops.value : [], prologue.value()))),
);

// -----------------------------------------------------------------------------
// Entry points
// -----------------------------------------------------------------------------

const run = <A>(
  grammar: P<A>,
  input: string,
  baseIri: string | undefined,
  prefixes: Readonly<Record<string, string>> | undefined,
): Result.Result<A, Failure> => {
  const tokens = tokenize(input);
  const resolved = resolve(tokens, baseIri, prefixes);
  fresh = () => new Context(input);
  ctx = fresh();
  prologue = {
    value: () => {
      const declared: Ast.Prologue = { prefixes: { ...resolved.prefixes } };
      const based = resolved.base === undefined ? declared : { ...declared, base: resolved.base };
      return ctx.version === undefined ? based : { ...based, version: ctx.version };
    },
  };
  // A `Failure` thrown by the maps that check what they build ends the parse.
  const parsed = catchFailure(() => Parser.parse(grammar, tokens));
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
  const result: Result.Result<A, ParseError.ParseError<Failure>> = parsed.success;
  if (Result.isSuccess(result)) return Result.succeed(result.success);
  const error: ParseError.ParseError<Failure> = result.failure;
  if (error.cause !== undefined) return Result.fail(error.cause);
  const t = tokens[error.offset];
  if (t?.type === 'ERROR') return Result.fail(new Failure(t.value, t.start));
  return Result.fail(new Failure(`Unexpected ${describe(t)}`, offsetOf(t)));
};

/** Parses a query. */
export const parseQuery = (
  input: string,
  baseIri: string | undefined,
  prefixes: Readonly<Record<string, string>> | undefined,
): Result.Result<Ast.Query, Failure> => run(queryUnit, input, baseIri, prefixes);

/** Parses an update request. */
export const parseUpdate = (
  input: string,
  baseIri: string | undefined,
  prefixes: Readonly<Record<string, string>> | undefined,
): Result.Result<Ast.Update, Failure> => run(updateUnit, input, baseIri, prefixes);
