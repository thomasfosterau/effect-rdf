/**
 * Generates SPARQL text from the AST.
 *
 * The output is designed to round-trip: parsing the generated text yields
 * an AST that generates the same text again. Expressions and property paths
 * are fully parenthesised, IRIs are compacted with the prologue's prefixes
 * where possible, and numeric/boolean literals use the short syntax when
 * their lexical form allows it.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as Ast from './Ast.ts';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * @since 0.1.0
 * @category models
 */
export interface GenerateOptions {
  /**
   * Prefixes used to compact IRIs. Defaults to the prologue of the query or
   * update. Pass an empty object to always print full IRIs.
   */
  readonly prefixes?: Readonly<Record<string, string>> | undefined;
  /** Whether to print the prologue (`BASE` / `PREFIX`). Defaults to `true`. */
  readonly prologue?: boolean | undefined;
  /** Indentation unit. Defaults to two spaces. */
  readonly indent?: string | undefined;
}

class Printer {
  readonly prefixMap: PrefixMap.PrefixMap;
  readonly unit: string;
  constructor(prefixes: Readonly<Record<string, string>>, indent: string) {
    this.prefixMap = PrefixMap.make(prefixes);
    this.unit = indent;
  }

  iri(node: Term.NamedNode): string {
    const c = PrefixMap.compact(this.prefixMap, node);
    if (Option.isSome(c)) {
      const [prefix, local] = c.value;
      // A trailing '.' or a local part starting with a digit is fine for
      // PN_LOCAL; PrefixMap.compact already validated it.
      return `${prefix}:${local}`;
    }
    return `<${Term.escapeIri(node.value)}>`;
  }

