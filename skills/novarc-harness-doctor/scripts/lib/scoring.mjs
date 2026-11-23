// Scoring for novarc-harness-doctor, exactly as references/scoring.md describes.
//
// Pure ESM with no imports: render-board.mjs imports it, and the same source is inlined into
// board.html (the `export` keywords are stripped there) so the page can recompute the projected
// score while the user decides. Keep it free of Node and DOM APIs, and declare every export as
// `export const` or `export function` at the start of a line.
//
// The model is confidence-weighted: every counted round starts at 100 and loses points per
// unresolved item, weighted by status and by where the finding lives, with the noise of one
// non-active file capped. The idea is inspired by AgentShield's src/reporter/score.ts (MIT,
// affaan-m/agentshield); this is a re-implementation.

export const ROUND_WEIGHTS = { 1: 20, 2: 15, 3: 10, 4: 15, 5: 5, 6: 15, 7: 10, 8: 10 };
export const ROUNDS_TOTAL = 8;
export const SEVERITY_POINTS = { critical: 25, high: 15, medium: 5, low: 2 };
// What an item still costs, by status. `approved` and `in-progress` count in full for `current`:
// the user said yes, but nothing is on disk yet.
export const STATUS_FACTOR = {
  open: 1, approved: 1, 'in-progress': 1, failed: 1, deferred: 1,
  declined: 0.5,
  fixed: 0, ok: 0, 'not-applicable': 0,
};
/** Statuses the `projected` score treats as already fixed. */
export const PROJECTED_AS_FIXED = { approved: true, 'in-progress': true };
/** How much a finding counts by where it lives. An item without `origin` is `active`. */
export const ORIGIN_WEIGHT = { active: 1, 'project-optional': 0.75, plugin: 0.5, example: 0.25 };
/** Most points the non-active items of one file can take from one round. */
export const FILE_CAP = 10;
export const ROUND_MAX = 100;

/** Floor to one decimal ("never round one up"), with an epsilon so 64.99999999 reads as 65. */
export function floor1(x) {
  return Math.floor(x * 10 + 1e-7) / 10;
}

