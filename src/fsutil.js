// File-system helpers: realpath resolution for dedupe, safe copying that never
// follows symlinks, hashing, backups and atomic writes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Windows and macOS (APFS / HFS+ default) file systems are case-insensitive.
export const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/** True when two resolved paths name the same location on this platform. */
export function samePath(a, b) {
  return CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Resolve `p` to its canonical form even when it does not exist yet: realpath
 * the nearest existing ancestor (following links, e.g. a config dir symlinked
 * into another) and append the remaining segments.
 */
export function resolveReal(p) {
  const abs = path.resolve(p);
  const rest = [];
  let cur = abs;
  for (;;) {
    let real = null;
    try {
      real = fs.realpathSync.native(cur);
    } catch {
      real = null;
    }
    if (real !== null) return rest.length ? path.join(real, ...rest.reverse()) : real;
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    rest.push(path.basename(cur));
    cur = parent;
  }
}

/** Key used to compare paths: realpath (so /var == /private/var), case-folded where the FS is. */
export function pathKey(p) {
  const r = resolveReal(p);
  return CASE_INSENSITIVE ? r.toLowerCase() : r;
}

/** True when `child` is `parent` or lies inside it (both already resolved). */
export function isInside(parent, child) {
  const a = CASE_INSENSITIVE ? parent.toLowerCase() : parent;
  const b = CASE_INSENSITIVE ? child.toLowerCase() : child;
  const rel = path.relative(a, b);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function hashFile(file) {
  return sha256(fs.readFileSync(file));
}

export function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Top-level folders of a skill that are for maintainers, never installed or fetched.
const SKILL_DEV_DIRS = new Set(['tests']);

/**
 * List regular files under `dir` (relative, forward slashes). Symlinks are
 * never followed; they are reported in `skipped`. Top-level dev folders
 * (SKILL_DEV_DIRS) are left out.
 */
export function listFiles(dir) {
  const files = [];
  const skipped = [];
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!rel && SKILL_DEV_DIRS.has(ent.name)) continue;
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const st = fs.lstatSync(childAbs);
      if (st.isSymbolicLink()) skipped.push(childRel);
      else if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) files.push(childRel);
    }
  };
  if (exists(dir)) walk(dir, '');
  files.sort();
  return { files, skipped };
}

/** `{relPath: sha256}` for every regular file under `dir`. */
export function hashTree(dir) {
  const out = {};
  for (const rel of listFiles(dir).files) out[rel] = hashFile(path.join(dir, ...rel.split('/')));
  return out;
}

/**
 * Make sure writing to `target` stays inside `root`. Both are resolved through
 * realpath, so a symlinked directory inside the target that points elsewhere
 * is caught.
 */
export function assertInside(root, target) {
  const r = resolveReal(root);
  const t = resolveReal(target);
  if (!isInside(r, t)) {
    const err = new Error(`Refusing to write outside the target: ${target}`);
    err.code = 'OUTSIDE_TARGET';
    throw err;
  }
}

/** Remove a path without following symlinks (a link is unlinked, not its target). */
export function removePath(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) fs.unlinkSync(p);
  else fs.rmSync(p, { recursive: true, force: true });
}

/**
 * Write one file inside `root`. A symlink already sitting at the destination is
 * replaced by a regular file instead of being written through.
 */
export function writeInside(root, rel, data) {
  const dest = path.join(root, ...rel.split('/'));
  assertInside(root, path.dirname(dest));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    if (fs.lstatSync(dest).isSymbolicLink()) fs.unlinkSync(dest);
  } catch {
    /* missing is fine */
  }
  fs.writeFileSync(dest, data);
  return dest;
}

/**
 * Write a file in place: open the existing path, truncate, write. Never
 * temp-file + rename and never unlink + create, because instruction and
 * settings files are often symlinks or hardlinks shared between accounts and a
 * rename would silently fork them.
 */
export function writeFileInPlace(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

/** Identity of an existing file or dir (`dev:ino`), or null. Collapses hardlinks and case variants. */
export function fileIdentity(p) {
  try {
    const st = fs.statSync(p, { bigint: true });
    if (st.ino === 0n) return null;
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/** Timestamp folder name for backups: ISO time with colons replaced. */
export function backupStamp(date = new Date()) {
  return date.toISOString().replace(/:/g, '-');
}

/** Encode an absolute path into one safe file name. */
export function encodePath(p) {
  return path
    .resolve(p)
    .replace(/^([A-Za-z]):/, '$1')
    .replace(/[\\/]+/g, '__')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^_+/, '');
}

/** Copy a pre-existing file into `<state dir>/backups/<stamp>/<encoded path>`. */
export function backupFile(stateDirPath, stamp, file) {
  if (!exists(file)) return null;
  const dest = path.join(stateDirPath, 'backups', stamp, encodePath(file));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!exists(dest)) fs.copyFileSync(file, dest);
  return dest;
}
