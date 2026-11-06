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
import * as Arr from 'effect/Array';
import * as Cause from 'effect/Cause';
import * as Match from 'effect/Match';
import * as Predicate from 'effect/Predicate';
import * as Term from '../Term.ts';
import * as Algebra from './Algebra.ts';
import * as Ast from './Ast.ts';
import * as Bindings from './Bindings.ts';
import * as StringMap from './internal/stringMap.ts';

/** Variable names, as a string set. */
type Names = ReadonlyMap<string, true>;

class Translator {
  private counter = 0;

  fresh(kind: string): Term.Variable {
    return Algebra.internalVariable(`${kind}${this.counter++}`);
  }

  // --- terms ----------------------------------------------------------------

  termPattern(t: Ast.TermPattern): Ast.TermPattern {
    return Match.value(t).pipe(
      Match.tag('BlankNode', (b): Ast.TermPattern => Algebra.internalVariable(`b:${b.value}`)),
      Match.tag('Triple', (x) =>
        Term.triple<any, any, any>(
          this.termPattern(x.subject),
          this.termPattern(x.predicate),
          this.termPattern(x.object),
        ),
      ),
      Match.orElse((x) => x),
    );
  }

  // --- graph patterns -------------------------------------------------------

  /** Translates a group graph pattern (without simplification). */
  group(g: Ast.GroupPattern): Algebra.Operation {
    const filters: Array<Ast.Expression> = [];
    // Merge adjacent triple blocks (filters do not separate BGPs).
    const elements: Array<Ast.Pattern> = [];
    g.patterns.forEach((p) => {
      if (Predicate.isTagged(p, 'Filter')) {
        filters.push(p.expression);
        return;
      }
      const last = elements[elements.length - 1];
      if (Predicate.isTagged(p, 'Bgp') && Predicate.isTagged(last, 'Bgp')) {
        elements[elements.length - 1] = Ast.bgp([...last.triples, ...p.triples]);
      } else elements.push(p);
    });
    let result = elements.reduce<Algebra.Operation>(
      (acc, e) =>
        Match.value(e).pipe(
          Match.tag('Optional', (o): Algebra.Operation => {
            const a = this.group(o.pattern);
            return Predicate.isTagged(a, 'Filter')
              ? Algebra.leftJoin(acc, a.input, a.expression)
              : Algebra.leftJoin(acc, a);
          }),
          Match.tag('Minus', (m) => Algebra.minus(acc, this.group(m.pattern))),
          Match.tag('Bind', (b) => Algebra.extend(acc, b.variable, this.expression(b.expression))),
          Match.orElse((p) => Algebra.join(acc, this.pattern(p))),
        ),
      Algebra.unit,
    );
    if (Arr.isReadonlyArrayNonEmpty(filters)) {
      const conjunction = filters
        .map((f) => this.expression(f))
        .reduce((a, b) => ({ _tag: 'Operation', operator: '&&', args: [a, b] }));
      result = Algebra.filter(conjunction, result);
    }
    return result;
  }

  pattern(p: Ast.Pattern): Algebra.Operation {
    return Match.value(p).pipe(
      Match.tag('Bgp', (b): Algebra.Operation => this.triples(b.triples)),
      Match.tag('Group', (g) => this.group(g)),
      Match.tag('Union', (u) =>
        u.patterns.map((g) => this.group(g)).reduce((a, b) => Algebra.union(a, b)),
      ),
      Match.tag('Graph', (g): Algebra.Operation => ({
        _tag: 'Graph',
        name: g.name,
        input: this.group(g.pattern),
      })),
      Match.tag('Service', (s): Algebra.Operation => ({
        _tag: 'Service',
        name: s.name,
        silent: s.silent,
        input: this.group(s.pattern),
        pattern: s.pattern,
        prefixes: {},
      })),
      Match.tag('Values', (v) => values(v)),
      Match.tag('SubSelect', (s) => this.query(s.query).input),
      Match.tag('Optional', (o) => Algebra.leftJoin(Algebra.unit, this.group(o.pattern))),
      Match.tag('Minus', (m) => Algebra.minus(Algebra.unit, this.group(m.pattern))),
      Match.tag('Filter', (f) => Algebra.filter(this.expression(f.expression), Algebra.unit)),
      Match.tag('Bind', (b) =>
        Algebra.extend(Algebra.unit, b.variable, this.expression(b.expression)),
      ),
      Match.exhaustive,
    );
  }

