// Executes a plan (backup, change, verify, record) and undoes a run.
//
// `apply` never trusts paths from the plan file: it rebuilds the plan from the current state of
// the disk plus the choices recorded in the file, and refuses when the two no longer agree.
// Everything it replaces is MOVED into the run's backup folder, never deleted; every in-place
// edit is journalled as a reverse patch, so `undo` restores the originals byte for byte.
// Right before a step writes, what it is about to change is compared with what the plan signed,
// content behind links included: a step whose input moved is given up with nothing written.
// `undo` records each journal entry it has undone, so one that stops half way can be run again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOOL, MANIFEST_VERSION, MCP_PREFIX, homeDir, syncDir, manifestFile, stableCheckPath, displayPath,
  scrub, lstatSafe, isDir, readBuf, readText, parseJson, sha256, hashFile, canon, mkdirp, isInside,
  writeKeepingLinks, writeAtomic, linkStatus, linkOrCopy, linkRecord, removeLink, generateInstructions,
  readServers, rewriteCodexServers, reconcileServers, readManifest, writeManifest, destIdentity,
  destinationProblem,
} from '../../sync-check.mjs';
import { detectAccounts } from './detect.mjs';
import { manifestIsFor, liveSignature, serverSignature, instructionSignature } from './diff.mjs';
import { buildPlan, resolutionsFromPlan, PlanError, PLAN_VERSION } from './plan.mjs';
import { copyTree, removeTree, movePath, compareTrees, sameContent, listFiles } from './fsops.mjs';
import { setIn, removeIn, makePatch, revertPatch } from './jsonedit.mjs';
import { parseLang } from './strings.mjs';

const JOURNAL_VERSION = 1;

export function backupsDir(home = homeDir()) { return path.join(syncDir(home), 'backups'); }

function newStamp(root) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  let stamp = base;
  for (let n = 2; lstatSafe(path.join(root, stamp)); n++) stamp = `${base}-${n}`;
  return stamp;
}

/** Read a text file exactly: refuses one that is not valid UTF-8 (an edit would damage it). */
function readExact(file) {
  const buf = readBuf(file, 64 * 1024 * 1024);
  if (buf === null) return null;
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) throw new Error('the file is not valid UTF-8; left untouched');
  return text;
}

/** One apply (or install) run: its backup folder and its undo journal. */
export class Run {
  /** `signed`: the signatures of the plan being applied (see `confirm`); none for an install. */
  constructor(home, primaryId, signed = null) {
    this.home = home;
    this.signed = signed;
    this.root = backupsDir(home);
    this.stamp = null;
    this.journal = { version: JOURNAL_VERSION, tool: TOOL, primary: primaryId, startedAt: new Date().toISOString(), ops: [] };
  }

  dir() {
    if (!this.stamp) {
      mkdirp(this.root);
      this.stamp = newStamp(this.root);
      this.journal.stamp = this.stamp;
      mkdirp(path.join(this.root, this.stamp));
    }
    return path.join(this.root, this.stamp);
  }

  backupPath(accountId, name) {
    return path.join(this.dir(), accountId, ...name.replace(/\/$/, '').split('/'));
  }

  save() { writeAtomic(path.join(this.dir(), 'journal.json'), JSON.stringify(this.journal, null, 2) + '\n'); }
  op(o) { this.journal.ops.push(o); this.save(); }
  unop() { this.journal.ops.pop(); this.save(); }
  mark() { return this.journal.ops.length; }
  /** Forget the journal entries of a step that was rolled back. */
  rewind(mark) { if (this.journal.ops.length > mark) { this.journal.ops.length = mark; this.save(); } }

  /** Create the missing parent folders of a path, journalled so undo removes them again. */
  parents(file) {
    const made = [];
    for (let d = path.dirname(file); !lstatSafe(d) && path.dirname(d) !== d; d = path.dirname(d)) made.unshift(d);
    for (const m of made) { fs.mkdirSync(m); this.op({ op: 'mkdir', path: m }); }
  }
}

/**
 * Right before a step writes: what it is about to change must still be what the plan signed.
 * The whole plan is compared when `apply` starts, but steps run one after another: an earlier
 * step, or anything else on the machine, can change what a later one is about to read. `live`
 * is the element's signature read from the disk now. Throws, before anything is written for
 * that step, when it is no longer the signed one.
 */
