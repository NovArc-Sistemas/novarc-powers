import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderCatalog } from '../scripts/build-catalog.mjs';
import { LEAK_PATTERNS, scanText, validate } from '../scripts/validate.mjs';

// Secret-shaped samples are assembled at runtime so this file itself stays clean.
const j = (...parts) => parts.join('');
const LEAKS = {
  'github-token': j('gh', 'p_', 'a'.repeat(36)),
  'github-pat': j('github', '_pat_', 'A1'.repeat(15)),
  'secret-key-sk': j('s', 'k-', 'ant-', 'x'.repeat(30)),
  'supabase-token': j('sb', 'p_', 'f'.repeat(40)),
  'slack-token': j('xo', 'xb-', '1234567890-abc'),
  'npm-token': j('np', 'm_', 'B'.repeat(36)),
  'aws-access-key': j('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
  'private-key': j('-----BEGIN ', 'RSA PRIVATE', ' KEY-----'),
  'windows-user-path': j('C:', '\\', 'Users', '\\', 'jdoe', '\\', 'repo'),
  'mac-user-path': j('/', 'Users/', 'jdoe/repo'),
  'linux-home-path': j('/', 'home/', 'jdoe/repo'),
  email: j('jane.doe', '@', 'acme', '.io'),
};

test('every leak pattern fires on its sample', () => {
  assert.deepEqual(Object.keys(LEAKS).sort(), LEAK_PATTERNS.map((p) => p.id).filter((id) => id !== 'aws-secret-key').sort());
  for (const [id, sample] of Object.entries(LEAKS)) {
    const hits = scanText(`before ${sample} after`).map((f) => f.id);
    assert.ok(hits.includes(id), `${id} should fire on its sample, got ${hits.join(',')}`);
  }
});

test('placeholders and allowed addresses do not fire', () => {
  const ok = [
    j('C:', '\\', 'Users', '\\', '<name>', '\\', 'x'),
    j('C:', '\\', 'Users', '\\', 'you', '\\', 'x'),
    j('/', 'Users/', '<user>/x'),
    j('/', 'home/', 'you/x'),
    j('noreply', '@', 'anthropic.com'),
    j('someone', '@', 'example.com'),
    j('git', '@', 'github.com'),
    'see ~/.claude/CLAUDE.md and $HOME/.codex',
  ];
  for (const s of ok) assert.deepEqual(scanText(s), [], s);
});

function fakeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novarc-powers-validate-'));
  const skill = path.join(root, 'skills', 'demo');
  fs.mkdirSync(path.join(skill, 'references'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: demo\ndescription: Demo skill.\n---\n\nSee [notes](references/notes.md).\n');
  fs.writeFileSync(path.join(skill, 'references', 'notes.md'), 'Back to [skill](../SKILL.md).\n');
  fs.writeFileSync(
    path.join(skill, 'skill.json'),
    JSON.stringify({ name: 'demo', version: '0.1.0', summary: 'Demo.', profile: { recommended: 'user', supported: ['user'] } }),
  );
  fs.writeFileSync(path.join(root, 'catalog.json'), renderCatalog(root));
  return root;
}

test('validate passes a clean repo and flags each kind of problem', (t) => {
  const root = fakeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(validate(root), []);

  const skill = path.join(root, 'skills', 'demo');
  const meta = JSON.parse(fs.readFileSync(path.join(skill, 'skill.json'), 'utf8'));
  fs.writeFileSync(path.join(skill, 'skill.json'), JSON.stringify({ ...meta, version: '0.2.0' }));
  fs.appendFileSync(path.join(skill, 'SKILL.md'), '\n[up](../../README.md) [gone](missing.md)\n');
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'leak.md'), `token ${LEAKS['github-token']}\n`);
  fs.mkdirSync(path.join(root, 'tests', 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'fixtures', 'ignored.md'), `token ${LEAKS['npm-token']}\n`);
  const bad = path.join(root, 'skills', 'other');
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, 'SKILL.md'), '---\nname: wrong\n---\n');
  fs.writeFileSync(path.join(bad, 'skill.json'), '{ not json');

  const msgs = validate(root).map((p) => `${p.file}: ${p.message}`);
  const has = (re) => assert.ok(msgs.some((m) => re.test(m)), `expected ${re} in\n${msgs.join('\n')}`);
  has(/catalog\.json: stale/);
  has(/link points outside the skill: \.\.\/\.\.\/README\.md/);
  has(/broken link: missing\.md/);
  has(/docs\/leak\.md:1: possible leak \(github-token\)/);
  has(/skills\/other\/SKILL\.md: frontmatter name "wrong" differs/);
  has(/skills\/other\/SKILL\.md: frontmatter description missing/);
  has(/skills\/other\/skill\.json: invalid JSON/);
  assert.equal(msgs.some((m) => m.includes('fixtures')), false, 'tests/fixtures is skipped');
});