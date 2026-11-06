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
import * as Arr from 'effect/Array';
import { constFalse } from 'effect/Function';
import * as HashSet from 'effect/HashSet';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Result from 'effect/Result';
import type * as Xml from '../Xml.ts';
import {
  INVALID_CHAR_RE,
  isName,
  isNCName,
  isValidText,
  nameChar,
  nameStart,
  NMTOKEN_RE,
  PUBID_RE,
  space,
} from './chars.ts';
import { loop } from './loop.ts';

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
  /** Where in the document the error is: set by `parseText`, from `offset`. */
  position: Xml.Position;
  constructor(message: string, offset: number) {
    this.message = message;
    this.offset = offset;
    this.position = { offset, line: 0, column: 0 };
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
  /** Where its start tag is (found as it is read, when the last position found is near). */
  readonly position: Xml.Position;
  readonly prefix: string;
  readonly localName: string;
  readonly namespace: Option.Option<string>;
  readonly attributes: ReadonlyArray<Xml.Attribute>;
  readonly declarations: ReadonlyArray<Xml.NamespaceDeclaration>;
  readonly inScope: ReadonlyMap<string, string>;
  readonly children: Array<Xml.Node>;
  text: string;
  textStart: number;
  /** Whether the last of `children` is a text node (so `text` may merge into it). */
  endsWithText: boolean;
  /** How many children precede the last child taken by a `RootChildHook`: text never merges into them. */
  floor: number;
}

/** The replacement text of a predefined entity, or `''` if `entity` is not one. */
const predefined = (entity: string): string =>
  entity === 'lt'
    ? '<'
    : entity === 'gt'
      ? '>'
      : entity === 'amp'
        ? '&'
        : entity === 'apos'
          ? "'"
          : entity === 'quot'
            ? '"'
            : '';

/** The types (tokenized or not) and defaults an `<!ATTLIST>` declares for an element. */
interface AttributeList {
  readonly types: MutableHashMap.MutableHashMap<string, boolean>;
  readonly defaults: Array<AttributeDefault>;
}

const baseFrame = (inScope: ReadonlyMap<string, string>): Frame => ({
  qname: '',
  position: { offset: 0, line: 0, column: 0 },
  prefix: '',
  localName: '',
  namespace: Option.none(),
  attributes: [],
  declarations: [],
  inScope,
  children: [],
  text: '',
  textStart: -1,
  endsWithText: false,
  floor: 0,
});

/** Whether `offset` is on line `l` (from 0) of the text whose line starts are `starts`. */
const onLine = (starts: ReadonlyArray<number>, l: number, offset: number): boolean =>
  (starts[l] ?? Infinity) <= offset && offset < (starts[l + 1] ?? Infinity);

/** The line (from 0) of `offset` among lines `lo … hi` of the text whose line starts are `starts`. */
const lineIndex = (
  starts: ReadonlyArray<number>,
  offset: number,
  lo: number,
  hi: number,
): number => {
  if (lo >= hi) return lo;
  const mid = (lo + hi + 1) >> 1;
  return (starts[mid] ?? 0) <= offset
    ? lineIndex(starts, offset, mid, hi)
    : lineIndex(starts, offset, lo, mid - 1);
};

/**
 * Receives each child element of the root as soon as it is closed, with the
 * root element as read so far (its `children` are those not taken). Returns
 * `true` to take the child, which is then left out of the document.
 *
 * @internal
 */
export type RootChildHook = (child: Xml.Element, root: Xml.Element) => boolean;

const keepChild: RootChildHook = () => false;

/** Up to how many attributes a start tag's duplicates are found by searching its list. */
const SMALL = 16;

/** Stands for the declarations of an `<!ATTLIST>` until one is read. */
const NO_ATTRIBUTE_LIST: AttributeList = { types: MutableHashMap.empty(), defaults: [] };

/** Stands for the set of a start tag's expanded names while it has too few to need one. */
const UNUSED: MutableHashSet.MutableHashSet<string> = MutableHashSet.empty();

