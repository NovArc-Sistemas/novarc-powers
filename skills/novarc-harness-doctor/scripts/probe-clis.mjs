#!/usr/bin/env node
// probe-clis.mjs --cwd <dir> [--catalog <path>] [--provider <p> --config-dir <dir>] [--tools-from <clis.json>]
//
// For every catalog tool with a `bin`: every match on PATH, version (first line, 120 chars),
// whether more than one distinct binary answers to the name, and whether `verifyArgs` exits 0.
// Also lists the package managers present and evaluates each tool's `signals` against the
// project. Never runs auth or login commands; never runs anything that is not a catalog
// version/verify call.
//
// The output has two parts. What is installed (`tools[]` without their signals, and
// `packageManagers`) is about the machine; the signals and `context` are about `--cwd` and about
// whose MCP servers are read.
//   --provider, --config-dir  read the user-level MCP servers of that one account and of no
//                             other; without them, of every account on the machine
//   --tools-from              take the machine part from an earlier output of this script
//                             instead of running every binary again; signals and context are
//                             always worked out anew
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IS_WIN, parseArgs, isMain, printJson, warn, displayPath, scrubText, normalizeInputPath,
  readJsonSafe, readTextSafe, isFile, isDir, statSafe, realpathSafe, readdirSafe, run, git, home,
} from './lib/common.mjs';
import { userLocations, accountFromArgs } from './lib/locations.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CATALOG = path.join(HERE, '..', 'references', 'catalog', 'tools.json');

/** Used when the catalog is missing or unreadable. */
export const BUILTIN_TOOLS = [
  { id: 'git', kind: 'cli', bin: 'git', versionArgs: ['--version'], signals: [] },
  { id: 'gh', kind: 'cli', bin: 'gh', versionArgs: ['--version'], signals: [{ type: 'remote', value: 'github.com' }] },
  { id: 'node', kind: 'cli', bin: 'node', versionArgs: ['--version'], signals: [{ type: 'file', value: 'package.json' }] },
  { id: 'python', kind: 'cli', bin: 'python', versionArgs: ['--version'], signals: [{ type: 'file', value: 'pyproject.toml' }] },
  { id: 'docker', kind: 'cli', bin: 'docker', versionArgs: ['--version'], signals: [{ type: 'file', value: 'Dockerfile' }] },
  { id: 'ripgrep', kind: 'cli', bin: 'rg', versionArgs: ['--version'], signals: [] },
  { id: 'jq', kind: 'cli', bin: 'jq', versionArgs: ['--version'], signals: [] },
];

export const PACKAGE_MANAGERS = ['winget', 'scoop', 'choco', 'brew', 'apt', 'npm', 'pnpm', 'pipx', 'uv', 'cargo'];

