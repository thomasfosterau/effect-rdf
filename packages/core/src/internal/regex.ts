/**
 * A regular-expression engine for patterns that arrive in the data (SPARQL
 * `REGEX` / `REPLACE`, SHACL `sh:pattern`, ShEx `pattern`, CSVW `format`, N3
 * `string:matches`), whose running time is bounded by the pattern and the
 * input instead of by how the pattern backtracks.
 *
 * A pattern is parsed here (never handed to `new RegExp` whole) and compiled
 * to a small program. A program without back-references or lookahead runs on
 * a Pike VM: every thread of the match advances one character at a time, so a
 * search costs at most `program size × input length` steps whatever the
 * pattern (`(a+)+$` included). Back-references and lookahead cannot be matched
 * that way; a program that uses them runs on a backtracking matcher with a
 * step budget, and exhausting the budget is a reported outcome
 * ({@link EXHAUSTED}), never an unbounded search. The program itself is capped
 * ({@link MAX_INSTRUCTIONS}), so counted repetition cannot make it large.
 *
 * Two dialects share the engine. `xpath` is the XPath / XML Schema syntax
 * (`fn:matches`): `.` excludes only `\n` and `\r`; `\d`, `\w`, `\s`, `\i`,
 * `\c` and their complements have the XML Schema definitions; classes
 * subtract (`[a-z-[aeiou]]`); `\p{IsBlock}` names blocks; the flags are `s`,
 * `m`, `i`, `x` and `q`. It also accepts what the JavaScript engine it
 * replaces accepted: `\b`, `\B`, lookahead and the JavaScript character
 * escapes. `ecma` is the ECMAScript (Unicode-mode) syntax CSVW names.
 *
 * A single character is still tested by a JavaScript `RegExp` (a class such
 * as `[\p{L}-[a-z]]` becomes a one-character pattern), which is where the
 * Unicode tables come from; one character cannot backtrack.
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import { loop } from './loop.ts';

// -----------------------------------------------------------------------------
// Program
// -----------------------------------------------------------------------------

/** The end of a match. */
const MATCH = 0;
/** One code point, `a`. */
const CHAR = 1;
/** One code point accepted by predicate `a`. */
const SET = 2;
/** Any code point. */
const ANY = 3;
/** Continue at `a`. */
const JMP = 4;
/** Continue at `a`, or failing that at `b`. */
const SPLIT = 5;
/** Record the position in slot `a`. */
const SAVE = 6;
/** An assertion of kind `a` (one of the `AT_*` constants). */
const ASSERT = 7;
/** The text group `a` matched. */
const BACKREF = 8;
/** A lookahead over the instructions up to `a`; negative when `b` is 1. */
const LOOK = 9;
/** Record the position in loop register `a`. */
const MARK = 10;
/** Fail when the position still equals loop register `a` (an empty iteration). */
const CHECK = 11;

const AT_START = 0;
const AT_END = 1;
const AT_LINE_START = 2;
const AT_LINE_END = 3;
const AT_WORD_BOUNDARY = 4;
const NOT_AT_WORD_BOUNDARY = 5;

/** Numbers per instruction: the opcode and its two operands. */
const WIDTH = 3;

/**
 * The most instructions a compiled pattern may have. Counted repetition is
 * expanded (`a{3}` is `aaa`), so this is what bounds `(a{100}){100}`.
 *
 * @internal
 */
export const MAX_INSTRUCTIONS = 10_000;

/** How deeply groups may nest (the parser recurses once per level). */
const MAX_DEPTH = 200;

/** Steps the backtracking matcher may take per search, plus `BUDGET_PER_CHAR` per input character. */
const BUDGET = 1_000_000;
const BUDGET_PER_CHAR = 100;

/**
 * The outcome of a search: the pattern matched.
 *
 * @internal
 */
export const MATCHED = 1;
/**
 * The outcome of a search: the pattern did not match.
 *
 * @internal
 */
export const UNMATCHED = 0;
/**
 * The outcome of a search: a pattern with back-references or lookahead used
 * up its step budget before the answer was known.
 *
 * @internal
 */
export const EXHAUSTED = -1;

/** Tests one code point. */
type CharPredicate = (cp: number) => boolean;

/** The live threads of a Pike VM step, in priority order. */
interface Threads {
  readonly pcs: Array<number>;
  readonly caps: Array<ReadonlyArray<number>>;
}

/**
 * A compiled pattern.
 *
 * @internal
 */
export interface Regex {
  /** The pattern as written. */
  readonly source: string;
  /** The number of capturing groups. */
  readonly groups: number;
  /** Whether a search is linear in the input (no back-reference, no lookahead). */
  readonly linear: boolean;
  /** The program: `WIDTH` numbers per instruction, jumps as offsets into it. */
  readonly code: ReadonlyArray<number>;
  readonly predicates: ReadonlyArray<CharPredicate>;
  /** Capture slots plus loop registers. */
  readonly slots: number;
  /** Whether a match can only start at the start of the input. */
  readonly anchored: boolean;
  /** The text of a pattern that is one literal string, matched with `includes`. */
  readonly literal: Option.Option<string>;
  readonly ignoreCase: boolean;
  /** Pike VM scratch space, reused by every search (a search is synchronous). */
  readonly seen: Int32Array;
  readonly current: Threads;
  readonly next: Threads;
  readonly stack: Array<number>;
  readonly stackCaps: Array<ReadonlyArray<number>>;
  /** The generation `seen` is compared with; bumped for every thread list. */
  generation: number;
}

// -----------------------------------------------------------------------------
// Fragments
// -----------------------------------------------------------------------------

