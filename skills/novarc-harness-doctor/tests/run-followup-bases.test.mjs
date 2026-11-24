// A follow-up compares like with like (references/follow-up.md, "Comparable metrics"). The share
// of waste can be told on raw tokens or in input-token equivalents, and the two are different
// quantities: the same usage is 5% on one and 20% on the other. A record keeps both with the base
// of each; the comparison is weighted with weighted when both reviews have it on the same price
// weights, else raw with raw, and says "not measured" when no common base exists. The numbers in
// input-token equivalents are not compared across a change of the price weights.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, clock, historyOf, measured, writeImpact, firstReview, FIRST } from './run-helpers.mjs';
import { metricsOf, wasteShareOf, weightsOf, weightsChanged, followUpFor, validateRecord } from '../scripts/lib/run/followup.mjs';
import { loadStateSchema, validate } from '../scripts/lib/run/schema.mjs';

const SECOND = '2026-02-10T12:00:00.000Z';
/** 20 sessions, 2,000,000 tokens of which 100,000 were retries: 5% on raw tokens. */
const RAW = { sessions: 20, windowDays: 30, totalTokens: 2000000, waste: [{ kind: 'retry', tokens: 100000 }] };
/** The same usage, weighted: 400,000 equivalents of which 80,000 were retries: 20%. */
const WEIGHTED = { ...RAW, weightedTotal: 400000, waste: [{ kind: 'retry', tokens: 100000, weighted: 80000 }] };
const family = (output) => ({ turns: 10, tokens: 1000, weighted: 500, ratios: { input: 1, cacheRead: 0.1, output }, source: 'https://example.com/pricing', verifiedAt: '2026-01-01' });
const weights = (perModelFamily, source = 'references/catalog/pricing-weights.json') => ({ unit: 'input-token equivalents', source, verifiedAt: '2026-01-01', sources: ['https://example.com/pricing'], perModelFamily });

const h = { id: 'x', kind: 'project', path: '~/dev/x', pathAbs: path.join('nowhere', 'x') };
/**
 * The follow-up of a record whose measurement was `then`, measured `now` 31 days later:
 * `[before, after, changePct, verdict]` of a row, then its `base` and `reason` when it has either.
 */
function compare(thenMeasure, now) {
  const record = { runId: '20260110-then', reviewedAt: '2026-01-10T12:00:00.000Z', changesAppliedAt: null, scores: {}, items: [], measure: thenMeasure };
  const f = followUpFor({ record, run: { createdAt: SECOND }, h, hs: { impact: { ...now, sessions: 25, to: SECOND } }, raw: {}, items: [], scoreNow: null });
  const { schema } = loadStateSchema();
  assert.deepEqual(validate(f, schema.$defs.followUp, schema), [], 'the comparison fits `$defs.followUp` of the state schema');
  return (metric) => {
    const row = f.metrics.find((m) => m.metric === metric);
    return [row.before, row.after, row.changePct, row.verdict, ...(row.base || row.reason ? [row.base, row.reason] : [])];
  };
}
/** Start the follow-up of the latest run 31 days after the first review; it becomes the sandbox's current run. */
function follow(sb) {
  const started = sb.run(['init', '--follow-up', 'latest'], clock(SECOND));
  assert.equal(started.code, 0, started.stdout + started.stderr);
  sb.runId = started.json.runId;
  sb.dir = started.json.dir;
}
/** What a record keeps of a measurement. */
const kept = (impact) => ({ sessions: impact.sessions, metrics: metricsOf(impact, {}), ...(wasteShareOf(impact) ? { wasteShare: wasteShareOf(impact) } : {}), ...(weightsOf(impact) ? { weights: weightsOf(impact) } : {}) });

