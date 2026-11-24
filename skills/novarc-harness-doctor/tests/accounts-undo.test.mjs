// accounts.mjs undo when it cannot finish: each journal entry is marked as it is undone, the run
// only when all of them are, and a second undo retries exactly what is still pending.
// Every test runs against a fake home under os.tmpdir().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildHome, acc, check, rmrf, write, read, json, exists, isLink, snapshot, planAndApply, dropLink,
} from './accounts-fixture.mjs';

const SECOND_CLAUDE_MD = '# Rules of the second account\n\nDifferent on purpose.\n'; // the fixture's own text
const journalOf = (h, stamp) => json(path.join(h.sync, 'backups', stamp, 'journal.json'));
/** The tree outside this tool's own workspace, for byte-identical comparisons. */
const harness = (h) => Object.fromEntries(Object.entries(snapshot(h.home)).filter(([k]) => !k.includes('.novarc-powers')));

test('undo: a partial undo is not marked done, and a second undo retries exactly the pending step', (t) => {
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  const { apply } = planAndApply(h, 'claude-1', ['--resolve', 'claude-2:CLAUDE.md=replace-with-primary']);
  assert.equal(apply.code, 0, apply.stdout);
  const stamp = apply.json.stamp;
  const total = journalOf(h, stamp).ops.length;
  assert.ok(total > 5);
  const accMd = path.join(h.acc, 'CLAUDE.md');
  const accSettings = path.join(h.acc, 'settings.json');
  assert.notEqual(read(accMd), SECOND_CLAUDE_MD, 'the fixture did not replace the instruction file of the account');

  // The backup of one replaced file is out of reach when undo runs.
  const backup = path.join(h.sync, 'backups', stamp, 'claude-2', 'CLAUDE.md');
  assert.equal(read(backup), SECOND_CLAUDE_MD);
  const away = path.join(h.root, 'CLAUDE.md.away');
  fs.renameSync(backup, away);

  const first = acc(h.home, ['undo', '--stamp', stamp, '--yes']);
  assert.equal(first.code, 1);
  assert.equal(first.json.ok, false);
  assert.equal(first.json.pending, 1);
  assert.deepEqual(first.json.conflicts, [{ path: '~/.hostapp/host/harness-accounts/claude-code/acc-1/CLAUDE.md', reason: 'the backup is missing' }]);
  assert.match(first.json.note, /1 step is still pending\. Clear what "conflicts" reports and run the same undo again: it retries only what is pending\./);
  assert.ok(first.json.restored > 0 && first.json.removed > 0);
  // The journal: every entry but that one is marked, and the run is not.
  let journal = journalOf(h, stamp);
  assert.equal(journal.undoneAt, undefined, 'a partial undo was marked as done');
  const open = journal.ops.filter((o) => !o.undoneAt);
  assert.deepEqual(open.map((o) => [o.op, o.from]), [['move', accMd]]);
  assert.equal(journal.ops.filter((o) => typeof o.undoneAt === 'string').length, total - 1);
  // The disk: everything else is back, the pending file is not.
  assert.ok(!exists(accMd));
  assert.ok(!isLink(accSettings) && fs.statSync(accSettings).nlink === 1);
  assert.equal(read(accSettings), read(path.join(h.claude, 'settings.json')));
  // The manifest no longer claims the links that were removed, so the session-start check
  // does not put them back.
  assert.equal(check(h.home, ['--repair']).stdout, '');
  assert.ok(!exists(accMd) && !isLink(accSettings) && fs.statSync(accSettings).nlink === 1, 'the check re-created what undo removed');

  // The user goes on working with what the first undo restored.
  fs.writeFileSync(accSettings, '{"model": "edited between the two undos"}\n');
  const stillAway = acc(h.home, ['undo', '--stamp', stamp, '--yes']);
  assert.deepEqual([stillAway.code, stillAway.json.pending, stillAway.json.restored, stillAway.json.removed, stillAway.json.alreadyUndone], [1, 1, 0, 0, total - 1]);
  assert.equal(journalOf(h, stamp).undoneAt, undefined);

  // The backup is reachable again. A dry run says what is left and touches nothing.
  fs.renameSync(away, backup);
  const dry = acc(h.home, ['undo', '--stamp', stamp, '--dry-run']);
  assert.deepEqual([dry.code, dry.json.dryRun, dry.json.pending, dry.json.restored, dry.json.alreadyUndone], [0, true, 0, 1, total - 1]);
  assert.ok(!exists(accMd));
  assert.equal(journalOf(h, stamp).undoneAt, undefined);

  const second = acc(h.home, ['undo', '--stamp', stamp, '--yes']);
  assert.equal(second.code, 0, second.stdout);
  assert.deepEqual(
    { ok: second.json.ok, restored: second.json.restored, removed: second.json.removed, pending: second.json.pending, alreadyUndone: second.json.alreadyUndone, conflicts: second.json.conflicts },
    { ok: true, restored: 1, removed: 0, pending: 0, alreadyUndone: total - 1, conflicts: [] },
  );
  assert.equal(read(accMd), SECOND_CLAUDE_MD, 'the pending file was not restored');
  assert.ok(!isLink(accMd));
  assert.equal(read(accSettings), '{"model": "edited between the two undos"}\n', 'a step that was already undone was run again');
  journal = journalOf(h, stamp);
  assert.match(journal.undoneAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(journal.ops.every((o) => typeof o.undoneAt === 'string'));
  assert.ok(!exists(path.join(h.sync, 'manifest.json')), 'the manifest of the undone run is gone');

  const third = acc(h.home, ['undo', '--stamp', stamp, '--yes']);
  assert.equal(third.code, 0);
  assert.match(third.json.note, /already undone/);
  assert.deepEqual([third.json.pending, third.json.restored, third.json.removed], [0, 0, 0]);
});

test('undo: a folder the run created waits for the pending step inside it, and the retry leaves the tree as it was', (t) => {
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  const before = harness(h);
  const { apply } = planAndApply(h, 'claude-1', ['--resolve', 'claude-2:CLAUDE.md=replace-with-primary']);
  assert.equal(apply.code, 0, apply.stdout);
  const stamp = apply.json.stamp;
  // The run created the folder `docs` in the account for one linked import. Somebody then put a
  // file of their own where that link was.
  const docs = path.join(h.acc, 'docs');
  const extra = path.join(docs, 'extra.md');
  assert.ok(journalOf(h, stamp).ops.some((o) => o.op === 'mkdir' && o.path === docs), 'the fixture did not make the run create the folder');
  dropLink(extra);
  write(extra, 'typed here\n');

  const first = acc(h.home, ['undo', '--stamp', stamp, '--yes']);
  assert.equal(first.code, 1);
  assert.deepEqual(first.json.conflicts, [{ path: '~/.hostapp/host/harness-accounts/claude-code/acc-1/docs/extra.md', reason: 'no longer the link this run created; left as it is' }]);
  assert.equal(first.json.pending, 2, 'the link, and the folder that waits for it');
  assert.equal(read(extra), 'typed here\n');
  assert.deepEqual(journalOf(h, stamp).ops.filter((o) => !o.undoneAt).map((o) => o.op).sort(), ['link', 'mkdir']);
  assert.equal(read(path.join(h.acc, 'CLAUDE.md')), SECOND_CLAUDE_MD, 'the rest was undone');

  // The file is moved out of the way: the retry finishes the job, folder included.
  fs.rmSync(extra);
  const second = acc(h.home, ['undo', '--stamp', stamp, '--yes']);
  assert.equal(second.code, 0, second.stdout);
  assert.deepEqual([second.json.ok, second.json.pending, second.json.conflicts.length], [true, 0, 0]);
  assert.ok(!exists(docs), 'the folder the run created was left behind');
  assert.deepEqual(harness(h), before, 'the tree is not byte-identical to what it was before the run');
  assert.match(journalOf(h, stamp).undoneAt, /^\d{4}-/);
});
