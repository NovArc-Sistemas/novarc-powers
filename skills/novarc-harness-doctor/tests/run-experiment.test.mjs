// Experiments (references/follow-up.md, "Experiments"): while the last review of a harness applied
// changes, or was marked as an experiment with `close --experiment`, and its follow-up date has not
// come, a new run says so, the briefs tell reviewers to hold back changes to what loads at the
// start of every session, a held finding is not decided now, and approving one needs
// --override-experiment. `experiment end` ends one early without touching a record.
// Real run.mjs processes over a temporary home, with the clock set by NOVARC_HD_NOW.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, item, clock, historyOf, firstReview, FIRST } from './run-helpers.mjs';

const NOTE = 'rtk no lugar da saída crua do shell';
const UNTIL = '2026-02-09T12:00:00.000Z';
const APPLIED = '2026-01-10T11:31:00.000Z';
const TEN_DAYS = '2026-01-20T12:00:00.000Z';
const ONE_MONTH = '2026-02-10T12:00:00.000Z';
const RULE = `An experiment is open on acme-shop until 2026-02-09 ("${NOTE}"). Do not propose changes to what loads at the start of every session (instruction files and their imports, skill and agent descriptions, MCP servers, plugins, SessionStart hooks, output styles) in acme-shop until 2026-02-09, because they would confound the measurement. A finding about one of those may still be recorded: status open and "heldForExperiment": true. It waits until the experiment ends and is not listed with what the user decides now.`;

const one = (t) => sandbox(t, { accounts: 0, projects: ['acme-shop'] });
const ok = (r, what) => { assert.equal(r.code, 0, `${what}: ${r.stdout}${r.stderr}`); return r.json; };

/** `init --follow-up <of>` at `at`; the run becomes the sandbox's current run. */
function followUp(sb, at, of = 'latest', args = []) {
  const json = ok(sb.run(['init', '--follow-up', of, ...args], clock(at)), 'init --follow-up');
  sb.runId = json.runId;
  sb.dir = json.dir;
  return json;
}

test('close --experiment: the records say what is tested and until when, and a later decision keeps it', (t) => {
  const sb = one(t);
  const first = firstReview(sb, { close: false });
  const closed = ok(sb.run(['close', '--experiment', `  ${NOTE}  `], clock(FIRST.closed)), 'close --experiment');
  assert.deepEqual(closed.experiment, { note: NOTE, until: UNTIL });
  const hist = historyOf(sb);
  let record = hist.record(first.key, first.runId);
  assert.deepEqual(record.experiment, { note: NOTE, until: UNTIL });
  assert.equal(record.followUpAfter, UNTIL);
  assert.ok(hist.md(first.key, first.runId).includes(`- Experiment: ${NOTE}. It runs until 2026-02-09.`));
  assert.deepEqual(sb.read('run.json').experiment, { note: NOTE, days: 30 });

  // A decision taken after the close writes the records again; the experiment stays.
  ok(sb.run(['decide', '--target', 'ACME-104', '--action', 'defer'], clock('2026-01-11T09:00:00.000Z')), 'decide');
  record = hist.record(first.key, first.runId);
  assert.equal(record.items.find((i) => i.id === 'ACME-104').status, 'deferred');
  assert.deepEqual(record.experiment, { note: NOTE, until: UNTIL });

  // history lists it with its end date, while it is open.
  const h = ok(sb.run(['history', '--json'], clock('2026-01-15T12:00:00.000Z')), 'history');
  assert.deepEqual(h.experiments, [{ harness: first.key, name: 'acme-shop', note: NOTE, since: APPLIED, until: UNTIL, runId: first.runId }]);
  assert.deepEqual(h.harnesses[0].experiment, { note: NOTE, since: APPLIED, until: UNTIL, runId: first.runId });
  const text = sb.run(['history'], clock('2026-01-15T12:00:00.000Z')).stdout;
  assert.ok(text.includes(`  Experiment in progress until 2026-02-09: ${NOTE}.`), text);

  // The flags are checked.
  for (const [args, error] of [
    [['close', '--follow-up-days', '10'], '--follow-up-days goes with --experiment "<what you are testing>"'],
    [['close', '--experiment', 'x', '--follow-up-days', '0'], '--follow-up-days must be a whole number from 1 to 365'],
    [['close', '--experiment', 'x'.repeat(301)], '--experiment takes at most 300 characters'],
    [['close', '--experiment', `token ${'ghp_' + 'Q'.repeat(36)}`], '--experiment must not hold a credential: say what you are testing in words'],
  ]) {
    const r = sb.run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.json.error, error);
  }
});

