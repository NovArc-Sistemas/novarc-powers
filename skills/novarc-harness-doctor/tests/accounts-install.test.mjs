// accounts.mjs install-check / uninstall-check: the session-start hook in the primary account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildHome, acc, check, rmrf, write, read, json, sha, exists, isLink, snapshot, assertClean,
  assertCanariesUntouched, planAndApply, dropLink, CAN_SYMLINK, SCRIPTS, FAKE_TOKEN,
} from './accounts-fixture.mjs';

const stable = (h) => path.join(h.sync, 'sync-check.mjs');
const command = (h) => `node "${stable(h).replace(/\\/g, '/')}" --repair`;
const sessionStart = (file) => json(file).hooks.SessionStart;

test('install-check: refuses without --yes and without a primary', (t) => {
  const h = buildHome({ second: false, codex: false, agents: false });
  t.after(() => rmrf(h.root));
  const before = snapshot(h.home);
  const noYes = acc(h.home, ['install-check', '--primary', 'claude-1']);
  assert.equal(noYes.code, 2);
  assert.equal(noYes.json.refused, true);
  assert.match(noYes.stderr, /--yes/);
  const noPrimary = acc(h.home, ['install-check', '--yes']);
  assert.equal(noPrimary.code, 2);
  assert.match(noPrimary.stderr, /--primary/);
  assert.equal(acc(h.home, ['install-check', '--yes', '--primary', 'claude-7']).code, 2);
  assert.equal(acc(h.home, ['uninstall-check']).code, 2);
  assert.deepEqual(snapshot(h.home), before);
});

test('install-check: copies the script and registers one SessionStart hook, keeping everything else', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  planAndApply(h, 'claude-1', ['--only', 'codex-1', '--resolve', 'codex-1:AGENTS.md=replace-with-primary']);
  const settings = path.join(h.claude, 'settings.json');
  const original = read(settings);
  const r = acc(h.home, ['install-check', '--yes']); // the primary comes from the manifest
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual({ ok: r.json.ok, installed: r.json.installed, changed: r.json.changed, account: r.json.account, file: r.json.file, script: r.json.script }, {
    ok: true, installed: true, changed: true, account: 'claude-1', file: '~/.claude/settings.json', script: '~/.novarc-powers/novarc-harness-doctor/sync/sync-check.mjs',
  });
  // The script, at its stable place, byte for byte.
  assert.equal(sha(stable(h)), sha(path.join(SCRIPTS, 'sync-check.mjs')));
  // The hook.
  const now = read(settings);
  const hooks = sessionStart(settings);
  assert.deepEqual(hooks, [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: command(h), timeout: 15 }] }]);
  assert.ok(!hooks[0].hooks[0].command.includes('\\'), 'forward slashes only');
  assert.match(hooks[0].hooks[0].command, /^node "[^"]+\/\.novarc-powers\/novarc-harness-doctor\/sync\/sync-check\.mjs" --repair$/);
  // Everything else: same values, same bytes around the insertion.
  const after = JSON.parse(now);
  delete after.hooks.SessionStart;
  assert.deepEqual(after, JSON.parse(original));
  const at = original.indexOf('    ]\n  },\n  "statusLine"');
  assert.ok(at > 0 && now.startsWith(original.slice(0, at + 5)), 'the text before the insertion is byte-identical');
  assert.ok(now.endsWith(original.slice(at + 5)), 'the text after the insertion is byte-identical');
  // Backup first.
  assert.equal(r.json.backup, `~/.novarc-powers/novarc-harness-doctor/sync/backups/${r.json.stamp}/claude-1/settings.json`);
  assert.equal(read(path.join(h.sync, 'backups', r.json.stamp, 'claude-1', 'settings.json')), original);
  assert.equal(acc(h.home, ['diff']).json.syncInstalled, true);
  assertClean(assert, h, r.stdout + r.stderr);
  assertCanariesUntouched(assert, h);

  // Idempotent.
  const again = acc(h.home, ['install-check', '--yes']);
  assert.equal(again.code, 0);
  assert.equal(again.json.changed, false);
  assert.equal(read(settings), now);
  assert.equal(sessionStart(settings).length, 1);

  // The installed copy is what the hook runs: silent when fine, and it repairs.
  const run = (args) => check(h.home, args, { script: stable(h) });
  assert.deepEqual([run(['--repair']).code, run(['--repair']).stdout], [0, '']);
  fs.appendFileSync(path.join(h.claude, 'CLAUDE.md'), '\nA new rule. HOOK-RULE\n');
  assert.match(run(['--repair']).stdout, /repaired 1 \(codex-1 AGENTS\.md\)/);
  assert.ok(read(path.join(h.codexDir, 'AGENTS.md')).includes('HOOK-RULE'));
});

