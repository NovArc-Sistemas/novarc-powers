import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveReal } from '../src/fsutil.js';
import { countOccurrences, read, readJson, run, sandbox, trySymlink } from './helpers.js';

const START = '<!-- novarc-powers:start -->';

test('resolveReal canonicalises paths that do not exist yet', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const p = path.join(sb.home, '.claude', 'not', 'yet', 'here.md');
  assert.equal(resolveReal(p), path.join(fs.realpathSync.native(path.join(sb.home, '.claude')), 'not', 'yet', 'here.md'));
});

test('CLAUDE_CONFIG_DIR pointing at ~/.claude (other spelling) collapses to one target', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const alt = path.join(sb.home, '.claude') + path.sep;
  const spelled = process.platform === 'win32' ? alt.toUpperCase() : path.join(sb.home, '.', '.claude');
  const r = run(sb, ['add', 'alpha', '--scope', 'user', '--yes', '--json'], { env: { CLAUDE_CONFIG_DIR: spelled } });
  assert.equal(r.code, 0, r.stderr);
  const blocks = r.json.plan[0].actions.filter((a) => a.kind === 'block');
  assert.equal(blocks.length, 1);
  assert.equal(countOccurrences(read(path.join(sb.home, '.claude', 'CLAUDE.md')), START), 1);
});

test('symlinked CLAUDE.md in CLAUDE_CONFIG_DIR: block written once, link survives install and remove', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const main = path.join(sb.home, '.claude', 'CLAUDE.md');
  const altDir = path.join(sb.home, '.claude-second');
  const altMd = path.join(altDir, 'CLAUDE.md');
  fs.mkdirSync(altDir);
  fs.writeFileSync(main, '# Shared rules\n');
  if (!trySymlink(main, altMd)) {
    t.skip('this OS refused to create a file symlink');
    return;
  }
  const env = { CLAUDE_CONFIG_DIR: altDir };
  const r = run(sb, ['add', 'alpha', '--scope', 'user', '--yes', '--json'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.plan[0].actions.filter((a) => a.kind === 'block').length, 1, 'one block action for two config dirs');
  assert.ok(fs.lstatSync(altMd).isSymbolicLink(), 'still a symlink after install');
  assert.equal(path.resolve(altDir, fs.readlinkSync(altMd)), main);
  assert.equal(countOccurrences(read(main), START), 1);
  const m = readJson(path.join(sb.home, '.novarc-powers', 'manifest.json'));
  assert.equal(m.entries.filter((e) => e.skill === 'alpha').length, 1);
  // The second account still gets its own settings.json hook.
  assert.ok(fs.existsSync(path.join(altDir, 'settings.json')));

  assert.equal(run(sb, ['remove', 'alpha', '--yes'], { env }).code, 0);
  assert.ok(fs.lstatSync(altMd).isSymbolicLink(), 'still a symlink after remove');
  assert.equal(read(main), '# Shared rules\n');
});

test('hardlinked CLAUDE.md: block written once, inode preserved after install and remove', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const main = path.join(sb.home, '.claude', 'CLAUDE.md');
  const altDir = path.join(sb.home, '.claude-second');
  const altMd = path.join(altDir, 'CLAUDE.md');
  fs.mkdirSync(altDir);
  fs.writeFileSync(main, '# Shared rules\n');
  try {
    fs.linkSync(main, altMd);
  } catch (err) {
    t.skip(`hardlinks unavailable: ${err.code}`);
    return;
  }
  const ino = (p) => fs.statSync(p, { bigint: true }).ino;
  const before = ino(main);
  assert.equal(ino(altMd), before);
  const env = { CLAUDE_CONFIG_DIR: altDir };
  const r = run(sb, ['add', 'alpha', '--scope', 'user', '--yes', '--json'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.plan[0].actions.filter((a) => a.kind === 'block').length, 1);
  assert.equal(ino(main), before, 'main inode unchanged');
  assert.equal(ino(altMd), before, 'still hardlinked');
  assert.equal(fs.statSync(main).nlink, 2);
  assert.equal(countOccurrences(read(altMd), START), 1);
  assert.equal(run(sb, ['remove', 'alpha', '--yes'], { env }).code, 0);
  assert.equal(ino(main), before);
  assert.equal(ino(altMd), before);
  assert.equal(read(altMd), '# Shared rules\n');
});

test('symlinked settings.json keeps its link when the hook is registered and removed', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const realSettings = path.join(sb.base, 'shared-settings.json');
  fs.writeFileSync(realSettings, '{\n  "model": "x"\n}\n');
  const link = path.join(sb.home, '.claude', 'settings.json');
  if (!trySymlink(realSettings, link)) {
    t.skip('this OS refused to create a file symlink');
    return;
  }
  assert.equal(run(sb, ['add', 'alpha', '--scope', 'user', '--yes']).code, 0);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.match(read(realSettings), /check-update\.js/);
  assert.equal(run(sb, ['remove', 'alpha', '--yes']).code, 0);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.deepEqual(readJson(realSettings), { model: 'x' });
});

test('copy never follows a symlink planted inside the target dir', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  assert.equal(run(sb, ['add', 'beta', '--scope', 'user', '--yes']).code, 0);
  const target = path.join(sb.home, '.claude', 'skills', 'beta');
  const outside = path.join(sb.base, 'outside');
  fs.mkdirSync(outside);
  fs.rmSync(path.join(target, 'references'), { recursive: true });
  if (!trySymlink(outside, path.join(target, 'references'), 'junction')) {
    t.skip('this OS refused to create a directory link');
    return;
  }
  const r = run(sb, ['update', '--yes', '--force']);
  assert.notEqual(r.code, 0, 'refuses to write through the link');
  assert.match(r.stderr, /outside the target/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written outside');
});