// The board client's logic that needs no page (templates/board/logic.js): decisions and their
// revisions, routes and the remembered one, storage that may fail, what counts as unknown, and
// what the follow-up of an earlier review comes to (the overview line, a metric's change, an item's history).
// Also the way lib modules are inlined into the page. The fragment has no DOM in it, so it is
// loaded here as plain text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR, FIXTURES } from './helpers.mjs';
import { inlineModule, renderHtml, CLIENT_PARTS, BOARD_DIR, SCHEMA_PATH } from '../scripts/render-board.mjs';
import * as scoring from '../scripts/lib/scoring.mjs';
import * as anchors from '../scripts/lib/anchors.mjs';
import { STRINGS, fill, plural, label } from '../scripts/lib/i18n.mjs';

const read = (...p) => fs.readFileSync(path.join(SKILL_DIR, ...p), 'utf8');
const NAMES = ['ACTION_STATUS', 'DECIDABLE', 'PRIMARY_TARGET', 'REV_RE', 'quoteArg', 'decisionCommand', 'uuidFromBytes', 'revOf', 'makeDecision', 'cleanDecision',
  'latestPerTarget', 'groupsOfItems', 'overlayFor', 'effectiveOf', 'effectiveItems', 'decisionQueue',
  'parseRoute', 'routeKey', 'routeExists', 'routeToRestore', 'safeStore', 'triState', 'countOf', 'wasteGroups',
  'FU_VERDICT_TONE', 'FU_CHECK_TONE', 'metricUnit', 'metricChange', 'followUpSummary', 'followUpLine', 'followUpItems', 'reviewTrail', 'itemHistory', 'historyLine'];
const L = new Function(`${read('templates', 'board', 'logic.js')}\nreturn { ${NAMES.join(', ')} };`)();

const item = (id, status, extra = {}) => ({ id, harness: 'h', round: 1, severity: 'medium', class: 'none', status, ...extra });
const dec = (target, action, at, extra = {}) => ({ id: `${target}@${at}`, at, runId: 'run-1', target, action, via: 'board', ...extra });
const T1 = '2026-01-10T10:00:00Z';
const T2 = '2026-01-10T11:00:00Z';
const T3 = '2026-01-10T12:00:00Z';
const REV_1 = '0123456789ab';
const REV_2 = 'ba9876543210';

test('decisionCommand is the exact run.mjs decide line, with a safely quoted note', () => {
  assert.equal(L.decisionCommand(dec('ACME-104', 'approve', T1)), 'run.mjs decide --run run-1 --target ACME-104 --action approve');
  assert.equal(L.decisionCommand(dec('G-1', 'approve', T1, { exclude: ['A-1', 'B-2'] })), 'run.mjs decide --run run-1 --target G-1 --action approve --exclude A-1,B-2');
  assert.equal(L.decisionCommand(dec('A-1', 'ask', T1, { note: 'why "this"\nand $HOME `x`?' })),
    'run.mjs decide --run run-1 --target A-1 --action ask --note "why \\"this\\" and \\$HOME \\`x\\`?"');
  assert.equal(L.decisionCommand(dec('accounts.primary', 'approve', T1, { note: 'claude-1' })), 'run.mjs decide --run run-1 --target accounts.primary --action approve --note "claude-1"');
});

test('the line to paste carries the rev last, and never anything that is not a rev', () => {
  assert.equal(L.decisionCommand(dec('ACME-104', 'approve', T1, { rev: REV_1 })), `run.mjs decide --run run-1 --target ACME-104 --action approve --rev ${REV_1}`);
  assert.equal(L.decisionCommand(dec('G-1', 'decline', T1, { note: 'not now', exclude: ['A-1'], rev: REV_2 })),
    `run.mjs decide --run run-1 --target G-1 --action decline --note "not now" --exclude A-1 --rev ${REV_2}`);
  // Read back from storage, a rev is untrusted text: only the 12 hex characters reach a command line.
  for (const bad of ['', 'abc', `${REV_1}; rm -rf ~`, '0123456789AB', 12, null, ['x']]) {
    assert.equal(L.decisionCommand(dec('A-1', 'approve', T1, { rev: bad })), 'run.mjs decide --run run-1 --target A-1 --action approve');
  }
});

