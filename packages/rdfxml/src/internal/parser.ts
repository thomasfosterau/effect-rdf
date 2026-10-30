/**
 * The XML 1.0 parser behind `Xml.parse`: a compiled
 * `@thomasfosterau/effect-parse` grammar over the (line-end normalised)
 * input, building the document tree as it reads.
 *
 * Element content is read by one loop over start tags, end tags, text and
 * the other markup, with the open elements on an explicit stack, so deeply
 * nested documents cannot exhaust the call stack. Errors are thrown (as a
 * `Failure` at an offset) out of the grammar.
 *
 * The parser guards against hostile documents:
 *
 * - external entities and parameter entities are never loaded;
 * - the replacement text of entity references may add up to at most
 *   `MAX_ENTITY_EXPANSION` characters (which defeats "billion laughs");
 * - entity references nest at most `MAX_ENTITY_DEPTH` deep, and elements at
 *   most `MAX_ELEMENT_DEPTH` deep;
 * - the replacement text of an entity that contains markup is parsed with
 *   the document's tables, not copies of them, so that many such entities
 *   and references cost time in proportion to the text expanded.
 *
 * @internal
 */
import * as Compiler from '@thomasfosterau/effect-parse/Compiler';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Token from '@thomasfosterau/effect-parse/Token';
import * as HashSet from 'effect/HashSet';
import * as Result from 'effect/Result';
import type * as Xml from '../Xml.ts';
import {
  isName,
  isNCName,
  isValidText,
  nameChar,
  nameStart,
  NMTOKEN_RE,
  PUBID_RE,
  space,
} from './chars.ts';

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

/** The most replacement text that entity references may add to a document. */
export const MAX_ENTITY_EXPANSION = 1_000_000;

/** How deeply entity references may nest. */
export const MAX_ENTITY_DEPTH = 64;

/** How deeply elements may nest. */
export const MAX_ELEMENT_DEPTH = 1024;

/** A well-formedness error at an offset, thrown out of the grammar. */
export class Failure {
  readonly message: string;
  readonly offset: number;
  constructor(message: string, offset: number) {
    this.message = message;
    this.offset = offset;
  }
}

type P<A> = Parser.Parser<A>;

interface AttributeDefault {
  readonly name: string;
  readonly value: string;
  readonly tokenized: boolean;
}

interface RawAttribute {
  readonly name: string;
  value: string;
  readonly offset: number;
  readonly defaulted: boolean;
}

/** An open element (or the content an entity's replacement text adds). */
interface Frame {
  readonly qname: string;
  readonly start: number;
  readonly prefix: string;
  readonly localName: string;
  readonly namespace: string | undefined;
  readonly attributes: ReadonlyArray<Xml.Attribute>;
  readonly declarations: ReadonlyArray<Xml.NamespaceDeclaration>;
  readonly inScope: ReadonlyMap<string, string>;
  readonly children: Array<Xml.Node>;
  text: string;
  textStart: number;
}

const PREDEFINED = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['apos', "'"],
  ['quot', '"'],
]);

const baseFrame = (inScope: ReadonlyMap<string, string>): Frame => ({
  qname: '',
  start: 0,
  prefix: '',
  localName: '',
  namespace: undefined,
  attributes: [],
  declarations: [],
  inScope,
  children: [],
  text: '',
  textStart: -1,
});

/** The document being parsed. */
class Context {
  /** The text being parsed: the document, or an entity's replacement text. */
  src: string;
  lineStarts: ReadonlyArray<number>;
  readonly entities = new Map<string, string>();
  readonly externalEntities = new Set<string>();
  readonly attributeDefaults = new Map<string, Array<AttributeDefault>>();
  readonly attributeTypes = new Map<string, Map<string, boolean>>();
  expanded = 0;
  hasExternalSubset = false;

  /** The frames of the open elements; those below `base` belong to enclosing text. */
  stack: Array<Frame>;
  base = 1;
  /** The entities whose replacement text is being parsed. */
  entityStack: ReadonlySet<string> = new Set();

  // The parts of the document
  version: string | undefined;
  encoding: string | undefined;
  standalone: boolean | undefined;
  doctype: Xml.DocumentType | undefined;
  readonly prolog: Array<Xml.Comment | Xml.ProcessingInstruction> = [];
  readonly epilog: Array<Xml.Comment | Xml.ProcessingInstruction> = [];
  root: Xml.Element | undefined;

