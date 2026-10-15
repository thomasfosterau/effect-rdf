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

/** Class body fragments for the multi-character escapes. */
const CLASS_ESCAPES: Record<string, { readonly body: string; readonly negated: boolean }> = {
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

const BLOCKS: Record<string, string> = {
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

const SYNTAX = new Set(['^', '$', '\\', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/']);

class Translator {
  i = 0;
  constructor(
    readonly src: string,
    readonly dotAll: boolean,
    readonly extended: boolean,
  ) {}

  fail(msg: string): never {
    throw new Error(`${msg} at ${this.i} in /${this.src}/`);
  }

  /** Translates a property escape `\p{..}` / `\P{..}` (cursor after `p`/`P`). */
  property(negated: boolean): { body: string; negated: boolean } {
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
  escape(): { kind: 'char'; text: string } | { kind: 'class'; body: string; negated: boolean } {
    const c = this.src[this.i++];
    if (c === undefined) this.fail('dangling backslash');
    switch (c) {
      case 'n':
        return { kind: 'char', text: '\\n' };
      case 'r':
        return { kind: 'char', text: '\\r' };
      case 't':
        return { kind: 'char', text: '\\t' };
      case 'p':
      case 'P': {
        const p = this.property(c === 'P');
        return { kind: 'class', ...p };
      }
      default:
        break;
    }
    const ce = CLASS_ESCAPES[c];
    if (ce !== undefined) return { kind: 'class', ...ce };
    if (/[0-9]/.test(c)) return { kind: 'char', text: `\\${c}` };
    if (c === '-') return { kind: 'char', text: '\\-' };
    if (SYNTAX.has(c)) return { kind: 'char', text: `\\${c}` };
    return this.fail(`invalid escape \\${c}`);
  }

  /** Translates a character class (cursor after `[`); returns a JS fragment. */
  charClass(): string {
    let negated = false;
    if (this.src[this.i] === '^') {
      negated = true;
      this.i++;
    }
    let body = '';
    const extra: Array<string> = [];
    let subtraction: string | undefined;
    let first = true;
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined) this.fail('unterminated character class');
      if (c === ']' && !first) {
        this.i++;
        break;
      }
      first = false;
      if (c === '-' && this.src[this.i + 1] === '[') {
        this.i += 2;
        subtraction = this.charClass();
        if (this.src[this.i] !== ']') this.fail('expected ] after class subtraction');
        this.i++;
        break;
      }
      if (c === '\\') {
        this.i++;
        const e = this.escape();
        if (e.kind === 'char') body += e.text;
        else if (!e.negated) body += e.body;
        else extra.push(`[^${e.body}]`);
        continue;
      }
      this.i++;
      if (c === '[' || c === '/' || c === '{' || c === '}' || c === '(' || c === ')' || c === '|') {
        body += `\\${c}`;
      } else if (c === '-') {
        body += '\\-';
      } else body += c;
    }
    // Ranges were emitted with escaped '-': restore range operators between plain characters.
    body = restoreRanges(body);
    let set: string;
    if (extra.length === 0) set = `[${negated ? '^' : ''}${body}]`;
    else {
      const alts = [...(body === '' ? [] : [`[${body}]`]), ...extra];
      const union = `(?:${alts.join('|')})`;
      set = negated ? `(?:(?!${union})[\\s\\S])` : union;
    }
    return subtraction === undefined ? set : `(?:(?!${subtraction})${set})`;
  }

  translate(): string {
    let out = '';
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (this.extended && /\s/.test(c)) {
        this.i++;
        continue;
      }
      if (c === '\\') {
        this.i++;
        const e = this.escape();
        out +=
          e.kind === 'char'
            ? e.text === '\\-'
              ? '-'
              : e.text
            : `[${e.negated ? '^' : ''}${e.body}]`;
        continue;
      }
      if (c === '[') {
        this.i++;
        out += this.charClass();
        continue;
      }
      if (c === '.') {
        this.i++;
        out += this.dotAll ? '[\\s\\S]' : '[^\\n\\r]';
        continue;
      }
      if (c === '/') {
        this.i++;
        out += '\\/';
        continue;
      }
      if (c === '{') {
        const q = /^\{\d+(?:,\d*)?\}/.exec(this.src.slice(this.i));
        if (q !== null) {
          out += q[0];
          this.i += q[0].length;
        } else {
          out += '\\{';
          this.i++;
        }
        continue;
      }
      if (c === ']' || c === '}') {
        this.i++;
        out += `\\${c}`;
        continue;
      }
      out += c;
      this.i++;
    }
    return out;
  }
}

/**
 * Inside a translated class body, a `-` between two class atoms that was
 * written unescaped is a range; we escaped every `-` while scanning, so turn
 * back those that had atoms on both sides in the source.
 */
const restoreRanges = (body: string): string => {
  // Tokenise into atoms: escapes (\x, \p{..}, \u{..}) or single code points.
  const atoms: Array<string> = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === '\\') {
      const m = /^\\(?:[pP]\{[^}]*\}|u\{[0-9A-Fa-f]+\}|u[0-9A-Fa-f]{4}|.)/su.exec(body.slice(i));
      atoms.push(m![0]);
      i += m![0].length;
    } else {
      const cp = body.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      atoms.push(ch);
      i += ch.length;
    }
  }
  let out = '';
  for (let k = 0; k < atoms.length; k++) {
    const a = atoms[k]!;
    if (
      a === '\\-' &&
      k > 0 &&
      k < atoms.length - 1 &&
      isRangeEndpoint(atoms[k - 1]!) &&
      isRangeEndpoint(atoms[k + 1]!)
    ) {
      out += '-';
    } else out += a;
  }
  return out;
};

const isRangeEndpoint = (atom: string): boolean =>
  !/^\\[pPdDwWsS]/.test(atom) && atom !== '\\-';

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
