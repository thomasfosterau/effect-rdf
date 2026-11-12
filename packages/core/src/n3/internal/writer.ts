/**
 * Pretty-printer for the N3 model.
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Iri from '../../Iri.ts';
import * as PrefixMap from '../../PrefixMap.ts';
import * as Term from '../../Term.ts';
import { rdf, xsd } from '../../Vocab.ts';
import * as Model from '../Model.ts';
import * as Guards from './guards.ts';
import { loop } from './loop.ts';
import { isPnChars, isPnCharsBase, isPnCharsU } from './parser.ts';
import { i18n, log, sameAs } from '../Vocab.ts';

/** @internal */
export interface WriterOptions {
  readonly prefixes: PrefixMap.PrefixMap;
  readonly baseIri: Option.Option<string>;
  /** Indentation unit. */
  readonly indent: string;
}

/** Whether a string is a valid `PN_PREFIX` (or empty). */
const isPnPrefix = (s: string): boolean => {
  const cps = Array.from(s, codePoint);
  if (!Arr.isReadonlyArrayNonEmpty(cps)) return true;
  if (!isPnCharsBase(cps[0])) return false;
  if (cps.length > 1 && cps[cps.length - 1] === 0x2e) return false;
  return cps.slice(1).every((c) => c === 0x2e || isPnChars(c));
};

/** The code point of a character (as `Array.from` splits a string). */
const codePoint = (ch: string): number => ch.codePointAt(0) ?? 0;

/** Whether a string is a valid quick variable name (without `?`). */
const isVarName = (s: string): boolean => {
  const cps = Array.from(s, codePoint);
  return Arr.isReadonlyArrayNonEmpty(cps) && isPnCharsU(cps[0]) && cps.slice(1).every(isPnChars);
};

const BLANK_LABEL = /^[A-Za-z0-9_](?:[\w.-]*[\w-])?$/;
const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?\d*\.\d+$/;
const DOUBLE = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)[eE][+-]?\d+$/;

interface BlankInfo {
  refs: number;
  predicate: boolean;
  /** The first formula the blank node occurs in. */
  readonly formula: Model.Formula;
  /** Whether it occurs in another formula (object) too. */
  shared: boolean;
}

/** The statements of one subject (or predicate), in order. */
interface Group {
  readonly first: Model.Statement;
  readonly statements: Array<Model.Statement>;
}

/** @internal */
export const write = (root: Model.Formula, options: WriterOptions): string =>
  new Writer(root, options).run();

class Writer {
  private readonly prefixes: PrefixMap.PrefixMap;
  private readonly base: Option.Option<string>;
  private readonly unit: string;
  private readonly usedPrefixes = MutableHashSet.empty<string>();
  private readonly blanks = MutableHashMap.empty<string, BlankInfo>();
  private readonly blankLabels = MutableHashMap.empty<string, string>();
  private readonly usedLabels = MutableHashSet.empty<string>();
  private readonly varNames = MutableHashMap.empty<string, string>();
  /** Subject groups of inlinable blank nodes, per formula. */
  private readonly inlineGroups = MutableHashMap.empty<string, Array<Model.Statement>>();
  private readonly inlinable = MutableHashSet.empty<string>();
  private readonly emitted = MutableHashSet.empty<string>();

  private readonly root: Model.Formula;
  constructor(root: Model.Formula, options: WriterOptions) {
    this.root = root;
    this.prefixes = options.prefixes;
    this.base = options.baseIri;
    this.unit = options.indent;
  }

  run(): string {
    this.analyse(this.root);
    MutableHashMap.forEach(this.blanks, (info, label) => {
      if (!info.predicate && info.refs <= 1 && !info.shared) {
        MutableHashSet.add(this.inlinable, label);
      }
    });
    const body = this.formulaBody(this.root, 0);
    const base = Option.match(this.base, {
      onNone: () => '',
      onSome: (iri) => `@base <${Term.escapeIri(iri)}> .\n`,
    });
    const header = Arr.reduce(PrefixMap.entries(this.prefixes), base, (acc, [prefix, ns]) =>
      MutableHashSet.has(this.usedPrefixes, prefix)
        ? `${acc}@prefix ${prefix}: <${Term.escapeIri(ns)}> .\n`
        : acc,
    );
    return header === '' ? body : `${header}\n${body}`;
  }

  // ---------------------------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------------------------

  /** The blank node's information, made (in `f`) on first sight. */
  private info(label: string, f: Model.Formula): BlankInfo {
    const known = this.blanks.backing.get(label);
    if (known !== undefined) {
      if (known.formula !== f) known.shared = true;
      return known;
    }
    const info: BlankInfo = { refs: 0, predicate: false, formula: f, shared: false };
    MutableHashMap.set(this.blanks, label, info);
    return info;
  }

  private analyse(f: Model.Formula): void {
    f.statements.forEach((s) => {
      this.analyseTerm(s.subject, f, 'subject');
      this.analyseTerm(s.predicate, f, 'predicate');
      this.analyseTerm(s.object, f, 'object');
    });
  }

  // Plain refinements rather than `Match`: `analyseTerm` runs for every term written.
  private analyseTerm(t: Model.N3Term, f: Model.Formula, position: string): void {
    if (Guards.isBlankNode(t)) {
      const info = this.info(t.value, f);
      if (position === 'predicate') info.predicate = true;
      else if (position !== 'subject') info.refs++;
    } else if (t instanceof Model.Collection) {
      t.items.forEach((item) => this.analyseTerm(item, f, 'item'));
    } else if (t instanceof Model.Formula) {
      this.analyse(t);
    }
  }

