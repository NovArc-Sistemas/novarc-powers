// Review records, write side, and `run.mjs history` (references/follow-up.md).
//
// `close` writes one record per harness of the run, the same content as a `.md` to read, and
// history/index.json. `history --write` does it for a run that stays open. A run that already has
// records gets them written again by whatever changes a status afterwards (`decide`, `decisions`,
// `mark`, `record`, `undo`, `complete`), so a record always says what was decided and what is
// applied now. A record is made from the state as `build` assembles it (followup.mjs), goes
// through the same two barriers as the state (home paths, credentials), and is checked against
// templates/record.schema.json before anything is written. Every file is written with a temp
// file and a rename, under the run's mutex and the history folder's own: two runs can close at
// the same time.
//
// Making the records is the slow part: the whole state is assembled and harness files are read.
// It is never done while holding the run mutex, where a lock held that long could be taken for a
// dead one and broken (see `withRecords`).
import fs from 'node:fs';
import path from 'node:path';
import { normalizeInputPath } from '../common.mjs';
import { RunError, UsageError, Plain, readJson, readJsonl, readText, writeTextAtomic, toJsonText, withLock, sleepSync, sha256, nowIso, nowMs } from './store.mjs';
import { runPaths, runsDir, latestRunId, historyDir, historyIndexPath, historyMutex, RUN_ID_RE } from './paths.mjs';
import { homeMatchers, scrubDeep } from './scrub.mjs';
import { maskDeep } from './secrets.mjs';
import { isDateTime } from './schema.mjs';
import { loadFindings, loadItems, loadStatus, resolveGroups, resolveRunId, loadRun, inputsFingerprint } from './model.mjs';
import { assembleCurrent } from './build.mjs';
import { markClosed } from './init.mjs';
import { HARNESS_KEY_RE, harnessKeyOf, listRecords, forgetRecords, makeRecord, validateRecord, recordBaseName, loadThresholds } from './followup.mjs';
import { recordMarkdown, historyText } from './text.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const INDEX_SCHEMA = 1;
/** How often the records are made again because the run changed meanwhile, before the mutex is held throughout. */
const OPTIMISTIC_TRIES = 3;

function readIndex() {
  let index = null;
  try { index = readJson(historyIndexPath()); } catch { index = null; }
  if (!isObject(index) || !isObject(index.harnesses)) return { schema: INDEX_SCHEMA, harnesses: {} };
  return { schema: INDEX_SCHEMA, harnesses: { ...index.harnesses } };
}

/** The `reviews` of one harness in index.json: one line per record, oldest first. */
function reviewsOf(key) {
  return listRecords(key).map(({ name, record }) => ({
    runId: record.runId,
    reviewedAt: record.reviewedAt,
    file: name,
    score: record.scores.current,
    grade: record.scores.grade,
    fixed: record.items.filter((i) => i.status === 'fixed').length,
    followUpAfter: record.followUpAfter,
  }));
}

/** Write `text` to `file` unless it already holds exactly that. True when it was written. */
function put(file, text) {
  if (readText(file) === text) return false;
  writeTextAtomic(file, text);
  return true;
}

function readRun(paths) {
  const run = readJson(paths.run);
  if (!run || !Array.isArray(run.harnesses)) throw new RunError(`run ${paths.runId} not found`);
  return run;
}

/** The harnesses of the run that get a record: all of them, or only those that already have one. */
function targetsOf(run, onlyExisting) {
  const out = [];
  for (const h of run.harnesses) {
    const key = harnessKeyOf(h);
    const existing = listRecords(key).find((e) => e.record.runId === run.runId) || null;
    if (!onlyExisting || existing) out.push({ h, key, existing });
  }
  return out;
}

/**
 * Everything a record is made from, as one hash: what `build` reads, the ledger, the group ids
 * and whether the run is closed. The same hash before and after the records were made means
 * they say what the run directory says.
 */
function recordInputs(paths) {
  const run = readRun(paths);
  const hashOf = (file) => { const t = readText(file); return t === null ? '-' : sha256(t); };
  return sha256([inputsFingerprint(paths, run), run.closed === true, run.closedAt || '', hashOf(paths.ledger), hashOf(paths.groups)].join('\n'));
}