  // Registers for the markup being read (none of it nests)
  tagStart = 0;
  qname = '';
  raw: Array<RawAttribute> = [];
  seen = new Set<string>();
  attlistElement = '';
  attributeName = '';
  attributeType = '';
  tokenized = false;
  entityName = '';
  parameter = false;
  entityValue: string | undefined;
  doctypeName = '';
  publicId: string | undefined;
  systemId: string | undefined;

  constructor(src: string, lineStarts: ReadonlyArray<number>) {
    this.src = src;
    this.lineStarts = lineStarts;
    this.stack = [baseFrame(new Map())];
  }

  position(offset: number): Xml.Position {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { offset, line: lo + 1, column: offset - this.lineStarts[lo]! + 1 };
  }

  top(): Frame {
    return this.stack[this.stack.length - 1]!;
  }
}

let x = new Context('', [0]);

const fail: (message: string, offset: number) => never = (message, offset) => {
  throw new Failure(message, offset);
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const lit = Token.literal;

/** Runs `f` at the current offset, consuming nothing. */
const act = (f: (pos: number) => void): P<number> => Parser.tap(Parser.location, f);

/** Throws `message` at the current offset. */
const failHere = <A = never>(message: string): P<A> =>
  Parser.map(Parser.location, (pos): A => fail(message, pos));

const at = (s: string): P<unknown> => Parser.peek(lit(s));

const ws: P<string> = Token.takeWhile(space);
const requireWs: P<unknown> = Parser.alt(
  Token.takeWhile(space, { min: 1 }),
  failHere('Expected white space'),
);

/** Fails unless white space was just read (`ws` may have read none). */
const afterWs: P<void> = Parser.make<void>((state) => {
  const c = state.input.charCodeAt(state.pos - 1);
  if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) fail('Expected white space', state.pos);
  return undefined;
});

const expect = (s: string): P<unknown> => Parser.alt(lit(s), failHere(`Expected "${s}"`));

const name: P<string> = Parser.alt(
  Parser.taken(Parser.seq(Token.oneOf(nameStart), Token.takeWhile(nameChar))),
  failHere('Expected a name'),
);

const eq: P<unknown> = Parser.seq(ws, expect('='), ws);

/** A quoted string, without its quotes. */
const quoted: P<string> = Parser.alt(
  Parser.preceded(
    Parser.peek(Token.oneOf('"\'')),
    Parser.alt(
      Parser.delimited(lit('"'), Token.takeTill('"'), lit('"')),
      Parser.delimited(lit("'"), Token.takeTill("'"), lit("'")),
      failHere('Unterminated quoted string'),
    ),
  ),
  failHere('Expected a quoted string'),
);

/** `p`, then `check` with its value and the offset after it. */
const checked = <A>(p: P<A>, check: (a: A, pos: number) => void): P<A> =>
  Parser.seq(p, Parser.location).pipe(
    Parser.tap(([a, pos]) => check(a, pos)),
    Parser.map(([a]) => a),
  );

const withEntry = (set: ReadonlySet<string>, entry: string): Set<string> => {
  const next = new Set(set);
  next.add(entry);
  return next;
};

const collapse = (value: string): string => value.replace(/ +/g, ' ').replace(/^ | $/g, '');

// -----------------------------------------------------------------------------
// References
// -----------------------------------------------------------------------------

const charRef = (body: string, offset: number): string => {
  const code = body.startsWith('#x') ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
  if (!(code <= 0x10ffff)) fail('Invalid character reference', offset);
  const ch = String.fromCodePoint(code);
  if (!isValidText(ch)) fail('Character reference to an invalid character', offset);
  return ch;
};

/** Expands the character references in an entity value, leaving entity references. */
const expandCharRefs = (raw: string, offset: number): string =>
  raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[^;]*);|&/g, (m, body: string | undefined, i: number) => {
    if (body === undefined) fail('Invalid reference', offset + i);
    if (body.startsWith('#')) return charRef(body, offset + i);
    if (!isName(body)) fail('Invalid entity reference', offset + i);
    return m;
  });

/** The replacement text of a reference to `name`, counted against the expansion limit. */
const entityText = (name: string, offset: number, stack: ReadonlySet<string>): string => {
  if (!isName(name)) fail('Invalid entity reference', offset);
  const predefined = PREDEFINED.get(name);
  if (predefined !== undefined)
    return predefined === '<' ? '&#60;' : predefined === '&' ? '&#38;' : predefined;
  if (x.externalEntities.has(name)) fail(`External entity "${name}" is not supported`, offset);
  const value = x.entities.get(name);
  if (value === undefined) fail(`Undefined entity "${name}"`, offset);
  if (stack.has(name)) fail(`Recursive entity "${name}"`, offset);
  if (stack.size >= MAX_ENTITY_DEPTH) fail('Entity references are nested too deeply', offset);
  x.expanded += value.length;
  if (x.expanded > MAX_ENTITY_EXPANSION) fail('Entity expansion limit exceeded', offset);
  return value;
};

