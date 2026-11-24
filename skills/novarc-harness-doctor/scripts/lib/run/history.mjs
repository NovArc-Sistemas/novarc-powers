// Review records, write side, and `run.mjs history` (references/follow-up.md).
//
// `close` writes one record per harness of the run, the same content as a `.md` to read, and
// history/index.json. `history --write` does it for a run that stays open. A run that already has
// records gets them written again by whatever changes a status afterwards (`decide`, `decisions`,
// `mark`, `record`, `undo`, `complete`), so a record always says what was decided and what is
// applied now. A record is made from the state as `build` assembles it (followup.mjs), passes the
// barrier every record passes when it is read (records.mjs: home paths, the prose policy,
// credentials), and is checked against templates/record.schema.json before anything is written.
// Every file is written with a temp file and a rename, under the run's mutex and the history
// folder's own: two runs can close at the same time.
//
// The records are the truth of the history folder. The `.md` beside each one and index.json are
// made from them, so whatever a crash left behind (a record without its `.md`, an index that does
// not know a record, a run that wrote its records and was never marked closed) is put right by
// the next `history`, `init` or `close`: `healHistory` writes what is missing or differs, and
// `close` on a run that has records but is not closed writes them again and closes it.
//
// Making the records is the slow part: the whole state is assembled and harness files are read.
// It is never done while holding the run mutex, where a lock held that long could be taken for a
// dead one and broken (see `withRecords`).
import fs from 'node:fs';
import path from 'node:path';
import { normalizeInputPath } from '../common.mjs';
import { RunError, UsageError, Plain, readJson, readJsonl, readText, writeTextAtomic, toJsonText, withLock, sleepSync, sha256, nowIso, nowMs } from './store.mjs';
import { runPaths, runsDir, latestRunId, historyDir, historyIndexPath, historyMutex, homeBase, RUN_ID_RE } from './paths.mjs';
import { isDateTime } from './schema.mjs';
import { loadFindings, loadItems, loadStatus, resolveGroups, resolveRunId, loadRun, inputsFingerprint } from './model.mjs';
import { assembleCurrent } from './build.mjs';
import { markClosed } from './init.mjs';
import { limits, harnessKeyOf, ownsPath, harnessKeys, readIndexText, indexedPaths, holdsText, listRecords, ignoredRecords, starved, forgetRecords, recheckRecords, validateRecord, recordBaseName, sanitizeRecord } from './records.mjs';
import { makeRecord, slimRecord, loadThresholds } from './followup.mjs';
import { recordMarkdown, historyText } from './text.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const INDEX_SCHEMA = 1;
/** How often the records are made again because the run changed meanwhile, before the mutex is held throughout. */
const OPTIMISTIC_TRIES = 3;

/**
 * Write `text` to `file` unless it already holds exactly that. True when it was written. What is
 * there is read only when it has the size of `text` (`holdsText`): a file of the history folder
 * is never read whole just to be replaced.
 */
function put(file, text) {
  if (holdsText(file, text) === 'same') return false;
  writeTextAtomic(file, text);
  return true;
}

function readRun(paths) {
  const run = readJson(paths.run);
  if (!run || !Array.isArray(run.harnesses)) throw new RunError(`run ${paths.runId} not found`);
  return run;
}

/**
 * Test seam: NOVARC_HD_TEST_CRASH_AT names a point (`record-json`, `record-md`, `index`); the
 * process dies there the way a killed one does, with its locks left behind. A test can then see
 * what the next command makes of the half-written history.
 */
function crashForTests(point) {
  if (process.env.NOVARC_HD_TEST_CRASH_AT !== point) return;
  try { process.kill(process.pid, 'SIGKILL'); } catch { /* fall through */ }
  process.exit(137);
}

// ---------------------------------------------------------------------------------------------
// index.json: a cache of the records
// ---------------------------------------------------------------------------------------------

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

/** The folder a display path names on this machine, or null. */
function expandDisplay(display) {
  if (typeof display !== 'string' || !display) return null;
  if (display === '~') return homeBase();
  if (display.startsWith('~/')) return path.join(homeBase(), display.slice(2));
  return path.isAbsolute(display) ? path.normalize(display) : null;
}

/**
 * The absolute path of the harness `key` names: the one place a record does not keep. It is
 * taken from whoever can say it (the run that is writing, the index as it was, the display path
 * of the last record, the run directories of its records) and kept only when it is that
 * harness's own: the key holds the hash of the path. null when nobody can say.
 */
function pathOf(key, records, hints, indexed) {
  const last = records[records.length - 1].record;
  for (const candidate of [hints.get(key), indexed.get(key), expandDisplay(last.path)]) {
    if (ownsPath(key, last, candidate)) return candidate;
  }
  for (const { record } of records.slice(-5).reverse()) {
    let run = null;
    try { run = RUN_ID_RE.test(record.runId) ? readJson(runPaths(record.runId).run) : null; } catch { run = null; }
    const h = run && Array.isArray(run.harnesses) ? run.harnesses.find((x) => isObject(x) && x.harnessKey === key) : null;
    if (h && ownsPath(key, last, h.pathAbs)) return h.pathAbs;
  }
  return null;
}