/** Give every group of the findings its id. Must run under the run mutex: it may write groups.json. */
function assignGroups(paths) {
  const run = readRun(paths);
  const findings = loadFindings(paths, run);
  const { items } = loadItems(paths, run, findings);
  resolveGroups(paths, run, findings, new Set(items.map((i) => i.id)), { assign: true });
}

/**
 * Test seam: NOVARC_HD_TEST_RECORDS_GATE names a file. Once the records are made, and before
 * anything is written, the command announces itself by creating `<file>.waiting` and goes on
 * only when `<file>` exists (or after 30 seconds). A test can then see that the run mutex is
 * free meanwhile, and change the run under it.
 */
function gateForTests() {
  const gate = process.env.NOVARC_HD_TEST_RECORDS_GATE;
  if (!gate) return;
  try { fs.writeFileSync(`${gate}.waiting`, ''); } catch { return; }
  for (let waited = 0; waited < 30000 && !fs.existsSync(gate); waited += 25) sleepSync(25);
}

/**
 * Make the records of a run without writing anything: `{ run, records: [{ h, key, record }] }`.
 * This is the slow part. Nothing is returned for writing unless every record fits its schema.
 * Group ids must have been assigned (`assignGroups`).
 */
function prepare(paths, { at, onlyExisting }) {
  const run = readRun(paths);
  const targets = targetsOf(run, onlyExisting);
  if (!targets.length) return { run, records: [] };
  const t = loadThresholds();
  const { state } = assembleCurrent({ paths, run }, { assign: false });
  const status = loadStatus(paths);
  const ledger = readJson(paths.ledger) || { entries: [] };
  const events = readJsonl(paths.log).filter((l) => l.value).map((l) => l.value);
  const matchers = homeMatchers();
  const records = [];
  const problems = [];
  for (const { h, key, existing } of targets) {
    let raw = null;
    try { raw = readJson(path.join(paths.probeDir(h.id), 'impact.json')); } catch { raw = null; }
    // The review ended when the run was closed: writing its record again keeps that moment.
    const closedAt = isDateTime(run.closedAt) ? run.closedAt : at;
    const reviewedAt = run.closed === true ? (existing ? existing.record.reviewedAt : closedAt) : at;
    const made = makeRecord({ state, run, h, status, ledger, events, raw: isObject(raw) ? raw : null, reviewedAt, t });
    // The same two barriers as the state: no absolute home path, no credential.
    const record = maskDeep(scrubDeep(made, matchers));
    for (const e of validateRecord(record).slice(0, 10)) problems.push(`${h.id}: ${e}`);
    records.push({ h, key, record });
  }
  if (problems.length) throw new RunError('a review record does not fit templates/record.schema.json; nothing was written', { errors: problems.slice(0, 50) });
  gateForTests();
  return { run, records };
}

/**
 * Write prepared records, their `.md` and the index, under the history mutex. Returns one entry
 * per record: `{ harness, harnessKey, file, md, items, fixed, written }`, `file` and `md`
 * relative to the history folder, `written` false when the files already held exactly this.
 */
function commit({ run, records }) {
  if (!records.length) return [];
  const base = recordBaseName(run.runId, run.createdAt);
  return withLock(historyMutex(), () => {
    const index = readIndex();
    const out = [];
    for (const { h, key, record } of records) {
      const dir = path.join(historyDir(), key);
      const wroteJson = put(path.join(dir, `${base}.json`), toJsonText(record));
      const wroteMd = put(path.join(dir, `${base}.md`), recordMarkdown(record, run.language));
      forgetRecords(key);
      // The one place that keeps the absolute path of the harness.
      index.harnesses[key] = { kind: record.kind, provider: record.provider, name: record.name, path: record.path, pathAbs: h.pathAbs, reviews: reviewsOf(key) };
      out.push({
        harness: h.id, harnessKey: key, file: `${key}/${base}.json`, md: `${key}/${base}.md`,
        items: record.items.length, fixed: record.items.filter((i) => i.status === 'fixed').length, written: wroteJson || wroteMd,
      });
    }
    const sorted = {};
    for (const key of Object.keys(index.harnesses).sort()) sorted[key] = index.harnesses[key];
    put(historyIndexPath(), toJsonText({ schema: INDEX_SCHEMA, harnesses: sorted }));
    return out;
  });
}

