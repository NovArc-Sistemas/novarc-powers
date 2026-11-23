import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, rmrf, homeEnv, runScript, write, git, trySymlink, SKILL_DIR } from './helpers.mjs';
import { encodeProjectPath } from '../scripts/lib/locations.mjs';
import { scanText } from '../scripts/secret-scan.mjs';
import { maskText, maskSensitiveText, isSensitiveName } from '../scripts/lib/snapshot/mask.mjs';
import { parseWorkflow, hookList } from '../scripts/lib/snapshot/scan.mjs';
import { hookBlocking } from '../scripts/lib/snapshot/elements.mjs';
import { cutToBytes, langOf } from '../scripts/lib/snapshot/files.mjs';
import { projectGitInfo } from '../scripts/lib/snapshot/project.mjs';

// Every secret-looking value is assembled at runtime, so the repository scan finds none in this file.
const TOKEN_GH = `ghp_${'x'.repeat(36)}`;
const TOKEN_SB = `sbp_${'a1'.repeat(20)}`;
const TOKEN_BEARER = `tk${'Zz9'.repeat(12)}`; // no known prefix: only the header rule can catch it
const URL_PASSWORD = `pw${'Qq7'.repeat(4)}`;
const ENV_VALUE = `plain/val+${'k3'.repeat(8)}=`; // has `/`, `+`, `=`: not the scanner's generic shape
const KEY_BODY = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj'].map((s) => s.split('').reverse().join(''));
const KEY_BEGIN = `-----BEGIN RSA ${'PRIVATE'} KEY-----`;
const KEY_END = `-----END RSA ${'PRIVATE'} KEY-----`;
const SECRETS = [TOKEN_GH, TOKEN_SB, TOKEN_BEARER, URL_PASSWORD, ENV_VALUE, ...KEY_BODY];
const MAIL = ['person', 'example.invalid'].join('@');
const WORKER_TOML = 'model = "y"\ndescription = "Does the work."\n';

let fx;
let tmpRoot = null;

function buildProject(home) {
  const proj = path.join(home, 'dev', 'proj-snap');
  fs.mkdirSync(proj, { recursive: true });
  git(proj, ['init', '-q', '-b', 'main']);
  write(path.join(proj, 'package.json'), '{"name":"proj-snap"}\n');
  write(path.join(proj, 'README.md'), '# Proj snap\n\nThis is the readme of the project and it is written for the people who use it.\n');
  write(path.join(proj, 'CLAUDE.md'), [
    '# Project rules', '',
    '@docs/guide.md', '@docs/nowhere.md', '@docs/huge.md', '@assets/blob.bin', '@.env', '',
    'Read docs/small.md before a release; docs/big.md has the history.',
    'Run `bash scripts/check.sh` before pushing.', '',
  ].join('\n'));
  write(path.join(proj, 'docs', 'guide.md'), '# Guide\n\nThis guide is for the agent and it is the one that is always in the context of the session.\n');
  write(path.join(proj, 'docs', 'small.md'), '# Small\n\nRelease steps.\n');
  write(path.join(proj, 'docs', 'big.md'), `# Big\n\n${'History line that is not small at all.\n'.repeat(600)}`);
  write(path.join(proj, 'docs', 'other.md'), '# Other\n\nNobody points at this one.\n');
  write(path.join(proj, 'docs', 'huge.md'), `# Huge\n\n${'A line of an oversized instruction file.\n'.repeat(7500)}`); // ~300 KB
  fs.mkdirSync(path.join(proj, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'assets', 'blob.bin'), Buffer.from([1, 2, 0, 3, 0, 255, 0, 9]));
  write(path.join(proj, '.env'), `# local values\nAPI_URL=https://api.example.invalid\nDB_PASSWORD=${URL_PASSWORD}\n`);
  write(path.join(proj, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(npm test)', 'Read'], deny: ['Bash(rm -rf *)'], ask: ['Bash(git push)'], defaultMode: 'acceptEdits' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [
        { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.mjs"' },
        { type: 'command', command: 'my-guard --strict' },
      ] }],
      PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'echo edited >> .claude/log.txt' }] }],
      Stop: [{ hooks: [{ type: 'command', command: `curl -s -H "Authorization: Bearer ${TOKEN_BEARER}" https://hooks.example.invalid/done || true` }] }],
    },
    env: { SERVICE_SECRET: ENV_VALUE, DATABASE_URL: `postgres://app:${URL_PASSWORD}@db.example.invalid:5432/app` },
    enabledPlugins: { 'alpha@market-one': true },
  }, null, 2));
  write(path.join(proj, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: [`Bash(GH_TOKEN=${TOKEN_GH} gh api *)`] } }, null, 2));
  write(path.join(proj, '.claude', 'hooks', 'guard.mjs'), '// Stops a dangerous command.\nif (process.argv.includes("--bad")) { console.error("blocked"); process.exit(2); }\n');
  write(path.join(proj, '.claude', 'skills', 'proj-skill', 'SKILL.md'), `---\nname: proj-skill\ndescription: ${'Use when the project needs its own release steps. '.repeat(9).trim()}\n---\n\n# Proj skill\n\nBody.\n`);
  write(path.join(proj, '.claude', 'agents', 'helper.md'), '---\nname: helper\ndescription: Reads code and answers questions about it.\nmodel: sonnet\ntools: Read, Grep\n---\n\nYou are a helper.\n');
  write(path.join(proj, '.claude', 'commands', 'deploy.md'), '# Deploy\n\nSteps.\n');
  write(path.join(proj, '.claude', 'rules', 'style.md'), '# Style\n\nAlways on.\n');
  write(path.join(proj, '.claude', 'rules', 'api.md'), '---\npaths:\n  - "src/api/**"\n---\n\n# API rules\n');
  write(path.join(proj, '.mcp.json'), JSON.stringify({
    mcpServers: {
      supabase: { command: 'npx', args: ['-y', 'supabase-mcp'], env: { SUPABASE_ACCESS_TOKEN: TOKEN_SB } },
      'remote-api': { type: 'http', url: 'https://mcp.example.invalid/x', headers: { Authorization: `Bearer ${TOKEN_BEARER}` } },
    },
  }, null, 2));
  write(path.join(proj, 'scripts', 'check.sh'), ['#!/bin/sh', `export GH_TOKEN=${TOKEN_GH}`, KEY_BEGIN, ...KEY_BODY, KEY_END, 'npm test', ''].join('\n'));
  write(path.join(proj, '.github', 'workflows', 'ci.yml'), [
    'name: CI', 'on:', '  push:', '    branches: [main]', '  pull_request:', '  schedule:', "    - cron: '0 3 * * 1'", '',
    'jobs:', '  lint:', '    runs-on: ubuntu-latest', '    steps:', '      - run: npm run lint', '  test:', '    runs-on: ubuntu-latest', '    steps:', '      - run: npm test', '',
  ].join('\n'));
  git(proj, ['add', '-A']);
  git(proj, ['commit', '-q', '-m', 'init']);
  // Written after the commit: git would run a pre-commit hook that is already there.
  write(path.join(proj, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nnpm test\n');
  write(path.join(proj, '.git', 'hooks', 'pre-push.sample'), '#!/bin/sh\nexit 0\n');
  return proj;
}

function buildUser(home, proj) {
  const claude = path.join(home, '.claude');
  const pluginRoot = path.join(claude, 'plugins', 'cache', 'market-one', 'alpha', '1.0.0');
  write(path.join(home, 'shared', 'base.md'), 'Shared base rules that another folder owns.\n');
  write(path.join(home, 'shared', 'skills', 'linked-skill', 'SKILL.md'), '---\nname: linked-skill\ndescription: Lives in a shared folder.\n---\n');
  write(path.join(claude, 'CLAUDE.md'), '# User rules\n\n@extra.md\n@linked.md\n@gone.md\n\nUse `python ~/.claude/scripts/tool.py` for the API.\n');
  write(path.join(claude, 'extra.md'), 'Extra rules.\n');
  const fileLink = trySymlink(path.join(home, 'shared', 'base.md'), path.join(claude, 'linked.md'), 'file');
  write(path.join(claude, 'AGENTS.md'), '# Left over from another agent\n');
  write(path.join(claude, 'settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(git status)', 'Read'], deny: ['Bash(git push --force *)'], defaultMode: 'default' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${path.join(claude, 'hooks', 'guard.js')}"` }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'pwsh', args: ['-NoProfile', '-File', path.join(claude, 'hooks', 'start.ps1')], async: true }] }],
    },
    statusLine: { type: 'command', command: `node "${path.join(claude, 'statusline.mjs')}"` },
    enabledPlugins: { 'alpha@market-one': true, 'beta@market-one': false },
    extraKnownMarketplaces: { 'market-one': { source: { source: 'github', repo: 'example/market-one' } } },
    outputStyle: 'Terse',
    env: { SOME_TOKEN: TOKEN_GH },
  }, null, 2));
  write(path.join(claude, 'hooks', 'guard.js'), 'if (process.env.BAD) process.exit(2);\n');
  write(path.join(claude, 'hooks', 'start.ps1'), 'Write-Output "hello"\n');
  write(path.join(claude, 'statusline.mjs'), 'console.log("status");\n');
  write(path.join(claude, 'scripts', 'tool.py'), `#!/usr/bin/env python3\nAPI_TOKEN = "${TOKEN_SB}"\nprint("ok")\n`);
  write(path.join(claude, 'keybindings.json'), '{"bindings":[]}\n');
  write(path.join(claude, 'skills', 'alpha-skill', 'SKILL.md'), `---\nname: alpha-skill\ndescription: ${'Use when alpha work is needed. '.repeat(20).trim()}\n---\n\nBody.\n`);
  const dirLink = trySymlink(path.join(home, 'shared', 'skills', 'linked-skill'), path.join(claude, 'skills', 'linked-skill'), 'junction');
  write(path.join(claude, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews a diff.\nmodel: opus\ntools: [Read, Grep, Glob]\n---\n\nReview carefully.\n');
  write(path.join(claude, 'commands', 'ship.md'), '# Ship\n');
  write(path.join(claude, 'rules', 'always.md'), '# Always\n');
  write(path.join(claude, 'rules', 'scoped.md'), '---\npaths: ["src/**"]\n---\n# Scoped\n');
  write(path.join(claude, 'output-styles', 'terse.md'), '---\nname: Terse\ndescription: Short answers.\n---\n\nBe brief.\n');
  write(path.join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'alpha@market-one': [{ scope: 'user', installPath: pluginRoot, version: '1.0.0', lastUpdated: '2026-01-01T00:00:00.000Z' }],
    'beta@market-one': [{ scope: 'user', installPath: path.join(claude, 'plugins', 'cache', 'market-one', 'beta', '0.1.0'), version: '0.1.0', lastUpdated: '2026-01-01T00:00:00.000Z' }],
  } }, null, 2));
  write(path.join(claude, 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'market-one': { source: { source: 'github', repo: 'example/market-one' }, installLocation: path.join(claude, 'plugins', 'marketplaces', 'market-one') } }, null, 2));
  write(path.join(pluginRoot, 'skills', 'plug-skill', 'SKILL.md'), '---\nname: plug-skill\ndescription: Comes with the alpha plugin.\n---\n');
  write(path.join(pluginRoot, 'agents', 'plug-agent.md'), '---\nname: plug-agent\ndescription: Comes with the alpha plugin.\n---\nPrompt.\n');
  write(path.join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/start.sh"' }] }] } }, null, 2));
  write(path.join(pluginRoot, 'hooks', 'start.sh'), '#!/bin/sh\necho plugin-start\n');
  write(path.join(pluginRoot, '.mcp.json'), JSON.stringify({ mcpServers: { plugsrv: { command: 'node', args: ['srv.js'] } } }));
  write(path.join(claude, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN_GH, account: MAIL } }));
  write(path.join(claude, 'projects', encodeProjectPath(proj), 'memory', 'MEMORY.md'), '- [note](note.md) remembered for this project\n');
  write(path.join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: MAIL },
    mcpServers: { github: { type: 'http', url: 'https://mcp.example.invalid/gh' }, localtool: { command: 'node', args: ['server.js'], env: { API_KEY: TOKEN_GH } } },
    projects: { [proj]: { mcpServers: { localonly: { command: 'node' } } }, [path.join(home, 'dev', 'elsewhere')]: { mcpServers: { notmine: { command: 'node' } } } },
  }));
  // Codex account.
  const codex = path.join(home, '.codex');
  write(path.join(codex, 'AGENTS.md'), '# Codex rules\n');
  write(path.join(codex, 'config.toml'), [
    'model = "x"', 'approval_policy = "on-request"', 'sandbox_mode = "workspace-write"', '',
    '[mcp_servers.remote_one]', 'url = "https://mcp.example.invalid/y"', `bearer_token = "${TOKEN_BEARER}"`, '',
    '[mcp_servers.local_one]', 'command = "npx"', '',
    '[plugins."helper@market-two"]', 'enabled = true', '',
    '[plugins."idle@market-two"]', 'enabled = false', '',
  ].join('\n'));
  write(path.join(codex, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'shell', hooks: [{ type: 'command', command: 'echo checking' }] }] } }));
  write(path.join(codex, 'skills', 'cx-skill', 'SKILL.md'), '---\nname: cx-skill\ndescription: A Codex skill.\n---\n');
  write(path.join(codex, 'agents', 'worker.toml'), WORKER_TOML);
  write(path.join(codex, 'auth.json'), JSON.stringify({ tokens: { access_token: TOKEN_GH } }));
  return { claude, codex, pluginRoot, fileLink, dirLink };
}