// Arguments we are willing to pass to a binary. Anything else is refused.
const SAFE_ARG = /^[A-Za-z0-9][A-Za-z0-9._:=/-]{0,63}$|^-{1,2}[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AUTH_ARG = /^(auth|login|logout|signin|sign-in|signout|token|tokens|whoami|credentials?)$/i;

function pathExts() {
  if (!IS_WIN) return [''];
  const raw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  return raw.split(';').filter(Boolean).map((e) => e.toLowerCase());
}

/**
 * Every file on PATH answering to `name`, in PATH order: `where <name>` on Windows (honours
 * PATHEXT), `which -a <name>` elsewhere. Both are run without a shell. If the lookup program
 * itself is unavailable, fall back to walking PATH in-process.
 */
export function whichAll(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(name)) return [];
  const r = IS_WIN ? run('where', [name], { timeout: 5000, cwd: path.parse(process.cwd()).root }) : run('which', ['-a', name], { timeout: 5000 });
  if (r.error === 'ENOENT') return walkPath(name);
  const seen = new Set();
  const out = [];
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const p = line.trim();
    if (!p || !path.isAbsolute(p)) continue;
    const key = IS_WIN ? p.toLowerCase() : p;
    if (seen.has(key) || !isFile(p)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** In-process PATH walk; used only when `where` / `which` cannot be run. */
export function walkPath(name) {
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = pathExts();
  const hasExt = IS_WIN && exts.includes(path.extname(name).toLowerCase());
  const out = [];
  const seen = new Set();
  for (const d of dirs) {
    const cands = IS_WIN ? (hasExt ? [name] : [...exts.map((e) => name + e), name]) : [name];
    for (const c of cands) {
      const full = path.join(d, c);
      const st = statSafe(full);
      if (!st || !st.isFile()) continue;
      if (!IS_WIN && !(st.mode & 0o111)) continue;
      const key = IS_WIN ? full.toLowerCase() : full;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(full);
    }
  }
  return out;
}

/**
 * Distinct programs behind the matches: same real directory + same stem counts once
 * (`npm`, `npm.cmd` and `npm.ps1` in one folder are one tool).
 */
function distinctPrograms(matches) {
  const set = new Set();
  for (const m of matches) {
    const rp = realpathSafe(m) || m;
    const stem = path.basename(rp, path.extname(rp));
    const key = `${path.dirname(rp)}|${stem}`;
    set.add(IS_WIN ? key.toLowerCase() : key);
  }
  return set.size;
}

function isSafeArgs(args) {
  return Array.isArray(args) && args.every((a) => typeof a === 'string' && SAFE_ARG.test(a));
}

function firstLine(s) {
  const line = String(s || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  return scrubText(line).slice(0, 120);
}

/** Run a resolved binary with catalog arguments. `.cmd`/`.bat` need a shell on Windows. */
function runBinary(file, args, timeout = 5000) {
  const ext = path.extname(file).toLowerCase();
  if (IS_WIN && (ext === '.cmd' || ext === '.bat')) {
    const cmdline = [`"${file}"`, ...args].join(' ');
    return run(cmdline, [], { shell: true, timeout });
  }
  return run(file, args, { timeout });
}

function pickExecutable(matches) {
  if (!IS_WIN) return matches[0];
  const exts = pathExts();
  return matches.find((m) => exts.includes(path.extname(m).toLowerCase())) || null;
}

export function probeTool(tool) {
  const res = { id: tool.id, kind: tool.kind || null, bin: tool.bin || null, installed: null, version: null, paths: [], collision: false, distinctBinaries: 0, verify: null };
  if (!tool.bin) return res; // plugins and other non-binary tools: nothing to resolve here
  const matches = whichAll(tool.bin);
  res.paths = matches.map((m) => displayPath(m));
  res.installed = matches.length > 0;
  res.distinctBinaries = distinctPrograms(matches);
  res.collision = res.distinctBinaries > 1;
  if (!matches.length) return res;
  const exe = pickExecutable(matches);
  if (!exe) { res.version = null; res.versionError = 'no-runnable-match'; return res; }
  const vArgs = tool.versionArgs || ['--version'];
  if (!isSafeArgs(vArgs) || vArgs.some((a) => AUTH_ARG.test(a))) {
    res.versionError = 'unsafe-args-refused';
  } else {
    const r = runBinary(exe, vArgs);
    if (r.error) res.versionError = r.error;
    else if (r.timedOut) res.versionError = 'timeout';
    res.version = firstLine(r.stdout) || firstLine(r.stderr) || null;
    res.versionExit = r.code;
  }
  if (tool.verifyArgs) {
    if (!isSafeArgs(tool.verifyArgs)) res.verify = 'skipped-unsafe-args';
    else if (tool.verifyArgs.some((a) => AUTH_ARG.test(a))) res.verify = 'skipped-auth';
    else {
      const r = runBinary(exe, tool.verifyArgs);
      res.verify = r.timedOut ? 'timeout' : r.ok ? 'pass' : 'fail';
      res.verifyExit = r.code;
    }
  }
  return res;
}

// ------------------------------------------------------------------------------------------
// Project signals
// ------------------------------------------------------------------------------------------

function globToRe(g) {
  return new RegExp(`^${g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/\\\\]*')}$`, IS_WIN ? 'i' : '');
}

function pathSignal(cwd, value, wantDir) {
  const v = String(value).replace(/\\/g, '/');
  if (!v.includes('*')) {
    const p = path.join(cwd, v);
    return wantDir ? isDir(p) : isFile(p);
  }
  // Single-level wildcard support: `*.csproj`, `infra/*.tf`.
  const dir = path.join(cwd, path.dirname(v));
  const re = globToRe(path.basename(v));
  return readdirSafe(dir).some((e) => re.test(e.name) && (wantDir ? e.isDirectory() : e.isFile()));
}

function packageDeps(cwd) {
  const pj = readJsonSafe(path.join(cwd, 'package.json'));
  if (!pj.ok || !pj.value || typeof pj.value !== 'object') return new Set();
  const names = new Set();
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const o = pj.value[k];
    if (o && typeof o === 'object') for (const n of Object.keys(o)) names.add(n);
  }
  return names;
}

function gitRemoteText(cwd) {
  const r = git(cwd, ['remote', '-v']);
  return r.ok ? r.stdout : '';
}

function mcpNamesFromObject(o, into) {
  if (o && typeof o === 'object' && o.mcpServers && typeof o.mcpServers === 'object') for (const n of Object.keys(o.mcpServers)) into.add(n);
}

/** Minimal TOML scan for `[mcp_servers.<name>]` headers (Codex). */
export function codexMcpNames(tomlText) {
  const names = new Set();
  if (!tomlText) return names;
  for (const line of tomlText.split(/\r?\n/)) {
    const m = /^\s*\[\s*mcp_servers\.("?)([^".\]]+)\1\s*\]/.exec(line);
    if (m) names.add(m[2]);
  }
  return names;
}