/** Normalises an attribute value (XML 1.0 §3.3.3). */
const normalizeAttribute = (raw: string, offset: number, stack: ReadonlySet<string>): string => {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '<') fail('"<" is not allowed in attribute values', offset + i);
    if (c === '&') {
      const semi = raw.indexOf(';', i);
      if (semi === -1) fail('Unterminated reference', offset + i);
      const body = raw.slice(i + 1, semi);
      if (body.startsWith('#')) {
        if (!/^#(x[0-9a-fA-F]+|[0-9]+)$/.test(body))
          fail('Invalid character reference', offset + i);
        out += charRef(body, offset + i);
      } else {
        const replacement = entityText(body, offset + i, stack);
        out += normalizeAttribute(replacement, offset + i, withEntry(stack, body));
      }
      i = semi + 1;
    } else {
      out += c === '\t' || c === '\n' || c === '\r' ? ' ' : c;
      i++;
    }
  }
  return out;
};

/** An attribute value literal, normalised. */
const attributeValue: P<string> = Parser.alt(
  Parser.preceded(
    Parser.peek(Token.oneOf('"\'')),
    Parser.alt(
      Parser.seq(Parser.location, Parser.delimited(lit('"'), Token.takeTill('"'), lit('"'))),
      Parser.seq(Parser.location, Parser.delimited(lit("'"), Token.takeTill("'"), lit("'"))),
      failHere<readonly [number, string]>('Unterminated attribute value'),
    ),
  ),
  failHere<readonly [number, string]>('Expected a quoted attribute value'),
).pipe(Parser.map(([quote, raw]) => normalizeAttribute(raw, quote + 1, new Set())));

// -----------------------------------------------------------------------------
// Comments and processing instructions
// -----------------------------------------------------------------------------

const comment: P<Xml.Comment> = Parser.terminated(
  Parser.seq(
    Parser.location,
    Parser.preceded(lit('<!--'), Parser.alt(Token.takeUntil('--'), Parser.succeed(undefined))),
    Parser.location,
  ).pipe(
    Parser.tap(([start, value, end]) => {
      if (value === undefined) fail('Unterminated comment', start);
      if (x.src.charCodeAt(end + 2) !== 0x3e) fail('"--" is not allowed in comments', end);
    }),
    Parser.map(([start, value]): Xml.Comment => ({
      _tag: 'Comment',
      value: value!,
      position: x.position(start),
    })),
  ),
  lit('-->'),
);

const pi: P<Xml.ProcessingInstruction> = Parser.terminated(
  Parser.seq(
    Parser.location,
    Parser.preceded(
      lit('<?'),
      checked(name, (target, pos) => {
        if (target.toLowerCase() === 'xml')
          fail('Reserved processing instruction target', pos - target.length - 2);
        if (target.includes(':')) fail('Processing instruction targets cannot contain ":"', pos);
      }),
    ),
    Parser.alt(
      Parser.preceded(at('?>'), Parser.succeed('')),
      Parser.preceded(requireWs, Parser.alt(Token.takeUntil('?>'), Parser.succeed(undefined))),
    ),
  ).pipe(
    Parser.tap(([start, , data]) => {
      if (data === undefined) fail('Unterminated processing instruction', start);
    }),
    Parser.map(([start, target, data]): Xml.ProcessingInstruction => ({
      _tag: 'ProcessingInstruction',
      target,
      data: data!,
      position: x.position(start),
    })),
  ),
  lit('?>'),
);

// -----------------------------------------------------------------------------
// The document type declaration
// -----------------------------------------------------------------------------

/** `ExternalID`: `[publicId, systemId]`. */
const externalId: P<readonly [string | undefined, string | undefined]> = Parser.alt(
  Parser.preceded(Parser.seq(lit('SYSTEM'), requireWs), quoted).pipe(
    Parser.map((system) => [undefined, system] as const),
  ),
  Parser.preceded(
    Parser.seq(expect('PUBLIC'), requireWs),
    Parser.seq(
      checked(quoted, (pub, pos) => {
        if (!PUBID_RE.test(pub)) fail('Invalid public identifier', pos);
      }),
      Parser.preceded(Parser.seq(ws, afterWs), quoted),
    ),
  ),
);