before(async () => {
  const root = tmpDir('hd-snap-');
  tmpRoot = root; // remembered apart from `fx`, so the folder is removed even when this hook fails
  const home = path.join(root, 'home');
  const proj = buildProject(home);
  const user = buildUser(home, proj);
  const impact = path.join(root, 'impact.json');
  write(impact, JSON.stringify({
    windowDays: 30, sessions: 3, totalTokens: 1000,
    skillInvocations: { 'proj-skill': 4, 'alpha-skill': 2 }, mcpCalls: { supabase: 9, github: 1 },
    unusedContext: { skillsNeverInvoked: ['plug-skill'], mcpServersNeverCalled: ['remote-api'] },
  }));
  const clis = path.join(root, 'clis.json');
  write(clis, JSON.stringify({ tools: [
    { id: 'gh', kind: 'cli', bin: 'gh', installed: true, version: 'gh version 2.0.0', collision: false, signalsMatched: [{ type: 'remote', value: 'github.com' }] },
    { id: 'supabase', kind: 'cli', bin: 'supabase', installed: false, version: null, collision: false, signalsMatched: [] },
    { id: 'superpowers', kind: 'plugin', bin: null, installed: null, version: null },
  ] }));

  // Schema: the v2 file, or state.schema.json once v2 has replaced it.
  let schema = null;
  for (const n of ['state.schema.v2.json', 'state.schema.json']) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'templates', n), 'utf8'));
      if (s.properties && s.properties.schemaVersion && s.properties.schemaVersion.const === 2 && s.$defs && s.$defs.elements) { schema = s; break; }
    } catch { /* try the next name */ }
  }
  let validate = localValidate;
  try {
    const mod = await import('../scripts/render-board.mjs');
    if (typeof mod.validate === 'function') validate = mod.validate;
  } catch { /* the renderer is being rewritten: use the local check */ }

  fx = { root, home, proj, ...user, impact, clis, schema, validate, env: homeEnv(home, { GIT_CEILING_DIRECTORIES: root }) };
  fx.p = runScript('snapshot-harness.mjs', ['--kind', 'project', '--cwd', proj, '--id', 'proj-snap', '--impact', impact, '--clis', clis], { env: fx.env });
  fx.u = runScript('snapshot-harness.mjs', ['--kind', 'user', '--config-dir', user.claude, '--provider', 'claude-code', '--id', 'user-main', '--impact', impact], { env: fx.env });
});

after(() => { if (tmpRoot) rmrf(tmpRoot); });