/**
 * Write the review records of a run and, right after and under the same hold of the run mutex,
 * do `then` (that is how `close` marks the run closed). Returns `{ records, extra }`, `extra`
 * being what `then` returned. Must NOT be called while holding the run mutex.
 *
 * The records are made without the mutex and written under it only when the run directory still
 * is what they were made from (`recordInputs`); otherwise they are made again. So the mutex is
 * only ever held for a few file reads and writes, and a slow assemble cannot have the lock taken
 * for a stale one. A run that changes faster than its records can be made, OPTIMISTIC_TRIES
 * times in a row, gets them made under the mutex after all, with the lock refreshed before each
 * slow step.
 *   at            this moment (ISO): the `reviewedAt` of a run that is still open
 *   onlyExisting  write again the records the run already has, and no new one
 */
function withRecords(ctx, { at = nowIso(), onlyExisting = false } = {}, then = null) {
  const { paths } = ctx;
  for (let attempt = 0; attempt < OPTIMISTIC_TRIES; attempt++) {
    const before = withLock(paths.mutex, () => { assignGroups(paths); return recordInputs(paths); });
    const made = prepare(paths, { at, onlyExisting });
    const done = withLock(paths.mutex, () => {
      if (recordInputs(paths) !== before) return null; // the run changed while its records were being made
      return { records: commit(made), extra: then ? then() : undefined };
    });
    if (done) return done;
  }
  return withLock(paths.mutex, (lock) => {
    assignGroups(paths);
    lock.touch();
    const made = prepare(paths, { at, onlyExisting });
    lock.touch();
    return { records: commit(made), extra: then ? then() : undefined };
  });
}

/** Write the review record of every harness of the run (see `withRecords`). Returns the entries written. */
export function writeRunRecords(ctx, opts = {}) {
  return withRecords(ctx, opts).records;
}

/**
 * A status of the run changed (a decision, an applied change, an undo, new findings): when the
 * run already left review records, write them again. `out` is the command's answer; it gains
 * `records` (what was written) or `recordsNotWritten` (why not). It never fails the command:
 * what the command did is already done. Must NOT be called while holding the run mutex.
 */
export function refreshRecords(ctx, out) {
  try {
    // Most runs have no record yet: nothing to do, and no lock to take.
    if (!targetsOf(readRun(ctx.paths), true).length) return out;
    const { records } = withRecords(ctx, { at: nowIso(), onlyExisting: true });
    if (records.length) out.records = records;
  } catch (e) {
    out.recordsNotWritten = e instanceof RunError ? e.message : 'the review records could not be written again';
  }
  return out;
}

/**
 * `run.mjs close`: write the review record of every harness, then mark the run closed. Closing a
 * run that is already closed changes nothing, except that a run closed before records existed
 * gets them.
 */
export function closeRun(ctx) {
  const at = nowIso();
  const { records, extra } = withRecords(ctx, { at }, () => {
    const run = readRun(ctx.paths);
    if (run.closed === true) return { runId: ctx.paths.runId, closed: true, closedAt: run.closedAt || null, already: true };
    return markClosed(ctx, at);
  });
  return { ...extra, historyDir: historyDir(), records };
}

/**
 * Runs that have a board but left no review record: closed before records existed, or abandoned.
 * The latest run, while it is open, is work in progress and is not listed.
 */
export function unrecordedRuns(limit = 25) {
  let ids = [];
  try { ids = fs.readdirSync(runsDir()).filter((n) => RUN_ID_RE.test(n)).sort().reverse().slice(0, limit); } catch { return []; }
  const latest = latestRunId();
  const out = [];
  for (const id of ids) {
    const p = runPaths(id);
    if (!fs.existsSync(p.state)) continue;
    let run = null;
    try { run = readJson(p.run); } catch { run = null; }
    if (!run || !Array.isArray(run.harnesses) || (id === latest && run.closed !== true)) continue;
    if (!run.harnesses.some((h) => listRecords(harnessKeyOf(h)).some((e) => e.record.runId === id))) out.push(id);
  }
  return out.sort();
}