const skipParens: P<unknown> = Parser.preceded(
  expect('('),
  Parser.seq(
    Parser.location,
    Token.takeTill(')'),
    Parser.alt(lit(')'), Parser.succeed(undefined)),
  ).pipe(
    Parser.tap(([pos, tokens, close]) => {
      if (close === undefined) fail('Unterminated enumeration', pos);
      for (const t of tokens.split('|')) {
        if (!NMTOKEN_RE.test(t.trim())) fail('Invalid enumeration', pos);
      }
    }),
  ),
);

const TOKENIZED_TYPES: HashSet.HashSet<string> = HashSet.make(
  'ID',
  'IDREF',
  'IDREFS',
  'ENTITY',
  'ENTITIES',
  'NMTOKEN',
  'NMTOKENS',
);

const defaultDecl: P<string | undefined> = Parser.alt(
  Parser.preceded(lit('#REQUIRED'), Parser.succeed<string | undefined>(undefined)),
  Parser.preceded(lit('#IMPLIED'), Parser.succeed<string | undefined>(undefined)),
  Parser.preceded(Parser.opt(Parser.seq(lit('#FIXED'), requireWs)), attributeValue),
);

const notation: P<void> = Parser.make<void>((state) =>
  x.attributeType === 'NOTATION' ? undefined : state.backtrack('Verify', ['NOTATION']),
);

const attributeDef: P<unknown> = Parser.seq(
  Parser.tap(name, (n) => {
    x.attributeName = n;
    x.tokenized = true;
  }),
  requireWs,
  Parser.alt(
    Parser.preceded(at('('), skipParens),
    Parser.seq(
      checked(name, (type, pos) => {
        x.attributeType = type;
        if (type === 'CDATA') x.tokenized = false;
        else if (type !== 'NOTATION' && !HashSet.has(TOKENIZED_TYPES, type)) {
          fail(`Unknown attribute type "${type}"`, pos);
        }
      }),
      Parser.opt(Parser.preceded(notation, Parser.seq(requireWs, skipParens))),
    ),
  ),
  requireWs,
  defaultDecl,
).pipe(
  Parser.tap(([, , , , v]) => {
    // SAFETY: the default declaration yields the default value string, or `undefined` for
    // `#REQUIRED` / `#IMPLIED`.
    const value = v;
    let types = x.attributeTypes.get(x.attlistElement);
    if (types === undefined) x.attributeTypes.set(x.attlistElement, (types = new Map()));
    const defaults = x.attributeDefaults.get(x.attlistElement)!;
    const name = x.attributeName;
    if (types.has(name)) return;
    types.set(name, x.tokenized);
    if (value !== undefined) {
      defaults.push({ name, value: x.tokenized ? collapse(value) : value, tokenized: x.tokenized });
    }
  }),
);

const attlistDecl: P<unknown> = Parser.preceded(
  Parser.seq(lit('<!ATTLIST'), requireWs),
  Parser.seq(
    Parser.tap(name, (element) => {
      x.attlistElement = element;
      if (!x.attributeDefaults.has(element)) x.attributeDefaults.set(element, []);
      if (!x.attributeTypes.has(element)) x.attributeTypes.set(element, new Map());
    }),
    Parser.repeat(Parser.preceded(Parser.seq(ws, Parser.not(lit('>')), afterWs), attributeDef)),
    ws,
    lit('>'),
  ),
);

const entityDecl: P<unknown> = Parser.preceded(
  Parser.seq(lit('<!ENTITY'), requireWs),
  Parser.seq(
    Parser.alt(
      Parser.preceded(Parser.seq(lit('%'), requireWs), Parser.succeed(true)),
      Parser.succeed(false),
    ),
    checked(name, (n, pos) => {
      if (n.includes(':')) fail('Entity names cannot contain ":"', pos);
    }),
    requireWs,
    Parser.alt(
      Parser.preceded(
        Parser.peek(Token.oneOf('"\'')),
        Parser.seq(Parser.location, quoted).pipe(
          Parser.map(([quote, raw]) => {
            if (raw.includes('%')) fail('Parameter entity references are not supported', quote + 1);
            return expandCharRefs(raw, quote + 1);
          }),
        ),
      ),
      Parser.preceded(
        externalId,
        Parser.opt(
          Parser.preceded(
            Parser.seq(Token.takeWhile(space, { min: 1 }), lit('NDATA')),
            Parser.seq(requireWs, name),
          ),
        ),
      ).pipe(Parser.as(undefined)),
    ),
    ws,
    expect('>'),
  ),
).pipe(
  Parser.tap(([parameter, name, , value]) => {
    if (parameter) return;
    if (x.entities.has(name) || x.externalEntities.has(name)) return; // first wins
    if (value === undefined) x.externalEntities.add(name);
    else x.entities.set(name, value);
  }),
);