function confirm(run, account, name, live) {
  if (!run.signed) return;
  if (sha256(live).slice(0, 16) === run.signed[`${account}:${name}`]) return;
  throw Object.assign(new Error(`${name} changed after the plan was made (its content, or what a link leads to, is not what the plan showed); nothing was written for it: plan again`), { stale: true });
}

// ---- manifest records -----------------------------------------------------------------------

function accountRecord(manifest, settings) {
  const a = settings.account;
  const key = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  let rec = manifest.accounts.find((x) => x.pathAbs && key(x.pathAbs) === key(a.pathAbs));
  if (!rec) { rec = { id: a.id, provider: a.provider, pathAbs: a.pathAbs, mode: settings.mode, elements: [], exceptions: [] }; manifest.accounts.push(rec); }
  Object.assign(rec, { id: a.id, provider: a.provider, pathAbs: a.pathAbs, mode: settings.mode });
  for (const k of ['imports', 'skills', 'mcp']) { if (settings[k]) rec[k] = settings[k]; else delete rec[k]; }
  // Where the account's MCP file is, with this plan approved. The unattended check writes that
  // file only while it is still a plain file there (see destinationProblem).
  if (rec.mcp && rec.mcp.format === 'codex-toml') rec.mcp = { ...rec.mcp, identity: destIdentity(rec.mcp.path, { ids: false }) };
  return rec;
}

function forget(rec, name) { rec.elements = rec.elements.filter((x) => x.name !== name); }
function upsert(rec, el) { forget(rec, el.name); rec.elements.push(el); rec.exceptions = rec.exceptions.filter((n) => n !== el.name); }
function except(rec, name) { forget(rec, name); if (!rec.exceptions.includes(name)) rec.exceptions.push(name); }

// ---- steps ----------------------------------------------------------------------------------

function doLink(run, step, rec, confirmed = false) {
  const { e } = step;
  const { S, P } = e;
  const dir = !!e.dir;
  if (!confirmed) confirm(run, step.account, step.name, liveSignature(e));
  const mark = run.mark();
  let moved = null;
  if (lstatSafe(S)) {
    moved = run.backupPath(step.account, step.name);
    movePath(S, moved);
    run.op({ op: 'move', from: S, to: moved });
  }
  let kind;
  try {
    run.parents(S);
    kind = linkOrCopy(P, S, dir); // a managed copy where no link is possible (another volume)
    const ok = kind === 'copy' ? sameContent(P, S) : linkStatus(S, P).state === 'ok';
    if (!ok) throw new Error('verification failed: the link does not resolve to the primary');
  } catch (err) {
    if (lstatSafe(S)) removeLink(S);
    if (moved) movePath(moved, S);
    run.rewind(mark);
    throw err;
  }
  run.op({ op: 'link', path: S, target: P, kind, dir });
  upsert(rec, linkRecord(step.name, kind, S, P, dir));
  return { kind: kind === 'copy' ? 'managed copy' : kind };
}

