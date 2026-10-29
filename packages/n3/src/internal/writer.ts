/**
 * Pretty-printer for the N3 model.
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { rdf, xsd } from '@thomasfosterau/effect-rdf/Vocab';
import * as Model from '../Model.ts';
import { isPnPrefix, isVarName } from './parser.ts';
import { i18n, log, sameAs } from '../Vocab.ts';

/** @internal */
export interface WriterOptions {
  readonly prefixes?: PrefixMap.PrefixMap | undefined;
  readonly baseIri?: string | undefined;
  /** Indentation unit (default four spaces). */
  readonly indent?: string | undefined;
}

const BLANK_LABEL = /^[A-Za-z0-9_](?:[\w.-]*[\w-])?$/;
const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?\d*\.\d+$/;
const DOUBLE = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)[eE][+-]?\d+$/;

interface BlankInfo {
  refs: number;
  predicate: boolean;
  formulas: Set<Model.Formula>;
}

/** @internal */
export const write = (root: Model.Formula, options?: WriterOptions): string =>
  new Writer(root, options).run();

class Writer {
  private readonly prefixes: PrefixMap.PrefixMap;
  private readonly base: string | undefined;
  private readonly unit: string;
  private readonly usedPrefixes = new Set<string>();
  private readonly blanks = new Map<string, BlankInfo>();
  private readonly blankLabels = new Map<string, string>();
  private readonly usedLabels = new Set<string>();
  private readonly varNames = new Map<string, string>();
  /** Subject groups of inlinable blank nodes, per formula. */
  private readonly inlineGroups = new Map<string, Array<Model.Statement>>();
  private readonly inlinable = new Set<string>();
  private readonly emitted = new Set<string>();

  private readonly root: Model.Formula;
  constructor(root: Model.Formula, options?: WriterOptions) {
    this.root = root;
    this.prefixes = options?.prefixes ?? PrefixMap.empty;
    this.base = options?.baseIri;
    this.unit = options?.indent ?? '    ';
  }

  run(): string {
    this.analyse(this.root);
    for (const [label, info] of this.blanks) {
      if (!info.predicate && info.refs <= 1 && info.formulas.size === 1) this.inlinable.add(label);
    }
    const body = this.formulaBody(this.root, 0);
    let header = '';
    if (this.base !== undefined) header += `@base <${Term.escapeIri(this.base)}> .\n`;
    for (const [prefix, ns] of this.prefixes.prefixes) {
      if (this.usedPrefixes.has(prefix)) header += `@prefix ${prefix}: <${Term.escapeIri(ns)}> .\n`;
    }
    return header === '' ? body : `${header}\n${body}`;
  }

  // ---------------------------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------------------------

  private info(label: string): BlankInfo {
    let i = this.blanks.get(label);
    if (i === undefined)
      this.blanks.set(label, (i = { refs: 0, predicate: false, formulas: new Set() }));
    return i;
  }

  private analyse(f: Model.Formula): void {
    for (const s of f.statements) {
      this.analyseTerm(s.subject, f, 'subject');
      this.analyseTerm(s.predicate, f, 'predicate');
      this.analyseTerm(s.object, f, 'object');
    }
  }