/** `<!ELEMENT …>` and `<!NOTATION …>`, skipped. */
const skippedDecl: P<unknown> = Parser.seq(
  Parser.repeat(
    Parser.alt(
      Parser.preceded(Parser.peek(Token.oneOf('"\'')), quoted),
      Token.takeTill('>"\'', { min: 1 }),
    ),
  ),
  Parser.alt(lit('>'), failHere('Unterminated markup declaration')),
);

const internalSubset: P<unknown> = Parser.terminated(
  Parser.repeat(
    Parser.preceded(
      Parser.seq(ws, Parser.not(lit(']'))),
      Parser.alt(
        Parser.preceded(Parser.eof, failHere('Unterminated internal subset')),
        Parser.preceded(at('<!ENTITY'), entityDecl),
        Parser.preceded(at('<!ATTLIST'), attlistDecl),
        Parser.preceded(Parser.alt(at('<!ELEMENT'), at('<!NOTATION')), skippedDecl),
        Parser.preceded(at('<!--'), comment),
        Parser.preceded(at('<?'), pi),
        Parser.preceded(at('%'), failHere('Parameter entity references are not supported')),
        failHere('Invalid markup in the internal subset'),
      ),
    ),
  ),
  Parser.seq(ws, lit(']')),
);

const doctype: P<unknown> = Parser.seq(
  Parser.preceded(Parser.seq(lit('<!DOCTYPE'), requireWs), name),
  Parser.alt(
    Parser.preceded(
      Parser.seq(ws, Parser.peek(Parser.alt(lit('SYSTEM'), lit('PUBLIC'))), afterWs),
      Parser.terminated(externalId, ws),
    ).pipe(
      Parser.tap(() => {
        x.hasExternalSubset = true;
      }),
    ),
    Parser.preceded(ws, Parser.succeed([undefined, undefined] as const)),
  ),
  Parser.opt(Parser.preceded(lit('['), Parser.terminated(internalSubset, ws))),
  expect('>'),
).pipe(
  Parser.tap(([name, [publicId, systemId]]) => {
    x.doctype = { name, publicId, systemId, entities: new Map(x.entities) };
  }),
);

// -----------------------------------------------------------------------------
// Elements
// -----------------------------------------------------------------------------

const pushText = (frame: Frame, s: string, at: number): void => {
  if (s === '') return;
  if (frame.textStart === -1) frame.textStart = at;
  frame.text += s;
};

const flush = (frame: Frame): void => {
  if (frame.text !== '') {
    const children = frame.children;
    const prev = children[children.length - 1];
    if (prev !== undefined && prev._tag === 'Text') {
      children[children.length - 1] = { ...prev, value: prev.value + frame.text };
    } else {
      children.push({ _tag: 'Text', value: frame.text, position: x.position(frame.textStart) });
    }
  }
  frame.text = '';
  frame.textStart = -1;
};

/** A child that is not text. */
const pushNode = (node: Xml.Node): void => {
  const frame = x.top();
  flush(frame);
  frame.children.push(node);
};

const resolveName = (
  qname: string,
  ns: ReadonlyMap<string, string>,
  isElement: boolean,
  offset: number,
): readonly [string, string, string | undefined] => {
  const i = qname.indexOf(':');
  if (i === -1) {
    if (!isNCName(qname)) fail(`Invalid name "${qname}"`, offset);
    return ['', qname, isElement ? ns.get('') : undefined];
  }
  const prefix = qname.slice(0, i);
  const local = qname.slice(i + 1);
  if (!isNCName(prefix) || !isNCName(local)) fail(`Invalid qualified name "${qname}"`, offset);
  if (prefix === 'xmlns') fail('Elements and attributes cannot use the "xmlns" prefix', offset);
  if (prefix === 'xml') return [prefix, local, XML_NAMESPACE];
  const uri = ns.get(prefix);
  if (uri === undefined) fail(`Unbound namespace prefix "${prefix}"`, offset);
  return [prefix, local, uri];
};

