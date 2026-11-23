// File-tree helpers for the accounts feature: compare, sign, copy, move and remove trees
// without ever following a link into somebody else's files.
import fs from 'node:fs';
import path from 'node:path';
import { lstatSafe, readlinkSafe, readdirSafe, sha256, mkdirp, removeLink, realpathSafe } from '../../sync-check.mjs';

const CHUNK = 1024 * 1024;

/** Byte-for-byte comparison of two regular files. */
export function sameContent(a, b) {
  let fa;
  let fb;
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    if (sa.size === 0) return true;
    fa = fs.openSync(a, 'r');
    fb = fs.openSync(b, 'r');
    const ba = Buffer.allocUnsafe(Math.min(CHUNK, sa.size));
    const bb = Buffer.allocUnsafe(ba.length);
    for (;;) {
      const na = fs.readSync(fa, ba, 0, ba.length, null);
      const nb = fs.readSync(fb, bb, 0, bb.length, null);
      if (na !== nb) return false;
      if (na === 0) return true;
      if (ba.compare(bb, 0, nb, 0, na) !== 0) return false;
    }
  } catch { return false; } finally {
    if (fa !== undefined) try { fs.closeSync(fa); } catch { /* ignore */ }
    if (fb !== undefined) try { fs.closeSync(fb); } catch { /* ignore */ }
  }
}

/**
 * Compare two trees entry by entry: 'same', 'different', or 'unknown' when the budget ran out
 * (a very large folder). Links are compared by where they point, never followed.
 */
export function compareTrees(a, b, budget = { entries: 20000, bytes: 64 * 1024 * 1024 }) {
  const left = { entries: budget.entries, bytes: budget.bytes };
  const walk = (x, y) => {
    const lx = lstatSafe(x);
    const ly = lstatSafe(y);
    if (!lx || !ly) return lx === ly ? 'same' : 'different';
    if (--left.entries < 0) return 'unknown';
    if (lx.isSymbolicLink() || ly.isSymbolicLink()) {
      if (lx.isSymbolicLink() !== ly.isSymbolicLink()) return 'different';
      return readlinkSafe(x) === readlinkSafe(y) ? 'same' : 'different';
    }
    if (lx.isDirectory() !== ly.isDirectory()) return 'different';
    if (lx.isDirectory()) {
      const nx = readdirSafe(x).map((e) => e.name).sort();
      const ny = readdirSafe(y).map((e) => e.name).sort();
      if (nx.length !== ny.length || nx.some((n, i) => n !== ny[i])) return 'different';
      let unknown = false;
      for (const n of nx) {
        const r = walk(path.join(x, n), path.join(y, n));
        if (r === 'different') return r;
        if (r === 'unknown') unknown = true;
      }
      return unknown ? 'unknown' : 'same';
    }
    if (lx.size !== ly.size) return 'different';
    left.bytes -= lx.size;
    if (left.bytes < 0) return 'unknown';
    return sameContent(x, y) ? 'same' : 'different';
  };
  return walk(a, b);
}

/**
 * A cheap signature of what is at a path, used to notice that something changed between a plan
 * and its apply: content hash for a file, link target for a link, names/sizes/times for a folder
 * (bounded, so a huge folder costs a fixed amount).
 */
export function signature(p, cap = 4000) {
  const l = lstatSafe(p);
  if (!l) return '-';
  if (l.isSymbolicLink()) return `l:${readlinkSafe(p) || ''}`;
  if (l.isFile()) {
    try { return `f:${sha256(fs.readFileSync(p))}`; } catch { return `f:${l.size}:${Math.round(l.mtimeMs)}`; }
  }
  if (!l.isDirectory()) return 'o';
  const parts = [];
  let left = cap;
  const walk = (dir, rel) => {
    for (const e of readdirSafe(dir).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
      if (--left < 0) return;
      const full = path.join(dir, e.name);
      const s = lstatSafe(full);
      if (!s) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (s.isSymbolicLink()) parts.push(`${r}>l:${readlinkSafe(full) || ''}`);
      else if (s.isDirectory()) { parts.push(`${r}/`); walk(full, r); } else parts.push(`${r}:${s.size}:${Math.round(s.mtimeMs)}`);
    }
  };
  walk(p, '');
  return `d:${sha256(parts.join('\n'))}${left < 0 ? '+' : ''}`;
}

/** Copy a file or a tree. Links are re-created as links (or, where refused, as what they hold). */
export function copyTree(src, dst) {
  const l = fs.lstatSync(src);
  if (l.isSymbolicLink()) {
    const raw = fs.readlinkSync(src);
    const st = (() => { try { return fs.statSync(src); } catch { return null; } })();
    try { fs.symlinkSync(raw, dst, st && st.isDirectory() ? 'dir' : 'file'); return; } catch (e) {
      if (!st) throw e;
      if (st.isDirectory()) { fs.symlinkSync(realpathSafe(src) || path.resolve(path.dirname(src), raw), dst, 'junction'); return; }
      fs.copyFileSync(src, dst);
      return;
    }
  }
  if (l.isDirectory()) {
    mkdirp(dst);
    for (const e of fs.readdirSync(src)) copyTree(path.join(src, e), path.join(dst, e));
    return;
  }
  mkdirp(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

/** Remove a file, a link or a tree. A link is removed as a link: its target is never touched. */
export function removeTree(p) {
  const l = lstatSafe(p);
  if (!l) return;
  if (l.isSymbolicLink() || !l.isDirectory()) { removeLink(p); return; }
  for (const e of fs.readdirSync(p)) removeTree(path.join(p, e));
  fs.rmdirSync(p);
}

/** Move a file, link or folder. Falls back to copy-verify-remove across volumes. */
export function movePath(src, dst) {
  mkdirp(path.dirname(dst));
  try { fs.renameSync(src, dst); return; } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'ENOTEMPTY') throw e;
    if (lstatSafe(dst)) throw e;
  }
  copyTree(src, dst);
  if (compareTrees(src, dst) !== 'same') {
    removeTree(dst);
    throw new Error('could not move: the copy does not match the original');
  }
  removeTree(src);
}

/** Every regular file under `root`, as paths relative to it (links are listed, not entered). */
export function listFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of readdirSafe(dir)) {
      const full = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      const s = lstatSafe(full);
      if (!s) continue;
      if (s.isDirectory() && !s.isSymbolicLink()) walk(full, r);
      else out.push(r);
    }
  };
  walk(root, '');
  return out;
}
