// The board client's decision logic (templates/board/logic.js) and the way lib modules are
// inlined into the page. The fragment has no DOM in it, so it is loaded here as plain text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR, FIXTURES } from './helpers.mjs';
import { inlineModule, renderHtml, CLIENT_PARTS, BOARD_DIR } from '../scripts/render-board.mjs';
import * as scoring from '../scripts/lib/scoring.mjs';
import * as anchors from '../scripts/lib/anchors.mjs';

const read = (...p) => fs.readFileSync(path.join(SKILL_DIR, ...p), 'utf8');
const NAMES = ['ACTION_STATUS', 'DECIDABLE', 'PRIMARY_TARGET', 'quoteArg', 'decisionCommand', 'uuidFromBytes', 'makeDecision', 'cleanDecision',
  'latestPerTarget', 'groupsOfItems', 'overlayFor', 'effectiveOf', 'effectiveItems', 'decisionQueue'];
const L = new Function(`${read('templates', 'board', 'logic.js')}\nreturn { ${NAMES.join(', ')} };`)();

const item = (id, status, extra = {}) => ({ id, harness: 'h', round: 1, severity: 'medium', class: 'none', status, ...extra });
const dec = (target, action, at, extra = {}) => ({ id: `${target}@${at}`, at, runId: 'run-1', target, action, via: 'board', ...extra });
const T1 = '2026-01-10T10:00:00Z';
const T2 = '2026-01-10T11:00:00Z';
const T3 = '2026-01-10T12:00:00Z';

test('decisionCommand is the exact run.mjs decide line, with a safely quoted note', () => {
  assert.equal(L.decisionCommand(dec('ACME-104', 'approve', T1)), 'run.mjs decide --run run-1 --target ACME-104 --action approve');
  assert.equal(L.decisionCommand(dec('G-1', 'approve', T1, { exclude: ['A-1', 'B-2'] })), 'run.mjs decide --run run-1 --target G-1 --action approve --exclude A-1,B-2');
  assert.equal(L.decisionCommand(dec('A-1', 'ask', T1, { note: 'why "this"\nand $HOME `x`?' })),
    'run.mjs decide --run run-1 --target A-1 --action ask --note "why \\"this\\" and \\$HOME \\`x\\`?"');
  assert.equal(L.decisionCommand(dec('accounts.primary', 'approve', T1, { note: 'claude-1' })), 'run.mjs decide --run run-1 --target accounts.primary --action approve --note "claude-1"');
});

test('makeDecision builds the contract shape and leaves empty fields out', () => {
  assert.deepEqual(L.makeDecision('run-1', 'A-1', 'approve', '  ', [], 'id-1', T1), { id: 'id-1', at: T1, runId: 'run-1', target: 'A-1', action: 'approve', via: 'board' });
  assert.deepEqual(L.makeDecision('run-1', 'G-1', 'decline', ' no ', ['A-2'], 'id-2', T1), { id: 'id-2', at: T1, runId: 'run-1', target: 'G-1', action: 'decline', via: 'board', note: 'no', exclude: ['A-2'] });
  const id = L.uuidFromBytes(new Uint8Array(16).fill(255));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('cleanDecision keeps only well-formed decisions read back from a channel', () => {
  assert.equal(L.cleanDecision(null), null);
  assert.equal(L.cleanDecision({ target: 'A-1', action: 'delete-everything', at: T1 }), null);
  assert.equal(L.cleanDecision({ target: 'A-1', action: 'approve', at: 'yesterday' }), null);
  assert.equal(L.cleanDecision({ action: 'approve', at: T1 }), null, 'no target');
  assert.deepEqual(L.cleanDecision({ action: 'approve', at: T1, exclude: ['A-2', 7, ''], note: 5, extra: { nested: true } }, 'G-1'),
    { id: `G-1@${T1}`, at: T1, runId: '', target: 'G-1', action: 'approve', via: 'board', exclude: ['A-2'] });
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