/** Opens the element whose start tag was just read (closing it too if it was empty). */
const openElement = (empty: boolean): void => {
  const start = x.tagStart;
  const qname = x.qname;
  const raw = x.raw;
  const seen = x.seen;
  // attribute types and defaults from the internal subset
  const types = x.attributeTypes.get(qname);
  if (types !== undefined) {
    for (const a of raw) if (types.get(a.name) === true) a.value = collapse(a.value);
  }
  for (const d of x.attributeDefaults.get(qname) ?? []) {
    if (!seen.has(d.name))
      raw.push({ name: d.name, value: d.value, offset: start, defaulted: true });
  }

  // namespace declarations
  const parent = x.top();
  const parentNs = parent.inScope;
  let inScope = parentNs;
  const declarations: Array<Xml.NamespaceDeclaration> = [];
  for (const a of raw) {
    let prefix: string | undefined;
    if (a.name === 'xmlns') prefix = '';
    else if (a.name.startsWith('xmlns:')) prefix = a.name.slice(6);
    if (prefix === undefined) continue;
    if (prefix !== '' && !isNCName(prefix)) fail('Invalid namespace prefix', a.offset);
    if (prefix === 'xmlns') fail('The "xmlns" prefix cannot be declared', a.offset);
    if (prefix === 'xml' && a.value !== XML_NAMESPACE) {
      fail('The "xml" prefix cannot be rebound', a.offset);
    }
    if (prefix !== 'xml' && a.value === XML_NAMESPACE) {
      fail('The XML namespace cannot be bound to another prefix', a.offset);
    }
    if (a.value === XMLNS_NAMESPACE) fail('The xmlns namespace cannot be declared', a.offset);
    if (prefix !== '' && a.value === '') {
      fail('Prefixed namespace declarations cannot be empty', a.offset);
    }
    if (prefix === 'xml') continue;
    if (inScope === parentNs) inScope = new Map(parentNs);
    // SAFETY: `inScope` was copied into a fresh mutable map on the line above when it was still
    // the parent's.
    const own = inScope as Map<string, string>;
    if (a.value === '') own.delete('');
    else own.set(prefix, a.value);
    declarations.push({ prefix, namespace: a.value });
  }

  const [prefix, localName, namespace] = resolveName(qname, inScope, true, start + 1);
  const attributes: Array<Xml.Attribute> = [];
  const expanded = new Set<string>();
  for (const a of raw) {
    if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
    const [ap, al, ans] = resolveName(a.name, inScope, false, a.offset);
    const key = `${ans ?? ''} ${al}`;
    if (expanded.has(key)) fail(`Duplicate attribute "{${ans ?? ''}}${al}"`, a.offset);
    expanded.add(key);
    attributes.push({
      _tag: 'Attribute',
      name: a.name,
      prefix: ap,
      localName: al,
      namespace: ans,
      value: a.value,
      defaulted: a.defaulted,
      position: x.position(a.offset),
    });
  }

  flush(parent);
  const frame: Frame = {
    qname,
    start,
    prefix,
    localName,
    namespace,
    attributes,
    declarations,
    inScope,
    children: [],
    text: '',
    textStart: -1,
  };
  if (empty) {
    closeElement(frame);
    return;
  }
  if (x.stack.length - x.base >= MAX_ELEMENT_DEPTH) fail('Elements are nested too deeply', start);
  x.stack.push(frame);
};

/** Adds a finished element to its parent. */
const closeElement = (frame: Frame): void => {
  flush(frame);
  const element: Xml.Element = {
    _tag: 'Element',
    name: frame.qname,
    prefix: frame.prefix,
    localName: frame.localName,
    namespace: frame.namespace,
    attributes: frame.attributes,
    namespaceDeclarations: frame.declarations,
    inScopeNamespaces: frame.inScope,
    children: frame.children,
    position: x.position(frame.start),
  };
  x.top().children.push(element);
};

const attribute: P<unknown> = Parser.seq(Parser.location, name, eq, attributeValue).pipe(
  Parser.tap(([offset, name, , value]) => {
    if (x.seen.has(name)) fail(`Duplicate attribute "${name}"`, offset);
    x.seen.add(name);
    x.raw.push({ name, value, offset, defaulted: false });
  }),
);

const startTag: P<unknown> = Parser.seq(
  Parser.tap(Parser.seq(Parser.location, Parser.preceded(lit('<'), name)), ([start, qname]) => {
    x.tagStart = start;
    x.qname = qname;
    x.raw = [];
    x.seen = new Set();
  }),
  Parser.repeat(
    Parser.preceded(
      Parser.seq(ws, Parser.not(Parser.alt(lit('>'), lit('/>')))),
      Parser.preceded(
        Parser.make<void>((state) => {
          const c = state.input.charCodeAt(state.pos - 1);
          if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
            fail('Expected white space between attributes', state.pos);
          }
          return undefined;
        }),
        attribute,
      ),
    ),
  ),
  Parser.preceded(
    ws,
    Parser.alt(
      Parser.tap(lit('/>'), () => openElement(true)),
      Parser.tap(lit('>'), () => openElement(false)),
    ),
  ),
);

