// Shared test helpers. Every CLI run gets an explicit environment: a temp home,
// the fixture skills, a pinned language and no inherited CLAUDE_CONFIG_DIR, so
// nothing can touch the real home directory.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(ROOT, 'bin', 'novarc-powers.js');
export const FIXTURE_SKILLS = path.join(ROOT, 'tests', 'fixtures', 'skills');

/** Fresh sandbox: `{base, home, cwd}` under the OS temp dir, removed by `cleanup`. */
export function sandbox({ claude = true, codex = false, agents = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'novarc-powers-test-'));
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  if (claude) fs.mkdirSync(path.join(home, '.claude'));
  if (codex) fs.mkdirSync(path.join(home, '.codex'));
  if (agents) fs.mkdirSync(path.join(home, '.agents'));
  return { base, home, cwd, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

export function cliEnv(sb, extra = {}) {
  if (!sb || !sb.home) throw new Error('cliEnv needs a sandbox home');
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.FORCE_COLOR;
  Object.assign(env, {
    NOVARC_POWERS_HOME: sb.home,
    NOVARC_POWERS_SKILLS_DIR: FIXTURE_SKILLS,
    LC_ALL: 'en_US.UTF-8',
    NO_COLOR: '1',
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** Run the CLI; returns `{code, stdout, stderr, json}`. */
export function run(sb, args, { env = {} } = {}) {
  const res = spawnSync(process.execPath, [BIN, '--lang', 'en', '--cwd', sb.cwd, ...args], {
    env: cliEnv(sb, env),
    encoding: 'utf8',
    cwd: sb.cwd,
  });
  let json = null;
  if (args.includes('--json')) {
    try {
      json = JSON.parse(res.stdout);
    } catch {
      json = null;
    }
  }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

export function read(p) {
  return fs.readFileSync(p, 'utf8');
}

export function readJson(p) {
  return JSON.parse(read(p));
}

/** Try to create a symlink; returns false when the OS refuses (Windows without Developer Mode). */
export function trySymlink(target, link, type = 'file') {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (err) {
    if (['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'UNKNOWN'].includes(err.code)) return false;
    throw err;
  }
}

export function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}