test('makeDecision builds the contract shape and leaves empty fields out', () => {
  assert.deepEqual(L.makeDecision('run-1', 'A-1', 'approve', '  ', [], 'id-1', T1), { id: 'id-1', at: T1, runId: 'run-1', target: 'A-1', action: 'approve', via: 'board' });
  assert.deepEqual(L.makeDecision('run-1', 'G-1', 'decline', ' no ', ['A-2'], 'id-2', T1), { id: 'id-2', at: T1, runId: 'run-1', target: 'G-1', action: 'decline', via: 'board', note: 'no', exclude: ['A-2'] });
  const id = L.uuidFromBytes(new Uint8Array(16).fill(255));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('a decision carries the rev of the item or group it answers, when the state has one', () => {
  const state = {
    items: [item('A-1', 'open', { rev: REV_1 }), item('A-2', 'open'), item('A-3', 'open', { rev: 'not-a-rev' })],
    groups: [{ id: 'G-1', title: 't', round: 1, rev: REV_2, items: ['A-1', 'A-2'] }, { id: 'G-2', title: 't', round: 1, items: ['A-2', 'A-3'] }],
  };
  assert.equal(L.revOf(state, 'A-1'), REV_1);
  assert.equal(L.revOf(state, 'G-1'), REV_2);
  for (const none of ['A-2', 'A-3', 'G-2', 'Z-9', L.PRIMARY_TARGET]) assert.equal(L.revOf(state, none), null, none);
  assert.equal(L.revOf({}, 'A-1'), null);

  const made = (target) => L.makeDecision('run-1', target, 'approve', '', [], 'id', T1, L.revOf(state, target));
  assert.deepEqual(made('A-1'), { id: 'id', at: T1, runId: 'run-1', target: 'A-1', action: 'approve', via: 'board', rev: REV_1 });
  assert.equal(made('G-1').rev, REV_2);
  assert.ok(!('rev' in made('A-2')) && !('rev' in made(L.PRIMARY_TARGET)), 'no rev in the state, no rev in the decision');
  assert.ok(L.REV_RE.test(REV_1) && !L.REV_RE.test('0123456789abc') && !L.REV_RE.test('0123456789AB'));
});

test('cleanDecision keeps only well-formed decisions read back from a channel', () => {
  assert.equal(L.cleanDecision(null), null);
  assert.equal(L.cleanDecision({ target: 'A-1', action: 'delete-everything', at: T1 }), null);
  assert.equal(L.cleanDecision({ target: 'A-1', action: 'approve', at: 'yesterday' }), null);
  assert.equal(L.cleanDecision({ action: 'approve', at: T1 }), null, 'no target');
  assert.deepEqual(L.cleanDecision({ action: 'approve', at: T1, exclude: ['A-2', 7, ''], note: 5, extra: { nested: true } }, 'G-1'),
    { id: `G-1@${T1}`, at: T1, runId: '', target: 'G-1', action: 'approve', via: 'board', exclude: ['A-2'] });
  // The rev survives the round trip; anything else in its place is dropped, the decision stays.
  assert.equal(L.cleanDecision({ target: 'A-1', action: 'approve', at: T1, rev: REV_1 }).rev, REV_1);
  for (const bad of ['zzz', 5, null, `${REV_1} `]) assert.ok(!('rev' in L.cleanDecision({ target: 'A-1', action: 'approve', at: T1, rev: bad })));
});

test('a restored decision made on another revision of its target does not hold', () => {
  const state = {
    items: [item('A-1', 'open', { rev: REV_1 }), item('A-2', 'open', { rev: REV_1 }), item('A-3', 'open'), item('B-1', 'open', { rev: REV_1 }), item('B-2', 'open', { rev: REV_1 })],
    groups: [{ id: 'G-1', title: 't', round: 1, rev: REV_2, items: ['B-1', 'B-2'] }],
  };
  const o = L.overlayFor(state, [
    dec('A-1', 'approve', T1, { rev: REV_1 }), // the revision on the table: holds
    dec('A-2', 'approve', T1, { rev: REV_2 }), // an earlier revision: the proposal changed since
    dec('A-3', 'approve', T1, { rev: REV_2 }), // the state has no rev to compare with: holds
    dec('G-1', 'approve', T1, { rev: REV_1 }), // the group changed, so none of its members is decided
  ], {});
  assert.deepEqual(Object.keys(o.items), ['A-1', 'A-3']);
  assert.deepEqual(o.groups, {});
  // A decision without a rev (an older board, or chat) is not judged by it.
  assert.deepEqual(Object.keys(L.overlayFor(state, [dec('A-2', 'approve', T1), dec('G-1', 'decline', T1)], {}).items), ['A-2', 'B-1', 'B-2']);
  // Each decision is judged on its own revision, as the session does when it takes them in: an
  // answer to the revision on the table holds even when a later one answered another revision.
  const both = L.overlayFor(state, [dec('A-2', 'decline', T1, { rev: REV_1 }), dec('A-2', 'approve', T2, { rev: REV_2 })], {});
  assert.equal(both.items['A-2'].action, 'decline');
  assert.equal(L.overlayFor(state, [dec('A-2', 'decline', T1, { rev: REV_1 }), dec('A-2', 'approve', T2, { rev: REV_1 })], {}).items['A-2'].action, 'approve');
});

test('a decision made on the page moves an open item, and the scores follow', () => {
  const state = { harnesses: [{ id: 'h' }], rounds: [{ harness: 'h', round: 1, status: 'done' }], items: [item('A-1', 'open', { severity: 'high' }), item('A-2', 'open')] };
  const none = L.overlayFor(state, [], {});
  assert.deepEqual(none.items, {});
  const approve = dec('A-1', 'approve', T1);
  const o = L.overlayFor(state, [approve], { [approve.id]: true });
  assert.equal(L.effectiveOf(state.items[0], o).status, 'approved');
  assert.equal(L.effectiveOf(state.items[1], o).status, 'open');
  assert.deepEqual(o.held, [approve]);
  // high 15 + medium 5 = 20 -> 80 now; with A-1 approved the projected score counts only A-2: 95.
  const eff = { ...state, items: L.effectiveItems(state, o) };
  const s = scoring.scoreHarness(eff, 'h');
  assert.deepEqual([s.baseline, s.current, s.projected], [80, 80, 95]);
  assert.equal(state.items[0].status, 'open', 'the state itself is not touched');
  // decline halves it now; defer changes nothing; ask leaves it open with the question set.
  const st = (action, note) => L.effectiveOf(state.items[0], L.overlayFor(state, [dec('A-1', action, T1, note ? { note } : {})], {}));
  assert.equal(st('decline').status, 'declined');
  assert.equal(st('defer').status, 'deferred');
  assert.deepEqual([st('ask', 'why?').status, st('ask', 'why?').asked, st('ask', 'why?').question], ['open', true, 'why?']);
});

test('the state always wins over decisions restored from memory', () => {
  const state = {
    items: [item('A-1', 'open'), item('A-2', 'fixed'), item('A-3', 'declined', { updatedAt: T2 }), item('A-4', 'approved'), item('A-5', 'open')],
    decisions: [{ id: 'in-state', at: T2, target: 'A-5', action: 'ask' }],
  };
  const restored = [
    dec('A-1', 'approve', T1), // open, nothing newer in the state: holds
    dec('A-2', 'decline', T3), // already fixed: never
    dec('A-3', 'approve', T1), // the state declined it later: the state wins
    dec('A-4', 'decline', T3), // the state has no stamp for it, so memory cannot prove it is newer
    dec('A-5', 'approve', T1), // the state has a newer decision for it
    { ...dec('A-1', 'decline', T3), id: 'in-state' }, // already taken into the state
  ];
  const o = L.overlayFor(state, restored, {});
  assert.deepEqual(Object.keys(o.items), ['A-1']);
  assert.equal(o.items['A-1'].action, 'approve');
  // Provably newer than the state: holds for a status the user may still change.
  assert.equal(L.overlayFor(state, [dec('A-3', 'approve', T3)], {}).items['A-3'].action, 'approve');
  // Made in this page load: holds for anything still decidable, but never for a finished item.
  const fresh = [dec('A-4', 'decline', T1), dec('A-2', 'decline', T1)];
  const f = L.overlayFor(state, fresh, { [fresh[0].id]: true, [fresh[1].id]: true });
  assert.deepEqual(Object.keys(f.items), ['A-4']);
});

test('the newest decision per target wins, and arrival order breaks a tie', () => {
  const list = [dec('A-1', 'approve', T1), dec('A-1', 'decline', T2), dec('A-2', 'defer', T1), { ...dec('A-2', 'approve', T1), id: 'later' }];
  assert.deepEqual(L.latestPerTarget(list).map((d) => [d.target, d.action]), [['A-1', 'decline'], ['A-2', 'approve']]);
});

test('a group decision covers its items, except the excluded ones and the ones decided later on their own', () => {
  const state = {
    items: [item('A-1', 'open', { group: 'G-1' }), item('B-1', 'open'), item('C-1', 'open'), item('D-1', 'fixed')],
    groups: [{ id: 'G-1', title: 't', round: 2, items: ['A-1', 'B-1', 'C-1', 'D-1'] }],
  };
  assert.deepEqual(L.groupsOfItems(state), { 'A-1': ['G-1'], 'B-1': ['G-1'], 'C-1': ['G-1'], 'D-1': ['G-1'] });
  const g = dec('G-1', 'approve', T2, { exclude: ['C-1'] });
  const own = dec('B-1', 'decline', T3);
  const older = dec('A-1', 'decline', T1);
  const o = L.overlayFor(state, [g, own, older], {});
  assert.equal(L.effectiveOf(state.items[0], o).status, 'approved', 'the group decision is newer than the item one');
  assert.equal(L.effectiveOf(state.items[1], o).status, 'declined', 'decided on its own after the group');
  assert.equal(L.effectiveOf(state.items[2], o).status, 'open', 'left out of the group');
  assert.equal(L.effectiveOf(state.items[3], o).status, 'fixed');
  assert.equal(o.groups['G-1'], g);
  assert.deepEqual(o.held.map((d) => d.target), ['G-1', 'B-1']);
});

test('choosing the primary account holds only while the state has none', () => {
  const accounts = (primary) => ({ primary, list: [{ id: 'claude-1' }, { id: 'codex-1' }] });
  const pick = dec(L.PRIMARY_TARGET, 'approve', T1, { note: 'codex-1' });
  assert.equal(L.overlayFor({ items: [], accounts: accounts(null) }, [pick], {}).primary, pick);
  assert.equal(L.overlayFor({ items: [], accounts: accounts('claude-1') }, [pick], {}).primary, null);
  assert.equal(L.overlayFor({ items: [], accounts: accounts(null) }, [dec(L.PRIMARY_TARGET, 'approve', T1, { note: 'unknown' })], {}).primary, null);
});

test('the decision queue: groups with an open item first, then open items by severity', () => {
  const state = {
    items: [item('A-1', 'open', { severity: 'low' }), item('A-2', 'open', { severity: 'critical' }), item('A-3', 'fixed', { severity: 'critical' }),
      item('B-1', 'open', { severity: 'high' }), item('B-2', 'open', { severity: 'high', round: 3 }), item('C-1', 'approved')],
    groups: [{ id: 'G-1', title: 't', round: 1, items: ['A-1', 'C-1'] }, { id: 'G-2', title: 'done', round: 1, items: ['A-3', 'C-1'] }],
  };
  assert.deepEqual(L.decisionQueue(state), [
    { kind: 'group', id: 'G-1' }, { kind: 'item', id: 'A-2' }, { kind: 'item', id: 'B-1' }, { kind: 'item', id: 'B-2' },
  ]);
});

test('parseRoute reads every route the page writes, and anything else is the overview', () => {
  assert.deepEqual(L.parseRoute(''), { page: 'overview', q: {} });
  assert.deepEqual(L.parseRoute('#/overview'), { page: 'overview', q: {} });
  assert.deepEqual(L.parseRoute('#/h/acme-shop'), { page: 'harness', harness: 'acme-shop', sub: 'explorer', arg: null, q: {} });
  assert.deepEqual(L.parseRoute('#/h/u1/diagnosis?item=U1-101'), { page: 'harness', harness: 'u1', sub: 'diagnosis', arg: null, q: { item: 'U1-101' } });
  assert.deepEqual(L.parseRoute('#/h/u1/file/fu1-1?at=U1-201.0'), { page: 'harness', harness: 'u1', sub: 'file', arg: 'fu1-1', q: { at: 'U1-201.0' } });
  assert.deepEqual(L.parseRoute('#/h/u1/view/hooks'), { page: 'harness', harness: 'u1', sub: 'view', arg: 'hooks', q: {} });
  assert.deepEqual(L.parseRoute('#/decide/G-1'), { page: 'decide', arg: 'G-1', q: {} });
  assert.deepEqual(L.parseRoute('#/decide'), { page: 'decide', arg: null, q: {} });
  assert.deepEqual(L.parseRoute('#/h/a%20b/view/%E0%A4%A'), { page: 'harness', harness: 'a b', sub: 'view', arg: '%E0%A4%A', q: {} }, 'a broken escape is kept as text');
  for (const other of ['#/h', '#/settings', '#x', 'decide']) assert.equal(L.parseRoute(other).page, other === 'decide' ? 'decide' : 'overview', other);
});

const KNOWN = {
  harnesses: { u1: true, shop: true },
  files: { 'fu1-1': 'u1', 'fshop-1': 'shop' },
  views: { hooks: true, mcp: true },
  targets: { 'G-1': true, 'U1-101': true },
};

test('a route exists only when what it names is in this state', () => {
  const exists = (hash) => L.routeExists(L.parseRoute(hash), KNOWN);
  for (const ok of ['#/overview', '#/decide', '#/decide/summary', '#/decide/G-1', '#/decide/U1-101', '#/h/u1', '#/h/u1/explorer', '#/h/u1/diagnosis', '#/h/u1/diagnosis?item=GONE-1',
    '#/h/shop/impact', '#/h/u1/file/fu1-1', '#/h/u1/file/fu1-1?at=U1-201.0', '#/h/shop/view/mcp']) assert.equal(exists(ok), true, ok);
  for (const gone of ['#/h/ghost', '#/h/ghost/diagnosis', '#/h/u1/file/fshop-1', '#/h/u1/file/f-none', '#/h/u1/file', '#/h/u1/view/secrets', '#/h/u1/view',
    '#/h/u1/settings', '#/decide/U1-999', '#/h/constructor', '#/h/u1/view/constructor', '#/h/u1/file/toString', '#/decide/hasOwnProperty']) assert.equal(exists(gone), false, gone);
  assert.equal(L.routeExists(null, KNOWN), false);
  assert.equal(L.routeExists(L.parseRoute('#/h/u1'), null), false);
  assert.equal(L.routeExists(L.parseRoute('#/h/u1'), {}), false);
});

test('the remembered route is restored only without a hash in the URL and only while it exists', () => {
  const restore = (url, stored) => L.routeToRestore(url, stored, KNOWN);
  assert.equal(restore('', '#/h/u1/view/hooks'), '#/h/u1/view/hooks');
  assert.equal(restore('#', '#/decide/G-1'), '#/decide/G-1');
  assert.equal(restore(undefined, '#/h/shop/diagnosis?item=SHOP-1'), '#/h/shop/diagnosis?item=SHOP-1');
  // The URL names a route: it wins, even when it is the overview or leads nowhere.
  for (const url of ['#/overview', '#/h/u1', '#/', '#/h/ghost', '#x']) assert.equal(restore(url, '#/h/u1/view/hooks'), null, url);
  // Nothing to restore: the overview, a route whose target is gone, or anything that is not a route.
  for (const stored of ['#/overview', '#/', '#/nowhere', '#/h/ghost', '#/h/u1/file/fshop-1', '#/decide/U1-999', 'h/u1', 'javascript:alert(1)', 'https://example.com/#/h/u1',
    '', null, undefined, 42, {}, ['#/h/u1'], `#/h/u1/diagnosis?item=${'x'.repeat(600)}`]) assert.equal(restore('', stored), null, String(stored).slice(0, 40));
  assert.equal(L.routeKey('20260110-ab12'), 'novarc-harness-doctor:20260110-ab12:route');
  assert.notEqual(L.routeKey('a'), L.routeKey('b'), 'one key per run');
});

test('safeStore never throws, whatever the storage does', () => {
  const data = new Map();
  const working = L.safeStore(() => ({ getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, v); } }));
  assert.equal(working.get('k'), null);
  assert.equal(working.set('k', '#/h/u1'), true);
  assert.equal(working.get('k'), '#/h/u1');
  const boom = () => { throw new Error('SecurityError'); };
  const cases = {
    'reaching it throws': L.safeStore(boom),
    'it is missing': L.safeStore(() => undefined),
    'it is null': L.safeStore(() => null),
    'every call throws': L.safeStore(() => ({ getItem: boom, setItem: boom })),
    'it has no methods': L.safeStore(() => ({})),
  };
  for (const [name, store] of Object.entries(cases)) {
    assert.equal(store.get('k'), null, name);
    assert.equal(store.set('k', 'v'), false, name);
  }
  // A full or read-only storage keeps reading; a value that is not a string is not a route.
  const readOnly = L.safeStore(() => ({ getItem: () => '#/decide', setItem: boom }));
  assert.deepEqual([readOnly.get('k'), readOnly.set('k', 'v')], ['#/decide', false]);
  assert.equal(L.safeStore(() => ({ getItem: () => 42 })).get('k'), null);
});

