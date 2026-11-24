// A rename that is refused for a moment (EBUSY, EPERM, EACCES: a scanner holds the file) is tried
// again after a short wait. The last look at what is about to be replaced is taken before EVERY
// attempt: an edit, or a folder moved away, DURING that wait must be seen, and what changed must
// be left as it is. The refusal comes from the fault seam (`EBUSY@point#1` in
// NOVARC_POWERS_TEST_FAULT fails the first attempt at that point with that code); "another
// program" acts through the `at` hook at `<point>-retry`, or through NOVARC_POWERS_TEST_EDIT in
// a child process. Every assertion is on literal bytes. Temp dirs and a fake home only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  buildHome, acc, env, rmrf, write, read, exists, planAndApply, tmpDir, atomicSave, resolvesTo, SCRIPTS,
} from './accounts-fixture.mjs';
import { writeKeepingLinks, recoverWrites } from '../scripts/sync-check.mjs';
import { copyTree } from '../scripts/lib/accounts/fsops.mjs';

const OLD = 'ORIGINAL\n';
const NEW = 'APPROVED, and longer than the original was\n';
const EDIT = 'USER_EDIT_DURING_BUSY\n';
const CODES = ['EBUSY', 'EPERM', 'EACCES'];
const SYNC = ['.novarc-powers', 'novarc-harness-doctor', 'sync'];
const ino = (p) => String(fs.statSync(p, { bigint: true }).ino);
const changed = (reason) => `the file changed while this write was being prepared (${reason}); nothing was written`;

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

/** One file with three names: the primary's, and one in each of two other account folders. */
function three(t) {
  const root = tmpDir('hd-retry-');
  t.after(() => rmrf(root));
  const home = path.join(root, 'home');
  const P = path.join(home, '.claude', 'settings.json');
  const A = path.join(home, '.alt-a', 'settings.json');
  const B = path.join(home, '.alt-b', 'settings.json');
  write(P, OLD);
  for (const p of [A, B]) { fs.mkdirSync(path.dirname(p)); fs.linkSync(P, p); }
  const state = () => [P, A, B].map((p) => (exists(p) ? read(p) : null));
  const clean = () => { assert.deepEqual(strays(root), [], 'a temp name was left behind'); assert.ok(!exists(path.join(home, ...SYNC, 'recovery')), 'a record was left behind'); };
  /** `dir` is moved away; its name now leads to another folder holding a settings.json with the old bytes. */
  const redirect = (dir) => {
    const other = `${dir}-unrelated`;
    fs.renameSync(dir, `${dir}-moved`);
    write(path.join(other, 'settings.json'), OLD);
    fs.symlinkSync(other, dir, 'junction'); // a plain folder link outside Windows
    return path.join(other, 'settings.json');
  };
  return { root, home, P, A, B, state, clean, redirect };
}

let runs = 0;
/**
 * Run `fn(at, seen)` with the fault seam set to `spec`. `during` maps a point to what another
 * program does when the write reaches it; `seen[point]` counts how often each point was reached.
 */
function withFault(spec, during, fn) {
  const seen = {};
  const at = (point) => { seen[point] = (seen[point] || 0) + 1; if (during[point] && seen[point] === 1) during[point](); };
  process.env.NOVARC_POWERS_TEST_FAULT = `${spec},run${++runs}`; // the suffix matches no point: it only makes each run a new one
  try { return { value: fn(at), seen }; } catch (error) { return { error, seen }; } finally { delete process.env.NOVARC_POWERS_TEST_FAULT; }
}

