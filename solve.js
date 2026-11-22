// solve.js — a faster drop-in for makefun-site 1.0.0 (make.fun's own static site generator).
// Same answers, byte for byte. Speed comes from: a single-pass Markdown renderer that never
// builds token objects and escapes plain runs in bulk; chunk-array template rendering; cached
// slugs with an ASCII fast path; index-based front matter (no full split/join of the body);
// allocation-free word counting. No network, no WASM, no native code, dependency-free.

/* ------------------------------------------------------------------ text */

// HTML escape table. ESC is a null-prototype object so single-char lookups are safe.
const ESC = Object.create(null);
ESC['&'] = '&amp;';
ESC['<'] = '&lt;';
ESC['>'] = '&gt;';
ESC['"'] = '&quot;';
ESC["'"] = '&#39;';
const HAS_SPECIAL = /[&<>"']/;

/** `text` with & < > " and ' escaped. Fast path when nothing needs escaping. */
export function escapeHtml(text) {
  if (!HAS_SPECIAL.test(text)) return text;
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const e = ESC[text[i]];
    if (e !== undefined) {
      out += text.slice(last, i) + e;
      last = i + 1;
    }
  }
  return out + text.slice(last);
}

/** Escape `s[a..b)` into the chunk array `out`, without allocating the substring. */
const ESC_TBL = new Array(128).fill(null);
ESC_TBL[38] = '&amp;';
ESC_TBL[60] = '&lt;';
ESC_TBL[62] = '&gt;';
ESC_TBL[34] = '&quot;';
ESC_TBL[39] = '&#39;';
function pushEsc(out, s, a, b) {
  let last = a;
  for (let j = a; j < b; j++) {
    const c = s.charCodeAt(j);
    const e = c < 128 ? ESC_TBL[c] : null;
    if (e !== null) {
      if (j > last) out.push(s.slice(last, j));
      out.push(e);
      last = j + 1;
    }
  }
  if (b > last) out.push(s.slice(last, b));
}

/** The most characters a slug keeps before a collision suffix. */
export const SLUG_MAX = 64;

/** The slug of `plain` (already NFKD, marks dropped): the reference's loop, chunk-built. */
function slugFrom(plain) {
  const parts = [];
  let gap = false;
  let len = 0;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = len > 0;
      continue;
    }
    if (gap) {
      parts.push('-');
      len++;
    }
    gap = false;
    parts.push(keep);
    len++;
  }
  const out = parts.join('').slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

const slugCache = new Map();
const NON_ASCII = /[^\x00-\x7F]/;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters
 * other than a-z and 0-9 one "-", none at either end, at most 64 characters, "untitled" when
 * nothing is left. Results are cached (titles and tags repeat); ASCII text skips the
 * normalisation, which is the identity on it.
 */