/** Bring the account's version into the primary, then link the account to it. */
function doAdopt(run, step, rec, primaryId) {
  const { e } = step;
  const { S, P } = e;
  // The account's version is about to be copied into the primary: it must be, byte for byte and
  // behind any link, the version the plan showed.
  confirm(run, step.account, step.name, liveSignature(e));
  const mark = run.mark();
  let kept = 0;
  try {
    if (e.state === 'account-only') {
      if (lstatSafe(P)) throw new Error('the primary has this element now; plan again');
      mkdirp(path.dirname(P));
      run.op({ op: 'create', path: P, like: S });
      copyTree(S, P);
    } else if (!e.dir) {
      const pb = run.backupPath(primaryId, step.name);
      mkdirp(path.dirname(pb));
      fs.copyFileSync(P, pb);
      const data = fs.readFileSync(S);
      run.op({ op: 'overwrite', path: P, backup: pb, afterHash: sha256(data) });
      writeKeepingLinks(P, data, { home: run.home });
    } else {
      for (const rel of listFiles(S)) {
        const src = path.join(S, rel);
        const dst = path.join(P, rel);
        if (lstatSafe(dst)) { if (!sameContent(src, dst)) kept++; continue; }
        const made = [];
        for (let d = path.dirname(dst); !lstatSafe(d) && isInside(d, P); d = path.dirname(d)) made.unshift(d);
        for (const m of made) { fs.mkdirSync(m); run.op({ op: 'mkdir', path: m }); }
        copyTree(src, dst);
        run.op({ op: 'add', path: dst, like: src });
      }
    }
    const r = doLink(run, step, rec, true); // confirmed above; the primary's side has just changed
    if (kept) r.note = `${kept} entr${kept === 1 ? 'y differs' : 'ies differ'} on both sides: the primary's stayed, the account's are in the backup`;
    return r;
  } catch (err) {
    // The account is as it was (doLink restores it): take back what was brought into the primary.
    const seen = { gone: new Set(), back: new Map() };
    for (const op of run.journal.ops.slice(mark).reverse()) { try { undoOp(op, false, seen, run.home); } catch { /* reported by the failed step */ } }
    run.rewind(mark);
    throw err;
  }
}

function doDrop(run, step, rec) {
  confirm(run, step.account, step.name, liveSignature(step.e));
  const moved = run.backupPath(step.account, step.name);
  movePath(step.e.S, moved);
  run.op({ op: 'move', from: step.e.S, to: moved });
  forget(rec, step.name);
  return {};
}

function doInstructions(run, step, rec, home) {
  const { e } = step;
  const S = e.S;
  const provider = rec.provider;
  const gen = generateInstructions({ source: e.P, provider, sourceDisplay: e.sourceDisplay, inlineImports: e.inlineImports, home });
  if (!gen) throw new Error('the primary\'s instruction file can no longer be read');
  const data = Buffer.from(gen.text, 'utf8');
  const hash = sha256(data);
  if (step.pre !== 'same') {
    confirm(run, step.account, step.name, instructionSignature(hash, lstatSafe(S) ? hashFile(S) : null));
    const mark = run.mark();
    let moved = null;
    let previous = null;
    try {
      if (step.pre === 'stale' && lstatSafe(S)) {
        // Rewritten where it is, so only while it is still the plain file that was generated.
        const tracked = rec.elements.find((x) => x.name === step.name);
        const problem = destinationProblem(tracked && tracked.identity, S, rec.pathAbs);
        if (problem) throw new Error(`${problem}; nothing was written: plan again to decide what happens to it`);
        previous = readExact(S);
        run.op({ op: 'patch', path: S, afterHash: hash, patch: makePatch(previous, gen.text) });
        writeKeepingLinks(S, data, { home });
      } else {
        if (lstatSafe(S)) {
          moved = run.backupPath(step.account, step.name);
          movePath(S, moved);
          run.op({ op: 'move', from: S, to: moved });
        }
        run.parents(S);
        run.op({ op: 'write', path: S, hash });
        writeKeepingLinks(S, data, { home });
      }
      if (hashFile(S) !== hash) throw new Error('verification failed: the generated file does not match');
    } catch (err) {
      // A failed write leaves the file as it was; only a write that went through is taken back.
      if (previous !== null) { if (hashFile(S) !== sha256(Buffer.from(previous, 'utf8'))) writeKeepingLinks(S, previous, { home }); } else {
        if (lstatSafe(S) && (moved || step.pre === 'missing')) removeLink(S);
        if (moved) movePath(moved, S);
      }
      run.rewind(mark);
      throw err;
    }
  }
  // `identity`: where the generated file is. The unattended check rewrites it only while that holds.
  upsert(rec, { name: step.name, kind: 'generated', path: S, target: e.P, generator: { type: 'instructions', provider, sourceDisplay: e.sourceDisplay, inlineImports: e.inlineImports }, sourceHash: hash, contentHash: hash, identity: destIdentity(S) });
  return {};
}

const SERVER_WRITES = new Set(['write', 'replace', 'remove', 'adopt']);