test('the file: a rename refused once, then an edit before the retry: nothing is written; with no edit, the retry goes through', (t) => {
  for (const code of CODES) {
    // Edited in place during the wait (the old file, which all three names still are).
    let w = three(t);
    let r = withFault(`${code}@rename-file#1`, { 'rename-file-retry': () => fs.writeFileSync(w.P, EDIT) }, (at) => writeKeepingLinks(w.P, NEW, { home: w.home, peers: [w.A, w.B], at }));
    assert.deepEqual([r.error && r.error.code, r.error && r.error.message], ['ECHANGED', changed('it was edited')], code);
    assert.deepEqual(w.state(), [EDIT, EDIT, EDIT], `${code}: an edit made while the rename was refused was replaced`);
    assert.deepEqual([r.seen['rename-file'], fs.statSync(w.P).nlink], [1, 3], `${code}: a second attempt was made after the file had changed`);
    w.clean();

    // Saved as a new file during the wait.
    w = three(t);
    r = withFault(`${code}@rename-file#1`, { 'rename-file-retry': () => atomicSave(w.P, EDIT) }, (at) => writeKeepingLinks(w.P, NEW, { home: w.home, peers: [w.A, w.B], at }));
    assert.equal(r.error && r.error.message, changed('it was edited'), code);
    assert.deepEqual(w.state(), [EDIT, OLD, OLD], code);
    w.clean();

    // Nothing happened during the wait: the second attempt replaces the file.
    w = three(t);
    r = withFault(`${code}@rename-file#1`, {}, (at) => writeKeepingLinks(w.P, NEW, { home: w.home, peers: [w.A, w.B], at }));
    assert.deepEqual(r.value, { how: 'replaced', relinked: 2, pending: [] }, code);
    assert.deepEqual([w.state(), r.seen['rename-file'], r.seen['rename-file-retry']], [[NEW, NEW, NEW], 2, 1], code);
    assert.ok(fs.statSync(w.P).nlink === 3 && ino(w.P) === ino(w.A) && ino(w.P) === ino(w.B), code);
    w.clean();
  }
});

test('another name: a rename refused once, then an edit before the retry: that name is left as it is; with no edit, the retry goes through', (t) => {
  for (const code of CODES) {
    // The name is saved as a new file while its rename is refused.
    let w = three(t);
    let r = withFault(`${code}@rename-name#1`, { 'rename-name-retry': () => atomicSave(w.A, EDIT) }, (at) => writeKeepingLinks(w.P, NEW, { home: w.home, peers: [w.A, w.B], at }));
    assert.deepEqual(r.value, { how: 'replaced', relinked: 1, pending: [], left: [{ path: w.A, note: 'it was edited' }] }, code);
    assert.deepEqual(w.state(), [NEW, EDIT, NEW], `${code}: an edit made while the rename was refused was replaced`);
    assert.equal(ino(w.P), ino(w.B));
    w.clean();

    // Edited in place: the old file, which the second other name still is too.
    w = three(t);
    r = withFault(`${code}@rename-name#1`, { 'rename-name-retry': () => fs.writeFileSync(w.A, EDIT) }, (at) => writeKeepingLinks(w.P, NEW, { home: w.home, peers: [w.A, w.B], at }));
    assert.deepEqual(r.value, { how: 'replaced', relinked: 0, pending: [], left: [{ path: w.A, note: 'it was edited' }, { path: w.B, note: 'it was edited' }] }, code);
    assert.deepEqual(w.state(), [NEW, EDIT, EDIT], code);
    w.clean();

    // Nothing happened during the wait.
    w = three(t);
    r = withFault(`${code}@rename-name#1`, {}, (at) => writeKeepingLinks(w.P, NEW, { home: w.home, peers: [w.A, w.B], at }));
    assert.deepEqual(r.value, { how: 'replaced', relinked: 2, pending: [] }, code);
    assert.deepEqual([w.state(), r.seen['rename-name'], r.seen['rename-name-retry']], [[NEW, NEW, NEW], 3, 1], code);
    w.clean();
  }
});

