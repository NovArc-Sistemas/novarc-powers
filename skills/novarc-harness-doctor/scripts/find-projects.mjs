#!/usr/bin/env node
// find-projects.mjs [--roots <dir,dir>] [--days 30] [--max-depth 4] [--config-dirs a,b]
//
// Finds the git repositories an agent has worked in, or that carry harness files. Sources: the
// working directory recorded inside agent session transcripts of every account (Claude Code keeps
// `cwd` on transcript entries, Codex rollouts record it in their first line), plus any --roots
// scanned for `.git` down to --max-depth. Worktrees are folded into their main repository.
// Read-only. Only the first kilobytes of a transcript are read, and only to learn its `cwd`;
// the window is decided by file modification time. Prints display paths (`~` for home); the one
// absolute path is `pathAbs`, which exists so the caller can pass it back as --cwd.
import path from 'node:path';
import {
  IS_WIN, parseArgs, isMain, printJson, warn, displayPath, normalizeInputPath, home, isDir, statSafe,
  readdirSafe, realpathSafe, SKIP_DIRS,
} from './lib/common.mjs';
import { claudeConfigDirs, codexDirs, encodeProjectPath } from './lib/locations.mjs';
import { keyOf, resolveRepo, isCodeDir, harnessSignals, linkedWorktrees, readHead } from './lib/snapshot/project.mjs';

const DAY = 86400000;
const HEAD_SIZES = [16 * 1024, 64 * 1024, 256 * 1024];
const SAMPLE_FILES = 3;
const REASON = {
  gone: 'path no longer exists',
  notRepo: 'not a git repository',
  idle: 'no activity in window and no harness files',
};

const CWD_FIELD = /"cwd":\s*"((?:[^"\\]|\\.)*)"/;

