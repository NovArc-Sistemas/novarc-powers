// Units of work (references/contracts.md, "Units"): which exist for a run, what each one owns,
// and who holds it right now. A claim is one lock file per unit; the file is the truth and
// `queue.json` mirrors it for readers.
import fs from 'node:fs';
import { readText, nowMs } from './store.mjs';

export const REVIEW_UNITS = [
  { name: 'security', rounds: [1] },
  { name: 'instructions', rounds: [2, 3] },
  { name: 'gates', rounds: [4] },
  { name: 'skills-tools', rounds: [6, 7] },
  { name: 'cleanup-deps', rounds: [5, 8] },
];

/** A review unit covers at most this many harnesses; above it, the unit is split into chunks. */
export const CHUNK_SIZE = 6;
export const DEFAULT_TTL_MINUTES = 90;
export const ROUNDS = [1, 2, 3, 4, 5, 6, 7, 8];

/** Round files, relative to the skill folder. */
export const ROUND_FILES = {
  1: 'references/rounds/01-security-permissions.md',
  2: 'references/rounds/02-instructions-structure.md',
  3: 'references/rounds/03-documentation.md',
  4: 'references/rounds/04-gates-automation.md',
  5: 'references/rounds/05-cleanup.md',
  6: 'references/rounds/06-skills-knowledge.md',
  7: 'references/rounds/07-clis-tools.md',
  8: 'references/rounds/08-external-dependencies.md',
};

/** The id block the `accounts` unit owns: `<KEY>-9nn`. Review units own `<KEY>-<round>nn`. */
export const ACCOUNTS_ID_BLOCK = 9;

/** Round 3 (documentation) is about a repository; it does not apply to a user harness. */
export function roundApplies(harness, round) {
  return !(harness.kind === 'user' && round === 3);
}

/**
 * Review units (chunked above CHUNK_SIZE harnesses) and the `accounts` unit, in claim order. A
 * measure-only run (`init --mode measure`) has none: nothing is reviewed, only measured.
 */
export function staticUnits(run) {
  if (run.mode === 'measure') return [];
  const ids = run.harnesses.map((h) => h.id);
  const chunks = [];
  if (ids.length > CHUNK_SIZE) for (let i = 0; i < ids.length; i += CHUNK_SIZE) chunks.push(ids.slice(i, i + CHUNK_SIZE));
  else chunks.push(ids);
  const units = [];
  for (const u of REVIEW_UNITS) {
    chunks.forEach((harnesses, i) => {
      units.push({ id: chunks.length > 1 ? `review:${u.name}#${i + 1}` : `review:${u.name}`, kind: 'review', rounds: u.rounds.slice(), harnesses: harnesses.slice() });
    });
  }
  if ((run.accounts || []).length >= 2) {
    units.push({ id: 'accounts', kind: 'accounts', rounds: [], harnesses: run.harnesses.filter((h) => h.kind === 'user').map((h) => h.id) });
  }
  return units;
}

/**
 * `apply:<harness>` units: one per harness that has approved items or items being applied.
 * `busy` is true while an item of that harness is in progress (changed within the ttl): the unit
 * then belongs to whoever is applying, and nobody else may start.
 */
export function applyUnits(run, items, now = nowMs(), ttlMinutes = DEFAULT_TTL_MINUTES) {
  const units = [];
  for (const h of run.harnesses) {
    const mine = items.filter((i) => i.harness === h.id);
    const approved = mine.filter((i) => i.status === 'approved').map((i) => i.id);
    const inProgress = mine.filter((i) => i.status === 'in-progress');
    if (!approved.length && !inProgress.length) continue;
    const busy = inProgress.some((i) => {
      const t = Date.parse(i.updatedAt || '');
      return Number.isNaN(t) || now - t <= ttlMinutes * 60000;
    });
    // The rev of each item as it is now: what the executor is about to apply (`mark --rev`).
    const revs = {};
    for (const i of mine) if ((i.status === 'approved' || i.status === 'in-progress') && typeof i.rev === 'string') revs[i.id] = i.rev;
    units.push({ id: `apply:${h.id}`, kind: 'apply', rounds: [], harnesses: [h.id], approved, inProgress: inProgress.map((i) => i.id), revs, busy });
  }
  return units;
}

/** The claim on a unit, or null: `{ unit, session, at, ttlMinutes, ageMinutes, stale }`. */
export function readClaim(paths, unitId, now = nowMs()) {
  const file = paths.claimFile(unitId);
  let text;
  try { text = readText(file); } catch { text = ''; }
  if (text === null) return null;
  let claim = null;
  try { const v = JSON.parse(text); if (v && typeof v === 'object') claim = v; } catch { /* created but not written yet */ }
  if (!claim || typeof claim.at !== 'string' || Number.isNaN(Date.parse(claim.at))) {
    // The file exists, so the unit is taken; its age comes from the file itself.
    let mtime = now;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
    claim = { unit: unitId, session: claim && typeof claim.session === 'string' ? claim.session : null, at: new Date(mtime).toISOString(), ttlMinutes: DEFAULT_TTL_MINUTES };
  }
  const ttl = Number.isFinite(claim.ttlMinutes) && claim.ttlMinutes > 0 ? claim.ttlMinutes : DEFAULT_TTL_MINUTES;
  const ageMs = Math.max(0, now - Date.parse(claim.at));
  return { unit: unitId, session: claim.session ?? null, at: claim.at, ttlMinutes: ttl, ageMinutes: Math.floor(ageMs / 60000), stale: ageMs > ttl * 60000 };
}

/**
 * Every unit with its effective status:
 *   done     a findings file was accepted (static units only)
 *   claimed  a session holds it (`claim.stale` when its ttl ran out: it can be taken over)
 *   busy     an apply unit whose harness is being changed without a claim
 *   pending  free to claim
 */
export function unitsView(paths, run, queue, items, now = nowMs()) {
  const stored = new Map(((queue && queue.units) || []).map((u) => [u.id, u]));
  const out = [];
  for (const u of [...staticUnits(run), ...applyUnits(run, items, now)]) {
    const q = stored.get(u.id);
    const done = u.kind !== 'apply' && q && q.status === 'done';
    const claim = done ? null : readClaim(paths, u.id, now);
    let status = 'pending';
    if (done) status = 'done';
    else if (claim) status = 'claimed';
    else if (u.kind === 'apply' && (u.busy || !u.approved.length)) status = 'busy';
    out.push({ ...u, status, claim, completedAt: done ? q.completedAt || null : null, completedBy: done ? q.completedBy || null : null });
  }
  return out;
}

/** True when `claim --session` may take this unit right now. */
export function claimable(unit) {
  if (unit.status === 'pending') return true;
  if (unit.status === 'claimed' && unit.claim.stale) return unit.kind !== 'apply' || unit.approved.length > 0;
  return false;
}

/** What `queue.json` stores: the static units with the status mirrored from the claim files. */
export function queueSnapshot(view) {
  return {
    version: 1,
    units: view.filter((u) => u.kind !== 'apply').map((u) => ({
      id: u.id, kind: u.kind, rounds: u.rounds, harnesses: u.harnesses, status: u.status,
      claimedBy: u.claim ? u.claim.session : null, claimedAt: u.claim ? u.claim.at : null,
      completedAt: u.completedAt, completedBy: u.completedBy,
    })),
  };
}
