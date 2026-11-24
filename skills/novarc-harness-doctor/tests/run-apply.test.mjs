// run.mjs mark / record / undo: what an executor calls around each change, and taking the
// changes back. The "harness files" edited here live in the sandbox's project folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sandbox, securityFindings } from './run-helpers.mjs';

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function ready(t, initArgs = []) {
  const sb = sandbox(t);
  assert.equal(sb.init(initArgs).code, 0);
  assert.equal(sb.complete('review:security', securityFindings()).code, 0);
  sb.project = path.join(sb.home, 'dev', 'acme-shop');
  /** Back a file up into the run's backups folder, as an executor does before a change. */
  sb.backup = (file, stamp = 'b1') => {
    const dest = sb.file('backups', stamp, path.basename(file));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    return dest;
  };
  sb.approve = (id) => assert.equal(sb.run(['decide', '--target', id, '--action', 'approve']).code, 0);
  sb.status = (id) => sb.read('status.json').items[id] || {};
  return sb;
}

test('mark follows approved -> in-progress -> fixed | failed and rejects everything else', (t) => {
  const sb = ready(t);
  const mark = (id, status, ...more) => sb.run(['mark', '--item', id, '--status', status, ...more]);

  const open = mark('ACME-101', 'in-progress');
  assert.equal(open.code, 1, 'an open item was not approved');
  assert.match(open.json.error, /cannot mark ACME-101 as in-progress: it is open/);
  assert.equal(mark('ACME-101', 'fixed', '--verified', 'x').code, 1, 'open -> fixed');
  assert.equal(mark('ACME-101', 'in-progress', '--auto').code, 1, '--auto needs doctor mode');

  sb.approve('ACME-101');
  assert.equal(mark('ACME-101', 'fixed', '--verified', 'x').code, 1, 'approved -> fixed skips in-progress');
  assert.equal(mark('ACME-101', 'failed').code, 1, 'approved -> failed');
  const started = mark('ACME-101', 'in-progress');
  assert.equal(started.code, 0, started.stdout);
  assert.deepEqual({ from: started.json.from, status: started.json.status, changed: started.json.changed }, { from: 'approved', status: 'in-progress', changed: true });
  assert.equal(mark('ACME-101', 'in-progress').json.changed, false, 'marking in-progress twice is harmless');

  const bare = mark('ACME-101', 'fixed');
  assert.equal(bare.code, 1, 'fixed needs what was checked');
  assert.match(bare.json.error, /--verified/);
  const fixed = mark('ACME-101', 'fixed', '--verified', 'Re-read the file; the rule is there.', '--not-verified', `A live session; see ${path.join(sb.home, 'notes.txt')}`);
  assert.equal(fixed.code, 0, fixed.stdout);
  const o = sb.status('ACME-101');
  assert.equal(o.status, 'fixed');
  assert.equal(o.verified, 'Re-read the file; the rule is there.');
  assert.equal(o.notVerified, `A live session; see ~${path.sep}notes.txt`, 'an absolute home path in a note is replaced');
  assert.equal(o.applied, true);
  assert.match(o.updatedAt, /^\d{4}-/);
  assert.equal(mark('ACME-101', 'in-progress').code, 1, 'fixed -> in-progress');
  assert.equal(mark('ACME-101', 'failed').code, 1, 'fixed -> failed');

  sb.approve('NP-101');
  mark('NP-101', 'in-progress');
  assert.equal(mark('NP-101', 'failed', '--not-verified', 'The check did not pass; backup restored.').code, 0);
  assert.equal(sb.status('NP-101').status, 'failed');
  assert.ok(!('applied' in sb.status('NP-101')));
  assert.equal(mark('NP-101', 'in-progress').code, 1, 'a failed item needs a new approval');
  sb.approve('NP-101');
  assert.ok(!('notVerified' in sb.status('NP-101')), 'the new approval starts clean');
  assert.equal(mark('NP-101', 'in-progress').code, 0);

  assert.equal(mark('NP-102', 'in-progress').code, 1, 'an item that is ok has nothing to apply');
  assert.equal(mark('ZZ-101', 'in-progress').code, 1);
  assert.equal(mark('ACME-102', 'done').code, 2);
  assert.equal(sb.run(['mark', '--status', 'fixed']).code, 2);

  // The state shows it: status, what was verified, applied changes, and a log line.
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  const state = sb.read('state.json');
  const it = state.items.find((i) => i.id === 'ACME-101');
  assert.deepEqual({ status: it.status, verified: it.verified, applied: it.changes[0].applied }, { status: 'fixed', verified: 'Re-read the file; the rule is there.', applied: true });
  assert.ok(!('applied' in state.items.find((i) => i.id === 'ACME-102').changes[0]));
  assert.ok(state.log.some((l) => l.item === 'ACME-101' && /^Fixed\. Verified: Re-read the file; the rule is there\. Not verified: A live session/.test(l.text)));
  assert.ok(state.log.some((l) => l.item === 'NP-101' && /^Failed\. Not verified: The check did not pass/.test(l.text)));
});

