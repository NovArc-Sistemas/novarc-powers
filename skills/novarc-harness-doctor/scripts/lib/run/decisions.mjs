// Decisions (references/contracts.md, "Decisions"): one shape wherever it comes from — the board
// through serve-board.mjs (decisions.jsonl), an Artifact database export (`--ingest`), or chat
// (`run.mjs decide`). Taking a decision in means: record it once (by id), bind it to the revision
// it was made on, apply its effect to the status overlay, and say what changed. Everything here
// runs under the run mutex.
//
// A decision is a yes or a no to one exact proposal, so it carries `rev` (rev.mjs). The board sends
// the rev it showed; a decision typed in chat is stamped with the current rev; a decision that
// arrives from the board without one is bound to the rev in the last built state.json, the only
// board the user can have looked at. A decision whose rev is not the current one is not applied:
// it is reported in `stale` and logged, and the item stays open. When it is newer than the
// decision the item has (the user decided, then acted again on a page that still showed an
// earlier version), that decision is cleared as well and the item goes back to open: the last
// thing the user did was not about what is on the table.
//
// A decision taken in after the run left review records (it was closed) has them written again:
// a record says what was decided, whenever that was (history.mjs, `refreshRecords`).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RunError, UsageError, readJson, readText, writeJsonAtomic, appendJsonLine, withLock, sha256, nowIso } from './store.mjs';
import { isDateTime } from './schema.mjs';
import { loadFindings, loadItems, loadStatus, resolveGroups, withGroupRevs, appendLog } from './model.mjs';
import { REV_RE, DECISION_STATUSES, builtRevs } from './rev.mjs';
import { hasCredential, CREDENTIAL_HINT } from './secrets.mjs';
import { maskEmails } from './prose.mjs';
import { refreshRecords } from './history.mjs';
import { heldItems, dayOf } from './experiments.mjs';

export const ACTIONS = ['approve', 'decline', 'defer', 'ask'];
export const TARGET_RE = /^[A-Z][A-Z0-9]{0,5}-[0-9]{1,3}$/; // an item id; a group id (G-<n>) has the same form
export const GROUP_RE = /^G-[0-9]{1,3}$/;
export const PRIMARY_TARGET = 'accounts.primary';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const DECISION_FIELDS = ['id', 'at', 'runId', 'target', 'action', 'note', 'exclude', 'rev', 'via'];
const MAX_NOTE = 4000;
/** Statuses a decision may still change. Applied, verified or closed items are left alone. */
const DECIDABLE = ['open', 'approved', 'declined', 'deferred', 'failed'];
const STATUS_OF = { approve: 'approved', decline: 'declined', defer: 'deferred' };
/** `--ingest <directory>`: one JSON file per document, each at most this large. */
const MAX_INGEST_FILE_BYTES = 1024 * 1024;
const MAX_INGEST_FILES = 5000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Stable id for a decision that came without one, so taking the same export in twice is a no-op. */
function derivedId(d) {
  // The rev is part of the identity: the same answer given again to a changed proposal is a new decision.
  return `d-${sha256(JSON.stringify([d.target, d.action, d.at || '', d.note || '', d.exclude || [], ...(d.rev ? [d.rev] : [])])).slice(0, 20)}`;
}

