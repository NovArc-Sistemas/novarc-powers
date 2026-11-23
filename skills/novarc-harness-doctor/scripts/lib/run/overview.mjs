// status / next: where a run stands and what should happen now. Both read the run directory
// itself (findings + status overlay + claim files), never state.json, so they are right even
// when the board is behind.
import fs from 'node:fs';
import { readJson } from './store.mjs';
import { loadFindings, loadItems, loadStatus, loadUnits, inputsFingerprint } from './model.mjs';
import { claimable, roundApplies, ROUNDS, DEFAULT_TTL_MINUTES } from './units.mjs';
import { inboxCount, PRIMARY_TARGET } from './decisions.mjs';
import { SAFE_CLASSES } from './apply.mjs';

function gather(ctx, now = Date.now()) {
  const { paths, run } = ctx;
  const status = loadStatus(paths);
  const findings = loadFindings(paths, run);
  const { items } = loadItems(paths, run, findings, status);
  const units = loadUnits(paths, run, items, now);
  return { status, findings, items, units, inbox: inboxCount(paths, status, paths.runId) };
}

function unitRow(u) {
  const row = { id: u.id, status: u.status };
  if (u.claim) Object.assign(row, { session: u.claim.session, ageMinutes: u.claim.ageMinutes, ...(u.claim.stale ? { stale: true } : {}) });
  if (u.status === 'done') Object.assign(row, { completedBy: u.completedBy, completedAt: u.completedAt });
  if (u.kind === 'apply') Object.assign(row, { approved: u.approved.length, inProgress: u.inProgress.length });
  return row;
}

/** `run.mjs status`. */
export function statusReport(ctx) {
  const { paths, run } = ctx;
  const g = gather(ctx);
  const summary = readJson(paths.probeSummary);
  const said = new Map();
  for (const { data } of g.findings) for (const r of Array.isArray(data.rounds) ? data.rounds : []) said.set(`${r.harness}:${r.round}`, r.status);
  const harnesses = run.harnesses.map((h) => {
    const byStatus = {};
    for (const i of g.items) if (i.harness === h.id) byStatus[i.status] = (byStatus[i.status] || 0) + 1;
    const applicable = ROUNDS.filter((r) => roundApplies(h, r));
    const probes = summary && summary.harnesses && summary.harnesses[h.id];
    const probeNames = probes ? Object.keys(probes).filter((k) => probes[k] && typeof probes[k] === 'object') : [];
    return {
      id: h.id, key: h.key, kind: h.kind, name: h.name,
      ...(h.inherits ? { inherits: h.inherits } : {}),
      items: byStatus,
      itemsTotal: Object.values(byStatus).reduce((a, b) => a + b, 0),
      roundsDone: applicable.filter((r) => said.get(`${h.id}:${r}`) === 'done').length,
      roundsTotal: applicable.length,
      probes: probes ? { ok: probeNames.filter((k) => probes[k].ok).length, failed: probeNames.filter((k) => !probes[k].ok) } : null,
    };
  });
  const decisionTimes = g.status.decisions.map((d) => d.at).filter(Boolean).sort();
  return {
    runId: paths.runId,
    dir: paths.dir,
    ...(run.title ? { title: run.title } : {}),
    mode: run.mode,
    language: run.language,
    createdAt: run.createdAt,
    closed: run.closed === true,
    primary: run.primary ?? null,
    harnesses,
    units: g.units.map(unitRow),
    decisions: g.status.decisions.length,
    lastDecisionAt: decisionTimes.length ? decisionTimes[decisionTimes.length - 1] : null,
    inbox: g.inbox,
  };
}