export function gradeFor(score) {
  if (score === null || score === undefined) return null;
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/** The file an item is about: its first change's path, else `file`, else null. */
export function itemFile(item) {
  const c = Array.isArray(item.changes) ? item.changes[0] : null;
  if (c && c.path) return c.path;
  return item.file || null;
}

/** Origin weight. A `secret` item always counts in full, wherever it lives. */
export function originWeight(item) {
  if (item.class === 'secret') return 1;
  const w = ORIGIN_WEIGHT[item.origin || 'active'];
  return w === undefined ? 1 : w;
}

/**
 * Status factor in one of the three views of a harness:
 * `baseline` (every item as if open), `current` (real statuses) and `projected` (approved and
 * in-progress items as if fixed). An unknown status counts in full.
 */
export function statusFactor(status, mode) {
  if (mode === 'baseline') return 1;
  if (mode === 'projected' && PROJECTED_AS_FIXED[status]) return 0;
  const f = STATUS_FACTOR[status];
  return f === undefined ? 1 : f;
}

/** True when the item's deduction goes into its file's capped group. */
function inFileCap(item) {
  return (item.origin || 'active') !== 'active' && item.class !== 'secret' && itemFile(item) !== null;
}

/**
 * Points one round loses to its items: severity x status factor x origin weight, summed, with the
 * items of each non-active file (secrets excepted) capped together at FILE_CAP. Origin weights
 * and the cap apply in every mode.
 */
export function roundDeductions(items, mode) {
  const m = mode || 'current';
  let total = 0;
  const perFile = new Map();
  for (const i of items) {
    const d = (SEVERITY_POINTS[i.severity] || 0) * statusFactor(i.status, m) * originWeight(i);
    if (inFileCap(i)) {
      const f = itemFile(i);
      perFile.set(f, (perFile.get(f) || 0) + d);
    } else {
      total += d;
    }
  }
  for (const d of perFile.values()) total += Math.min(FILE_CAP, d);
  return total;
}

function roundStatus(state, harnessId, round) {
  const r = (state.rounds || []).find((x) => x.harness === harnessId && x.round === round);
  return r ? r.status : 'pending';
}

/**
 * Per-round breakdown for one harness. A round score is max(0, 100 - deductions), from 0 to 100,
 * and null for a round that is not `done`.
 */
export function roundBreakdown(state, harnessId) {
  const out = [];
  for (let r = 1; r <= ROUNDS_TOTAL; r++) {
    const status = roundStatus(state, harnessId, r);
    const items = (state.items || []).filter((i) => i.harness === harnessId && i.round === r);
    const deductions = roundDeductions(items, 'current');
    const baselineDeductions = roundDeductions(items, 'baseline');
    const projectedDeductions = roundDeductions(items, 'projected');
    const counted = status === 'done';
    out.push({
      round: r,
      status,
      weight: ROUND_WEIGHTS[r],
      counted,
      items: items.length,
      deductions,
      baselineDeductions,
      projectedDeductions,
      score: counted ? Math.max(0, ROUND_MAX - deductions) : null,
      baselineScore: counted ? Math.max(0, ROUND_MAX - baselineDeductions) : null,
      projectedScore: counted ? Math.max(0, ROUND_MAX - projectedDeductions) : null,
    });
  }
  return out;
}

/** Harness score: weighted average of the `done` rounds' scores, floored to one decimal. */
export function scoreHarness(state, harnessId) {
  const rows = roundBreakdown(state, harnessId);
  const done = rows.filter((r) => r.counted);
  // Rounds that do not apply to this harness are not part of the total ("7 of 7", not "7 of 8").
  const roundsTotal = rows.filter((r) => r.status !== 'not-applicable').length;
  if (done.length === 0) {
    return {
      current: null, baseline: null, projected: null,
      grade: null, baselineGrade: null, projectedGrade: null,
      roundsCounted: 0, roundsTotal, breakdown: rows,
    };
  }
  const w = done.reduce((s, r) => s + r.weight, 0);
  const avg = (key) => floor1(done.reduce((s, r) => s + r.weight * r[key], 0) / w);
  const current = avg('score');
  const baseline = avg('baselineScore');
  const projected = avg('projectedScore');
  return {
    current, baseline, projected,
    grade: gradeFor(current), baselineGrade: gradeFor(baseline), projectedGrade: gradeFor(projected),
    roundsCounted: done.length, roundsTotal, breakdown: rows,
  };
}

const SCORE_KEYS = ['current', 'baseline', 'projected', 'grade', 'baselineGrade', 'projectedGrade', 'roundsCounted', 'roundsTotal'];

/**
 * New `scores` object per harness id. `previous` is kept from the existing state (it is set when
 * a re-run starts, not by the renderer). `computedAt` only moves when a computed value changed,
 * so an unchanged state renders byte-identically.
 */
export function computeScores(state, now) {
  const stamp = (now || new Date()).toISOString();
  const out = {};
  for (const h of state.harnesses || []) {
    const s = scoreHarness(state, h.id);
    const prev = h.scores || {};
    const same = SCORE_KEYS.every((k) => prev[k] === s[k]);
    out[h.id] = {
      current: s.current,
      baseline: s.baseline,
      projected: s.projected,
      previous: prev.previous === undefined ? null : prev.previous,
      grade: s.grade,
      baselineGrade: s.baselineGrade,
      projectedGrade: s.projectedGrade,
      roundsCounted: s.roundsCounted,
      roundsTotal: s.roundsTotal,
      computedAt: same && prev.computedAt ? prev.computedAt : stamp,
    };
  }
  return out;
}

/** Writes the computed scores into each harness (the only key the renderer changes). */
export function applyScores(state, now) {
  const scores = computeScores(state, now);
  for (const h of state.harnesses || []) h.scores = scores[h.id];
  return scores;
}

/** Mean of the scores that exist, floored to one decimal; null when none does. */
export function averageScore(values) {
  const nums = values.filter((v) => typeof v === 'number');
  if (!nums.length) return null;
  return floor1(nums.reduce((s, v) => s + v, 0) / nums.length);
}

// ---------------------------------------------------------------------------------------------
// Fleet totals. Not a score: the other numbers the overview and board.md show for the whole run.
// They live here because this is the module the renderer and the page share.
// ---------------------------------------------------------------------------------------------

/**
 * Measured waste of one impact block: `tokens` (raw) and `weighted` (relative cost, in
 * input-token equivalents). `weighted` is null unless the block has a weighted total and every
 * kind with tokens carries a weighted figure, so a share is never taken on partial numbers.
 */
export function wasteOf(impact) {
  const rows = (impact && impact.waste) || [];
  const tokens = rows.reduce((s, w) => s + (w.tokens || 0), 0);
  const weighable = !!impact && typeof impact.weightedTotal === 'number' && impact.weightedTotal > 0
    && !rows.some((w) => w.tokens > 0 && typeof w.weighted !== 'number');
  return { tokens, weighted: weighable ? rows.reduce((s, w) => s + (w.weighted || 0), 0) : null };
}

/** Sessions of a harness in the window: the measured count, else its activity count, else null. */
export function sessionsOfHarness(h) {
  if (h.impact && typeof h.impact.sessions === 'number') return h.impact.sessions;
  return h.activity && typeof h.activity.sessions === 'number' ? h.activity.sessions : null;
}

/**
 * What the whole run spent, with no session counted twice. An account's impact already contains
 * its sessions in every project, so the totals add the measured accounts (user harnesses) when
 * there is at least one, and the measured projects only when no account was measured.
 * Sessions follow the same side; an account whose sessions are measured in another harness
 * (`impactSkipped.reason: shared-sessions`) is not added again.
 *
 * Returns `{ basis, measured, waste, total, relative, relWaste, relTotal, sessionsBasis,
 * sessions, sessionsFrom }`: `basis` is 'accounts', 'projects' or null (nothing measured);
 * `relative` is true when every measured harness on that side carries price weights.
 */
export function fleetImpact(harnesses) {
  const list = harnesses || [];
  const users = list.filter((h) => h.kind === 'user');
  const projects = list.filter((h) => h.kind !== 'user');
  const basis = users.some((h) => h.impact) ? 'accounts' : projects.some((h) => h.impact) ? 'projects' : null;
  const measured = (basis === 'accounts' ? users : basis === 'projects' ? projects : []).filter((h) => h.impact);
  let waste = 0;
  let total = 0;
  let relWaste = 0;
  let relTotal = 0;
  let relative = measured.length > 0;
  for (const h of measured) {
    const w = wasteOf(h.impact);
    waste += w.tokens;
    total += h.impact.totalTokens || 0;
    if (w.weighted === null) relative = false;
    else { relWaste += w.weighted; relTotal += h.impact.weightedTotal; }
  }
  const counted = (h) => !(h.impactSkipped && h.impactSkipped.reason === 'shared-sessions') && sessionsOfHarness(h) !== null;
  const sessionsBasis = basis || (users.some(counted) ? 'accounts' : projects.some(counted) ? 'projects' : null);
  const from = (sessionsBasis === 'accounts' ? users : sessionsBasis === 'projects' ? projects : []).filter(counted);
  return {
    basis,
    measured: measured.length,
    waste,
    total,
    relative,
    relWaste: relative ? relWaste : null,
    relTotal: relative ? relTotal : null,
    sessionsBasis,
    sessions: from.length ? from.reduce((s, h) => s + sessionsOfHarness(h), 0) : null,
    sessionsFrom: from.length,
  };
}
