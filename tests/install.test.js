import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PKG_VERSION, countOccurrences, read, readJson, run, sandbox } from './helpers.js';

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('copy install writes files and a manifest with matching hashes', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const r = run(sb, ['add', 'beta', '--scope', 'user', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  const target = path.join(sb.home, '.claude', 'skills', 'beta');
  assert.ok(fs.existsSync(path.join(target, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(target, 'references', 'notes.md')));
  const m = readJson(path.join(sb.home, '.novarc-powers', 'manifest.json'));
  assert.equal(m.packageVersion, PKG_VERSION);
  assert.equal(m.updates, 'notify');
  const e = m.entries.find((x) => x.skill === 'beta');
  assert.equal(e.profile, 'user');
  assert.equal(e.tool, 'claude-code');
  assert.equal(e.version, '1.0.0');
  assert.deepEqual(Object.keys(e.files).sort(), ['SKILL.md', 'references/notes.md', 'skill.json']);
  for (const [rel, hash] of Object.entries(e.files)) assert.equal(sha(path.join(target, ...rel.split('/'))), hash);
  // Re-running changes nothing.
  const again = run(sb, ['add', 'beta', '--scope', 'user', '--yes', '--json']);
  assert.equal(again.code, 0);
  assert.equal(again.json.plan.flatMap((p) => p.actions).length, 0);
});

test('on-demand install writes one pointer block; removing the last skill removes it', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const claudeMd = path.join(sb.home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(claudeMd, '# Personal rules\r\n\r\nKeep it short.\r\n');
  assert.equal(run(sb, ['add', 'alpha', '--scope', 'user', '--yes']).code, 0);
  assert.equal(run(sb, ['add', 'gamma', '--scope', 'user', '--profile', 'on-demand', '--yes']).code, 0);
  let text = read(claudeMd);
  assert.ok(text.startsWith('# Personal rules\r\n\r\nKeep it short.\r\n'));
  assert.equal(countOccurrences(text, '<!-- novarc-powers:start -->'), 1);
  assert.match(text, /- `alpha`: /);
  assert.match(text, /- `gamma`: /);
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'CRLF preserved');
  const backups = path.join(sb.home, '.novarc-powers', 'backups');
  assert.ok(fs.readdirSync(backups).length >= 1, 'pre-existing file was backed up');
  assert.equal(run(sb, ['remove', 'alpha', '--yes']).code, 0);
  text = read(claudeMd);
  assert.doesNotMatch(text, /- `alpha`: /);
  assert.match(text, /- `gamma`: /);
  assert.equal(run(sb, ['remove', 'gamma', '--yes']).code, 0);
  assert.equal(read(claudeMd), '# Personal rules\r\n\r\nKeep it short.\r\n');
  assert.equal(fs.existsSync(path.join(sb.home, '.novarc-powers', 'manifest.json')), false);
});

test('update: hand-edited file is a conflict, --force overwrites it', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  assert.equal(run(sb, ['add', 'beta', '--scope', 'user', '--yes']).code, 0);
  const file = path.join(sb.home, '.claude', 'skills', 'beta', 'SKILL.md');
  const pristine = read(file);
  fs.writeFileSync(file, pristine + '\nmy local tweak\n');

  const status = run(sb, ['status', '--json']);
  const entry = status.json.scopes[0].entries.find((e) => e.skill === 'beta');
  assert.deepEqual(entry.handEdited, [{ file: 'SKILL.md', reason: 'modified' }]);

  const check = run(sb, ['update', '--check', '--json']);
  assert.equal(check.code, 0);
  assert.equal(check.json.scopes[0].conflicts.length, 1);
  assert.match(read(file), /my local tweak/, '--check writes nothing');

  const upd = run(sb, ['update', '--yes', '--json']);
  assert.equal(upd.code, 0);
  assert.equal(upd.json.plan[0].conflicts[0].files[0].file, 'SKILL.md');
  assert.match(read(file), /my local tweak/, 'conflict skipped without --force');

  const forced = run(sb, ['update', '--yes', '--force']);
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(read(file), pristine);
  const backupRoot = path.join(sb.home, '.novarc-powers', 'backups');
  const backedUp = fs.readdirSync(backupRoot).flatMap((d) => fs.readdirSync(path.join(backupRoot, d)).map((f) => path.join(backupRoot, d, f)));
  assert.ok(backedUp.some((f) => f.endsWith('SKILL.md') && /my local tweak/.test(read(f))), 'hand-edited file backed up before --force');
  assert.equal(run(sb, ['status', '--json']).json.scopes[0].entries.find((e) => e.skill === 'beta').handEdited.length, 0);
});

