// run.mjs decide / decisions: one decision shape from chat, from the board's decisions.jsonl and
// from an Artifact database export; effects on items, groups and the primary account.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, securityFindings, item, together } from './run-helpers.mjs';

function ready(t) {
  const sb = sandbox(t);
  assert.equal(sb.init().code, 0);
  assert.equal(sb.complete('review:security', securityFindings()).code, 0);
  assert.equal(sb.complete('review:gates', { items: [item('ACME-401', 'acme-shop', 4), item('NP-401', 'novarc-powers', 4), item('U1-401', 'claude-1', 4)], groups: [{ title: 'Same gate', round: 4, items: ['ACME-401', 'NP-401', 'U1-401'] }] }).code, 0);
  return sb;
}
const statusOf = (sb, id) => (sb.read('status.json').items[id] || {}).status;
function ingest(sb, value, name = 'export.json') {
  const file = path.join(sb.home, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return sb.run(['decisions', '--ingest', file]);
}

test('decide approve / decline / defer changes the item and reports what changed', (t) => {
  const sb = ready(t);
  const a = sb.run(['decide', '--target', 'ACME-101', '--action', 'approve', '--note', 'yes, do it']);
  assert.equal(a.code, 0, a.stdout + a.stderr);
  assert.equal(a.json.new.length, 1);
  const d = a.json.new[0];
  assert.deepEqual({ target: d.target, action: d.action, note: d.note, via: d.via, runId: d.runId, result: d.result }, { target: 'ACME-101', action: 'approve', note: 'yes, do it', via: 'chat', runId: sb.runId, result: 'applied' });
  assert.match(d.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(a.json.approvedByHarness, { 'acme-shop': ['ACME-101'] });
  assert.deepEqual(a.json.questions, []);
  assert.equal(statusOf(sb, 'ACME-101'), 'approved');
  assert.equal(sb.read('status.json').items['ACME-101'].decision, 'yes, do it');

  assert.equal(sb.run(['decide', '--target', 'NP-101', '--action', 'decline']).json.new[0].result, 'applied');
  assert.equal(statusOf(sb, 'NP-101'), 'declined');
  assert.equal(sb.run(['decide', '--target', 'U1-101', '--action', 'defer']).code, 0);
  assert.equal(statusOf(sb, 'U1-101'), 'deferred');
  // A decision can be changed until the item is being applied.
  sb.run(['decide', '--target', 'NP-101', '--action', 'approve']);
  assert.equal(statusOf(sb, 'NP-101'), 'approved');

  // Every decision is one line of decisions.jsonl, and reaches the state on the next build.
  const lines = sb.text('decisions.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.target, l.action]), [['ACME-101', 'approve'], ['NP-101', 'decline'], ['U1-101', 'defer'], ['NP-101', 'approve']]);
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  const state = sb.read('state.json');
  assert.deepEqual(state.decisions.map((x) => [x.target, x.action, x.via]), [['ACME-101', 'approve', 'chat'], ['NP-101', 'decline', 'chat'], ['U1-101', 'defer', 'chat'], ['NP-101', 'approve', 'chat']]);
  assert.equal(state.decisions[0].note, 'yes, do it');
  assert.ok(!('result' in state.decisions[0]) && !('ingestedAt' in state.decisions[0]), 'bookkeeping fields stay in status.json');
  const acme = state.items.find((i) => i.id === 'ACME-101');
  assert.deepEqual({ status: acme.status, decision: acme.decision }, { status: 'approved', decision: 'yes, do it' });
  assert.match(acme.updatedAt, /^\d{4}-/);
  assert.ok(state.log.some((l) => l.item === 'ACME-101' && /Approved in chat\. yes, do it/.test(l.text)));
  assert.equal(sb.run(['status']).json.lastDecisionAt, lines[3].at);

  assert.equal(sb.run(['decide', '--target', 'ACME-101']).code, 2, '--action is required');
  assert.equal(sb.run(['decide', '--target', 'ACME-101', '--action', 'burn']).code, 2);
  assert.equal(sb.run(['decide', '--target', 'not an id', '--action', 'approve']).code, 2);
  assert.equal(sb.run(['decide', '--target', 'ACME-101', '--action', 'approve', '--exclude', 'ACME-102']).code, 2, '--exclude is for groups');
  assert.equal(sb.run(['decide', '--target', 'ACME-101', '--action', 'ask']).code, 2, 'ask needs the question');
});

test('a group decision fans out to its items, minus the excluded ones', (t) => {
  const sb = ready(t);
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  assert.deepEqual(sb.read('state.json').groups.map((g) => g.id), ['G-1', 'G-2']);
  const r = sb.run(['decide', '--target', 'G-2', '--action', 'approve', '--exclude', 'U1-401', '--note', 'all but my account']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.new[0].result, 'applied');
  assert.deepEqual(r.json.new[0].exclude, ['U1-401']);
  assert.deepEqual(r.json.approvedByHarness, { 'acme-shop': ['ACME-401'], 'novarc-powers': ['NP-401'] });
  assert.equal(statusOf(sb, 'ACME-401'), 'approved');
  assert.equal(statusOf(sb, 'NP-401'), 'approved');
  assert.equal(statusOf(sb, 'U1-401'), undefined, 'the excluded item is untouched');

  const g1 = sb.run(['decide', '--target', 'G-1', '--action', 'decline']);
  assert.deepEqual(g1.json.approvedByHarness, {});
  assert.equal(statusOf(sb, 'ACME-101'), 'declined');
  assert.equal(statusOf(sb, 'NP-101'), 'declined');
  assert.equal(sb.text('decisions.jsonl').trim().split('\n').length, 2, 'a group decision is recorded once');
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  assert.ok(sb.read('state.json').log.some((l) => /Approved in chat for group G-2 \(2 item\(s\)\)/.test(l.text)));

  const unknown = sb.run(['decide', '--target', 'G-9', '--action', 'approve']);
  assert.equal(unknown.code, 0, 'an unknown target is reported, not fatal');
  assert.deepEqual(unknown.json.unknown, [{ target: 'G-9', reason: 'no such group' }]);
  assert.equal(unknown.json.new[0].result, 'unknown-target');
  assert.deepEqual(sb.run(['decide', '--target', 'ZZZ-101', '--action', 'approve']).json.unknown, [{ target: 'ZZZ-101', reason: 'no such item' }]);
});

test('accounts.primary sets the primary account of the run', (t) => {
  const sb = ready(t);
  assert.equal(sb.read('run.json').primary, 'claude-1');
  const r = sb.run(['decide', '--target', 'accounts.primary', '--action', 'approve', '--note', 'codex-1']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.primary, 'codex-1');
  assert.equal(sb.read('run.json').primary, 'codex-1');
  assert.equal(sb.run(['status']).json.primary, 'codex-1');
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  assert.equal(sb.read('state.json').accounts.primary, 'codex-1');

  const bad = sb.run(['decide', '--target', 'accounts.primary', '--action', 'approve', '--note', 'nobody']);
  assert.equal(bad.code, 0);
  assert.equal(bad.json.unknown[0].target, 'accounts.primary');
  assert.equal(sb.read('run.json').primary, 'codex-1');
  assert.equal(sb.run(['decide', '--target', 'accounts.primary', '--action', 'approve']).code, 2, 'the account id goes in --note');

  const q = sb.run(['decide', '--target', 'accounts.primary', '--action', 'ask', '--note', 'What changes if I pick Codex?']);
  assert.deepEqual(q.json.questions.map((x) => x.target), ['accounts.primary']);
  assert.ok(sb.run(['next']).json.questions.some((x) => x.target === 'accounts.primary'));
  assert.equal(sb.run(['decide', '--target', 'accounts.primary', '--answered']).json.answered, true);
  assert.ok(!sb.run(['next']).json.questions.some((x) => x.target === 'accounts.primary'));
});

test('ask keeps the item open with the question; --answered clears it', (t) => {
  const sb = ready(t);
  const r = sb.run(['decide', '--target', 'ACME-102', '--action', 'ask', '--note', 'Why does this save tokens?']);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.questions.map((q) => [q.target, q.question]), [['ACME-102', 'Why does this save tokens?']]);
  assert.deepEqual(r.json.approvedByHarness, {});
  assert.equal(statusOf(sb, 'ACME-102'), undefined, 'the status stays open');
  assert.equal(sb.read('status.json').items['ACME-102'].question, 'Why does this save tokens?');
  assert.deepEqual(sb.run(['next']).json.questions.map((q) => q.target), ['ACME-102']);
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  const it = sb.read('state.json').items.find((i) => i.id === 'ACME-102');
  assert.deepEqual({ status: it.status, question: it.question }, { status: 'open', question: 'Why does this save tokens?' });

  // Asking about an approved item puts it back to open: nothing is applied under a question.
  sb.run(['decide', '--target', 'ACME-101', '--action', 'approve']);
  sb.run(['decide', '--target', 'ACME-101', '--action', 'ask', '--note', 'Wait, what about the hook?']);
  assert.equal(statusOf(sb, 'ACME-101'), 'open');

  const ans = sb.run(['decide', '--target', 'ACME-102', '--answered']);
  assert.equal(ans.json.answered, true);
  assert.ok(!('question' in sb.read('status.json').items['ACME-102']));
  assert.equal(sb.run(['decide', '--target', 'ACME-102', '--answered']).json.answered, false);
  // A later decision also clears a waiting question.
  sb.run(['decide', '--target', 'ACME-101', '--action', 'approve']);
  assert.ok(!('question' in sb.read('status.json').items['ACME-101']));
  assert.deepEqual(sb.run(['next']).json.questions, []);
});

test('decisions --ingest takes an array, a map or wrapped documents; the same id twice is a no-op', (t) => {
  const sb = ready(t);
  const at = (s) => `2020-01-01T10:00:${s}.000Z`;
  const array = [
    { id: 'dec-1', at: at('01'), runId: sb.runId, target: 'ACME-101', action: 'approve', note: 'from the board', exclude: [], via: 'board' },
    { id: 'dec-2', at: at('02'), runId: sb.runId, target: 'NP-101', action: 'decline', via: 'board' },
  ];
  const first = ingest(sb, array);
  assert.equal(first.code, 0, first.stdout);
  assert.deepEqual(first.json.new.map((d) => [d.id, d.result, d.via]), [['dec-1', 'applied', 'board'], ['dec-2', 'applied', 'board']]);
  assert.deepEqual(first.json.approvedByHarness, { 'acme-shop': ['ACME-101'] });
  assert.equal(statusOf(sb, 'ACME-101'), 'approved');
  assert.equal(statusOf(sb, 'NP-101'), 'declined');
  assert.equal(sb.text('decisions.jsonl').trim().split('\n').length, 2, 'ingested decisions join the record');

  const again = ingest(sb, array);
  assert.equal(again.code, 0);
  assert.deepEqual(again.json.new, []);
  assert.equal(again.json.duplicates, 2);
  assert.equal(sb.read('status.json').decisions.length, 2);
  assert.equal(sb.text('decisions.jsonl').trim().split('\n').length, 2);

  // The Artifact database keeps one document per target: a map keyed by the document id.
  const map = { 'ACME-102': { id: 'dec-3', at: at('03'), action: 'defer' }, 'G-2': { id: 'dec-4', at: at('04'), target: 'G-2', action: 'approve', exclude: ['U1-401'] } };
  const second = ingest(sb, map, 'map.json');
  assert.deepEqual(second.json.new.map((d) => [d.id, d.target, d.result]), [['dec-3', 'ACME-102', 'applied'], ['dec-4', 'G-2', 'applied']]);
  assert.equal(statusOf(sb, 'ACME-102'), 'deferred');
  assert.equal(statusOf(sb, 'ACME-401'), 'approved');

  // An export envelope with the decision under `data`, and one without an id at all.
  const wrapped = { documents: [{ id: 'U1-101', data: { id: 'dec-5', at: at('05'), action: 'approve' } }, { id: 'U1-401', data: { at: at('06'), action: 'decline' } }] };
  const third = ingest(sb, wrapped, 'wrapped.json');
  assert.deepEqual(third.json.new.map((d) => [d.target, d.result]), [['U1-101', 'applied'], ['U1-401', 'applied']]);
  assert.match(third.json.new[1].id, /^d-[0-9a-f]{20}$/, 'a decision without an id gets a stable one');
  assert.equal(ingest(sb, wrapped, 'wrapped.json').json.duplicates, 2, 'so ingesting the same export again changes nothing');
  assert.equal(statusOf(sb, 'U1-401'), 'declined');

  assert.equal(sb.run(['build', '--no-render']).code, 0);
  assert.deepEqual(sb.read('state.json').decisions.map((d) => d.id).slice(0, 5), ['dec-1', 'dec-2', 'dec-3', 'dec-4', 'dec-5']);
  assert.ok(sb.read('state.json').log.some((l) => /Approved on the board\. from the board/.test(l.text)));
});

test('bad entries are reported and skipped; an older decision never overrides a newer one', (t) => {
  const sb = ready(t);
  const r = ingest(sb, [
    { id: 'ok-1', at: '2020-01-01T10:00:00.000Z', target: 'ACME-101', action: 'approve' },
    { id: 'bad-action', target: 'ACME-102', action: 'explode' },
    { id: 'bad-target', target: '../../etc', action: 'approve' },
    { id: 'other-run', runId: '20200101-zzzz', target: 'NP-101', action: 'approve' },
    { id: 'unknown-1', at: '2020-01-01T10:00:01.000Z', target: 'ACME-777', action: 'approve' },
    'not an object',
  ]);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.new.map((d) => [d.id, d.result]), [['ok-1', 'applied'], ['unknown-1', 'unknown-target']]);
  assert.equal(r.json.rejected.length, 4);
  assert.match(r.json.rejected.map((x) => x.reason).join('|'), /action must be one of.*target must be.*runId is not this run.*must be a JSON object/);
  assert.deepEqual(r.json.unknown, [{ target: 'ACME-777', reason: 'no such item' }]);
  assert.equal(statusOf(sb, 'NP-101'), undefined);

  // Chat says decline now; an export that still carries the older approve arrives afterwards.
  sb.run(['decide', '--target', 'ACME-102', '--action', 'decline']);
  const late = ingest(sb, [{ id: 'old-approve', at: '2020-01-01T09:00:00.000Z', target: 'ACME-102', action: 'approve' }], 'late.json');
  assert.equal(late.json.new[0].result, 'superseded');
  assert.deepEqual(late.json.approvedByHarness, {});
  assert.equal(statusOf(sb, 'ACME-102'), 'declined');

  // An item that is being applied, or is fixed, is left alone.
  sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress']);
  const busy = sb.run(['decide', '--target', 'ACME-101', '--action', 'decline']);
  assert.equal(busy.json.new[0].result, 'skipped');
  assert.deepEqual(busy.json.skipped, [{ target: 'ACME-101', item: 'ACME-101', reason: 'item is in-progress' }]);
  assert.equal(statusOf(sb, 'ACME-101'), 'in-progress');
  const okItem = sb.run(['decide', '--target', 'NP-102', '--action', 'approve']);
  assert.equal(okItem.json.skipped[0].reason, 'item is ok');
  assert.equal(sb.run(['decisions', '--ingest', path.join(sb.home, 'missing.json')]).code, 1);
});

test('decisions takes in what the board appended to decisions.jsonl, once', (t) => {
  const sb = ready(t);
  const line = (d) => fs.appendFileSync(sb.file('decisions.jsonl'), `${JSON.stringify({ runId: sb.runId, via: 'board', ...d })}\n`);
  line({ id: 'b-1', at: '2020-02-01T08:00:00.000Z', target: 'ACME-101', action: 'approve' });
  line({ id: 'b-2', at: '2020-02-01T08:00:01.000Z', target: 'ACME-102', action: 'ask', note: 'Is this safe?' });
  fs.appendFileSync(sb.file('decisions.jsonl'), 'this line is not json\n');
  fs.appendFileSync(sb.file('decisions.jsonl'), '{"id":"partial","target":"NP-1'); // still being written: no newline yet
  assert.equal(sb.run(['next']).json.inbox, 3);
  assert.equal(sb.run(['status']).json.inbox, 3);

  const r = sb.run(['decisions']);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.new.map((d) => d.id), ['b-1', 'b-2']);
  assert.deepEqual(r.json.approvedByHarness, { 'acme-shop': ['ACME-101'] });
  assert.deepEqual(r.json.questions.map((q) => q.target), ['ACME-102']);
  assert.deepEqual(r.json.rejected, [{ source: 'decisions.jsonl line 3', reason: 'invalid JSON' }]);
  assert.equal(sb.run(['next']).json.inbox, 0, 'the bad line is reported once and does not hold the run open');

  const again = sb.run(['decisions']);
  assert.deepEqual(again.json.new, []);
  assert.deepEqual(again.json.rejected, []);
  assert.equal(sb.text('decisions.jsonl').split('\n').length, 4, 'taking decisions in never rewrites the file');
  // The half-written line is completed by the board; the next call sees it.
  fs.appendFileSync(sb.file('decisions.jsonl'), '01","action":"decline"}\n');
  assert.deepEqual(sb.run(['decisions']).json.new.map((d) => [d.id, d.target, d.result]), [['partial', 'NP-101', 'applied']]);
});

