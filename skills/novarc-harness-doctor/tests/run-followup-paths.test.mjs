// The on-disk check of a follow-up never leaves the harness (scripts/lib/run/diskcheck.mjs). The
// paths it follows come from a review record, a file anyone can edit: a path is followed only
// inside the real folders of that harness, and a file reached through a link that leads out, a
// file of the home named with `~`, a link to nowhere, anything that is not a regular file and a
// file over the size limit are `not-checked`. Nothing of them is read.
//
// Links are real ones. Where the platform will not make one (a file symlink on Windows without the
// privilege), that case is skipped and says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, clock, historyOf, measured, writeImpact, firstReview } from './run-helpers.mjs';
import { tmpDir, rmrf } from './helpers.mjs';
import { checkItem, checkRoots, realPathOf, MAX_CHECK_BYTES } from '../scripts/lib/run/diskcheck.mjs';

const MARKER = 'private_marker';
/** A change that would be `in-place` if the file were read: the file holds its `after` text. */
const looksFor = (p) => ({ changes: [{ path: p, before: '', after: MARKER }] });

/** Make a link, or return false where this platform or account cannot. */
function link(target, at, type) {
  try { fs.symlinkSync(target, at, type); return true; } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'ENOSYS' || e.code === 'UNKNOWN')) return false;
    throw e;
  }
}

function home(t) {
  const dir = tmpDir('hd-paths-');
  const before = process.env.NOVARC_POWERS_HOME;
  process.env.NOVARC_POWERS_HOME = dir;
  t.after(() => { if (before === undefined) delete process.env.NOVARC_POWERS_HOME; else process.env.NOVARC_POWERS_HOME = before; rmrf(dir); });
  return dir;
}
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test('a project: nothing outside its repository is read, by `~`, by `..` or through a link', (t) => {
  const dir = home(t);
  const root = path.join(dir, 'dev', 'acme');
  const h = { id: 'acme', kind: 'project', path: '~/dev/acme', pathAbs: root };
  put(path.join(root, 'CLAUDE.md'), `rules\n${MARKER}\n`);
  put(path.join(dir, 'outside.txt'), `${MARKER}\n`);
  put(path.join(dir, 'elsewhere', 'secret.txt'), `${MARKER}\n`);
  const check = (p) => checkItem(looksFor(p), h);

  assert.equal(check('./CLAUDE.md'), 'in-place', 'the check works: a file of the project that holds the text');
  assert.equal(check('~/dev/acme/CLAUDE.md'), 'in-place');
  // The home is not the project, even though the project lives in it.
  assert.equal(check('~/outside.txt'), 'not-checked');
  assert.equal(check('~/elsewhere/secret.txt'), 'not-checked');
  assert.equal(check('../../outside.txt'), 'not-checked');
  assert.equal(check('./sub/../../../outside.txt'), 'not-checked');
  assert.equal(check('~/dev/acme/../../outside.txt'), 'not-checked', 'the display path of the project is no way out either');
  assert.equal(check(path.join(dir, 'outside.txt')), 'not-checked', 'an absolute path is never taken from a record');

  // A link to a folder outside (a junction on Windows, which needs no privilege).
  assert.ok(link(path.join(dir, 'elsewhere'), path.join(root, 'linkdir'), 'junction'), 'a folder link can be made on every platform this runs on');
  assert.equal(check('./linkdir/secret.txt'), 'not-checked', 'a file reached through a link that leads out');
  assert.equal(check('./linkdir/not-there.txt'), 'not-checked', 'not "missing": nothing is said about a folder outside the project');
  // A link that stays inside the project is the project.
  fs.mkdirSync(path.join(root, 'docs'));
  put(path.join(root, 'docs', 'guide.md'), `${MARKER}\n`);
  assert.ok(link(path.join(root, 'docs'), path.join(root, 'manual'), 'junction'));
  assert.equal(check('./manual/guide.md'), 'in-place');
  assert.equal(check('./manual/gone.md'), 'missing');

  // A link to a file outside.
  if (link(path.join(dir, 'outside.txt'), path.join(root, 'linked.txt'), 'file')) {
    assert.equal(check('./linked.txt'), 'not-checked', 'the link passes a look at its name; its real path is outside');
    // A link to nowhere is a link, not a missing file.
    assert.ok(link(path.join(dir, 'no-such-file.txt'), path.join(root, 'dangling.txt'), 'file'));
    assert.equal(check('./dangling.txt'), 'not-checked');
    // And a link to a file of the project is that file.
    assert.ok(link(path.join(root, 'CLAUDE.md'), path.join(root, 'alias.md'), 'file'));
    assert.equal(check('./alias.md'), 'in-place');
  } else t.diagnostic('file symlinks cannot be made here (no privilege): the file-link cases were skipped; the folder-link cases ran');

  // Not a regular file, and a file over the limit: nothing is read.
  assert.equal(check('./docs'), 'not-checked');
  put(path.join(root, 'big.md'), `${MARKER}\n${'x'.repeat(MAX_CHECK_BYTES)}`);
  assert.equal(check('./big.md'), 'not-checked');
  put(path.join(root, 'fits.md'), `${MARKER}\n${'x'.repeat(1024)}`);
  assert.equal(check('./fits.md'), 'in-place');

  // A project that is itself reached through a link: its real folder is its root.
  assert.ok(link(root, path.join(dir, 'dev', 'acme-link'), 'junction'));
  const through = { id: 'acme', kind: 'project', path: '~/dev/acme-link', pathAbs: path.join(dir, 'dev', 'acme-link') };
  assert.equal(checkItem(looksFor('./CLAUDE.md'), through), 'in-place');
  assert.equal(checkItem(looksFor('./linkdir/secret.txt'), through), 'not-checked');
  assert.equal(checkItem(looksFor('~/outside.txt'), through), 'not-checked');

  // A project whose folder is gone: its files are missing, and nothing else is looked at.
  const gone = { id: 'gone', kind: 'project', path: '~/dev/gone', pathAbs: path.join(dir, 'dev', 'gone') };
  assert.equal(checkItem(looksFor('./CLAUDE.md'), gone), 'missing');
  assert.equal(checkItem(looksFor('~/outside.txt'), gone), 'not-checked');

  assert.deepEqual(realPathOf(path.join(root, 'no', 'such', 'file.md')), { real: path.join(fs.realpathSync.native(root), 'no', 'such', 'file.md'), exists: false });
});