test('remove keeps skill data unless --purge', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  assert.equal(run(sb, ['add', 'beta', '--scope', 'project', '--yes']).code, 0);
  const target = path.join(sb.cwd, '.claude', 'skills', 'beta');
  const data = path.join(sb.cwd, '.novarc-powers', 'beta');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'state.json'), '{}');
  assert.equal(run(sb, ['remove', 'beta', '--scope', 'project', '--yes']).code, 0);
  assert.equal(fs.existsSync(target), false, 'installed files removed');
  assert.ok(fs.existsSync(path.join(data, 'state.json')), 'data kept without --purge');

  assert.equal(run(sb, ['add', 'beta', '--scope', 'project', '--yes']).code, 0);
  assert.equal(run(sb, ['remove', 'beta', '--scope', 'project', '--purge', '--yes']).code, 0);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(data), false, 'data deleted with --purge');
});

test('project install generates .novarc-powers/.gitignore from workspace.local', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  assert.equal(run(sb, ['add', 'beta', 'gamma', '--scope', 'project', '--yes']).code, 0);
  const gi = read(path.join(sb.cwd, '.novarc-powers', '.gitignore'));
  assert.match(gi, /^\*\/cache-data\/$/m);
  assert.match(gi, /^\*\/board\.html$/m);
  assert.match(gi, /^backups\/$/m);
  assert.match(gi, /^cache\/$/m);
});

test('project scope with codex + agents dedupes to one skills dir and one AGENTS.md', (t) => {
  const sb = sandbox({ claude: false });
  t.after(sb.cleanup);
  const r = run(sb, ['add', 'beta', 'alpha', '--scope', 'project', '--tools', 'codex,agents', '--profile', 'project', '--yes', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const copies = r.json.plan[0].actions.filter((a) => a.kind === 'copy');
  assert.equal(copies.length, 2, 'one copy per skill, not per tool');
  const m = readJson(path.join(sb.cwd, '.novarc-powers', 'manifest.json'));
  for (const e of m.entries) assert.deepEqual(e.tools, ['codex', 'agents']);

  const r2 = run(sb, ['add', 'alpha', '--scope', 'project', '--tools', 'codex,agents', '--profile', 'on-demand', '--yes']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(countOccurrences(read(path.join(sb.cwd, 'AGENTS.md')), '<!-- novarc-powers:start -->'), 1);
  assert.equal(fs.existsSync(path.join(sb.cwd, '.agents', 'skills', 'alpha')), false, 'switching profile removed the copy');
});

test('fetch prints exactly one absolute path to SKILL.md', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const r = run(sb, ['fetch', 'alpha']);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(r.stdout, lines[0] + '\n');
  assert.ok(path.isAbsolute(lines[0]));
  assert.equal(lines[0], path.join(sb.home, '.novarc-powers', 'cache', `alpha@${PKG_VERSION}`, 'SKILL.md'));
  assert.match(read(lines[0]), /name: alpha/);
  // Overwrites on a second call.
  fs.writeFileSync(lines[0], 'tampered');
  assert.equal(run(sb, ['fetch', 'alpha']).stdout, r.stdout);
  assert.match(read(lines[0]), /name: alpha/);
});

test('fetch errors go to stderr with a non-zero exit', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const r = run(sb, ['fetch', 'does-not-exist']);
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Unknown skill/);
  const bad = run(sb, ['fetch', '../evil']);
  assert.notEqual(bad.code, 0);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /Invalid skill name/);
});

test('non-TTY install without required choices fails with a clear message', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const r = run(sb, []);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /--scope/);
  assert.match(r.stderr, /--skills/);
  const j = run(sb, ['install', '--json']);
  assert.notEqual(j.code, 0);
  assert.equal(j.json.code, 'MISSING_CHOICES');
  const noYes = run(sb, ['--scope', 'user', '--skills', 'alpha']);
  assert.notEqual(noYes.code, 0);
  assert.match(noYes.stderr, /--yes/);
  assert.equal(fs.existsSync(path.join(sb.home, '.novarc-powers')), false, 'nothing written');
});

test('--dry-run --json reports the plan and writes nothing', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const r = run(sb, ['--scope', 'both', '--skills', 'alpha,beta,gamma', '--dry-run', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.dryRun, true);
  const kinds = r.json.plan.flatMap((p) => p.actions.map((a) => a.kind));
  for (const k of ['copy', 'block', 'settings', 'hook-script', 'config', 'manifest', 'gitignore']) assert.ok(kinds.includes(k), k);
  assert.deepEqual(fs.readdirSync(path.join(sb.home, '.claude')), []);
  assert.deepEqual(fs.readdirSync(sb.cwd), []);
});

test('invalid skill names and unsupported profiles are refused', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  assert.match(run(sb, ['add', 'Bad_Name', '--scope', 'user', '--yes']).stderr, /Invalid skill name/);
  assert.match(run(sb, ['add', 'beta', '--scope', 'user', '--profile', 'on-demand', '--yes']).stderr, /does not support/);
});