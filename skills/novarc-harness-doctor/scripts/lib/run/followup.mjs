// Review records, read side, and the follow-up (references/follow-up.md).
//
// Every review leaves one record per harness under <home>/.novarc-powers/novarc-harness-doctor/
// history/<harnessKey>/. This module is what a run needs from them: the stable key of a harness,
// its records, the comparable metrics of a measurement, the comparison of "then" with "now", the
// on-disk check of what was applied, the history of a finding, and the record of the present
// review. history.mjs writes the files and answers `run.mjs history`.
//
// Nothing here writes, and nothing here reads the clock: "now" is the end of the measured window,
// so the same inputs always give the same comparison. The on-disk check reads harness files
// through the absolute paths of run.json, read-only; only its verdict leaves this module.
import fs from 'node:fs';
import path from 'node:path';
import { RunError, readJson, sha256 } from './store.mjs';
import { SKILL_DIR, homeBase, historyDir } from './paths.mjs';
import { slugify } from './ids.mjs';
import { loadStateSchema, validate, def, isDateTime } from './schema.mjs';
import { maskCredentials } from './secrets.mjs';
import { scoreHarness, wasteOf } from '../scoring.mjs';

export const RECORD_SCHEMA = 1;
const DAY = 86400000;
const MAX_CHECK_BYTES = 4 * 1024 * 1024;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' ? v : '');
const round1 = (x) => Math.round(x * 10) / 10;
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------------------------

const THRESHOLD_KEYS = ['followUpAfterDays', 'minDays', 'minSessions', 'confirmedShare', 'partialShare', 'noisePct'];
let thresholds;

/**
 * The numbers a comparison is judged with, from references/catalog/follow-up.json. They are
 * never in code: without that file there is no comparison and no record.
 */
export function loadThresholds() {
  if (thresholds) return thresholds;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'references', 'catalog', 'follow-up.json'), 'utf8')); } catch { raw = null; }
  if (!isObject(raw) || THRESHOLD_KEYS.some((k) => !isNum(raw[k]) || raw[k] < 0)) {
    throw new RunError('references/catalog/follow-up.json is missing or incomplete: the skill folder is incomplete');
  }
  thresholds = Object.fromEntries(THRESHOLD_KEYS.map((k) => [k, raw[k]]));
  return thresholds;
}

// ---------------------------------------------------------------------------------------------
// The key of a harness
// ---------------------------------------------------------------------------------------------

export const HARNESS_KEY_RE = /^[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/;
const keyMemo = new Map();

/**
 * The 8 hex characters that tell one harness from another: the start of a SHA-256 over its kind,
 * its provider (empty for a project) and its real absolute path, joined by line feeds. The path
 * is lower-cased on Windows, where case does not tell two folders apart.
 */
export function harnessHash(h) {
  let real = path.resolve(str(h.pathAbs));
  try { real = fs.realpathSync.native(real); } catch { /* the folder is gone: the path as it was written */ }
  if (process.platform === 'win32') real = real.toLowerCase();
  return sha256([str(h.kind), str(h.provider), real].join('\n')).slice(0, 8);
}

/**
 * `<slug of the name>-<8 hex>`: the name of the harness's folder under history/. `h` is a harness
 * entry of run.json; the key `init` wrote there wins. The name of a harness can change between
 * runs (an account label follows the language of the run), so a folder that already holds the
 * records of this same kind, provider and path keeps its name.
 */
export function harnessKeyOf(h) {
  if (typeof h.harnessKey === 'string' && HARNESS_KEY_RE.test(h.harnessKey)) return h.harnessKey;
  const memo = JSON.stringify([historyDir(), h.kind, h.provider, h.pathAbs, h.name]);
  if (keyMemo.has(memo)) return keyMemo.get(memo);
  const hash = harnessHash(h);
  let existing = null;
  try { existing = fs.readdirSync(historyDir()).filter((n) => n.endsWith(`-${hash}`) && HARNESS_KEY_RE.test(n)).sort()[0] || null; } catch { existing = null; }
  const key = existing || `${slugify(h.name, h.kind === 'user' ? 'account' : 'project')}-${hash}`;
  keyMemo.set(memo, key);
  return key;
}

/** File name of a record, without extension: the run id, which starts with the day it started. */
export function recordBaseName(runId, startedAt) {
  if (/^\d{8}-/.test(runId)) return runId;
  const day = isDateTime(startedAt) ? startedAt.slice(0, 10).replace(/-/g, '') : '00000000';
  return `${day}-${runId}`;
}

// ---------------------------------------------------------------------------------------------
// The record schema
// ---------------------------------------------------------------------------------------------

let recordSchema;
function loadRecordSchema() {
  if (recordSchema !== undefined) return recordSchema;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'templates', 'record.schema.json'), 'utf8'));
    recordSchema = s && s.properties && s.properties.schema && s.properties.schema.const === RECORD_SCHEMA ? s : null;
  } catch { recordSchema = null; }
  return recordSchema;
}