/** The JSON Schema subset the state schema uses, for when the renderer's validator cannot be loaded. */
function localValidate(value, schema, root = schema, at = '', errors = []) {
  if (schema.$ref) {
    const target = root.$defs[schema.$ref.replace('#/$defs/', '')];
    if (!target) { errors.push(`${at}: unresolvable $ref`); return errors; }
    return localValidate(value, target, root, at, errors);
  }
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
  const t = typeOf(value);
  if ('const' in schema && value !== schema.const) errors.push(`${at}: const`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: enum`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((x) => x === t || (x === 'number' && t === 'integer'))) { errors.push(`${at}: type ${t}`); return errors; }
  }
  if (t === 'object') {
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${at}: missing ${k}`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && schema.properties[k]) localValidate(v, schema.properties[k], root, `${at}/${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}: unknown ${k}`);
    }
  } else if (t === 'array') {
    if (schema.items) value.forEach((v, i) => localValidate(v, schema.items, root, `${at}/${i}`, errors));
  } else if (t === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: pattern`);
  } else if ((t === 'integer' || t === 'number') && schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: minimum`);
  return errors;
}

function schemaErrors(out) {
  const s = fx.schema;
  return [
    ...fx.validate(out.harness, s.properties.harnesses.items, s, '/harness'),
    ...out.files.flatMap((f, i) => fx.validate(f, s.properties.files.items, s, `/files/${i}`)),
    ...fx.validate(out.elements, s.$defs.elements, s, '/elements'),
    ...out.layers.flatMap((l, i) => fx.validate(l, s.properties.layers.items, s, `/layers/${i}`)),
  ];
}

const slashes = (s) => s.replace(/\\/g, '/').toLowerCase();
const fileAt = (out, p) => out.files.find((f) => f.path === p);
const strings = (v, acc = []) => { if (typeof v === 'string') acc.push(v); else if (Array.isArray(v)) v.forEach((x) => strings(x, acc)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, acc)); return acc; };

function assertNoLeak(r, label) {
  for (const text of [r.stdout, r.stderr]) {
    for (const s of SECRETS) assert.ok(!text.includes(s), `${label}: a secret value was printed`);
    assert.ok(!text.includes(MAIL), `${label}: account e-mail printed`);
    for (const t of [text, text.replace(/\\\\/g, '\\')]) assert.ok(!slashes(t).includes(slashes(fx.root)), `${label}: an absolute path was printed`);
  }
  // What the scanner would flag must be gone from every string of the output.
  const hits = strings(r.json).flatMap((s) => scanText(s));
  assert.deepEqual(hits, [], `${label}: secret-shaped text left in the output`);
}

// ------------------------------------------------------------------------------------------
// Units
// ------------------------------------------------------------------------------------------

test('maskText hides every secret shape and keeps the line structure', () => {
  const src = [
    '# config',
    `GH_TOKEN=${TOKEN_GH}`,
    `"Authorization": "Bearer ${TOKEN_BEARER}"`,
    `url = "postgres://app:${URL_PASSWORD}@db.example.invalid/app"`,
    `"SERVICE_SECRET": "${ENV_VALUE}"`,
    `https://api.example.invalid/v1?api_key=${TOKEN_BEARER}&page=2`,
    'TOKEN=${{ secrets.DEPLOY_TOKEN }}',
    'password: "$DB_PASSWORD"',
    "tokens: 'about 5k tokens per session'",
    '"max_tokens": "4096000000", "apiKeyHelper": "~/bin/key-helper.sh"',
    KEY_BEGIN, ...KEY_BODY, KEY_END,
    'last line stays',
  ].join('\r\n');
  const out = maskText(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.ok(out.split('\n').slice(0, -1).every((l) => l.endsWith('\r')), 'line endings are kept');
  for (const s of SECRETS) assert.ok(!out.includes(s), 'a secret survived');
  assert.ok(out.includes('ghp_…40'), 'long tokens keep four characters and their length');
  assert.ok(out.includes(`postgres://app:…${URL_PASSWORD.length}@db.example.invalid/app`), 'a short password shows only its length');
  assert.ok(out.includes('TOKEN=${{ secrets.DEPLOY_TOKEN }}') && out.includes('password: "$DB_PASSWORD"'), 'references to a secret are not secrets');
  assert.ok(out.includes("tokens: 'about 5k tokens per session'") && out.includes('"max_tokens": "4096000000", "apiKeyHelper": "~/bin/key-helper.sh"'), 'settings that merely mention tokens or keys stay readable');
  assert.ok(out.includes('&page=2') && out.includes('# config') && out.endsWith('last line stays'));
  assert.ok(!out.includes('BEGIN RSA') && !out.includes('END RSA'));
  assert.deepEqual(scanText(out), []);
  assert.equal(maskText(out), out, 'masking twice changes nothing');
});

test('a mention of a key marker in prose does not swallow the text after it', () => {
  const out = maskText(['The file starts with', KEY_BEGIN, 'and that line is how you recognise one. Keep it out of git.', 'More prose.'].join('\n'));
  assert.ok(out.includes('and that line is how you recognise one.'));
  assert.ok(out.endsWith('More prose.'));
});

test('files that exist to hold credentials lose every value', () => {
  assert.ok(isSensitiveName('.env') && isSensitiveName('.env.local') && isSensitiveName('server.pem') && isSensitiveName('.credentials.json') && isSensitiveName('auth.json'));
  assert.ok(!isSensitiveName('settings.json') && !isSensitiveName('CLAUDE.md') && !isSensitiveName('environment.md'));
  const out = maskSensitiveText('# comment\nAPI_URL=https://api.example.invalid\nexport NAME=bob\n\nloose line\n');
  assert.equal(out, '# comment\nAPI_URL=…27\nexport NAME=…3\n\n…10\n');
});

test('cutToBytes cuts at a line end and never inside a character', () => {
  const text = `${'ação\n'.repeat(100)}`;
  const cut = cutToBytes(text, 250);
  assert.ok(Buffer.byteLength(cut) <= 250 && cut.endsWith('\n') && !cut.includes('\uFFFD'));
  assert.equal(cutToBytes('short', 100), 'short');
  assert.equal(langOf('x/pre-commit', '#!/usr/bin/env node\n'), 'javascript');
  assert.equal(langOf('x/pre-commit', '#!/bin/sh\n'), 'shell');
  assert.equal(langOf('a.toml'), 'toml');
  assert.equal(langOf('LICENSE'), 'text');
});

test('parseWorkflow reads triggers, cron lines and job ids', () => {
  const wf = parseWorkflow(['name: "Deploy"', '"on":', '  push:', '    branches: [main, release]', '  workflow_dispatch:', '  schedule:', '    - cron: "15 4 * * *" # nightly', 'jobs:', '  build:', '    steps: []', '  ship:', '    needs: build'].join('\n'));
  assert.equal(wf.name, 'Deploy');
  assert.deepEqual(wf.triggers.map((t) => t.event), ['push', 'workflow_dispatch', '15 4 * * *']);
  assert.equal(wf.triggers[0].filter, 'branches: main, release');
  assert.deepEqual(wf.jobs, ['build', 'ship']);
  assert.deepEqual(parseWorkflow('on: [push, pull_request]\njobs:\n  a:\n    x: 1\n').triggers.map((t) => t.event), ['push', 'pull_request']);
  assert.deepEqual(parseWorkflow('on: push\n').triggers.map((t) => t.event), ['push']);
});

test('hookList keeps the args of an exec-form hook', () => {
  const list = hookList({ SessionStart: [{ hooks: [{ type: 'command', command: 'pwsh', args: ['-File', 'C:/x y/start.ps1'], async: true }] }], Stop: [{ type: 'prompt', prompt: 'check' }] });
  assert.deepEqual(list, [
    { event: 'SessionStart', matcher: '', type: 'command', command: 'pwsh -File "C:/x y/start.ps1"', async: true },
    { event: 'Stop', matcher: '', type: 'prompt', command: '', async: false },
  ]);
});

// "Async hooks can't block or control Claude's behavior"; `onFailure: "block"` makes a failure do
// what exit code 2 does on that event (https://code.claude.com/docs/en/hooks, "Run hooks in the
// background" and "Block the action when a hook fails").
test('hookList carries async, asyncRewake and onFailure, and hookBlocking honours them', () => {
  const list = hookList({
    PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: 'sh plain.sh' },
      { type: 'command', command: 'sh bg.sh', async: true },
      { type: 'command', command: 'sh rewake.sh', asyncRewake: true },
      { type: 'command', command: 'sh strict.sh', onFailure: 'block' },
      { type: 'command', command: 'sh lenient.sh', onFailure: 'continue' },
      { type: 'http', url: 'https://hooks.example.invalid/check', onFailure: 'block' },
      { type: 'command', command: 'sh odd.sh', async: 'yes', asyncRewake: 1, onFailure: true },
    ] }],
  });
  const fields = ({ async, asyncRewake, onFailure }) => ({ async, asyncRewake, onFailure });
  assert.deepEqual(list.map(fields), [
    { async: false, asyncRewake: undefined, onFailure: undefined },
    { async: true, asyncRewake: undefined, onFailure: undefined },
    { async: false, asyncRewake: true, onFailure: undefined },
    { async: false, asyncRewake: undefined, onFailure: 'block' },
    { async: false, asyncRewake: undefined, onFailure: 'continue' },
    { async: false, asyncRewake: undefined, onFailure: 'block' },
    { async: false, asyncRewake: undefined, onFailure: undefined },
  ]);
  // A hook that sets neither keeps the shape it had: the two keys are absent, not undefined.
  assert.deepEqual(Object.keys(list[0]), ['event', 'matcher', 'type', 'command', 'async']);
  assert.deepEqual(Object.keys(list[6]), ['event', 'matcher', 'type', 'command', 'async'], 'only true and a string are carried');

  const blocking = (entry, scriptText) => hookBlocking({ source: 'agent', scriptText, outside: false, ...entry });
  const [plain, bg, rewake, strict, lenient, http] = list;
  assert.equal(blocking(plain, 'exit 2'), true);
  assert.equal(blocking(plain, 'exit 1'), false);
  assert.equal(blocking(bg, 'exit 2'), false, 'async');
  assert.equal(blocking(rewake, 'exit 2'), false, 'asyncRewake');
  assert.equal(blocking(strict, 'exit 1'), true, 'a failure blocks');
  assert.equal(blocking(lenient, 'exit 1'), false);
  assert.equal(blocking(http, null), true, 'no script to read, and none is needed');
  assert.equal(blocking({ ...strict, event: 'Stop' }, 'exit 1'), false, 'no effect where a block means keep working');
  assert.equal(blocking({ ...strict, async: true }, 'exit 1'), false, 'no effect on a background hook');
});