/**
 * Check one decision. `strict` (the board channel) also rejects unknown fields and requires the
 * note that `ask` and `accounts.primary` need. Returns { ok, decision } or { ok: false, reason };
 * a reason never quotes a value.
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
  // The note travels to status.json, the log and the board: no credential gets in through it.
  if (note && hasCredential(note)) return { ok: false, reason: `note holds a credential: ${CREDENTIAL_HINT}` };
  let exclude = [];
  if (raw.exclude !== undefined && raw.exclude !== null) {
    if (!Array.isArray(raw.exclude) || raw.exclude.length > 500 || raw.exclude.some((x) => typeof x !== 'string' || !TARGET_RE.test(x))) return { ok: false, reason: 'exclude must be a list of item ids' };
    exclude = [...new Set(raw.exclude)];
  }
  if (raw.rev !== undefined && raw.rev !== null && typeof raw.rev !== 'string') return { ok: false, reason: 'rev must be a text' };
  const rev = typeof raw.rev === 'string' ? raw.rev.trim() : '';
  if (rev && !REV_RE.test(rev)) return { ok: false, reason: 'rev must be the 12-character revision of the item or group' };
  if (raw.id !== undefined && raw.id !== null && (typeof raw.id !== 'string' || !ID_RE.test(raw.id))) return { ok: false, reason: 'id must be a short token' };
  if (typeof raw.id === 'string' && hasCredential(raw.id)) return { ok: false, reason: 'id must be a short token, not a credential' };
  if (strict && raw.at !== undefined && !isDateTime(raw.at)) return { ok: false, reason: 'at must be an RFC 3339 date-time' };
  if (strict && raw.action === 'ask' && !note) return { ok: false, reason: 'ask needs the question in note' };
  if (strict && target === PRIMARY_TARGET && raw.action === 'approve' && !note) return { ok: false, reason: 'accounts.primary needs the account id in note' };
  const decision = { id: raw.id || null, at: isDateTime(raw.at) ? new Date(raw.at).toISOString() : null, runId, target, action: raw.action };
  if (note) decision.note = note;
  if (exclude.length) decision.exclude = exclude;
  if (rev && target !== PRIMARY_TARGET) decision.rev = rev; // the primary account has no revision
  decision.via = raw.via === 'chat' || raw.via === 'board' ? raw.via : via;
  if (!decision.id) decision.id = derivedId(decision);
  return { ok: true, decision };
}

const looksLikeDecision = (v) => isObject(v) && typeof v.action === 'string';

/**
 * The decision inside one document: the document itself, or what it keeps under `data` /
 * `fields` / `value` / `doc` / `document`. `key` (the document id) is the target when the
 * decision names none. Anything else comes back unchanged.
 */
function unwrapDoc(v, key) {
  if (!isObject(v)) return v;
  let d = null;
  if (looksLikeDecision(v)) d = v;
  else for (const k of ['data', 'fields', 'value', 'doc', 'document']) if (looksLikeDecision(v[k])) { d = v[k]; break; }
  if (!d) return v;
  if (d.target !== undefined) return d;
  const fallback = d !== v && typeof v.id === 'string' ? v.id : key;
  return fallback === undefined ? d : { ...d, target: fallback };
}

/**
 * Decisions inside whatever `--ingest <file>` was given: a JSON array, a map keyed by document id
 * (the Artifact database keeps one document per target), or either wrapped in an export envelope.
 */
export function extractDecisions(json) {
  if (Array.isArray(json)) return json.map((v) => unwrapDoc(v));
  if (!isObject(json)) return [];
  if (looksLikeDecision(json)) return [json];
  for (const k of ['decisions', 'documents', 'docs', 'rows']) {
    if (Array.isArray(json[k]) || (isObject(json[k]) && !looksLikeDecision(json[k]))) return extractDecisions(json[k]);
  }
  return Object.entries(json).map(([key, v]) => unwrapDoc(v, key));
}

/**
 * A file of an export as an answer may name it: its base name, without control characters, with
 * an e-mail address masked, at most 80 characters. A name that looks like a credential is not
 * repeated at all: the file is named by its place among the JSON files of the directory, in name
 * order. A file name is data like any other, and it is printed.
 */
function ingestSource(name, position) {
  const base = path.basename(String(name)).replace(/[\u0000-\u001f\u007f]/g, '');
  if (hasCredential(base)) return `file #${position} (its name is withheld: it looks like a credential)`;
  return `file ${maskEmails(base.length > 80 ? `${base.slice(0, 79)}…` : base)}`;
}

/**
 * `--ingest <directory>`: the shape an Artifact database export gives, one JSON file per
 * document, named after the document id (which is the target). Files that are not `.json` are
 * ignored; one that cannot be read or parsed is reported and the rest is still taken in.
 * Returns { entries, sources, rejected, files, ignored }; `sources[i]` says where `entries[i]`
 * came from.
 */
