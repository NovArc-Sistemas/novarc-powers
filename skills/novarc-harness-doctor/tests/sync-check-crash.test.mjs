// A process that DIES in the middle of a write (scripts/sync-check.mjs, writeKeepingLinks).
// The writer is a child process that kills itself at a named point (NOVARC_POWERS_TEST_FAULT
// with `kill@point`: SIGKILL, nothing unwound). The test then reads the literal bytes of every
// name of the file, starts FRESH processes for `check` and `check --repair`, and reads them
// again: each name must hold the complete old bytes or the complete new bytes at every moment,
// and the next run that may write must finish the job and say so.
// Hardlinks are used on every platform (they are what Windows falls back to where symbolic
// links are refused). Everything runs in temp dirs with a fake home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  buildHome, acc, check, env, rmrf, write, read, json, exists, snapshot, planAndApply, tmpDir, resolvesTo, SCRIPTS,
} from './accounts-fixture.mjs';
import { recoverWrites, recoveryDir } from '../scripts/sync-check.mjs';

const OLD = 'ORIGINAL_CONTENT_12345678\n';
const NEW = 'NEW_CONTENT_ABCDEFGHIJ, and longer than the original so that a short write shows\n';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ino = (p) => String(fs.statSync(p, { bigint: true }).ino);
const SYNC = ['.novarc-powers', 'novarc-harness-doctor', 'sync'];

/** Every name under `root` that looks like a temp file of the tool (links are not entered). */
function strays(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.includes('.nhd-')) out.push(path.join(d, e.name));
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(root);
  return out.sort();
}

/** Make a file look as if it had been lying there for five minutes. */
function age(file) {
  const then = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(file, then, then);
}

const WRITER = `
import { writeKeepingLinks } from ${JSON.stringify(pathToFileURL(path.join(SCRIPTS, 'sync-check.mjs')).href)};
writeKeepingLinks(process.env.T_FILE, process.env.T_DATA, { home: process.env.NOVARC_POWERS_HOME });
process.stdout.write('RETURNED');
`;

/** A child process writes `data` to `file` and dies at `point`. */
function dieWriting(home, file, data, point) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', WRITER], {
    encoding: 'utf8', timeout: 60000, env: env(home, { NOVARC_POWERS_TEST_FAULT: `kill@${point}`, T_FILE: file, T_DATA: data }),
  });
  assert.notEqual(r.status, 0, `${point}: the writer was meant to die`);
  assert.equal(r.stdout, '', `${point}: the writer got to the end`);
  assert.equal(r.stderr, '', `${point}: the writer failed instead of dying`);
}

/**
 * The primary's settings.json with two more names, in two other account folders, as the
 * hardlink fallback leaves them; a manifest records both.
 */
function world(t) {
  const root = tmpDir('hd-crash-');
  t.after(() => rmrf(root));
  const home = path.join(root, 'home');
  const P = path.join(home, '.claude', 'settings.json');
  const A = path.join(home, '.alt-a', 'settings.json');
  const B = path.join(home, '.alt-b', 'settings.json');
  write(P, OLD);
  for (const p of [A, B]) { fs.mkdirSync(path.dirname(p)); fs.linkSync(P, p); }
  const account = (id, file) => ({ id, provider: 'claude-code', pathAbs: path.dirname(file), mode: 'linked', exceptions: [], elements: [{ name: 'settings.json', kind: 'hardlink', path: file, target: P, contentHash: sha256(OLD) }] });
  write(path.join(home, ...SYNC, 'manifest.json'), JSON.stringify({ version: 1, tool: 'novarc-harness-doctor', primary: 'claude-1', primaryPathAbs: path.dirname(P), accounts: [account('claude-2', A), account('claude-3', B)] }, null, 2));
  const state = () => [read(P), read(A), read(B)];
  const oneFile = () => fs.statSync(P).nlink === 3 && ino(P) === ino(A) && ino(P) === ino(B);
  const report = (args) => { const r = check(home, [...args, '--json']); assert.equal(r.code, 0); return JSON.parse(r.stdout); };
  return { root, home, P, A, B, state, oneFile, report, recovery: path.join(home, ...SYNC, 'recovery') };
}