test('hookBlocking answers only when the text settles it', () => {
  const h = (o) => hookBlocking({ source: 'agent', type: 'command', scriptText: null, outside: false, ...o });
  assert.equal(h({ event: 'PreToolUse', command: 'node guard.js', scriptText: 'process.exit(2)' }), true);
  assert.equal(h({ event: 'PreToolUse', command: 'sh check.sh', scriptText: 'echo fine\n' }), false);
  assert.equal(h({ event: 'PreToolUse', command: 'echo \'{"decision":"block"}\'' }), true);
  assert.equal(h({ event: 'PreToolUse', command: 'sh -c "exit 2" || true' }), false, 'the exit status is thrown away');
  assert.equal(h({ event: 'PreToolUse', command: 'my-guard --strict' }), null, 'an opaque program');
  assert.equal(h({ event: 'PreToolUse', command: 'node guard.js', outside: true }), null, 'a script that was not read');
  assert.equal(h({ event: 'PreToolUse', command: 'echo hi >> log.txt' }), false);
  assert.equal(h({ event: 'PreToolUse', command: 'node guard.js', scriptText: 'process.exit(2)', async: true }), false);
  assert.equal(h({ event: 'PostToolUse', command: 'sh x.sh', scriptText: 'exit 2' }), false, 'the tool already ran');
  assert.equal(h({ event: 'Stop', type: 'prompt', command: '' }), null);
  assert.equal(h({ event: 'SomethingNew', command: 'echo x' }), null);
  assert.equal(hookBlocking({ source: 'git', event: 'pre-commit' }), true);
  assert.equal(hookBlocking({ source: 'git', event: 'post-merge' }), false);
  assert.equal(hookBlocking({ source: 'ci', event: 'push' }), null);
});

// Each row follows the Claude Code hooks reference (https://code.claude.com/docs/en/hooks):
// "Exit code 2 behavior per event", "Decision control" and "Block the action when a hook fails".
test('hookBlocking follows the documented events and ways to block', () => {
  const h = (o) => hookBlocking({ source: 'agent', type: 'command', command: 'sh hook.sh', scriptText: '', outside: false, ...o });
  const prints = (json) => `echo '${json}'`;

  // PreToolUse: exit status 2, permissionDecision deny or ask, and the deprecated decision block.
  assert.equal(h({ event: 'PreToolUse', scriptText: 'jq -n \'{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny"}}\'' }), true);
  assert.equal(h({ event: 'PreToolUse', scriptText: prints('{"hookSpecificOutput":{"permissionDecision":"ask"}}') }), true);
  assert.equal(h({ event: 'PreToolUse', scriptText: 'echo "{\\"hookSpecificOutput\\": {\\"permissionDecision\\": \\"deny\\"}}"' }), true, 'quotes escaped inside a shell string');
  assert.equal(h({ event: 'PreToolUse', scriptText: prints('{"hookSpecificOutput":{"permissionDecision":"allow"}}') }), false);
  assert.equal(h({ event: 'PreToolUse', scriptText: prints('{"continue": false}') }), false, 'continue: false does not block the tool call');
  // Printing allow does not bring back an exit status the command throws away.
  assert.equal(h({ event: 'PreToolUse', command: 'sh hook.sh || true', scriptText: `${prints('{"permissionDecision":"allow"}')}\nexit 2` }), false);
  // ... but a printed deny still applies when the hook exits 0.
  assert.equal(h({ event: 'PreToolUse', command: 'sh hook.sh || true', scriptText: prints('{"permissionDecision":"deny"}') }), true);

  // PermissionRequest: exit status 2 is not read as a decision; decision.behavior deny is.
  assert.equal(h({ event: 'PermissionRequest', scriptText: 'exit 2' }), false);
  assert.equal(h({ event: 'PermissionRequest', scriptText: prints('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}') }), true);
  assert.equal(h({ event: 'PermissionRequest', scriptText: prints('{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}') }), false);

  // Stop and the like: exit 2 or decision block keeps Claude working; continue: false ends the turn.
  for (const event of ['Stop', 'SubagentStop', 'TeammateIdle', 'TaskCreated', 'TaskCompleted']) {
    assert.equal(h({ event, scriptText: 'exit 2' }), true, event);
    assert.equal(h({ event, scriptText: prints('{"decision":"block","reason":"tests fail"}') }), true, event);
    assert.equal(h({ event, scriptText: prints('{"continue": false}') }), false, event);
  }
  // The other events exit status 2 can block.
  for (const event of ['UserPromptSubmit', 'UserPromptExpansion', 'ConfigChange', 'PreCompact', 'PostToolBatch', 'PreModelSwitch', 'Elicitation', 'ElicitationResult']) {
    assert.equal(h({ event, scriptText: 'exit 2' }), true, event);
    assert.equal(h({ event, scriptText: prints('{"decision":"block"}') }), true, event);
    assert.equal(h({ event, scriptText: 'echo ok' }), false, event);
  }
  assert.equal(h({ event: 'UserPromptSubmit', scriptText: prints('{"continue": false, "stopReason": "x"}') }), true, 'Claude stops processing the prompt');
  assert.equal(h({ event: 'PostToolBatch', scriptText: prints('{"continue": false}') }), true, 'stops the loop before the next model call');
  assert.equal(h({ event: 'PreModelSwitch', scriptText: prints('{"hookSpecificOutput":{"permissionDecision":"deny"}}') }), true);
  assert.equal(h({ event: 'Elicitation', scriptText: prints('{"hookSpecificOutput":{"action":"decline"}}') }), true);
  // Worktree hooks: any non-zero exit fails the operation; without an explicit exit nothing is settled.
  assert.equal(h({ event: 'WorktreeCreate', scriptText: 'git worktree add "$1" || exit 1' }), true);
  assert.equal(h({ event: 'WorktreeRemove', scriptText: 'rm -rf "$1"' }), null);

  // Events that cannot block, whatever the hook does.
  for (const event of ['PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'StopFailure', 'Notification', 'SubagentStart', 'SessionStart', 'Setup', 'SessionEnd', 'CwdChanged', 'DirectoryAdded', 'FileChanged', 'PostCompact', 'PostModelSwitch', 'InstructionsLoaded', 'MessageDisplay']) {
    assert.equal(h({ event, scriptText: `exit 2\n${prints('{"decision":"block"}')}` }), false, event);
  }

  // A background hook cannot block: async, or asyncRewake.
  assert.equal(h({ event: 'PreToolUse', scriptText: 'exit 2', asyncRewake: true }), false);
  // onFailure "block": a failure blocks (denies, on PermissionRequest), for command, http and mcp_tool hooks.
  assert.equal(h({ event: 'PreToolUse', scriptText: 'exit 1', onFailure: 'block' }), true);
  assert.equal(h({ event: 'PreToolUse', scriptText: 'exit 1' }), false, 'exit 1 alone is a non-blocking error');
  assert.equal(h({ event: 'PermissionRequest', scriptText: 'exit 1', onFailure: 'block' }), true);
  assert.equal(h({ event: 'UserPromptSubmit', type: 'http', command: '', onFailure: 'block' }), true);
  assert.equal(h({ event: 'UserPromptSubmit', type: 'http', command: '' }), null, 'the decision is in the response, not in a file');
  assert.equal(h({ event: 'PreToolUse', type: 'prompt', command: '', onFailure: 'block' }), null, 'the field does not exist on prompt hooks');
  // ... and it has no effect where a block means "keep working", nor on a background hook.
  for (const event of ['Stop', 'SubagentStop', 'TaskCompleted', 'TeammateIdle']) assert.equal(h({ event, scriptText: 'exit 1', onFailure: 'block' }), false, event);
  assert.equal(h({ event: 'PreToolUse', scriptText: 'exit 1', onFailure: 'block', async: true }), false);
});

test('projectGitInfo reads default branch, distance to the remote and worktrees', () => {
  const base = path.join(fx.root, 'gitinfo');
  const seed = path.join(base, 'seed');
  const work = path.join(base, 'work');
  const commit = (dir, name) => { write(path.join(dir, name), `${name}\n`); git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', name]); };
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'stable']); // a name the fallback list does not guess
  commit(seed, 'one');
  git(base, ['clone', '-q', seed, 'work']);
  commit(seed, 'two');
  commit(seed, 'three');
  git(work, ['fetch', '-q']);
  git(work, ['worktree', 'add', '-q', '-b', 'side', path.join(base, 'work-side')]);
  const want = { defaultBranch: 'stable', behindRemote: 2, worktrees: 1 };
  assert.deepEqual(projectGitInfo(work), want);
  assert.deepEqual(projectGitInfo(path.join(base, 'work-side')), want, 'a linked worktree answers for its repository');
  git(work, ['pack-refs', '--all']);
  assert.deepEqual(projectGitInfo(work), want, 'refs packed into one file read the same');
  assert.deepEqual(projectGitInfo(seed), { worktrees: 0 }, 'no remote and no conventional branch name: the default branch is left unsaid');
  const plain = path.join(base, 'not-a-repo');
  fs.mkdirSync(plain);
  const saved = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = fx.root;
  try { assert.deepEqual(projectGitInfo(plain), {}); } finally {
    if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = saved;
  }
});