export function readIngestDir(dir) {
  let names;
  try { names = fs.readdirSync(dir).sort(); } catch { throw new RunError('--ingest directory cannot be read'); }
  const out = { entries: [], sources: [], rejected: [], files: 0, ignored: 0 };
  for (const name of names) {
    if (!/\.json$/i.test(name)) { out.ignored++; continue; }
    const source = ingestSource(name, out.files + 1);
    if (out.files >= MAX_INGEST_FILES) { out.rejected.push({ source: 'directory', reason: `more than ${MAX_INGEST_FILES} JSON files; the rest was not read` }); break; }
    out.files++;
    let json;
    try {
      const file = path.join(dir, name);
      const st = fs.statSync(file);
      if (!st.isFile()) { out.rejected.push({ source, reason: 'cannot be read: not a file' }); continue; }
      if (st.size > MAX_INGEST_FILE_BYTES) { out.rejected.push({ source, reason: 'larger than 1 MB' }); continue; }
      json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      // Never the parser's message: it quotes the input.
      out.rejected.push({ source, reason: e instanceof SyntaxError ? 'not valid JSON' : 'cannot be read' });
      continue;
    }
    const one = unwrapDoc(json, name.replace(/\.json$/i, ''));
    const list = looksLikeDecision(one) ? [one] : extractDecisions(json);
    if (!list.length) { out.rejected.push({ source, reason: 'holds no decision' }); continue; }
    list.forEach((d, i) => { out.entries.push(d); out.sources.push(list.length > 1 ? `${source} entry ${i + 1}` : source); });
  }
  return out;
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

/**
 * Apply one decision to one item. Returns 'applied', 'superseded' or 'skipped'. An approval of an
 * item held for an open experiment (experiments.mjs) is skipped unless the decision overrides the
 * experiment (`decide --override-experiment`): `s.held` and `s.override` say which.
 */
function decideItem(item, status, d, report, s) {
  const o = status.items[item.id] || (status.items[item.id] = {});
  const last = [o.decidedAt, o.askedAt].filter(Boolean).sort().pop();
  if (last && d.at < last) return 'superseded'; // a newer decision on this item was already taken in
  if (d.action === 'approve' && s.held.has(item.id)) {
    const e = s.held.get(item.id);
    if (!s.override) {
      s.heldOut.push({ target: d.target, item: item.id, harness: item.harness, until: e.until });
      report.skipped.push({ target: d.target, item: item.id, reason: `held for the experiment open until ${dayOf(e.until)}` });
      return 'skipped';
    }
    s.overridden.push({ item: item.id, harness: item.harness, until: e.until });
  }
  if (d.action === 'ask') {
    if (DECISION_STATUSES.includes(item.status)) { o.status = 'open'; item.status = 'open'; delete o.rev; }
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
  // The revision this decision is a yes or a no to. A group decision reaches here only when the
  // group's rev matched, which means every member is the revision the user saw.
  o.rev = item.rev;
  delete o.invalidated;
  if (d.note) o.decision = d.note; else delete o.decision;
  delete o.question;
  o.decidedAt = d.at;
  o.updatedAt = d.at;
  if (d.action === 'approve') (report.approvedByHarness[item.harness] = report.approvedByHarness[item.harness] || []).push(item.id);
  return 'applied';
}

/**
 * A stale decision `d` reached an item that has a decision. When `d` is the newer of the two, the
 * user acted on an outdated page after deciding: clear the decision, so the item is open until
 * they decide on what it proposes now. Returns true when the item was reopened.
 */
function reopen(item, status, d) {
  const o = status.items[item.id];
  if (!o || !DECISION_STATUSES.includes(item.status)) return false;
  const last = [o.decidedAt, o.askedAt].filter(Boolean).sort().pop();
  if (last && d.at < last) return false; // made before the decision that stands
  o.invalidated = { status: o.status, ...(typeof o.rev === 'string' ? { rev: o.rev } : {}), at: d.at };
  o.status = 'open';
  item.status = 'open';
  delete o.rev;
  delete o.decision;
  o.updatedAt = d.at;
  return true;
}

const STALE_REASON = {
  changed: 'the proposal changed after this decision was made',
  'no-board': 'the decision carries no rev and no board was built yet',
  'not-on-board': 'the decision carries no rev and the last built board does not show this target',
};

function applyDecision(d, s, report, unbound) {
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
  const item = group ? null : s.items.get(d.target);
  if (!group && !item) { report.unknown.push({ target: d.target, reason: GROUP_RE.test(d.target) ? 'no such group' : 'no such item' }); return 'unknown-target'; }

  // Not the revision on the table now: it is not applied, whatever the action.
  const currentRev = (group || item).rev;
  if (d.rev !== currentRev) {
    const decidedRev = d.rev || null;
    const exclude = new Set(d.exclude || []);
    const members = group ? group.items.filter((id) => !exclude.has(id)).map((id) => s.items.get(id)) : [item];
    const reopened = members.filter((it) => reopen(it, s.status, d)).map((it) => it.id);
    report.stale.push({
      id: d.id, target: d.target, action: d.action, decidedRev, currentRev,
      reason: STALE_REASON[decidedRev ? 'changed' : (unbound || 'not-on-board')],
      ...(d.action === 'ask' && d.note ? { note: d.note } : {}),
      ...(reopened.length ? { reopened } : {}),
    });
    s.log.push({ at: d.at, event: 'stale-decision', ...(item ? { harness: item.harness, item: item.id } : { target: d.target }), action: d.action, via: d.via, decidedRev, currentRev });
    for (const id of reopened) s.log.push({ at: d.at, event: 'decision-reopened', harness: s.items.get(id).harness, item: id, was: s.status.items[id].invalidated.status });
    return 'stale';
  }

  if (group) {
    const exclude = new Set(d.exclude || []);
    const results = group.items.filter((id) => !exclude.has(id)).map((id) => decideItem(s.items.get(id), s.status, d, report, s));
    const count = results.filter((r) => r === 'applied').length;
    if (count) s.log.push({ at: d.at, event: 'decision', target: d.target, action: d.action, via: d.via, count, ...(d.note ? { note: d.note } : {}) });
    if (count) return 'applied';
    return results.includes('superseded') ? 'superseded' : 'skipped';
  }
  const result = decideItem(item, s.status, d, report, s);
  if (result === 'applied') s.log.push({ at: d.at, event: 'decision', harness: item.harness, item: item.id, action: d.action, via: d.via, ...(d.note ? { note: d.note } : {}) });
  return result;
}

/**
 * Take in every decision not seen before: the lines of decisions.jsonl, plus `extra` (already
 * extracted from a file, or the one `decide` builds). `extra` decisions are appended to
 * decisions.jsonl too, so that file stays the full record of what was decided.
 * `opts.sources[i]` names where `extra[i]` came from; `opts.rejected` are entries the caller
 * already refused (a file of an ingested directory that could not be read).
 */
export function takeIn(ctx, extra = [], extraVia = 'board', opts = {}) {
  const { paths } = ctx;
  let changed = false;
  const taken = withLock(paths.mutex, () => {
    const run = readJson(paths.run);
    const status = loadStatus(paths);
    if (!Array.isArray(status.rejected)) status.rejected = [];
    const findings = loadFindings(paths, run);
    const { items } = loadItems(paths, run, findings, status);
    const itemMap = new Map(items.map((i) => [i.id, i]));
    const groups = withGroupRevs(resolveGroups(paths, run, findings, new Set(itemMap.keys()), { assign: true }), items);
    const groupMap = new Map(groups.map((g) => [g.id, g]));
    const known = new Set(status.decisions.map((d) => d.id));
    const report = { runId: paths.runId, new: [], approvedByHarness: {}, questions: [], unknown: [], skipped: [], stale: [], rejected: [...(opts.rejected || [])], duplicates: 0 };
    const now = nowIso();
    const fresh = [];
    const queued = new Set();
    let statusChanged = false;
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
      if (!consider(res, false, `decisions.jsonl line ${i + 1}`)) { status.rejected.push(key); statusChanged = true; }
    });
    extra.forEach((raw, i) => consider(normalizeDecision(raw, { runId: paths.runId, via: extraVia }), true, (opts.sources && opts.sources[i]) || `entry ${i + 1}`));

    // The revs of the last built board, read once and only when a decision came without one.
    let built;
    const builtRev = (target) => {
      if (built === undefined) built = builtRevs(paths);
      return built ? (built.items.get(target) || built.groups.get(target) || null) : null;
    };

    fresh.sort((a, b) => a.d.at.localeCompare(b.d.at));
    const s = {
      run, status, items: itemMap, groups: groupMap, log: [], runChanged: false,
      held: heldItems(run, items), override: opts.overrideExperiment === true, heldOut: [], overridden: [],
    };
    for (const { d, fromFile } of fresh) {
      let unbound = null;
      if (d.target !== PRIMARY_TARGET && !d.rev) {
        if (fromFile && extraVia === 'chat') {
          // Said in chat, about the item as it is now.
          const target = groupMap.get(d.target) || itemMap.get(d.target);
          if (target) d.rev = target.rev;
        } else {
          const rev = builtRev(d.target);
          if (rev) d.rev = rev; else unbound = built ? 'not-on-board' : 'no-board';
        }
      }
      if (fromFile) appendJsonLine(paths.decisions, d);
      const result = applyDecision(d, s, report, unbound);
      status.decisions.push({ ...d, result, ingestedAt: now });
      report.new.push({ ...d, result });
    }
    for (const [harness, ids] of Object.entries(report.approvedByHarness)) {
      const still = [...new Set(ids)].filter((id) => itemMap.get(id).status === 'approved');
      if (still.length) report.approvedByHarness[harness] = still; else delete report.approvedByHarness[harness];
    }
    if (fresh.length || statusChanged) writeJsonAtomic(paths.status, status);
    if (s.runChanged) { writeJsonAtomic(paths.run, run); ctx.run = run; }
    for (const x of s.overridden) s.log.push({ at: now, event: 'experiment-override', harness: x.harness, item: x.item, until: x.until });
    for (const e of s.log) appendLog(paths, e);
    if (s.heldOut.length) report.heldForExperiment = s.heldOut;
    if (s.overridden.length) {
      report.experimentOverridden = s.overridden;
      report.warnings = s.overridden.map((x) => `${x.item} was approved while the experiment on ${x.harness} is open (until ${dayOf(x.until)}): the next measurement will mix the two effects`);
    }
    changed = report.new.some((d) => d.result === 'applied') || report.stale.some((x) => x.reopened);
    return report;
  });
  return changed ? refreshRecords(ctx, taken) : taken;
}

