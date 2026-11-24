// The one write primitive of the accounts feature (scripts/sync-check.mjs, writeKeepingLinks):
// a write that fails half way must leave the file holding what it held. Failures are injected
// with NOVARC_POWERS_TEST_FAULT, which makes a named write stage stop after half of its bytes as
// a full disk would. Everything runs in temp dirs with a fake home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildHome, acc, rmrf, write, read, json, exists, isLink, planAndApply, tmpDir, CAN_SYMLINK,
} from './accounts-fixture.mjs';
import { writeKeepingLinks, recoveryDir } from '../scripts/sync-check.mjs';

const OLD = 'old contents: these bytes must survive a failed write\n';
const NEW = 'NEW CONTENTS, longer than the old ones were, so that a short write would show at once\n';

function sandbox(t) {
  const root = tmpDir('hd-write-');
  t.after(() => rmrf(root));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  return { root, home };
}

/** Run `fn` while the named write stages fail, in this process. */
function withFault(stages, fn) {
  process.env.NOVARC_POWERS_TEST_FAULT = stages;
  try { return fn(); } finally { delete process.env.NOVARC_POWERS_TEST_FAULT; }
}

function failure(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

test('write: a file with one name is replaced through a temp file; a failure before the rename changes nothing', (t) => {
  const { root, home } = sandbox(t);
  const f = path.join(root, 'cfg', 'file.txt');
  write(f, OLD);

  const err = withFault('temp', () => failure(() => writeKeepingLinks(f, NEW, { home })));
  assert.equal(err && err.code, 'ENOSPC');
  assert.equal(read(f), OLD, 'the file changed although the write failed');
  assert.equal(fs.statSync(f).size, Buffer.byteLength(OLD));
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['file.txt'], 'a temp file was left behind');

  // The same failure produced the way the review did: every write call fails.
  const original = fs.writeSync;
  let calls = 0;
  fs.writeSync = () => { calls++; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  let thrown;
  try { thrown = failure(() => writeKeepingLinks(f, NEW, { home })); } finally { fs.writeSync = original; }
  assert.ok(calls > 0, 'the simulated failure never fired');
  assert.match(String(thrown && thrown.message), /disk full/);
  assert.equal(read(f), OLD);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['file.txt']);

  assert.equal(writeKeepingLinks(f, NEW, { home }), 'replaced');
  assert.equal(read(f), NEW);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['file.txt']);
  assert.ok(!exists(recoveryDir(home)), 'a file with one name needs no safety copy');
  assert.equal(writeKeepingLinks(f, OLD, { home }), 'replaced');
  assert.equal(read(f), OLD, 'shorter content replaces longer content exactly');

  if (process.platform !== 'win32') {
    fs.chmodSync(f, 0o640);
    writeKeepingLinks(f, NEW, { home });
    assert.equal(fs.statSync(f).mode & 0o777, 0o640, 'the permission bits of the replaced file are kept');
  }

  // A missing file is created, folders included; a failed creation leaves nothing.
  const made = path.join(root, 'new', 'deep', 'made.txt');
  assert.equal(writeKeepingLinks(made, NEW, { home }), 'created');
  assert.equal(read(made), NEW);
  const never = path.join(root, 'new', 'never.txt');
  assert.equal(withFault('temp', () => failure(() => writeKeepingLinks(never, NEW, { home }))).code, 'ENOSPC');
  assert.ok(!exists(never));
  assert.deepEqual(fs.readdirSync(path.dirname(never)), ['deep']);

  // A file the user made read-only is not replaced behind their back (a rename could).
  const locked = path.join(root, 'ro', 'locked.txt');
  write(locked, OLD);
  fs.chmodSync(locked, 0o444);
  if (!(process.getuid && process.getuid() === 0)) { // root may write anything
    assert.ok(failure(() => writeKeepingLinks(locked, NEW, { home })), 'a read-only file was replaced');
    assert.equal(read(locked), OLD);
    assert.deepEqual(fs.readdirSync(path.dirname(locked)), ['locked.txt']);
  }
  fs.chmodSync(locked, 0o644);

  // Not a file: refused, untouched.
  assert.match(String(failure(() => writeKeepingLinks(path.join(root, 'new'), NEW, { home })).message), /not a file/);
  assert.equal(read(made), NEW);
});

