// The follow-up (references/follow-up.md): a run on a harness that has a review record measures
// what happened since, checks that what was applied is still on disk, and links what comes back
// to what was seen before. The scenarios are real run.mjs processes over a temporary home, with
// the clock set by NOVARC_HD_NOW and the impact probe's output written as the probe would write
// it; the edge cases of the comparison and of the on-disk check call the functions directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, item, clock, historyOf, measured, writeImpact, firstReview, FIRST } from './run-helpers.mjs';
import { tmpDir, rmrf } from './helpers.mjs';
import { METRICS, metricsOf, metricUnit, coverageOf, checkItem, followUpFor, followUpWindow, loadThresholds, validateRecord } from '../scripts/lib/run/followup.mjs';
import { loadStateSchema } from '../scripts/lib/run/schema.mjs';

const DAY = 86400000;
/** 31 days and 29 minutes after the change of the first review was applied. */
const SECOND = '2026-02-10T12:00:00.000Z';
const one = (t) => sandbox(t, { accounts: 0, projects: ['acme-shop'] });

/** Start the follow-up of the latest run at `at`; it becomes the sandbox's current run. */
function followUp(sb, at, args = []) {
  const r = sb.run(['init', '--follow-up', 'latest', ...args], clock(at));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  sb.runId = r.json.runId;
  sb.dir = r.json.dir;
  return r.json;
}

/**
 * What the impact probe measured in the 30 days up to `to`: 25 sessions with the same numbers per
 * session as in the first review (so nothing changed), unless `extra` replaces a field.
 */
