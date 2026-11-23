// mark / record / undo: what an executor calls around each change, and how the run takes its
// changes back. The ledger is the only record of what the run wrote outside its own directory,
// so every entry carries the hash the file had before (from the backup) and after: `undo` only
// touches a file that still has the hash the run left.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeInputPath } from '../common.mjs';
import { RunError, UsageError, readJson, writeJsonAtomic, withLock, sha256File, nowIso, relativeInside } from './store.mjs';
import { homeBase } from './paths.mjs';
import { homeMatchers, scrubString } from './scrub.mjs';
import { loadItems, loadStatus, appendLog, harnessById } from './model.mjs';

/** Classes doctor mode may apply without a decision (references/doctor-policy.md). */
export const SAFE_CLASSES = ['reversible', 'additive'];
const MARK_STATUSES = ['in-progress', 'fixed', 'failed'];
const MAX_NOTE = 2000;

function noteArg(args, name) {
  const v = args[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !v.trim()) throw new UsageError(`--${name} needs a text`);
  return scrubString(v.trim().slice(0, MAX_NOTE), homeMatchers());
}

function findItem(ctx, status, id) {
  const { items } = loadItems(ctx.paths, ctx.run, undefined, status);
  const item = items.find((i) => i.id === id);
  if (!item) throw new RunError(`no item ${id} in this run`);
  return item;
}

/** `mark --item <id> --status in-progress|fixed|failed [--verified <t>] [--not-verified <t>] [--auto]`. */
export function mark(ctx, args) {
  if (typeof args.item !== 'string') throw new UsageError('mark needs --item <id>');
  if (!MARK_STATUSES.includes(args.status)) throw new UsageError(`--status must be one of ${MARK_STATUSES.join(', ')}`);
  const verified = noteArg(args, 'verified');
  const notVerified = noteArg(args, 'not-verified');
  const target = args.status;
  return withLock(ctx.paths.mutex, () => {
    const status = loadStatus(ctx.paths);
    const item = findItem(ctx, status, args.item);
    const from = item.status;
    const refuse = (why) => { throw new RunError(`cannot mark ${item.id} as ${target}: ${why}`, { item: item.id, status: from }); };
    let auto = false;
    if (target === 'in-progress') {
      if (from === 'in-progress') return { runId: ctx.paths.runId, item: item.id, status: from, changed: false };
      if (from === 'open') {
        if (args.auto !== true) refuse('it is open; the user has not approved it');
        if (ctx.run.mode !== 'doctor') refuse('--auto is only for doctor mode; this run is guided');
        if (!SAFE_CLASSES.includes(item.class)) refuse(`class ${item.class} always waits for the user's decision`);
        auto = true;
      } else if (from !== 'approved') refuse(`it is ${from}; only an approved item can be applied`);
    } else {
      if (from !== 'in-progress') refuse(`it is ${from}; mark it in-progress first`);
      if (target === 'fixed' && !verified && !notVerified) refuse('say what was checked with --verified, and what could not be with --not-verified');
    }
    const at = nowIso();
    const o = status.items[item.id] || (status.items[item.id] = {});
    o.status = target;
    o.updatedAt = at;
    if (target === 'in-progress') { delete o.verified; delete o.notVerified; delete o.applied; }
    else {
      if (verified) o.verified = verified; else delete o.verified;
      if (notVerified) o.notVerified = notVerified; else delete o.notVerified;
      if (target === 'fixed') o.applied = true; else delete o.applied;
    }
    writeJsonAtomic(ctx.paths.status, status);
    if (target !== 'in-progress') {
      const { items } = loadItems(ctx.paths, ctx.run, undefined, status);
      const left = items.some((i) => i.harness === item.harness && (i.status === 'approved' || i.status === 'in-progress'));
      if (!left) fs.rmSync(ctx.paths.claimFile(`apply:${item.harness}`), { force: true });
    }
    appendLog(ctx.paths, { at, event: 'mark', harness: item.harness, item: item.id, status: target, ...(auto ? { auto: true } : {}), ...(verified ? { verified } : {}), ...(notVerified ? { notVerified } : {}) });
    return { runId: ctx.paths.runId, item: item.id, harness: item.harness, from, status: target, changed: true, ...(auto ? { auto: true } : {}) };
  });
}

