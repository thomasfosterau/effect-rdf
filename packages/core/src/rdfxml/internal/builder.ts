/**
 * Builds `Xml.Document`s from `@thomasfosterau/effect-xml`'s SAX events.
 *
 * effect-xml's tokenizer reads the characters: names, references, the
 * internal subset (entities, attribute defaults), CDATA sections, comments,
 * processing instructions, the XML declaration, the characters XML forbids
 * and the resource limits. This module adds what the tree needs on top of
 * that: well-formed structure (matched tags, one root, nothing but white
 * space, comments and processing instructions outside it), unique
 * attributes, Namespaces in XML 1.0 (resolution and its constraints), merged
 * text nodes and positions for every node.
 *
 * It is synchronous: `Sax.forEach` over a string runs to completion inside
 * one `Effect.runSyncExit`, and failures are thrown as a `Failure`, which
 * `RdfXml` and `Xml` turn into their typed errors.
 */
import * as Sax from '@thomasfosterau/effect-xml/Sax';
import * as Arr from 'effect/Array';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as HashMap from 'effect/HashMap';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import type * as Xml from '../Xml.ts';
import { isNCName } from './chars.ts';
import { loop } from '../../internal/loop.ts';

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

/** The most replacement text entity references may add to a document. */
export const MAX_ENTITY_EXPANSION = 1_000_000;
/** How deep entity references may nest in replacement text. */
export const MAX_ENTITY_DEPTH = 64;
/** How deep elements may nest. */
export const MAX_ELEMENT_DEPTH = 1024;

/**
 * The limits effect-xml enforces. Only those this parser has always had are
 * set; the others (text, name and attribute counts, total size) are off, so
 * a document that parsed before still parses.
 */
const LIMITS = {
  maxDepth: MAX_ELEMENT_DEPTH,
  maxEntityExpansion: MAX_ENTITY_EXPANSION,
  maxEntityDepth: MAX_ENTITY_DEPTH,
  maxAttributes: Infinity,
  maxNameLength: Infinity,
  maxTextLength: Infinity,
  maxTotalBytes: Infinity,
};

/** A well-formedness or namespace error at a position, thrown out of the builder. */
export class Failure {
  readonly message: string;
  readonly position: Xml.Position;
  constructor(message: string, position: Xml.Position) {
    this.message = message;
    this.position = position;
  }
}

const fail = (message: string, position: Xml.Position): never => {
  throw new Failure(message, position);
};

/** A plain position (effect-xml's resolve their line and column lazily). */
const plain = (p: { readonly offset: number; readonly line: number; readonly column: number }) => ({
  offset: p.offset,
  line: p.line,
  column: p.column,
});

/**
 * Receives each child element of the root as soon as it is closed, with the
 * root element as read so far (its `children` are those not taken). Returns
 * `true` to take the child, which is then left out of the document.
 */
export type RootChildHook = (child: Xml.Element, root: Xml.Element) => boolean;

const keepChild: RootChildHook = () => false;

/** Up to how many attributes a start tag's duplicates are found by searching its list. */
const SMALL = 16;

/** An open element. */
interface Frame {
  readonly qname: string;
  readonly position: Xml.Position;
  readonly prefix: string;
  readonly localName: string;
  /** The namespace name, or `''` for none (an empty namespace name is no namespace). */
  readonly namespace: string;
  readonly attributes: ReadonlyArray<Xml.Attribute>;
  readonly declarations: ReadonlyArray<Xml.NamespaceDeclaration>;
  readonly inScope: HashMap.HashMap<string, string>;
  readonly children: Array<Xml.Node>;
  /** Character data not yet added to `children`, and where it starts. */
  text: string;
  /** Where `text` starts, or `NO_TEXT` while it is empty. */
  textPosition: Xml.Position;
  /** How many children precede the last child taken by a `RootChildHook`: text never merges into them. */
  floor: number;
}

const ORIGIN: Xml.Position = { offset: 0, line: 1, column: 1 };

/** Stands for the position of a frame's pending text while it has none. */
const NO_TEXT: Xml.Position = { offset: -1, line: 0, column: 0 };

