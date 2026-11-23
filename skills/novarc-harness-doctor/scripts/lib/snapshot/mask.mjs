// Masking for harness file text that is about to leave the machine inside a snapshot.
// Pure string work, no file system access. Every function keeps the line structure of its input,
// so a line number in the snapshot is the line number on disk.
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
 * Only the group `v` is the secret. They run after the scanner's own patterns.
 */
export const EXTRA_PATTERNS = [
  { id: 'authorization-value', re: /\bauthorization["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic|Token)\s+)?(?<v>[^\s"',;\\]{8,})/gi },
  { id: 'bearer-token', re: /\bBearer\s+(?<v>[A-Za-z0-9._~+/=-]{16,})/g },
  { id: 'url-password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'<>\\]*:(?<v>[^\s@/"'<>\\]{3,})@/gi },
  { id: 'query-secret', re: /[?&](?:api[_-]?key|apikey|key|token|access_token|auth|secret|signature|sig|password|pwd)=(?<v>[^&\s"'<>#\\]{8,})/gi },
  // "clientSecret": "value", api_key = 'value': a quoted value of any shape.
  { id: 'sensitive-key-quoted', re: new RegExp(`["']?${NAME}["']?\\s*[:=]\\s*["'](?<v>[^"'\\n]{8,})["']`, 'gi') },
  // DB_PASSWORD=value, GITHUB_TOKEN: value: upper-case names, the way environment variables are written.
  { id: 'env-assignment', re: new RegExp(`${ENV_NAME}["']?\\s*[:=]\\s*["']?(?<v>[^\\s"',;\\\\]{8,})`, 'g') },
];

const withIndices = (re) => new RegExp(re.source, re.flags.includes('d') ? re.flags : `${re.flags}d`);
const KEY_BEGIN_SRC = PATTERNS.find((p) => p.id === 'private-key').re.source;
const KEY_BEGIN = new RegExp(KEY_BEGIN_SRC);
const KEY_END = new RegExp(KEY_BEGIN_SRC.replace('BEGIN', 'END'));
const LINE_PATTERNS = [
  ...PATTERNS.filter((p) => p.id !== 'private-key').map((p) => ({ id: p.id, re: withIndices(p.re), extra: false })),
  ...EXTRA_PATTERNS.map((p) => ({ id: p.id, re: withIndices(p.re), extra: true })),
];

/** A value that names a secret instead of being one: `${VAR}`, `$VAR`, `%VAR%`, `<placeholder>`. */
function isReference(v) {
  return /^\$\{|^\$[A-Za-z_(]|^%[A-Za-z_][A-Za-z0-9_]*%$|^<[^<>]*>$|^\{\{|^\*+$|^x+$/i.test(v);
}

const isMasked = (v) => /^.{0,4}…\d+$/.test(v);
const hidden = (s) => `…${s.length}`;
/** `mask()` shows four characters: fine for a long token, too much of a short password. */
const maskValue = (v) => (v.length >= 16 ? mask(v) : hidden(v));

function maskLineOnce(line) {
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

/** Mask every secret-shaped value on one line (no newline inside). */
export function maskLine(line) {
  let cur = String(line);
  for (let i = 0; i < 5; i++) {
    const next = maskLineOnce(cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/** A line that can be part of a PEM body: one base64-ish token, a PEM header field, or blank. */
const pemBodyLine = (l) => /^\s*[A-Za-z0-9+/=_-]*\s*$/.test(l) || /^[A-Za-z-]+:\s/.test(l);

/**
 * Mask a whole text. Private key blocks lose their header, body and footer (the body without even
 * a prefix); every other line goes through maskLine. The number of lines never changes.
 */
export function maskText(text) {
  const lines = String(text).split('\n');
  let inKey = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const cr = line.endsWith('\r') ? '\r' : '';
    if (cr) line = line.slice(0, -1);
    if (inKey) {
      const end = KEY_END.exec(line);
      if (end) {
        const stop = end.index + end[0].length;
        line = hidden(line.slice(0, stop)) + maskLine(line.slice(stop));
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
        line = maskLine(line.slice(0, begin.index)) + mask(line.slice(begin.index, stop)) + maskLine(line.slice(stop));
      } else {
        line = maskLine(line.slice(0, begin.index)) + mask(rest);
        inKey = true;
      }
      lines[i] = line + cr;
      continue;
    }
    lines[i] = maskLine(line) + cr;
  }
  return lines.join('\n');
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