function inside(base, target) {
  const rel = path.relative(base, target);
  return !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null;
}

/** Display path of a changed file: `./x` in its project, the account's display path, else `~/x`. */
function displayFor(abs, harness) {
  if (harness && harness.pathAbs) {
    const rel = inside(harness.pathAbs, abs);
    if (rel !== null) return harness.kind === 'project' ? `./${rel}` : `${harness.path}/${rel}`.replace(/\/$/, '');
  }
  for (const home of [homeBase(), os.homedir()]) {
    const rel = inside(home, abs);
    if (rel !== null) return rel ? `~/${rel}` : '~';
  }
  return abs.split(path.sep).join('/');
}

function localFile(value, what) {
  if (typeof value !== 'string' || !value.trim()) throw new UsageError(`${what} needs an absolute path`);
  const raw = value.trim();
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(raw) || raw.startsWith('\\\\') || raw.startsWith('//')) throw new UsageError(`${what} must be a file on this machine`);
  if (!path.isAbsolute(raw) && !/^\/[a-zA-Z](\/|$)/.test(raw) && !raw.startsWith('~')) throw new UsageError(`${what} must be an absolute path`);
  return normalizeInputPath(raw);
}

function isRegularFileOrMissing(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
}

/** `record --item <id> --path <abs> (--backup <abs> | --new) [--masked]`. */
export function record(ctx, args) {
  if (typeof args.item !== 'string') throw new UsageError('record needs --item <id>');
  const file = localFile(args.path, '--path');
  const isNew = args.new === true;
  if (isNew && args.backup !== undefined) throw new UsageError('pass --backup, or --new for a file this change created, not both');
  if (!isNew && args.backup === undefined) throw new UsageError('record needs --backup <abs> (the copy taken before the change), or --new for a file this change created');
  const backup = isNew ? null : localFile(args.backup, '--backup');
  if (!isRegularFileOrMissing(file)) throw new RunError('--path is not a regular file');
  if (backup !== null) {
    if (relativeInside(ctx.paths.backups, backup) === null) throw new RunError('--backup must be a file under this run\'s backups/ folder');
    if (!fs.existsSync(backup) || !fs.statSync(backup).isFile()) throw new RunError('--backup file not found');
  }
  return withLock(ctx.paths.mutex, () => {
    const status = loadStatus(ctx.paths);
    const item = findItem(ctx, status, args.item);
    if (item.status !== 'in-progress' && item.status !== 'fixed') throw new RunError(`cannot record a change for ${item.id}: it is ${item.status}; mark it in-progress first`);
    const hashBefore = backup === null ? null : sha256File(backup);
    const hashAfter = sha256File(file);
    if (hashBefore === null && hashAfter === null) throw new RunError('nothing to record: the file does not exist and there is no backup');
    if (hashBefore !== null && hashBefore === hashAfter) throw new RunError('nothing to record: the file is identical to its backup');
    const ledger = readJson(ctx.paths.ledger) || { version: 1, entries: [] };
    if (!Array.isArray(ledger.entries)) ledger.entries = [];
    const entry = {
      n: ledger.entries.length + 1,
      item: item.id,
      path: file,
      display: displayFor(file, harnessById(ctx.run, item.harness)),
      backup,
      hashBefore,
      hashAfter,
      at: nowIso(),
      ...(args.masked === true ? { masked: true } : {}),
    };
    ledger.entries.push(entry);
    writeJsonAtomic(ctx.paths.ledger, ledger);
    if (backup !== null) {
      const o = status.items[item.id] || (status.items[item.id] = {});
      if (!o.backup) { o.backup = relativeInside(ctx.paths.dir, backup); writeJsonAtomic(ctx.paths.status, status); }
    }
    const { path: _path, backup: _backup, ...shown } = entry;
    return { runId: ctx.paths.runId, recorded: { ...shown, created: hashBefore === null, deleted: hashAfter === null } };
  });
}

const pathKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

