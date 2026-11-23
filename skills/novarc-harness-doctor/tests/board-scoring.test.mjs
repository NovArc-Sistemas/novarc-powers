// Scoring arithmetic (scripts/lib/scoring.mjs), with every expected number worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  floor1, gradeFor, statusFactor, roundDeductions, roundBreakdown, scoreHarness, computeScores, applyScores, averageScore,
  STATUS_FACTOR, SEVERITY_POINTS, ROUND_WEIGHTS,
} from '../scripts/lib/scoring.mjs';

/** A small in-memory harness `h`: `done` lists the rounds that count; items default to round 1, open, active. */
function mini(items, done = [1]) {
  return {
    harnesses: [{ id: 'h', kind: 'project', name: 'h', path: './' }],
    rounds: done.map((round) => ({ harness: 'h', round, status: 'done' })),
    items: items.map((it, k) => ({ id: `X-${k + 1}`, harness: 'h', round: 1, status: 'open', class: 'none', ...it })),
  };
}
const sc = (items, done) => scoreHarness(mini(items, done), 'h');

test('floor1 never rounds up and survives float error', () => {
  assert.equal(floor1(2630 / 35), 75.1);
  assert.equal(floor1(6355 / 70), 90.7);
  assert.equal(floor1(96.25), 96.2);
  assert.equal(floor1((45.5 / 70) * 100), 65); // 64.99999... in floating point
  assert.equal(floor1(89.99), 89.9);
});

test('grades: A >= 90, B >= 75, C >= 60, D >= 40, otherwise F', () => {
  const cases = [[100, 'A'], [90, 'A'], [89.9, 'B'], [75, 'B'], [74.9, 'C'], [60, 'C'], [59.9, 'D'], [40, 'D'], [39.9, 'F'], [0, 'F']];
  for (const [score, grade] of cases) assert.equal(gradeFor(score), grade, `score ${score}`);
  assert.equal(gradeFor(null), null);
});

