/**
 * The Turtle and TriG (RDF 1.2) parser: a compiled
 * `@thomasfosterau/effect-parse` grammar over the input string, built on the
 * terminals of `Grammar.ts`, that emits quads as it reads.
 *
 * What depends on the document so far (prefixes, the base IRI, blank node
 * labels and counters, the current graph) lives in a per-parser `Builder`
 * that the grammar's callbacks update, as the hand-written parser it replaces
 * did. Errors are thrown out of the grammar (as a `Stop` at an offset) at the
 * points, and with the messages, of that parser.
 *
 * Input can be fed incrementally. Each run parses as many statements as the
 * buffered text holds; a statement that ends too close to the end of the
 * buffer to be sure of (or fails there) is rolled back and retried with more
 * text, and a statement that fails before the input is complete is re-read in
 * partial mode to tell a real error from a statement that is merely cut off.
 *
 * @internal
 */
import * as Ascii from '@thomasfosterau/effect-parse/Ascii';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Token from '@thomasfosterau/effect-parse/Token';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { rdf, xsd } from '@thomasfosterau/effect-rdf/Vocab';
import * as Lexical from '@thomasfosterau/effect-ntriples/Lexical';
import * as Result from 'effect/Result';
import * as Grammar from '../Grammar.ts';

/** @internal */
export class SyntaxFailure extends Error {
  readonly line: number;
  readonly column: number;
  constructor(message: string, line: number, column: number) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

/** @internal */
export interface ParserOptions {
  readonly trig: boolean;
  readonly baseIri: string | undefined;
  readonly blankNodePrefix: string;
  /** The graph for triples outside graph blocks. */
  readonly graph: Term.Graph;
}

/** An error at an offset of the text being parsed, thrown out of the grammar. */
class Stop {
  readonly message: string;
  readonly pos: number;
  constructor(message: string, pos: number) {
    this.message = message;
    this.pos = pos;
  }
}

/**
 * How far past the end of a statement, and past any dots there, the grammar
 * may look (`.%41`, `1.e+5`): a statement ending closer than this to the end
 * of incomplete input is retried once more text has arrived. (A run of dots
 * may continue a name, as in `ex:a...b`, however long it is.)
 */
const MARGIN = 3;

const C_DOT = 0x2e;
const C_BACKSLASH = 0x5c;
const C_PERCENT = 0x25;
const C_GT = 0x3e;

type P<A> = Parser.Parser<A, never, never, string>;

// -----------------------------------------------------------------------------
// The builder
// -----------------------------------------------------------------------------

/** The subject being described, with the predicate, object and reifier in progress. */
class Frame {
  subject: Term.Subject = rdf.nil;
  predicate: Term.Predicate = rdf.nil;
  object: Term.Object = rdf.nil;
  reifier: Term.NamedNode | Term.BlankNode | undefined;
  triple: Term.Triple | undefined;
}

class Builder {
  readonly options: ParserOptions;
  readonly prefixes = new Map<string, string>();
  base: string | undefined;
  out: Array<Term.Quad> = [];
  readonly labels = new Map<string, Term.BlankNode>();
  counter = 0;
  graph: Term.Graph;
  inGraph = false;

  /** Whether the input is complete, and the text being parsed. */
  final = true;
  input = '';
  readonly frames: Array<Frame> = [];
  depth = -1;
  /** A node read before it is known what it is (a TriG subject or graph name). */
  pending: Term.NamedNode | Term.BlankNode = rdf.nil;

  /** The state at the start of the current statement, to roll back to. */
  open = false;
  snapPos = 0;
  snapOut = 0;
  snapCounter = 0;
  snapGraph: Term.Graph;
  snapInGraph = false;
  snapBase: string | undefined;
  snapPrefix: string | undefined;
  snapPrefixValue: string | undefined;
  /** Registers for the terms being read (none of them nests). */
  iriStart = 0;
  iriEnd = 0;
  nameStart = 0;
  prefix = '';
  stringStart = 0;
  stringEnd = 0;
  tagStart = 0;
  literalStart = 0;
  literalValue = '';

  /** Where the last complete statement ended. */
  lastEnd = 0;
  /** The state at the start of the run, for a re-run. */
  private runOut = 0;
  private runCounter = 0;
  private runGraph: Term.Graph;
  private runInGraph = false;
  private runBase: string | undefined;
  /** The prefixes set during the run, with their previous values. */
  private readonly runPrefixes: Array<readonly [string, string | undefined]> = [];

  constructor(options: ParserOptions) {
    this.options = options;
    this.base = options.baseIri;
    this.graph = options.graph;
    this.snapGraph = options.graph;
    this.runGraph = options.graph;
  }

  /** Records the state at the start of a run. */
  beginRun(): void {
    this.open = false;
    this.lastEnd = 0;
    this.runOut = this.out.length;
    this.runCounter = this.counter;
    this.runGraph = this.graph;
    this.runInGraph = this.inGraph;
    this.runBase = this.base;
    this.runPrefixes.length = 0;
  }

  /** Returns to the state at the start of the run (for the re-run of a failed one). */
  restartRun(): void {
    this.open = false;
    this.lastEnd = 0;
    this.depth = -1;
    this.out.length = this.runOut;
    this.counter = this.runCounter;
    this.graph = this.runGraph;
    this.inGraph = this.runInGraph;
    this.base = this.runBase;
    for (let i = this.runPrefixes.length - 1; i >= 0; i--) {
      const [prefix, value] = this.runPrefixes[i]!;
      if (value === undefined) this.prefixes.delete(prefix);
      else this.prefixes.set(prefix, value);
    }
    this.runPrefixes.length = 0;
  }

