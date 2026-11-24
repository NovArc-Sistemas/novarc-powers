// Two rules of scripts/sync-check.mjs that equal bytes must never override:
//   1. nothing is replaced on the strength of what it was when a write was prepared: the file,
//      and each other name of it, is looked at again right before its rename, and one that
//      something else changed in the meantime is left exactly as it is;
//   2. a path is a place only while its real folder and that folder's identity are the recorded
//      ones: recovery (and the undo of `accounts.mjs apply`) touch nothing behind a folder that
//      was moved away and replaced by a link, or by another folder, whatever bytes sit there.
// "Something else" acts through the `at` hook of writeKeepingLinks, which is called at each point
// a write passes; a dead writer is a child process that kills itself (NOVARC_POWERS_TEST_FAULT).
// Every assertion is on literal bytes. Everything runs in temp dirs with a fake home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  buildHome, acc, check, env, rmrf, write, read, json, exists, snapshot, planAndApply, tmpDir, atomicSave, dropLink, CAN_SYMLINK, SCRIPTS,
} from './accounts-fixture.mjs';
import { writeKeepingLinks } from '../scripts/sync-check.mjs';

const OLD = 'ORIGINAL\n';
const NEW = 'APPROVED, and longer than the original was\n';
const EDIT = 'USER_EDIT_AFTER_COMMIT\n';
const ino = (p) => String(fs.statSync(p, { bigint: true }).ino);
const SYNC = ['.novarc-powers', 'novarc-harness-doctor', 'sync'];
const ELSEWHERE = 'its folder is not the one the write was made in (moved, replaced or redirected since)';

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

/** One file with three names: the primary's, and one in each of two other account folders. */
function three(t) {
  const root = tmpDir('hd-place-');
  t.after(() => rmrf(root));
  const home = path.join(root, 'home');
  const P = path.join(home, '.claude', 'settings.json');
  const A = path.join(home, '.alt-a', 'settings.json');
  const B = path.join(home, '.alt-b', 'settings.json');
  write(P, OLD);
  for (const p of [A, B]) { fs.mkdirSync(path.dirname(p)); fs.linkSync(P, p); }
  const state = () => [P, A, B].map((p) => (exists(p) && fs.statSync(p).isFile() ? read(p) : null));
  const clean = () => { assert.deepEqual(strays(root), [], 'a temp name was left behind'); assert.ok(!exists(path.join(home, ...SYNC, 'recovery')), 'a record was left behind'); };
  /** `dir` is moved away, and its name now leads to another folder that holds `files`. */
  const redirect = (dir, files, type = 'junction') => {
    const moved = `${dir}-moved`;
    const other = `${dir}-unrelated`;
    fs.renameSync(dir, moved);
    for (const [name, body] of Object.entries(files)) write(path.join(other, name), body);
    fs.mkdirSync(other, { recursive: true });
    fs.symlinkSync(other, dir, type); // `junction` is a plain folder link outside Windows
    return { moved, other, back: () => { dropLink(dir); fs.renameSync(moved, dir); } };
  };
  return { root, home, P, A, B, state, clean, redirect, peers: [A, B] };
}

/** Run a write, with `fn` doing at `when` (a point, or the n-th time a point is reached) what another program might. */
function writeWhile(w, when, fn, file = w.P) {
  const [name, nth = '1'] = when.split('#');
  let n = 0;
  let acted = false;
  let result;
  let error;
  try { result = writeKeepingLinks(file, NEW, { home: w.home, peers: w.peers, at: (point) => { if (point === name && ++n === Number(nth)) { acted = true; fn(); } } }); } catch (e) { error = e; }
  assert.ok(acted, `the write never passed "${when}"`);
  return { result, error };
}

