// run.mjs next / status across the life of a run: probe -> claim -> build -> wait-for-decisions
// -> apply -> build -> close.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, item } from './run-helpers.mjs';

const UNITS = ['review:security', 'review:instructions', 'review:gates', 'review:skills-tools', 'review:cleanup-deps'];

test('next walks the lifecycle of a guided run', (t) => {
  const sb = sandbox(t, { accounts: 1, projects: ['acme-shop'] });
  sb.init();
  const next = () => sb.run(['next']).json;

  let n = next();
  assert.equal(n.suggestion, 'probe');
  assert.deepEqual(n.pendingUnits, UNITS);
  assert.equal(n.boardStale, true);
  assert.equal(sb.run(['probe']).code, 0);

  n = next();
  assert.equal(n.suggestion, 'claim');
  assert.match(n.reason, /5 unit\(s\) free to claim/);

  // Four units are completed; the fifth is held by another session.
  sb.complete('review:security', { rounds: [{ harness: 'acme-shop', round: 1, status: 'done' }, { harness: 'claude-1', round: 1, status: 'done' }], items: [item('ACME-101', 'acme-shop', 1), item('ACME-102', 'acme-shop', 1, { class: 'permission' }), item('U1-101', 'claude-1', 1)] });
  for (const u of UNITS.slice(1, 4)) assert.equal(sb.complete(u, { items: [] }).code, 0);
  sb.run(['claim', '--unit', 'review:cleanup-deps', '--session', 'slow-reviewer']);
  n = next();
  assert.deepEqual(n.pendingUnits, []);
  assert.deepEqual(n.claimedUnits.map((c) => [c.unit, c.session]), [['review:cleanup-deps', 'slow-reviewer']]);
  assert.equal(typeof n.claimedUnits[0].ageMinutes, 'number');
  assert.equal(n.suggestion, 'build', 'a partial board is worth building while the last reviewer works');
  assert.equal(n.undecided, 3);

  assert.equal(sb.run(['build']).code, 0);
  n = next();
  assert.equal(n.boardStale, false);
  assert.equal(n.suggestion, 'wait-for-decisions');
  assert.match(n.reason, /3 item\(s\) wait for the user's decision/);

  // The last reviewer finishes: the board is behind again.
  assert.equal(sb.complete('review:cleanup-deps', { items: [item('ACME-501', 'acme-shop', 5)] }, 'slow-reviewer').code, 0);
  n = next();
  assert.equal(n.suggestion, 'build');
  assert.match(n.reason, /changed since the board was built/);
  sb.run(['build']);
  assert.equal(next().suggestion, 'wait-for-decisions');

  // Decisions arrive from the board: first they must be taken in.
  fs.appendFileSync(sb.file('decisions.jsonl'), `${JSON.stringify({ id: 'b-1', at: '2020-01-01T00:00:00.000Z', runId: sb.runId, target: 'ACME-101', action: 'approve', via: 'board' })}\n`);
  n = next();
  assert.equal(n.inbox, 1);
  assert.equal(n.suggestion, 'wait-for-decisions');
  assert.match(n.reason, /1 decision\(s\) from the board not taken in yet: run\.mjs decisions/);
  sb.run(['decisions']);
  sb.run(['decide', '--target', 'ACME-102', '--action', 'ask', '--note', 'Why?']);
  sb.run(['decide', '--target', 'U1-101', '--action', 'decline']);
  sb.run(['decide', '--target', 'ACME-501', '--action', 'approve']);

  n = next();
  assert.equal(n.suggestion, 'apply');
  assert.deepEqual(n.approvedWaiting, { 'acme-shop': ['ACME-101', 'ACME-501'] });
  assert.deepEqual(n.pendingUnits, ['apply:acme-shop']);
  assert.deepEqual(n.questions.map((q) => [q.target, q.question]), [['ACME-102', 'Why?']]);
  assert.equal(n.undecided, 1);

  // An executor works through the harness.
  sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress']);
  n = next();
  assert.equal(n.inProgress, 1);
  assert.deepEqual(n.pendingUnits, [], 'the harness is busy: nobody else may start on it');
  assert.equal(n.suggestion, 'build', 'the board shows the item in progress');
  sb.run(['build']);
  assert.equal(next().suggestion, 'wait-for-decisions', 'a question is still open');
  sb.run(['decide', '--target', 'ACME-102', '--answered']);
  sb.run(['decide', '--target', 'ACME-102', '--action', 'defer']);
  sb.run(['build']);
  n = next();
  assert.equal(n.suggestion, 'apply');
  assert.match(n.reason, /being applied/);

  sb.run(['mark', '--item', 'ACME-101', '--status', 'fixed', '--verified', 'read back']);
  assert.equal(next().suggestion, 'apply', 'ACME-501 is still approved and the harness is free again');
  sb.run(['mark', '--item', 'ACME-501', '--status', 'in-progress']);
  sb.run(['mark', '--item', 'ACME-501', '--status', 'failed', '--not-verified', 'check failed']);
  n = next();
  assert.equal(n.suggestion, 'build');
  assert.deepEqual(n.failed, ['ACME-501']);
  sb.run(['build']);
  n = next();
  assert.equal(n.suggestion, 'close');
  assert.deepEqual(n.approvedWaiting, {});
  assert.equal(n.undecided, 0);

  assert.equal(sb.run(['close']).code, 0);
  n = next();
  assert.equal(n.closed, true);
  assert.equal(n.suggestion, 'close');
  assert.match(n.reason, /closed/);
});

test('next in doctor mode proposes the safe items once every review is in', (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop'] });
  sb.init(['--mode', 'doctor']);
  sb.run(['probe']);
  sb.complete('review:security', { items: [item('ACME-101', 'acme-shop', 1, { class: 'additive' }), item('ACME-102', 'acme-shop', 1, { class: 'delete' })] });
  assert.deepEqual(sb.run(['next']).json.autoApplicable, {}, 'reviewers may still be reading the files');
  for (const u of UNITS.slice(1)) sb.complete(u, { items: [] });
  let n = sb.run(['next']).json;
  assert.deepEqual(n.autoApplicable, { 'acme-shop': ['ACME-101'] });
  assert.equal(n.suggestion, 'apply');
  assert.match(n.reason, /mark --auto/);
  sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress', '--auto']);
  sb.run(['mark', '--item', 'ACME-101', '--status', 'fixed', '--verified', 'ok']);
  n = sb.run(['next']).json;
  assert.deepEqual(n.autoApplicable, {});
  assert.equal(n.suggestion, 'build');
  sb.run(['build']);
  n = sb.run(['next']).json;
  assert.equal(n.suggestion, 'wait-for-decisions', 'the delete still needs the user');
  assert.equal(n.undecided, 1);
});

test('next reports items stuck in progress; a stale apply claim can be taken over', (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop'] });
  sb.init();
  sb.run(['probe']);
  sb.complete('review:security', { items: [item('ACME-101', 'acme-shop', 1), item('ACME-102', 'acme-shop', 1)] });
  for (const u of UNITS.slice(1)) sb.complete(u, { items: [] });
  sb.run(['decide', '--target', 'ACME-101', '--action', 'approve']);
  sb.run(['decide', '--target', 'ACME-102', '--action', 'approve']);
  sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress']);
  // The executor vanished two hours ago.
  const status = sb.read('status.json');
  status.items['ACME-101'].updatedAt = new Date(Date.now() - 2 * 3600000).toISOString();
  fs.writeFileSync(sb.file('status.json'), JSON.stringify(status));
  const n = sb.run(['next']).json;
  assert.deepEqual(n.stuck, ['ACME-101']);
  assert.deepEqual(n.pendingUnits, ['apply:acme-shop'], 'the harness is free again for the approved item that is left');
  assert.equal(n.suggestion, 'apply');
  assert.equal(sb.run(['claim', '--session', 'exec-2']).json.unit, 'apply:acme-shop');
});

test('status counts items by status, rounds done, probes and units', (t) => {
  const sb = sandbox(t);
  sb.init(['--title', 'Ana']);
  sb.run(['probe'], { STUB_FAIL: 'probe-clis' });
  sb.complete('review:security', {
    rounds: [{ harness: 'acme-shop', round: 1, status: 'done' }, { harness: 'novarc-powers', round: 1, status: 'skipped' }],
    items: [item('ACME-101', 'acme-shop', 1), item('ACME-102', 'acme-shop', 1), item('ACME-103', 'acme-shop', 1, { status: 'ok' }), item('NP-101', 'novarc-powers', 1)],
  }, 'rev-1');
  sb.run(['decide', '--target', 'ACME-101', '--action', 'approve']);
  sb.run(['claim', '--unit', 'review:gates', '--session', 'rev-2']);
  const s = sb.run(['status']).json;
  assert.equal(s.runId, sb.runId);
  assert.equal(s.title, 'Ana');
  assert.equal(s.mode, 'guided');
  assert.equal(s.closed, false);
  assert.equal(s.dir, sb.dir);
  const acme = s.harnesses.find((h) => h.id === 'acme-shop');
  assert.deepEqual(acme.items, { approved: 1, open: 1, ok: 1 });
  assert.equal(acme.itemsTotal, 3);
  assert.deepEqual([acme.roundsDone, acme.roundsTotal], [1, 8]);
  assert.deepEqual(acme.probes, { ok: 5, failed: ['clis'] });
  const np = s.harnesses.find((h) => h.id === 'novarc-powers');
  assert.deepEqual([np.roundsDone, np.roundsTotal, np.items.open], [0, 8, 1]);
  assert.equal(s.harnesses.find((h) => h.id === 'claude-1').roundsTotal, 7, 'round 3 does not count for a user harness');
  const unit = (id) => s.units.find((u) => u.id === id);
  assert.deepEqual({ status: unit('review:security').status, by: unit('review:security').completedBy }, { status: 'done', by: 'rev-1' });
  assert.deepEqual({ status: unit('review:gates').status, session: unit('review:gates').session }, { status: 'claimed', session: 'rev-2' });
  assert.equal(unit('review:instructions').status, 'pending');
  assert.equal(unit('apply:acme-shop').approved, 1);
  assert.equal(s.decisions, 1);
  assert.match(s.lastDecisionAt, /^\d{4}-/);
  assert.equal(s.inbox, 0);

  // Without --run the latest run is used; a second run does not disturb the first.
  const firstRun = sb.runId;
  sb.init();
  assert.equal(sb.run(['status']).json.runId, sb.runId);
  assert.notEqual(sb.runId, firstRun);
  assert.equal(sb.run(['status', '--run', firstRun]).json.decisions, 1);
  assert.equal(sb.run(['status']).json.decisions, 0);
  assert.ok(fs.existsSync(path.join(sb.home, '.novarc-powers', 'novarc-harness-doctor', 'runs', firstRun, 'findings', 'review.security.json')));
});