// The point of death, what each of the three names holds right after it, and what the next run
// that may write reports. `null`: no record was complete yet, so there is nothing to report.
const POINTS = [
  ['record', [OLD, OLD, OLD], null], // half of the record of the write is on disk
  ['intent', [OLD, OLD, OLD], { outcome: 'rolled-back' }], // the record is durable, nothing else exists
  ['temp', [OLD, OLD, OLD], { outcome: 'rolled-back' }], // half of the new bytes are in the temp file
  ['staged', [OLD, OLD, OLD], { outcome: 'rolled-back' }], // the temp file is complete
  ['peer-staged', [OLD, OLD, OLD], { outcome: 'rolled-back' }], // a link for the first other name is ready
  ['peer-staged#2', [OLD, OLD, OLD], { outcome: 'rolled-back' }], // ... and for the second
  ['committed', [NEW, OLD, OLD], { outcome: 'completed', relinked: 2 }], // right after the rename over the file
  ['peer#2', [NEW, NEW, OLD], { outcome: 'completed', relinked: 1 }], // between the two other names
  ['finished', [NEW, NEW, NEW], { outcome: 'completed' }], // all done but the record
];

for (const [point, after, outcome] of POINTS) {
  test(`a writer killed at "${point}": every name holds complete bytes, and the next check --repair settles it`, (t) => {
    const w = world(t);
    assert.ok(w.oneFile());
    dieWriting(w.home, w.P, NEW, point);

    // 1. Right after the death.
    assert.deepEqual(w.state(), after, 'a name holds neither the complete old nor the complete new bytes');
    if (point === 'temp') {
      const left = strays(path.dirname(w.P));
      assert.equal(left.length, 1);
      assert.equal(read(left[0]), NEW.slice(0, NEW.length >> 1), 'the fixture did not die in the middle of the write');
    }
    const leftovers = strays(w.root);

    // 2. A fresh, read-only check: says what is waiting, touches nothing.
    const seen = w.report([]);
    assert.deepEqual(seen.recovered, outcome ? [{ file: '~/.claude/settings.json', outcome: 'pending' }] : undefined);
    assert.deepEqual(w.state(), after);
    assert.deepEqual(strays(w.root), leftovers, 'a read-only check removed something');

    // 3. A fresh check --repair: the write is finished, or cleared, and reported.
    const fixed = w.report(['--repair']);
    assert.deepEqual(fixed.recovered, outcome ? [{ file: '~/.claude/settings.json', ...outcome }] : undefined);
    const whole = after[0] === NEW ? NEW : OLD;
    assert.deepEqual(w.state(), [whole, whole, whole]);
    assert.ok(w.oneFile(), 'the three names are not one file again');
    assert.equal(fixed.status, 'ok');

    if (!outcome) {
      // Half a record: a temp file of the tool's own folder, cleared once it is plainly a leftover.
      const half = strays(w.root);
      assert.equal(half.length, 1);
      assert.equal(path.dirname(half[0]), w.recovery);
      age(half[0]);
      const swept = w.report(['--repair']).recovered;
      assert.equal(swept.length, 1);
      assert.deepEqual([swept[0].outcome, swept[0].leftovers], ['removed', 1]);
      assert.match(swept[0].file, /^~\/\.novarc-powers\/novarc-harness-doctor\/sync\/recovery\/[^/]+\.json\.nhd-\d+-[0-9a-f]{8}\.tmp$/);
    }

    // 4. Nothing of the dead run is left, and the next session start has nothing to say.
    assert.deepEqual(strays(w.root), []);
    assert.ok(!exists(w.recovery), 'the recovery folder was left behind');
    assert.deepEqual([check(w.home, ['--repair']).stdout, w.report(['--repair']).recovered], ['', undefined]);
    assert.deepEqual(w.state(), [whole, whole, whole]);
  });
}