/** `decide --target <id> --action approve|decline|defer|ask [--note <t>] [--exclude <id,id>] [--rev <rev>]`. */
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
  // The rev the user was looking at (a command copied from the board carries it). Without it the
  // decision is about the item as it is now.
  if (args.rev !== undefined) {
    if (typeof args.rev !== 'string') throw new UsageError('--rev takes the revision shown with the item or group');
    raw.rev = args.rev;
  }
  if (args['override-experiment'] !== undefined && args['override-experiment'] !== true) throw new UsageError('--override-experiment takes no value');
  const override = args['override-experiment'] === true;
  const res = normalizeDecision(raw, { runId: ctx.paths.runId, via: 'chat', strict: true });
  if (!res.ok) throw new UsageError(res.reason);
  if (res.decision.exclude && !GROUP_RE.test(res.decision.target)) throw new UsageError('--exclude only applies to a group target');
  if (res.decision.action === 'approve' && !override) refuseHeld(ctx, res.decision);
  return takeIn(ctx, [res.decision], 'chat', { overrideExperiment: override });
}

/**
 * An approval that reaches an item held for an open experiment is refused before anything is
 * recorded: approving it now would change what loads at the start of every session in the middle
 * of a measurement. The user may still want it: `--override-experiment` says so.
 */