const documentFrame = (): Frame => ({
  qname: '',
  position: ORIGIN,
  prefix: '',
  localName: '',
  namespace: '',
  attributes: [],
  declarations: [],
  inScope: HashMap.empty(),
  children: [],
  text: '',
  textPosition: NO_TEXT,
  floor: 0,
});

const isText = Predicate.isTagged('Text');

/** Adds a frame's pending character data to its children, merging it into a text node before it. */
const flush = (frame: Frame): void => {
  if (frame.text === '') return;
  const children = frame.children;
  const prev = children.length > frame.floor ? children.at(-1) : undefined;
  if (isText(prev)) {
    children[children.length - 1] = { ...prev, value: prev.value + frame.text };
  } else {
    children.push({
      _tag: 'Text',
      value: frame.text,
      position: frame.textPosition,
    });
  }
  frame.text = '';
  frame.textPosition = NO_TEXT;
};

const pushChild = (frame: Frame, node: Xml.Node): void => {
  flush(frame);
  frame.children.push(node);
};

/** The namespace prefix an `xmlns` / `xmlns:…` attribute declares, or none for any other attribute. */
const declaredPrefix = (attribute: string): Option.Option<string> =>
  attribute === 'xmlns'
    ? Option.some('')
    : attribute.startsWith('xmlns:')
      ? Option.some(attribute.slice(6))
      : Option.none();

/** Checks a namespace declaration, which declares `prefix` to be `uri`. */
const checkDeclaration = (prefix: string, uri: string, position: Xml.Position): void => {
  if (prefix !== '' && !isNCName(prefix)) fail('Invalid namespace prefix', position);
  if (prefix === 'xmlns') fail('The "xmlns" prefix cannot be declared', position);
  if (prefix === 'xml' && uri !== XML_NAMESPACE) {
    fail('The "xml" prefix cannot be rebound', position);
  }
  if (prefix !== 'xml' && uri === XML_NAMESPACE) {
    fail('The XML namespace cannot be bound to another prefix', position);
  }
  if (uri === XMLNS_NAMESPACE) fail('The xmlns namespace cannot be declared', position);
  if (prefix !== '' && uri === '') {
    fail('Prefixed namespace declarations cannot be empty', position);
  }
};

/** The namespaces in scope of an element that makes `declarations` (which are not empty). */
const declare = (
  parentNs: HashMap.HashMap<string, string>,
  declarations: ReadonlyArray<Xml.NamespaceDeclaration>,
): HashMap.HashMap<string, string> =>
  HashMap.mutate(parentNs, (own) => {
    declarations.forEach((d) => {
      if (d.namespace === '') HashMap.remove(own, '');
      else HashMap.set(own, d.prefix, d.namespace);
    });
  });

const CHAR_REF_RE = /&#(x[0-9a-fA-F]+|[0-9]+);/g;
const COMMENT_OR_PI_RE = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g;
const ENTITY_DECL_RE =
  /<!ENTITY[ \t\r\n]+([^ \t\r\n%][^ \t\r\n]*)[ \t\r\n]+(?:"([^"]*)"|'([^']*)')/g;

/**
 * The internal general entities an internal subset declares (name → value,
 * with character references expanded); the first declaration of a name wins.
 * effect-xml expands them in the content; this is only the record of them.
 */
const entitiesOf = (subset: string): HashMap.HashMap<string, string> =>
  HashMap.mutate(HashMap.empty<string, string>(), (entities) => {
    Array.from(subset.replace(COMMENT_OR_PI_RE, '').matchAll(ENTITY_DECL_RE), (m) => {
      const name = m[1] ?? '';
      if (!HashMap.has(entities, name)) {
        const value = (m[2] ?? m[3] ?? '').replace(CHAR_REF_RE, (_, body: string) =>
          String.fromCodePoint(
            body.startsWith('x') ? Number.parseInt(body.slice(1), 16) : Number.parseInt(body, 10),
          ),
        );
        HashMap.set(entities, name, value);
      }
      return name;
    });
  });

/** The document being built. */
class Builder {
  readonly onRootChild: RootChildHook;
  readonly stack: Arr.NonEmptyArray<Frame> = [documentFrame()];
  /** The qualified names read so far, split. */
  readonly qnames = MutableHashMap.empty<string, readonly [prefix: string, local: string]>();
  /** The expanded names of a long start tag's attributes (cleared for each). */
  readonly expanded = MutableHashSet.empty<string>();

