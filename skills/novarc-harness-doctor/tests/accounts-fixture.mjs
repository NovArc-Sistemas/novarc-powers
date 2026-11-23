// Synthetic home with several agent accounts, entirely under os.tmpdir(). Shared by the
// accounts-*.test.mjs files. Nothing here reads or writes the real machine's harness: every
// script runs with HOME, USERPROFILE and NOVARC_POWERS_HOME pointing at the fake home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpDir, rmrf, write, homeEnv, runScript, SCRIPTS } from './helpers.mjs';

// In-process imports of the library must never fall back to the real home either.
const GUARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-acc-guard-'));
process.env.NOVARC_POWERS_HOME = GUARD_HOME;
process.on('exit', () => rmrf(GUARD_HOME));

/** Placed in every credential, session and history file. It must never reach any output. */
export const CANARY = 'ZQCANARY9917';
// Shaped like a GitHub classic token, obviously fake, and built at run time.
export const FAKE_TOKEN = `ghp_${'x'.repeat(36)}`;
export const PRIMARY_EMAIL = `primary.owner@${'example'}.com`;
export const SECOND_EMAIL = `second.owner@${'example'}.com`;

export const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export const read = (p) => fs.readFileSync(p, 'utf8');
export const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
export const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
export const json = (p) => JSON.parse(read(p));

export const CLAUDE_MD = [
  '# Global rules',
  '',
  'Always answer briefly.',
  '',
  '@RTK.md',
  '',
  'See @docs/extra.md for the long version.',
  '',
  '@rules/style.md',
  '@missing-file.md',
  '',
  '<!-- only: claude-code -->',
  'Use the Skill tool for skills. CLAUDE-ONLY-LINE',
  '<!-- /only -->',
  '',
  '<!-- except: codex -->',
  'Not for Codex. EXCEPT-CODEX-LINE',
  '<!-- /except -->',
  '',
  '<!-- only: codex -->',
  'Codex reads this. CODEX-ONLY-LINE',
  '<!-- /only -->',
  '',
  'Inline <!-- only: gemini -->GEMINI-INLINE <!-- /only -->tail.',
  '',
  '```',
  '@not-an-import.md',
  '<!-- only: claude-code -->',
  'inside a code block: kept as text',
  '```',
  '',
  'Mention `@types/node` and @someone are not imports.',
  '',
].join('\n');

/**
 * Build the fake home.
 *   .claude                      claude-1, the default account (the usual primary)
 *   .hostapp/.../claude-code/acc-1   claude-2, a host-app account that drifted
 *   .codex                       codex-1
 *   .agents                      agents-1, the shared skills folder (optional)
 */
