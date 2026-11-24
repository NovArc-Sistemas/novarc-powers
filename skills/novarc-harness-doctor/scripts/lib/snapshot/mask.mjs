// Masking for harness file text that is about to leave the machine inside a snapshot.
// Pure string work, no file system access. Every function keeps the line structure of its input,
// so a line number in the snapshot is the line number on disk.
//
// A text goes through three nets, in this order:
//   1. by key, with the structure of the file (JSON, TOML, YAML): every string under a key whose
//      name says "secret" is masked, whatever it looks like and however short it is. That covers
//      what a line cannot show: a nested object, a string with escaped quotes, a string that
//      spans lines, a table header.
//   2. by key, without structure: the same rule for `"key": "value"` and `KEY=value` wherever
//      they are written (a command, a script, a comment, a paragraph). It is all that can be
//      done for a text whose format is unknown, and it never masks what (1) decided to keep.
//   3. by shape: the scanner's fixed-prefix tokens, the credential shapes below and private key
//      blocks, line by line.
// The output is a fixed point: masking it again changes nothing, with or without the `lang`
// hint. lib/run/secrets.mjs relies on that to tell masked text from text copied off the disk.
import path from 'node:path';
import { PATTERNS, mask } from '../../secret-scan.mjs';
import { IS_WIN, home, realpathSafe } from '../common.mjs';

// A name holds a secret when one of these words is anywhere in it (`clientSecret`, `DB_PASSWORD_2`) ...
const ANYWHERE = '(?:secret|password|passwd|passphrase|credentials?)';
// ... or when it ends in one of these (`access_token`, `X-Api-Key`). Ending only: `tokens`,
// `max_tokens`, `tokenizer` and `apiKeyHelper` are settings, not secrets.
const AT_END = '(?:token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|authorization|bearer)';
const NAME = `(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9_.-]*${ANYWHERE}[A-Za-z0-9_.-]*|[A-Za-z0-9_.-]*${AT_END})`;
const ENV_NAME = `(?<![A-Za-z0-9_])(?:[A-Za-z0-9_]*${ANYWHERE.toUpperCase()}[A-Za-z0-9_]*|[A-Za-z0-9_]*(?:TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY))`;

/**
 * Credential shapes that config files carry but secret-scan.mjs has no fixed-prefix pattern for:
 * header values, URL passwords, query-string keys and assignments to a name that says "secret".
 * Only the group `v` is the secret; a group `k`, when there is one, is the name it is assigned
 * to. They run after the scanner's own patterns.
 */