/** The document being parsed. */
class Context {
  /** The text being parsed: the document, or an entity's replacement text. */
  src: string;
  lineStarts: ReadonlyArray<number>;
  readonly entities = MutableHashMap.empty<string, string>();
  readonly externalEntities = MutableHashSet.empty<string>();
  /** The `<!ATTLIST>` declarations, by element name. */
  readonly attributeLists = MutableHashMap.empty<string, AttributeList>();
  expanded = 0;
  hasExternalSubset = false;

  /** Takes a finished child of the root element instead of adding it to the root (`true`). */
  onRootChild: RootChildHook = keepChild;

  /** The frames of the open elements; those below `base` belong to enclosing text. */
  stack: Arr.NonEmptyArray<Frame>;
  base = 1;
  /** The entities whose replacement text is being parsed. */
  entityStack: HashSet.HashSet<string> = HashSet.empty();

  // The parts of the document
  version: Option.Option<string> = Option.none();
  encoding: Option.Option<string> = Option.none();
  standalone: Option.Option<boolean> = Option.none();
  doctype: Option.Option<Xml.DocumentType> = Option.none();
  readonly prolog: Array<Xml.Comment | Xml.ProcessingInstruction> = [];
  readonly epilog: Array<Xml.Comment | Xml.ProcessingInstruction> = [];
  root: Option.Option<Xml.Element> = Option.none();

  // Registers for the markup being read (none of it nests)
  tagStart = 0;
  qname = '';
  raw: Array<RawAttribute> = [];
  /** The qualified names read so far, split (`nameParts`). */
  readonly qnames = MutableHashMap.empty<string, readonly [prefix: string, local: string]>();
  /** The names in `namesOf`, once it is too long to search. */
  readonly names = MutableHashSet.empty<string>();
  /** The attributes whose names `names` holds (cleared and refilled for each long start tag). */
  namesOf: ReadonlyArray<RawAttribute> = [];
  /** The declarations of the `<!ATTLIST>` being read (set as each is begun). */
  attributeList: AttributeList = NO_ATTRIBUTE_LIST;
  attributeName = '';
  attributeType = '';
  tokenized = false;

  constructor(src: string, lineStarts: ReadonlyArray<number>) {
    this.src = src;
    this.lineStarts = lineStarts;
    // `inScopeNamespaces` is a public `ReadonlyMap`
    this.stack = [baseFrame(new Map())];
  }

  /** The line of the last position, where the next one usually is (offsets mostly increase). */
  private line = 0;

  position(offset: number): Xml.Position {
    const starts = this.lineStarts;
    // The last position's line, or the one after or before it (where the text before a tag
    // starts), before a binary search
    const line = this.line;
    const lo = onLine(starts, line, offset)
      ? line
      : onLine(starts, line + 1, offset)
        ? line + 1
        : line > 0 && onLine(starts, line - 1, offset)
          ? line - 1
          : lineIndex(starts, offset, 0, starts.length - 1);
    this.line = lo;
    return { offset, line: lo + 1, column: offset - (starts[lo] ?? 0) + 1 };
  }

  /** Whether the start tag being read has an attribute `name` (adding it if not). */
  hasAttribute(attribute: string): boolean {
    if (this.raw.length < SMALL) return this.raw.some((a) => a.name === attribute);
    const names = this.names;
    if (this.namesOf !== this.raw) {
      MutableHashSet.clear(names);
      this.raw.forEach((a) => MutableHashSet.add(names, a.name));
      this.namesOf = this.raw;
    }
    if (MutableHashSet.has(names, attribute)) return true;
    MutableHashSet.add(names, attribute);
    return false;
  }

