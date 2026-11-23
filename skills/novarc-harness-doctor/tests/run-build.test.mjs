// run.mjs build: the merge of run.json, probes, findings, status and decisions into state.json.
// The renderer is a stub (NOVARC_HD_SCRIPT_RENDER_BOARD); the state is checked against the real
// schema in templates/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, securityFindings, item } from './run-helpers.mjs';
import { loadStateSchema, validate, prune } from '../scripts/lib/run/schema.mjs';
import { tmpDir, rmrf } from './helpers.mjs';

function ready(t, opts) {
  const sb = sandbox(t, opts);
  assert.equal(sb.init(['--title', 'Ana', '--lang', 'pt']).code, 0);
  assert.equal(sb.run(['probe']).code, 0);
  return sb;
}
const strip = (text) => { const s = JSON.parse(text); for (const h of s.harnesses) delete h.scores; return JSON.stringify(s); };

test('the state follows the schema and merges probes, findings and settings', (t) => {
  const sb = ready(t);
  assert.equal(sb.complete('review:security', securityFindings()).code, 0);
  const b = sb.run(['build', '--channel', 'server', '--agent', 'codex']);
  assert.equal(b.code, 0, b.stdout + b.stderr);
  assert.equal(b.json.rendered, true);
  assert.equal(b.json.items, 5);
  assert.equal(b.json.groups, 1);
  const state = sb.read('state.json');
  const { schema } = loadStateSchema();
  assert.deepEqual(validate(state, schema), [], 'state.json is valid against templates/state.schema');

  assert.equal(state.schemaVersion, 2);
  assert.equal(state.mode, 'guided');
  assert.equal(state.language, 'pt');
  assert.deepEqual(state.run, { id: sb.runId, title: 'Ana', startedAt: sb.read('run.json').createdAt, lastRun: state.run.lastRun, windowDays: 30 });
  assert.equal(state.environment.agent, 'codex');
  assert.equal(state.environment.channel, 'server');
  assert.equal(sb.read('run.json').environment.channel, 'server', 'the channel is remembered for the next build');
  assert.match(sb.text('board.html'), /channel server, items 5/, 'the renderer ran with the channel');

  // Harnesses: identity from run.json, project/activity from the snapshot, impact pruned to the schema.
  const acme = state.harnesses.find((h) => h.id === 'acme-shop');
  assert.deepEqual({ kind: acme.kind, name: acme.name, path: acme.path }, { kind: 'project', name: 'acme-shop', path: '~/dev/acme-shop' });
  assert.deepEqual(acme.project, { isCode: true, defaultBranch: 'main' });
  assert.deepEqual(acme.activity, { sessions: 7 });
  assert.equal(acme.impact.totalTokens, 9000);
  assert.deepEqual(acme.impact.estimates, [{ label: 'Compact shell output', tool: 'rtk', tokens: 4000, source: 'catalog factor x measured output' }], 'estimates from their own probe file, pruned to the schema');
  assert.equal(acme.impact.windowDays, 30);
  assert.ok(!('method' in acme.impact) && !('sources' in acme.impact), 'diagnostic fields of the probe are not part of the state');
  // Which impact keys survive is decided by the schema file at run time, not by a list in build:
  // every key of the probe that `$defs.impact` allows is kept, every other one is dropped.
  const impactProps = schema.$defs.impact.properties;
  const measured = sb.read('probes', 'acme-shop', 'impact.json');
  for (const k of Object.keys(measured)) assert.equal(k in acme.impact, k in impactProps, `impact.${k}`);
  for (const k of Object.keys(measured.contextAtStart)) assert.equal(k in acme.impact.contextAtStart, k in impactProps.contextAtStart.properties, `impact.contextAtStart.${k}`);
  for (const k of Object.keys(measured.waste[0])) assert.equal(k in acme.impact.waste[0], k in impactProps.waste.items.properties, `impact.waste[].${k}`);
  assert.equal(acme.impact.weightedTotal, 1234);
  assert.equal(acme.impact.waste[0].weighted, 150);
  assert.equal(acme.impact.waste.length, 1, 'the waste entry of an unknown kind is dropped');
  assert.deepEqual({ kind: acme.impact.waste[0].kind, episodes: acme.impact.waste[0].episodes, tokens: acme.impact.waste[0].tokens, topHeads: acme.impact.waste[0].topHeads }, { kind: 'retry', episodes: 2, tokens: 120, topHeads: ['npm test'] });
  const claude = state.harnesses.find((h) => h.id === 'claude-1');
  assert.deepEqual({ provider: claude.provider, account: claude.account }, { provider: 'claude-code', account: 'claude-1' });
  assert.ok(!('project' in claude), 'a user harness has no project block');
  assert.equal(claude.impact.totalTokens, 5000);

  // Accounts, from run.json and the account comparison probe.
  assert.equal(state.accounts.primary, 'claude-1');
  assert.equal(state.accounts.syncInstalled, false);
  assert.deepEqual(state.accounts.list.map((a) => [a.id, a.harness, a.path]), [['claude-1', 'claude-1', '~/.claude'], ['codex-1', 'codex-1', '~/.codex']]);
  assert.deepEqual(state.accounts.list[0].sync, { mode: 'primary', status: 'ok', detail: 'the source the other accounts follow', elements: [] });
  assert.equal(state.accounts.list.length, 2, 'an account the comparison found but the run did not select stays out');
  assert.equal(state.accounts.list[1].sync.mode, 'replicated');
  assert.deepEqual(state.accounts.list[1].sync.elements, [{ name: 'AGENTS.md', state: 'generated' }, { name: 'skills/', state: 'divergent', note: 'one skill differs' }]);

  // Files from the snapshots: the entry the schema rejects is dropped, roles applied, changes linked.
  assert.equal(state.files.length, 8);
  assert.ok(!state.files.some((f) => f.path.endsWith('odd.bin')));
  const file = state.files.find((f) => f.id === 'facme-shop-1');
  assert.equal(file.role, 'The rules every session starts with.');
  assert.ok(!('debug' in file));
  assert.equal(state.items.find((i) => i.id === 'ACME-101').changes[0].file, 'facme-shop-1', 'a change is linked to its file by path');
  assert.equal(state.items.find((i) => i.id === 'U1-101').changes[0].file, 'fclaude-1-1');
  assert.ok(b.json.mergeWarnings.some((w) => /files/.test(w.source) && /dropped/.test(w.problem)));
  assert.ok(b.json.mergeWarnings.some((w) => /impact\.json waste/.test(w.source)));
  assert.ok(b.json.mergeWarnings.some((w) => /diff\.json elements/.test(w.source)));

  // Layers: the reviewer's note lands on the snapshot's layer of the same name.
  const layer = state.layers.find((l) => l.harness === 'acme-shop');
  assert.deepEqual(layer, { harness: 'acme-shop', name: 'CLAUDE.md', kind: 'instructions', file: 'facme-shop-1', tokens: 7, basis: 'estimated', note: 'Loaded in every session.' });
  assert.equal(state.layers.length, 4);
  assert.equal(state.inventory[0].item, 'ACME-101');
  assert.deepEqual(state.defenses, [{ harness: 'acme-shop', title: 'Force-push is blocked', detail: 'PreToolUse hook' }]);
  assert.equal(state.leads.length, 1);
  assert.match(state.log[0].text, /Revisão iniciada com 4 harness/);
  assert.ok(state.log.some((l) => /review:security/.test(l.text)));
});

