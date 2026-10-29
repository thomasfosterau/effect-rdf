/**
 * Pretty-printing writer shared by the Turtle and TriG serializers.
 *
 * @internal
 */
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as Isomorphism from '@thomasfosterau/effect-rdf/Isomorphism';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { commonPrefixes, rdf, xsd } from '@thomasfosterau/effect-rdf/Vocab';
import * as Lexical from '@thomasfosterau/effect-ntriples/Lexical';
import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';

/** @internal */
export class SerializeFailure extends Error {}

/** @internal */
export interface WriterOptions {
  readonly trig: boolean;
  readonly prefixes: PrefixMap.PrefixMap | undefined;
  readonly baseIri: string | undefined;
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
const LOCAL_ESCAPABLE = new Set("_~.-!$&'()*+,;=@");

// -----------------------------------------------------------------------------
// Lexical helpers
// -----------------------------------------------------------------------------

/** Whether `prefix` is a valid `PN_PREFIX` (or empty). */
export const isPrefixName = (prefix: string): boolean => {
  if (prefix === '') return true;
  const chars = Array.from(prefix, (ch) => ch.codePointAt(0)!);
  if (!Lexical.isPnCharsBase(chars[0]!)) return false;
  if (chars[chars.length - 1] === 0x2e) return false;
  return chars.every((c) => Lexical.isPnChars(c) || c === 0x2e);
};

/** Encodes a local name as `PN_LOCAL`, or returns `undefined` if it cannot be. */
export const encodeLocalName = (local: string): string | undefined => {
  let out = '';
  const chars = Array.from(local);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const c = ch.codePointAt(0)!;
    const first = i === 0;
    const last = i === chars.length - 1;
    const plain = first
      ? Lexical.isPnCharsU(c) || c === 0x3a || Lexical.isDigit(c)
      : Lexical.isPnChars(c) || c === 0x3a || (c === 0x2e && !last);
    if (plain) {
      out += ch;
    } else if (
      c === 0x25 &&
      i + 2 < chars.length &&
      Lexical.isHex(chars[i + 1]!.charCodeAt(0)) &&
      Lexical.isHex(chars[i + 2]!.charCodeAt(0))
    ) {
      out += ch + chars[i + 1]! + chars[i + 2]!;
      i += 2;
    } else if (LOCAL_ESCAPABLE.has(ch)) {
      out += `\\${ch}`;
    } else {
      return undefined;
    }
  }
  return out;
};

const hex4 = (c: number): string => `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`;

/** Formats a string as a Turtle string literal, using `"""` for multi-line text. */
export const quoteString = (value: string): string => {
  if (!value.includes('\n')) return `"${Term.escapeString(value)}"`;
  let out = '"""';
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n' || ch === '\t') out += ch;
    else if (ch === '\r') out += '\\r';
    else if (c < 0x20 || c === 0x7f || c === 0xfffe || c === 0xffff) out += hex4(c);
    else out += ch;
  }
  return `${out}"""`;
};

// -----------------------------------------------------------------------------
// Analysis
// -----------------------------------------------------------------------------

interface BlankInfo {
  objectRefs: Array<Term.Quad>;
  inTripleTerm: boolean;
  asGraph: boolean;
  subjectGraphs: Set<string>;
}

const visitTripleTerm = (t: Term.Triple, f: (b: Term.BlankNode) => void): void => {
  for (const x of [t.subject, t.object]) {
    if (x._tag === 'BlankNode') f(x);
    else if (x._tag === 'Triple') visitTripleTerm(x, f);
  }
};

/** @internal */
export const checkQuad = (q: Term.Quad, trig: boolean): void => {
  const checkTriple = (t: Term.Triple): void => {
    if (t.subject._tag === 'Triple') {
      throw new SerializeFailure(
        `Triple terms cannot be the subject of a triple term in Turtle 1.2: ${t.key}`,
      );
    }
    if (t.object._tag === 'Triple') checkTriple(t.object);
  };
  if (q.subject._tag === 'Triple') {
    throw new SerializeFailure(`Triple terms cannot be subjects in Turtle 1.2: ${q.key}`);
  }
  if (!Term.isGround(q)) throw new SerializeFailure(`Cannot serialise non-ground quad ${q.key}`);
  if (q.object._tag === 'Triple') checkTriple(q.object);
  if (!trig && q.graph._tag !== 'DefaultGraph') {
    throw new SerializeFailure(`Turtle cannot represent quads in named graphs: ${q.key}`);
  }
};