function refuseHeld(ctx, d) {
  const { paths, run } = ctx;
  const findings = loadFindings(paths, run);
  const { items } = loadItems(paths, run, findings);
  const held = heldItems(run, items);
  if (!held.size) return;
  let targets = [d.target];
  if (GROUP_RE.test(d.target)) {
    const group = resolveGroups(paths, run, findings, new Set(items.map((i) => i.id))).find((g) => g.id === d.target);
    const exclude = new Set(d.exclude || []);
    targets = group ? group.items.filter((id) => !exclude.has(id)) : [];
  }
  const hit = targets.filter((id) => held.has(id)).map((id) => {
    const e = held.get(id);
    return { item: id, harness: items.find((i) => i.id === id).harness, until: e.until, ...(e.note ? { note: e.note } : {}) };
  });
  if (!hit.length) return;
  const where = [...new Set(hit.map((x) => `${x.harness} until ${dayOf(x.until)}`))].join(', ');
  throw new RunError(`${hit.map((x) => x.item).join(', ')} ${hit.length > 1 ? 'are' : 'is'} held for the experiment open on ${where}: approving it now changes what loads at the start of every session and would confound the measurement. Nothing was recorded. If the user still wants it now, decide again with --override-experiment`, { heldForExperiment: hit });
}

/** `decisions [--ingest <file.json|directory>]`. */
export function decisions(ctx, ingestPath) {
  if (!ingestPath) return takeIn(ctx, [], 'board');
  let st;
  try { st = fs.statSync(ingestPath); } catch { throw new RunError('--ingest file not found'); }
  if (st.isDirectory()) {
    const got = readIngestDir(ingestPath);
    const report = takeIn(ctx, got.entries, 'board', { sources: got.sources, rejected: got.rejected });
    return { ...report, ingest: { files: got.files, ignored: got.ignored } };
  }
  let json;
  try { json = JSON.parse(fs.readFileSync(ingestPath, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
    throw new RunError(e && e.code === 'ENOENT' ? '--ingest file not found' : '--ingest file is not valid JSON');
  }
  return takeIn(ctx, extractDecisions(json), 'board');
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
