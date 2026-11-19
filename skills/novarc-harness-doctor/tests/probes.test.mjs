import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runScript, homeEnv, rmrf, write } from './helpers.mjs';
import { buildFakeHome, buildFakeProject, buildFakeTranscripts, FAKE_TOKEN, MARKER } from './fake-harness.mjs';
import { scanText, mask } from '../scripts/secret-scan.mjs';
import { encodeProjectPath } from '../scripts/lib/locations.mjs';
import { commandHead, codexCommandString, matchesProjectDir } from '../scripts/transcript-signals.mjs';
import { parseImports, detectLanguage } from '../scripts/discover.mjs';

let fx;
let env;

before(() => {
  fx = buildFakeHome();
  fx.project = buildFakeProject(fx.root);
  buildFakeTranscripts(fx.home, fx.project);
  env = homeEnv(fx.home, { CLAUDE_CONFIG_DIR: fx.second });
});

after(() => rmrf(fx.root));

const norm = (p) => p.replace(/\\/g, '/');

// ------------------------------------------------------------------------------------------
// Unit checks
// ------------------------------------------------------------------------------------------

// Personal-looking paths and key headers are assembled at runtime so the repo leak scan stays clean.
const MAC = "/" + "Users";
const LNX = "/" + "home";
const WINU = "C:\\" + "Users";
const KEY_HEADER = "-----BEGIN RSA " + "PRIVATE KEY-----";

test('encodeProjectPath matches Claude Code directory names on Windows and macOS/Linux', () => {
  // Pure string transform: both encodings are checked on every host OS.
  assert.equal(encodeProjectPath('C:\\dev\\Projects\\x'), 'C--dev-Projects-x');
  assert.equal(encodeProjectPath('C:\\dev\\x'), 'C--dev-x');
  assert.equal(encodeProjectPath(`${MAC}/x/proj`), '-Users-x-proj');
  assert.equal(encodeProjectPath('/private/var/folders/ab/proj'), '-private-var-folders-ab-proj');
  assert.equal(encodeProjectPath(`${LNX}/u/my.app`), '-home-u-my-app');
  assert.equal(encodeProjectPath(`${WINU}\\u\\Área de Trabalho\\p`), 'C--Users-u--rea-de-Trabalho-p');
});

test('project dir matching for a POSIX path (runs on every OS)', () => {
  const root = `${MAC}/x/proj`;
  const enc = encodeProjectPath(root);
  assert.ok(matchesProjectDir('-Users-x-proj', root));
  assert.ok(matchesProjectDir(`${enc}--claude-worktrees-feat-1`, root));
  assert.ok(matchesProjectDir('-Users-x--hostapp-worktrees-proj-feat-2', root));
  assert.ok(!matchesProjectDir(`${enc}-sibling`, root));
});

test('project dir matching for a Windows path', { skip: process.platform !== 'win32' && 'drive-letter paths only resolve as absolute on Windows' }, () => {
  const root = 'C:\\dev\\proj';
  const enc = encodeProjectPath(root);
  assert.ok(matchesProjectDir(enc, root));
  assert.ok(matchesProjectDir(`${enc}--claude-worktrees-feat-1`, root));
  assert.ok(matchesProjectDir('C--Users-u--hostapp-worktrees-proj-feat-2', root));
  assert.ok(!matchesProjectDir(`${enc}-sibling`, root));
  assert.ok(!matchesProjectDir(`${enc}x`, root));
});

test('commandHead keeps at most two plain tokens and never arguments', () => {
  assert.equal(commandHead('npm test -- --grep SECRETARG'), 'npm test');
  assert.equal(commandHead('cd /some/path && git push origin main --force'), 'git push');
  assert.equal(commandHead('GH_TOKEN=abc sudo supabase db push'), 'supabase db');
  assert.equal(commandHead('C:\\tools\\node.exe script.js'), 'node');
  assert.equal(commandHead('echo hello world'), 'echo');
  assert.equal(commandHead('python manage.py migrate'), 'python');
  assert.equal(commandHead('git commit -m "msg"'), 'git commit');
  assert.equal(commandHead('docker UPPERCASEARG'), 'docker');
  // Only known subcommand CLIs keep a second token; for anything else it may be data.
  assert.equal(commandHead('psql proddb'), 'psql');
  assert.equal(commandHead('ssh buildhost'), 'ssh');
  assert.equal(commandHead('make deploy'), 'make deploy');
  assert.equal(codexCommandString(['bash', '-lc', 'cargo build']), 'cargo build');
  assert.equal(codexCommandString(['powershell.exe', '-NoProfile', '-Command', 'Get-Item x']), 'Get-Item x');
});

