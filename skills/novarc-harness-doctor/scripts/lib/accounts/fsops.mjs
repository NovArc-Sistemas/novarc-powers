// File-tree helpers for the accounts feature: compare, sign, copy, move and remove trees
// without ever following a link into somebody else's files.
import fs from 'node:fs';
import path from 'node:path';
import {
  homeDir, lstatSafe, statSafe, readlinkSafe, readdirSafe, sha256, mkdirp, removeLink, realpathSafe, pathKey,
  copyFileSafe, buildThenRename, testFault,
} from '../../sync-check.mjs';

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

/**
 * Copy a file or a tree to a place where nothing is yet. Links are re-created as links (or,
 * where refused, as what they hold). The copy appears whole or not at all: a file is copied
 * under a temp name and renamed, a folder is built under a temp name beside the destination and
 * renamed. The next run removes that temp if this one dies in the middle.
 */
export function copyTree(src, dst, { home = homeDir(), at } = {}) {
  /** A link as a link; where the OS refuses one, a junction for a folder and the bytes for a file. */
  const link = (from, to, copyFile) => {
    const raw = fs.readlinkSync(from);
    const st = statSafe(from);
    try { fs.symlinkSync(raw, to, st && st.isDirectory() ? 'dir' : 'file'); } catch (e) {
      if (!st) throw e;
      if (st.isDirectory()) fs.symlinkSync(realpathSafe(from) || path.resolve(path.dirname(from), raw), to, 'junction');
      else copyFile(from, to);
    }
  };
  /** A folder, copied to a place nobody reads yet (the temp name): plain copies are enough there. */
  const fill = (from, to) => {
    fs.mkdirSync(to);
    for (const name of fs.readdirSync(from).sort()) {
      const a = path.join(from, name);
      const b = path.join(to, name);
      const l = fs.lstatSync(a);
      if (l.isSymbolicLink()) link(a, b, (x, y) => fs.copyFileSync(x, y));
      else if (l.isDirectory()) fill(a, b);
      else fs.copyFileSync(a, b);
      testFault('tree-file');
    }
  };
  mkdirp(path.dirname(dst));
  const top = fs.lstatSync(src);
  // `at` is for the tests: called at each point the final rename passes (see buildThenRename).
  if (top.isSymbolicLink()) link(src, dst, (x, y) => copyFileSafe(x, y, { home, at }));
  else if (top.isDirectory()) buildThenRename(dst, (tmp) => fill(src, tmp), { home, at });
  else copyFileSafe(src, dst, { home, at });
}

/** True when everything at `a` is also at `b`, entry for entry and byte for byte; `b` may hold more. */
export function containedIn(a, b, budget = { entries: 20000, bytes: 64 * 1024 * 1024 }) {
  const left = { entries: budget.entries, bytes: budget.bytes };
  const walk = (x, y) => {
    const lx = lstatSafe(x);
    const ly = lstatSafe(y);
    if (!lx) return true;
    if (!ly || --left.entries < 0) return false;
    if (lx.isSymbolicLink() || ly.isSymbolicLink()) return lx.isSymbolicLink() && ly.isSymbolicLink() && readlinkSafe(x) === readlinkSafe(y);
    if (lx.isDirectory() !== ly.isDirectory()) return false;
    if (lx.isDirectory()) return readdirSafe(x).every((e) => walk(path.join(x, e.name), path.join(y, e.name)));
    if (lx.size !== ly.size) return false;
    left.bytes -= lx.size;
    return left.bytes >= 0 && sameContent(x, y);
  };
  return walk(a, b);
}

/** Bring into `dst` whatever `src` holds and `dst` lacks. Nothing that is in `dst` is touched. */
export function fillFrom(src, dst, { home = homeDir() } = {}) {
  const ls = lstatSafe(src);
  if (!ls) return;
  const ld = lstatSafe(dst);
  if (!ld) { copyTree(src, dst, { home }); return; }
  const real = (l) => l.isDirectory() && !l.isSymbolicLink();
  if (real(ls) && real(ld)) for (const e of readdirSafe(src)) fillFrom(path.join(src, e.name), path.join(dst, e.name), { home });
}

/**
 * Remove a tree entry by entry, each one only while it is still identical to its counterpart
 * under `like`, looked at right before it goes. Stops (code ECHANGED) at the first entry that
 * something changed since the two trees were compared: what is left stays.
 */
export function removeIfSame(p, like) {
  const l = lstatSafe(p);
  if (!l) return;
  if (l.isDirectory() && !l.isSymbolicLink()) {
    for (const e of fs.readdirSync(p)) removeIfSame(path.join(p, e), path.join(like, e));
    fs.rmdirSync(p); // fails when something new appeared in it: it stays
    return;
  }
  if (compareTrees(p, like) !== 'same') throw Object.assign(new Error('it changed while it was being removed; what is left of it stays'), { code: 'ECHANGED' });
  removeLink(p);
}

/** Remove a file, a link or a tree. A link is removed as a link: its target is never touched. */
export function removeTree(p) {
  const l = lstatSafe(p);
  if (!l) return;
  if (l.isSymbolicLink() || !l.isDirectory()) { removeLink(p); return; }
  for (const e of fs.readdirSync(p)) removeTree(path.join(p, e));
  fs.rmdirSync(p);
}

/**
 * Move a file, link or folder. Falls back to copy-verify-remove across volumes: the copy appears
 * whole or not at all (see copyTree), so the destination is complete before the source is touched.
 */
export function movePath(src, dst, { home = homeDir() } = {}) {
  mkdirp(path.dirname(dst));
  try { fs.renameSync(src, dst); return; } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'ENOTEMPTY') throw e;
    if (lstatSafe(dst)) throw e;
  }
  copyTree(src, dst, { home });
  if (compareTrees(src, dst) !== 'same') {
    removeTree(dst);
    throw new Error('could not move: the copy does not match the original');
  }
  // The source goes entry by entry, each only while it still is what was copied: an edit made
  // after the comparison stays where it is, and the move fails with the copy whole.
  removeIfSame(src, dst);
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