function doServers(run, step, rec) {
  const m = step.mcp;
  const src = readServers(m.source, m.sourceFormat);
  const tgt = readServers(m.path, m.format);
  if (!src.ok || !tgt.ok) throw new Error('the server definitions can no longer be read');
  // Before anything is touched: each server about to change is compared again, as the plan did.
  const managed = {};
  for (const x of rec.elements) if (x.kind === 'managed-block') managed[x.name.slice(MCP_PREFIX.length)] = x.contentHash;
  const live = new Map(reconcileServers({ source: src.servers, target: tgt.servers, sourceFormat: m.sourceFormat, targetFormat: m.format, managed }).map((x) => [x.name, x]));
  for (const it of step.items) {
    if (!SERVER_WRITES.has(it.op)) continue;
    const now = live.get(it.name);
    const cur = tgt.servers[it.name];
    confirm(run, step.account, MCP_PREFIX + it.name, now ? serverSignature(now.status, now.want, cur ? cur.def : undefined) : '-');
  }
  const write = [];
  const remove = [];
  const changed = new Set();
  const adopted = [];
  const json = m.format !== 'codex-toml';
  for (const it of step.items) {
    if (it.op === 'forget') forget(rec, MCP_PREFIX + it.name);
    else if (it.op === 'remove') { remove.push(it.name); changed.add(it.name); } else if (it.op === 'keep') { if (canon(it.e.cur) === canon(it.e.want)) write.push({ name: it.name, def: it.e.want }); } else if (it.op === 'adopt') {
      // An identical definition of the account's own: recorded as managed. In a TOML file it
      // also moves into the managed block; in a JSON file not a byte changes.
      write.push({ name: it.name, def: it.e.want });
      adopted.push(it.name);
      if (!json) changed.add(it.name);
    } else { write.push({ name: it.name, def: it.e.want }); changed.add(it.name); }
  }
  const mark = run.mark();
  let before = '';
  let after = '';
  if (!json) {
    before = tgt.exists ? readExact(m.path) : '';
    after = rewriteCodexServers(before, { remove, write });
  } else {
    if (lstatSafe(`${m.path}.lock`)) throw new Error('the app is writing its state file right now; close it and apply again');
    before = readExact(m.path);
    after = before;
    for (const w of write) if (changed.has(w.name)) after = setIn(after, ['mcpServers', w.name], w.def);
    for (const name of remove) after = removeIn(after, ['mcpServers', name]);
  }
  if (after !== before) {
    if (!tgt.exists) run.parents(m.path);
    run.op({ op: 'patch', path: m.path, afterHash: sha256(Buffer.from(after, 'utf8')), patch: makePatch(before, after), created: !tgt.exists });
    try { writeKeepingLinks(m.path, after, { home: run.home }); } catch (err) { run.rewind(mark); throw err; }
  }
  const now = readServers(m.path, m.format).servers;
  const bad = write.filter((w) => !now[w.name] || canon(now[w.name].def) !== canon(w.def)).map((w) => w.name).concat(remove.filter((n) => now[n]));
  if (bad.length) {
    if (after !== before) { if (tgt.exists) writeKeepingLinks(m.path, before, { home: run.home }); else removeLink(m.path); run.rewind(mark); }
    throw new Error(`verification failed for: ${bad.join(', ')}`);
  }
  if (rec.mcp && rec.mcp.format === 'codex-toml') rec.mcp = { ...rec.mcp, identity: destIdentity(m.path, { ids: false }) };
  for (const name of remove) forget(rec, MCP_PREFIX + name);
  for (const it of step.items) {
    if (it.op !== 'keep' && it.op !== 'write' && it.op !== 'replace' && it.op !== 'adopt') continue;
    if (!now[it.name] || !src.servers[it.name]) continue;
    // A definition the user tuned (extra keys) keeps its old record: it is theirs to change.
    if (it.op === 'keep' && canon(it.e.cur) !== canon(it.e.want)) continue;
    upsert(rec, { name: MCP_PREFIX + it.name, kind: 'managed-block', path: m.path, target: m.source, format: m.format, sourceHash: sha256(canon(src.servers[it.name].def)), contentHash: sha256(canon(now[it.name].def)) });
  }
  return { changed: [...new Set([...changed, ...adopted])] };
}

const CHANGES = new Set(['link', 'adopt', 'drop']);