test('parseImports ignores code, mentions, package scopes and emails', () => {
  const t = '@a.md\nsee @./b/c.md and @~/d.md.\n`@types/node` @someone x@y.example\n```\n@e.md\n```\n';
  assert.deepEqual(parseImports(t), ['a.md', './b/c.md', '~/d.md']);
});

test('detectLanguage separates en, pt and short texts', () => {
  assert.equal(detectLanguage('This guide is for the agent. It explains how the project is built and what you should do when a test fails, and it is in the folder with the scripts that can be run.'), 'en');
  assert.equal(detectLanguage('Este guia é para o agente. Ele explica como o projeto é construído e o que você deve fazer quando um teste falha. Os scripts estão na pasta e não são lentos, mas a suíte é.'), 'pt');
  assert.equal(detectLanguage('Short.'), 'unknown');
});

test('scanText masks values and drops overlapping matches', () => {
  const f = scanText(`token: ${FAKE_TOKEN}\nkey=sk-ant-${'a'.repeat(30)}\napi_key = "abcd1234efgh5678ijkl"\n${KEY_HEADER}`);
  assert.deepEqual(f.map((x) => x.pattern), ['github-token', 'anthropic-key', 'generic-assignment', 'private-key']);
  assert.equal(f[0].masked, 'ghp_…40');
  assert.equal(f[1].masked, `sk-a…${'sk-ant-'.length + 30}`);
  assert.equal(f[2].masked, 'abcd…20');
  assert.equal(mask('abcdef'), 'abcd…6');
  assert.ok(!JSON.stringify(f).includes('x'.repeat(36)));
});

// ------------------------------------------------------------------------------------------
// secret-scan.mjs
// ------------------------------------------------------------------------------------------

test('secret-scan reports the fake token masked and never prints it', () => {
  write(path.join(fx.claude, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0x67, 0x68, 0x70, 0x5f]));
  write(path.join(fx.claude, 'big.txt'), `${FAKE_TOKEN}\n`.repeat(200)); // ~8 KB, over the 4000-byte limit below
  const r = runScript('secret-scan.mjs', [fx.claude, fx.hostAcc, '--max-bytes', '4000'], { env });
  assert.equal(r.code, 0, r.stderr);
  const out = r.stdout + r.stderr;
  assert.ok(!out.includes(FAKE_TOKEN), 'raw token never printed');
  assert.ok(!out.includes('x'.repeat(36)), 'no long slice of the token printed');
  const helper = r.json.findings.find((f) => f.file.endsWith('scripts/helper.sh'));
  assert.ok(helper, 'finding in helper script');
  assert.equal(helper.pattern, 'github-token');
  assert.equal(helper.line, 3);
  assert.equal(helper.masked, 'ghp_…40');
  assert.ok(r.json.findings.some((f) => f.file.endsWith('settings.json')), 'token in settings env found');
  assert.ok(r.json.findings.every((f) => !path.isAbsolute(f.file) || !f.file.includes(fx.home)), 'paths are displayed with ~');
  assert.ok(r.json.skipped.binary >= 1);
  assert.ok(r.json.skipped.tooLarge >= 1);
  if (fx.dirLink) assert.ok(r.json.skipped.symlinkedDirs >= 1, 'symlinked projects dir not followed');
});

// ------------------------------------------------------------------------------------------
// discover.mjs
// ------------------------------------------------------------------------------------------

