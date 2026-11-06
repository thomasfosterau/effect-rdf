import * as Arr from 'effect/Array';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
/**
 * Translation of XPath / XML Schema regular expressions (as used by the
 * ShEx `pattern` facet and `fn:matches`) to JavaScript `RegExp`s.
 *
 * Handled differences: `.` excludes only `\n` and `\r`; `\d`, `\w`, `\i`,
 * `\c` and their complements use the XML Schema definitions; character class
 * subtraction (`[a-z-[aeiou]]`); `\p{IsBlock}` names; the `x` flag removes
 * whitespace; escapes JavaScript rejects in Unicode mode are normalised.
 *
 * @internal
 */

const NAME_START =
  ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NAME_CHAR = `${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;

/** A character class body, and whether the class is complemented. */
interface ClassBody {
  readonly body: string;
  readonly negated: boolean;
}

/** A lookup table keyed by escape letter or block name. */
interface Table<A> {
  readonly [key: string]: A;
}

/** Class body fragments for the multi-character escapes. */
const CLASS_ESCAPES: Table<ClassBody> = {
  d: { body: '\\p{Nd}', negated: false },
  D: { body: '\\p{Nd}', negated: true },
  w: { body: '\\p{L}\\p{M}\\p{N}\\p{S}', negated: false },
  W: { body: '\\p{L}\\p{M}\\p{N}\\p{S}', negated: true },
  s: { body: ' \\t\\n\\r', negated: false },
  S: { body: ' \\t\\n\\r', negated: true },
  i: { body: NAME_START, negated: false },
  I: { body: NAME_START, negated: true },
  c: { body: NAME_CHAR, negated: false },
  C: { body: NAME_CHAR, negated: true },
};

const BLOCKS: Table<string> = {
  BasicLatin: '\\u0000-\\u007F',
  'Latin-1Supplement': '\\u0080-\\u00FF',
  LatinExtended_A: '\\u0100-\\u017F',
  'LatinExtended-A': '\\u0100-\\u017F',
  'LatinExtended-B': '\\u0180-\\u024F',
  IPAExtensions: '\\u0250-\\u02AF',
  Greek: '\\u0370-\\u03FF',
  GreekandCoptic: '\\u0370-\\u03FF',
  Cyrillic: '\\u0400-\\u04FF',
  Hebrew: '\\u0590-\\u05FF',
  Arabic: '\\u0600-\\u06FF',
  CJKUnifiedIdeographs: '\\u4E00-\\u9FFF',
  Hiragana: '\\u3040-\\u309F',
  Katakana: '\\u30A0-\\u30FF',
};

const SYNTAX = MutableHashSet.make(
  '^',
  '$',
  '\\',
  '.',
  '*',
  '+',
  '?',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '|',
  '/',
);

/** What a character class collects besides its body. */
interface ClassState {
  /** Complemented class escapes, which cannot go in the body. */
  readonly extra: Array<string>;
  /** The subtracted class (`-[…]`), translated. */
  subtraction: Option.Option<string>;
}

/** An escape read by `Translator.escape`: a character, or a class body. */
type Escape = { kind: 'char'; text: string } | { kind: 'class'; body: string; negated: boolean };

// Built once: `escape` runs it for every backslash of every pattern.
const escapeOf: (c: string, t: Translator) => Escape = Match.fn(
  (c: string, _t: Translator) => c,
).pipe(
  Match.withReturnType<Escape>(),
  Match.when('n', () => ({ kind: 'char', text: '\\n' })),
  Match.when('r', () => ({ kind: 'char', text: '\\r' })),
  Match.when('t', () => ({ kind: 'char', text: '\\t' })),
  Match.when(Match.is('p', 'P'), (c, _c, t) => {
    const p = t.property(c === 'P');
    return { kind: 'class', ...p };
  }),
  Match.orElse((c, _c, t) => {
    const ce = CLASS_ESCAPES[c];
    if (ce !== undefined) return { kind: 'class', ...ce };
    if (/[0-9]/.test(c)) return { kind: 'char', text: `\\${c}` };
    if (c === '-') return { kind: 'char', text: '\\-' };
    if (MutableHashSet.has(SYNTAX, c)) return { kind: 'char', text: `\\${c}` };
    return t.fail(`invalid escape \\${c}`);
  }),
);

class Translator {
  i = 0;
  readonly src: string;
  readonly dotAll: boolean;
  readonly extended: boolean;
  constructor(src: string, dotAll: boolean, extended: boolean) {
    this.src = src;
    this.dotAll = dotAll;
    this.extended = extended;
  }

  fail(msg: string): never {
    throw new SyntaxError(`${msg} at ${this.i} in /${this.src}/`);
  }

  /** Translates a property escape `\p{..}` / `\P{..}` (cursor after `p`/`P`). */
  property(negated: boolean): ClassBody {
    if (this.src[this.i] !== '{') this.fail('expected {');
    const end = this.src.indexOf('}', this.i);
    if (end === -1) this.fail('unterminated property escape');
    const name = this.src.slice(this.i + 1, end);
    this.i = end + 1;
    if (name.startsWith('Is')) {
      const block = BLOCKS[name.slice(2)];
      if (block === undefined) this.fail(`unsupported block ${name}`);
      return { body: block, negated };
    }
    return { body: `\\p{${name}}`, negated };
  }

  /** Reads an escape inside or outside a class (cursor after the backslash). */
  escape(): Escape {
    const c = this.src[this.i++];
    if (c === undefined) this.fail('dangling backslash');
    return escapeOf(c, this);
  }

  /** Translates a character class (cursor after `[`); returns a JS fragment. */
  charClass(): string {
    const negated = this.src[this.i] === '^';
    if (negated) this.i++;
    const state: ClassState = { extra: [], subtraction: Option.none() };
    const raw = Arr.unfold(true, (first) =>
      Option.map(this.classAtom(first, state), (fragment) => [fragment, false] as const),
    ).join('');
    // Ranges were emitted with escaped '-': restore range operators between plain characters.
    const body = restoreRanges(raw);
    const { extra } = state;
    const set = Arr.isReadonlyArrayEmpty(extra)
      ? `[${negated ? '^' : ''}${body}]`
      : this.union(negated, [...(body === '' ? [] : [`[${body}]`]), ...extra]);
    return Option.match(state.subtraction, {
      onNone: () => set,
      onSome: (subtraction) => `(?:(?!${subtraction})${set})`,
    });
  }

  /** A class with complemented escapes: the union of its alternatives (or its complement). */
  union(negated: boolean, alts: ReadonlyArray<string>): string {
    const union = `(?:${alts.join('|')})`;
    return negated ? `(?:(?!${union})[\\s\\S])` : union;
  }

  /**
   * Reads the next atom of a character class, returning its body fragment,
   * or none once the class ends (`]`, or a subtraction, which ends it).
   */
  classAtom(first: boolean, state: ClassState): Option.Option<string> {
    const c = this.src[this.i];
    if (c === undefined) this.fail('unterminated character class');
    if (c === ']' && !first) {
      this.i++;
      return Option.none();
    }
    if (c === '-' && this.src[this.i + 1] === '[') {
      this.i += 2;
      state.subtraction = Option.some(this.charClass());
      if (this.src[this.i] !== ']') this.fail('expected ] after class subtraction');
      this.i++;
      return Option.none();
    }
    this.i++;
    if (c === '\\') {
      const e = this.escape();
      if (e.kind === 'char') return Option.some(e.text);
      if (!e.negated) return Option.some(e.body);
      state.extra.push(`[^${e.body}]`);
      return Option.some('');
    }
    if (c === '[' || c === '/' || c === '{' || c === '}' || c === '(' || c === ')' || c === '|') {
      return Option.some(`\\${c}`);
    }
    return Option.some(c === '-' ? '\\-' : c);
  }

  /** Translates the atom at the cursor (outside a class). */
  atom(): string {
    const c = this.src.charAt(this.i);
    if (this.extended && /\s/.test(c)) {
      this.i++;
      return '';
    }
    if (c === '\\') {
      this.i++;
      const e = this.escape();
      return e.kind === 'char'
        ? e.text === '\\-'
          ? '-'
          : e.text
        : `[${e.negated ? '^' : ''}${e.body}]`;
    }
    if (c === '[') {
      this.i++;
      return this.charClass();
    }
    if (c === '{') {
      const q = /^\{\d+(?:,\d*)?\}/.exec(this.src.slice(this.i));
      if (q !== null) {
        this.i += q[0].length;
        return q[0];
      }
      this.i++;
      return '\\{';
    }
    this.i++;
    if (c === '.') return this.dotAll ? '[\\s\\S]' : '[^\\n\\r]';
    if (c === '/') return '\\/';
    if (c === ']' || c === '}') return `\\${c}`;
    return c;
  }

  translate(): string {
    return Arr.unfold(this, (t) =>
      t.i < t.src.length ? Option.some([t.atom(), t] as const) : Option.none(),
    ).join('');
  }
}

/**
 * Inside a translated class body, a `-` between two class atoms that was
 * written unescaped is a range; we escaped every `-` while scanning, so turn
 * back those that had atoms on both sides in the source.
 */
const restoreRanges = (body: string): string => {
  // Tokenise into atoms: escapes (\x, \p{..}, \u{..}) or single code points.
  const atoms = body.match(CLASS_ATOM) ?? [];
  const endpointAt = (k: number): boolean => {
    const a = atoms[k];
    return a !== undefined && isRangeEndpoint(a);
  };
  return Arr.map(atoms, (a, k) =>
    a === '\\-' && endpointAt(k - 1) && endpointAt(k + 1) ? '-' : a,
  ).join('');
};

const CLASS_ATOM = /\\(?:[pP]\{[^}]*\}|u\{[0-9A-Fa-f]+\}|u[0-9A-Fa-f]{4}|.)|./gsu;

const isRangeEndpoint = (atom: string): boolean => !/^\\[pPdDwWsS]/.test(atom) && atom !== '\\-';

/**
 * Compiles an XPath regular expression with XPath flags (`s`, `m`, `i`, `x`,
 * `q`) to a JavaScript `RegExp` (Unicode mode).
 *
 * @internal
 */
export const compileXPathRegex = (pattern: string, flags: string): RegExp => {
  if (flags.includes('q')) {
    const escaped = pattern.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
    return new RegExp(escaped, `u${flags.includes('i') ? 'i' : ''}`);
  }
  const t = new Translator(pattern, flags.includes('s'), flags.includes('x'));
  const source = t.translate();
  let jsFlags = 'u';
  if (flags.includes('i')) jsFlags += 'i';
  if (flags.includes('m')) jsFlags += 'm';
  return new RegExp(source, jsFlags);
};
