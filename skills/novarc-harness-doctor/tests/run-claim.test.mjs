// run.mjs claim / release: the work queue shared by several sessions. The claim is an exclusive
// file create, so these tests race real processes against each other.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, securityFindings, together } from './run-helpers.mjs';
import { SKILL_DIR } from './helpers.mjs';

const REVIEW = ['review:security', 'review:instructions', 'review:gates', 'review:skills-tools', 'review:cleanup-deps'];

test('claim hands out the next unit with its brief; a session resumes the unit it holds', (t) => {
  const sb = sandbox(t);
  sb.init();
  const a = sb.run(['claim', '--session', 'claude-main']);
  assert.equal(a.code, 0, a.stderr);
  const brief = a.json;
  assert.equal(brief.unit, 'review:security');
  assert.equal(brief.session, 'claude-main');
  assert.deepEqual(brief.rounds, [1]);
  assert.deepEqual(brief.roundFiles, ['references/rounds/01-security-permissions.md']);
  for (const f of brief.roundFiles) assert.ok(fs.existsSync(path.join(SKILL_DIR, f)), `${f} exists in the skill`);
  assert.deepEqual(brief.harnesses.map((h) => [h.id, h.key, h.kind]), [['claude-1', 'U1', 'user'], ['codex-1', 'U2', 'user'], ['acme-shop', 'ACME', 'project'], ['novarc-powers', 'NP', 'project']]);
  const acme = brief.harnesses[2];
  assert.equal(acme.path, '~/dev/acme-shop');
  assert.equal(acme.pathAbs, path.join(sb.home, 'dev', 'acme-shop'));
  assert.equal(acme.probesDir, sb.file('probes', 'acme-shop'));
  assert.match(brief.idRule, /<KEY>-<round><nn>/);
  assert.deepEqual(brief.idRanges.find((r) => r.harness === 'acme-shop'), { harness: 'acme-shop', round: 1, first: 'ACME-101', last: 'ACME-199' });
  assert.equal(brief.findingsTemplate.unit, 'review:security');
  assert.equal(brief.findingsTemplate.rounds.length, 4);
  assert.deepEqual(brief.findingsTemplate.items, []);

  const lock = JSON.parse(fs.readFileSync(sb.file('claims', 'review.security.lock'), 'utf8'));
  assert.equal(lock.session, 'claude-main');
  assert.equal(lock.ttlMinutes, 90);
  assert.equal(sb.read('queue.json').units[0].status, 'claimed');
  assert.equal(sb.read('queue.json').units[0].claimedBy, 'claude-main');

  const again = sb.run(['claim', '--session', 'claude-main']);
  assert.equal(again.json.unit, 'review:security');
  assert.equal(again.json.resumed, true);

  const b = sb.run(['claim', '--session', 'codex-2']);
  assert.equal(b.json.unit, 'review:instructions');
  assert.deepEqual(b.json.rounds, [2, 3]);
  // Round 3 is about a repository: no id range and no template row for a user harness.
  assert.ok(!b.json.idRanges.some((r) => r.harness === 'claude-1' && r.round === 3));
  assert.ok(b.json.idRanges.some((r) => r.harness === 'acme-shop' && r.round === 3));
  assert.equal(b.json.findingsTemplate.rounds.filter((r) => r.harness === 'claude-1').length, 1);

  const taken = sb.run(['claim', '--unit', 'review:security', '--session', 'codex-2']);
  assert.equal(taken.code, 1);
  assert.match(taken.json.error, /claimed by claude-main/);
  assert.equal(sb.run(['claim', '--unit', 'review:nope', '--session', 'x']).code, 1);
  assert.equal(sb.run(['claim']).code, 2, '--session is required');
  assert.equal(sb.run(['claim', '--session', 'bad label!']).code, 2);

  const acc = sb.run(['claim', '--unit', 'accounts', '--session', 'owner']);
  assert.equal(acc.json.unit, 'accounts');
  assert.deepEqual(acc.json.harnesses.map((h) => h.id), ['claude-1', 'codex-1']);
  for (const f of acc.json.roundFiles) assert.ok(fs.existsSync(path.join(SKILL_DIR, f)), `${f} exists in the skill`);
  assert.match(acc.json.idRule, /U1-901/);
});