test('10 days later: init and every brief carry the experiment, a held finding waits, and approving it needs the override', (t) => {
  const sb = one(t);
  const first = firstReview(sb, { close: false });
  ok(sb.run(['close', '--experiment', NOTE], clock(FIRST.closed)), 'close --experiment');

  const started = followUp(sb, TEN_DAYS);
  const experiment = { note: NOTE, since: APPLIED, until: UNTIL, runId: first.runId };
  assert.deepEqual(started.harnesses[0].experiment, experiment);
  assert.deepEqual(sb.read('run.json').harnesses[0].experiment, experiment);

  // Every review brief: the experiment on the harness, and the instruction line.
  for (const unit of ['review:security', 'review:instructions', 'review:gates', 'review:skills-tools', 'review:cleanup-deps']) {
    const brief = ok(sb.run(['claim', '--unit', unit, '--session', `s-${unit.slice(7)}`]), `claim ${unit}`);
    assert.deepEqual(brief.harnesses[0].experiment, experiment, unit);
    assert.deepEqual(brief.experimentRules, [RULE], unit);
  }

  // Only an open finding can wait.
  const refused = sb.complete('review:security', { rounds: [{ harness: 'acme-shop', round: 1, status: 'done' }], items: [item('ACME-101', 'acme-shop', 1, { status: 'ok', heldForExperiment: true })] }, 's-security');
  assert.equal(refused.code, 1);
  assert.deepEqual(refused.json.errors, ['/items/0/heldForExperiment: only an open finding can wait for an experiment']);

  const done = ok(sb.complete('review:security', {
    rounds: [{ harness: 'acme-shop', round: 1, status: 'done' }],
    items: [
      item('ACME-101', 'acme-shop', 1, { heldForExperiment: true, title: 'A long block in CLAUDE.md loads in every session' }),
      item('ACME-102', 'acme-shop', 1, { file: './settings.json', changes: undefined }),
    ],
  }, 's-security'), 'complete');
  assert.deepEqual(done.warnings, []);

  ok(sb.run(['build', '--no-render']), 'build');
  const state = sb.read('state.json');
  assert.deepEqual(state.harnesses[0].experiment, experiment);
  assert.deepEqual(state.items.map((i) => [i.id, i.status, i.heldForExperiment ?? null]), [['ACME-101', 'open', true], ['ACME-102', 'open', null]]);

  const next = ok(sb.run(['next']), 'next');
  assert.equal(next.undecided, 1);
  assert.deepEqual(next.heldForExperiment, ['ACME-101']);
  assert.deepEqual(next.experiments, { 'acme-shop': experiment });

  // Approving the held finding is refused, and nothing is recorded.
  const refusedApproval = sb.run(['decide', '--target', 'ACME-101', '--action', 'approve']);
  assert.equal(refusedApproval.code, 1);
  assert.equal(refusedApproval.json.error, 'ACME-101 is held for the experiment open on acme-shop until 2026-02-09: approving it now changes what loads at the start of every session and would confound the measurement. Nothing was recorded. If the user still wants it now, decide again with --override-experiment');
  assert.deepEqual(refusedApproval.json.heldForExperiment, [{ item: 'ACME-101', harness: 'acme-shop', until: UNTIL, note: NOTE }]);
  assert.equal(sb.read('status.json').items['ACME-101'], undefined);
  assert.equal(sb.exists('decisions.jsonl'), false);
  // Another finding is approved as usual.
  ok(sb.run(['decide', '--target', 'ACME-102', '--action', 'approve']), 'approve ACME-102');

  const overridden = ok(sb.run(['decide', '--target', 'ACME-101', '--action', 'approve', '--override-experiment']), 'approve with override');
  assert.deepEqual(overridden.experimentOverridden, [{ item: 'ACME-101', harness: 'acme-shop', until: UNTIL }]);
  assert.deepEqual(overridden.warnings, ['ACME-101 was approved while the experiment on acme-shop is open (until 2026-02-09): the next measurement will mix the two effects']);
  assert.deepEqual(overridden.approvedByHarness, { 'acme-shop': ['ACME-101'] });
  assert.equal(sb.run(['decide', '--target', 'ACME-101', '--action', 'approve', '--override-experiment', 'yes']).code, 2);
});

test('31 days later the experiment is over; without --experiment, applied changes are the experiment', (t) => {
  const sb = one(t);
  const first = firstReview(sb); // closed without --experiment: it applied ACME-101
  const soon = followUp(sb, TEN_DAYS);
  assert.deepEqual(soon.harnesses[0].experiment, { since: APPLIED, until: UNTIL, runId: first.runId });
  const text = sb.run(['history'], clock(TEN_DAYS)).stdout;
  assert.ok(text.includes('  Experiment in progress until 2026-02-09: the changes applied on 2026-01-10.'), text);

  const later = followUp(sb, ONE_MONTH, first.runId);
  assert.equal(later.harnesses[0].experiment, undefined);
  assert.equal(sb.read('run.json').harnesses[0].experiment, undefined);
  ok(sb.run(['build', '--no-render']), 'build');
  assert.equal(sb.read('state.json').harnesses[0].experiment, undefined);
  const brief = ok(sb.run(['claim', '--session', 'late']), 'claim');
  assert.equal(brief.harnesses[0].experiment, undefined);
  assert.equal(brief.experimentRules, undefined);
  assert.deepEqual(ok(sb.run(['history', '--json'], clock(ONE_MONTH)), 'history').experiments, []);
});