test('the share of waste on each base, and which one a measurement shows', () => {
  assert.deepEqual(wasteShareOf(RAW), { base: 'raw', raw: 5 });
  assert.deepEqual(wasteShareOf(WEIGHTED), { base: 'weighted', weighted: 20, raw: 5 });
  assert.deepEqual([metricsOf(RAW, {})['waste-share'], metricsOf(WEIGHTED, {})['waste-share']], [5, 20], '`waste-share` stays one number: the weighted one when it is known');
  // One kind of waste without its weighted figure: the weighted share cannot be told.
  assert.deepEqual(wasteShareOf({ ...WEIGHTED, waste: [...WEIGHTED.waste, { kind: 'loop', tokens: 100000 }] }), { base: 'raw', raw: 10 });
  assert.equal(wasteShareOf({ sessions: 20 }), null, 'waste was not measured');
  assert.equal(wasteShareOf({ sessions: 20, totalTokens: 0, waste: [] }), null);

  const opus = weightsOf({ ...WEIGHTED, weights: weights({ 'claude-opus': family(5), 'claude-haiku': family(4) }) });
  assert.deepEqual({ source: opus.source, verifiedAt: opus.verifiedAt, ids: opus.families.map((f) => f.id) }, { source: 'references/catalog/pricing-weights.json', verifiedAt: '2026-01-01', ids: ['claude-haiku', 'claude-opus'] });
  assert.ok(opus.families.every((f) => /^[0-9a-f]{12}$/.test(f.hash)));
  assert.equal(weightsOf(RAW), null, 'nothing was weighted');
  assert.equal(weightsOf({ ...RAW, weights: weights({ 'claude-opus': family(5) }) }), null);

  const same = weightsOf({ ...WEIGHTED, weights: weights({ 'claude-opus': family(5) }) });
  assert.equal(weightsChanged(opus, same), false, 'another mix of models on the same prices');
  assert.equal(weightsChanged(opus, weightsOf({ ...WEIGHTED, weights: weights({ 'claude-opus': family(6) }) })), true, 'another ratio for a model both used');
  assert.equal(weightsChanged(opus, weightsOf({ ...WEIGHTED, weights: weights({ 'claude-opus': family(5) }, 'my-weights.json') })), true, 'another weights file');
  assert.equal(weightsChanged(opus, weightsOf({ ...WEIGHTED, weights: weights({ 'gpt-5': family(8) }) })), false, 'no model in common: nothing says the prices changed');
  assert.equal(weightsChanged(undefined, opus), false, 'a record that does not say is not known to differ');
});

test('raw then, weighted now: the same usage is "no change", not 5% against 20%', () => {
  const row = compare(kept(RAW), WEIGHTED);
  assert.deepEqual(row('waste-share'), [5, 5, 0, 'no-change', 'raw', undefined], 'raw with raw');
  // And the other way round.
  assert.deepEqual(compare(kept(WEIGHTED), RAW)('waste-share'), [5, 5, 0, 'no-change', 'raw', undefined]);
  // Both weighted, on the same price weights: weighted with weighted.
  const w = weights({ 'claude-opus': family(5) });
  assert.deepEqual(compare(kept({ ...WEIGHTED, weights: w }), { ...WEIGHTED, weights: w })('waste-share'), [20, 20, 0, 'no-change', 'weighted', undefined]);
  const better = { ...WEIGHTED, weights: w, waste: [{ kind: 'retry', tokens: 100000, weighted: 40000 }] };
  assert.deepEqual(compare(kept({ ...WEIGHTED, weights: w }), better)('waste-share'), [20, 10, -50, 'improved', 'weighted', undefined]);
  // Only the share has a base to name: every other row is one quantity.
  assert.deepEqual(compare(kept(RAW), WEIGHTED)('tokens-per-session'), [100000, 80000, -20, 'improved']);
});

test('the price weights changed between the two reviews: weighted numbers are not compared', () => {
  const then = kept({ ...WEIGHTED, weights: weights({ 'claude-opus': family(5) }) });
  // The same raw usage under dearer output: more equivalents, and nothing in the harness changed.
  const now = { ...WEIGHTED, weightedTotal: 480000, waste: [{ kind: 'retry', tokens: 100000, weighted: 120000 }], weights: weights({ 'claude-opus': family(6) }) };
  const row = compare(then, now);
  assert.deepEqual(row('weighted-per-session'), [null, 19200, null, 'not-measured', undefined, 'weights-changed'], 'today\'s number, and no earlier one to read a change from');
  assert.deepEqual(row('waste-share'), [5, 5, 0, 'no-change', 'raw', undefined], 'the share falls back to raw tokens, which no price touches');
  assert.deepEqual(row('tokens-per-session'), [100000, 80000, -20, 'improved'], 'raw numbers are compared as always');
  // Without the change of weights the same two measurements would have been compared.
  const sameWeights = { ...now, weights: weights({ 'claude-opus': family(5) }) };
  assert.deepEqual(compare(then, sameWeights)('weighted-per-session'), [20000, 19200, -4, 'no-change']);
});