type Annotation =
  | { readonly _tag: 'Block'; readonly reifier: Term.BlankNode }
  | { readonly _tag: 'Id'; readonly reifier: Term.NamedNode | Term.BlankNode };

interface GraphPlan {
  readonly graph: Term.Graph;
  readonly bySubject: Map<string, Array<Term.Quad>>;
  readonly subjects: Map<string, Term.Subject>;
  /** Blank nodes rendered inline as `[ ... ]` at their single reference. */
  readonly inline: Set<string>;
  /** List heads rendered as `( ... )`, with their items. */
  readonly lists: Map<string, ReadonlyArray<Term.Object>>;
  /** Blank nodes consumed as list cells (including heads). */
  readonly listCells: Set<string>;
  /** Annotations keyed by the asserted quad's key. */
  readonly annotations: Map<string, Array<Annotation>>;
  /** Blank reifiers rendered inside `{| ... |}` blocks. */
  readonly blockReifiers: Set<string>;
  /** Reifiers referenced as `~ id`. */
  readonly idReifiers: Set<string>;
  /** Blank reifiers rendered as `<< s p o >>` subjects. */
  readonly reifiedSubjects: Map<string, Term.Triple>;
  /** Quads represented by syntax (annotations, lists) rather than written out. */
  readonly consumed: Set<string>;
}

// -----------------------------------------------------------------------------
// Writer
// -----------------------------------------------------------------------------

/** @internal */
export class Writer {
  private readonly prefixes: Array<readonly [string, string]>;
  private readonly usedPrefixes = new Set<string>();
  private readonly blanks = new Map<string, BlankInfo>();
  private readonly asserted = new Set<string>();
  private plan!: GraphPlan;
  private readonly labels = new Map<string, string>();
  private rendered = new Set<string>();

  readonly options: WriterOptions;
  private readonly quads: ReadonlyArray<Term.Quad>;
  private readonly relabel;
  constructor(options: WriterOptions, quads: ReadonlyArray<Term.Quad>, relabel = true) {
    this.options = options;
    this.quads = quads;
    this.relabel = relabel;
    const declared = new Map<string, string>();
    if (options.autoPrefixes) {
      for (const [p, ns] of detectPrefixes(quads, options.baseIri)) declared.set(p, ns);
    }
    if (options.prefixes !== undefined) {
      for (const [p, ns] of options.prefixes.prefixes) {
        for (const [q, other] of declared) if (other === ns && q !== p) declared.delete(q);
        declared.set(p, ns);
      }
    }
    this.prefixes = Array.from(declared).filter(
      ([p, ns]) => isPrefixName(p) && Lexical.isWritableIri(ns),
    );
    if (options.baseIri !== undefined && !Lexical.isWritableIri(options.baseIri)) {
      throw new SerializeFailure(`Invalid base IRI <${options.baseIri}>`);
    }
  }

  write(): string {
    const byGraph = new Map<string, { graph: Term.Graph; quads: Array<Term.Quad> }>();
    for (const q of this.quads) {
      checkQuad(q, this.options.trig);
      this.asserted.add(q.key);
      let entry = byGraph.get(q.graph.key);
      if (entry === undefined) byGraph.set(q.graph.key, (entry = { graph: q.graph, quads: [] }));
      entry.quads.push(q);
      this.index(q);
    }
    const graphs = Arr.sort(
      byGraph.values(),
      Order.mapInput(compareTerms, (g: { readonly graph: Term.Graph }) => g.graph),
    );
    let body = '';
    for (const { graph, quads } of graphs) {
      const name = graph._tag === 'DefaultGraph' ? '' : this.term(graph);
      const content = this.writeGraph(graph, quads, graph._tag === 'DefaultGraph' ? 0 : 1);
      if (graph._tag === 'DefaultGraph') {
        body += content;
      } else {
        body += `${body === '' ? '' : '\n'}${name} {\n${content}}\n`;
      }
    }
    return this.header() + body;
  }