test('another name edited after the file was replaced, and before that name is switched, is left as it is', (t) => {
  // In place: the old file is edited, and both other names are still names of it.
  let w = three(t);
  let r = writeWhile(w, 'committed', () => fs.writeFileSync(w.A, EDIT));
  assert.deepEqual(r.result, { how: 'replaced', relinked: 0, pending: [], left: [{ path: w.A, note: 'it was edited' }, { path: w.B, note: 'it was edited' }] });
  assert.deepEqual(w.state(), [NEW, EDIT, EDIT], 'an edit made after the commit was replaced');
  w.clean();

  // Saved the way editors do (a new file under the same name): only that name is left.
  w = three(t);
  r = writeWhile(w, 'committed', () => atomicSave(w.A, EDIT));
  assert.deepEqual(r.result, { how: 'replaced', relinked: 1, pending: [], left: [{ path: w.A, note: 'it was edited' }] });
  assert.deepEqual(w.state(), [NEW, EDIT, NEW]);
  assert.equal(ino(w.P), ino(w.B));
  w.clean();

  // Between the two switches.
  w = three(t);
  r = writeWhile(w, 'peer#2', () => atomicSave(w.B, EDIT));
  assert.deepEqual(r.result, { how: 'replaced', relinked: 1, pending: [], left: [{ path: w.B, note: 'it was edited' }] });
  assert.deepEqual(w.state(), [NEW, NEW, EDIT]);
  w.clean();

  // Removed, or turned into something that is not a file.
  w = three(t);
  r = writeWhile(w, 'committed', () => { fs.rmSync(w.A); fs.rmSync(w.B); fs.mkdirSync(w.B); });
  assert.deepEqual(r.result.left, [{ path: w.A, note: 'it was removed' }, { path: w.B, note: 'it was replaced by something that is not a plain file' }]);
  assert.deepEqual([read(w.P), exists(w.A), fs.statSync(w.B).isDirectory(), r.result.relinked], [NEW, false, true, 0]);
  w.clean();

  // Its folder moved away, with another folder holding the very same bytes behind its name.
  w = three(t);
  let there;
  r = writeWhile(w, 'committed', () => { there = w.redirect(path.dirname(w.A), { 'settings.json': OLD }); });
  assert.deepEqual(r.result, { how: 'replaced', relinked: 1, pending: [], left: [{ path: w.A, note: 'its folder was moved, replaced or redirected' }] });
  assert.deepEqual([read(w.P), read(w.B), read(path.join(there.other, 'settings.json')), read(path.join(there.moved, 'settings.json'))], [NEW, NEW, OLD, OLD]);
  assert.notEqual(ino(path.join(there.other, 'settings.json')), ino(w.P), 'a file in another folder was linked to the new content');
  assert.deepEqual(fs.readdirSync(there.other), ['settings.json'], 'something was written into the other folder');
});

test('the file itself changed between the preparation of a write and its rename: nothing is written, and the call says so', (t) => {
  const changed = (reason) => `the file changed while this write was being prepared (${reason}); nothing was written`;
  // Edited in place while the new bytes were being staged: all three names are the same file.
  let w = three(t);
  let r = writeWhile(w, 'staged', () => fs.writeFileSync(w.P, EDIT));
  assert.deepEqual([r.error && r.error.code, r.error && r.error.message], ['ECHANGED', changed('it was edited')]);
  assert.deepEqual(w.state(), [EDIT, EDIT, EDIT]);
  assert.equal(fs.statSync(w.P).nlink, 3);
  w.clean();

  // Saved as a new file at the last moment before the rename.
  w = three(t);
  r = writeWhile(w, 'peer-staged#2', () => atomicSave(w.P, EDIT));
  assert.deepEqual([r.error && r.error.code, r.error && r.error.message], ['ECHANGED', changed('it was edited')]);
  assert.deepEqual(w.state(), [EDIT, OLD, OLD]);
  w.clean();

  w = three(t);
  r = writeWhile(w, 'staged', () => fs.rmSync(w.P));
  assert.equal(r.error && r.error.message, changed('it was removed'));
  assert.deepEqual(w.state(), [null, OLD, OLD]);
  w.clean();

  // Its folder redirected: the write does not land in the folder behind the link.
  w = three(t);
  let there;
  r = writeWhile(w, 'staged', () => { there = w.redirect(path.dirname(w.P), { 'settings.json': OLD }); });
  assert.equal(r.error && r.error.message, changed('its folder was moved, replaced or redirected'));
  assert.deepEqual([read(path.join(there.other, 'settings.json')), read(w.A), read(w.B)], [OLD, OLD, OLD]);
  assert.deepEqual(fs.readdirSync(there.other), ['settings.json'], 'something was written into the other folder');

  // A file that did not exist, and that something else created meanwhile.
  w = three(t);
  const fresh = path.join(w.home, '.claude', 'new.json');
  w.peers = [];
  r = writeWhile(w, 'staged', () => fs.writeFileSync(fresh, EDIT), fresh);
  assert.deepEqual([r.error && r.error.code, r.error && r.error.message], ['ECHANGED', changed('something was created at its place')]);
  assert.equal(read(fresh), EDIT);
  w.clean();
});