  frame(): Frame {
    return this.frames[this.depth]!;
  }

  push(subject: Term.Subject): void {
    const frame = (this.frames[++this.depth] ??= new Frame());
    frame.subject = subject;
    frame.reifier = undefined;
    frame.triple = undefined;
  }

  emit(s: Term.Subject, p: Term.Predicate, o: Term.Object): void {
    this.out.push(new Term.Quad(s, p, o, this.graph));
  }

  fresh(): Term.BlankNode {
    return new Term.BlankNode(`${this.options.blankNodePrefix}_${(this.counter++).toString(36)}`);
  }

  snapshot(pos: number): void {
    this.open = true;
    this.depth = -1;
    this.snapPos = pos;
    this.snapOut = this.out.length;
    this.snapCounter = this.counter;
    this.snapGraph = this.graph;
    this.snapInGraph = this.inGraph;
    this.snapBase = this.base;
    this.snapPrefix = undefined;
  }

  /** Undoes the statement in progress. */
  rollback(): void {
    if (!this.open) return;
    this.out.length = this.snapOut;
    this.counter = this.snapCounter;
    this.graph = this.snapGraph;
    this.inGraph = this.snapInGraph;
    this.base = this.snapBase;
    if (this.snapPrefix !== undefined) {
      if (this.snapPrefixValue === undefined) this.prefixes.delete(this.snapPrefix);
      else this.prefixes.set(this.snapPrefix, this.snapPrefixValue);
      this.snapPrefix = undefined;
    }
    this.depth = -1;
  }

  setPrefix(prefix: string, iri: string): void {
    if (this.snapPrefix === undefined) {
      this.snapPrefix = prefix;
      this.snapPrefixValue = this.prefixes.get(prefix);
    }
    this.runPrefixes.push([prefix, this.prefixes.get(prefix)]);
    this.prefixes.set(prefix, iri);
  }

