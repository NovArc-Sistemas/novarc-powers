// End to end: a finding that spells a secret name the way only a parser reads it, wraps the
// value in an expression, or hands it to a command as an argument, is refused by the real
// `run.mjs complete` with a pointer to where it is, and the value reaches no file of the run.
// And the same value in the content of a harness file is masked by the real snapshot before it
// reaches the state, the record and the board. The masker (lib/snapshot/mask.mjs) and the barrier
// (lib/run/secrets.mjs) cannot drift apart without this failing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SCRIPTS } from './helpers.mjs';
import { maskText } from '../scripts/lib/snapshot/mask.mjs';
import { sandbox, item, filesContaining, historyOf } from './run-helpers.mjs';

// Assembled at runtime, so the repository scan finds no credential in this file.
const join = (...parts) => parts.join('');
const VALUE = join('private', 'Credential', '9876', '54');
const MASTER = join('test', 'Master', 'Credential', '9876', '54'); // handed to `bw unlock`
const SESSION = join('test', 'Session', 'Credential', '9876', '54'); // handed to `--session`
const BS = '\\';
const ESCAPED_KEY = `{"pass${BS}u0077ord":"${VALUE}"}`; // what a JSON file holds when `w` is written as an escape
const UNLOCK = `token = "$(bw unlock '${MASTER}' --raw)"`;
const WITH_SESSION = `password = "$(bw get password item --session ${SESSION})"`;
const FETCHING = 'password = "$(cat /run/secrets/pw)"';
const ROUNDS = [{ harness: 'acme-shop', round: 1, status: 'done' }];

/** The real renderer, for the channel that leaves the machine. */
function renderArtifact(sb) {
  return spawnSync(process.execPath, [path.join(SCRIPTS, 'render-board.mjs'), sb.file('state.json'), '--channel', 'artifact'], { encoding: 'utf8', env: sb.env, timeout: 120000 });
}

test('the escaped-key text really is a password to a JSON parser', () => {
  assert.equal(JSON.parse(ESCAPED_KEY).password, VALUE);
  assert.equal(maskText(ESCAPED_KEY), `{"pass${BS}u0077ord":"priv…23"}`);
});

test('complete refuses each spelling with its pointer, and stores nothing of the value', (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop'] });
  assert.equal(sb.init().code, 0);
  // [where it is planted, the pointer the refusal names, the text]
  const places = [
    ['title', '/items/0/title', ESCAPED_KEY],
    ['finding', '/items/0/finding', `The hook runs password = "$(printf ${VALUE})" on every call.`],
    ['proposal', '/items/0/proposal', `Replace password: "\${{ '${VALUE}' }}" with a reference.`],
    ['evidence', '/items/0/evidence', `.mcp.json:4 "args": ["--api-key", "${VALUE}"]`],
  ];
  for (const [field, pointer, text] of places) {
    const r = sb.complete('review:security', { rounds: ROUNDS, items: [item('ACME-101', 'acme-shop', 1, { [field]: text })] });
    assert.equal(r.code, 1, `${pointer}: refused`);
    assert.equal(r.json.ok, false, pointer);
    assert.equal(r.json.errors.length, 1, pointer);
    assert.ok(r.json.errors[0].startsWith(`${pointer}: credential (`), r.json.errors[0]);
    assert.ok(!(r.stdout + r.stderr).includes(VALUE), `${pointer}: the refusal does not show the value`);
    assert.deepEqual(filesContaining(sb.dir, VALUE), [], `${pointer}: nothing under the run directory holds it`);
    // The only file that holds it is the one handed in, which the run never copies.
    assert.deepEqual(filesContaining(sb.home, VALUE), ['findings-review-security.json'], pointer);
  }

  // With what the masker writes in its place, the same finding is accepted.
  const accepted = sb.complete('review:security', { rounds: ROUNDS, items: [item('ACME-101', 'acme-shop', 1, { title: maskText(ESCAPED_KEY) })] });
  assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
  sb.run(['close']);
  assert.deepEqual(filesContaining(sb.home, VALUE), [], 'after the run is closed no file holds the value');
});