const endTag: P<unknown> = Parser.seq(
  Parser.seq(
    act((offset) => {
      if (x.stack.length === x.base) fail('Unbalanced end tag in entity replacement text', offset);
    }),
    Parser.preceded(lit('</'), name),
  ).pipe(
    Parser.tap(([offset, endName]) => {
      const frame = x.top();
      if (endName !== frame.qname) {
        fail(`Mismatched end tag: expected </${frame.qname}> but found </${endName}>`, offset);
      }
    }),
  ),
  ws,
  expect('>'),
).pipe(
  Parser.tap(() => {
    closeElement(x.stack.pop()!);
  }),
);

const cdata: P<unknown> = Parser.seq(
  Parser.location,
  Parser.preceded(
    lit('<![CDATA['),
    Parser.alt(Parser.terminated(Token.takeUntil(']]>'), lit(']]>')), Parser.succeed(undefined)),
  ),
).pipe(
  Parser.tap(([start, text]) => {
    if (text === undefined) fail('Unterminated CDATA section', start);
    pushText(x.top(), text, start);
  }),
);

const charData: P<unknown> = Parser.seq(Parser.location, Token.takeTill('<&', { min: 1 })).pipe(
  Parser.tap(([start, text]) => {
    const bad = text.indexOf(']]>');
    if (bad !== -1) fail('"]]>" is not allowed in character data', start + bad);
    pushText(x.top(), text, start);
  }),
);

/** The content an entity's replacement text adds (parsed interpreted: it may nest). */
const entityContent: P<unknown> = Parser.suspend(() =>
  Parser.terminated(
    Parser.repeat(Parser.preceded(Parser.not(Parser.eof), contentItem)),
    act((pos) => {
      if (x.stack.length > x.base) fail('Unexpected end of input: unclosed element', pos);
    }),
  ),
);

/** Parses the replacement text of an entity that contains markup. */
const replacementNodes = (body: string, replacement: string, start: number): Array<Xml.Node> => {
  const { src, lineStarts, stack, base, entityStack } = x;
  const frame = baseFrame(x.top().inScope);
  x.src = replacement;
  x.lineStarts = [0];
  x.stack = [frame];
  x.base = 1;
  x.entityStack = withEntry(entityStack, body);
  const outcome = Result.try({
    try: () => {
      const result = Parser.parse(entityContent, replacement);
      if (Result.isFailure(result)) fail('Invalid markup', result.failure.offset);
      flush(frame);
      return frame.children;
    },
    catch: (e) => e,
  });
  x.src = src;
  x.lineStarts = lineStarts;
  x.stack = stack;
  x.base = base;
  x.entityStack = entityStack;
  if (Result.isSuccess(outcome)) return outcome.success;
  if (outcome.failure instanceof Failure) {
    fail(`In entity "${body}": ${outcome.failure.message}`, start);
  }
  throw outcome.failure;
};

