// run.mjs complete: a findings file is accepted or rejected as a whole, with JSON pointers.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox, securityFindings, item } from './run-helpers.mjs';

/** Complete review:security with `mutate` applied to a valid file; returns the command result. */
function attempt(sb, mutate, unit = 'review:security') {
  const f = securityFindings();
  mutate(f);
  return sb.complete(unit, f);
}
const hasError = (r, re) => Array.isArray(r.json.errors) && r.json.errors.some((e) => re.test(e));

test('a good findings file is stored, the unit is done, and completing again replaces it', (t) => {
  const sb = sandbox(t);
  sb.init();
  sb.run(['claim', '--unit', 'review:security', '--session', 'rev']);
  const r = sb.complete('review:security', securityFindings(), 'rev');
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.replaced, false);
  assert.equal(r.json.stored, 'findings/review.security.json');
  assert.deepEqual(r.json.counts.byHarness, { 'claude-1': 1, 'acme-shop': 2, 'novarc-powers': 2 });
  assert.equal(r.json.counts.items, 5);
  assert.deepEqual(r.json.warnings, []);

  const stored = sb.read('findings', 'review.security.json');
  assert.equal(stored.unit, 'review:security');
  assert.equal(stored.session, 'rev');
  assert.match(stored.completedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(stored.items.find((i) => i.id === 'ACME-101').status, 'open', 'status defaults to open');
  assert.equal(stored.items.find((i) => i.id === 'NP-102').status, 'ok');
  const unit = sb.read('queue.json').units[0];
  assert.deepEqual({ status: unit.status, by: unit.completedBy }, { status: 'done', by: 'rev' });
  assert.ok(!sb.exists('claims', 'review.security.lock'), 'the claim is gone');

  const again = sb.complete('review:security', securityFindings({ items: [item('ACME-101', 'acme-shop', 1)], inventory: [], groups: [], elements: {} }), 'other-session');
  assert.equal(again.code, 0, again.stdout);
  assert.equal(again.json.replaced, true);
  assert.equal(sb.read('findings', 'review.security.json').items.length, 1);
});

