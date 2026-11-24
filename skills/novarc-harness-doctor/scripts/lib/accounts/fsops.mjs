// File-tree helpers for the accounts feature: compare, sign, copy, move and remove trees
// without ever following a link into somebody else's files.
import fs from 'node:fs';
import path from 'node:path';
import { lstatSafe, statSafe, readlinkSafe, readdirSafe, sha256, mkdirp, removeLink, realpathSafe, pathKey } from '../../sync-check.mjs';

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
 * A signature of what is at a path AND of what it holds, used to notice that something changed
 * between a plan and its apply:
 *   file     the hash of its content
 *   link     where it points (the link text) and, signed by these same rules, what it resolves
 *            to: content edited behind a link is a change, although the link itself is the same
 *   folder   a hash over every entry: its name and its own signature, links included
 * Bounded, so a huge folder costs a fixed amount: past `cap` entries the rest is left out, past
 * `bytes` of content a file is signed by size and time instead, and the signature then ends in
 * `+`. A link that leads back into a folder being walked is signed as `loop`, not followed.
 */
export function signature(p, { cap = 4000, bytes = 64 * 1024 * 1024 } = {}) {
  const left = { entries: cap, bytes };
  let cut = false;
  const open = new Set(); // the folders being walked
  const at = (real, st) => {
    if (st.isFile()) {
      if (st.size <= left.bytes) {
        try { const buf = fs.readFileSync(real); left.bytes -= buf.length; return `f:${sha256(buf)}`; } catch { /* unreadable: by size and time */ }
      }
      cut = true;
      return `f:${st.size}:${Math.round(st.mtimeMs)}`;
    }
    if (!st.isDirectory()) return 'o';
    const key = pathKey(real);
    if (open.has(key)) return 'loop';
    open.add(key);
    const parts = [];
    for (const name of readdirSafe(real).map((e) => e.name).sort()) {
      if (--left.entries < 0) { cut = true; break; }
      parts.push(`${name}\0${any(path.join(real, name))}`);
    }
    open.delete(key);
    return `d:${sha256(parts.join('\0'))}`;
  };
  const any = (q) => {
    const l = lstatSafe(q);
    if (!l) return '-';
    if (!l.isSymbolicLink()) return at(q, l);
    const real = realpathSafe(q);
    const st = real ? statSafe(real) : null;
    return `l:${readlinkSafe(q) || ''}|${st ? at(real, st) : '!'}`; // `!`: it points nowhere
  };
  const sig = any(p);
  return cut ? `${sig}+` : sig;
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
