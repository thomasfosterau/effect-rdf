/**
 * Translation of the SPARQL AST to the SPARQL algebra, following SPARQL 1.1
 * §18.2 (with the SPARQL 1.2 clarifications): blank nodes become fresh
 * internal variables, property paths are expanded to triple patterns where
 * possible, filters apply to their whole group, `OPTIONAL { … FILTER }`
 * becomes a `LeftJoin` with a condition, and grouping, aggregation,
 * `HAVING`, `VALUES`, select expressions and solution modifiers are applied
 * at the query level. The empty-BGP simplification is applied after the
 * whole translation (the "preferred reading" of the specification).
 *
 * @since 0.1.0
 */
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Algebra from './Algebra.ts';
import * as Ast from './Ast.ts';
import * as Bindings from './Bindings.ts';

class Translator {
  private counter = 0;

  fresh(kind: string): Term.Variable {
    return Algebra.internalVariable(`${kind}${this.counter++}`);
  }

  // --- terms ----------------------------------------------------------------

  termPattern(t: Ast.TermPattern): Ast.TermPattern {
    switch (t._tag) {
      case 'BlankNode':
        return Algebra.internalVariable(`b:${t.value}`);
      case 'Triple':
        return Term.triple(
          this.termPattern(t.subject) as any,
          this.termPattern(t.predicate) as any,
          this.termPattern(t.object) as any,
        );
      default:
        return t;
    }
  }

  // --- graph patterns -------------------------------------------------------

  /** Translates a group graph pattern (without simplification). */
  group(g: Ast.GroupPattern): Algebra.Operation {
    const filters: Array<Ast.Expression> = [];
    // Merge adjacent triple blocks (filters do not separate BGPs).
    const elements: Array<Ast.Pattern> = [];
    for (const p of g.patterns) {
      if (p._tag === 'Filter') {
        filters.push(p.expression);
        continue;
      }
      const last = elements[elements.length - 1];
      if (p._tag === 'Bgp' && last !== undefined && last._tag === 'Bgp') {
        elements[elements.length - 1] = Ast.bgp([...last.triples, ...p.triples]);
      } else elements.push(p);
    }
    let result: Algebra.Operation = Algebra.unit;
    for (const e of elements) {
      switch (e._tag) {
        case 'Optional': {
          const a = this.group(e.pattern);
          result =
            a._tag === 'Filter'
              ? Algebra.leftJoin(result, a.input, a.expression)
              : Algebra.leftJoin(result, a);
          break;
        }
        case 'Minus':
          result = Algebra.minus(result, this.group(e.pattern));
          break;
        case 'Bind':
          result = Algebra.extend(result, e.variable, this.expression(e.expression));
          break;
        default:
          result = Algebra.join(result, this.pattern(e));
      }
    }
    if (filters.length > 0) {
      const conjunction = filters
        .map((f) => this.expression(f))
        .reduce((a, b) => ({ _tag: 'Operation', operator: '&&', args: [a, b] }));
      result = Algebra.filter(conjunction, result);
    }
    return result;
  }

  pattern(p: Ast.Pattern): Algebra.Operation {
    switch (p._tag) {
      case 'Bgp':
        return this.triples(p.triples);
      case 'Group':
        return this.group(p);
      case 'Union':
        return p.patterns.map((g) => this.group(g)).reduce((a, b) => Algebra.union(a, b));
      case 'Graph':
        return { _tag: 'Graph', name: p.name, input: this.group(p.pattern) };
      case 'Service':
        return {
          _tag: 'Service',
          name: p.name,
          silent: p.silent,
          input: this.group(p.pattern),
          pattern: p.pattern,
          prefixes: {},
        };
      case 'Values':
        return values(p);
      case 'SubSelect':
        return this.query(p.query).input;
      case 'Optional':
        return Algebra.leftJoin(Algebra.unit, this.group(p.pattern));
      case 'Minus':
        return Algebra.minus(Algebra.unit, this.group(p.pattern));
      case 'Filter':
        return Algebra.filter(this.expression(p.expression), Algebra.unit);
      case 'Bind':
        return Algebra.extend(Algebra.unit, p.variable, this.expression(p.expression));
    }
  }