test('discover finds config dirs, imports, settings counts and links without leaking values', () => {
  const r = runScript('discover.mjs', ['--scope', 'both', '--cwd', fx.project], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes(FAKE_TOKEN), 'no secret values');
  assert.ok(!norm(r.stdout).includes(norm(fx.home)), 'home shown as ~');
  const u = r.json.user;
  const main = u.configDirs.find((d) => d.path === '~/.claude');
  assert.ok(main, 'default config dir');
  assert.ok(u.configDirs.some((d) => d.source === 'CLAUDE_CONFIG_DIR'), 'CLAUDE_CONFIG_DIR dir');
  assert.ok(u.configDirs.some((d) => d.source === 'host-app'), 'host-app account dir');

  const cm = main.instructionFiles.find((f) => f.path === '~/.claude/CLAUDE.md');
  assert.deepEqual(cm.imports.map((i) => [i.raw, i.resolves]), [['good.md', true], ['missing-rules.md', false]]);
  assert.equal(cm.brokenImports, 1);
  assert.ok(main.instructionFiles.some((f) => f.path === '~/.claude/good.md' && f.importDepth === 1));
  assert.equal(main.totals.brokenImports, 1);

  const s = main.settings.find((x) => x.path === '~/.claude/settings.json');
  assert.deepEqual(s.hooks, { PreToolUse: 2, Stop: 1 });
  assert.deepEqual(s.permissions, { allow: 3, deny: 2, ask: 1, defaultMode: 'default', additionalDirectories: 0 });
  assert.deepEqual(s.plugins, { enabled: ['alpha@market-one'], disabled: ['beta@market-one'] });
  assert.deepEqual(s.marketplaces, ['market-one']);
  assert.equal(s.envVarCount, 1);
  assert.deepEqual(main.mcpServers, [{ name: 'localtool', transport: 'local' }, { name: 'remotetool', transport: 'remote' }]);
  assert.deepEqual(main.skills.names, ['alpha-skill']);
  assert.ok(main.backupFiles.includes('settings.json.bak'));

  const second = u.configDirs.find((d) => d.source === 'CLAUDE_CONFIG_DIR');
  const sc = second.instructionFiles.find((f) => f.path.endsWith('CLAUDE.md'));
  assert.equal(sc.brokenImports, 1, 'import resolves relative to the second dir, where good.md is missing');
  const hl = second.links.find((l) => l.name === 'shared.md');
  assert.equal(hl.type, 'hardlink');
  assert.ok(hl.peers.includes('~/.claude/shared.md'));
  if (fx.fileSymlink) {
    const sl = second.links.find((l) => l.name === 'linked-good.md');
    assert.equal(sl.type, 'symlink');
    assert.equal(sl.target, '~/.claude/good.md');
  }
  assert.deepEqual(u.codex[0].config.mcpServers, [{ name: 'local_one', transport: 'local' }, { name: 'remote_one', transport: 'remote' }]);
  assert.deepEqual(u.agentsDirs[0].skills.names, ['shared-skill']);
  assert.deepEqual(u.desktopConfigs[0].mcpServers, [{ name: 'desk', transport: 'local' }]);

  const p = r.json.project;
  assert.equal(p.name, 'proj-alpha');
  assert.equal(p.isCode, true);
  const pc = p.instructionFiles.find((f) => f.path === './CLAUDE.md');
  assert.deepEqual(pc.imports.map((i) => [i.resolvedPath, i.resolves]), [['./docs/guide.md', true], ['./docs/nowhere.md', false]]);
  assert.equal(p.git.isRepo, true);
  assert.equal(p.git.currentBranch, 'main');
  assert.equal(p.git.defaultBranch, 'main');
  assert.equal(p.git.lastFetch.olderThanOneDay, true);
  assert.ok(p.git.hooks.active.includes('pre-push'));
  assert.equal(p.graphify.exists, true);
  assert.equal(p.graphify.tracked, true);
  assert.deepEqual(p.ci, ['./.github/workflows/ci.yml']);
  assert.deepEqual(p.envFiles, [{ name: '.env', tracked: false, ignored: true }]);
  assert.deepEqual(p.mcpJson.servers, [{ name: 'supabase', transport: 'local' }]);
  const lang = Object.fromEntries(p.docs.files.map((d) => [d.path, d.language]));
  assert.equal(lang['./docs/guia.md'], 'pt');
  assert.equal(lang['./docs/guide.md'], 'en');
  assert.equal(lang['./README.md'], 'en');
  assert.equal(p.docs.files.find((d) => d.path === './docs/adr/0001-record.md').kind, 'adr');
  assert.ok(p.docs.files.every((d) => d.lastCommitAt), 'last commit date per doc');
});

// ------------------------------------------------------------------------------------------
// transcript-signals.mjs
// ------------------------------------------------------------------------------------------