export const EXTRA_PATTERNS = [
  { id: 'authorization-value', re: /\bauthorization["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic|Token)\s+)?(?<v>[^\s"',;\\]{8,})/gi },
  { id: 'bearer-token', re: /\bBearer\s+(?<v>[A-Za-z0-9._~+/=-]{16,})/g },
  { id: 'url-password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'<>\\]*:(?<v>[^\s@/"'<>\\]{3,})@/gi },
  { id: 'query-secret', re: /[?&](?:api[_-]?key|apikey|key|token|access_token|auth|secret|signature|sig|password|pwd)=(?<v>[^&\s"'<>#\\]{8,})/gi },
  // "clientSecret": "value", api_key = 'value': a quoted value of any shape.
  { id: 'sensitive-key-quoted', re: new RegExp(`["']?(?<k>${NAME})["']?\\s*[:=]\\s*(?<q>["'])(?<v>[^"'\\n]{8,})\\k<q>`, 'gi') },
  // DB_PASSWORD=value, GITHUB_TOKEN: value: upper-case names, the way environment variables are written.
  { id: 'env-assignment', re: new RegExp(`(?<k>${ENV_NAME})["']?\\s*[:=]\\s*["']?(?<v>[^\\s"',;\\\\]{8,})`, 'g') },
];

// ---------------------------------------------------------------------------------------------
// Which names hold a secret
// ---------------------------------------------------------------------------------------------

// The last word of a name, when it is one of these, says the name describes a secret instead of
// holding one: `secret-scan`, `password_min_length`, `tokenUrl`, `credentialsFile`,
// `bearer_token_env_var`, `apiKeyHelper`. The last row is products and kinds of thing that are
// named after what they keep.
const DESCRIPTORS = new Set([
  'scan', 'scans', 'scanner', 'scanning', 'check', 'checker', 'detect', 'detector', 'lint', 'mask', 'masked', 'redact', 'redacted',
  'policy', 'policies', 'rule', 'rules', 'pattern', 'patterns', 'regex', 'length', 'len', 'min', 'max', 'count', 'limit', 'limits',
  'budget', 'size', 'bytes', 'chars', 'ttl', 'expiry', 'expires', 'expiration', 'lifetime', 'rotation', 'interval', 'timeout',
  'hint', 'prompt', 'label', 'title', 'description', 'placeholder', 'message', 'error', 'status', 'state', 'strength',
  'name', 'names', 'field', 'fields', 'url', 'uri', 'endpoint', 'host', 'path', 'paths', 'file', 'files', 'filename', 'dir',
  'directory', 'folder', 'location', 'env', 'var', 'variable', 'type', 'kind', 'mode', 'format', 'version', 'algorithm', 'alg', 'scheme',
  'enabled', 'disabled', 'required', 'optional', 'exists', 'present', 'configured', 'valid',
  'helper', 'command', 'cmd', 'script', 'provider', 'manager', 'store', 'vault', 'source', 'backend', 'ref', 'reference',
  'server', 'servers', 'plugin', 'cli', 'tool', 'tools', '1password', 'onepassword',
]);
const END_WORD = /(?:secrets?|passwords?|passwd|passphrase|credentials?|token|api_?keys?|private_?keys?|access_?keys?|secret_?keys?|authorization|bearer)(?:_?\d+)?$/;
// `tokens` alone counts things (`max_tokens`); behind one of these words it is a list of credentials.
const TOKEN_LIST = /(?:^|_)(?:access|refresh|auth|api|bearer|session|oauth|personal|bot|deploy|registry)_?tokens$/;
const ANY_WORD = /secret|password|passwd|passphrase|credential/;
// Every name the three patterns above can accept has one of these in it, however it is spelled.
const MAYBE_SECRET = /secret|passw|passphrase|credential|token|key|authorization|bearer/i;
const KEY_MEMO = new Map();

/** The words of a name in any spelling: `X-Api-Key`, `clientSecret`, `DB_PASSWORD_2`. */
function keyWords(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * True when a key, variable or flag of this name holds a secret: the name ends in one of the
 * secret words (`password`, `client_secret`, `access_token`, `X-Api-Key`) or has `secret`,
 * `password` or `credential` anywhere in it, unless its last word says it only describes one.
 */
export function isSensitiveKey(name) {
  const key = String(name);
  if (!MAYBE_SECRET.test(key)) return false; // most names: decided without taking them apart
  let known = KEY_MEMO.get(key);
  if (known === undefined) {
    const words = keyWords(key);
    const norm = words.join('_');
    known = words.length > 0 && words.length <= 16 && !DESCRIPTORS.has(words[words.length - 1])
      && (END_WORD.test(norm) || TOKEN_LIST.test(norm) || ANY_WORD.test(norm));
    if (KEY_MEMO.size >= 4096) KEY_MEMO.clear();
    KEY_MEMO.set(key, known);
  }
  return known;
}

// ---------------------------------------------------------------------------------------------
// What a masked value looks like
// ---------------------------------------------------------------------------------------------

/**
 * A value that names a secret instead of being one: `${VAR}`, `$VAR`, `$(command)`, `%VAR%`,
 * `<placeholder>`, and the ways a script reads its environment (`process.env.X`, `os.environ[...]`).
 */
function isReference(v) {
  return /^\$\{|^\$\(|^\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*(?:$|[\\/:.[\]\s])|^\$[0-9@*#?!$-]$|^%[A-Za-z_][A-Za-z0-9_]*%$|^<[^<>]*>$|^\{\{|^\*+$|^x+$|^\.{2,}$/i.test(v)
    || /^(?:process\.env\b|import\.meta\.env\b|os\.environ\b|os\.getenv\(|getenv\(|System\.getenv\(|ENV\[)/.test(v);
}

// The word in front of a credential in a header value stays readable.
const SCHEME_RE = /^(?:Bearer|Basic|Token|Digest|Negotiate|ApiKey)\s+/i;
// What this module writes (`abcd…40`, `…7`), and the same written by hand without the length.
const isMasked = (v) => /^.{0,4}…\d*$/.test(v.replace(SCHEME_RE, ''));
const hidden = (s) => `…${s.length}`;
/** `mask()` shows four characters: fine for a long token, too much of a short password. */
const maskValue = (v) => (v.length >= 16 ? mask(v) : hidden(v));
// An unquoted value that switches something on or off, or names a mode, is not a secret.
const PLAIN_WORD = /^(?:true|false|yes|no|on|off|null|none|nil|undefined|~|0|1|inherit|read|write|required|optional|enabled|disabled|always|never|auto|default)$/i;

/** What replaces the value of a secret key, or null when there is nothing to hide in it. */
function secretText(raw) {
  const head = (SCHEME_RE.exec(raw) || [''])[0];
  const v = raw.slice(head.length);
  if (!v.trim() || isMasked(v) || isReference(v)) return null;
  // Four characters that end inside an escape sequence would leave half of it behind.
  return head + (v.slice(0, 4).includes('\\') ? hidden(v) : maskValue(v));
}

/** Mask `text[s, e)`, the value of a secret key on one line. */
function pushValue(st, text, s, e) {
  if (e <= s) return;
  const r = secretText(text.slice(s, e));
  if (r !== null) st.spans.push([s, e, r]);
}

/** Mask `text[s, e)`, a value that spans lines: each line keeps its place and shows only its length. */
function pushLines(st, text, s, e) {
  let i = s;
  while (i < e) {
    let nl = text.indexOf('\n', i);
    if (nl === -1 || nl > e) nl = e;
    const end = nl > i && text[nl - 1] === '\r' ? nl - 1 : nl;
    const seg = text.slice(i, end);
    if (seg.trim() && !isMasked(seg.trim())) st.spans.push([i, end, hidden(seg)]);
    i = nl + 1;
  }
}

function applySpans(text, spans) {
  if (!spans.length) return text;
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let pos = 0;
  for (const [s, e, r] of spans) {
    if (s < pos) continue; // inside a value that is already masked as a whole
    out += text.slice(pos, s) + r;
    pos = e;
  }
  return out + text.slice(pos);
}

// ---------------------------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------------------------

const lineEnd = (text, i) => { const k = text.indexOf('\n', i); return k === -1 ? text.length : k; };

/**
 * How deep a quote is nested, from the number of backslashes in front of it: `"` is a quote of the
 * text itself (0), `\"` a quote of a text kept inside a string (1), `\\\"` one level further in
 * (2). An even run is escaped backslashes followed by a quote of the outer text, so `\\"` is 0.
 */
function quoteDepth(backslashes) {
  let n = 0;
  for (let b = backslashes; b & 1; b >>= 1) n++;
  return n;
}

/**
 * The end of the string opened by the quote at `q`, which has `k` backslashes in front of it.
 * Returns [end of the content, index after the closing quote, closed]. A string never runs past
 * its line; one that is not closed there, or whose enclosing string ends first, is `closed: false`.
 * `escapes: false` is a string where a backslash is a plain character (TOML '...').
 */
function stringEnd(text, q, k, escapes = true) {
  const ch = text[q];
  const depth = quoteDepth(k);
  let i = q + 1;
  for (;;) {
    const c = text[i];
    if (c === undefined || c === '\n') {
      const end = c === '\n' && text[i - 1] === '\r' && i - 1 > q ? i - 1 : i;
      return [end, end, false];
    }
    if (c === '\\' && escapes) {
      let b = 1;
      while (text[i + b] === '\\') b++;
      if (text[i + b] !== ch) { i += b; continue; }
      const d = quoteDepth(b);
      if (d > depth) { i += b + 1; continue; } // a quote of a text nested further in: content
      // The last backslashes of the run belong to the quote; the ones before them are content.
      const end = i + b - ((1 << d) - 1);
      return d === depth ? [end, i + b + 1, true] : [end, end, false];
    }
    if (c === ch) return depth === 0 ? [i, i + 1, true] : [i, i, false];
    i++;
  }
}

/** Index of the `"""` or `'''` that closes a multi-line string whose content starts at `from`, or -1. */
function tripleEnd(text, from, delim) {
  let i = from;
  for (;;) {
    i = text.indexOf(delim, i);
    if (i === -1 || delim === "'''") return i;
    let b = 0;
    while (text[i - 1 - b] === '\\') b++;
    if (b % 2 === 0) return i;
    i++;
  }
}

// ---------------------------------------------------------------------------------------------
// Net 1: by key, with the structure of the file
// ---------------------------------------------------------------------------------------------

/**
 * JSON, read leniently (comments, trailing commas, a file cut at the size cap): every string
 * value under a secret key, at any depth below it. Keys are never masked.
 */
function jsonSpans(text, st) {
  const frames = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    const top = frames.length ? frames[frames.length - 1] : null;
    if (c === '"') {
      const [end, after, closed] = stringEnd(text, i, 0);
      if (top && top.obj && closed && /^\s*:/.test(text.slice(after, after + 64))) top.secret = isSensitiveKey(text.slice(i + 1, end));
      else if (top && (top.all || top.secret)) pushValue(st, text, i + 1, end);
      i = Math.max(after, i + 1);
    } else if (c === '{' || c === '[') {
      frames.push({ obj: c === '{', secret: false, all: !!top && (top.all || top.secret) });
      i++;
    } else if (c === '}' || c === ']') {
      frames.pop();
      i++;
    } else if (c === ',') {
      if (top && top.obj) top.secret = false;
      i++;
    } else if (c === '/' && text[i + 1] === '/') i = lineEnd(text, i);
    else if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; } else i++;
  }
}

/**
 * TOML: every string under a secret key, in any of the four string forms (basic, literal and
 * their multi-line `"""` / `'''` variants), inside arrays and inline tables, and every string of
 * a table whose header has a secret segment (`[servers.x.credentials]`).
 */
function tomlSpans(text, st) {
  const n = text.length;
  const spaces = (j) => { while (text[j] === ' ' || text[j] === '\t') j++; return j; };
  // Spaces, line ends and comments: what may sit between the items of an array.
  const blank = (j) => {
    for (;;) {
      const c = text[j];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') j++;
      else if (c === '#') j = lineEnd(text, j);
      else return j;
    }
  };
  /** Segments of a (dotted) key from `j` up to one of the characters in `stop`. */
  const key = (j, stop) => {
    const segs = [];
    for (;;) {
      j = spaces(j);
      const c = text[j];
      if (c === '"' || c === "'") {
        const [end, after, closed] = stringEnd(text, j, 0, c === '"');
        if (!closed) return null;
        segs.push(text.slice(j + 1, end));
        j = after;
      } else {
        const m = /^[A-Za-z0-9_-]+/.exec(text.slice(j, j + 256));
        if (!m) return null;
        segs.push(m[0]);
        j += m[0].length;
      }
      j = spaces(j);
      if (text[j] === '.') { j++; continue; }
      return text[j] !== undefined && stop.includes(text[j]) ? { segs, end: j } : null;
    }
  };
  const secretKey = (segs) => segs.some((s) => isSensitiveKey(s)) || isSensitiveKey(segs.join('.'));
  /** Reads the value at `j`; returns the index after it. */
  const value = (j, secret) => {
    j = spaces(j);
    const three = text.slice(j, j + 3);
    if (three === '"""' || three === "'''") {
      const close = tripleEnd(text, j + 3, three);
      if (secret) pushLines(st, text, j + 3, close === -1 ? n : close);
      return close === -1 ? n : close + 3;
    }
    const c = text[j];
    if (c === '"' || c === "'") {
      const [end, after] = stringEnd(text, j, 0, c === '"');
      if (secret) pushValue(st, text, j + 1, end);
      return Math.max(after, j + 1);
    }
    if (c === '[' || c === '{') {
      const close = c === '[' ? ']' : '}';
      j++;
      for (;;) {
        j = blank(j);
        if (j >= n) return n;
        if (text[j] === close) return j + 1;
        if (text[j] === ',') { j++; continue; }
        let next;
        if (c === '[') next = value(j, secret);
        else {
          const k = key(j, '=');
          next = k ? value(k.end + 1, secret || secretKey(k.segs)) : j + 1;
        }
        j = next > j ? next : j + 1;
      }
    }
    while (j < n && !',]}#\n'.includes(text[j])) j++; // a number, a boolean, a date
    return j;
  };

  let table = false;
  let i = 0;
  while (i < n) {
    const j = spaces(i);
    const c = text[j];
    if (c === undefined) break;
    if (c === '[') {
      const k = key(text[j + 1] === '[' ? j + 2 : j + 1, ']');
      if (k) table = secretKey(k.segs);
      i = lineEnd(text, j) + 1;
      continue;
    }
    const k = c === '#' || c === '\n' || c === '\r' ? null : key(j, '=');
    i = lineEnd(text, k ? Math.max(value(k.end + 1, table || secretKey(k.segs)), k.end + 1) : j) + 1;
  }
}

/**
 * YAML, the two forms the keyless net cannot see: an unquoted scalar (`password: hunter2`) and a
 * block scalar (`key: |` followed by indented lines). Quoted values and `{ }` / `[ ]` values are
 * the next net's. A mapping nested under a secret key is not followed: in a workflow the key of
 * such a mapping is as often the name of a job.
 */
function yamlSpans(text, st) {
  const n = text.length;
  let block = -1; // indentation of the secret key whose block scalar is being read, or -1
  let i = 0;
  while (i < n) {
    const nl = lineEnd(text, i);
    const end = nl > i && text[nl - 1] === '\r' ? nl - 1 : nl;
    const line = text.slice(i, end);
    const start = i;
    i = nl + 1;
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (block >= 0) {
      if (indent > block) {
        const seg = line.slice(indent);
        if (!isMasked(seg)) st.spans.push([start + indent, end, hidden(seg)]);
        continue;
      }
      block = -1;
    }
    const m = /^(\s*(?:-\s+)*)(["']?)([A-Za-z_$][A-Za-z0-9_.$-]*)\2\s*:(?:\s+(.*))?$/.exec(line);
    if (!m || !isSensitiveKey(m[3])) continue;
    const v = m[4] === undefined ? '' : m[4];
    if (/^[|>][0-9+-]*\s*(?:#.*)?$/.test(v)) { block = m[1].length; continue; }
    if (!v || /^["'`{[&*!|>#]/.test(v)) continue;
    const bare = v.replace(/\s+#.*$/, '').trimEnd();
    if (!bare || PLAIN_WORD.test(bare)) continue;
    pushValue(st, text, end - v.length, end - v.length + bare.length);
  }
}

const STRUCTURE = { json: jsonSpans, toml: tomlSpans, yaml: yamlSpans };

/** A text with no `lang` hint that parses as a JSON object or array. */
function looksLikeJson(text) {
  const first = /\S/.exec(text);
  if (!first || (first[0] !== '{' && first[0] !== '[')) return false;
  try { const v = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); return v !== null && typeof v === 'object'; } catch { return false; }
}

// ---------------------------------------------------------------------------------------------
// Net 2: by key, wherever `key: value` or `KEY=value` is written
// ---------------------------------------------------------------------------------------------

// `DB_PASSWORD`, `$API_KEY`: the way environment variables are written.
const ENV_LIKE = /^\$?[A-Z][A-Z0-9_]*$/;
// A bracket of running text that nothing closes must not take the rest of the file with it,
// and a text full of such brackets is not read again from each of them.
const CONTAINER_MAX = 32 * 1024;
const UNCLOSED_MAX = 16;
/** A template literal that is put together at run time (`Bearer ${token}`) holds no secret of its own. */
const computedTemplate = (text, quote, s, e) => quote === '`' && text.slice(s, e).includes('${');

/**
 * Mask every string value between the bracket at `open` and the one that closes it, strings of
 * nested brackets included. A string followed by `:` or `=` is a key and stays. The bracket may
 * close on a later line only when it ends its own line, the way data is laid out: `"secrets": {`
 * inside a string of some other language (`'  "secrets": {',`) is followed by that language's
 * quotes, which must not be paired up as values. Returns the index after the closing bracket, or
 * the one after the opening bracket when nothing closes it.
 */
function containerSpans(text, open, st) {
  const found = [];
  const eol = lineEnd(text, open);
  const mayRun = st.unclosed < UNCLOSED_MAX && /^[ \t]*(?:(?:#|\/\/).*)?\r?$/.test(text.slice(open + 1, eol));
  const stop = mayRun ? Math.min(text.length, open + CONTAINER_MAX) : eol;
  const js = st.lang === 'javascript';
  let depth = 0;
  let closed = false;
  let i = open;
  while (i < stop) {
    const c = text[i];
    if (c === '{' || c === '[') { depth++; i++; continue; }
    if (c === '}' || c === ']') { depth--; i++; if (depth <= 0) { closed = true; break; } continue; }
    if (c === '#') {
      if (!js && st.lang !== 'json' && (i === 0 || /\s/.test(text[i - 1]))) i = lineEnd(text, i); else i++;
      continue;
    }
    if (c === '/') {
      if (text[i + 1] === '/') i = lineEnd(text, i);
      else if (text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e === -1 ? stop : e + 2; } else i++;
      continue;
    }
    if (c !== '"' && c !== "'" && c !== '\\' && c !== '`') { i++; continue; }
    if (c !== '\\' && c !== '`' && text[i + 1] === c && text[i + 2] === c) {
      const e = tripleEnd(text, i + 3, c + c + c);
      found.push([true, i + 3, e === -1 ? text.length : e]);
      i = e === -1 ? text.length : e + 3;
      continue;
    }
    let k = 0;
    while (text[i + k] === '\\') k++;
    const q = text[i + k];
    if (q === '"' || q === "'" || (q === '`' && js)) {
      const [end, after, ok] = stringEnd(text, i + k, k, !(st.lang === 'toml' && q === "'"));
      const isKey = ok && /^[ \t]*(?:=>|:|=)/.test(text.slice(after, after + 16));
      if (!isKey && !computedTemplate(text, q, i + k + 1, end)) found.push([false, i + k + 1, end]);
      i = Math.max(after, i + k + 1);
      continue;
    }
    i += k || 1;
  }
  // A bracket nothing closes is running text, not data: what follows it is read as usual.
  if (!closed) {
    if (mayRun) st.unclosed++;
    return open + 1;
  }
  for (const [lines, s, e] of found) {
    if (lines) pushLines(st, text, s, e);
    else pushValue(st, text, s, e);
  }
  return i;
}

// `X-Api-Key`, `Private-Token`, `Authorization`: the way a header is named.
const HEADER_LIKE = /^(?:[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+|authorization)$/i;

/**
 * The value that follows a secret name at `p`. `opener` is the quote right in front of a bare
 * name, when there is one. Returns the index after what was read.
 */
function valueSpans(text, p, st, { name, quotedKey, tight, sep, opener }) {
  let i = p;
  const prefix = /^[rRbBfFuU]{1,2}(?=["'])/.exec(text.slice(i, i + 3)); // r"...", b'...'
  if (prefix) i += prefix[0].length;
  const three = text.slice(i, i + 3);
  if (three === '"""' || three === "'''") {
    const close = tripleEnd(text, i + 3, three);
    pushLines(st, text, i + 3, close === -1 ? text.length : close);
    return close === -1 ? text.length : close + 3;
  }
  let k = 0;
  while (text[i + k] === '\\') k++;
  const q = text[i + k];
  if (q === '"' || q === "'" || (q === '`' && st.lang === 'javascript')) {
    const [end, after, closed] = stringEnd(text, i + k, k, !(st.lang === 'toml' && q === "'"));
    // After a bare name the quote may be the one that closes the string the name is written in
    // (`"header": "Authorization: ", "next": ...`): what follows is then not a value.
    if (!quotedKey && (!closed || /[A-Za-z0-9_]/.test(text[after] || ''))) return p;
    if (!computedTemplate(text, q, i + k + 1, end)) pushValue(st, text, i + k + 1, end);
    return Math.max(after, i + k + 1);
  }
  if (k === 0 && (q === '{' || q === '[')) return containerSpans(text, i, st);
  // Unquoted, only where the value cannot be running text: `DB_PASSWORD=value`, `--token=value`.
  if (!quotedKey && tight && sep === '=' && (ENV_LIKE.test(name) || name.startsWith('-'))) {
    const v = /^[^\s"'`,;\\]+/.exec(text.slice(i, i + 4096));
    if (!v) return p;
    if (!PLAIN_WORD.test(v[0])) pushValue(st, text, i, i + v[0].length);
    return i + v[0].length;
  }
  // ... and a header written inside a string: `-H "X-Api-Key: value"`, up to the closing quote.
  if (!quotedKey && opener && sep === ':' && HEADER_LIKE.test(name)) {
    const close = text.indexOf(opener, i);
    if (close === -1 || close > lineEnd(text, i)) return p;
    const v = text.slice(i, close).replace(/\\+$/, '');
    if (!/^\S+$/.test(v.replace(SCHEME_RE, '')) || PLAIN_WORD.test(v)) return p; // one word: a sentence is not a credential
    pushValue(st, text, i, i + v.length);
    return i + v.length;
  }
  return p;
}

const isNameChar = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 36 || c === 45; // [A-Za-z0-9_.$-]
const NAME_MAX = 120;

/**
 * The name in front of the separator at `c`, read backwards, no further than `floor`: a quoted
 * name (the quotes escaped or not, the way JSON kept inside a string writes them; no space in
 * it, since with one it is as often the first branch of `cond ? 'some text' : 'other'`) or a
 * bare one (`[A-Za-z_$]` first, after up to two dashes of a command line flag). A name never
 * starts in the middle of a word. Returns { name, start, quoted, spaced } or null.
 */
function nameBefore(text, c, floor) {
  let e = c;
  while (e > floor && (text[e - 1] === ' ' || text[e - 1] === '\t')) e--;
  const spaced = e < c;
  if (e <= floor) return null;
  const q = text[e - 1];
  if (q === '"' || q === "'") {
    let k = 0;
    while (text[e - 2 - k] === '\\') k++;
    const close = e - 1 - k;
    let s = close;
    while (s > floor && close - s <= NAME_MAX) {
      const ch = text[s - 1];
      if (ch === '"' || ch === "'" || ch === '\\' || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') break;
      s--;
    }
    if (s === close || s - 1 < floor || text[s - 1] !== q) return null;
    let kb = 0;
    while (text[s - 2 - kb] === '\\') kb++;
    const start = s - 1 - k;
    if (kb < k || start < floor || (kb === k && start > 0 && isNameChar(text.charCodeAt(start - 1)))) return null;
    return { name: text.slice(s, close), start, quoted: true, spaced };
  }
  let s = e;
  while (s > floor && e - s <= NAME_MAX + 2 && isNameChar(text.charCodeAt(s - 1))) s--;
  if (s === e || (s > 0 && isNameChar(text.charCodeAt(s - 1))) || !/^-{0,2}[A-Za-z_$]/.test(text.slice(s, s + 3))) return null;
  return { name: text.slice(s, e), start: s, quoted: false, spaced };
}

/**
 * `text` with the value of every secret name masked, read without any knowledge of its format:
 * a name followed by `:`, `=`, `:=` or `=>` and by a value. The text is walked from one separator
 * to the next, and the name is looked for only in front of one.
 */
function maskByKey(text, lang) {
  const st = { spans: [], lang, unclosed: 0 };
  const n = text.length;
  let i = 0; // nothing before `i` is read again
  for (;;) {
    let c = i;
    for (; c < n; c++) { const ch = text.charCodeAt(c); if (ch === 58 || ch === 61) break; } // `:` or `=`
    if (c >= n) break;
    let sep;
    if (text[c] === ':') {
      if (text[c + 1] === ':') { i = c + 2; continue; } // `a::b` names something, it assigns nothing
      sep = text[c + 1] === '=' ? ':=' : ':';
    } else {
      let run = 1;
      while (text[c + run] === '=') run++;
      if (run > 3) { i = c + run; continue; } // a ruler
      sep = run === 1 && text[c + 1] === '>' ? '=>' : '='.repeat(run);
    }
    const after = c + sep.length;
    const key = nameBefore(text, c, i);
    if (!key || !isSensitiveKey(key.name)) { i = after; continue; }
    let p = after;
    while (text[p] === ' ' || text[p] === '\t') p++;
    const before = text[key.start - 1];
    const next = valueSpans(text, p, st, {
      name: key.name, quotedKey: key.quoted, tight: !key.spaced && p === after, sep, opener: !key.quoted && (before === '"' || before === "'") ? before : null,
    });
    i = Math.max(next, p);
  }
  return applySpans(text, st.spans);
}

// ---------------------------------------------------------------------------------------------
// Net 3: by shape
// ---------------------------------------------------------------------------------------------

const withIndices = (re) => new RegExp(re.source, re.flags.includes('d') ? re.flags : `${re.flags}d`);
const KEY_BEGIN_SRC = PATTERNS.find((p) => p.id === 'private-key').re.source;
const KEY_BEGIN = new RegExp(KEY_BEGIN_SRC);
const KEY_END = new RegExp(KEY_BEGIN_SRC.replace('BEGIN', 'END'));
const LINE_PATTERNS = [
  ...PATTERNS.filter((p) => p.id !== 'private-key').map((p) => ({ id: p.id, re: withIndices(p.re), extra: false })),
  ...EXTRA_PATTERNS.map((p) => ({ id: p.id, re: withIndices(p.re), extra: true })),
];

function shapeLineOnce(line) {
  const taken = [];
  const spans = [];
  for (const p of LINE_PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(line)) !== null) {
      if (m[0].length === 0) { p.re.lastIndex++; continue; }
      const a = m.index;
      const b = m.index + m[0].length;
      if (taken.some(([x, y]) => a < y && b > x)) continue;
      // `secret-scan`, `password_min_length`: a name that describes a secret holds none.
      if (p.extra && m.groups && m.groups.k !== undefined && !isSensitiveKey(m.groups.k)) continue;
      const g = m.indices && m.indices.groups && m.indices.groups.v ? m.indices.groups.v : m.indices[0];
      const value = line.slice(g[0], g[1]);
      if (isMasked(value) || (p.extra && isReference(value))) continue;
      taken.push([a, b]);
      spans.push([g[0], g[1], maskValue(value)]);
    }
  }
  if (!spans.length) return line;
  spans.sort((x, y) => x[0] - y[0]);
  let out = '';
  let pos = 0;
  for (const [s, e, r] of spans) { out += line.slice(pos, s) + r; pos = e; }
  return out + line.slice(pos);
}

/** Every secret-shaped value of one line. */
function shapeLine(line) {
  let cur = line;
  for (let i = 0; i < 5; i++) {
    const next = shapeLineOnce(cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/** Mask every secret on one line (no newline inside): by the name it is assigned to, then by its shape. */
export function maskLine(line) {
  return shapeLine(maskByKey(String(line), null));
}

/** A line that can be part of a PEM body: one base64-ish token, a PEM header field, or blank. */
const pemBodyLine = (l) => /^\s*[A-Za-z0-9+/=_-]*\s*$/.test(l) || /^[A-Za-z-]+:\s/.test(l);

/**
 * Private key blocks lose their header, body and footer (the body without even a prefix); every
 * other line goes through the shape patterns.
 */
function maskByShape(text) {
  const lines = text.split('\n');
  let inKey = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const cr = line.endsWith('\r') ? '\r' : '';
    if (cr) line = line.slice(0, -1);
    if (inKey) {
      const end = KEY_END.exec(line);
      if (end) {
        const stop = end.index + end[0].length;
        line = hidden(line.slice(0, stop)) + shapeLine(line.slice(stop));
        inKey = false;
      } else if (pemBodyLine(line)) {
        line = line.trim() ? hidden(line) : line;
      } else {
        inKey = false; // prose after a mention of the marker, not key material
        i--;
        continue;
      }
      lines[i] = line + cr;
      continue;
    }
    const begin = KEY_BEGIN.exec(line);
    if (begin) {
      const rest = line.slice(begin.index);
      const end = KEY_END.exec(rest);
      if (end) {
        const stop = begin.index + end.index + end[0].length;
        line = shapeLine(line.slice(0, begin.index)) + mask(line.slice(begin.index, stop)) + shapeLine(line.slice(stop));
      } else {
        line = shapeLine(line.slice(0, begin.index)) + mask(rest);
        inKey = true;
      }
      lines[i] = line + cr;
      continue;
    }
    lines[i] = shapeLine(line) + cr;
  }
  return lines.join('\n');
}

/**
 * Mask a whole text. `lang` is what files.mjs calls the file's language (`json`, `toml`, `yaml`,
 * `javascript`, ...): it selects the structure the text is read with. Without it a text that
 * parses as JSON is read as JSON and anything else as running text. The number of lines never
 * changes.
 */
export function maskText(text, { lang = null } = {}) {
  let cur = String(text);
  const structure = Object.hasOwn(STRUCTURE, lang || '') ? lang : ((lang === null || lang === 'text') && looksLikeJson(cur) ? 'json' : null);
  if (structure) {
    const st = { spans: [], lang: structure };
    STRUCTURE[structure](cur, st);
    cur = applySpans(cur, st.spans);
  }
  return maskByShape(maskByKey(cur, structure || lang));
}

const SENSITIVE_NAMES = [
  /^\.env(\..+)?$/i, /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.?credentials(\.[a-z]+)?$/i, /^\.credentials\.json/i, /^auth\.json$/i, /^\.npmrc$/i, /^\.netrc$/i, /^\.pypirc$/i,
  /^\.claude\.json$/i, /(^|[._-])secrets?\.(json|ya?ml|toml|env|txt)$/i,
];

/** Files whose every value is treated as a secret, whatever its shape. */
export function isSensitiveName(file) {
  const base = path.basename(String(file));
  return SENSITIVE_NAMES.some((re) => re.test(base));
}

/**
 * For a file that exists to hold credentials: keep comments and the names on the left of an
 * assignment, replace every value and every other line by its length.
 */
export function maskSensitiveText(text) {
  return String(text).split('\n').map((raw) => {
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    if (!line.trim() || /^\s*(#|\/\/|;)/.test(line)) return maskLine(line) + cr;
    const kv = /^(\s*(?:export\s+)?["']?[A-Za-z_][A-Za-z0-9_.-]*["']?\s*[=:]\s*)(.*)$/.exec(line);
    if (kv) return kv[1] + (kv[2].trim() ? hidden(kv[2]) : kv[2]) + cr;
    return hidden(line) + cr;
  }).join('\n');
}

let homeRegexes = null;

function buildHomeRegexes() {
  const set = new Set();
  const add = (p) => {
    if (!p || p.length < 3) return;
    set.add(p);
    set.add(p.replace(/\\/g, '/'));
    set.add(p.replace(/\\/g, '\\\\')); // as written inside a JSON string
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
    if (m) {
      const rest = m[2].replace(/\\/g, '/');
      set.add(`/${m[1].toLowerCase()}/${rest}`); // Git Bash
      set.add(`/mnt/${m[1].toLowerCase()}/${rest}`); // WSL
    }
  };
  const h = home();
  add(h);
  add(realpathSafe(h));
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...set].sort((a, b) => b.length - a.length)
    .map((v) => new RegExp(`(?<![A-Za-z0-9_.~-])${esc(v)}(?![A-Za-z0-9_-])`, IS_WIN ? 'gi' : 'g'));
}

/** Replace the home directory, in every spelling a config file uses, by `~`. */
export function scrubHome(text) {
  if (typeof text !== 'string' || !text) return text;
  if (!homeRegexes) homeRegexes = buildHomeRegexes();
  let s = text;
  for (const re of homeRegexes) s = s.replace(re, '~');
  return s;
}

/** One-line, masked, home-scrubbed, capped form of a short text (a command, a description, a rule). */
export function inline(text, max = 300) {
  const s = scrubHome(maskText(String(text ?? ''))).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
