// Shared helpers for the novarc-harness-doctor probes.
// Zero dependencies. Every helper is read-only unless its name says otherwise.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

export const IS_WIN = process.platform === 'win32';

/** Parse `--flag value`, `--flag=value` and bare `--flag` (boolean) into an object; positionals in `_`. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

/** Convert a Git Bash style path (/c/dev/x) to a native one on Windows, then resolve. */
export function normalizeInputPath(p) {
  if (!p) return p;
  let s = String(p);
  if (IS_WIN) {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(s);
    if (m) s = `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`;
  }
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(s);
}

export function home() { return os.homedir(); }

function samePrefix(p, prefix) {
  if (!prefix) return false;
  const a = IS_WIN ? p.toLowerCase() : p;
  const b = IS_WIN ? prefix.toLowerCase() : prefix;
  if (a === b) return true;
  const withSep = b.endsWith(path.sep) ? b : b + path.sep;
  return a.startsWith(withSep);
}

/**
 * Display form of a path: project root as `./`, home as `~`, forward slashes.
 * Never returns an absolute path under home; other absolute paths pass through.
 */
export function displayPath(p, projectRoot) {
  if (p === undefined || p === null) return p;
  let s = String(p);
  if (IS_WIN) {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(s);
    if (m) s = `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`;
  }
  if (!path.isAbsolute(s)) return s.replace(/\\/g, '/');
  const norm = path.normalize(s);
  if (projectRoot && samePrefix(norm, projectRoot)) {
    const rel = path.relative(projectRoot, norm).replace(/\\/g, '/');
    return rel ? `./${rel}` : './';
  }
  const h = home();
  if (samePrefix(norm, h)) {
    const rel = path.relative(h, norm).replace(/\\/g, '/');
    return rel ? `~/${rel}` : '~';
  }
  return norm.replace(/\\/g, '/');
}

/** Replace any occurrence of the home dir (native or forward-slash form) inside free text with `~`. */
export function scrubText(text, projectRoot) {
  if (typeof text !== 'string') return text;
  let s = text;
  const variants = (p) => {
    if (!p) return [];
    const v = new Set([p, p.replace(/\\/g, '/')]);
    if (IS_WIN) {
      const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
      if (m) v.add(`/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`);
    }
    return [...v].sort((a, b) => b.length - a.length);
  };
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const v of variants(projectRoot)) s = s.replace(new RegExp(esc(v), IS_WIN ? 'gi' : 'g'), '.');
  for (const v of variants(home())) s = s.replace(new RegExp(esc(v), IS_WIN ? 'gi' : 'g'), '~');
  return s;
}

export function lstatSafe(p) { try { return fs.lstatSync(p); } catch { return null; } }
export function statSafe(p) { try { return fs.statSync(p); } catch { return null; } }
export function exists(p) { return statSafe(p) !== null; }
export function isDir(p) { const s = statSafe(p); return !!(s && s.isDirectory()); }
export function isFile(p) { const s = statSafe(p); return !!(s && s.isFile()); }
export function realpathSafe(p) { try { return fs.realpathSync.native(p); } catch { return null; } }
export function readdirSafe(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }
export function readlinkSafe(p) { try { return fs.readlinkSync(p); } catch { return null; } }

export function readTextSafe(p, maxBytes = 4 * 1024 * 1024) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > maxBytes) return null;
    return fs.readFileSync(p, 'utf8');
  } catch { return null; }
}

/**
 * Parse JSON without ever surfacing the parser's message: Node's JSON.parse error text embeds a
 * slice of the input, which may be a secret or transcript text.
 */
export function parseJsonSafe(text) {
  if (typeof text !== 'string') return { ok: false, error: 'unreadable' };
  try { return { ok: true, value: JSON.parse(text.replace(/^﻿/, '')) }; } catch { return { ok: false, error: 'invalid JSON' }; }
}

export function readJsonSafe(p) {
  const t = readTextSafe(p);
  if (t === null) return { ok: false, error: exists(p) ? 'unreadable' : 'missing' };
  return parseJsonSafe(t);
}

export function approxTokens(chars) { return Math.round(chars / 4); }

/** Run a command without a shell. Returns { ok, code, stdout, stderr, error }. Never throws. */
export function run(cmd, args, opts = {}) {
  try {
    const r = spawnSync(cmd, args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: opts.timeout ?? 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: opts.shell ?? false,
      env: opts.env ?? process.env,
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    });
    if (r.error) return { ok: false, code: null, stdout: '', stderr: '', error: r.error.code || 'spawn-error' };
    return { ok: r.status === 0, code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', timedOut: r.signal === 'SIGTERM' };
  } catch (e) {
    return { ok: false, code: null, stdout: '', stderr: '', error: e && e.code ? e.code : 'spawn-error' };
  }
}

/**
 * Read-only git invocation in `cwd`, via execFile with an argument array (no shell, no quoting
 * issues on any OS). Returns the same shape as run().
 */
export function git(cwd, args, timeout = 15000) {
  try {
    const stdout = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    });
    return { ok: true, code: 0, stdout, stderr: '' };
  } catch (e) {
    if (typeof e.status === 'number') return { ok: false, code: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
    return { ok: false, code: null, stdout: '', stderr: '', error: e && e.code ? e.code : 'spawn-error' };
  }
}

export function printJson(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }

export function warn(msg) { process.stderr.write(`[harness-doctor] ${msg}\n`); }

/** True when the module file is the script node was asked to run. */
export function isMain(metaUrl) {
  try {
    const self = fs.realpathSync(new URL(metaUrl));
    const argv1 = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return IS_WIN ? self.toLowerCase() === argv1.toLowerCase() : self === argv1;
  } catch { return false; }
}

export const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.turbo', '.cache', 'coverage', 'graphify-out', '.novarc-powers']);