const samePath = (a, b) => {
  const norm = (p) => {
    let real = path.resolve(p);
    try { real = fs.realpathSync.native(real); } catch { /* gone: as written */ }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
};

/** What `history` answers: every harness reviewed on this machine, its reviews, and what is due. */
function historyReport(wanted) {
  const now = nowMs();
  const index = readIndex();
  let keys = Object.keys(index.harnesses);
  try { keys = keys.concat(fs.readdirSync(historyDir()).filter((n) => HARNESS_KEY_RE.test(n))); } catch { /* no history yet */ }
  const harnesses = [];
  for (const key of [...new Set(keys)].sort()) {
    const records = listRecords(key);
    if (!records.length) continue;
    const last = records[records.length - 1].record;
    const pathAbs = isObject(index.harnesses[key]) && typeof index.harnesses[key].pathAbs === 'string' ? index.harnesses[key].pathAbs : null;
    if (wanted !== undefined) {
      const display = wanted.replace(/\\/g, '/').replace(/\/+$/, '');
      let hit = wanted === key || display === last.path;
      if (!hit && pathAbs) { try { hit = samePath(normalizeInputPath(wanted), pathAbs); } catch { hit = false; } }
      if (!hit) continue;
    }
    harnesses.push({
      key, kind: last.kind, provider: last.provider, name: last.name, path: last.path,
      reviews: records.map(({ record }) => ({
        runId: record.runId,
        reviewedAt: record.reviewedAt,
        score: record.scores.current,
        grade: record.scores.grade,
        fixed: record.items.filter((i) => i.status === 'fixed').length,
        expectedTokens: record.items.filter((i) => i.status === 'fixed' && i.saves).reduce((sum, i) => sum + i.saves.tokens, 0),
        followUpAfter: record.followUpAfter,
      })),
      followUpAfter: last.followUpAfter,
      due: Date.parse(last.followUpAfter) <= now,
    });
  }
  return {
    historyDir: historyDir(),
    at: new Date(now).toISOString(),
    harnesses,
    due: harnesses.filter((h) => h.due).map((h) => h.key),
    unrecordedRuns: unrecordedRuns(),
  };
}

/** The language of the latest run: what `history` speaks when `--lang` does not say. */
function latestLanguage() {
  const id = latestRunId();
  if (!id) return 'en';
  try { const run = readJson(runPaths(id).run); return run && run.language === 'pt' ? 'pt' : 'en'; } catch { return 'en'; }
}

/**
 * `history [--harness <key|path>] [--json] [--lang pt|en]`: what was reviewed, when, and which
 * follow-ups are due; text for a person unless `--json`.
 * `history --write [--run <id>]`: write the records of a run without closing it.
 */
export function history(args) {
  if (args.write !== undefined) {
    if (args.write !== true) throw new UsageError('--write takes no value');
    if (args.harness !== undefined || args.json !== undefined || args.lang !== undefined) throw new UsageError('history --write takes only --run <id>');
    const ctx = loadRun(resolveRunId(args));
    const records = writeRunRecords(ctx, { at: nowIso() });
    return { runId: ctx.paths.runId, closed: readRun(ctx.paths).closed === true, historyDir: historyDir(), records };
  }
  if (args.run !== undefined) throw new UsageError('--run goes with --write: without it, history lists every harness reviewed on this machine');
  if (args.json !== undefined && args.json !== true) throw new UsageError('--json takes no value');
  if (args.harness !== undefined && (typeof args.harness !== 'string' || !args.harness.trim())) throw new UsageError('--harness takes a harness key or the path of the harness');
  if (args.lang !== undefined && !['pt', 'en'].includes(args.lang)) throw new UsageError('--lang must be pt or en');
  const report = historyReport(args.harness === undefined ? undefined : args.harness.trim());
  if (args.json === true) return report;
  return new Plain(historyText(report, args.lang || latestLanguage(), { filtered: args.harness !== undefined }));
}