test('a folder replaced while a rename is refused is seen before the retry', (t) => {
  // The folder of the file itself.
  let w = three(t);
  let other;
  let r = withFault('EBUSY@rename-file#1', { 'rename-file-retry': () => { other = w.redirect(path.dirname(w.P)); } }, (at) => writeKeepingLinks(w.P, NEW, { home: w.home, peers: [w.A, w.B], at }));
  assert.deepEqual([r.error && r.error.code, r.error && r.error.message], ['ECHANGED', changed('its folder was moved, replaced or redirected')]);
  assert.deepEqual([read(other), fs.readdirSync(path.dirname(other)), read(w.A), read(w.B)], [OLD, ['settings.json'], OLD, OLD], 'the write landed behind the redirected name');

  // The folder of another name.
  w = three(t);
  r = withFault('EBUSY@rename-name#1', { 'rename-name-retry': () => { other = w.redirect(path.dirname(w.A)); } }, (at) => writeKeepingLinks(w.P, NEW, { home: w.home, peers: [w.A, w.B], at }));
  assert.deepEqual(r.value, { how: 'replaced', relinked: 1, pending: [], left: [{ path: w.A, note: 'its folder was moved, replaced or redirected' }] });
  assert.deepEqual([read(w.P), read(w.B), read(other), fs.statSync(other).nlink, fs.readdirSync(path.dirname(other))], [NEW, NEW, OLD, 1, ['settings.json']], 'a file behind the redirected name was linked to the new content');
});

test('a rename that keeps being refused: the file is not written; another name waits for the next run', (t) => {
  let w = three(t);
  let r = withFault('EBUSY@rename-file', {}, (at) => writeKeepingLinks(w.P, NEW, { home: w.home, peers: [w.A, w.B], at }));
  assert.deepEqual([r.error && r.error.code, r.seen['rename-file']], ['EBUSY', 4]);
  assert.deepEqual(w.state(), [OLD, OLD, OLD]);
  assert.equal(fs.statSync(w.P).nlink, 3);
  w.clean();

  w = three(t);
  r = withFault('EBUSY@rename-name', {}, (at) => writeKeepingLinks(w.P, NEW, { home: w.home, peers: [w.A, w.B], at }));
  assert.deepEqual(r.value, { how: 'replaced', relinked: 0, pending: [w.A, w.B], why: 'EBUSY' });
  assert.deepEqual(w.state(), [NEW, OLD, OLD]);
  assert.deepEqual(recoverWrites({ home: w.home }), [{ file: '~/.claude/settings.json', outcome: 'completed', relinked: 2 }]);
  assert.deepEqual(w.state(), [NEW, NEW, NEW]);
  w.clean();
});

const WRITER = `
import { writeKeepingLinks } from ${JSON.stringify(pathToFileURL(path.join(SCRIPTS, 'sync-check.mjs')).href)};
writeKeepingLinks(process.env.T_FILE, process.env.T_DATA, { home: process.env.NOVARC_POWERS_HOME, peers: JSON.parse(process.env.T_PEERS) });
`;

/** A child process replaces the file and dies before it switches the other names. */
function dieCommitted(w) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', WRITER], {
    encoding: 'utf8', timeout: 60000, env: env(w.home, { NOVARC_POWERS_TEST_FAULT: 'kill@committed', T_FILE: w.P, T_DATA: NEW, T_PEERS: JSON.stringify([w.A, w.B]) }),
  });
  assert.notEqual(r.status, 0);
  assert.deepEqual(w.state(), [NEW, OLD, OLD]);
}