/**
 * index.json as the records say it should be. Nothing of the index on disk is trusted but the
 * absolute path of each harness, and that only after `ownsPath` (see `pathOf`). `hints` gives
 * the path of the harnesses a run is writing right now, `indexText` the index as it is on disk
 * (`readIndexText`). null when this command could not read every record (a history larger than
 * one command reads): an index is then not made at all, rather than made from a part.
 */
function expectedIndex(hints, indexText) {
  const indexed = indexedPaths(indexText);
  const harnesses = {};
  for (const key of harnessKeys()) {
    const records = listRecords(key);
    if (starved(key)) return null;
    if (!records.length) continue;
    const last = records[records.length - 1].record;
    harnesses[key] = { kind: last.kind, provider: last.provider, name: last.name, path: last.path, pathAbs: pathOf(key, records, hints, indexed), reviews: reviewsOf(key) };
  }
  return toJsonText({ schema: INDEX_SCHEMA, harnesses });
}

/** The language a run was held in, when its directory is still there. */
function languageOfRun(runId) {
  try {
    const run = RUN_ID_RE.test(runId) ? readJson(runPaths(runId).run) : null;
    return run && (run.language === 'pt' || run.language === 'en') ? run.language : null;
  } catch { return null; }
}

/**
 * What the history folder lacks or holds differently from what its records say: `{ md, index }`.
 * A `.md` is compared without being read unless it has the size it should have, and the index is
 * read once; both count against what a command may read. What cannot be told for lack of that
 * budget is left for the next command.
 */
function pendingRepairs() {
  const md = [];
  for (const key of harnessKeys()) {
    for (const { file, record } of listRecords(key)) {
      const mdFile = file.replace(/\.json$/, '.md');
      // A record that says its language gets its `.md` back whenever it differs; an older one
      // only when it is missing, in the language of its run when that can still be told.
      const text = recordMarkdown(record, record.language || languageOfRun(record.runId) || 'en');
      const have = holdsText(mdFile, text);
      if (have === 'missing' || (have === 'differs' && record.language)) md.push({ file: mdFile, text });
    }
  }
  const current = readIndexText();
  const index = expectedIndex(new Map(), current.text);
  // An index that could not be read for lack of budget is not known to differ.
  return { md, index: index === null || current.reason === 'over-total-budget' || current.text === index ? null : index };
}

/**
 * Put the history folder back in line with its records: a missing or outdated `.md`, and an
 * index.json that is missing, unreadable or says something else. `{ index, md }`: whether the
 * index was written, and how many `.md`. It never fails: a history that cannot be repaired now
 * is repaired by the next command, and the records alone are what a run reads.
 */
export function healHistory() {
  const healed = { index: false, md: 0 };
  try {
    if (!fs.existsSync(historyDir())) return healed;
    const first = pendingRepairs();
    if (first.index === null && !first.md.length) return healed;
    withLock(historyMutex(), (lock) => {
      // Someone may have written between the look and the lock: look again, now alone.
      for (const key of harnessKeys()) recheckRecords(key);
      const todo = pendingRepairs();
      for (const { file, text } of todo.md) {
        if (!lock.held()) return; // taken over: whoever holds it now does the rest
        lock.touch();
        if (put(file, text)) healed.md++;
      }
      if (todo.index !== null && lock.held()) healed.index = put(historyIndexPath(), todo.index);
    });
  } catch { /* the next command tries again */ }
  return healed;
}

// ---------------------------------------------------------------------------------------------
// Writing the records of a run
// ---------------------------------------------------------------------------------------------

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
 * Make the records of a run without writing anything:
 * `{ run, records: [{ h, key, record, json }] }`. This is the slow part. Nothing is returned for
 * writing unless every record fits its schema and the size a record may have.
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
  // The items as the findings files hold them: what each revision is a hash of.
  const stored = new Map();
  for (const { data } of loadFindings(paths, run)) {
    for (const i of Array.isArray(data.items) ? data.items : []) if (isObject(i) && typeof i.id === 'string' && !stored.has(i.id)) stored.set(i.id, i);
  }
  const max = limits().recordBytes;
  const records = [];
  const problems = [];
  for (const { h, key, existing } of targets) {
    let raw = null;
    try { raw = readJson(path.join(paths.probeDir(h.id), 'impact.json')); } catch { raw = null; }
    // The review ended when the run was closed: writing its record again keeps that moment.
    const closedAt = isDateTime(run.closedAt) ? run.closedAt : at;
    const reviewedAt = run.closed === true ? (existing ? existing.record.reviewedAt : closedAt) : at;
    const made = makeRecord({ state, run, h, status, ledger, events, stored, raw: isObject(raw) ? raw : null, reviewedAt, t });
    // The barrier a record passes when it is read: what is written is what a later run sees.
    const record = sanitizeRecord(made);
    let json = toJsonText(record);
    // A record over the size that is read back loses the text of its changes, the unapplied ones first.
    for (const fixedToo of [false, true]) {
      if (Buffer.byteLength(json) <= max) break;
      if (slimRecord(record, fixedToo)) json = toJsonText(record);
    }
    if (Buffer.byteLength(json) > max) problems.push(`${h.id}: the record is larger than ${max} bytes even without the text of its changes`);
    for (const e of validateRecord(record).slice(0, 10)) problems.push(`${h.id}: ${e}`);
    records.push({ h, key, record, json });
  }
  if (problems.length) throw new RunError('a review record does not fit templates/record.schema.json; nothing was written', { errors: problems.slice(0, 50) });
  gateForTests();
  return { run, records };
}