test('recovery never touches a name that changed since the death', (t) => {
  // The file itself was edited after the rename went through: nothing is switched over.
  const w = world(t);
  dieWriting(w.home, w.P, NEW, 'committed');
  fs.writeFileSync(w.P, 'EDITED AFTER THE CRASH\n');
  assert.deepEqual(recoverWrites({ home: w.home }), [{ file: '~/.claude/settings.json', outcome: 'abandoned' }]);
  assert.deepEqual(w.state(), ['EDITED AFTER THE CRASH\n', OLD, OLD]);
  assert.deepEqual(strays(w.root), []);
  assert.ok(!exists(w.recovery));
  // From here on it is the ordinary rule of the check, not recovery: the other names still hold
  // the bytes last seen through the link, so nobody edited them and they are linked again.
  assert.equal(w.report(['--repair']).recovered, undefined);
  assert.deepEqual(w.state(), ['EDITED AFTER THE CRASH\n', 'EDITED AFTER THE CRASH\n', 'EDITED AFTER THE CRASH\n']);
  assert.ok(resolvesTo(w.A, w.P) && resolvesTo(w.B, w.P), 'the untouched names were not linked to the primary again');

  // One of the other names was saved again by an editor (a new file, other bytes): it is left,
  // the untouched one follows.
  const v = world(t);
  dieWriting(v.home, v.P, NEW, 'committed');
  fs.writeFileSync(`${v.A}.save`, 'TYPED IN THE SECOND ACCOUNT\n');
  fs.renameSync(`${v.A}.save`, v.A);
  assert.deepEqual(v.state(), [NEW, 'TYPED IN THE SECOND ACCOUNT\n', OLD]);
  assert.deepEqual(v.report(['--repair']).recovered, [{ file: '~/.claude/settings.json', outcome: 'completed', relinked: 1, left: 1 }]);
  assert.deepEqual(v.state(), [NEW, 'TYPED IN THE SECOND ACCOUNT\n', NEW]);
  assert.equal(ino(v.P), ino(v.B));
  assert.notEqual(ino(v.P), ino(v.A));
  assert.deepEqual(strays(v.root), []);
});