test('a record written before the base was kept: compared only where its base is certain', () => {
  // No weighted total in that record: its share can only have been on raw tokens.
  const legacyRaw = { sessions: 20, metrics: { 'tokens-per-session': 100000, 'waste-share': 5, 'waste:retry': 5000 } };
  assert.deepEqual(compare(legacyRaw, WEIGHTED)('waste-share'), [5, 5, 0, 'no-change', 'raw', undefined]);
  // With one, it may have been either: no common base, so no verdict and no change to misread.
  const legacyEither = { sessions: 20, metrics: { 'tokens-per-session': 100000, 'weighted-per-session': 20000, 'waste-share': 5, 'waste:retry': 5000 } };
  const row = compare(legacyEither, WEIGHTED);
  assert.deepEqual(row('waste-share'), [null, 20, null, 'not-measured', 'weighted', 'no-common-base'], 'today\'s share, on today\'s base, and nothing to compare it with');
  assert.deepEqual(row('weighted-per-session'), [20000, 16000, -20, 'improved'], 'nothing says its weights were other ones');
});


test('through a real follow-up: the record holds both shares, and the state says which base a share was compared on', (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop'] });
  const first = firstReview(sb);
  const history = historyOf(sb);
  // The first review was weighted: 5% on both bases (see `measured`).
  assert.deepEqual(history.record(first.key, first.runId).measure.wasteShare, { base: 'weighted', weighted: 5, raw: 5 });

  follow(sb);
  // The same usage per session, measured without price weights this time: only the raw share exists now.
  const { weightedTotal: _w, ...unweighted } = measured({ from: '2026-01-11T12:00:00.000Z', to: SECOND, sessions: 25, totalTokens: 2500000, waste: [{ kind: 'retry', episodes: 5, sessions: 4, tokens: 125000, basis: 'measured' }] });
  writeImpact(sb, 'acme-shop', unweighted);
  const rows = () => {
    const built = sb.run(['build', '--no-render']);
    assert.equal(built.code, 0, built.stdout + built.stderr);
    const { metrics } = sb.read('state.json').harnesses[0].followUp;
    return (metric) => metrics.find((m) => m.metric === metric);
  };
  let row = rows();
  assert.deepEqual(row('waste-share'), { metric: 'waste-share', unit: 'percent', before: 5, expected: null, after: 5, changePct: 0, verdict: 'no-change', base: 'raw' }, 'raw with raw: the base both reviews have');
  assert.deepEqual(row('weighted-per-session'), { metric: 'weighted-per-session', unit: 'tokens/session', before: 20000, expected: null, after: null, changePct: null, verdict: 'not-measured' }, 'measured then, not now: a missing side has no reason to give');

  // A record written before the base was kept, with a weighted total: its share may have been on
  // either base, so there is none in common.
  const recordFile = path.join(history.dir, first.key, `${first.runId}.json`);
  const original = fs.readFileSync(recordFile, 'utf8');
  const legacy = JSON.parse(original);
  delete legacy.measure.wasteShare;
  fs.writeFileSync(recordFile, JSON.stringify(legacy));
  row = rows();
  assert.deepEqual(row('waste-share'), { metric: 'waste-share', unit: 'percent', before: null, expected: null, after: 5, changePct: null, verdict: 'not-measured', base: 'raw', reason: 'no-common-base' });
  fs.writeFileSync(recordFile, original);

  assert.equal(sb.run(['close'], clock('2026-02-10T13:00:00.000Z')).code, 0);
  const second = history.record(first.key, sb.runId);
  assert.deepEqual(validateRecord(second), []);
  assert.deepEqual({ share: second.measure.wasteShare, metric: second.measure.metrics['waste-share'], weights: second.measure.weights }, { share: { base: 'raw', raw: 5 }, metric: 5, weights: undefined });
  assert.equal(second.outcome.metrics.find((m) => m.metric === 'waste-share').base, 'raw', 'the comparison is kept in the record as the state had it');
});