test('element annotations are merged by name (hooks by id) onto the snapshot, never replacing it', (t) => {
  const sb = ready(t);
  const f = securityFindings();
  f.elements['acme-shop'].skills.push({ name: 'ghost', verdict: 'retire', reason: 'Not in the snapshot.' });
  f.elements['acme-shop'].mcp = [{ name: 'github', level: 'user', cli: 'gh', note: 'The CLI covers it.' }, { name: 'github', level: 'project', note: 'Wrong level: no match.' }];
  f.elements['acme-shop'].docs = [{ path: './README.md', status: 'stale', reader: 'developer' }];
  assert.equal(sb.complete('review:security', f).code, 0);
  const b = sb.run(['build']);
  assert.equal(b.code, 0, b.stdout);
  const el = sb.read('state.json').harnesses.find((h) => h.id === 'acme-shop').elements;
  assert.deepEqual(el.skills[0], { name: 'alpha', level: 'user', description: 'Alpha skill', invocations: 0, file: 'facme-shop-1', verdict: 'retire', reason: 'Never invoked in the window.', item: 'ACME-102' });
  assert.deepEqual(el.skills[1], { name: 'beta', level: 'user', description: 'Beta skill', invocations: 4 }, 'an element nobody annotated is untouched');
  assert.equal(el.skills.length, 2, 'a reviewer cannot add to the base inventory');
  assert.deepEqual(el.hooks[0], { id: 'hook-1', source: 'agent', event: 'PreToolUse', matcher: 'Bash', blocking: true, note: 'Blocks force-push.' });
  assert.deepEqual(el.mcp[0], { name: 'github', level: 'user', transport: 'remote', calls: 0, cli: 'gh', note: 'The CLI covers it.' });
  assert.deepEqual(el.docs[0], { path: './README.md', bytes: 100, status: 'stale', reader: 'developer' });
  const dropped = b.json.mergeWarnings.filter((w) => /annotation dropped/.test(w.problem));
  assert.equal(dropped.length, 2);
  assert.ok(dropped.some((w) => /skills: no entry "ghost"/.test(w.problem)));
  // Another harness's elements are not touched by this harness's annotations.
  assert.ok(!('verdict' in sb.read('state.json').harnesses.find((h) => h.id === 'novarc-powers').elements.skills[0]));
});