test('mark --auto: doctor mode applies safe classes without a decision, nothing else', (t) => {
  const sb = ready(t, ['--mode', 'doctor']);
  const auto = (id) => sb.run(['mark', '--item', id, '--status', 'in-progress', '--auto']);
  const safe = auto('ACME-102'); // class additive
  assert.equal(safe.code, 0, safe.stdout);
  assert.equal(safe.json.auto, true);
  assert.equal(sb.status('ACME-102').status, 'in-progress');
  assert.equal(auto('ACME-101').code, 0, 'class reversible is safe too');
  const perm = auto('U1-101'); // class permission
  assert.equal(perm.code, 1);
  assert.match(perm.json.error, /class permission always waits for the user's decision/);
  assert.equal(sb.run(['mark', '--item', 'NP-101', '--status', 'in-progress']).code, 1, 'without --auto an open item still needs approval');
  assert.deepEqual(sb.run(['next']).json.autoApplicable, {}, 'review units are still open: nothing is suggested for auto-apply yet');
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  assert.ok(sb.read('state.json').log.some((l) => l.item === 'ACME-102' && /Applying automatically/.test(l.text)));
});

test('record hashes the change; undo restores the file and flips the item back to approved', (t) => {
  const sb = ready(t);
  const file = path.join(sb.project, 'CLAUDE.md');
  fs.writeFileSync(file, '# Rules\nline one\nline two\n');
  sb.approve('ACME-101');
  sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress']);
  const backup = sb.backup(file);
  fs.writeFileSync(file, '# Rules\nline one, improved\nline two\n');

  const rec = sb.run(['record', '--item', 'ACME-101', '--path', file, '--backup', backup]);
  assert.equal(rec.code, 0, rec.stdout + rec.stderr);
  assert.deepEqual(rec.json.recorded, {
    n: 1, item: 'ACME-101', display: './CLAUDE.md',
    hashBefore: sha('# Rules\nline one\nline two\n'), hashAfter: sha('# Rules\nline one, improved\nline two\n'),
    at: rec.json.recorded.at, created: false, deleted: false,
  });
  assert.ok(!rec.stdout.includes(sb.home.replace(/\\/g, '\\\\')) && !rec.stdout.includes(sb.home), 'record prints display paths only');
  const entry = sb.read('ledger.json').entries[0];
  assert.equal(entry.path, file, 'the ledger keeps the absolute path: it is local and is what undo needs');
  assert.equal(entry.backup, backup);
  assert.equal(sb.status('ACME-101').backup, 'backups/b1/CLAUDE.md');
  sb.run(['mark', '--item', 'ACME-101', '--status', 'fixed', '--verified', 'read back']);
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  assert.equal(sb.read('state.json').items.find((i) => i.id === 'ACME-101').backup, 'backups/b1/CLAUDE.md');

  assert.equal(sb.run(['undo', '--item', 'ACME-101']).code, 2, 'undo needs --yes');
  assert.equal(sb.run(['undo', '--yes']).code, 2, 'undo needs --item or --all');
  const dry = sb.run(['undo', '--item', 'ACME-101', '--dry-run']);
  assert.equal(dry.code, 0);
  assert.deepEqual({ dryRun: dry.json.dryRun, restored: dry.json.restored, flipped: dry.json.flipped }, { dryRun: true, restored: [{ item: 'ACME-101', display: './CLAUDE.md' }], flipped: ['ACME-101'] });
  assert.equal(fs.readFileSync(file, 'utf8'), '# Rules\nline one, improved\nline two\n', 'a dry run changes nothing');
  assert.equal(sb.status('ACME-101').status, 'fixed');
  assert.ok(!('undoneAt' in sb.read('ledger.json').entries[0]));

  const undo = sb.run(['undo', '--item', 'ACME-101', '--yes']);
  assert.equal(undo.code, 0, undo.stdout);
  assert.deepEqual(undo.json.restored, [{ item: 'ACME-101', display: './CLAUDE.md' }]);
  assert.deepEqual([undo.json.conflicts, undo.json.deleted, undo.json.flipped], [[], [], ['ACME-101']]);
  assert.equal(fs.readFileSync(file, 'utf8'), '# Rules\nline one\nline two\n');
  const o = sb.status('ACME-101');
  assert.equal(o.status, 'approved');
  assert.ok(!('applied' in o) && !('verified' in o) && !('backup' in o));
  assert.match(sb.read('ledger.json').entries[0].undoneAt, /^\d{4}-/);
  assert.equal(sb.run(['undo', '--item', 'ACME-101', '--yes']).json.note, 'no recorded change to undo', 'an undone entry is not undone twice');
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  const state = sb.read('state.json');
  assert.ok(!('applied' in state.items.find((i) => i.id === 'ACME-101').changes[0]));
  assert.ok(state.log.some((l) => l.item === 'ACME-101' && /Change undone: 1 file\(s\) restored/.test(l.text)));
  // The item is approved again, so it can be applied again.
  assert.equal(sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress']).code, 0);
});

test('a file the run created is deleted by undo; a file the run deleted comes back', (t) => {
  const sb = ready(t);
  const created = path.join(sb.project, '.claude', 'rules', 'new-rule.md');
  const removed = path.join(sb.project, 'OLD.md');
  fs.writeFileSync(removed, 'obsolete\n');
  sb.approve('ACME-102');
  sb.run(['mark', '--item', 'ACME-102', '--status', 'in-progress']);

  fs.mkdirSync(path.dirname(created), { recursive: true });
  fs.writeFileSync(created, 'new rule\n');
  const recNew = sb.run(['record', '--item', 'ACME-102', '--path', created, '--new']);
  assert.equal(recNew.code, 0, recNew.stdout);
  assert.deepEqual({ before: recNew.json.recorded.hashBefore, after: recNew.json.recorded.hashAfter, created: recNew.json.recorded.created, display: recNew.json.recorded.display }, { before: null, after: sha('new rule\n'), created: true, display: './.claude/rules/new-rule.md' });

  const backup = sb.backup(removed);
  fs.rmSync(removed);
  const recDel = sb.run(['record', '--item', 'ACME-102', '--path', removed, '--backup', backup]);
  assert.equal(recDel.code, 0, recDel.stdout);
  assert.deepEqual({ before: recDel.json.recorded.hashBefore, after: recDel.json.recorded.hashAfter, deleted: recDel.json.recorded.deleted }, { before: sha('obsolete\n'), after: null, deleted: true });
  sb.run(['mark', '--item', 'ACME-102', '--status', 'fixed', '--verified', 'both checked']);

  const undo = sb.run(['undo', '--all', '--yes']);
  assert.equal(undo.code, 0, undo.stdout);
  assert.deepEqual(undo.json.deleted, [{ item: 'ACME-102', display: './.claude/rules/new-rule.md' }]);
  assert.deepEqual(undo.json.restored, [{ item: 'ACME-102', display: './OLD.md' }]);
  assert.deepEqual(undo.json.flipped, ['ACME-102']);
  assert.ok(!fs.existsSync(created), 'the file the run created is gone');
  assert.equal(fs.readFileSync(removed, 'utf8'), 'obsolete\n', 'the file the run deleted is back');
  assert.equal(sb.status('ACME-102').status, 'approved');
});

test('a file edited after the run is a conflict and is left alone', (t) => {
  const sb = ready(t);
  const a = path.join(sb.project, 'CLAUDE.md');
  const b = path.join(sb.project, 'AGENTS.md');
  fs.writeFileSync(a, 'a before\n');
  fs.writeFileSync(b, 'b before\n');
  for (const id of ['ACME-101', 'NP-101']) { sb.approve(id); sb.run(['mark', '--item', id, '--status', 'in-progress']); }
  const backupA = sb.backup(a, 's1');
  fs.writeFileSync(a, 'a after\n');
  assert.equal(sb.run(['record', '--item', 'ACME-101', '--path', a, '--backup', backupA]).code, 0);
  const backupB = sb.backup(b, 's1');
  fs.writeFileSync(b, 'b after\n');
  assert.equal(sb.run(['record', '--item', 'ACME-101', '--path', b, '--backup', backupB]).code, 0);
  // A second item changes file A again, on top of the first change.
  const backupA2 = sb.backup(a, 's2');
  fs.writeFileSync(a, 'a after, twice\n');
  assert.equal(sb.run(['record', '--item', 'NP-101', '--path', a, '--backup', backupA2]).code, 0);
  for (const id of ['ACME-101', 'NP-101']) sb.run(['mark', '--item', id, '--status', 'fixed', '--verified', 'ok']);

  // Undoing only the first item: file A no longer has the hash that item left.
  const first = sb.run(['undo', '--item', 'ACME-101', '--yes']);
  assert.equal(first.code, 0, first.stdout);
  assert.deepEqual(first.json.restored, [{ item: 'ACME-101', display: './AGENTS.md' }]);
  assert.deepEqual(first.json.conflicts, [{ item: 'ACME-101', display: './CLAUDE.md', reason: 'the file was edited after the run changed it' }]);
  assert.deepEqual(first.json.flipped, []);
  assert.deepEqual(first.json.partial, ['ACME-101'], 'one change undone, one left: the item is not flipped');
  assert.equal(fs.readFileSync(a, 'utf8'), 'a after, twice\n');
  assert.equal(fs.readFileSync(b, 'utf8'), 'b before\n');
  assert.equal(sb.status('ACME-101').status, 'fixed');

  // The user edits file A by hand: now nothing the run left is on disk, and undo touches nothing.
  fs.writeFileSync(a, 'edited by the user\n');
  const all = sb.run(['undo', '--all', '--yes']);
  assert.equal(all.json.conflicts.length, 2);
  assert.deepEqual(all.json.restored, []);
  assert.equal(fs.readFileSync(a, 'utf8'), 'edited by the user\n');
  assert.equal(sb.status('NP-101').status, 'fixed');

  // With the run's last version back in place, --all unwinds both changes in reverse order.
  fs.writeFileSync(a, 'a after, twice\n');
  const dry = sb.run(['undo', '--all', '--dry-run']);
  assert.deepEqual(dry.json.restored.map((r) => r.item), ['NP-101', 'ACME-101'], 'a dry run chains the two changes to the same file');
  assert.deepEqual(dry.json.flipped, ['ACME-101', 'NP-101']);
  const unwind = sb.run(['undo', '--all', '--yes']);
  assert.deepEqual(unwind.json.conflicts, []);
  assert.deepEqual(unwind.json.flipped, ['ACME-101', 'NP-101']);
  assert.equal(fs.readFileSync(a, 'utf8'), 'a before\n');
  assert.equal(sb.status('ACME-101').status, 'approved');
  assert.equal(sb.status('NP-101').status, 'approved');

  // A removed file and a damaged backup are conflicts too.
  sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress']);
  const backupA3 = sb.backup(a, 's3');
  fs.writeFileSync(a, 'third\n');
  sb.run(['record', '--item', 'ACME-101', '--path', a, '--backup', backupA3]);
  fs.writeFileSync(backupA3, 'tampered\n');
  assert.equal(sb.run(['undo', '--item', 'ACME-101', '--yes']).json.conflicts[0].reason, 'the backup is missing or changed');
  fs.rmSync(a);
  assert.equal(sb.run(['undo', '--item', 'ACME-101', '--yes']).json.conflicts[0].reason, 'the file was removed after the run changed it');
});

test('record refuses what it cannot stand behind', (t) => {
  const sb = ready(t);
  const file = path.join(sb.project, 'CLAUDE.md');
  fs.writeFileSync(file, 'before\n');
  const rec = (...args) => sb.run(['record', ...args]);
  const stray = path.join(sb.home, 'stray-backup.md');
  fs.writeFileSync(stray, 'before\n');

  assert.equal(rec('--item', 'ACME-101', '--path', file, '--backup', stray).code, 1, 'the backup must be under the run\'s backups/');
  const backup = sb.backup(file);
  const notApplied = rec('--item', 'ACME-101', '--path', file, '--backup', backup);
  assert.equal(notApplied.code, 1, 'the item is open: nothing is being applied');
  assert.match(notApplied.json.error, /mark it in-progress first/);
  sb.approve('ACME-101');
  sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress']);
  const unchanged = rec('--item', 'ACME-101', '--path', file, '--backup', backup);
  assert.equal(unchanged.code, 1);
  assert.match(unchanged.json.error, /identical to its backup/);

  assert.equal(rec('--item', 'ACME-101', '--path', file).code, 2, '--backup or --new');
  assert.equal(rec('--item', 'ACME-101', '--path', file, '--backup', backup, '--new').code, 2);
  assert.equal(rec('--item', 'ACME-101', '--path', 'relative/file.md', '--backup', backup).code, 2);
  assert.equal(rec('--item', 'ACME-101', '--path', 'https://example.com/x', '--backup', backup).code, 2);
  assert.equal(rec('--item', 'ACME-101', '--path', sb.project, '--backup', backup).code, 1, 'a folder is not a file');
  assert.equal(rec('--item', 'ACME-101', '--path', path.join(sb.project, 'missing.md'), '--new').code, 1, 'nothing was created');
  assert.equal(rec('--item', 'ZZ-101', '--path', file, '--backup', backup).code, 1);
  assert.deepEqual(sb.read('ledger.json').entries, [], 'nothing was recorded');

  // A masked backup is recorded, and undo will not write it over the real file.
  fs.writeFileSync(backup, 'TOKEN=sk-a…\n');
  fs.writeFileSync(file, 'TOKEN moved to the keychain\n');
  const masked = rec('--item', 'ACME-101', '--path', file, '--backup', backup, '--masked');
  assert.equal(masked.code, 0, masked.stdout);
  assert.equal(masked.json.recorded.masked, true);
  const undo = sb.run(['undo', '--item', 'ACME-101', '--yes']);
  assert.match(undo.json.conflicts[0].reason, /secrets masked: restore this file by hand/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'TOKEN moved to the keychain\n');
});