const reference: P<unknown> = Parser.seq(
  Parser.location,
  Parser.preceded(lit('&'), Token.takeTill(';')),
  Parser.alt(lit(';'), Parser.succeed(undefined)),
).pipe(
  Parser.tap(([start, body, semi]) => {
    if (semi === undefined) fail('Unterminated reference', start);
    const frame = x.top();
    if (body.startsWith('#')) {
      if (!/^#(x[0-9a-fA-F]+|[0-9]+)$/.test(body)) fail('Invalid character reference', start);
      pushText(frame, charRef(body, start), start);
      return;
    }
    const predefined = PREDEFINED.get(body);
    if (predefined !== undefined) {
      pushText(frame, predefined, start);
      return;
    }
    const replacement = entityText(body, start, x.entityStack);
    if (!replacement.includes('<') && !replacement.includes('&')) {
      pushText(frame, replacement, start);
      return;
    }
    flush(frame);
    const position = x.position(start);
    for (const n of replacementNodes(body, replacement, start)) {
      // SAFETY: adding a position to a node keeps its kind.
      const positioned = { ...n, position } as Xml.Node;
      if (positioned._tag === 'Text') pushText(frame, positioned.value, start);
      else {
        flush(frame);
        frame.children.push(positioned);
      }
    }
  }),
);

const contentItem: P<unknown> = Parser.alt(
  Parser.preceded(at('</'), endTag),
  Parser.preceded(at('<!--'), Parser.tap(comment, pushNode)),
  Parser.preceded(at('<![CDATA['), cdata),
  Parser.preceded(at('<?'), Parser.tap(pi, pushNode)),
  Parser.preceded(at('<!'), failHere('Unexpected markup declaration in content')),
  Parser.preceded(at('<'), startTag),
  Parser.preceded(at('&'), reference),
  charData,
);

/** The root element: its start tag, then content until it is closed. */
const rootElement: P<unknown> = Parser.terminated(
  Parser.asVoid(
    Parser.seq(
      startTag,
      Parser.repeat(
        Parser.preceded(
          Parser.make<void>((state) =>
            x.stack.length > x.base ? undefined : state.backtrack('Verify', ['content']),
          ),
          Parser.alt(
            Parser.preceded(Parser.eof, failHere('Unexpected end of input: unclosed element')),
            contentItem,
          ),
        ),
      ),
    ),
  ),
  act(() => {
    // SAFETY: the document element is the root frame's only child.
    x.root = x.stack[0]!.children.pop() as Xml.Element;
  }),
);

// -----------------------------------------------------------------------------
// The document
// -----------------------------------------------------------------------------

const xmlDecl: P<unknown> = Parser.preceded(
  Parser.seq(lit('<?xml'), Parser.peek(Token.oneOf(space))),
  Parser.seq(
    requireWs,
    expect('version'),
    eq,
    checked(quoted, (version, pos) => {
      if (!/^1\.[0-9]+$/.test(version)) fail(`Unsupported XML version "${version}"`, pos);
      x.version = version;
    }),
    ws,
    Parser.opt(
      Parser.preceded(
        Parser.seq(at('encoding'), afterWs, lit('encoding'), eq),
        Parser.terminated(
          checked(quoted, (encoding, pos) => {
            if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(encoding)) fail('Invalid encoding name', pos);
            x.encoding = encoding;
          }),
          ws,
        ),
      ),
    ),
    Parser.opt(
      Parser.preceded(
        Parser.seq(at('standalone'), afterWs, lit('standalone'), eq),
        Parser.terminated(
          checked(quoted, (sd, pos) => {
            if (sd !== 'yes' && sd !== 'no') fail('standalone must be "yes" or "no"', pos);
            x.standalone = sd === 'yes';
          }),
          ws,
        ),
      ),
    ),
    expect('?>'),
  ),
);

const prologOrEpilog = (node: Xml.Comment | Xml.ProcessingInstruction): void => {
  (x.root === undefined ? x.prolog : x.epilog).push(node);
};

const document: P<unknown> = Compiler.jit(
  Parser.asVoid(
    Parser.seq(
      Parser.opt(xmlDecl),
      Parser.repeat(
        Parser.preceded(
          Parser.not(Parser.eof),
          Parser.alt(
            Token.takeWhile(space, { min: 1 }),
            Parser.preceded(at('<!--'), Parser.tap(comment, prologOrEpilog)),
            Parser.preceded(at('<?'), Parser.tap(pi, prologOrEpilog)),
            Parser.preceded(
              at('<!DOCTYPE'),
              Parser.preceded(
                act((pos) => {
                  if (x.doctype !== undefined || x.root !== undefined)
                    fail('Unexpected DOCTYPE', pos);
                }),
                doctype,
              ),
            ),
            Parser.preceded(
              at('<'),
              Parser.preceded(
                act((pos) => {
                  if (x.root !== undefined) fail('Only one root element is allowed', pos);
                }),
                rootElement,
              ),
            ),
            act((pos) =>
              fail(
                x.root === undefined
                  ? 'Expected the root element'
                  : 'Content after the root element',
                pos,
              ),
            ),
          ),
        ),
      ),
      act((pos) => {
        if (x.root === undefined) fail('No root element', pos);
      }),
    ),
  ),
);

/** Parses a (line-end normalised) document, throwing a `Failure`. */
export const parse = (text: string, lineStarts: ReadonlyArray<number>): Xml.Document => {
  x = new Context(text, lineStarts);
  const result = Parser.parse(document, text);
  if (Result.isFailure(result)) fail('Invalid XML', result.failure.offset);
  return {
    _tag: 'Document',
    version: x.version,
    encoding: x.encoding,
    standalone: x.standalone,
    doctype: x.doctype,
    prolog: x.prolog,
    root: x.root!,
    epilog: x.epilog,
  };
};