test('decide from several processes at once: every decision lands', async (t) => {
  const sb = ready(t);
  const calls = [
    ['--target', 'U1-101', '--action', 'approve'],
    ['--target', 'ACME-101', '--action', 'decline'],
    ['--target', 'ACME-102', '--action', 'defer'],
    ['--target', 'NP-101', '--action', 'approve'],
    ['--target', 'ACME-401', '--action', 'approve'],
    ['--target', 'NP-401', '--action', 'ask', '--note', 'Why?'],
    ['--target', 'accounts.primary', '--action', 'approve', '--note', 'codex-1'],
    ['--target', 'U1-401', '--action', 'decline'],
  ];
  const gate = together();
  const results = await Promise.all(calls.map((c) => sb.runAsync(['decide', ...c], gate)));
  for (const r of results) assert.equal(r.code, 0, r.stderr + r.stdout);
  const status = sb.read('status.json');
  assert.equal(status.decisions.length, 8, 'no decision was lost to a concurrent write');
  assert.ok(status.decisions.every((d) => d.result === 'applied'));
  assert.equal(new Set(status.decisions.map((d) => d.id)).size, 8);
  assert.deepEqual(
    ['U1-101', 'ACME-101', 'ACME-102', 'NP-101', 'ACME-401', 'U1-401'].map((id) => status.items[id].status),
    ['approved', 'declined', 'deferred', 'approved', 'approved', 'declined'],
  );
  assert.equal(status.items['NP-401'].question, 'Why?');
  assert.equal(sb.read('run.json').primary, 'codex-1');
  assert.equal(sb.text('decisions.jsonl').trim().split('\n').length, 8);
  assert.equal(sb.text('log.jsonl').trim().split('\n').filter((l) => /"event":"(decision|primary)"/.test(l)).length, 8);
});