test('weights and points are the documented ones', () => {
  assert.deepEqual(ROUND_WEIGHTS, { 1: 20, 2: 15, 3: 10, 4: 15, 5: 5, 6: 15, 7: 10, 8: 10 });
  assert.deepEqual(SEVERITY_POINTS, { critical: 25, high: 15, medium: 5, low: 2 });
  assert.equal(Object.values(ROUND_WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test('status factors: open, approved, in-progress, failed, deferred count in full; declined half; fixed, ok, not-applicable nothing', () => {
  assert.deepEqual(STATUS_FACTOR, { open: 1, approved: 1, 'in-progress': 1, failed: 1, deferred: 1, declined: 0.5, fixed: 0, ok: 0, 'not-applicable': 0 });
  // One high item (15 points) alone in a done round, per status: current = 100 - 15 x factor.
  const expected = { open: 85, approved: 85, 'in-progress': 85, failed: 85, deferred: 85, declined: 92.5, fixed: 100, ok: 100, 'not-applicable': 100 };
  for (const [status, current] of Object.entries(expected)) {
    const s = sc([{ severity: 'high', status }]);
    assert.equal(s.current, current, status);
    assert.equal(s.baseline, 85, `${status}: the baseline treats every item as open`);
  }
  assert.equal(statusFactor('something-new', 'current'), 1, 'an unknown status counts in full');
});

test('projected treats approved and in-progress as fixed, and nothing else', () => {
  // critical open 25 + high approved 15 + medium in-progress 5 + low declined 1 + high deferred 15 + medium failed 5
  const s = sc([
    { severity: 'critical' },
    { severity: 'high', status: 'approved' },
    { severity: 'medium', status: 'in-progress' },
    { severity: 'low', status: 'declined' },
    { severity: 'high', status: 'deferred' },
    { severity: 'medium', status: 'failed' },
  ]);
  assert.equal(s.baseline, 33); // 25 + 15 + 5 + 2 + 15 + 5 = 67
  assert.equal(s.current, 34); // 25 + 15 + 5 + 1 + 15 + 5 = 66
  assert.equal(s.projected, 54); // 25 + 0 + 0 + 1 + 15 + 5 = 46
  assert.deepEqual([s.baselineGrade, s.grade, s.projectedGrade], ['F', 'F', 'D']);
  assert.equal(statusFactor('approved', 'projected'), 0);
  assert.equal(statusFactor('in-progress', 'projected'), 0);
  assert.equal(statusFactor('deferred', 'projected'), 1);
  assert.equal(statusFactor('fixed', 'baseline'), 1);
});

test('the worked example in scoring.md computes as documented', () => {
  const plugin = '~/.claude/plugins/acme/hooks.json';
  const st = mini([
    { round: 1, severity: 'critical', file: './.claude/settings.json' },
    { round: 1, severity: 'high', origin: 'plugin', file: plugin },
    { round: 1, severity: 'high', status: 'declined', origin: 'plugin', file: plugin },
    { round: 1, severity: 'medium', origin: 'plugin', file: plugin },
    { round: 2, severity: 'critical', class: 'secret', origin: 'example', file: './examples/.env.sample' },
    { round: 2, severity: 'medium', status: 'fixed', file: './CLAUDE.md' },
    { round: 3, severity: 'high', file: './docs/setup.md' },
    { round: 4, severity: 'low', origin: 'project-optional' },
    { round: 4, severity: 'high', status: 'approved', file: './.githooks/pre-push' },
  ], [1, 2, 4]);
  /*
    Done rounds 1, 2, 4: weights 20 + 15 + 15 = 50. Round 3 is not done, so P7 is not counted.
    current   r1: 25 + min(10, 7.5 + 3.75 + 2.5) = 35 -> 65 ; r2: 25 (secret, not discounted) -> 75
              r4: 1.5 + 15 = 16.5 -> 83.5
              (20 x 65 + 15 x 75 + 15 x 83.5) / 50 = 3677.5 / 50 = 73.55 -> 73.5, grade C
    baseline  r1: 25 + min(10, 17.5) = 35 -> 65 ; r2: 25 + 5 = 30 -> 70 ; r4: 16.5 -> 83.5
              (1300 + 1050 + 1252.5) / 50 = 72.05 -> 72, grade C
    projected r1: 65 ; r2: 75 ; r4: 1.5 -> 98.5 (the approved item counts as fixed)
              (1300 + 1125 + 1477.5) / 50 = 78.05 -> 78, grade B
  */
  const s = scoreHarness(st, 'h');
  assert.equal(s.current, 73.5);
  assert.equal(s.baseline, 72);
  assert.equal(s.projected, 78);
  assert.deepEqual([s.baselineGrade, s.grade, s.projectedGrade], ['C', 'C', 'B']);
  assert.equal(s.roundsCounted, 3);
  assert.equal(s.roundsTotal, 8);
});

test('origin weights scale a deduction: active 1, project-optional .75, plugin .5, example .25', () => {
  const one = (extra) => sc([{ severity: 'high', ...extra }]);
  assert.equal(one({}).current, 85); // no origin = active: 15
  assert.equal(one({ origin: 'active' }).current, 85);
  assert.equal(one({ origin: 'project-optional' }).current, 88.7); // 11.25 -> 88.75, floored
  assert.equal(one({ origin: 'plugin' }).current, 92.5); // 7.5
  assert.equal(one({ origin: 'example' }).current, 96.2); // 3.75 -> 96.25, floored
  // Origin and status multiply: 15 x .5 declined x .5 plugin = 3.75; baseline 15 x .5 = 7.5.
  const dec = one({ origin: 'plugin', status: 'declined' });
  assert.equal(dec.current, 96.2);
  assert.equal(dec.baseline, 92.5);
});

test('a secret is never discounted by origin and never capped', () => {
  assert.equal(sc([{ severity: 'critical', class: 'secret', origin: 'example', file: './examples/.env' }]).current, 75); // 25 in full, not 25 x .25
  assert.equal(sc([{ severity: 'critical', class: 'permission', origin: 'example', file: './examples/.env' }]).current, 93.7); // 6.25 -> 93.75, floored
  // Two secrets in one plugin file: 50, not capped at 10.
  assert.equal(sc([
    { severity: 'critical', class: 'secret', origin: 'plugin', file: 'p/x.json' },
    { severity: 'critical', class: 'secret', origin: 'plugin', file: 'p/x.json' },
  ]).current, 50);
  // A secret next to capped items in the same file: 25 + min(10, 7.5 + 7.5) = 35.
  assert.equal(sc([
    { severity: 'critical', class: 'secret', origin: 'plugin', file: 'p/x.json' },
    { severity: 'high', origin: 'plugin', file: 'p/x.json' },
    { severity: 'high', origin: 'plugin', file: 'p/x.json' },
  ]).current, 65);
});

test('per-file cap: non-active items of one file deduct at most 10 per round', () => {
  // Three high plugin items in one file: 7.5 x 3 = 22.5 -> capped at 10.
  const three = Array.from({ length: 3 }, () => ({ severity: 'high', origin: 'plugin', file: 'p/a.md' }));
  assert.equal(sc(three).current, 90);
  // A second file is a second group: 10 + 7.5.
  assert.equal(sc([...three, { severity: 'high', origin: 'plugin', file: 'p/b.md' }]).current, 82.5);
  // The first changes[].path wins over `file`: both items land in group "p/a.md" (15 -> 10).
  // If `file` won, they would be two groups of 7.5 and the round would score 85.
  assert.equal(sc([
    { severity: 'high', origin: 'plugin', file: 'p/a.md' },
    { severity: 'high', origin: 'plugin', file: 'p/b.md', changes: [{ path: 'p/a.md', before: 'x', after: 'y' }] },
  ]).current, 90);
  // Active items are never capped, even in one file: 25 + 25.
  assert.equal(sc([{ severity: 'critical', file: 'a.json' }, { severity: 'critical', file: 'a.json' }]).current, 50);
  // Non-active items without a file are not grouped: 7.5 x 3 = 22.5.
  assert.equal(sc(Array.from({ length: 3 }, () => ({ severity: 'high', origin: 'plugin' }))).current, 77.5);
  // The cap is per round: the same file in rounds 1 and 2 is capped in each.
  const both = mini([...three, ...three.map((i) => ({ ...i, round: 2 }))], [1, 2]);
  const rows = roundBreakdown(both, 'h');
  assert.equal(rows[0].deductions, 10);
  assert.equal(rows[1].deductions, 10);
  assert.equal(scoreHarness(both, 'h').current, 90);
  // Every view is capped: two declined plugin highs = 3.75 x 2 = 7.5 now, 15 -> 10 as open.
  const dec = sc([
    { severity: 'high', origin: 'plugin', status: 'declined', file: 'p/a.md' },
    { severity: 'high', origin: 'plugin', status: 'declined', file: 'p/a.md' },
  ]);
  assert.equal(dec.current, 92.5);
  assert.equal(dec.baseline, 90);
  assert.equal(roundDeductions(mini(three).items, 'projected'), 10);
});

test('a round never goes below zero and a low score grades F', () => {
  const s = sc(Array.from({ length: 5 }, () => ({ severity: 'critical' })));
  assert.equal(s.current, 0);
  assert.equal(s.grade, 'F');
  // Three open criticals in the only done round: 75 deducted -> 25, grade F.
  assert.equal(sc(Array.from({ length: 3 }, () => ({ severity: 'critical' }))).current, 25);
});

test('scores are per harness: another harness and rounds that are not done do not count', () => {
  const st = mini([{ severity: 'critical' }, { severity: 'critical', round: 2 }]);
  st.harnesses.push({ id: 'other', kind: 'user', name: 'other', path: '~' });
  st.rounds.push({ harness: 'other', round: 1, status: 'done' }, { harness: 'h', round: 2, status: 'pending' }, { harness: 'h', round: 3, status: 'not-applicable' });
  st.items.push({ id: 'O-1', harness: 'other', round: 1, severity: 'high', status: 'open', class: 'none' });
  assert.equal(scoreHarness(st, 'h').current, 75); // only its own round-1 critical
  assert.equal(scoreHarness(st, 'other').current, 85);
  assert.equal(scoreHarness(st, 'h').roundsCounted, 1);
  assert.equal(scoreHarness(st, 'h').roundsTotal, 7, 'a not-applicable round is not part of the total');
});

test('a harness with zero done rounds is not scored', () => {
  const s = scoreHarness(mini([{ severity: 'critical' }], []), 'h');
  assert.deepEqual([s.current, s.baseline, s.projected, s.grade, s.baselineGrade, s.projectedGrade, s.roundsCounted], [null, null, null, null, null, null, 0]);
});

test('computeScores keeps previous, and moves computedAt only when a value changes', () => {
  const st = mini([{ severity: 'high' }]);
  st.harnesses[0].scores = { previous: 61.5 };
  const t1 = new Date('2026-01-01T00:00:00Z');
  const first = applyScores(st, t1);
  assert.deepEqual(first.h, {
    current: 85, baseline: 85, projected: 85, previous: 61.5, grade: 'B', baselineGrade: 'B', projectedGrade: 'B',
    roundsCounted: 1, roundsTotal: 8, computedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(st.harnesses[0].scores, first.h, 'written into the harness');
  const same = computeScores(st, new Date('2026-02-02T00:00:00Z'));
  assert.equal(same.h.computedAt, '2026-01-01T00:00:00.000Z', 'unchanged values keep the stamp');
  st.items[0].status = 'approved';
  const moved = computeScores(st, new Date('2026-03-03T00:00:00Z'));
  assert.equal(moved.h.projected, 100);
  assert.equal(moved.h.computedAt, '2026-03-03T00:00:00.000Z');
  assert.equal(moved.h.previous, 61.5);
});

test('averageScore is the floored mean of the scores that exist', () => {
  assert.equal(averageScore([79.5, 97.5]), 88.5);
  assert.equal(averageScore([79.6, 98.8, 99.1]), 92.5); // 277.5 / 3 = 92.5
  assert.equal(averageScore([80, null, undefined, 81]), 80.5);
  assert.equal(averageScore([70, 70, 71]), 70.3); // 70.333...
  assert.equal(averageScore([null]), null);
});