  literal(lit: Term.Literal): string {
    const dt = lit.datatype.value;
    const v = lit.value;
    if (lit.language === '') {
      if (dt === `${XSD}integer` && /^[+-]?[0-9]+$/.test(v)) return v;
      if (dt === `${XSD}decimal` && /^[+-]?[0-9]*\.[0-9]+$/.test(v)) return v;
      if (dt === `${XSD}double` && /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)[eE][+-]?[0-9]+$/.test(v))
        return v;
      if (dt === `${XSD}boolean` && (v === 'true' || v === 'false')) return v;
    }
    const lexical = `"${Term.escapeString(v)}"`;
    if (lit.language !== '') {
      return lit.direction === undefined
        ? `${lexical}@${lit.language}`
        : `${lexical}@${lit.language}--${lit.direction}`;
    }
    if (dt === Term.XSD_STRING) return lexical;
    return `${lexical}^^${this.iri(lit.datatype)}`;
  }

  term(t: Term.Term | Ast.TermPattern): string {
    return Match.value(t).pipe(
      Match.tag('NamedNode', (n) => this.iri(n)),
      Match.tag('BlankNode', (b) => `_:${b.value}`),
      Match.tag('Literal', (l) => this.literal(l)),
      Match.tag('Variable', (v) => `?${v.value}`),
      Match.tag('DefaultGraph', () => 'DEFAULT'),
      Match.tag(
        'Triple',
        (x) => `<<( ${this.term(x.subject)} ${this.verb(x.predicate)} ${this.term(x.object)} )>>`,
      ),
      Match.exhaustive,
    );
  }

  verb(t: Term.Term): string {
    return t._tag === 'NamedNode' && t.value === RDF_TYPE ? 'a' : this.term(t);
  }

  path(p: Ast.Path): string {
    return Match.value(p).pipe(
      Match.tag('PathLink', (l) => this.verb(l.iri)),
      Match.tag('PathInverse', (i) => `^(${this.path(i.path)})`),
      Match.tag('PathSequence', (s) => `(${s.paths.map((x) => this.path(x)).join(' / ')})`),
      Match.tag('PathAlternative', (a) => `(${a.paths.map((x) => this.path(x)).join(' | ')})`),
      Match.tag('PathZeroOrMore', (z) => `(${this.path(z.path)})*`),
      Match.tag('PathOneOrMore', (o) => `(${this.path(o.path)})+`),
      Match.tag('PathZeroOrOne', (z) => `(${this.path(z.path)})?`),
      Match.tag('PathNegated', (n) => {
        const items = [
          ...n.iris.map((i) => this.verb(i)),
          ...n.inverse.map((i) => `^${this.verb(i)}`),
        ];
        return `!(${items.join(' | ')})`;
      }),
      Match.exhaustive,
    );
  }

  // --- expressions ----------------------------------------------------------

  expression(e: Ast.Expression): string {
    return Match.value(e).pipe(
      Match.tag('Variable', 'NamedNode', 'Literal', 'BlankNode', 'Triple', (t) => this.term(t)),
      Match.tag(
        'FunctionCall',
        (c) =>
          `${this.iri(c.function)}(${c.distinct ? 'DISTINCT ' : ''}${c.args.map((a) => this.expression(a)).join(', ')})`,
      ),
      Match.tag('Aggregate', (a) => {
        const arg = a.expression === '*' ? '*' : this.expression(a.expression);
        const sep =
          a.separator !== undefined ? `; SEPARATOR = "${Term.escapeString(a.separator)}"` : '';
        return `${a.name}(${a.distinct ? 'DISTINCT ' : ''}${arg}${sep})`;
      }),
      Match.tag(
        'Exists',
        (x) => `${x.negated ? 'NOT EXISTS' : 'EXISTS'} ${this.group(x.pattern, 1)}`,
      ),
      Match.tag('Operation', (o) => this.operation(o)),
      Match.exhaustive,
    );
  }

  operation(e: Ast.OperationExpression): string {
    const args = e.args.map((a) => this.expression(a));
    return Match.value(e.operator).pipe(
      Match.when(
        Match.is('||', '&&', '=', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/'),
        (operator) => `(${args.join(` ${operator} `)})`,
      ),
      Match.when('!', () => `!(${args[0]})`),
      Match.when('UPLUS', () => `+(${args[0]})`),
      Match.when('UMINUS', () => `-(${args[0]})`),
      Match.when(
        Match.is('IN', 'NOT IN'),
        (operator) => `(${args[0]} ${operator} (${args.slice(1).join(', ')}))`,
      ),
      Match.when('SAMETERM', () => `sameTerm(${args.join(', ')})`),
      Match.orElse((operator) => `${operator}(${args.join(', ')})`),
    );
  }

  // --- patterns -------------------------------------------------------------

  pad(level: number): string {
    return this.unit.repeat(level);
  }

  triple(t: Ast.TriplePattern | Ast.PathPattern | Ast.QuadPattern): string {
    const p = t._tag === 'PathPattern' ? this.path(t.path) : this.verb(t.predicate);
    return `${this.term(t.subject)} ${p} ${this.term(t.object)} .`;
  }

  group(g: Ast.GroupPattern, level: number): string {
    if (Arr.isReadonlyArrayEmpty(g.patterns)) return '{}';
    const only = g.patterns[0]!;
    if (g.patterns.length === 1 && only._tag === 'SubSelect') {
      return `{\n${this.pad(level + 1)}${this.select(only.query, level + 1)}\n${this.pad(level)}}`;
    }
    const lines = g.patterns.flatMap((p) => this.pattern(p, level + 1));
    return `{\n${lines.map((l) => this.pad(level + 1) + l).join('\n')}\n${this.pad(level)}}`;
  }

  pattern(p: Ast.Pattern, level: number): Array<string> {
    return Match.value(p).pipe(
      Match.tag('Bgp', (b): Array<string> => b.triples.map((t) => this.triple(t))),
      Match.tag('Group', (g) => [this.group(g, level)]),
      Match.tag('Optional', (o) => [`OPTIONAL ${this.group(o.pattern, level)}`]),
      Match.tag('Minus', (m) => [`MINUS ${this.group(m.pattern, level)}`]),
      Match.tag('Union', (u) => [u.patterns.map((x) => this.group(x, level)).join(' UNION ')]),
      Match.tag('Graph', (g) => [`GRAPH ${this.term(g.name)} ${this.group(g.pattern, level)}`]),
      Match.tag('Service', (s) => [
        `SERVICE ${s.silent ? 'SILENT ' : ''}${this.term(s.name)} ${this.group(s.pattern, level)}`,
      ]),
      Match.tag('Filter', (f) => [`FILTER(${this.expression(f.expression)})`]),
      Match.tag('Bind', (b) => [
        `BIND(${this.expression(b.expression)} AS ${this.term(b.variable)})`,
      ]),
      Match.tag('Values', (v) => [this.values(v)]),
      Match.tag('SubSelect', (s) => [
        `{\n${this.pad(level + 1)}${this.select(s.query, level + 1)}\n${this.pad(level)}}`,
      ]),
      Match.exhaustive,
    );
  }

  values(v: Ast.ValuesPattern): string {
    const vars = v.variables.map((x) => this.term(x)).join(' ');
    const rows = v.rows
      .map((r) => `(${r.map((t) => (t === undefined ? 'UNDEF' : this.term(t))).join(' ')})`)
      .join(' ');
    return `VALUES (${vars}) { ${rows} }`;
  }

  // --- queries --------------------------------------------------------------

  dataset(d: Ast.DatasetClause | undefined, keyword: 'FROM' | 'USING'): string {
    if (d === undefined) return '';
    return [
      ...d.default.map((g) => `${keyword} ${this.iri(g)}\n`),
      ...d.named.map((g) => `${keyword} NAMED ${this.iri(g)}\n`),
    ].join('');
  }

  modifiers(q: Ast.QueryBase): string {
    let out = '';
    if (Arr.isReadonlyArrayNonEmpty(q.groupBy)) {
      out += `\nGROUP BY ${q.groupBy
        .map((g) =>
          g.variable !== undefined
            ? `(${this.expression(g.expression)} AS ${this.term(g.variable)})`
            : g.expression._tag === 'Variable'
              ? this.term(g.expression)
              : `(${this.expression(g.expression)})`,
        )
        .join(' ')}`;
    }
    if (Arr.isReadonlyArrayNonEmpty(q.having)) {
      out += `\nHAVING ${q.having.map((h) => `(${this.expression(h)})`).join(' ')}`;
    }
    if (Arr.isReadonlyArrayNonEmpty(q.orderBy)) {
      out += `\nORDER BY ${q.orderBy
        .map((o) => `${o.descending ? 'DESC' : 'ASC'}(${this.expression(o.expression)})`)
        .join(' ')}`;
    }
    if (q.limit !== undefined) out += `\nLIMIT ${q.limit}`;
    if (q.offset !== undefined) out += `\nOFFSET ${q.offset}`;
    return out;
  }

  select(q: Ast.SelectQuery, level: number): string {
    const projection =
      q.projection === '*'
        ? '*'
        : q.projection
            .map((p) =>
              p._tag === 'Variable'
                ? this.term(p)
                : `(${this.expression(p.expression)} AS ${this.term(p.variable)})`,
            )
            .join(' ');
    const head = `SELECT ${q.distinct ? 'DISTINCT ' : q.reduced ? 'REDUCED ' : ''}${projection}`;
    const values = q.values !== undefined ? `\n${this.values(q.values)}` : '';
    return `${head}\n${this.dataset(q.dataset, 'FROM')}WHERE ${this.group(q.where, level)}${this.modifiers(q)}${values}`;
  }

  query(q: Ast.Query): string {
    const values = q.values !== undefined ? `\n${this.values(q.values)}` : '';
    return Match.value(q).pipe(
      Match.tag('Select', (s) => this.select(s, 0)),
      Match.tag(
        'Ask',
        (a) =>
          `ASK\n${this.dataset(a.dataset, 'FROM')}WHERE ${this.group(a.where, 0)}${this.modifiers(a)}${values}`,
      ),
      Match.tag('Construct', (c) => {
        const template = c.template.map((t) => `${this.unit}${this.triple(t)}`).join('\n');
        return `CONSTRUCT {\n${template}${template === '' ? '' : '\n'}}\n${this.dataset(c.dataset, 'FROM')}WHERE ${this.group(c.where, 0)}${this.modifiers(c)}${values}`;
      }),
      Match.tag('Describe', (d) => {
        const terms = d.terms === '*' ? '*' : d.terms.map((t) => this.term(t)).join(' ');
        return `DESCRIBE ${terms}\n${this.dataset(d.dataset, 'FROM')}WHERE ${this.group(d.where, 0)}${this.modifiers(d)}${values}`;
      }),
      Match.exhaustive,
    );
  }

  // --- updates --------------------------------------------------------------

  quads(quads: ReadonlyArray<Ast.QuadPattern | Term.Quad>): string {
    const lines: Array<string> = [];
    let i = 0;
    while (i < quads.length) {
      const g = quads[i]!.graph;
      const run: Array<Ast.QuadPattern | Term.Quad> = [];
      while (i < quads.length && quads[i]!.graph.key === g.key) run.push(quads[i++]!);
      const triples = run.map(
        (q) => `${this.term(q.subject)} ${this.verb(q.predicate)} ${this.term(q.object)} .`,
      );
      if (g._tag === 'DefaultGraph') lines.push(...triples.map((t) => this.unit + t));
      else {
        lines.push(`${this.unit}GRAPH ${this.term(g)} {`);
        lines.push(...triples.map((t) => this.unit + this.unit + t));
        lines.push(`${this.unit}}`);
      }
    }
    return Arr.isReadonlyArrayEmpty(lines) ? '{}' : `{\n${lines.join('\n')}\n}`;
  }

  graphTarget(t: Ast.GraphTarget): string {
    return t._tag === 'NamedNode' ? `GRAPH ${this.iri(t)}` : t._tag.toUpperCase();
  }

  graphOrDefault(g: Ast.GraphOrDefault): string {
    return g._tag === 'DefaultGraph' ? 'DEFAULT' : `GRAPH ${this.iri(g)}`;
  }

  operationText(op: Ast.UpdateOperation): string {
    return Match.value(op).pipe(
      Match.tag('InsertData', (o) => `INSERT DATA ${this.quads(o.quads)}`),
      Match.tag('DeleteData', (o) => `DELETE DATA ${this.quads(o.quads)}`),
      Match.tag('DeleteWhere', (o) => `DELETE WHERE ${this.quads(o.patterns)}`),
      Match.tag('Modify', (o) => {
        let out = o.with !== undefined ? `WITH ${this.iri(o.with)}\n` : '';
        if (Arr.isReadonlyArrayNonEmpty(o.delete) || Arr.isReadonlyArrayEmpty(o.insert)) {
          out += `DELETE ${this.quads(o.delete)}\n`;
        }
        if (Arr.isReadonlyArrayNonEmpty(o.insert)) out += `INSERT ${this.quads(o.insert)}\n`;
        out += this.dataset(o.using, 'USING');
        return `${out}WHERE ${this.group(o.where, 0)}`;
      }),
      Match.tag(
        'Load',
        (o) =>
          `LOAD ${o.silent ? 'SILENT ' : ''}${this.iri(o.source)}${o.destination !== undefined ? ` INTO GRAPH ${this.iri(o.destination)}` : ''}`,
      ),
      Match.tag(
        'Clear',
        'Drop',
        (o) => `${o._tag.toUpperCase()} ${o.silent ? 'SILENT ' : ''}${this.graphTarget(o.target)}`,
      ),
      Match.tag('Create', (o) => `CREATE ${o.silent ? 'SILENT ' : ''}GRAPH ${this.iri(o.graph)}`),
      Match.tag(
        'Add',
        'Move',
        'Copy',
        (o) =>
          `${o._tag.toUpperCase()} ${o.silent ? 'SILENT ' : ''}${this.graphOrDefault(o.source)} TO ${this.graphOrDefault(o.destination)}`,
      ),
      Match.exhaustive,
    );
  }
}