  triples(triples: ReadonlyArray<Ast.TriplePattern | Ast.PathPattern>): Algebra.Operation {
    const parts: Array<Algebra.Operation> = [];
    let current: Array<Ast.TriplePattern> = [];
    const flush = () => {
      if (current.length > 0) parts.push(Algebra.bgp(current));
      current = [];
    };
    const emitPath = (s: Ast.TermPattern, path: Ast.Path, o: Ast.TermPattern): void => {
      switch (path._tag) {
        case 'PathLink':
          current.push(Ast.triplePattern(s, path.iri, o));
          return;
        case 'PathInverse':
          if (path.path._tag === 'PathLink') {
            current.push(Ast.triplePattern(o, path.path.iri, s));
            return;
          }
          break;
        case 'PathSequence': {
          let from = s;
          path.paths.forEach((step, i) => {
            const to = i === path.paths.length - 1 ? o : this.fresh('p');
            emitPath(from, step, to);
            from = to;
          });
          return;
        }
        default:
          break;
      }
      flush();
      parts.push({ _tag: 'Path', subject: s, path, object: o });
    };
    for (const t of triples) {
      const s = this.termPattern(t.subject);
      const o = this.termPattern(t.object);
      if (t._tag === 'TriplePattern') current.push(Ast.triplePattern(s, t.predicate, o));
      else emitPath(s, t.path, o);
    }
    flush();
    if (parts.length === 0) return Algebra.unit;
    return parts.reduce((a, b) => Algebra.join(a, b));
  }

  // --- expressions ----------------------------------------------------------

  expression(
    e: Ast.Expression,
    aggregates?: (a: Ast.AggregateExpression) => Term.Variable,
  ): Algebra.Expression {
    switch (e._tag) {
      case 'Variable':
      case 'NamedNode':
      case 'Literal':
      case 'BlankNode':
      case 'Triple':
        return e;
      case 'Operation':
        return {
          _tag: 'Operation',
          operator: e.operator,
          args: e.args.map((a) => this.expression(a, aggregates)),
        };
      case 'FunctionCall':
        return {
          _tag: 'FunctionCall',
          function: e.function,
          args: e.args.map((a) => this.expression(a, aggregates)),
        };
      case 'Exists':
        // Not simplified: the empty BGPs at the start of each group are the
        // "ContextSolution" through which the current solution flows into
        // the pattern (SPARQL 1.2 §18.6).
        return { _tag: 'Exists', negated: e.negated, input: this.group(e.pattern) };
      case 'Aggregate':
        if (aggregates === undefined)
          throw new Error('Aggregate outside of an aggregation context');
        return aggregates(e);
    }
  }

  // --- queries --------------------------------------------------------------