export function buildHome({ agents = true, codex = true, second = true } = {}) {
  const root = tmpDir('hd-acc-');
  const home = path.join(root, 'home');
  const claude = path.join(home, '.claude');
  const acc = path.join(home, '.hostapp', 'host', 'harness-accounts', 'claude-code', 'acc-1');
  const codexDir = path.join(home, '.codex');
  const agentsDir = path.join(home, '.agents');
  const canaries = [];
  const canary = (p, body = '') => { write(p, `${body}${CANARY}\n`); canaries.push(p); };

  // ---- claude-1
  write(path.join(claude, 'CLAUDE.md'), CLAUDE_MD);
  write(path.join(claude, 'RTK.md'), '# RTK\n\nPrefix commands. RTK-BODY\n\n@NESTED.md\n');
  write(path.join(claude, 'NESTED.md'), 'Nested import. NESTED-BODY\n');
  write(path.join(claude, 'docs', 'extra.md'), 'The long version. EXTRA-BODY\n');
  write(path.join(claude, 'rules', 'style.md'), 'Style rules. STYLE-BODY\n');
  write(path.join(claude, 'settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(git status)', 'Read'], deny: ['Bash(rm -rf *)'], ask: ['Bash(git push)'], defaultMode: 'default' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.js' }] }] },
    statusLine: { type: 'command', command: 'bash ~/.claude/statusline.sh' },
    enabledPlugins: { 'tool@market': true },
    model: 'x',
  }, null, 2) + '\n');
  write(path.join(claude, 'statusline.sh'), '#!/bin/sh\necho status\n');
  write(path.join(claude, 'keybindings.json'), '{"bindings": []}\n');
  write(path.join(claude, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha.\n---\nAlpha body.\n');
  write(path.join(claude, 'skills', 'alpha', 'helper.txt'), 'helper\n');
  write(path.join(claude, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: Beta.\n---\nBeta body.\n');
  write(path.join(claude, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nReview.\n');
  write(path.join(claude, 'commands', 'ship.md'), 'Ship it.\n');
  write(path.join(claude, 'plugins', 'installed_plugins.json'), '{"version": 2, "plugins": {}}\n');
  canary(path.join(claude, '.credentials.json'), '{"token":"');
  canary(path.join(claude, 'projects', 'C--x', 'session.jsonl'));
  canary(path.join(claude, 'history.jsonl'));
  canary(path.join(claude, 'settings.local.json'), '{"note":"');
  canary(path.join(claude, 'todos', 't.json'));
  // The default account's state file lives in home. Only oauthAccount.emailAddress and
  // mcpServers may ever be taken from it.
  const state1 = path.join(home, '.claude.json');
  write(state1, JSON.stringify({
    numStartups: 3,
    oauthAccount: { emailAddress: PRIMARY_EMAIL, accountUuid: CANARY, organizationName: CANARY },
    projects: { [`/work/${CANARY}`]: { history: [CANARY] } },
    mcpServers: {
      context7: { command: 'npx', args: ['-y', 'context7-mcp'], env: { MODE: 'fast', PASSTHRU: '${PASSTHRU}' } },
      remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${REMOTE_TOKEN}', 'X-Region': 'eu' } },
      leaky: { command: 'npx', args: ['-y', 'leaky-mcp'], env: { GITHUB_TOKEN: FAKE_TOKEN } },
      streamy: { type: 'sse', url: 'https://sse.example.com/sse' },
    },
  }, null, 2) + '\n');

  // ---- claude-2: a host-app account with its own drifted copies
  let state2 = null;
  if (second) {
    write(path.join(acc, 'CLAUDE.md'), '# Rules of the second account\n\nDifferent on purpose.\n');
    fs.copyFileSync(path.join(claude, 'settings.json'), path.join(acc, 'settings.json')); // copied
    write(path.join(acc, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nOlder alpha.\n'); // divergent folder
    write(path.join(acc, 'output-styles', 'terse.md'), 'Terse.\n'); // account-only
    write(path.join(acc, 'commands', 'ship.md'), 'Ship it.\n'); // copied folder
    canary(path.join(acc, '.credentials.json'), '{"token":"');
    canary(path.join(acc, 'projects', 'C--y', 'session.jsonl'));
    state2 = path.join(acc, '.claude.json');
    write(state2, JSON.stringify({
      oauthAccount: { emailAddress: SECOND_EMAIL, accountUuid: CANARY },
      projects: { [`/work/${CANARY}`]: {} },
      mcpServers: {
        context7: { command: 'npx', args: ['-y', 'context7-mcp'], env: { MODE: 'fast', PASSTHRU: '${PASSTHRU}' } },
        'only-here': { command: 'node', args: ['local.js'] },
      },
    }, null, 2) + '\n');
  }

  // ---- codex-1
  if (codex) {
    write(path.join(codexDir, 'AGENTS.md'), '# Codex rules written by hand\n');
    write(path.join(codexDir, 'config.toml'), [
      'model = "x"', 'approval_policy = "on-request"', '',
      '[mcp_servers.existing]', 'command = "echo"', 'args = ["hello"]', '',
      '[projects."/work/a"]', 'trust_level = "trusted"', '',
    ].join('\n'));
    write(path.join(codexDir, 'skills', 'own-skill', 'SKILL.md'), '---\nname: own-skill\n---\nOwn.\n');
    canary(path.join(codexDir, 'auth.json'), '{"tokens":"');
    canary(path.join(codexDir, 'sessions', '2026', 'rollout.jsonl'));
    canary(path.join(codexDir, 'history.jsonl'));
  }

  // ---- agents-1
  if (agents) write(path.join(agentsDir, 'skills', 'shared-skill', 'SKILL.md'), '---\nname: shared-skill\n---\nShared.\n');

  const canaryHashes = new Map(canaries.map((p) => [p, sha(p)]));
  return { root, home, claude, acc, codexDir, agentsDir, state1, state2, canaries, canaryHashes, sync: path.join(home, '.novarc-powers', 'novarc-harness-doctor', 'sync') };
}

/**
 * NOVARC_POWERS_TEST_NO_SYMLINK=1 runs the whole suite as on a machine that refuses symbolic
 * links (Windows without the privilege): the scripts fall back to junctions and hardlinks, and
 * the assertions that need a real symlink are replaced by their fallback counterpart.
 */
const FORCE_FALLBACK = process.env.NOVARC_POWERS_TEST_NO_SYMLINK === '1';

/** Environment for a child process: fake home everywhere, no inherited config-dir overrides. */
export function env(home, extra = {}) {
  return homeEnv(home, { NOVARC_POWERS_HOME: home, NOVARC_POWERS_NO_SYMLINK: FORCE_FALLBACK ? '1' : '', ...extra });
}

/** Run accounts.mjs against the fake home. Returns { code, stdout, stderr, json }. */
export function acc(home, args, extra = {}) {
  return runScript('accounts.mjs', args, { env: env(home, extra) });
}

/** Run the standalone check, from the skill's scripts dir or from an installed copy. */
export function check(home, args = [], { script = path.join(SCRIPTS, 'sync-check.mjs'), extra = {} } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: env(home, extra), timeout: 60000 });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Plan to a file and apply it. Returns { plan, apply, planFile }. */
export function planAndApply(h, primary, planArgs = [], extra = {}) {
  const planFile = path.join(h.root, `plan-${Math.random().toString(36).slice(2, 8)}.json`);
  const plan = acc(h.home, ['plan', '--primary', primary, '--out', planFile, ...planArgs], extra);
  const apply = acc(h.home, ['apply', '--plan', planFile, '--yes'], extra);
  return { plan, apply, planFile };
}

/** Every regular file under a directory (links are not followed), for write-nothing assertions. */
export function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const l = fs.lstatSync(full);
      if (l.isSymbolicLink()) out[full] = `link:${fs.readlinkSync(full)}`;
      else if (l.isDirectory()) { out[`${full}${path.sep}`] = 'dir'; walk(full); } else out[full] = `${l.size}:${sha(full)}`;
    }
  };
  walk(dir);
  return out;
}

/** Fails when any output of a run leaks a credential marker or an absolute fake-home path. */
export function assertClean(assert, h, text, { allowAbs = false } = {}) {
  assert.ok(!text.includes(CANARY), 'a credential or session marker reached the output');
  assert.ok(!text.includes(FAKE_TOKEN), 'a secret value reached the output');
  if (!allowAbs) {
    for (const form of [h.home, h.home.replace(/\\/g, '/'), h.home.replace(/\\/g, '\\\\')]) {
      assert.ok(!text.includes(form), 'an absolute home path reached the output');
    }
  }
}

/** Credential and session files are byte-identical, still plain files, and linked nowhere. */
export function assertCanariesUntouched(assert, h) {
  for (const [p, hash] of h.canaryHashes) {
    const l = fs.lstatSync(p);
    assert.ok(l.isFile() && !l.isSymbolicLink(), `${path.basename(p)} is no longer a plain file`);
    assert.equal(l.nlink, 1, `${path.basename(p)} gained a hardlink`);
    assert.equal(sha(p), hash, `${path.basename(p)} changed`);
  }
}

/** A text search over every file this tool wrote (plans, manifest, journals, backups). */
export function grepTree(dir, needle) {
  const hits = [];
  if (!exists(dir)) return hits;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const l = fs.lstatSync(full);
      if (l.isSymbolicLink()) continue;
      if (l.isDirectory()) walk(full);
      else if (fs.readFileSync(full).includes(needle)) hits.push(full);
    }
  };
  walk(dir);
  return hits;
}

/** True when `a` reaches the same file or folder as `b` (symlink, junction or hardlink). */
export function resolvesTo(a, b) {
  try {
    if (fs.realpathSync.native(a) === fs.realpathSync.native(b)) return true;
    const x = fs.statSync(a, { bigint: true });
    const y = fs.statSync(b, { bigint: true });
    return x.ino === y.ino && x.dev === y.dev;
  } catch { return false; }
}

/** Whether this OS lets the test process create symbolic links (Windows needs a privilege). */
export const CAN_SYMLINK = (() => {
  if (FORCE_FALLBACK) return false;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-acc-sl-'));
  try { fs.writeFileSync(path.join(d, 't'), 'x'); fs.symlinkSync(path.join(d, 't'), path.join(d, 'l'), 'file'); return true; } catch { return false; } finally { rmrf(d); }
})();

/** Remove a link (file link, folder link or junction) without touching what it points to. */
export function dropLink(p) {
  try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
}

/** Simulate an editor's atomic save: write a temp file, then rename it over the target. */
export function atomicSave(file, content) {
  const tmp = `${file}.tmp-save`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** Add a second host-app Claude account whose instruction file and skills link into `.claude`. */
export function addLinkedAccount(h, { hard = false } = {}) {
  const dir = path.join(h.home, '.hostapp', 'host', 'harness-accounts', 'claude-code', 'acc-2');
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, 'settings.json'), '{}\n');
  if (hard || !CAN_SYMLINK) {
    fs.linkSync(path.join(h.claude, 'CLAUDE.md'), path.join(dir, 'CLAUDE.md'));
    fs.linkSync(path.join(h.claude, 'RTK.md'), path.join(dir, 'RTK.md'));
    fs.symlinkSync(path.join(h.claude, 'skills'), path.join(dir, 'skills'), 'junction');
  } else {
    fs.symlinkSync(path.join(h.claude, 'CLAUDE.md'), path.join(dir, 'CLAUDE.md'), 'file');
    fs.symlinkSync(path.join(h.claude, 'RTK.md'), path.join(dir, 'RTK.md'), 'file');
    fs.symlinkSync(path.join(h.claude, 'skills'), path.join(dir, 'skills'), 'dir');
  }
  return dir;
}

export { tmpDir, rmrf, write, SCRIPTS };