function since(extra = {}, to = SECOND) {
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

function build(sb) {
  const r = sb.run(['build', '--no-render']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const state = sb.read('state.json');
  return { state, warnings: r.json.mergeWarnings, harness: state.harnesses.find((h) => h.id === 'acme-shop') };
}
const startAt = (median) => ({ contextAtStart: { perSessionMedian: median, sessionsMeasured: 25 } });
const row = (followUpObject, metric) => followUpObject.metrics.find((m) => m.metric === metric);

test('31 days later: the expected saving happened, by half, not at all, and the opposite', (t) => {
  const sb = one(t);
  const first = firstReview(sb);
  const started = followUp(sb, SECOND);
  assert.deepEqual(started.harnesses[0].followUp, { runId: first.runId, reviewedAt: FIRST.closed, days: 31, windowDays: 30 });

  // The fixed item expected 200000 tokens less at the start of sessions over 20 sessions: 10000 per session.
  // Now: 40000 at the start (it was 50000), fewer tokens per session, more shell output, no peak measured.
  writeImpact(sb, 'acme-shop', since({
    ...startAt(40000), contextPeak: undefined, totalTokens: 2125000,
    waste: [{ kind: 'retry', episodes: 5, sessions: 4, tokens: 130000, weighted: 26000, basis: 'measured' }],
    toolOutput: { shellResultChars: 1250000 },
  }));
  const { harness, state } = build(sb);
  assert.deepEqual(harness.history, [{ runId: first.runId, reviewedAt: FIRST.closed, score: 79, grade: 'B', fixed: 1, tokensPerSession: 100000 }]);
  assert.deepEqual(harness.followUp, {
    of: { runId: first.runId, reviewedAt: FIRST.closed },
    days: 31,
    sample: { sessions: 25, enough: true },
    // How that review ended, where it said the harness would land, and the harness as found now
    // (nothing was reviewed yet in this run, so there is no score yet).
    score: { then: 79, expected: 79, now: null },
    metrics: [
      { metric: 'tokens-per-session', unit: 'tokens/session', before: 100000, expected: null, after: 85000, changePct: -15, verdict: 'improved' },
      { metric: 'weighted-per-session', unit: 'tokens/session', before: 20000, expected: null, after: 20000, changePct: 0, verdict: 'no-change' },
      { metric: 'context-at-start', unit: 'tokens/session', before: 50000, expected: 40000, after: 40000, changePct: -20, verdict: 'confirmed', items: ['ACME-101'] },
      { metric: 'context-peak', unit: 'tokens/session', before: 120000, expected: null, after: null, changePct: null, verdict: 'not-measured' },
      // Both reviews weighted their waste: the share is compared on that base, and the row says so.
      { metric: 'waste-share', unit: 'percent', before: 5, expected: null, after: 5.2, changePct: 4, verdict: 'no-change', base: 'weighted' },
      { metric: 'waste:retry', unit: 'tokens/session', before: 5000, expected: null, after: 5200, changePct: 4, verdict: 'no-change' },
      { metric: 'tool-output', unit: 'chars/session', before: 40000, expected: null, after: 50000, changePct: 25, verdict: 'worse' },
    ],
    items: [
      { id: 'ACME-101', title: 'Finding ACME-101', round: 1, status: 'fixed', check: 'in-place', paths: ['./CLAUDE.md'], saves: 200000 },
      { id: 'ACME-102', title: 'Finding ACME-102', round: 1, status: 'declined', saves: null },
      { id: 'ACME-103', title: 'Finding ACME-103', round: 1, status: 'deferred', saves: null },
      { id: 'ACME-104', title: 'Finding ACME-104', round: 1, status: 'open', saves: null },
    ],
    summary: { expectedTokensPerSession: 10000, observedTokensPerSession: -15000, inPlace: 1, reverted: 0, cameBack: 0 },
  });
  assert.deepEqual(state.run.followUpOf, { runId: first.runId, reviewedAt: FIRST.closed });
  assert.equal(harness.key, first.key);

  // The same expectation, three other outcomes.
  const outcome = (median) => {
    writeImpact(sb, 'acme-shop', since(startAt(median)));
    const m = row(build(sb).harness.followUp, 'context-at-start');
    return [m.before, m.expected, m.after, m.changePct, m.verdict];
  };
  assert.deepEqual(outcome(45000), [50000, 40000, 45000, -10, 'partial'], 'half of the expected saving');
  assert.deepEqual(outcome(50000), [50000, 40000, 50000, 0, 'no-change'], 'nothing changed');
  assert.deepEqual(outcome(60000), [50000, 40000, 60000, 20, 'worse'], 'it rose');
  // With nothing else changed, every other metric reads "no change".
  const flat = build(sb).harness.followUp;
  assert.deepEqual(flat.metrics.filter((m) => m.metric !== 'context-at-start').map((m) => [m.metric, m.changePct, m.verdict]), [
    ['tokens-per-session', 0, 'no-change'], ['weighted-per-session', 0, 'no-change'], ['context-peak', 0, 'no-change'],
    ['waste-share', 0, 'no-change'], ['waste:retry', 0, 'no-change'], ['tool-output', 0, 'no-change'],
  ]);
  assert.equal(flat.summary.observedTokensPerSession, 0);
});

test('too few days, too few sessions, or no measurement: not enough data yet, with the date it will be ready', (t) => {
  const sb = one(t);
  const first = firstReview(sb);

  // Three days after: the normal window is measured, and nothing is judged yet.
  const soon = followUp(sb, '2026-01-13T12:00:00.000Z');
  assert.deepEqual(soon.harnesses[0].followUp, { runId: first.runId, reviewedAt: FIRST.closed, days: 3, windowDays: 30 });
  writeImpact(sb, 'acme-shop', since(startAt(40000), '2026-01-13T12:00:00.000Z'));
  let f = build(sb).harness.followUp;
  assert.equal(f.days, 3);
  // Seven days (minDays) after the change was applied at 11:31 on the 10th.
  assert.deepEqual(f.sample, { sessions: null, enough: false, reason: 'too-few-days', readyAt: '2026-01-17T11:31:00.000Z' });
  assert.deepEqual(f.metrics.map((m) => m.verdict), Array(7).fill('not-enough-data'));
  assert.deepEqual(row(f, 'context-at-start'), { metric: 'context-at-start', unit: 'tokens/session', before: 50000, expected: 40000, after: 40000, changePct: -20, verdict: 'not-enough-data', items: ['ACME-101'] }, 'the numbers are shown, not judged');
  assert.deepEqual(f.summary, { expectedTokensPerSession: 10000, observedTokensPerSession: null, inPlace: 1, reverted: 0, cameBack: 0 });

  // 31 days after, but only 4 sessions (minSessions is 10).
  followUp(sb, SECOND);
  writeImpact(sb, 'acme-shop', since({ ...startAt(40000), sessions: 4, totalTokens: 400000, weightedTotal: 80000, waste: [{ kind: 'retry', episodes: 1, sessions: 1, tokens: 20000, weighted: 4000, basis: 'measured' }], toolOutput: { shellResultChars: 160000 } }));
  f = build(sb).harness.followUp;
  assert.equal(f.days, 31);
  // No date can be told for sessions: readyAt is only for days.
  assert.deepEqual(f.sample, { sessions: 4, enough: false, reason: 'too-few-sessions' });
  assert.deepEqual(f.metrics.map((m) => m.verdict), Array(7).fill('not-enough-data'));
  assert.equal(f.summary.observedTokensPerSession, null);
  // Ten sessions are enough.
  writeImpact(sb, 'acme-shop', since({ ...startAt(40000), sessions: 10, totalTokens: 1000000, weightedTotal: 200000, waste: [{ kind: 'retry', episodes: 1, sessions: 1, tokens: 50000, weighted: 10000, basis: 'measured' }], toolOutput: { shellResultChars: 400000 } }));
  f = build(sb).harness.followUp;
  assert.deepEqual([f.sample, row(f, 'context-at-start').verdict], [{ sessions: 10, enough: true }, 'confirmed']);
  // No session at all: what is counted per session was not measured. "Not enough data" comes first.
  writeImpact(sb, 'acme-shop', since({ sessions: 0, totalTokens: 0, weightedTotal: 0, waste: [], contextAtStart: { perSessionMedian: 0, sessionsMeasured: 0 }, contextPeak: { median: 0, sessionsMeasured: 0 }, toolOutput: { shellResultChars: 0 } }));
  f = build(sb).harness.followUp;
  assert.deepEqual(f.sample, { sessions: 0, enough: false, reason: 'too-few-sessions' });
  assert.deepEqual(f.metrics.map((m) => [m.metric, m.after, m.verdict]), [
    ['tokens-per-session', null, 'not-enough-data'], ['weighted-per-session', null, 'not-enough-data'], ['context-at-start', null, 'not-enough-data'],
    ['context-peak', null, 'not-enough-data'], ['waste-share', null, 'not-enough-data'], ['waste:retry', null, 'not-enough-data'], ['tool-output', null, 'not-enough-data'],
  ], 'a metric that was not measured is absent, never 0');

  // A window that reaches back before that review does not measure "since then": nothing counts as now.
  writeImpact(sb, 'acme-shop', since({ ...startAt(40000), windowDays: 45 }));
  f = build(sb).harness.followUp;
  assert.deepEqual(f.sample, { sessions: null, enough: false, reason: 'not-measured' });
  assert.deepEqual(f.metrics.map((m) => [m.after, m.verdict]), Array(7).fill([null, 'not-measured']));
  // The impact probe did not run: counted from the start of the run, nothing to compare.
  fs.rmSync(sb.file('probes', 'acme-shop', 'impact.json'));
  f = build(sb).harness.followUp;
  assert.deepEqual([f.days, f.sample], [31, { sessions: null, enough: false, reason: 'not-measured' }]);
  assert.deepEqual(f.metrics.map((m) => [m.before === null, m.after, m.verdict]), Array(7).fill([false, null, 'not-measured']));
  assert.deepEqual(f.items.map((i) => [i.id, i.check]), [['ACME-101', 'in-place'], ['ACME-102', undefined], ['ACME-103', undefined], ['ACME-104', undefined]], 'the on-disk check does not depend on the measurement');
});

test('is what was applied still there: in place, reverted, rewritten, removed', (t) => {
  const sb = one(t);
  const first = firstReview(sb);
  followUp(sb, SECOND);
  writeImpact(sb, 'acme-shop', since());
  const check = (content) => {
    if (content === null) fs.rmSync(first.file); else fs.writeFileSync(first.file, content);
    const { harness, state } = build(sb);
    const f = harness.followUp;
    return { check: f.items[0].check, inPlace: f.summary.inPlace, reverted: f.summary.reverted, text: JSON.stringify(state) };
  };
  const tell = ({ check: c, inPlace, reverted }) => [c, inPlace, reverted];

  // Untouched since the run changed it: the file still has the hash the ledger recorded.
  assert.equal(fs.readFileSync(first.file, 'utf8'), '# Rules\nline one, improved\nline two\n');
  assert.deepEqual(tell(check('# Rules\nline one, improved\nline two\n')), ['in-place', 1, 0]);
  // Edited elsewhere, or saved with other line endings: the text that was written is still there.
  assert.deepEqual(tell(check('# Rules\nline one, improved\nline two\n\n## More\nA section added later.\n')), ['in-place', 1, 0]);
  assert.deepEqual(tell(check('# Rules\r\nline one, improved\r\nline two\r\n')), ['in-place', 1, 0]);
  // The text from before is back.
  assert.deepEqual(tell(check('# Rules\nline one\nline two\n')), ['reverted', 0, 1]);
  // Neither the text before nor the text after: someone rewrote that part.
  assert.deepEqual(tell(check('# Rules\nSomething else entirely.\n')), ['changed', 0, 0]);
  // The file is gone.
  assert.deepEqual(tell(check(null)), ['missing', 0, 0]);

  // The check reads the file; only its verdict is written. A marker and a credential in the file
  // never reach the state, and neither does the absolute path it was read from.
  const marker = 'MARKER-' + 'q7x2'.repeat(3);
  const token = 'ghp_' + 'S'.repeat(36);
  const seen = check(`# Rules\nline one, improved\n${marker}\napi_token = "${token}"\n`);
  assert.equal(seen.check, 'in-place');
  assert.ok(!seen.text.includes(marker) && !seen.text.includes(token) && !seen.text.includes(token.slice(0, 10)));
  for (const spelling of [sb.home, sb.home.replace(/\\/g, '\\\\'), sb.home.replace(/\\/g, '/')]) assert.ok(!seen.text.includes(spelling), 'nothing absolute enters the state');
});

test('a finding seen before: `previous` links it, the state says what happened then, and the same proposal stays declined', (t) => {
  const sb = one(t);
  const first = firstReview(sb);
  followUp(sb, SECOND);
  writeImpact(sb, 'acme-shop', since());
  const history = historyOf(sb);

  // The brief of a review unit names the record of the last review of each harness.
  const brief = sb.run(['claim', '--unit', 'review:security', '--session', 'rev']).json;
  assert.deepEqual({ harnessKey: brief.harnesses[0].harnessKey, lastRecord: brief.harnesses[0].lastRecord }, {
    harnessKey: first.key,
    lastRecord: { runId: first.runId, reviewedAt: FIRST.closed, file: path.join(history.dir, first.key, `${first.runId}.json`) },
  });

  const prev = (id) => ({ run: first.runId, item: id });
  const again = [
    // Declined then, nothing changed: the same proposal again, open like any finding a reviewer sends.
    item('ACME-101', 'acme-shop', 1, { previous: prev('ACME-102'), class: 'additive', severity: 'low', changes: [{ path: './AGENTS.md', lang: 'markdown', before: '', after: 'A new rule.\n', why: 'Adds the rule.' }] }),
    // Deferred then: open again.
    item('ACME-102', 'acme-shop', 1, { previous: prev('ACME-103'), severity: 'high', changes: undefined, file: './settings.json' }),
    // Fixed then, and the same problem is back in another place.
    item('ACME-103', 'acme-shop', 1, { previous: prev('ACME-101'), changes: [{ path: './AGENTS.md', lang: 'markdown', before: 'line one', after: 'line one, improved', why: 'The same fix, in the other file.' }] }),
    // Points at nothing.
    item('ACME-104', 'acme-shop', 1, { previous: { run: '20200101-none', item: 'ACME-999' }, changes: undefined, file: './README.md' }),
    // New.
    item('ACME-105', 'acme-shop', 1, { changes: undefined, file: './docs/guide.md' }),
  ];
  const findings = (items) => ({ rounds: [{ harness: 'acme-shop', round: 1, status: 'done' }], items });

  // `declined` is the user's word: a reviewer never sets it, not even on what the user did decline.
  for (const handedBack of [{ ...again[4], status: 'declined' }, { ...again[0], status: 'declined' }]) {
    const refused = sb.complete('review:security', findings([handedBack]), 'rev');
    assert.equal(refused.code, 1);
    assert.deepEqual(refused.json.errors, ['/items/0/status: a reviewer may only set open, ok, not-applicable (a decline of an earlier review is carried by the run: send the same proposal as open, with `previous`)']);
  }
  const misshapen = sb.complete('review:security', findings([{ ...again[1], previous: { run: first.runId } }]), 'rev');
  assert.equal(misshapen.code, 1);
  assert.match(misshapen.json.errors.join('\n'), /^\/items\/0\/previous: missing required "item"$/m);
  assert.ok(!sb.exists('findings', 'review.security.json'));

  const done = sb.complete('review:security', findings(again), 'rev');
  assert.equal(done.code, 0, done.stdout + done.stderr);
  assert.deepEqual(done.json.warnings, ['/items/3/previous: no review record of this harness holds this run and item']);
  assert.deepEqual(done.json.declinedBefore, { same: ['ACME-101'], changed: [] }, 'the reviewer is told that the decline still stands');

  const { harness, state, warnings } = build(sb);
  assert.deepEqual(warnings.filter((w) => /previous/.test(w.problem)), [{ source: 'findings', problem: 'item ACME-104: `previous` points at a run or item that no review record of this harness holds; its history is left out' }]);
  const of = (id) => state.items.find((i) => i.id === id);
  // The decline is carried with its date and its note, and says where it comes from; no decision
  // of this run stands behind it.
  assert.deepEqual({ status: of('ACME-101').status, decision: of('ACME-101').decision, updatedAt: of('ACME-101').updatedAt, carriedFrom: of('ACME-101').carriedFrom, history: of('ACME-101').history }, {
    status: 'declined', decision: 'not now', updatedAt: FIRST.decided, carriedFrom: { run: first.runId, item: 'ACME-102' },
    history: { firstSeenAt: FIRST.closed, times: 1, lastStatus: 'declined', lastDecisionAt: FIRST.decided, lastNote: 'not now' },
  });
  assert.deepEqual(state.items.filter((i) => 'carriedFrom' in i).map((i) => i.id), ['ACME-101'], 'only a carried decline has it');
  assert.deepEqual(state.decisions, []);
  assert.deepEqual(sb.read('status.json').items, {}, 'nothing was decided in this run');
  assert.deepEqual({ status: of('ACME-102').status, history: of('ACME-102').history }, { status: 'open', history: { firstSeenAt: FIRST.closed, times: 1, lastStatus: 'deferred', lastDecisionAt: FIRST.decided } });
  assert.deepEqual(of('ACME-103').history, { firstSeenAt: FIRST.closed, times: 1, lastStatus: 'fixed', lastDecisionAt: FIRST.decided, lastNote: 'yes, do it' });
  assert.ok(!('history' in of('ACME-104')) && !('history' in of('ACME-105')) && !('previous' in of('ACME-105')));

  // What that review left, each with the finding it became in this run.
  assert.deepEqual(harness.followUp.items.map((i) => [i.id, i.status, i.check, i.now]), [
    ['ACME-101', 'fixed', 'in-place', 'ACME-103'], ['ACME-102', 'declined', undefined, 'ACME-101'], ['ACME-103', 'deferred', undefined, 'ACME-102'], ['ACME-104', 'open', undefined, undefined],
  ]);
  assert.equal(harness.followUp.summary.cameBack, 1);
  // The harness as found now: 2 + 15 + 5 + 5 + 5 points lost.
  assert.deepEqual(harness.followUp.score, { then: 79, expected: 79, now: 68 });
  const next = sb.run(['next']).json;
  assert.equal(next.undecided, 4, 'the declined one is not asked again');
  assert.deepEqual(next.approvedWaiting, {});

  // Closing this run records it as a follow-up, and the decision made then travels with the finding.
  const closedAt = '2026-02-10T13:00:00.000Z';
  assert.equal(sb.run(['close'], clock(closedAt)).code, 0);
  const second = history.record(first.key, sb.runId);
  assert.deepEqual(validateRecord(second), []);
  assert.deepEqual(second.followUpOf, { runId: first.runId, reviewedAt: FIRST.closed });
  assert.deepEqual(second.outcome, harness.followUp);
  assert.deepEqual({ status: second.items[0].status, decision: second.items[0].decision, previous: second.items[0].previous }, {
    status: 'declined', decision: { action: 'decline', at: FIRST.decided, note: 'not now', carriedFrom: { run: first.runId, item: 'ACME-102' } }, previous: prev('ACME-102'),
  });
  assert.deepEqual(history.index().harnesses[first.key].reviews.map((r) => [r.runId, r.score, r.fixed]), [[first.runId, 79, 1], [sb.runId, 69, 0]]);
  const md = history.md(first.key, sb.runId).split('\n');
  assert.deepEqual(md.slice(0, 5), [
    '# Review of acme-shop, 2026-02-10', '', '## Since the last review', '',
    'The review of 2026-01-10, 31 days ago, against what was measured since. 25 sessions since then. 0 of 1 expected effect confirmed.',
  ], 'the record of a follow-up leads with the comparison');
  for (const line of [
    'Score at that review: 79 (B) · score that review expected: 79 (B) · score as found today: 68 (C)',
    '| Measure | Before | Expected | Now | Change | Verdict |',
    '| Context at the start of a session (tokens per session) | 50k | 40k | 50k | 0% | no change |',
    'Expected saving, in tokens per session: 10k · measured change, in tokens per session: 0 · 1 fix still in place · 0 fixes reverted · 1 fix back as a finding',
    '### What that review fixed, checked on disk',
    '- **ACME-101** Finding ACME-101: still in place · `./CLAUDE.md` · expected saving 200k tokens · in this review: ACME-103',
    '### 3 items that review left undone',
    '- **ACME-102** Finding ACME-102: declined · in this review: ACME-101',
    '- **ACME-103** Finding ACME-103: later · in this review: ACME-102',
    '- **ACME-104** Finding ACME-104: open',
    'Two periods are compared here, not two versions of the same work: the kind of task, the models and the amount of activity change too. A confirmed effect is not proof that the change caused it, and a number that got worse is a lead to check, not a reason to undo the fix.',
    '## This review',
    `- Run: ${sb.runId}, started 2026-02-10. Follow-up of the review of 2026-01-10 (${first.runId})`,
    '- **ACME-101** Finding ACME-101 (low, additive)',
    `  - Decision: declined on 2026-01-10, kept from run ${first.runId}: the same proposal came back. "not now"`,
    `  - Same finding as ACME-102 of run ${first.runId}.`,
  ]) assert.ok(md.includes(line), line);

  // A third review: the history of a finding follows `previous` from record to record.
  const secondRun = sb.runId;
  const third = followUp(sb, '2026-03-15T13:00:00.000Z');
  assert.deepEqual(third.harnesses[0].followUp, { runId: secondRun, reviewedAt: closedAt, days: 33, windowDays: 30 });
  writeImpact(sb, 'acme-shop', since({}, '2026-03-15T13:00:00.000Z'));
  assert.equal(sb.complete('review:security', findings([
    item('ACME-101', 'acme-shop', 1, { previous: { run: secondRun, item: 'ACME-102' }, severity: 'high', changes: undefined, file: './settings.json' }),
    item('ACME-102', 'acme-shop', 1, { previous: { run: secondRun, item: 'ACME-101' }, class: 'additive', severity: 'low', changes: [{ path: './AGENTS.md', lang: 'markdown', before: '', after: 'A new rule.\n', why: 'Adds the rule.' }] }),
  ])).code, 0);
  const now = build(sb);
  assert.deepEqual(now.harness.history.map((h) => [h.runId, h.reviewedAt, h.score, h.fixed]), [[first.runId, FIRST.closed, 79, 1], [secondRun, closedAt, 69, 0]], 'oldest first');
  assert.deepEqual(now.harness.followUp.of, { runId: secondRun, reviewedAt: closedAt });
  assert.deepEqual(now.state.items[0].history, { firstSeenAt: FIRST.closed, times: 2, lastStatus: 'open' }, 'deferred in January, open in February, here again');
  assert.deepEqual({ status: now.state.items[1].status, decision: now.state.items[1].decision, carriedFrom: now.state.items[1].carriedFrom, history: now.state.items[1].history }, {
    status: 'declined', decision: 'not now', carriedFrom: { run: secondRun, item: 'ACME-101' },
    history: { firstSeenAt: FIRST.closed, times: 2, lastStatus: 'declined', lastDecisionAt: FIRST.decided, lastNote: 'not now' },
  }, 'carried again, from the review that carried it: the date is still the day the user said no');
});

test('a harness with no record gets nothing from all this: its part of the state is what it always was', (t) => {
  const sb = one(t);
  firstReview(sb);
  // A second project that was never reviewed joins the next run.
  const fresh = path.join(sb.home, 'dev', 'novarc-powers');
  fs.mkdirSync(fresh, { recursive: true });
  const selection = path.join(sb.home, 'both.json');
  fs.writeFileSync(selection, JSON.stringify({ ...sb.selection, projects: [...sb.selection.projects, { name: 'novarc-powers', path: '~/dev/novarc-powers', pathAbs: fresh }] }));
  const init = sb.run(['init', '--select', selection], clock(SECOND));
  assert.equal(init.code, 0, init.stdout);
  sb.runId = init.json.runId;
  sb.dir = init.json.dir;
  assert.deepEqual(init.json.harnesses.map((h) => [h.id, 'followUp' in h]), [['acme-shop', true], ['novarc-powers', false]]);
  assert.ok(!('followUpOf' in init.json), 'a plain run is nobody\'s follow-up, whatever its harnesses');
  assert.deepEqual(sb.read('run.json').harnesses.map((h) => [h.id, h.windowDays, 'lastRecord' in h]), [['acme-shop', 30, true], ['novarc-powers', undefined, false]]);
  writeImpact(sb, 'acme-shop', since());
  writeImpact(sb, 'novarc-powers', since());
  assert.equal(sb.complete('review:security', {
    rounds: [{ harness: 'acme-shop', round: 1, status: 'done' }, { harness: 'novarc-powers', round: 1, status: 'done' }],
    items: [item('ACME-101', 'acme-shop', 1), item('NP-101', 'novarc-powers', 1), item('NP-102', 'novarc-powers', 1, { changes: undefined, file: './README.md' })],
  }).code, 0);

  const withRecords = build(sb);
  const text = sb.text('state.json');
  const [acme, np] = withRecords.state.harnesses;
  assert.deepEqual(Object.keys(acme), ['id', 'key', 'kind', 'name', 'path', 'impact', 'history', 'followUp', 'scores']);
  assert.deepEqual(acme.scores, { previous: 79 }, 'the score its last review ended with');
  assert.deepEqual(Object.keys(np), ['id', 'key', 'kind', 'name', 'path', 'impact'], 'no history and no followUp');
  assert.ok(withRecords.state.items.every((i) => !('history' in i)));
  assert.ok(!('followUpOf' in withRecords.state.run));

  // Take every record away and build again: apart from the two keys of the harness that had one,
  // the state is the same, byte for byte.
  const history = historyOf(sb);
  fs.renameSync(history.dir, `${history.dir}-away`);
  const without = build(sb);
  assert.ok(without.state.harnesses.every((h) => !('history' in h) && !('followUp' in h)));
  const stripped = JSON.parse(text);
  for (const h of stripped.harnesses) { delete h.history; delete h.followUp; }
  assert.equal(sb.text('state.json'), `${JSON.stringify(stripped, null, 2)}\n`);
  assert.equal(JSON.stringify(without.state.harnesses[1]), JSON.stringify(np));
  assert.deepEqual(without.state.items, withRecords.state.items);
  // And records of other harnesses change nothing for a run whose harnesses have none.
  fs.renameSync(`${history.dir}-away`, history.dir);
  fs.renameSync(path.join(history.dir, acme.key), path.join(history.dir, 'someone-else-0a1b2c3d'));
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  assert.equal(sb.text('state.json'), `${JSON.stringify(stripped, null, 2)}\n`);
});

test('a record that is not a valid record is ignored, and said', (t) => {
  const sb = one(t);
  const first = firstReview(sb);
  const history = historyOf(sb);
  const good = path.join(history.dir, first.key, `${first.runId}.json`);
  const broken = JSON.parse(fs.readFileSync(good, 'utf8'));
  broken.runId = '20251201-old1';
  broken.reviewedAt = '2025-12-01T12:00:00.000Z';
  broken.items[0].title = { not: 'a text' };
  fs.writeFileSync(path.join(history.dir, first.key, '20251201-old1.json'), JSON.stringify(broken));
  fs.writeFileSync(path.join(history.dir, first.key, '20251101-junk.json'), '{ "schema": 1, ');
  followUp(sb, SECOND);
  writeImpact(sb, 'acme-shop', since());
  const { harness, warnings } = build(sb);
  assert.deepEqual(harness.history.map((h) => h.runId), [first.runId]);
  assert.deepEqual(warnings.filter((w) => /review record/.test(w.problem)), [
    { source: `history/${first.key}/20251101-junk.json`, problem: 'not a review record this version reads (not-json); ignored' },
    { source: `history/${first.key}/20251201-old1.json`, problem: 'not a review record this version reads (invalid); ignored' },
  ]);
  const listed = sb.run(['history', '--json']).json;
  assert.deepEqual(listed.harnesses[0].reviews.map((r) => r.runId), [first.runId]);
  assert.deepEqual(listed.ignored, [
    { harness: first.key, file: '20251101-junk.json', reason: 'not-json' },
    { harness: first.key, file: '20251201-old1.json', reason: 'invalid' },
  ]);
  assert.match(sb.run(['history']).stdout, /^2 files under history\/ are not review records this version reads and were ignored \(run\.mjs history --json says which\)\.$/m);
});

test('the record of a follow-up, to read: it leads with the comparison, in the language of the run', (t) => {
  const sb = one(t);
  const first = firstReview(sb, { initArgs: ['--lang', 'pt'] });
  followUp(sb, SECOND);
  writeImpact(sb, 'acme-shop', since({ ...startAt(40000), contextPeak: undefined, totalTokens: 2125000, toolOutput: { shellResultChars: 1250000 } }));
  assert.equal(sb.complete('review:security', {
    rounds: [{ harness: 'acme-shop', round: 1, status: 'done' }],
    items: [
      item('ACME-101', 'acme-shop', 1, { previous: { run: first.runId, item: 'ACME-102' }, class: 'additive', severity: 'low', changes: [{ path: './AGENTS.md', lang: 'markdown', before: '', after: 'A new rule.\n', why: 'Adds the rule.' }] }),
      item('ACME-102', 'acme-shop', 1, { previous: { run: first.runId, item: 'ACME-103' }, severity: 'high', changes: undefined, file: './settings.json' }),
    ],
  }).code, 0);
  assert.equal(sb.run(['close'], clock('2026-02-10T13:00:00.000Z')).code, 0);
  const md = historyOf(sb).md(first.key, sb.runId);
  assert.equal(md, [
    '# Revisão de acme-shop, 2026-02-10',
    '',
    '## Desde a última revisão',
    '',
    'A revisão de 2026-01-10, há 31 dias, contra o que foi medido desde então. 25 sessões desde então. 1 de 1 efeito esperado confirmado.',
    '',
    'Nota naquela revisão: 79 (B) · nota que aquela revisão esperava: 79 (B) · nota como está hoje: 83 (B)',
    '',
    '| Medida | Antes | Esperado | Agora | Mudança | Resultado |',
    '|---|---|---|---|---|---|',
    '| Contexto no início da sessão (tokens por sessão) | 50 mil | 40 mil | 40 mil | -20% | confirmado |',
    '| Todos os tokens gastos (tokens por sessão) | 100 mil | - | 85 mil | -15% | melhorou |',
    '| Custo relativo (tokens por sessão) | 20 mil | - | 20 mil | 0% | sem mudança |',
    '| Pico de contexto da sessão (tokens por sessão) | 120 mil | - | sem medição | - | sem medição |',
    '| Parcela do gasto que foi à toa (por cento do gasto) | 5% | - | 5% | 0% | sem mudança |',
    '| Repetições de um comando que continua falhando (tokens por sessão) | 5 mil | - | 5 mil | 0% | sem mudança |',
    '| Saída de terminal lida pelo agente (caracteres por sessão) | 40 mil | - | 50 mil | +25% | piorou |',
    '',
    'Economia esperada, em tokens por sessão: 10 mil · mudança medida, em tokens por sessão: -15 mil · 1 correção que continua no lugar · 0 correções desfeitas · 0 correções que voltaram como achados',
    '',
    '### O que aquela revisão corrigiu, conferido no disco',
    '',
    '- **ACME-101** Finding ACME-101: continua no lugar · `./CLAUDE.md` · economia esperada 200 mil tokens',
    '',
    '### 3 itens que aquela revisão deixou por fazer',
    '',
    '- **ACME-102** Finding ACME-102: recusado · nesta revisão: ACME-101',
    '- **ACME-103** Finding ACME-103: adiado · nesta revisão: ACME-102',
    '- **ACME-104** Finding ACME-104: aberto',
    '',
    'Aqui são comparados dois períodos, não duas versões do mesmo trabalho: o tipo de tarefa, os modelos e a quantidade de atividade também mudam. Um efeito confirmado não prova que a mudança foi a causa, e um número que piorou é uma pista para conferir, não um motivo para desfazer a correção.',
    '',
    '## Esta revisão',
    '',
    '- Harness: acme-shop (harness de projeto), `~/dev/acme-shop`',
    `- Execução: ${sb.runId}, iniciada em 2026-02-10. Acompanha a revisão de 2026-01-10 (${first.runId})`,
    '- Nota: 83 como foi encontrado, 84 depois desta revisão, 84 quando o que foi aprovado estiver aplicado (conceito B)',
    '- Nenhuma mudança foi aplicada.',
    '- Acompanhamento a partir de: 2026-03-12',
    '',
    '## Medido',
    '',
    '30 dias, 25 sessões. Todo número é por sessão.',
    '',
    '| Medida | Valor |',
    '|---|---|',
    '| Todos os tokens gastos (tokens por sessão) | 85 mil |',
    '| Custo relativo (tokens por sessão) | 20 mil |',
    '| Contexto no início da sessão (tokens por sessão) | 40 mil |',
    '| Parcela do gasto que foi à toa (por cento do gasto) | 5% |',
    '| Repetições de um comando que continua falhando (tokens por sessão) | 5 mil |',
    '| Saída de terminal lida pelo agente (caracteres por sessão) | 50 mil |',
    '',
    '## Recusados (1)',
    '',
    '- **ACME-101** Finding ACME-101 (baixa, aditiva)',
    `  - Decisão: recusado em 2026-01-10, mantido da execução ${first.runId}: a mesma proposta voltou. "not now"`,
    '  - Para levar: The rule to keep.',
    `  - Mesmo achado que ACME-102 da execução ${first.runId}.`,
    '',
    '## Em aberto (1)',
    '',
    '- **ACME-102** Finding ACME-102 (alta, reversível)',
    '  - Para levar: The rule to keep.',
    `  - Mesmo achado que ACME-103 da execução ${first.runId}.`,
    '',
  ].join('\n'));
  assert.ok(!/[‒-―]|\p{Extended_Pictographic}/u.test(md), 'no dash other than the hyphen, and no emoji');

  // Too soon to compare: the same place says so, with the day it will be ready.
  const soon = one(t);
  const early = firstReview(soon, { initArgs: ['--lang', 'pt'] });
  followUp(soon, '2026-01-13T12:00:00.000Z');
  writeImpact(soon, 'acme-shop', since({}, '2026-01-13T12:00:00.000Z'));
  assert.equal(soon.run(['close'], clock('2026-01-13T13:00:00.000Z')).code, 0);
  const waiting = historyOf(soon).md(early.key, soon.runId).split('\n');
  assert.equal(waiting[4], 'A revisão de 2026-01-10, há 3 dias, contra o que foi medido desde então. Ainda sem dados suficientes: pronto para comparar em 2026-01-17.');
  assert.ok(waiting.includes('| Contexto no início da sessão (tokens por sessão) | 50 mil | 40 mil | 50 mil | 0% | ainda sem dados suficientes |'), waiting.join('\n'));
});

// ---------------------------------------------------------------------------------------------
// The functions, called directly
// ---------------------------------------------------------------------------------------------

test('comparable metrics: per session, from the impact; what was not measured is absent', () => {
  assert.deepEqual(METRICS, loadStateSchema().schema.$defs.metric.enum, 'the same list as $defs.metric of the state schema');
  assert.deepEqual(METRICS.map(metricUnit), ['tokens/session', 'tokens/session', 'tokens/session', 'tokens/session', 'percent', ...Array(7).fill('tokens/session'), 'chars/session']);
  const raw = measured();
  assert.deepEqual(metricsOf(raw, raw), { 'tokens-per-session': 100000, 'weighted-per-session': 20000, 'context-at-start': 50000, 'context-peak': 120000, 'waste-share': 5, 'waste:retry': 5000, 'tool-output': 40000 });
  assert.deepEqual(coverageOf(raw), { claude: 'complete', codex: 'not-read' });
  assert.deepEqual(coverageOf({ coverage: { claude: { toolCalls: 'partial' }, codex: { toolCalls: 'made-up' }, method: 'text' } }), { claude: 'partial' });
  assert.deepEqual(coverageOf(null), {});

  // Without price weights the share of waste is taken on raw tokens: 100000 of 2000000.
  const { weightedTotal: _w, ...unweighted } = raw;
  unweighted.waste = [{ kind: 'retry', tokens: 100000 }, { kind: 'loop', tokens: 30000 }, { kind: 'made-up', tokens: 5 }];
  assert.deepEqual(metricsOf(unweighted, unweighted), { 'tokens-per-session': 100000, 'context-at-start': 50000, 'context-peak': 120000, 'waste-share': 6.5, 'waste:retry': 5000, 'waste:loop': 1500, 'tool-output': 40000 });
  // The state keeps less than the probe wrote: without the probe's file there is no shell output.
  assert.deepEqual(Object.keys(metricsOf(raw, null)), ['tokens-per-session', 'weighted-per-session', 'context-at-start', 'context-peak', 'waste-share', 'waste:retry']);
  // A median over no session is not a measurement; a measured zero is.
  assert.deepEqual(metricsOf({ sessions: 5, totalTokens: 1000, contextAtStart: { perSessionMedian: 0 }, waste: [{ kind: 'retry', tokens: 0 }] }, { contextAtStart: { sessionsMeasured: 0 } }), { 'tokens-per-session': 200, 'waste-share': 0, 'waste:retry': 0 });
  assert.deepEqual(metricsOf({ sessions: 0, totalTokens: 0 }, {}), {});
  assert.deepEqual(metricsOf(null, null), {});

  assert.deepEqual(loadThresholds(), { followUpAfterDays: 30, minDays: 7, minSessions: 10, confirmedShare: 0.7, partialShare: 0.2, noisePct: 10 }, 'the thresholds of references/catalog/follow-up.json');
  const record = { reviewedAt: '2026-01-10T12:00:00.000Z', changesAppliedAt: '2026-01-10T11:31:00.000Z' };
  const at = (iso) => Date.parse(iso);
  assert.deepEqual(followUpWindow(record, at('2026-01-17T11:30:59.000Z'), 30), { days: 6, windowDays: 30, sinceReview: false });
  assert.deepEqual(followUpWindow(record, at('2026-01-17T11:31:00.000Z'), 30), { days: 7, windowDays: 7, sinceReview: true });
  assert.deepEqual(followUpWindow(record, at('2026-03-01T00:00:00.000Z'), 30), { days: 49, windowDays: 30, sinceReview: true });
  assert.deepEqual(followUpWindow({ ...record, changesAppliedAt: null }, at('2026-01-20T12:00:00.000Z'), 30), { days: 10, windowDays: 10, sinceReview: true }, 'nothing applied: counted from the end of the review');
});

test('verdicts at their thresholds, and what sets an expectation', () => {
  const saving = (id, tokens, metric) => ({ id, title: id, round: 1, status: 'fixed', saves: { tokens, basis: 'measured', ...(metric ? { metric } : {}) } });
  const record = {
    runId: '20260110-then', reviewedAt: '2026-01-10T12:00:00.000Z', changesAppliedAt: '2026-01-10T11:31:00.000Z',
    scores: { current: 80, projected: 90 },
    measure: { sessions: 20, metrics: { 'tokens-per-session': 100000, 'context-at-start': 50000, 'context-peak': 120000, 'waste-share': 5, 'waste:retry': 5000, 'tool-output': 40000 } },
    items: [
      saving('A-101', 200000, 'context-at-start'), saving('A-102', 40000),
      saving('A-103', 60000, 'waste-share'), saving('A-104', 60000, 'tool-output'), saving('A-105', 20000, 'waste:loop'),
      { id: 'A-106', title: 'A-106', round: 1, status: 'declined', saves: { tokens: 999999, basis: 'estimated', metric: 'context-at-start' } },
    ],
  };
  const compare = (metrics, sessions = 25) => followUpFor({
    record, run: { createdAt: SECOND }, h: { id: 'x', kind: 'project', path: '~/dev/x', pathAbs: path.join('nowhere', 'x') },
    hs: { impact: { windowDays: 30, to: SECOND, sessions, totalTokens: metrics['tokens-per-session'] * sessions, contextAtStart: { perSessionMedian: metrics['context-at-start'] }, waste: [{ kind: 'retry', tokens: metrics['waste:retry'] * sessions }] } },
    raw: { toolOutput: { shellResultChars: metrics['tool-output'] * sessions } }, items: [], scoreNow: 85,
  });
  const same = { 'tokens-per-session': 100000, 'context-at-start': 50000, 'waste:retry': 5000, 'tool-output': 40000 };
  const base = compare(same);
  assert.deepEqual(base.score, { then: 80, expected: 90, now: 85 });
  // One row for every metric measured on either side. An expectation is the sum of the fixed
  // items that named the metric, over the sessions of that review.
  assert.deepEqual(base.metrics.map((m) => [m.metric, m.before, m.expected, m.after, m.verdict, m.items]), [
    ['tokens-per-session', 100000, 98000, 100000, 'no-change', ['A-102']], // no metric named: it counts toward tokens per session
    ['context-at-start', 50000, 40000, 50000, 'no-change', ['A-101']], // the declined item expected nothing
    ['context-peak', 120000, null, null, 'not-measured', undefined], // measured then, not now
    ['waste-share', 5, null, 5, 'no-change', ['A-103']], // a saving is in tokens: no expectation for a percentage
    ['waste:retry', 5000, null, 5000, 'no-change', undefined],
    ['tool-output', 40000, null, 40000, 'no-change', ['A-104']], // nor for characters
  ], 'waste:loop was named by a fixed item and measured on neither side: it has no row');
  assert.equal(base.summary.expectedTokensPerSession, 19000, '380000 tokens over 20 sessions');

  const verdict = (metric, value) => compare({ ...same, [metric]: value }).metrics.find((m) => m.metric === metric).verdict;
  // With an expectation of 10000 less: 70% of it is confirmed, 20% is partial.
  assert.equal(verdict('context-at-start', 43000), 'confirmed');
  assert.equal(verdict('context-at-start', 43001), 'partial');
  assert.equal(verdict('context-at-start', 48000), 'partial');
  assert.equal(verdict('context-at-start', 48001), 'no-change');
  assert.equal(verdict('context-at-start', 55000), 'no-change', 'up by exactly the noise is still noise');
  assert.equal(verdict('context-at-start', 55001), 'worse');
  assert.equal(verdict('context-at-start', 20000), 'confirmed', 'more than expected');
  // Without one: more than 10% either way.
  assert.equal(verdict('waste:retry', 4500), 'no-change');
  assert.equal(verdict('waste:retry', 4499), 'improved');
  assert.equal(verdict('waste:retry', 5500), 'no-change');
  assert.equal(verdict('waste:retry', 5501), 'worse');
  assert.equal(verdict('tool-output', 30000), 'improved', 'a metric with fixed items but no expectation is read as a plain change');
  assert.equal(verdict('waste:retry', 0), 'improved');
  // The expectation of 2000 tokens per session is small: 98600 is 70% of it, and still within the noise.
  assert.equal(verdict('tokens-per-session', 98600), 'confirmed');
  assert.equal(verdict('tokens-per-session', 99700), 'no-change');
  // The order of the table: a rise is "worse" whatever was expected.
  assert.equal(verdict('tokens-per-session', 111000), 'worse');
  // Not enough sessions comes first: nothing is judged, not even what was not measured.
  const few = compare(same, 9);
  assert.deepEqual(few.sample, { sessions: 9, enough: false, reason: 'too-few-sessions' });
  assert.deepEqual(few.metrics.map((m) => [m.metric, m.after === null, m.verdict]), [
    ['tokens-per-session', false, 'not-enough-data'], ['context-at-start', false, 'not-enough-data'], ['context-peak', true, 'not-enough-data'],
    ['waste-share', false, 'not-enough-data'], ['waste:retry', false, 'not-enough-data'], ['tool-output', false, 'not-enough-data'],
  ]);
});

test('the on-disk check, change by change', (t) => {
  const home = tmpDir('hd-check-');
  const before = process.env.NOVARC_POWERS_HOME;
  process.env.NOVARC_POWERS_HOME = home;
  t.after(() => { if (before === undefined) delete process.env.NOVARC_POWERS_HOME; else process.env.NOVARC_POWERS_HOME = before; rmrf(home); });
  const root = path.join(home, 'dev', 'acme');
  const h = { id: 'acme', kind: 'project', path: '~/dev/acme', pathAbs: root };
  const put = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  const check = (...changes) => checkItem({ changes }, h);

  // An insertion: there, taken out again, or the place it went into is gone too.
  const inserted = { path: './CLAUDE.md', before: '', after: '- Never force-push.\n', insertAfter: '## Rules' };
  put('CLAUDE.md', '# Project\n## Rules\n- Never force-push.\n- Ask first.\n');
  assert.equal(check(inserted), 'in-place');
  put('CLAUDE.md', '# Project\n## Rules\n- Ask first.\n');
  assert.equal(check(inserted), 'reverted');
  put('CLAUDE.md', '# Project\nRewritten from scratch.\n');
  assert.equal(check(inserted), 'changed');
  assert.equal(check({ ...inserted, insertAfter: undefined }), 'reverted', 'appended at the end, and no longer there');

  // A removal: gone, or back.
  const removed = { path: './CLAUDE.md', before: 'An obsolete paragraph.\n', after: '' };
  assert.equal(check(removed), 'in-place');
  put('CLAUDE.md', '# Project\nAn obsolete paragraph.\n');
  assert.equal(check(removed), 'reverted');

  // A replacement whose new text contains the old one: the old text counts only outside the new.
  const grown = { path: './CLAUDE.md', before: 'Run the tests.', after: 'Run the tests. Then run the linter.' };
  put('CLAUDE.md', 'Run the tests. Then run the linter.\n');
  assert.equal(check(grown), 'in-place');
  put('CLAUDE.md', 'Run the tests.\n');
  assert.equal(check(grown), 'reverted');

  // A file the change created, and a file the change removed.
  const created = { path: './.claude/rules/new.md', before: '', after: 'A new rule.\n' };
  assert.equal(check(created), 'missing');
  put('.claude/rules/new.md', 'A new rule.\n');
  assert.equal(check(created), 'in-place');
  const deleted = { path: './OLD.md', before: 'obsolete\n', after: '', hashAfter: null, deleted: true };
  assert.equal(check(deleted), 'in-place', 'still gone');
  put('OLD.md', 'obsolete\n');
  assert.equal(check(deleted), 'reverted', 'it is back');

  // The hash the ledger recorded settles it without reading the text.
  put('settings.json', '{ "a": 1 }\n');
  const hash = 'a'.repeat(64);
  assert.equal(check({ path: './settings.json', before: '', after: '', hashAfter: hash }), 'not-checked', 'another hash and no text to look for: nothing can be said');
  assert.equal(check({ path: './settings.json', before: '{ "a": 0 }', after: '{ "a": 1 }', hashAfter: hash }), 'in-place', 'another hash, but the text is there');

  // Several changes: the worst result is the item's.
  put('CLAUDE.md', 'Run the tests. Then run the linter.\n');
  assert.equal(check(grown, created), 'in-place');
  assert.equal(check(grown, { ...created, path: './.claude/rules/gone.md' }), 'missing');
  assert.equal(check(grown, removed, { path: './CLAUDE.md', before: 'x', after: 'never written' }), 'changed');
  assert.equal(check({ path: './CLAUDE.md', before: 'Run the tests. Then run the linter.', after: 'Run nothing.' }, { path: './CLAUDE.md', before: 'x', after: 'never written' }), 'reverted');

  // Nothing to look for, or nowhere to look.
  assert.equal(checkItem({}, h), 'not-checked', 'an item with no change: a command, an install');
  assert.equal(check({ path: './CLAUDE.md', before: '', after: '' }), 'not-checked');
  assert.equal(check({ path: './CLAUDE.md', before: ' \n', after: '\n' }), 'not-checked', 'white space is not a text to look for');
  assert.equal(check({ before: 'a', after: 'b' }), 'not-checked');
  put('../outside.md', 'other plans\n');
  assert.equal(check({ path: '../outside.md', before: 'x', after: 'other plans' }), 'not-checked', 'a path that climbs out of the harness is never followed');
  assert.equal(check({ path: './sub/../../outside.md', before: 'x', after: 'other plans' }), 'not-checked');
  assert.equal(check({ path: '~/dev/outside.md', before: 'x', after: 'other plans' }), 'not-checked', 'a file of the home is not a file of this project');
  assert.equal(check({ path: '~/dev/acme/CLAUDE.md', before: 'x', after: 'Run the tests. Then run the linter.' }), 'in-place', 'the display path of the project names its own files');
  assert.equal(check({ path: '~/../outside-the-home.md', before: 'x', after: 'y' }), 'not-checked');
  assert.equal(check({ path: path.join(root, 'CLAUDE.md'), before: 'x', after: 'Run the tests. Then run the linter.' }), 'not-checked', 'an absolute path is never taken from a record');
  assert.equal(check({ path: './dev', before: 'x', after: 'y' }), 'missing');
  fs.mkdirSync(path.join(root, 'folder'));
  assert.equal(check({ path: './folder', before: 'x', after: 'y' }), 'not-checked', 'a folder is not a file');

  // A user harness: its files are named from the home.
  const account = { id: 'claude-1', kind: 'user', path: '~/.claude', pathAbs: path.join(home, 'accounts', 'one') };
  fs.mkdirSync(account.pathAbs, { recursive: true });
  fs.writeFileSync(path.join(account.pathAbs, 'CLAUDE.md'), 'Be brief.\n');
  assert.equal(checkItem({ changes: [{ path: '~/.claude/CLAUDE.md', before: 'Be verbose.', after: 'Be brief.' }] }, account), 'in-place', 'the display path of the account maps to its real folder');
  assert.equal(checkItem({ changes: [{ path: '~/.claude/missing.md', before: 'a', after: 'b' }] }, account), 'missing');

  // A record quotes a secret masked; the file holds it in full. The check looks at the file masked the same way.
  const token = 'ghp_' + 'T'.repeat(36);
  put('settings.json', `{\n  "env": { "GITHUB_TOKEN": "${token}" }\n}\n`);
  const secret = { path: './settings.json', before: '"GITHUB_TOKEN": "ghp_…40"', after: '"GITHUB_TOKEN": "${GITHUB_TOKEN}"' };
  assert.equal(check(secret), 'reverted', 'the token is in the file again');
  put('settings.json', '{\n  "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }\n}\n');
  assert.equal(check(secret), 'in-place');
});
