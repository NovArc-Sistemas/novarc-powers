// Absolute home paths must never reach a findings file or the state: the board can be shared.
// This module finds them (to reject a findings file with the offending JSON pointer) and replaces
// them with `~` (a last line of defence over probe output in `build`). It knows the home
// directory in every spelling it can take inside text: native, forward slashes, JSON-escaped
// backslashes, Git Bash (`/c/...`) and WSL (`/mnt/c/...`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeBase } from './paths.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function spellings(root) {
  const out = new Set();
  const native = root.replace(/[\\/]+$/, '');
  if (native.length < 4) return out; // a home of `/` or `C:\` would match everything
  out.add(native);
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(native);
  if (drive) {
    const rest = drive[2].replace(/\\/g, '/');
    const letter = drive[1];
    out.add(`${letter}:/${rest}`);
    out.add(`${letter}:\\${rest.replace(/\//g, '\\')}`);
    out.add(`${letter}:\\\\${rest.replace(/\//g, '\\\\')}`); // as it appears inside JSON text
    out.add(`/${letter.toLowerCase()}/${rest}`);
    out.add(`/mnt/${letter.toLowerCase()}/${rest}`);
  }
  return out;
}

/** Matchers for the home directory: the OS one, the NOVARC_POWERS_HOME one, and their real paths. */
export function homeMatchers(extraRoots = []) {
  const roots = new Set();
  for (const r of [os.homedir(), homeBase(), ...extraRoots]) {
    if (!r) continue;
    roots.add(path.resolve(r));
    try { roots.add(fs.realpathSync.native(r)); } catch { /* not on disk */ }
  }
  const all = new Set();
  for (const r of roots) for (const s of spellings(r)) all.add(s);
  // Longest first, so a nested root is not shadowed by its parent.
  return [...all].sort((a, b) => b.length - a.length).map((s) => {
    const windowsLike = /^[A-Za-z]:/.test(s) || process.platform === 'win32';
    // Not followed by a path-name character: a home folder named `ann` must not match inside `anna`.
    return new RegExp(`${escapeRe(s)}(?![A-Za-z0-9._-])`, windowsLike ? 'gi' : 'g');
  });
}

export function hasHomePath(text, matchers) {
  if (typeof text !== 'string' || !text) return false;
  return matchers.some((re) => { re.lastIndex = 0; return re.test(text); });
}

export function scrubString(text, matchers) {
  let s = text;
  for (const re of matchers) { re.lastIndex = 0; s = s.replace(re, '~'); }
  return s;
}

const ptr = (base, key) => `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

/** Visit every string (values and object keys) with its JSON pointer. */
export function walkStrings(value, visit, at = '') {
  if (typeof value === 'string') { visit(value, at || '/', false); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => walkStrings(v, visit, ptr(at, i))); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      visit(k, ptr(at, k), true);
      walkStrings(v, visit, ptr(at, k));
    }
  }
}

/** JSON pointers of every string that contains an absolute home path. */
export function findHomePaths(value, matchers) {
  const hits = [];
  walkStrings(value, (s, at) => { if (hasHomePath(s, matchers)) hits.push(at); });
  return [...new Set(hits)];
}

/** JSON pointers of every string value longer than `maxBytes` (UTF-8). */
export function findLongStrings(value, maxBytes) {
  const hits = [];
  walkStrings(value, (s, at, isKey) => { if (!isKey && s.length * 4 > maxBytes && Buffer.byteLength(s, 'utf8') > maxBytes) hits.push(at); });
  return hits;
}

/** Copy of `value` with home paths in string values replaced by `~`; `hits` receives the pointers. */
export function scrubDeep(value, matchers, hits = [], at = '') {
  if (typeof value === 'string') {
    if (!hasHomePath(value, matchers)) return value;
    hits.push(at || '/');
    return scrubString(value, matchers);
  }
  if (Array.isArray(value)) return value.map((v, i) => scrubDeep(v, matchers, hits, ptr(at, i)));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, matchers, hits, ptr(at, k));
    return out;
  }
  return value;
}