test('recovery: the same look before every attempt, for a name, its folder and the file itself', (t) => {
  const entry = (extra) => [{ file: '~/.claude/settings.json', outcome: 'completed', ...extra }];
  for (const code of CODES) {
    // The first name is saved as a new file while its rename is refused.
    let w = three(t);
    dieCommitted(w);
    let r = withFault(`${code}@rename-recovery#1`, { 'rename-recovery-retry': () => atomicSave(w.A, EDIT) }, (at) => recoverWrites({ home: w.home, at }));
    assert.deepEqual(r.value, entry({ relinked: 1, left: 1 }), code);
    assert.deepEqual(w.state(), [NEW, EDIT, NEW], `${code}: an edit made while the rename was refused was replaced`);
    w.clean();

    // Nothing happened during the wait.
    w = three(t);
    dieCommitted(w);
    r = withFault(`${code}@rename-recovery#1`, {}, (at) => recoverWrites({ home: w.home, at }));
    assert.deepEqual(r.value, entry({ relinked: 2 }), code);
    assert.deepEqual([w.state(), r.seen['rename-recovery'], r.seen['rename-recovery-retry']], [[NEW, NEW, NEW], 3, 1], code);
    w.clean();
  }
  // The folder of the first name is replaced during the wait.
  let w = three(t);
  dieCommitted(w);
  let other;
  let r = withFault('EBUSY@rename-recovery#1', { 'rename-recovery-retry': () => { other = w.redirect(path.dirname(w.A)); } }, (at) => recoverWrites({ home: w.home, at }));
  assert.deepEqual(r.value, entry({ relinked: 1, foreign: 1 }));
  assert.deepEqual([read(w.P), read(w.B), read(other), fs.statSync(other).nlink, fs.readdirSync(path.dirname(other))], [NEW, NEW, OLD, 1, ['settings.json']]);

  // The file itself is edited during the wait: no other name is switched to it any more.
  w = three(t);
  dieCommitted(w);
  r = withFault('EBUSY@rename-recovery#1', { 'rename-recovery-retry': () => fs.writeFileSync(w.P, EDIT) }, (at) => recoverWrites({ home: w.home, at }));
  assert.deepEqual(r.value, entry({ left: 2 }));
  assert.deepEqual(w.state(), [EDIT, OLD, OLD]);
  w.clean();
});

test('a folder built under a temp name: the place is looked at again before every attempt of its rename', (t) => {
  const world = () => {
    const root = tmpDir('hd-retry-');
    t.after(() => rmrf(root));
    const home = path.join(root, 'home');
    const src = path.join(root, 'source');
    write(path.join(src, 'a.md'), 'a\n');
    write(path.join(src, 'deep', 'b.md'), 'b\n');
    const parent = path.join(home, '.claude');
    fs.mkdirSync(parent, { recursive: true });
    return { root, home, src, parent, dst: path.join(parent, 'styles') };
  };
  const moved = (reason) => `the place changed while this was being made (${reason}); nothing was put there`;

  // The folder it was going into is moved away, with another folder under its name.
  let w = world();
  const other = path.join(w.root, 'another-folder');
  let r = withFault('EBUSY@rename-temp#1', { 'rename-temp-retry': () => { fs.renameSync(w.parent, `${w.parent}-moved`); fs.mkdirSync(other); fs.symlinkSync(other, w.parent, 'junction'); } }, (at) => copyTree(w.src, w.dst, { home: w.home, at }));
  assert.deepEqual([r.error && r.error.code, r.error && r.error.message], ['ECHANGED', moved('its folder was moved, replaced or redirected')]);
  assert.deepEqual(fs.readdirSync(other), [], 'the folder was put behind the redirected name');
  assert.ok(!exists(path.join(`${w.parent}-moved`, 'styles')));

  // Something appears under the very name during the wait.
  w = world();
  r = withFault('EBUSY@rename-temp#1', { 'rename-temp-retry': () => write(path.join(w.dst, 'theirs.md'), 'made by another program\n') }, (at) => copyTree(w.src, w.dst, { home: w.home, at }));
  assert.equal(r.error && r.error.message, moved('something was created at its place'));
  assert.deepEqual([fs.readdirSync(w.dst), read(path.join(w.dst, 'theirs.md'))], [['theirs.md'], 'made by another program\n']);
  assert.deepEqual(strays(w.home).filter((p) => !p.includes('.novarc-powers')), [], 'the temp folder was left behind');

  // Nothing happened: the second attempt puts the whole folder there.
  w = world();
  r = withFault('EBUSY@rename-temp#1', {}, (at) => copyTree(w.src, w.dst, { home: w.home, at }));
  assert.equal(r.error, undefined);
  assert.deepEqual([read(path.join(w.dst, 'a.md')), read(path.join(w.dst, 'deep', 'b.md')), r.seen['rename-temp']], ['a\n', 'b\n', 2]);
  assert.deepEqual(strays(w.root), []);
});