test('unknown is neither "no" nor zero', () => {
  assert.deepEqual([true, false, null, undefined, 0, 1, 'true', 'no', {}].map(L.triState), ['yes', 'no', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
  assert.deepEqual([0, 7, 2.5, null, undefined, '3', NaN, Infinity, true].map(L.countOf), [0, 7, 2.5, null, null, null, null, null, null]);
  const groups = L.wasteGroups([
    { kind: 'loop', episodes: 0, tokens: 0 },
    { kind: 'retry', episodes: 4, tokens: 300 },
    { kind: 'hook-block', episodes: null, tokens: null },
    { kind: 'exploration', episodes: 2, tokens: 900 },
    { kind: 'notfound', tokens: 0 },
    { kind: 'correction', episodes: 1 },
  ]);
  assert.deepEqual(groups.seen.map((x) => x.kind), ['exploration', 'retry', 'correction'], 'most tokens first; a missing token figure goes last');
  assert.deepEqual(groups.quiet.map((x) => x.kind), ['loop'], 'measured, and nothing happened');
  assert.deepEqual(groups.unknown.map((x) => x.kind), ['hook-block', 'notfound'], 'no episode count: not measured');
  assert.deepEqual(L.wasteGroups(undefined), { seen: [], quiet: [], unknown: [] });
});

// --- follow-up: a harness against its last review ----------------------------------------------

/** The formatters the wording helpers take, with dates as written in the state. */
const FMT = { date: (iso) => iso.slice(0, 10), plural, fill, label };
const metric = (name, before, expected, after, verdict, extra = {}) => ({ metric: name, before, expected, after, verdict, ...extra });

test('a metric has a unit, and its change is a fall, a rise or nothing', () => {
  assert.deepEqual(['tokens-per-session', 'weighted-per-session', 'context-at-start', 'context-peak', 'waste:retry', 'waste-share', 'tool-output', 'something-new']
    .map((name) => L.metricUnit({ metric: name })), ['tokens/session', 'tokens/session', 'tokens/session', 'tokens/session', 'tokens/session', 'percent', 'chars/session', 'tokens/session']);
  // What the state says wins over what the name implies; an unknown unit does not.
  assert.equal(L.metricUnit({ metric: 'tool-output', unit: 'tokens/session' }), 'tokens/session');
  assert.equal(L.metricUnit({ metric: 'waste-share', unit: 'furlongs' }), 'percent');
  assert.equal(L.metricUnit({ metric: 'waste-share', unit: 'constructor' }), 'percent');
  assert.equal(L.metricUnit(undefined), 'tokens/session');

  // Lower is better for every metric: a fall is good and a rise is bad.
  assert.deepEqual(L.metricChange(metric('context-at-start', 46000, 37870, 38200, 'confirmed', { changePct: -17 })), { pct: -17, dir: 'down', tone: 'good' });
  assert.deepEqual(L.metricChange(metric('waste:retry', 9800, null, 13592, 'worse', { changePct: 38.7 })), { pct: 38.7, dir: 'up', tone: 'bad' });
  assert.deepEqual(L.metricChange(metric('context-peak', 139000, null, 121000, 'improved')).tone, 'good');
  assert.deepEqual(L.metricChange(metric('waste:notfound', 4400, 1400, 2670, 'partial')).tone, 'good');
  // A verdict that says nothing moved, or that nothing can be said, is never coloured.
  for (const verdict of ['no-change', 'not-enough-data', 'not-measured']) {
    assert.equal(L.metricChange(metric('tokens-per-session', 1262000, null, 1179612, verdict, { changePct: -6.5 })).tone, '', verdict);
    assert.equal(L.metricChange(metric('tokens-per-session', 100, null, 180, verdict)).tone, '', verdict);
  }
  // While the sample is too small no change is coloured, whatever verdict the state carries.
  assert.deepEqual(L.metricChange(metric('waste:retry', 9800, null, 13592, 'worse', { changePct: 38.7 }), true), { pct: 38.7, dir: 'up', tone: '' });
  // Without a changePct the change is computed; with one side not measured there is none.
  assert.deepEqual(L.metricChange(metric('x', 200, null, 150, 'improved')), { pct: -25, dir: 'down', tone: 'good' });
  assert.deepEqual(L.metricChange(metric('x', 200, null, 200, 'improved')), { pct: 0, dir: 'flat', tone: '' });
  assert.deepEqual(L.metricChange(metric('x', 0, null, 50, 'worse')), { pct: null, dir: 'up', tone: 'bad' });
  for (const [before, after] of [[null, 50], [50, null], [undefined, 50], [null, null], ['46000', 50]]) {
    assert.deepEqual(L.metricChange(metric('x', before, null, after, 'worse', { changePct: 12 })), { pct: null, dir: null, tone: '' });
  }
  assert.deepEqual(L.metricChange(undefined), { pct: null, dir: null, tone: '' });
});

test('the one line of a follow-up: N of M expected effects confirmed, or when it will be ready', () => {
  const fu = (metrics, sample = { enough: true }) => ({ of: { runId: 'r', reviewedAt: '2026-10-18T16:20:00Z' }, days: 33, sample, metrics, items: [] });
  const line = (f, lang = 'en') => L.followUpLine(L.followUpSummary(f), STRINGS[lang], FMT);
  const rows = [
    metric('context-at-start', 46000, 37870, 38200, 'confirmed'),
    metric('waste:notfound', 4400, 1400, 2670, 'partial'),
    metric('waste:correction', 21500, 18500, 24599, 'worse'),
    metric('tokens-per-session', 1262000, null, 1179612, 'no-change'), // no expectation: not counted
    metric('context-peak', 139000, undefined, 121000, 'improved'),
    metric('weighted-per-session', null, null, 194412, 'confirmed'), // a verdict without an expectation is not an expected effect
  ];
  assert.deepEqual(L.followUpSummary(fu(rows)), { state: 'effects', confirmed: 1, expected: 3, readyAt: null, reason: null });
  assert.equal(line(fu(rows)), '1 of 3 expected effects confirmed');
  assert.equal(line(fu(rows), 'pt'), '1 de 3 efeitos esperados confirmados');
  assert.equal(line(fu(rows.slice(0, 1))), '1 of 1 expected effect confirmed');
  assert.equal(line(fu(rows.slice(0, 1)), 'pt'), '1 de 1 efeito esperado confirmado');
  assert.equal(line(fu(rows.slice(1, 3))), '0 of 2 expected effects confirmed');
  // Nothing was expected: the line says so and never reads "0 of 0".
  assert.deepEqual(L.followUpSummary(fu(rows.slice(3))).state, 'none');
  assert.equal(line(fu(rows.slice(3))), 'no expected effect to check');
  assert.equal(line(fu([]), 'pt'), 'nenhum efeito esperado para conferir');

  // Too little data: the date it will be ready, else the reason, else that it is not yet.
  const waiting = (sample) => fu(rows, { enough: false, ...sample });
  assert.deepEqual(L.followUpSummary(waiting({ reason: 'too-few-days', readyAt: '2026-11-23T18:00:00Z' })), { state: 'waiting', confirmed: 0, expected: 0, readyAt: '2026-11-23T18:00:00Z', reason: 'too-few-days' });
  assert.equal(line(waiting({ reason: 'too-few-days', readyAt: '2026-11-23T18:00:00Z' })), 'ready to compare on 2026-11-23');
  assert.equal(line(waiting({ reason: 'too-few-days', readyAt: '2026-11-23T18:00:00Z' }), 'pt'), 'pronto para comparar em 2026-11-23');
  assert.equal(line(waiting({ reason: 'too-few-sessions' })), 'too few sessions since the review to compare');
  assert.equal(line(waiting({ reason: 'too-few-sessions', readyAt: 'soon' })), 'too few sessions since the review to compare', 'a date that does not parse is no date');
  assert.equal(line(waiting({ reason: 'not-measured' }), 'pt'), 'sem medição para comparar');
  assert.equal(line(waiting({})), 'not enough data yet');
  assert.equal(line(waiting({ reason: 'toString' })), 'not enough data yet');
  // No follow-up, no line: a first review has none.
  for (const none of [undefined, null, 'x', 5]) assert.equal(L.followUpSummary(none), null);
  // A follow-up without a sample block is read as comparable.
  assert.equal(L.followUpSummary({ metrics: rows }).state, 'effects');
});

test('what a review left: the fixed items apart from the ones it did not apply', () => {
  const items = [
    { id: 'A-1', title: 'a', status: 'fixed', check: 'in-place' }, { id: 'A-2', title: 'b', status: 'declined' }, { id: 'A-3', title: 'c', status: 'fixed', check: 'reverted', now: 'A-9' },
    { id: 'A-4', title: 'd', status: 'deferred' }, { id: 'A-5', title: 'e', status: 'open' }, { id: 'A-6', title: 'f', status: 'failed' }, null, { title: 'no id', status: 'fixed' },
  ];
  const split = L.followUpItems({ items });
  assert.deepEqual(split.fixed.map((i) => i.id), ['A-1', 'A-3']);
  assert.deepEqual(split.carried.map((i) => i.id), ['A-2', 'A-4', 'A-5', 'A-6']);
  for (const none of [undefined, {}, { items: 'x' }]) assert.deepEqual(L.followUpItems(none), { fixed: [], carried: [] });
});

test('the earlier reviews of a harness come out oldest first', () => {
  const history = [
    { runId: 'b', reviewedAt: '2026-10-18T16:20:00Z', score: 76.4, grade: 'B', fixed: 5 },
    { runId: 'a', reviewedAt: '2026-09-14T15:05:00Z', score: 61.5, grade: 'C' },
    { runId: 'c', reviewedAt: '2026-11-01T09:00:00Z', score: null, grade: null },
    { runId: 'd', reviewedAt: 'not a date', score: 90 }, null, { runId: 'e' },
  ];
  assert.deepEqual(L.reviewTrail(history), [
    { runId: 'a', at: '2026-09-14T15:05:00Z', score: 61.5, grade: 'C' },
    { runId: 'b', at: '2026-10-18T16:20:00Z', score: 76.4, grade: 'B' },
    { runId: 'c', at: '2026-11-01T09:00:00Z', score: null, grade: null },
  ]);
  for (const none of [undefined, null, [], 'x', {}]) assert.deepEqual(L.reviewTrail(none), []);
});

test('the history of an item is one line; a previous link alone says nothing', () => {
  const full = { firstSeenAt: '2026-09-14T15:05:00Z', times: 2, lastStatus: 'declined', lastDecisionAt: '2026-10-18T15:48:00Z', lastNote: '  I will fix it in the project.  ' };
  const say = (history, lang = 'en') => L.historyLine(L.itemHistory({ history }), STRINGS[lang], FMT);
  assert.equal(say(full), 'First seen on 2026-09-14 · seen in 2 earlier reviews · declined on 2026-10-18: I will fix it in the project.');
  assert.equal(say(full, 'pt'), 'Visto pela primeira vez em 2026-09-14 · apareceu em 2 revisões anteriores · recusado em 2026-10-18: I will fix it in the project.');
  assert.equal(say({ firstSeenAt: '2026-10-18T16:20:00Z', times: 1, lastStatus: 'fixed' }), 'First seen on 2026-10-18 · seen in 1 earlier review · fixed');
  assert.equal(say({ times: 3, lastStatus: 'deferred', lastDecisionAt: '2026-10-18T15:48:00Z' }), 'Seen in 3 earlier reviews · left for later on 2026-10-18');
  assert.equal(say({ lastStatus: 'open' }, 'pt'), 'Ficou em aberto');
  assert.equal(say({ firstSeenAt: '2026-10-18T16:20:00Z', lastDecisionAt: 'never', times: 0 }), 'First seen on 2026-10-18', 'a date that does not parse and a count of zero are left out');
  // Nothing to say: no history, an empty one, or only the link the reviewer set.
  for (const item of [undefined, {}, { previous: { run: 'r', item: 'A-1' } }, { history: {} }, { history: 'x' }, { history: { lastNote: 'a note without a decision', lastDecisionAt: '2026-10-18T15:48:00Z' } }]) {
    assert.equal(L.itemHistory(item), null, JSON.stringify(item));
  }
});

test('every metric, verdict, check and reason of the schema has a label in both languages', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const fu = schema.$defs.followUp.properties;
  const metricRow = fu.metrics.items.properties;
  const sets = [
    ['metric', schema.$defs.metric.enum, (T) => T.fu.metric],
    ['unit', metricRow.unit.enum, (T) => T.fu.unit],
    ['verdict', metricRow.verdict.enum, (T) => T.fu.verdict],
    ['check', fu.items.items.properties.check.enum, (T) => T.fu.check],
    ['reason', fu.sample.properties.reason.enum, (T) => T.fu.reason],
    ['carried status', fu.items.items.properties.status.enum, (T) => T.status],
    ['last status', schema.properties.items.items.properties.history.properties.lastStatus.enum, (T) => T.hist.status],
  ];
  for (const [what, values, mapOf] of sets) {
    assert.ok(values.length > 0, what);
    for (const lang of ['en', 'pt']) {
      const map = mapOf(STRINGS[lang]);
      assert.deepEqual(values.filter((v) => typeof map[v] !== 'string' || !map[v]), [], `${what} labels in ${lang}`);
    }
  }
  // No label is left over for a value the schema does not have.
  for (const lang of ['en', 'pt']) {
    assert.deepEqual(Object.keys(STRINGS[lang].fu.metric).sort(), [...schema.$defs.metric.enum].sort());
    assert.deepEqual(Object.keys(STRINGS[lang].fu.verdict).sort(), [...metricRow.verdict.enum].sort());
    assert.deepEqual(Object.keys(STRINGS[lang].fu.check).sort(), [...fu.items.items.properties.check.enum].sort());
    // A waste kind reads the same in the follow-up table as in the list of measured waste.
    for (const [kind, text] of Object.entries(STRINGS[lang].waste)) assert.equal(STRINGS[lang].fu.metric[`waste:${kind}`], text, `${lang} waste:${kind}`);
  }
  // Each verdict and check has a tone: a fall is good, a rise is bad, the rest is neutral.
  assert.deepEqual(Object.keys(L.FU_VERDICT_TONE).sort(), [...metricRow.verdict.enum].sort());
  assert.deepEqual(Object.keys(L.FU_CHECK_TONE).sort(), [...fu.items.items.properties.check.enum].sort());
  assert.deepEqual([L.FU_VERDICT_TONE.confirmed, L.FU_VERDICT_TONE.improved, L.FU_VERDICT_TONE.worse], ['ok', 'ok', 'bad']);
  assert.ok(L.FU_VERDICT_TONE.partial.startsWith('ok'));
  for (const neutral of ['no-change', 'not-enough-data', 'not-measured']) assert.ok(!/ok|bad|warn/.test(L.FU_VERDICT_TONE[neutral]), neutral);
  assert.deepEqual([L.FU_CHECK_TONE['in-place'], L.FU_CHECK_TONE.reverted, L.FU_CHECK_TONE.missing, L.FU_CHECK_TONE.changed], ['ok', 'bad', 'bad', 'warn']);
});

test('fleet totals: the measured accounts, or the measured projects when no account was measured', () => {
  const impact = (tokens, total, weighted, weightedTotal, sessions) => ({
    windowDays: 30, sessions, totalTokens: total, ...(weightedTotal ? { weightedTotal } : {}),
    waste: [{ kind: 'retry', episodes: 2, tokens, ...(weighted === null ? {} : { weighted }) }],
  });
  const user = (id, extra = {}) => ({ id, kind: 'user', name: id, path: '~', ...extra });
  const project = (id, extra = {}) => ({ id, kind: 'project', name: id, path: './', ...extra });
  const Inlined = new Function(`${inlineModule(read('scripts', 'lib', 'scoring.mjs'), 'Scoring')}\nreturn Scoring;`)();
  for (const S of [scoring, Inlined]) {
    // An account's impact already contains its sessions in every project: projects are not added.
    const mixed = [
      user('a', { impact: impact(100, 1000, 10, 200, 40) }),
      user('b', { impact: impact(50, 500, 5, 100, 20) }),
      user('c', { activity: { sessions: 7 } }),
      user('d', { activity: { sessions: 9 }, impactSkipped: { reason: 'shared-sessions', with: 'a' } }),
      project('p', { impact: impact(999, 9999, 99, 999, 30) }),
    ];
    assert.deepEqual(S.fleetImpact(mixed), {
      basis: 'accounts', measured: 2, waste: 150, total: 1500, relative: true, relWaste: 15, relTotal: 300,
      sessionsBasis: 'accounts', sessions: 67, sessionsFrom: 3, // 40 + 20 + 7; "d" is measured inside "a"
    });
    // No account measured: the measured projects are added, and so are the projects' sessions.
    const onlyProjects = [user('a', { activity: { sessions: 500 } }), project('p', { impact: impact(30, 300, 3, 60, 12) }), project('q', { impact: impact(20, 200, 2, 40, 8) }), project('r')];
    assert.deepEqual(S.fleetImpact(onlyProjects), {
      basis: 'projects', measured: 2, waste: 50, total: 500, relative: true, relWaste: 5, relTotal: 100,
      sessionsBasis: 'projects', sessions: 20, sessionsFrom: 2,
    });
    // One measured harness without price weights: the share cannot be taken on relative cost.
    const partial = S.fleetImpact([user('a', { impact: impact(100, 1000, 10, 200, 40) }), user('b', { impact: impact(50, 500, null, 0, 20) })]);
    assert.deepEqual([partial.relative, partial.relWaste, partial.relTotal, partial.waste, partial.total], [false, null, null, 150, 1500]);
    // Nothing measured: no basis; sessions still come from one side only.
    assert.deepEqual(S.fleetImpact([user('a', { activity: { sessions: 5 } }), project('p', { activity: { sessions: 3 } })]), {
      basis: null, measured: 0, waste: 0, total: 0, relative: false, relWaste: null, relTotal: null, sessionsBasis: 'accounts', sessions: 5, sessionsFrom: 1,
    });
    assert.deepEqual(S.fleetImpact([]), { basis: null, measured: 0, waste: 0, total: 0, relative: false, relWaste: null, relTotal: null, sessionsBasis: null, sessions: null, sessionsFrom: 0 });
    // wasteOf: relative cost only when every kind with tokens carries a weighted figure.
    assert.deepEqual(S.wasteOf(impact(100, 1000, 10, 200, 4)), { tokens: 100, weighted: 10 });
    assert.deepEqual(S.wasteOf(impact(100, 1000, null, 200, 4)), { tokens: 100, weighted: null });
    assert.deepEqual(S.wasteOf({ totalTokens: 10, weightedTotal: 5, waste: [] }), { tokens: 0, weighted: 0 });
  }
});

test('lib modules inlined into the page behave like the modules themselves', () => {
  const Scoring = new Function(`${inlineModule(read('scripts', 'lib', 'scoring.mjs'), 'Scoring')}\nreturn Scoring;`)();
  const Anchors = new Function(`${inlineModule(read('scripts', 'lib', 'anchors.mjs'), 'Anchors')}\nreturn Anchors;`)();
  assert.deepEqual(Object.keys(Scoring).sort(), Object.keys(scoring).sort());
  assert.deepEqual(Object.keys(Anchors).sort(), Object.keys(anchors).sort());
  const state = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'state.fixture.json'), 'utf8'));
  for (const h of state.harnesses) assert.deepEqual(Scoring.scoreHarness(state, h.id), scoring.scoreHarness(state, h.id));
  assert.deepEqual(JSON.parse(JSON.stringify(Anchors.anchorState(state))), JSON.parse(JSON.stringify(anchors.anchorState(state))));
  assert.throws(() => inlineModule('import x from "y";\nexport const a = 1;', 'M'), /can be inlined/);
  assert.throws(() => inlineModule('const a = 1;\nexport default a;', 'M'), /can be inlined/);
});

test('the client script is valid JavaScript and every fragment is part of it', () => {
  const state = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'state.fixture.json'), 'utf8'));
  const html = renderHtml(state, { lang: 'en', offline: true });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]), 'the inline script parses');
  for (const f of CLIENT_PARTS) {
    assert.ok(fs.existsSync(path.join(BOARD_DIR, f)), `${f} exists`);
    assert.ok(scripts[0].includes(fs.readFileSync(path.join(BOARD_DIR, f), 'utf8').replace(/\r\n/g, '\n').split('\n')[0]), `${f} is inlined`);
  }
  assert.deepEqual(fs.readdirSync(BOARD_DIR).filter((f) => f.endsWith('.js')).sort(), [...CLIENT_PARTS].sort(), 'no fragment is left out of the page');
});