const WRITER = `
import { writeKeepingLinks, copyFileSafe } from ${JSON.stringify(pathToFileURL(path.join(SCRIPTS, 'sync-check.mjs')).href)};
const home = process.env.NOVARC_POWERS_HOME;
if (process.env.T_COPY) copyFileSafe(process.env.T_COPY, process.env.T_FILE, { home });
else writeKeepingLinks(process.env.T_FILE, process.env.T_DATA, { home, peers: JSON.parse(process.env.T_PEERS) });
process.stdout.write('RETURNED');
`;

/** A child process starts the write and dies at `point`. Returns the record it left. */
function die(w, point, extra = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', WRITER], {
    encoding: 'utf8', timeout: 60000, env: env(w.home, { NOVARC_POWERS_TEST_FAULT: `kill@${point}`, T_FILE: w.P, T_DATA: NEW, T_PEERS: JSON.stringify(w.peers), ...extra }),
  });
  assert.notEqual(r.status, 0, `${point}: the writer was meant to die`);
  assert.deepEqual([r.stdout, r.stderr], ['', ''], `${point}: the writer did not die there`);
  const dir = path.join(w.home, ...SYNC, 'recovery');
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  assert.equal(files.length, 1);
  return { file: path.join(dir, files[0]), shown: `~/.novarc-powers/novarc-harness-doctor/sync/recovery/${files[0]}`, ...json(path.join(dir, files[0])) };
}

/** What a FRESH `sync-check.mjs --repair` reports as recovered. */
const recover = (w) => { const r = check(w.home, ['--repair', '--json']); assert.equal(r.code, 0); return JSON.parse(r.stdout).recovered; };