/**
 * Write prepared records, their `.md` and the index, under the history mutex. Returns one entry
 * per record: `{ harness, harnessKey, file, md, items, fixed, written }`, `file` and `md`
 * relative to the history folder, `written` false when the files already held exactly this.
 * The record goes first: it is the truth, and a crash after it leaves only what `healHistory`
 * makes again.
 */
function commit({ run, records }) {
  if (!records.length) return [];
  const base = recordBaseName(run.runId, run.createdAt);
  return withLock(historyMutex(), () => {
    const out = [];
    const hints = new Map();
    for (const { h, key, record, json } of records) {
      const dir = path.join(historyDir(), key);
      const wroteJson = put(path.join(dir, `${base}.json`), json);
      crashForTests('record-json');
      const wroteMd = put(path.join(dir, `${base}.md`), recordMarkdown(record, record.language));
      forgetRecords(key);
      hints.set(key, h.pathAbs);
      out.push({
        harness: h.id, harnessKey: key, file: `${key}/${base}.json`, md: `${key}/${base}.md`,
        items: record.items.length, fixed: record.items.filter((i) => i.status === 'fixed').length, written: wroteJson || wroteMd,
      });
    }
    crashForTests('record-md');
    // The index is made from the records, every time: another run may have written since this
    // process last looked at a harness.
    for (const key of harnessKeys()) if (!hints.has(key)) recheckRecords(key);
    const index = expectedIndex(hints, readIndexText().text);
    if (index !== null) put(historyIndexPath(), index);
    crashForTests('index');
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
 * slow step; should the lock be lost all the same (one step outlived the stale time), nothing is
 * written and the command says so.
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
    if (!lock.held()) throw new RunError('the lock of the run directory was lost while the review records were being made; nothing was written, run the command again');
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

/** `healed` for an answer, when something was put right. */
function healedPart() {
  const healed = healHistory();
  return healed.index || healed.md ? { healed } : {};
}

/**
 * `run.mjs close`: write the review record of every harness, then mark the run closed. Closing a
 * run that is already closed changes nothing, except that a run closed before records existed
 * gets them. A run whose records were written and that was never marked closed (the command died
 * in between) is closed here like any other.
 */
export function closeRun(ctx) {
  const at = nowIso();
  const { records, extra } = withRecords(ctx, { at }, () => {
    const run = readRun(ctx.paths);
    if (run.closed === true) return { runId: ctx.paths.runId, closed: true, closedAt: run.closedAt || null, already: true };
    return markClosed(ctx, at);
  });
  return { ...extra, historyDir: historyDir(), records, ...healedPart() };
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

// ---------------------------------------------------------------------------------------------
// `run.mjs history`
// ---------------------------------------------------------------------------------------------

/**
 * What `history` answers: every harness reviewed on this machine, its reviews, what is due, and
 * what was found in the history folder that is not a record. Everything comes from the records;
 * the index is not read for it.
 */
function historyReport(wanted) {
  const now = nowMs();
  const harnesses = [];
  const ignored = [];
  for (const key of harnessKeys()) {
    const records = listRecords(key);
    let hit = wanted === undefined || wanted === key;
    if (!hit && records.length) {
      const last = records[records.length - 1].record;
      hit = wanted.replace(/\\/g, '/').replace(/\/+$/, '') === last.path;
      // A path names a harness when it gives the hash its key ends in.
      if (!hit) { try { hit = ownsPath(key, last, normalizeInputPath(wanted)); } catch { hit = false; } }
    }
    if (!hit) continue;
    for (const x of ignoredRecords(key)) ignored.push({ harness: key, file: x.file, ...(x.count ? { count: x.count } : {}), reason: x.reason });
    if (!records.length) continue;
    const last = records[records.length - 1].record;
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
    ...(ignored.length ? { ignored } : {}),
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
 * follow-ups are due; text for a person unless `--json`. It first puts the history folder back in
 * line with its records (`healHistory`).
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
  const healed = healedPart();
  const report = { ...historyReport(args.harness === undefined ? undefined : args.harness.trim()), ...healed };
  if (args.json === true) return report;
  return new Plain(historyText(report, args.lang || latestLanguage(), { filtered: args.harness !== undefined }));
}
