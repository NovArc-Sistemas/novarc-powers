// The follow-up (references/follow-up.md): what a run makes of the review records of its
// harnesses.
//
// Every review leaves one record per harness under <home>/.novarc-powers/novarc-harness-doctor/
// history/<harnessKey>/. records.mjs reads them (limits, shape, privacy barrier); this module is
// what a run needs from them: the earlier records of a harness, the comparable metrics of a
// measurement, the comparison of "then" with "now", the history of a finding, a decline that
// still stands, and the record of the present review. diskcheck.mjs checks on disk what was
// applied; history.mjs writes the files and answers `run.mjs history`.
//
// Nothing here writes, and nothing here reads the clock: "now" is the end of the measured window,
// so the same inputs always give the same comparison.
import fs from 'node:fs';
import path from 'node:path';
import { RunError, sha256 } from './store.mjs';
import { SKILL_DIR } from './paths.mjs';
import { isDateTime } from './schema.mjs';
import { itemRev, canonicalJson } from './rev.mjs';
import { RECORD_SCHEMA, harnessKeyOf, listRecords } from './records.mjs';
import { checkItem, checkRoots } from './diskcheck.mjs';
import { scoreHarness, wasteOf } from '../scoring.mjs';

export { RECORD_SCHEMA, HARNESS_KEY_RE, harnessHash, harnessKeyOf, recordBaseName, validateRecord, forgetRecords, listRecords, ignoredRecords } from './records.mjs';
export { checkItem } from './diskcheck.mjs';