function cwdFromLine(line, complete) {
  if (complete) {
    try {
      // A whole entry: only its own cwd counts (Claude Code) or its payload's (Codex), not a
      // cwd quoted somewhere deeper inside it.
      const o = JSON.parse(line);
      if (o && typeof o.cwd === 'string' && o.cwd) return o.cwd;
      if (o && o.payload && typeof o.payload.cwd === 'string' && o.payload.cwd) return o.payload.cwd;
      return null;
    } catch { /* not valid JSON: fall through to the pattern */ }
  }
  // An entry longer than what was read: take the field from the part that is there.
  const m = CWD_FIELD.exec(line);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`) || null; } catch { return null; }
}

/** The working directory a transcript records near its start, reading as little as possible. */
export function transcriptCwd(file, size = null) {
  let total = size;
  if (total === null) { const st = statSafe(file); if (!st) return null; total = st.size; }
  for (const bytes of HEAD_SIZES) {
    const head = readHead(file, bytes);
    if (head === null) return null;
    const whole = total <= bytes;
    const lines = head.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!CWD_FIELD.test(lines[i])) continue;
      const cwd = cwdFromLine(lines[i], whole || i < lines.length - 1);
      if (cwd) return cwd;
    }
    if (whole) return null;
  }
  return null;
}

function cleanCwd(cwd) {
  let s = String(cwd);
  if (IS_WIN) s = s.replace(/^\\\\\?\\(?!UNC\\)/i, ''); // extended-length prefix some tools record
  return normalizeInputPath(s);
}

function jsonlFiles(dir) {
  const out = [];
  for (const e of readdirSafe(dir)) {
    if (!e.name.endsWith('.jsonl') || e.isDirectory()) continue;
    const st = statSafe(path.join(dir, e.name));
    if (st && st.isFile()) out.push({ file: path.join(dir, e.name), mtime: st.mtimeMs, size: st.size });
  }
  return out;
}

function rolloutFiles(dir, maxDepth) {
  const out = [];
  const stack = [[dir, 0]];
  while (stack.length) {
    const [d, depth] = stack.pop();
    for (const e of readdirSafe(d)) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < maxDepth) stack.push([full, depth + 1]); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      const st = statSafe(full);
      if (st && st.isFile()) out.push({ file: full, mtime: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

/** Directories under `root` that hold a `.git`, down to `maxDepth` levels (the root is level 0). */
export function scanRoot(root, maxDepth) {
  const found = [];
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    const ents = readdirSafe(dir);
    const isRepo = ents.some((e) => e.name === '.git');
    if (isRepo) found.push(dir);
    // A repository's own tree is not searched for more repositories, except the root the user named.
    if ((isRepo && depth > 0) || depth >= maxDepth) continue;
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      stack.push([path.join(dir, e.name), depth + 1]);
    }
  }
  return found.sort();
}

export function findProjects({ roots = [], days = 30, maxDepth = 4, configDirs = null, now = Date.now() } = {}) {
  const cutoff = now - days * DAY;
  const scanned = { configDirs: 0, transcriptDirs: 0, transcripts: 0, codexRollouts: 0, withoutCwd: 0, roots: roots.length };
  const activity = new Map(); // cwd key -> { cwd, sessions, total, last, providers }
  const note = (cwd, provider, sessions, total, last) => {
    const abs = cleanCwd(cwd);
    const k = keyOf(abs);
    const a = activity.get(k) || { cwd: abs, sessions: 0, total: 0, last: 0, providers: new Set() };
    a.sessions += sessions;
    a.total += total;
    a.last = Math.max(a.last, last);
    a.providers.add(provider);
    activity.set(k, a);
  };

  // Claude-style config dirs: <dir>/projects/<encoded cwd>/<session>.jsonl. Account dirs of host
  // apps often link their projects/ to the default one, so both levels are deduped by real path.
  const dirs = configDirs && configDirs.length
    ? configDirs.map((p) => ({ path: normalizeInputPath(p) })).filter((d) => isDir(d.path))
    : claudeConfigDirs();
  scanned.configDirs = dirs.length;
  const seen = new Set();
  const once = (p) => {
    const real = realpathSafe(p);
    if (!real) return false;
    const k = keyOf(real);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  for (const d of dirs) {
    const pdir = path.join(d.path, 'projects');
    if (!once(pdir)) continue;
    for (const e of readdirSafe(pdir)) {
      const full = path.join(pdir, e.name);
      if (!(e.isDirectory() || e.isSymbolicLink()) || !isDir(full) || !once(full)) continue;
      const files = jsonlFiles(full);
      if (!files.length) continue;
      scanned.transcriptDirs++;
      scanned.transcripts += files.length;
      files.sort((a, b) => b.mtime - a.mtime);
      // The folder name is a lossy encoding of the working directory; the transcripts say what
      // it really was. A cwd that encodes back to the folder name wins over any other.
      let cwd = null;
      const want = e.name.toLowerCase();
      for (const f of files.slice(0, SAMPLE_FILES)) {
        const c = transcriptCwd(f.file, f.size);
        if (!c) continue;
        if (cwd === null) cwd = c;
        if (encodeProjectPath(c).toLowerCase() === want) { cwd = c; break; }
      }
      if (cwd === null) { scanned.withoutCwd++; continue; }
      note(cwd, 'claude-code', files.filter((f) => f.mtime >= cutoff).length, files.length, files[0].mtime);
    }
  }

  // Codex: <dir>/sessions/YYYY/MM/DD/rollout-*.jsonl, each with its own cwd in the first line.
  for (const d of codexDirs()) {
    for (const f of rolloutFiles(path.join(d.path, 'sessions'), 4)) {
      scanned.codexRollouts++;
      const cwd = transcriptCwd(f.file, f.size);
      if (!cwd) { scanned.withoutCwd++; continue; }
      note(cwd, 'codex', f.mtime >= cutoff ? 1 : 0, 1, f.mtime);
    }
  }

  const repoCache = new Map();
  const groups = new Map(); // repository key -> group
  const skipped = new Map(); // display path -> reason
  const h = home();
  const groupFor = (repo) => {
    let g = groups.get(repo.key);
    if (!g) { g = { repo, sessions: 0, total: 0, last: 0, providers: new Set(), tops: new Map() }; groups.set(repo.key, g); }
    const t = g.tops.get(keyOf(repo.top)) || { top: repo.top, total: 0 };
    g.tops.set(keyOf(repo.top), t);
    return { g, t };
  };

  for (const a of activity.values()) {
    // A deleted worktree or subfolder still belongs to the repository above it, when one is there.
    let existing = a.cwd;
    for (let i = 0; i < 16 && !isDir(existing); i++) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const gone = keyOf(existing) !== keyOf(a.cwd);
    const repo = isDir(existing) ? resolveRepo(existing, repoCache) : null;
    // A repository at the home directory (dotfiles) does not claim every folder that was ever under it.
    const tooWide = repo && gone && keyOf(repo.top) === keyOf(realpathSafe(h) || h);
    if (!repo || tooWide) { skipped.set(displayPath(a.cwd), gone ? REASON.gone : REASON.notRepo); continue; }
    const { g, t } = groupFor(repo);
    g.sessions += a.sessions;
    g.total += a.total;
    g.last = Math.max(g.last, a.last);
    for (const p of a.providers) g.providers.add(p);
    t.total += a.total;
  }

  for (const root of roots) for (const dir of scanRoot(root, maxDepth)) {
    const repo = resolveRepo(dir, repoCache);
    if (repo) groupFor(repo);
  }

  const projects = [];
  for (const g of groups.values()) {
    // The main working tree stands for the repository. Without one (a bare repository with
    // worktrees), the worktree with the most sessions does.
    const standard = path.basename(g.repo.commonDir).toLowerCase() === '.git';
    const root = standard ? g.repo.main : [...g.tops.values()].sort((x, y) => y.total - x.total || (x.top < y.top ? -1 : 1))[0].top;
    if (!isDir(root)) { skipped.set(displayPath(root), REASON.gone); continue; }
    const signals = harnessSignals(root, g.repo.commonDir);
    const suggested = g.sessions > 0 || signals.length > 0;
    if (!suggested) { skipped.set(displayPath(root), REASON.idle); continue; }
    projects.push({
      name: path.basename(root),
      path: displayPath(root),
      pathAbs: root,
      sessions: g.sessions,
      lastActive: g.last ? new Date(g.last).toISOString() : null,
      worktrees: linkedWorktrees(g.repo.commonDir),
      isCode: isCodeDir(root),
      signals,
      providers: [...g.providers].sort(),
      suggested,
    });
  }
  projects.sort((a, b) => b.sessions - a.sessions || String(b.lastActive || '').localeCompare(String(a.lastActive || '')) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  // A path listed as a project is not also reported as skipped.
  for (const p of projects) skipped.delete(p.path);
  return {
    windowDays: days,
    projects,
    skipped: [...skipped].map(([p, reason]) => ({ path: p, reason })).sort((a, b) => a.path.localeCompare(b.path)),
    scanned,
  };
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  const days = args.days !== undefined ? Number(args.days) : 30;
  if (!Number.isFinite(days) || days <= 0) { warn('--days must be a positive number'); process.exit(2); }
  const maxDepth = args['max-depth'] !== undefined ? Number(args['max-depth']) : 4;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 12) { warn('--max-depth must be an integer from 0 to 12'); process.exit(2); }
  const list = (v, flag) => {
    if (v === undefined) return [];
    if (typeof v !== 'string') { warn(`${flag} needs a comma-separated list of directories`); process.exit(2); }
    return v.split(',').map((s) => s.trim()).filter(Boolean).map(normalizeInputPath);
  };
  const roots = list(args.roots, '--roots');
  const configDirs = list(args['config-dirs'], '--config-dirs');
  for (const r of roots) if (!isDir(r)) { warn(`--roots: not a directory: ${displayPath(r)}`); process.exit(2); }
  for (const c of configDirs) if (!isDir(c)) { warn(`--config-dirs: not a directory: ${displayPath(c)}`); process.exit(2); }
  const started = Date.now();
  try {
    const res = findProjects({ roots, days, maxDepth, configDirs: configDirs.length ? configDirs : null });
    printJson({ generatedAt: new Date().toISOString(), ...res, durationMs: Date.now() - started });
  } catch (e) {
    warn(`failed: ${e && e.code ? e.code : 'error'}`);
    process.exit(1);
  }
}