// ------------------------------------------------------------------------------------------
// Project harness
// ------------------------------------------------------------------------------------------

test('project: output has the four parts and validates against the state schema', () => {
  const r = fx.p;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(r.json), ['harness', 'files', 'elements', 'layers']);
  assert.ok(fx.schema, 'schema v2 found');
  assert.deepEqual(schemaErrors(r.json), []);
  assert.deepEqual(r.json.harness, { id: 'proj-snap', kind: 'project', name: 'proj-snap', path: '~/dev/proj-snap', project: { isCode: true, defaultBranch: 'main', worktrees: 0 } });
  for (const k of ['scores', 'impact', 'account']) assert.ok(!(k in r.json.harness));
});

test('project: no secret, e-mail or absolute path leaves the machine', () => {
  assertNoLeak(fx.p, 'project');
});

test('project: masking keeps every line where it was', () => {
  const mcp = fileAt(fx.p.json, './.mcp.json');
  const disk = fs.readFileSync(path.join(fx.proj, '.mcp.json'), 'utf8');
  assert.equal(mcp.content.split('\n').length, disk.split('\n').length);
  const line = disk.split('\n').findIndex((l) => l.includes(TOKEN_SB));
  assert.ok(mcp.content.split('\n')[line].includes('"SUPABASE_ACCESS_TOKEN": "sbp_…44"'), 'the token line is the same line, masked');
  assert.ok(mcp.content.includes('"command": "npx"'), 'everything else is untouched');
  assert.equal(mcp.bytes, Buffer.byteLength(disk));
  assert.equal(mcp.tokens, Math.round(disk.length / 4));
  const script = fileAt(fx.p.json, './scripts/check.sh');
  assert.equal(script.content.split('\n').length, 8);
  assert.ok(script.content.includes('export GH_TOKEN=ghp_…40') && script.content.endsWith('npm test\n'));
  const env = fileAt(fx.p.json, './.env');
  assert.equal(env.content, `# local values\nAPI_URL=…27\nDB_PASSWORD=…${URL_PASSWORD.length}\n`);
});

test('project: every file has its role, language and load mode', () => {
  const got = Object.fromEntries(fx.p.json.files.map((f) => [f.path, `${f.category}/${f.loaded}/${f.lang}`]));
  const want = {
    './CLAUDE.md': 'instructions/always/markdown',
    './docs/guide.md': 'instructions/always/markdown',
    './docs/huge.md': 'instructions/always/markdown',
    './assets/blob.bin': 'instructions/always/text',
    './.env': 'instructions/always/text',
    './.claude/settings.json': 'settings/always/json',
    './.claude/settings.local.json': 'settings/always/json',
    './.claude/hooks/guard.mjs': 'script/never/javascript',
    './scripts/check.sh': 'script/on-demand/shell',
    './.git/hooks/pre-commit': 'gate/never/shell',
    './.github/workflows/ci.yml': 'gate/never/yaml',
    './.mcp.json': 'mcp/always/json',
    './.claude/agents/helper.md': 'agent/on-demand/markdown',
    './.claude/commands/deploy.md': 'command/on-demand/markdown',
    './.claude/rules/style.md': 'rule/always/markdown',
    './.claude/rules/api.md': 'rule/on-demand/markdown',
    './.claude/skills/proj-skill/SKILL.md': 'skill/on-demand/markdown',
    './docs/small.md': 'doc/on-demand/markdown',
    '~/.claude/projects/~-dev-proj-snap/memory/MEMORY.md': 'memory/always/markdown',
  };
  assert.deepEqual(got, want);
  assert.equal(fileAt(fx.p.json, './.git/hooks/pre-push.sample'), undefined);
});

test('project: caps, binary files and files without content', () => {
  const huge = fileAt(fx.p.json, './docs/huge.md');
  assert.equal(huge.truncated, true);
  assert.ok(huge.bytes > 290 * 1024);
  const size = Buffer.byteLength(huge.content);
  assert.ok(size <= 256 * 1024 && size > 240 * 1024 && huge.content.endsWith('\n'));
  assert.equal(huge.tokens, Math.round(fs.readFileSync(path.join(fx.proj, 'docs', 'huge.md'), 'utf8').length / 4), 'tokens describe the whole file');
  const blob = fileAt(fx.p.json, './assets/blob.bin');
  assert.equal(blob.omitted, 'binary');
  assert.equal(blob.content, '');
  assert.equal(blob.bytes, 8);
  for (const f of fx.p.json.files) if (!f.omitted) assert.ok(Buffer.byteLength(f.content) <= 256 * 1024);
});

