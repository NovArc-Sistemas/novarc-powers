// A measure-only run (run.mjs init --mode measure): no review units, the probes the board needs,
// a board with no rounds, then straight to close, whose records are a baseline. A later run on the
// same harness is a follow-up of that baseline: its metrics are compared, with no expectation.
// Real run.mjs processes over a temporary home, with the stub probes and renderer of
// run-helpers.mjs and the clock set by NOVARC_HD_NOW.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, clock, historyOf, measured, writeImpact } from './run-helpers.mjs';

const DAY = 86400000;
const T0 = '2026-01-10T10:00:00.000Z';
const CLOSED = '2026-01-10T12:00:00.000Z';
const LATER = '2026-02-10T12:00:00.000Z';

const ok = (r, what) => { assert.equal(r.code, 0, `${what}: ${r.stdout}${r.stderr}`); return r.json; };

/** `init --select` at the moment `at`; the run becomes the sandbox's current run. */
function initAt(sb, at, args = []) {
  const file = path.join(sb.home, 'selection.json');
  fs.writeFileSync(file, JSON.stringify(sb.selection));
  const r = sb.run(['init', '--select', file, ...args], clock(at));
  if (r.code === 0) { sb.runId = r.json.runId; sb.dir = r.json.dir; }
  return r;
}

/** What the impact probe measured in the 30 days up to `to`: 25 sessions, `extra` replacing fields. */
function since(extra = {}, to = LATER) {
  return measured({
    from: new Date(Date.parse(to) - 30 * DAY).toISOString(), to, sessions: 25, activeDays: 15,
    totalTokens: 2500000, weightedTotal: 500000,
    contextAtStart: { perSessionMedian: 50000, sessionsMeasured: 25 },
    contextPeak: { median: 120000, sessionsMeasured: 25 },
    waste: [{ kind: 'retry', episodes: 5, sessions: 4, tokens: 125000, weighted: 25000, basis: 'measured' }],
    toolOutput: { shellResultChars: 1000000 },
    ...extra,
  });
}

test('measure only: no unit to claim, no rule engine, a board with every round skipped, then close with records of mode measure and no items', (t) => {
  const sb = sandbox(t, { accounts: 2, projects: ['acme-shop'] });
  const init = initAt(sb, T0, ['--mode', 'measure', '--lang', 'pt']);
  assert.equal(init.code, 0, init.stdout + init.stderr);
  assert.equal(init.json.mode, 'measure');
  // Not even the accounts unit, although the run has two accounts.
  assert.deepEqual(init.json.units, []);
  assert.deepEqual(sb.read('queue.json'), { version: 1, units: [] });
  assert.equal(sb.read('run.json').mode, 'measure');

  const probe = ok(sb.run(['probe']), 'probe');
  assert.equal(probe.failed, 0);
  // The rule engine is for reviewers: it is not run, and the summary says why.
  const calls = sb.stubCalls().map((c) => c.script);
  assert.equal(calls.filter((s) => s === 'harness-checks').length, 0);
  for (const s of ['discover', 'session-impact', 'probe-clis', 'snapshot-harness', 'impact-estimates']) assert.ok(calls.includes(s), `${s} still runs`);
  assert.ok(calls.includes('accounts'), 'the accounts comparison still runs: the board shows it');
  for (const h of ['claude-1', 'codex-1', 'acme-shop']) {
    assert.deepEqual(sb.read('probes', 'summary.json').harnesses[h].checks, { ok: false, skipped: 'measure-mode' });
    assert.equal(sb.exists('probes', h, 'checks.json'), false);
  }
  const status = ok(sb.run(['status']), 'status');
  assert.deepEqual(status.units, []);
  assert.deepEqual(status.harnesses.find((h) => h.id === 'acme-shop').probes.failed, []);

  // Nothing to claim, nothing to hand in.
  const claim = ok(sb.run(['claim', '--session', 'tester']), 'claim');
  assert.equal(claim.unit, null);
  assert.equal(claim.reason, 'no unit is free to claim');
  const findings = path.join(sb.home, 'f.json');
  fs.writeFileSync(findings, '{}');
  const complete = sb.run(['complete', '--unit', 'review:security', '--session', 'tester', '--findings', findings]);
  assert.equal(complete.code, 1);
  assert.equal(complete.json.error, 'no unit review:security in this run (see `run.mjs status`)');

  assert.equal(ok(sb.run(['next']), 'next').suggestion, 'build');
  const built = ok(sb.run(['build']), 'build');
  assert.equal(built.items, 0);
  assert.equal(built.rendered, true);
  const state = sb.read('state.json');
  assert.equal(state.mode, 'measure');
  assert.deepEqual(state.items, []);
  assert.deepEqual([...new Set(state.rounds.map((r) => r.status))].sort(), ['not-applicable', 'skipped']);
  assert.deepEqual(state.rounds.filter((r) => r.status === 'not-applicable').map((r) => `${r.harness}:${r.round}`), ['claude-1:3', 'codex-1:3']);
  assert.equal(state.harnesses.find((h) => h.id === 'acme-shop').impact.sessions, 3);
  assert.ok(state.accounts.list.length === 2);

  // Built, nothing to review or decide: straight to close.
  const next = ok(sb.run(['next']), 'next');
  assert.equal(next.suggestion, 'close');
  assert.equal(next.undecided, 0);
  assert.deepEqual(next.pendingUnits, []);

  const closed = ok(sb.run(['close'], clock(CLOSED)), 'close');
  assert.equal(closed.closed, true);
  assert.deepEqual(closed.records.map((r) => [r.harness, r.items, r.fixed]), [['claude-1', 0, 0], ['codex-1', 0, 0], ['acme-shop', 0, 0]]);
  const hist = historyOf(sb);
  const key = init.json.harnesses.find((h) => h.id === 'acme-shop').harnessKey;
  const record = hist.record(key, sb.runId);
  assert.equal(record.mode, 'measure');
  assert.deepEqual(record.items, []);
  assert.deepEqual(record.scores, { baseline: null, current: null, projected: null, grade: null, rounds: [1, 2, 3, 4, 5, 6, 7, 8].map((round) => ({ round, status: 'skipped', score: null })) });
  assert.equal(record.measure.sessions, 3);
  assert.equal(record.changesAppliedAt, null);
  assert.equal(record.followUpAfter, '2026-02-09T12:00:00.000Z');
  assert.equal(record.experiment, undefined, 'a baseline is not an experiment unless the user says so');
  assert.ok(hist.md(key, sb.runId).includes('- Somente medição: sem rodadas de revisão e sem itens. Este registro é a base com que a próxima revisão compara.'));
  // A measure-only baseline that no one marked opens no experiment.
  const h = ok(sb.run(['history', '--json'], clock('2026-01-15T12:00:00.000Z')), 'history');
  assert.deepEqual(h.experiments, []);
  assert.deepEqual(h.harnesses.find((x) => x.key === key).reviews.map((r) => r.mode), ['measure']);
});