test('recovery acts only on temp files of the tool, in a folder the record proves, whatever a record says', (t) => {
  const root = tmpDir('hd-crash-');
  t.after(() => rmrf(root));
  const home = path.join(root, 'home');
  const dir = recoveryDir(home);
  const user = path.join(root, 'user');
  const precious = ['a.txt', 'b.txt', path.join('tree', 'kept.md')].map((n) => path.join(user, n));
  for (const p of precious) write(p, `precious ${path.basename(p)}\n`);
  /** What a genuine record says about where a path is: its real folder and that folder's identity. */
  const place = (p) => { const s = fs.statSync(path.dirname(p), { bigint: true }); return { parent: path.dirname(p), parentId: `${s.dev}:${s.ino}` }; };
  const target = path.join(user, 'target.txt');
  const victim = path.join(user, 'victim.txt');
  write(target, NEW);
  write(victim, 'something else entirely\n');
  // Real leftovers: a temp file, and a temp folder that holds a file and a link into the user's tree.
  const realTemp = path.join(user, 'tree', 'copy.md.nhd-4242-0a1b2c3d.tmp');
  write(realTemp, 'half a copy');
  const realTempDir = path.join(user, 'styles.nhd-4242-0a1b2c3e.tmp');
  write(path.join(realTempDir, 'inner', 'half.md'), 'half a folder');
  fs.symlinkSync(path.join(user, 'tree'), path.join(realTempDir, 'into-the-users-tree'), 'junction');
  const victimTemp = `${victim}.nhd-4242-0a1b2c40.tmp`;
  write(victimTemp, 'a link the dead run never finished');
  // Files that merely have a temp name, in folders no record proves.
  const lookalikes = ['one.md.nhd-4242-0a1b2c3f.tmp', 'two.md.nhd-4242-0a1b2c41.tmp', 'far.txt.nhd-4242-0a1b2c42.tmp'].map((n) => path.join(user, 'elsewhere', n));
  for (const p of lookalikes) write(p, 'named like a temp, not one\n');
  const record = (name, body) => write(path.join(dir, name), JSON.stringify({ version: 1, tool: 'novarc-harness-doctor', pid: 4242, startedAt: '2026-01-01T00:00:00.000Z', state: 'writing', ...body }));
  // 1. Things to "clean up": the user's file and folder, a bare path, a temp name with no proof
  //    of its folder, one with the proof of another folder, and the two real leftovers.
  record('1.json', { cleanup: [
    { path: precious[0], ...place(precious[0]) }, { path: path.join(user, 'tree'), ...place(path.join(user, 'tree')) }, realTemp,
    { path: lookalikes[0] }, { path: lookalikes[1], ...place(target) },
    { path: realTemp, ...place(realTemp) }, { path: realTempDir, ...place(realTempDir) },
  ] });
  // 2. A write that "went through", whose other names are a file with other bytes, and a file
  //    in a folder the record does not prove.
  const far = path.join(user, 'elsewhere', 'far.txt');
  write(far, OLD);
  record('2.json', { target, tmp: `${target}.nhd-4242-0a1b2c43.tmp`, before: sha256(OLD), after: sha256(NEW), id: null, ...place(target), peers: [
    { path: victim, tmp: victimTemp, ...place(victim) }, { path: far, tmp: lookalikes[2], ...place(target) }, { path: 'relative', tmp: precious[1] },
  ] });
  // 3. A write whose "temp file" is the user's file. 4. Nonsense. 5. Not JSON.
  record('3.json', { target, tmp: precious[1], before: sha256(OLD), after: sha256(NEW), ...place(target), peers: [] });
  record('4.json', { target: 'relative.txt', tmp: 7, before: null, after: 12, peers: 'nonsense' });
  write(path.join(dir, '5.json'), '{ not json');
  write(path.join(dir, 'notes.txt'), 'not a record: not this tool\'s to remove\n');

  const shown = (p) => p.replace(/\\/g, '/');
  const before = snapshot(user);
  assert.equal(recoverWrites({ home, repair: false }).length, 4, 'four of the five records leave something to report');
  assert.deepEqual(snapshot(user), before, 'a read-only look changed something');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['1.json', '2.json', '3.json', '4.json', '5.json', 'notes.txt']);

  assert.deepEqual(recoverWrites({ home }), [
    { file: shown(lookalikes[0]), outcome: 'conflict', note: 'its folder is not the one the write was made in (moved, replaced or redirected since)', leftovers: 2 },
    { file: shown(target), outcome: 'completed', left: 1, foreign: 1 },
    { file: '~/.novarc-powers/novarc-harness-doctor/sync/recovery/3.json', outcome: 'removed', note: 'a record that cannot be used' },
    { file: '~/.novarc-powers/novarc-harness-doctor/sync/recovery/5.json', outcome: 'removed', note: 'a record that cannot be read' },
  ]);
  for (const p of precious) assert.equal(read(p), `precious ${path.basename(p)}\n`, `${path.basename(p)} was touched`);
  for (const p of lookalikes) assert.equal(read(p), 'named like a temp, not one\n', 'a file was removed for its name alone');
  assert.deepEqual([read(target), read(victim), read(far), fs.statSync(far).nlink], [NEW, 'something else entirely\n', OLD, 1]);
  assert.ok(!exists(realTemp) && !exists(realTempDir) && !exists(victimTemp), 'a real leftover was not removed');
  assert.deepEqual(fs.readdirSync(dir), ['notes.txt'], 'the records were not cleared, or a foreign file was');
});