/** A piece of a program under construction, its jumps relative (in instructions). */
interface Fragment {
  readonly code: ReadonlyArray<number>;
  /** Whether the fragment can match the empty string. */
  readonly nullable: boolean;
}

const EMPTY: Fragment = { code: [], nullable: true };

const instruction = (op: number, a: number, b: number, nullable: boolean): Fragment => ({
  code: [op, a, b],
  nullable,
});

const sizeOf = (f: Fragment): number => f.code.length / WIDTH;

const concat = (a: Fragment, b: Fragment): Fragment => ({
  code: [...a.code, ...b.code],
  nullable: a.nullable && b.nullable,
});

const alternate = (a: Fragment, b: Fragment): Fragment => ({
  code: [SPLIT, 1, sizeOf(a) + 2, ...a.code, JMP, sizeOf(b) + 1, 0, ...b.code],
  nullable: a.nullable || b.nullable,
});

const optional = (f: Fragment, greedy: boolean): Fragment => {
  const skip = sizeOf(f) + 1;
  return { code: [SPLIT, greedy ? 1 : skip, greedy ? skip : 1, ...f.code], nullable: true };
};

/** `f*`. A body that can match nothing is guarded, so an empty iteration ends the loop. */
const star = (f: Fragment, greedy: boolean, register: number): Fragment => {
  const body = f.nullable ? [MARK, register, 0, ...f.code, CHECK, register, 0] : f.code;
  const exit = body.length / WIDTH + 2;
  return {
    code: [SPLIT, greedy ? 1 : exit, greedy ? exit : 1, ...body, JMP, 1 - exit, 0],
    nullable: true,
  };
};

// -----------------------------------------------------------------------------
// Character predicates
// -----------------------------------------------------------------------------

const UNKNOWN = 0;
const YES = 1;
const NO = 2;

/** A predicate from a one-character JavaScript pattern, its ASCII answers remembered. */
const predicateOf = (re: RegExp): CharPredicate => {
  const ascii = new Int8Array(128);
  return (cp) => {
    if (cp >= 128) return re.test(String.fromCodePoint(cp));
    const known = ascii[cp];
    if (known !== UNKNOWN) return known === YES;
    const answer = re.test(String.fromCodePoint(cp));
    ascii[cp] = answer ? YES : NO;
    return answer;
  };
};

const hex = (cp: number): string => `\\u{${cp.toString(16)}}`;