test('ids must be <KEY>-<round><nn> for a harness and round the unit owns', (t) => {
  const sb = sandbox(t);
  sb.init();
  const wrongKey = attempt(sb, (f) => { f.items[1].id = 'SHOP-101'; f.inventory = []; f.groups = []; });
  assert.equal(wrongKey.code, 1);
  assert.equal(wrongKey.json.ok, false);
  assert.ok(hasError(wrongKey, /^\/items\/1\/id: must be ACME-<round><nn>/), JSON.stringify(wrongKey.json.errors));

  const wrongDigit = attempt(sb, (f) => { f.items[2].id = 'ACME-202'; });
  assert.ok(hasError(wrongDigit, /^\/items\/2\/id: the digit after the dash must be the item's round/));

  const wrongRound = attempt(sb, (f) => { f.items[2] = item('ACME-401', 'acme-shop', 4); });
  assert.equal(wrongRound.code, 1);
  assert.ok(hasError(wrongRound, /^\/items\/2\/round: unit review:security does not own this round/), JSON.stringify(wrongRound.json.errors));

  const counter = attempt(sb, (f) => { f.items[2].id = 'ACME-100'; });
  assert.ok(hasError(counter, /counter starts at 01/));
  const short = attempt(sb, (f) => { f.items[2].id = 'ACME-12'; });
  assert.ok(hasError(short, /^\/items\/2\/id:/));
  const dup = attempt(sb, (f) => { f.items[2].id = 'ACME-101'; });
  assert.ok(hasError(dup, /^\/items\/2\/id: duplicate id/));
  const foreign = attempt(sb, (f) => { f.items[2].harness = 'elsewhere'; });
  assert.ok(hasError(foreign, /^\/items\/2\/harness: not a harness of unit/));
  const roundRow = attempt(sb, (f) => { f.rounds.push({ harness: 'acme-shop', round: 2, status: 'done' }); });
  assert.ok(hasError(roundRow, /^\/rounds\/4\/round: unit review:security does not own this round/));

  assert.ok(!sb.exists('findings', 'review.security.json'), 'a rejected file stores nothing');
  assert.equal(sb.read('queue.json').units[0].status, 'pending');
});

test('required fields, reviewer statuses and change paths are enforced', (t) => {
  const sb = sandbox(t);
  sb.init();
  const missing = attempt(sb, (f) => { delete f.items[1].finding; delete f.items[1].severity; });
  assert.ok(hasError(missing, /^\/items\/1: missing required "finding"/));
  assert.ok(hasError(missing, /^\/items\/1: missing required "severity"/));

  const status = attempt(sb, (f) => { f.items[1].status = 'approved'; });
  assert.ok(hasError(status, /^\/items\/1\/status: a reviewer may only set open, ok, not-applicable/));
  const fixed = attempt(sb, (f) => { f.items[1].status = 'fixed'; });
  assert.equal(fixed.code, 1);

  const noPath = attempt(sb, (f) => { delete f.items[1].changes[0].path; });
  assert.ok(hasError(noPath, /^\/items\/1\/changes\/0\/path: every change needs the display path/));
  const badEnum = attempt(sb, (f) => { f.items[1].severity = 'urgent'; });
  assert.ok(hasError(badEnum, /^\/items\/1\/severity: not one of/));
  const unknownField = attempt(sb, (f) => { f.items[1].scope = 'project'; });
  assert.ok(hasError(unknownField, /^\/items\/1: unknown property "scope"/));
  const topLevel = attempt(sb, (f) => { f.notes = 'hello'; });
  assert.ok(hasError(topLevel, /^\/: unknown property "notes"/));

  const group = attempt(sb, (f) => { f.groups[0].items = ['ACME-101']; });
  assert.ok(hasError(group, /^\/groups\/0\/items: /));
  const groupLink = attempt(sb, (f) => { f.groups[0].items = ['ACME-101', 'ACME-199']; });
  assert.ok(hasError(groupLink, /^\/groups\/0\/items\/1: no item with this id/));
  const invLink = attempt(sb, (f) => { f.inventory[0].item = 'ACME-150'; });
  assert.ok(hasError(invLink, /^\/inventory\/0\/item: no item with this id/));
  const element = attempt(sb, (f) => { f.elements['acme-shop'].skills[0] = { verdict: 'retire' }; });
  assert.ok(hasError(element, /^\/elements\/acme-shop\/skills\/0: needs "name"/));
  const verdict = attempt(sb, (f) => { f.elements['acme-shop'].skills[0].verdict = 'burn'; });
  assert.ok(hasError(verdict, /^\/elements\/acme-shop\/skills\/0\/verdict: not one of/));
  const category = attempt(sb, (f) => { f.elements['acme-shop'].gadgets = []; });
  assert.ok(hasError(category, /unknown element category/));

  const round3 = sb.complete('review:instructions', { rounds: [{ harness: 'claude-1', round: 3, status: 'done' }], items: [] });
  assert.ok(hasError(round3, /^\/rounds\/0\/status: this round does not apply to a user harness/));
  const round3item = sb.complete('review:instructions', { items: [item('U1-301', 'claude-1', 3)] });
  assert.ok(hasError(round3item, /^\/items\/0\/round: this round does not apply to a user harness/));
  assert.equal(sb.complete('review:instructions', { rounds: [{ harness: 'claude-1', round: 3, status: 'not-applicable' }], items: [item('ACME-301', 'acme-shop', 3), item('U1-201', 'claude-1', 2)] }).code, 0);
});

test('an absolute home path or an oversized string rejects the file, naming the pointer', (t) => {
  const sb = sandbox(t);
  sb.init();
  const abs = path.join(sb.home, 'dev', 'acme-shop', 'CLAUDE.md');
  const inChange = attempt(sb, (f) => { f.items[1].changes[0].path = abs; });
  assert.equal(inChange.code, 1);
  assert.deepEqual(inChange.json.errors.filter((e) => /absolute home path/.test(e)).map((e) => e.split(':')[0]), ['/items/1/changes/0/path']);
  const output = inChange.stdout + inChange.stderr;
  for (const spelling of [sb.home, sb.home.replace(/\\/g, '\\\\'), sb.home.replace(/\\/g, '/')]) assert.ok(!output.includes(spelling), 'the rejection does not echo the path');

  const forward = attempt(sb, (f) => { f.items[0].evidence = `seen in ${abs.replace(/\\/g, '/')} line 3`; });
  assert.ok(hasError(forward, /^\/items\/0\/evidence: absolute home path/));
  const escaped = attempt(sb, (f) => { f.items[0].changes[0].before = JSON.stringify({ dir: abs }); });
  assert.ok(hasError(escaped, /^\/items\/0\/changes\/0\/before: absolute home path/), 'the JSON-escaped spelling is caught too');
  const deep = attempt(sb, (f) => { f.leads[0].note = `${sb.home}`; });
  assert.ok(hasError(deep, /^\/leads\/0\/note: absolute home path/));
  const role = attempt(sb, (f) => { f.fileRoles['facme-shop-1'] = `Lives in ${abs}`; });
  assert.ok(hasError(role, /^\/fileRoles\/facme-shop-1: absolute home path/));
  // A display path is fine, and so is a sibling folder whose name merely starts like the home.
  const fine = attempt(sb, (f) => { f.items[0].evidence = `~/dev/acme-shop/CLAUDE.md and ${sb.home}-sibling/x`; });
  assert.equal(fine.code, 0, fine.stdout);

  const big = attempt(sb, (f) => { f.items[1].changes[0].after = 'x'.repeat(200 * 1024 + 1); });
  assert.equal(big.code, 1);
  assert.ok(hasError(big, /^\/items\/1\/changes\/0\/after: string longer than 200 KB/));
  const justFits = attempt(sb, (f) => { f.items[1].changes[0].after = 'x'.repeat(200 * 1024); });
  assert.equal(justFits.code, 0, justFits.stdout);
});

test('run-only fields are dropped with a warning; unmarked rounds are reported; bad input fails cleanly', (t) => {
  const sb = sandbox(t);
  sb.init();
  const r = attempt(sb, (f) => {
    f.items[1].verified = 'I checked';
    f.items[1].group = 'G-9';
    f.items[1].changes[0].applied = true;
    f.groups[0].id = 'G-7';
    f.rounds = f.rounds.slice(0, 1);
    f.elements['acme-shop'].skills[0].description = 'rewritten by the reviewer';
  });
  assert.equal(r.code, 0, r.stdout);
  const w = r.json.warnings.join('\n');
  assert.match(w, /\/items\/1\/verified: set by the run, ignored/);
  assert.match(w, /\/items\/1\/group: set by the run, ignored/);
  assert.match(w, /\/items\/1\/changes\/0\/applied: set by the run, ignored/);
  assert.match(w, /\/groups\/0\/id: assigned by build, ignored/);
  assert.match(w, /round 1 of acme-shop is not marked/);
  assert.match(w, /\/elements\/acme-shop\/skills\/0\/description: base inventory comes from the snapshot, ignored/);
  const stored = sb.read('findings', 'review.security.json');
  const acme = stored.items.find((i) => i.id === 'ACME-101');
  assert.ok(!('verified' in acme) && !('group' in acme) && !('applied' in acme.changes[0]));
  assert.ok(!('id' in stored.groups[0]));
  assert.deepEqual(stored.elements['acme-shop'].skills[0], { name: 'alpha', verdict: 'retire', reason: 'Never invoked in the window.', item: 'ACME-102' });

  assert.equal(sb.run(['complete', '--unit', 'review:gates', '--session', 's']).code, 2, '--findings is required');
  assert.equal(sb.run(['complete', '--unit', 'review:gates', '--session', 's', '--findings', path.join(sb.home, 'nope.json')]).code, 1);
  assert.equal(sb.complete('review:gates', [1, 2, 3]).code, 1, 'the file must be an object');
  assert.equal(sb.complete('review:gates', { unit: 'review:security', items: [] }).code, 1, 'the file names another unit');
  // Another unit cannot reuse an id that is already in the run.
  sb.run(['claim', '--unit', 'accounts', '--session', 'acc']);
  const acc = sb.complete('accounts', { items: [item('U1-901', 'claude-1', 8, { class: 'sync' }), item('U2-901', 'codex-1', 8, { class: 'sync' })], groups: [{ title: 'Link the two accounts', round: 8, items: ['U1-901', 'U2-901'] }] }, 'acc');
  assert.equal(acc.code, 0, acc.stdout);
  const accBad = sb.complete('accounts', { items: [item('U1-801', 'claude-1', 8)] }, 'acc');
  assert.ok(hasError(accBad, /the accounts unit owns U1-9nn/));
  const accRounds = sb.complete('accounts', { rounds: [{ harness: 'claude-1', round: 8, status: 'done' }], items: [] }, 'acc');
  assert.ok(hasError(accRounds, /does not own this round/));
});

test('a unit claimed by another live session cannot be completed by someone else', (t) => {
  const sb = sandbox(t);
  sb.init();
  sb.run(['claim', '--unit', 'review:security', '--session', 'owner-a']);
  const r = sb.complete('review:security', securityFindings(), 'intruder');
  assert.equal(r.code, 1);
  assert.match(r.json.error, /claimed by owner-a/);
  assert.ok(!sb.exists('findings', 'review.security.json'));
  assert.equal(sb.complete('review:security', securityFindings(), 'owner-a').code, 0);
});