  /** Whether `subject` is an inlinable blank node. */
  private isInlinable(subject: Model.N3Term): subject is Term.BlankNode {
    return Guards.isBlankNode(subject) && MutableHashSet.has(this.inlinable, subject.value);
  }

  // ---------------------------------------------------------------------------
  // Statements
  // ---------------------------------------------------------------------------

  private formulaBody(f: Model.Formula, depth: number): string {
    const groups = MutableHashMap.empty<string, Group>();
    f.statements.forEach((s) => {
      const k = s.subject.key;
      let g = groups.backing.get(k);
      if (g === undefined) {
        g = { first: s, statements: [s] };
        MutableHashMap.set(groups, k, g);
      } else g.statements.push(s);
      if (this.isInlinable(s.subject)) {
        MutableHashMap.set(this.inlineGroups, s.subject.value, g.statements);
      }
    });
    const pad = this.unit.repeat(depth);
    const lines: Array<string> = [];
    const render = (g: Group) => {
      const subject = g.first.subject;
      if (this.isInlinable(subject)) {
        MutableHashSet.add(this.emitted, subject.value);
        lines.push(
          `${pad}[ ${this.predicateObjects(g.statements, depth + 1, ` ;\n${pad}${this.unit}`)} ] .`,
        );
        return;
      }
      const subj = this.term(subject, depth);
      lines.push(
        `${pad}${subj} ${this.predicateObjects(g.statements, depth, ` ;\n${pad}${this.unit}`)} .`,
      );
    };
    const deferred: Array<Group> = [];
    MutableHashMap.forEach(groups, (g) => {
      const subject = g.first.subject;
      if (this.isInlinable(subject) && this.blanks.backing.get(subject.value)?.refs === 1) {
        deferred.push(g);
        return;
      }
      render(g);
    });
    // Inlinable blank nodes that were never reached (reference cycles) are
    // written with labels.
    deferred.forEach((g) => {
      const subject = g.first.subject;
      if (!Guards.isBlankNode(subject) || MutableHashSet.has(this.emitted, subject.value)) return;
      MutableHashSet.remove(this.inlinable, subject.value);
      render(g);
    });
    return lines.join('\n') + (Arr.isReadonlyArrayNonEmpty(lines) ? '\n' : '');
  }

  private predicateObjects(
    statements: ReadonlyArray<Model.Statement>,
    depth: number,
    separator: string,
  ): string {
    const byPredicate = MutableHashMap.empty<
      string,
      { predicate: Model.N3Term; objects: Array<Model.N3Term> }
    >();
    statements.forEach((s) => {
      const k = s.predicate.key;
      const e = byPredicate.backing.get(k);
      if (e === undefined) {
        MutableHashMap.set(byPredicate, k, { predicate: s.predicate, objects: [s.object] });
      } else e.objects.push(s.object);
    });
    return Arr.map(
      Arr.fromIterable(MutableHashMap.values(byPredicate)),
      ({ predicate, objects }) =>
        `${this.verb(predicate, depth)} ${objects.map((o) => this.term(o, depth)).join(', ')}`,
    ).join(separator);
  }

  private verb(t: Model.N3Term, depth: number): string {
    if (Guards.isNamedNode(t)) {
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

  // Plain refinements rather than `Match`: `term` runs for every term written.
  private term(t: Model.N3Term, depth: number): string {
    if (Guards.isNamedNode(t)) return this.iri(t.value);
    if (Guards.isBlankNode(t)) return this.blank(t, depth);
    if (Guards.isLiteral(t)) return this.literal(t);
    if (Guards.isVariable(t)) return this.variable(t);
    if (t instanceof Model.Collection) {
      return Arr.isReadonlyArrayEmpty(t.items)
        ? '()'
        : `( ${t.items.map((i) => this.term(i, depth)).join(' ')} )`;
    }
    return this.formula(t, depth);
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
    if (MutableHashSet.has(this.inlinable, b.value) && !MutableHashSet.has(this.emitted, b.value)) {
      MutableHashSet.add(this.emitted, b.value);
      const g = this.inlineGroups.backing.get(b.value);
      if (g === undefined || Arr.isReadonlyArrayEmpty(g)) return '[]';
      const pad = this.unit.repeat(depth + 1);
      return `[ ${this.predicateObjects(g, depth + 1, ` ;\n${pad}`)} ]`;
    }
    const known = this.blankLabels.backing.get(b.value);
    if (known !== undefined) return `_:${known}`;
    let label = BLANK_LABEL.test(b.value) ? b.value : `b${MutableHashMap.size(this.blankLabels)}`;
    loop(() => {
      if (!MutableHashSet.has(this.usedLabels, label)) return false;
      label = `${label}_`;
      return true;
    });
    MutableHashSet.add(this.usedLabels, label);
    MutableHashMap.set(this.blankLabels, b.value, label);
    return `_:${label}`;
  }

  private variable(v: Term.Variable): string {
    const known = this.varNames.backing.get(v.value);
    if (known !== undefined) return `?${known}`;
    const name = isVarName(v.value) ? v.value : `v${MutableHashMap.size(this.varNames)}`;
    MutableHashMap.set(this.varNames, v.value, name);
    return `?${name}`;
  }

  private iri(value: string): string {
    const compact = PrefixMap.compact(this.prefixes, value);
    if (Option.isSome(compact) && isPnPrefix(compact.value[0])) {
      const [prefix, local] = compact.value;
      if (!local.endsWith('.')) {
        MutableHashSet.add(this.usedPrefixes, prefix);
        return `${prefix}:${local}`;
      }
    }
    if (Option.isSome(this.base)) {
      const rel = Iri.relativize(value, this.base.value);
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