/**
 * MCP server names configured where this probe looks: the project files under `cwd`, and the
 * user level. Names only. Without `account` the user level is every account on the machine;
 * with `account` (`{ provider, configDir }`) it is that config dir alone: the state file in the
 * home folder (`~/.claude.json`) belongs to the default Claude account and is read only for it,
 * and the desktop app and the other providers are somebody else's.
 */
export function mcpServerNames(cwd, account = null) {
  const names = new Set();
  for (const f of ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json', '.cursor/mcp.json']) {
    const r = readJsonSafe(path.join(cwd, f));
    if (r.ok) mcpNamesFromObject(r.value, names);
  }
  const loc = userLocations(account);
  const h = home();
  const key = (p) => { const real = realpathSafe(p) || p; return IS_WIN ? real.toLowerCase() : real; };
  const defaultDir = key(path.join(h, '.claude'));
  let homeState = !account;
  for (const d of loc.claude) {
    for (const f of ['settings.json', 'settings.local.json', '.claude.json']) {
      const r = readJsonSafe(path.join(d.path, f));
      if (r.ok) mcpNamesFromObject(r.value, names);
    }
    if (key(d.path) === defaultDir) homeState = true;
  }
  const userJson = homeState ? readJsonSafe(path.join(h, '.claude.json')) : { ok: false };
  if (userJson.ok && userJson.value) {
    mcpNamesFromObject(userJson.value, names);
    const projects = userJson.value.projects;
    if (projects && typeof projects === 'object') {
      for (const [k, v] of Object.entries(projects)) {
        const a = normalizeInputPath(k);
        if ((IS_WIN ? a.toLowerCase() === cwd.toLowerCase() : a === cwd)) mcpNamesFromObject(v, names);
      }
    }
  }
  for (const d of loc.codex) for (const n of codexMcpNames(readTextSafe(path.join(d.path, 'config.toml')))) names.add(n);
  for (const f of loc.desktop) { const r = readJsonSafe(f); if (r.ok) mcpNamesFromObject(r.value, names); }
  return names;
}

export function evaluateSignals(tool, ctx) {
  const matched = [];
  const unknown = [];
  for (const s of tool.signals || []) {
    if (!s || typeof s !== 'object') continue;
    let hit = false;
    switch (s.type) {
      case 'file': hit = pathSignal(ctx.cwd, s.value, false); break;
      case 'dir': hit = pathSignal(ctx.cwd, s.value, true); break;
      case 'dep': {
        const v = String(s.value);
        hit = v.endsWith('*') ? [...ctx.deps].some((d) => d.startsWith(v.slice(0, -1))) : ctx.deps.has(v);
        break;
      }
      case 'remote': hit = ctx.remotes.toLowerCase().includes(String(s.value).toLowerCase()); break;
      case 'mcp': {
        const v = String(s.value).toLowerCase();
        hit = [...ctx.mcp].some((n) => n.toLowerCase() === v || n.toLowerCase().includes(v));
        break;
      }
      default: unknown.push(s.type);
    }
    if (hit) matched.push({ type: s.type, value: s.value });
  }
  return { matched, unknown };
}

export function loadCatalog(p) {
  const r = readJsonSafe(p);
  if (!r.ok) return { source: 'builtin', reason: r.error, tools: BUILTIN_TOOLS };
  const tools = r.value && Array.isArray(r.value.tools) ? r.value.tools.filter((t) => t && typeof t === 'object' && typeof t.id === 'string') : null;
  if (!tools) return { source: 'builtin', reason: 'no tools array', tools: BUILTIN_TOOLS };
  return { source: 'catalog', tools };
}

const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * The machine part of an earlier output of this script, to be used again: what each tool's
 * binary answered and which package managers are present. Entries are rebuilt field by field,
 * so nothing but what probeTool() writes is carried over, and an entry that does not look like
 * one is left out (its tool is probed again). Signals are never taken: they depend on where and
 * for whom the probe runs.
 */