// Dead right after the rename over the file, or right before it with every temp link in place.
for (const [point, outcome, after] of [['committed', 'completed', NEW], ['peer-staged#2', 'rolled-back', OLD]]) {
  test(`recovery (${outcome}): another name whose folder now leads elsewhere is left alone, identical bytes or not`, (t) => {
    const kinds = [['junction', 'a link to another folder'], ['fresh', 'another folder under the same name']];
    if (CAN_SYMLINK) kinds.push(['dir', 'a symbolic link to another folder']);
    for (const [kind, what] of kinds) {
      const w = three(t);
      const rec = die(w, point);
      const tempName = path.basename(rec.peers[0].tmp);
      const dir = path.dirname(w.A);
      // The other folder holds a file with the very same bytes, and one named like the temp.
      const files = { 'settings.json': OLD, [tempName]: 'not a temp file of this write\n' };
      let other;
      const moved = `${dir}-moved`;
      if (kind === 'fresh') { fs.renameSync(dir, moved); other = dir; for (const [n, body] of Object.entries(files)) write(path.join(dir, n), body); } else other = w.redirect(dir, files, kind).other;

      const expected = { file: '~/.claude/settings.json', outcome, ...(outcome === 'completed' ? { relinked: 1 } : {}), foreign: 1 };
      assert.deepEqual(recover(w), [expected], what);
      assert.deepEqual([read(w.P), read(w.B)], [after, after], what);
      assert.equal(ino(w.P), ino(w.B), `${what}: the name in its own folder does not follow the file`);
      // Nothing behind the redirected name was linked, renamed or removed.
      assert.deepEqual(Object.fromEntries(fs.readdirSync(other).map((n) => [n, read(path.join(other, n))])), files, what);
      assert.notEqual(ino(path.join(other, 'settings.json')), ino(w.P), `${what}: an unrelated file was linked to the primary`);
      assert.equal(fs.statSync(path.join(other, 'settings.json')).nlink, 1, what);
      // The folder that was moved away is as the dead run left it.
      assert.equal(read(path.join(moved, 'settings.json')), OLD, what);
      assert.ok(exists(path.join(moved, tempName)), `${what}: a temp was removed from a folder reached by no recorded path`);
      assert.equal(recover(w), undefined, 'said once');
    }
  });

  test(`recovery (${outcome}): while the folder of the file itself leads elsewhere nothing is touched; once it is back, the write is settled`, (t) => {
    const w = three(t);
    const rec = die(w, point);
    // Behind the name: a file holding exactly what the dead run would have left, and its temp name.
    const files = { 'settings.json': after, [path.basename(rec.tmp)]: 'not a temp file of this write\n' };
    const there = w.redirect(path.dirname(w.P), files);
    const before = snapshot(w.root);
    const conflict = [{ file: '~/.claude/settings.json', outcome: 'conflict', note: ELSEWHERE, record: rec.shown }];
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(recover(w), conflict, 'said at every run while it lasts');
      // Not a byte, not a name: the other names are NOT linked to the file behind the link.
      assert.deepEqual(snapshot(w.root), before);
    }
    assert.deepEqual([read(w.A), read(w.B), read(path.join(there.other, 'settings.json')), fs.statSync(path.join(there.other, 'settings.json')).nlink], [OLD, OLD, after, 1]);
    assert.equal(check(w.home, ['--repair']).stdout, `novarc-harness-doctor account sync: needs attention 1 (~/.claude/settings.json: left as it is, because ${ELSEWHERE}; put the folder back, or delete ${rec.shown}).\n`);
    assert.ok(exists(rec.file), 'the record was dropped although nothing could be settled');

    there.back();
    assert.deepEqual(recover(w), [{ file: '~/.claude/settings.json', outcome, ...(outcome === 'completed' ? { relinked: 2 } : {}) }]);
    assert.deepEqual(w.state(), [after, after, after]);
    assert.ok(fs.statSync(w.P).nlink === 3 && ino(w.P) === ino(w.A) && ino(w.P) === ino(w.B));
    assert.deepEqual(strays(w.home).filter((p) => !p.startsWith(there.other)), [], 'a temp of the write is left in its own folders');
    assert.ok(!exists(rec.file));
    assert.deepEqual(Object.fromEntries(fs.readdirSync(there.other).map((n) => [n, read(path.join(there.other, n))])), files, 'the folder behind the link was touched');
  });

  test(`recovery (${outcome}): a name that was itself replaced by another file with the same bytes is not switched`, (t) => {
    const w = three(t);
    die(w, point);
    // One name is now another plain file with the old bytes; the other, where the platform
    // allows, a symbolic link to a file kept elsewhere with the old bytes.
    atomicSave(w.A, OLD);
    const outside = path.join(w.root, 'outside', 'settings.json');
    write(outside, OLD);
    if (CAN_SYMLINK) { fs.rmSync(w.B); fs.symlinkSync(outside, w.B, 'file'); }
    const got = recover(w);
    if (outcome === 'completed') assert.deepEqual(got, [{ file: '~/.claude/settings.json', outcome, ...(CAN_SYMLINK ? { left: 2 } : { relinked: 1, left: 1 }) }]);
    else assert.deepEqual(got, [{ file: '~/.claude/settings.json', outcome }]);
    assert.deepEqual([read(w.P), read(w.A), read(outside)], [after, OLD, OLD]);
    assert.deepEqual([fs.statSync(w.A).nlink, fs.statSync(outside).nlink], [1, 1], 'a replaced name, or the file behind a link, was linked to the primary');
    if (CAN_SYMLINK) assert.ok(fs.lstatSync(w.B).isSymbolicLink(), 'a symbolic link was replaced');
    assert.deepEqual(strays(w.home), []);
  });
}

test('recovery: the file itself replaced by a link to a file with the new bytes settles nothing on that file', { skip: !CAN_SYMLINK && 'symbolic links cannot be created here' }, (t) => {
  const w = three(t);
  die(w, 'committed');
  const outside = path.join(w.root, 'outside', 'settings.json');
  write(outside, NEW);
  fs.rmSync(w.P);
  fs.symlinkSync(outside, w.P, 'file');
  assert.deepEqual(recover(w), [{ file: '~/.claude/settings.json', outcome: 'abandoned' }]);
  assert.deepEqual([read(outside), read(w.A), read(w.B), fs.statSync(outside).nlink], [NEW, OLD, OLD, 1], 'the other names were linked to a file reached through a link');
  assert.deepEqual(strays(w.home), []);
});