test('a user harness: its config folder, the account it links into, and the one state file its snapshot reads', (t) => {
  const dir = home(t);
  const claude = { id: 'claude-1', kind: 'user', provider: 'claude-code', path: '~/.claude', pathAbs: path.join(dir, '.claude') };
  const second = { id: 'claude-2', kind: 'user', provider: 'claude-code', path: '~/.claude-work', pathAbs: path.join(dir, '.claude-work'), inherits: 'claude-1' };
  const codex = { id: 'codex-1', kind: 'user', provider: 'codex', path: '~/.codex', pathAbs: path.join(dir, '.codex') };
  const run = { harnesses: [claude, second, codex] };
  for (const h of run.harnesses) put(path.join(h.pathAbs, 'CLAUDE.md'), `${MARKER}\n`);
  put(path.join(dir, '.claude.json'), `{ "note": "${MARKER}" }\n`);
  put(path.join(dir, 'notes.txt'), `${MARKER}\n`);
  const check = (p, h) => checkItem(looksFor(p), h, checkRoots(run, h));

  assert.equal(check('~/.claude/CLAUDE.md', claude), 'in-place');
  assert.equal(check('~/notes.txt', claude), 'not-checked', 'the home is not the account');
  assert.equal(check('~/.codex/CLAUDE.md', claude), 'not-checked', 'nor is another account');
  // The default Claude account keeps `.claude.json` beside its folder: that file, and no other.
  assert.equal(check('~/.claude.json', claude), 'in-place');
  assert.equal(check('~/.claude.json', codex), 'not-checked');
  assert.equal(check('~/.claude.json', second), 'not-checked', 'a second account has its own state file, inside its folder');
  // An account that links into another reads that account's files.
  assert.equal(check('~/.claude/CLAUDE.md', second), 'in-place');
  assert.equal(check('~/.claude-work/CLAUDE.md', second), 'in-place');
  assert.equal(checkItem(looksFor('~/.claude/CLAUDE.md'), second), 'not-checked', 'only when that account is in the run');
  assert.equal(check('~/.codex/CLAUDE.md', second), 'not-checked');
  assert.deepEqual(checkRoots(run, codex), { dirs: [fs.realpathSync.native(codex.pathAbs)], files: [] });
});

test('through a real follow-up: a record edited to point outside the project gets no verdict', (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop'] });
  const first = firstReview(sb);
  const history = historyOf(sb);
  put(path.join(sb.home, 'outside.txt'), `${MARKER}\n`);
  put(path.join(sb.home, 'elsewhere', 'secret.txt'), `${MARKER}\n`);
  assert.ok(link(path.join(sb.home, 'elsewhere'), path.join(sb.home, 'dev', 'acme-shop', 'linkdir'), 'junction'));
  const recordFile = path.join(history.dir, first.key, `${first.runId}.json`);
  const original = fs.readFileSync(recordFile, 'utf8');
  const second = '2026-02-10T12:00:00.000Z';
  const started = sb.run(['init', '--follow-up', 'latest'], clock(second));
  assert.equal(started.code, 0, started.stdout + started.stderr);
  sb.runId = started.json.runId;
  sb.dir = started.json.dir;
  writeImpact(sb, 'acme-shop', measured({ from: '2026-01-11T12:00:00.000Z', to: second, sessions: 25 }));

  const checkOf = (changePath) => {
    const record = JSON.parse(original);
    record.items[0].changes = [{ path: changePath, before: '', after: MARKER }];
    fs.writeFileSync(recordFile, JSON.stringify(record));
    const built = sb.run(['build', '--no-render']);
    assert.equal(built.code, 0, built.stdout + built.stderr);
    const text = sb.text('state.json');
    assert.ok(!text.includes(sb.home) && !text.includes(sb.home.replace(/\\/g, '/')), 'nothing absolute enters the state');
    return JSON.parse(text).harnesses[0].followUp.items[0];
  };
  assert.deepEqual([checkOf('~/outside.txt').check, checkOf('./linkdir/secret.txt').check, checkOf('../../outside.txt').check], ['not-checked', 'not-checked', 'not-checked']);
  fs.writeFileSync(path.join(sb.home, 'dev', 'acme-shop', 'inside.txt'), `${MARKER}\n`);
  assert.deepEqual(checkOf('./inside.txt'), { id: 'ACME-101', title: 'Finding ACME-101', round: 1, status: 'fixed', check: 'in-place', paths: ['./inside.txt'], saves: 200000 }, 'the same change, on a file of the project');
});