export function machinePart(earlier) {
  const tools = new Map();
  for (const t of earlier && Array.isArray(earlier.tools) ? earlier.tools : []) {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !(t.installed === null || typeof t.installed === 'boolean')) continue;
    if (!(t.bin === null || typeof t.bin === 'string') || !isStrings(t.paths)) continue;
    const e = {
      id: t.id, kind: typeof t.kind === 'string' ? t.kind : null, bin: t.bin, installed: t.installed,
      version: typeof t.version === 'string' ? t.version : null, paths: t.paths, collision: t.collision === true,
      distinctBinaries: Number.isInteger(t.distinctBinaries) ? t.distinctBinaries : 0, verify: typeof t.verify === 'string' ? t.verify : null,
    };
    if (typeof t.versionError === 'string') e.versionError = t.versionError;
    for (const k of ['versionExit', 'verifyExit']) if (k in t && (t[k] === null || Number.isInteger(t[k]))) e[k] = t[k];
    tools.set(t.id, e);
  }
  const pms = earlier && Array.isArray(earlier.packageManagers) ? earlier.packageManagers : [];
  const managers = PACKAGE_MANAGERS.map((name) => pms.find((p) => p && p.name === name && typeof p.present === 'boolean' && isStrings(p.paths)));
  return { tools, packageManagers: managers.every(Boolean) ? managers.map((p) => ({ name: p.name, present: p.present, paths: p.paths })) : null };
}

/**
 * `account` (`{ provider, configDir, supported }`) narrows the user-level MCP servers to one
 * account. `reuse` is an earlier output of this function: its machine part is used again for
 * every tool the catalog still names with the same binary.
 */
export function probe({ cwd, catalogPath = DEFAULT_CATALOG, account = null, reuse = null }) {
  const cat = loadCatalog(catalogPath);
  const ctx = { cwd, deps: packageDeps(cwd), remotes: gitRemoteText(cwd), mcp: mcpServerNames(cwd, account) };
  const earlier = reuse ? machinePart(reuse) : null;
  let reused = 0;
  const tools = cat.tools.map((t) => {
    const known = earlier ? earlier.tools.get(t.id) : null;
    const same = !!known && known.bin === (t.bin || null);
    if (same) reused++;
    const pr = same ? known : probeTool(t);
    const sig = evaluateSignals(t, ctx);
    const out = { ...pr, signalsMatched: sig.matched };
    if (sig.unknown.length) out.unknownSignalTypes = [...new Set(sig.unknown)];
    return out;
  });
  const packageManagers = (earlier && earlier.packageManagers) || PACKAGE_MANAGERS.map((pm) => {
    const m = whichAll(pm);
    return { name: pm, present: m.length > 0, paths: m.map((x) => displayPath(x)) };
  });
  return {
    cwd: displayPath(cwd, cwd),
    os: process.platform,
    ...(account ? { account: { provider: account.provider, path: displayPath(account.configDir), supported: account.supported } } : {}),
    catalog: { source: cat.source, path: displayPath(catalogPath), ...(cat.reason ? { reason: cat.reason } : {}) },
    ...(earlier ? { toolsReused: reused } : {}),
    tools,
    packageManagers,
    context: { mcpServers: [...ctx.mcp].sort(), hasPackageJson: isFile(path.join(cwd, 'package.json')), gitRemoteHosts: remoteHosts(ctx.remotes) },
  };
}

function remoteHosts(text) {
  const hosts = new Set();
  for (const m of text.matchAll(/(?:@|:\/\/)([A-Za-z0-9.-]+\.[A-Za-z]{2,})[:/]/g)) hosts.add(m[1].toLowerCase());
  return [...hosts].sort();
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  const cwd = normalizeInputPath(args.cwd || process.cwd());
  if (!isDir(cwd)) { warn('--cwd is not a directory'); process.exit(2); }
  const { account, error } = accountFromArgs(args);
  if (error) { warn(error); process.exit(2); }
  let reuse = null;
  if (args['tools-from'] !== undefined) {
    const r = typeof args['tools-from'] === 'string' ? readJsonSafe(normalizeInputPath(args['tools-from'])) : { ok: false, error: 'needs a file path' };
    if (!r.ok || !r.value || typeof r.value !== 'object' || !Array.isArray(r.value.tools)) { warn(`--tools-from: ${r.ok ? 'not an output of this script' : r.error}`); process.exit(2); }
    reuse = r.value;
  }
  const catalogPath = args.catalog ? normalizeInputPath(args.catalog) : DEFAULT_CATALOG;
  if (args.catalog && !fs.existsSync(catalogPath)) warn('catalog not found; using the built-in list');
  printJson(probe({ cwd, catalogPath, account, reuse }));
}