test('project: a small budget keeps the important files and drops content from the rest', () => {
  // Instruction files and the memory index fit (the oversized import cut to the file cap);
  // settings.json is the first file that does not, so nothing after it carries content.
  const r = runScript('snapshot-harness.mjs', ['--kind', 'project', '--cwd', fx.proj, '--id', 'proj-snap', '--budget', '1800', '--file-cap', '1000'], { env: fx.env });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(schemaErrors(r.json), []);
  assert.ok(fileAt(r.json, './CLAUDE.md').content.startsWith('# Project rules'));
  assert.ok(fileAt(r.json, './docs/guide.md').content.length > 0);
  assert.ok(fileAt(r.json, '~/.claude/projects/~-dev-proj-snap/memory/MEMORY.md').content.length > 0);
  const huge = fileAt(r.json, './docs/huge.md');
  assert.ok(huge.truncated === true && Buffer.byteLength(huge.content) <= 1000 && huge.content.length > 800);
  for (const p of ['./.claude/settings.json', './.mcp.json', './.claude/skills/proj-skill/SKILL.md', './docs/small.md', './.claude/commands/deploy.md']) {
    const f = fileAt(r.json, p);
    assert.equal(f.omitted, 'budget', p);
    assert.equal(f.content, '');
    assert.ok(!('truncated' in f));
    assert.ok(f.bytes > 0 && f.tokens > 0 && f.id && f.category && f.lang, 'metadata is kept');
  }
  assert.ok(r.json.files.reduce((s, f) => s + Buffer.byteLength(f.content), 0) <= 1800);
  assert.deepEqual(r.json.files.map((f) => [f.id, f.path]), fx.p.json.files.map((f) => [f.id, f.path]), 'ids do not depend on the budget');
  assert.equal(r.json.elements.skills.find((s) => s.name === 'proj-skill').file, fileAt(r.json, './.claude/skills/proj-skill/SKILL.md').id);
});

test('project: ids are stable and two runs print the same bytes', () => {
  const again = runScript('snapshot-harness.mjs', ['--kind', 'project', '--cwd', fx.proj, '--id', 'proj-snap', '--impact', fx.impact, '--clis', fx.clis], { env: fx.env });
  assert.equal(again.stdout, fx.p.stdout);
  const ids = fx.p.json.files.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^f[0-9a-f]{6}-[0-9]+$/.test(id)));
  assert.equal(new Set(ids.map((id) => id.split('-')[0])).size, 1);
  const sorted = [...fx.p.json.files].sort((a, b) => (a.path < b.path ? -1 : 1));
  assert.deepEqual(sorted.map((f) => Number(f.id.split('-')[1])), ids.map((_, i) => i + 1), 'numbered in path order');
});

