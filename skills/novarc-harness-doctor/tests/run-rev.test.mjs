// Revisions (scripts/lib/run/rev.mjs): a decision is a yes or a no to one exact proposal. When
// the proposal changes under the same item id, the decision no longer applies, wherever it is
// checked: when it arrives, when a unit is completed again, and when the item is about to be applied.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sandbox, securityFindings, item, builtRev } from './run-helpers.mjs';
import { itemRev, groupRev, canonicalJson, revInput } from '../scripts/lib/run/rev.mjs';

const sha12 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
const at = (s) => `2020-05-01T10:00:${String(s).padStart(2, '0')}.000Z`;
const statusOf = (sb, id) => sb.read('status.json').items[id] || {};
let files = 0;
function ingest(sb, list) {
  const file = path.join(sb.home, `export-${++files}.json`);
  fs.writeFileSync(file, JSON.stringify(list));
  const r = sb.run(['decisions', '--ingest', file]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  return r.json;
}
const build = (sb) => assert.equal(sb.run(['build', '--no-render']).code, 0);
/** Security findings with one item replaced by another proposal under the same id. */
function withChanged(id, extra) {
  const f = securityFindings();
  const i = f.items.findIndex((x) => x.id === id);
  f.items[i] = { ...f.items[i], ...extra };
  return f;
}
const OTHER = { class: 'permission', proposal: 'Allow every command without asking.', changes: [{ path: './CLAUDE.md', lang: 'markdown', before: 'line one', after: 'Allow every command without asking.', why: 'Not what was approved.' }] };

function ready(t) {
  const sb = sandbox(t);
  assert.equal(sb.init().code, 0);
  assert.equal(sb.complete('review:security', securityFindings()).code, 0);
  build(sb);
  return sb;
}

test('the rev is a hash of what would be applied: fields and order, written out by hand', (t) => {
  const it = item('ACME-101', 'acme-shop', 1);
  // Keys in code-unit order at every level, no whitespace, a field that is absent as null.
  const canonical = '{"changes":[{"after":"line one, improved","before":"line one","file":null,"insertAfter":null,"path":"./CLAUDE.md"}],"class":"reversible","file":null,"harness":"acme-shop","proposal":"What to change."}';
  assert.equal(canonicalJson(revInput(it)), canonical);
  assert.equal(itemRev(it), sha12(canonical));
  assert.match(itemRev(it), /^[0-9a-f]{12}$/);

  // Wording can be improved without asking the user again.
  const wording = [
    { title: 'Another title' }, { finding: 'Said differently.' }, { evidence: 'CLAUDE.md:9' }, { opinion: 'Still worth doing.' },
    { severity: 'critical' }, { round: 2 }, { origin: 'plugin' }, { check: 'some-check' }, { status: 'ok' }, { id: 'ACME-199' },
    { lesson: { why: 'Other words.', impact: 'Other words.', better: 'Other words.' } }, { saves: { tokens: 10, basis: 'estimated' } },
    { changes: [{ ...it.changes[0], why: 'Another reason.', lang: 'text', applied: true }] },
  ];
  for (const w of wording) assert.equal(itemRev({ ...it, ...w }), itemRev(it), `wording only: ${Object.keys(w)[0]}`);

  // Anything that changes what is applied, or where, is another revision.
  const c = it.changes[0];
  const substance = [
    { harness: 'novarc-powers' }, { class: 'permission' }, { proposal: 'Something else.' }, { file: './OTHER.md' }, { changes: [] },
    { changes: [{ ...c, after: 'line one, changed' }] }, { changes: [{ ...c, before: 'line two' }] }, { changes: [{ ...c, path: './AGENTS.md' }] },
    { changes: [{ ...c, file: 'facme-shop-2' }] }, { changes: [{ ...c, insertAfter: '# Rules' }] }, { changes: [{ ...c, insertAfter: '' }] },
    { changes: [c, { ...c, before: 'line two', after: '' }] }, { changes: [{ ...c, before: 'line two', after: '' }, c] },
  ];
  const revs = substance.map((s) => itemRev({ ...it, ...s }));
  assert.equal(new Set([itemRev(it), ...revs]).size, substance.length + 1, 'every one of them is a different revision');
  assert.equal(itemRev({ ...it, changes: undefined }), itemRev({ ...it, changes: [] }), 'no changes, however it is written');

  // A group: the sorted `itemId:rev` of its members, joined by a line feed.
  const revOf = new Map([['NP-101', 'bbbbbbbbbbbb'], ['ACME-101', 'aaaaaaaaaaaa']]);
  assert.equal(groupRev(['NP-101', 'ACME-101'], revOf), sha12('ACME-101:aaaaaaaaaaaa\nNP-101:bbbbbbbbbbbb'));
  assert.equal(groupRev(['ACME-101', 'NP-101'], revOf), groupRev(['NP-101', 'ACME-101'], revOf), 'the order of the members does not matter');
  assert.notEqual(groupRev(['ACME-101', 'NP-101'], new Map([...revOf, ['NP-101', 'cccccccccccc']])), groupRev(['ACME-101', 'NP-101'], revOf));

  // And that is what build writes, from the item as the findings file stores it.
  const sb = sandbox(t);
  assert.equal(sb.init().code, 0);
  assert.equal(sb.run(['probe']).code, 0);
  assert.equal(sb.complete('review:security', securityFindings()).code, 0);
  build(sb);
  const state = sb.read('state.json');
  const stored = sb.read('findings', 'review.security.json').items;
  for (const i of state.items) assert.equal(i.rev, itemRev(stored.find((x) => x.id === i.id)), i.id);
  const acme = state.items.find((i) => i.id === 'ACME-101');
  assert.equal(acme.changes[0].file, 'facme-shop-1', 'build linked the change to its file in the snapshot');
  assert.equal(acme.rev, sha12(canonical), 'and that link is not part of the rev');
  const g = state.groups[0];
  assert.deepEqual(g.items, ['ACME-101', 'NP-101']);
  assert.equal(g.rev, sha12(`ACME-101:${builtRev(sb, 'ACME-101')}\nNP-101:${builtRev(sb, 'NP-101')}`));
});

test('a proposal changed after approval goes back to open, is not applied, and a late decision on the old one is stale', (t) => {
  const sb = ready(t);
  const revA = builtRev(sb, 'ACME-101');
  const approve = sb.run(['decide', '--target', 'ACME-101', '--action', 'approve', '--note', 'yes to this']);
  assert.equal(approve.json.new[0].rev, revA, 'a decision made in chat is stamped with the current rev');
  assert.deepEqual({ status: statusOf(sb, 'ACME-101').status, rev: statusOf(sb, 'ACME-101').rev }, { status: 'approved', rev: revA }, 'status.json keeps the revision that was approved');
  assert.deepEqual(sb.run(['next']).json.approvedWaiting, { 'acme-shop': ['ACME-101'] });

  // The unit is completed again: same id, another class and another change.
  const changed = withChanged('ACME-101', OTHER);
  const revB = itemRev(changed.items[1]);
  assert.notEqual(revB, revA);
  const again = sb.complete('review:security', changed);
  assert.equal(again.code, 0, again.stdout);
  assert.deepEqual(again.json.invalidated, [{ item: 'ACME-101', was: 'approved', decidedRev: revA, currentRev: revB }]);
  const o = statusOf(sb, 'ACME-101');
  assert.equal(o.status, 'open');
  assert.ok(!('rev' in o) && !('decision' in o), 'neither the approval nor its note is left on the item');
  assert.deepEqual({ status: o.invalidated.status, rev: o.invalidated.rev }, { status: 'approved', rev: revA });
  assert.equal(sb.text('decisions.jsonl').trim().split('\n').length, 1, 'the old decision stays in the record');

  // Nothing downstream takes it.
  const n = sb.run(['next']).json;
  assert.deepEqual(n.approvedWaiting, {});
  assert.deepEqual(n.decideAgain, ['ACME-101']);
  assert.ok(!n.pendingUnits.includes('apply:acme-shop'));
  assert.ok(!sb.run(['status']).json.units.some((u) => u.id === 'apply:acme-shop'), 'no apply unit for it');
  assert.equal(sb.run(['claim', '--unit', 'apply:acme-shop', '--session', 'exec']).code, 1);
  const mark = sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress']);
  assert.equal(mark.code, 1);
  assert.match(mark.json.error, /^cannot mark ACME-101 as in-progress: it is open again: the user approved another version of this proposal, and has to decide on the current one$/);
  assert.deepEqual({ rev: mark.json.rev, decidedRev: mark.json.decidedRev }, { rev: revB, decidedRev: revA });
  build(sb);
  let state = sb.read('state.json');
  const shown = state.items.find((i) => i.id === 'ACME-101');
  assert.deepEqual({ status: shown.status, rev: shown.rev, cls: shown.class, decision: shown.decision }, { status: 'open', rev: revB, cls: 'permission', decision: undefined });
  assert.ok(state.log.some((l) => l.item === 'ACME-101' && /^The proposal changed after it was approved: that decision no longer applies/.test(l.text)));

  // The approval made on the old board arrives late, by another channel.
  const late = ingest(sb, [{ id: 'late-1', at: at(1), target: 'ACME-101', action: 'approve', rev: revA }]);
  assert.deepEqual(late.new.map((d) => [d.id, d.result]), [['late-1', 'stale']]);
  assert.deepEqual(late.stale, [{ id: 'late-1', target: 'ACME-101', action: 'approve', decidedRev: revA, currentRev: revB, reason: 'the proposal changed after this decision was made' }]);
  assert.deepEqual(late.approvedByHarness, {});
  assert.equal(statusOf(sb, 'ACME-101').status, 'open');
  assert.equal(sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress']).code, 1);
  // So does a question and a refusal made on the old one: recorded, reported, without effect.
  const more = ingest(sb, [{ id: 'late-2', at: at(2), target: 'ACME-101', action: 'ask', note: 'Why this line?', rev: revA }, { id: 'late-3', at: at(3), target: 'ACME-101', action: 'decline', rev: revA }]);
  assert.deepEqual(more.stale.map((x) => [x.id, x.action, x.note]), [['late-2', 'ask', 'Why this line?'], ['late-3', 'decline', undefined]]);
  assert.deepEqual(more.questions, []);
  assert.equal(sb.text('decisions.jsonl').trim().split('\n').length, 4, 'stale decisions are still part of the record');
  build(sb);
  state = sb.read('state.json');
  assert.deepEqual(state.decisions.map((d) => [d.target, d.action, d.rev]), [['ACME-101', 'approve', revA]], 'only the decision that was applied, with the revision it was applied to');
  assert.ok(state.log.some((l) => l.item === 'ACME-101' && /^Decision not applied \(Approved on the board\): it was made on an earlier version of this proposal\.$/.test(l.text)));

  // Deciding on the proposal as it is now works as always.
  const fresh = sb.run(['decide', '--target', 'ACME-101', '--action', 'approve', '--rev', revB]);
  assert.deepEqual(fresh.json.new.map((d) => [d.result, d.rev]), [['applied', revB]]);
  assert.deepEqual(fresh.json.stale, []);
  assert.deepEqual({ status: statusOf(sb, 'ACME-101').status, rev: statusOf(sb, 'ACME-101').rev, invalidated: statusOf(sb, 'ACME-101').invalidated }, { status: 'approved', rev: revB, invalidated: undefined });
  assert.ok(!('decideAgain' in sb.run(['next']).json));
  assert.equal(sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress']).code, 0);
});

test('declined and deferred follow the revision too; a change of wording keeps every decision', (t) => {
  const sb = ready(t);
  sb.run(['decide', '--target', 'ACME-101', '--action', 'approve']);
  sb.run(['decide', '--target', 'ACME-102', '--action', 'decline', '--note', 'not now']);
  sb.run(['decide', '--target', 'NP-101', '--action', 'defer']);

  // Reworded: same class, same proposal, same edits.
  const reworded = securityFindings();
  for (const i of reworded.items) {
    i.title = `${i.title}, reworded`;
    i.lesson = { why: 'Better words.', impact: 'Better words.', better: 'Better words.', principle: 'Better words.' };
    if (i.changes) i.changes[0].why = 'A clearer reason.';
  }
  const same = sb.complete('review:security', reworded);
  assert.equal(same.code, 0, same.stdout);
  assert.ok(!('invalidated' in same.json));
  assert.deepEqual(['ACME-101', 'ACME-102', 'NP-101'].map((id) => statusOf(sb, id).status), ['approved', 'declined', 'deferred']);
  assert.equal(sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress']).code, 0);

  // Another proposal for the two the user said no and later to.
  const f = securityFindings();
  f.items[2] = { ...f.items[2], changes: [{ ...f.items[2].changes[0], after: 'line one, and something the user never saw' }] };
  f.items[3] = { ...f.items[3], proposal: 'A different plan.' };
  const again = sb.complete('review:security', f);
  assert.deepEqual(again.json.invalidated.map((x) => [x.item, x.was]), [['ACME-102', 'declined'], ['NP-101', 'deferred']]);
  assert.deepEqual(['ACME-102', 'NP-101'].map((id) => statusOf(sb, id).status), ['open', 'open']);
  assert.ok(!('decision' in statusOf(sb, 'ACME-102')), 'the note belonged to the old proposal');
  // The item that is being applied only had its wording put back: nothing to say.
  assert.equal(statusOf(sb, 'ACME-101').status, 'in-progress');
  assert.deepEqual(again.json.warnings, []);
  // Its proposal replaced while an executor is on it, or after it was applied: refused. The board
  // shows the changes of that item as applied, so they stay the ones that were.
  const during = sb.complete('review:security', withChanged('ACME-101', OTHER));
  assert.equal(during.code, 1);
  assert.deepEqual(during.json.errors, ['/items/1: ACME-101 is being applied with another proposal; keep the item as it is until it is marked fixed or failed']);
  assert.equal(sb.read('findings', 'review.security.json').items[1].proposal, 'What to change.', 'the stored findings are untouched');
  assert.equal(statusOf(sb, 'ACME-101').status, 'in-progress');
  assert.equal(sb.run(['mark', '--item', 'ACME-101', '--status', 'fixed', '--verified', 'read back']).code, 0);
  const applied = sb.complete('review:security', withChanged('ACME-101', OTHER));
  assert.equal(applied.code, 1);
  assert.deepEqual(applied.json.errors, ['/items/1: ACME-101 is fixed with another proposal; keep the item as it was applied, or undo it first (run.mjs undo --item ACME-101)']);
  assert.equal(sb.complete('review:security', f).code, 0, 'the same findings again, with the applied item as it was, are fine');

  // A fix that failed may come back as a better proposal: it needs a new approval anyway.
  sb.run(['decide', '--target', 'NP-101', '--action', 'approve']);
  sb.run(['mark', '--item', 'NP-101', '--status', 'in-progress']);
  assert.equal(sb.run(['mark', '--item', 'NP-101', '--status', 'failed', '--not-verified', 'the check did not pass']).code, 0);
  f.items[3] = { ...f.items[3], proposal: 'A third plan, after the failure.' };
  const retry = sb.complete('review:security', f);
  assert.equal(retry.code, 0, retry.stdout);
  assert.equal(statusOf(sb, 'NP-101').status, 'failed');
  assert.equal(sb.run(['mark', '--item', 'NP-101', '--status', 'in-progress']).code, 1, 'a failed item needs a new approval');
  assert.deepEqual(sb.run(['decide', '--target', 'NP-101', '--action', 'approve']).json.new.map((d) => [d.result, d.rev]), [['applied', itemRev(f.items[3])]]);
  assert.equal(sb.run(['mark', '--item', 'NP-101', '--status', 'in-progress']).code, 0);
  build(sb);
  const log = sb.read('state.json').log.map((l) => l.text).join('\n');
  assert.match(log, /The proposal changed after it was declined/);
  assert.match(log, /The proposal changed after it was deferred/);
});

test('a decision that arrives without a rev is bound to the last built board', (t) => {
  const sb = sandbox(t);
  assert.equal(sb.init().code, 0);
  assert.equal(sb.complete('review:security', securityFindings()).code, 0);

  // No board yet: nobody can have decided on one.
  const none = ingest(sb, [{ id: 'n-1', at: at(1), target: 'ACME-101', action: 'approve' }]);
  assert.deepEqual(none.new.map((d) => d.result), ['stale']);
  assert.deepEqual(none.stale, [{ id: 'n-1', target: 'ACME-101', action: 'approve', decidedRev: null, currentRev: itemRev(securityFindings().items[1]), reason: 'the decision carries no rev and no board was built yet' }]);
  assert.equal(statusOf(sb, 'ACME-101').status, undefined);

  build(sb);
  const revA = builtRev(sb, 'ACME-101');
  // The proposal changes and the board is not rebuilt: the user is still looking at A.
  const changed = withChanged('ACME-101', OTHER);
  const revB = itemRev(changed.items[1]);
  assert.equal(sb.complete('review:security', changed).code, 0);
  const old = ingest(sb, [{ id: 'n-2', at: at(2), target: 'ACME-101', action: 'approve' }, { id: 'n-3', at: at(3), target: 'G-1', action: 'approve' }]);
  assert.deepEqual(old.new.map((d) => [d.id, d.result, d.rev]), [['n-2', 'stale', revA], ['n-3', 'stale', builtRev(sb, 'G-1')]]);
  assert.deepEqual(old.stale.map((x) => [x.target, x.decidedRev, x.currentRev === x.decidedRev]), [['ACME-101', revA, false], ['G-1', builtRev(sb, 'G-1'), false]]);
  assert.equal(old.stale[0].currentRev, revB);
  assert.deepEqual(sb.text('decisions.jsonl').trim().split('\n').map((l) => JSON.parse(l)).map((d) => [d.id, d.rev]), [['n-1', undefined], ['n-2', revA], ['n-3', builtRev(sb, 'G-1')]], 'the record keeps the revision each decision was bound to');
  assert.deepEqual(['ACME-101', 'NP-101'].map((id) => statusOf(sb, id).status), [undefined, undefined]);

  // Rebuilt: the board shows B, and a decision without a rev is about B.
  build(sb);
  assert.equal(builtRev(sb, 'ACME-101'), revB);
  const now = ingest(sb, [{ id: 'n-4', at: at(4), target: 'ACME-101', action: 'approve' }]);
  assert.deepEqual(now.new.map((d) => [d.result, d.rev]), [['applied', revB]]);
  assert.deepEqual({ status: statusOf(sb, 'ACME-101').status, rev: statusOf(sb, 'ACME-101').rev }, { status: 'approved', rev: revB });

  // The same for a line the board appended to decisions.jsonl without a rev.
  fs.appendFileSync(sb.file('decisions.jsonl'), `${JSON.stringify({ id: 'line-1', at: at(5), runId: sb.runId, target: 'NP-101', action: 'decline', via: 'board' })}\n`);
  assert.deepEqual(sb.run(['decisions']).json.new.map((d) => [d.id, d.result, d.rev]), [['line-1', 'applied', builtRev(sb, 'NP-101')]]);

  // An item the last build does not show cannot have been decided on the board.
  const added = withChanged('ACME-101', OTHER);
  added.items.push(item('ACME-103', 'acme-shop', 1));
  assert.equal(sb.complete('review:security', added).code, 0);
  const unseen = ingest(sb, [{ id: 'n-5', at: at(6), target: 'ACME-103', action: 'approve' }]);
  assert.deepEqual(unseen.stale.map((x) => [x.target, x.decidedRev, x.reason]), [['ACME-103', null, 'the decision carries no rev and the last built board does not show this target']]);
  // In chat it can: the decision is about the item as it is now, unless it says otherwise.
  const chat = sb.run(['decide', '--target', 'ACME-103', '--action', 'approve']);
  assert.deepEqual(chat.json.new.map((d) => [d.result, d.rev]), [['applied', itemRev(added.items[5])]]);
  const pasted = sb.run(['decide', '--target', 'ACME-102', '--action', 'approve', '--rev', '0123456789ab']);
  assert.equal(pasted.code, 0);
  assert.deepEqual(pasted.json.stale.map((x) => [x.target, x.decidedRev]), [['ACME-102', '0123456789ab']]);
  assert.equal(statusOf(sb, 'ACME-102').status, undefined);
  assert.equal(sb.run(['decide', '--target', 'ACME-102', '--action', 'approve', '--rev', 'latest']).code, 2, 'a rev is 12 hex characters');
  assert.equal(sb.run(['decide', '--target', 'ACME-102', '--action', 'approve', '--rev']).code, 2);
  // The primary account has no revision: a rev given with it is dropped, never checked.
  const primary = sb.run(['decide', '--target', 'accounts.primary', '--action', 'approve', '--note', 'codex-1', '--rev', '0123456789ab']);
  assert.deepEqual(primary.json.new.map((d) => [d.result, d.rev]), [['applied', undefined]]);
  assert.equal(sb.read('run.json').primary, 'codex-1');
});

test('a group rev changes when a member changes; group approvals with exclude keep working', (t) => {
  const sb = ready(t);
  const groupA = builtRev(sb, 'G-1');
  const acme = builtRev(sb, 'ACME-101');

  // One member comes back as another proposal: same group, another revision of it.
  const f = withChanged('NP-101', { proposal: 'Another plan for this project.' });
  assert.equal(sb.complete('review:security', f).code, 0);
  build(sb);
  const groupB = builtRev(sb, 'G-1');
  assert.notEqual(groupB, groupA);
  assert.equal(builtRev(sb, 'ACME-101'), acme, 'the member that did not change keeps its rev');
  assert.equal(groupB, sha12(`ACME-101:${acme}\nNP-101:${builtRev(sb, 'NP-101')}`));

  // A yes to the group as it was is not a yes to the group as it is.
  const old = ingest(sb, [{ id: 'g-1', at: at(1), target: 'G-1', action: 'approve', rev: groupA }]);
  assert.deepEqual(old.new.map((d) => d.result), ['stale']);
  assert.deepEqual(old.stale, [{ id: 'g-1', target: 'G-1', action: 'approve', decidedRev: groupA, currentRev: groupB, reason: 'the proposal changed after this decision was made' }]);
  assert.deepEqual(['ACME-101', 'NP-101'].map((id) => statusOf(sb, id).status), [undefined, undefined], 'not even the member that did not change');
  build(sb);
  assert.ok(sb.read('state.json').log.some((l) => /^Decision not applied \(Approved on the board\) for group G-1: it was made on an earlier version of the group\.$/.test(l.text)));

  // On the current revision, with one member left out.
  const ok = ingest(sb, [{ id: 'g-2', at: at(2), target: 'G-1', action: 'approve', exclude: ['NP-101'], rev: groupB }]);
  assert.deepEqual(ok.new.map((d) => [d.result, d.rev]), [['applied', groupB]]);
  assert.deepEqual(ok.approvedByHarness, { 'acme-shop': ['ACME-101'] });
  assert.deepEqual({ status: statusOf(sb, 'ACME-101').status, rev: statusOf(sb, 'ACME-101').rev }, { status: 'approved', rev: acme }, 'each member is bound to its own revision');
  assert.equal(statusOf(sb, 'NP-101').status, undefined);
  // In chat, without a rev, the group as it is now; then the whole group.
  const chat = sb.run(['decide', '--target', 'G-1', '--action', 'approve']);
  assert.deepEqual(chat.json.new.map((d) => [d.result, d.rev]), [['applied', groupB]]);
  assert.deepEqual(chat.json.approvedByHarness, { 'acme-shop': ['ACME-101'], 'novarc-powers': ['NP-101'] });

  // The excluded member changing again does not touch the approval of the other one.
  assert.equal(sb.complete('review:security', withChanged('NP-101', { proposal: 'A third plan.' })).json.invalidated.length, 1);
  assert.equal(statusOf(sb, 'ACME-101').status, 'approved');
  assert.equal(statusOf(sb, 'NP-101').status, 'open');
  assert.deepEqual(sb.run(['next']).json.approvedWaiting, { 'acme-shop': ['ACME-101'] });
});

test('a decision on an earlier version, made after the one the item has, puts the item back to open', (t) => {
  const sb = ready(t);
  const revA = builtRev(sb, 'ACME-101');
  const groupA = builtRev(sb, 'G-1');
  const changed = withChanged('ACME-101', OTHER);
  const revB = itemRev(changed.items[1]);
  assert.equal(sb.complete('review:security', changed).code, 0);
  // The user approves the new proposal (and the other member of the group) in chat.
  sb.run(['decide', '--target', 'ACME-101', '--action', 'approve']);
  sb.run(['decide', '--target', 'NP-101', '--action', 'approve']);
  assert.deepEqual({ status: statusOf(sb, 'ACME-101').status, rev: statusOf(sb, 'ACME-101').rev }, { status: 'approved', rev: revB });

  // A refusal of the old proposal that was made before that approval: the approval stands.
  const earlier = ingest(sb, [{ id: 'o-1', at: at(1), target: 'ACME-101', action: 'decline', rev: revA }]);
  assert.deepEqual(earlier.stale.map((x) => [x.id, x.reopened]), [['o-1', undefined]]);
  assert.equal(statusOf(sb, 'ACME-101').status, 'approved');

  // The same refusal made afterwards, on a page that still showed the old proposal: the last thing
  // the user did was say no, to something else. Nothing is applied on that; they decide again.
  const later = new Date(Date.now() + 60000).toISOString();
  const after = ingest(sb, [{ id: 'o-2', at: later, target: 'ACME-101', action: 'decline', rev: revA }]);
  assert.deepEqual(after.new.map((d) => d.result), ['stale']);
  assert.deepEqual(after.stale, [{ id: 'o-2', target: 'ACME-101', action: 'decline', decidedRev: revA, currentRev: revB, reason: 'the proposal changed after this decision was made', reopened: ['ACME-101'] }]);
  const o = statusOf(sb, 'ACME-101');
  assert.equal(o.status, 'open', 'neither declined nor approved');
  assert.deepEqual({ status: o.invalidated.status, rev: o.invalidated.rev }, { status: 'approved', rev: revB });
  assert.equal(statusOf(sb, 'NP-101').status, 'approved', 'another item is not touched');
  assert.deepEqual(sb.run(['next']).json.decideAgain, ['ACME-101']);
  assert.equal(sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress']).code, 1);
  build(sb);
  assert.ok(sb.read('state.json').log.some((l) => l.item === 'ACME-101' && /^Open again: after it was approved, another decision arrived that was made on an earlier version of this proposal\.$/.test(l.text)));

  // A group decision on the old group reopens the members it covers, not the one it leaves out.
  const evenLater = new Date(Date.now() + 120000).toISOString();
  const group = ingest(sb, [{ id: 'o-3', at: evenLater, target: 'G-1', action: 'decline', exclude: ['ACME-101'], rev: groupA }]);
  assert.deepEqual(group.stale.map((x) => [x.target, x.reopened]), [['G-1', ['NP-101']]]);
  assert.equal(statusOf(sb, 'NP-101').status, 'open');
});

test('an approval stored for another revision is never effective, whoever wrote it', (t) => {
  const sb = ready(t);
  sb.run(['decide', '--target', 'ACME-101', '--action', 'approve']);
  sb.run(['decide', '--target', 'ACME-102', '--action', 'approve']);
  const edit = (fn) => { const s = sb.read('status.json'); fn(s.items); fs.writeFileSync(sb.file('status.json'), JSON.stringify(s)); };

  // status.json says approved, for a revision the item does not have; and approved for none at all
  // (a run that started before decisions carried a revision).
  edit((items) => { items['ACME-101'].rev = '0123456789ab'; delete items['ACME-102'].rev; });
  const acme = sb.run(['status']).json.harnesses.find((h) => h.id === 'acme-shop');
  assert.deepEqual(acme.items, { open: 2 });
  assert.ok(!sb.run(['status']).json.units.some((u) => u.id === 'apply:acme-shop'));
  const n = sb.run(['next']).json;
  assert.deepEqual(n.approvedWaiting, {});
  assert.deepEqual(n.decideAgain, ['ACME-101', 'ACME-102']);
  for (const id of ['ACME-101', 'ACME-102']) {
    const mark = sb.run(['mark', '--item', id, '--status', 'in-progress']);
    assert.equal(mark.code, 1, id);
    assert.match(mark.json.error, /it is open again: the user approved another version of this proposal/);
  }
  build(sb);
  assert.deepEqual(sb.read('state.json').items.filter((i) => i.harness === 'acme-shop').map((i) => i.status), ['open', 'open']);
  // Decided again, it is an approval like any other.
  sb.run(['decide', '--target', 'ACME-102', '--action', 'approve']);
  assert.equal(sb.run(['mark', '--item', 'ACME-102', '--status', 'in-progress']).code, 0);
});

test('mark --rev refuses a proposal that was replaced after the executor read it; the brief carries the revs', (t) => {
  const sb = ready(t);
  sb.run(['decide', '--target', 'ACME-101', '--action', 'approve']);
  sb.run(['decide', '--target', 'ACME-102', '--action', 'approve']);
  const brief = sb.run(['claim', '--unit', 'apply:acme-shop', '--session', 'exec-1']).json;
  assert.deepEqual(brief.items, ['ACME-101', 'ACME-102']);
  assert.deepEqual(brief.revs, { 'ACME-101': builtRev(sb, 'ACME-101'), 'ACME-102': builtRev(sb, 'ACME-102') });

  // Replaced and approved again between the executor's read and its mark.
  const changed = withChanged('ACME-101', OTHER);
  assert.equal(sb.complete('review:security', changed).code, 0);
  sb.run(['decide', '--target', 'ACME-101', '--action', 'approve']);
  const stale = sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress', '--rev', brief.revs['ACME-101']]);
  assert.equal(stale.code, 1);
  assert.match(stale.json.error, /its proposal is not the revision given with --rev any more; read the item again/);
  assert.equal(stale.json.rev, itemRev(changed.items[1]));
  assert.equal(statusOf(sb, 'ACME-101').status, 'approved');
  assert.equal(sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress', '--rev', 'nope']).code, 2);
  const ok = sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress', '--rev', itemRev(changed.items[1])]);
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(sb.run(['mark', '--item', 'ACME-102', '--status', 'in-progress', '--rev', brief.revs['ACME-102']]).code, 0);
  assert.equal(statusOf(sb, 'ACME-102').rev, brief.revs['ACME-102'], 'the revision being applied stays on the item');
});

test('doctor mode does not apply on its own a new version of something the user decided', (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop'] });
  assert.equal(sb.init(['--mode', 'doctor']).code, 0);
  const findings = (extra = {}) => ({ rounds: [{ harness: 'acme-shop', round: 1, status: 'done' }], items: [item('ACME-101', 'acme-shop', 1), item('ACME-102', 'acme-shop', 1, { class: 'additive', ...extra })] });
  assert.equal(sb.complete('review:security', findings()).code, 0);
  for (const unit of ['review:instructions', 'review:gates', 'review:skills-tools', 'review:cleanup-deps']) assert.equal(sb.complete(unit, { items: [] }).code, 0);
  assert.deepEqual(sb.run(['next']).json.autoApplicable, { 'acme-shop': ['ACME-101', 'ACME-102'] });

  sb.run(['decide', '--target', 'ACME-102', '--action', 'decline', '--note', 'I keep this as it is']);
  assert.deepEqual(sb.run(['next']).json.autoApplicable, { 'acme-shop': ['ACME-101'] });
  // A slightly different proposal, still a safe class: open again, and it waits for the user.
  const again = sb.complete('review:security', findings({ proposal: 'Nearly the same thing.' }));
  assert.deepEqual(again.json.invalidated.map((x) => [x.item, x.was]), [['ACME-102', 'declined']]);
  const n = sb.run(['next']).json;
  assert.deepEqual(n.autoApplicable, { 'acme-shop': ['ACME-101'] });
  assert.deepEqual(n.decideAgain, ['ACME-102']);
  const auto = sb.run(['mark', '--item', 'ACME-102', '--status', 'in-progress', '--auto']);
  assert.equal(auto.code, 1);
  assert.match(auto.json.error, /the user declined another version of this proposal; the current one waits for their decision/);
  assert.equal(sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress', '--auto']).code, 0, 'an item the user never decided is applied as before');
  sb.run(['decide', '--target', 'ACME-102', '--action', 'approve']);
  assert.equal(sb.run(['mark', '--item', 'ACME-102', '--status', 'in-progress']).code, 0);
});

test('a rev written by a reviewer is ignored: only the run computes it', (t) => {
  const sb = sandbox(t);
  assert.equal(sb.init().code, 0);
  const f = securityFindings();
  f.items[1].rev = 'aaaaaaaaaaaa';
  f.groups[0].rev = 'bbbbbbbbbbbb';
  const r = sb.complete('review:security', f);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.json.warnings.join('\n'), /\/items\/1\/rev: set by the run, ignored/);
  assert.match(r.json.warnings.join('\n'), /\/groups\/0\/rev: computed by build, ignored/);
  const stored = sb.read('findings', 'review.security.json');
  assert.ok(!('rev' in stored.items[1]) && !('rev' in stored.groups[0]));
  build(sb);
  assert.equal(builtRev(sb, 'ACME-101'), itemRev(securityFindings().items[1]));
  assert.notEqual(builtRev(sb, 'G-1'), 'bbbbbbbbbbbb');
});
