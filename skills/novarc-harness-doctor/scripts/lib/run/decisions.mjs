// Decisions (references/contracts.md, "Decisions"): one shape wherever it comes from — the board
// through serve-board.mjs (decisions.jsonl), an Artifact database export (`--ingest`), or chat
// (`run.mjs decide`). Taking a decision in means: record it once (by id), apply its effect to the
// status overlay, and say what changed. Everything here runs under the run mutex.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { RunError, UsageError, readJson, readText, writeJsonAtomic, appendJsonLine, withLock, sha256, nowIso } from './store.mjs';
import { isDateTime } from './schema.mjs';
import { loadFindings, loadItems, loadStatus, resolveGroups, appendLog } from './model.mjs';

export const ACTIONS = ['approve', 'decline', 'defer', 'ask'];
export const TARGET_RE = /^[A-Z][A-Z0-9]{0,5}-[0-9]{1,3}$/; // an item id; a group id (G-<n>) has the same form
export const GROUP_RE = /^G-[0-9]{1,3}$/;
export const PRIMARY_TARGET = 'accounts.primary';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const DECISION_FIELDS = ['id', 'at', 'runId', 'target', 'action', 'note', 'exclude', 'via'];
const MAX_NOTE = 4000;
/** Statuses a decision may still change. Applied, verified or closed items are left alone. */
const DECIDABLE = ['open', 'approved', 'declined', 'deferred', 'failed'];
const STATUS_OF = { approve: 'approved', decline: 'declined', defer: 'deferred' };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Stable id for a decision that came without one, so taking the same export in twice is a no-op. */
function derivedId(d) {
  return `d-${sha256(JSON.stringify([d.target, d.action, d.at || '', d.note || '', d.exclude || []])).slice(0, 20)}`;
}

/**
 * Check one decision. `strict` (the board channel) also rejects unknown fields and requires the
 * note that `ask` and `accounts.primary` need. Returns { ok, decision } or { ok: false, reason }.
 */
export function normalizeDecision(raw, { runId, via = 'board', strict = false } = {}) {
  if (!isObject(raw)) return { ok: false, reason: 'a decision must be a JSON object' };
  if (strict) for (const k of Object.keys(raw)) if (!DECISION_FIELDS.includes(k)) return { ok: false, reason: `unknown field "${k}"` };
  const target = typeof raw.target === 'string' ? raw.target.trim() : '';
  if (target !== PRIMARY_TARGET && !TARGET_RE.test(target)) return { ok: false, reason: 'target must be an item id, a group id or accounts.primary' };
  if (!ACTIONS.includes(raw.action)) return { ok: false, reason: `action must be one of ${ACTIONS.join(', ')}` };
  if (raw.runId !== undefined && raw.runId !== null && raw.runId !== runId) return { ok: false, reason: 'runId is not this run', wrongRun: true };
  if (raw.note !== undefined && raw.note !== null && typeof raw.note !== 'string') return { ok: false, reason: 'note must be a text' };
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (note.length > MAX_NOTE) return { ok: false, reason: `note is longer than ${MAX_NOTE} characters` };
  let exclude = [];
  if (raw.exclude !== undefined && raw.exclude !== null) {
    if (!Array.isArray(raw.exclude) || raw.exclude.length > 500 || raw.exclude.some((x) => typeof x !== 'string' || !TARGET_RE.test(x))) return { ok: false, reason: 'exclude must be a list of item ids' };
    exclude = [...new Set(raw.exclude)];
  }
  if (raw.id !== undefined && raw.id !== null && (typeof raw.id !== 'string' || !ID_RE.test(raw.id))) return { ok: false, reason: 'id must be a short token' };
  if (strict && raw.at !== undefined && !isDateTime(raw.at)) return { ok: false, reason: 'at must be an RFC 3339 date-time' };
  if (strict && raw.action === 'ask' && !note) return { ok: false, reason: 'ask needs the question in note' };
  if (strict && target === PRIMARY_TARGET && raw.action === 'approve' && !note) return { ok: false, reason: 'accounts.primary needs the account id in note' };
  const decision = { id: raw.id || null, at: isDateTime(raw.at) ? new Date(raw.at).toISOString() : null, runId, target, action: raw.action };
  if (note) decision.note = note;
  if (exclude.length) decision.exclude = exclude;
  decision.via = raw.via === 'chat' || raw.via === 'board' ? raw.via : via;
  if (!decision.id) decision.id = derivedId(decision);
  return { ok: true, decision };
}