const DAY = 86400000;
/** What a record keeps of one text, at most (what `complete` accepts for one string). */
const MAX_TEXT = 200 * 1024;
/** Changes kept per item; an item with more keeps none (`changesOmitted`). */
const MAX_CHANGES = 1000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' ? v : '');
const round1 = (x) => Math.round(x * 10) / 10;
const iso = (ms) => new Date(ms).toISOString();
const clip = (s, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

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
// The earlier records of a harness
// ---------------------------------------------------------------------------------------------

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
 * A decline that still stands. `raw` is an item as a reviewer handed it in, `rev` its revision.
 * When its `previous` names an item the user declined in an earlier review of this harness, and
 * what is proposed now is the same proposal, the answer is that decline:
 * `{ run, item, at, note }`. Otherwise null: the user never said no to this.
 *
 * "The same proposal" is the revision (rev.mjs): the harness, the class, the target file, the
 * proposal and every change. It is equal to the revision the record holds, or to the revision of
 * what the record kept of that item (`class`, `file`, `proposal`, `changes`) under the harness id
 * of this run, since a harness id belongs to the selection of one run and the record is read as
 * the user saw it. Pointing at a declined item is never enough.
 */
export function carriedDecline(run, h, raw, rev) {
  const before = previousItem(run, h, raw.previous);
  if (!before || before.item.status !== 'declined') return null;
  const r = before.item;
  let same = r.rev === rev;
  if (!same && typeof r.proposal === 'string' && r.changesOmitted !== true) {
    same = itemRev({ harness: raw.harness, class: r.class, file: r.file, proposal: r.proposal, changes: r.changes }) === rev;
  }
  if (!same) return null;
  const d = isObject(r.decision) ? r.decision : {};
  return {
    run: before.entry.record.runId,
    item: r.id,
    at: isDateTime(d.at) ? d.at : before.entry.record.reviewedAt,
    note: typeof d.note === 'string' ? d.note : '',
  };
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
 * The share of a measurement that was waste, on each base it can be told on:
 * `{ base, weighted?, raw? }`, or null when waste was not measured. `raw` is waste tokens over
 * all tokens; `weighted` is the same in input-token equivalents, known only when every kind of
 * waste was weighted. The two are different quantities (cache reads weigh little, so the same
 * usage can be 5% on one and 20% on the other) and are never compared with each other. `base`
 * names the one `waste-share` shows: weighted when it is known.
 */
export function wasteShareOf(impact) {
  if (!isObject(impact) || !Array.isArray(impact.waste)) return null;
  const w = wasteOf(impact);
  const out = {};
  if (w.weighted !== null) out.weighted = round1((w.weighted / impact.weightedTotal) * 100);
  if (isNum(impact.totalTokens) && impact.totalTokens > 0) out.raw = round1((w.tokens / impact.totalTokens) * 100);
  if (out.weighted === undefined && out.raw === undefined) return null;
  return { base: out.weighted !== undefined ? 'weighted' : 'raw', ...out };
}

/**
 * Which price weights the weighted numbers of a measurement were made with:
 * `{ source, verifiedAt?, families: [{ id, hash }] }`, or null when nothing was weighted. `hash`
 * is 12 hex characters of a SHA-256 over the ratios applied to that model family, so two
 * measurements can be told to be on the same prices without keeping the price list.
 */
export function weightsOf(impact) {
  if (!isObject(impact) || !isNum(impact.weightedTotal) || !isObject(impact.weights)) return null;
  const w = impact.weights;
  const families = [];
  for (const [id, fam] of Object.entries(isObject(w.perModelFamily) ? w.perModelFamily : {})) {
    if (!isObject(fam) || !id || id.length > 120) continue;
    const ratios = { ratios: isObject(fam.ratios) ? fam.ratios : null, longContext: isObject(fam.longContext) ? fam.longContext : null };
    families.push({ id, hash: sha256(canonicalJson(ratios)).slice(0, 12) });
  }
  families.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = { source: clip(str(w.source), 200) };
  if (typeof w.verifiedAt === 'string' && w.verifiedAt) out.verifiedAt = clip(w.verifiedAt, 40);
  out.families = families.slice(0, 200);
  return out;
}

/**
 * Were two measurements weighted with different prices? True when they name another weights
 * file, or apply other ratios to a model family both used. A side that does not say (a record
 * written before weights were kept) is not known to differ.
 */
export function weightsChanged(then, now) {
  if (!isObject(then) || !isObject(now)) return false;
  if (str(then.source) !== str(now.source)) return true;
  const before = new Map((Array.isArray(then.families) ? then.families : []).map((f) => [f.id, f.hash]));
  return (Array.isArray(now.families) ? now.families : []).some((f) => before.has(f.id) && before.get(f.id) !== f.hash);
}

/**
 * The comparable numbers of one measurement. `impact` is the harness's impact as the state holds
 * it; `raw` is the probe's own output (impact.json), which also has what the state leaves out:
 * shell output, and how many sessions each median was taken over. A metric that was not measured
 * is absent, never 0. `waste-share` is on the base `wasteShareOf` names.
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
    const share = wasteShareOf(impact);
    if (share) m['waste-share'] = share[share.base];
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
  // The base of each number that has more than one: what the next review needs to compare like with like.
  const share = wasteShareOf(impact);
  if (share) measure.wasteShare = share;
  const weights = weightsOf(impact);
  if (weights) measure.weights = weights;
  const unused = impact.unusedContext;
  if (isObject(unused)) {
    const names = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.length <= 300).slice(0, 5000) : []);
    measure.unused = { skills: names(unused.skillsNeverInvoked), mcpServers: names(unused.mcpServersNeverCalled) };
  }
  const coverage = coverageOf(raw);
  if (Object.keys(coverage).length) measure.coverage = coverage;
  return { measure, skipped: null };
}

/**
 * The waste share a record holds, with its base. A record written before the base was kept says
 * one number: without weighted totals it can only be raw; with them it may be either, and is not
 * compared (`{ base: null }`).
 */
function shareOfRecord(measure) {
  if (isObject(measure.wasteShare)) return measure.wasteShare;
  const value = measure.metrics['waste-share'];
  if (!isNum(value)) return null;
  return isNum(measure.metrics['weighted-per-session']) ? { base: null } : { base: 'raw', raw: value };
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
 * The two sides of one metric as they can be compared: `{ before, after, base?, reason? }`,
 * `base` and `reason` being the fields of that name on a row of `$defs.followUp`.
 * A number that has more than one base is compared on a base both sides have, never across:
 *   waste-share            weighted with weighted when both have it and the price weights did not
 *                          change, else raw with raw; with no common base, `no-common-base`
 *   weighted-per-session   not compared when the price weights changed: `weights-changed`
 * A row that cannot be compared keeps today's number and no earlier one, so nothing is read as a
 * change.
 */
function sidesOf(metric, then, now, bases) {
  const before = isNum(then[metric]) ? then[metric] : null;
  const after = isNum(now[metric]) ? now[metric] : null;
  if (metric === 'weighted-per-session') {
    return bases.weightsDiffer && before !== null && after !== null ? { before: null, after, reason: 'weights-changed' } : { before, after };
  }
  if (metric !== 'waste-share') return { before, after };
  const a = bases.shareThen;
  const b = bases.shareNow;
  if (!a || !b) return { before, after };
  const both = (base) => isNum(a[base]) && isNum(b[base]);
  const base = both('weighted') && !bases.weightsDiffer ? 'weighted' : both('raw') ? 'raw' : null;
  if (base) return { before: a[base], after: b[base], base };
  return { before: null, after, base: b.base, reason: both('weighted') ? 'weights-changed' : 'no-common-base' };
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

  const measure = isObject(record.measure) ? record.measure : null;
  const then = measure ? measure.metrics : {};
  // A window that reaches back before that review measured something else: nothing counts as "now".
  const counted = !!impact && sample.reason !== 'not-measured';
  const now = counted ? metricsOf(impact, raw) : {};
  const bases = {
    shareThen: measure ? shareOfRecord(measure) : null,
    shareNow: counted ? wasteShareOf(impact) : null,
    weightsDiffer: !!measure && counted && weightsChanged(measure.weights, weightsOf(impact)),
  };
  const sessionsThen = measure && measure.sessions > 0 ? measure.sessions : 0;
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
    const { before, after, base, reason } = sidesOf(metric, then, now, bases);
    // A saving is in tokens: it sets an expectation only for a metric counted in tokens per session.
    const expected = named && before !== null && sessionsThen && metricUnit(metric) === 'tokens/session' ? Math.max(0, Math.round(before - named.tokens / sessionsThen)) : null;
    const row = {
      metric, unit: metricUnit(metric), before, expected, after,
      changePct: before !== null && after !== null && before !== 0 ? round1(((after - before) / before) * 100) : null,
      verdict: verdictOf({ before, after, expected, tooFew }, t),
    };
    if (base) row.base = base;
    if (reason) row.reason = reason;
    if (named) row.items = named.items;
    metrics.push(row);
  }

  const nowOf = new Map();
  for (const i of items) {
    if (i.harness !== h.id || !isObject(i.previous) || i.previous.run !== record.runId) continue;
    if (!nowOf.has(i.previous.item)) nowOf.set(i.previous.item, i.id);
  }
  const roots = checkRoots(run, h);
  const carried = [];
  for (const i of record.items) {
    if (!CARRIED.includes(i.status)) continue;
    const entry = { id: i.id, title: i.title, round: i.round, status: i.status };
    if (i.status === 'fixed') {
      entry.check = checkItem(i, h, roots);
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
const LINK_RE = /^.{1,60}$/s;

/**
 * The record of harness `h` (an entry of run.json) for this run, from the state as `build`
 * assembles it, so every text in it is already masked.
 *   status, ledger, events   status.json, ledger.json and the lines of log.jsonl
 *   stored                   the items as the findings files hold them, by id: what each `rev` is a hash of
 *   raw                      the probe's impact.json, or null
 *   reviewedAt               when this review ended (ISO)
 *
 * Every item keeps what its revision is made of (`class`, `file`, `proposal`, `changes`), whatever
 * its status: the on-disk check needs it for a fixed item, and the next review needs it to tell
 * whether a proposal is the one the user already declined.
 */
export function makeRecord({ state, run, h, status, ledger, events, stored = new Map(), raw, reviewedAt, t = loadThresholds() }) {
  const hs = state.harnesses.find((x) => x.id === h.id);
  const score = scoreHarness(state, h.id);
  const entries = (isObject(ledger) && Array.isArray(ledger.entries) ? ledger.entries : []).filter((e) => isObject(e) && !e.undoneAt);
  const fixedAt = new Map();
  for (const e of events) if (isObject(e) && e.event === 'mark' && e.status === 'fixed' && typeof e.item === 'string' && isDateTime(e.at)) fixedAt.set(e.item, e.at);

  const applied = [];
  const items = state.items.filter((i) => i.harness === h.id).map((i) => {
    const o = (isObject(status.items) && Object.hasOwn(status.items, i.id) && status.items[i.id]) || {};
    const handed = isObject(stored.get(i.id)) ? stored.get(i.id) : {};
    const out = { id: i.id, rev: i.rev, round: i.round, severity: i.severity, class: i.class, title: clip(str(i.title)), status: i.status };
    if (typeof handed.file === 'string' && typeof i.file === 'string' && i.file.length <= 200) out.file = i.file;
    out.proposal = clip(str(i.proposal));
    if (isDateTime(o.decidedAt) && ACTION_OF[i.status]) {
      out.decision = { action: ACTION_OF[i.status], at: o.decidedAt };
      if (typeof i.decision === 'string' && i.decision) out.decision.note = clip(i.decision);
    } else if (i.status === 'declined' && o.status === undefined && isObject(i.previous) && isObject(i.history) && i.history.lastStatus === 'declined') {
      // Declined in an earlier review and proposed again as it was: that decision still stands.
      out.decision = { action: 'decline', at: isDateTime(i.updatedAt) ? i.updatedAt : (isDateTime(i.history.lastDecisionAt) ? i.history.lastDecisionAt : reviewedAt) };
      if (typeof i.decision === 'string' && i.decision) out.decision.note = clip(i.decision);
      out.decision.carriedFrom = { run: str(i.previous.run), item: str(i.previous.item) };
    }
    if (i.status === 'fixed' && fixedAt.has(i.id)) { out.fixedAt = fixedAt.get(i.id); applied.push(out.fixedAt); }
    if (typeof i.verified === 'string') out.verified = clip(i.verified);
    if (typeof i.notVerified === 'string') out.notVerified = clip(i.notVerified);
    if (isObject(i.lesson) && typeof i.lesson.principle === 'string' && i.lesson.principle) out.principle = clip(i.lesson.principle);
    if (isObject(i.saves)) {
      out.saves = { ...i.saves };
      if (typeof out.saves.how === 'string') out.saves.how = clip(out.saves.how);
    }
    if (isObject(i.previous) && LINK_RE.test(str(i.previous.run)) && LINK_RE.test(str(i.previous.item))) out.previous = { run: i.previous.run, item: i.previous.item };
    const mine = entries.filter((e) => e.item === i.id);
    // A change counts as applied while its item is fixed or being applied: one that failed was put back.
    if (i.status === 'fixed' || i.status === 'in-progress') for (const e of mine) if (isDateTime(e.at)) applied.push(e.at);
    if (Array.isArray(i.changes) && i.changes.length) {
      const fits = i.changes.length <= MAX_CHANGES && i.changes.every((c) => isObject(c) && [c.path, c.before, c.after, c.insertAfter].every((s) => s === undefined || (typeof s === 'string' && s.length <= MAX_TEXT)));
      if (!fits) out.changesOmitted = true;
      else {
        const handedChanges = Array.isArray(handed.changes) ? handed.changes : [];
        out.changes = i.changes.map((c, n) => {
          const change = { path: c.path, before: c.before, after: c.after };
          if (typeof c.insertAfter === 'string') change.insertAfter = c.insertAfter;
          // The file id is part of the revision only when the reviewer wrote one (`build` links the rest).
          const given = isObject(handedChanges[n]) ? handedChanges[n].file : undefined;
          if (typeof given === 'string' && given.length <= 200) change.file = given;
          if (i.status !== 'fixed') return change;
          const last = mine.filter((e) => typeof e.display === 'string' && displayKey(e.display) === displayKey(c.path)).pop();
          if (last) {
            change.hashAfter = typeof last.hashAfter === 'string' ? last.hashAfter : null;
            if (change.hashAfter === null) change.deleted = true;
          }
          return change;
        });
      }
    }
    return out;
  });

  const { measure, skipped } = measureOf(hs, raw);
  const elements = {};
  for (const [name, list] of Object.entries(isObject(hs.elements) ? hs.elements : {})) if (Array.isArray(list)) elements[name] = list.length;

  // `close --experiment` keeps what the user is testing in run.json (`experiment: { note, days }`),
  // so a record written again later (a decision after the close) still says it. It ends `days`
  // after this review ended, and that is also when the follow-up is due.
  const exp = isObject(run.experiment) && Number.isInteger(run.experiment.days) && run.experiment.days > 0 ? run.experiment : null;
  const followUpAfter = iso(Date.parse(reviewedAt) + (exp ? exp.days : t.followUpAfterDays) * DAY);
  const record = {
    schema: RECORD_SCHEMA,
    skillVersion: clip(str(state.skillVersion), 64),
    harnessKey: harnessKeyOf(h),
    runId: run.runId,
    language: run.language === 'pt' ? 'pt' : 'en',
    ...(['guided', 'doctor', 'measure'].includes(run.mode) ? { mode: run.mode } : {}),
    kind: h.kind,
    provider: typeof h.provider === 'string' ? clip(h.provider, 64) : null,
    name: clip(str(hs.name), 300),
    path: hs.path,
    startedAt: run.createdAt,
    reviewedAt,
    changesAppliedAt: applied.length ? applied.sort((a, b) => Date.parse(a) - Date.parse(b))[applied.length - 1] : null,
    followUpAfter,
  };
  if (exp) record.experiment = { ...(typeof exp.note === 'string' && exp.note ? { note: clip(exp.note, 300) } : {}), until: followUpAfter };
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

/**
 * A record that is too large to keep, made smaller: the changes of the items that were not fixed
 * go first (each one is marked `changesOmitted`), then those of the fixed ones. Returns true when
 * something was left out. What is lost is the on-disk check of those items, and telling a
 * declined proposal by its content; every decision, date and number stays.
 */
export function slimRecord(record, fixedToo) {
  let cut = false;
  for (const i of record.items) {
    if (!Array.isArray(i.changes) || (i.status === 'fixed' && !fixedToo)) continue;
    delete i.changes;
    i.changesOmitted = true;
    cut = true;
  }
  return cut;
}