test('install-check killed right after the rename: the linked account keeps its old bytes until the next session start switches it over', (t) => {
  const HARD = { NOVARC_POWERS_NO_SYMLINK: '1' }; // as where symbolic links are refused
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  assert.equal(planAndApply(h, 'claude-1', ['--resolve', 'claude-2:CLAUDE.md=replace-with-primary'], HARD).apply.code, 0);
  const P = path.join(h.claude, 'settings.json');
  const S = path.join(h.acc, 'settings.json');
  assert.deepEqual([fs.statSync(P).nlink, ino(P) === ino(S)], [2, true], 'the fixture did not produce a hardlinked settings.json');
  const before = read(P);

  const dead = acc(h.home, ['install-check', '--yes'], { ...HARD, NOVARC_POWERS_TEST_FAULT: 'kill@committed' });
  assert.notEqual(dead.code, 0);
  assert.equal(dead.stdout, '');
  const now = read(P);
  assert.equal(JSON.parse(now).hooks.SessionStart.length, 1, 'the primary does not hold the complete new file');
  assert.equal(read(S), before, 'the other name does not hold the complete old file');

  // Any read-only command says that something is waiting, and changes nothing.
  const list = acc(h.home, ['list'], HARD);
  assert.equal(list.code, 0);
  assert.deepEqual(list.json.recovered, [{ file: '~/.claude/settings.json', outcome: 'pending' }]);
  assert.equal(list.stderr, '[harness-doctor] ~/.claude/settings.json: left unfinished by an interrupted run (a check with --repair deals with it)\n');
  assert.deepEqual([read(P), read(S)], [now, before]);

  // The session-start hook finishes it and says so, once.
  const hook = check(h.home, ['--repair'], { extra: HARD });
  assert.equal(hook.stdout, 'novarc-harness-doctor account sync: recovered 1 (~/.claude/settings.json: an interrupted write had gone through; 1 other name of the file now follows it).\n');
  assert.deepEqual([read(P), read(S), fs.statSync(P).nlink, ino(P) === ino(S)], [now, now, 2, true]);
  assert.deepEqual(strays(h.home), []);
  assert.ok(!exists(path.join(h.sync, 'recovery')));
  assert.equal(check(h.home, ['--repair'], { extra: HARD }).stdout, '');
  assert.equal(acc(h.home, ['list'], HARD).json.recovered, undefined);
});

test('apply killed in the middle of a write: the file is as it was, the leftovers are cleared, and undo takes the run back', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  const harness = () => Object.fromEntries(Object.entries(snapshot(h.home)).filter(([k]) => !k.includes('.novarc-powers')));
  const before = harness();
  const state2 = read(h.state2);
  const planFile = path.join(h.root, 'plan.json');
  assert.equal(acc(h.home, ['plan', '--primary', 'claude-1', '--out', planFile, '--resolve', 'claude-2:CLAUDE.md=replace-with-primary']).code, 0);

  // The first file `apply` writes is the second account's state file (its MCP servers).
  const dead = acc(h.home, ['apply', '--plan', planFile, '--yes'], { NOVARC_POWERS_TEST_FAULT: 'kill@temp' });
  assert.notEqual(dead.code, 0);
  assert.equal(dead.stdout, '');
  assert.equal(read(h.state2), state2, 'the state file changed although the write never finished');
  const left = strays(h.home).filter((p) => !p.includes('.novarc-powers'));
  assert.equal(left.length, 1);
  assert.match(left[0], /acc-1[\\/]\.claude\.json\.nhd-\d+-[0-9a-f]{8}\.tmp$/);
  assert.notDeepEqual(harness(), before, 'the fixture died before the run changed anything');

  // The next command that may write clears it; a dry run before that only reports it.
  const dry = acc(h.home, ['apply', '--plan', planFile, '--dry-run']);
  assert.deepEqual(dry.json.recovered, [{ file: '~/.hostapp/host/harness-accounts/claude-code/acc-1/.claude.json', outcome: 'pending' }]);
  assert.equal(strays(h.home).filter((p) => !p.includes('.novarc-powers')).length, 1);
  const stamps = fs.readdirSync(path.join(h.sync, 'backups'));
  assert.equal(stamps.length, 1);
  const undo = acc(h.home, ['undo', '--stamp', stamps[0], '--yes']);
  assert.equal(undo.code, 0, undo.stdout + undo.stderr);
  assert.deepEqual(undo.json.recovered, [{ file: '~/.hostapp/host/harness-accounts/claude-code/acc-1/.claude.json', outcome: 'rolled-back' }]);
  assert.match(undo.stderr, /acc-1\/\.claude\.json: an interrupted write had not gone through; the file is as it was/);
  assert.deepEqual([undo.json.ok, undo.json.pending, undo.json.conflicts], [true, 0, []]);
  assert.equal(read(h.state2), state2);
  assert.deepEqual(strays(h.home), []);
  assert.deepEqual(harness(), before, 'the tree is not byte-identical to what it was before the dead run');
});

