/**
 * Pretty-printing writer shared by the Turtle and TriG serializers.
 *
 * @internal
 */
import * as Dataset from '../../Dataset.ts';
import * as Iri from '../../Iri.ts';
import * as Isomorphism from '../../Isomorphism.ts';
import * as PrefixMap from '../../PrefixMap.ts';
import * as Term from '../../Term.ts';
import { commonPrefixes, rdf, xsd } from '../../Vocab.ts';
import * as Lexical from '../../ntriples/Lexical.ts';
import * as Arr from 'effect/Array';
import * as Iterable from 'effect/Iterable';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
import { loop } from './loop.ts';

/** @internal */
export class SerializeFailure extends Error {}

/** @internal */
export interface WriterOptions {
  readonly trig: boolean;
  readonly prefixes: Option.Option<PrefixMap.PrefixMap>;
  readonly baseIri: Option.Option<string>;
  readonly autoPrefixes: boolean;
  readonly sparqlDirectives: boolean;
  readonly indent: string;
}

const RDF_TYPE = rdf.type.value;
const RDF_FIRST = rdf.first.value;
const RDF_REST = rdf.rest.value;
const RDF_NIL = rdf.nil.value;
const RDF_REIFIES = rdf.reifies.value;
const XSD_INTEGER = xsd.integer.value;
const XSD_DECIMAL = xsd.decimal.value;
const XSD_DOUBLE = xsd.double.value;
const XSD_BOOLEAN = xsd.boolean.value;

const INTEGER = /^[+-]?[0-9]+$/;
const DECIMAL = /^[+-]?[0-9]*\.[0-9]+$/;
const DOUBLE =
  /^[+-]?(?:[0-9]+\.[0-9]*[eE][+-]?[0-9]+|\.[0-9]+[eE][+-]?[0-9]+|[0-9]+[eE][+-]?[0-9]+)$/;

/** Characters that may be backslash-escaped in a local name (minus URL delimiters). */
const LOCAL_ESCAPABLE = "_~.-!$&'()*+,;=@";

/** An ASCII local name that is already a `PN_LOCAL` (or empty): no character needs encoding. */
const PLAIN_LOCAL = /^(?:[A-Za-z0-9_:](?:[A-Za-z0-9_:.-]*[A-Za-z0-9_:-])?)?$/;

/**
 * The characters a long (`"""`) string escapes: `\`, `"`, controls other than
 * tab and line feed, and the noncharacters U+FFFE and U+FFFF. Written as what
 * is kept, so that it names no control character.
 */