const isWordChar = (cp: number): boolean =>
  (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 95;

const hasCase = (cp: number): boolean => {
  const s = String.fromCodePoint(cp);
  return s.toLowerCase() !== s || s.toUpperCase() !== s;
};

// -----------------------------------------------------------------------------
// The XPath / XML Schema character classes
// -----------------------------------------------------------------------------

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

/** Class bodies of the XML Schema multi-character escapes. */
const XPATH_CLASSES: Table<ClassBody> = {
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

/** Class bodies of the ECMAScript class escapes (the engine's own definitions). */
const ECMA_CLASSES: Table<ClassBody> = {
  d: { body: '\\d', negated: false },
  D: { body: '\\d', negated: true },
  w: { body: '\\w', negated: false },
  W: { body: '\\w', negated: true },
  s: { body: '\\s', negated: false },
  S: { body: '\\s', negated: true },
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

/** The control characters with a letter escape in both dialects. */
const CONTROL_ESCAPES: Table<number> = { n: 10, r: 13, t: 9, f: 12, v: 11 };

// -----------------------------------------------------------------------------
// Parser
// -----------------------------------------------------------------------------

/**
 * The syntax a pattern is written in.
 *
 * @internal
 */
export type Dialect = 'xpath' | 'ecma';

/** What a character class holds: a character, or a class escape. */
type ClassMember =
  | { readonly kind: 'char'; readonly cp: number }
  | { readonly kind: 'class'; readonly body: string; readonly negated: boolean };

/** An escape: a character, a class, an assertion or a back-reference. */
type Escape =
  | ClassMember
  | { readonly kind: 'assert'; readonly assertion: number }
  | { readonly kind: 'backref'; readonly group: number };

const DIGIT = /^[0-9]$/;
const ALPHANUMERIC = /^[0-9A-Za-z]$/;
const QUANTIFIER = /^\{(\d+)(?:(,)(\d*))?\}/;
const GROUP_NAME = /^<([A-Za-z_$][\w$]*)>/;
const XPATH_SPACE = /^[\t\n\r ]$/;

class Parser {
  i = 0;
  groups = 0;
  registers = 0;
  depth = 0;
  backtracks = false;
  readonly src: string;
  readonly xpath: boolean;
  readonly ignoreCase: boolean;
  readonly multiline: boolean;
  readonly dotAll: boolean;
  readonly extended: boolean;
  readonly predicates: Array<CharPredicate> = [];
  readonly predicateIndex = MutableHashMap.empty<string, number>();
  readonly names = MutableHashMap.empty<string, number>();

  constructor(src: string, dialect: Dialect, flags: string) {
    this.src = src;
    this.xpath = dialect === 'xpath';
    this.ignoreCase = flags.includes('i');
    this.multiline = flags.includes('m');
    this.dotAll = flags.includes('s');
    this.extended = flags.includes('x');
  }

  fail(message: string): never {
    throw new SyntaxError(`${message} at ${this.i} in /${this.src}/`);
  }

  /** The character at the cursor (empty at the end). */
  peek(): string {
    return this.src.charAt(this.i);
  }

  eat(text: string): boolean {
    if (!this.src.startsWith(text, this.i)) return false;
    this.i += text.length;
    return true;
  }

  /** Reads the code point at the cursor. */
  codePoint(): number {
    const cp = this.src.codePointAt(this.i);
    if (cp === undefined) return this.fail('unexpected end of pattern');
    this.i += cp > 0xffff ? 2 : 1;
    return cp;
  }

  checkSize(f: Fragment): Fragment {
    return sizeOf(f) > MAX_INSTRUCTIONS
      ? this.fail(`pattern is too large (more than ${MAX_INSTRUCTIONS} instructions)`)
      : f;
  }

  /** The predicate for a one-character JavaScript pattern, built once per source. */
  predicate(source: string): Fragment {
    const known = MutableHashMap.get(this.predicateIndex, source);
    if (Option.isSome(known)) return instruction(SET, known.value, 0, false);
    const compiled = Result.try(() => new RegExp(`^(?:${source})$`, this.ignoreCase ? 'iu' : 'u'));
    if (Result.isFailure(compiled)) return this.fail('invalid character class');
    const index = this.predicates.push(predicateOf(compiled.success)) - 1;
    MutableHashMap.set(this.predicateIndex, source, index);
    return instruction(SET, index, 0, false);
  }

  /** A literal character, compared through a predicate when letter case is ignored. */
  literal(cp: number): Fragment {
    return this.ignoreCase && hasCase(cp)
      ? this.predicate(hex(cp))
      : instruction(CHAR, cp, 0, false);
  }

  // ---- escapes ---------------------------------------------------------------

  hexDigits(count: number): number {
    const digits = this.src.slice(this.i, this.i + count);
    if (digits.length !== count || !/^[0-9A-Fa-f]+$/.test(digits)) {
      return this.fail('invalid hexadecimal escape');
    }
    this.i += count;
    return Number.parseInt(digits, 16);
  }

  /** `\uHHHH` or `\u{H…}` (cursor after the `u`). */
  unicodeEscape(): number {
    if (!this.eat('{')) return this.hexDigits(4);
    const end = this.src.indexOf('}', this.i);
    const digits = end === -1 ? '' : this.src.slice(this.i, end);
    const cp = /^[0-9A-Fa-f]{1,6}$/.test(digits) ? Number.parseInt(digits, 16) : -1;
    if (cp < 0 || cp > 0x10ffff) return this.fail('invalid Unicode escape');
    this.i = end + 1;
    return cp;
  }

  /** `\p{…}` / `\P{…}` (cursor after the letter). */
  property(negated: boolean): Escape {
    const end = this.src.indexOf('}', this.i);
    if (this.peek() !== '{' || end === -1) return this.fail('invalid property escape');
    const name = this.src.slice(this.i + 1, end);
    this.i = end + 1;
    if (!this.xpath || !name.startsWith('Is')) {
      return { kind: 'class', body: `\\p{${name}}`, negated };
    }
    const block = BLOCKS[name.slice(2)];
    return block === undefined
      ? this.fail(`unsupported block ${name}`)
      : { kind: 'class', body: block, negated };
  }

  /** A numbered back-reference (cursor after its first digit, `first`). */
  backreference(first: string): Escape {
    let group = Number(first);
    loop(() => {
      const next = group * 10 + Number(this.peek());
      if (!DIGIT.test(this.peek()) || next > this.groups) return false;
      group = next;
      this.i++;
      return true;
    });
    if (group > this.groups) return this.fail(`no group ${group} to refer back to`);
    return { kind: 'backref', group };
  }

  /** `\k<name>` (cursor after the `k`). */
  namedBackreference(): Escape {
    const name = GROUP_NAME.exec(this.src.slice(this.i));
    const group = Option.flatMap(Option.fromNullOr(name), (n) =>
      MutableHashMap.get(this.names, n[1] ?? ''),
    );
    if (name === null || Option.isNone(group)) return this.fail('invalid named back-reference');
    this.i += name[0].length;
    return { kind: 'backref', group: group.value };
  }

  /** The escapes with a letter that both dialects read the same way, if `c` is one. */
  sharedEscape(c: string): Option.Option<Escape> {
    const control = CONTROL_ESCAPES[c];
    if (control !== undefined) return Option.some({ kind: 'char', cp: control });
    if (c === 'p' || c === 'P') return Option.some(this.property(c === 'P'));
    if (c === 'x') return Option.some({ kind: 'char', cp: this.hexDigits(2) });
    if (c === 'u') return Option.some({ kind: 'char', cp: this.unicodeEscape() });
    if (c === 'b') return Option.some({ kind: 'assert', assertion: AT_WORD_BOUNDARY });
    if (c === 'B') return Option.some({ kind: 'assert', assertion: NOT_AT_WORD_BOUNDARY });
    if (c === 'k') return Option.some(this.namedBackreference());
    if (c >= '1' && c <= '9') return Option.some(this.backreference(c));
    return Option.none();
  }

  /** Reads an escape (cursor after the backslash). */
  escape(): Escape {
    const start = this.i;
    const cp = this.codePoint();
    const c = String.fromCodePoint(cp);
    const classes = this.xpath ? XPATH_CLASSES : ECMA_CLASSES;
    const cls = classes[c];
    if (cls !== undefined) return { kind: 'class', ...cls };
    const shared = this.sharedEscape(c);
    if (Option.isSome(shared)) return shared.value;
    if (c === '0' && !this.xpath) return { kind: 'char', cp: 0 };
    if (c === 'c' && /^[A-Za-z]$/.test(this.peek())) {
      return { kind: 'char', cp: this.codePoint() % 32 };
    }
    if (!ALPHANUMERIC.test(c)) return { kind: 'char', cp };
    this.i = start;
    return this.fail(`invalid escape \\${c}`);
  }

  // ---- character classes -----------------------------------------------------

  /** An ECMAScript class, taken as written (cursor after `[`). */
  ecmaClass(): Fragment {
    const start = this.i - 1;
    loop(() => {
      const c = this.peek();
      if (c === '') return this.fail('unterminated character class');
      this.i += c === '\\' ? 2 : 1;
      return c !== ']';
    });
    return this.predicate(this.src.slice(start, this.i));
  }

  /** One end of a range or a single member of an XPath class: a character, or a class escape. */
  classMember(): ClassMember {
    if (!this.eat('\\')) return { kind: 'char', cp: this.codePoint() };
    const e = this.escape();
    return e.kind === 'char' || e.kind === 'class'
      ? e
      : this.fail('invalid escape in a character class');
  }

  /**
   * Translates an XPath class to a one-character JavaScript pattern (cursor
   * after `[`): its members, the complemented escapes (which cannot go in a
   * JavaScript class body) and a subtracted class.
   */
  xpathClass(): string {
    const negated = this.eat('^');
    const body: Array<string> = [];
    const extra: Array<string> = [];
    let subtraction = '';
    let first = true;
    loop(() => {
      if (this.peek() === '') return this.fail('unterminated character class');
      if (!first && this.eat(']')) return false;
      first = false;
      if (this.eat('-[')) {
        subtraction = this.xpathClass();
        return this.eat(']') ? false : this.fail('expected ] after class subtraction');
      }
      const member = this.classMember();
      if (member.kind === 'class') {
        if (member.negated) extra.push(`[^${member.body}]`);
        else body.push(member.body);
        return true;
      }
      body.push(this.rangeFrom(member.cp));
      return true;
    });
    const members = body.join('');
    const set = Arr.isReadonlyArrayEmpty(extra)
      ? `[${negated ? '^' : ''}${members}]`
      : unionOf(negated, [...(members === '' ? [] : [`[${members}]`]), ...extra]);
    return subtraction === '' ? set : `(?:(?!${subtraction})${set})`;
  }

  /** A class member that starts at `low`: the character, or a range to the next one. */
  rangeFrom(low: number): string {
    const next = this.src.charAt(this.i + 1);
    if (this.peek() !== '-' || next === ']' || next === '[' || next === '') return hex(low);
    this.i++;
    const high = this.classMember();
    if (high.kind !== 'char' || high.cp < low) return this.fail('invalid range in a class');
    return `${hex(low)}-${hex(high.cp)}`;
  }

  // ---- atoms -----------------------------------------------------------------

  /** A group (cursor after `(`). */
  group(): Fragment {
    this.depth++;
    if (this.depth > MAX_DEPTH) return this.fail('groups nest too deeply');
    const f = this.groupBody();
    if (!this.eat(')')) return this.fail('unterminated group');
    this.depth--;
    return f;
  }

  groupBody(): Fragment {
    if (this.eat('?:')) return this.alternation();
    if (this.eat('?=')) return this.lookahead(0);
    if (this.eat('?!')) return this.lookahead(1);
    if (this.src.startsWith('?<=', this.i) || this.src.startsWith('?<!', this.i)) {
      return this.fail('lookbehind is not supported');
    }
    const index = ++this.groups;
    if (this.eat('?')) {
      const name = GROUP_NAME.exec(this.src.slice(this.i));
      if (name === null) return this.fail('invalid group');
      this.i += name[0].length;
      MutableHashMap.set(this.names, name[1] ?? '', index);
    }
    const f = this.alternation();
    return {
      code: [SAVE, index * 2, 0, ...f.code, SAVE, index * 2 + 1, 0],
      nullable: f.nullable,
    };
  }

  lookahead(negative: number): Fragment {
    this.backtracks = true;
    const f = this.alternation();
    return { code: [LOOK, sizeOf(f) + 2, negative, ...f.code, MATCH, 0, 0], nullable: true };
  }

  dot(): Fragment {
    if (!this.xpath) return this.predicate('[^\\n\\r\\u2028\\u2029]');
    return this.dotAll ? instruction(ANY, 0, 0, false) : this.predicate('[^\\n\\r]');
  }

  escaped(): Fragment {
    const e = this.escape();
    if (e.kind === 'char') return this.literal(e.cp);
    if (e.kind === 'class') return this.predicate(`[${e.negated ? '^' : ''}${e.body}]`);
    if (e.kind === 'assert') return instruction(ASSERT, e.assertion, 0, true);
    this.backtracks = true;
    return instruction(BACKREF, e.group, 0, true);
  }

  /** `^` or `$`, if one is at the cursor. */
  anchor(): Option.Option<Fragment> {
    if (this.eat('^')) {
      return Option.some(instruction(ASSERT, this.multiline ? AT_LINE_START : AT_START, 0, true));
    }
    return this.eat('$')
      ? Option.some(instruction(ASSERT, this.multiline ? AT_LINE_END : AT_END, 0, true))
      : Option.none();
  }

  /** A group, class, dot or escape, if one starts at the cursor. */
  compound(): Option.Option<Fragment> {
    if (this.eat('(')) return Option.some(this.group());
    if (this.eat('[')) {
      return Option.some(this.xpath ? this.predicate(this.xpathClass()) : this.ecmaClass());
    }
    if (this.eat('.')) return Option.some(this.dot());
    return this.eat('\\') ? Option.some(this.escaped()) : this.anchor();
  }

  /** The atom at the cursor. */
  atom(): Fragment {
    const c = this.peek();
    if (c === '*' || c === '+' || c === '?') return this.fail('nothing to repeat');
    return Option.getOrElse(this.compound(), () => {
      const cp = this.codePoint();
      return this.extended && XPATH_SPACE.test(c) ? EMPTY : this.literal(cp);
    });
  }

  /** `f{min,max}` (`max` −1 for no upper bound), as copies of `f`. */
  repeat(f: Fragment, min: number, max: number, greedy: boolean): Fragment {
    if (max !== -1 && max < min) return this.fail('quantifier bounds are out of order');
    if (min > MAX_INSTRUCTIONS || max > MAX_INSTRUCTIONS) return this.checkSize(this.tooLarge());
    let tail = max === -1 ? star(f, greedy, this.registers++) : EMPTY;
    if (max !== -1) {
      loop((k) => {
        if (k >= max - min) return false;
        tail = this.checkSize(optional(concat(f, tail), greedy));
        return true;
      });
    }
    let head = EMPTY;
    loop((k) => {
      if (k >= min) return false;
      head = this.checkSize(concat(head, f));
      return true;
    });
    return this.checkSize(concat(head, tail));
  }

  /** A fragment over the cap, for a bound that alone exceeds it. */
  tooLarge(): Fragment {
    return {
      code: Array.from({ length: (MAX_INSTRUCTIONS + 1) * WIDTH }, () => 0),
      nullable: true,
    };
  }

  /** The bounds of the quantifier at the cursor, if there is one. */
  bounds(): Option.Option<readonly [number, number]> {
    if (this.eat('*')) return Option.some([0, -1]);
    if (this.eat('+')) return Option.some([1, -1]);
    if (this.eat('?')) return Option.some([0, 1]);
    const q = QUANTIFIER.exec(this.src.slice(this.i));
    if (q === null) return Option.none();
    this.i += q[0].length;
    const min = Number(q[1]);
    const upper = q[3] ?? '';
    return Option.some([min, q[2] === undefined ? min : upper === '' ? -1 : Number(upper)]);
  }

  /** An atom and the quantifiers after it. */
  quantified(): Fragment {
    let f = this.atom();
    loop(() => {
      const bounds = this.bounds();
      if (Option.isNone(bounds)) return false;
      const [min, max] = bounds.value;
      f = this.repeat(f, min, max, !this.eat('?'));
      return true;
    });
    return f;
  }

  sequence(): Fragment {
    let f = EMPTY;
    loop(() => {
      const c = this.peek();
      if (c === '' || c === '|' || c === ')') return false;
      f = this.checkSize(concat(f, this.quantified()));
      return true;
    });
    return f;
  }

  alternation(): Fragment {
    const first = this.sequence();
    return this.eat('|') ? this.checkSize(alternate(first, this.alternation())) : first;
  }

  /** A pattern taken literally (the XPath `q` flag). */
  quoted(): Fragment {
    let f = EMPTY;
    loop(() => {
      if (this.i >= this.src.length) return false;
      f = this.checkSize(concat(f, this.literal(this.codePoint())));
      return true;
    });
    return f;
  }

  parse(literally: boolean): Fragment {
    const f = literally ? this.quoted() : this.alternation();
    return this.i < this.src.length ? this.fail('unmatched )') : f;
  }
}

/** A class with complemented escapes: the union of its alternatives (or its complement). */
const unionOf = (negated: boolean, alternatives: ReadonlyArray<string>): string => {
  const union = `(?:${alternatives.join('|')})`;
  return negated ? `(?:(?!${union})[\\s\\S])` : union;
};

// -----------------------------------------------------------------------------
// Assembly
// -----------------------------------------------------------------------------

/** The operand positions (1 for `a`, 2 for `b`) that hold a jump, by opcode. */
const jumpOperands = (op: number): ReadonlyArray<number> =>
  op === SPLIT ? [1, 2] : op === JMP || op === LOOK ? [1] : [];

/** Makes the jumps absolute offsets and gives the loop registers their slots. */
const assemble = (body: Fragment, groups: number): Array<number> => {
  const code = [SAVE, 0, 0, ...body.code, SAVE, 1, 0, MATCH, 0, 0];
  const firstRegister = (groups + 1) * 2;
  code.forEach((op, at) => {
    if (at % WIDTH !== 0) return;
    jumpOperands(op).forEach((operand) => {
      code[at + operand] = at + (code[at + operand] ?? 0) * WIDTH;
    });
    if (op === MARK || op === CHECK) code[at + 1] = firstRegister + (code[at + 1] ?? 0);
  });
  return code;
};

/** The text of a body that is only literal characters. */
const literalOf = (body: Fragment): Option.Option<string> => {
  const cps = body.code.filter((_, at) => at % WIDTH === 1);
  return body.code.every((op, at) => at % WIDTH !== 0 || op === CHAR) &&
    Arr.isReadonlyArrayNonEmpty(cps)
    ? Option.some(String.fromCodePoint(...cps))
    : Option.none();
};

const XPATH_FLAGS = 'smixq';

/**
 * Compiles a pattern. `flags` are the XPath flags (`s`, `m`, `i`, `x`, `q`);
 * the `ecma` dialect takes only `i`. Fails with a message for a pattern that
 * is malformed, uses lookbehind, or compiles to more than
 * {@link MAX_INSTRUCTIONS} instructions.
 *
 * @internal
 */
export const compile = (
  pattern: string,
  dialect: Dialect,
  flags = '',
): Result.Result<Regex, string> => {
  const allowed = dialect === 'xpath' ? XPATH_FLAGS : 'i';
  const unsupported = Array.from(flags).find((flag) => !allowed.includes(flag));
  if (unsupported !== undefined) {
    return Result.fail(`unsupported regular expression flag '${unsupported}'`);
  }
  const parser = new Parser(pattern, dialect, flags);
  return Result.try({
    try: (): Regex => {
      const body = parser.parse(flags.includes('q'));
      const code = assemble(body, parser.groups);
      return {
        source: pattern,
        groups: parser.groups,
        linear: !parser.backtracks,
        code,
        predicates: parser.predicates,
        slots: (parser.groups + 1) * 2 + parser.registers,
        anchored: code[WIDTH] === ASSERT && code[WIDTH + 1] === AT_START,
        literal: parser.ignoreCase ? Option.none() : literalOf(body),
        ignoreCase: parser.ignoreCase,
        seen: new Int32Array(code.length),
        current: { pcs: [], caps: [] },
        next: { pcs: [], caps: [] },
        stack: [],
        stackCaps: [],
        generation: 0,
      };
    },
    catch: (e) => (e instanceof SyntaxError ? e.message : String(e)),
  });
};

/** Compiled patterns by dialect, flags and pattern: a data-supplied pattern is matched once per value. */
const cache = MutableHashMap.empty<string, Result.Result<Regex, string>>();
const CACHE_SIZE = 1000;

/**
 * {@link compile}, remembering the result (the last thousand patterns).
 *
 * @internal
 */
export const compileCached = (
  pattern: string,
  dialect: Dialect,
  flags = '',
): Result.Result<Regex, string> => {
  const key = `${dialect}/${flags}/${pattern}`;
  const known = MutableHashMap.get(cache, key);
  if (Option.isSome(known)) return known.value;
  const compiled = compile(pattern, dialect, flags);
  if (MutableHashMap.size(cache) >= CACHE_SIZE) MutableHashMap.clear(cache);
  MutableHashMap.set(cache, key, compiled);
  return compiled;
};

// -----------------------------------------------------------------------------
// Matching
// -----------------------------------------------------------------------------

const widthOf = (cp: number): number => (cp > 0xffff ? 2 : 1);

const NEWLINE = 10;

const wordAt = (input: string, pos: number): boolean =>
  pos >= 0 && pos < input.length && isWordChar(input.charCodeAt(pos));

/** Whether assertion `kind` holds at `pos`. */
const holds = (kind: number, input: string, pos: number): boolean => {
  if (kind === AT_START) return pos === 0;
  if (kind === AT_END) return pos === input.length;
  if (kind === AT_LINE_START) return pos === 0 || input.charCodeAt(pos - 1) === NEWLINE;
  if (kind === AT_LINE_END) return pos === input.length || input.charCodeAt(pos) === NEWLINE;
  const boundary = wordAt(input, pos - 1) !== wordAt(input, pos);
  return kind === AT_WORD_BOUNDARY ? boundary : !boundary;
};

/** Whether the consuming instruction at `pc` accepts code point `cp` (−1 at the end of input). */
const accepts = (re: Regex, pc: number, cp: number): boolean => {
  const op = re.code[pc];
  const a = re.code[pc + 1] ?? 0;
  if (cp < 0) return false;
  if (op === CHAR) return cp === a;
  if (op === ANY) return true;
  const predicate = re.predicates[a];
  return op === SET && predicate !== undefined && predicate(cp);
};

const NO_CAPTURES: ReadonlyArray<number> = [];

const withSlot = (
  caps: ReadonlyArray<number>,
  slot: number,
  pos: number,
): ReadonlyArray<number> => {
  const copy = caps.slice();
  copy[slot] = pos;
  return copy;
};

/**
 * Adds the thread at `pc0` to `list`, following jumps, splits, saves and
 * assertions to the consuming instructions (and `MATCH`) they lead to, in
 * priority order. Each instruction joins a list at most once per position.
 */
const addThread = (
  re: Regex,
  list: Threads,
  pc0: number,
  input: string,
  pos: number,
  caps0: ReadonlyArray<number>,
): void => {
  const { code, seen, stack, stackCaps, generation } = re;
  const tracking = caps0 !== NO_CAPTURES;
  const push = (pc: number, caps: ReadonlyArray<number>): void => {
    stack.push(pc);
    stackCaps.push(caps);
  };
  /** Follows the instruction at `pc` if it consumes nothing; false for one that joins the list. */
  const follow = (pc: number, caps: ReadonlyArray<number>): boolean => {
    const op = code[pc] ?? MATCH;
    const a = code[pc + 1] ?? 0;
    if (op === JMP) push(a, caps);
    else if (op === SPLIT) {
      push(code[pc + 2] ?? 0, caps);
      push(a, caps);
    } else if (op === SAVE) push(pc + WIDTH, tracking ? withSlot(caps, a, pos) : caps);
    else if (op === MARK || op === CHECK) push(pc + WIDTH, caps);
    else if (op !== ASSERT) return false;
    else if (holds(a, input, pos)) push(pc + WIDTH, caps);
    return true;
  };
  push(pc0, caps0);
  loop(() => {
    const pc = stack.pop();
    const caps = stackCaps.pop();
    if (pc === undefined || caps === undefined) return false;
    if (seen[pc] === generation) return true;
    seen[pc] = generation;
    if (!follow(pc, caps)) {
      list.pcs.push(pc);
      list.caps.push(caps);
    }
    return true;
  });
};

const clear = (list: Threads): void => {
  list.pcs.length = 0;
  list.caps.length = 0;
};

/**
 * Searches `input` from `from` on the Pike VM. With `captures`, finds the
 * leftmost match (preferring what a backtracking matcher would find first)
 * and writes its slots; without, stops at the first evidence of any match.
 */
const pike = (
  re: Regex,
  input: string,
  from: number,
  captures: Option.Option<Array<number>>,
): number => {
  const tracking = Option.isSome(captures);
  const initial: ReadonlyArray<number> = tracking
    ? Array.from({ length: re.slots }, () => -1)
    : NO_CAPTURES;
  let current = re.current;
  let next = re.next;
  clear(current);
  let matched = false;
  let pos = from;
  re.generation++;
  loop(() => {
    if (!matched) addThread(re, current, 0, input, pos, initial);
    if (Arr.isReadonlyArrayEmpty(current.pcs) && (matched || re.anchored)) return false;
    const cp = pos < input.length ? (input.codePointAt(pos) ?? -1) : -1;
    const after = pos + widthOf(cp);
    re.generation++;
    clear(next);
    const live = current;
    const found = live.pcs.some((pc, k) => {
      if (re.code[pc] === MATCH) {
        matched = true;
        if (tracking) writeCaptures(captures.value, live.caps[k] ?? NO_CAPTURES);
        return true;
      }
      if (accepts(re, pc, cp))
        addThread(re, next, pc + WIDTH, input, after, live.caps[k] ?? initial);
      return false;
    });
    if (found && !tracking) return false;
    current = next;
    next = live;
    if (pos >= input.length) return false;
    pos = after;
    return true;
  });
  return matched ? MATCHED : UNMATCHED;
};

const writeCaptures = (into: Array<number>, caps: ReadonlyArray<number>): void => {
  into.length = 0;
  caps.forEach((value) => into.push(value));
};

// ---- the bounded backtracking matcher ---------------------------------------

const BRANCH = 0;
const RESTORE = 1;

/**
 * Matches a program with back-references or lookahead at one start position,
 * depth first, charging every instruction to a step budget shared by the
 * whole search.
 */
class Backtracker {
  pc: number;
  pos: number;
  outcome = UNMATCHED;
  /** Triples: a branch to resume (`BRANCH`, pc, pos) or a slot to put back (`RESTORE`, slot, value). */
  readonly trail: Array<number> = [];
  readonly re: Regex;
  readonly input: string;
  readonly caps: Array<number>;
  readonly budget: { steps: number };

  constructor(
    re: Regex,
    input: string,
    caps: Array<number>,
    budget: { steps: number },
    pc: number,
    pos: number,
  ) {
    this.re = re;
    this.input = input;
    this.caps = caps;
    this.budget = budget;
    this.pc = pc;
    this.pos = pos;
  }

  set(slot: number, value: number): void {
    this.trail.push(RESTORE, slot, this.caps[slot] ?? -1);
    this.caps[slot] = value;
  }

  /** Resumes the most recent branch, undoing the slots set since; false when none is left. */
  backtrack(): boolean {
    let resumed = false;
    loop(() => {
      const b = this.trail.pop();
      const a = this.trail.pop();
      const kind = this.trail.pop();
      if (kind === undefined || a === undefined || b === undefined) return false;
      if (kind === RESTORE) {
        this.caps[a] = b;
        return true;
      }
      this.pc = a;
      this.pos = b;
      resumed = true;
      return false;
    });
    return resumed;
  }

  /** The length of the text group `group` matched if it recurs here, else −1 (an unset group matches empty). */
  backreference(group: number): number {
    const start = this.caps[group * 2] ?? -1;
    const end = this.caps[group * 2 + 1] ?? -1;
    if (start < 0 || end < 0) return 0;
    const text = this.input.slice(start, end);
    const here = this.input.slice(this.pos, this.pos + text.length);
    const same = this.re.ignoreCase ? here.toLowerCase() === text.toLowerCase() : here === text;
    return same ? text.length : -1;
  }

  /** Runs the lookahead whose body starts after `pc`; keeps its captures when a positive one holds. */
  lookahead(end: number, negative: boolean): boolean {
    const inner = new Backtracker(
      this.re,
      this.input,
      this.caps.slice(),
      this.budget,
      this.pc + WIDTH,
      this.pos,
    );
    const outcome = inner.run();
    if (outcome === EXHAUSTED) {
      this.outcome = EXHAUSTED;
      return false;
    }
    const held = outcome === MATCHED;
    if (held && !negative) {
      inner.caps.forEach((value, slot) => {
        if (value !== this.caps[slot]) this.set(slot, value);
      });
    }
    this.pc = end;
    return held !== negative;
  }

  /** Executes a consuming instruction; false when it does not accept the next character. */
  consume(): boolean {
    const cp = this.pos < this.input.length ? (this.input.codePointAt(this.pos) ?? -1) : -1;
    if (!accepts(this.re, this.pc, cp)) return false;
    this.pos += widthOf(cp);
    this.pc += WIDTH;
    return true;
  }

  /** Executes a non-consuming instruction; false when it fails here. */
  advance(op: number, a: number, b: number): boolean {
    if (op === JMP) this.pc = a;
    else if (op === SPLIT) {
      this.trail.push(BRANCH, b, this.pos);
      this.pc = a;
    } else if (op === SAVE || op === MARK) {
      this.set(a, this.pos);
      this.pc += WIDTH;
    } else if (op === LOOK) return this.lookahead(a, b === 1);
    else {
      const length = op === BACKREF ? this.backreference(a) : 0;
      const ok =
        op === CHECK
          ? this.caps[a] !== this.pos
          : op === ASSERT
            ? holds(a, this.input, this.pos)
            : length >= 0;
      if (!ok) return false;
      this.pos += length;
      this.pc += WIDTH;
    }
    return true;
  }

  run(): number {
    const { code } = this.re;
    loop(() => {
      this.budget.steps--;
      if (this.budget.steps < 0) {
        this.outcome = EXHAUSTED;
        return false;
      }
      const op = code[this.pc] ?? MATCH;
      if (op === MATCH) {
        this.outcome = MATCHED;
        return false;
      }
      const ok =
        op === CHAR || op === SET || op === ANY
          ? this.consume()
          : this.advance(op, code[this.pc + 1] ?? 0, code[this.pc + 2] ?? 0);
      return ok || (this.outcome !== EXHAUSTED && this.backtrack());
    });
    return this.outcome;
  }
}

/** Searches `input` from `from` with the backtracking matcher, trying each start in turn. */
const backtrackingSearch = (
  re: Regex,
  input: string,
  from: number,
  captures: Array<number>,
): number => {
  const budget = { steps: BUDGET + BUDGET_PER_CHAR * input.length };
  let outcome = UNMATCHED;
  let start = from;
  loop(() => {
    const caps = Array.from({ length: re.slots }, () => -1);
    outcome = new Backtracker(re, input, caps, budget, 0, start).run();
    if (outcome === MATCHED) writeCaptures(captures, caps);
    if (outcome !== UNMATCHED || start >= input.length || re.anchored) return false;
    start += widthOf(input.codePointAt(start) ?? 0);
    return true;
  });
  return outcome;
};

// -----------------------------------------------------------------------------
// Searching
// -----------------------------------------------------------------------------

/**
 * Whether `re` matches anywhere in `input`: {@link MATCHED},
 * {@link UNMATCHED}, or {@link EXHAUSTED} when a pattern with back-references
 * or lookahead ran out of steps.
 *
 * @internal
 */
export const search = (re: Regex, input: string): number => {
  if (Option.isSome(re.literal)) return input.includes(re.literal.value) ? MATCHED : UNMATCHED;
  return re.linear ? pike(re, input, 0, Option.none()) : backtrackingSearch(re, input, 0, []);
};

/**
 * Whether `re` matches anywhere in `input`. A search that exhausts its step
 * budget counts as no match.
 *
 * @internal
 */
export const test = (re: Regex, input: string): boolean => search(re, input) === MATCHED;

/**
 * The capture slots of a match: for group `n` (0 is the whole match), its
 * start at `2n` and its end at `2n + 1`, −1 for a group that took no part.
 *
 * @internal
 */
export type Captures = ReadonlyArray<number>;

/**
 * The leftmost match of `re` in `input` at or after `from`, writing its slots
 * to `captures`. Returns the outcome of the search.
 *
 * @internal
 */
export const exec = (re: Regex, input: string, from: number, captures: Array<number>): number =>
  re.linear
    ? pike(re, input, from, Option.some(captures))
    : backtrackingSearch(re, input, from, captures);

/**
 * The text of group `n` in a match, none for a group that took no part.
 *
 * @internal
 */
export const group = (input: string, captures: Captures, n: number): Option.Option<string> => {
  const start = captures[n * 2] ?? -1;
  const end = captures[n * 2 + 1] ?? -1;
  return start < 0 || end < 0 ? Option.none() : Option.some(input.slice(start, end));
};

/**
 * The first match of `re` in `input`, none when there is no match (or the
 * step budget ran out).
 *
 * @internal
 */
export const first = (re: Regex, input: string): Option.Option<Captures> => {
  const captures: Array<number> = [];
  return exec(re, input, 0, captures) === MATCHED ? Option.some(captures) : Option.none();
};

/**
 * Replaces every match of `re` in `input` with what `replacement` returns for
 * it, as a global `String.prototype.replace` does (an empty match advances one
 * character). None when the step budget ran out.
 *
 * @internal
 */
export const replaceAll = (
  re: Regex,
  input: string,
  replacement: (captures: Captures) => string,
): Option.Option<string> => {
  const out: Array<string> = [];
  const captures: Array<number> = [];
  let copied = 0;
  let from = 0;
  let outcome = UNMATCHED;
  loop(() => {
    outcome = from > input.length ? UNMATCHED : exec(re, input, from, captures);
    if (outcome !== MATCHED) return false;
    const start = captures[0] ?? 0;
    const end = captures[1] ?? 0;
    out.push(input.slice(copied, start), replacement(captures));
    copied = end;
    from = end > start ? end : end + widthOf(input.codePointAt(end) ?? 0);
    return true;
  });
  out.push(input.slice(copied));
  return outcome === EXHAUSTED ? Option.none() : Option.some(out.join(''));
};

const REFERENCE = /\$(\$|&|\d{1,2})/g;

/**
 * Expands a replacement template for one match, as `String.prototype.replace`
 * does: `$$` is a dollar sign, `$&` the match, `$n` / `$nn` a group (left as
 * written when the pattern has no such group).
 *
 * @internal
 */
export const expand = (re: Regex, template: string, input: string, captures: Captures): string => {
  const text = (n: number): string => Option.getOrElse(group(input, captures, n), () => '');
  return template.replace(REFERENCE, (whole: string, reference: string) => {
    if (reference === '$') return '$';
    if (reference === '&') return text(0);
    const both = Number(reference);
    if (both >= 1 && both <= re.groups) return text(both);
    const one = Number(reference.charAt(0));
    return one >= 1 && one <= re.groups ? `${text(one)}${reference.slice(1)}` : whole;
  });
};