test('a command that carries a credential in its arguments is refused, and build, close and the board never see it', (t) => {
  for (const [title, secret, left] of [[UNLOCK, MASTER, 'token = "…47"'], [WITH_SESSION, SESSION, 'password = "…61"']]) {
    assert.equal(maskText(title), left);
    const sb = sandbox(t, { accounts: 0, projects: ['acme-shop'] });
    assert.equal(sb.init().code, 0);
    const refused = sb.complete('review:security', { rounds: ROUNDS, items: [item('ACME-101', 'acme-shop', 1, { title })] });
    assert.equal(refused.code, 1, title);
    assert.equal(refused.json.errors.length, 1);
    assert.ok(refused.json.errors[0].startsWith('/items/0/title: credential ('), refused.json.errors[0]);
    assert.ok(!(refused.stdout + refused.stderr).includes(secret), 'the refusal does not show the value');

    // The run goes on with the finding as the masker writes it; nothing downstream holds the value.
    const accepted = sb.complete('review:security', { rounds: ROUNDS, items: [item('ACME-101', 'acme-shop', 1, { title: left })] });
    assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
    assert.equal(sb.run(['build', '--no-render']).code, 0);
    assert.equal(sb.run(['close']).code, 0);
    const render = renderArtifact(sb);
    assert.equal(render.status, 0, render.stderr);
    const history = historyOf(sb);
    const record = JSON.stringify(history.record(history.keys()[0], sb.runId));
    for (const [where, text] of [['state.json', sb.text('state.json')], ['the record', record], ['board.html', sb.text('board.html')]]) {
      assert.ok(!text.includes(secret), `${where} does not hold the value`);
    }
    assert.ok(sb.text('state.json').includes(JSON.stringify(left).slice(1, -1)), 'the state holds the masked title');
    assert.deepEqual(filesContaining(sb.home, secret), [], 'and no file of the run does');
  }
});

test('the same commands in the content of a harness file are masked before the state, the record and the board', (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop'] });
  const project = path.join(sb.home, 'dev', 'acme-shop');
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), ['# Rules', '', 'Unlock the vault first:', '', UNLOCK, WITH_SESSION, FETCHING, ''].join('\n'));
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { db: { command: 'npx', args: ['-y', 'db-mcp'], env: { BW_SESSION: `$(bw unlock '${MASTER}' --raw)`, DB_PASSWORD: '$(cat /run/secrets/pw)' } } },
  }, null, 2));
  assert.equal(sb.init().code, 0);
  // The real snapshot script reads the project; the other probes stay stubs.
  const probe = sb.run(['probe'], { NOVARC_HD_SCRIPT_SNAPSHOT_HARNESS: path.join(SCRIPTS, 'snapshot-harness.mjs') });
  assert.equal(probe.code, 0, probe.stderr);
  const files = Object.fromEntries(sb.read('probes', 'acme-shop', 'snapshot.json').files.map((f) => [f.path, f.content]));
  assert.equal(files['./CLAUDE.md'], ['# Rules', '', 'Unlock the vault first:', '', 'token = "…47"', 'password = "…61"', FETCHING, ''].join('\n'));
  assert.deepEqual(JSON.parse(files['./.mcp.json']).mcpServers.db.env, { BW_SESSION: '…47', DB_PASSWORD: '$(cat /run/secrets/pw)' });

  assert.equal(sb.complete('review:security', { rounds: ROUNDS, items: [item('ACME-101', 'acme-shop', 1)] }).code, 0);
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  assert.equal(sb.run(['close']).code, 0);
  const render = renderArtifact(sb);
  assert.equal(render.status, 0, render.stderr);

  const history = historyOf(sb);
  const record = JSON.stringify(history.record(history.keys()[0], sb.runId));
  const state = sb.text('state.json');
  const board = sb.text('board.html');
  for (const secret of [MASTER, SESSION]) {
    for (const [where, text] of [['state.json', state], ['the record', record], ['board.html', board]]) assert.ok(!text.includes(secret), `${where} does not hold the value`);
  }
  // The content did reach the state and the board: the command that only fetches is there, whole.
  assert.ok(state.includes('$(cat /run/secrets/pw)'), 'the state holds the file content');
  assert.ok(board.includes('$(cat /run/secrets/pw)'), 'and so does the board');
  // The two files on disk are the only ones that hold the values.
  assert.deepEqual(filesContaining(sb.home, MASTER), ['dev/acme-shop/.mcp.json', 'dev/acme-shop/CLAUDE.md']);
  assert.deepEqual(filesContaining(sb.home, SESSION), ['dev/acme-shop/CLAUDE.md']);
});
