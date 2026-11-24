// The one write primitive of the accounts feature (scripts/sync-check.mjs, writeKeepingLinks).
// No file is written in place: new bytes go to a temp file that is renamed over the old one, and
// every known other name of the file is switched over by a rename of its own. These tests make a
// write FAIL at each point (NOVARC_POWERS_TEST_FAULT makes a named point fail as a full disk
// would) and assert the literal bytes of every name. A process that DIES in the middle is in
// sync-check-crash.test.mjs. Everything runs in temp dirs with a fake home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildHome, acc, rmrf, write, read, json, exists, isLink, planAndApply, tmpDir, CAN_SYMLINK,
} from './accounts-fixture.mjs';
import { writeKeepingLinks, unknownNames, recoverWrites, recoveryDir } from '../scripts/sync-check.mjs';

const OLD = 'old contents: these bytes must survive a failed write\n';
const NEW = 'NEW CONTENTS, longer than the old ones were, so that a short write would show at once\n';

function sandbox(t) {
  const root = tmpDir('hd-write-');
  t.after(() => rmrf(root));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  return { root, home };
}

/** Run `fn` while the named points of a write fail, in this process. */
function withFault(points, fn) {
  process.env.NOVARC_POWERS_TEST_FAULT = points;
  try { return fn(); } finally { delete process.env.NOVARC_POWERS_TEST_FAULT; }
}

function failure(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

const ino = (p) => String(fs.statSync(p, { bigint: true }).ino);
/** Every name under `root` that looks like a temp file of the tool. */
function strays(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.includes('.nhd-')) out.push(path.join(d, e.name));
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(root);
  return out;
}