test('rounds default to pending, round 3 is not-applicable for a user harness, reviewers win', (t) => {
  const sb = ready(t);
  assert.equal(sb.complete('review:security', securityFindings()).code, 0);
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  const rounds = sb.read('state.json').rounds;
  assert.equal(rounds.length, 32, '4 harnesses x 8 rounds');
  const of = (h, r) => rounds.find((x) => x.harness === h && x.round === r);
  assert.deepEqual(of('claude-1', 1), { harness: 'claude-1', round: 1, status: 'done' });
  assert.deepEqual(of('codex-1', 1), { harness: 'codex-1', round: 1, status: 'skipped', note: 'nothing to read' });
  assert.equal(of('acme-shop', 1).status, 'done');
  assert.equal(of('claude-1', 3).status, 'not-applicable');
  assert.equal(of('codex-1', 3).status, 'not-applicable');
  assert.equal(of('acme-shop', 3).status, 'pending');
  assert.equal(rounds.filter((r) => r.status === 'pending').length, 32 - 4 - 2);
  assert.deepEqual(rounds.slice(0, 8).map((r) => r.round), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(!sb.exists('board.html'), '--no-render writes the state only');
});

test('build is deterministic: the same inputs give the same bytes', (t) => {
  const sb = ready(t);
  assert.equal(sb.complete('review:security', securityFindings()).code, 0);
  assert.equal(sb.complete('review:gates', { rounds: [{ harness: 'acme-shop', round: 4, status: 'done' }], items: [item('ACME-401', 'acme-shop', 4), item('NP-401', 'novarc-powers', 4)], groups: [{ title: 'Same gate', round: 4, items: ['ACME-401', 'NP-401'] }] }).code, 0);
  sb.run(['decide', '--target', 'ACME-101', '--action', 'approve', '--note', 'go ahead']);
  sb.run(['decide', '--target', 'G-1', '--action', 'defer']);

  assert.equal(sb.run(['build', '--no-render']).code, 0);
  const first = sb.text('state.json');
  const mtime = fs.statSync(sb.file('state.json')).mtimeMs;
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  assert.equal(sb.text('state.json'), first, 'two builds without a renderer are byte-identical');
  assert.equal(fs.statSync(sb.file('state.json')).mtimeMs, mtime, 'an unchanged state is not rewritten');

  // With a renderer that writes scores: identical apart from the scores, and identical in full
  // once the scores are there, because build carries them over instead of dropping them.
  assert.equal(sb.run(['build'], { STUB_SCORES: '1' }).code, 0);
  const scored = sb.text('state.json');
  assert.equal(strip(scored), strip(first));
  assert.equal(JSON.parse(scored).harnesses[2].scores.current, 98, 'the stub scores 100 minus the open items: ACME-102 and ACME-401');
  assert.equal(sb.run(['build'], { STUB_SCORES: '1' }).code, 0);
  assert.equal(sb.text('state.json'), scored, 'a rebuild keeps the renderer\'s scores byte for byte');

  // A change in the inputs changes the state; undoing nothing else moves.
  sb.run(['decide', '--target', 'NP-101', '--action', 'decline']);
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  const third = JSON.parse(sb.text('state.json'));
  assert.equal(third.items.find((i) => i.id === 'NP-101').status, 'declined');
  assert.equal(third.harnesses[2].scores.current, 98, 'scores survive a build that does not render');
  assert.deepEqual(third.items.map((i) => i.id), ['U1-101', 'ACME-101', 'ACME-102', 'ACME-401', 'NP-101', 'NP-102', 'NP-401'], 'items are ordered by harness, round, number');
});

test('group ids are stable when another unit completes later', (t) => {
  const sb = ready(t);
  // review:gates completes first although review:security comes first in the queue.
  const gates = { items: [item('ACME-401', 'acme-shop', 4), item('NP-401', 'novarc-powers', 4), item('U1-401', 'claude-1', 4)], groups: [{ title: 'Same gate', round: 4, summary: 'Three places.', items: ['ACME-401', 'NP-401', 'U1-401'] }] };
  assert.equal(sb.complete('review:gates', gates).code, 0);
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  let state = sb.read('state.json');
  assert.deepEqual(state.groups, [{ id: 'G-1', title: 'Same gate', round: 4, items: ['ACME-401', 'NP-401', 'U1-401'], summary: 'Three places.' }]);
  assert.equal(state.items.find((i) => i.id === 'NP-401').group, 'G-1');
  sb.run(['decide', '--target', 'G-1', '--action', 'approve', '--exclude', 'U1-401']);

  assert.equal(sb.complete('review:security', securityFindings()).code, 0);
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  state = sb.read('state.json');
  assert.deepEqual(state.groups.map((g) => [g.id, g.title]), [['G-1', 'Same gate'], ['G-2', 'Same wording problem in two projects']], 'the earlier group keeps its id');
  assert.equal(state.items.find((i) => i.id === 'ACME-101').group, 'G-2');
  assert.equal(state.decisions[0].target, 'G-1');
  assert.deepEqual(state.decisions[0].exclude, ['U1-401']);

  // Re-completing with the same group keeps the id; a different set of items is a new group.
  assert.equal(sb.complete('review:gates', { ...gates, groups: [{ title: 'Same gate, reworded', round: 4, items: ['U1-401', 'NP-401', 'ACME-401'] }] }).code, 0);
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  assert.deepEqual(sb.read('state.json').groups.map((g) => [g.id, g.title]), [['G-1', 'Same gate, reworded'], ['G-2', 'Same wording problem in two projects']]);
  assert.equal(sb.complete('review:gates', { ...gates, groups: [{ title: 'Only the projects', round: 4, items: ['NP-401', 'ACME-401'] }] }).code, 0);
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  assert.deepEqual(sb.read('state.json').groups.map((g) => g.id), ['G-2', 'G-3'], 'G-1 is retired, never reused');
});

test('estimates, inherited files and previous scores', (t) => {
  const sb = sandbox(t, { accounts: 2, linksInto: 'claude-1' });
  sb.init();
  assert.equal(sb.read('run.json').harnesses[1].inherits, 'claude-1');
  assert.equal(sb.run(['probe'], { STUB_LINKED: 'codex-1' }).code, 0);
  fs.writeFileSync(sb.file('probes', 'acme-shop', 'estimates.json'), JSON.stringify({ estimates: [{ label: 'Compact shell output', tool: 'rtk', tokens: 4000, source: 'catalog factor x measured output', extra: 1 }, { label: 'no source', tokens: 1 }] }));
  fs.rmSync(sb.file('probes', 'novarc-powers', 'impact.json'));
  fs.writeFileSync(sb.file('probes', 'novarc-powers', 'estimates.json'), JSON.stringify({ estimates: [{ label: 'x', tokens: 1, source: 's' }] }));
  const b = sb.run(['build'], { STUB_SCORES: '1' });
  assert.equal(b.code, 0, b.stdout);
  const state = sb.read('state.json');
  assert.deepEqual(state.harnesses.find((h) => h.id === 'acme-shop').impact.estimates, [{ label: 'Compact shell output', tool: 'rtk', tokens: 4000, source: 'catalog factor x measured output' }]);
  assert.ok(!('impact' in state.harnesses.find((h) => h.id === 'novarc-powers')));
  assert.ok(b.json.mergeWarnings.some((w) => /estimates need the measured impact/.test(w.problem)));

  const codex = state.harnesses.find((h) => h.id === 'codex-1');
  assert.equal(codex.inherits, 'claude-1');
  const linked = state.files.find((f) => f.id === 'fcodex-1-4');
  assert.equal(linked.inheritedFrom, 'claude-1', 'a file that links into the inherited harness is marked');
  assert.ok(!('inheritedFrom' in state.files.find((f) => f.id === 'fcodex-1-1')));
  // Its text is still here: the file it links to is not in the run.
  assert.equal(linked.content, 'alpha');
  assert.ok(!('omitted' in linked));

  // With the owner in the run, the linked file carries no text of its own.
  assert.equal(sb.run(['probe'], { STUB_LINKED: 'codex-1', STUB_OWNER: 'claude-1' }).code, 0);
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  const deduped = sb.read('state.json').files.find((f) => f.id === 'fcodex-1-4');
  assert.equal(deduped.omitted, 'linked');
  assert.equal(deduped.content, '');
  assert.equal(deduped.inheritedFrom, 'claude-1');
  assert.equal(sb.read('state.json').files.find((f) => f.id === 'fclaude-1-5').content, 'alpha');

  // The next run starts from this run's scores: `previous` is seeded for the same harness.
  assert.equal(sb.init().code, 0);
  assert.equal(sb.read('run.json').previousScores['acme-shop'], 100);
  assert.equal(sb.run(['probe']).code, 0);
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  assert.deepEqual(sb.read('state.json').harnesses.find((h) => h.id === 'acme-shop').scores, { previous: 100 });
});

test('renderer warnings pass through; a renderer failure keeps the state and fails the command', (t) => {
  const sb = ready(t);
  assert.equal(sb.complete('review:security', securityFindings()).code, 0);
  const warned = sb.run(['build'], { STUB_RENDER_WARN: '1' });
  assert.equal(warned.code, 0);
  assert.deepEqual(warned.json.warnings, [{ item: 'ACME-101', change: 0, problem: 'before text not found in the file' }]);
  assert.equal(warned.json.language, 'pt');

  const before = sb.text('state.json');
  const failed = sb.run(['build'], { STUB_FAIL: 'render-board' });
  assert.equal(failed.code, 1);
  assert.equal(failed.json.ok, false);
  assert.equal(failed.json.rendered, false);
  assert.match(failed.json.error, /state\.json was written, but the board was not rendered/);
  assert.equal(sb.text('state.json'), before);
  const missing = sb.run(['build'], { NOVARC_HD_SCRIPT_RENDER_BOARD: path.join(sb.stubDir, 'gone.mjs') });
  assert.equal(missing.code, 1);
  assert.match(missing.json.render.error, /not found/);
  assert.equal(sb.run(['build', '--channel', 'pigeon']).code, 2);
  assert.equal(sb.run(['build', '--agent', 'hal']).code, 2);
});

test('a build with no probes and no findings still gives a valid, empty state', (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop'] });
  sb.init();
  const b = sb.run(['build', '--no-render']);
  assert.equal(b.code, 0, b.stdout);
  const state = sb.read('state.json');
  assert.deepEqual(validate(state, loadStateSchema().schema), []);
  assert.ok(!('accounts' in state), 'no account selected: no accounts section');
  assert.deepEqual(state.harnesses, [{ id: 'acme-shop', kind: 'project', name: 'acme-shop', path: '~/dev/acme-shop' }]);
  assert.deepEqual([state.files, state.items, state.groups, state.inventory, state.decisions], [[], [], [], [], []]);
  assert.equal(state.rounds.length, 8);
  assert.equal(state.environment.channel, 'file');
});

test('the schema decides what is kept: the schema file of the renderer wins, and new impact keys pass once it allows them', (t) => {
  const dir = tmpDir('hd-schema-');
  t.after(() => rmrf(dir));
  const real = loadStateSchema().schema;
  const put = (name, schema) => fs.writeFileSync(path.join(dir, name), JSON.stringify(schema));
  const v1 = { properties: { schemaVersion: { const: 1 } } };

  assert.equal(loadStateSchema(dir), null, 'no schema in the folder');
  put('state.schema.v2.json', real);
  assert.equal(loadStateSchema(dir).file, 'state.schema.v2.json');
  put('state.schema.json', v1);
  assert.equal(loadStateSchema(dir).file, 'state.schema.v2.json', 'a v1 state.schema.json is passed over');
  // The renamed schema, already ahead of the copy left beside it.
  const next = JSON.parse(JSON.stringify(real));
  const impact = next.$defs.impact.properties;
  impact.weightedByKind = { type: 'object', additionalProperties: false, properties: { input: { type: 'integer' }, output: { type: 'integer' } } };
  impact.weights = { type: 'object' };
  impact.contextAtStart.properties.weightedTotal = { type: 'integer' };
  put('state.schema.json', next);
  const loaded = loadStateSchema(dir);
  assert.equal(loaded.file, 'state.schema.json', 'the file render-board.mjs validates against wins once it is v2');

  const measured = {
    windowDays: 30, sessions: 3, totalTokens: 9000, weightedTotal: 1234, method: 'not in any schema',
    weightedByKind: { input: 100, output: 2000, bogus: 1 }, weights: { input: 1, output: 5, anything: 0.1 },
    contextAtStart: { perSessionMedian: 10, total: 30, weightedTotal: 33, method: 'dropped' },
    waste: [{ kind: 'retry', episodes: 2, tokens: 120, weighted: 150, label: 'dropped' }],
  };
  const kept = prune(measured, loaded.schema.$defs.impact, loaded.schema);
  assert.deepEqual(kept, {
    windowDays: 30, sessions: 3, totalTokens: 9000, weightedTotal: 1234,
    weightedByKind: { input: 100, output: 2000 }, weights: { input: 1, output: 5, anything: 0.1 },
    contextAtStart: { perSessionMedian: 10, total: 30, weightedTotal: 33 },
    waste: [{ kind: 'retry', episodes: 2, tokens: 120, weighted: 150 }],
  });
  assert.deepEqual(validate(kept, loaded.schema.$defs.impact, loaded.schema), []);
  assert.ok('method' in measured, 'prune copies; the probe output is untouched');
});