/** `run.mjs next`. */
export function next(ctx) {
  const { paths, run } = ctx;
  const now = Date.now();
  const g = gather(ctx, now);
  const review = g.units.filter((u) => u.kind !== 'apply');
  const apply = g.units.filter((u) => u.kind === 'apply');
  const pending = g.units.filter(claimable);
  const claimed = g.units.filter((u) => u.status === 'claimed' && !u.claim.stale);

  const approvedWaiting = {};
  for (const i of g.items) if (i.status === 'approved') (approvedWaiting[i.harness] = approvedWaiting[i.harness] || []).push(i.id);
  const questions = g.items.filter((i) => typeof i.question === 'string').map((i) => ({ target: i.id, question: i.question, at: (g.status.items[i.id] || {}).askedAt || i.updatedAt || null }));
  for (const q of g.status.questions) if (q.target === PRIMARY_TARGET) questions.push({ target: q.target, question: q.question, at: q.at });
  const undecided = g.items.filter((i) => i.status === 'open').length;
  const failed = g.items.filter((i) => i.status === 'failed').map((i) => i.id);
  const stuck = g.items.filter((i) => {
    if (i.status !== 'in-progress') return false;
    const t = Date.parse(i.updatedAt || '');
    return !Number.isNaN(t) && now - t > DEFAULT_TTL_MINUTES * 60000;
  }).map((i) => i.id);
  const inProgress = g.items.filter((i) => i.status === 'in-progress').length;

  const reviewOpen = review.some((u) => u.status !== 'done');
  const autoApplicable = {};
  if (run.mode === 'doctor' && !reviewOpen) {
    for (const i of g.items) if (i.status === 'open' && SAFE_CLASSES.includes(i.class)) (autoApplicable[i.harness] = autoApplicable[i.harness] || []).push(i.id);
  }

  const probed = fs.existsSync(paths.probeSummary);
  const stamp = readJson(paths.buildStamp);
  const boardStale = !fs.existsSync(paths.state) || !stamp || stamp.inputs !== inputsFingerprint(paths, run);
  const reviewPending = pending.filter((u) => u.kind !== 'apply');
  const applyPending = pending.filter((u) => u.kind === 'apply');

  let suggestion;
  let reason;
  if (run.closed === true) { suggestion = 'close'; reason = 'the run is closed'; }
  else if (!probed) { suggestion = 'probe'; reason = 'no harness was probed yet: run.mjs probe'; }
  else if (reviewPending.length) { suggestion = 'claim'; reason = `${reviewPending.length} unit(s) free to claim: run.mjs claim --session <label>`; }
  else if (g.inbox) { suggestion = 'wait-for-decisions'; reason = `${g.inbox} decision(s) from the board not taken in yet: run.mjs decisions`; }
  else if (applyPending.length) { suggestion = 'apply'; reason = `approved items wait in ${applyPending.map((u) => u.harnesses[0]).join(', ')}`; }
  else if (Object.keys(autoApplicable).length) { suggestion = 'apply'; reason = 'doctor mode: safe items can be applied with mark --auto'; }
  else if (boardStale) { suggestion = 'build'; reason = fs.existsSync(paths.state) ? 'the run changed since the board was built: run.mjs build' : 'no board yet: run.mjs build'; }
  else if (undecided || questions.length) { suggestion = 'wait-for-decisions'; reason = questions.length ? `${questions.length} question(s) to answer in chat, ${undecided} item(s) undecided` : `${undecided} item(s) wait for the user's decision`; }
  else if (claimed.some((u) => u.kind !== 'apply')) { suggestion = 'claim'; reason = 'every remaining review unit is claimed by another session: nothing to claim until they complete'; }
  else if (inProgress || apply.some((u) => u.status === 'claimed')) { suggestion = 'apply'; reason = stuck.length ? 'items have been in progress for a long time: check them and mark them fixed or failed' : 'approved items are being applied'; }
  else { suggestion = 'close'; reason = 'nothing is waiting: write the report, then run.mjs close'; }

  return {
    runId: paths.runId,
    mode: run.mode,
    closed: run.closed === true,
    pendingUnits: pending.map((u) => u.id),
    claimedUnits: g.units.filter((u) => u.status === 'claimed').map((u) => ({ unit: u.id, session: u.claim.session, ageMinutes: u.claim.ageMinutes, ...(u.claim.stale ? { stale: true } : {}) })),
    undecided,
    approvedWaiting,
    ...(run.mode === 'doctor' ? { autoApplicable } : {}),
    inProgress,
    ...(stuck.length ? { stuck } : {}),
    ...(failed.length ? { failed } : {}),
    questions,
    inbox: g.inbox,
    boardStale,
    suggestion,
    reason,
  };
}
