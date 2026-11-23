// The file list of a harness snapshot: which files are in, in which role, with their text masked
// and capped. Read-only on the harness.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { home, displayPath, statSafe, lstatSafe, realpathSafe, approxTokens } from '../common.mjs';
import { encodeProjectPath } from '../locations.mjs';
import { maskText, maskSensitiveText, isSensitiveName, scrubHome } from './mask.mjs';
import { keyOf, under } from './project.mjs';

export const FILE_CAP = 256 * 1024;
export const HARNESS_BUDGET = 3 * 1024 * 1024;
/** Files above this are never read; they are listed as `too-large`. */
export const READ_MAX = 4 * 1024 * 1024;

const LANG_BY_EXT = {
  '.md': 'markdown', '.mdx': 'markdown', '.markdown': 'markdown', '.mdc': 'markdown',
  '.json': 'json', '.jsonc': 'json', '.toml': 'toml', '.yml': 'yaml', '.yaml': 'yaml',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ps1': 'powershell', '.psm1': 'powershell',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'javascript', '.py': 'python',
};

export function langOf(file, text = '') {
  const ext = path.extname(file).toLowerCase();
  if (LANG_BY_EXT[ext]) return LANG_BY_EXT[ext];
  const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(text);
  if (shebang) {
    const prog = `${shebang[1]} ${shebang[2] || ''}`;
    if (/\b(node|deno|bun)\b/.test(prog)) return 'javascript';
    if (/\bpython[0-9.]*\b/.test(prog)) return 'python';
    if (/\b(pwsh|powershell)\b/.test(prog)) return 'powershell';
    if (/\b(ba|z|da|k)?sh\b/.test(prog)) return 'shell';
  }
  return 'text';
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Reads each file once. `load` never throws: `{ ok, text, bytes }` or `{ ok: false, reason, bytes }`. */
export class Loader {
  constructor() { this.cache = new Map(); }

  load(abs) {
    const k = keyOf(abs);
    if (this.cache.has(k)) return this.cache.get(k);
    let res;
    const st = statSafe(abs);
    if (!st || !st.isFile()) res = { ok: false, reason: 'unreadable', bytes: null };
    else if (st.size > READ_MAX) res = { ok: false, reason: 'too-large', bytes: st.size };
    else {
      try {
        const buf = fs.readFileSync(abs);
        res = isBinary(buf) ? { ok: false, reason: 'binary', bytes: st.size } : { ok: true, text: buf.toString('utf8').replace(/^﻿/, ''), bytes: st.size };
      } catch { res = { ok: false, reason: 'unreadable', bytes: st.size }; }
    }
    this.cache.set(k, res);
    return res;
  }

  /** Text of a readable text file, else null. */
  text(abs) {
    const r = this.load(abs);
    return r.ok ? r.text : null;
  }
}

/** The first `cap` bytes of a text, cut back to the end of a line when there is one nearby. */
export function cutToBytes(text, cap) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= cap) return text;
  let s = buf.subarray(0, cap).toString('utf8').replace(/�+$/, '');
  const nl = s.lastIndexOf('\n');
  if (nl > 0 && s.length - nl < 8192) s = s.slice(0, nl + 1);
  return s;
}

const LOADED_RANK = { always: 2, 'on-demand': 1, never: 0 };

export class FileSet {
  /**
   * `kind` project shows paths under `root` as `./…`; everything else under home as `~/…`.
   * `fileCap` and `budget` are byte limits for one file's content and for all content together.
   */
  constructor({ harnessId, kind, root, loader, fileCap = FILE_CAP, budget = HARNESS_BUDGET }) {
    this.harnessId = harnessId;
    this.kind = kind;
    this.root = path.resolve(root);
    this.realRoot = realpathSafe(this.root) || this.root;
    this.loader = loader;
    this.fileCap = fileCap;
    this.budget = budget;
    this.entries = new Map();
    this.displays = new Set();
    this.homeEncoded = encodeProjectPath(home());
  }

