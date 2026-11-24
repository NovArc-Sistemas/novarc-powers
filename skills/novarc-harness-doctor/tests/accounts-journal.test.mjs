// `accounts.mjs apply` journals every step BEFORE it makes it (synced to disk) and marks it done
// after. These tests kill `apply`, and `undo`, at each of those points (NOVARC_POWERS_TEST_FAULT
// with `kill@point`: SIGKILL, nothing unwound) and then start FRESH processes: an `undo` must
// return the tree to the exact bytes of a snapshot taken before `apply`, with no conflict of the
// tool's own making, and an `apply` of the same plan must complete or refuse cleanly.
// Every test runs against a fake home under os.tmpdir().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildHome, acc, rmrf, write, read, json, exists, snapshot, resolvesTo, tmpDir,
} from './accounts-fixture.mjs';
import { Run } from '../scripts/lib/accounts/apply.mjs';

const RESOLVE = [
  '--resolve', 'claude-2:CLAUDE.md=replace-with-primary',
  '--resolve', 'claude-2:keybindings.json=adopt-into-primary',
  '--resolve', 'claude-2:skills/=adopt-into-primary',
  '--resolve', 'claude-2:output-styles/=adopt-into-primary',
  '--resolve', 'codex-1:AGENTS.md=replace-with-primary',
];

/** Every name under `root`, outside the tool's own folder, that looks like a temp of the tool. */
function strays(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.novarc-powers') continue;
      if (e.name.includes('.nhd-')) out.push(path.join(d, e.name));
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(root);
  return out;
}

/**
 * Two accounts that differ from the primary in every way a plan can settle, so that one `apply`
 * makes every kind of step: moves to the backup, links, new folders, a file of the primary
 * replaced, files added to a folder of the primary, a whole folder brought into it, generated
 * files, edits of the two MCP files, and the manifest.
 */
function world(t) {
  const h = buildHome({ agents: false });
  t.after(() => rmrf(h.root));
  write(path.join(h.acc, 'keybindings.json'), '{"bindings": ["from the second account"]}\n');
  write(path.join(h.acc, 'skills', 'delta', 'SKILL.md'), '---\nname: delta\n---\nOnly in the account.\n');
  write(path.join(h.acc, 'skills', 'gamma', 'SKILL.md'), '---\nname: gamma\n---\nOnly in the account.\n');
  write(path.join(h.acc, 'skills', 'gamma', 'notes', 'a.txt'), 'a note\n');
  write(path.join(h.acc, 'output-styles', 'brief.md'), 'Brief.\n');
  write(path.join(h.acc, 'output-styles', 'deep', 'long.md'), 'Long.\n');
  const planFile = path.join(h.root, 'plan.json');
  const plan = acc(h.home, ['plan', '--primary', 'claude-1', '--out', planFile, ...RESOLVE]);
  assert.equal(plan.code, 0, plan.stderr);
  const tree = () => Object.fromEntries(Object.entries(snapshot(h.home)).filter(([k]) => !k.includes('.novarc-powers')));
  const stamps = () => (exists(path.join(h.sync, 'backups')) ? fs.readdirSync(path.join(h.sync, 'backups')).sort() : []);
  const journal = (stamp) => json(path.join(h.sync, 'backups', stamp, 'journal.json'));
  const apply = (extra = {}) => acc(h.home, ['apply', '--plan', planFile, '--yes'], extra);
  const undo = (stamp, extra = {}) => acc(h.home, ['undo', '--stamp', stamp, '--yes'], extra);
  /** `apply` dies at `point`; returns the stamp of the dead run. */
  const dieApplying = (point) => {
    const dead = apply({ NOVARC_POWERS_TEST_FAULT: `kill@${point}` });
    assert.notEqual(dead.code, 0, `${point}: apply was meant to die there (is the point ever reached?)`);
    assert.equal(dead.stdout, '', `${point}: apply got to its end`);
    assert.equal(dead.stderr, '', `${point}: apply failed instead of dying`);
    assert.equal(stamps().length, 1, `${point}: the dead run left no journal`);
    return stamps()[0];
  };
  return { h, planFile, before: tree(), tree, stamps, journal, apply, undo, dieApplying };
}

/** The tree is, byte for byte, what it was before `apply`, and nothing of the dead run is left. */
function assertBack(w, label) {
  assert.deepEqual(w.tree(), w.before, `${label}: the tree is not byte-identical to the snapshot taken before apply`);
  assert.deepEqual(strays(w.h.home), [], `${label}: a temp name of the dead run is left`);
  assert.ok(!exists(path.join(w.h.sync, 'manifest.json')), `${label}: a manifest is left`);
  assert.ok(!exists(path.join(w.h.sync, 'recovery')), `${label}: the recovery folder is left`);
}