/**
 * Decisions inside whatever `--ingest` was given: a JSON array, a map keyed by document id (the
 * Artifact database keeps one document per target), or either wrapped in an export envelope.
 * A document may hold the decision directly or under `data` / `fields` / `value`.
 */
export function extractDecisions(json) {
  const looks = (v) => isObject(v) && typeof v.action === 'string';
  const unwrap = (v, key) => {
    if (!isObject(v)) return v;
    let d = null;
    if (looks(v)) d = v;
    else for (const k of ['data', 'fields', 'value', 'doc', 'document']) if (looks(v[k])) { d = v[k]; break; }
    if (!d) return v;
    if (d.target !== undefined) return d;
    const fallback = d !== v && typeof v.id === 'string' ? v.id : key;
    return fallback === undefined ? d : { ...d, target: fallback };
  };
  if (Array.isArray(json)) return json.map((v) => unwrap(v));
  if (!isObject(json)) return [];
  if (looks(json)) return [json];
  for (const k of ['decisions', 'documents', 'docs', 'rows']) {
    if (Array.isArray(json[k]) || (isObject(json[k]) && !looks(json[k]))) return extractDecisions(json[k]);
  }
  return Object.entries(json).map(([key, v]) => unwrap(v, key));
}

function lineKey(line) { return sha256(line).slice(0, 20); }

/** Decisions waiting in decisions.jsonl that nothing has taken in yet. */
export function inboxCount(paths, status, runId) {
  const text = readText(paths.decisions);
  if (!text) return 0;
  const known = new Set(status.decisions.map((d) => d.id));
  const rejected = new Set(status.rejected || []);
  let n = 0;
  for (const line of text.split('\n').slice(0, -1)) {
    if (!line.trim() || rejected.has(lineKey(line))) continue;
    let raw;
    try { raw = JSON.parse(line); } catch { n++; continue; }
    const res = normalizeDecision(raw, { runId });
    if (!res.ok || !known.has(res.decision.id)) n++;
  }
  return n;
}

/** Apply one decision to one item. Returns 'applied', 'superseded' or 'skipped'. */
function decideItem(item, status, d, report) {
  const o = status.items[item.id] || (status.items[item.id] = {});
  const last = [o.decidedAt, o.askedAt].filter(Boolean).sort().pop();
  if (last && d.at < last) return 'superseded'; // a newer decision on this item was already taken in
  if (d.action === 'ask') {
    if (['approved', 'declined', 'deferred'].includes(item.status)) { o.status = 'open'; item.status = 'open'; }
    o.question = d.note || '?';
    o.askedAt = d.at;
    o.updatedAt = d.at;
    report.questions.push({ target: item.id, question: o.question, at: d.at });
    return 'applied';
  }
  if (!DECIDABLE.includes(item.status)) { report.skipped.push({ target: d.target, item: item.id, reason: `item is ${item.status}` }); return 'skipped'; }
  if (item.status === 'failed') { delete o.verified; delete o.notVerified; }
  o.status = STATUS_OF[d.action];
  item.status = o.status;
  if (d.note) o.decision = d.note; else delete o.decision;
  delete o.question;
  o.decidedAt = d.at;
  o.updatedAt = d.at;
  if (d.action === 'approve') (report.approvedByHarness[item.harness] = report.approvedByHarness[item.harness] || []).push(item.id);
  return 'applied';
}