test('check --repair: a copy judged unedited, then edited while its rename is refused, is not replaced by the link', (t) => {
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  assert.equal(planAndApply(h, 'claude-1', ['--resolve', 'claude-2:CLAUDE.md=replace-with-primary']).apply.code, 0);
  const P = path.join(h.claude, 'keybindings.json');
  const S = path.join(h.acc, 'keybindings.json');
  const element = (r) => r.json.accounts[0].elements.find((e) => e.name === 'keybindings.json');
  // An identical copy where the link was: safe to link again, as far as the check can tell.
  fs.rmSync(S);
  fs.copyFileSync(P, S);
  const edited = acc(h.home, ['check', '--repair'], { NOVARC_POWERS_TEST_FAULT: 'EBUSY@rename-link#1', NOVARC_POWERS_TEST_EDIT: `rename-link-retry=${S}` });
  assert.deepEqual(element(edited), {
    name: 'keybindings.json', state: 'drift', note: 'edited while it was being linked again; not overwritten', decide: true,
    path: '~/.hostapp/host/harness-accounts/claude-code/acc-1/keybindings.json', source: '~/.claude/keybindings.json',
  });
  assert.deepEqual([read(S), read(P)], ['EDITED BY ANOTHER PROGRAM\n', '{"bindings": []}\n'], 'an edit made while the rename was refused was replaced by the link');
  assert.deepEqual(strays(h.acc), []);
  // Refused once and nothing else: the link is made by the second attempt.
  fs.copyFileSync(P, S);
  const fixed = acc(h.home, ['check', '--repair'], { NOVARC_POWERS_TEST_FAULT: 'EBUSY@rename-link#1' });
  assert.deepEqual([element(fixed).repaired, resolvesTo(S, P)], [true, true]);
});

test('apply: a file that something else rewrote after it was read for an edit is not written over', (t) => {
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  write(path.join(h.acc, 'keybindings.json'), '{"bindings": ["from the second account"]}\n');
  const planFile = path.join(h.root, 'plan.json');
  assert.equal(acc(h.home, ['plan', '--primary', 'claude-1', '--out', planFile, '--resolve', 'claude-2:keybindings.json=adopt-into-primary']).code, 0);
  const stale = { result: 'failed', stale: true, error: changed('it was edited') };
  // The app saves the second account's state file between the moment apply read it and the write.
  let r = acc(h.home, ['apply', '--plan', planFile, '--yes'], { NOVARC_POWERS_TEST_EDIT: `patch-intended=${h.state2}` });
  assert.equal(r.code, 1, r.stdout);
  assert.deepEqual(r.json.done.find((d) => d.element === 'mcp servers'), { account: 'claude-2', element: 'mcp servers', ...stale });
  assert.equal(read(h.state2), 'EDITED BY ANOTHER PROGRAM\n', 'the app\'s own save was written over with what apply had worked out from the older bytes');
  assert.equal(r.json.done.find((d) => d.element === 'keybindings.json').result, 'done');
  assert.equal(acc(h.home, ['undo', '--stamp', r.json.stamp, '--yes']).code, 0);

  // The primary's file is saved by something else after its backup was taken, before it is replaced.
  const P = path.join(h.claude, 'keybindings.json');
  fs.writeFileSync(h.state2, JSON.stringify({ mcpServers: {} }));
  assert.equal(acc(h.home, ['plan', '--primary', 'claude-1', '--out', planFile, '--resolve', 'claude-2:keybindings.json=adopt-into-primary']).code, 0);
  r = acc(h.home, ['apply', '--plan', planFile, '--yes'], { NOVARC_POWERS_TEST_EDIT: `overwrite-intended=${P}` });
  assert.equal(r.code, 1, r.stdout);
  assert.deepEqual(r.json.done.find((d) => d.element === 'keybindings.json'), { account: 'claude-2', element: 'keybindings.json', ...stale });
  assert.equal(read(P), 'EDITED BY ANOTHER PROGRAM\n', 'the primary\'s file was replaced although it had changed since its backup');
  assert.equal(read(path.join(h.acc, 'keybindings.json')), '{"bindings": ["from the second account"]}\n');
});