function stepChanges(step) {
  if (CHANGES.has(step.kind)) return true;
  if (step.kind === 'instructions') return step.pre !== 'same';
  if (step.kind === 'mcp') return step.items.some((it) => SERVER_WRITES.has(it.op));
  return false;
}

function stripVolatile(manifest) {
  const { updatedAt, ...rest } = manifest;
  return canon(rest);
}

// ---- apply ----------------------------------------------------------------------------------

/**
 * Apply a plan file. Returns { code, out }: `out` is the JSON to print (display paths only).
 * Options: yes (required unless dryRun), dryRun, newPrimary (replace a manifest written for
 * another primary).
 */
export function applyPlan({ planFile, yes = false, dryRun = false, newPrimary = false, home = homeDir(), env = process.env }) {
  const refuse = (code, error, extra = {}) => ({ code, out: { ok: false, refused: true, error, ...extra } });
  if (!yes && !dryRun) return refuse(2, 'apply changes the accounts on this machine: pass --yes after the user approved the plan, or --dry-run to see what it would do');
  const text = readText(planFile);
  const parsed = parseJson(text);
  if (text === null || !parsed.ok) return refuse(2, 'the plan file cannot be read as JSON');
  const file = parsed.value;
  if (!file || file.tool !== TOOL || file.version !== PLAN_VERSION || !file.primary || !Array.isArray(file.accounts)) return refuse(2, 'this is not a plan written by accounts.mjs plan');

  const accounts = detectAccounts({ home, env });
  const match = (p) => accounts.some((a) => a.id === p.id && a.path === p.path && a.provider === p.provider);
  if (!match(file.primary) || !file.accounts.every(match)) return refuse(1, 'the accounts on this machine no longer match the plan (an account moved, appeared or disappeared); plan again');

  const { resolutions, problems } = resolutionsFromPlan(file);
  if (problems.length) return refuse(1, 'the plan has choices that were not made explicitly', { problems });

  const manifestPath = manifestFile(home);
  let manifest = readManifest(manifestPath);
  if (manifest && !manifestIsFor(manifest, accounts.find((a) => a.id === file.primary.id))) {
    if (!newPrimary) return refuse(1, `the accounts are already synced from ${manifest.primary}; undo that first, or pass --new-primary to start over from ${file.primary.id}`);
    manifest = null;
  }

  let fresh;
  try {
    fresh = buildPlan({ accounts, primaryId: file.primary.id, manifest, resolutions, only: file.accounts.map((a) => a.id), symlinks: !!(file.options && file.options.symlinks), lenient: true, lang: parseLang(file.lang) || 'en', home });
  } catch (err) {
    if (err instanceof PlanError) return refuse(1, `the plan is stale (${err.message}); plan again`);
    throw err;
  }
  const pending = fresh.steps.filter(stepChanges);
  const seen = file.signatures && typeof file.signatures === 'object' ? file.signatures : {};
  if (pending.length) {
    // Stale when an element changed state, or when the content of something about to be
    // changed (behind a link too) is no longer what the user was shown. Each step compares its
    // own element once more right before it writes: see `confirm`.
    const moved = fresh.changes.filter((key) => fresh.plan.signatures[key] !== seen[key]);
    if (fresh.plan.fingerprint !== file.fingerprint || moved.length) {
      return refuse(1, 'the accounts changed since this plan was made; plan again and review the new plan', moved.length ? { changed: moved } : {});
    }
  }

  const warnings = [...fresh.plan.warnings];
  if (dryRun) {
    return { code: 0, out: { ok: true, dryRun: true, primary: file.primary.id, changes: pending.length, actions: fresh.plan.actions.filter((a) => a.action !== 'skip'), conflicts: fresh.plan.conflicts, warnings, note: 'Nothing was written.' } };
  }

  const previous = readManifest(manifestPath);
  const working = manifest ? JSON.parse(JSON.stringify(manifest)) : { version: MANIFEST_VERSION, tool: TOOL, primary: file.primary.id, accounts: [] };
  working.primary = file.primary.id;
  working.primaryPathAbs = fresh.primary.pathAbs;
  const run = new Run(home, file.primary.id, seen);
  const done = [];
  let failed = 0;
  for (const step of fresh.steps) {
    const rec = accountRecord(working, fresh.info.get(step.account));
    const entry = { account: step.account, element: step.kind === 'mcp' ? 'mcp servers' : step.name };
    try {
      if (step.kind === 'except') { except(rec, step.name); continue; }
      if (step.kind === 'record') {
        const e = step.e;
        if (!rec.elements.some((x) => x.name === step.name)) upsert(rec, linkRecord(step.name, e.linkKind === 'hardlink' ? 'hardlink' : 'symlink', e.S, e.P, !!e.dir));
        continue;
      }
      let r;
      if (step.kind === 'link') r = { action: 'link', ...doLink(run, step, rec) };
      else if (step.kind === 'adopt') r = { action: 'adopt-into-primary', ...doAdopt(run, step, rec, file.primary.id) };
      else if (step.kind === 'drop') r = { action: 'drop', ...doDrop(run, step, rec) };
      else if (step.kind === 'instructions') { r = { action: 'generate', ...doInstructions(run, step, rec, home) }; if (step.pre === 'same') continue; } else if (step.kind === 'mcp') {
        r = doServers(run, step, rec);
        if (!r.changed.length) continue;
        r = { action: 'generate', servers: r.changed };
      } else continue;
      done.push({ ...entry, ...r, result: 'done' });
    } catch (err) {
      failed++;
      done.push({ ...entry, result: 'failed', ...(err && err.stale ? { stale: true } : {}), error: scrub(String(err && err.message ? err.message : err), home) });
    }
  }
  // Records with nothing left to manage, or for an account whose folder is gone, are dropped.
  working.accounts = working.accounts.filter((a) => (a.elements.length || a.exceptions.length) && isDir(a.pathAbs));

  const manifestChanged = previous ? stripVolatile(previous) !== stripVolatile(working) : working.accounts.length > 0;
  if (manifestChanged) {
    run.journal.manifest = { before: previous };
    writeManifest(working, manifestPath);
    run.journal.manifest.afterHash = hashFile(manifestPath);
  }
  const out = { ok: failed === 0, primary: file.primary.id, changed: done.filter((d) => d.result === 'done').length, failed, done, manifest: displayPath(manifestPath, home), warnings };
  if (run.stamp || manifestChanged) {
    run.journal.finishedAt = new Date().toISOString();
    run.save();
    out.stamp = run.stamp;
    out.backups = displayPath(run.dir(), home);
    out.undo = `node accounts.mjs undo --stamp ${run.stamp} --yes`;
  } else out.note = 'Nothing to do: every element already follows the primary.';

  // Keep an installed copy of the check in step with the skill.
  try {
    const stable = stableCheckPath(home);
    const mine = fileURLToPath(new URL('../../sync-check.mjs', import.meta.url));
    if (lstatSafe(stable) && hashFile(stable) !== hashFile(mine)) { writeAtomic(stable, fs.readFileSync(mine)); out.checkRefreshed = true; }
  } catch { /* not installed, or not writable: install-check reports it */ }
  return { code: failed ? 1 : 0, out };
}