test('uninstall-check: restores the file byte for byte, and removes only its own entry after edits', (t) => {
  const h = buildHome({ second: false, codex: false, agents: false });
  t.after(() => rmrf(h.root));
  const settings = path.join(h.claude, 'settings.json');
  const original = read(settings);
  acc(h.home, ['install-check', '--yes', '--primary', 'claude-1']);
  let r = acc(h.home, ['uninstall-check', '--yes']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.changed, true);
  assert.equal(read(settings), original);
  assert.ok(!exists(stable(h)));
  assert.equal(acc(h.home, ['uninstall-check', '--yes', '--primary', 'claude-1']).json.changed, false, 'nothing left to remove');

  // The user edits the file between install and uninstall: only our entry goes.
  acc(h.home, ['install-check', '--yes', '--primary', 'claude-1']);
  const edited = JSON.parse(read(settings));
  edited.model = 'changed-by-the-user';
  edited.hooks.SessionStart.unshift({ hooks: [{ type: 'command', command: 'echo mine' }] });
  edited.hooks.SessionStart[1].hooks.push({ type: 'command', command: 'echo also mine' });
  fs.writeFileSync(settings, JSON.stringify(edited, null, 2) + '\n');
  r = acc(h.home, ['uninstall-check', '--yes']);
  assert.equal(r.code, 0, r.stdout);
  const left = JSON.parse(read(settings));
  assert.equal(left.model, 'changed-by-the-user');
  assert.deepEqual(left.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'echo mine' }] }, { matcher: 'startup|resume', hooks: [{ type: 'command', command: 'echo also mine' }] }]);
  assert.deepEqual(left.hooks.PreToolUse, JSON.parse(original).hooks.PreToolUse);
  assert.ok(!read(settings).includes('sync-check.mjs'));
});

test('install-check: a file that is not valid JSON is refused and left untouched', (t) => {
  const h = buildHome({ second: false, codex: false, agents: false });
  t.after(() => rmrf(h.root));
  const settings = path.join(h.claude, 'settings.json');
  for (const bad of ['{ "model": "x", ', '// a comment\n{}', '[1, 2]', '{"hooks": []}', '{"hooks": {"SessionStart": {}}}']) {
    fs.writeFileSync(settings, bad);
    const r = acc(h.home, ['install-check', '--yes', '--primary', 'claude-1']);
    assert.equal(r.code, 1, bad);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.refused, true);
    assert.equal(read(settings), bad, 'the file was written');
    assert.ok(!r.stdout.includes('"x"') || bad.includes('SessionStart'), 'the parser message must not echo the file');
  }
});

test('install-check: a symbolic link on settings.json survives: the file it leads to is replaced', { skip: !CAN_SYMLINK && 'symbolic links cannot be created here' }, (t) => {
  const h = buildHome({ second: false, codex: false, agents: false });
  t.after(() => rmrf(h.root));
  const settings = path.join(h.claude, 'settings.json');
  const real = path.join(h.root, 'mirror', 'settings.json');
  const original = read(settings);
  write(real, original);
  fs.rmSync(settings);
  fs.symlinkSync(real, settings, 'file');
  const r = acc(h.home, ['install-check', '--yes', '--primary', 'claude-1']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(isLink(settings), 'the symlink was replaced by a regular file');
  assert.equal(read(real), read(settings), 'both paths still show the same file');
  assert.equal(sessionStart(real).length, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(real)), ['settings.json'], 'a temp file was left beside the real file');
  assert.equal(acc(h.home, ['uninstall-check', '--yes']).code, 0);
  assert.ok(isLink(settings));
  assert.equal(read(real), original, 'uninstall restores the file behind the link byte for byte');
});