test('8 processes racing for 5 units: no unit is claimed twice', async (t) => {
  const sb = sandbox(t, { accounts: 1 });
  sb.init();
  assert.deepEqual(sb.read('queue.json').units.map((u) => u.id), REVIEW, 'one account: exactly the 5 review units');
  const gate = together();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => sb.runAsync(['claim', '--session', `worker-${i}`], gate)));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const got = results.filter((r) => r.json.unit !== null);
  const none = results.filter((r) => r.json.unit === null);
  assert.equal(got.length, 5, 'every unit found a worker');
  assert.equal(none.length, 3, 'the other three were told there is nothing to claim');
  assert.deepEqual(got.map((r) => r.json.unit).sort(), REVIEW.slice().sort(), 'no unit was handed out twice');
  assert.equal(new Set(got.map((r) => r.json.session)).size, 5);
  for (const r of got) {
    const lock = JSON.parse(fs.readFileSync(sb.file('claims', `${r.json.unit.replace(':', '.')}.lock`), 'utf8'));
    assert.equal(lock.session, r.json.session, 'the lock file names the process that was told it won');
  }
  const queue = sb.read('queue.json');
  assert.ok(queue.units.every((u) => u.status === 'claimed'));
  assert.equal(new Set(queue.units.map((u) => u.claimedBy)).size, 5);
  const next = sb.run(['next']).json;
  assert.deepEqual(next.pendingUnits, []);
  assert.equal(next.claimedUnits.length, 5);
});

test('a stale claim is taken over once; the old holder can no longer complete', async (t) => {
  const sb = sandbox(t);
  sb.init();
  assert.equal(sb.run(['claim', '--unit', 'review:gates', '--session', 'gone']).code, 0);
  const lockFile = sb.file('claims', 'review.gates.lock');
  const fresh = sb.run(['claim', '--unit', 'review:gates', '--session', 'other']);
  assert.equal(fresh.code, 1, 'a live claim is not taken over');

  // Age the claim past its ttl.
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  fs.writeFileSync(lockFile, JSON.stringify({ ...lock, at: new Date(Date.now() - 91 * 60000).toISOString() }));
  const status = sb.run(['status']).json.units.find((u) => u.id === 'review:gates');
  assert.equal(status.stale, true);
  assert.ok(status.ageMinutes >= 90);
  assert.ok(sb.run(['next']).json.pendingUnits.includes('review:gates'), 'a stale claim counts as free');

  // Four processes go for the same stale unit: exactly one gets it.
  const gate = together();
  const race = await Promise.all(Array.from({ length: 4 }, (_, i) => sb.runAsync(['claim', '--unit', 'review:gates', '--session', `taker-${i}`], gate)));
  const winners = race.filter((r) => r.code === 0);
  assert.equal(winners.length, 1, race.map((r) => r.stdout).join('\n'));
  assert.equal(winners[0].json.takenOverFrom, 'gone');
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).session, winners[0].json.session);
  for (const r of race.filter((x) => x.code !== 0)) assert.match(r.json.error, /claimed by taker-/);

  const late = sb.complete('review:gates', { rounds: [], items: [] }, 'gone');
  assert.equal(late.code, 1, 'the session that lost its claim cannot complete the unit');
  assert.match(late.json.error, /claimed by taker-/);
  assert.equal(sb.run(['release', '--unit', 'review:gates', '--session', 'gone']).code, 1);

  // A custom ttl is honoured: a one-minute claim made two minutes ago is free again.
  assert.equal(sb.run(['claim', '--unit', 'review:security', '--session', 'short', '--ttl', '1']).code, 0);
  const shortFile = sb.file('claims', 'review.security.lock');
  const short = JSON.parse(fs.readFileSync(shortFile, 'utf8'));
  assert.equal(short.ttlMinutes, 1);
  fs.writeFileSync(shortFile, JSON.stringify({ ...short, at: new Date(Date.now() - 2 * 60000).toISOString() }));
  const auto = sb.run(['claim', '--session', 'sweeper']);
  assert.equal(auto.json.unit, 'review:security', 'claim without --unit also takes a stale unit, in queue order');
  assert.equal(auto.json.takenOverFrom, 'short');
});

