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
    switch (t._tag) {
      case 'NamedNode':
        return this.iri(t);
      case 'BlankNode':
        return `_:${t.value}`;
      case 'Literal':
        return this.literal(t);
      case 'Variable':
        return `?${t.value}`;
      case 'DefaultGraph':
        return 'DEFAULT';
      case 'Triple':
        return `<<( ${this.term(t.subject)} ${this.verb(t.predicate)} ${this.term(t.object)} )>>`;
    }
  }

  verb(t: Term.Term): string {
    return t._tag === 'NamedNode' && t.value === RDF_TYPE ? 'a' : this.term(t);
  }

  path(p: Ast.Path): string {
    switch (p._tag) {
      case 'PathLink':
        return this.verb(p.iri);
      case 'PathInverse':
        return `^(${this.path(p.path)})`;
      case 'PathSequence':
        return `(${p.paths.map((x) => this.path(x)).join(' / ')})`;
      case 'PathAlternative':
        return `(${p.paths.map((x) => this.path(x)).join(' | ')})`;
      case 'PathZeroOrMore':
        return `(${this.path(p.path)})*`;
      case 'PathOneOrMore':
        return `(${this.path(p.path)})+`;
      case 'PathZeroOrOne':
        return `(${this.path(p.path)})?`;
      case 'PathNegated': {
        const items = [
          ...p.iris.map((i) => this.verb(i)),
          ...p.inverse.map((i) => `^${this.verb(i)}`),
        ];
        return `!(${items.join(' | ')})`;
      }
    }
  }

  // --- expressions ----------------------------------------------------------

  expression(e: Ast.Expression): string {
    switch (e._tag) {
      case 'Variable':
      case 'NamedNode':
      case 'Literal':
      case 'BlankNode':
      case 'Triple':
        return this.term(e);
      case 'FunctionCall':
        return `${this.iri(e.function)}(${e.distinct ? 'DISTINCT ' : ''}${e.args.map((a) => this.expression(a)).join(', ')})`;
      case 'Aggregate': {
        const arg = e.expression === '*' ? '*' : this.expression(e.expression);
        const sep =
          e.separator !== undefined ? `; SEPARATOR = "${Term.escapeString(e.separator)}"` : '';
        return `${e.name}(${e.distinct ? 'DISTINCT ' : ''}${arg}${sep})`;
      }
      case 'Exists':
        return `${e.negated ? 'NOT EXISTS' : 'EXISTS'} ${this.group(e.pattern, 1)}`;
      case 'Operation':
        return this.operation(e);
    }
  }

  operation(e: Ast.OperationExpression): string {
    const args = e.args.map((a) => this.expression(a));
    switch (e.operator) {
      case '||':
      case '&&':
      case '=':
      case '!=':
      case '<':
      case '>':
      case '<=':
      case '>=':
      case '+':
      case '-':
      case '*':
      case '/':
        return `(${args.join(` ${e.operator} `)})`;
      case '!':
        return `!(${args[0]})`;
      case 'UPLUS':
        return `+(${args[0]})`;
      case 'UMINUS':
        return `-(${args[0]})`;
      case 'IN':
      case 'NOT IN':
        return `(${args[0]} ${e.operator} (${args.slice(1).join(', ')}))`;
      case 'SAMETERM':
        return `sameTerm(${args.join(', ')})`;
      default:
        return `${e.operator}(${args.join(', ')})`;
    }
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
    if (g.patterns.length === 0) return '{}';
    const only = g.patterns[0]!;
    if (g.patterns.length === 1 && only._tag === 'SubSelect') {
      return `{\n${this.pad(level + 1)}${this.select(only.query, level + 1)}\n${this.pad(level)}}`;
    }
    const lines = g.patterns.flatMap((p) => this.pattern(p, level + 1));
    return `{\n${lines.map((l) => this.pad(level + 1) + l).join('\n')}\n${this.pad(level)}}`;
  }

  pattern(p: Ast.Pattern, level: number): Array<string> {
    switch (p._tag) {
      case 'Bgp':
        return p.triples.map((t) => this.triple(t));
      case 'Group':
        return [this.group(p, level)];
      case 'Optional':
        return [`OPTIONAL ${this.group(p.pattern, level)}`];
      case 'Minus':
        return [`MINUS ${this.group(p.pattern, level)}`];
      case 'Union':
        return [p.patterns.map((x) => this.group(x, level)).join(' UNION ')];
      case 'Graph':
        return [`GRAPH ${this.term(p.name)} ${this.group(p.pattern, level)}`];
      case 'Service':
        return [
          `SERVICE ${p.silent ? 'SILENT ' : ''}${this.term(p.name)} ${this.group(p.pattern, level)}`,
        ];
      case 'Filter':
        return [`FILTER(${this.expression(p.expression)})`];
      case 'Bind':
        return [`BIND(${this.expression(p.expression)} AS ${this.term(p.variable)})`];
      case 'Values':
        return [this.values(p)];
      case 'SubSelect':
        return [`{\n${this.pad(level + 1)}${this.select(p.query, level + 1)}\n${this.pad(level)}}`];
    }
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
    if (q.groupBy.length > 0) {
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
    if (q.having.length > 0) {
      out += `\nHAVING ${q.having.map((h) => `(${this.expression(h)})`).join(' ')}`;
    }
    if (q.orderBy.length > 0) {
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
    switch (q._tag) {
      case 'Select':
        return this.select(q, 0);
      case 'Ask':
        return `ASK\n${this.dataset(q.dataset, 'FROM')}WHERE ${this.group(q.where, 0)}${this.modifiers(q)}${values}`;
      case 'Construct': {
        const template = q.template.map((t) => `${this.unit}${this.triple(t)}`).join('\n');
        return `CONSTRUCT {\n${template}${template === '' ? '' : '\n'}}\n${this.dataset(q.dataset, 'FROM')}WHERE ${this.group(q.where, 0)}${this.modifiers(q)}${values}`;
      }
      case 'Describe': {
        const terms = q.terms === '*' ? '*' : q.terms.map((t) => this.term(t)).join(' ');
        return `DESCRIBE ${terms}\n${this.dataset(q.dataset, 'FROM')}WHERE ${this.group(q.where, 0)}${this.modifiers(q)}${values}`;
      }
    }
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
    return lines.length === 0 ? '{}' : `{\n${lines.join('\n')}\n}`;
  }

  graphTarget(t: Ast.GraphTarget): string {
    return t._tag === 'NamedNode' ? `GRAPH ${this.iri(t)}` : t._tag.toUpperCase();
  }

  graphOrDefault(g: Ast.GraphOrDefault): string {
    return g._tag === 'DefaultGraph' ? 'DEFAULT' : `GRAPH ${this.iri(g)}`;
  }

  operationText(op: Ast.UpdateOperation): string {
    switch (op._tag) {
      case 'InsertData':
        return `INSERT DATA ${this.quads(op.quads)}`;
      case 'DeleteData':
        return `DELETE DATA ${this.quads(op.quads)}`;
      case 'DeleteWhere':
        return `DELETE WHERE ${this.quads(op.patterns)}`;
      case 'Modify': {
        let out = op.with !== undefined ? `WITH ${this.iri(op.with)}\n` : '';
        if (op.delete.length > 0 || op.insert.length === 0) {
          out += `DELETE ${this.quads(op.delete)}\n`;
        }
        if (op.insert.length > 0) out += `INSERT ${this.quads(op.insert)}\n`;
        out += this.dataset(op.using, 'USING');
        return `${out}WHERE ${this.group(op.where, 0)}`;
      }
      case 'Load':
        return `LOAD ${op.silent ? 'SILENT ' : ''}${this.iri(op.source)}${op.destination !== undefined ? ` INTO GRAPH ${this.iri(op.destination)}` : ''}`;
      case 'Clear':
      case 'Drop':
        return `${op._tag.toUpperCase()} ${op.silent ? 'SILENT ' : ''}${this.graphTarget(op.target)}`;
      case 'Create':
        return `CREATE ${op.silent ? 'SILENT ' : ''}GRAPH ${this.iri(op.graph)}`;
      case 'Add':
      case 'Move':
      case 'Copy':
        return `${op._tag.toUpperCase()} ${op.silent ? 'SILENT ' : ''}${this.graphOrDefault(op.source)} TO ${this.graphOrDefault(op.destination)}`;
    }
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