  private analyseTerm(t: Model.N3Term, f: Model.Formula, position: string): void {
    switch (t._tag) {
      case 'BlankNode': {
        const info = this.info(t.value);
        info.formulas.add(f);
        if (position === 'predicate') info.predicate = true;
        else if (position !== 'subject') info.refs++;
        return;
      }
      case 'Collection':
        for (const item of t.items) this.analyseTerm(item, f, 'item');
        return;
      case 'Formula':
        this.analyse(t);
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Statements
  // ---------------------------------------------------------------------------

  private formulaBody(f: Model.Formula, depth: number): string {
    const groups = new Map<string, Array<Model.Statement>>();
    const order: Array<string> = [];
    for (const s of f.statements) {
      const k = s.subject.key;
      let g = groups.get(k);
      if (g === undefined) {
        groups.set(k, (g = []));
        order.push(k);
      }
      g.push(s);
      if (s.subject._tag === 'BlankNode' && this.inlinable.has(s.subject.value)) {
        this.inlineGroups.set(s.subject.value, g);
      }
    }
    const pad = this.unit.repeat(depth);
    const lines: Array<string> = [];
    const render = (key: string) => {
      const g = groups.get(key)!;
      const subject = g[0]!.subject;
      if (subject._tag === 'BlankNode' && this.inlinable.has(subject.value)) {
        this.emitted.add(subject.value);
        lines.push(`${pad}[ ${this.predicateObjects(g, depth + 1, ` ;\n${pad}${this.unit}`)} ] .`);
        return;
      }
      const subj = this.term(subject, depth);
      lines.push(`${pad}${subj} ${this.predicateObjects(g, depth, ` ;\n${pad}${this.unit}`)} .`);
    };
    const deferred: Array<string> = [];
    for (const key of order) {
      const subject = groups.get(key)![0]!.subject;
      if (subject._tag === 'BlankNode' && this.inlinable.has(subject.value)) {
        if (this.blanks.get(subject.value)!.refs === 1) {
          deferred.push(key);
          continue;
        }
      }
      render(key);
    }
    // Inlinable blank nodes that were never reached (reference cycles) are
    // written with labels.
    for (const key of deferred) {
      // SAFETY: deferred keys are blank-node subjects.
      const subject = groups.get(key)![0]!.subject as Term.BlankNode;
      if (this.emitted.has(subject.value)) continue;
      this.inlinable.delete(subject.value);
      render(key);
    }
    return lines.join('\n') + (Arr.isReadonlyArrayNonEmpty(lines) ? '\n' : '');
  }

  private predicateObjects(
    statements: ReadonlyArray<Model.Statement>,
    depth: number,
    separator: string,
  ): string {
    const byPredicate = new Map<
      string,
      { predicate: Model.N3Term; objects: Array<Model.N3Term> }
    >();
    for (const s of statements) {
      const k = s.predicate.key;
      let e = byPredicate.get(k);
      if (e === undefined) byPredicate.set(k, (e = { predicate: s.predicate, objects: [] }));
      e.objects.push(s.object);
    }
    const parts: Array<string> = [];
    for (const { predicate, objects } of byPredicate.values()) {
      parts.push(
        `${this.verb(predicate, depth)} ${objects.map((o) => this.term(o, depth)).join(', ')}`,
      );
    }
    return parts.join(separator);
  }

  private verb(t: Model.N3Term, depth: number): string {
    if (t._tag === 'NamedNode') {
      if (t.value === rdf.type.value) return 'a';
      if (t.value === log.implies.value) return '=>';
      if (t.value === log.isImpliedBy.value) return '<=';
      if (t.value === sameAs.value) return '=';
    }
    return this.term(t, depth);
  }

  // ---------------------------------------------------------------------------
  // Terms
  // ---------------------------------------------------------------------------

  private term(t: Model.N3Term, depth: number): string {
    switch (t._tag) {
      case 'NamedNode':
        return this.iri(t.value);
      case 'BlankNode':
        return this.blank(t, depth);
      case 'Literal':
        return this.literal(t);
      case 'Variable':
        return this.variable(t);
      case 'Collection':
        return Arr.isReadonlyArrayEmpty(t.items)
          ? '()'
          : `( ${t.items.map((i) => this.term(i, depth)).join(' ')} )`;
      case 'Formula':
        return this.formula(t, depth);
    }
  }

  private formula(f: Model.Formula, depth: number): string {
    if (Arr.isReadonlyArrayEmpty(f.statements)) return '{}';
    const inner = this.formulaBody(f, depth + 1);
    if (f.statements.length === 1) {
      const line = inner.trim();
      if (!line.includes('\n') && line.length <= 80) return `{ ${line.replace(/ \.$/, '')} }`;
    }
    return `{\n${inner}${this.unit.repeat(depth)}}`;
  }

  private blank(b: Term.BlankNode, depth: number): string {
    if (this.inlinable.has(b.value) && !this.emitted.has(b.value)) {
      this.emitted.add(b.value);
      const g = this.inlineGroups.get(b.value);
      if (g === undefined || Arr.isReadonlyArrayEmpty(g)) return '[]';
      const pad = this.unit.repeat(depth + 1);
      return `[ ${this.predicateObjects(g, depth + 1, ` ;\n${pad}`)} ]`;
    }
    let label = this.blankLabels.get(b.value);
    if (label === undefined) {
      label = BLANK_LABEL.test(b.value) ? b.value : `b${this.blankLabels.size}`;
      while (this.usedLabels.has(label)) label = `${label}_`;
      this.usedLabels.add(label);
      this.blankLabels.set(b.value, label);
    }
    return `_:${label}`;
  }

  private variable(v: Term.Variable): string {
    let name = this.varNames.get(v.value);
    if (name === undefined) {
      name = isVarName(v.value) ? v.value : `v${this.varNames.size}`;
      this.varNames.set(v.value, name);
    }
    return `?${name}`;
  }

  private iri(value: string): string {
    const compact = PrefixMap.compact(this.prefixes, value);
    if (Option.isSome(compact) && isPnPrefix(compact.value[0])) {
      const [prefix, local] = compact.value;
      if (!local.endsWith('.')) {
        this.usedPrefixes.add(prefix);
        return `${prefix}:${local}`;
      }
    }
    if (this.base !== undefined) {
      const rel = Iri.relativize(value, this.base);
      if (Option.isSome(rel)) return `<${Term.escapeIri(rel.value)}>`;
    }
    return `<${Term.escapeIri(value)}>`;
  }

  private literal(l: Term.Literal): string {
    const dt = l.datatype.value;
    if (l.language === '') {
      if (dt === xsd.integer.value && INTEGER.test(l.value)) return l.value;
      if (dt === xsd.decimal.value && DECIMAL.test(l.value)) return l.value;
      if (dt === xsd.double.value && DOUBLE.test(l.value)) return l.value;
      if (dt === xsd.boolean.value && (l.value === 'true' || l.value === 'false')) return l.value;
    }
    const quoted = this.quote(l.value);
    if (l.language !== '') {
      return l.direction === undefined
        ? `${quoted}@${l.language}`
        : `${quoted}^^${this.iri(`${i18n.base}${l.language}_${l.direction}`)}`;
    }
    if (dt === Term.XSD_STRING) return quoted;
    return `${quoted}^^${this.iri(dt)}`;
  }

  private quote(value: string): string {
    if (value.includes('\n') && !value.endsWith('"')) {
      // eslint-disable-next-line no-control-regex
      const body = value.replace(/[\\"\u0000-\u0009\u000b-\u001f\u007f]/g, (ch) =>
        ch === '\\' || ch === '"' ? `\\${ch}` : Term.escapeString(ch),
      );
      return `"""${body}"""`;
    }
    return `"${Term.escapeString(value)}"`;
  }
}
