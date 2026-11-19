import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { addHook, hookCommand, removeHook } from '../src/settings-hook.js';
import { read, readJson, run, sandbox } from './helpers.js';

const CMD = hookCommand(path.join('X:', 'h', '.novarc-powers', 'hooks', 'check-update.js'));

test('addHook merges into existing settings and is idempotent', () => {
  const original = JSON.stringify(
    {
      model: 'opus',
      permissions: { allow: ['Bash(ls)'] },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }], Stop: [] },
    },
    null,
    2,
  );
  const first = addHook(original, CMD);
  assert.equal(first.status, 'changed');
  const data = JSON.parse(first.text);
  assert.equal(data.model, 'opus');
  assert.deepEqual(data.permissions, { allow: ['Bash(ls)'] });
  assert.deepEqual(data.hooks.Stop, []);
  assert.equal(data.hooks.SessionStart.length, 2);
  assert.equal(data.hooks.SessionStart[0].hooks[0].command, 'echo hi');
  assert.equal(addHook(first.text, CMD).status, 'unchanged');
  const removed = removeHook(first.text);
  assert.equal(removed.status, 'changed');
  assert.deepEqual(JSON.parse(removed.text), JSON.parse(original));
  assert.equal(removeHook(removed.text).status, 'unchanged');
});

test('hook command uses forward slashes', () => {
  assert.equal(CMD.includes('\\'), false);
});

test('invalid JSON is refused by addHook and removeHook', () => {
  assert.equal(addHook('{ "model": ', CMD).status, 'invalid');
  assert.equal(removeHook('{ nope', CMD).status, 'invalid');
  assert.equal(addHook('[1,2]', CMD).status, 'invalid');
  assert.equal(addHook('{"hooks": {"SessionStart": {}}}', CMD).status, 'invalid');
});

test('CLI registers the hook once across repeated installs and unregisters on --updates off', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const settings = path.join(sb.home, '.claude', 'settings.json');
  fs.writeFileSync(settings, '{\n    "theme": "dark"\n}\n');
  assert.equal(run(sb, ['add', 'alpha', '--scope', 'user', '--yes']).code, 0);
  assert.equal(run(sb, ['add', 'alpha', 'beta', '--scope', 'user', '--yes']).code, 0);
  const data = readJson(settings);
  assert.equal(data.theme, 'dark');
  const ours = data.hooks.SessionStart.flatMap((g) => g.hooks).filter((h) => h.command.includes('check-update.js'));
  assert.equal(ours.length, 1);
  assert.match(read(settings), /^\{\n {4}"theme"/, 'indentation preserved');
  assert.ok(fs.existsSync(path.join(sb.home, '.novarc-powers', 'hooks', 'check-update.js')));
  const cfg = readJson(path.join(sb.home, '.novarc-powers', 'config.json'));
  assert.deepEqual(cfg, { updates: 'notify', lastCheck: null, installedVersion: '0.1.0' });

  assert.equal(run(sb, ['update', '--updates', 'off', '--yes']).code, 0);
  assert.deepEqual(readJson(settings), { theme: 'dark' });
  assert.equal(readJson(path.join(sb.home, '.novarc-powers', 'config.json')).updates, 'off');
  assert.equal(fs.existsSync(path.join(sb.home, '.novarc-powers', 'hooks', 'check-update.js')), false);
});

test('CLI leaves an invalid settings.json untouched and warns', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const settings = path.join(sb.home, '.claude', 'settings.json');
  const broken = '{ "theme": "dark", // comment\n';
  fs.writeFileSync(settings, broken);
  const r = run(sb, ['add', 'alpha', '--scope', 'user', '--yes', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(read(settings), broken);
  assert.ok(r.json.plan[0].warnings.some((w) => w.code === 'SETTINGS_INVALID_JSON'));
  assert.equal(r.json.plan[0].actions.some((a) => a.kind === 'settings'), false);
});

test('removing everything unregisters the hook', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const settings = path.join(sb.home, '.claude', 'settings.json');
  assert.equal(run(sb, ['add', 'alpha', '--scope', 'user', '--yes']).code, 0);
  assert.match(read(settings), /check-update\.js/);
  assert.equal(run(sb, ['remove', 'alpha', '--yes']).code, 0);
  assert.deepEqual(readJson(settings), {});
  assert.equal(fs.existsSync(path.join(sb.home, '.novarc-powers', 'config.json')), false);
});