  private header(): string {
    let out = '';
    const sparql = this.options.sparqlDirectives;
    if (this.options.baseIri !== undefined) {
      out += sparql
        ? `BASE <${Term.escapeIri(this.options.baseIri)}>\n`
        : `@base <${Term.escapeIri(this.options.baseIri)}> .\n`;
    }
    const used = Arr.sort(
      this.prefixes.filter(([p]) => this.usedPrefixes.has(p)),
      byPrefixName,
    );
    for (const [p, ns] of used) {
      out += sparql
        ? `PREFIX ${p}: <${Term.escapeIri(ns)}>\n`
        : `@prefix ${p}: <${Term.escapeIri(ns)}> .\n`;
    }
    return out === '' ? '' : `${out}\n`;
  }

  private info(b: Term.BlankNode): BlankInfo {
    let info = this.blanks.get(b.value);
    if (info === undefined) {
      info = { objectRefs: [], inTripleTerm: false, asGraph: false, subjectGraphs: new Set() };
      this.blanks.set(b.value, info);
    }
    return info;
  }

  private index(q: Term.Quad): void {
    if (q.subject._tag === 'BlankNode') this.info(q.subject).subjectGraphs.add(q.graph.key);
    if (q.object._tag === 'BlankNode') this.info(q.object).objectRefs.push(q);
    if (q.object._tag === 'Triple') {
      visitTripleTerm(q.object, (b) => {
        this.info(b).inTripleTerm = true;
      });
    }
    if (q.graph._tag === 'BlankNode') this.info(q.graph).asGraph = true;
  }

  /** Whether a blank node is local to `graph` and appears in no triple term or graph name. */
  private isLocal(b: Term.BlankNode, graph: Term.Graph): boolean {
    const info = this.info(b);
    if (info.inTripleTerm || info.asGraph) return false;
    for (const g of info.subjectGraphs) if (g !== graph.key) return false;
    return true;
  }

  private planGraph(
    graph: Term.Graph,
    quads: ReadonlyArray<Term.Quad>,
    demoted: ReadonlySet<string>,
  ): GraphPlan {
    const bySubject = new Map<string, Array<Term.Quad>>();
    const subjects = new Map<string, Term.Subject>();
    for (const q of quads) {
      let list = bySubject.get(q.subject.key);
      if (list === undefined) {
        bySubject.set(q.subject.key, (list = []));
        subjects.set(q.subject.key, q.subject);
      }
      list.push(q);
    }
    const consumed = new Set<string>();
    const inline = new Set<string>();

    // Blank nodes referenced exactly once (as an object, in this graph).
    const candidates = new Set<string>();
    const consider = (b: Term.BlankNode) => {
      if (demoted.has(b.value) || !this.isLocal(b, graph)) return;
      const refs = this.info(b).objectRefs;
      if (refs.length === 1 && refs[0]!.graph.key === graph.key) candidates.add(b.value);
    };
    for (const q of quads) if (q.object._tag === 'BlankNode') consider(q.object);
    for (const c of candidates) inline.add(c);

    // Well-formed collections.
    const lists = new Map<string, ReadonlyArray<Term.Object>>();
    const listCells = new Set<string>();
    const listShape = (label: string): readonly [Term.Object, Term.Object] | undefined => {
      if (!candidates.has(label)) return undefined;
      const own = bySubject.get(`_:${label}`) ?? [];
      if (own.length !== 2) return undefined;
      const first = own.find((q) => q.predicate.value === RDF_FIRST);
      const rest = own.find((q) => q.predicate.value === RDF_REST);
      if (first === undefined || rest === undefined) return undefined;
      return [first.object, rest.object];
    };
    for (const label of candidates) {
      const shape = listShape(label);
      if (shape === undefined) continue;
      const ref = this.info(Term.blankNode(label)).objectRefs[0]!;
      // Not the tail of another list cell.
      if (
        ref.predicate.value === RDF_REST &&
        ref.subject._tag === 'BlankNode' &&
        listShape(ref.subject.value) !== undefined
      ) {
        continue;
      }
      const items: Array<Term.Object> = [];
      const cells: Array<string> = [];
      let current: string = label;
      let ok = false;
      for (;;) {
        const s = listShape(current);
        if (s === undefined || cells.includes(current)) break;
        cells.push(current);
        items.push(s[0]);
        const next = s[1];
        if (next._tag === 'NamedNode' && next.value === RDF_NIL) {
          ok = true;
          break;
        }
        if (next._tag !== 'BlankNode') break;
        current = next.value;
      }
      if (!ok) continue;
      lists.set(label, items);
      for (const cell of cells) {
        listCells.add(cell);
        for (const q of bySubject.get(`_:${cell}`)!) consumed.add(q.key);
      }
    }

    // Annotations and reified-triple subjects.
    const annotations = new Map<string, Array<Annotation>>();
    const blockReifiers = new Set<string>();
    const reifiedSubjects = new Map<string, Term.Triple>();
    const idReifiers = new Set<string>();
    const addAnnotation = (key: string, a: Annotation) => {
      let list = annotations.get(key);
      if (list === undefined) annotations.set(key, (list = []));
      list.push(a);
    };
    for (const q of quads) {
      if (q.predicate.value !== RDF_REIFIES || q.object._tag !== 'Triple') continue;
      const t = q.object;
      if (t.subject._tag === 'Triple') continue;
      const r = q.subject;
      if (r._tag === 'Triple') continue;
      const assertedKey = new Term.Quad(t.subject, t.predicate, t.object, graph).key;
      const isAsserted = this.asserted.has(assertedKey);
      const standalone =
        r._tag === 'BlankNode' &&
        !demoted.has(r.value) &&
        this.isLocal(r, graph) &&
        Arr.isReadonlyArrayEmpty(this.info(r).objectRefs) &&
        bySubject
          .get(r.key)!
          .filter((x) => x.predicate.value === RDF_REIFIES && !consumed.has(x.key)).length === 1;
      if (standalone && r._tag === 'BlankNode') {
        consumed.add(q.key);
        if (isAsserted) {
          blockReifiers.add(r.value);
          addAnnotation(assertedKey, { _tag: 'Block', reifier: r });
        } else {
          reifiedSubjects.set(r.value, t);
        }
      } else if (
        isAsserted &&
        (r._tag === 'NamedNode' || (!inline.has(r.value) && !listCells.has(r.value)))
      ) {
        consumed.add(q.key);
        if (r._tag === 'BlankNode') idReifiers.add(r.value);
        addAnnotation(assertedKey, { _tag: 'Id', reifier: r });
      }
    }

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
    const demoted = new Set<string>();
    for (;;) {
      this.plan = this.planGraph(graph, quads, demoted);
      this.rendered = new Set();
      const out = this.renderGraph(level);
      let changed = false;
      for (const label of this.plan.inline) {
        if (!this.rendered.has(label) && !this.plan.listCells.has(label)) {
          demoted.add(label);
          changed = true;
        }
      }
      for (const label of this.plan.lists.keys()) {
        if (!this.rendered.has(label)) {
          demoted.add(label);
          changed = true;
        }
      }
      if (!changed) return out;
    }
  }