/** `undo (--item <id> | --all) [--dry-run] --yes`. */
export function undo(ctx, args) {
  const all = args.all === true;
  if (all === (typeof args.item === 'string')) throw new UsageError('undo needs --item <id> or --all');
  const dryRun = args['dry-run'] === true;
  if (!dryRun && args.yes !== true) throw new UsageError('undo changes files: pass --yes, or --dry-run to see what it would do');
  return withLock(ctx.paths.mutex, () => {
    const ledger = readJson(ctx.paths.ledger) || { version: 1, entries: [] };
    const entries = (ledger.entries || []).filter((e) => !e.undoneAt && (all || e.item === args.item));
    const out = { runId: ctx.paths.runId, dryRun, restored: [], deleted: [], conflicts: [], flipped: [], partial: [] };
    const now = nowIso();
    // What each file would hold after the steps taken so far; lets a dry run chain several entries.
    const virtual = new Map();
    const touched = new Set();
    for (const e of entries.slice().reverse()) {
      touched.add(e.item);
      const key = pathKey(e.path);
      const where = { item: e.item, display: e.display };
      const conflict = (reason) => out.conflicts.push({ ...where, reason });
      if (e.masked) { conflict('the backup has secrets masked: restore this file by hand'); continue; }
      let current;
      try { current = virtual.has(key) ? virtual.get(key) : sha256File(e.path); } catch { conflict('the file cannot be read'); continue; }
      if (current !== e.hashAfter) { conflict(current === null ? 'the file was removed after the run changed it' : 'the file was edited after the run changed it'); continue; }
      if (e.hashBefore === null) {
        if (!dryRun) { try { fs.unlinkSync(e.path); } catch (err) { if (err.code !== 'ENOENT') { conflict(`could not remove the file (${err.code})`); continue; } } }
        out.deleted.push(where);
      } else {
        let data = null;
        try { if (sha256File(e.backup) === e.hashBefore) data = fs.readFileSync(e.backup); } catch { data = null; }
        if (data === null) { conflict('the backup is missing or changed'); continue; }
        if (!dryRun) {
          try {
            fs.mkdirSync(path.dirname(e.path), { recursive: true });
            fs.writeFileSync(e.path, data); // in place: keeps a link pointing where it pointed
          } catch (err) { conflict(`could not write the file (${err.code || 'error'})`); continue; }
        }
        out.restored.push(where);
      }
      virtual.set(key, e.hashBefore);
      if (!dryRun) e.undoneAt = now;
      else e.wouldUndo = true;
    }

    // An item goes back to `approved` once none of its recorded changes is left on disk.
    const status = loadStatus(ctx.paths);
    const { items } = loadItems(ctx.paths, ctx.run, undefined, status);
    for (const id of touched) {
      const left = (ledger.entries || []).filter((e) => e.item === id && !e.undoneAt && !e.wouldUndo);
      const done = (ledger.entries || []).filter((e) => e.item === id && (e.wouldUndo || e.undoneAt === now));
      if (left.length) { if (done.length) out.partial.push(id); continue; }
      const item = items.find((i) => i.id === id);
      if (!item || !['fixed', 'in-progress', 'failed'].includes(item.status)) continue;
      out.flipped.push(id);
      if (dryRun) continue;
      const o = status.items[id] || (status.items[id] = {});
      o.status = 'approved';
      delete o.applied;
      o.updatedAt = now;
      delete o.verified;
      delete o.notVerified;
      delete o.backup;
      appendLog(ctx.paths, { at: now, event: 'undo', harness: item.harness, item: id, restored: done.length, conflicts: 0 });
    }
    if (!dryRun) {
      for (const id of out.partial) {
        const item = items.find((i) => i.id === id);
        const restored = (ledger.entries || []).filter((e) => e.item === id && e.undoneAt === now).length;
        appendLog(ctx.paths, { at: now, event: 'undo', ...(item ? { harness: item.harness } : {}), item: id, restored, conflicts: out.conflicts.filter((c) => c.item === id).length });
      }
      if (entries.some((e) => e.undoneAt === now)) writeJsonAtomic(ctx.paths.ledger, ledger);
      if (out.flipped.length) writeJsonAtomic(ctx.paths.status, status);
    }
    out.flipped.sort();
    out.partial.sort();
    if (!entries.length) out.note = 'no recorded change to undo';
    return out;
  });
}