// Where `apply` dies. `x-intended`: the entry for step x is on disk, the step is not made;
// `x-made`: the step is made, its entry is not marked done. `#n`: at the n-th such step.
const POINTS = [
  ['journal#5', 'half of the fifth journal entry is written'],
  ['move-intended', 'an original is about to be moved to the backup'],
  ['move-made', 'an original is in the backup, and the journal does not say so yet'],
  ['move-made#4', 'the same, for a folder, after other steps'],
  ['mkdir-intended', 'a folder is about to be created'],
  ['mkdir-made', 'a folder was created'],
  ['link-intended', 'the original is in the backup, the link is not made'],
  ['link-made', 'a link was made'],
  ['link-made#6', 'the same, after other steps'],
  ['overwrite-intended', 'a file of the primary is about to be replaced'],
  ['overwrite-made', 'a file of the primary was replaced'],
  ['add-intended', 'a file is about to be added to a folder of the primary'],
  ['copied#2', 'the second added file sits under its temp name'],
  ['add-made', 'a file was added to a folder of the primary'],
  ['add-intended#2', 'between two files of a folder adopt'],
  ['create-intended', 'a folder is about to be brought into the primary'],
  ['tree-file#2', 'in the middle of copying that folder'],
  ['create-made', 'the folder is in the primary'],
  ['patch-intended', 'an MCP file is about to be edited'],
  ['patch-made', 'an MCP file was edited'],
  ['write-intended', 'a generated file is about to be written'],
  ['write-made', 'a generated file was written'],
  ['manifest-intended', 'every step is made, the manifest is not written'],
  ['manifest-made', 'the manifest is written, the run is not marked finished'],
];

for (const [point, what] of POINTS) {
  test(`apply killed at "${point}" (${what}): undo returns the exact starting tree, and the same plan applies`, (t) => {
    const w = world(t);
    const stamp = w.dieApplying(point);

    const undo = w.undo(stamp);
    assert.equal(undo.code, 0, undo.stdout + undo.stderr);
    assert.deepEqual([undo.json.ok, undo.json.pending, undo.json.conflicts], [true, 0, []], 'undo reported a conflict of the tool\'s own making');
    assertBack(w, point);
    assert.match(w.journal(stamp).undoneAt, /^\d{4}-/);

    // The plan the user approved is as good as new.
    const again = w.apply();
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assert.deepEqual([again.json.ok, again.json.failed, again.json.unfinished], [true, 0, undefined]);
    assert.ok(again.json.changed >= 15);
    assert.ok(resolvesTo(path.join(w.h.acc, 'CLAUDE.md'), path.join(w.h.claude, 'CLAUDE.md')));
    assert.equal(read(path.join(w.h.claude, 'skills', 'gamma', 'notes', 'a.txt')), 'a note\n');
    assert.equal(read(path.join(w.h.claude, 'output-styles', 'deep', 'long.md')), 'Long.\n');
    assert.equal(read(path.join(w.h.claude, 'keybindings.json')), '{"bindings": ["from the second account"]}\n');
    assert.match(w.journal(again.json.stamp).finishedAt, /^\d{4}-/);
    assert.ok(w.journal(again.json.stamp).ops.every((o) => o.done === true), 'a step of a finished run is not marked done');
  });
}

for (const point of ['move-intended', 'link-intended', 'overwrite-intended', 'add-made', 'create-made', 'manifest-intended']) {
  test(`apply killed at "${point}", then the same plan applied at once: it completes or refuses cleanly, and undo still gets back`, (t) => {
    const w = world(t);
    const dead = w.dieApplying(point);
    const left = w.tree();
    const again = w.apply();
    if (again.code === 0) {
      assert.deepEqual([again.json.ok, again.json.failed], [true, 0]);
    } else {
      assert.equal(again.code, 1, again.stdout + again.stderr);
      assert.equal(again.json.refused, true);
      assert.equal(again.json.error, 'the accounts changed since this plan was made; plan again and review the new plan');
      assert.deepEqual(again.json.unfinished, [dead], 'the refusal does not name the run that died');
      assert.equal(again.json.note, `An earlier run (${dead}) did not finish (the process died or was stopped). "node accounts.mjs undo --stamp ${dead} --yes" takes back what it had done.`);
      assert.deepEqual(w.tree(), left, 'a refused apply changed something');
      assert.equal(w.stamps().length, 1, 'a refused apply left a run behind');
    }
    // Newest first, every run is taken back.
    for (const stamp of w.stamps().reverse()) {
      const undo = w.undo(stamp);
      assert.equal(undo.code, 0, `${stamp}: ${undo.stdout}${undo.stderr}`);
      assert.deepEqual([undo.json.ok, undo.json.conflicts], [true, []]);
    }
    assertBack(w, point);
  });
}