test('write: a file with one name is replaced through a temp file; a failure before the rename changes nothing', (t) => {
  const { root, home } = sandbox(t);
  const f = path.join(root, 'cfg', 'file.txt');
  write(f, OLD);

  // The record cannot be written, the write is cut short, the temp is complete: all before the rename.
  for (const point of ['record', 'intent', 'temp', 'staged']) {
    const err = withFault(point, () => failure(() => writeKeepingLinks(f, NEW, { home })));
    assert.equal(err && err.code, 'ENOSPC', point);
    assert.equal(read(f), OLD, `${point}: the file changed although the write failed`);
    assert.deepEqual(strays(root), [], `${point}: a temp file was left behind`);
    assert.ok(!exists(recoveryDir(home)), `${point}: the record of a failed write was left behind`);
  }

  // The same failure produced the way the first review did: every write call fails.
  const original = fs.writeSync;
  let calls = 0;
  fs.writeSync = () => { calls++; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  let thrown;
  try { thrown = failure(() => writeKeepingLinks(f, NEW, { home })); } finally { fs.writeSync = original; }
  assert.ok(calls > 0, 'the simulated failure never fired');
  assert.match(String(thrown && thrown.message), /disk full/);
  assert.equal(read(f), OLD);
  assert.deepEqual(strays(root), []);

  assert.deepEqual(writeKeepingLinks(f, NEW, { home }), { how: 'replaced', relinked: 0, pending: [] });
  assert.equal(read(f), NEW);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['file.txt']);
  assert.ok(!exists(recoveryDir(home)), 'the record of a finished write was left behind');
  writeKeepingLinks(f, OLD, { home });
  assert.equal(read(f), OLD, 'shorter content replaces longer content exactly');

  if (process.platform !== 'win32') {
    fs.chmodSync(f, 0o640);
    writeKeepingLinks(f, NEW, { home });
    assert.equal(fs.statSync(f).mode & 0o777, 0o640, 'the permission bits of the replaced file are kept');
  }

  // A missing file is created, folders included; a failed creation leaves nothing.
  const made = path.join(root, 'new', 'deep', 'made.txt');
  assert.deepEqual(writeKeepingLinks(made, NEW, { home }), { how: 'created', relinked: 0, pending: [] });
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

/** One file with three names: `f`, and two more in other folders. */
function threeNames(t) {
  const s = sandbox(t);
  const f = path.join(s.root, 'a', 'shared.json');
  const p1 = path.join(s.root, 'b', 'peer.json');
  const p2 = path.join(s.root, 'c', 'peer.json');
  write(f, OLD);
  for (const p of [p1, p2]) { fs.mkdirSync(path.dirname(p)); fs.linkSync(f, p); }
  const state = () => [read(f), read(p1), read(p2)];
  const oneFile = () => fs.statSync(f).nlink === 3 && ino(f) === ino(p1) && ino(f) === ino(p2);
  return { ...s, f, p1, p2, state, oneFile };
}

test('write: a file with other names is never written in place: it is replaced, and each known name is switched over', (t) => {
  const w = threeNames(t);
  const before = ino(w.f);
  assert.deepEqual(writeKeepingLinks(w.f, NEW, { home: w.home, peers: [w.p1, w.p2] }), { how: 'replaced', relinked: 2, pending: [] });
  assert.deepEqual(w.state(), [NEW, NEW, NEW]);
  assert.ok(w.oneFile(), 'the three names are no longer one file');
  assert.notEqual(ino(w.f), before, 'the old file was written into');
  assert.deepEqual(strays(w.root), []);
  assert.ok(!exists(recoveryDir(w.home)));

  // Written through any of its names, with shorter content, the names listed twice or in another spelling.
  const spelled = path.join(path.dirname(w.f), '..', 'a', 'shared.json');
  assert.deepEqual(writeKeepingLinks(w.p2, OLD, { home: w.home, peers: [w.p1, spelled, w.f, w.p1, w.p2, path.join(w.root, 'no-such-file')] }).relinked, 2);
  assert.deepEqual(w.state(), [OLD, OLD, OLD]);
  assert.ok(w.oneFile());

  // A failure at any point before the rename leaves the three names holding the old bytes, as one file.
  for (const point of ['record', 'intent', 'temp', 'staged', 'peer-staged', 'peer-staged#2']) {
    const err = withFault(point, () => failure(() => writeKeepingLinks(w.f, NEW, { home: w.home, peers: [w.p1, w.p2] })));
    assert.equal(err && err.code, 'ENOSPC', point);
    assert.deepEqual(w.state(), [OLD, OLD, OLD], `${point}: a name changed although the write failed`);
    assert.ok(w.oneFile(), `${point}: the names are no longer one file`);
    assert.deepEqual(strays(w.root), [], `${point}: a temp name was left behind`);
    assert.ok(!exists(recoveryDir(w.home)), `${point}: a record was left behind`);
  }

  // The manifest is where the other names are looked for when the caller names none.
  write(path.join(w.home, '.novarc-powers', 'novarc-harness-doctor', 'sync', 'manifest.json'), JSON.stringify({
    version: 1, tool: 'novarc-harness-doctor', primary: 'x-1', accounts: [
      { id: 'x-2', provider: 'x', pathAbs: path.dirname(w.p1), elements: [{ name: 'peer.json', kind: 'hardlink', path: w.p1, target: w.f }], exceptions: [] },
      { id: 'x-3', provider: 'x', pathAbs: path.dirname(w.p2), elements: [{ name: 'peer.json', kind: 'hardlink', path: w.p2, target: w.f }], exceptions: [] },
    ],
  }));
  assert.equal(unknownNames(w.f, { home: w.home }), 0);
  assert.equal(writeKeepingLinks(w.f, NEW, { home: w.home }).relinked, 2);
  assert.deepEqual(w.state(), [NEW, NEW, NEW]);
  assert.ok(w.oneFile());
});

test('write: a name nobody recorded stops the write, with the count, before anything changes', (t) => {
  const w = threeNames(t);
  const one = failure(() => writeKeepingLinks(w.f, NEW, { home: w.home, peers: [w.p1] }));
  assert.deepEqual([one.code, one.unknownNames], ['EUNKNOWNNAMES', 1]);
  assert.equal(one.message, 'the file has 1 other name (hardlink) that this tool has no record of; replacing it would leave it behind with the old content, so nothing was written. Remove it or turn it into a symbolic link, then run this again');
  // No manifest, no list: both other names are unknown.
  const two = failure(() => writeKeepingLinks(w.f, NEW, { home: w.home }));
  assert.deepEqual([two.code, two.unknownNames], ['EUNKNOWNNAMES', 2]);
  assert.equal(two.message, 'the file has 2 other names (hardlinks) that this tool has no record of; replacing it would leave them behind with the old content, so nothing was written. Remove them or turn them into symbolic links, then run this again');
  assert.deepEqual([unknownNames(w.f, { home: w.home, peers: [w.p1] }), unknownNames(w.f, { home: w.home }), unknownNames(w.f, { home: w.home, peers: [w.p2, w.p1] })], [1, 2, 0]);
  assert.deepEqual(w.state(), [OLD, OLD, OLD]);
  assert.ok(w.oneFile());
  assert.deepEqual(strays(w.root), []);
  assert.ok(!exists(recoveryDir(w.home)), 'a refused write left a record');
  // A file that merely has the same bytes is not a name of this one.
  const twin = path.join(w.root, 'd', 'twin.json');
  write(twin, OLD);
  assert.equal(failure(() => writeKeepingLinks(w.f, NEW, { home: w.home, peers: [w.p1, twin] })).unknownNames, 1);
  assert.equal(read(twin), OLD);
});

test('write: a name that cannot be switched over just now is left whole, and the next run finishes it', (t) => {
  const w = threeNames(t);
  // The rename over the second of the other names fails (as it does for a file held open on Windows).
  const r = withFault('peer#2', () => writeKeepingLinks(w.f, NEW, { home: w.home, peers: [w.p1, w.p2] }));
  assert.deepEqual(r, { how: 'replaced', relinked: 1, pending: [w.p2], why: 'ENOSPC' });
  assert.deepEqual(w.state(), [NEW, NEW, OLD], 'every name holds complete bytes: the new ones, or the old ones');
  assert.equal(ino(w.f), ino(w.p1));
  assert.notEqual(ino(w.f), ino(w.p2));
  // The record stays, saying what is left to do.
  const records = fs.readdirSync(recoveryDir(w.home));
  assert.equal(records.length, 1);
  const record = json(path.join(recoveryDir(w.home), records[0]));
  assert.deepEqual([record.state, record.target, record.peers.map((p) => p.path)], ['pending', w.f, [w.p1, w.p2]]);
  // A read-only look changes nothing.
  assert.deepEqual(recoverWrites({ home: w.home, repair: false }), [{ file: w.f.replace(/\\/g, '/'), outcome: 'pending' }]);
  assert.deepEqual(w.state(), [NEW, NEW, OLD]);
  // The next run that may write finishes the job.
  assert.deepEqual(recoverWrites({ home: w.home }), [{ file: w.f.replace(/\\/g, '/'), outcome: 'completed', relinked: 1 }]);
  assert.deepEqual(w.state(), [NEW, NEW, NEW]);
  assert.ok(w.oneFile());
  assert.deepEqual(strays(w.root), []);
  assert.ok(!exists(recoveryDir(w.home)));
  assert.deepEqual(recoverWrites({ home: w.home }), []);
});

test('write: a symbolic link is kept, and the file it resolves to is replaced by the same rules', { skip: !CAN_SYMLINK && 'symbolic links cannot be created here' }, (t) => {
  const { root, home } = sandbox(t);
  const target = path.join(root, 'dotfiles', 'real.md');
  const link = path.join(root, 'account', 'link.md');
  write(target, OLD);
  fs.mkdirSync(path.dirname(link));
  fs.symlinkSync(target, link, 'file');

  assert.equal(withFault('temp', () => failure(() => writeKeepingLinks(link, NEW, { home }))).code, 'ENOSPC');
  assert.deepEqual([read(target), isLink(link)], [OLD, true]);
  assert.equal(writeKeepingLinks(link, NEW, { home }).how, 'replaced');
  assert.deepEqual([read(target), read(link), isLink(link)], [NEW, NEW, true]);
  assert.deepEqual(fs.readdirSync(path.dirname(link)), ['link.md']);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['real.md']);

  // The file behind the link has a second name: a symbolic link to it is not one, the hardlink is.
  const second = path.join(root, 'dotfiles', 'second.md');
  fs.linkSync(target, second);
  assert.equal(failure(() => writeKeepingLinks(link, OLD, { home, peers: [link] })).unknownNames, 1);
  assert.equal(writeKeepingLinks(link, OLD, { home, peers: [link, second] }).relinked, 1);
  assert.deepEqual([read(target), read(second), read(link), isLink(link), fs.statSync(target).nlink], [OLD, OLD, OLD, true, 2]);

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

  for (const point of ['record', 'temp']) {
    const failed = acc(h.home, ['check', '--repair'], { NOVARC_POWERS_TEST_FAULT: point });
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
    assert.deepEqual(strays(h.home), [], 'a temp file was left behind');
    assert.ok(!exists(path.join(h.sync, 'recovery')));
    assert.equal(failed.json.recovered, undefined);
  }

  // Once the disk has room again, the same check repairs both.
  const fixed = acc(h.home, ['check', '--repair']).json.accounts.find((a) => a.id === 'codex-1').elements;
  assert.deepEqual(fixed.filter((e) => e.repaired).map((e) => e.name), ['AGENTS.md', 'mcp servers/context7']);
  assert.ok(read(agents).includes('A rule added later. LATER-RULE\n'));
  assert.ok(read(toml).includes('args = ["-y", "context7-mcp@2"]\n') && !read(toml).includes('args = ["-y", "context7-mcp"]\n'));
});

test('a hardlinked settings.json survives a failed edit: both names hold the old bytes, as one file', (t) => {
  const HARD = { NOVARC_POWERS_NO_SYMLINK: '1' };
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  assert.equal(planAndApply(h, 'claude-1', ['--resolve', 'claude-2:CLAUDE.md=replace-with-primary'], HARD).apply.code, 0);
  const P = path.join(h.claude, 'settings.json');
  const S = path.join(h.acc, 'settings.json');
  assert.equal(fs.statSync(P).nlink, 2, 'the fixture did not produce a hardlinked settings.json');
  const before = read(P);
  assert.equal(JSON.parse(before).hooks.SessionStart, undefined);

  for (const point of ['temp', 'peer-staged']) {
    const failed = acc(h.home, ['install-check', '--yes'], { ...HARD, NOVARC_POWERS_TEST_FAULT: point });
    assert.equal(failed.code, 1, point);
    assert.match(failed.stderr, /no space left on device \(simulated\)/);
    assert.deepEqual([read(P), read(S), fs.statSync(P).nlink, ino(P) === ino(S)], [before, before, 2, true], point);
    assert.deepEqual(strays(h.home), [], `${point}: a temp name was left behind`);
    assert.ok(!exists(path.join(h.sync, 'recovery')));
  }

  const ok = acc(h.home, ['install-check', '--yes'], HARD);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(fs.statSync(P).nlink, 2, 'the edit left the second name behind');
  assert.equal(ino(P), ino(S));
  assert.equal(read(S), read(P));
  assert.match(json(S).hooks.SessionStart[0].hooks[0].command, /sync-check\.mjs" --repair$/);
  assert.equal(json(S).model, 'x', 'the rest of the file is intact');
});