/**
 * Errors of `record` against templates/record.schema.json; its `outcome` is checked against the
 * `followUp` definition of the state schema, which is where that object comes from.
 */
export function validateRecord(record) {
  const schema = loadRecordSchema();
  if (!schema) throw new RunError('templates/record.schema.json (schema 1) not found: the skill folder is incomplete');
  const errors = validate(record, schema);
  if (isObject(record) && isObject(record.outcome)) {
    const state = loadStateSchema();
    const followUp = state ? def(state.schema, 'followUp') : null;
    if (followUp) validate(record.outcome, followUp, state.schema, '/outcome', errors);
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------
// Reading records
// ---------------------------------------------------------------------------------------------

const cache = new Map();

/** Forget what was read (after a write). Without a key, everything. */
export function forgetRecords(key) {
  if (key === undefined) cache.clear(); else cache.delete(key);
}

function readRecords(key) {
  if (cache.has(key)) return cache.get(key);
  const dir = path.join(historyDir(), key);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { names = []; }
  const records = [];
  const invalid = [];
  for (const name of names) {
    let record = null;
    try { record = readJson(path.join(dir, name)); } catch { record = null; }
    // A record that does not fit its schema is left out: what it holds would reach the state.
    if (!isObject(record) || record.harnessKey !== key || validateRecord(record).length) { invalid.push(name); continue; }
    records.push({ file: path.join(dir, name), name, record });
  }
  records.sort((a, b) => Date.parse(a.record.reviewedAt) - Date.parse(b.record.reviewedAt) || a.record.runId.localeCompare(b.record.runId));
  const out = { records, invalid };
  cache.set(key, out);
  return out;
}

/** Every valid record of a harness key, oldest first: `[{ file, name, record }]`. */
export function listRecords(key) { return readRecords(key).records; }
/** File names under history/<key>/ that are not valid records. */
export function invalidRecords(key) { return readRecords(key).invalid; }

/**
 * The records of earlier reviews of harness `h` (an entry of run.json), oldest first: every
 * record of another run that started before this one did.
 */
export function earlierRecords(run, h) {
  const started = Date.parse(run.createdAt);
  return listRecords(harnessKeyOf(h)).filter((e) => e.record.runId !== run.runId && !(Date.parse(e.record.startedAt) >= started));
}

/**
 * The record this run compares harness `h` with: the one `init` found (its window was chosen
 * from it), else the latest earlier one. null for a harness that was never reviewed.
 */
export function lastRecordOf(run, h) {
  const list = earlierRecords(run, h);
  if (!list.length) return null;
  const pinned = isObject(h.lastRecord) ? list.find((e) => e.record.runId === h.lastRecord.runId) : null;
  return pinned || list[list.length - 1];
}

/** The item `previous` points at in the earlier records of `h`: `{ entry, item }`, or null. */
export function previousItem(run, h, previous) {
  if (!h || !isObject(previous) || typeof previous.run !== 'string' || typeof previous.item !== 'string') return null;
  const entry = earlierRecords(run, h).find((e) => e.record.runId === previous.run);
  const item = entry ? entry.record.items.find((i) => i.id === previous.item) : null;
  return item ? { entry, item } : null;
}

/**
 * What happened to a finding before (`items[].history` of the state), following `previous` from
 * record to record. `{ history, last }`, or null when `previous` points at nothing.
 */
export function itemHistory(run, h, previous) {
  const first = previousItem(run, h, previous);
  if (!first) return null;
  let oldest = first;
  let times = 1;
  const seen = new Set([`${previous.run}\n${previous.item}`]);
  for (let link = first.item.previous; times < 100; link = oldest.item.previous) {
    const next = previousItem(run, h, link);
    if (!next || seen.has(`${link.run}\n${link.item}`)) break;
    seen.add(`${link.run}\n${link.item}`);
    oldest = next;
    times++;
  }
  const history = { firstSeenAt: oldest.entry.record.reviewedAt, times, lastStatus: first.item.status };
  const d = first.item.decision;
  if (isObject(d) && isDateTime(d.at)) history.lastDecisionAt = d.at;
  if (isObject(d) && typeof d.note === 'string' && d.note) history.lastNote = d.note;
  return { history, last: first };
}

/** `harnesses[].history` of the state: one line per earlier review, oldest first. */
export function harnessHistory(entries) {
  return entries.map(({ record }) => ({
    runId: record.runId,
    reviewedAt: record.reviewedAt,
    score: isNum(record.scores.current) ? record.scores.current : null,
    grade: typeof record.scores.grade === 'string' ? record.scores.grade : null,
    fixed: record.items.filter((i) => i.status === 'fixed').length,
    tokensPerSession: record.measure && isNum(record.measure.metrics['tokens-per-session']) ? Math.round(record.measure.metrics['tokens-per-session']) : null,
  }));
}

// ---------------------------------------------------------------------------------------------
// Comparable metrics
// ---------------------------------------------------------------------------------------------

export const WASTE_KINDS = ['retry', 'loop', 'notfound', 'correction', 'hook-block', 'error-end', 'exploration'];
/** Every comparable metric, in the order they are shown: `$defs.metric` of the state schema. */
export const METRICS = ['tokens-per-session', 'weighted-per-session', 'context-at-start', 'context-peak', 'waste-share', ...WASTE_KINDS.map((k) => `waste:${k}`), 'tool-output'];
/** The metric a saving counts toward when its item names none. */
export const DEFAULT_METRIC = 'tokens-per-session';

export function metricUnit(metric) {
  if (metric === 'waste-share') return 'percent';
  return metric === 'tool-output' ? 'chars/session' : 'tokens/session';
}

/**
 * The comparable numbers of one measurement. `impact` is the harness's impact as the state holds
 * it; `raw` is the probe's own output (impact.json), which also has what the state leaves out:
 * shell output, and how many sessions each median was taken over. A metric that was not measured
 * is absent, never 0.
 */
export function metricsOf(impact, raw) {
  const m = {};
  if (!isObject(impact)) return m;
  const r = isObject(raw) ? raw : {};
  const sessions = isNum(impact.sessions) && impact.sessions > 0 ? impact.sessions : 0;
  const perSession = (v) => Math.round(v / sessions);
  if (sessions && isNum(impact.totalTokens)) m['tokens-per-session'] = perSession(impact.totalTokens);
  if (sessions && isNum(impact.weightedTotal)) m['weighted-per-session'] = perSession(impact.weightedTotal);
  const measured = (block, rawBlock) => isObject(block) && !(isObject(rawBlock) && rawBlock.sessionsMeasured === 0);
  if (measured(impact.contextAtStart, r.contextAtStart) && isNum(impact.contextAtStart.perSessionMedian)) m['context-at-start'] = impact.contextAtStart.perSessionMedian;
  if (measured(impact.contextPeak, r.contextPeak) && isNum(impact.contextPeak.median)) m['context-peak'] = impact.contextPeak.median;
  if (Array.isArray(impact.waste)) {
    const w = wasteOf(impact);
    if (w.weighted !== null) m['waste-share'] = round1((w.weighted / impact.weightedTotal) * 100);
    else if (isNum(impact.totalTokens) && impact.totalTokens > 0) m['waste-share'] = round1((w.tokens / impact.totalTokens) * 100);
    if (sessions) for (const row of impact.waste) if (isObject(row) && WASTE_KINDS.includes(row.kind) && isNum(row.tokens)) m[`waste:${row.kind}`] = perSession(row.tokens);
  }
  if (sessions && isObject(r.toolOutput) && isNum(r.toolOutput.shellResultChars)) m['tool-output'] = perSession(r.toolOutput.shellResultChars);
  return m;
}

const COVERAGE = ['not-read', 'complete', 'partial', 'unknown'];

/**
 * How well the tool calls of each source were read in that window, as the impact probe says it
 * (`coverage.<source>.toolCalls`): `not-read`, `complete`, `partial` or `unknown`.
 */
export function coverageOf(raw) {
  const out = {};
  const cover = isObject(raw) && isObject(raw.coverage) ? raw.coverage : {};
  for (const source of ['claude', 'codex']) {
    if (isObject(cover[source]) && COVERAGE.includes(cover[source].toolCalls)) out[source] = cover[source].toolCalls;
  }
  return out;
}

/** The `measure` block of a record, or null with the reason when the harness was not measured. */
function measureOf(hs, raw) {
  const impact = hs.impact;
  if (!isObject(impact) || !isNum(impact.sessions) || !isNum(impact.windowDays) || impact.windowDays < 1) {
    const reason = isObject(hs.impactSkipped) ? hs.impactSkipped.reason : null;
    return { measure: null, skipped: reason === 'shared-sessions' || reason === 'no-transcript-reader' ? reason : 'not-measured' };
  }
  const window = {};
  if (isDateTime(impact.from)) window.from = impact.from;
  if (isDateTime(impact.to)) window.to = impact.to;
  window.days = impact.windowDays;
  const measure = { window, sessions: impact.sessions };
  if (isNum(impact.activeDays)) measure.activeDays = impact.activeDays;
  measure.metrics = metricsOf(impact, raw);
  const unused = impact.unusedContext;
  if (isObject(unused)) {
    measure.unused = {
      skills: Array.isArray(unused.skillsNeverInvoked) ? unused.skillsNeverInvoked.filter((x) => typeof x === 'string') : [],
      mcpServers: Array.isArray(unused.mcpServersNeverCalled) ? unused.mcpServersNeverCalled.filter((x) => typeof x === 'string') : [],
    };
  }
  const coverage = coverageOf(raw);
  if (Object.keys(coverage).length) measure.coverage = coverage;
  return { measure, skipped: null };
}

// ---------------------------------------------------------------------------------------------
// The window of a follow-up
// ---------------------------------------------------------------------------------------------

/** The moment a record's effect starts to count: its last applied change, else its end. */
export function referenceOf(record) {
  const at = isDateTime(record.changesAppliedAt) ? record.changesAppliedAt : record.reviewedAt;
  return Date.parse(at);
}

/**
 * The window `init` gives a harness that has a record (references/follow-up.md, "Window"): once
 * `minDays` have passed since the record, the days since then, at most the run's window; before
 * that, the run's window. `{ days, windowDays, sinceReview }`.
 */
export function followUpWindow(record, nowMs, runWindow, t = loadThresholds()) {
  const days = Math.max(0, Math.floor((nowMs - referenceOf(record)) / DAY));
  const sinceReview = days >= t.minDays;
  return { days, windowDays: sinceReview ? Math.max(1, Math.min(days, runWindow)) : runWindow, sinceReview };
}

// ---------------------------------------------------------------------------------------------
// The on-disk check of a fixed item
// ---------------------------------------------------------------------------------------------

const CHECK_RANK = { 'not-checked': 0, 'in-place': 1, changed: 2, reverted: 3, missing: 4 };

/**
 * Absolute path of a change's display path, or null when it is not one this harness can name.
 * A path under the harness's own display path, or relative to its root, resolves inside its
 * folder; `~/...` resolves inside the home. An absolute path, or one that climbs out with `..`,
 * is never followed: the path comes from a record, and the check stays where the review was.
 */
function resolveChangePath(display, h) {
  if (typeof display !== 'string' || !display || typeof h.pathAbs !== 'string') return null;
  const p = display.replace(/\\/g, '/');
  let base = h.pathAbs;
  let rest;
  if (typeof h.path === 'string' && h.path && (p === h.path || p.startsWith(`${h.path}/`))) rest = p.slice(h.path.length);
  else if (p.startsWith('~/')) { base = homeBase(); rest = p.slice(2); }
  else if (p.startsWith('./')) rest = p.slice(2);
  else if (!p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.startsWith('~')) rest = p;
  else return null;
  const abs = path.join(base, rest);
  const rel = path.relative(base, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? abs : null;
}

const lf = (s) => s.replace(/\r\n/g, '\n');

/** One change against the file on disk (the table in references/follow-up.md). */
function checkChange(c, h) {
  if (!isObject(c)) return 'not-checked';
  const before = lf(str(c.before));
  const after = lf(str(c.after));
  const hasText = !!before.trim() || !!after.trim();
  const hashAfter = typeof c.hashAfter === 'string' ? c.hashAfter : null;
  if (!hasText && !hashAfter && c.deleted !== true) return 'not-checked';
  const abs = resolveChangePath(c.path, h);
  if (!abs) return 'not-checked';
  let buf;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_CHECK_BYTES) return 'not-checked';
    buf = fs.readFileSync(abs);
  } catch (e) {
    if (e && e.code === 'ENOENT') return c.deleted === true ? 'in-place' : 'missing';
    return 'not-checked';
  }
  if (c.deleted === true) return 'reverted'; // the file the change removed is back
  if (hashAfter && sha256(buf) === hashAfter) return 'in-place';
  if (!hasText) return 'not-checked'; // another change may have touched the file since: no text to tell
  const text = lf(buf.toString('utf8'));
  // A record quotes a secret masked; the file holds it in full. Look in the file masked the same way too.
  const views = before.includes('…') || after.includes('…') ? [text, lf(maskCredentials(buf.toString('utf8')))] : [text];
  const holds = (needle) => views.some((v) => v.includes(needle));
  // The text before, outside any place that holds the text after (which often contains it).
  const holdsBefore = () => views.some((v) => (after.trim() ? v.split(after).join('\u0000') : v).includes(before));
  if (after.trim()) {
    if (holds(after)) return 'in-place';
    if (before.trim()) return holdsBefore() ? 'reverted' : 'changed';
    // A pure insertion that is gone: taken out again, unless the place it went into is gone too.
    const anchor = lf(str(c.insertAfter));
    return anchor.trim() && !holds(anchor) ? 'changed' : 'reverted';
  }
  return holdsBefore() ? 'reverted' : 'in-place'; // a removal
}

/**
 * Is what a fixed item changed still on disk? The worst result of its changes:
 * missing > reverted > changed > in-place; `not-checked` when no change has anything to look for.
 */
export function checkItem(item, h) {
  let worst = 'not-checked';
  for (const c of Array.isArray(item.changes) ? item.changes : []) {
    const result = checkChange(c, h);
    if (CHECK_RANK[result] > CHECK_RANK[worst]) worst = result;
  }
  return worst;
}

// ---------------------------------------------------------------------------------------------
// The follow-up of one harness
// ---------------------------------------------------------------------------------------------

const CARRIED = ['fixed', 'failed', 'declined', 'deferred', 'open', 'approved', 'in-progress'];

/**
 * The verdict of one metric row: the first line of the table in references/follow-up.md that
 * applies. `tooFew` is true while too few days or sessions have passed since the review.
 */
function verdictOf({ before, after, expected, tooFew }, t) {
  if (tooFew) return 'not-enough-data';
  if (!isNum(before) || !isNum(after)) return 'not-measured';
  const rose = before === 0 ? after > 0 : ((after - before) / before) * 100 > t.noisePct;
  if (rose) return 'worse';
  const reduction = isNum(expected) ? before - expected : 0;
  if (reduction > 0) {
    const share = (before - after) / reduction;
    if (share >= t.confirmedShare) return 'confirmed';
    if (share >= t.partialShare) return 'partial';
    return 'no-change';
  }
  return before !== 0 && ((after - before) / before) * 100 < -t.noisePct ? 'improved' : 'no-change';
}

/**
 * `harnesses[].followUp` of the state (`$defs.followUp`): harness `h` now against `record`.
 *   hs        the harness entry being built for the state (its `impact`, when measured)
 *   raw       the probe's impact.json, or null
 *   items     the items of this run, all harnesses (`previous` links them to the record's)
 *   scoreNow  this run's baseline score of the harness, or null
 */
export function followUpFor({ record, run, h, hs, raw, items, scoreNow, t = loadThresholds() }) {
  const impact = isObject(hs.impact) ? hs.impact : null;
  const ref = referenceOf(record);
  // "Now" is the end of the measured window; a harness that was not measured counts from the run's start.
  const measuredAt = impact && isDateTime(impact.to) ? Date.parse(impact.to) : Date.parse(run.createdAt);
  const days = Math.max(0, Math.floor((measuredAt - ref) / DAY));

  let sample;
  if (!impact) sample = { sessions: null, enough: false, reason: 'not-measured' };
  else if (days < t.minDays) sample = { sessions: null, enough: false, reason: 'too-few-days', readyAt: iso(ref + t.minDays * DAY) };
  else if (!(impact.windowDays <= days)) sample = { sessions: null, enough: false, reason: 'not-measured' }; // the window reaches back before that review
  else if (impact.sessions < t.minSessions) sample = { sessions: impact.sessions, enough: false, reason: 'too-few-sessions' };
  else sample = { sessions: impact.sessions, enough: true };
  const tooFew = sample.reason === 'too-few-days' || sample.reason === 'too-few-sessions';

  const then = record.measure ? record.measure.metrics : {};
  // A window that reaches back before that review measured something else: nothing counts as "now".
  const now = impact && sample.reason !== 'not-measured' ? metricsOf(impact, raw) : {};
  const sessionsThen = record.measure && record.measure.sessions > 0 ? record.measure.sessions : 0;
  const fixed = record.items.filter((i) => i.status === 'fixed');
  const expectedBy = new Map();
  let expectedTokens = 0;
  for (const i of fixed) {
    const tokens = isObject(i.saves) && isNum(i.saves.tokens) ? i.saves.tokens : 0;
    if (tokens <= 0) continue;
    expectedTokens += tokens;
    const metric = METRICS.includes(i.saves.metric) ? i.saves.metric : DEFAULT_METRIC;
    const e = expectedBy.get(metric) || { tokens: 0, items: [] };
    e.tokens += tokens;
    e.items.push(i.id);
    expectedBy.set(metric, e);
  }

  const metrics = [];
  for (const metric of METRICS) {
    // One row for every metric measured on either side.
    if (!isNum(then[metric]) && !isNum(now[metric])) continue;
    const named = expectedBy.get(metric);
    const before = isNum(then[metric]) ? then[metric] : null;
    const after = isNum(now[metric]) ? now[metric] : null;
    // A saving is in tokens: it sets an expectation only for a metric counted in tokens per session.
    const expected = named && before !== null && sessionsThen && metricUnit(metric) === 'tokens/session' ? Math.max(0, Math.round(before - named.tokens / sessionsThen)) : null;
    const row = {
      metric, unit: metricUnit(metric), before, expected, after,
      changePct: before !== null && after !== null && before !== 0 ? round1(((after - before) / before) * 100) : null,
      verdict: verdictOf({ before, after, expected, tooFew }, t),
    };
    if (named) row.items = named.items;
    metrics.push(row);
  }

  const nowOf = new Map();
  for (const i of items) {
    if (i.harness !== h.id || !isObject(i.previous) || i.previous.run !== record.runId) continue;
    if (!nowOf.has(i.previous.item)) nowOf.set(i.previous.item, i.id);
  }
  const carried = [];
  for (const i of record.items) {
    if (!CARRIED.includes(i.status)) continue;
    const entry = { id: i.id, title: i.title, round: i.round, status: i.status };
    if (i.status === 'fixed') {
      entry.check = checkItem(i, h);
      const paths = [...new Set((Array.isArray(i.changes) ? i.changes : []).map((c) => c.path).filter((p) => typeof p === 'string' && p))];
      if (paths.length) entry.paths = paths;
    }
    entry.saves = isObject(i.saves) && isNum(i.saves.tokens) ? i.saves.tokens : null;
    if (nowOf.has(i.id)) entry.now = nowOf.get(i.id);
    carried.push(entry);
  }

  const tps = metrics.find((m) => m.metric === 'tokens-per-session');
  const fixedNow = carried.filter((e) => e.status === 'fixed');
  return {
    of: { runId: record.runId, reviewedAt: record.reviewedAt },
    days,
    sample,
    score: {
      then: isNum(record.scores.current) ? record.scores.current : null,
      expected: isNum(record.scores.projected) ? record.scores.projected : null,
      now: isNum(scoreNow) ? scoreNow : null,
    },
    metrics,
    items: carried,
    summary: {
      expectedTokensPerSession: sessionsThen ? Math.round(expectedTokens / sessionsThen) : null,
      observedTokensPerSession: sample.enough && tps && tps.before !== null && tps.after !== null ? Math.round(tps.after - tps.before) : null,
      inPlace: fixedNow.filter((e) => e.check === 'in-place').length,
      reverted: fixedNow.filter((e) => e.check === 'reverted').length,
      cameBack: fixedNow.filter((e) => e.now !== undefined).length,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The record of the present review
// ---------------------------------------------------------------------------------------------

const ACTION_OF = { approved: 'approve', 'in-progress': 'approve', fixed: 'approve', failed: 'approve', declined: 'decline', deferred: 'defer' };
const displayKey = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * The record of harness `h` (an entry of run.json) for this run, from the state as `build`
 * assembles it, so every text in it is already masked.
 *   status, ledger, events   status.json, ledger.json and the lines of log.jsonl
 *   raw                      the probe's impact.json, or null
 *   reviewedAt               when this review ended (ISO)
 */
export function makeRecord({ state, run, h, status, ledger, events, raw, reviewedAt, t = loadThresholds() }) {
  const hs = state.harnesses.find((x) => x.id === h.id);
  const score = scoreHarness(state, h.id);
  const entries = (isObject(ledger) && Array.isArray(ledger.entries) ? ledger.entries : []).filter((e) => isObject(e) && !e.undoneAt);
  const fixedAt = new Map();
  for (const e of events) if (isObject(e) && e.event === 'mark' && e.status === 'fixed' && typeof e.item === 'string' && isDateTime(e.at)) fixedAt.set(e.item, e.at);

  const applied = [];
  const items = state.items.filter((i) => i.harness === h.id).map((i) => {
    const o = (isObject(status.items) && status.items[i.id]) || {};
    const out = { id: i.id, rev: i.rev, round: i.round, severity: i.severity, class: i.class, title: i.title, status: i.status };
    if (isDateTime(o.decidedAt) && ACTION_OF[i.status]) {
      out.decision = { action: ACTION_OF[i.status], at: o.decidedAt };
      if (typeof i.decision === 'string' && i.decision) out.decision.note = i.decision;
    } else if (i.status === 'declined' && isObject(i.history) && isDateTime(i.history.lastDecisionAt)) {
      // Declined in an earlier review and handed back as it was: that decision still stands.
      out.decision = { action: 'decline', at: i.history.lastDecisionAt };
      if (typeof i.decision === 'string' && i.decision) out.decision.note = i.decision;
    }
    if (i.status === 'fixed' && fixedAt.has(i.id)) { out.fixedAt = fixedAt.get(i.id); applied.push(out.fixedAt); }
    if (typeof i.verified === 'string') out.verified = i.verified;
    if (typeof i.notVerified === 'string') out.notVerified = i.notVerified;
    if (isObject(i.lesson) && typeof i.lesson.principle === 'string' && i.lesson.principle) out.principle = i.lesson.principle;
    if (isObject(i.saves)) out.saves = { ...i.saves };
    if (isObject(i.previous)) out.previous = { run: i.previous.run, item: i.previous.item };
    const mine = entries.filter((e) => e.item === i.id);
    // A change counts as applied while its item is fixed or being applied: one that failed was put back.
    if (i.status === 'fixed' || i.status === 'in-progress') for (const e of mine) if (isDateTime(e.at)) applied.push(e.at);
    if (i.status === 'fixed' && Array.isArray(i.changes)) {
      out.changes = i.changes.map((c) => {
        const change = { path: c.path, before: c.before, after: c.after };
        if (typeof c.insertAfter === 'string') change.insertAfter = c.insertAfter;
        const last = mine.filter((e) => typeof e.display === 'string' && displayKey(e.display) === displayKey(c.path)).pop();
        if (last) {
          change.hashAfter = typeof last.hashAfter === 'string' ? last.hashAfter : null;
          if (change.hashAfter === null) change.deleted = true;
        }
        return change;
      });
    }
    return out;
  });

  const { measure, skipped } = measureOf(hs, raw);
  const elements = {};
  for (const [name, list] of Object.entries(isObject(hs.elements) ? hs.elements : {})) if (Array.isArray(list)) elements[name] = list.length;

  const record = {
    schema: RECORD_SCHEMA,
    skillVersion: state.skillVersion,
    harnessKey: harnessKeyOf(h),
    runId: run.runId,
    kind: h.kind,
    provider: typeof h.provider === 'string' ? h.provider : null,
    name: hs.name,
    path: hs.path,
    startedAt: run.createdAt,
    reviewedAt,
    changesAppliedAt: applied.length ? applied.sort((a, b) => Date.parse(a) - Date.parse(b))[applied.length - 1] : null,
    followUpAfter: iso(Date.parse(reviewedAt) + t.followUpAfterDays * DAY),
  };
  if (isObject(hs.followUp)) record.followUpOf = { runId: hs.followUp.of.runId, reviewedAt: hs.followUp.of.reviewedAt };
  record.scores = {
    baseline: score.baseline, current: score.current, projected: score.projected, grade: score.grade,
    rounds: score.breakdown.map((r) => ({ round: r.round, status: r.status, score: r.score })),
  };
  record.measure = measure;
  if (!measure) record.measureSkipped = skipped;
  record.elements = elements;
  record.items = items;
  if (isObject(hs.followUp)) record.outcome = hs.followUp;
  return record;
}