  triples(triples: ReadonlyArray<Ast.TriplePattern | Ast.PathPattern>): Algebra.Operation {
    const parts: Array<Algebra.Operation> = [];
    let current: Array<Ast.TriplePattern> = [];
    const flush = () => {
      if (Arr.isReadonlyArrayNonEmpty(current)) parts.push(Algebra.bgp(current));
      current = [];
    };
    const emitPath = (s: Ast.TermPattern, path: Ast.Path, o: Ast.TermPattern): void => {
      const emitted = Match.value(path).pipe(
        Match.tag('PathLink', (link) => {
          current.push(Ast.triplePattern(s, link.iri, o));
          return true;
        }),
        Match.tag('PathInverse', (inv) => {
          if (!Predicate.isTagged(inv.path, 'PathLink')) return false;
          current.push(Ast.triplePattern(o, inv.path.iri, s));
          return true;
        }),
        Match.tag('PathSequence', (seq) => {
          let from = s;
          seq.paths.forEach((step, i) => {
            const to = i === seq.paths.length - 1 ? o : this.fresh('p');
            emitPath(from, step, to);
            from = to;
          });
          return true;
        }),
        Match.orElse(() => false),
      );
      if (emitted) return;
      flush();
      parts.push({ _tag: 'Path', subject: s, path, object: o });
    };
    triples.forEach((t) => {
      const s = this.termPattern(t.subject);
      const o = this.termPattern(t.object);
      if (Predicate.isTagged(t, 'TriplePattern'))
        current.push(Ast.triplePattern(s, t.predicate, o));
      else emitPath(s, t.path, o);
    });
    flush();
    if (Arr.isReadonlyArrayEmpty(parts)) return Algebra.unit;
    return parts.reduce((a, b) => Algebra.join(a, b));
  }

  // --- expressions ----------------------------------------------------------

  expression(
    e: Ast.Expression,
    aggregates?: (a: Ast.AggregateExpression) => Term.Variable,
  ): Algebra.Expression {
    return Match.value(e).pipe(
      Match.tag(
        'Variable',
        'NamedNode',
        'Literal',
        'BlankNode',
        'Triple',
        (t): Algebra.Expression => t,
      ),
      Match.tag('Operation', (o): Algebra.Expression => ({
        _tag: 'Operation',
        operator: o.operator,
        args: o.args.map((a) => this.expression(a, aggregates)),
      })),
      Match.tag('FunctionCall', (c): Algebra.Expression => ({
        _tag: 'FunctionCall',
        function: c.function,
        args: c.args.map((a) => this.expression(a, aggregates)),
      })),
      // Not simplified: the empty BGPs at the start of each group are the
      // "ContextSolution" through which the current solution flows into
      // the pattern (SPARQL 1.2 §18.6).
      Match.tag('Exists', (x): Algebra.Expression => ({
        _tag: 'Exists',
        negated: x.negated,
        input: this.group(x.pattern),
      })),
      Match.tag('Aggregate', (a) => {
        if (aggregates === undefined)
          throw new Cause.IllegalArgumentError('Aggregate outside of an aggregation context');
        return aggregates(a);
      }),
      Match.exhaustive,
    );
  }

  // --- queries --------------------------------------------------------------