test('undo killed after a step and before its mark: the next undo finishes, with no conflict, on the exact starting tree', (t) => {
  for (const kind of ['move', 'link', 'patch', 'create']) {
    const w = world(t);
    const done = w.apply();
    assert.equal(done.code, 0, done.stdout + done.stderr);
    const stamp = done.json.stamp;
    // Undo takes the entries newest first: die right after the first one of this kind.
    const k = [...w.journal(stamp).ops].reverse().findIndex((o) => o.op === kind) + 1;
    assert.ok(k > 0, `the run made no ${kind}`);
    const dead = w.undo(stamp, { NOVARC_POWERS_TEST_FAULT: `kill@undo-step#${k}` });
    assert.notEqual(dead.code, 0, `${kind}: undo was meant to die`);
    assert.equal(dead.stdout, '');
    assert.equal(w.journal(stamp).undoneAt, undefined);
    const undo = w.undo(stamp);
    assert.equal(undo.code, 0, `${kind}: ${undo.stdout}${undo.stderr}`);
    assert.deepEqual([undo.json.ok, undo.json.pending, undo.json.conflicts], [true, 0, []], `${kind}: the second undo reported a conflict of the tool's own making`);
    assert.equal(undo.json.alreadyUndone || 0, k - 1);
    assertBack(w, `undo killed at a ${kind}`);
  }
});

test('a move across volumes that died while removing its source is put back from the backup; anything foreign stops it', (t) => {
  // The fallback of a move (copy, verify, remove the source) cannot be made to happen on one
  // volume, so the state it leaves is laid out by hand around a real journal entry.
  const rels = [['alpha', 'SKILL.md'], ['delta', 'SKILL.md'], ['gamma', 'SKILL.md'], ['gamma', 'notes', 'a.txt']];
  const lay = (w, stamp) => {
    const op = w.journal(stamp).ops.at(-1);
    assert.deepEqual([op.op, op.from, op.done], ['move', path.join(w.h.acc, 'skills'), undefined]);
    // The copy in the backup is whole; the source has lost a file and a folder.
    for (const rel of rels) write(path.join(op.to, ...rel), read(path.join(op.from, ...rel)));
    fs.rmSync(path.join(op.from, 'alpha', 'SKILL.md'));
    fs.rmSync(path.join(op.from, 'gamma'), { recursive: true });
    return op;
  };
  const w = world(t);
  const stamp = w.dieApplying('move-intended#4'); // the move of the skills folder
  lay(w, stamp);
  assert.notDeepEqual(w.tree(), w.before);
  const undo = w.undo(stamp);
  assert.equal(undo.code, 0, undo.stdout + undo.stderr);
  assert.deepEqual([undo.json.ok, undo.json.conflicts], [true, []]);
  assertBack(w, 'a move that died while removing its source');

  // Something that is not in the backup sits in the source: not this tool's to merge over.
  const v = world(t);
  const other = v.dieApplying('move-intended#4');
  const op = lay(v, other);
  write(path.join(op.from, 'alpha', 'SKILL.md'), 'written here after the crash\n');
  const stopped = v.undo(other);
  assert.equal(stopped.code, 1);
  // The folder is not merged; and what the run had added to the primary from the part of the
  // folder that is gone cannot be checked against it any more, so it stays too.
  assert.deepEqual(stopped.json.conflicts.map((c) => `${c.path}: ${c.reason}`).sort(), [
    '~/.claude/skills/gamma/SKILL.md: changed in the primary since the run; left there',
    '~/.claude/skills/gamma/notes/a.txt: changed in the primary since the run; left there',
    '~/.hostapp/host/harness-accounts/claude-code/acc-1/skills: something else is at the original place now; the backup was kept',
  ]);
  assert.equal(read(path.join(op.from, 'alpha', 'SKILL.md')), 'written here after the crash\n');
  assert.ok(!exists(path.join(op.from, 'gamma')), 'undo merged the backup over a folder somebody changed');
  assert.equal(read(path.join(op.to, 'gamma', 'notes', 'a.txt')), 'a note\n', 'the backup was not kept');
});