function applyDecision(d, s, report) {
  if (d.target === PRIMARY_TARGET) {
    if (d.action === 'ask') {
      s.status.questions.push({ target: PRIMARY_TARGET, question: d.note || '?', at: d.at, decision: d.id });
      report.questions.push({ target: PRIMARY_TARGET, question: d.note || '?', at: d.at });
      return 'applied';
    }
    if (d.action !== 'approve') return 'applied'; // recorded; declining or deferring changes nothing
    if (!(s.run.accounts || []).some((a) => a.id === d.note)) { report.unknown.push({ target: d.target, reason: 'note is not the id of an account of this run' }); return 'unknown-target'; }
    s.run.primary = d.note;
    s.runChanged = true;
    s.status.questions = s.status.questions.filter((q) => q.target !== PRIMARY_TARGET);
    report.primary = d.note;
    s.log.push({ at: d.at, event: 'primary', account: d.note });
    return 'applied';
  }
  const group = s.groups.get(d.target);
  if (group) {
    const exclude = new Set(d.exclude || []);
    const results = group.items.filter((id) => !exclude.has(id)).map((id) => decideItem(s.items.get(id), s.status, d, report));
    const count = results.filter((r) => r === 'applied').length;
    if (count) s.log.push({ at: d.at, event: 'decision', target: d.target, action: d.action, via: d.via, count, ...(d.note ? { note: d.note } : {}) });
    if (count) return 'applied';
    return results.includes('superseded') ? 'superseded' : 'skipped';
  }
  const item = s.items.get(d.target);
  if (!item) { report.unknown.push({ target: d.target, reason: GROUP_RE.test(d.target) ? 'no such group' : 'no such item' }); return 'unknown-target'; }
  const result = decideItem(item, s.status, d, report);
  if (result === 'applied') s.log.push({ at: d.at, event: 'decision', harness: item.harness, item: item.id, action: d.action, via: d.via, ...(d.note ? { note: d.note } : {}) });
  return result;
}

/**
 * Take in every decision not seen before: the lines of decisions.jsonl, plus `extra` (already
 * extracted from a file, or the one `decide` builds). `extra` decisions are appended to
 * decisions.jsonl too, so that file stays the full record of what was decided.
 */
export function takeIn(ctx, extra = [], extraVia = 'board') {
  const { paths } = ctx;
  return withLock(paths.mutex, () => {
    const run = readJson(paths.run);
    const status = loadStatus(paths);
    if (!Array.isArray(status.rejected)) status.rejected = [];
    const findings = loadFindings(paths, run);
    const { items } = loadItems(paths, run, findings, status);
    const itemMap = new Map(items.map((i) => [i.id, i]));
    const groups = resolveGroups(paths, run, findings, new Set(itemMap.keys()), { assign: true });
    const known = new Set(status.decisions.map((d) => d.id));
    const report = { runId: paths.runId, new: [], approvedByHarness: {}, questions: [], unknown: [], skipped: [], rejected: [], duplicates: 0 };
    const now = nowIso();
    const fresh = [];
    const queued = new Set();
    const consider = (res, fromFile, where) => {
      if (!res.ok) { report.rejected.push({ source: where, reason: res.reason }); return false; }
      const d = res.decision;
      if (known.has(d.id) || queued.has(d.id)) { if (fromFile) report.duplicates++; return true; }
      queued.add(d.id);
      if (!d.at) d.at = now;
      fresh.push({ d, fromFile });
      return true;
    };

    const text = readText(paths.decisions) || '';
    text.split('\n').slice(0, -1).forEach((line, i) => {
      if (!line.trim()) return;
      const key = lineKey(line);
      if (status.rejected.includes(key)) return;
      let raw;
      let res;
      try { raw = JSON.parse(line); res = normalizeDecision(raw, { runId: paths.runId }); } catch { res = { ok: false, reason: 'invalid JSON' }; }
      // A bad line is reported once, then remembered so it does not hold the run open forever.
      if (!consider(res, false, `decisions.jsonl line ${i + 1}`)) status.rejected.push(key);
    });
    extra.forEach((raw, i) => consider(normalizeDecision(raw, { runId: paths.runId, via: extraVia }), true, `entry ${i + 1}`));

    fresh.sort((a, b) => a.d.at.localeCompare(b.d.at));
    const s = { run, status, items: itemMap, groups: new Map(groups.map((g) => [g.id, g])), log: [], runChanged: false };
    for (const { d, fromFile } of fresh) {
      if (fromFile) appendJsonLine(paths.decisions, d);
      const result = applyDecision(d, s, report);
      status.decisions.push({ ...d, result, ingestedAt: now });
      report.new.push({ ...d, result });
    }
    for (const [harness, ids] of Object.entries(report.approvedByHarness)) {
      const still = [...new Set(ids)].filter((id) => itemMap.get(id).status === 'approved');
      if (still.length) report.approvedByHarness[harness] = still; else delete report.approvedByHarness[harness];
    }
    if (fresh.length || report.rejected.length) writeJsonAtomic(paths.status, status);
    if (s.runChanged) { writeJsonAtomic(paths.run, run); ctx.run = run; }
    for (const e of s.log) appendLog(paths, e);
    return report;
  });
}