// ---- undo -----------------------------------------------------------------------------------

/**
 * Undo one journal entry. In a dry run nothing is touched, so `seen` remembers what the earlier
 * entries would have removed or moved back; later entries are judged against that. `seen.pending`
 * lists the paths of the entries that could not be undone so far in this attempt.
 */
function undoOp(op, dryRun, seen, home = homeDir()) {
  const key = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const present = (p) => !!lstatSafe(p) && !(dryRun && seen.gone.has(key(p)));
  const now = (p) => (dryRun && seen.back.get(key(p))) || p; // where a moved-back original sits
  const remove = (p, fn) => { if (dryRun) seen.gone.add(key(p)); else fn(); return { ok: true }; };
  const act = (fn) => { if (!dryRun) fn(); return { ok: true }; };
  const conflict = (reason) => ({ ok: false, reason });
  if (op.op === 'link') {
    if (!present(op.path)) return { ok: true };
    if (op.kind === 'copy') return sameContent(op.path, op.target) ? remove(op.path, () => removeLink(op.path)) : conflict('edited since the run; left as it is');
    const st = linkStatus(op.path, op.target);
    if ((st.state === 'ok' && st.kind !== 'inherited') || st.state === 'dangling') return remove(op.path, () => removeLink(op.path));
    return conflict('no longer the link this run created; left as it is');
  }
  if (op.op === 'move') {
    if (present(op.from)) return conflict('something else is at the original place now; the backup was kept');
    if (!lstatSafe(op.to)) return conflict('the backup is missing');
    if (dryRun) { seen.gone.delete(key(op.from)); seen.back.set(key(op.from), op.to); return { ok: true }; }
    return act(() => movePath(op.to, op.from));
  }
  if (op.op === 'write') {
    if (!present(op.path)) return { ok: true };
    return hashFile(op.path) === op.hash ? remove(op.path, () => removeLink(op.path)) : conflict('edited since the run; left as it is');
  }
  if (op.op === 'patch') {
    const buf = readBuf(op.path, 64 * 1024 * 1024);
    if (buf === null) return conflict('the file is gone');
    if (sha256(buf) !== op.afterHash) return conflict('edited since the run; left as it is');
    if (op.created) return remove(op.path, () => removeLink(op.path));
    return act(() => writeKeepingLinks(op.path, revertPatch(buf.toString('utf8'), op.patch), { home }));
  }
  if (op.op === 'overwrite') {
    if (hashFile(op.path) !== op.afterHash) return conflict('the primary\'s file was edited since the run; its earlier version is in the backup');
    const data = readBuf(op.backup);
    if (data === null) return conflict('the backup is missing');
    return act(() => writeKeepingLinks(op.path, data, { home }));
  }
  if (op.op === 'create' || op.op === 'add') {
    if (!present(op.path)) return { ok: true };
    return compareTrees(op.path, now(op.like)) === 'same' ? remove(op.path, () => removeTree(op.path)) : conflict('changed in the primary since the run; left there');
  }
  if (op.op === 'mkdir') {
    if (dryRun || !lstatSafe(op.path)) return { ok: true };
    try { fs.rmdirSync(op.path); return { ok: true }; } catch { /* not empty */ }
    // While a step of this run inside the folder is still to be undone, the folder waits for
    // it and is tried again with it. Otherwise it holds something else now, and stays.
    return (seen.pending || []).some((p) => isInside(p, op.path)) ? { ok: false, waiting: true } : { ok: true };
  }
  return conflict('unknown journal entry');
}