export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = NON_ASCII.test(text) ? slugFrom(text.normalize('NFKD').replace(/\p{M}/gu, '')) : slugFrom(text);
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether char code `c` is JavaScript whitespace (the \s set). ASCII via a table. */
const WS_TBL = new Uint8Array(128);
WS_TBL[9] = 1;
WS_TBL[10] = 1;
WS_TBL[11] = 1;
WS_TBL[12] = 1;
WS_TBL[13] = 1;
WS_TBL[32] = 1;
function isWS(c) {
  if (c < 128) return WS_TBL[c] === 1;
  return c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace (no regex, no array). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c < 128 ? WS_TBL[c] === 1 : (c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------ front matter */

/** The keys a source's front matter may give. */
export const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const KEYSET = new Set(KEYS);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function stringOf(raw) {
  if (raw.length > 0 && raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        if (i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        const n = raw[i + 1];
        if (n !== '"' && n !== '\\') return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.length > 0 && raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * The `key` and `raw` value of the front-matter line `text[a..b)`, or null when the line is
 * not "key: value" (a key of a-z and _, a colon, one space and the value, trailing spaces
 * and tabs dropped). Mirrors /^([a-z_]+):(?: (.*))?$/.
 */
function keyValueOf(text, a, b) {
  let i = a;
  while (i < b) {
    const c = text.charCodeAt(i);
    if ((c >= 97 && c <= 122) || c === 95) i++;
    else break;
  }
  if (i === a) return null;
  if (i >= b || text.charCodeAt(i) !== 58) return null;
  const key = text.slice(a, i);
  let raw;
  if (i + 1 >= b) raw = '';
  else if (text.charCodeAt(i + 1) === 32) raw = text.slice(i + 2, b);
  else return null;
  let e = raw.length;
  while (e > 0) {
    const c = raw.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return { key, raw: raw.slice(0, e) };
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is
 * refused. `text` has "\n" line ends. Read by index scans: the body is one slice, never a
 * split and re-join of every line.
 */
export function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let close = -1;
  let closeLineEnd = -1;
  let p = 4;
  while (p <= text.length) {
    const nl = text.indexOf('\n', p);
    const end = nl === -1 ? text.length : nl;
    if (end - p === 3 && text.charCodeAt(p) === 45 && text.charCodeAt(p + 1) === 45 && text.charCodeAt(p + 2) === 45) {
      close = p;
      closeLineEnd = end;
      break;
    }
    if (nl === -1) break;
    p = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let q = 4;
  let ln = 2;
  while (q < close) {
    const nl = text.indexOf('\n', q);
    const end = nl === -1 ? text.length : nl;
    let blank = true;
    for (let k = q; k < end; k++) {
      const c = text.charCodeAt(k);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (!blank && text.charCodeAt(q) !== 35) {
      const kv = keyValueOf(text, q, end);
      if (kv === null) return { error: `line ${ln} is not "key: value"` };
      const { key, raw } = kv;
      if (!KEYSET.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    q = end + 1;
    ln++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeLineEnd >= text.length ? '' : text.slice(closeLineEnd + 1);
  return { data, body };
}

/* --------------------------------------------------------------- markdown */

// The characters a backslash escapes. Indexed by char code for a fast lookup.
const ESCAPABLE = new Uint8Array(128);
for (const c of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[c.charCodeAt(0)] = 1;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (s.charCodeAt(j) !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline into the chunk array `out`; `env.link(target)` is a link's href.
 * A global regex finds the next special character (`\`, backtick, `*`, `[`) so plain runs
 * are skipped by the regex engine, not by a per-character loop; plain runs are escaped in
 * bulk. The shared regex's lastIndex is saved and restored around recursive renders.
 */
const SPECIAL_RE = /[\\`*\[]/g;
export function inline(s, env, out) {
  const n = s.length;
  let seg = 0;
  SPECIAL_RE.lastIndex = 0;
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null) {
    const i = m.index;
    const c = m[0].charCodeAt(0);
    if (c === 92 && i + 1 < n && ESCAPABLE[s.charCodeAt(i + 1)]) {
      pushEsc(out, s, seg, i);
      const e = s[i + 1];
      out.push(ESC[e] === undefined ? e : ESC[e]);
      SPECIAL_RE.lastIndex = i + 2;
      seg = i + 2;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        pushEsc(out, s, seg, i);
        out.push('<code>');
        pushEsc(out, s, i + 1, j);
        out.push('</code>');
        SPECIAL_RE.lastIndex = j + 1;
        seg = j + 1;
      } else SPECIAL_RE.lastIndex = i + 1;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          pushEsc(out, s, seg, i);
          out.push('<strong>');
          const saved = SPECIAL_RE.lastIndex;
          inline(s.slice(i + 2, j), env, out);
          SPECIAL_RE.lastIndex = saved;
          out.push('</strong>');
          SPECIAL_RE.lastIndex = j + 2;
          seg = j + 2;
        } else SPECIAL_RE.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        pushEsc(out, s, seg, i);
        out.push('<em>');
        const saved = SPECIAL_RE.lastIndex;
        inline(s.slice(i + 1, j), env, out);
        SPECIAL_RE.lastIndex = saved;
        out.push('</em>');
        SPECIAL_RE.lastIndex = j + 1;
        seg = j + 1;
      } else SPECIAL_RE.lastIndex = i + 1;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m2 = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !/\s/.test(target)) {
        pushEsc(out, s, seg, i);
        out.push('<a href="');
        out.push(escapeHtml(env.link(target)));
        out.push('">');
        const saved = SPECIAL_RE.lastIndex;
        inline(s.slice(i + 1, k), env, out);
        SPECIAL_RE.lastIndex = saved;
        out.push('</a>');
        SPECIAL_RE.lastIndex = m2 + 1;
        seg = m2 + 1;
        continue;
      }
      SPECIAL_RE.lastIndex = i + 1;
      continue;
    }
    SPECIAL_RE.lastIndex = i + 1;
  }
  pushEsc(out, s, seg, n);
}

/* Block-line classifiers. Each works on the line `src[i..j)` without slicing it. */

/** Whether the line is blank (spaces and tabs only). */
function isBlank(src, i, j) {
  for (let k = i; k < j; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence's language, or null: a line of three backticks and an optional language, then spaces or tabs only. */
function fenceOpen(src, i, j) {
  if (j - i < 3 || src.charCodeAt(i) !== 96 || src.charCodeAt(i + 1) !== 96 || src.charCodeAt(i + 2) !== 96) return null;
  let k = i + 3;
  while (k < j) {
    const c = src.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) k++;
    else break;
  }
  const lang = src.slice(i + 3, k);
  while (k < j) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
    k++;
  }
  return lang;
}

/** Whether the line closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(src, i, j) {
  if (j - i < 3 || src.charCodeAt(i) !== 96 || src.charCodeAt(i + 1) !== 96 || src.charCodeAt(i + 2) !== 96) return false;
  for (let k = i + 3; k < j; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(src, i, j) {
  let k = i;
  while (k < j && src.charCodeAt(k) === 35) k++;
  const depth = k - i;
  if (depth < 1 || depth > 6) return null;
  if (k >= j) return null;
  const c = src.charCodeAt(k);
  if (c !== 32 && c !== 9) return null;
  let t = k;
  while (t < j) {
    const cc = src.charCodeAt(t);
    if (cc !== 32 && cc !== 9) break;
    t++;
  }
  let e = j;
  while (e > t) {
    const cc = src.charCodeAt(e - 1);
    if (cc !== 32 && cc !== 9) break;
    e--;
  }
  if (e <= t) return null;
  return { depth, text: src.slice(t, e) };
}

/** Whether the line is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(src, i, j) {
  if (j - i < 3) return false;
  const a = src.charCodeAt(i);
  const b = src.charCodeAt(i + 1);
  const c = src.charCodeAt(i + 2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let k = i + 3; k < j; k++) {
    const cc = src.charCodeAt(k);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** Whether the line ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(src, i, j) {
  return isBlank(src, i, j) || fenceOpen(src, i, j) !== null || headingOf(src, i, j) !== null || isHr(src, i, j);
}

/** The line with spaces and tabs at either end dropped. */
function trimSlice(src, i, j) {
  while (i < j) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  while (j > i) {
    const c = src.charCodeAt(j - 1);
    if (c !== 32 && c !== 9) break;
    j--;
  }
  return src.slice(i, j);
}

/**
 * A list item's start: { ordered, start, text } for a bullet (`- `, `* `) or ordered
 * (`digits. `) line, or null. `text` is the marker's rest, trimmed.
 */
function listStart(src, i, j) {
  const c = src.charCodeAt(i);
  if ((c === 45 || c === 42) && j - i >= 2 && src.charCodeAt(i + 1) === 32) {
    return { ordered: false, start: 1, text: trimSlice(src, i + 2, j) };
  }
  if (c >= 48 && c <= 57) {
    let k = i;
    while (k < j && k - i < 9) {
      const d = src.charCodeAt(k);
      if (d < 48 || d > 57) break;
      k++;
    }
    const digits = k - i;
    if (digits >= 1 && k + 1 < j && src.charCodeAt(k) === 46 && src.charCodeAt(k + 1) === 32) {
      return { ordered: true, start: Number(src.slice(i, k)), text: trimSlice(src, k + 2, j) };
    }
  }
  return null;
}

/** Whether the line continues a list item: two or more spaces, then a non-space. */
function isContinued(src, i, j) {
  let k = i;
  while (k < j && src.charCodeAt(k) === 32) k++;
  if (k - i < 2 || k >= j) return false;
  return !isWS(src.charCodeAt(k));
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading: level, id and its inline HTML) and its
 * excerpt (the first paragraph's inline HTML, or ""). Lines are walked by index, never split
 * into an array, and blocks render straight into one chunk array.
 */
export function renderMarkdown(src, env) {
  const out = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  const n = src.length;
  let i = 0;
  while (i < n) {
    let j = src.indexOf('\n', i);
    if (j === -1) j = n;
    if (isBlank(src, i, j)) {
      i = j + 1;
      continue;
    }
    const fenceLang = fenceOpen(src, i, j);
    if (fenceLang !== null) {
      out.push('<pre><code');
      if (fenceLang !== '') {
        out.push(' class="language-');
        out.push(escapeHtml(fenceLang));
        out.push('"');
      }
      out.push('>');
      i = j + 1;
      while (i < n) {
        let k = src.indexOf('\n', i);
        if (k === -1) k = n;
        if (fenceClose(src, i, k)) {
          i = k + 1;
          break;
        }
        pushEsc(out, src, i, k);
        out.push('\n');
        i = k + 1;
      }
      out.push('</code></pre>\n');
      continue;
    }
    const hd = headingOf(src, i, j);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const tmp = [];
      inline(hd.text, env, tmp);
      const html = tmp.join('');
      out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i = j + 1;
      continue;
    }
    if (isHr(src, i, j)) {
      out.push('<hr>\n');
      i = j + 1;
      continue;
    }
    if (src.charCodeAt(i) === 62) {
      const lines = [];
      while (i < n) {
        let k = src.indexOf('\n', i);
        if (k === -1) k = n;
        if (src.charCodeAt(i) !== 62) break;
        let s = i + 1;
        if (s < k && src.charCodeAt(s) === 32) s++;
        const t = trimSlice(src, s, k);
        if (t !== '') lines.push(t);
        i = k + 1;
      }
      if (lines.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const tmp = [];
        inline(lines.join('\n'), env, tmp);
        out.push('<blockquote>\n<p>' + tmp.join('') + '</p>\n</blockquote>\n');
      }
      continue;
    }
    const first = listStart(src, i, j);
    if (first !== null) {
      const isOrdered = first.ordered;
      const items = [];
      let cur = [first.text];
      i = j + 1;
      while (i < n) {
        let k = src.indexOf('\n', i);
        if (k === -1) k = n;
        const m = listStart(src, i, k);
        if (m !== null && m.ordered === isOrdered) {
          items.push(cur);
          cur = [m.text];
          i = k + 1;
        } else if (isContinued(src, i, k)) {
          cur.push(trimSlice(src, i, k));
          i = k + 1;
        } else break;
      }
      items.push(cur);
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && first.start !== 1 ? `<ol start="${first.start}">\n` : `<${tag}>\n`);
      for (const parts of items) {
        const tmp = [];
        inline(parts.join('\n'), env, tmp);
        out.push('<li>' + tmp.join('') + '</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const lines = [trimSlice(src, i, j)];
    i = j + 1;
    while (i < n) {
      let k = src.indexOf('\n', i);
      if (k === -1) k = n;
      if (endsParagraph(src, i, k)) break;
      lines.push(trimSlice(src, i, k));
      i = k + 1;
    }
    const tmp = [];
    inline(lines.join('\n'), env, tmp);
    const html = tmp.join('');
    if (excerpt === null) excerpt = html;
    out.push('<p>' + html + '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

/* --------------------------------------------------------------- templates */

// Node kinds: 0 text, 1 var (escaped), 2 raw, 3 if, 4 for, 5 include.
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { k: -1, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ k: 0, t: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ k: tok.t === 'var' ? 1 : 2, p: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: 4, name: m[1], p: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: 3, not: m[1] !== undefined, p: pathOf(name, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.k !== 3 || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 4 : 3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === -1 ? parent.body : parent.k === 4 ? parent.body : parent.els ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ k: 5, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 4 ? 'for' : 'if'} is not closed`);
  return root.body;
}

/**
 * The value at `path` in the scope stack (innermost last): its first name from the nearest
 * scope holding it, then own properties of the value so far.
 */
function lookup(stack, path) {
  for (let s = stack.length - 1; s >= 0; s--) {
    const vars = stack[s];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into the chunk array `out`. `stack` is the scope stack (innermost last);
 * `templates` maps names to parsed nodes. A `for` pushes one vars frame per element and pops
 * it, instead of allocating a linked scope object per iteration.
 */
export function renderNodes(nodes, stack, templates, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    const k = node.k;
    if (k === 0) {
      out.push(node.t);
      continue;
    }
    if (k === 1) {
      out.push(escapeHtml(textOf(lookup(stack, node.p))));
      continue;
    }
    if (k === 2) {
      out.push(textOf(lookup(stack, node.p)));
      continue;
    }
    if (k === 3) {
      const v = truthy(lookup(stack, node.p));
      const branch = v !== node.not ? node.then : node.els;
      if (branch !== null) renderNodes(branch, stack, templates, depth, out);
      continue;
    }
    if (k === 4) {
      const xs = lookup(stack, node.p);
      if (!Array.isArray(xs)) continue;
      const len = xs.length;
      for (let idx = 0; idx < len; idx++) {
        const vars = {};
        vars[node.name] = xs[idx];
        vars.loop = { index: idx + 1, first: idx === 0, last: idx === len - 1, length: len };
        stack.push(vars);
        renderNodes(node.body, stack, templates, depth, out);
        stack.pop();
      }
      continue;
    }
    const t = templates.get(node.name);
    if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, stack, templates, depth + 1, out);
  }
}

/* ------------------------------------------------------------------- build */

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A post's card, as lists show it. Computed once per source and shared by its layout.
  const cards = new Map();
  const cardOf = (s) => {
    let card = cards.get(s);
    if (card === undefined) {
      card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cards.set(s, card);
    }
    return card;
  };

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, [{ site, tags: allTags, recent, ...vars }], templates, 0, out);
    return out.join('');
  };
  for (const s of kept) {
    const page = {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