test('apply refuses to replace a file of the primary that has a name nobody recorded, and says how many', (t) => {
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  const P = path.join(h.claude, 'keybindings.json');
  const S = path.join(h.acc, 'keybindings.json');
  const outside = path.join(h.root, 'dotfiles', 'keys.json');
  fs.mkdirSync(path.dirname(outside));
  fs.linkSync(P, outside); // a second name of the primary's file, kept by hand outside every account
  write(S, '{"bindings": ["from the second account"]}\n');
  const { plan, apply } = planAndApply(h, 'claude-1', ['--resolve', 'claude-2:keybindings.json=adopt-into-primary']);
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(apply.code, 1, apply.stdout);
  assert.deepEqual(apply.json.done.find((d) => d.element === 'keybindings.json'), {
    account: 'claude-2', element: 'keybindings.json', result: 'failed', decide: true, unknownNames: 1,
    error: 'the file has 1 other name (hardlink) that this tool has no record of; replacing it would leave it behind with the old content, so nothing was written. Remove it or turn it into a symbolic link, then run this again',
  });
  assert.deepEqual([read(P), read(outside), fs.statSync(P).nlink, ino(P) === ino(outside)], ['{"bindings": []}\n', '{"bindings": []}\n', 2, true]);
  assert.equal(read(S), '{"bindings": ["from the second account"]}\n', 'the account\'s own file was touched');
  assert.ok(apply.json.done.some((d) => d.element === 'settings.json' && d.result === 'done'), 'the other steps still ran');
  assert.deepEqual(strays(h.home), []);
  assert.ok(!exists(path.join(h.sync, 'recovery')));
});