test('install-check: a settings.json hardlinked into another account is replaced, and that account follows', (t) => {
  // Where symbolic links are refused, a linked account's settings.json is a second name of the
  // primary's. Here the link was made by hand: no manifest records it, the account folder does.
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  const P = path.join(h.claude, 'settings.json');
  const S = path.join(h.acc, 'settings.json');
  const original = read(P);
  fs.rmSync(S);
  fs.linkSync(P, S);
  const r = acc(h.home, ['install-check', '--yes', '--primary', 'claude-1']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.notEqual(read(P), original);
  assert.equal(read(S), read(P), 'the other account no longer shows the same bytes');
  assert.equal(fs.statSync(P).nlink, 2, 'the two names are no longer one file');
  assert.equal(String(fs.statSync(P, { bigint: true }).ino), String(fs.statSync(S, { bigint: true }).ino));
  assert.equal(sessionStart(S).length, 1);
  for (const dir of [h.claude, h.acc]) assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.nhd-')), [], 'a temp name was left behind');
  assert.ok(!exists(path.join(h.sync, 'recovery')), 'the record of a finished write was left behind');
  assert.equal(acc(h.home, ['uninstall-check', '--yes']).code, 0);
  assert.deepEqual([read(P), read(S), fs.statSync(P).nlink], [original, original, 2], 'uninstall keeps the link too');
});

test('install-check: a settings.json with names nobody recorded is refused, with the count, and left alone', (t) => {
  const h = buildHome({ second: false, codex: false, agents: false });
  t.after(() => rmrf(h.root));
  const settings = path.join(h.claude, 'settings.json');
  const original = read(settings);
  // Two more names of the same file, outside every account: a mirror kept by hand.
  const one = path.join(h.root, 'mirror', 'settings.json');
  const two = path.join(h.root, 'mirror', 'hard.json');
  fs.mkdirSync(path.dirname(one));
  fs.linkSync(settings, one);
  fs.linkSync(settings, two);
  const r = acc(h.home, ['install-check', '--yes', '--primary', 'claude-1']);
  assert.equal(r.code, 1);
  assert.deepEqual({ ok: r.json.ok, refused: r.json.refused, file: r.json.file, unknownNames: r.json.unknownNames }, { ok: false, refused: true, file: '~/.claude/settings.json', unknownNames: 2 });
  assert.equal(r.json.error, 'settings.json: the file has 2 other names (hardlinks) that this tool has no record of; replacing it would leave them behind with the old content, so nothing was written. Remove them or turn them into symbolic links, then run this again');
  assert.deepEqual([read(settings), read(one), read(two), fs.statSync(settings).nlink], [original, original, original, 3]);
  assert.ok(!exists(path.join(h.sync, 'backups')), 'a refused install left a backup run behind');
  assert.equal(acc(h.home, ['diff', '--primary', 'claude-1']).json.syncInstalled, false);
  // One name fewer is still one too many; with none left, the install goes through.
  fs.rmSync(two);
  const again = acc(h.home, ['install-check', '--yes', '--primary', 'claude-1']);
  assert.deepEqual([again.code, again.json.unknownNames], [1, 1]);
  assert.match(again.json.error, /^settings\.json: the file has 1 other name \(hardlink\) that this tool has no record of; replacing it would leave it behind/);
  fs.rmSync(one);
  assert.equal(acc(h.home, ['install-check', '--yes', '--primary', 'claude-1']).code, 0);
  assert.equal(sessionStart(settings).length, 1);
  // Uninstall is held to the same rule, and only when it has something to write.
  fs.linkSync(settings, one);
  const installed = read(settings);
  const un = acc(h.home, ['uninstall-check', '--yes']);
  assert.deepEqual([un.code, un.json.refused, un.json.unknownNames], [1, true, 1]);
  assert.deepEqual([read(settings), read(one)], [installed, installed]);
});

test('install-check: a settings file with a secret is not copied into the backups', (t) => {
  const h = buildHome({ second: false, codex: false, agents: false });
  t.after(() => rmrf(h.root));
  const settings = path.join(h.claude, 'settings.json');
  const s = json(settings);
  s.env = { GITHUB_TOKEN: FAKE_TOKEN };
  fs.writeFileSync(settings, JSON.stringify(s, null, 2) + '\n');
  const original = read(settings);
  const r = acc(h.home, ['install-check', '--yes', '--primary', 'claude-1']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.backup, null);
  assert.ok(r.json.notes.some((n) => /No backup copy was made/.test(n)));
  assert.ok(!r.stdout.includes(FAKE_TOKEN));
  const copies = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (fs.readFileSync(f).includes(FAKE_TOKEN)) copies.push(f); } };
  walk(h.sync);
  assert.deepEqual(copies, [], 'the secret was duplicated under the sync folder');
  assert.equal(json(settings).env.GITHUB_TOKEN, FAKE_TOKEN, 'the secret itself is not this command\'s to touch');
  acc(h.home, ['uninstall-check', '--yes']);
  assert.equal(read(settings), original);
});

