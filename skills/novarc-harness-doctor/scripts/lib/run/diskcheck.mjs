// The on-disk check of a fixed item (references/follow-up.md): is what an earlier review changed
// still in the harness files?
//
// The paths come from a review record, which is a file anyone can edit. So a path is only ever
// followed inside the folders that harness is made of, and "inside" is decided on real paths:
//
//   a project        its repository root, and nothing else (never the home it may sit in);
//   a user harness   its config folder; the config folder of the account it links into, when that
//                    account is in the run; and, for the default Claude account, the one file
//                    its snapshot reads outside that folder (`~/.claude.json`).
//
// The real path of the target is taken link by link (a missing file is placed through its nearest
// folder that exists). A target whose real path is outside those folders, a link that points
// nowhere, anything that is not a regular file, and a file over `MAX_CHECK_BYTES` are
// `not-checked`: nothing of them is read. The file is opened once, by its real path, and what is
// read is the handle that was checked. Only the verdict leaves this module.
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './store.mjs';
import { homeBase } from './paths.mjs';
import { maskCredentials } from './secrets.mjs';

export const MAX_CHECK_BYTES = 4 * 1024 * 1024;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const lf = (s) => s.replace(/\r\n/g, '\n');
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * The real path of `abs`, with every link in it resolved: `{ real, exists }`. A file that is not
 * there is placed through the nearest folder that is, since nothing below that can be a link.
 * null when it cannot be told: a link that points nowhere, a loop, a folder that cannot be read.
 */
export function realPathOf(abs) {
  let cur = path.resolve(abs);
  const tail = [];
  for (let depth = 0; depth < 512; depth++) {
    try {
      const real = fs.realpathSync.native(cur);
      return { real: tail.length ? path.join(real, ...tail) : real, exists: tail.length === 0 };
    } catch (e) {
      if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) return null;
      // Something is at this name and it does not resolve: a link whose target is gone.
      try { fs.lstatSync(cur); return null; } catch (e2) { if (!e2 || e2.code !== 'ENOENT') return null; }
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return null;
}

const insideDir = (dir, target) => {
  const rel = path.relative(dir, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Where the on-disk check of harness `h` (an entry of run.json) may look: `{ dirs, files }`, real
 * paths. `run` gives the account a linked one inherits from.
 */
export function checkRoots(run, h) {
  const dirs = [];
  const files = [];
  const addDir = (abs) => {
    if (typeof abs !== 'string' || !abs) return;
    const r = realPathOf(abs);
    if (r) dirs.push(r.real);
  };
  addDir(h.pathAbs);
  if (h.kind === 'user') {
    const parent = typeof h.inherits === 'string' && run && Array.isArray(run.harnesses) ? run.harnesses.find((x) => x && x.id === h.inherits && x.kind === 'user') : null;
    if (parent) addDir(parent.pathAbs);
    // The default Claude account keeps its state file beside its folder, and the snapshot reads it.
    if (h.provider === 'claude-code' && dirs.length) {
      const def = realPathOf(path.join(homeBase(), '.claude'));
      const state = def && fold(def.real) === fold(dirs[0]) ? realPathOf(path.join(homeBase(), '.claude.json')) : null;
      if (state) files.push(state.real);
    }
  }
  return { dirs, files };
}

/**
 * The absolute path a change's display path names for harness `h`, before any link is followed,
 * or null when it is not a path this harness can name: a path under the harness's own display
 * path, or relative to its root; or `~/...`, which names a file of the home and is then only
 * accepted where `checkRoots` allows. An absolute path is never taken from a record.
 */
function candidateOf(display, h) {
  if (typeof display !== 'string' || !display || typeof h.pathAbs !== 'string' || !h.pathAbs) return null;
  const p = display.replace(/\\/g, '/');
  if (p.includes('\u0000')) return null;
  if (typeof h.path === 'string' && h.path && (p === h.path || p.startsWith(`${h.path}/`))) return path.join(h.pathAbs, p.slice(h.path.length));
  if (p.startsWith('~/')) return path.join(homeBase(), p.slice(2));
  if (p.startsWith('./')) return path.join(h.pathAbs, p.slice(2));
  if (!p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.startsWith('~')) return path.join(h.pathAbs, p);
  return null;
}

/**
 * The file a change names, as far as it may be read: `{ state: 'missing' }`, `{ state: 'file',
 * buf }`, or null (`not-checked`).
 */
function readTarget(display, h, roots) {
  const candidate = candidateOf(display, h);
  if (!candidate) return null;
  const at = realPathOf(candidate);
  if (!at) return null;
  const allowed = roots.files.some((f) => fold(f) === fold(at.real)) || roots.dirs.some((d) => insideDir(d, at.real));
  if (!allowed) return null;
  if (!at.exists) return { state: 'missing' };
  let fd;
  try { fd = fs.openSync(at.real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); } catch (e) {
    return e && e.code === 'ENOENT' ? { state: 'missing' } : null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_CHECK_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (n <= 0) break;
      got += n;
    }
    return { state: 'file', buf: buf.subarray(0, got) };
  } catch { return null; } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** One change against the file on disk (the table in references/follow-up.md). */
function checkChange(c, h, roots) {
  if (!isObject(c)) return 'not-checked';
  const before = lf(str(c.before));
  const after = lf(str(c.after));
  const hasText = !!before.trim() || !!after.trim();
  const hashAfter = typeof c.hashAfter === 'string' ? c.hashAfter : null;
  if (!hasText && !hashAfter && c.deleted !== true) return 'not-checked';
  const target = readTarget(c.path, h, roots);
  if (!target) return 'not-checked';
  if (target.state === 'missing') return c.deleted === true ? 'in-place' : 'missing';
  if (c.deleted === true) return 'reverted'; // the file the change removed is back
  const buf = target.buf;
  if (hashAfter && sha256(buf) === hashAfter) return 'in-place';
  if (!hasText) return 'not-checked'; // another change may have touched the file since: no text to tell
  const raw = buf.toString('utf8');
  const text = lf(raw);
  // A record quotes a secret masked; the file holds it in full. Look in the file masked the same way too.
  const views = before.includes('…') || after.includes('…') ? [text, lf(maskCredentials(raw))] : [text];
  const holds = (needle) => views.some((v) => v.includes(needle));
  // The text before, outside any place that holds the text after (which often contains it).
  const holdsBefore = () => views.some((v) => (after.trim() ? v.split(after).join('\u0000') : v).includes(before));
  if (after.trim()) {
    if (holds(after)) return 'in-place';
    if (before.trim()) return holdsBefore() ? 'reverted' : 'changed';
    // A pure insertion that is gone: taken out again, unless the place it went into is gone too.
    const anchor = lf(str(c.insertAfter));
    return anchor.trim() && !holds(anchor) ? 'changed' : 'reverted';
  }
  return holdsBefore() ? 'reverted' : 'in-place'; // a removal
}

const CHECK_RANK = { 'not-checked': 0, 'in-place': 1, changed: 2, reverted: 3, missing: 4 };

/**
 * Is what a fixed item changed still on disk? The worst result of its changes:
 * missing > reverted > changed > in-place; `not-checked` when no change has anything to look for,
 * or names a file outside what `roots` (see `checkRoots`) allows.
 */
export function checkItem(item, h, roots = checkRoots(null, h)) {
  let worst = 'not-checked';
  for (const c of Array.isArray(item.changes) ? item.changes : []) {
    const result = checkChange(c, h, roots);
    if (CHECK_RANK[result] > CHECK_RANK[worst]) worst = result;
  }
  return worst;
}
