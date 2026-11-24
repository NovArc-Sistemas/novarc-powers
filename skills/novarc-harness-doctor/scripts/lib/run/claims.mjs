// claim / release / complete: how sessions share the work queue.
//
// A claim is the lock file `claims/<unit>.lock`. Creating it with an exclusive open is the atomic
// step: of any number of processes racing for a unit, exactly one open succeeds. A claim older
// than its ttl is taken over under the run mutex, by re-checking it and renaming a new lock over
// the old one, so two processes can never both take over the same stale claim.
import fs from 'node:fs';
import path from 'node:path';
import { RunError, UsageError, readJson, writeJsonAtomic, writeTextAtomic, withLock, nowIso, nowMs, isTransient } from './store.mjs';
import { SKILL_DIR } from './paths.mjs';
import { loadStateSchema } from './schema.mjs';
import { loadFindings, loadItems, loadStatus, loadUnits, appendLog } from './model.mjs';
import { readClaim, claimable, queueSnapshot, roundApplies, ROUND_FILES, DEFAULT_TTL_MINUTES, ACCOUNTS_ID_BLOCK } from './units.mjs';
import { validateFindings, findingsTemplate } from './findings.mjs';
import { itemRev, DECISION_STATUSES } from './rev.mjs';
import { hasCredential } from './secrets.mjs';
import { harnessKeyOf, lastRecordOf, previousItem, carriedDecline } from './followup.mjs';
import { refreshRecords } from './history.mjs';

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;

export function requireSession(args) {
  if (typeof args.session !== 'string' || !SESSION_RE.test(args.session)) {
    throw new UsageError('--session takes a short label (letters, digits, . _ : @ -), e.g. --session claude-main');
  }
  // The label is written to the claim, the queue, the findings and the log.
  if (hasCredential(args.session)) throw new UsageError('--session takes a short label, not a credential');
  return args.session;
}

function view(ctx, now = nowMs()) {
  const { items } = loadItems(ctx.paths, ctx.run);
  return loadUnits(ctx.paths, ctx.run, items, now);
}

/** Rewrite queue.json from the claim files. Must run under the run mutex. */
function syncQueue(ctx) {
  const snap = queueSnapshot(view(ctx));
  writeJsonAtomic(ctx.paths.queue, snap);
  return snap;
}

function isDone(ctx, unitId) {
  const q = readJson(ctx.paths.queue);
  return !!(q && Array.isArray(q.units) && q.units.some((u) => u.id === unitId && u.status === 'done'));
}

function lockText(unitId, session, ttlMinutes) {
  return JSON.stringify({ unit: unitId, session, at: nowIso(), ttlMinutes }) + '\n';
}

/**
 * Try to make `session` the holder of `unitId`.
 * Returns { ok: true, takeover?: <previous session> } or { ok: false, holder }.
 */