  private renderGraph(level: number): string {
    const plan = this.plan;
    const unsorted = Array.from(plan.subjects.values()).filter(
      (s) =>
        !(
          s._tag === 'BlankNode' &&
          (plan.inline.has(s.value) ||
            plan.listCells.has(s.value) ||
            plan.blockReifiers.has(s.value))
        ),
    );
    const roots = Arr.sort(unsorted, compareTerms);
    const blocks: Array<string> = [];
    for (const s of roots) {
      const quads = plan.bySubject.get(s.key)!.filter((q) => !plan.consumed.has(q.key));
      const reified = s._tag === 'BlankNode' ? plan.reifiedSubjects.get(s.value) : undefined;
      const head = reified !== undefined ? this.reifiedTriple(reified) : this.term(s);
      if (Arr.isReadonlyArrayEmpty(quads)) {
        if (reified !== undefined) blocks.push(`${this.pad(level)}${head} .\n`);
        continue;
      }
      if (
        s._tag === 'BlankNode' &&
        reified === undefined &&
        !plan.idReifiers.has(s.value) &&
        Arr.isReadonlyArrayEmpty(this.info(s).objectRefs) &&
        this.isLocal(s, plan.graph)
      ) {
        // An unreferenced blank node: `[ p o ] .`
        blocks.push(`${this.pad(level)}${this.bracketed('[', ']', quads, level)} .\n`);
        continue;
      }
      blocks.push(`${this.pad(level)}${head} ${this.predicateObjectList(quads, level + 1)} .\n`);
    }
    return blocks.join(level === 0 ? '\n' : '');
  }

  private pad(level: number): string {
    return this.options.indent.repeat(level);
  }