  query(q: Ast.Query): Algebra.Query {
    let op = this.group(q.where);
    const projection =
      Predicate.isTagged(q, 'Select') && q.projection !== '*' ? q.projection : ([] as const);
    const selectExpressions = projection.filter((p): p is Ast.Projection =>
      Predicate.isTagged(p, 'Projection'),
    );
    const grouped =
      Arr.isReadonlyArrayNonEmpty(q.groupBy) ||
      selectExpressions.some((p) => Ast.containsAggregate(p.expression)) ||
      q.having.some(Ast.containsAggregate) ||
      q.orderBy.some((o) => Ast.containsAggregate(o.expression));

    let translateLevel: (e: Ast.Expression, aliases: Names) => Algebra.Expression = (e) =>
      this.expression(e);

    if (grouped) {
      const keys: Array<Algebra.GroupKey> = q.groupBy.map((g) => ({
        expression: this.expression(g.expression),
        variable: g.variable ?? (Term.isVariable(g.expression) ? g.expression : this.fresh('g')),
      }));
      const keyNames = StringMap.setOf([
        ...keys.map((k) => k.variable.value),
        ...(q.values?.variables.map((v) => v.value) ?? []),
      ]);
      const aggregates: Array<{ variable: Term.Variable; aggregate: Algebra.Aggregate }> = [];
      const aggregateVariable = (a: Ast.AggregateExpression): Term.Variable => {
        const unseparated: Algebra.Aggregate = {
          name: a.name,
          distinct: a.distinct,
          expression: a.expression === '*' ? '*' : this.expression(a.expression),
        };
        const aggregate: Algebra.Aggregate =
          a.separator === undefined ? unseparated : { ...unseparated, separator: a.separator };
        const variable = this.fresh('agg');
        aggregates.push({ variable, aggregate });
        return variable;
      };
      // Variables outside aggregates that are not group keys are sampled.
      const sampleVariables = (e: Ast.Expression, aliases: Names): Ast.Expression => {
        return Match.value(e).pipe(
          Match.tag('Variable', (v): Ast.Expression =>
            keyNames.has(v.value) || aliases.has(v.value) ? v : Ast.aggregate('SAMPLE', v),
          ),
          Match.tag('Operation', (o) =>
            Ast.operation(o.operator, ...o.args.map((a) => sampleVariables(a, aliases))),
          ),
          Match.tag('FunctionCall', (c) =>
            Ast.functionCall(
              c.function,
              c.args.map((a) => sampleVariables(a, aliases)),
              c.distinct,
            ),
          ),
          Match.orElse((x) => x),
        );
      };
      translateLevel = (e, aliases) =>
        this.expression(sampleVariables(e, aliases), aggregateVariable);
      // Translate expressions now so that the aggregates are collected before
      // the Group node is built.
      const having = q.having.map((h) => translateLevel(h, StringMap.emptySet()));
      const aliases = StringMap.emptySet();
      const extensions = selectExpressions.map((p) => {
        const e = translateLevel(p.expression, aliases);
        aliases.set(p.variable.value, true);
        return { variable: p.variable, expression: e };
      });
      const order = q.orderBy.map((o) => ({
        expression: translateLevel(o.expression, aliases),
        descending: o.descending,
      }));
      const group: Algebra.Operation = { _tag: 'Group', input: op, keys, aggregates };
      op = having.reduce<Algebra.Operation>((acc, h) => Algebra.filter(h, acc), group);
      if (q.values !== undefined) op = Algebra.join(op, values(q.values));
      op = extensions.reduce<Algebra.Operation>(
        (acc, x) => Algebra.extend(acc, x.variable, x.expression),
        op,
      );
      if (Arr.isReadonlyArrayNonEmpty(order))
        op = { _tag: 'OrderBy', input: op, conditions: order };
    } else {
      op = q.having.reduce<Algebra.Operation>(
        (acc, h) => Algebra.filter(this.expression(h), acc),
        op,
      );
      if (q.values !== undefined) op = Algebra.join(op, values(q.values));
      op = selectExpressions.reduce<Algebra.Operation>(
        (acc, p) =>
          Algebra.extend(acc, p.variable, translateLevel(p.expression, StringMap.emptySet())),
        op,
      );
      if (Arr.isReadonlyArrayNonEmpty(q.orderBy)) {
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

    return Match.value(q).pipe(
      Match.tag('Select', (s): Algebra.Query => {
        const variables = Ast.projectedVariables(s).map((v) => Term.variable(v));
        op = Algebra.project(op, variables);
        if (s.distinct) op = { _tag: 'Distinct', input: op };
        else if (s.reduced) op = { _tag: 'Reduced', input: op };
        return { _tag: 'Select', input: slice(op), variables, ...dataset };
      }),
      Match.tag('Ask', (): Algebra.Query => ({ _tag: 'Ask', input: slice(op), ...dataset })),
      Match.tag('Construct', (c): Algebra.Query => ({
        _tag: 'Construct',
        input: slice(op),
        template: c.template,
        ...dataset,
      })),
      Match.tag('Describe', (d): Algebra.Query => {
        const terms =
          d.terms === '*' ? Ast.inScopeVariables(d.where).map((v) => Term.variable(v)) : d.terms;
        const vars = terms.filter(Term.isVariable);
        return {
          _tag: 'Describe',
          input: slice(Algebra.project(op, vars)),
          terms,
          ...dataset,
        };
      }),
      Match.exhaustive,
    );
  }
}

const values = (p: Ast.ValuesPattern): Algebra.Values => ({
  _tag: 'Values',
  variables: p.variables,
  bindings: p.rows.map((row) =>
    Bindings.fromEntries(p.variables.map((v, i) => [v.value, row[i]] as const)),
  ),
});

const isUnit = (op: Algebra.Operation): boolean =>
  Predicate.isTagged(op, 'Bgp') && Arr.isReadonlyArrayEmpty(op.patterns);

/**
 * Removes joins with the empty BGP (`Join(Z, A)` → `A`).
 *
 * @since 0.1.0
 * @category simplification
 */
export const simplify = (op: Algebra.Operation): Algebra.Operation =>
  Algebra.transform(op, (o) => {
    if (Predicate.isTagged(o, 'Join')) {
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