export function listRuns(home = homeDir()) {
  const root = backupsDir(home);
  let names = [];
  try { names = fs.readdirSync(root); } catch { /* none yet */ }
  return names.filter((n) => lstatSafe(path.join(root, n, 'journal.json'))).sort();
}

/**
 * Undo one apply run: remove the links and generated files it created and move the originals
 * back, only where each thing is still as the run left it. Anything changed since is reported
 * as a conflict and left alone.
 *
 * Each journal entry is marked (`undoneAt`) the moment it is undone, and the run as a whole only
 * when every entry is. An undo that could not finish can therefore be run again: it skips what
 * is already undone and retries exactly what is still pending. `pending` in the result counts
 * those entries; `conflicts` says why each one could not be undone.
 */
export function undoRun({ stamp, yes = false, dryRun = false, home = homeDir() }) {
  const runs = listRuns(home);
  if (!stamp) return { code: 2, out: { ok: false, error: 'pass --stamp <stamp>', stamps: runs } };
  if (!/^[0-9]{8}-[0-9]{6}(-[0-9]+)?$/.test(stamp) || !runs.includes(stamp)) return { code: 2, out: { ok: false, error: 'no such run', stamps: runs } };
  if (!yes && !dryRun) return { code: 2, out: { ok: false, refused: true, error: 'undo changes the accounts on this machine: pass --yes, or --dry-run to see what it would do' } };
  const journalPath = path.join(backupsDir(home), stamp, 'journal.json');
  const j = parseJson(readText(journalPath));
  if (!j.ok || !j.value || j.value.version !== JOURNAL_VERSION || !Array.isArray(j.value.ops)) return { code: 1, out: { ok: false, error: 'the journal of that run cannot be read' } };
  const journal = j.value;
  if (journal.undoneAt) return { code: 0, out: { ok: true, stamp, note: 'This run was already undone.', restored: 0, removed: 0, conflicts: [], pending: 0 } };
  // Nothing more is undone once the journal cannot record it: the error stops the undo there.
  const save = () => {
    try { writeAtomic(journalPath, JSON.stringify(journal, null, 2) + '\n'); } catch (err) {
      throw new Error(`the journal of run ${stamp} could not be updated (${scrub(String(err && (err.code || err.message)), home)}); undo stopped there, run it again once that folder can be written`);
    }
  };
  const counts = { restored: 0, removed: 0 };
  const conflicts = [];
  const notes = [];
  const seen = { gone: new Set(), back: new Map(), pending: [] };
  let pending = 0;
  let already = 0;
  // Newest first. What an earlier attempt undid is not touched again.
  for (const op of [...journal.ops].reverse()) {
    if (op.undoneAt) { already++; continue; }
    let r;
    try { r = undoOp(op, dryRun, seen, home); } catch (err) { r = { ok: false, reason: scrub(String(err && err.message ? err.message : err), home) }; }
    if (!r.ok) {
      pending++;
      seen.pending.push(op.path || op.from);
      if (!r.waiting) conflicts.push({ path: displayPath(op.path || op.from, home), reason: r.reason });
      continue;
    }
    if (op.op === 'move' || op.op === 'patch' || op.op === 'overwrite') counts.restored++;
    else if (op.op !== 'mkdir') counts.removed++;
    // Recorded entry by entry, so an undo that is interrupted resumes exactly where it stopped.
    if (!dryRun) { op.undoneAt = new Date().toISOString(); save(); }
  }
  const complete = pending === 0;
  const m = journal.manifest;
  if (m && !dryRun && !m.settledAt) {
    // The manifest goes back with the FIRST attempt, whether or not entries are still pending.
    // A manifest that kept claiming the links this undo removed would have the session-start
    // check re-create them; and what is still pending is either something changed since the
    // run (no longer what the manifest recorded) or waits for the retry. Done once per run.
    const mf = manifestFile(home);
    if (hashFile(mf) === m.afterHash) {
      if (m.before) writeAtomic(mf, JSON.stringify(m.before, null, 2) + '\n');
      else removeLink(mf);
    } else {
      // The manifest moved on since the run (the check refreshed it): drop what no longer holds.
      pruneManifest(home);
      notes.push('The manifest had changed since the run, so it was not restored: the elements that no longer hold were dropped from it instead.');
    }
    m.settledAt = new Date().toISOString();
  }
  if (!dryRun) {
    // The run counts as undone only when nothing of it is left to undo.
    if (complete) journal.undoneAt = new Date().toISOString();
    save();
    if (!complete) notes.push(`${pending} step${pending === 1 ? ' is' : 's are'} still pending. Clear what "conflicts" reports and run the same undo again: it retries only what is pending.`);
  }
  const out = { ok: complete, stamp, ...(dryRun ? { dryRun: true } : {}), ...counts, conflicts, pending, ...(already ? { alreadyUndone: already } : {}), ...(notes.length ? { note: notes.join(' ') } : {}) };
  return { code: complete ? 0 : 1, out };
}

/** Drop from the manifest every element that is no longer what it records. */
function pruneManifest(home) {
  const mf = manifestFile(home);
  const manifest = readManifest(mf);
  if (!manifest) return;
  for (const a of manifest.accounts) {
    const servers = a.mcp ? readServers(a.mcp.path, a.mcp.format).servers : {};
    a.elements = a.elements.filter((el) => {
      if (el.kind === 'generated') return !!lstatSafe(el.path) && hashFile(el.path) === el.contentHash;
      if (el.kind === 'managed-block') { const s = servers[el.name.slice(MCP_PREFIX.length)]; return !!s && sha256(canon(s.def)) === el.contentHash; }
      return linkStatus(el.path, el.target).state === 'ok';
    });
  }
  manifest.accounts = manifest.accounts.filter((a) => a.elements.length);
  if (manifest.accounts.length) writeManifest(manifest, mf);
  else removeLink(mf);
}