const LONG_ESCAPED = /[\\"]|[^\t\n -~\x80-\u{fffd}\u{10000}-\u{10ffff}]/gu;

// -----------------------------------------------------------------------------
// Lexical helpers
// -----------------------------------------------------------------------------

/** The code point of a one-character string. */
const codePoint = (ch: string): number => ch.codePointAt(0) ?? 0;

/** Whether `prefix` is a valid `PN_PREFIX` (or empty). */
export const isPrefixName = (prefix: string): boolean => {
  if (prefix === '') return true;
  const chars = Array.from(prefix, codePoint);
  return (
    Arr.isReadonlyArrayNonEmpty(chars) &&
    Lexical.isPnCharsBase(Arr.headNonEmpty(chars)) &&
    Arr.lastNonEmpty(chars) !== 0x2e &&
    chars.every((c) => Lexical.isPnChars(c) || c === 0x2e)
  );
};

/** Encodes a local name character by character, escaping what `PN_LOCAL` needs escaped. */
const encodeLocalChars = (local: string): Option.Option<string> => {
  const chars = Array.from(local);
  const last = chars.length - 1;
  let out = '';
  let i = 0;
  let ok = true;
  loop(() => {
    if (i > last) return false;
    const ch = chars[i] ?? '';
    const c = codePoint(ch);
    const plain =
      i === 0
        ? Lexical.isPnCharsU(c) || c === 0x3a || Lexical.isDigit(c)
        : Lexical.isPnChars(c) || c === 0x3a || (c === 0x2e && i !== last);
    if (plain) {
      out += ch;
      i += 1;
      return true;
    }
    const h1 = chars[i + 1] ?? '';
    const h2 = chars[i + 2] ?? '';
    if (
      c === 0x25 &&
      i + 2 < chars.length &&
      Lexical.isHex(h1.charCodeAt(0)) &&
      Lexical.isHex(h2.charCodeAt(0))
    ) {
      out += ch + h1 + h2;
      i += 3;
      return true;
    }
    if (LOCAL_ESCAPABLE.includes(ch)) {
      out += `\\${ch}`;
      i += 1;
      return true;
    }
    ok = false;
    return false;
  });
  return ok ? Option.some(out) : Option.none();
};

/** Encodes a local name as `PN_LOCAL`, or returns `None` if it cannot be. */
export const encodeLocalName = (local: string): Option.Option<string> =>
  PLAIN_LOCAL.test(local) ? Option.some(local) : encodeLocalChars(local);

const hex4 = (c: number): string => `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`;

const escapeLong = (ch: string): string =>
  ch === '\\' ? '\\\\' : ch === '"' ? '\\"' : ch === '\r' ? '\\r' : hex4(ch.charCodeAt(0));

/** Formats a string as a Turtle string literal, using `"""` for multi-line text. */
export const quoteString = (value: string): string =>
  value.includes('\n')
    ? `"""${value.replace(LONG_ESCAPED, escapeLong)}"""`
    : `"${Term.escapeString(value)}"`;

// -----------------------------------------------------------------------------
// Analysis
// -----------------------------------------------------------------------------

interface BlankInfo {
  readonly objectRefs: Array<Term.Quad>;
  inTripleTerm: boolean;
  asGraph: boolean;
  /** The graph the node is first a subject in, and whether it is a subject in any other. */
  subjectGraph: Option.Option<string>;
  manyGraphs: boolean;
}

/** Calls `f` for every blank node in `t`, looking inside triple terms. */
const visitBlankNodes = (t: Term.Term, f: (b: Term.BlankNode) => void): void => {
  if (Term.isBlankNode(t)) {
    f(t);
  } else if (Term.isTriple(t)) {
    visitBlankNodes(t.subject, f);
    visitBlankNodes(t.object, f);
  }
};

/** Throws when a triple term's subject is itself a triple term, at any depth of objects. */
const checkTriple = (t: Term.Triple): void => {
  if (Term.isTriple(t.subject)) {
    throw new SerializeFailure(
      `Triple terms cannot be the subject of a triple term in Turtle 1.2: ${t.key}`,
    );
  }
  if (Term.isTriple(t.object)) checkTriple(t.object);
};

/** @internal */
export const checkQuad = (q: Term.Quad, trig: boolean): void => {
  if (Term.isTriple(q.subject)) {
    throw new SerializeFailure(`Triple terms cannot be subjects in Turtle 1.2: ${q.key}`);
  }
  if (!Term.isGround(q)) throw new SerializeFailure(`Cannot serialise non-ground quad ${q.key}`);
  if (Term.isTriple(q.object)) checkTriple(q.object);
  if (!trig && !Term.isDefaultGraph(q.graph)) {
    throw new SerializeFailure(`Turtle cannot represent quads in named graphs: ${q.key}`);
  }
};

type Annotation =
  | { readonly _tag: 'Block'; readonly reifier: Term.BlankNode }
  | { readonly _tag: 'Id'; readonly reifier: Term.NamedNode | Term.BlankNode };

const isIdAnnotation = Predicate.isTagged('Id');

type StringSet = MutableHashSet.MutableHashSet<string>;

interface GraphPlan {
  readonly graph: Term.Graph;
  readonly bySubject: MutableHashMap.MutableHashMap<string, Array<Term.Quad>>;
  readonly subjects: MutableHashMap.MutableHashMap<string, Term.Subject>;
  /** Blank nodes rendered inline as `[ ... ]` at their single reference. */
  readonly inline: StringSet;
  /** List heads rendered as `( ... )`, with their items. */
  readonly lists: MutableHashMap.MutableHashMap<string, ReadonlyArray<Term.Object>>;
  /** Blank nodes consumed as list cells (including heads). */
  readonly listCells: StringSet;
  /** Annotations keyed by the asserted quad's key. */
  readonly annotations: MutableHashMap.MutableHashMap<string, Array<Annotation>>;
  /** Blank reifiers rendered inside `{| ... |}` blocks. */
  readonly blockReifiers: StringSet;
  /** Reifiers referenced as `~ id`. */
  readonly idReifiers: StringSet;
  /** Blank reifiers rendered as `<< s p o >>` subjects. */
  readonly reifiedSubjects: MutableHashMap.MutableHashMap<string, Term.Triple>;
  /** Quads represented by syntax (annotations, lists) rather than written out (by identity). */
  readonly consumed: WeakSet<Term.Quad>;
}

/** Appends `value` to the list at `key`, creating the list on first use. */
const pushAt = <V>(
  map: MutableHashMap.MutableHashMap<string, Array<V>>,
  key: string,
  value: V,
): void => {
  const list = MutableHashMap.get(map, key);
  if (Option.isSome(list)) list.value.push(value);
  else MutableHashMap.set(map, key, [value]);
};

/**
 * Groups `values` by key, in order of first appearance, calling `onFirst`
 * with the first value of each group. A run of values with the same key
 * (statements arrive grouped) is appended without a lookup.
 */
const groupBy = <V>(
  values: ReadonlyArray<V>,
  keyOf: (value: V) => string,
  onFirst: (value: V, key: string) => void = () => undefined,
): MutableHashMap.MutableHashMap<string, Array<V>> => {
  const groups = MutableHashMap.empty<string, Array<V>>();
  let lastKey = '';
  let last: Array<V> = [];
  values.forEach((value) => {
    const key = keyOf(value);
    if (Arr.isReadonlyArrayNonEmpty(last) && key === lastKey) {
      last.push(value);
      return;
    }
    const found = MutableHashMap.get(groups, key);
    if (Option.isSome(found)) {
      found.value.push(value);
      last = found.value;
    } else {
      last = [value];
      MutableHashMap.set(groups, key, last);
      onFirst(value, key);
    }
    lastKey = key;
  });
  return groups;
};

/** The list at `key`, or an empty one. */
const listAt = <V>(
  map: MutableHashMap.MutableHashMap<string, Array<V>>,
  key: string,
): ReadonlyArray<V> => Option.getOrElse(MutableHashMap.get(map, key), () => []);

/** A declared prefix, with its index among the declarations. */
interface PrefixCandidate {
  readonly prefix: string;
  readonly ns: string;
  readonly index: number;
}

const byNamespaceLength: Order.Order<PrefixCandidate> = Order.flip(
  Order.mapInput(Order.Number, (c: PrefixCandidate) => c.ns.length),
);

/** `rdf:type` first (written `a`), then by IRI. */
const byVerb: Order.Order<string> = (a, b) =>
  a === RDF_TYPE ? -1 : b === RDF_TYPE ? 1 : a < b ? -1 : a > b ? 1 : 0;

// -----------------------------------------------------------------------------
// Writer
// -----------------------------------------------------------------------------

/** @internal */
export class Writer {
  private readonly prefixes: Array<readonly [string, string]>;
  /** Whether each of `prefixes` has been written. */
  private readonly usedPrefixes: Array<boolean> = [];
  /** The prefixes, longest namespace first (in declaration order for equal lengths). */
  private readonly byLength: ReadonlyArray<PrefixCandidate>;
  private readonly blanks = MutableHashMap.empty<string, BlankInfo>();
  /** The keys of the quads written, built when the first reifier is planned. */
  private assertedKeys: Option.Option<StringSet> = Option.none();
  private plan!: GraphPlan;
  private readonly labels = MutableHashMap.empty<string, string>();
  private rendered: StringSet = MutableHashSet.empty();

  readonly options: WriterOptions;
  private readonly quads: ReadonlyArray<Term.Quad>;
  private readonly relabel;
  constructor(options: WriterOptions, quads: ReadonlyArray<Term.Quad>, relabel = true) {
    this.options = options;
    this.quads = quads;
    this.relabel = relabel;
    const declared = MutableHashMap.empty<string, string>();
    if (options.autoPrefixes) {
      Arr.forEach(detectPrefixes(quads, options.baseIri), ([p, ns]) => {
        MutableHashMap.set(declared, p, ns);
      });
    }
    if (Option.isSome(options.prefixes)) {
      Iterable.forEach(PrefixMap.entries(options.prefixes.value), ([p, ns]) => {
        // A declared prefix replaces any detected one for the same namespace
        Arr.forEach(
          Arr.filter(Arr.fromIterable(declared), ([q, other]) => other === ns && q !== p),
          ([q]) => {
            MutableHashMap.remove(declared, q);
          },
        );
        MutableHashMap.set(declared, p, ns);
      });
    }
    this.prefixes = Arr.filter(
      Arr.fromIterable(declared),
      ([p, ns]) => isPrefixName(p) && Lexical.isWritableIri(ns),
    );
    this.byLength = Arr.sort(
      this.prefixes.map(([prefix, ns], index): PrefixCandidate => ({ prefix, ns, index })),
      byNamespaceLength,
    );
    if (Option.isSome(options.baseIri) && !Lexical.isWritableIri(options.baseIri.value)) {
      throw new SerializeFailure(`Invalid base IRI <${options.baseIri.value}>`);
    }
  }

  write(): string {
    this.quads.forEach((q) => {
      checkQuad(q, this.options.trig);
      this.index(q);
    });
    const names = MutableHashMap.empty<string, Term.Graph>();
    const byGraph = groupBy(
      this.quads,
      (q) => q.graph.key,
      (q, key) => MutableHashMap.set(names, key, q.graph),
    );
    const graphs = Arr.sort(
      Arr.fromIterable(names),
      Order.mapInput(compareTerms, ([, graph]: readonly [string, Term.Graph]) => graph),
    ).map(([key, graph]) => ({ graph, quads: listAt(byGraph, key) }));
    const body = Arr.reduce(graphs, '', (out, { graph, quads }) =>
      Term.isDefaultGraph(graph)
        ? out + this.writeGraph(graph, quads, 0)
        : // The graph name is labelled before its content
          `${out}${out === '' ? '' : '\n'}${this.term(graph)} {\n${this.writeGraph(graph, quads, 1)}}\n`,
    );
    return this.header() + body;
  }

  private asserted(): StringSet {
    if (Option.isSome(this.assertedKeys)) return this.assertedKeys.value;
    const keys: StringSet = MutableHashSet.empty();
    this.quads.forEach((q) => MutableHashSet.add(keys, q.key));
    this.assertedKeys = Option.some(keys);
    return keys;
  }

  private header(): string {
    const sparql = this.options.sparqlDirectives;
    const base = Option.match(this.options.baseIri, {
      onNone: () => '',
      onSome: (iri) =>
        sparql ? `BASE <${Term.escapeIri(iri)}>\n` : `@base <${Term.escapeIri(iri)}> .\n`,
    });
    const used = Arr.sort(
      this.prefixes.filter((_, i) => this.usedPrefixes[i] === true),
      byPrefixName,
    );
    const out =
      base +
      used
        .map(([p, ns]) =>
          sparql
            ? `PREFIX ${p}: <${Term.escapeIri(ns)}>\n`
            : `@prefix ${p}: <${Term.escapeIri(ns)}> .\n`,
        )
        .join('');
    return out === '' ? '' : `${out}\n`;
  }

  private info(b: Term.BlankNode): BlankInfo {
    const found = MutableHashMap.get(this.blanks, b.value);
    if (Option.isSome(found)) return found.value;
    const info: BlankInfo = {
      objectRefs: [],
      inTripleTerm: false,
      asGraph: false,
      subjectGraph: Option.none(),
      manyGraphs: false,
    };
    MutableHashMap.set(this.blanks, b.value, info);
    return info;
  }

  private index(q: Term.Quad): void {
    if (Term.isBlankNode(q.subject)) {
      const info = this.info(q.subject);
      if (Option.isNone(info.subjectGraph)) info.subjectGraph = Option.some(q.graph.key);
      else if (info.subjectGraph.value !== q.graph.key) info.manyGraphs = true;
    }
    if (Term.isBlankNode(q.object)) this.info(q.object).objectRefs.push(q);
    if (Term.isTriple(q.object)) {
      visitBlankNodes(q.object, (b) => {
        this.info(b).inTripleTerm = true;
      });
    }
    if (Term.isBlankNode(q.graph)) this.info(q.graph).asGraph = true;
  }

  /** Whether a blank node is local to `graph` and appears in no triple term or graph name. */
  private isLocal(b: Term.BlankNode, graph: Term.Graph): boolean {
    const info = this.info(b);
    return (
      !info.inTripleTerm &&
      !info.asGraph &&
      !info.manyGraphs &&
      (Option.isNone(info.subjectGraph) || info.subjectGraph.value === graph.key)
    );
  }

  private planGraph(
    graph: Term.Graph,
    quads: ReadonlyArray<Term.Quad>,
    demoted: StringSet,
  ): GraphPlan {
    const subjects = MutableHashMap.empty<string, Term.Subject>();
    const bySubject = groupBy(
      quads,
      (q) => q.subject.key,
      (q, key) => MutableHashMap.set(subjects, key, q.subject),
    );
    const consumed = new WeakSet<Term.Quad>();

    // Blank nodes referenced exactly once (as an object, in this graph), rendered inline.
    const inline: StringSet = MutableHashSet.empty();
    quads.forEach((q) => {
      const o = q.object;
      if (!Term.isBlankNode(o) || MutableHashSet.has(demoted, o.value) || !this.isLocal(o, graph))
        return;
      const refs = this.info(o).objectRefs;
      if (refs.length === 1 && refs[0]?.graph.key === graph.key)
        MutableHashSet.add(inline, o.value);
    });

    // Well-formed collections.
    const lists = MutableHashMap.empty<string, ReadonlyArray<Term.Object>>();
    const listCells: StringSet = MutableHashSet.empty();
    const listShape = (label: string): Option.Option<readonly [Term.Object, Term.Object]> => {
      if (!MutableHashSet.has(inline, label)) return Option.none();
      const own = listAt(bySubject, `_:${label}`);
      if (own.length !== 2) return Option.none();
      const first = Arr.findFirst(own, (q) => q.predicate.value === RDF_FIRST);
      const rest = Arr.findFirst(own, (q) => q.predicate.value === RDF_REST);
      return Option.isSome(first) && Option.isSome(rest)
        ? Option.some<readonly [Term.Object, Term.Object]>([first.value.object, rest.value.object])
        : Option.none();
    };
    Iterable.forEach(inline, (label) => {
      if (Option.isNone(listShape(label))) return;
      const ref = Arr.head(this.info(Term.blankNode(label)).objectRefs);
      // Not the tail of another list cell.
      if (
        Option.isNone(ref) ||
        (ref.value.predicate.value === RDF_REST &&
          Term.isBlankNode(ref.value.subject) &&
          Option.isSome(listShape(ref.value.subject.value)))
      ) {
        return;
      }
      const items: Array<Term.Object> = [];
      const cells: Array<string> = [];
      let current: string = label;
      let ok = false;
      loop(() => {
        const shape = listShape(current);
        if (Option.isNone(shape) || cells.includes(current)) return false;
        const [item, next] = shape.value;
        cells.push(current);
        items.push(item);
        if (Term.isNamedNode(next) && next.value === RDF_NIL) {
          ok = true;
          return false;
        }
        if (!Term.isBlankNode(next)) return false;
        current = next.value;
        return true;
      });
      if (!ok) return;
      MutableHashMap.set(lists, label, items);
      Arr.forEach(cells, (cell) => {
        MutableHashSet.add(listCells, cell);
        Arr.forEach(listAt(bySubject, `_:${cell}`), (q) => {
          consumed.add(q);
        });
      });
    });

    // Annotations and reified-triple subjects.
    const annotations = MutableHashMap.empty<string, Array<Annotation>>();
    const blockReifiers: StringSet = MutableHashSet.empty();
    const reifiedSubjects = MutableHashMap.empty<string, Term.Triple>();
    const idReifiers: StringSet = MutableHashSet.empty();
    /** A blank reifier of nothing else, described only here: written as a block or a subject. */
    const isStandalone = (r: Term.BlankNode): boolean =>
      !MutableHashSet.has(demoted, r.value) &&
      this.isLocal(r, graph) &&
      Arr.isReadonlyArrayEmpty(this.info(r).objectRefs) &&
      listAt(bySubject, r.key).filter((x) => x.predicate.value === RDF_REIFIES && !consumed.has(x))
        .length === 1;
    quads.forEach((q) => {
      if (q.predicate.value !== RDF_REIFIES || !Term.isTriple(q.object)) return;
      const t = q.object;
      if (Term.isTriple(t.subject)) return;
      const r = q.subject;
      if (Term.isTriple(r)) return;
      const assertedKey = new Term.Quad(t.subject, t.predicate, t.object, graph).key;
      const isAsserted = MutableHashSet.has(this.asserted(), assertedKey);
      if (Term.isBlankNode(r) && isStandalone(r)) {
        consumed.add(q);
        if (isAsserted) {
          MutableHashSet.add(blockReifiers, r.value);
          pushAt(annotations, assertedKey, { _tag: 'Block', reifier: r });
        } else {
          MutableHashMap.set(reifiedSubjects, r.value, t);
        }
      } else if (
        isAsserted &&
        (Term.isNamedNode(r) ||
          (!MutableHashSet.has(inline, r.value) && !MutableHashSet.has(listCells, r.value)))
      ) {
        consumed.add(q);
        if (Term.isBlankNode(r)) MutableHashSet.add(idReifiers, r.value);
        pushAt(annotations, assertedKey, { _tag: 'Id', reifier: r });
      }
    });

    return {
      graph,
      bySubject,
      subjects,
      inline,
      lists,
      listCells,
      annotations,
      blockReifiers,
      idReifiers,
      reifiedSubjects,
      consumed,
    };
  }

  private writeGraph(graph: Term.Graph, quads: ReadonlyArray<Term.Quad>, level: number): string {
    // Inline blank nodes and lists that rendering did not reach are written out, and re-planned
    const demoted: StringSet = MutableHashSet.empty();
    let out = '';
    loop(() => {
      this.plan = this.planGraph(graph, quads, demoted);
      this.rendered = MutableHashSet.empty();
      out = this.renderGraph(level);
      const before = MutableHashSet.size(demoted);
      Iterable.forEach(this.plan.inline, (label) => {
        if (
          !MutableHashSet.has(this.rendered, label) &&
          !MutableHashSet.has(this.plan.listCells, label)
        ) {
          MutableHashSet.add(demoted, label);
        }
      });
      Iterable.forEach(MutableHashMap.keys(this.plan.lists), (label) => {
        if (!MutableHashSet.has(this.rendered, label)) MutableHashSet.add(demoted, label);
      });
      return MutableHashSet.size(demoted) !== before;
    });
    return out;
  }

  private renderGraph(level: number): string {
    const plan = this.plan;
    const unsorted = Arr.filter(
      Arr.fromIterable(MutableHashMap.values(plan.subjects)),
      (s) =>
        !(
          Term.isBlankNode(s) &&
          (MutableHashSet.has(plan.inline, s.value) ||
            MutableHashSet.has(plan.listCells, s.value) ||
            MutableHashSet.has(plan.blockReifiers, s.value))
        ),
    );
    const roots = Arr.sort(unsorted, compareTerms);
    const blocks = Arr.flatMap(roots, (s): ReadonlyArray<string> => {
      const quads = listAt(plan.bySubject, s.key).filter((q) => !plan.consumed.has(q));
      const reified = Term.isBlankNode(s)
        ? MutableHashMap.get(plan.reifiedSubjects, s.value)
        : Option.none<Term.Triple>();
      const head = Option.isSome(reified) ? this.reifiedTriple(reified.value) : this.term(s);
      if (Arr.isReadonlyArrayEmpty(quads)) {
        return Option.isSome(reified) ? [`${this.pad(level)}${head} .\n`] : [];
      }
      if (
        Term.isBlankNode(s) &&
        Option.isNone(reified) &&
        !MutableHashSet.has(plan.idReifiers, s.value) &&
        Arr.isReadonlyArrayEmpty(this.info(s).objectRefs) &&
        this.isLocal(s, plan.graph)
      ) {
        // An unreferenced blank node: `[ p o ] .`
        return [`${this.pad(level)}${this.bracketed('[', ']', quads, level)} .\n`];
      }
      return [`${this.pad(level)}${head} ${this.predicateObjectList(quads, level + 1)} .\n`];
    });
    return blocks.join(level === 0 ? '\n' : '');
  }

  private pad(level: number): string {
    return this.options.indent.repeat(level);
  }

  /** Renders `p o, o ; p o` with continuation lines at `level`. */
  private predicateObjectList(quads: ReadonlyArray<Term.Quad>, level: number): string {
    const byPredicate = groupBy(quads, (q) => q.predicate.value);
    const predicates = Arr.sort(
      byPredicate,
      Order.mapInput(byVerb, ([p]: readonly [string, Array<Term.Quad>]) => p),
    );
    const parts = predicates.map(([p, list]) => {
      const objects = Arr.sort(
        list,
        Order.mapInput(compareTerms, (q: Term.Quad) => q.object),
      ).map((q) => this.objectWithAnnotations(q, level));
      const verb = p === RDF_TYPE ? 'a' : this.iri(p);
      return `${verb} ${objects.join(', ')}`;
    });
    return parts.join(` ;\n${this.pad(level)}`);
  }

  private objectWithAnnotations(q: Term.Quad, level: number): string {
    let out = this.object(q.object, level);
    const annotations = MutableHashMap.get(this.plan.annotations, q.key);
    if (Option.isNone(annotations)) return out;
    // An annotation block directly after a reifier would describe that
    // reifier, so blocks come first, then bare `~`, then `~ id`.
    let bare = '';
    let ids = '';
    Arr.forEach(
      Arr.sort(
        annotations.value,
        Order.mapInput(compareTerms, (x: Annotation) => x.reifier),
      ),
      (annotation) => {
        if (isIdAnnotation(annotation)) {
          ids += ` ~ ${this.term(annotation.reifier)}`;
          return;
        }
        const own = listAt(this.plan.bySubject, annotation.reifier.key).filter(
          (x) => !this.plan.consumed.has(x),
        );
        if (Arr.isReadonlyArrayEmpty(own)) bare += ' ~';
        else out += ` ${this.bracketed('{|', '|}', own, level)}`;
      },
    );
    return out + bare + ids;
  }

  /** Renders a bracketed property list (`[ ... ]` or `{| ... |}`). */
  private bracketed(
    open: string,
    close: string,
    quads: ReadonlyArray<Term.Quad>,
    level: number,
  ): string {
    const single = this.predicateObjectList(quads, level + 1);
    if (!single.includes('\n') && single.length <= 60) return `${open} ${single} ${close}`;
    return `${open}\n${this.pad(level + 1)}${single}\n${this.pad(level)}${close}`;
  }

  private object(o: Term.Object, level: number): string {
    if (Term.isBlankNode(o)) {
      const items = MutableHashMap.get(this.plan.lists, o.value);
      if (Option.isSome(items) && !MutableHashSet.has(this.rendered, o.value)) {
        MutableHashSet.add(this.rendered, o.value);
        const rendered = items.value.map((item) => this.object(item, level));
        const oneLine = `( ${rendered.join(' ')} )`;
        return oneLine.length <= 80 && !oneLine.includes('\n')
          ? oneLine
          : `(\n${rendered.map((r) => this.pad(level + 1) + r).join('\n')}\n${this.pad(level)})`;
      }
      if (
        MutableHashSet.has(this.plan.inline, o.value) &&
        !MutableHashSet.has(this.rendered, o.value)
      ) {
        MutableHashSet.add(this.rendered, o.value);
        const own = listAt(this.plan.bySubject, o.key).filter((x) => !this.plan.consumed.has(x));
        if (Arr.isReadonlyArrayEmpty(own)) return '[]';
        const only = own.length === 1 ? Arr.head(own) : Option.none<Term.Quad>();
        if (
          Option.isSome(only) &&
          only.value.predicate.value === RDF_REIFIES &&
          Term.isTriple(only.value.object) &&
          !Term.isTriple(only.value.object.subject)
        ) {
          // A blank node whose only statement reifies a triple: `<< s p o >>`.
          return this.reifiedTriple(only.value.object);
        }
        return this.bracketed('[', ']', own, level);
      }
    }
    if (Term.isNamedNode(o) && o.value === RDF_NIL) return '()';
    return this.term(o);
  }

  private reifiedTriple(t: Term.Triple): string {
    return `<< ${this.term(t.subject)} ${this.predicate(t.predicate)} ${this.term(t.object)} >>`;
  }

  private predicate(p: Term.NamedNode): string {
    return p.value === RDF_TYPE ? 'a' : this.iri(p.value);
  }

  /** Renders a term without any abbreviation that depends on context. */
  term(t: Term.Term): string {
    // Plain guards rather than a `Match`: this runs for every term written
    if (Term.isNamedNode(t)) return this.iri(t.value);
    if (Term.isBlankNode(t)) return `_:${this.label(t.value)}`;
    if (Term.isLiteral(t)) return this.literal(t);
    if (Term.isTriple(t)) {
      return `<<( ${this.term(t.subject)} ${this.predicate(t.predicate)} ${this.term(t.object)} )>>`;
    }
    throw new SerializeFailure(`Cannot serialise ${t._tag}`);
  }

  /** Output labels are assigned in order of first appearance. */
  private label(value: string): string {
    if (!this.relabel) return Lexical.blankNodeLabel(value);
    const found = MutableHashMap.get(this.labels, value);
    if (Option.isSome(found)) return found.value;
    const label = `b${MutableHashMap.size(this.labels)}`;
    MutableHashMap.set(this.labels, value, label);
    return label;
  }

  private literal(l: Term.Literal): string {
    const dt = l.datatype.value;
    if (l.language === '') {
      if (
        (dt === XSD_INTEGER && INTEGER.test(l.value)) ||
        (dt === XSD_DECIMAL && DECIMAL.test(l.value)) ||
        (dt === XSD_DOUBLE && DOUBLE.test(l.value)) ||
        (dt === XSD_BOOLEAN && (l.value === 'true' || l.value === 'false'))
      ) {
        return l.value;
      }
    }
    const lexical = quoteString(l.value);
    if (l.language !== '') {
      const language = l.language.toLowerCase();
      return l.direction === undefined
        ? `${lexical}@${language}`
        : `${lexical}@${language}--${l.direction}`;
    }
    if (dt === Term.XSD_STRING) return lexical;
    return `${lexical}^^${this.iri(dt)}`;
  }

  iri(iri: string): string {
    if (!Lexical.isWritableIri(iri)) throw new SerializeFailure(`Invalid or relative IRI <${iri}>`);
    // The longest namespace whose local part can be written as a prefixed name
    const best = this.byLength.find(
      (c) => iri.startsWith(c.ns) && Option.isSome(encodeLocalName(iri.slice(c.ns.length))),
    );
    if (best !== undefined) {
      this.usedPrefixes[best.index] = true;
      return `${best.prefix}:${Option.getOrElse(encodeLocalName(iri.slice(best.ns.length)), () => '')}`;
    }
    if (Option.isSome(this.options.baseIri)) {
      const relative = Iri.relativize(iri, this.options.baseIri.value);
      if (Option.isSome(relative)) return `<${Term.escapeIri(relative.value)}>`;
    }
    return `<${Term.escapeIri(iri)}>`;
  }
}

/** Term kinds in writing order; anything else (a variable) sorts last. */
const tagRank: Record.ReadonlyRecord<string, number> = {
  DefaultGraph: 0,
  NamedNode: 1,
  BlankNode: 2,
  Literal: 3,
  Triple: 4,
};

/** The value of a numeric literal, or `NaN`. */
const numericValue = (l: Term.Literal): number => {
  const dt = l.datatype.value;
  return dt === XSD_INTEGER || dt === XSD_DECIMAL || dt === XSD_DOUBLE ? Number(l.value) : NaN;
};

const compareTerms: Order.Order<Term.Term> = (a, b) => {
  const ra = tagRank[a._tag] ?? 5;
  const rb = tagRank[b._tag] ?? 5;
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (Term.isLiteral(a) && Term.isLiteral(b)) {
    const na = numericValue(a);
    const nb = numericValue(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na < nb ? -1 : 1;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
};

/** Prefix declarations by prefix name. */
export const byPrefixName: Order.Order<readonly [string, string]> = Order.mapInput(
  Order.String,
  ([prefix]: readonly [string, string]) => prefix,
);

/** Counts the namespaces of the IRIs in `t` (and in its datatype and triple terms). */
const countNamespaces = (
  t: Term.Term,
  counts: MutableHashMap.MutableHashMap<string, { count: number }>,
): void => {
  // Plain guards rather than a `Match`: this runs for every term of every quad
  if (Term.isNamedNode(t)) {
    const i = Math.max(t.value.lastIndexOf('#'), t.value.lastIndexOf('/'));
    if (i <= 0) return;
    const ns = t.value.slice(0, i + 1);
    if (!Lexical.isAbsoluteIri(ns) || Option.isNone(encodeLocalName(t.value.slice(i + 1)))) {
      return;
    }
    const found = MutableHashMap.get(counts, ns);
    if (Option.isSome(found)) found.value.count += 1;
    else MutableHashMap.set(counts, ns, { count: 1 });
  } else if (Term.isLiteral(t)) {
    if (t.language === '' && t.datatype.value !== Term.XSD_STRING) {
      countNamespaces(t.datatype, counts);
    }
  } else if (Term.isTriple(t)) {
    countNamespaces(t.subject, counts);
    countNamespaces(t.predicate, counts);
    countNamespaces(t.object, counts);
  }
};

/** Well-known namespaces by IRI, with their usual prefixes. */
const knownPrefixes = MutableHashMap.fromIterable(
  Record.toEntries(commonPrefixes).map(([p, ns]): readonly [string, string] => [ns, p]),
);

/**
 * Finds namespaces worth declaring: well-known vocabularies that are used,
 * plus any namespace used by at least two IRIs.
 */
const detectPrefixes = (
  quads: ReadonlyArray<Term.Quad>,
  baseIri: Option.Option<string>,
): Array<readonly [string, string]> => {
  // Namespaces under the base IRI are better written as relative IRIs.
  const baseDir = Option.map(baseIri, (iri) => iri.slice(0, iri.lastIndexOf('/') + 1));
  const counts = MutableHashMap.empty<string, { count: number }>();
  quads.forEach((q) => {
    countNamespaces(q.subject, counts);
    countNamespaces(q.predicate, counts);
    countNamespaces(q.object, counts);
    countNamespaces(q.graph, counts);
  });
  let n = 0;
  return Arr.flatMap(
    Arr.sort(
      counts,
      Order.mapInput(Order.String, ([ns]: readonly [string, { count: number }]) => ns),
    ),
    ([ns, { count }]): ReadonlyArray<readonly [string, string]> => {
      const name = MutableHashMap.get(knownPrefixes, ns);
      if (Option.isSome(name)) return [[name.value, ns]];
      if (Option.isSome(baseDir) && baseDir.value.includes('//') && ns.startsWith(baseDir.value)) {
        return [];
      }
      return count >= 2 ? [[`ns${n++}`, ns]] : [];
    },
  );
};

/**
 * Normalises quads for writing: relabels blank nodes deterministically.
 *
 * @internal
 */
export const prepare = (quads: Iterable<Term.Quad>): ReadonlyArray<Term.Quad> =>
  Array.from(Isomorphism.relabel(Dataset.fromIterable(quads), 'b'));