  /** Renders `p o, o ; p o` with continuation lines at `level`. */
  private predicateObjectList(quads: ReadonlyArray<Term.Quad>, level: number): string {
    const byPredicate = new Map<string, Array<Term.Quad>>();
    for (const q of quads) {
      let list = byPredicate.get(q.predicate.value);
      if (list === undefined) byPredicate.set(q.predicate.value, (list = []));
      list.push(q);
    }
    // `rdf:type` first (written `a`), then by IRI.
    const predicates = Arr.sort(
      byPredicate.keys(),
      Order.make((a: string, b: string) =>
        a === RDF_TYPE ? -1 : b === RDF_TYPE ? 1 : a < b ? -1 : a > b ? 1 : 0,
      ),
    );
    const parts = predicates.map((p) => {
      const objects = Arr.sort(
        byPredicate.get(p)!,
        Order.mapInput(compareTerms, (q: Term.Quad) => q.object),
      ).map((q) => this.objectWithAnnotations(q, level));
      const verb = p === RDF_TYPE ? 'a' : this.iri(p);
      return `${verb} ${objects.join(', ')}`;
    });
    return parts.join(` ;\n${this.pad(level)}`);
  }

  private objectWithAnnotations(q: Term.Quad, level: number): string {
    let out = this.object(q.object, level);
    const annotations = this.plan.annotations.get(q.key);
    if (annotations === undefined) return out;
    // An annotation block directly after a reifier would describe that
    // reifier, so blocks come first, then bare `~`, then `~ id`.
    let bare = '';
    let ids = '';
    for (const a of Arr.sort(
      annotations,
      Order.mapInput(compareTerms, (a: Annotation) => a.reifier),
    )) {
      if (a._tag === 'Id') {
        ids += ` ~ ${this.term(a.reifier)}`;
      } else {
        const own = (this.plan.bySubject.get(a.reifier.key) ?? []).filter(
          (x) => !this.plan.consumed.has(x.key),
        );
        if (Arr.isReadonlyArrayEmpty(own)) bare += ' ~';
        else out += ` ${this.bracketed('{|', '|}', own, level)}`;
      }
    }
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
    if (o._tag === 'BlankNode') {
      const items = this.plan.lists.get(o.value);
      if (items !== undefined && !this.rendered.has(o.value)) {
        this.rendered.add(o.value);
        const rendered = items.map((item) => this.object(item, level));
        const oneLine = `( ${rendered.join(' ')} )`;
        return oneLine.length <= 80 && !oneLine.includes('\n')
          ? oneLine
          : `(\n${rendered.map((r) => this.pad(level + 1) + r).join('\n')}\n${this.pad(level)})`;
      }
      if (this.plan.inline.has(o.value) && !this.rendered.has(o.value)) {
        this.rendered.add(o.value);
        const own = (this.plan.bySubject.get(o.key) ?? []).filter(
          (x) => !this.plan.consumed.has(x.key),
        );
        if (Arr.isReadonlyArrayEmpty(own)) return '[]';
        const only = own.length === 1 ? own[0]! : undefined;
        if (
          only !== undefined &&
          only.predicate.value === RDF_REIFIES &&
          only.object._tag === 'Triple' &&
          only.object.subject._tag !== 'Triple'
        ) {
          // A blank node whose only statement reifies a triple: `<< s p o >>`.
          return this.reifiedTriple(only.object);
        }
        return this.bracketed('[', ']', own, level);
      }
    }
    if (o._tag === 'NamedNode' && o.value === RDF_NIL) return '()';
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
    switch (t._tag) {
      case 'NamedNode':
        return this.iri(t.value);
      case 'BlankNode':
        return `_:${this.label(t.value)}`;
      case 'Literal':
        return this.literal(t);
      case 'Triple':
        return `<<( ${this.term(t.subject)} ${this.predicate(t.predicate)} ${this.term(t.object)} )>>`;
      default:
        throw new SerializeFailure(`Cannot serialise ${t._tag}`);
    }
  }