  top(): Frame {
    return Arr.lastNonEmpty(this.stack);
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

const xmlName: P<string> = Parser.alt(
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

const collapse = (value: string): string => value.replace(/ +/g, ' ').replace(/^ | $/g, '');

const CHAR_REF_RE = /^#(x[0-9a-fA-F]+|[0-9]+)$/;

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
  // `body` is unset only when the bare `&` (the only one-character match) was matched
  raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[^;]*);|&/g, (m: string, body: string, i: number) => {
    if (m.length === 1) fail('Invalid reference', offset + i);
    if (body.startsWith('#')) return charRef(body, offset + i);
    if (!isName(body)) fail('Invalid entity reference', offset + i);
    return m;
  });

/** The replacement text of a reference to `entity`, counted against the expansion limit. */
const entityText = (entity: string, offset: number, stack: HashSet.HashSet<string>): string => {
  if (!isName(entity)) fail('Invalid entity reference', offset);
  const builtIn = predefined(entity);
  if (builtIn !== '') return builtIn === '<' ? '&#60;' : builtIn === '&' ? '&#38;' : builtIn;
  if (MutableHashSet.has(x.externalEntities, entity)) {
    fail(`External entity "${entity}" is not supported`, offset);
  }
  const value = Option.getOrElse(MutableHashMap.get(x.entities, entity), () =>
    fail(`Undefined entity "${entity}"`, offset),
  );
  if (HashSet.has(stack, entity)) fail(`Recursive entity "${entity}"`, offset);
  if (HashSet.size(stack) >= MAX_ENTITY_DEPTH) {
    fail('Entity references are nested too deeply', offset);
  }
  x.expanded += value.length;
  if (x.expanded > MAX_ENTITY_EXPANSION) fail('Entity expansion limit exceeded', offset);
  return value;
};

/**
 * What attribute-value normalisation replaces: a reference (to the first `;`
 * after its `&`), an `&` with no `;` after it, `<`, and white space other
 * than a space. The matches are found before any is replaced, so the nested
 * normalisation of an entity's replacement text may reuse it.
 */
const ATTRIBUTE_SPECIAL_RE = /&([^;]*);|[&<\t\n\r]/g;
const ATTRIBUTE_SPECIAL_TEST_RE = /[&<\t\n\r]/;

/** Normalises an attribute value (XML 1.0 §3.3.3). */
const normalizeAttribute = (raw: string, offset: number, stack: HashSet.HashSet<string>): string =>
  !ATTRIBUTE_SPECIAL_TEST_RE.test(raw)
    ? raw
    : // `body` is set for every match longer than one character (a reference)
      raw.replace(ATTRIBUTE_SPECIAL_RE, (m: string, body: string, i: number): string => {
        if (m === '<') return fail('"<" is not allowed in attribute values', offset + i);
        if (m === '&') return fail('Unterminated reference', offset + i);
        if (m.length === 1) return ' ';
        if (body.startsWith('#')) {
          if (!CHAR_REF_RE.test(body)) fail('Invalid character reference', offset + i);
          return charRef(body, offset + i);
        }
        const replacement = entityText(body, offset + i, stack);
        return normalizeAttribute(replacement, offset + i, HashSet.add(stack, body));
      });

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
).pipe(Parser.map(([quote, raw]) => normalizeAttribute(raw, quote + 1, HashSet.empty())));

// -----------------------------------------------------------------------------
// Comments and processing instructions
// -----------------------------------------------------------------------------

const comment: P<Xml.Comment> = Parser.terminated(
  Parser.seq(
    Parser.location,
    Parser.preceded(lit('<!--'), Parser.opt(Token.takeUntil('--'))),
    Parser.location,
  ).pipe(
    Parser.map(([start, body, end]): Xml.Comment => {
      const value = Option.getOrElse(body, () => fail('Unterminated comment', start));
      if (x.src.charCodeAt(end + 2) !== 0x3e) fail('"--" is not allowed in comments', end);
      return { _tag: 'Comment', value, position: x.position(start) };
    }),
  ),
  lit('-->'),
);

const pi: P<Xml.ProcessingInstruction> = Parser.terminated(
  Parser.seq(
    Parser.location,
    Parser.preceded(
      lit('<?'),
      checked(xmlName, (target, pos) => {
        if (target.toLowerCase() === 'xml')
          fail('Reserved processing instruction target', pos - target.length - 2);
        if (target.includes(':')) fail('Processing instruction targets cannot contain ":"', pos);
      }),
    ),
    Parser.alt(
      Parser.preceded(at('?>'), Parser.succeed(Option.some(''))),
      Parser.preceded(requireWs, Parser.opt(Token.takeUntil('?>'))),
    ),
  ).pipe(
    Parser.map(([start, target, data]): Xml.ProcessingInstruction => ({
      _tag: 'ProcessingInstruction',
      target,
      data: Option.getOrElse(data, () => fail('Unterminated processing instruction', start)),
      position: x.position(start),
    })),
  ),
  lit('?>'),
);

