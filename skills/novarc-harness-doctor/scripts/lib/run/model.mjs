// Read side of a run: the run file, the findings reviewers handed in, the status overlay, and the
// items that result from the two. `build`, `decide`, `mark`, `next` and `status` all read the run
// through here, so they agree on what an item's status is even when `state.json` is stale.
import fs from 'node:fs';
import path from 'node:path';
import { RunError, UsageError, readJson, readText, writeJsonAtomic, appendJsonLine, sha256, nowIso, nowMs } from './store.mjs';
import { runPaths, latestRunId, RUN_ID_RE } from './paths.mjs';
import { staticUnits, unitsView } from './units.mjs';
import { itemRev, groupRev, DECISION_STATUSES } from './rev.mjs';
import { earlierRecords, carriedDecline } from './followup.mjs';
import { markerPath } from './experiments.mjs';

/** `--run <id>`, else the latest run. */
export function resolveRunId(args) {
  if (args.run !== undefined) {
    if (typeof args.run !== 'string' || !RUN_ID_RE.test(args.run)) throw new UsageError('--run takes a run id such as 20260101-ab12');
    return args.run;
  }
  const latest = latestRunId();
  if (!latest) throw new RunError('no run found: start one with `run.mjs init --select <selection.json>`');
  return latest;
}

/** `{ paths, run }` for an existing run. */
export function loadRun(runId) {
  const paths = runPaths(runId);
  const run = readJson(paths.run);
  if (!run || !Array.isArray(run.harnesses)) throw new RunError(`run ${runId} not found`);
  return { paths, run };
}

export function emptyStatus() { return { version: 1, items: {}, decisions: [], questions: [] }; }

export function loadStatus(paths) {
  const s = readJson(paths.status) || emptyStatus();
  if (!s.items || typeof s.items !== 'object') s.items = {};
  if (!Array.isArray(s.decisions)) s.decisions = [];
  if (!Array.isArray(s.questions)) s.questions = [];
  return s;
}

/** Findings files of the static units, in unit order: `[{ unit, data }]`. */
export function loadFindings(paths, run) {
  const out = [];
  for (const u of staticUnits(run)) {
    const data = readJson(paths.findingsFile(u.id));
    if (data && typeof data === 'object' && !Array.isArray(data)) out.push({ unit: u, data });
  }
  return out;
}

const itemNumber = (id) => Number(String(id).split('-').pop()) || 0;

/** Overlay fields that replace the reviewer's value on an item. */
const OVERLAY_FIELDS = ['status', 'decision', 'question', 'verified', 'notVerified', 'backup', 'updatedAt'];

/**
 * Every item of the run with its effective status: the reviewer's item (status `open` unless it
 * says `ok` or `not-applicable`) with the status overlay on top, and its `rev` (rev.mjs). Sorted
 * by harness, round, number. `duplicates` lists ids that appeared in more than one findings file
 * (the first one wins).
 *
 * A decision belongs to the revision it was made on. An item whose stored decision (approved,
 * declined, deferred) carries another rev than the item has now, or none, is `open` here, so
 * nothing downstream (the apply units, `mark`, `next`, the board) can act on a yes that was given
 * to another proposal. `outdated` maps each item whose last decision was made on another revision
 * to `{ status, decidedRev, currentRev }`, until the user decides again.
 *
 * The same rule holds across runs. A decline is the user's word on one exact proposal, so an item
 * that is the same proposal the user declined in an earlier review of that harness (its
 * `previous` names the declined item and the revisions are equal: `carriedDecline`, followup.mjs)
 * is `declined` here, with the date of that decision in `updatedAt`, its note in `decision`, and
 * `carriedFrom: { run, item }` saying where it comes from. A reviewer cannot set `declined`, and
 * pointing at a declined item with another proposal carries nothing: that item is `open`.
 * Whatever the user did to the item in this run comes first.
 */
export function loadItems(paths, run, findings = loadFindings(paths, run), status = loadStatus(paths)) {
  const order = new Map(run.harnesses.map((h, i) => [h.id, i]));
  const harnessOf = new Map(run.harnesses.map((h) => [h.id, h]));
  const seen = new Map();
  const duplicates = [];
  const outdated = new Map();
  for (const { unit, data } of findings) {
    for (const raw of Array.isArray(data.items) ? data.items : []) {
      if (!raw || typeof raw.id !== 'string' || !order.has(raw.harness)) continue;
      if (seen.has(raw.id)) { duplicates.push(raw.id); continue; }
      const rev = itemRev(raw);
      // A reviewer says `ok` or `not-applicable`; anything else is a finding to decide on.
      const item = { ...raw, status: raw.status === 'ok' || raw.status === 'not-applicable' ? raw.status : 'open', rev };
      delete item.group; // assigned by build from the groups
      delete item.carriedFrom; // set here and nowhere else
      const o = Object.hasOwn(status.items, raw.id) ? status.items[raw.id] : undefined;
      if (item.status === 'open' && raw.previous !== undefined && !(o && o.status !== undefined)) {
        const carried = carriedDecline(run, harnessOf.get(raw.harness), raw, rev);
        if (carried) {
          item.status = 'declined';
          item.updatedAt = carried.at;
          if (carried.note) item.decision = carried.note;
          item.carriedFrom = { run: carried.run, item: carried.item };
        }
      }
      if (o) {
        const unbound = DECISION_STATUSES.includes(o.status) && o.rev !== rev;
        for (const f of OVERLAY_FIELDS) {
          if (unbound && (f === 'status' || f === 'decision')) continue;
          if (o[f] === null) delete item[f];
          else if (o[f] !== undefined) item[f] = o[f];
        }
        if (unbound) outdated.set(raw.id, { status: o.status, decidedRev: typeof o.rev === 'string' ? o.rev : null, currentRev: rev });
        else if (item.status === 'open' && o.invalidated && DECISION_STATUSES.includes(o.invalidated.status)) {
          outdated.set(raw.id, { status: o.invalidated.status, decidedRev: typeof o.invalidated.rev === 'string' ? o.invalidated.rev : null, currentRev: rev });
        }
        if (Array.isArray(item.changes) && o.applied === true) item.changes = item.changes.map((c) => ({ ...c, applied: true }));
      }
      seen.set(raw.id, { item, unit: unit.id });
    }
  }
  const items = [...seen.values()].map((x) => x.item).sort((a, b) => (order.get(a.harness) - order.get(b.harness)) || (a.round - b.round) || (itemNumber(a.id) - itemNumber(b.id)) || a.id.localeCompare(b.id));
  return { items, duplicates, outdated, unitOf: new Map([...seen.entries()].map(([id, x]) => [id, x.unit])) };
}