test('experiment end: ends it early with a marker beside the record, which stays as it was', (t) => {
  const sb = one(t);
  const first = firstReview(sb, { close: false });
  ok(sb.run(['close', '--experiment', NOTE, '--follow-up-days', '45'], clock(FIRST.closed)), 'close');
  const hist = historyOf(sb);
  const recordFile = path.join(hist.dir, first.key, `${first.runId}.json`);
  const before = fs.readFileSync(recordFile, 'utf8');
  assert.equal(JSON.parse(before).followUpAfter, '2026-02-24T12:00:00.000Z');

  const ended = ok(sb.run(['experiment', 'end', '--harness', path.join(sb.home, 'dev', 'acme-shop')], clock('2026-01-13T12:00:00.000Z')), 'experiment end');
  assert.deepEqual(ended, {
    harnessKey: first.key, name: 'acme-shop', path: '~/dev/acme-shop', runId: first.runId,
    until: '2026-02-24T12:00:00.000Z', note: NOTE, ended: true, endedAt: '2026-01-13T12:00:00.000Z',
  });
  assert.equal(fs.readFileSync(recordFile, 'utf8'), before, 'the record is not touched');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hist.dir, first.key, 'ended', `${first.runId}.json`), 'utf8')),
    { schema: 1, harnessKey: first.key, runId: first.runId, endedAt: '2026-01-13T12:00:00.000Z' });

  // Every reader respects it, and nothing reads the marker as a record.
  const h = ok(sb.run(['history', '--json'], clock('2026-01-14T12:00:00.000Z')), 'history');
  assert.deepEqual(h.experiments, []);
  assert.equal(h.ignored, undefined);
  assert.deepEqual(hist.files(first.key), [`${first.runId}.json`, `${first.runId}.md`, 'ended']);
  assert.equal(followUp(sb, '2026-01-14T12:00:00.000Z').harnesses[0].experiment, undefined);

  // Again: already ended, nothing changes. By key as by path.
  const again = ok(sb.run(['experiment', 'end', '--harness', first.key], clock('2026-01-15T12:00:00.000Z')), 'again');
  assert.equal(again.already, true);
  assert.equal(again.endedAt, '2026-01-13T12:00:00.000Z');

  // No open experiment, no such harness, a bad command line.
  const late = sb.run(['experiment', 'end', '--harness', first.key], clock('2026-03-01T12:00:00.000Z'));
  assert.equal(late.code, 1);
  assert.equal(late.json.error, `no experiment is open on ${first.key}`);
  const unknown = sb.run(['experiment', 'end', '--harness', 'nothing-0000aaaa']);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.json.error, 'no review record names that harness: run.mjs history lists the harnesses that have one');
  for (const args of [['experiment'], ['experiment', 'start', '--harness', first.key], ['experiment', 'end', 'now', '--harness', first.key]]) assert.equal(sb.run(args).code, 2, args.join(' '));
  assert.equal(sb.run(['experiment', 'end']).json.error, 'experiment end needs --harness <key|path> (run.mjs history lists the harnesses)');
});

test('a measure-only baseline marked as an experiment opens one; the next run, without --mode, reviews', (t) => {
  const sb = one(t);
  const file = path.join(sb.home, 'selection.json');
  fs.writeFileSync(file, JSON.stringify(sb.selection));
  const init = ok(sb.run(['init', '--select', file, '--mode', 'measure'], clock('2026-01-10T10:00:00.000Z')), 'init');
  sb.runId = init.runId;
  sb.dir = init.dir;
  const closed = ok(sb.run(['close', '--experiment', 'sem o servidor MCP do GitHub', '--follow-up-days', '14'], clock(FIRST.closed)), 'close');
  assert.deepEqual(closed.experiment, { note: 'sem o servidor MCP do GitHub', until: '2026-01-24T12:00:00.000Z' });
  const record = historyOf(sb).record(init.harnesses[0].harnessKey, init.runId);
  assert.equal(record.mode, 'measure');
  assert.deepEqual(record.items, []);
  const next = followUp(sb, TEN_DAYS, init.runId);
  assert.equal(next.mode, 'guided');
  assert.deepEqual(next.harnesses[0].experiment, { note: 'sem o servidor MCP do GitHub', since: FIRST.closed, until: '2026-01-24T12:00:00.000Z', runId: init.runId });
});