test('install-check: a missing settings file is created, and removed again on uninstall', (t) => {
  const h = buildHome({ second: false, codex: false, agents: false });
  t.after(() => rmrf(h.root));
  const settings = path.join(h.claude, 'settings.json');
  fs.rmSync(settings);
  const r = acc(h.home, ['install-check', '--yes', '--primary', 'claude-1']);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(json(settings), { hooks: { SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: command(h), timeout: 15 }] }] } });
  acc(h.home, ['uninstall-check', '--yes']);
  assert.ok(!exists(settings));
});

test('install-check: a Codex primary gets the entry in hooks.json, or the manual step', (t) => {
  const h = buildHome({ second: false, agents: false });
  t.after(() => rmrf(h.root));
  const hooks = path.join(h.codexDir, 'hooks.json');
  // No file yet: created in the documented shape.
  let r = acc(h.home, ['install-check', '--yes', '--primary', 'codex-1']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.file, '~/.codex/hooks.json');
  assert.deepEqual(json(hooks), { hooks: { SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: command(h), timeout: 15 }] }] } });
  assert.ok(r.json.notes.some((n) => /\/hooks/.test(n)), 'Codex runs a hook only once it is trusted');
  assert.equal(acc(h.home, ['install-check', '--yes', '--primary', 'codex-1']).json.changed, false);
  acc(h.home, ['uninstall-check', '--yes']);
  assert.ok(!exists(hooks));
  // An existing file in the documented shape: merged.
  const mine = '{\n  "description": "mine",\n  "hooks": {\n    "PreToolUse": [ { "matcher": "shell", "hooks": [ { "type": "command", "command": "guard" } ] } ]\n  }\n}\n';
  fs.writeFileSync(hooks, mine);
  r = acc(h.home, ['install-check', '--yes', '--primary', 'codex-1']);
  assert.equal(r.json.changed, true);
  assert.equal(json(hooks).description, 'mine');
  assert.equal(json(hooks).hooks.PreToolUse[0].hooks[0].command, 'guard');
  assert.equal(json(hooks).hooks.SessionStart.length, 1);
  acc(h.home, ['uninstall-check', '--yes']);
  assert.equal(read(hooks), mine);
  // A shape this tool does not recognise: nothing written, the manual step is printed.
  fs.writeFileSync(hooks, '[{"event": "SessionStart"}]');
  r = acc(h.home, ['install-check', '--yes', '--primary', 'codex-1']);
  assert.equal(r.code, 0);
  assert.equal(r.json.installed, false);
  assert.match(r.json.manual, /node "~\/\.novarc-powers\/novarc-harness-doctor\/sync\/sync-check\.mjs" --repair/);
  assert.equal(read(hooks), '[{"event": "SessionStart"}]');
  assertClean(assert, h, r.stdout);
});

test('install-check: a provider without a known hook file gets the manual step only', (t) => {
  const h = buildHome({ second: false, codex: false });
  t.after(() => rmrf(h.root));
  const before = snapshot(h.agentsDir);
  const r = acc(h.home, ['install-check', '--yes', '--primary', 'agents-1']);
  assert.equal(r.code, 0);
  assert.equal(r.json.installed, false);
  assert.ok(r.json.manual.length > 20);
  assert.deepEqual(snapshot(h.agentsDir), before);
  assert.ok(exists(stable(h)), 'the script is still made available');
});

test('apply refreshes an installed copy of the check, so the hook never runs stale code', (t) => {
  const h = buildHome({ agents: false });
  t.after(() => rmrf(h.root));
  acc(h.home, ['install-check', '--yes', '--primary', 'claude-1']);
  fs.writeFileSync(stable(h), '// an older copy\n');
  const { apply } = planAndApply(h, 'claude-1');
  assert.equal(apply.code, 0, apply.stdout);
  assert.equal(apply.json.checkRefreshed, true);
  assert.equal(sha(stable(h)), sha(path.join(SCRIPTS, 'sync-check.mjs')));
});