  display(abs) {
    let d = displayPath(abs, this.kind === 'project' ? this.root : undefined);
    // `projects/<encoded cwd>` names spell out the home path; show that part as `~` too.
    if (this.homeEncoded.length > 3) d = d.split('/').map((seg) => (seg.toLowerCase().startsWith(this.homeEncoded.toLowerCase()) ? `~${seg.slice(this.homeEncoded.length)}` : seg)).join('/');
    return d;
  }

  /** Display path of what `abs` links to, when it reaches its content through a link. */
  linkTarget(abs) {
    const real = realpathSafe(abs);
    if (!real) return null;
    let expected;
    if (under(abs, this.root)) expected = path.join(this.realRoot, path.relative(this.root, abs));
    else {
      const dir = path.dirname(abs);
      expected = path.join(realpathSafe(dir) || dir, path.basename(abs));
    }
    const l = lstatSafe(abs);
    if (keyOf(real) === keyOf(expected) && !(l && l.isSymbolicLink())) return null;
    return this.display(real);
  }

  /**
   * Register a file. `meta`: { category, loaded, priority }. Lower priority numbers keep their
   * content first when the budget runs out. A file registered twice keeps its most important role.
   * Returns the entry, or null when `abs` is not a file.
   */
  add(abs, meta) {
    const full = path.resolve(abs);
    const st = statSafe(full);
    if (!st || !st.isFile()) return null;
    const k = keyOf(full);
    const prev = this.entries.get(k);
    if (prev) {
      if (LOADED_RANK[meta.loaded] > LOADED_RANK[prev.loaded]) prev.loaded = meta.loaded;
      if (meta.priority < prev.priority) { prev.priority = meta.priority; prev.category = meta.category; }
      return prev;
    }
    const display = this.display(full);
    if (this.displays.has(display)) return null;
    this.displays.add(display);
    const e = { abs: full, display, category: meta.category, loaded: meta.loaded, priority: meta.priority, linkTo: this.linkTarget(full) };
    this.entries.set(k, e);
    return e;
  }

  get(abs) { return abs ? this.entries.get(keyOf(abs)) || null : null; }

  /** File id of a registered file, once `finalize` has run. */
  idOf(abs) { const e = this.get(abs); return e && e.id ? e.id : null; }

  /** Assign ids (stable: by display path) and contents (by priority, inside the budget). */
  finalize() {
    const cmp = (a, b) => (a.display < b.display ? -1 : a.display > b.display ? 1 : 0);
    const byPath = [...this.entries.values()].sort(cmp);
    const prefix = `f${createHash('sha256').update(String(this.harnessId)).digest('hex').slice(0, 6)}-`;
    byPath.forEach((e, i) => { e.id = `${prefix}${i + 1}`; });
    let remaining = this.budget;
    // Once a file does not fit, it and everything less important keep their metadata only:
    // which files carry content then depends on priority alone, never on sizes further down.
    let spent = false;
    for (const e of [...byPath].sort((a, b) => a.priority - b.priority || cmp(a, b))) {
      const r = this.loader.load(e.abs);
      e.bytes = r.bytes;
      e.content = '';
      if (!r.ok) { e.omitted = r.reason; e.lang = langOf(e.abs); continue; }
      e.lang = langOf(e.abs, r.text);
      e.tokens = approxTokens(r.text.length);
      if (spent) { e.omitted = 'budget'; continue; }
      const cut = cutToBytes(r.text, this.fileCap);
      const masked = scrubHome(isSensitiveName(e.abs) ? maskSensitiveText(cut) : maskText(cut));
      const size = Buffer.byteLength(masked, 'utf8');
      if (size > remaining) { e.omitted = 'budget'; spent = true; continue; }
      remaining -= size;
      e.content = masked;
      if (cut.length < r.text.length) e.truncated = true;
    }
    this.contentBytes = this.budget - remaining;
    return byPath.map((e) => {
      const f = { id: e.id, harness: this.harnessId, path: e.display, category: e.category, lang: e.lang, content: e.content };
      if (e.omitted) f.omitted = e.omitted;
      if (e.truncated) f.truncated = true;
      if (typeof e.bytes === 'number') f.bytes = e.bytes;
      if (typeof e.tokens === 'number') f.tokens = e.tokens;
      f.loaded = e.loaded;
      if (e.linkTo) f.linkTo = e.linkTo;
      return f;
    });
  }
}