/** `groups` with the `rev` of each one (rev.mjs), from the items as they are now. */
export function withGroupRevs(groups, items) {
  const revOf = new Map(items.map((i) => [i.id, i.rev]));
  return groups.map((g) => ({ ...g, rev: groupRev(g.items, revOf) }));
}

function groupKey(itemIds) { return sha256([...itemIds].sort().join('\n')).slice(0, 20); }

/**
 * Groups from the findings with their `G-<n>` ids. An id is assigned the first time a group (the
 * set of its items) is seen and kept in groups.json, so a decision recorded for `G-2` keeps
 * pointing at the same group when another unit completes later. `assign: true` writes new ids and
 * must run under the run mutex; without it, a group that has no id yet is left out.
 */
export function resolveGroups(paths, run, findings, knownItemIds, { assign = false } = {}) {
  const reg = readJson(paths.groups) || { version: 1, next: 1, ids: {} };
  if (!reg.ids || typeof reg.ids !== 'object') reg.ids = {};
  if (!Number.isInteger(reg.next) || reg.next < 1) reg.next = 1;
  const out = [];
  const used = new Set();
  let changed = false;
  for (const { unit, data } of findings) {
    for (const g of Array.isArray(data.groups) ? data.groups : []) {
      if (!g || !Array.isArray(g.items)) continue;
      const members = [...new Set(g.items.filter((id) => knownItemIds.has(id)))];
      if (members.length < 2) continue;
      const key = groupKey(members);
      if (used.has(key)) continue; // the same set of items grouped twice
      let id = reg.ids[key];
      if (!id) {
        if (!assign) continue;
        id = `G-${reg.next++}`;
        reg.ids[key] = id;
        changed = true;
      }
      used.add(key);
      const group = { id, title: String(g.title || ''), round: g.round, items: members };
      if (typeof g.summary === 'string' && g.summary) group.summary = g.summary;
      out.push({ group, unit: unit.id });
    }
  }
  if (changed) writeJsonAtomic(paths.groups, reg);
  out.sort((a, b) => Number(a.group.id.slice(2)) - Number(b.group.id.slice(2)));
  return out.map((x) => x.group);
}

/** Units with their effective status (see units.mjs). */
export function loadUnits(paths, run, items, now = nowMs()) {
  return unitsView(paths, run, readJson(paths.queue), items, now);
}

/** Append one event to the run's log (rendered into `state.log` by build). */
export function appendLog(paths, event) {
  appendJsonLine(paths.log, { at: nowIso(), ...event });
}

export function harnessById(run, id) { return run.harnesses.find((h) => h.id === id) || null; }

/**
 * One hash over everything `build` reads. `build` stores it; `next` compares, to tell whether the
 * board is behind the run directory. Probe files count by size and mtime (they can be megabytes),
 * the small files by content.
 */
export function inputsFingerprint(paths, run) {
  const { closed: _closed, closedAt: _closedAt, ...settings } = run;
  const parts = [JSON.stringify(settings)];
  const content = (file) => { const t = readText(file); return t === null ? '-' : sha256(t); };
  const stat = (file) => { try { const s = fs.statSync(file); return `${s.size}:${Math.round(s.mtimeMs)}`; } catch { return '-'; } };
  for (const u of staticUnits(run)) parts.push(`findings ${u.id} ${content(paths.findingsFile(u.id))}`);
  parts.push(`status ${content(paths.status)}`, `log ${content(paths.log)}`);
  for (const h of run.harnesses) for (const name of ['snapshot.json', 'impact.json', 'estimates.json']) parts.push(`probe ${h.id}/${name} ${stat(path.join(paths.probeDir(h.id), name))}`);
  parts.push(`probe accounts/diff.json ${stat(path.join(paths.probeDir('accounts'), 'diff.json'))}`);
  // The review records a follow-up is compared with (never this run's own).
  for (const h of run.harnesses) for (const e of earlierRecords(run, h)) parts.push(`record ${e.record.harnessKey}/${e.name} ${stat(e.file)}`);
  // An experiment ended early (`run.mjs experiment end`) changes what the board shows.
  for (const h of run.harnesses) {
    const last = earlierRecords(run, h).slice(-1)[0];
    if (last) parts.push(`ended ${last.record.harnessKey}/${last.record.runId} ${stat(markerPath(last.record.harnessKey, last.record.runId))}`);
  }
  return sha256(parts.join('\n'));
}
