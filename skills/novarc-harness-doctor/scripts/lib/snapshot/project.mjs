// What a directory is as a project: its git repository (worktrees folded into the main one),
// whether it holds code, and which harness files it carries. Read-only; shared by
// find-projects.mjs and snapshot-harness.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { IS_WIN, home, isDir, isFile, statSafe, readdirSafe, readTextSafe, realpathSafe, git } from '../common.mjs';

// Same markers as discover.mjs (kept in step by hand: that list is not exported).
const CODE_MARKERS = new Set(['package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'mix.exs', 'deno.json', 'Makefile', 'CMakeLists.txt', 'pubspec.yaml', 'Package.swift']);
const CODE_MARKER_GLOBS = [/\.csproj$/i, /\.sln$/i, /\.fsproj$/i, /\.vcxproj$/i];

export const keyOf = (p) => (IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p));

export function under(p, root) {
  if (!root) return false;
  const a = keyOf(p);
  const b = keyOf(root);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

export function isCodeDir(dir) {
  return readdirSafe(dir).some((e) => e.isFile() && (CODE_MARKERS.has(e.name) || CODE_MARKER_GLOBS.some((re) => re.test(e.name))));
}

/**
 * Nearest directory at or above `start` that holds a `.git` (a repository, or a linked worktree's
 * pointer file). Like git, the search never climbs into a directory named in
 * GIT_CEILING_DIRECTORIES.
 */
export function findGitTop(start) {
  const ceilings = new Set((process.env.GIT_CEILING_DIRECTORIES || '').split(path.delimiter).filter(Boolean).map((p) => keyOf(p)));
  let d = path.resolve(start);
  for (let i = 0; i < 64; i++) {
    const g = path.join(d, '.git');
    const st = statSafe(g);
    if (st && st.isDirectory() && isFile(path.join(g, 'HEAD'))) return { top: d, dotGit: g, pointer: false };
    if (st && st.isFile()) return { top: d, dotGit: g, pointer: true };
    const parent = path.dirname(d);
    if (parent === d || ceilings.has(keyOf(parent))) return null;
    d = parent;
  }
  return null;
}

/**
 * The common git dir a `.git` pointer file leads to, read the way git reads it: the pointer names
 * the worktree's own git dir, whose `commondir` file names the shared one. Null when either
 * step does not hold.
 */
export function commonDirFromPointer(top, dotGit) {
  const m = /^gitdir:\s*(.+)$/m.exec(readTextSafe(dotGit, 64 * 1024) || '');
  if (!m) return null;
  const gitDir = path.resolve(top, m[1].trim());
  if (!isDir(gitDir)) return null;
  const rel = (readTextSafe(path.join(gitDir, 'commondir'), 64 * 1024) || '').trim();
  return rel ? path.resolve(gitDir, rel) : gitDir;
}

const REPO_CACHE = new Map();

/**
 * The repository `dir` belongs to: `{ top, commonDir, main, key, found }`, or null outside one.
 * `main` is the main working tree (a linked worktree resolves to the repository it belongs to);
 * `key` identifies the repository, so every worktree of one repository shares it; `found` is
 * what findGitTop() saw, with the path as given (not resolved through links).
 * A `.git` directory is its own common dir. A `.git` pointer file (a linked worktree, a
 * submodule) is followed on disk; `git rev-parse --git-common-dir` is asked only when that
 * fails, because starting git once per worktree is what makes a large machine slow to scan.
 * Answers are remembered per working tree.
 */
export function resolveRepo(dir, cache = REPO_CACHE) {
  const found = findGitTop(dir);
  if (!found) return null;
  const ck = keyOf(found.top);
  if (cache.has(ck)) return cache.get(ck);
  let commonDir = found.dotGit;
  if (found.pointer) {
    commonDir = commonDirFromPointer(found.top, found.dotGit);
    if (!commonDir || !isDir(commonDir)) {
      const r = git(found.top, ['rev-parse', '--git-common-dir']);
      commonDir = r.ok && r.stdout.trim() ? path.resolve(found.top, r.stdout.trim()) : null;
    }
    if (!commonDir || !isDir(commonDir)) { cache.set(ck, null); return null; }
  }
  commonDir = realpathSafe(commonDir) || commonDir;
  const top = realpathSafe(found.top) || found.top;
  // `<repo>/.git` belongs to the working tree beside it. Anything else (a submodule's module dir,
  // a bare repository with worktrees) has no main working tree: the worktree stands for itself.
  const beside = path.dirname(commonDir);
  const main = path.basename(commonDir).toLowerCase() === '.git' && isDir(beside) ? beside : top;
  const repo = { top, commonDir, main, key: keyOf(commonDir), found };
  cache.set(ck, repo);
  return repo;
}

/** Linked worktrees registered in a common git dir whose working directory still exists. */
export function linkedWorktrees(commonDir) {
  let n = 0;
  for (const e of readdirSafe(path.join(commonDir, 'worktrees'))) {
    const base = path.join(commonDir, 'worktrees', e.name);
    const pointer = (readTextSafe(path.join(base, 'gitdir'), 64 * 1024) || '').trim();
    if (pointer && statSafe(path.resolve(base, pointer))) n++;
  }
  return n;
}

/** What the probes need from the repository's own config file: remote names and core.hooksPath. */
function localConfig(commonDir) {
  const out = { remotes: [], hooksPath: null };
  const text = readTextSafe(path.join(commonDir, 'config'), 1024 * 1024);
  if (text === null) return out;
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const h = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (h) {
      section = h[1].toLowerCase();
      if (section === 'remote' && h[2] && !out.remotes.includes(h[2])) out.remotes.push(h[2]);
      continue;
    }
    const kv = /^\s*hookspath\s*=\s*(.+?)\s*$/i.exec(line);
    if (section === 'core' && kv && out.hooksPath === null) out.hooksPath = kv[1].replace(/^"|"$/g, '');
  }
  return out;
}

/** `core.hooksPath` from the repository's own config file (global config is not a project trait). */
export function localHooksPath(commonDir) {
  return localConfig(commonDir).hooksPath;
}

/** Harness files a project root carries, as short labels in a fixed order. */
export function harnessSignals(root, commonDir = null) {
  const out = [];
  for (const n of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) if (isFile(path.join(root, n))) out.push(n);
  if (isDir(path.join(root, '.claude'))) out.push('.claude/');
  if (isDir(path.join(root, '.agents'))) out.push('.agents/');
  if (isDir(path.join(root, '.cursor', 'rules'))) out.push('.cursor/rules');
  if (isFile(path.join(root, '.mcp.json'))) out.push('.mcp.json');
  if (isDir(path.join(root, 'graphify-out'))) out.push('graphify-out/');
  if (readdirSafe(path.join(root, '.github', 'workflows')).some((e) => /\.ya?ml$/i.test(e.name))) out.push('.github/workflows');
  if (isDir(path.join(root, '.githooks'))) out.push('.githooks');
  if (commonDir && localHooksPath(commonDir)) out.push('core.hooksPath');
  if (isDir(path.join(root, '.novarc-powers'))) out.push('.novarc-powers/');
  return out;
}

/**
 * Git facts for the harness entry of a project: default branch, how far the local default branch
 * is behind its remote (from the refs already fetched; nothing is fetched here), linked worktrees.
 * Keys are left out when the fact is unknown.
 */
export function projectGitInfo(cwd) {
  const repo = resolveRepo(cwd);
  if (!repo) return {};
  const t = (args) => { const r = git(cwd, args); return r.ok ? r.stdout.trim() : null; };
  // Starting a git process is slow on some systems, so refs are read from the repository's files.
  // A repository that keeps its refs in another format is asked through git instead.
  const plain = !isDir(path.join(repo.commonDir, 'reftable'));
  const packed = new Set();
  if (plain) for (const line of (readTextSafe(path.join(repo.commonDir, 'packed-refs'), 16 * 1024 * 1024) || '').split(/\r?\n/)) {
    const m = /^[0-9a-f]{40,64} (\S+)$/.exec(line);
    if (m) packed.add(m[1]);
  }
  const hasRef = (ref) => (plain ? isFile(path.join(repo.commonDir, ...ref.split('/'))) || packed.has(ref) : t(['rev-parse', '--verify', '--quiet', ref]) !== null);
  const remotes = plain ? localConfig(repo.commonDir).remotes : (t(['remote']) || '').split(/\r?\n/).filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0] || null;
  let def = null;
  if (remote) {
    const head = `refs/remotes/${remote}/HEAD`;
    const target = plain ? (/^ref:\s*(\S+)/.exec(readTextSafe(path.join(repo.commonDir, ...head.split('/')), 4096) || '') || [])[1] : t(['symbolic-ref', head]);
    const prefix = `refs/remotes/${remote}/`;
    if (target && target.startsWith(prefix)) def = target.slice(prefix.length);
  }
  if (!def) def = ['main', 'master', 'trunk', 'develop'].find((c) => hasRef(`refs/heads/${c}`) || (remote !== null && hasRef(`refs/remotes/${remote}/${c}`))) || null;
  const out = {};
  if (def) out.defaultBranch = def;
  if (def && remote && hasRef(`refs/heads/${def}`) && hasRef(`refs/remotes/${remote}/${def}`)) {
    const s = t(['rev-list', '--left-right', '--count', `refs/heads/${def}...refs/remotes/${remote}/${def}`]);
    const behind = s ? Number(s.split(/\s+/)[1]) : NaN;
    if (Number.isInteger(behind) && behind >= 0) out.behindRemote = behind;
  }
  out.worktrees = linkedWorktrees(repo.commonDir);
  return out;
}

/** The directory git runs hooks from for this checkout, or null outside a repository. */
export function gitHooksDir(cwd) {
  const repo = resolveRepo(cwd);
  if (!repo) return null;
  // Asked through git: the setting may come from the user's or the system's config as well.
  const hp = git(cwd, ['config', '--get', 'core.hooksPath']);
  const raw = hp.ok ? hp.stdout.trim() : (hp.code === null ? localHooksPath(repo.commonDir) || '' : '');
  if (raw) return path.resolve(repo.found.top, raw.replace(/^~(?=[\\/]|$)/, home()));
  return path.join(repo.found.pointer ? repo.commonDir : repo.found.dotGit, 'hooks');
}

/** First bytes of a file as text; null when it cannot be read. */
export function readHead(file, bytes) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } catch { return null; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } } }
}