  openGraph(graph: Term.Graph): void {
    this.inGraph = true;
    this.graph = graph;
  }
}

/** The builder of the parser running the grammar. */
let b: Builder = new Builder({
  trig: false,
  baseIri: undefined,
  blankNodePrefix: '',
  graph: Term.defaultGraph,
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const lit = Token.literal;
const skip = Grammar.skip;

/** Runs `f` at the current offset, consuming nothing (never skipped by the compiler). */
const act = (f: (pos: number) => void): P<number> => Parser.tap(Parser.location, f);

/** Throws `message` at the current offset. */
const failHere = <A = never>(message: string): P<A> =>
  act((pos) => {
    throw new Stop(message, pos);
  }) as unknown as P<A>;

/** Throws the error `diagnose` finds at the current offset. */
const failWith = <A = never>(diagnose: (input: string, pos: number) => Stop): P<A> =>
  Parser.make<A, never, never, string>((state) => {
    throw diagnose(state.input, state.pos);
  });

const at = (s: string): P<unknown> => Parser.peek(lit(s));

const nameChar = Token.oneOf([Grammar.pnChars, ':']);
const notName = Parser.not(nameChar);

/** A case-insensitive keyword followed by a character that cannot continue a name. */
const keyword = (word: string): P<unknown> => Parser.terminated(Ascii.caseless(word), notName);

/** An `@` keyword, not followed by a letter, digit or `-`. */
const atKeyword = (word: string): P<unknown> =>
  Parser.terminated(lit(word), Parser.not(Token.oneOf([Grammar.alphanumeric, '-'])));

/** `.` or the error "Expected `what`". */
const expectDot = (what: string): P<unknown> => Parser.alt(lit('.'), failHere(`Expected ${what}`));

const nameStart: P<unknown> = Parser.peek(Parser.alt(lit(':'), Token.oneOf(Grammar.pnCharsBase)));

// -----------------------------------------------------------------------------
// Diagnostics: the errors of IRIs and strings, found by scanning them again
// -----------------------------------------------------------------------------

/** The error in the IRI at `start`, or `undefined`; `end` bounds an IRI that matched. */
const iriError = (input: string, start: number, end = input.length): Stop | undefined => {
  let i = start + 1;
  for (;;) {
    if (i >= end) return end === input.length ? new Stop('Unterminated IRI', start) : undefined;
    const c = input.charCodeAt(i);
    if (c === C_GT) return undefined;
    if (c === C_BACKSLASH) {
      const decoded = Lexical.decodeUchar(input, i);
      if (decoded._tag === 'Error') return new Stop(decoded.message, i);
      if (!Lexical.isIriChar(decoded.value.codePointAt(0)!)) {
        return new Stop('Escaped character is not allowed in an IRI', i);
      }
      i += decoded.length;
      continue;
    }
    if (!Lexical.isIriChar(c)) return new Stop('Invalid character in IRI', i);
    i++;
  }
};

/** The error in the string at `start`, or `undefined`; `end` bounds a string that matched. */
const stringError = (input: string, start: number, end = input.length): Stop | undefined => {
  const q = input.charCodeAt(start);
  const long = input.charCodeAt(start + 1) === q && input.charCodeAt(start + 2) === q;
  if (!long && input.charCodeAt(start + 1) === q) return undefined;
  let i = start + (long ? 3 : 1);
  for (;;) {
    if (i >= end)
      return end === input.length ? new Stop('Unterminated string literal', start) : undefined;
    const c = input.charCodeAt(i);
    if (c === q) {
      if (!long) return undefined;
      if (input.charCodeAt(i + 1) === q && input.charCodeAt(i + 2) === q) return undefined;
      i++;
      continue;
    }
    if (c === C_BACKSLASH) {
      if (Lexical.decodeEchar(input.charCodeAt(i + 1)) !== undefined) {
        i += 2;
        continue;
      }
      const decoded = Lexical.decodeUchar(input, i);
      if (decoded._tag === 'Error') return new Stop(decoded.message, i);
      i += decoded.length;
      continue;
    }
    if (!long && (c === 0x0a || c === 0x0d)) return new Stop('Line break in string literal', i);
    i++;
  }
};

const diagnosis =
  (find: (input: string, start: number) => Stop | undefined, message: string) =>
  (input: string, pos: number): Stop =>
    find(input, pos) ?? new Stop(message, pos);

// -----------------------------------------------------------------------------
// Terms
// -----------------------------------------------------------------------------

/** `IRIREF` (at a `<`), resolved against the base. */
const iri: P<Term.NamedNode> = Parser.preceded(
  act((pos) => {
    b.iriStart = pos;
  }),
  Parser.terminated(
    Parser.alt(Parser.backtrack(Grammar.iriRef), failWith(diagnosis(iriError, 'Invalid IRI'))),
    act((pos) => {
      b.iriEnd = pos;
    }),
  ),
).pipe(
  Parser.map((value) => {
    const start = b.iriStart;
    // Escapes (which shorten the value) may decode to characters an IRI cannot contain
    if (b.iriEnd - start - 2 !== value.length) {
      const error = iriError(b.input, start, b.iriEnd);
      if (error !== undefined) throw error;
    }
    if (b.base === undefined) {
      if (!Lexical.isAbsoluteIri(value)) {
        throw new Stop(`Relative IRI <${value}> cannot be resolved without a base IRI`, start);
      }
      return new Term.NamedNode(value);
    }
    return new Term.NamedNode(Iri.resolve(value, b.base));
  }),
);

/** Fails when a prefix name is followed by a dot (which `PN_PREFIX` cannot end with). */
const noTrailingDot: P<void> = Parser.make<void, never, never, string>((state) => {
  if (state.input.charCodeAt(state.pos) === C_DOT) {
    throw new Stop('A prefix name must not end with "."', state.pos - b.prefix.length);
  }
  return undefined;
});

/** `PN_PREFIX` (possibly empty), before the colon. */
const prefixLabel: P<string> = Parser.alt(
  Parser.terminated(
    Parser.tap(Grammar.pnPrefix, (prefix) => {
      b.prefix = prefix;
    }),
    noTrailingDot,
  ),
  Parser.preceded(at(':'), Parser.succeed('')),
  failHere('Invalid prefix name'),
);

/** Fails on the escapes that end a local name early: `%` or `\` (after any dots). */
const localTail: P<void> = Parser.make<void, never, never, string>((state) => {
  const input = state.input;
  let i = state.pos;
  while (input.charCodeAt(i) === C_DOT) i++;
  const c = input.charCodeAt(i);
  if (c === C_PERCENT) throw new Stop('Invalid percent escape', i);
  if (c === C_BACKSLASH) throw new Stop('Invalid escape in local name', i);
  return undefined;
});

const prefixedName: P<Term.NamedNode> = Parser.preceded(
  Parser.seq(
    act((pos) => {
      b.nameStart = pos;
    }),
    Parser.tap(prefixLabel, (prefix) => {
      b.prefix = prefix;
    }),
  ),
  Parser.alt(
    Parser.preceded(
      lit(':'),
      Parser.terminated(Parser.alt(Grammar.pnLocal, Parser.succeed('')), localTail),
    ).pipe(
      Parser.map((local) => {
        const ns = b.prefixes.get(b.prefix);
        if (ns === undefined) throw new Stop(`Undefined prefix "${b.prefix}:"`, b.nameStart);
        return new Term.NamedNode(ns + local);
      }),
    ),
    Parser.make<Term.NamedNode, never, never, string>(() => {
      throw new Stop('Expected a prefixed name', b.nameStart);
    }),
  ),
);

const blankNode: P<Term.BlankNode> = Parser.alt(
  Grammar.blankNodeLabel,
  Parser.preceded(lit('_:'), failHere<string>('Invalid blank node label')),
).pipe(
  Parser.map((label) => {
    let node = b.labels.get(label);
    if (node === undefined) {
      node = new Term.BlankNode(
        b.options.blankNodePrefix + (label.startsWith('_') ? `_${label}` : label),
      );
      b.labels.set(label, node);
    }
    return node;
  }),
);

/** An IRI or a blank node label (no anonymous nodes). */
const resource: P<Term.NamedNode | Term.BlankNode> = Parser.alt(
  Parser.preceded(at('<<'), failHere('Unexpected triple')),
  Parser.preceded(at('<'), iri),
  Parser.preceded(at('_:'), blankNode),
  prefixedName,
);

/** Any of the four string forms (at a quote), returning the value. */
const string: P<string> = Parser.preceded(
  act((pos) => {
    b.stringStart = pos;
  }),
  Parser.terminated(
    Parser.alt(
      Parser.backtrack(Grammar.stringLiteral),
      failWith(diagnosis(stringError, 'Invalid string literal')),
    ),
    act((pos) => {
      b.stringEnd = pos;
    }),
  ),
).pipe(
  Parser.map((value) => {
    // Numeric escapes (which shorten the value) may encode surrogates, which the terminal accepts
    const input = b.input;
    const start = b.stringStart;
    const q = input.charCodeAt(start);
    const quotes = input.charCodeAt(start + 1) === q && input.charCodeAt(start + 2) === q ? 6 : 2;
    if (b.stringEnd - start - quotes !== value.length) {
      const error = stringError(input, start, b.stringEnd);
      if (error !== undefined) throw error;
    }
    return value;
  }),
);

const datatype: P<Term.NamedNode> = Parser.alt(
  Parser.preceded(Parser.seq(Parser.not(lit('<<')), at('<')), iri),
  Parser.preceded(nameStart, prefixedName),
  failHere('Expected a datatype IRI'),
);

const languageTag: P<Lexical.LanguageTag> = Parser.preceded(
  lit('@'),
  Parser.preceded(
    act((pos) => {
      b.tagStart = pos;
    }),
    Token.takeWhile([Grammar.alphanumeric, '-']),
  ),
).pipe(
  Parser.map((text) => {
    const tag = Lexical.parseLanguageTag(text);
    if (tag === undefined) throw new Stop('Invalid language tag', b.tagStart);
    return tag;
  }),
);

const literal = (annotation: Lexical.LanguageTag | Term.NamedNode | undefined): Term.Literal => {
  const literal = Lexical.makeLiteral(b.literalValue, annotation);
  if (typeof literal === 'string') throw new Stop(literal, b.literalStart);
  return literal;
};

const rdfLiteral: P<Term.Literal> = Parser.preceded(
  Parser.seq(
    act((pos) => {
      b.literalStart = pos;
    }),
    Parser.tap(string, (value) => {
      b.literalValue = value;
    }),
    skip,
  ),
  Parser.alt(
    languageTag.pipe(Parser.map(literal)),
    Parser.preceded(
      Parser.alt(lit('^^'), Parser.preceded(at('^'), failHere("Expected '^^'"))),
      Parser.preceded(skip, datatype),
    ).pipe(Parser.map(literal)),
    Parser.make<Term.Literal, never, never, string>(() => literal(undefined)),
  ),
);

const numericLiteral: P<Term.Literal> = Parser.alt(
  Grammar.double.pipe(Parser.map((value) => new Term.Literal(value, xsd.double))),
  Grammar.decimal.pipe(Parser.map((value) => new Term.Literal(value, xsd.decimal))),
  Grammar.integer.pipe(Parser.map((value) => new Term.Literal(value, xsd.integer))),
  failHere('Invalid number'),
);

const trueLiteral = new Term.Literal('true', xsd.boolean);
const falseLiteral = new Term.Literal('false', xsd.boolean);

const booleanLiteral: P<Term.Literal> = Parser.alt(
  Parser.terminated(lit('true'), notName).pipe(Parser.as(trueLiteral)),
  Parser.terminated(lit('false'), notName).pipe(Parser.as(falseLiteral)),
);

/** Numbers, booleans and prefixed names. */
const simpleObject: P<Term.Object> = Parser.alt(
  Parser.preceded(Parser.peek(Token.oneOf('0123456789+-.')), numericLiteral),
  booleanLiteral,
  Parser.preceded(nameStart, prefixedName),
  failHere('Expected an object'),
);

const anon: P<Term.BlankNode> = Parser.seq(lit('['), Token.takeWhile(' \t\r\n'), lit(']')).pipe(
  Parser.map(() => b.fresh()),
);

/** `iri | BlankNode`, including `[]`. */
const iriOrBlankNode = (what: string): P<Term.NamedNode | Term.BlankNode> =>
  Parser.alt(
    Parser.preceded(
      at('['),
      Parser.alt(anon, failHere(`Blank node property lists are not allowed in ${what}`)),
    ),
    Parser.preceded(at('<<'), failHere(`Unexpected triple in ${what}`)),
    Parser.preceded(at('('), failHere(`Collections are not allowed in ${what}`)),
    Parser.preceded(Parser.peek(Token.oneOf('<_:')), resource),
    Parser.preceded(
      Parser.seq(Parser.peek(Token.oneOf(Grammar.pnCharsBase)), Parser.not(booleanLiteral)),
      resource,
    ),
    failHere(`Expected an IRI or blank node in ${what}`),
  );

const verb: P<Term.NamedNode> = Parser.alt(
  Parser.preceded(at('<<'), failHere('Triples are not allowed as predicates')),
  Parser.preceded(at('<'), iri),
  Parser.terminated(lit('a'), notName).pipe(Parser.as(rdf.type)),
  Parser.preceded(nameStart, prefixedName),
  failHere('Expected a predicate'),
);

const tripleTerm: P<Term.Triple> = Parser.suspend(() => tripleTerm_);
const reifiedTriple: P<Term.NamedNode | Term.BlankNode> = Parser.suspend(() => reifiedTriple_);
const object: P<Term.Object> = Parser.suspend(() => object_);
const predicateObjectList: P<unknown> = Parser.suspend(() => predicateObjectList_);

/** The object of a reified triple or triple term. */
const innerObject = (reified: boolean): P<Term.Object> => {
  const what = reified ? 'reified triples' : 'triple terms';
  return Parser.alt(
    Parser.preceded(at('<<('), tripleTerm),
    Parser.preceded(
      at('<<'),
      reified ? reifiedTriple : failHere('Reified triples are not allowed in triple terms'),
    ),
    Parser.preceded(Parser.peek(Token.oneOf('<_')), resource),
    Parser.preceded(
      at('['),
      Parser.alt(anon, failHere(`Blank node property lists are not allowed in ${what}`)),
    ),
    Parser.preceded(at('('), failHere(`Collections are not allowed in ${what}`)),
    Parser.preceded(Parser.peek(Token.oneOf('"\'')), rdfLiteral),
    simpleObject,
  );
};

const tripleTerm_: P<Term.Triple> = Parser.seq(
  Parser.preceded(Parser.seq(lit('<<('), skip), iriOrBlankNode('the subject of a triple term')),
  Parser.preceded(skip, verb),
  Parser.preceded(skip, innerObject(false)),
  Parser.preceded(skip, Parser.alt(lit(')>>'), failHere("Expected ')>>'"))),
).pipe(Parser.map(([s, p, o]) => new Term.Triple(s, p, o)));

const startsReifierId: P<unknown> = Parser.peek(
  Parser.alt(
    Parser.preceded(Parser.not(lit('<<')), lit('<')),
    lit('_:'),
    anon,
    lit(':'),
    Token.oneOf(Grammar.pnCharsBase),
  ),
);

/** A reifier IRI or blank node, including `[]`. */
const reifierId: P<Term.NamedNode | Term.BlankNode> = Parser.preceded(
  startsReifierId,
  Parser.alt(Parser.preceded(at('['), anon), resource),
);

const reifiedTriple_: P<Term.NamedNode | Term.BlankNode> = Parser.seq(
  Parser.preceded(
    Parser.seq(lit('<<'), skip),
    Parser.alt(
      Parser.preceded(Parser.seq(at('<<'), Parser.not(lit('<<('))), reifiedTriple),
      iriOrBlankNode('the subject of a reified triple'),
    ),
  ),
  Parser.preceded(skip, verb),
  Parser.preceded(skip, innerObject(true)),
  Parser.preceded(
    skip,
    Parser.opt(
      Parser.preceded(Parser.seq(lit('~'), skip), Parser.terminated(Parser.opt(reifierId), skip)),
    ),
  ),
  Parser.alt(lit('>>'), failHere("Expected '>>'")),
).pipe(
  Parser.map(([s, p, o, r]) => {
    const reifier = r._tag === 'Some' && r.value._tag === 'Some' ? r.value.value : b.fresh();
    b.emit(reifier, rdf.reifies, new Term.Triple(s, p, o));
    return reifier;
  }),
);

const blankNodePropertyList: P<Term.BlankNode> = Parser.seq(
  Parser.tap(lit('[').pipe(Parser.map(() => b.fresh())), (node) => b.push(node)),
  Parser.preceded(skip, predicateObjectList),
  Parser.preceded(skip, Parser.alt(lit(']'), failHere("Expected ']'"))),
).pipe(
  Parser.tap(() => {
    b.depth--;
  }),
  Parser.map(([node]) => node),
);

const collection: P<Term.NamedNode | Term.BlankNode> = Parser.preceded(
  Parser.seq(lit('('), skip),
  Parser.terminated(
    Parser.repeat(
      Parser.preceded(
        Parser.seq(Parser.not(lit(')')), Parser.not(Parser.eof)),
        Parser.terminated(object, skip),
      ),
    ),
    Parser.alt(lit(')'), failHere("Expected ')'")),
  ),
).pipe(
  Parser.map((items) => {
    if (items.length === 0) return rdf.nil;
    const nodes = items.map(() => b.fresh());
    for (let i = 0; i < items.length; i++) {
      b.emit(nodes[i]!, rdf.first, items[i]!);
      b.emit(nodes[i]!, rdf.rest, i + 1 < nodes.length ? nodes[i + 1]! : rdf.nil);
    }
    return nodes[0]!;
  }),
);

/**
 * A parser as a rule of its own: the compiler inlines everything between
 * rules, and leaves inlined into the recursive productions would make their
 * stack frames (and so the nesting the parser supports) much larger.
 */
const rule = <A>(p: P<A>): P<A> => Parser.suspend(() => p);

const object_: P<Term.Object> = Parser.alt(
  Parser.preceded(at('<<('), tripleTerm),
  Parser.preceded(at('<<'), reifiedTriple),
  Parser.preceded(at('<'), rule(iri)),
  Parser.preceded(at('_:'), rule(blankNode)),
  Parser.preceded(at('_'), rule(prefixedName)),
  Parser.preceded(at('['), Parser.alt(rule(anon), rule(blankNodePropertyList))),
  Parser.preceded(at('('), rule(collection)),
  Parser.preceded(Parser.peek(Token.oneOf('"\'')), rule(rdfLiteral)),
  rule(simpleObject),
);

// -----------------------------------------------------------------------------
// Predicate-object lists
// -----------------------------------------------------------------------------

const freshNode: P<Term.BlankNode> = Parser.make<Term.BlankNode, never, never, string>(() =>
  b.fresh(),
);

const emitObject: P<Term.Object> = Parser.tap(object, (o) => {
  const frame = b.frame();
  b.emit(frame.subject, frame.predicate, o);
  frame.object = o;
  frame.reifier = undefined;
  frame.triple = undefined;
});

const reifies = (frame: Frame, reifier: Term.NamedNode | Term.BlankNode): void => {
  frame.triple ??= new Term.Triple(frame.subject, frame.predicate, frame.object);
  b.emit(reifier, rdf.reifies, frame.triple);
};

// `~ r` names a reifier of the triple; `{| … |}` describes it (a fresh one if none was named).
const annotation: P<unknown> = Parser.repeat(
  Parser.preceded(
    skip,
    Parser.alt(
      Parser.tap(
        Parser.preceded(Parser.seq(lit('~'), skip), Parser.alt(reifierId, freshNode)),
        (reifier) => {
          const frame = b.frame();
          reifies(frame, reifier);
          frame.reifier = reifier;
        },
      ),
      Parser.seq(
        Parser.tap(lit('{|'), () => {
          const frame = b.frame();
          if (frame.reifier === undefined) {
            frame.reifier = b.fresh();
            reifies(frame, frame.reifier);
          }
          b.push(frame.reifier);
        }),
        Parser.preceded(skip, predicateObjectList),
        Parser.preceded(skip, Parser.alt(lit('|}'), failHere("Expected '|}'"))),
      ).pipe(
        Parser.tap(() => {
          b.depth--;
          b.frame().reifier = undefined;
        }),
      ),
    ),
  ),
);

const objectList: P<unknown> = Parser.seq(
  emitObject,
  rule(annotation),
  skip,
  Parser.repeat(
    Parser.preceded(Parser.seq(lit(','), skip), Parser.seq(emitObject, annotation, skip)),
  ),
);

const setPredicate: P<Term.NamedNode> = Parser.tap(rule(verb), (p) => {
  b.frame().predicate = p;
});

const startsVerb: P<unknown> = Parser.peek(
  Parser.alt(
    Parser.preceded(Parser.not(lit('<<')), lit('<')),
    lit(':'),
    Token.oneOf(Grammar.pnCharsBase),
  ),
);

const predicateObjectList_: P<unknown> = Parser.seq(
  setPredicate,
  skip,
  objectList,
  Parser.repeat(
    Parser.preceded(
      Parser.repeat(Parser.seq(lit(';'), skip), { min: 1 }),
      Parser.opt(Parser.preceded(startsVerb, Parser.seq(setPredicate, skip, objectList))),
    ),
  ),
);

/** `subject` (pushed while `rest` describes it). */
const describing = (subject: P<Term.Subject>, rest: P<unknown>): P<unknown> =>
  Parser.terminated(
    Parser.preceded(
      Parser.tap(subject, (s) => b.push(s)),
      rest,
    ),
    act(() => {
      b.depth--;
    }),
  );

const notEnd: P<unknown> = Parser.not(Token.oneOf('.}'));

const properties: P<unknown> = Parser.preceded(skip, predicateObjectList);
const optionalProperties: P<unknown> = Parser.preceded(
  skip,
  Parser.opt(Parser.preceded(notEnd, predicateObjectList)),
);

/** The `triples` production. */
const triples: P<unknown> = Parser.alt(
  Parser.preceded(
    at('['),
    Parser.alt(describing(anon, properties), describing(blankNodePropertyList, optionalProperties)),
  ),
  Parser.preceded(at('('), describing(collection, properties)),
  Parser.preceded(at('<<('), failHere('Triple terms are not allowed as subjects')),
  Parser.preceded(at('<<'), describing(reifiedTriple, optionalProperties)),
  describing(resource, properties),
);

// -----------------------------------------------------------------------------
// Statements
// -----------------------------------------------------------------------------

const prefixDirective = (turtle: boolean): P<unknown> =>
  Parser.seq(
    Parser.tap(
      Parser.preceded(skip, Parser.seq(Parser.location, prefixLabel, Parser.opt(lit(':')))),
      ([start, , colon]) => {
        if (colon._tag === 'None') throw new Stop('Expected a prefix name ending with ":"', start);
      },
    ),
    Parser.preceded(skip, Parser.alt(Parser.preceded(at('<'), iri), failHere('Expected an IRI'))),
    turtle ? Parser.preceded(skip, expectDot("'.' after @prefix")) : Parser.succeed(undefined),
  ).pipe(
    Parser.tap(([[, prefix], iri]) => {
      b.setPrefix(prefix, iri.value);
    }),
  );

const baseDirective = (turtle: boolean): P<unknown> =>
  Parser.seq(
    Parser.preceded(skip, Parser.alt(Parser.preceded(at('<'), iri), failHere('Expected an IRI'))),
    turtle ? Parser.preceded(skip, expectDot("'.' after @base")) : Parser.succeed(undefined),
  ).pipe(
    Parser.tap(([iri]) => {
      b.base = iri.value;
    }),
  );

const versionDirective = (turtle: boolean): P<unknown> =>
  Parser.seq(
    Parser.preceded(
      skip,
      Parser.alt(
        Parser.preceded(
          Parser.peek(Parser.alt(lit('"""'), lit("'''"))),
          failHere('Long strings are not allowed as version specifiers'),
        ),
        Parser.preceded(Parser.peek(Token.oneOf('"\'')), string),
        failHere('Expected a version string'),
      ),
    ),
    turtle ? Parser.preceded(skip, expectDot("'.' after @version")) : Parser.succeed(undefined),
  );

const directive: P<unknown> = Parser.alt(
  Parser.preceded(
    at('@'),
    Parser.alt(
      Parser.preceded(atKeyword('@prefix'), prefixDirective(true)),
      Parser.preceded(atKeyword('@base'), baseDirective(true)),
      Parser.preceded(atKeyword('@version'), versionDirective(true)),
      failHere('Unknown directive'),
    ),
  ),
  Parser.preceded(keyword('prefix'), prefixDirective(false)),
  Parser.preceded(keyword('base'), baseDirective(false)),
  Parser.preceded(keyword('version'), versionDirective(false)),
);

const endOfStatement: P<unknown> = Parser.preceded(
  skip,
  expectDot("'.' at the end of the statement"),
);

const turtleStatement: P<unknown> = Parser.alt(directive, Parser.seq(triples, endOfStatement));

const pending = (p: P<Term.NamedNode | Term.BlankNode>): P<unknown> =>
  Parser.tap(p, (node) => {
    b.pending = node;
  });

/** A graph block opened with `{` after `pending`, or properties of `pending`. */
const graphOrProperties: P<unknown> = Parser.preceded(
  skip,
  Parser.alt(
    Parser.tap(lit('{'), () => b.openGraph(b.pending)),
    Parser.seq(
      describing(
        Parser.make<Term.Subject, never, never, string>(() => b.pending),
        predicateObjectList,
      ),
      endOfStatement,
    ),
  ),
);

const graphLabel: P<Term.NamedNode | Term.BlankNode> = Parser.alt(
  Parser.preceded(at('['), Parser.alt(anon, failHere('Expected a graph name'))),
  resource,
);

/** A TriG block outside graphs. */
const block: P<unknown> = Parser.alt(
  Parser.tap(lit('{'), () => b.openGraph(Term.defaultGraph)),
  Parser.preceded(
    keyword('graph'),
    Parser.seq(
      pending(Parser.preceded(skip, graphLabel)),
      Parser.preceded(skip, Parser.alt(lit('{'), failHere("Expected '{' after graph name"))),
    ).pipe(Parser.tap(() => b.openGraph(b.pending))),
  ),
  Parser.preceded(
    at('['),
    Parser.alt(
      Parser.preceded(pending(anon), graphOrProperties),
      Parser.seq(
        describing(
          blankNodePropertyList,
          Parser.preceded(
            skip,
            Parser.opt(Parser.preceded(Parser.not(lit('.')), predicateObjectList)),
          ),
        ),
        endOfStatement,
      ),
    ),
  ),
  Parser.preceded(at('('), Parser.seq(describing(collection, properties), endOfStatement)),
  Parser.preceded(at('<<('), failHere('Triple terms are not allowed as subjects')),
  Parser.preceded(
    at('<<'),
    Parser.seq(
      describing(
        reifiedTriple,
        Parser.preceded(
          skip,
          Parser.opt(Parser.preceded(Parser.not(lit('.')), predicateObjectList)),
        ),
      ),
      endOfStatement,
    ),
  ),
  Parser.preceded(pending(resource), graphOrProperties),
);

/** Whether a TriG graph block is open (consuming nothing). */
const inGraph: P<void> = Parser.make<void, never, never, string>((state) =>
  b.inGraph ? undefined : state.backtrack('Verify', ['a graph block']),
);

const graphStatement: P<unknown> = Parser.alt(
  Parser.tap(lit('}'), () => {
    b.inGraph = false;
    b.graph = b.options.graph;
  }),
  Parser.seq(triples, skip, Parser.alt(lit('.'), at('}'), failHere("Expected '.' or '}'"))),
);

const trigStatement: P<unknown> = Parser.alt(
  Parser.preceded(inGraph, graphStatement),
  directive,
  block,
);

/** Records the state at the start of a statement. */
const beginStatement: P<void> = Parser.make<void, never, never, string>((state) => {
  b.snapshot(state.pos);
  return undefined;
});

/**
 * Ends a statement, unless the input may continue so close to its end that
 * the statement could still turn out differently.
 */
const endStatement: P<void> = Parser.make<void, never, never, string>((state) => {
  if (!b.final) {
    const input = state.input;
    let i = state.pos;
    while (input.charCodeAt(i) === C_DOT) i++;
    if (i + MARGIN > input.length) return state.backtrack('Verify', ['more input']);
  }
  b.open = false;
  b.lastEnd = state.pos;
  return undefined;
});

/** Starts a run: the compiled run, or the interpreted re-run after it fails. */
const startRun: P<void> = Parser.make<void, never, never, string>((state) => {
  b.input = state.input;
  b.restartRun();
  return undefined;
});

const statements = (statement: P<unknown>): P<number> =>
  Parser.compile(
    Parser.preceded(
      startRun,
      Parser.preceded(
        Parser.repeat(
          Parser.preceded(
            skip,
            Parser.preceded(
              Parser.not(Parser.eof),
              Parser.delimited(beginStatement, statement, endStatement),
            ),
          ),
        ),
        Parser.preceded(skip, Parser.location),
      ),
    ),
  );

const turtleStatements = statements(turtleStatement);
const trigStatements = statements(trigStatement);

/** One statement, for the partial-mode check (setting the input first). */
const single = (statement: P<unknown>): P<unknown> =>
  Parser.preceded(
    Parser.make<void, never, never, string>((state) => {
      b.input = state.input;
      return undefined;
    }),
    statement,
  );

const turtleSingle = single(turtleStatement);
const trigSingle = single(trigStatement);

// -----------------------------------------------------------------------------
// Driving
// -----------------------------------------------------------------------------

/** @internal */
export class TurtleParser {
  private input = '';
  private pos = 0;
  private final = true;
  /** Lines and columns consumed before the start of `input`. */
  private lineOffset = 0;
  private columnOffset = 0;
  private started = false;
  private readonly builder: Builder;
  /** How much text the failing statement at `pos` had when it was last checked (or -1). */
  private checked = -1;

  readonly options: ParserOptions;
  constructor(options: ParserOptions) {
    this.options = options;
    this.builder = new Builder(options);
  }

  get prefixes(): Map<string, string> {
    return this.builder.prefixes;
  }

  get base(): string | undefined {
    return this.builder.base;
  }

  /** Parses a complete document. */
  parseDocument(input: string): Array<Term.Quad> {
    this.input = input;
    this.pos = 0;
    this.final = true;
    this.skipBom();
    this.run();
    return this.finish();
  }

  /** Adds a chunk of input and returns the statements completed so far. */
  feed(chunk: string): Array<Term.Quad> {
    this.discardConsumed();
    this.input += chunk;
    this.final = false;
    this.skipBom();
    this.run();
    return this.take();
  }

  /** Signals the end of input and returns the remaining statements. */
  end(): Array<Term.Quad> {
    this.final = true;
    this.run();
    return this.finish();
  }

  private finish(): Array<Term.Quad> {
    if (this.builder.inGraph) this.fail("Unterminated graph block: expected '}'");
    return this.take();
  }

  private take(): Array<Term.Quad> {
    const out = this.builder.out;
    this.builder.out = [];
    return out;
  }

  private skipBom(): void {
    if (this.started) return;
    if (this.input.length === 0) return;
    this.started = true;
    if (this.input.charCodeAt(0) === 0xfeff) this.pos = 1;
  }

  private discardConsumed(): void {
    if (this.pos === 0) return;
    const consumed = this.input.slice(0, this.pos);
    const lastBreak = Math.max(consumed.lastIndexOf('\n'), consumed.lastIndexOf('\r'));
    if (lastBreak === -1) {
      this.columnOffset += consumed.length;
    } else {
      this.lineOffset += countLines(consumed);
      this.columnOffset = consumed.length - lastBreak - 1;
    }
    this.input = this.input.slice(this.pos);
    this.pos = 0;
  }

  /** Parses the statements of the buffered input. */
  private run(): void {
    const base = this.pos;
    const input = base === 0 ? this.input : this.input.slice(base);
    const builder = this.builder;
    b = builder;
    builder.final = this.final;
    builder.beginRun();
    try {
      const result = Parser.parsePeek(this.options.trig ? trigStatements : turtleStatements, input);
      if (Result.isFailure(result)) this.fail('Invalid syntax', base + result.failure.offset);
      const [, end] = result.success;
      if (this.final) {
        if (end < input.length) this.fail('Invalid syntax', base + end);
        this.pos = base + end;
      } else {
        builder.rollback();
        this.pos = base + builder.lastEnd;
        this.checked = -1;
      }
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
      builder.rollback();
      if (this.final) this.fail(e.message, base + e.pos);
      // A statement that fails is usually just cut off: it is retried with more
      // text, and checked when it still fails once its text has doubled (which
      // keeps the interpreted checks linear in the input)
      const start = builder.snapPos;
      const pending = input.length - start;
      if (start !== 0 || this.checked < 0 || pending < 2 * this.checked) {
        if (start !== 0 || this.checked < 0) this.checked = pending;
        this.pos = base + start;
        return;
      }
      this.checked = pending;
      this.check(input, base);
    }
  }

  /**
   * Before the input is complete, re-reads the statement that failed in
   * partial mode: it fails again if the error is real, and runs out of input
   * if the statement is only cut off.
   */
  private check(input: string, base: number): void {
    const builder = this.builder;
    const start = builder.snapPos;
    builder.open = true;
    try {
      const result = Parser.parsePartial(
        this.options.trig ? trigSingle : turtleSingle,
        input.slice(start),
      );
      if (Result.isFailure(result))
        this.fail('Invalid syntax', base + start + result.failure.offset);
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
      builder.rollback();
      this.fail(e.message, base + start + e.pos);
    }
    builder.rollback();
    builder.open = false;
    this.pos = base + start;
  }

  private fail(message: string, pos: number = this.pos): never {
    const before = this.input.slice(0, pos);
    const lines = countLines(before);
    const lastBreak = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'));
    const column = lines === 0 ? this.columnOffset + pos + 1 : pos - lastBreak;
    throw new SyntaxFailure(message, this.lineOffset + lines + 1, column);
  }
}

const countLines = (text: string): number => {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) n++;
    else if (c === 0x0d && text.charCodeAt(i + 1) !== 0x0a) n++;
  }
  return n;
};