test('recovery: a temp of a copy is not removed from a folder its name no longer leads to', (t) => {
  const w = three(t);
  const src = path.join(w.root, 'source.md');
  const dst = path.join(w.home, '.alt-a', 'copied.md');
  write(src, 'the bytes to copy\n');
  const rec = die(w, 'copied', { T_COPY: src, T_FILE: dst });
  const name = path.basename(rec.cleanup[0].path);
  assert.deepEqual([exists(dst), read(path.join(w.home, '.alt-a', name))], [false, 'the bytes to copy\n']);
  const there = w.redirect(path.dirname(dst), { [name]: 'not a temp file of this copy\n' });
  assert.deepEqual(recover(w), [{ file: `~/.alt-a/${name}`, outcome: 'conflict', note: ELSEWHERE }]);
  assert.equal(read(path.join(there.other, name)), 'not a temp file of this copy\n', 'a file in another folder was removed because of its name');
  assert.equal(read(path.join(there.moved, name)), 'the bytes to copy\n');
  assert.equal(recover(w), undefined, 'said once');
  // In its own folder, the same leftover is simply removed.
  const v = three(t);
  const rec2 = die(v, 'copied', { T_COPY: src, T_FILE: path.join(v.home, '.alt-a', 'copied.md') });
  const name2 = path.basename(rec2.cleanup[0].path);
  assert.deepEqual(recover(v), [{ file: `~/.alt-a/${name2}`, outcome: 'removed', leftovers: 1 }]);
  assert.deepEqual(strays(v.home), []);
});

test('undo: nothing is removed, rewritten or restored behind an account folder that now leads elsewhere', (t) => {
  const h = buildHome({ second: false, agents: false });
  t.after(() => rmrf(h.root));
  const tree = () => Object.fromEntries(Object.entries(snapshot(h.home)).filter(([k]) => !k.includes('.novarc-powers')));
  const before = tree();
  const { apply } = planAndApply(h, 'claude-1', ['--resolve', 'codex-1:AGENTS.md=replace-with-primary']);
  assert.equal(apply.code, 0, apply.stdout);
  const generated = read(path.join(h.codexDir, 'AGENTS.md'));
  const toml = read(path.join(h.codexDir, 'config.toml'));
  assert.ok(generated.startsWith('<!-- generated by novarc-harness-doctor from ~/.claude/CLAUDE.md;') && toml.includes('# novarc-harness-doctor:start'));

  // The Codex folder is moved away; its name now leads to a folder that holds, byte for byte,
  // the generated file and the edited config (which the journal would recognise by their hashes).
  const moved = `${h.codexDir}-moved`;
  const other = path.join(h.root, 'another-codex');
  fs.renameSync(h.codexDir, moved);
  write(path.join(other, 'AGENTS.md'), generated);
  write(path.join(other, 'config.toml'), toml);
  fs.symlinkSync(other, h.codexDir, 'junction');

  const stopped = acc(h.home, ['undo', '--stamp', apply.json.stamp, '--yes']);
  assert.equal(stopped.code, 1);
  assert.ok(stopped.json.conflicts.length >= 3);
  assert.deepEqual([...new Set(stopped.json.conflicts.map((c) => c.reason))], ['its folder is not the one this run worked in (moved, replaced or redirected since); left as it is']);
  assert.ok(stopped.json.conflicts.every((c) => c.path.startsWith('~/.codex/')));
  assert.deepEqual(Object.fromEntries(fs.readdirSync(other).map((n) => [n, read(path.join(other, n))])), { 'AGENTS.md': generated, 'config.toml': toml }, 'a file with the same bytes in another folder was removed, reverted or joined by a restored original');
  assert.equal(read(path.join(moved, 'AGENTS.md')), generated, 'the folder that was moved away was touched');

  // With the folder back, the same undo finishes on the exact starting tree.
  dropLink(h.codexDir);
  fs.renameSync(moved, h.codexDir);
  const undo = acc(h.home, ['undo', '--stamp', apply.json.stamp, '--yes']);
  assert.equal(undo.code, 0, undo.stdout + undo.stderr);
  assert.deepEqual([undo.json.ok, undo.json.pending, undo.json.conflicts], [true, 0, []]);
  assert.deepEqual(tree(), before);
});
