/**
 * A small, self-contained Turtle reader used by the conformance tests until
 * the `@thomasfosterau/effect-rdf-turtle` package is available. It supports
 * the full Turtle 1.1 grammar except RDF-star, and keeps blank node labels
 * as written (the shexTest suite refers to them by label).
 */
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { matchAt, RE, unescapeLocal, unescapeString, unescapeUchar } from '../../src/internal/lexer.ts';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

export interface TurtleResult {
  readonly dataset: Dataset.Dataset;
  readonly prefixes: ReadonlyMap<string, string>;
}

export const parseTurtle = (input: string, baseIri?: string): TurtleResult => {
  let pos = 0;
  let base = baseIri;
  const prefixes = new Map<string, string>();
  const quads: Array<Term.Quad> = [];
  let bnodeCounter = 0;

  const fail = (msg: string): never => {
    throw new Error(`Turtle: ${msg} at offset ${pos}: ${JSON.stringify(input.slice(pos, pos + 30))}`);
  };
  const ws = () => {
    const m = matchAt(/(?:\s+|#[^\n\r]*)+/uy, input, pos);
    if (m !== undefined) pos += m.length;
  };
  const peekChar = () => {
    ws();
    return input[pos];
  };
  const eat = (s: string) => {
    ws();
    if (input.startsWith(s, pos)) {
      pos += s.length;
      return true;
    }
    return false;
  };
  const expect = (s: string) => {
    if (!eat(s)) fail(`expected ${s}`);
  };
  const resolve = (iri: string) =>
    base === undefined || Iri.isAbsolute(iri) ? iri : Iri.resolve(iri, base);
  const keyword = (kw: string) => {
    ws();
    const m = matchAt(/[A-Za-z]+/y, input, pos);
    if (m !== undefined && m.toLowerCase() === kw.toLowerCase()) {
      pos += m.length;
      return true;
    }
    return false;
  };

  const iri = (): Term.NamedNode | undefined => {
    ws();
    let m = matchAt(RE.IRIREF, input, pos);
    if (m !== undefined) {
      pos += m.length;
      return Term.namedNode(resolve(unescapeUchar(m.slice(1, -1))));
    }
    m = matchAt(RE.PNAME_LN, input, pos) ?? matchAt(RE.PNAME_NS, input, pos);
    if (m !== undefined) {
      const i = m.indexOf(':');
      const ns = prefixes.get(m.slice(0, i));
      if (ns === undefined) fail(`unknown prefix ${m.slice(0, i)}`);
      pos += m.length;
      return Term.namedNode(ns + unescapeLocal(m.slice(i + 1)));
    }
    return undefined;
  };

  const blank = (): Term.BlankNode | undefined => {
    ws();
    const m = matchAt(RE.BLANK_NODE_LABEL, input, pos);
    if (m !== undefined) {
      pos += m.length;
      return Term.blankNode(m.slice(2));
    }
    return undefined;
  };

  const fresh = () => Term.blankNode(`_g${bnodeCounter++}`);

  const literal = (): Term.Literal | undefined => {
    ws();
    const c = input[pos];
    if (c === '"' || c === "'") {
      let m: string | undefined;
      let q = 3;
      if (input.startsWith(c.repeat(3), pos)) {
        m = matchAt(c === "'" ? RE.STRING_LITERAL_LONG1 : RE.STRING_LITERAL_LONG2, input, pos);
      }
      if (m === undefined) {
        q = 1;
        m = matchAt(c === "'" ? RE.STRING_LITERAL1 : RE.STRING_LITERAL2, input, pos);
      }
      if (m === undefined) return fail('bad string');
      pos += m.length;
      const value = unescapeString(m.slice(q, -q));
      const lang = matchAt(/@[A-Za-z]+(?:-[A-Za-z0-9]+)*(?:--(?:ltr|rtl))?/y, input, pos);
      if (lang !== undefined) {
        pos += lang.length;
        const [tag, dir] = lang.slice(1).split('--');
        return dir === undefined
          ? Term.literal(value, tag!)
          : Term.literal(value, { language: tag!, direction: dir as 'ltr' | 'rtl' });
      }
      if (input.startsWith('^^', pos)) {
        pos += 2;
        const dt = iri();
        if (dt === undefined) return fail('expected datatype');
        return Term.literal(value, dt);
      }
      return Term.literal(value);
    }
    let m = matchAt(RE.DOUBLE, input, pos);
    if (m !== undefined) {
      pos += m.length;
      return Term.literal(m, Term.namedNode(`${XSD}double`));
    }
    m = matchAt(RE.DECIMAL, input, pos);
    if (m !== undefined) {
      pos += m.length;
      return Term.literal(m, Term.namedNode(`${XSD}decimal`));
    }
    m = matchAt(RE.INTEGER, input, pos);
    if (m !== undefined) {
      pos += m.length;
      return Term.literal(m, Term.namedNode(`${XSD}integer`));
    }
    m = matchAt(/(?:true|false)(?![A-Za-z0-9_:-])/y, input, pos);
    if (m !== undefined) {
      pos += m.length;
      return Term.literal(m, Term.namedNode(`${XSD}boolean`));
    }
    return undefined;
  };

  const collection = (): Term.Object => {
    const items: Array<Term.Object> = [];
    while (!eat(')')) items.push(object());
    if (items.length === 0) return Term.namedNode(`${RDF}nil`);
    const nodes = items.map(() => fresh());
    items.forEach((item, i) => {
      quads.push(Term.quad(nodes[i]!, Term.namedNode(`${RDF}first`), item));
      quads.push(
        Term.quad(nodes[i]!, Term.namedNode(`${RDF}rest`), nodes[i + 1] ?? Term.namedNode(`${RDF}nil`)),
      );
    });
    return nodes[0]!;
  };

  const object = (): Term.Object => {
    const c = peekChar();
    if (c === '[') {
      pos++;
      const node = fresh();
      if (!eat(']')) {
        predicateObjectList(node);
        expect(']');
      }
      return node;
    }
    if (c === '(') {
      pos++;
      return collection();
    }
    return blank() ?? literal() ?? iri() ?? fail('expected object');
  };

  const verb = (): Term.NamedNode => {
    ws();
    if (matchAt(/a(?=[\s<"'[(_:#]|$)/y, input, pos) !== undefined) {
      pos++;
      return Term.namedNode(`${RDF}type`);
    }
    return iri() ?? fail('expected predicate');
  };

  const predicateObjectList = (subject: Term.Subject) => {
    for (;;) {
      const p = verb();
      do {
        quads.push(Term.quad(subject, p, object()));
      } while (eat(','));
      if (!eat(';')) return;
      while (eat(';'));
      const c = peekChar();
      if (c === '.' || c === ']' || c === undefined) return;
    }
  };

  const statement = () => {
    if (eat('@prefix')) {
      ws();
      const m = matchAt(RE.PNAME_NS, input, pos) ?? fail('expected prefix');
      pos += m.length;
      const ns = iri() ?? fail('expected IRI');
      prefixes.set(m.slice(0, -1), ns.value);
      expect('.');
      return;
    }
    if (eat('@base')) {
      base = (iri() ?? fail('expected IRI')).value;
      expect('.');
      return;
    }
    const save = pos;
    if (keyword('PREFIX')) {
      ws();
      const m = matchAt(RE.PNAME_NS, input, pos) ?? fail('expected prefix');
      pos += m.length;
      prefixes.set(m.slice(0, -1), (iri() ?? fail('expected IRI')).value);
      return;
    }
    pos = save;
    if (keyword('BASE')) {
      base = (iri() ?? fail('expected IRI')).value;
      return;
    }
    pos = save;
    const c = peekChar();
    let subject: Term.Subject;
    if (c === '[') {
      pos++;
      subject = fresh();
      if (!eat(']')) {
        predicateObjectList(subject);
        expect(']');
        if (eat('.')) return;
      }
    } else if (c === '(') {
      pos++;
      subject = collection() as Term.Subject;
    } else {
      subject = blank() ?? iri() ?? fail('expected subject');
    }
    predicateObjectList(subject);
    expect('.');
  };

  for (;;) {
    ws();
    if (pos >= input.length) break;
    statement();
  }
  return { dataset: Dataset.fromIterable(quads), prefixes };
};