test('release gives a unit back, only to its holder', (t) => {
  const sb = sandbox(t);
  sb.init();
  sb.run(['claim', '--unit', 'review:security', '--session', 'a']);
  const wrong = sb.run(['release', '--unit', 'review:security', '--session', 'b']);
  assert.equal(wrong.code, 1);
  assert.ok(sb.exists('claims', 'review.security.lock'));
  const ok = sb.run(['release', '--unit', 'review:security', '--session', 'a']);
  assert.equal(ok.code, 0);
  assert.equal(ok.json.released, true);
  assert.ok(!sb.exists('claims', 'review.security.lock'));
  assert.equal(sb.read('queue.json').units[0].status, 'pending');
  assert.equal(sb.run(['release', '--unit', 'review:security', '--session', 'a']).json.released, false);
  assert.equal(sb.run(['claim', '--session', 'b']).json.unit, 'review:security', 'the released unit is first in line again');
  assert.equal(sb.run(['release', '--session', 'b']).code, 2, '--unit is required');
});

test('a completed unit is never handed out again; apply units follow approved items', (t) => {
  const sb = sandbox(t, { accounts: 1 });
  sb.init();
  assert.equal(sb.complete('review:security', securityFindings({ rounds: [], elements: {}, items: securityFindings().items.filter((i) => i.harness !== 'codex-1') }), 'r1').code, 0);
  assert.equal(sb.run(['claim', '--unit', 'review:security', '--session', 'r2']).code, 1);
  assert.equal(sb.run(['claim', '--session', 'r2']).json.unit, 'review:instructions');
  assert.ok(!sb.run(['status']).json.units.some((u) => u.id.startsWith('apply:')), 'nothing approved: no apply unit');

  sb.run(['decide', '--target', 'ACME-101', '--action', 'approve']);
  sb.run(['decide', '--target', 'ACME-102', '--action', 'approve']);
  const unit = sb.run(['status']).json.units.find((u) => u.id === 'apply:acme-shop');
  assert.deepEqual({ status: unit.status, approved: unit.approved, inProgress: unit.inProgress }, { status: 'pending', approved: 2, inProgress: 0 });
  const brief = sb.run(['claim', '--unit', 'apply:acme-shop', '--session', 'exec-1']).json;
  assert.deepEqual(brief.items, ['ACME-101', 'ACME-102']);
  assert.equal(brief.findingsTemplate, null);
  assert.equal(sb.run(['claim', '--unit', 'apply:acme-shop', '--session', 'exec-2']).code, 1, 'one writer per harness');

  // While an item is being applied without a claim, nobody else may start on that harness.
  assert.equal(sb.run(['complete', '--unit', 'apply:acme-shop', '--session', 'exec-1']).code, 0);
  sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress']);
  assert.equal(sb.run(['status']).json.units.find((u) => u.id === 'apply:acme-shop').status, 'busy');
  assert.equal(sb.run(['claim', '--unit', 'apply:acme-shop', '--session', 'exec-2']).code, 1);
  sb.run(['mark', '--item', 'ACME-101', '--status', 'failed', '--not-verified', 'check did not pass']);
  assert.equal(sb.run(['status']).json.units.find((u) => u.id === 'apply:acme-shop').status, 'pending', 'ACME-102 is still approved');

  // An executor that never calls complete does not keep the harness: its claim ends with its last item.
  assert.equal(sb.run(['claim', '--unit', 'apply:acme-shop', '--session', 'exec-3']).code, 0);
  sb.run(['mark', '--item', 'ACME-102', '--status', 'in-progress']);
  assert.ok(sb.exists('claims', 'apply.acme-shop.lock'));
  sb.run(['mark', '--item', 'ACME-102', '--status', 'fixed', '--verified', 'read back']);
  assert.ok(!sb.exists('claims', 'apply.acme-shop.lock'), 'nothing approved is left: the apply claim is released');
  assert.ok(!sb.run(['status']).json.units.some((u) => u.id === 'apply:acme-shop'));
});