  query(q: Ast.Query): Algebra.Query {
    let op = this.group(q.where);
    const projection = q._tag === 'Select' && q.projection !== '*' ? q.projection : ([] as const);
    const selectExpressions = projection.filter(
      (p): p is Ast.Projection => p._tag === 'Projection',
    );
    const grouped =
      q.groupBy.length > 0 ||
      selectExpressions.some((p) => Ast.containsAggregate(p.expression)) ||
      q.having.some(Ast.containsAggregate) ||
      q.orderBy.some((o) => Ast.containsAggregate(o.expression));

    let translateLevel: (e: Ast.Expression, aliases: ReadonlySet<string>) => Algebra.Expression = (
      e,
    ) => this.expression(e);

    if (grouped) {
      const keys: Array<Algebra.GroupKey> = q.groupBy.map((g) => ({
        expression: this.expression(g.expression),
        variable: g.variable ?? (g.expression._tag === 'Variable' ? g.expression : this.fresh('g')),
      }));
      const keyNames = new Set(keys.map((k) => k.variable.value));
      const aggregates: Array<{ variable: Term.Variable; aggregate: Algebra.Aggregate }> = [];
      const aggregateVariable = (a: Ast.AggregateExpression): Term.Variable => {
        const aggregate: Algebra.Aggregate = {
          name: a.name,
          distinct: a.distinct,
          expression: a.expression === '*' ? '*' : this.expression(a.expression),
          ...(a.separator !== undefined ? { separator: a.separator } : {}),
        };
        const variable = this.fresh('agg');
        aggregates.push({ variable, aggregate });
        return variable;
      };
      // Variables outside aggregates that are not group keys are sampled.
      const sampleVariables = (e: Ast.Expression, aliases: ReadonlySet<string>): Ast.Expression => {
        switch (e._tag) {
          case 'Variable':
            return keyNames.has(e.value) || aliases.has(e.value) ? e : Ast.aggregate('SAMPLE', e);
          case 'Operation':
            return Ast.operation(e.operator, ...e.args.map((a) => sampleVariables(a, aliases)));
          case 'FunctionCall':
            return Ast.functionCall(
              e.function,
              e.args.map((a) => sampleVariables(a, aliases)),
              e.distinct,
            );
          default:
            return e;
        }
      };
      translateLevel = (e, aliases) =>
        this.expression(sampleVariables(e, aliases), aggregateVariable);
      // Translate expressions now so that the aggregates are collected before
      // the Group node is built.
      const having = q.having.map((h) => translateLevel(h, new Set()));
      const aliases = new Set<string>();
      const extensions = selectExpressions.map((p) => {
        const e = translateLevel(p.expression, aliases);
        aliases.add(p.variable.value);
        return { variable: p.variable, expression: e };
      });
      const order = q.orderBy.map((o) => ({
        expression: translateLevel(o.expression, aliases),
        descending: o.descending,
      }));
      op = { _tag: 'Group', input: op, keys, aggregates };
      for (const h of having) op = Algebra.filter(h, op);
      if (q.values !== undefined) op = Algebra.join(op, values(q.values));
      for (const x of extensions) op = Algebra.extend(op, x.variable, x.expression);
      if (order.length > 0) op = { _tag: 'OrderBy', input: op, conditions: order };
    } else {
      for (const h of q.having) op = Algebra.filter(this.expression(h), op);
      if (q.values !== undefined) op = Algebra.join(op, values(q.values));
      for (const p of selectExpressions) {
        op = Algebra.extend(op, p.variable, translateLevel(p.expression, new Set()));
      }
      if (q.orderBy.length > 0) {
        op = {
          _tag: 'OrderBy',
          input: op,
          conditions: q.orderBy.map((o) => ({
            expression: this.expression(o.expression),
            descending: o.descending,
          })),
        };
      }
    }

    const slice = (input: Algebra.Operation): Algebra.Operation =>
      q.offset !== undefined || q.limit !== undefined
        ? { _tag: 'Slice', input, offset: q.offset ?? 0, limit: q.limit }
        : input;
    const dataset = q.dataset !== undefined ? { dataset: q.dataset } : {};

    switch (q._tag) {
      case 'Select': {
        const variables = Ast.projectedVariables(q).map((v) => Term.variable(v));
        op = Algebra.project(op, variables);
        if (q.distinct) op = { _tag: 'Distinct', input: op };
        else if (q.reduced) op = { _tag: 'Reduced', input: op };
        return { _tag: 'Select', input: slice(op), variables, ...dataset };
      }
      case 'Ask':
        return { _tag: 'Ask', input: slice(op), ...dataset };
      case 'Construct':
        return { _tag: 'Construct', input: slice(op), template: q.template, ...dataset };
      case 'Describe': {
        const terms =
          q.terms === '*' ? Ast.inScopeVariables(q.where).map((v) => Term.variable(v)) : q.terms;
        const vars = terms.filter((t): t is Term.Variable => t._tag === 'Variable');
        return {
          _tag: 'Describe',
          input: slice(Algebra.project(op, vars)),
          terms,
          ...dataset,
        };
      }
    }
  }
}

const values = (p: Ast.ValuesPattern): Algebra.Values => ({
  _tag: 'Values',
  variables: p.variables,
  bindings: p.rows.map((row) =>
    Bindings.fromEntries(p.variables.map((v, i) => [v.value, row[i]] as const)),
  ),
});

const isUnit = (op: Algebra.Operation): boolean => op._tag === 'Bgp' && op.patterns.length === 0;

/**
 * Removes joins with the empty BGP (`Join(Z, A)` → `A`).
 *
 * @since 0.1.0
 * @category simplification
 */
export const simplify = (op: Algebra.Operation): Algebra.Operation =>
  Algebra.transform(op, (o) => {
    if (o._tag === 'Join') {
      if (isUnit(o.left)) return o.right;
      if (isUnit(o.right)) return o.left;
    }
    return o;
  });

/**
 * Translates a query to the algebra.
 *
 * @since 0.1.0
 * @category translation
 */
export const translateQuery = (query: Ast.Query): Algebra.Query => {
  const q = new Translator().query(query);
  return { ...q, input: simplify(q.input) };
};

/**
 * Translates a group graph pattern (e.g. the `WHERE` clause of an update) to
 * the algebra.
 *
 * @since 0.1.0
 * @category translation
 */
export const translatePattern = (pattern: Ast.GroupPattern): Algebra.Operation =>
  simplify(new Translator().group(pattern));

/**
 * Translates an expression (which must not contain aggregates) to the
 * algebra.
 *
 * @since 0.1.0
 * @category translation
 */
export const translateExpression = (expression: Ast.Expression): Algebra.Expression =>
  new Translator().expression(expression);
