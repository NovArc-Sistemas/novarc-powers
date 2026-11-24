// File primitives for the run directory: atomic writes (temp file + rename), a short-lived mutex
// with retry for read-modify-write sections shared by several processes, JSON and JSONL readers.
// Everything is synchronous on purpose: a critical section is a few milliseconds of file I/O and
// a synchronous section cannot be interleaved by this process's own event loop.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** A failure the caller can act on (exit 1). The message is safe to print. */
export class RunError extends Error {
  constructor(message, details) { super(message); this.name = 'RunError'; this.details = details; }
}
/** Bad command line (exit 2). */
export class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; }
}

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms) { Atomics.wait(SLEEP_CELL, 0, 0, Math.max(1, Math.floor(ms))); }

/** What a command prints when its answer is text for a person instead of JSON (`run.mjs history`). */
export class Plain {
  constructor(text) { this.text = text; }
}

/**
 * The clock of the run library, in epoch milliseconds. NOVARC_HD_NOW (an RFC 3339 date-time, or
 * epoch milliseconds) replaces it, so a test can close a review on one day and start its
 * follow-up a month later. The lock code below keeps the real clock: a lock is about processes,
 * not about the review.
 */
export function nowMs() {
  const raw = process.env.NOVARC_HD_NOW;
  if (raw === undefined || !raw.trim()) return Date.now();
  const v = raw.trim();
  const ms = /^\d{1,16}$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(ms)) throw new UsageError('NOVARC_HD_NOW must be an RFC 3339 date-time or epoch milliseconds');
  return ms;
}

export function nowIso() { return new Date(nowMs()).toISOString(); }

export function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
/** sha256 of a file's bytes, or null when it does not exist. */
export function sha256File(file) {
  try { return sha256(fs.readFileSync(file)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// Windows reports a rename or open that collides with another process (or an antivirus scan) as
// one of these; they clear within milliseconds.
const TRANSIENT = new Set(process.platform === 'win32' ? ['EPERM', 'EBUSY', 'EACCES'] : []);
/** True for an error that means "another process is touching this file right now". */
export function isTransient(e) { return !!e && TRANSIENT.has(e.code); }

function retrying(fn, tries = 60) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= tries || !TRANSIENT.has(e.code)) throw e;
      sleepSync(4 + Math.random() * 12 + Math.min(i, 20));
    }
  }
}

/** Write `text` so that a reader sees either the old file or the new one, never a partial one. */
export function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, text);
  try { retrying(() => fs.renameSync(tmp, file)); } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

export function toJsonText(value) { return JSON.stringify(value, null, 2) + '\n'; }
export function writeJsonAtomic(file, value) { writeTextAtomic(file, toJsonText(value)); }

/** Read a text file; null when it does not exist. */
export function readText(file) {
  try { return retrying(() => fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/**
 * Read a JSON file. Missing -> `fallback`. Invalid JSON -> RunError naming the file only: Node's
 * parser message embeds a slice of the input, which must never be printed.
 */
export function readJson(file, fallback = null) {
  const text = readText(file);
  if (text === null) return fallback;
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch { throw new RunError(`${path.basename(file)} is not valid JSON`); }
}

/** Parsed lines of a JSONL file: `[{ line, value } | { line, error }]`. An unterminated last line is skipped. */
export function readJsonl(file) {
  const text = readText(file);
  if (!text) return [];
  // The last part is '' after a final newline, or a line another process is still writing.
  const complete = text.split('\n').slice(0, -1);
  const out = [];
  complete.forEach((raw, i) => {
    const s = raw.trim();
    if (!s) return;
    try { out.push({ line: i + 1, value: JSON.parse(s) }); } catch { out.push({ line: i + 1, error: 'invalid JSON' }); }
  });
  return out;
}

/** Append one JSON value as one line, in a single write call. */
export function appendJsonLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  retrying(() => fs.appendFileSync(file, JSON.stringify(value) + '\n'));
}

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Remove a lock whose holder evidently died. Only one process examines it at a time. */
function breakIfStale(lockPath, staleMs) {
  let st;
  try { st = fs.statSync(lockPath); } catch { return; }
  if (Date.now() - st.mtimeMs <= staleMs) return;
  const guard = `${lockPath}.break`;
  let fd;
  try { fd = fs.openSync(guard, 'wx'); } catch {
    // Another process is breaking it. A guard that outlived its own holder is cleared for the next round.
    try { if (Date.now() - fs.statSync(guard).mtimeMs > staleMs) fs.unlinkSync(guard); } catch { /* gone */ }
    return;
  }
  try {
    const again = fs.statSync(lockPath);
    if (Date.now() - again.mtimeMs > staleMs) fs.unlinkSync(lockPath);
  } catch { /* released meanwhile */ } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(guard); } catch { /* ignore */ }
  }
}

/**
 * Run `fn` while holding the lock file `lockPath` (exclusive create). Waits with jittered retries
 * up to `timeoutMs`; a lock older than `staleMs` belongs to a dead process and is broken.
 * `fn` must be synchronous and short. A holder that cannot be short gets `{ touch }` as its
 * argument and calls `touch()` before each slow step: it tells the others the lock is alive.
 */
export function withLock(lockPath, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? envNumber('NOVARC_HD_LOCK_TIMEOUT_MS', 20000);
  const staleMs = opts.staleMs ?? envNumber('NOVARC_HD_LOCK_STALE_MS', 30000);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const started = Date.now();
  for (;;) {
    let fd = null;
    try { fd = fs.openSync(lockPath, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST' && !TRANSIENT.has(e.code)) throw e;
    }
    if (fd !== null) {
      try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); }
      break;
    }
    breakIfStale(lockPath, staleMs);
    if (Date.now() - started > timeoutMs) throw new RunError('the run directory is busy (another command holds its lock); try again');
    sleepSync(6 + Math.random() * 24);
  }
  const lock = {
    touch() {
      try {
        if (fs.readFileSync(lockPath, 'utf8') !== token) return;
        const t = new Date();
        fs.utimesSync(lockPath, t, t);
      } catch { /* gone: nothing to keep alive */ }
    },
  };
  try { return fn(lock); } finally {
    // Release only our own lock: if it was broken as stale, the file now belongs to someone else.
    try { if (fs.readFileSync(lockPath, 'utf8') === token) fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

/** Path relative to `base` with forward slashes, or null when `target` is not inside it. */
export function relativeInside(base, target) {
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}
