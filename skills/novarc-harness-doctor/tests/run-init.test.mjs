// run.mjs init / list / close: harness ids and keys, the run directory, and the rule that
// absolute paths stay in run.json and never reach state.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, securityFindings } from './run-helpers.mjs';
import { slugify, projectKeyCandidates, uniqueProjectKey, assignHarnesses } from '../scripts/lib/run/ids.mjs';
import { staticUnits } from '../scripts/lib/run/units.mjs';
import { newRunId, unitFileName, scriptEnvName } from '../scripts/lib/run/paths.mjs';

test('init assigns ids and keys, writes the run directory and records the latest run', (t) => {
  const sb = sandbox(t);
  const r = sb.init(['--mode', 'doctor', '--days', '14', '--lang', 'pt', '--title', 'Ana']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.json.runId, /^\d{8}-[a-z0-9]{4}$/);
  assert.deepEqual(r.json.harnesses.map((h) => [h.id, h.key, h.kind]), [
    ['claude-1', 'U1', 'user'], ['codex-1', 'U2', 'user'], ['acme-shop', 'ACME', 'project'], ['novarc-powers', 'NP', 'project'],
  ]);
  assert.deepEqual(r.json.units, ['review:security', 'review:instructions', 'review:gates', 'review:skills-tools', 'review:cleanup-deps', 'accounts']);
  assert.ok(r.json.dir.startsWith(sb.home), 'the run lives under NOVARC_POWERS_HOME');

  const run = sb.read('run.json');
  assert.equal(run.mode, 'doctor');
  assert.equal(run.windowDays, 14);
  assert.equal(run.language, 'pt');
  assert.equal(run.title, 'Ana');
  assert.equal(run.primary, 'claude-1');
  assert.equal(run.closed, false);
  assert.equal(run.harnesses[2].pathAbs, path.join(sb.home, 'dev', 'acme-shop'), 'run.json keeps the absolute path');
  assert.equal(run.accounts[0].harness, 'claude-1');
  assert.equal(run.environment.os, process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux');

  const queue = sb.read('queue.json');
  assert.equal(queue.units.length, 6);
  assert.ok(queue.units.every((u) => u.status === 'pending'));
  assert.deepEqual(queue.units[1].rounds, [2, 3]);
  assert.deepEqual(queue.units[5].harnesses, ['claude-1', 'codex-1'], 'the accounts unit covers the user harnesses');
  for (const d of ['claims', 'probes', 'findings', 'backups', 'drafts']) assert.ok(fs.statSync(sb.file(d)).isDirectory(), d);
  assert.deepEqual(sb.read('ledger.json').entries, []);
  const latest = JSON.parse(fs.readFileSync(path.join(sb.home, '.novarc-powers', 'novarc-harness-doctor', 'latest.json'), 'utf8'));
  assert.equal(latest.runId, r.json.runId);
});

test('init dedupes ids and keys, links an inheriting account, and masks a full e-mail', (t) => {
  const sb = sandbox(t, { accounts: 2, projects: [] });
  const mk = (rel) => { const p = path.join(sb.home, rel); fs.mkdirSync(p, { recursive: true }); return p; };
  const sel = {
    accounts: [
      { ...sb.selection.accounts[0], identity: 'someone@example.com' },
      { ...sb.selection.accounts[1], id: 'claude-2', provider: 'claude-code', label: 'Claude Code · account 2', linksInto: 'claude-1' },
    ],
    primary: null,
    projects: [
      { name: 'acme-shop', path: '~/a/acme-shop', pathAbs: mk('a/acme-shop') },
      { name: 'acme-shop', path: '~/b/acme-shop', pathAbs: mk('b/acme-shop') },
      { name: 'Acme Site', path: '~/acme-site', pathAbs: mk('acme-site') },
      { name: 'accounts', path: '~/accounts', pathAbs: mk('accounts') },
      { name: 'u1', path: '~/u1', pathAbs: mk('u1') },
      mk('plain-path'),
    ],
  };
  const r = sb.init([], sel);
  assert.equal(r.code, 0, r.stderr);
  const hs = r.json.harnesses;
  assert.deepEqual(hs.map((h) => h.id), ['claude-1', 'claude-2', 'acme-shop', 'acme-shop-2', 'acme-site', 'accounts-2', 'u1', 'plain-path']);
  assert.equal(hs[1].inherits, 'claude-1');
  assert.equal(new Set(hs.map((h) => h.key)).size, hs.length, 'keys are unique');
  for (const h of hs.slice(2)) assert.match(h.key, /^[A-Z][A-Z0-9]{1,4}$/, `${h.id} -> ${h.key}`);
  assert.equal(hs[2].key, 'ACME');
  assert.notEqual(hs[6].key, 'U1', 'a project never takes a user key');
  assert.equal(hs[7].path, '~/plain-path', 'a bare path gets its display form');
  const run = sb.read('run.json');
  assert.equal(run.accounts[0].identity, 'so…@example.com');
  assert.equal(run.primary, null);
  assert.equal(run.harnesses[1].inherits, 'claude-1');
});

test('init rejects a bad command line or selection with exit 2 and writes nothing', (t) => {
  const sb = sandbox(t);
  const runs = path.join(sb.home, '.novarc-powers', 'novarc-harness-doctor', 'runs');
  assert.equal(sb.run(['init']).code, 2);
  assert.equal(sb.init(['--mode', 'fast']).code, 2);
  assert.equal(sb.init(['--lang', 'fr']).code, 2);
  assert.equal(sb.init(['--days', '0']).code, 2);
  assert.equal(sb.init(['--title', 'someone@example.com']).code, 2, 'a title is never an e-mail');
  assert.equal(sb.init([], { ...sb.selection, primary: 'nobody' }).code, 2);
  assert.equal(sb.init([], { accounts: [], primary: null, projects: [] }).code, 2);
  assert.equal(sb.init([], { accounts: ['claude-1'], primary: null, projects: [] }).code, 2, 'accounts must be objects');
  assert.equal(sb.init([], { accounts: [], primary: null, projects: [{ name: 'x', path: '~/x', pathAbs: 'relative/x' }] }).code, 2);
  assert.equal(sb.init([], { accounts: [], primary: null, projects: [{ name: 'x', path: '~/x', pathAbs: path.join(sb.home, 'missing') }] }).code, 2);
  const bad = sb.init(['--mode', 'fast']);
  assert.equal(bad.json.ok, false);
  assert.ok(!fs.existsSync(runs) || fs.readdirSync(runs).length === 0, 'no run directory was created');
});

test('units are chunked by 6 harnesses, and the accounts unit needs two accounts', () => {
  const harnesses = Array.from({ length: 13 }, (_, i) => ({ id: `h${i}`, kind: i < 1 ? 'user' : 'project' }));
  const units = staticUnits({ harnesses, accounts: [{ id: 'a' }] });
  assert.equal(units.length, 15, '5 review units x 3 chunks, no accounts unit');
  assert.deepEqual(units.slice(0, 3).map((u) => u.id), ['review:security#1', 'review:security#2', 'review:security#3']);
  assert.deepEqual(units.slice(0, 3).map((u) => u.harnesses.length), [6, 6, 1]);
  assert.deepEqual(staticUnits({ harnesses: harnesses.slice(0, 6), accounts: [] }).map((u) => u.id), ['review:security', 'review:instructions', 'review:gates', 'review:skills-tools', 'review:cleanup-deps']);
  assert.equal(staticUnits({ harnesses: harnesses.slice(0, 2), accounts: [{ id: 'a' }, { id: 'b' }] }).at(-1).id, 'accounts');
});

test('key and id helpers', () => {
  assert.equal(projectKeyCandidates('acme-shop')[0], 'ACME');
  assert.equal(projectKeyCandidates('novarc-powers')[0], 'NP');
  assert.equal(projectKeyCandidates('dashboard')[0], 'DASH');
  assert.equal(projectKeyCandidates('myCoolApp')[0], 'MY');
  assert.equal(projectKeyCandidates('3d-viewer')[0], 'DV');
  const taken = new Set();
  const keys = Array.from({ length: 40 }, () => uniqueProjectKey('acme-shop', taken));
  assert.equal(new Set(keys).size, 40);
  for (const k of keys) assert.match(k, /^[A-Z][A-Z0-9]{1,4}$/);
  assert.match(uniqueProjectKey('2048', new Set()), /^[A-Z][A-Z0-9]{1,4}$/);
  assert.equal(slugify('Ação & Reação!'), 'acao-reacao');
  assert.equal(slugify('***'), 'harness');
  assert.match(newRunId(new Date(2026, 0, 5)), /^20260105-[a-z0-9]{4}$/);
  assert.equal(unitFileName('review:security#2'), 'review.security.2');
  assert.equal(scriptEnvName('snapshot-harness.mjs'), 'NOVARC_HD_SCRIPT_SNAPSHOT_HARNESS');
  const { harnesses } = assignHarnesses([{ id: 'a-1', label: 'A', path: '~/.a', pathAbs: 'x', provider: 'other' }], [{ name: 'a-1', path: '~/a-1', pathAbs: 'y' }]);
  assert.deepEqual(harnesses.map((h) => h.id), ['a-1', 'a-1-2'], 'an account and a project never share an id');
});

test('nothing absolute reaches state.json; run.json keeps the absolute paths', (t) => {
  const sb = sandbox(t);
  assert.equal(sb.init(['--title', 'Ana']).code, 0);
  assert.equal(sb.run(['probe']).code, 0);
  assert.equal(sb.complete('review:security', securityFindings()).code, 0);
  const b = sb.run(['build', '--channel', 'file']);
  assert.equal(b.code, 0, b.stdout + b.stderr);
  const stateText = sb.text('state.json');
  const forms = [sb.home, sb.home.replace(/\\/g, '/'), sb.home.replace(/\\/g, '\\\\')];
  if (process.platform === 'win32') forms.push(`/${sb.home[0].toLowerCase()}/${sb.home.slice(3).replace(/\\/g, '/')}`);
  for (const f of forms) assert.ok(!stateText.toLowerCase().includes(f.toLowerCase()), 'state.json holds no absolute home path');
  assert.ok(!stateText.includes('pathAbs'));
  const state = JSON.parse(stateText);
  assert.deepEqual(state.harnesses.map((h) => h.path), ['~/.claude', '~/.codex', '~/dev/acme-shop', '~/dev/novarc-powers']);
  // The stub snapshot leaked its --cwd into a file's content: build replaced it and said so.
  assert.ok(state.files.find((f) => f.id === 'facme-shop-2').content.includes('~'));
  assert.ok(b.json.mergeWarnings.some((w) => /absolute home path replaced/.test(w.problem)));
  assert.ok(sb.text('run.json').includes(JSON.stringify(sb.home).slice(1, -1)), 'run.json is local and keeps pathAbs');
});

test('list shows runs newest first; close marks the run closed', (t) => {
  const sb = sandbox(t);
  const first = sb.init().json.runId;
  const second = sb.init(['--title', 'Second']).json.runId;
  const list = sb.run(['list']).json.runs;
  assert.deepEqual(new Set(list.map((r) => r.runId)), new Set([first, second]));
  assert.equal(list.find((r) => r.runId === second).latest, true);
  assert.equal(list.find((r) => r.runId === first).latest, false);
  assert.ok(list[0].createdAt >= list[1].createdAt);

  const c = sb.run(['close', '--run', first]);
  assert.equal(c.code, 0);
  assert.equal(c.json.closed, true);
  assert.equal(sb.run(['close', '--run', first]).json.already, true);
  assert.equal(sb.run(['list']).json.runs.find((r) => r.runId === first).closed, true);
  assert.equal(sb.run(['next', '--run', first]).json.suggestion, 'close');
  assert.equal(sb.run(['claim', '--run', first, '--session', 's1']).code, 1, 'a closed run hands out no work');
  assert.equal(sb.run(['status', '--run', 'no-such-run']).code, 1);
  assert.equal(sb.run(['status', '--run', '../escape']).code, 2);
});
