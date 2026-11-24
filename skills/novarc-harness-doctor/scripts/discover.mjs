#!/usr/bin/env node
// discover.mjs --scope user|project|both --cwd <dir> [--provider <p> --config-dir <dir>]
//
// Read-only inventory of agent harness locations. User scope: Claude-style config dirs (default,
// CLAUDE_CONFIG_DIR, host-app account dirs), Codex, ~/.agents and the Claude desktop config.
// With --provider and --config-dir the user scope is one account: that config dir and nothing
// of any other account (the output then says which, in `account`).
// Project scope: instruction files, agent folders, settings, git state, knowledge graph, git
// hooks, CI and a docs inventory. Prints JSON. Never prints file contents, setting values,
// environment variables or credentials; only names, counts, sizes and display paths.
import fs from 'node:fs';
import path from 'node:path';
import {
  IS_WIN, parseArgs, isMain, printJson, warn, displayPath, normalizeInputPath, home,
  lstatSafe, statSafe, isDir, isFile, readdirSafe, readlinkSafe, realpathSafe, readTextSafe,
  readJsonSafe, approxTokens, git, SKIP_DIRS,
} from './lib/common.mjs';
import { userLocations, accountFromArgs } from './lib/locations.mjs';

const INSTRUCTION_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md', 'GEMINI.md'];
const BACKUP_RE = /(\.(bak|old|orig|backup|tmp)(\b|[-.])|~$|\.bak-|\.tmp\.)/i;
const CODE_MARKERS = ['package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'mix.exs', 'deno.json', 'Makefile', 'CMakeLists.txt', 'pubspec.yaml', 'Package.swift'];
const CODE_MARKER_GLOBS = [/\.csproj$/i, /\.sln$/i, /\.fsproj$/i, /\.vcxproj$/i];
const DOC_EXT = /\.(md|mdx|markdown|rst|txt|adoc)$/i;
const DOC_DIR_NAMES = new Set(['adr', 'adrs', 'decisions', 'specs', 'spec', 'plans', 'rfcs', 'rfc']);
const MAX_DOCS = 200;

// ---------------------------------------------------------------------------------------------
// Instruction files and @imports
// ---------------------------------------------------------------------------------------------

/** `@path` imports in a markdown instruction file, ignoring fenced code and inline code spans. */
export function parseImports(text) {
  const stripped = text
    .replace(/^(```|~~~)[\s\S]*?^\1/gm, '')
    .replace(/`[^`\n]*`/g, '');
  const out = [];
  const re = /(^|[\s(])@((?:~|\.{1,2})?[\\/]?[^\s`'"()<>[\]{}]+)/gm;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    let raw = m[2].replace(/[.,;:!?]+$/, '');
    if (!raw || raw.includes('@')) continue;
    const pathish = /^(~[\\/]|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(raw);
    const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(raw);
    if (!pathish && !hasExt) continue; // `@name` mentions and package scopes are not imports
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

function resolveImport(raw, fromFile) {
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(home(), raw.slice(2));
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(path.dirname(fromFile), raw);
}

/**
 * Describe an instruction file and follow its imports (up to 5 hops, like Claude Code).
 * Imports resolve relative to the importing file's own directory, not its symlink target.
 */
function describeInstructionFile(file, projectRoot, seen = new Set(), depth = 0) {
  const results = [];
  const key = IS_WIN ? file.toLowerCase() : file;
  if (seen.has(key)) return results;
  seen.add(key);
  const text = readTextSafe(file);
  const lst = lstatSafe(file);
  const entry = {
    path: displayPath(file, projectRoot),
    importDepth: depth,
    isSymlink: !!(lst && lst.isSymbolicLink()),
    bytes: null,
    approxTokens: null,
    imports: [],
  };
  if (entry.isSymlink) entry.linkTarget = displayPath(realpathSafe(file) || readlinkSafe(file) || '', projectRoot);
  if (text === null) { entry.readable = false; results.push(entry); return results; }
  entry.bytes = Buffer.byteLength(text, 'utf8');
  entry.approxTokens = approxTokens(text.length);
  const resolvedList = [];
  for (const raw of parseImports(text)) {
    const abs = resolveImport(raw, file);
    const ok = isFile(abs);
    entry.imports.push({ raw, resolvedPath: displayPath(abs, projectRoot), resolves: ok });
    if (ok) resolvedList.push(abs);
  }
  entry.brokenImports = entry.imports.filter((i) => !i.resolves).length;
  results.push(entry);
  if (depth < 5) for (const abs of resolvedList) results.push(...describeInstructionFile(abs, projectRoot, seen, depth + 1));
  return results;
}

// ---------------------------------------------------------------------------------------------
// Settings, hooks, permissions, plugins, MCP
// ---------------------------------------------------------------------------------------------

function countHooks(hooks) {
  const out = {};
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks)) {
    let n = 0;
    if (Array.isArray(groups)) {
      for (const g of groups) {
        if (g && Array.isArray(g.hooks)) n += g.hooks.length;
        else if (g && (g.command || g.type)) n += 1;
      }
    }
    out[event] = n;
  }
  return out;
}

function mcpTransport(def) {
  if (!def || typeof def !== 'object') return 'unknown';
  const t = String(def.type || def.transport || '').toLowerCase();
  if (t === 'http' || t === 'sse' || t === 'streamable-http' || t === 'ws' || def.url || def.serverUrl) return 'remote';
  if (t === 'stdio' || def.command) return 'local';
  return 'unknown';
}

function mcpList(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj).map(([name, def]) => ({ name, transport: mcpTransport(def) })).sort((a, b) => a.name.localeCompare(b.name));
}

function summarizeSettings(file, projectRoot) {
  const r = readJsonSafe(file);
  const out = { path: displayPath(file, projectRoot), valid: r.ok };
  if (!r.ok) { out.error = r.error; return out; }
  const s = r.value && typeof r.value === 'object' ? r.value : {};
  const perms = s.permissions && typeof s.permissions === 'object' ? s.permissions : {};
  out.hooks = countHooks(s.hooks);
  out.hookCount = Object.values(out.hooks).reduce((a, b) => a + b, 0);
  out.permissions = {
    allow: Array.isArray(perms.allow) ? perms.allow.length : 0,
    deny: Array.isArray(perms.deny) ? perms.deny.length : 0,
    ask: Array.isArray(perms.ask) ? perms.ask.length : 0,
    defaultMode: typeof perms.defaultMode === 'string' ? perms.defaultMode : null,
    additionalDirectories: Array.isArray(perms.additionalDirectories) ? perms.additionalDirectories.length : 0,
  };
  if (s.skipDangerousModePermissionPrompt !== undefined) out.permissions.skipDangerousModePermissionPrompt = !!s.skipDangerousModePermissionPrompt;
  const ep = s.enabledPlugins && typeof s.enabledPlugins === 'object' ? s.enabledPlugins : {};
  out.plugins = {
    enabled: Object.keys(ep).filter((k) => ep[k] === true).sort(),
    disabled: Object.keys(ep).filter((k) => ep[k] !== true).sort(),
  };
  out.marketplaces = s.extraKnownMarketplaces && typeof s.extraKnownMarketplaces === 'object' ? Object.keys(s.extraKnownMarketplaces).sort() : [];
  out.mcpServers = mcpList(s.mcpServers);
  out.envVarCount = s.env && typeof s.env === 'object' ? Object.keys(s.env).length : 0; // names and values deliberately omitted
  out.statusLine = !!s.statusLine;
  out.outputStyle = typeof s.outputStyle === 'string' ? s.outputStyle : null;
  out.model = typeof s.model === 'string' ? s.model : null;
  return out;
}

function namesIn(dir, { dirsOnly = false, ext = null, requireFile = null } = {}) {
  const out = [];
  for (const e of readdirSafe(dir)) {
    const full = path.join(dir, e.name);
    const st = statSafe(full);
    if (!st) continue;
    if (dirsOnly) {
      if (!st.isDirectory()) continue;
      if (requireFile && !isFile(path.join(full, requireFile))) continue;
      out.push(e.name);
    } else if (st.isFile() && (!ext || ext.test(e.name))) out.push(e.name);
    else if (!ext && st.isDirectory()) out.push(`${e.name}/`);
  }
  return out.sort();
}

function skillsIn(dir, projectRoot) {
  const names = namesIn(dir, { dirsOnly: true, requireFile: 'SKILL.md' });
  return { path: isDir(dir) ? displayPath(dir, projectRoot) : null, count: names.length, names };
}

/** Top-level symlinks/junctions and hardlinked files of a config dir. */
function linksIn(dir) {
  const links = [];
  for (const e of readdirSafe(dir)) {
    const full = path.join(dir, e.name);
    const l = lstatSafe(full);
    if (!l) continue;
    if (l.isSymbolicLink()) {
      const target = realpathSafe(full);
      const raw = readlinkSafe(full);
      const st = statSafe(full);
      links.push({ name: e.name, type: st && st.isDirectory() ? 'symlink-dir' : 'symlink', target: displayPath(target || (raw ? path.resolve(dir, raw) : '')), targetExists: !!target });
    } else if (l.isFile() && l.nlink > 1) {
      let ino = null;
      try { const b = fs.statSync(full, { bigint: true }); ino = `${b.dev}:${b.ino}`; } catch { /* ignore */ }
      links.push({ name: e.name, type: 'hardlink', nlink: l.nlink, peers: [], _ino: ino, _abs: full });
    }
  }
  return links;
}

function backupFilesIn(dir) {
  return readdirSafe(dir).filter((e) => BACKUP_RE.test(e.name)).map((e) => e.name).sort();
}

function claudeJsonFor(dir) {
  const inside = path.join(dir, '.claude.json');
  if (isFile(inside)) return inside;
  const h = home();
  const isDefault = (realpathSafe(dir) || dir).toLowerCase() === (realpathSafe(path.join(h, '.claude')) || path.join(h, '.claude')).toLowerCase();
  if (isDefault && isFile(path.join(h, '.claude.json'))) return path.join(h, '.claude.json');
  return null;
}

function describeClaudeDir(d) {
  const dir = d.path;
  const dl = lstatSafe(dir);
  const out = {
    agent: d.agent,
    source: d.source,
    path: displayPath(dir),
    isLink: !!(dl && dl.isSymbolicLink()),
    realpath: displayPath(d.realpath),
    aliases: (d.aliases || []).map((a) => displayPath(a)),
    links: linksIn(dir),
    instructionFiles: [],
    settings: [],
    mcpServers: [],
    plugins: {},
    skills: skillsIn(path.join(dir, 'skills')),
    commands: namesIn(path.join(dir, 'commands'), { ext: /\.md$/i }),
    agents: namesIn(path.join(dir, 'agents'), { ext: /\.md$/i }),
    rules: namesIn(path.join(dir, 'rules')),
    outputStyles: namesIn(path.join(dir, 'output-styles'), { ext: /\.md$/i }),
    backupFiles: backupFilesIn(dir),
    hasProjectsDir: isDir(path.join(dir, 'projects')),
  };
  const seen = new Set();
  for (const n of INSTRUCTION_NAMES) {
    const f = path.join(dir, n);
    if (isFile(f)) out.instructionFiles.push(...describeInstructionFile(f, undefined, seen));
  }
  for (const n of ['settings.json', 'settings.local.json', 'managed-settings.json']) {
    const f = path.join(dir, n);
    if (isFile(f)) out.settings.push(summarizeSettings(f));
  }
  const cj = claudeJsonFor(dir);
  if (cj) {
    const r = readJsonSafe(cj);
    out.claudeJson = { path: displayPath(cj), valid: r.ok };
    if (r.ok && r.value) {
      out.mcpServers = mcpList(r.value.mcpServers);
      const projects = r.value.projects && typeof r.value.projects === 'object' ? r.value.projects : {};
      out.claudeJson.projectsWithMcpServers = Object.values(projects).filter((p) => p && p.mcpServers && Object.keys(p.mcpServers).length).length;
    }
  }
  const km = readJsonSafe(path.join(dir, 'plugins', 'known_marketplaces.json'));
  const ip = readJsonSafe(path.join(dir, 'plugins', 'installed_plugins.json'));
  out.plugins = {
    knownMarketplaces: km.ok && km.value && typeof km.value === 'object' ? Object.keys(km.value).sort() : [],
    installed: ip.ok && ip.value && typeof ip.value === 'object'
      ? Object.keys(ip.value.plugins && typeof ip.value.plugins === 'object' ? ip.value.plugins : ip.value).filter((k) => k !== 'version').sort()
      : [],
  };
  out.totals = {
    instructionTokens: out.instructionFiles.reduce((s, f) => s + (f.approxTokens || 0), 0),
    brokenImports: out.instructionFiles.reduce((s, f) => s + (f.brokenImports || 0), 0),
    hooks: out.settings.reduce((s, x) => s + (x.hookCount || 0), 0),
    skills: out.skills.count,
  };
  return out;
}

// ---------------------------------------------------------------------------------------------
// Codex, ~/.agents, desktop app
// ---------------------------------------------------------------------------------------------

/** Minimal TOML read: section headers for mcp_servers / plugins and whether each has url/command. */
export function scanCodexToml(text) {
  const servers = new Map();
  const plugins = new Set();
  const marketplaces = new Set();
  let current = null;
  for (const line of (text || '').split(/\r?\n/)) {
    const h = /^\s*\[\s*([^\]]+?)\s*\]\s*$/.exec(line);
    if (h) {
      const parts = h[1].match(/"[^"]*"|[^.]+/g)?.map((p) => p.replace(/^"|"$/g, '').trim()) || [];
      current = null;
      if (parts[0] === 'mcp_servers' && parts[1]) {
        if (!servers.has(parts[1])) servers.set(parts[1], { name: parts[1], transport: 'unknown' });
        current = parts.length === 2 ? servers.get(parts[1]) : null;
      } else if (parts[0] === 'plugins' && parts[1]) plugins.add(parts[1]);
      else if (parts[0] === 'marketplaces' && parts[1]) marketplaces.add(parts[1]);
      continue;
    }
    if (current) {
      if (/^\s*url\s*=/.test(line)) current.transport = 'remote';
      else if (/^\s*command\s*=/.test(line) && current.transport === 'unknown') current.transport = 'local';
    }
  }
  return { mcpServers: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name)), plugins: [...plugins].sort(), marketplaces: [...marketplaces].sort() };
}

function describeCodexDir(d) {
  const dir = d.path;
  const out = {
    agent: 'codex', source: d.source, path: displayPath(dir), realpath: displayPath(d.realpath),
    links: linksIn(dir), instructionFiles: [], backupFiles: backupFilesIn(dir),
    skills: skillsIn(path.join(dir, 'skills')),
    hasSessionsDir: isDir(path.join(dir, 'sessions')),
  };
  const seen = new Set();
  for (const n of ['AGENTS.md', 'AGENTS.override.md']) {
    const f = path.join(dir, n);
    if (isFile(f)) out.instructionFiles.push(...describeInstructionFile(f, undefined, seen));
  }
  const toml = readTextSafe(path.join(dir, 'config.toml'));
  out.config = toml === null ? null : { path: displayPath(path.join(dir, 'config.toml')), ...scanCodexToml(toml) };
  const hooks = readJsonSafe(path.join(dir, 'hooks.json'));
  if (hooks.ok) out.hooks = countHooks(hooks.value && hooks.value.hooks ? hooks.value.hooks : hooks.value);
  return out;
}

function describeAgentsDir(d) {
  return { agent: 'shared', path: displayPath(d.path), skills: skillsIn(path.join(d.path, 'skills')), links: linksIn(d.path) };
}

function describeDesktopConfig(file) {
  const r = readJsonSafe(file);
  const out = { path: displayPath(file), valid: r.ok, note: 'Written by a running app; edit only with the app closed.' };
  if (r.ok && r.value) out.mcpServers = mcpList(r.value.mcpServers);
  return out;
}

function fillHardlinkPeers(groups) {
  const byIno = new Map();
  for (const g of groups) for (const l of g.links || []) if (l.type === 'hardlink' && l._ino) {
    if (!byIno.has(l._ino)) byIno.set(l._ino, []);
    byIno.get(l._ino).push(l);
  }
  for (const list of byIno.values()) for (const l of list) l.peers = list.filter((x) => x !== l).map((x) => displayPath(x._abs));
  for (const g of groups) for (const l of g.links || []) { delete l._ino; delete l._abs; }
}

/**
 * The user-level harness locations. `account` (`{ provider, configDir }`) narrows it to one
 * account: nothing of any other config dir is opened, so a hardlink names only the peers it has
 * inside that dir.
 */
export function discoverUser(account = null) {
  const loc = userLocations(account);
  const claude = loc.claude.map(describeClaudeDir);
  const codex = loc.codex.map(describeCodexDir);
  const agents = loc.agents.map(describeAgentsDir);
  const all = [...claude, ...codex, ...agents];
  fillHardlinkPeers(all);
  return {
    configDirs: claude,
    codex,
    agentsDirs: agents,
    desktopConfigs: loc.desktop.map(describeDesktopConfig),
    env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ? 'set' : 'unset', CODEX_HOME: process.env.CODEX_HOME ? 'set' : 'unset' },
  };
}

// ---------------------------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------------------------

const STOPWORDS = {
  en: new Set('the and is are of to in that it for with this be on not you by from as or can when use an will should if which have was were has must'.split(' ')),
  pt: new Set('não nao uma um os da dos das é são mas mais ou pelo pela isso você voce ao à também tambem seu sua com em quando deve está esta já então porque'.split(' ')),
  es: new Set('el los las del y es con una pero más también está son al lo su sus esto cuando usted puede hay en muy porque entonces'.split(' ')),
};

/** Heuristic language of a prose text: `en`, `pt`, `es`, `mixed` or `unknown`. */
export function detectLanguage(text) {
  const prose = String(text || '')
    .replace(/^(```|~~~)[\s\S]*?^\1/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .toLowerCase();
  const words = prose.match(/[\p{L}]+/gu) || [];
  if (words.length < 20) return 'unknown';
  const hits = { en: 0, pt: 0, es: 0 };
  for (const w of words) for (const k of Object.keys(hits)) if (STOPWORDS[k].has(w)) hits[k]++;
  const ranked = Object.entries(hits).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (top[1] / words.length < 0.03) return 'unknown';
  if (second[1] >= top[1] * 0.5 && second[1] / words.length >= 0.03) return 'mixed';
  return top[0];
}

function walkFiles(root, { maxDepth, filter, enterDir }) {
  const out = [];
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    for (const e of readdirSafe(dir)) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && enterDir(e.name, full, depth + 1)) stack.push([full, depth + 1]);
      } else if (e.isFile() && filter(e.name, full, depth)) out.push(full);
    }
  }
  return out.sort();
}

function enterProjectDir(name) {
  if (SKIP_DIRS.has(name)) return false;
  if (name.startsWith('.') && !['.claude', '.github', '.cursor', '.agents', '.codex', '.gemini'].includes(name)) return false;
  return true;
}

function gitInfo(cwd) {
  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') return { isRepo: false };
  const t = (args) => { const r = git(cwd, args); return r.ok ? r.stdout.trim() : null; };
  const out = { isRepo: true };
  out.topLevel = displayPath(t(['rev-parse', '--show-toplevel']) || cwd, cwd);
  out.currentBranch = t(['branch', '--show-current']) || null;
  const remotes = (t(['remote']) || '').split(/\r?\n/).filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0] || null;
  out.remote = remote;
  out.remoteCount = remotes.length;
  let def = null;
  let defSource = null;
  if (remote) {
    const sym = t(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
    if (sym) { def = sym.replace(new RegExp(`^${remote}/`), ''); defSource = 'remote-head'; }
  }
  if (!def) {
    for (const c of ['main', 'master', 'trunk', 'develop']) {
      if (t(['rev-parse', '--verify', '--quiet', `refs/heads/${c}`]) || (remote && t(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${c}`]))) { def = c; defSource = 'guess'; break; }
    }
  }
  out.defaultBranch = def;
  out.defaultBranchSource = defSource;
  const counts = (range) => {
    const s = t(['rev-list', '--left-right', '--count', range]);
    if (!s) return null;
    const [a, b] = s.split(/\s+/).map(Number);
    return { ahead: a, behind: b };
  };
  out.upstream = t(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  out.headVsUpstream = out.upstream ? counts('HEAD...@{u}') : null;
  out.defaultVsRemote = def && remote && t(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${def}`]) && t(['rev-parse', '--verify', '--quiet', `refs/heads/${def}`])
    ? counts(`refs/heads/${def}...refs/remotes/${remote}/${def}`) : null;
  // No fetch: report how old the last fetch is so the caller knows how far to trust "behind".
  const gitDir = t(['rev-parse', '--absolute-git-dir']);
  const commonDir = t(['rev-parse', '--git-common-dir']);
  const commonAbs = commonDir ? path.resolve(cwd, commonDir) : gitDir;
  let fh = null;
  for (const d of [gitDir, commonAbs]) { if (d && isFile(path.join(d, 'FETCH_HEAD'))) { fh = path.join(d, 'FETCH_HEAD'); break; } }
  if (fh) {
    const ageH = (Date.now() - statSafe(fh).mtimeMs) / 3600000;
    out.lastFetch = { at: new Date(statSafe(fh).mtimeMs).toISOString(), ageHours: Math.round(ageH * 10) / 10, olderThanOneDay: ageH > 24 };
  } else out.lastFetch = { at: null, ageHours: null, olderThanOneDay: true, note: 'no FETCH_HEAD; remote refs may never have been fetched' };
  out.isWorktree = !!(gitDir && commonAbs && path.resolve(gitDir) !== path.resolve(commonAbs));
  out.lastCommitAt = t(['log', '-1', '--format=%cI']) || null;
  // Hooks
  const hooksPath = t(['config', '--get', 'core.hooksPath']);
  const hooksDir = hooksPath ? path.resolve(cwd, hooksPath) : commonAbs ? path.join(commonAbs, 'hooks') : null;
  out.hooks = {
    coreHooksPath: hooksPath ? displayPath(path.resolve(cwd, hooksPath), cwd) : null,
    dir: hooksDir ? displayPath(hooksDir, cwd) : null,
    active: hooksDir ? readdirSafe(hooksDir).filter((e) => e.isFile() && !e.name.endsWith('.sample')).map((e) => e.name).sort() : [],
  };
  if (hooksPath && commonAbs) out.hooks.ignoredDefaultDirHooks = readdirSafe(path.join(commonAbs, 'hooks')).filter((e) => e.isFile() && !e.name.endsWith('.sample')).map((e) => e.name).sort();
  out._remoteName = remote;
  return out;
}

function graphifyInfo(cwd, gi) {
  const dir = path.join(cwd, 'graphify-out');
  if (!isDir(dir)) return { exists: false };
  let latest = 0;
  const visit = (d, depth) => {
    for (const e of readdirSafe(d)) {
      const full = path.join(d, e.name);
      const st = statSafe(full);
      if (!st) continue;
      if (st.mtimeMs > latest) latest = st.mtimeMs;
      if (e.isDirectory() && depth < 2) visit(full, depth + 1);
    }
  };
  visit(dir, 0);
  const out = { exists: true, lastModifiedAt: latest ? new Date(latest).toISOString() : null };
  if (gi.isRepo) {
    out.lastCommitAt = gi.lastCommitAt;
    out.olderThanLastCommit = gi.lastCommitAt && latest ? latest < Date.parse(gi.lastCommitAt) : null;
    const tracked = git(cwd, ['ls-files', '--', 'graphify-out']);
    out.tracked = tracked.ok && tracked.stdout.trim().length > 0;
    out.ignored = git(cwd, ['check-ignore', '-q', 'graphify-out']).code === 0;
  }
  return out;
}

function ciFiles(cwd) {
  const out = [];
  for (const f of readdirSafe(path.join(cwd, '.github', 'workflows'))) if (/\.ya?ml$/i.test(f.name)) out.push(`./.github/workflows/${f.name}`);
  for (const f of ['.gitlab-ci.yml', 'azure-pipelines.yml', '.circleci/config.yml', 'bitbucket-pipelines.yml', 'Jenkinsfile', '.travis.yml', '.buildkite/pipeline.yml', '.drone.yml']) {
    if (isFile(path.join(cwd, f))) out.push(`./${f}`);
  }
  return out.sort();
}

function docKind(rel) {
  const base = path.basename(rel);
  if (INSTRUCTION_NAMES.includes(base)) return 'instructions';
  if (/^readme/i.test(base)) return 'readme';
  const segs = rel.split('/').map((s) => s.toLowerCase());
  if (segs.some((s) => s === 'adr' || s === 'adrs' || s === 'decisions')) return 'adr';
  if (segs.some((s) => s === 'specs' || s === 'spec')) return 'spec';
  if (segs.some((s) => s === 'plans' || s === 'rfcs' || s === 'rfc')) return 'plan';
  return 'doc';
}

function docsInventory(cwd, gi) {
  const files = new Set();
  for (const e of readdirSafe(cwd)) if (e.isFile() && (/^readme/i.test(e.name) || /\.(md|mdx|markdown|rst|adoc)$/i.test(e.name))) files.add(path.join(cwd, e.name));
  for (const base of ['docs', 'doc', 'documentation']) {
    for (const f of walkFiles(path.join(cwd, base), { maxDepth: 6, filter: (n) => DOC_EXT.test(n), enterDir: (n) => !SKIP_DIRS.has(n) })) files.add(f);
  }
  // Dirs named adr/specs/plans... anywhere up to depth 3.
  const stack = [[cwd, 0]];
  while (stack.length) {
    const [d, depth] = stack.pop();
    for (const e of readdirSafe(d)) {
      if (!e.isDirectory() || !enterProjectDir(e.name)) continue;
      const full = path.join(d, e.name);
      if (DOC_DIR_NAMES.has(e.name.toLowerCase())) {
        for (const f of walkFiles(full, { maxDepth: 4, filter: (n) => DOC_EXT.test(n), enterDir: (n) => !SKIP_DIRS.has(n) })) files.add(f);
      } else if (depth < 2) stack.push([full, depth + 1]);
    }
  }
  const sorted = [...files].sort();
  const truncated = sorted.length > MAX_DOCS;
  const list = sorted.slice(0, MAX_DOCS).map((abs) => {
    const rel = path.relative(cwd, abs).replace(/\\/g, '/');
    const st = statSafe(abs);
    const text = readTextSafe(abs, 512 * 1024);
    let lastCommitAt = null;
    if (gi.isRepo) {
      const r = git(cwd, ['log', '-1', '--format=%cI', '--', rel]);
      lastCommitAt = r.ok && r.stdout.trim() ? r.stdout.trim() : null;
    }
    return {
      path: `./${rel}`,
      kind: docKind(rel),
      bytes: st ? st.size : null,
      approxTokens: text === null ? null : approxTokens(text.length),
      lastCommitAt,
      modifiedAt: st ? new Date(st.mtimeMs).toISOString() : null,
      language: text === null ? 'unknown' : detectLanguage(text.slice(0, 64 * 1024)),
    };
  });
  return { count: sorted.length, truncated, files: list };
}

function envFiles(cwd, gi) {
  const out = [];
  for (const e of readdirSafe(cwd)) {
    if (!e.isFile() || !/^\.env(\..+)?$/i.test(e.name)) continue;
    const item = { name: e.name };
    if (gi.isRepo) {
      item.tracked = (git(cwd, ['ls-files', '--error-unmatch', '--', e.name]).code === 0);
      item.ignored = (git(cwd, ['check-ignore', '-q', '--', e.name]).code === 0);
    }
    out.push(item);
  }
  return out;
}

export function discoverProject(cwd) {
  const out = { root: './', name: path.basename(cwd) };
  // Instruction files at any depth up to 3.
  const instr = walkFiles(cwd, {
    maxDepth: 3,
    filter: (n, full) => INSTRUCTION_NAMES.includes(n) || /[\\/]\.github[\\/]copilot-instructions\.md$/i.test(full),
    enterDir: enterProjectDir,
  });
  const seen = new Set();
  out.instructionFiles = [];
  for (const f of instr) out.instructionFiles.push(...describeInstructionFile(f, cwd, seen));
  // Agent folders
  const dotClaude = path.join(cwd, '.claude');
  out.claudeDir = isDir(dotClaude) ? {
    settings: ['settings.json', 'settings.local.json'].filter((n) => isFile(path.join(dotClaude, n))).map((n) => summarizeSettings(path.join(dotClaude, n), cwd)),
    skills: skillsIn(path.join(dotClaude, 'skills'), cwd),
    commands: namesIn(path.join(dotClaude, 'commands'), { ext: /\.md$/i }),
    agents: namesIn(path.join(dotClaude, 'agents'), { ext: /\.md$/i }),
    rules: namesIn(path.join(dotClaude, 'rules')),
    hooksDir: namesIn(path.join(dotClaude, 'hooks')),
    worktrees: isDir(path.join(dotClaude, 'worktrees')) ? readdirSafe(path.join(dotClaude, 'worktrees')).filter((e) => e.isDirectory()).length : 0,
  } : null;
  out.agentsDir = isDir(path.join(cwd, '.agents')) ? { skills: skillsIn(path.join(cwd, '.agents', 'skills'), cwd) } : null;
  out.cursorRules = namesIn(path.join(cwd, '.cursor', 'rules'));
  const mcp = readJsonSafe(path.join(cwd, '.mcp.json'));
  out.mcpJson = mcp.ok ? { path: './.mcp.json', servers: mcpList(mcp.value && mcp.value.mcpServers) } : (isFile(path.join(cwd, '.mcp.json')) ? { path: './.mcp.json', valid: false } : null);
  // Project-scoped MCP servers recorded in the user's ~/.claude.json for this path.
  const uj = readJsonSafe(path.join(home(), '.claude.json'));
  out.userScopedProjectMcp = [];
  if (uj.ok && uj.value && uj.value.projects && typeof uj.value.projects === 'object') {
    for (const [k, v] of Object.entries(uj.value.projects)) {
      const a = normalizeInputPath(k);
      if ((IS_WIN ? a.toLowerCase() === cwd.toLowerCase() : a === cwd) && v) out.userScopedProjectMcp = mcpList(v.mcpServers);
    }
  }
  // Git
  const gi = gitInfo(cwd);
  delete gi._remoteName;
  out.git = gi;
  out.graphify = graphifyInfo(cwd, gi);
  out.ci = ciFiles(cwd);
  out.envFiles = envFiles(cwd, gi);
  out.docs = docsInventory(cwd, gi);
  const markers = [];
  for (const e of readdirSafe(cwd)) {
    if (!e.isFile()) continue;
    if (CODE_MARKERS.includes(e.name) || CODE_MARKER_GLOBS.some((re) => re.test(e.name))) markers.push(e.name);
  }
  out.isCode = markers.length > 0;
  out.codeMarkers = markers.sort();
  out.totals = {
    instructionTokens: out.instructionFiles.reduce((s, f) => s + (f.approxTokens || 0), 0),
    brokenImports: out.instructionFiles.reduce((s, f) => s + (f.brokenImports || 0), 0),
    docs: out.docs.count,
  };
  return out;
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  const scope = args.scope || 'both';
  if (!['user', 'project', 'both'].includes(scope)) { warn('--scope must be user, project or both'); process.exit(2); }
  const cwd = normalizeInputPath(args.cwd || process.cwd());
  if ((scope === 'project' || scope === 'both') && !isDir(cwd)) { warn('--cwd is not a directory'); process.exit(2); }
  const { account, error } = accountFromArgs(args);
  if (error) { warn(error); process.exit(2); }
  if (account && scope === 'project') { warn('--provider and --config-dir narrow the user scope; they have no meaning with --scope project'); process.exit(2); }
  const started = Date.now();
  const result = { generatedAt: new Date().toISOString(), scope, os: process.platform, home: '~' };
  if (account) result.account = { provider: account.provider, path: displayPath(account.configDir), supported: account.supported };
  if (scope === 'user' || scope === 'both') result.user = discoverUser(account);
  if (scope === 'project' || scope === 'both') result.project = discoverProject(cwd);
  result.durationMs = Date.now() - started;
  printJson(result);
}