test('a later guided run follows the baseline: metrics compared, no expectation, so the verdicts are plain changes', (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop'] });
  const init = initAt(sb, T0, ['--mode', 'measure']);
  assert.equal(init.code, 0, init.stdout + init.stderr);
  const baseline = sb.runId;
  writeImpact(sb, 'acme-shop', measured());
  ok(sb.run(['close'], clock(CLOSED)), 'close');

  // No --mode: the run after a baseline reviews (guided), it does not measure again.
  const next = ok(sb.run(['init', '--follow-up', 'latest'], clock(LATER)), 'init --follow-up');
  sb.runId = next.runId;
  sb.dir = next.dir;
  assert.equal(next.mode, 'guided');
  assert.deepEqual(next.units, ['review:security', 'review:instructions', 'review:gates', 'review:skills-tools', 'review:cleanup-deps']);
  assert.deepEqual(next.harnesses[0].followUp, { runId: baseline, reviewedAt: CLOSED, days: 31, windowDays: 30 });
  assert.equal(next.harnesses[0].experiment, undefined);

  writeImpact(sb, 'acme-shop', since({ contextAtStart: { perSessionMedian: 40000, sessionsMeasured: 25 }, totalTokens: 2125000 }));
  ok(sb.run(['build', '--no-render']), 'build');
  const f = sb.read('state.json').harnesses[0].followUp;
  assert.deepEqual(f.score, { then: null, expected: null, now: null });
  assert.deepEqual(f.items, []);
  assert.deepEqual(f.metrics.map((m) => [m.metric, m.before, m.expected, m.after, m.changePct, m.verdict]), [
    ['tokens-per-session', 100000, null, 85000, -15, 'improved'],
    ['weighted-per-session', 20000, null, 20000, 0, 'no-change'],
    ['context-at-start', 50000, null, 40000, -20, 'improved'],
    ['context-peak', 120000, null, 120000, 0, 'no-change'],
    ['waste-share', 5, null, 5, 0, 'no-change'],
    ['waste:retry', 5000, null, 5000, 0, 'no-change'],
    ['tool-output', 40000, null, 40000, 0, 'no-change'],
  ]);
  assert.deepEqual(f.summary, { expectedTokensPerSession: 0, observedTokensPerSession: -15000, inPlace: 0, reverted: 0, cameBack: 0 });
});

test('init --follow-up <runId> --mode measure measures again since the baseline', (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop'] });
  assert.equal(initAt(sb, T0, ['--mode', 'measure']).code, 0);
  const baseline = sb.runId;
  writeImpact(sb, 'acme-shop', measured());
  ok(sb.run(['close'], clock(CLOSED)), 'close');

  const again = ok(sb.run(['init', '--follow-up', baseline, '--mode', 'measure'], clock(LATER)), 'init again');
  sb.runId = again.runId;
  sb.dir = again.dir;
  assert.equal(again.mode, 'measure');
  assert.deepEqual(again.units, []);
  assert.deepEqual(again.followUpOf, { runId: baseline, reviewedAt: CLOSED });
  writeImpact(sb, 'acme-shop', since({ contextAtStart: { perSessionMedian: 60000, sessionsMeasured: 25 } }));
  ok(sb.run(['build', '--no-render']), 'build');
  const row = sb.read('state.json').harnesses[0].followUp.metrics.find((m) => m.metric === 'context-at-start');
  assert.deepEqual([row.before, row.expected, row.after, row.verdict], [50000, null, 60000, 'worse']);
  const closed = ok(sb.run(['close'], clock('2026-02-10T13:00:00.000Z')), 'close');
  const record = historyOf(sb).record(closed.records[0].harnessKey, sb.runId);
  assert.equal(record.mode, 'measure');
  assert.deepEqual(record.followUpOf, { runId: baseline, reviewedAt: CLOSED });
  assert.equal(record.outcome.metrics.find((m) => m.metric === 'context-at-start').verdict, 'worse');

  // A bad mode is a bad command line.
  const bad = sb.run(['init', '--follow-up', baseline, '--mode', 'audit']);
  assert.equal(bad.code, 2);
  assert.equal(bad.json.error, '--mode must be guided, doctor or measure');
});