test('write: a file with another name is written in place, and restored from an intact copy when the write fails', (t) => {
  const { root, home } = sandbox(t);
  const f = path.join(root, 'a', 'shared.json');
  const peer = path.join(root, 'b', 'peer.json');
  write(f, OLD);
  fs.mkdirSync(path.dirname(peer));
  fs.linkSync(f, peer);
  const kept = () => (exists(recoveryDir(home)) ? fs.readdirSync(recoveryDir(home)) : []);

  assert.equal(writeKeepingLinks(f, NEW, { home }), 'in-place');
  assert.deepEqual([read(f), read(peer), fs.statSync(f).nlink], [NEW, NEW, 2], 'the other name stopped following');
  assert.deepEqual(kept(), [], 'the safety copy is removed after a good write');
  writeKeepingLinks(f, OLD, { home });
  assert.deepEqual([read(f), read(peer), fs.statSync(f).nlink], [OLD, OLD, 2], 'shorter content is cut to length');

  // 1. Half of the new bytes land, then the disk is full: the old bytes come back.
  const first = withFault('shared', () => failure(() => writeKeepingLinks(f, NEW, { home })));
  assert.equal(first.code, 'ENOSPC');
  assert.equal(first.restored, true);
  assert.match(first.message, /^the write failed \(ENOSPC\); the file was restored to what it held$/);
  assert.deepEqual([read(f), read(peer), fs.statSync(f).nlink], [OLD, OLD, 2]);
  assert.deepEqual(kept(), []);

  // 2. The safety copy itself cannot be made: the file is never touched.
  const second = withFault('copy', () => failure(() => writeKeepingLinks(f, NEW, { home })));
  assert.equal(second.code, 'ENOSPC');
  assert.deepEqual([read(f), read(peer), fs.statSync(f).nlink], [OLD, OLD, 2]);
  assert.deepEqual(kept(), []);

  // 3. The write fails and so does the restore: the intact copy stays, and the error says where.
  const third = withFault('shared,restore', () => failure(() => writeKeepingLinks(f, NEW, { home })));
  assert.equal(third.code, 'ENOSPC');
  assert.equal(kept().length, 1);
  assert.match(kept()[0], /-shared\.json$/);
  const copy = path.join(recoveryDir(home), kept()[0]);
  assert.equal(third.recovery, copy);
  assert.equal(third.message, `the write failed (ENOSPC) and the file could not be restored: an intact copy of what it held is at ~/.novarc-powers/novarc-harness-doctor/sync/recovery/${kept()[0]}`);
  assert.equal(read(copy), OLD, 'the kept copy is not the intact original');
  assert.ok(fs.statSync(f).size > 0, 'the file was truncated to nothing');
  assert.equal(fs.statSync(f).nlink, 2);
});

test('write: a symbolic link is kept, and the file it resolves to is written by the same rules', { skip: !CAN_SYMLINK && 'symbolic links cannot be created here' }, (t) => {
  const { root, home } = sandbox(t);
  const target = path.join(root, 'dotfiles', 'real.md');
  const link = path.join(root, 'account', 'link.md');
  write(target, OLD);
  fs.mkdirSync(path.dirname(link));
  fs.symlinkSync(target, link, 'file');

  assert.equal(withFault('temp', () => failure(() => writeKeepingLinks(link, NEW, { home }))).code, 'ENOSPC');
  assert.deepEqual([read(target), isLink(link)], [OLD, true]);
  assert.equal(writeKeepingLinks(link, NEW, { home }), 'replaced');
  assert.deepEqual([read(target), read(link), isLink(link)], [NEW, NEW, true]);
  assert.deepEqual(fs.readdirSync(path.dirname(link)), ['link.md']);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['real.md']);

  // A link to nothing is refused instead of being replaced or followed into a new file.
  const nowhere = path.join(root, 'dotfiles', 'nowhere.md');
  const dangling = path.join(root, 'account', 'dangling.md');
  fs.symlinkSync(nowhere, dangling, 'file');
  assert.match(String(failure(() => writeKeepingLinks(dangling, NEW, { home })).message), /does not exist; nothing was written/);
  assert.ok(!exists(nowhere) && isLink(dangling));
});

