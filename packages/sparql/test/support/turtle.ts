/**
 * A small Turtle / TriG / N-Triples / N-Quads reader used by the conformance
 * tests to load manifests and test data, until the real Turtle package is
 * available. Supports RDF 1.2 triple terms, reified triples and annotations.
 */
import { Iri, Term } from '@thomasfosterau/effect-rdf';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const PN_CHARS_BASE =
  'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const PN_CHARS_U = `${PN_CHARS_BASE}_`;
const PN_CHARS = `${PN_CHARS_U}\\-0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const PLX = `%[0-9A-Fa-f]{2}|\\\\[_~.\\-!$&'()*+,;=/?#@%]`;
const PN_PREFIX = `[${PN_CHARS_BASE}](?:[${PN_CHARS}.]*[${PN_CHARS}])?`;
const PN_LOCAL = `(?:[${PN_CHARS_U}:0-9]|${PLX})(?:(?:[${PN_CHARS}.:]|${PLX})*(?:[${PN_CHARS}:]|${PLX}))?`;
const RE_PNAME = new RegExp(`(${PN_PREFIX})?:(${PN_LOCAL})?`, 'uy');
const RE_BNODE = new RegExp(`_:([${PN_CHARS_U}0-9](?:[${PN_CHARS}.]*[${PN_CHARS}])?)`, 'uy');
const RE_WS = /(?:[ \t\r\n]|#[^\r\n]*)*/y;
const RE_NUMBER =
  /[+-]?(?:[0-9]+(?:\.[0-9]*)?[eE][+-]?[0-9]+|\.[0-9]+[eE][+-]?[0-9]+|[0-9]*\.[0-9]+|[0-9]+)/y;
const RE_LANG = /@([a-zA-Z]+(?:-[a-zA-Z0-9]+)*(?:--[a-zA-Z]+)?)/y;

export class TurtleError extends Error {}

const unescape = (s: string): string =>
  s.replace(/\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})|\\(.)/gs, (_, u4, u8, c) => {
    if (u4 !== undefined || u8 !== undefined) return String.fromCodePoint(parseInt(u4 ?? u8, 16));
    switch (c) {
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      default:
        return c;
    }
  });

let docCounter = 0;