const prologueText = (prologue: Ast.Prologue): string => {
  let out = '';
  if (prologue.version !== undefined) out += `VERSION "${Term.escapeString(prologue.version)}"\n`;
  if (prologue.base !== undefined) out += `BASE <${Term.escapeIri(prologue.base)}>\n`;
  for (const [prefix, ns] of Object.entries(prologue.prefixes)) {
    out += `PREFIX ${prefix}: <${Term.escapeIri(ns)}>\n`;
  }
  return out;
};

/**
 * Generates SPARQL text for a query or update.
 *
 * @since 0.1.0
 * @category printing
 */
export const print = (ast: Ast.Query | Ast.Update, options?: GenerateOptions): string => {
  const prefixes = options?.prefixes ?? ast.prologue.prefixes;
  const printer = new Printer(prefixes, options?.indent ?? '  ');
  const prologue =
    options?.prologue === false
      ? ''
      : prologueText(
          options?.prefixes !== undefined
            ? { ...ast.prologue, prefixes: options.prefixes }
            : ast.prologue,
        );
  if (ast._tag === 'Update') {
    return prologue + ast.operations.map((op) => printer.operationText(op)).join(' ;\n');
  }
  return prologue + printer.query(ast);
};

/**
 * Generates SPARQL text for an expression.
 *
 * @since 0.1.0
 * @category printing
 */
export const printExpression = (
  expression: Ast.Expression,
  prefixes: Readonly<Record<string, string>> = {},
): string => new Printer(prefixes, '  ').expression(expression);

/**
 * Generates SPARQL text for a graph pattern.
 *
 * @since 0.1.0
 * @category printing
 */
export const printPattern = (
  pattern: Ast.Pattern,
  prefixes: Readonly<Record<string, string>> = {},
): string => new Printer(prefixes, '  ').pattern(pattern, 0).join('\n');

/**
 * Generates SPARQL syntax for a term (IRIs are compacted with `prefixes`).
 *
 * @since 0.1.0
 * @category printing
 */
export const printTerm = (
  term: Term.Term,
  prefixes: Readonly<Record<string, string>> = {},
): string => new Printer(prefixes, '  ').term(term);