test('leftovers of a killed run are cleared at the next run that may write, and reported', (t) => {
  const ALL = ['--resolve', 'claude-2:CLAUDE.md=replace-with-primary', '--resolve', 'claude-2:skills/=replace-with-primary'];
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  const applied = planAndApply(h, 'claude-1', ALL);
  assert.equal(applied.apply.code, 0, applied.apply.stdout);

  // 1. The check dies while it links a file again: a temp link is left beside the file.
  const P = path.join(h.claude, 'keybindings.json');
  const S = path.join(h.acc, 'keybindings.json');
  fs.rmSync(S);
  fs.copyFileSync(P, S); // an identical copy where the link was: safe to link again
  const dead = check(h.home, ['--repair'], { extra: { NOVARC_POWERS_TEST_FAULT: 'kill@linked' } });
  assert.notEqual(dead.code, 0);
  assert.deepEqual([read(S), read(P)], ['{"bindings": []}\n', '{"bindings": []}\n']);
  const temp = strays(h.acc);
  assert.equal(temp.length, 1);
  assert.match(temp[0], /keybindings\.json\.nhd-\d+-[0-9a-f]{8}\.tmp$/);
  const display = `~/.hostapp/host/harness-accounts/claude-code/acc-1/${path.basename(temp[0])}`;
  // Read-only: reported, still there.
  assert.deepEqual(acc(h.home, ['check']).json.recovered, [{ file: display, outcome: 'pending', leftovers: 1 }]);
  assert.deepEqual(strays(h.acc), temp);
  // With --repair: removed and said, then the link is made as usual.
  assert.equal(check(h.home, ['--repair']).stdout, `novarc-harness-doctor account sync: recovered 1 (${display}: a leftover temp file removed); repaired 1 (claude-2 keybindings.json).\n`);
  assert.deepEqual(strays(h.home), []);
  assert.ok(resolvesTo(S, P));
  assert.equal(read(P), '{"bindings": []}\n');

  // 2. Temp files of the tool's own bookkeeping: a leftover once they are a minute old.
  const oldOnes = [path.join(h.sync, 'journal.json.nhd-4242-0a1b2c3d.tmp'), path.join(h.sync, 'manifest.json.nhd-4242-0a1b2c3d.tmp')];
  const young = path.join(h.sync, 'sync-check.mjs.nhd-4242-0a1b2c3e.tmp');
  for (const f of [...oldOnes, young]) write(f, '{"half": ');
  for (const f of oldOnes) age(f);
  const entries = (outcome) => [
    { file: '~/.novarc-powers/novarc-harness-doctor/sync/journal.json.nhd-4242-0a1b2c3d.tmp', outcome, leftovers: 1 },
    { file: '~/.novarc-powers/novarc-harness-doctor/sync/manifest.json.nhd-4242-0a1b2c3d.tmp', outcome, leftovers: 1 },
  ];
  assert.deepEqual(acc(h.home, ['check']).json.recovered, entries('pending'));
  assert.ok(oldOnes.every(exists), 'a read-only check removed something');
  assert.deepEqual(acc(h.home, ['check', '--repair']).json.recovered, entries('removed'));
  assert.deepEqual(strays(h.home), [young], 'a temp file a running command may still be using was removed');
  age(young);
  assert.equal(check(h.home, ['--repair']).stdout, 'novarc-harness-doctor account sync: recovered 1 (~/.novarc-powers/novarc-harness-doctor/sync/sync-check.mjs.nhd-4242-0a1b2c3e.tmp: a leftover temp file removed).\n');
  assert.deepEqual(strays(h.home), []);
  assert.equal(check(h.home, ['--repair']).stdout, '');
});

test('a folder brought into the primary appears whole or not at all, and a copy that dies leaves one temp folder', (t) => {
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  write(path.join(h.acc, 'output-styles', 'brief.md'), 'Brief.\n'); // beside the fixture's terse.md
  const files = { 'brief.md': 'Brief.\n', 'terse.md': 'Terse.\n' };
  const planFile = path.join(h.root, 'plan.json');
  assert.equal(acc(h.home, ['plan', '--primary', 'claude-1', '--out', planFile, '--resolve', 'claude-2:output-styles/=adopt-into-primary']).code, 0);
  // Dies with the first of the two files copied.
  const dead = acc(h.home, ['apply', '--plan', planFile, '--yes'], { NOVARC_POWERS_TEST_FAULT: 'kill@tree-file#1' });
  assert.notEqual(dead.code, 0);
  assert.ok(!exists(path.join(h.claude, 'output-styles')), 'the folder shows in the primary although its copy never finished');
  const temp = fs.readdirSync(h.claude).filter((n) => n.includes('.nhd-'));
  assert.equal(temp.length, 1);
  assert.match(temp[0], /^output-styles\.nhd-\d+-[0-9a-f]{8}\.tmp$/);
  assert.deepEqual(fs.readdirSync(path.join(h.claude, temp[0])), ['brief.md'], 'the fixture did not die in the middle of the copy');
  for (const [n, body] of Object.entries(files)) assert.equal(read(path.join(h.acc, 'output-styles', n)), body, 'the account\'s own folder was touched');

  assert.deepEqual(acc(h.home, ['check', '--repair']).json.recovered, [{ file: `~/.claude/${temp[0]}`, outcome: 'removed', leftovers: 1 }]);
  assert.ok(!exists(path.join(h.claude, 'output-styles')));
  assert.deepEqual(strays(h.home), []);
});