test('a move across volumes that FAILS while removing its source puts the source back at once', (t) => {
  // Not a death: the fallback of a move (copy, verify, remove the source) hits a file it cannot
  // remove. Forced here by making the rename fail as across volumes and one removal fail.
  const root = tmpDir('hd-journal-');
  t.after(() => rmrf(root));
  const home = path.join(root, 'home');
  const from = path.join(home, '.alt', 'skills');
  const files = { [path.join('a', 'one.md')]: 'one\n', [path.join('b', 'two.md')]: 'two\n', [path.join('b', 'deep', 'three.md')]: 'three\n' };
  for (const [rel, body] of Object.entries(files)) write(path.join(from, rel), body);
  const before = snapshot(path.join(home, '.alt'));
  const run = new Run(home, 'claude-1');
  const to = run.backupPath('claude-2', 'skills/');
  const stuck = path.join(from, 'b', 'two.md');
  const real = { rename: fs.renameSync, unlink: fs.unlinkSync };
  let removed = 0;
  fs.renameSync = (a, b) => { if (a === from) throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }); return real.rename(a, b); };
  fs.unlinkSync = (p) => { if (p === stuck) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); if (String(p).startsWith(from)) removed++; return real.unlink(p); };
  let thrown;
  try { run.move(from, to); } catch (e) { thrown = e; } finally { fs.renameSync = real.rename; fs.unlinkSync = real.unlink; }
  assert.ok(thrown, 'the move was meant to fail');
  assert.ok(removed > 0, 'the fixture did not fail in the middle of removing the source');
  assert.deepEqual(snapshot(path.join(home, '.alt')), before, 'the source is not whole again');
  assert.ok(!exists(to), 'the copy was left in the backup although the move failed');
  assert.deepEqual(json(path.join(run.dir(), 'journal.json')).ops, [], 'a move that did not happen is still in the journal');
});

test('the next run tells what a dead run only intended from what it did, and never takes its own work for the dead run\'s', (t) => {
  const w = world(t);
  // Dies with the second account's CLAUDE.md in the backup and the link not made.
  const dead = w.dieApplying('link-intended');
  const S = path.join(w.h.acc, 'CLAUDE.md');
  const P = path.join(w.h.claude, 'CLAUDE.md');
  assert.ok(!exists(S));
  assert.deepEqual(w.journal(dead).ops.map((o) => [o.op, !!o.done]), [['move', true], ['link', false]]);

  // Planning says so first; the plan itself is made on what is there now.
  const fresh = path.join(w.h.root, 'fresh.json');
  const plan = acc(w.h.home, ['plan', '--primary', 'claude-1', '--out', fresh, ...RESOLVE.slice(2)]);
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(plan.json.warnings[0], `An earlier run did not finish (the process died or was stopped): ${dead}. Take back what it had done first, with "node accounts.mjs undo --stamp ${dead} --yes", then plan again.`);
  assert.match(acc(w.h.home, ['plan', '--primary', 'claude-1', '--lang', 'pt', ...RESOLVE.slice(2)]).json.warnings[0], new RegExp(`^Uma execução anterior não terminou \\(o processo morreu ou foi interrompido\\): ${dead}\\.`));
  assert.equal(w.journal(dead).ops[1].never, undefined, 'a read-only command wrote to the journal of the dead run');

  // The user applies the new plan anyway: it makes the link the dead run never made.
  const second = acc(w.h.home, ['apply', '--plan', fresh, '--yes']);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.deepEqual(second.json.unfinished, [dead]);
  assert.ok(second.json.warnings.includes(`An earlier run (${dead}) did not finish (the process died or was stopped). "node accounts.mjs undo --stamp ${dead} --yes" takes back what it had done.`));
  assert.ok(resolvesTo(S, P));
  // The dead run's entry for that link was struck before the new run made anything.
  assert.deepEqual(w.journal(dead).ops.map((o) => [o.op, !!o.done, !!o.never]), [['move', true, false], ['link', false, true]]);

  // Undoing the dead run first cannot put the original back (the new link is in its place), and
  // must not remove that link: it is the second run's.
  const early = w.undo(dead);
  assert.equal(early.code, 1);
  assert.deepEqual(early.json.conflicts, [{ path: '~/.hostapp/host/harness-accounts/claude-code/acc-1/CLAUDE.md', reason: 'something else is at the original place now; the backup was kept' }]);
  assert.ok(resolvesTo(S, P), 'the undo of the dead run removed a link another run made');
  // Newest first, as told: the second run, then what is left of the dead one.
  const undoSecond = w.undo(second.json.stamp);
  assert.equal(undoSecond.code, 0, undoSecond.stdout + undoSecond.stderr);
  const undoDead = w.undo(dead);
  assert.equal(undoDead.code, 0, undoDead.stdout + undoDead.stderr);
  assert.deepEqual([undoDead.json.ok, undoDead.json.pending, undoDead.json.conflicts], [true, 0, []]);
  assertBack(w, 'two runs');
  assert.equal(acc(w.h.home, ['plan', '--primary', 'claude-1', ...RESOLVE]).json.warnings.some((x) => /did not finish/.test(x)), false);
});
