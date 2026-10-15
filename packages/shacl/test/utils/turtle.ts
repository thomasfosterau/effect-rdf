/**
 * A small, self-contained Turtle reader used only by the tests (the SHACL
 * test suite is written in Turtle). It supports prefixes, base IRIs, `a`,
 * predicate/object lists, blank node property lists, collections and all
 * literal forms (numbers, booleans, short/long strings, language tags and
 * datatypes).
 *
 * This is deliberately isolated so it can be swapped for
 * `@thomasfosterau/effect-rdf-turtle` later.
 */
import { Dataset, Iri, Term, Vocab } from '@thomasfosterau/effect-rdf';

const { rdf, xsd } = Vocab;

let documentCounter = 0;

/**
 * Parses a Turtle document into a dataset (default graph). Blank node labels
 * are made unique per document. Throws on syntax errors.
 */
export const parseTurtle = (input: string, baseIri?: string): Dataset.Dataset => {
  const docPrefix = `d${documentCounter++}_`;
  let pos = 0;
  let base = baseIri;
  const prefixes = new Map<string, string>();
  const quads: Array<Term.Quad> = [];
  let fresh = 0;
  const freshBlank = () => new Term.BlankNode(`${docPrefix}g${fresh++}`);
  const labelled = new Map<string, Term.BlankNode>();

  const fail = (message: string): never => {
    const line = input.slice(0, pos).split('\n').length;
    throw new Error(`Turtle syntax error at line ${line}: ${message}`);
  };

  const skipWs = () => {
    while (pos < input.length) {
      const c = input[pos]!;
      if (c === '#') {
        while (pos < input.length && input[pos] !== '\n') pos++;
      } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        pos++;
      } else break;
    }
  };

  const peek = () => input[pos];
  const startsWith = (s: string) => input.startsWith(s, pos);
  const expect = (s: string) => {
    skipWs();
    if (!startsWith(s)) fail(`expected '${s}'`);
    pos += s.length;
  };

  const unescapeUnicode = (hex: string) => String.fromCodePoint(parseInt(hex, 16));

  const readIriRef = (): string => {
    // at '<'
    pos++;
    let out = '';
    while (pos < input.length && input[pos] !== '>') {
      const c = input[pos]!;
      if (c === '\\') {
        const k = input[pos + 1];
        if (k === 'u') {
          out += unescapeUnicode(input.slice(pos + 2, pos + 6));
          pos += 6;
        } else if (k === 'U') {
          out += unescapeUnicode(input.slice(pos + 2, pos + 10));
          pos += 10;
        } else fail('bad IRI escape');
      } else {
        out += c;
        pos++;
      }
    }
    if (pos >= input.length) fail('unterminated IRI');
    pos++;
    return Iri.resolve(out, base);
  };

  const PN_CHARS = /[A-Za-z0-9_\-·À-￿]/u;

  const readPrefixedName = (): Term.NamedNode => {
    let prefix = '';
    while (pos < input.length && input[pos] !== ':') {
      const c = input[pos]!;
      if (PN_CHARS.test(c) || (c === '.' && prefix.length > 0)) {
        prefix += c;
        pos++;
      } else fail(`bad prefixed name character '${c}'`);
    }
    pos++; // ':'
    let local = '';
    while (pos < input.length) {
      const c = input[pos]!;
      if (c === '\\') {
        local += input[pos + 1];
        pos += 2;
      } else if (c === '%') {
        local += input.slice(pos, pos + 3);
        pos += 3;
      } else if (PN_CHARS.test(c) || c === ':') {
        local += c;
        pos++;
      } else if (c === '.') {
        // a dot may only appear inside a local name, not at its end
        const next = input[pos + 1];
        if (next !== undefined && (PN_CHARS.test(next) || next === ':' || next === '%')) {
          local += c;
          pos++;
        } else break;
      } else break;
    }
    const ns = prefixes.get(prefix);
    if (ns === undefined) fail(`unknown prefix '${prefix}'`);
    return Term.namedNode(ns + local);
  };

  const readString = (): string => {
    const q = peek()!;
    const long = startsWith(q.repeat(3));
    pos += long ? 3 : 1;
    let out = '';
    for (;;) {
      if (pos >= input.length) fail('unterminated string');
      const c = input[pos]!;
      if (long ? startsWith(q.repeat(3)) : c === q) {
        // In long strings, more than three quotes: the extra quotes belong to the content.
        if (long) {
          while (input[pos + 3] === q) {
            out += q;
            pos++;
          }
          pos += 3;
        } else pos++;
        return out;
      }
      if (!long && (c === '\n' || c === '\r')) fail('newline in short string');
      if (c === '\\') {
        const k = input[pos + 1]!;
        pos += 2;
        switch (k) {
          case 't':
            out += '\t';
            break;
          case 'b':
            out += '\b';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 'f':
            out += '\f';
            break;
          case '"':
          case "'":
          case '\\':
            out += k;
            break;
          case 'u':
            out += unescapeUnicode(input.slice(pos, pos + 4));
            pos += 4;
            break;
          case 'U':
            out += unescapeUnicode(input.slice(pos, pos + 8));
            pos += 8;
            break;
          default:
            fail(`bad string escape '\\${k}'`);
        }
      } else {
        out += c;
        pos++;
      }
    }
  };

  const readLiteral = (): Term.Literal => {
    const value = readString();
    if (peek() === '@') {
      pos++;
      const m = /^[A-Za-z]+(?:-[A-Za-z0-9]+)*/.exec(input.slice(pos));
      if (m === null) fail('bad language tag');
      pos += m![0].length;
      if (startsWith('--')) {
        const d = /^--(ltr|rtl)/.exec(input.slice(pos));
        if (d === null) fail('bad direction');
        pos += d![0].length;
        return Term.literal(value, { language: m![0], direction: d![1] as Term.Direction });
      }
      return Term.literal(value, m![0]);
    }
    if (startsWith('^^')) {
      pos += 2;
      return Term.literal(value, readIri());
    }
    return Term.literal(value);
  };

  const readIri = (): Term.NamedNode => {
    skipWs();
    if (peek() === '<') return Term.namedNode(readIriRef());
    return readPrefixedName();
  };

  const readNumber = (): Term.Literal => {
    const m = /^[+-]?(?:\d+\.\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+|\d+)/.exec(
      input.slice(pos),
    );
    if (m === null) fail('bad number');
    let text = m![0];
    // A trailing '.' is the statement terminator, not part of the number.
    if (text.endsWith('.')) text = text.slice(0, -1);
    pos += text.length;
    const dt = /[eE]/.test(text) ? xsd.double : text.includes('.') ? xsd.decimal : xsd.integer;
    return Term.literal(text, dt);
  };

  const readBlankLabel = (): Term.BlankNode => {
    pos += 2;
    const m = /^[A-Za-z0-9_À-￿](?:[A-Za-z0-9_\-.·À-￿]*[A-Za-z0-9_\-·À-￿])?/u.exec(input.slice(pos));
    if (m === null) fail('bad blank node label');
    pos += m![0].length;
    let node = labelled.get(m![0]);
    if (node === undefined) {
      node = new Term.BlankNode(`${docPrefix}${m![0]}`);
      labelled.set(m![0], node);
    }
    return node;
  };

  const emit = (s: Term.Term, p: Term.NamedNode, o: Term.Term) =>
    quads.push(Term.quad(s as Term.Subject, p, o as Term.Object));

  const readCollection = (): Term.Term => {
    pos++; // '('
    const items: Array<Term.Term> = [];
    for (;;) {
      skipWs();
      if (peek() === ')') {
        pos++;
        break;
      }
      items.push(readObject());
    }
    if (items.length === 0) return rdf.nil;
    const nodes = items.map(() => freshBlank());
    items.forEach((item, i) => {
      emit(nodes[i]!, rdf.first, item);
      emit(nodes[i]!, rdf.rest, nodes[i + 1] ?? rdf.nil);
    });
    return nodes[0]!;
  };

  const readBlankPropertyList = (): Term.Term => {
    pos++; // '['
    const node = freshBlank();
    skipWs();
    if (peek() === ']') {
      pos++;
      return node;
    }
    readPredicateObjectList(node);
    expect(']');
    return node;
  };

  const isKeyword = (word: string) => {
    if (!startsWith(word)) return false;
    const next = input[pos + word.length];
    return next === undefined || !/[A-Za-z0-9_:-]/.test(next);
  };

  const readObject = (): Term.Term => {
    skipWs();
    const c = peek();
    if (c === '<') return Term.namedNode(readIriRef());
    if (c === '"' || c === "'") return readLiteral();
    if (c === '[') return readBlankPropertyList();
    if (c === '(') return readCollection();
    if (c === '_' && input[pos + 1] === ':') return readBlankLabel();
    if (c !== undefined && /[0-9+\-.]/.test(c)) return readNumber();
    if (isKeyword('true')) {
      pos += 4;
      return Term.literal('true', xsd.boolean);
    }
    if (isKeyword('false')) {
      pos += 5;
      return Term.literal('false', xsd.boolean);
    }
    return readPrefixedName();
  };

  const readSubject = (): Term.Term => {
    skipWs();
    const c = peek();
    if (c === '<') return Term.namedNode(readIriRef());
    if (c === '[') return readBlankPropertyList();
    if (c === '(') return readCollection();
    if (c === '_' && input[pos + 1] === ':') return readBlankLabel();
    return readPrefixedName();
  };

  const readVerb = (): Term.NamedNode => {
    skipWs();
    if (peek() === 'a') {
      const next = input[pos + 1];
      if (next === undefined || /[\s<[("'_]/.test(next)) {
        pos++;
        return rdf.type;
      }
    }
    return readIri();
  };

  const readPredicateObjectList = (subject: Term.Term) => {
    for (;;) {
      const predicate = readVerb();
      for (;;) {
        emit(subject, predicate, readObject());
        skipWs();
        if (peek() === ',') {
          pos++;
          continue;
        }
        break;
      }
      skipWs();
      if (peek() !== ';') return;
      while (peek() === ';') {
        pos++;
        skipWs();
      }
      const c = peek();
      if (c === '.' || c === ']' || c === undefined) return;
    }
  };

  const readDirective = (): boolean => {
    const sparqlStyle = /^(PREFIX|BASE)\b/i.exec(input.slice(pos));
    if (
      startsWith('@prefix') ||
      (sparqlStyle !== null && sparqlStyle[1]!.toUpperCase() === 'PREFIX')
    ) {
      const at = startsWith('@');
      pos += at ? 7 : 6;
      skipWs();
      const m = /^([^:\s]*):/.exec(input.slice(pos));
      if (m === null) fail('bad prefix declaration');
      pos += m![0].length;
      skipWs();
      prefixes.set(m![1]!, readIriRef());
      if (at) expect('.');
      return true;
    }
    if (startsWith('@base') || (sparqlStyle !== null && sparqlStyle[1]!.toUpperCase() === 'BASE')) {
      const at = startsWith('@');
      pos += at ? 5 : 4;
      skipWs();
      base = readIriRef();
      if (at) expect('.');
      return true;
    }
    return false;
  };

  for (;;) {
    skipWs();
    if (pos >= input.length) break;
    if (readDirective()) continue;
    const subject = readSubject();
    skipWs();
    // A bare blank node property list may stand alone as a statement.
    if (peek() === '.' && Term.isBlankNode(subject)) {
      pos++;
      continue;
    }
    readPredicateObjectList(subject);
    expect('.');
  }

  return Dataset.fromIterable(quads);
};