  version: Option.Option<string> = Option.none();
  encoding: Option.Option<string> = Option.none();
  standalone: Option.Option<boolean> = Option.none();
  doctype: Option.Option<Xml.DocumentType> = Option.none();
  readonly prolog: Array<Xml.Comment | Xml.ProcessingInstruction> = [];
  readonly epilog: Array<Xml.Comment | Xml.ProcessingInstruction> = [];
  root: Option.Option<Xml.Element> = Option.none();

  readonly lineStarts: ReadonlyArray<number>;
  /** The line (from 0) of the last position, where the next one usually is. */
  line = 0;

  constructor(text: string, onRootChild: RootChildHook) {
    this.lineStarts = lineStartsOf(text);
    this.onRootChild = onRootChild;
  }

  /** The root element as read so far: its frame never changes, and `children` is shared. */
  private view: Option.Option<Xml.Element> = Option.none();

  rootView(): Xml.Element {
    if (Option.isSome(this.view)) return this.view.value;
    const view = elementOf(this.top());
    this.view = Option.some(view);
    return view;
  }

  /** The position of an offset: offsets mostly increase, so the last line is tried first. */
  at(offset: number): Xml.Position {
    const starts = this.lineStarts;
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

  top(): Frame {
    return Arr.lastNonEmpty(this.stack);
  }

  /** The prefix (`''` if none) and local part of a qualified name, each checked once. */
  nameParts(qname: string, position: Xml.Position): readonly [prefix: string, local: string] {
    const known = MutableHashMap.get(this.qnames, qname);
    if (Option.isSome(known)) return known.value;
    const i = qname.indexOf(':');
    const parts: readonly [string, string] =
      i === -1 ? ['', qname] : [qname.slice(0, i), qname.slice(i + 1)];
    const [prefix, local] = parts;
    if (i === -1 ? !isNCName(qname) : !isNCName(prefix) || !isNCName(local)) {
      fail(`Invalid ${i === -1 ? '' : 'qualified '}name "${qname}"`, position);
    }
    if (prefix === 'xmlns') {
      fail('Elements and attributes cannot use the "xmlns" prefix', position);
    }
    MutableHashMap.set(this.qnames, qname, parts);
    return parts;
  }

  /** Content outside the root element: white space, comments and processing instructions only. */
  outside(position: Xml.Position): never {
    return fail(
      Option.isNone(this.root) ? 'Expected the root element' : 'Content after the root element',
      position,
    );
  }

  event(e: Sax.SaxEvent): void {
    switch (e._tag) {
      case 'StartElement':
        this.start(e);
        return;
      case 'EndElement':
        this.end(e);
        return;
      case 'Text':
      case 'CData':
        this.text(e);
        return;
      case 'Comment':
        this.misc({ _tag: 'Comment', value: e.data, position: this.at(e.span.start.offset) });
        return;
      case 'ProcessingInstruction':
        this.misc({
          _tag: 'ProcessingInstruction',
          target: e.target,
          data: e.data,
          position: this.at(e.span.start.offset),
        });
        return;
      case 'Doctype':
        if (Option.isSome(this.doctype) || Option.isSome(this.root) || this.stack.length > 1) {
          fail('Unexpected DOCTYPE', this.at(e.span.start.offset));
        }
        this.doctype = Option.some({
          name: e.name,
          publicId: e.publicId ?? undefined,
          systemId: e.systemId ?? undefined,
          entities: entitiesOf(e.internalSubset ?? ''),
        });
        return;
      case 'XmlDeclaration':
        this.version = Option.some(e.version);
        this.encoding = Option.fromNullishOr(e.encoding);
        this.standalone = Option.fromNullishOr(e.standalone);
    }
  }

  misc(node: Xml.Comment | Xml.ProcessingInstruction): void {
    if (this.stack.length > 1) pushChild(this.top(), node);
    else (Option.isNone(this.root) ? this.prolog : this.epilog).push(node);
  }

  text(e: {
    readonly _tag: 'Text' | 'CData';
    readonly data: string;
    readonly span: Sax.SaxEvent['span'];
  }): void {
    if (e.data === '') return;
    if (this.stack.length === 1) {
      if (e._tag === 'CData' || !isWhitespace(e.data)) this.outside(this.at(e.span.start.offset));
      return;
    }
    const frame = this.top();
    if (frame.textPosition === NO_TEXT) frame.textPosition = this.at(e.span.start.offset);
    frame.text += e.data;
  }

  start(e: Extract<Sax.SaxEvent, { readonly _tag: 'StartElement' }>): void {
    const position = this.at(e.span.start.offset);
    if (this.stack.length === 1 && Option.isSome(this.root)) {
      fail('Only one root element is allowed', position);
    }
    const qname: string = e.name;
    const raw = e.attributes;
    const tagStart = e.span.start.offset;
    const parent = this.top();

    // namespace declarations
    const declarations: Array<Xml.NamespaceDeclaration> = [];
    raw.forEach((a) => {
      const declared = declaredPrefix(a.name);
      if (Option.isNone(declared)) return;
      const prefix = declared.value;
      checkDeclaration(prefix, a.value, this.at(a.span.start.offset));
      if (prefix !== 'xml') declarations.push({ prefix, namespace: a.value });
    });
    const inScope = Arr.isArrayNonEmpty(declarations)
      ? declare(parent.inScope, declarations)
      : parent.inScope;

    const namePosition = {
      offset: position.offset + 1,
      line: position.line,
      column: position.column + 1,
    };
    const [prefix, localName] = this.nameParts(qname, namePosition);
    const namespace =
      prefix === ''
        ? Option.getOrElse(HashMap.get(inScope, ''), () => '')
        : this.namespaceOf(prefix, inScope, namePosition);

    const large = raw.length >= SMALL;
    if (large) MutableHashSet.clear(this.expanded);
    const attributes: Array<Xml.Attribute> = [];
    raw.forEach((a) => {
      const name: string = a.name;
      if (name === 'xmlns' || name.startsWith('xmlns:')) return;
      const at = this.at(a.span.start.offset);
      // effect-xml does not check duplicates: equal names have equal expanded
      // names, so the check below finds both (an `<!ATTLIST>` default is only
      // added when the attribute is absent)
      const [ap, al] = this.nameParts(name, at);
      const ans = ap === '' ? undefined : this.namespaceOf(ap, inScope, at);
      const duplicate = large
        ? MutableHashSet.has(this.expanded, `${ans ?? ''} ${al}`)
        : attributes.some((b) => b.localName === al && b.namespace === ans);
      if (duplicate) {
        fail(
          ans === undefined && ap === ''
            ? `Duplicate attribute "${name}"`
            : `Duplicate attribute "{${ans ?? ''}}${al}"`,
          at,
        );
      }
      if (large) MutableHashSet.add(this.expanded, `${ans ?? ''} ${al}`);
      attributes.push({
        _tag: 'Attribute',
        name,
        prefix: ap,
        localName: al,
        namespace: ans,
        value: a.value,
        // A defaulted attribute's span is its element's start tag
        defaulted: a.span.start.offset === tagStart,
        position: at,
      });
    });

    flush(parent);
    const frame: Frame = {
      qname,
      position,
      prefix,
      localName,
      namespace,
      attributes,
      declarations,
      inScope,
      children: [],
      text: '',
      textPosition: NO_TEXT,
      floor: 0,
    };
    if (e.selfClosing) this.close(frame);
    else this.stack.push(frame);
  }

  namespaceOf(
    prefix: string,
    inScope: HashMap.HashMap<string, string>,
    position: Xml.Position,
  ): string {
    if (prefix === 'xml') return XML_NAMESPACE;
    return Option.getOrElse(HashMap.get(inScope, prefix), () =>
      fail(`Unbound namespace prefix "${prefix}"`, position),
    );
  }

  end(e: Extract<Sax.SaxEvent, { readonly _tag: 'EndElement' }>): void {
    const frame = this.top();
    if (this.stack.length === 1)
      fail(`Unexpected end tag </${e.name}>`, this.at(e.span.start.offset));
    if (frame.qname !== e.name) {
      fail(`Mismatched end tag: expected </${frame.qname}>`, this.at(e.span.start.offset));
    }
    this.stack.pop();
    this.close(frame);
  }

  /** Adds a finished element to its parent (or makes it the root). */
  close(frame: Frame): void {
    flush(frame);
    const element = elementOf(frame);
    if (this.stack.length === 1) {
      this.root = Option.some(element);
      return;
    }
    // A child of the root may be taken as it closes
    if (this.stack.length === 2 && this.onRootChild(element, this.rootView())) {
      // Text before the child stays pending, so the root keeps one text node
      const root = this.top();
      root.floor = root.children.length;
      return;
    }
    pushChild(this.top(), element);
  }
}

/** The element an open frame stands for (with the children it has so far). */
const elementOf = (frame: Frame): Xml.Element => ({
  _tag: 'Element',
  name: frame.qname,
  prefix: frame.prefix,
  localName: frame.localName,
  namespace: frame.namespace === '' ? undefined : frame.namespace,
  attributes: frame.attributes,
  namespaceDeclarations: frame.declarations,
  inScopeNamespaces: frame.inScope,
  children: frame.children,
  position: frame.position,
});

// Hoisted: a regex literal makes a new `RegExp` each time it is evaluated.
const WHITESPACE = /^[ \t\r\n]*$/;

/** Whether a string consists only of XML white space (`S`). */
export const isWhitespace = (value: string): boolean => WHITESPACE.test(value);

/**
 * Whether the prolog has a document type declaration. Only then is the
 * internal subset read (`dtd: "internal"`), which turns effect-xml's fast
 * scanner off; without one, the two modes read a document identically. The
 * alternatives start with different characters, so the match is linear.
 */
const DOCTYPE_RE = /(?:[ \t\r\n]|<\?[\s\S]*?\?>|<!--[\s\S]*?-->)*<!DOCTYPE/y;

/** @internal */
export const normalizeInput = (input: string): string => {
  const noBom = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  return noBom.includes('\r') ? noBom.replace(/\r\n?/g, '\n') : noBom;
};

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

const LINE_BREAK_RE = /\r\n?|\n/g;

/** The offsets at which lines start; `\r\n`, `\r` and `\n` each end a line, as in XML. */
const lineStartsOf = (text: string): Array<number> => {
  const starts = [0];
  if (text.includes('\r')) {
    Array.from(text.matchAll(LINE_BREAK_RE), (m) => starts.push(m.index + m[0].length));
    return starts;
  }
  let i = text.indexOf('\n');
  loop(() => {
    if (i === -1) return false;
    starts.push(i + 1);
    i = text.indexOf('\n', i + 1);
    return true;
  });
  return starts;
};

/**
 * Parses a document, throwing a `Failure` with its position. `onRootChild`
 * may take the root's children as they are read. A leading byte order mark
 * is dropped; positions count UTF-16 code units of the input after it, with
 * line breaks as written.
 */
export const parseText = (input: string, onRootChild: RootChildHook = keepChild): Xml.Document => {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const builder = new Builder(text, onRootChild);
  DOCTYPE_RE.lastIndex = 0;
  const exit = Effect.runSyncExit(
    Sax.forEach(text, (e) => builder.event(e), {
      dtd: DOCTYPE_RE.test(text) ? 'internal' : 'ignore',
      limits: LIMITS,
    }),
  );
  if (Exit.isFailure(exit)) {
    const error = Cause.findErrorOption(exit.cause);
    if (Option.isSome(error)) {
      const failure = error.value;
      // The decoding errors (bytes only, never a string) carry no position
      const position = Predicate.hasProperty(failure, 'position') ? failure.position : null;
      throw new Failure(failure.message, Predicate.isNullish(position) ? ORIGIN : plain(position));
    }
    // A `Failure` the builder threw, or a defect
    throw Cause.squash(exit.cause);
  }
  if (builder.stack.length > 1) {
    fail('Unexpected end of input: unclosed element', builder.at(text.length));
  }
  return {
    _tag: 'Document',
    version: Option.getOrUndefined(builder.version),
    encoding: Option.getOrUndefined(builder.encoding),
    standalone: Option.getOrUndefined(builder.standalone),
    doctype: Option.getOrUndefined(builder.doctype),
    prolog: builder.prolog,
    root: Option.getOrElse(builder.root, () => fail('No root element', builder.at(text.length))),
    epilog: builder.epilog,
  };
};