// -----------------------------------------------------------------------------
// The document type declaration
// -----------------------------------------------------------------------------

/** `ExternalID`: `[publicId, systemId]`. */
const externalId: P<readonly [Option.Option<string>, Option.Option<string>]> = Parser.alt(
  Parser.preceded(Parser.seq(lit('SYSTEM'), requireWs), quoted).pipe(
    Parser.map((system) => [Option.none(), Option.some(system)] as const),
  ),
  Parser.preceded(
    Parser.seq(expect('PUBLIC'), requireWs),
    Parser.seq(
      checked(quoted, (pub, pos) => {
        if (!PUBID_RE.test(pub)) fail('Invalid public identifier', pos);
      }),
      Parser.preceded(Parser.seq(ws, afterWs), quoted),
    ).pipe(Parser.map(([pub, system]) => [Option.some(pub), Option.some(system)] as const)),
  ),
);

const skipParens: P<unknown> = Parser.preceded(
  expect('('),
  Parser.seq(Parser.location, Token.takeTill(')'), Parser.opt(lit(')'))).pipe(
    Parser.tap(([pos, tokens, close]) => {
      if (Option.isNone(close)) fail('Unterminated enumeration', pos);
      if (tokens.split('|').some((t) => !NMTOKEN_RE.test(t.trim()))) {
        fail('Invalid enumeration', pos);
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

const defaultDecl: P<Option.Option<string>> = Parser.alt(
  Parser.preceded(lit('#REQUIRED'), Parser.succeed(Option.none<string>())),
  Parser.preceded(lit('#IMPLIED'), Parser.succeed(Option.none<string>())),
  Parser.preceded(
    Parser.opt(Parser.seq(lit('#FIXED'), requireWs)),
    Parser.map(attributeValue, Option.some),
  ),
);

const notation: P<void> = Parser.make<void>((state) =>
  x.attributeType === 'NOTATION' ? undefined : state.backtrack('Verify', ['NOTATION']),
);

const attributeDef: P<unknown> = Parser.seq(
  Parser.tap(xmlName, (n) => {
    x.attributeName = n;
    x.tokenized = true;
  }),
  requireWs,
  Parser.alt(
    Parser.preceded(at('('), skipParens),
    Parser.seq(
      checked(xmlName, (type, pos) => {
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
  Parser.tap(([, , , , defaultValue]) => {
    const { types, defaults } = x.attributeList;
    const attribute = x.attributeName;
    if (MutableHashMap.has(types, attribute)) return; // first wins
    const tokenized = x.tokenized;
    MutableHashMap.set(types, attribute, tokenized);
    if (Option.isSome(defaultValue)) {
      const value = defaultValue.value;
      defaults.push({ name: attribute, value: tokenized ? collapse(value) : value, tokenized });
    }
  }),
);

const attlistDecl: P<unknown> = Parser.preceded(
  Parser.seq(lit('<!ATTLIST'), requireWs),
  Parser.seq(
    Parser.tap(xmlName, (element) => {
      const known = MutableHashMap.get(x.attributeLists, element);
      if (Option.isSome(known)) x.attributeList = known.value;
      else {
        const list: AttributeList = { types: MutableHashMap.empty(), defaults: [] };
        MutableHashMap.set(x.attributeLists, element, list);
        x.attributeList = list;
      }
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
    checked(xmlName, (n, pos) => {
      if (n.includes(':')) fail('Entity names cannot contain ":"', pos);
    }),
    requireWs,
    Parser.alt(
      Parser.preceded(
        Parser.peek(Token.oneOf('"\'')),
        Parser.seq(Parser.location, quoted).pipe(
          Parser.map(([quote, raw]) => {
            if (raw.includes('%')) fail('Parameter entity references are not supported', quote + 1);
            return Option.some(expandCharRefs(raw, quote + 1));
          }),
        ),
      ),
      Parser.preceded(
        externalId,
        Parser.opt(
          Parser.preceded(
            Parser.seq(Token.takeWhile(space, { min: 1 }), lit('NDATA')),
            Parser.seq(requireWs, xmlName),
          ),
        ),
      ).pipe(Parser.as(Option.none<string>())),
    ),
    ws,
    expect('>'),
  ),
).pipe(
  Parser.tap(([parameter, entity, , value]) => {
    if (parameter) return;
    if (MutableHashMap.has(x.entities, entity) || MutableHashSet.has(x.externalEntities, entity)) {
      return; // first wins
    }
    if (Option.isSome(value)) MutableHashMap.set(x.entities, entity, value.value);
    else MutableHashSet.add(x.externalEntities, entity);
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
  Parser.preceded(Parser.seq(lit('<!DOCTYPE'), requireWs), xmlName),
  Parser.alt(
    Parser.preceded(
      Parser.seq(ws, Parser.peek(Parser.alt(lit('SYSTEM'), lit('PUBLIC'))), afterWs),
      Parser.terminated(externalId, ws),
    ).pipe(
      Parser.tap(() => {
        x.hasExternalSubset = true;
      }),
    ),
    Parser.preceded(ws, Parser.succeed([Option.none<string>(), Option.none<string>()] as const)),
  ),
  Parser.opt(Parser.preceded(lit('['), Parser.terminated(internalSubset, ws))),
  expect('>'),
).pipe(
  Parser.tap(([doctypeName, [publicId, systemId]]) => {
    x.doctype = Option.some({
      name: doctypeName,
      publicId: Option.getOrUndefined(publicId),
      systemId: Option.getOrUndefined(systemId),
      // `DocumentType.entities` is a public `ReadonlyMap`
      entities: new Map(x.entities),
    });
  }),
);

// -----------------------------------------------------------------------------
// Elements
// -----------------------------------------------------------------------------

const pushText = (frame: Frame, s: string, offset: number): void => {
  if (s === '') return;
  if (frame.textStart === -1) frame.textStart = offset;
  frame.text += s;
};

const isText = Predicate.isTagged('Text');

const flush = (frame: Frame): void => {
  if (frame.text !== '') {
    const children = frame.children;
    const prev = frame.endsWithText && children.length > frame.floor ? children.at(-1) : undefined;
    if (isText(prev)) {
      children[children.length - 1] = { ...prev, value: prev.value + frame.text };
    } else {
      children.push({ _tag: 'Text', value: frame.text, position: x.position(frame.textStart) });
      frame.endsWithText = true;
    }
  }
  frame.text = '';
  frame.textStart = -1;
};

/** Adds a child that is not text to `frame`, after its text. */
const pushChild = (frame: Frame, node: Xml.Node): void => {
  flush(frame);
  frame.children.push(node);
  frame.endsWithText = false;
};

/** A child that is not text. */
const pushNode = (node: Xml.Node): void => {
  pushChild(x.top(), node);
};

/**
 * The prefix (`''` if none) and local part of a valid qualified name. The
 * names of a document repeat, so each is checked and split once, and its
 * parts are the same strings each time.
 */
const splitName = (qname: string, offset: number): readonly [prefix: string, local: string] => {
  const i = qname.indexOf(':');
  if (i === -1) {
    if (!isNCName(qname)) fail(`Invalid name "${qname}"`, offset);
    return ['', qname];
  }
  const prefix = qname.slice(0, i);
  const local = qname.slice(i + 1);
  if (!isNCName(prefix) || !isNCName(local)) fail(`Invalid qualified name "${qname}"`, offset);
  if (prefix === 'xmlns') fail('Elements and attributes cannot use the "xmlns" prefix', offset);
  return [prefix, local];
};

const nameParts = (qname: string, offset: number): readonly [prefix: string, local: string] => {
  const known = MutableHashMap.get(x.qnames, qname);
  if (Option.isSome(known)) return known.value;
  const parts = splitName(qname, offset);
  MutableHashMap.set(x.qnames, qname, parts);
  return parts;
};

const XML_NAMESPACE_OPTION = Option.some(XML_NAMESPACE);

/** The namespace of a name with `prefix` (an element's default namespace if `''`). */
const namespaceOf = (
  prefix: string,
  ns: ReadonlyMap<string, string>,
  isElement: boolean,
  offset: number,
): Option.Option<string> => {
  if (prefix === '') return isElement ? Option.fromUndefinedOr(ns.get('')) : Option.none();
  if (prefix === 'xml') return XML_NAMESPACE_OPTION;
  const uri = ns.get(prefix);
  if (uri === undefined) fail(`Unbound namespace prefix "${prefix}"`, offset);
  return Option.some(uri);
};

/** The namespace prefix an `xmlns` / `xmlns:…` attribute declares, or none for any other attribute. */
const declaredPrefix = (attribute: string): Option.Option<string> =>
  attribute === 'xmlns'
    ? Option.some('')
    : attribute.startsWith('xmlns:')
      ? Option.some(attribute.slice(6))
      : Option.none();

const isDeclaration = (attribute: string): boolean =>
  attribute === 'xmlns' || attribute.startsWith('xmlns:');

/** The namespaces in scope of an element that makes `declarations` (which are not empty). */
const declare = (
  parentNs: ReadonlyMap<string, string>,
  declarations: ReadonlyArray<Xml.NamespaceDeclaration>,
): ReadonlyMap<string, string> => {
  // `inScopeNamespaces` is a public `ReadonlyMap`
  const own = new Map(parentNs);
  declarations.forEach((d) => {
    if (d.namespace === '') own.delete('');
    else own.set(d.prefix, d.namespace);
  });
  return own;
};

/** Checks a namespace declaration, which declares `prefix` to be `uri`. */
const checkDeclaration = (prefix: string, uri: string, offset: number): void => {
  if (prefix !== '' && !isNCName(prefix)) fail('Invalid namespace prefix', offset);
  if (prefix === 'xmlns') fail('The "xmlns" prefix cannot be declared', offset);
  if (prefix === 'xml' && uri !== XML_NAMESPACE) fail('The "xml" prefix cannot be rebound', offset);
  if (prefix !== 'xml' && uri === XML_NAMESPACE) {
    fail('The XML namespace cannot be bound to another prefix', offset);
  }
  if (uri === XMLNS_NAMESPACE) fail('The xmlns namespace cannot be declared', offset);
  if (prefix !== '' && uri === '') fail('Prefixed namespace declarations cannot be empty', offset);
};

/** Opens the element whose start tag was just read (closing it too if it was empty). */
const openElement = (empty: boolean): void => {
  const start = x.tagStart;
  const qname = x.qname;
  const raw = x.raw;
  // attribute types and defaults from the internal subset
  if (!MutableHashMap.isEmpty(x.attributeLists)) {
    const list = MutableHashMap.get(x.attributeLists, qname);
    if (Option.isSome(list)) {
      const { types, defaults } = list.value;
      raw.forEach((a) => {
        if (Option.getOrElse(MutableHashMap.get(types, a.name), constFalse)) {
          a.value = collapse(a.value);
        }
      });
      defaults.forEach((d) => {
        if (!x.hasAttribute(d.name)) {
          raw.push({ name: d.name, value: d.value, offset: start, defaulted: true });
        }
      });
    }
  }

  // namespace declarations
  const parent = x.top();
  const parentNs = parent.inScope;
  const declarations: Array<Xml.NamespaceDeclaration> = [];
  raw.forEach((a) => {
    const declared = declaredPrefix(a.name);
    if (Option.isNone(declared)) return;
    const prefix = declared.value;
    checkDeclaration(prefix, a.value, a.offset);
    if (prefix !== 'xml') declarations.push({ prefix, namespace: a.value });
  });
  const inScope = Arr.isArrayNonEmpty(declarations) ? declare(parentNs, declarations) : parentNs;

  const [prefix, localName] = nameParts(qname, start + 1);
  const namespace = namespaceOf(prefix, inScope, true, start + 1);
  const attributes: Array<Xml.Attribute> = [];
  const large = raw.length >= SMALL;
  const expanded = large ? MutableHashSet.empty<string>() : UNUSED;
  raw.forEach((a) => {
    if (isDeclaration(a.name)) return;
    const [ap, al] = nameParts(a.name, a.offset);
    const ans = Option.getOrUndefined(namespaceOf(ap, inScope, false, a.offset));
    const key = `${ans ?? ''} ${al}`;
    const duplicate = large
      ? MutableHashSet.has(expanded, key)
      : attributes.some((b) => b.localName === al && b.namespace === ans);
    if (duplicate) fail(`Duplicate attribute "{${ans ?? ''}}${al}"`, a.offset);
    if (large) MutableHashSet.add(expanded, key);
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
  });

  flush(parent);
  const frame: Frame = {
    qname,
    position: x.position(start),
    prefix,
    localName,
    namespace,
    attributes,
    declarations,
    inScope,
    children: [],
    text: '',
    textStart: -1,
    endsWithText: false,
    floor: 0,
  };
  if (empty) {
    closeElement(frame);
    return;
  }
  if (x.stack.length - x.base >= MAX_ELEMENT_DEPTH) fail('Elements are nested too deeply', start);
  x.stack.push(frame);
};

/** The element an open frame stands for (with the children it has so far). */
const elementOf = (frame: Frame): Xml.Element => ({
  _tag: 'Element',
  name: frame.qname,
  prefix: frame.prefix,
  localName: frame.localName,
  namespace: Option.getOrUndefined(frame.namespace),
  attributes: frame.attributes,
  namespaceDeclarations: frame.declarations,
  inScopeNamespaces: frame.inScope,
  children: frame.children,
  position: frame.position,
});

/** Adds a finished element to its parent. */
const closeElement = (frame: Frame): void => {
  flush(frame);
  const element = elementOf(frame);
  const inDocument = HashSet.isEmpty(x.entityStack);
  // The document element (not one in an entity's replacement text) is the root
  if (x.stack.length === 1 && inDocument) {
    x.root = Option.some(element);
    return;
  }
  // A child of the root (not inside an entity's replacement text) may be taken as it closes
  if (x.stack.length === 2 && inDocument && x.onRootChild(element, elementOf(x.top()))) {
    const root = x.top();
    root.floor = root.children.length;
    return;
  }
  pushChild(x.top(), element);
};

const attribute: P<unknown> = Parser.seq(Parser.location, xmlName, eq, attributeValue).pipe(
  Parser.tap(([offset, attributeName, , value]) => {
    if (x.hasAttribute(attributeName)) fail(`Duplicate attribute "${attributeName}"`, offset);
    x.raw.push({ name: attributeName, value, offset, defaulted: false });
  }),
);

const startTag: P<unknown> = Parser.seq(
  Parser.tap(Parser.seq(Parser.location, Parser.preceded(lit('<'), xmlName)), ([start, qname]) => {
    x.tagStart = start;
    x.qname = qname;
    x.raw = [];
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
    Parser.preceded(lit('</'), xmlName),
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
    const frame = x.top();
    x.stack.pop();
    closeElement(frame);
  }),
);

const cdata: P<unknown> = Parser.seq(
  Parser.location,
  Parser.preceded(
    lit('<![CDATA['),
    Parser.opt(Parser.terminated(Token.takeUntil(']]>'), lit(']]>'))),
  ),
).pipe(
  Parser.tap(([start, text]) => {
    pushText(
      x.top(),
      Option.getOrElse(text, () => fail('Unterminated CDATA section', start)),
      start,
    );
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
  x.entityStack = HashSet.add(entityStack, body);
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
  Parser.opt(lit(';')),
).pipe(
  Parser.tap(([start, body, semi]) => {
    if (Option.isNone(semi)) fail('Unterminated reference', start);
    const frame = x.top();
    if (body.startsWith('#')) {
      if (!CHAR_REF_RE.test(body)) fail('Invalid character reference', start);
      pushText(frame, charRef(body, start), start);
      return;
    }
    const builtIn = predefined(body);
    if (builtIn !== '') {
      pushText(frame, builtIn, start);
      return;
    }
    const replacement = entityText(body, start, x.entityStack);
    if (!replacement.includes('<') && !replacement.includes('&')) {
      pushText(frame, replacement, start);
      return;
    }
    flush(frame);
    const position = x.position(start);
    replacementNodes(body, replacement, start).forEach((n) => {
      if (isText(n)) pushText(frame, n.value, start);
      else pushChild(frame, { ...n, position });
    });
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
const rootElement: P<unknown> = Parser.asVoid(
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
      x.version = Option.some(version);
    }),
    ws,
    Parser.opt(
      Parser.preceded(
        Parser.seq(at('encoding'), afterWs, lit('encoding'), eq),
        Parser.terminated(
          checked(quoted, (encoding, pos) => {
            if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(encoding)) fail('Invalid encoding name', pos);
            x.encoding = Option.some(encoding);
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
            x.standalone = Option.some(sd === 'yes');
          }),
          ws,
        ),
      ),
    ),
    expect('?>'),
  ),
);

const prologOrEpilog = (node: Xml.Comment | Xml.ProcessingInstruction): void => {
  (Option.isNone(x.root) ? x.prolog : x.epilog).push(node);
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
                  if (Option.isSome(x.doctype) || Option.isSome(x.root)) {
                    fail('Unexpected DOCTYPE', pos);
                  }
                }),
                doctype,
              ),
            ),
            Parser.preceded(
              at('<'),
              Parser.preceded(
                act((pos) => {
                  if (Option.isSome(x.root)) fail('Only one root element is allowed', pos);
                }),
                rootElement,
              ),
            ),
            act((pos) =>
              fail(
                Option.isNone(x.root)
                  ? 'Expected the root element'
                  : 'Content after the root element',
                pos,
              ),
            ),
          ),
        ),
      ),
      act((pos) => {
        if (Option.isNone(x.root)) fail('No root element', pos);
      }),
    ),
  ),
);

/** Parses a (line-end normalised) document, throwing a `Failure`. */
const parse = (
  text: string,
  lineStarts: ReadonlyArray<number>,
  onRootChild: RootChildHook,
): Xml.Document => {
  x = new Context(text, lineStarts);
  x.onRootChild = onRootChild;
  const result = Parser.parse(document, text);
  if (Result.isFailure(result)) fail('Invalid XML', result.failure.offset);
  return {
    _tag: 'Document',
    version: Option.getOrUndefined(x.version),
    encoding: Option.getOrUndefined(x.encoding),
    standalone: Option.getOrUndefined(x.standalone),
    doctype: Option.getOrUndefined(x.doctype),
    prolog: x.prolog,
    root: Option.getOrElse(x.root, () => fail('No root element', text.length)),
    epilog: x.epilog,
  };
};

/** The line and column of an offset, given the offsets at which lines start. */
const positionAt = (lineStarts: ReadonlyArray<number>, offset: number): Xml.Position => {
  const lo = lineIndex(lineStarts, offset, 0, lineStarts.length - 1);
  return { offset, line: lo + 1, column: offset - (lineStarts[lo] ?? 0) + 1 };
};

const lineStartsOf = (text: string): Array<number> => {
  const starts = [0];
  let i = text.indexOf('\n');
  loop(() => {
    if (i === -1) return false;
    starts.push(i + 1);
    i = text.indexOf('\n', i + 1);
    return true;
  });
  return starts;
};

/** @internal */
export const normalizeInput = (input: string): string => {
  const noBom = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  return noBom.includes('\r') ? noBom.replace(/\r\n?/g, '\n') : noBom;
};

/**
 * Parses a document (normalising its line ends first), throwing a `Failure`
 * with its position. `onRootChild` may take the root's children as they are
 * read.
 *
 * @internal
 */
export const parseText = (input: string, onRootChild: RootChildHook = keepChild): Xml.Document => {
  const text = normalizeInput(input);
  const lineStarts = lineStartsOf(text);
  const outcome = Result.try({
    try: () => {
      const bad = INVALID_CHAR_RE.exec(text);
      if (bad !== null) fail('Invalid XML character', bad.index);
      return parse(text, lineStarts, onRootChild);
    },
    catch: (e) => e,
  });
  if (Result.isSuccess(outcome)) return outcome.success;
  const e = outcome.failure;
  if (e instanceof Failure) e.position = positionAt(lineStarts, Math.min(e.offset, text.length));
  throw e;
};