test('through a real follow-up, with the price weights changed: the state, the record and its .md say what was not compared, and why', (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop'] });
  const first = firstReview(sb, { close: false });
  // The first review, measured by a probe that names the ratios it applied.
  writeImpact(sb, 'acme-shop', measured({ weights: weights({ 'claude-opus': family(5) }) }));
  assert.equal(sb.run(['close'], clock(FIRST.closed)).code, 0);
  const history = historyOf(sb);
  const then = history.record(first.key, first.runId).measure.weights;
  assert.deepEqual({ source: then.source, verifiedAt: then.verifiedAt, families: then.families.map((f) => f.id) }, { source: 'references/catalog/pricing-weights.json', verifiedAt: '2026-01-01', families: ['claude-opus'] });

  follow(sb);
  // The same raw usage per session. Output got dearer in the price list, so the equivalents grew
  // (24000 per session, from 20000) with nothing changed in the harness.
  writeImpact(sb, 'acme-shop', measured({
    from: '2026-01-11T12:00:00.000Z', to: SECOND, sessions: 25, activeDays: 15, totalTokens: 2500000, weightedTotal: 600000,
    waste: [{ kind: 'retry', episodes: 5, sessions: 4, tokens: 125000, weighted: 37500, basis: 'measured' }],
    toolOutput: { shellResultChars: 1000000 }, weights: weights({ 'claude-opus': family(6) }),
  }));
  const built = sb.run(['build', '--no-render']);
  assert.equal(built.code, 0, built.stdout + built.stderr);
  const { metrics } = sb.read('state.json').harnesses[0].followUp;
  assert.deepEqual(metrics, [
    { metric: 'tokens-per-session', unit: 'tokens/session', before: 100000, expected: null, after: 100000, changePct: 0, verdict: 'no-change' },
    // Today's number, no earlier one, and the reason: a rise of 20% that no one caused is not shown as one.
    { metric: 'weighted-per-session', unit: 'tokens/session', before: null, expected: null, after: 24000, changePct: null, verdict: 'not-measured', reason: 'weights-changed' },
    { metric: 'context-at-start', unit: 'tokens/session', before: 50000, expected: 40000, after: 50000, changePct: 0, verdict: 'no-change', items: ['ACME-101'] },
    { metric: 'context-peak', unit: 'tokens/session', before: 120000, expected: null, after: 120000, changePct: 0, verdict: 'no-change' },
    // The share falls back to raw tokens, which no price touches: 5% then, 5% now (weighted it would read 5% against 6.3%).
    { metric: 'waste-share', unit: 'percent', before: 5, expected: null, after: 5, changePct: 0, verdict: 'no-change', base: 'raw' },
    { metric: 'waste:retry', unit: 'tokens/session', before: 5000, expected: null, after: 5000, changePct: 0, verdict: 'no-change' },
    { metric: 'tool-output', unit: 'chars/session', before: 40000, expected: null, after: 40000, changePct: 0, verdict: 'no-change' },
  ]);

  assert.equal(sb.run(['close'], clock('2026-02-10T13:00:00.000Z')).code, 0);
  const second = history.record(first.key, sb.runId);
  assert.deepEqual(validateRecord(second), []);
  assert.deepEqual(second.outcome.metrics, metrics);
  assert.deepEqual({ share: second.measure.wasteShare, metric: second.measure.metrics['waste-share'] }, { share: { base: 'weighted', weighted: 6.3, raw: 5 }, metric: 6.3 });
  const md = history.md(first.key, sb.runId).split('\n');
  assert.ok(md.includes('Numbers in input-token equivalents are not compared: the price weights changed between the two reviews.'), md.join('\n'));
  assert.ok(md.some((line) => /^\| Relative cost \(tokens per session\) \| [^|]+ \| - \| 24k \| - \| [^|]+ \|$/.test(line)), md.join('\n'));
  assert.ok(md.includes('| Share of the spend wasted (percent of the spend) | 5% | - | 5% | 0% | no change |'));
});