function tryClaim(ctx, unitId, session, ttlMinutes) {
  const file = ctx.paths.claimFile(unitId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd = null;
    try { fd = fs.openSync(file, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST' && !isTransient(e)) throw e;
    }
    if (fd !== null) {
      try { fs.writeSync(fd, lockText(unitId, session, ttlMinutes)); } finally { fs.closeSync(fd); }
      return { ok: true };
    }
    const held = readClaim(ctx.paths, unitId);
    if (!held) continue; // released between the two calls: try the exclusive create again
    if (held.session === session) {
      // Our own claim: keep it and refresh its clock.
      return withLock(ctx.paths.mutex, () => {
        const again = readClaim(ctx.paths, unitId);
        if (!again || again.session !== session) return { ok: false, holder: again };
        writeTextAtomic(file, lockText(unitId, session, ttlMinutes));
        return { ok: true, resumed: true };
      });
    }
    if (!held.stale) return { ok: false, holder: held };
    const res = withLock(ctx.paths.mutex, () => {
      const again = readClaim(ctx.paths, unitId);
      if (!again) return null; // released meanwhile: go back to the exclusive create
      if (again.session !== held.session || again.at !== held.at || !again.stale) return { ok: false, holder: again };
      writeTextAtomic(file, lockText(unitId, session, ttlMinutes)); // rename over the stale lock
      return { ok: true, takeover: held.session || 'unknown' };
    });
    if (res) return res;
  }
  return { ok: false, holder: readClaim(ctx.paths, unitId) };
}

function idRule(unit, harnesses) {
  if (unit.kind === 'apply') return 'No new items: apply the approved ones listed in `items`.';
  if (unit.kind === 'accounts') {
    return `Item ids are <KEY>-${ACCOUNTS_ID_BLOCK}<nn>: the harness key, a dash, ${ACCOUNTS_ID_BLOCK}, and a two-digit counter from 01 (e.g. ${harnesses[0] ? harnesses[0].key : 'U1'}-${ACCOUNTS_ID_BLOCK}01). Set each item's round to the round it belongs to.`;
  }
  const example = harnesses[0] ? `${harnesses[0].key}-${unit.rounds[0]}01` : `KEY-${unit.rounds[0]}01`;
  return `Item ids are <KEY>-<round><nn>: the harness key, a dash, the item's round (${unit.rounds.join(' or ')}) and a two-digit counter from 01 per harness and round (e.g. ${example}).`;
}

/** The brief a session works from: what `claim` prints. */
export function unitBrief(ctx, unit, session, extra = {}) {
  const harnesses = unit.harnesses.map((id) => ctx.run.harnesses.find((h) => h.id === id)).filter(Boolean).map((h) => {
    const out = { id: h.id, key: h.key, kind: h.kind, name: h.name, path: h.path, pathAbs: h.pathAbs, probesDir: ctx.paths.probeDir(h.id) };
    if (h.inherits) out.inherits = h.inherits;
    out.harnessKey = harnessKeyOf(h);
    // The record of the last review of this harness (references/follow-up.md): a reviewer reads
    // its items before proposing anything, and links what was seen before with `previous`.
    const last = unit.kind === 'apply' ? null : lastRecordOf(ctx.run, h);
    if (last) out.lastRecord = { runId: last.record.runId, reviewedAt: last.record.reviewedAt, file: last.file };
    return out;
  });
  let roundFiles = unit.rounds.map((r) => ROUND_FILES[r]);
  if (unit.kind === 'accounts') roundFiles = ['references/accounts.md'];
  if (unit.kind === 'apply') roundFiles = ['references/doctor-policy.md', 'references/orchestration.md'];
  roundFiles = roundFiles.filter((f) => fs.existsSync(path.join(SKILL_DIR, f)));
  const idRanges = [];
  for (const h of harnesses) {
    if (unit.kind === 'accounts') idRanges.push({ harness: h.id, first: `${h.key}-${ACCOUNTS_ID_BLOCK}01`, last: `${h.key}-${ACCOUNTS_ID_BLOCK}99` });
    for (const r of unit.rounds) if (roundApplies(h, r)) idRanges.push({ harness: h.id, round: r, first: `${h.key}-${r}01`, last: `${h.key}-${r}99` });
  }
  const brief = {
    runId: ctx.paths.runId,
    unit: unit.id,
    session,
    harnesses,
    rounds: unit.rounds,
    roundFiles,
    skillDir: SKILL_DIR,
    idRule: idRule(unit, harnesses),
    idRanges,
    findingsTemplate: unit.kind === 'apply' ? null : findingsTemplate(unit, ctx.run, session),
    ...extra,
  };
  // `revs`: the revision of each item the user approved. Pass it to `mark --rev` so that what is
  // applied is the proposal that was read, not one that replaced it in between.
  if (unit.kind === 'apply') { brief.items = unit.approved; brief.inProgress = unit.inProgress; brief.revs = unit.revs; }
  if (unit.kind === 'accounts' && fs.existsSync(ctx.paths.probeDir('accounts'))) brief.accountsProbeDir = ctx.paths.probeDir('accounts');
  return brief;
}

/** `claim [--unit <id>] --session <label> [--ttl <minutes>]`. */
export function claim(ctx, { unitId = null, session, ttlMinutes = DEFAULT_TTL_MINUTES }) {
  if (ctx.run.closed) throw new RunError('this run is closed');
  const units = view(ctx);
  let candidates;
  if (unitId) {
    const u = units.find((x) => x.id === unitId);
    if (!u) throw new RunError(`no unit ${unitId} in this run (see \`run.mjs status\`)`);
    if (u.status === 'done') throw new RunError(`unit ${unitId} is already complete`);
    if (u.status === 'busy') throw new RunError(`unit ${unitId} cannot be claimed now: ${u.approved.length ? 'an item of this harness is being applied' : 'no approved item is waiting'}`);
    candidates = [u];
  } else {
    // A session that already holds a unit gets it back: this is how a session resumes.
    const mine = units.find((u) => u.status === 'claimed' && u.claim.session === session);
    candidates = mine ? [mine] : units.filter(claimable);
  }
  for (const u of candidates) {
    const res = tryClaim(ctx, u.id, session, ttlMinutes);
    if (!res.ok) {
      if (unitId) throw new RunError(`unit ${unitId} is claimed by ${res.holder && res.holder.session ? res.holder.session : 'another session'}`, { holder: res.holder });
      continue;
    }
    if (u.kind !== 'apply' && isDone(ctx, u.id)) {
      // Completed by someone else between our read and our claim.
      withLock(ctx.paths.mutex, () => { try { fs.unlinkSync(ctx.paths.claimFile(u.id)); } catch { /* gone */ } });
      if (unitId) throw new RunError(`unit ${unitId} is already complete`);
      continue;
    }
    withLock(ctx.paths.mutex, () => syncQueue(ctx));
    const extra = {};
    if (res.takeover) extra.takenOverFrom = res.takeover;
    if (res.resumed) extra.resumed = true;
    return unitBrief(ctx, u, session, extra);
  }
  const still = view(ctx);
  return {
    runId: ctx.paths.runId,
    unit: null,
    session,
    reason: 'no unit is free to claim',
    claimed: still.filter((u) => u.status === 'claimed').map((u) => ({ unit: u.id, session: u.claim.session, ageMinutes: u.claim.ageMinutes })),
  };
}

/** `release --unit <id> --session <label>`: give a unit back. */
export function release(ctx, { unitId, session }) {
  return withLock(ctx.paths.mutex, () => {
    const held = readClaim(ctx.paths, unitId);
    if (!held) return { runId: ctx.paths.runId, unit: unitId, released: false, reason: 'not claimed' };
    if (held.session !== session) throw new RunError(`unit ${unitId} is claimed by ${held.session || 'another session'}, not by ${session}`);
    try { fs.unlinkSync(ctx.paths.claimFile(unitId)); } catch { /* gone */ }
    syncQueue(ctx);
    return { runId: ctx.paths.runId, unit: unitId, released: true };
  });
}

/** `complete --unit <id> --session <label> [--findings <file>]`. */
export function complete(ctx, { unitId, session, findingsPath }) {
  const units = view(ctx);
  const unit = units.find((u) => u.id === unitId);
  if (!unit) throw new RunError(`no unit ${unitId} in this run (see \`run.mjs status\`)`);
  const heldByOther = (c) => c && c.session !== session && !c.stale;

  if (unit.kind === 'apply') {
    if (findingsPath) throw new UsageError('an apply unit takes no --findings file');
    return withLock(ctx.paths.mutex, () => {
      const held = readClaim(ctx.paths, unitId);
      if (heldByOther(held)) throw new RunError(`unit ${unitId} is claimed by ${held.session}`);
      try { fs.unlinkSync(ctx.paths.claimFile(unitId)); } catch { /* not claimed */ }
      const { items } = loadItems(ctx.paths, ctx.run);
      const mine = items.filter((i) => i.harness === unit.harnesses[0]);
      return {
        ok: true, runId: ctx.paths.runId, unit: unitId,
        stillApproved: mine.filter((i) => i.status === 'approved').map((i) => i.id),
        stillInProgress: mine.filter((i) => i.status === 'in-progress').map((i) => i.id),
      };
    });
  }

  if (!findingsPath) throw new UsageError('complete needs --findings <file>');
  if (heldByOther(unit.claim)) throw new RunError(`unit ${unitId} is claimed by ${unit.claim.session}; it can be completed by that session, or by anyone once the claim is ${unit.claim.ttlMinutes} minutes old`);
  let data;
  try { data = JSON.parse(fs.readFileSync(findingsPath, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
    throw new RunError(e && e.code === 'ENOENT' ? 'findings file not found' : 'findings file is not valid JSON');
  }
  const loaded = loadStateSchema();
  const res = validateFindings(data, { unit, run: ctx.run, session, schemaRoot: loaded ? loaded.schema : null });
  if (res.errors.length) throw new RunError(`findings rejected: ${res.errors.length} problem(s)`, { errors: res.errors, warnings: res.warnings });

  // Item ids are unique across the run: another unit's file must not already use one.
  const others = loadFindings(ctx.paths, ctx.run).filter((f) => f.unit.id !== unitId);
  const taken = new Set(others.flatMap((f) => (Array.isArray(f.data.items) ? f.data.items.map((i) => i && i.id) : [])));
  const clash = res.normalized.items.filter((i) => taken.has(i.id)).map((i) => i.id);
  if (clash.length) throw new RunError('findings rejected: item ids already used by another unit', { errors: clash.map((id) => `/items: id ${id} is already used by another unit`) });

  // `previous` names the same finding in an earlier review of that harness. One that points at
  // nothing is told to the reviewer and kept. One that points at an item the user declined is
  // answered with whether that decline still stands: it does for the same proposal (the
  // revisions are equal), and the user is not asked again; another proposal is a new question.
  const declinedBefore = { same: [], changed: [] };
  res.normalized.items.forEach((i, n) => {
    if (i.previous === undefined) return;
    const h = ctx.run.harnesses.find((x) => x.id === i.harness);
    const before = previousItem(ctx.run, h, i.previous);
    if (!before) res.warnings.push(`/items/${n}/previous: no review record of this harness holds this run and item`);
    else if (before.item.status === 'declined' && i.status === 'open') (carriedDecline(ctx.run, h, i, itemRev(i)) ? declinedBefore.same : declinedBefore.changed).push(i.id);
  });

  // New findings change what a review record says: a run that already left records gets them again.
  return refreshRecords(ctx, withLock(ctx.paths.mutex, () => {
    const held = readClaim(ctx.paths, unitId);
    if (heldByOther(held)) throw new RunError(`unit ${unitId} is claimed by ${held.session}`);
    const replaced = fs.existsSync(ctx.paths.findingsFile(unitId));
    // The revision each item had in the file this one replaces.
    const revBefore = new Map();
    if (replaced) {
      let old = null;
      try { old = readJson(ctx.paths.findingsFile(unitId)); } catch { old = null; }
      for (const i of old && Array.isArray(old.items) ? old.items : []) if (i && typeof i.id === 'string') revBefore.set(i.id, itemRev(i));
    }
    // An item that is being applied, or was applied, is the record of what was done to the
    // harness: the board shows its changes as applied. Its proposal cannot be swapped under it
    // (its wording can). A fix that failed is different: it needs a new approval anyway.
    const status = loadStatus(ctx.paths);
    const frozen = [];
    res.normalized.items.forEach((i, n) => {
      const o = status.items[i.id];
      if (!o || (o.status !== 'in-progress' && o.status !== 'fixed')) return;
      const appliedRev = typeof o.rev === 'string' ? o.rev : revBefore.get(i.id);
      if (appliedRev === undefined || appliedRev === itemRev(i)) return;
      frozen.push(o.status === 'fixed'
        ? `/items/${n}: ${i.id} is fixed with another proposal; keep the item as it was applied, or undo it first (run.mjs undo --item ${i.id})`
        : `/items/${n}: ${i.id} is being applied with another proposal; keep the item as it is until it is marked fixed or failed`);
    });
    if (frozen.length) throw new RunError(`findings rejected: ${frozen.length} problem(s)`, { errors: frozen, warnings: res.warnings });
    writeJsonAtomic(ctx.paths.findingsFile(unitId), res.normalized);
    // Done is written before the claim goes away, so a racing `claim` that wins the freed lock
    // sees a finished unit and backs off.
    const completedAt = nowIso();
    const q = readJson(ctx.paths.queue) || { version: 1, units: [] };
    const entry = (q.units || []).find((u) => u.id === unitId);
    if (entry) Object.assign(entry, { status: 'done', completedAt, completedBy: session, claimedBy: null, claimedAt: null });
    else (q.units = q.units || []).push({ id: unitId, kind: unit.kind, rounds: unit.rounds, harnesses: unit.harnesses, status: 'done', completedAt, completedBy: session, claimedBy: null, claimedAt: null });
    writeJsonAtomic(ctx.paths.queue, q);
    try { fs.unlinkSync(ctx.paths.claimFile(unitId)); } catch { /* not claimed */ }
    syncQueue(ctx);
    appendLog(ctx.paths, { event: 'unit-complete', unit: unitId, session, items: res.normalized.items.length });
    const byHarness = {};
    const bySeverity = {};
    for (const i of res.normalized.items) {
      byHarness[i.harness] = (byHarness[i.harness] || 0) + 1;
      bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;
    }
    // Statuses decided before a re-complete stay in status.json; say which ones lost their item.
    const { items: all, outdated } = loadItems(ctx.paths, ctx.run, undefined, status);
    const known = new Set(all.map((i) => i.id));
    const orphaned = Object.keys(status.items).filter((id) => !known.has(id));

    // A decision is a yes or a no to one revision. An item of this unit that came back as another
    // revision goes back to open: the user decides again, looking at the new proposal. The old
    // decision stays in decisions.jsonl; what happened is logged.
    const mine = new Set(res.normalized.items.map((i) => i.id));
    const invalidated = [];
    for (const [id, was] of outdated) {
      const o = status.items[id];
      if (!mine.has(id) || !o || !DECISION_STATUSES.includes(o.status)) continue;
      o.invalidated = { status: was.status, ...(was.decidedRev ? { rev: was.decidedRev } : {}), at: completedAt };
      o.status = 'open';
      delete o.rev;
      delete o.decision;
      o.updatedAt = completedAt;
      const entry = { item: id, was: was.status, decidedRev: was.decidedRev, currentRev: was.currentRev };
      invalidated.push(entry);
      appendLog(ctx.paths, { event: 'decision-invalidated', harness: all.find((i) => i.id === id).harness, ...entry });
    }
    if (invalidated.length) writeJsonAtomic(ctx.paths.status, status);
    return {
      ok: true, runId: ctx.paths.runId, unit: unitId, session, replaced,
      stored: `findings/${path.basename(ctx.paths.findingsFile(unitId))}`,
      counts: { items: res.normalized.items.length, byHarness, bySeverity, inventory: res.normalized.inventory.length, groups: res.normalized.groups.length },
      warnings: res.warnings,
      ...(declinedBefore.same.length || declinedBefore.changed.length ? { declinedBefore } : {}),
      ...(invalidated.length ? { invalidated } : {}),
      ...(orphaned.length ? { orphanedStatuses: orphaned } : {}),
    };
  }));
}
