// A decline outlives the run it was given in, for the proposal it was given to and for nothing
// else (references/follow-up.md, "Reviewing a harness again"). A reviewer never sets `declined`.
// When an item comes back as the same proposal the user declined (its `previous` names the
// declined item and the revisions are equal), the run carries the decline, with its date and its
// note. Pointing at a declined item with another proposal carries nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, item, clock, historyOf, measured, writeImpact, firstReview, FIRST } from './run-helpers.mjs';
import { itemRev } from '../scripts/lib/run/rev.mjs';
import { carriedDecline, forgetRecords } from '../scripts/lib/run/followup.mjs';

const SECOND = '2026-02-10T12:00:00.000Z';
const one = (t) => sandbox(t, { accounts: 0, projects: ['acme-shop'] });

function followUp(sb, at) {
  const r = sb.run(['init', '--follow-up', 'latest'], clock(at));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  sb.runId = r.json.runId;
  sb.dir = r.json.dir;
  writeImpact(sb, 'acme-shop', measured({ from: '2026-01-11T12:00:00.000Z', to: at, sessions: 25 }));
  return r.json;
}
const findings = (items) => ({ rounds: [{ harness: 'acme-shop', round: 1, status: 'done' }], items });
function build(sb) {
  const r = sb.run(['build', '--no-render']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const state = sb.read('state.json');
  return { state, of: (id) => state.items.find((i) => i.id === id) };
}

test('the same proposal stays declined; another proposal that points at the declined item is a new question', (t) => {
  const sb = one(t);
  const first = firstReview(sb);
  const history = historyOf(sb);
  followUp(sb, SECOND);

  // What a reviewer does: read the record, and copy what the declined item proposed.
  const declined = history.record(first.key, first.runId).items.find((i) => i.id === 'ACME-102');
  assert.deepEqual({ status: declined.status, class: declined.class, proposal: declined.proposal, changes: declined.changes }, {
    status: 'declined', class: 'additive', proposal: 'What to change.', changes: [{ path: './AGENTS.md', before: '', after: 'A new rule.\n' }],
  }, 'the record keeps what the declined proposal was');
  const previous = { run: first.runId, item: 'ACME-102' };
  const same = { previous, class: declined.class, proposal: declined.proposal, changes: declined.changes.map((c) => ({ ...c, lang: 'markdown', why: 'Adds the rule.' })) };
  const again = [
    // The same proposal: new id, new wording around it, the same thing to do.
    item('ACME-101', 'acme-shop', 1, { ...same, title: 'The same rule, proposed again', severity: 'high' }),
    // The reviewer's case: something else entirely, on another file, pointing at the old "no".
    item('ACME-102', 'acme-shop', 1, { previous, proposal: 'A completely different operation never declined', changes: [{ path: './settings.json', lang: 'json', before: '', after: 'A new unrelated permission change', why: 'test' }] }),
    // One field apart is another proposal too: the class, the text of a change, the target file.
    item('ACME-103', 'acme-shop', 1, { ...same, class: 'reversible' }),
    item('ACME-104', 'acme-shop', 1, { ...same, changes: [{ ...same.changes[0], after: 'A new rule, reworded.\n' }] }),
    item('ACME-105', 'acme-shop', 1, { ...same, changes: [{ ...same.changes[0], path: './CLAUDE.md' }] }),
  ];

  const done = sb.complete('review:security', findings(again));
  assert.equal(done.code, 0, done.stdout + done.stderr);
  assert.deepEqual(done.json.declinedBefore, { same: ['ACME-101'], changed: ['ACME-102', 'ACME-103', 'ACME-104', 'ACME-105'] });

  const { state, of } = build(sb);
  const earlier = { firstSeenAt: FIRST.closed, times: 1, lastStatus: 'declined', lastDecisionAt: FIRST.decided, lastNote: 'not now' };
  assert.deepEqual({ status: of('ACME-101').status, decision: of('ACME-101').decision, updatedAt: of('ACME-101').updatedAt, carriedFrom: of('ACME-101').carriedFrom, history: of('ACME-101').history }, {
    status: 'declined', decision: 'not now', updatedAt: FIRST.decided, carriedFrom: { run: first.runId, item: 'ACME-102' }, history: earlier,
  }, 'the decline is carried, with the date and the note of the day it was given, and says where it comes from');
  for (const id of ['ACME-102', 'ACME-103', 'ACME-104', 'ACME-105']) {
    assert.deepEqual({ status: of(id).status, decision: of(id).decision, carried: 'carriedFrom' in of(id), history: of(id).history }, { status: 'open', decision: undefined, carried: false, history: earlier }, `${id}: open, and the board can say it was declined before`);
  }
  assert.deepEqual(state.decisions, [], 'no decision of this run stands behind the carried decline');
  const next = sb.run(['next']).json;
  assert.equal(next.undecided, 4, 'the user is asked about the four new proposals, and not again about the one already answered');

  // The record of this run says where the decline comes from; the others carry no decision.
  assert.equal(sb.run(['history', '--write'], clock('2026-02-10T13:00:00.000Z')).code, 0);
  const recorded = () => history.record(first.key, sb.runId).items;
  assert.deepEqual(recorded().map((i) => [i.id, i.status, i.decision]), [
    ['ACME-101', 'declined', { action: 'decline', at: FIRST.decided, note: 'not now', carriedFrom: { run: first.runId, item: 'ACME-102' } }],
    ['ACME-102', 'open', undefined], ['ACME-103', 'open', undefined], ['ACME-104', 'open', undefined], ['ACME-105', 'open', undefined],
  ]);

  // A carried decline is an ordinary declined item: the user can still say yes.
  const yes = sb.run(['decide', '--target', 'ACME-101', '--action', 'approve', '--note', 'changed my mind'], clock('2026-02-10T14:00:00.000Z'));
  assert.equal(yes.code, 0, yes.stdout + yes.stderr);
  assert.equal(yes.json.new[0].result, 'applied');
  const approved = build(sb).of('ACME-101');
  assert.deepEqual([approved.status, approved.decision, 'carriedFrom' in approved], ['approved', 'changed my mind', false]);
  assert.deepEqual(recorded()[0].decision, { action: 'approve', at: '2026-02-10T14:00:00.000Z', note: 'changed my mind' }, 'and then it is a decision of this run, carried from nowhere');

  // A reviewer that sends another proposal under the same id takes the approval away, and the old
  // "no" does not come back for it either: the item is open.
  const replaced = sb.complete('review:security', findings([again[1], { ...again[0], proposal: 'Something else under the same id.' }, ...again.slice(2)]));
  assert.equal(replaced.code, 0, replaced.stdout + replaced.stderr);
  assert.deepEqual(replaced.json.invalidated.map((x) => [x.item, x.was]), [['ACME-101', 'approved']]);
  assert.equal(build(sb).of('ACME-101').status, 'open');
  // And the exact proposal the user declined, sent once more: what the user did in this run comes first.
  assert.equal(sb.complete('review:security', findings(again)).code, 0);
  assert.equal(build(sb).of('ACME-101').status, 'open', 'the item was reopened in this run: the user decides');
});

test('a reviewer cannot hand a finding back as declined, whatever it points at', (t) => {
  const sb = one(t);
  const first = firstReview(sb);
  followUp(sb, SECOND);
  const unrelated = item('ACME-199', 'acme-shop', 1, {
    status: 'declined', previous: { run: first.runId, item: 'ACME-102' }, proposal: 'A completely different operation never declined',
    changes: [{ path: './settings.json', lang: 'json', before: '', after: 'A new unrelated permission change', why: 'test' }],
  });
  const refused = sb.complete('review:security', findings([unrelated]));
  assert.equal(refused.code, 1);
  assert.deepEqual(refused.json.errors, ['/items/0/status: a reviewer may only set open, ok, not-applicable (a decline of an earlier review is carried by the run: send the same proposal as open, with `previous`)']);
  assert.ok(!sb.exists('findings', 'review.security.json'));

  // A findings file that already holds `declined` (written by hand, or by an earlier version) gives no decline either.
  const { status: _status, ...open } = unrelated;
  assert.equal(sb.complete('review:security', findings([open])).code, 0);
  const stored = sb.read('findings', 'review.security.json');
  stored.items[0].status = 'declined';
  fs.writeFileSync(sb.file('findings', 'review.security.json'), JSON.stringify(stored));
  const { state, of } = build(sb);
  assert.equal(of('ACME-199').status, 'open');
  assert.equal(of('ACME-199').decision, undefined, 'the old "not now" is not recorded against another proposal');
  assert.equal(state.items.length, 1);
  assert.equal(sb.run(['close'], clock('2026-02-10T13:00:00.000Z')).code, 0);
  const record = historyOf(sb).record(first.key, sb.runId);
  assert.deepEqual([record.items[0].status, record.items[0].decision], ['open', undefined]);
});

test('what "the same proposal" is: the revision the record holds, or the revision of what the record kept', (t) => {
  const sb = one(t);
  const first = firstReview(sb);
  const history = historyOf(sb);
  const recordFile = path.join(history.dir, first.key, `${first.runId}.json`);
  const original = fs.readFileSync(recordFile, 'utf8');
  const before = process.env.NOVARC_POWERS_HOME;
  process.env.NOVARC_POWERS_HOME = sb.home;
  t.after(() => { if (before === undefined) delete process.env.NOVARC_POWERS_HOME; else process.env.NOVARC_POWERS_HOME = before; forgetRecords(); });

  const run = { runId: '20260210-next', createdAt: SECOND };
  const h = (id) => ({ id, kind: 'project', name: 'acme-shop', path: '~/dev/acme-shop', pathAbs: path.join(sb.home, 'dev', 'acme-shop'), harnessKey: first.key });
  const proposal = (harness, extra = {}) => ({
    id: 'ACME-101', harness, class: 'additive', proposal: 'What to change.', previous: { run: first.runId, item: 'ACME-102' },
    changes: [{ path: './AGENTS.md', before: '', after: 'A new rule.\n' }], ...extra,
  });
  const carried = (raw, harnessId = raw.harness) => { forgetRecords(); return carriedDecline(run, h(harnessId), raw, itemRev(raw)); };
  const decline = { run: first.runId, item: 'ACME-102', at: FIRST.decided, note: 'not now' };

  assert.deepEqual(carried(proposal('acme-shop')), decline);
  // The id of a harness belongs to one run: under another id it is still the same proposal on the same harness.
  assert.notEqual(itemRev(proposal('acme-shop-2')), itemRev(proposal('acme-shop')));
  assert.deepEqual(carried(proposal('acme-shop-2')), decline);
  assert.equal(carried(proposal('acme-shop', { proposal: 'Something else.' })), null);
  assert.equal(carried(proposal('acme-shop', { previous: { run: first.runId, item: 'ACME-103' } })), null, 'deferred then: nothing to carry');
  assert.equal(carried(proposal('acme-shop', { previous: { run: first.runId, item: 'ACME-999' } })), null);
  assert.equal(carried(proposal('acme-shop', { previous: undefined })), null, 'without `previous` nothing is looked up');

  // A record written before proposals were kept: only the revision as written can tell.
  const edit = (change) => { const record = JSON.parse(original); change(record.items.find((i) => i.id === 'ACME-102')); fs.writeFileSync(recordFile, JSON.stringify(record)); };
  edit((i) => { delete i.proposal; delete i.changes; });
  assert.deepEqual(carried(proposal('acme-shop')), decline, 'the same harness id: the revisions are equal');
  assert.equal(carried(proposal('acme-shop-2')), null, 'another harness id, and nothing in the record to compare with');
  // A record that lost the text of its changes to its size limit says so, and is not guessed at.
  edit((i) => { delete i.changes; i.changesOmitted = true; });
  assert.equal(carried(proposal('acme-shop-2')), null);
  // A record whose text is not the text that was handed in (the prose policy masked an address
  // in it): the revision as written still tells, and what the record shows is what a reviewer copies.
  edit((i) => { i.proposal = 'What to change, as al…@example.test asked.'; });
  assert.deepEqual(carried(proposal('acme-shop')), decline, 'the proposal as it was handed in then');
  assert.deepEqual(carried(proposal('acme-shop-2', { proposal: 'What to change, as al…@example.test asked.' })), decline, 'the proposal as the record shows it');
  assert.equal(carried(proposal('acme-shop-2')), null);
  // The date of a carried decline is the day the user said no; a record without it falls back to its review.
  edit((i) => { delete i.decision; });
  assert.deepEqual(carried(proposal('acme-shop')), { ...decline, at: FIRST.closed, note: '' });
  fs.writeFileSync(recordFile, original);
});