  /** Output labels are assigned in order of first appearance. */
  private label(value: string): string {
    if (!this.relabel) return Lexical.blankNodeLabel(value);
    let label = this.labels.get(value);
    if (label === undefined) this.labels.set(value, (label = `b${this.labels.size}`));
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
    let best: string | undefined;
    let bestLength = -1;
    let bestPrefix = '';
    for (const [prefix, ns] of this.prefixes) {
      if (ns.length > bestLength && iri.startsWith(ns)) {
        const local = encodeLocalName(iri.slice(ns.length));
        if (local !== undefined) {
          best = `${prefix}:${local}`;
          bestLength = ns.length;
          bestPrefix = prefix;
        }
      }
    }
    if (best !== undefined) {
      this.usedPrefixes.add(bestPrefix);
      return best;
    }
    if (this.options.baseIri !== undefined) {
      const relative = Iri.relativize(iri, this.options.baseIri);
      if (Option.isSome(relative)) return `<${Term.escapeIri(relative.value)}>`;
    }
    return `<${Term.escapeIri(iri)}>`;
  }
}

/** Term kinds in writing order; anything else (a variable) sorts last. */
const tagRank = new Map<string, number>([
  ['DefaultGraph', 0],
  ['NamedNode', 1],
  ['BlankNode', 2],
  ['Literal', 3],
  ['Triple', 4],
]);

const compareTerms: Order.Order<Term.Term> = (a, b) => {
  const ra = tagRank.get(a._tag) ?? 5;
  const rb = tagRank.get(b._tag) ?? 5;
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (a._tag === 'Literal' && b._tag === 'Literal') {
    const na = numericValue(a);
    const nb = numericValue(b);
    if (na !== undefined && nb !== undefined && na !== nb) return na < nb ? -1 : 1;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
};

const numericValue = (l: Term.Literal): number | undefined => {
  const dt = l.datatype.value;
  if (dt !== XSD_INTEGER && dt !== XSD_DECIMAL && dt !== XSD_DOUBLE) return undefined;
  const n = Number(l.value);
  return Number.isNaN(n) ? undefined : n;
};

/** Prefix declarations by prefix name. */
export const byPrefixName: Order.Order<readonly [string, string]> = Order.mapInput(
  Order.String,
  ([prefix]: readonly [string, string]) => prefix,
);

/**
 * Finds namespaces worth declaring: well-known vocabularies that are used,
 * plus any namespace used by at least two IRIs.
 */
const detectPrefixes = (
  quads: ReadonlyArray<Term.Quad>,
  baseIri: string | undefined,
): Array<readonly [string, string]> => {
  // Namespaces under the base IRI are better written as relative IRIs.
  const baseDir = baseIri?.slice(0, baseIri.lastIndexOf('/') + 1);
  const counts = new Map<string, number>();
  const visit = (t: Term.Term): void => {
    switch (t._tag) {
      case 'NamedNode': {
        const i = Math.max(t.value.lastIndexOf('#'), t.value.lastIndexOf('/'));
        if (i <= 0) return;
        const ns = t.value.slice(0, i + 1);
        if (!Lexical.isAbsoluteIri(ns) || encodeLocalName(t.value.slice(i + 1)) === undefined) {
          return;
        }
        counts.set(ns, (counts.get(ns) ?? 0) + 1);
        return;
      }
      case 'Literal':
        if (t.language === '' && t.datatype.value !== Term.XSD_STRING) visit(t.datatype);
        return;
      case 'Triple':
        visit(t.subject);
        visit(t.predicate);
        visit(t.object);
        return;
      default:
        return;
    }
  };
  for (const q of quads) {
    visit(q.subject);
    visit(q.predicate);
    visit(q.object);
    visit(q.graph);
  }
  // SAFETY: `commonPrefixes` maps prefixes to namespace strings.
  const known = new Map<string, string>(
    Object.entries(commonPrefixes).map(([p, ns]) => [ns as string, p]),
  );
  const out: Array<readonly [string, string]> = [];
  let n = 0;
  const namespaces = Arr.sort(counts.keys(), Order.String);
  for (const ns of namespaces) {
    const name = known.get(ns);
    if (name !== undefined) {
      out.push([name, ns]);
    } else if (baseDir !== undefined && baseDir.includes('//') && ns.startsWith(baseDir)) {
      continue;
    } else if (counts.get(ns)! >= 2) {
      out.push([`ns${n++}`, ns]);
    }
  }
  return out;
};

/**
 * Normalises quads for writing: relabels blank nodes deterministically.
 *
 * @internal
 */
export const prepare = (quads: Iterable<Term.Quad>): ReadonlyArray<Term.Quad> =>
  Array.from(Isomorphism.relabel(Dataset.fromIterable(quads), 'b'));