test('transcript-signals aggregates counts and never prints message text', () => {
  const r = runScript('transcript-signals.mjs', ['--cwd', fx.project, '--days', '60'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(MARKER), 'marker from messages, commands and outputs never printed');
  assert.ok(!norm(r.stdout).includes(norm(fx.home)));
  const j = r.json;
  assert.equal(j.sources.claude.sessions, 2, 'main + worktree session; sibling project excluded');
  assert.equal(j.sources.claude.projectDirsMatched, 2);
  assert.equal(j.sources.codex.sessions, 1, 'only the Codex session whose cwd is the project');
  assert.equal(j.sessions, 3);
  assert.deepEqual(j.dateRange, { from: '2026-01-05', to: '2026-01-05' });
  assert.equal(j.unparsableLines, 1);
  assert.equal(j.toolCalls.Bash, 6);
  assert.equal(j.toolCalls.Read, 1);
  assert.equal(j.toolCalls.Skill, 1);
  assert.equal(j.toolCalls.PowerShell, 1);
  assert.equal(j.toolCalls.exec, 1);
  assert.deepEqual(j.shellFailures, { 'npm test': 3, 'Get-ChildItem': 1, 'cargo build': 1, 'git push': 1, 'supabase db': 1 });
  assert.deepEqual(j.commandNotFound, { 'supabase db': 1 });
  assert.equal(j.hookBlocks, 2, 'one denied tool result + one blocking hook attachment; non-blocking ignored');
  assert.deepEqual(j.retries, [{ head: 'npm test', sessions: 1 }]);
  assert.equal(j.userMessages, 4);
  assert.equal(j.userCorrections, 3);
  assert.equal(j.sessionsEndingOnError, 2);
  assert.deepEqual(j.skillInvocations, { 'alpha-skill': 1 });
  assert.deepEqual(j.slashCommands, { 'alpha-skill': 1 });
  assert.deepEqual(j.topFailureSessions, [
    { source: 'claude', id: 'session-one', failures: 6 },
    { source: 'codex', id: '01a1aaaa-bbbb-7ccc-8ddd-eeeeffff0000', failures: 1 },
  ]);
});

test('transcript-signals honours --config-dirs', () => {
  const r = runScript('transcript-signals.mjs', ['--cwd', fx.project, '--config-dirs', fx.second], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.sources.claude.sessions, 0);
  assert.equal(r.json.sources.claude.configDirs, 1);
});

// ------------------------------------------------------------------------------------------
// probe-clis.mjs
// ------------------------------------------------------------------------------------------

test('probe-clis resolves binaries, flags collisions, refuses auth and matches signals', () => {
  const win = process.platform === 'win32';
  const binA = path.join(fx.root, 'binA');
  const binB = path.join(fx.root, 'binB');
  for (const [dir, ver] of [[binA, '1.2.3'], [binB, '9.9.9']]) {
    const f = path.join(dir, win ? 'hdfaketool.cmd' : 'hdfaketool');
    write(f, win ? `@echo hdfaketool ${ver}\r\n` : `#!/bin/sh\necho "hdfaketool ${ver}"\n`);
    if (!win) fs.chmodSync(f, 0o755);
  }
  const catalog = path.join(fx.root, 'tools.json');
  write(catalog, JSON.stringify({
    tools: [
      { id: 'fake', kind: 'cli', bin: 'hdfaketool', versionArgs: ['--version'], verifyArgs: ['--version'], signals: [{ type: 'dir', value: 'supabase' }, { type: 'dep', value: '@supabase/supabase-js' }, { type: 'mcp', value: 'supabase' }, { type: 'remote', value: 'github.com' }, { type: 'file', value: 'missing.json' }, { type: 'weird', value: 'x' }], extra: { tolerated: true } },
      { id: 'authy', kind: 'cli', bin: 'hdfaketool', versionArgs: ['--version'], verifyArgs: ['auth', 'status'], signals: [] },
      { id: 'ghost', kind: 'cli', bin: 'hd-definitely-not-installed-xyz', versionArgs: ['--version'], signals: [] },
      { id: 'plugin-only', kind: 'plugin', bin: null, signals: [] },
    ],
  }));
  const pathEnv = [binA, binB, process.env.PATH || process.env.Path || ''].join(path.delimiter);
  const r = runScript('probe-clis.mjs', ['--cwd', fx.project, '--catalog', catalog], { env: { ...env, PATH: pathEnv, Path: pathEnv } });
  assert.equal(r.code, 0, r.stderr);
  const byId = Object.fromEntries(r.json.tools.map((t) => [t.id, t]));
  assert.equal(byId.fake.installed, true);
  assert.equal(byId.fake.version, 'hdfaketool 1.2.3', 'first match on PATH answers');
  assert.equal(byId.fake.distinctBinaries, 2);
  assert.equal(byId.fake.collision, true);
  assert.equal(byId.fake.verify, 'pass');
  assert.deepEqual(byId.fake.signalsMatched.map((s) => s.type).sort(), ['dep', 'dir', 'mcp']);
  assert.deepEqual(byId.fake.unknownSignalTypes, ['weird']);
  assert.equal(byId.authy.verify, 'skipped-auth');
  assert.equal(byId.ghost.installed, false);
  assert.equal(byId['plugin-only'].installed, null);
  assert.ok(r.json.packageManagers.some((p) => p.name === 'npm'));
  assert.equal(r.json.catalog.source, 'catalog');
  assert.ok(!norm(r.stdout).includes(norm(fx.home)));
});

test('probe-clis falls back to the built-in list when the catalog is missing', () => {
  const r = runScript('probe-clis.mjs', ['--cwd', fx.project, '--catalog', path.join(fx.root, 'nope.json')], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.catalog.source, 'builtin');
  assert.ok(r.json.tools.some((t) => t.id === 'git' && t.installed === true));
});