test('project: hooks point at their registration and at the script they run', () => {
  const { hooks } = fx.p.json.elements;
  const settings = fileAt(fx.p.json, './.claude/settings.json');
  const guard = fileAt(fx.p.json, './.claude/hooks/guard.mjs');
  const pre = hooks.filter((h) => h.source === 'agent' && h.event === 'PreToolUse');
  assert.equal(pre.length, 2);
  assert.deepEqual({ ...pre[0], id: 'x' }, { id: 'x', source: 'agent', event: 'PreToolUse', matcher: 'Bash', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.mjs"', file: settings.id, script: guard.id, blocking: true });
  assert.equal(pre[1].command, 'my-guard --strict');
  assert.equal(pre[1].blocking, null);
  assert.ok(!('script' in pre[1]));
  const post = hooks.find((h) => h.event === 'PostToolUse');
  assert.equal(post.blocking, false);
  assert.equal(post.matcher, 'Edit|Write');
  const stop = hooks.find((h) => h.event === 'Stop');
  assert.ok(stop.command.includes('Bearer tkZz…38') && stop.command.length <= 300);
  assert.equal(stop.blocking, null);
  const plugin = hooks.find((h) => h.source === 'plugin');
  assert.deepEqual({ event: plugin.event, plugin: plugin.plugin, blocking: plugin.blocking, hasFile: 'file' in plugin }, { event: 'SessionStart', plugin: 'alpha', blocking: false, hasFile: false });
  const gitHook = hooks.find((h) => h.source === 'git');
  assert.deepEqual({ ...gitHook, id: 'x' }, { id: 'x', source: 'git', event: 'pre-commit', file: fileAt(fx.p.json, './.git/hooks/pre-commit').id, blocking: true });
  const ci = hooks.filter((h) => h.source === 'ci');
  assert.deepEqual(ci.map((h) => [h.event, h.matcher || '', h.command, h.blocking, h.note]), [
    ['push', 'branches: main', 'jobs: lint, test', null, 'workflow CI'],
    ['pull_request', '', 'jobs: lint, test', null, 'workflow CI'],
    ['0 3 * * 1', '', 'jobs: lint, test', null, 'workflow CI'],
  ]);
  assert.ok(ci.every((h) => h.file === fileAt(fx.p.json, './.github/workflows/ci.yml').id));
  assert.equal(new Set(hooks.map((h) => h.id)).size, hooks.length);
});

test('project: permissions, MCP servers, skills, agents and plugins', () => {
  const el = fx.p.json.elements;
  const settings = fileAt(fx.p.json, './.claude/settings.json').id;
  const local = fileAt(fx.p.json, './.claude/settings.local.json').id;
  assert.deepEqual(el.permissions, [
    { layer: 'project', kind: 'allow', rule: 'Bash(npm test)', file: settings },
    { layer: 'project', kind: 'allow', rule: 'Read', file: settings },
    { layer: 'project', kind: 'deny', rule: 'Bash(rm -rf *)', file: settings },
    { layer: 'project', kind: 'ask', rule: 'Bash(git push)', file: settings },
    { layer: 'project', kind: 'mode', rule: 'acceptEdits', file: settings },
    { layer: 'local', kind: 'allow', rule: 'Bash(GH_TOKEN=ghp_…40 gh api *)', file: local },
  ]);
  const mcpFile = fileAt(fx.p.json, './.mcp.json').id;
  const mcp = Object.fromEntries(el.mcp.map((m) => [m.name, m]));
  assert.deepEqual(mcp.supabase, { name: 'supabase', level: 'project', transport: 'local', calls: 9, cli: 'supabase', file: mcpFile });
  assert.deepEqual(mcp['remote-api'], { name: 'remote-api', level: 'project', transport: 'remote', calls: 0, file: mcpFile });
  assert.deepEqual({ level: mcp.localonly.level, calls: mcp.localonly.calls, hasFile: 'file' in mcp.localonly }, { level: 'local', calls: null, hasFile: false });
  assert.equal(mcp.plugsrv.level, 'plugin');
  assert.ok(!('notmine' in mcp), 'servers recorded for another project stay out');

  const skill = el.skills.find((s) => s.name === 'proj-skill');
  assert.equal(skill.level, 'project');
  assert.equal(skill.invocations, 4);
  assert.equal(skill.description.length, 300);
  assert.ok(skill.description.endsWith('…'));
  assert.equal(skill.descriptionChars, 'Use when the project needs its own release steps. '.repeat(9).trim().length);
  assert.equal(skill.file, fileAt(fx.p.json, './.claude/skills/proj-skill/SKILL.md').id);
  const plug = el.skills.find((s) => s.name === 'plug-skill');
  assert.deepEqual(plug, { name: 'plug-skill', level: 'plugin', plugin: 'alpha', description: 'Comes with the alpha plugin.', descriptionChars: 28, invocations: 0 });

  assert.deepEqual(el.agents.find((a) => a.name === 'helper'), { name: 'helper', level: 'project', model: 'sonnet', tools: 'Read, Grep', promptChars: 'You are a helper.\n'.length + 1, file: fileAt(fx.p.json, './.claude/agents/helper.md').id });
  assert.equal(el.agents.find((a) => a.name === 'plug-agent').level, 'plugin');
  assert.deepEqual(el.plugins, [{ name: 'alpha', marketplace: 'market-one', enabled: true, pinned: false, note: 'version 1.0.0' }]);
  assert.deepEqual(el.clis, [
    { name: 'gh', installed: true, version: 'gh version 2.0.0', collision: false, signals: ['remote:github.com'], auth: 'unknown' },
    { name: 'supabase', installed: false, collision: false, auth: 'unknown' },
  ]);
});

test('project: docs are listed as metadata; only small referenced ones carry content', () => {
  const docs = Object.fromEntries(fx.p.json.elements.docs.map((d) => [d.path, d]));
  assert.deepEqual(Object.keys(docs).sort(), ['./README.md', './docs/big.md', './docs/guide.md', './docs/huge.md', './docs/other.md', './docs/small.md']);
  assert.equal(docs['./docs/guide.md'].status, 'always-loaded');
  assert.equal(docs['./docs/guide.md'].file, fileAt(fx.p.json, './docs/guide.md').id);
  assert.equal(docs['./docs/small.md'].status, 'unchecked');
  assert.equal(docs['./docs/small.md'].file, fileAt(fx.p.json, './docs/small.md').id);
  for (const p of ['./docs/big.md', './docs/other.md', './README.md']) assert.ok(!('file' in docs[p]), `${p} is metadata only`);
  assert.equal(fileAt(fx.p.json, './docs/big.md'), undefined, 'referenced but over 16 KB');
  assert.equal(fileAt(fx.p.json, './docs/other.md'), undefined, 'under 16 KB but nothing refers to it');
  for (const d of Object.values(docs)) {
    assert.ok(d.bytes > 0);
    assert.ok(!Number.isNaN(Date.parse(d.lastCommit)), 'last commit date comes from git');
  }
  assert.equal(docs['./docs/guide.md'].language, 'en');
});

test('project: layers list what enters every session, in load order', () => {
  const layers = fx.p.json.layers;
  assert.deepEqual(layers.map((l) => l.kind), ['instructions', 'instructions', 'memory', 'skills', 'other', 'mcp', 'plugins', 'hooks']);
  const [claude, rules, memory, skills, agents, mcp, plugins, starts] = layers;
  assert.deepEqual({ name: claude.name, path: claude.path, file: claude.file, basis: claude.basis }, { name: 'CLAUDE.md', path: './CLAUDE.md', file: fileAt(fx.p.json, './CLAUDE.md').id, basis: 'estimated' });
  assert.ok(claude.tokens > 70000, 'imports are counted in');
  assert.equal(claude.note, 'includes 4 imported files; 1 import that does not resolve');
  assert.ok(rules.name.startsWith('Rules (1 file') && rules.tokens > 0);
  assert.equal(memory.file, fileAt(fx.p.json, '~/.claude/projects/~-dev-proj-snap/memory/MEMORY.md').id);
  assert.ok(skills.name.includes('2 skills') && skills.tokens > 100 && skills.note === '1 from plugins');
  assert.ok(agents.name.includes('2 agents') && agents.tokens > 0);
  assert.ok(mcp.name.includes('(4)') && !('tokens' in mcp) && !('basis' in mcp), 'MCP cost is not guessed');
  assert.ok(plugins.name.includes('1 enabled') && !('tokens' in plugins));
  assert.ok(starts.name.includes('SessionStart hooks (1)'));
  assert.ok(layers.every((l) => l.harness === 'proj-snap'));
});

test('usage numbers follow the shape of the impact file that was given', () => {
  const run = (impact) => {
    const f = path.join(fx.root, `impact-${Math.random().toString(36).slice(2)}.json`);
    write(f, JSON.stringify(impact));
    const r = runScript('snapshot-harness.mjs', ['--kind', 'project', '--cwd', fx.proj, '--id', 'proj-snap', '--impact', f], { env: fx.env });
    assert.equal(r.code, 0, r.stderr);
    return { skill: (n) => r.json.elements.skills.find((s) => s.name === n).invocations, mcp: (n) => r.json.elements.mcp.find((m) => m.name === n).calls, el: r.json.elements };
  };
  // session-impact.mjs today: it says which names were never used, not how often the others were.
  const a = run({ windowDays: 30, sessions: 1, totalTokens: 1, unusedContext: { skillsNeverInvoked: ['plug-skill'], mcpServersNeverCalled: ['supabase'] } });
  assert.deepEqual([a.skill('proj-skill'), a.skill('plug-skill'), a.mcp('supabase'), a.mcp('remote-api')], [null, 0, 0, null]);
  // transcript-signals.mjs: full count maps, MCP calls by tool name.
  const b = run({ skillInvocations: { 'alpha:plug-skill': 3 }, toolCalls: { Bash: 10, mcp__supabase__query: 3, mcp__supabase__list: 2, 'mcp__remote-api__get': 1 } });
  assert.deepEqual([b.skill('proj-skill'), b.skill('plug-skill'), b.mcp('supabase'), b.mcp('remote-api'), b.mcp('localonly')], [0, 3, 5, 1, 0]);
  // No impact file: nothing is measured, and no CLI list is invented.
  const none = runScript('snapshot-harness.mjs', ['--kind', 'project', '--cwd', fx.proj, '--id', 'another-id'], { env: fx.env }).json;
  assert.ok(none.elements.skills.every((s) => s.invocations === null) && none.elements.mcp.every((m) => m.calls === null));
  assert.ok(!('clis' in none.elements));
  // Another harness id: same files, another id prefix.
  assert.deepEqual(none.files.map((f) => f.path), fx.p.json.files.map((f) => f.path));
  assert.notEqual(none.files[0].id.split('-')[0], fx.p.json.files[0].id.split('-')[0]);
  assert.ok(none.files.every((f) => f.harness === 'another-id') && none.layers.every((l) => l.harness === 'another-id'));
});

// ------------------------------------------------------------------------------------------
// User harness
// ------------------------------------------------------------------------------------------

test('user: output validates, leaks nothing and never touches credential stores', () => {
  const r = fx.u;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(schemaErrors(r.json), []);
  assertNoLeak(r, 'user');
  assert.deepEqual(r.json.harness, { id: 'user-main', kind: 'user', name: 'Claude Code (~/.claude)', path: '~/.claude', provider: 'claude-code' });
  const paths = r.json.files.map((f) => f.path);
  for (const p of paths) assert.ok(p.startsWith('~/'), `display path ${p}`);
  assert.ok(!paths.some((p) => /credentials|\.claude\.json|\/projects\//.test(p)), 'no credential, state or transcript file');
  assert.ok(!paths.some((p) => p.includes('plug-skill')), 'plugin skills are elements only');
});

test('user: files, roles and load modes', () => {
  const got = Object.fromEntries(fx.u.json.files.map((f) => [f.path, `${f.category}/${f.loaded}`]));
  const want = {
    '~/.claude/CLAUDE.md': 'instructions/always',
    '~/.claude/extra.md': 'instructions/always',
    '~/.claude/AGENTS.md': 'instructions/never',
    '~/.claude/settings.json': 'settings/always',
    '~/.claude/keybindings.json': 'settings/always',
    '~/.claude/hooks/guard.js': 'script/never',
    '~/.claude/hooks/start.ps1': 'script/never',
    '~/.claude/statusline.mjs': 'script/never',
    '~/.claude/scripts/tool.py': 'script/on-demand',
    '~/.claude/skills/alpha-skill/SKILL.md': 'skill/on-demand',
    '~/.claude/agents/reviewer.md': 'agent/on-demand',
    '~/.claude/commands/ship.md': 'command/on-demand',
    '~/.claude/rules/always.md': 'rule/always',
    '~/.claude/rules/scoped.md': 'rule/on-demand',
    '~/.claude/output-styles/terse.md': 'other/always',
    '~/.claude/plugins/installed_plugins.json': 'plugin/never',
    '~/.claude/plugins/known_marketplaces.json': 'plugin/never',
    '~/.claude/plugins/cache/market-one/alpha/1.0.0/hooks/hooks.json': 'hook/always',
    '~/.claude/plugins/cache/market-one/alpha/1.0.0/hooks/start.sh': 'script/never',
  };
  if (fx.fileLink) want['~/.claude/linked.md'] = 'instructions/always';
  if (fx.dirLink) want['~/.claude/skills/linked-skill/SKILL.md'] = 'skill/on-demand';
  assert.deepEqual(got, want);
  const registry = fileAt(fx.u.json, '~/.claude/plugins/installed_plugins.json');
  assert.ok(registry.content.includes('"installPath": "~'), 'home paths inside a file are shown as ~');
  assert.ok(fileAt(fx.u.json, '~/.claude/scripts/tool.py').content.includes('API_TOKEN = "sbp_…44"'));
});

test('user: a file that is a link says where it leads', (t) => {
  if (!fx.fileLink && !fx.dirLink) { t.skip('this OS refused both kinds of link'); return; }
  if (fx.fileLink) {
    const f = fileAt(fx.u.json, '~/.claude/linked.md');
    assert.equal(f.linkTo, '~/shared/base.md');
    assert.ok(f.content.includes('Shared base rules'), 'the content is still listed');
  }
  if (fx.dirLink) assert.equal(fileAt(fx.u.json, '~/.claude/skills/linked-skill/SKILL.md').linkTo, '~/shared/skills/linked-skill/SKILL.md');
  assert.ok(!('linkTo' in fileAt(fx.u.json, '~/.claude/extra.md')));
});

test('user: hooks, plugins, skills, MCP servers and permissions', () => {
  const el = fx.u.json.elements;
  const id = (p) => fileAt(fx.u.json, p).id;
  const settings = id('~/.claude/settings.json');
  const by = (pred) => el.hooks.find(pred);
  const pre = by((h) => h.event === 'PreToolUse');
  assert.equal(pre.script, id('~/.claude/hooks/guard.js'));
  assert.equal(pre.blocking, true);
  assert.ok(slashes(pre.command).startsWith('node "~/.claude/hooks/guard.js'), 'the home path in a command is shown as ~');
  const start = by((h) => h.event === 'SessionStart' && h.source === 'agent');
  assert.ok(slashes(start.command).startsWith('pwsh -noprofile -file ~/.claude/hooks/start.ps1'), 'args of the exec form are part of the command');
  assert.equal(start.script, id('~/.claude/hooks/start.ps1'));
  assert.equal(start.blocking, false);
  const status = by((h) => h.event === 'StatusLine');
  assert.deepEqual([status.file, status.script, status.blocking], [settings, id('~/.claude/statusline.mjs'), false]);
  const plug = by((h) => h.source === 'plugin');
  assert.deepEqual({ ...plug, id: 'x' }, {
    id: 'x', source: 'plugin', event: 'SessionStart', matcher: 'startup', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/start.sh"',
    file: id('~/.claude/plugins/cache/market-one/alpha/1.0.0/hooks/hooks.json'), script: id('~/.claude/plugins/cache/market-one/alpha/1.0.0/hooks/start.sh'), plugin: 'alpha', blocking: false,
  });

  assert.deepEqual(el.plugins, [
    { name: 'alpha', marketplace: 'market-one', enabled: true, pinned: false, note: 'version 1.0.0' },
    { name: 'beta', marketplace: 'market-one', enabled: false, pinned: false, note: 'version 0.1.0' },
  ]);
  const alpha = el.skills.find((s) => s.name === 'alpha-skill');
  assert.deepEqual([alpha.level, alpha.invocations, alpha.description.length, alpha.descriptionChars > 300, alpha.file], ['user', 2, 300, true, id('~/.claude/skills/alpha-skill/SKILL.md')]);
  assert.deepEqual(el.skills.find((s) => s.name === 'plug-skill'), { name: 'plug-skill', level: 'plugin', plugin: 'alpha', description: 'Comes with the alpha plugin.', descriptionChars: 28, invocations: 0 });
  assert.deepEqual(el.agents.find((a) => a.name === 'reviewer'), { name: 'reviewer', level: 'user', model: 'opus', tools: 'Read, Grep, Glob', promptChars: 'Review carefully.\n'.length + 1, file: id('~/.claude/agents/reviewer.md') });

  const mcp = Object.fromEntries(el.mcp.map((m) => [m.name, m]));
  assert.deepEqual(Object.keys(mcp).sort(), ['github', 'localtool', 'plugsrv']);
  assert.deepEqual(mcp.github, { name: 'github', level: 'user', transport: 'remote', calls: 1, cli: 'gh', note: 'kept in ~/.claude.json, which is not part of the snapshot' });
  assert.equal(mcp.localtool.transport, 'local');
  assert.deepEqual([mcp.plugsrv.level, mcp.plugsrv.note], ['plugin', 'from plugin alpha']);

  assert.deepEqual(el.permissions, [
    { layer: 'user', kind: 'allow', rule: 'Bash(git status)', file: settings },
    { layer: 'user', kind: 'allow', rule: 'Read', file: settings },
    { layer: 'user', kind: 'deny', rule: 'Bash(git push --force *)', file: settings },
    { layer: 'user', kind: 'mode', rule: 'default', file: settings },
  ]);
  assert.deepEqual(el.docs, []);
});

test('user: layers', () => {
  const kinds = fx.u.json.layers.map((l) => l.kind);
  assert.deepEqual(kinds, ['instructions', 'instructions', 'other', 'skills', 'other', 'mcp', 'plugins', 'hooks']);
  const [claude, rules, style, skills] = fx.u.json.layers;
  assert.equal(claude.path, '~/.claude/CLAUDE.md');
  assert.equal(claude.note, fx.fileLink ? 'includes 2 imported files; 1 import that does not resolve' : 'includes 1 imported file; 2 imports that do not resolve');
  assert.ok(rules.name.startsWith('Rules (1 file'));
  assert.deepEqual([style.name, style.file], ['Output style Terse', fileAt(fx.u.json, '~/.claude/output-styles/terse.md').id]);
  assert.ok(skills.name.includes(`${fx.dirLink ? 3 : 2} skills`));
  assert.ok(!fx.u.json.layers.some((l) => l.path === '~/.claude/AGENTS.md'), 'a file this agent never loads is not a layer');
});

test('user: a Codex account', () => {
  const r = runScript('snapshot-harness.mjs', ['--kind', 'user', '--config-dir', fx.codex, '--provider', 'codex', '--id', 'user-codex', '--name', 'Codex · account 1'], { env: fx.env });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(schemaErrors(r.json), []);
  assertNoLeak(r, 'codex');
  assert.deepEqual(r.json.harness, { id: 'user-codex', kind: 'user', name: 'Codex · account 1', path: '~/.codex', provider: 'codex' });
  assert.deepEqual(Object.fromEntries(r.json.files.map((f) => [f.path, `${f.category}/${f.loaded}/${f.lang}`])), {
    '~/.codex/AGENTS.md': 'instructions/always/markdown',
    '~/.codex/config.toml': 'settings/always/toml',
    '~/.codex/hooks.json': 'hook/always/json',
    '~/.codex/skills/cx-skill/SKILL.md': 'skill/on-demand/markdown',
    '~/.codex/agents/worker.toml': 'agent/on-demand/toml',
  });
  const cfg = fileAt(r.json, '~/.codex/config.toml');
  assert.ok(cfg.content.includes('bearer_token = "tkZz…38"'));
  assert.deepEqual(r.json.elements.permissions, [
    { layer: 'user', kind: 'mode', rule: 'approval_policy = on-request', file: cfg.id },
    { layer: 'user', kind: 'mode', rule: 'sandbox_mode = workspace-write', file: cfg.id },
  ]);
  assert.deepEqual(r.json.elements.mcp.map((m) => [m.name, m.level, m.transport, m.file]), [['local_one', 'user', 'local', cfg.id], ['remote_one', 'user', 'remote', cfg.id]]);
  assert.deepEqual(r.json.elements.hooks.map((h) => [h.source, h.event, h.matcher, h.command, h.blocking, h.file]), [['agent', 'PreToolUse', 'shell', 'echo checking', false, fileAt(r.json, '~/.codex/hooks.json').id]]);
  assert.deepEqual(r.json.elements.agents, [{ name: 'worker', level: 'user', model: 'y', promptChars: WORKER_TOML.length, file: fileAt(r.json, '~/.codex/agents/worker.toml').id }]);
  assert.deepEqual(r.json.elements.plugins, [
    { name: 'helper', marketplace: 'market-two', enabled: true, pinned: null },
    { name: 'idle', marketplace: 'market-two', enabled: false, pinned: null },
  ]);
  assert.deepEqual(r.json.layers.map((l) => l.name), ['AGENTS.md', 'Skill descriptions (1 skill)', 'Agent definitions (1 agent)', 'MCP servers (2)', 'Plugins (1 enabled)']);
});

test('bad arguments exit 2 and print no JSON', () => {
  const run = (args) => runScript('snapshot-harness.mjs', args, { env: fx.env });
  const cases = [
    [],
    ['--kind', 'other', '--id', 'x'],
    ['--kind', 'project', '--id', 'x'],
    ['--kind', 'project', '--cwd', path.join(fx.root, 'nope'), '--id', 'x'],
    ['--kind', 'project', '--cwd', fx.proj, '--id', 'Not An Id'],
    ['--kind', 'project', '--cwd', fx.proj],
    ['--kind', 'user', '--config-dir', fx.claude, '--id', 'x'],
    ['--kind', 'user', '--config-dir', fx.claude, '--provider', 'nobody', '--id', 'x'],
    ['--kind', 'project', '--cwd', fx.proj, '--id', 'x', '--impact', path.join(fx.root, 'missing.json')],
    ['--kind', 'project', '--cwd', fx.proj, '--id', 'x', '--budget', '0'],
  ];
  for (const args of cases) {
    const r = run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.stdout, '');
    assert.ok(!slashes(r.stderr).includes(slashes(fx.root)));
  }
});