export const parseTurtle = (
  input: string,
  baseIri?: string,
  defaultGraph: Term.Graph = Term.defaultGraph,
): Array<Term.Quad> => {
  const doc = `t${docCounter++}_`;
  let pos = 0;
  let base = baseIri;
  const prefixes: Record<string, string> = {};
  const out: Array<Term.Quad> = [];
  let graph: Term.Graph = defaultGraph;
  let bnodes = 0;

  const err = (msg: string): never => {
    throw new TurtleError(`${msg} at ${pos}: ${JSON.stringify(input.slice(pos, pos + 40))}`);
  };
  const ws = () => {
    RE_WS.lastIndex = pos;
    RE_WS.exec(input);
    pos = RE_WS.lastIndex;
  };
  const peek = (s: string) => {
    ws();
    return input.startsWith(s, pos);
  };
  const eat = (s: string) => {
    if (peek(s)) {
      pos += s.length;
      return true;
    }
    return false;
  };
  const expect = (s: string) => {
    if (!eat(s)) err(`Expected '${s}'`);
  };
  const keyword = (k: string): boolean => {
    ws();
    const slice = input.slice(pos, pos + k.length);
    if (
      slice.toUpperCase() === k.toUpperCase() &&
      !/[A-Za-z0-9_:-]/.test(input[pos + k.length] ?? '')
    ) {
      pos += k.length;
      return true;
    }
    return false;
  };
  const fresh = () => Term.blankNode(`${doc}g${bnodes++}`);
  const iriRef = (): string => {
    ws();
    if (input[pos] !== '<') err('Expected IRI');
    const end = input.indexOf('>', pos);
    const raw = unescape(input.slice(pos + 1, end));
    pos = end + 1;
    return base !== undefined ? Iri.resolve(raw, base) : raw;
  };
  const iri = (): Term.NamedNode => {
    ws();
    if (input[pos] === '<' && input[pos + 1] !== '<') return Term.namedNode(iriRef());
    RE_PNAME.lastIndex = pos;
    const m = RE_PNAME.exec(input);
    if (m === null) return err('Expected IRI or prefixed name');
    pos = RE_PNAME.lastIndex;
    const ns = prefixes[m[1] ?? ''];
    if (ns === undefined) err(`Unknown prefix ${m[1]}`);
    return Term.namedNode(ns + (m[2] ?? '').replace(/\\(.)/g, '$1'));
  };
  const string = (): string => {
    const q = input[pos]!;
    const long = input.startsWith(q.repeat(3), pos);
    if (long) {
      let i = pos + 3;
      for (;;) {
        if (input[i] === '\\') i += 2;
        else if (input.startsWith(q.repeat(3), i)) {
          while (input[i + 3] === q) i++;
          break;
        } else i++;
      }
      const s = input.slice(pos + 3, i);
      pos = i + 3;
      return unescape(s);
    }
    let i = pos + 1;
    while (input[i] !== q) i += input[i] === '\\' ? 2 : 1;
    const s = input.slice(pos + 1, i);
    pos = i + 1;
    return unescape(s);
  };
  const literalTail = (value: string): Term.Literal => {
    RE_LANG.lastIndex = pos;
    const lm = RE_LANG.exec(input);
    if (lm !== null) {
      pos = RE_LANG.lastIndex;
      const tag = lm[1]!;
      const i = tag.indexOf('--');
      return i === -1
        ? Term.literal(value, tag)
        : Term.literal(value, {
            language: tag.slice(0, i),
            direction: tag.slice(i + 2) as Term.Direction,
          });
    }
    if (input.startsWith('^^', pos)) {
      pos += 2;
      return Term.literal(value, iri());
    }
    return Term.literal(value);
  };
  const emit = (s: Term.Term, p: Term.Term, o: Term.Term) => {
    out.push(new Term.Quad(s as Term.Subject, p as Term.Predicate, o as Term.Object, graph));
  };

  const tripleTerm = (): Term.Triple => {
    expect('<<(');
    const s = node(false);
    const p = verb();
    const o = node(false);
    expect(')>>');
    return Term.triple(s as Term.Subject, p, o as Term.Object);
  };
  const reified = (): Term.Term => {
    expect('<<');
    const s = node(false);
    const p = verb();
    const o = node(false);
    let r: Term.Term = fresh();
    if (eat('~')) {
      ws();
      if (!peek('>>')) r = node(false);
    }
    expect('>>');
    emit(r, Term.namedNode(`${RDF}reifies`), Term.triple(s as Term.Subject, p, o as Term.Object));
    return r;
  };
  const node = (allowCollections = true): Term.Term => {
    ws();
    const c = input[pos]!;
    if (input.startsWith('<<(', pos)) return tripleTerm();
    if (input.startsWith('<<', pos)) return reified();
    if (c === '<') return Term.namedNode(iriRef());
    if (c === '_' && input[pos + 1] === ':') {
      RE_BNODE.lastIndex = pos;
      const m = RE_BNODE.exec(input);
      if (m === null) err('Bad blank node');
      pos = RE_BNODE.lastIndex;
      return Term.blankNode(doc + m![1]!);
    }
    if (c === '[') {
      pos++;
      const b = fresh();
      if (!peek(']')) predicateObjectList(b);
      expect(']');
      return b;
    }
    if (c === '(' && allowCollections) {
      pos++;
      const items: Array<Term.Term> = [];
      while (!peek(')')) items.push(node());
      expect(')');
      if (items.length === 0) return Term.namedNode(`${RDF}nil`);
      const nodes = items.map(fresh);
      items.forEach((item, i) => {
        emit(nodes[i]!, Term.namedNode(`${RDF}first`), item);
        emit(nodes[i]!, Term.namedNode(`${RDF}rest`), nodes[i + 1] ?? Term.namedNode(`${RDF}nil`));
      });
      return nodes[0]!;
    }
    if (c === '"' || c === "'") return literalTail(string());
    RE_NUMBER.lastIndex = pos;
    const nm = RE_NUMBER.exec(input);
    if (nm !== null) {
      pos = RE_NUMBER.lastIndex;
      const t = nm[0];
      const dt = /[eE]/.test(t) ? 'double' : t.includes('.') ? 'decimal' : 'integer';
      return Term.literal(t, Term.namedNode(XSD + dt));
    }
    if (keyword('true')) return Term.literal('true', Term.namedNode(`${XSD}boolean`));
    if (keyword('false')) return Term.literal('false', Term.namedNode(`${XSD}boolean`));
    return iri();
  };
  const verb = (): Term.NamedNode => {
    ws();
    if (input[pos] === 'a' && /[\s<"'[(_:]/.test(input[pos + 1] ?? '')) {
      pos++;
      return Term.namedNode(`${RDF}type`);
    }
    return iri();
  };
  const annotation = (s: Term.Term, p: Term.NamedNode, o: Term.Term) => {
    let current: Term.Term | undefined;
    const t = Term.triple(s as Term.Subject, p, o as Term.Object);
    for (;;) {
      if (eat('~')) {
        ws();
        current =
          peek('{|') || peek('.') || peek(';') || peek(',') || peek(']') || peek('}')
            ? fresh()
            : node(false);
        emit(current, Term.namedNode(`${RDF}reifies`), t);
      } else if (eat('{|')) {
        if (current === undefined) {
          current = fresh();
          emit(current, Term.namedNode(`${RDF}reifies`), t);
        }
        predicateObjectList(current);
        expect('|}');
        current = undefined;
      } else return;
    }
  };
  const predicateObjectList = (s: Term.Term) => {
    for (;;) {
      const p = verb();
      for (;;) {
        const o = node();
        emit(s, p, o);
        annotation(s, p, o);
        if (!eat(',')) break;
      }
      if (!eat(';')) return;
      while (eat(';'));
      ws();
      if (peek('.') || peek(']') || peek('}') || peek('|}') || pos >= input.length) return;
    }
  };
  const triples = () => {
    ws();
    const isBlankList = input[pos] === '[';
    const s = node();
    ws();
    if (isBlankList && (peek('.') || peek('}'))) return;
    if (s._tag === 'Triple' && (peek('.') || peek('}'))) return;
    if (input.startsWith('<<', pos) === false && (peek('.') || peek('}')) && s._tag === 'BlankNode')
      return;
    predicateObjectList(s);
  };
  const block = (end: string | undefined) => {
    for (;;) {
      ws();
      if (end !== undefined && peek(end)) return;
      if (pos >= input.length) {
        if (end !== undefined) err(`Expected '${end}'`);
        return;
      }
      if (eat('@prefix') || keyword('PREFIX')) {
        ws();
        const m = /([^\s:]*):/y;
        m.lastIndex = pos;
        const r = m.exec(input);
        if (r === null) err('Bad prefix');
        pos = m.lastIndex;
        prefixes[r![1]!] = iriRef();
        eat('.');
        continue;
      }
      if (eat('@base') || keyword('BASE')) {
        base = iriRef();
        eat('.');
        continue;
      }
      if (keyword('VERSION') || eat('@version')) {
        ws();
        string();
        eat('.');
        continue;
      }
      if (end === undefined) {
        // TriG graph blocks
        if (keyword('GRAPH')) {
          const g = node() as Term.Graph;
          expect('{');
          graph = g;
          block('}');
          expect('}');
          graph = defaultGraph;
          continue;
        }
        if (peek('{')) {
          expect('{');
          block('}');
          expect('}');
          continue;
        }
        const save = pos;
        const save2 = out.length;
        if (input[pos] === '<' || input[pos] === '_' || /[A-Za-z:]/.test(input[pos] ?? '')) {
          try {
            const g = node(false);
            if (peek('{') && g._tag !== 'Literal' && g._tag !== 'Triple') {
              expect('{');
              graph = g as Term.Graph;
              block('}');
              expect('}');
              graph = defaultGraph;
              continue;
            }
          } catch {
            // not a graph name
          }
          pos = save;
          out.length = save2;
        }
      }
      triples();
      ws();
      if (!eat('.')) {
        if (end !== undefined && peek(end)) return;
        // N-Quads style graph label
        if (end === undefined && pos < input.length) {
          const g = node(false);
          const last = out.pop()!;
          out.push(new Term.Quad(last.subject, last.predicate, last.object, g as Term.Graph));
          expect('.');
          continue;
        }
        if (pos < input.length) err("Expected '.'");
      }
    }
  };
  block(undefined);
  return out;
};
