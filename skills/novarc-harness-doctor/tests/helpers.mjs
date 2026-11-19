// Test helpers: temp dirs, running a script as a child process with an isolated home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.join(TESTS_DIR, '..');
export const SCRIPTS = path.join(SKILL_DIR, 'scripts');
export const FIXTURES = path.join(TESTS_DIR, 'fixtures');

export function tmpDir(prefix = 'hd-test-') {
  // realpath so that the path the script sees equals the one the test computes (macOS /var -> /private/var).
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Environment that points os.homedir() and app-data lookups at a fake home. */
export function homeEnv(fakeHome, extra = {}) {
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  delete env.XDG_CONFIG_HOME;
  env.HOME = fakeHome;
  env.USERPROFILE = fakeHome;
  env.APPDATA = path.join(fakeHome, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(fakeHome, 'AppData', 'Local');
  return { ...env, ...extra };
}

export function runScript(name, args, opts = {}) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, name), ...args], {
    encoding: 'utf8',
    env: opts.env || process.env,
    cwd: opts.cwd,
    timeout: opts.timeout || 60000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json: tryJson(r.stdout) };
}

function tryJson(s) { try { return JSON.parse(s); } catch { return null; } }

export function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

export function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}

/** Try a file symlink; Windows without developer mode refuses. Returns true when it worked. */
export function trySymlink(target, linkPath, type) {
  try { fs.symlinkSync(target, linkPath, type); return true; } catch { return false; }
}