test('check --repair: a repair that fails half way leaves the generated file and config.toml as they were', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  const ALL = ['--resolve', 'claude-2:CLAUDE.md=replace-with-primary', '--resolve', 'claude-2:skills/=replace-with-primary', '--resolve', 'codex-1:AGENTS.md=replace-with-primary'];
  assert.equal(planAndApply(h, 'claude-1', ALL).apply.code, 0);
  const agents = path.join(h.codexDir, 'AGENTS.md');
  const toml = path.join(h.codexDir, 'config.toml');
  const manifest = path.join(h.sync, 'manifest.json');
  // The primary moves on: the generated file and one MCP definition are now out of date.
  fs.appendFileSync(path.join(h.claude, 'RTK.md'), '\nA rule added later. LATER-RULE\n');
  const state = JSON.parse(read(h.state1));
  state.mcpServers.context7.args = ['-y', 'context7-mcp@2'];
  fs.writeFileSync(h.state1, JSON.stringify(state, null, 2) + '\n');
  const recorded = () => json(manifest).accounts.find((a) => a.id === 'codex-1').elements.filter((e) => e.name === 'AGENTS.md' || e.name === 'mcp servers/context7');
  const before = { agents: read(agents), toml: read(toml), recorded: recorded() };
  assert.equal(before.recorded.length, 2);
  assert.ok(before.agents.startsWith('<!-- generated by novarc-harness-doctor from ~/.claude/CLAUDE.md; edit the primary and run the sync check -->\n'));
  assert.ok(before.toml.includes('args = ["-y", "context7-mcp"]\n'));

  const failed = acc(h.home, ['check', '--repair'], { NOVARC_POWERS_TEST_FAULT: 'temp' });
  assert.equal(failed.code, 0);
  const codex = failed.json.accounts.find((a) => a.id === 'codex-1').elements;
  assert.deepEqual(codex.find((e) => e.name === 'AGENTS.md'), {
    name: 'AGENTS.md', state: 'drift', note: 'the primary changed; could not be rewritten (ENOSPC), so it is as it was', path: '~/.codex/AGENTS.md', source: '~/.claude/CLAUDE.md',
  });
  assert.deepEqual(codex.find((e) => e.name === 'mcp servers/context7'), {
    name: 'mcp servers/context7', state: 'drift', note: 'could not be repaired (no space left on device (simulated))', path: '~/.codex/config.toml', source: '~/.claude.json',
  });
  assert.equal(read(agents), before.agents, 'the generated file changed although its repair failed');
  assert.equal(read(toml), before.toml, 'config.toml changed although its repair failed');
  assert.deepEqual(recorded(), before.recorded, 'a failed repair was recorded as done');
  assert.deepEqual(fs.readdirSync(h.codexDir).filter((n) => n.includes('.nhd-')), [], 'a temp file was left in the account');

  // Once the disk has room again, the same check repairs both.
  const fixed = acc(h.home, ['check', '--repair']).json.accounts.find((a) => a.id === 'codex-1').elements;
  assert.deepEqual(fixed.filter((e) => e.repaired).map((e) => e.name), ['AGENTS.md', 'mcp servers/context7']);
  assert.ok(read(agents).includes('A rule added later. LATER-RULE\n'));
  assert.ok(read(toml).includes('args = ["-y", "context7-mcp@2"]\n') && !read(toml).includes('args = ["-y", "context7-mcp"]\n'));
});

test('a hardlinked settings.json survives a failed in-place edit: both names hold the old bytes', (t) => {
  const HARD = { NOVARC_POWERS_NO_SYMLINK: '1' };
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  assert.equal(planAndApply(h, 'claude-1', ['--resolve', 'claude-2:CLAUDE.md=replace-with-primary'], HARD).apply.code, 0);
  const P = path.join(h.claude, 'settings.json');
  const S = path.join(h.acc, 'settings.json');
  assert.equal(fs.statSync(P).nlink, 2, 'the fixture did not produce a hardlinked settings.json');
  const before = read(P);
  assert.equal(JSON.parse(before).hooks.SessionStart, undefined);

  const failed = acc(h.home, ['install-check', '--yes'], { ...HARD, NOVARC_POWERS_TEST_FAULT: 'shared' });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /the write failed \(ENOSPC\); the file was restored to what it held/);
  assert.deepEqual([read(P), read(S), fs.statSync(P).nlink], [before, before, 2]);
  assert.deepEqual(fs.readdirSync(path.join(h.sync, 'recovery')), []);

  const ok = acc(h.home, ['install-check', '--yes'], HARD);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(fs.statSync(P).nlink, 2, 'the edit broke the hardlink');
  assert.equal(read(S), read(P));
  assert.match(json(S).hooks.SessionStart[0].hooks[0].command, /sync-check\.mjs" --repair$/);
  assert.equal(json(S).model, 'x', 'the rest of the file is intact');
});