/** `decide --target <id> --action approve|decline|defer|ask [--note <t>] [--exclude <id,id>]`. */
export function decide(ctx, args) {
  if (typeof args.target !== 'string') throw new UsageError('decide needs --target <itemId|groupId|accounts.primary>');
  if (args.answered === true) return answered(ctx, args.target);
  if (typeof args.action !== 'string' || !ACTIONS.includes(args.action)) throw new UsageError(`--action must be one of ${ACTIONS.join(', ')}`);
  const raw = { id: crypto.randomUUID(), at: nowIso(), runId: ctx.paths.runId, target: args.target, action: args.action, via: 'chat' };
  if (args.note !== undefined) {
    if (typeof args.note !== 'string') throw new UsageError('--note needs a text');
    raw.note = args.note;
  }
  if (args.exclude !== undefined) {
    if (typeof args.exclude !== 'string') throw new UsageError('--exclude takes item ids separated by commas');
    raw.exclude = args.exclude.split(',').map((x) => x.trim()).filter(Boolean);
  }
  const res = normalizeDecision(raw, { runId: ctx.paths.runId, via: 'chat', strict: true });
  if (!res.ok) throw new UsageError(res.reason);
  if (res.decision.exclude && !GROUP_RE.test(res.decision.target)) throw new UsageError('--exclude only applies to a group target');
  return takeIn(ctx, [res.decision], 'chat');
}

/** `decisions [--ingest <file.json>]`. */
export function decisions(ctx, ingestPath) {
  let extra = [];
  if (ingestPath) {
    let json;
    try { json = JSON.parse(fs.readFileSync(ingestPath, 'utf8').replace(/^﻿/, '')); } catch (e) {
      throw new RunError(e && e.code === 'ENOENT' ? '--ingest file not found' : '--ingest file is not valid JSON');
    }
    extra = extractDecisions(json);
  }
  return takeIn(ctx, extra, 'board');
}

/** `decide --target <id> --answered`: the question was answered in chat; stop listing it. */
function answered(ctx, target) {
  return withLock(ctx.paths.mutex, () => {
    const status = loadStatus(ctx.paths);
    let cleared = false;
    if (target === PRIMARY_TARGET) {
      cleared = status.questions.some((q) => q.target === PRIMARY_TARGET);
      status.questions = status.questions.filter((q) => q.target !== PRIMARY_TARGET);
    } else if (status.items[target] && status.items[target].question !== undefined) {
      delete status.items[target].question;
      status.items[target].updatedAt = nowIso();
      cleared = true;
    }
    if (!cleared) return { runId: ctx.paths.runId, target, answered: false, reason: 'no question is waiting on this target' };
    writeJsonAtomic(ctx.paths.status, status);
    const { items } = loadItems(ctx.paths, ctx.run, undefined, status);
    const item = items.find((i) => i.id === target);
    appendLog(ctx.paths, { event: 'answered', ...(item ? { harness: item.harness, item: item.id } : {}) });
    return { runId: ctx.paths.runId, target, answered: true };
  });
}
