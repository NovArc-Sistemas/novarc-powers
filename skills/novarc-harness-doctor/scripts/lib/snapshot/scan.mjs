// Walks one harness (a project root, or one account's config dir) and registers its files and
// the raw facts the element views are built from. Read-only. Nothing here formats output:
// elements.mjs turns the raw facts into the schema's shape once file ids exist.
//
// lib/checks/collect.mjs reads the same things for the checks engine, but merges every account
// and drops a file a second account links to. A snapshot is per harness and must list those
// links, so the walk is done here and only collect's pure helpers are shared.
import path from 'node:path';
import {
  home, isDir, isFile, statSafe, readdirSafe, realpathSafe, readTextSafe, parseJsonSafe, normalizeInputPath, git, SKIP_DIRS,
} from '../common.mjs';
import { claudeConfigDirs, codexDirs, agentsDirs, encodeProjectPath } from '../locations.mjs';
import { parseImports, scanCodexToml, detectLanguage } from '../../discover.mjs';
import { hookScriptPath, resolveRef } from '../checks/collect.mjs';
import { frontmatter } from '../checks/util.mjs';
import { keyOf, under, gitHooksDir, readHead } from './project.mjs';

// Lower numbers keep their content first when the harness budget runs out. A file imported by
// an instruction file sits one step below the file that imports it.
export const PRIORITY = {
  instructions: 10, memory: 12, nested: 14, unloaded: 17,
  settings: 20, keybindings: 22, pluginRegistry: 25,
  hookFile: 30, hookScript: 31, pluginHookFile: 32, pluginHookScript: 33, supportScript: 35,
  gitHook: 40, gateConfig: 41, ci: 42,
  mcp: 50, agent: 60, command: 61, rule: 62, outputStyle: 63, skill: 70, doc: 90,
};

const INSTRUCTION_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md', 'GEMINI.md'];
const FOLLOWS_IMPORTS = /^(CLAUDE|GEMINI)(\.local)?\.md$/i;
const PROVIDER_INSTRUCTIONS = {
  'claude-code': ['CLAUDE.md'], codex: ['AGENTS.md', 'AGENTS.override.md'], gemini: ['GEMINI.md'],
  agents: ['AGENTS.md'], opencode: ['AGENTS.md'],
};
export const GIT_HOOK_NAMES = new Set([
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg',
  'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive',
  'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'post-index-change',
]);
const CI_FILES = ['.gitlab-ci.yml', 'azure-pipelines.yml', '.circleci/config.yml', 'bitbucket-pipelines.yml', 'Jenkinsfile', '.travis.yml', '.buildkite/pipeline.yml', '.drone.yml'];
const DOC_EXT = /\.(md|mdx|markdown|rst|txt|adoc)$/i;
const DOC_DIR_NAMES = new Set(['adr', 'adrs', 'decisions', 'specs', 'spec', 'plans', 'rfcs', 'rfc']);
const MAX_DOCS = 200;
const DOC_CONTENT_MAX = 16 * 1024;
const DOC_LANGUAGE_BYTES = 12 * 1024;
const MAX_SUPPORT_SCRIPTS = 30;
const MAX_NESTED = 40;

const str = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(', ') : '');
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function newScan({ kind, root, provider = null, files, loader }) {
  const configDirs = [...claudeConfigDirs(), ...codexDirs(), ...agentsDirs()];
  const scriptRoots = new Set([root, realpathSafe(root) || root]);
  for (const d of configDirs) { scriptRoots.add(d.path); scriptRoots.add(d.realpath || d.path); }
  return {
    kind, root, provider, files, loader,
    claudeDirs: claudeConfigDirs().map((d) => d.path),
    scriptRoots: [...scriptRoots],
    chains: [], settings: [], permissions: [], hooks: [], skills: [], agents: [], plugins: [], mcp: [], docs: [],
    rules: [], memory: [], outputStyles: [], activeOutputStyle: null, outputStyle: null,
  };
}

function jsonOf(ctx, abs) {
  const t = ctx.loader.text(abs);
  if (t === null) return null;
  const r = parseJsonSafe(t);
  return r.ok && r.value && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value : null;
}

/** JSON of a state file that is read for a few keys and never becomes a snapshot file. */
function stateJson(abs) {
  const t = readTextSafe(abs, 64 * 1024 * 1024);
  if (t === null) return null;
  const r = parseJsonSafe(t);
  return r.ok && r.value && typeof r.value === 'object' ? r.value : null;
}

/** Files under `dir` (linked folders included, each real folder once) whose name passes `test`. */
function walk(dir, maxDepth, test) {
  const out = [];
  const seen = new Set();
  const visit = (d, depth) => {
    const real = realpathSafe(d);
    if (!real || seen.has(keyOf(real))) return;
    seen.add(keyOf(real));
    for (const e of readdirSafe(d)) {
      const full = path.join(d, e.name);
      const st = statSafe(full);
      if (!st) continue;
      if (st.isDirectory()) { if (depth < maxDepth && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) visit(full, depth + 1); }
      else if (st.isFile() && test(e.name)) out.push(full);
    }
  };
  if (isDir(dir)) visit(dir, 1);
  return out.sort();
}

const scriptAllowed = (ctx, abs, extra = null) => ctx.scriptRoots.some((r) => under(abs, r)) || (extra !== null && under(abs, extra));

// ---------------------------------------------------------------------------------------------
// Instruction files and their imports
// ---------------------------------------------------------------------------------------------

function addChain(ctx, rootFile, { loaded, priority, follow }) {
  if (!isFile(rootFile)) return null;
  const chain = { root: path.resolve(rootFile), loaded, files: [], broken: 0 };
  const visited = new Set();
  const visit = (file, depth) => {
    const k = keyOf(realpathSafe(file) || file);
    if (visited.has(k)) return;
    visited.add(k);
    const e = ctx.files.add(file, { category: 'instructions', loaded, priority: depth ? priority + 1 : priority });
    if (!e) return;
    const text = ctx.loader.text(file);
    chain.files.push({ abs: e.abs, chars: text === null ? 0 : text.length });
    if (text === null || !follow || depth >= 5) return;
    for (const raw of parseImports(text)) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue;
      const target = resolveRef(raw, file);
      if (target && isFile(target)) visit(target, depth + 1);
      else chain.broken++;
    }
  };
  visit(rootFile, 0);
  ctx.chains.push(chain);
  return chain;
}

function nestedInstructionFiles(root) {
  const out = [];
  const stack = [[root, 0]];
  while (stack.length) {
    const [d, depth] = stack.pop();
    for (const e of readdirSafe(d)) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 3 && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push([full, depth + 1]); }
      else if (depth > 0 && e.isFile() && INSTRUCTION_NAMES.includes(e.name)) out.push(full);
    }
  }
  return out.sort().slice(0, MAX_NESTED);
}

// ---------------------------------------------------------------------------------------------
// Settings, permissions, hooks, MCP
// ---------------------------------------------------------------------------------------------

function mcpTransport(def) {
  if (!def || typeof def !== 'object') return 'unknown';
  const t = String(def.type || def.transport || '').toLowerCase();
  if (t === 'http' || t === 'sse' || t === 'streamable-http' || t === 'ws' || def.url || def.serverUrl || def.httpUrl) return 'remote';
  if (t === 'stdio' || def.command) return 'local';
  return 'unknown';
}

function addMcpServers(ctx, obj, { level, fileAbs = null, note = null }) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const name of Object.keys(obj).sort()) ctx.mcp.push({ name, level, transport: mcpTransport(obj[name]), fileAbs, note });
}

function addPermissions(ctx, perms, layer, fileAbs) {
  if (!perms || typeof perms !== 'object') return;
  for (const kind of ['allow', 'deny', 'ask']) {
    for (const rule of Array.isArray(perms[kind]) ? perms[kind] : []) if (typeof rule === 'string') ctx.permissions.push({ layer, kind, rule, fileAbs });
  }
  if (typeof perms.defaultMode === 'string') ctx.permissions.push({ layer, kind: 'mode', rule: perms.defaultMode, fileAbs });
}

/**
 * The script a command line runs, when it names a file inside the harness. `asFile: false` reads
 * it (to tell whether the hook can block) without listing it in the snapshot.
 */
function addCommandScript(ctx, command, { configDir, pluginRoot = null, priority, asFile = true }) {
  const where = { pluginRoot, projectRoot: ctx.kind === 'project' ? ctx.root : null, configDir };
  const abs = command ? hookScriptPath(command, where) : null;
  if (!abs) return { scriptAbs: null, scriptText: null, outside: false };
  if (!scriptAllowed(ctx, abs, pluginRoot)) return { scriptAbs: null, scriptText: null, outside: true };
  const e = asFile ? ctx.files.add(abs, { category: 'script', loaded: 'never', priority }) : null;
  return { scriptAbs: e ? e.abs : null, scriptText: ctx.loader.text(abs), outside: false };
}

/**
 * Hook registrations of a `hooks` object. Same walk as hookEntries() in lib/checks/collect.mjs,
 * plus the `args` array of the exec form (`"command": "pwsh", "args": ["-File", "x.ps1"]`), which
 * is where the script path is when a hook is written that way, and the three fields that decide
 * whether the hook can block at all (hookBlocking in elements.mjs reads them). From the Claude
 * Code hooks reference (https://code.claude.com/docs/en/hooks, read on 2026-11-23):
 *   `async`, `asyncRewake`: "Async hooks can't block or control Claude's behavior"; asyncRewake
 *     "runs in the background and wakes Claude on exit code 2".
 *   `onFailure`: "With `"block"` set, a failure does what exit code 2 does on that event, except
 *     on `PermissionRequest`, where it denies the request." "The field has no effect on" Stop,
 *     SubagentStop, TaskCompleted and TeammateIdle hooks, nor on background command hooks.
 * `asyncRewake` and `onFailure` are present only on a hook that sets them.
 */
export function hookList(hooksObj) {
  const out = [];
  if (!hooksObj || typeof hooksObj !== 'object') return out;
  for (const [event, groups] of Object.entries(hooksObj)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      const matcher = typeof g.matcher === 'string' ? g.matcher : '';
      const list = Array.isArray(g.hooks) ? g.hooks : (g.command || g.type ? [g] : []);
      for (const h of list) {
        if (!h || typeof h !== 'object') continue;
        const args = Array.isArray(h.args) ? h.args.filter((a) => typeof a === 'string') : [];
        const base = typeof h.command === 'string' ? h.command : '';
        const command = base ? [base, ...args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))].join(' ') : '';
        const entry = { event, matcher, type: h.type || 'command', command, async: h.async === true };
        if (h.asyncRewake === true) entry.asyncRewake = true;
        if (typeof h.onFailure === 'string') entry.onFailure = h.onFailure;
        out.push(entry);
      }
    }
  }
  return out;
}

function addAgentHooks(ctx, hooksObj, { fileAbs, configDir, source = 'agent', plugin = null, pluginRoot = null, asFile = true }) {
  for (const h of hookList(hooksObj)) {
    const s = addCommandScript(ctx, h.command, { configDir, pluginRoot, asFile, priority: plugin ? PRIORITY.pluginHookScript : PRIORITY.hookScript });
    ctx.hooks.push({ source, event: h.event, matcher: h.matcher, type: h.type, command: h.command, async: h.async, asyncRewake: h.asyncRewake, onFailure: h.onFailure, fileAbs, plugin, ...s });
  }
}

function addClaudeSettings(ctx, abs, layer, configDir) {
  const e = ctx.files.add(abs, { category: 'settings', loaded: 'always', priority: PRIORITY.settings });
  if (!e) return null;
  const j = jsonOf(ctx, abs);
  if (!j) return null;
  ctx.settings.push({ abs: e.abs, layer, json: j });
  addPermissions(ctx, j.permissions, layer, e.abs);
  addAgentHooks(ctx, j.hooks, { fileAbs: e.abs, configDir });
  addMcpServers(ctx, j.mcpServers, { level: layer === 'managed' ? 'user' : layer, fileAbs: e.abs });
  const sl = j.statusLine && typeof j.statusLine === 'object' && typeof j.statusLine.command === 'string' ? j.statusLine.command : null;
  if (sl) {
    const s = addCommandScript(ctx, sl, { configDir, priority: PRIORITY.hookScript });
    ctx.hooks.push({ source: 'agent', event: 'StatusLine', matcher: '', type: 'command', command: sl, fileAbs: e.abs, plugin: null, ...s });
  }
  if (typeof j.outputStyle === 'string' && j.outputStyle) ctx.activeOutputStyle = j.outputStyle;
  return j;
}

function addHooksFile(ctx, abs, configDir) {
  const e = ctx.files.add(abs, { category: 'hook', loaded: 'always', priority: PRIORITY.hookFile });
  if (!e) return;
  const j = jsonOf(ctx, abs);
  if (j) addAgentHooks(ctx, j.hooks && typeof j.hooks === 'object' ? j.hooks : j, { fileAbs: e.abs, configDir });
}

function addCodexConfig(ctx, abs, layer) {
  const e = ctx.files.add(abs, { category: 'settings', loaded: 'always', priority: PRIORITY.settings });
  if (!e) return;
  const text = ctx.loader.text(abs);
  if (text === null) return;
  const scan = scanCodexToml(text);
  for (const s of scan.mcpServers) ctx.mcp.push({ name: s.name, level: layer, transport: s.transport, fileAbs: e.abs, note: null });
  // `enabled = true|false` inside each `[plugins."name@marketplace"]` table.
  const enabled = new Map();
  let table = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^\s*\[\s*([^\]]+?)\s*\]\s*$/.exec(line);
    if (h) {
      const parts = (h[1].match(/"[^"]*"|[^.]+/g) || []).map((p) => p.replace(/^"|"$/g, '').trim());
      table = parts.length === 2 && parts[0] === 'plugins' ? parts[1] : null;
      continue;
    }
    const m = table === null ? null : /^\s*enabled\s*=\s*(true|false)\b/.exec(line);
    if (m) enabled.set(table, m[1] === 'true');
  }
  for (const key of scan.plugins) {
    const at = key.lastIndexOf('@');
    ctx.plugins.push({ name: at > 0 ? key.slice(0, at) : key, marketplace: at > 0 ? key.slice(at + 1) : null, enabled: enabled.has(key) ? enabled.get(key) : null, pinned: null, note: null });
  }
  const top = text.split(/^\s*\[/m)[0];
  for (const key of ['approval_policy', 'sandbox_mode']) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"'\\n]*)["']`, 'm').exec(top);
    if (m) ctx.permissions.push({ layer, kind: 'mode', rule: `${key} = ${m[1]}`, fileAbs: e.abs });
  }
}

function addMcpFile(ctx, abs, level, key) {
  const e = ctx.files.add(abs, { category: 'mcp', loaded: 'always', priority: PRIORITY.mcp });
  if (!e) return;
  const j = jsonOf(ctx, abs);
  if (j) addMcpServers(ctx, j[key] && typeof j[key] === 'object' ? j[key] : null, { level, fileAbs: e.abs });
}

/** The account state file that holds MCP servers added with `claude mcp add`. Read for names only. */
function claudeStateFile(dir) {
  const inside = path.join(dir, '.claude.json');
  if (isFile(inside)) return inside;
  const h = home();
  const def = path.join(h, '.claude');
  if (keyOf(realpathSafe(dir) || dir) === keyOf(realpathSafe(def) || def) && isFile(path.join(h, '.claude.json'))) return path.join(h, '.claude.json');
  return null;
}

function addStateMcp(ctx) {
  const seen = new Set();
  const dirs = ctx.kind === 'user' ? [ctx.root] : ctx.claudeDirs;
  for (const dir of dirs) {
    const f = claudeStateFile(dir);
    if (!f || seen.has(keyOf(realpathSafe(f) || f))) continue;
    seen.add(keyOf(realpathSafe(f) || f));
    const j = stateJson(f);
    if (!j) continue;
    const note = `kept in ${ctx.files.display(f)}, which is not part of the snapshot`;
    if (ctx.kind === 'user') { addMcpServers(ctx, j.mcpServers, { level: 'user', note }); continue; }
    const projects = j.projects && typeof j.projects === 'object' ? j.projects : {};
    for (const [k, v] of Object.entries(projects)) {
      if (v && typeof v === 'object' && keyOf(normalizeInputPath(k)) === keyOf(ctx.root)) addMcpServers(ctx, v.mcpServers, { level: 'local', note });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Agents, commands, rules, output styles, skills
// ---------------------------------------------------------------------------------------------

function addAgents(ctx, dir, level, { plugin = null } = {}) {
  for (const f of walk(dir, 2, (n) => /\.(md|toml)$/i.test(n))) {
    const text = ctx.loader.text(f);
    if (text === null) continue;
    const e = plugin ? null : ctx.files.add(f, { category: 'agent', loaded: 'on-demand', priority: PRIORITY.agent });
    if (/\.toml$/i.test(f)) {
      const model = /^\s*model\s*=\s*["']([^"'\n]*)["']/m.exec(text);
      const desc = /^\s*description\s*=\s*["']([^"'\n]*)["']/m.exec(text);
      ctx.agents.push({ name: path.basename(f).replace(/\.toml$/i, ''), level, plugin, model: model ? model[1] : '', tools: '', description: desc ? desc[1] : '', promptChars: text.length, fileAbs: e ? e.abs : null });
      continue;
    }
    const fm = frontmatter(text);
    ctx.agents.push({
      name: str(fm.data.name) || path.basename(f).replace(/\.md$/i, ''), level, plugin, model: str(fm.data.model), tools: str(fm.data.tools),
      description: str(fm.data.description), promptChars: fm.body.length, fileAbs: e ? e.abs : null,
    });
  }
}

function addCommands(ctx, dir, test = (n) => /\.md$/i.test(n)) {
  for (const f of walk(dir, 3, test)) ctx.files.add(f, { category: 'command', loaded: 'on-demand', priority: PRIORITY.command });
}

function addRules(ctx, dir, test = (n) => /\.md$/i.test(n)) {
  for (const f of walk(dir, 3, test)) {
    const text = ctx.loader.text(f);
    const fm = frontmatter(text || '');
    // A rule scoped to paths (or a Cursor rule without alwaysApply) loads only when it applies.
    const scoped = fm.data.paths !== undefined || fm.data.globs !== undefined || (/\.mdc$/i.test(f) && String(fm.data.alwaysApply) !== 'true');
    const e = ctx.files.add(f, { category: 'rule', loaded: scoped ? 'on-demand' : 'always', priority: PRIORITY.rule });
    if (e && !scoped && text !== null) ctx.rules.push({ abs: e.abs, chars: text.length });
  }
}

function addOutputStyles(ctx, dir) {
  for (const f of walk(dir, 1, (n) => /\.md$/i.test(n))) {
    const text = ctx.loader.text(f);
    const e = ctx.files.add(f, { category: 'other', loaded: 'on-demand', priority: PRIORITY.outputStyle });
    if (e && text !== null) ctx.outputStyles.push({ abs: e.abs, entry: e, name: str(frontmatter(text).data.name) || path.basename(f).replace(/\.md$/i, ''), chars: text.length });
  }
}

function addSkills(ctx, dir, level, { plugin = null } = {}) {
  const ents = readdirSafe(dir).slice().sort(byName);
  for (const d of ents) {
    const file = path.join(dir, d.name, 'SKILL.md');
    if (!isDir(path.join(dir, d.name)) || !isFile(file)) continue;
    const text = ctx.loader.text(file);
    const fm = frontmatter(text || '');
    const e = plugin ? null : ctx.files.add(file, { category: 'skill', loaded: 'on-demand', priority: PRIORITY.skill });
    ctx.skills.push({ name: str(fm.data.name) || d.name, dirName: d.name, level, plugin, description: str(fm.data.description), fileAbs: e ? e.abs : null });
  }
}

// ---------------------------------------------------------------------------------------------
// Claude Code plugins
// ---------------------------------------------------------------------------------------------

function marketplacePinned(def) {
  const src = def && typeof def.source === 'object' && def.source ? def.source : null;
  if (!src) return null;
  return /^[0-9a-f]{40}$/i.test(String(src.ref || src.sha || src.commit || ''));
}

/**
 * Plugins the harness enables: one element each, plus the skills, agents, hooks and MCP servers
 * of the install that loads. `registries` are the config dirs whose plugins/ folder may hold the
 * install records; `listInstalled` also lists installed plugins that are switched off.
 */
function addClaudePlugins(ctx, { registries, listInstalled }) {
  const enabled = new Map();
  const markets = new Map();
  for (const s of ctx.settings) {
    const ep = s.json.enabledPlugins && typeof s.json.enabledPlugins === 'object' ? s.json.enabledPlugins : {};
    for (const [k, v] of Object.entries(ep)) enabled.set(k, v === true);
    const ek = s.json.extraKnownMarketplaces && typeof s.json.extraKnownMarketplaces === 'object' ? s.json.extraKnownMarketplaces : {};
    for (const [k, v] of Object.entries(ek)) markets.set(k, v || {});
  }
  const installs = new Map();
  const seenReg = new Set();
  for (const dir of registries) {
    const pdir = path.join(dir, 'plugins');
    const real = realpathSafe(pdir);
    if (!real || seenReg.has(keyOf(real))) continue;
    seenReg.add(keyOf(real));
    if (ctx.kind === 'user') {
      for (const n of ['installed_plugins.json', 'known_marketplaces.json']) ctx.files.add(path.join(pdir, n), { category: 'plugin', loaded: 'never', priority: PRIORITY.pluginRegistry });
    }
    const km = stateJson(path.join(pdir, 'known_marketplaces.json'));
    if (km) for (const [k, v] of Object.entries(km)) if (!markets.has(k)) markets.set(k, v || {});
    const ip = stateJson(path.join(pdir, 'installed_plugins.json'));
    const list = ip ? (ip.plugins && typeof ip.plugins === 'object' ? ip.plugins : ip) : {};
    for (const [k, v] of Object.entries(list || {})) {
      if (k === 'version' || installs.has(k)) continue;
      const entries = (Array.isArray(v) ? v : [v]).filter((i) => i && typeof i.installPath === 'string');
      // One install loads per plugin: the user-scope one, or the one recorded for this project.
      const ok = entries.filter((i) => !i.projectPath || (ctx.kind === 'project' && keyOf(normalizeInputPath(i.projectPath)) === keyOf(ctx.root)));
      const pick = ok.sort((a, b) => String(a.lastUpdated || '').localeCompare(String(b.lastUpdated || ''))).slice(-1)[0];
      if (pick) installs.set(k, { dir, root: normalizeInputPath(pick.installPath), version: typeof pick.version === 'string' ? pick.version : null });
    }
  }
  const keys = new Set(enabled.keys());
  if (listInstalled) for (const k of installs.keys()) keys.add(k);
  for (const key of [...keys].sort()) {
    const at = key.lastIndexOf('@');
    const name = at > 0 ? key.slice(0, at) : key;
    const marketplace = at > 0 ? key.slice(at + 1) : null;
    const inst = installs.get(key) || null;
    const def = marketplace ? markets.get(marketplace) : null;
    const notes = [];
    if (inst && inst.version) notes.push(`version ${inst.version}`);
    if (def && def.autoUpdate === true) notes.push('marketplace auto-updates');
    if (enabled.get(key) === true && !inst) notes.push('enabled but no install record found');
    ctx.plugins.push({ name, marketplace, enabled: enabled.get(key) === true, pinned: def ? marketplacePinned(def) : null, note: notes.join('; ') || null });
    if (enabled.get(key) !== true || !inst || !isDir(inst.root)) continue;
    const root = inst.root;
    addSkills(ctx, path.join(root, 'skills'), 'plugin', { plugin: name });
    addAgents(ctx, path.join(root, 'agents'), 'plugin', { plugin: name });
    // A user harness lists the plugin's hook registration and scripts as files; a project that
    // merely enables the plugin gets the hooks as elements only.
    const asFile = ctx.kind === 'user';
    const hk = path.join(root, 'hooks', 'hooks.json');
    const e = asFile ? ctx.files.add(hk, { category: 'hook', loaded: 'always', priority: PRIORITY.pluginHookFile }) : null;
    const hj = isFile(hk) ? jsonOf(ctx, hk) : null;
    if (hj) addAgentHooks(ctx, hj.hooks && typeof hj.hooks === 'object' ? hj.hooks : hj, { fileAbs: e ? e.abs : null, configDir: inst.dir, source: 'plugin', plugin: name, pluginRoot: root, asFile });
    const note = `from plugin ${name}`;
    const pm = isFile(path.join(root, '.mcp.json')) ? jsonOf(ctx, path.join(root, '.mcp.json')) : null;
    if (pm) addMcpServers(ctx, pm.mcpServers && typeof pm.mcpServers === 'object' ? pm.mcpServers : pm, { level: 'plugin', note });
    const pj = isFile(path.join(root, '.claude-plugin', 'plugin.json')) ? jsonOf(ctx, path.join(root, '.claude-plugin', 'plugin.json')) : null;
    if (pj && pj.mcpServers && typeof pj.mcpServers === 'object') addMcpServers(ctx, pj.mcpServers, { level: 'plugin', note });
  }
}

// ---------------------------------------------------------------------------------------------
// Scripts and docs that instruction files point at
// ---------------------------------------------------------------------------------------------

const PATH_HEAD = '(?:~[\\\\/]|\\.{1,2}[\\\\/]|[\\\\/]|[A-Za-z]:[\\\\/])?';
const SEG = '[A-Za-z0-9_.@-]+';
const SCRIPT_REF = new RegExp(`(${PATH_HEAD}(?:${SEG}[\\\\/])+${SEG}\\.(?:sh|bash|zsh|ps1|py|mjs|cjs|js|rb))(?![A-Za-z0-9_])`, 'g');
const DOC_REF = new RegExp(`(${PATH_HEAD}(?:${SEG}[\\\\/])*${SEG}\\.(?:md|mdx|markdown|rst|txt|adoc))(?![A-Za-z0-9_])`, 'g');
const SCRIPT_DIR = /(^|[\\/])(scripts?|bin|tools|hooks|\.claude|\.codex|\.agents|\.githooks|\.husky)[\\/]/i;
const RUNNER_BEFORE = /(?:^|[\s`'"(])(?:bash|sh|zsh|node|python3?|py|pwsh|powershell|ruby|deno|bun|source)\s+["']?$/;

function refsIn(text, re) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    if (/[A-Za-z0-9_]$/.test(before) || /:\/{1,2}\S*$/.test(before)) continue; // middle of a word, or inside a URL
    out.push({ raw: m[1].replace(/^@/, ''), before });
  }
  return out;
}

function resolveMention(ctx, raw, fromFile) {
  const direct = resolveRef(raw, fromFile);
  if (direct && isFile(direct)) return direct;
  if (/^(~|[\\/]|[A-Za-z]:)/.test(raw)) return null;
  const fromRoot = path.resolve(ctx.root, raw);
  return isFile(fromRoot) ? fromRoot : null;
}

function addSupportScripts(ctx) {
  let n = 0;
  for (const chain of ctx.chains) {
    if (chain.loaded === 'never') continue;
    for (const f of chain.files) {
      const text = ctx.loader.text(f.abs);
      if (text === null) continue;
      for (const ref of refsIn(text, SCRIPT_REF)) {
        if (n >= MAX_SUPPORT_SCRIPTS) return;
        if (!SCRIPT_DIR.test(ref.raw) && !RUNNER_BEFORE.test(ref.before)) continue;
        const abs = resolveMention(ctx, ref.raw, f.abs);
        if (!abs || /[\\/]node_modules[\\/]/.test(abs) || !scriptAllowed(ctx, abs) || ctx.files.get(abs)) continue;
        if (ctx.files.add(abs, { category: 'script', loaded: 'on-demand', priority: PRIORITY.supportScript })) n++;
      }
    }
  }
}

function docFiles(root) {
  const files = new Set();
  const enter = (n) => !SKIP_DIRS.has(n) && !n.startsWith('.');
  const collect = (dir, maxDepth) => {
    const stack = [[dir, 0]];
    while (stack.length) {
      const [d, depth] = stack.pop();
      for (const e of readdirSafe(d)) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (depth < maxDepth && enter(e.name)) stack.push([full, depth + 1]); }
        else if (e.isFile() && DOC_EXT.test(e.name)) files.add(full);
      }
    }
  };
  for (const e of readdirSafe(root)) if (e.isFile() && (/^readme/i.test(e.name) || /\.(md|mdx|markdown|rst|adoc)$/i.test(e.name))) files.add(path.join(root, e.name));
  for (const base of ['docs', 'doc', 'documentation']) if (isDir(path.join(root, base))) collect(path.join(root, base), 6);
  const stack = [[root, 0]];
  while (stack.length) {
    const [d, depth] = stack.pop();
    for (const e of readdirSafe(d)) {
      if (!e.isDirectory() || !enter(e.name)) continue;
      const full = path.join(d, e.name);
      if (DOC_DIR_NAMES.has(e.name.toLowerCase())) collect(full, 4);
      else if (depth < 2) stack.push([full, depth + 1]);
    }
  }
  return [...files].filter((f) => !INSTRUCTION_NAMES.includes(path.basename(f))).sort();
}

/**
 * Last commit date per path (relative to `root`), from one `git log` over the folders the docs
 * live in. Bounded in commits and in time: a doc git does not reach in time has no date.
 */
function lastCommits(root, rels) {
  const out = new Map();
  const specs = [...new Set(rels.map((r) => r.split('/')[0]))].slice(0, 60);
  if (!specs.length) return out;
  const r = git(root, ['-c', 'core.quotepath=false', 'log', '--relative', '--name-only', '--format=%x00%cI', '-n', '3000', '--', ...specs], 8000);
  if (!r.ok) return out;
  for (const chunk of r.stdout.split('\u0000')) {
    const lines = chunk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    for (const p of lines.slice(1)) if (!out.has(p)) out.set(p, lines[0]);
  }
  return out;
}

function addDocs(ctx) {
  const all = docFiles(ctx.root);
  const always = new Set();
  const mentioned = new Set();
  for (const chain of ctx.chains) {
    if (chain.loaded === 'never') continue;
    for (const f of chain.files) {
      if (chain.loaded === 'always') always.add(keyOf(f.abs));
      const text = ctx.loader.text(f.abs);
      if (text === null) continue;
      for (const ref of refsIn(text, DOC_REF)) {
        const abs = resolveMention(ctx, ref.raw, f.abs);
        if (abs) mentioned.add(keyOf(abs));
      }
    }
  }
  // A project with more docs than the list holds keeps the ones the instructions point at,
  // then the ones nearest the root.
  const depth = (abs) => path.relative(ctx.root, abs).split(/[\\/]/).length;
  const rank = (abs) => (always.has(keyOf(abs)) || mentioned.has(keyOf(abs)) ? 0 : 1);
  const list = all.length <= MAX_DOCS ? all
    : [...all].sort((a, b) => rank(a) - rank(b) || depth(a) - depth(b) || (a < b ? -1 : 1)).slice(0, MAX_DOCS).sort();
  const rels = list.map((abs) => path.relative(ctx.root, abs).replace(/\\/g, '/'));
  const commits = lastCommits(ctx.root, rels);
  list.forEach((abs, i) => {
    const st = statSafe(abs);
    // The first kilobytes say which language a document is written in; the rest is not read.
    const head = readHead(abs, DOC_LANGUAGE_BYTES);
    let entry = ctx.files.get(abs);
    if (!entry && mentioned.has(keyOf(abs)) && st && st.size < DOC_CONTENT_MAX) entry = ctx.files.add(abs, { category: 'doc', loaded: 'on-demand', priority: PRIORITY.doc });
    ctx.docs.push({
      abs, bytes: st ? st.size : null, language: head === null || head.includes('\u0000') ? 'unknown' : detectLanguage(head),
      lastCommit: commits.get(rels[i]) || null, status: always.has(keyOf(abs)) ? 'always-loaded' : 'unchecked', fileAbs: entry ? entry.abs : null,
    });
  });
  ctx.docsTotal = all.length;
}

// ---------------------------------------------------------------------------------------------
// Gates: git hooks, hook frameworks, CI
// ---------------------------------------------------------------------------------------------

function addGitHooks(ctx) {
  const dir = gitHooksDir(ctx.root);
  // Husky points git at generated shims in `.husky/_`; the hooks people write sit one level up.
  const shims = dir && path.basename(dir) === '_' && path.basename(path.dirname(dir)) === '.husky';
  if (dir && !shims) {
    for (const e of readdirSafe(dir).slice().sort(byName)) {
      const full = path.join(dir, e.name);
      if (e.name.endsWith('.sample') || !isFile(full)) continue;
      const entry = ctx.files.add(full, { category: 'gate', loaded: 'never', priority: PRIORITY.gitHook });
      if (entry && GIT_HOOK_NAMES.has(e.name)) ctx.hooks.push({ source: 'git', event: e.name, fileAbs: entry.abs });
    }
  }
  for (const e of readdirSafe(path.join(ctx.root, '.husky')).slice().sort(byName)) {
    const full = path.join(ctx.root, '.husky', e.name);
    if (!GIT_HOOK_NAMES.has(e.name) || !isFile(full)) continue;
    const entry = ctx.files.add(full, { category: 'gate', loaded: 'never', priority: PRIORITY.gitHook });
    if (entry && !ctx.hooks.some((h) => h.source === 'git' && h.fileAbs === entry.abs)) ctx.hooks.push({ source: 'git', event: e.name, fileAbs: entry.abs, note: 'husky' });
  }
  const pc = ctx.files.add(path.join(ctx.root, '.pre-commit-config.yaml'), { category: 'gate', loaded: 'never', priority: PRIORITY.gateConfig });
  if (pc) ctx.hooks.push({ source: 'git', event: 'pre-commit', fileAbs: pc.abs, note: 'pre-commit framework config; active only where `pre-commit install` was run' });
  for (const n of ['lefthook.yml', '.lefthook.yml', 'lefthook.yaml']) {
    const lh = ctx.files.add(path.join(ctx.root, n), { category: 'gate', loaded: 'never', priority: PRIORITY.gateConfig });
    if (!lh) continue;
    const text = ctx.loader.text(lh.abs) || '';
    for (const m of text.matchAll(/^([a-z][a-z-]+):/gm)) if (GIT_HOOK_NAMES.has(m[1])) ctx.hooks.push({ source: 'git', event: m[1], fileAbs: lh.abs, note: 'lefthook config; active only where `lefthook install` was run' });
  }
}

const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2');
const stripComment = (s) => s.replace(/\s+#.*$/, '').trim();
const inlineList = (s) => (s.startsWith('[') ? s.replace(/^\[|\].*$/g, '').split(',').map(unquote).filter(Boolean) : null);

/** Triggers and job ids of a GitHub Actions workflow, from its text (no YAML library). */
export function parseWorkflow(text) {
  const out = { name: null, triggers: [], jobs: [] };
  let section = null;
  let childIndent = null;
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      const m = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w-]*))\s*:\s*(.*)$/.exec(raw);
      section = m ? (m[1] || m[2] || m[3]) : null;
      childIndent = null;
      current = null;
      if (!m) continue;
      const rest = stripComment(m[4]);
      if (section === 'name') out.name = unquote(rest);
      if (section === 'on' && rest) for (const ev of inlineList(rest) || [unquote(rest)]) out.triggers.push({ event: ev });
      continue;
    }
    if (childIndent === null) childIndent = indent;
    if (section === 'on') {
      if (indent === childIndent) {
        const m = /^\s*(?:-\s*)?["']?([A-Za-z_][\w-]*)["']?\s*:?/.exec(raw);
        current = m ? { event: m[1] } : null;
        if (current && current.event !== 'schedule') out.triggers.push(current);
      } else if (current && current.event === 'schedule') {
        const c = /cron\s*:\s*(.+)$/.exec(raw);
        if (c) out.triggers.push({ event: unquote(stripComment(c[1])), schedule: true });
      } else if (current && !current.filter) {
        const b = /^\s*(branches|tags|paths)\s*:\s*(.+)$/.exec(raw);
        const vals = b ? inlineList(stripComment(b[2])) : null;
        if (vals && vals.length) current.filter = `${b[1]}: ${vals.join(', ')}`;
      }
    } else if (section === 'jobs' && indent === childIndent) {
      const m = /^\s*["']?([A-Za-z_][\w-]*)["']?\s*:/.exec(raw);
      if (m) out.jobs.push(m[1]);
    }
  }
  return out;
}

function addCi(ctx) {
  const wdir = path.join(ctx.root, '.github', 'workflows');
  for (const e of readdirSafe(wdir).slice().sort(byName)) {
    if (!/\.ya?ml$/i.test(e.name)) continue;
    const entry = ctx.files.add(path.join(wdir, e.name), { category: 'gate', loaded: 'never', priority: PRIORITY.ci });
    if (!entry) continue;
    const wf = parseWorkflow(ctx.loader.text(entry.abs) || '');
    const command = wf.jobs.length ? `jobs: ${wf.jobs.join(', ')}` : '';
    const triggers = wf.triggers.length ? wf.triggers : [{ event: 'unknown' }];
    for (const t of triggers) ctx.hooks.push({ source: 'ci', event: t.event, matcher: t.filter || '', command, fileAbs: entry.abs, note: wf.name ? `workflow ${wf.name}` : null });
  }
  for (const rel of CI_FILES) {
    const entry = ctx.files.add(path.join(ctx.root, rel), { category: 'gate', loaded: 'never', priority: PRIORITY.ci });
    if (entry) ctx.hooks.push({ source: 'ci', event: 'pipeline', fileAbs: entry.abs });
  }
}

// ---------------------------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------------------------

function addMemoryFile(ctx, abs, seen) {
  const real = realpathSafe(abs);
  if (!real || seen.has(keyOf(real))) return;
  seen.add(keyOf(real));
  const e = ctx.files.add(abs, { category: 'memory', loaded: 'always', priority: PRIORITY.memory });
  const text = e ? ctx.loader.text(abs) : null;
  if (e) ctx.memory.push({ abs: e.abs, chars: text === null ? 0 : text.length });
}

/** Claude Code keeps a project's auto-memory index in the account's config dir, keyed by the cwd. */
function addProjectMemory(ctx) {
  const seen = new Set();
  const names = new Set([encodeProjectPath(ctx.root), encodeProjectPath(realpathSafe(ctx.root) || ctx.root)]);
  for (const dir of ctx.claudeDirs) for (const n of names) addMemoryFile(ctx, path.join(dir, 'projects', n, 'memory', 'MEMORY.md'), seen);
}

/** The output style the harness's own settings select enters every session. */
function applyOutputStyle(ctx) {
  const want = ctx.activeOutputStyle ? ctx.activeOutputStyle.toLowerCase() : null;
  const style = want ? ctx.outputStyles.find((s) => s.name.toLowerCase() === want || path.basename(s.abs).toLowerCase() === `${want}.md`) : null;
  if (!style) return;
  style.entry.loaded = 'always';
  ctx.outputStyle = style;
}

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

export function scanProject(ctx) {
  const root = ctx.root;
  const dc = path.join(root, '.claude');
  for (const rel of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursorrules']) {
    addChain(ctx, path.join(root, rel), { loaded: 'always', priority: PRIORITY.instructions, follow: FOLLOWS_IMPORTS.test(path.basename(rel)) });
  }
  for (const f of nestedInstructionFiles(root)) addChain(ctx, f, { loaded: 'on-demand', priority: PRIORITY.nested, follow: FOLLOWS_IMPORTS.test(path.basename(f)) });
  addProjectMemory(ctx);

  addClaudeSettings(ctx, path.join(dc, 'settings.json'), 'project', dc);
  addClaudeSettings(ctx, path.join(dc, 'settings.local.json'), 'local', dc);
  addCodexConfig(ctx, path.join(root, '.codex', 'config.toml'), 'project');
  addHooksFile(ctx, path.join(root, '.codex', 'hooks.json'), path.join(root, '.codex'));
  addMcpFile(ctx, path.join(root, '.mcp.json'), 'project', 'mcpServers');
  addMcpFile(ctx, path.join(root, '.cursor', 'mcp.json'), 'project', 'mcpServers');
  addMcpFile(ctx, path.join(root, '.vscode', 'mcp.json'), 'project', 'servers');
  addStateMcp(ctx);

  addAgents(ctx, path.join(dc, 'agents'), 'project');
  addCommands(ctx, path.join(dc, 'commands'));
  addRules(ctx, path.join(dc, 'rules'));
  addRules(ctx, path.join(root, '.cursor', 'rules'), (n) => /\.(md|mdc)$/i.test(n));
  addOutputStyles(ctx, path.join(dc, 'output-styles'));
  addSkills(ctx, path.join(dc, 'skills'), 'project');
  addSkills(ctx, path.join(root, '.agents', 'skills'), 'project');
  addClaudePlugins(ctx, { registries: ctx.claudeDirs, listInstalled: false });

  addGitHooks(ctx);
  addCi(ctx);
  addSupportScripts(ctx);
  addDocs(ctx);
  applyOutputStyle(ctx);
}

export function scanUser(ctx) {
  const dir = ctx.root;
  const mine = PROVIDER_INSTRUCTIONS[ctx.provider] || ['CLAUDE.md', 'AGENTS.md', 'AGENTS.override.md', 'GEMINI.md'];
  for (const n of ['CLAUDE.md', 'AGENTS.md', 'AGENTS.override.md', 'GEMINI.md']) {
    // A file another agent would read is still listed: it looks like instructions but never loads here.
    const loaded = mine.includes(n) ? 'always' : 'never';
    addChain(ctx, path.join(dir, n), { loaded, priority: loaded === 'always' ? PRIORITY.instructions : PRIORITY.unloaded, follow: FOLLOWS_IMPORTS.test(n) });
  }
  addMemoryFile(ctx, path.join(dir, 'memory', 'MEMORY.md'), new Set());

  addClaudeSettings(ctx, path.join(dir, 'managed-settings.json'), 'managed', dir);
  addClaudeSettings(ctx, path.join(dir, 'settings.json'), 'user', dir);
  addClaudeSettings(ctx, path.join(dir, 'settings.local.json'), 'user', dir);
  ctx.files.add(path.join(dir, 'keybindings.json'), { category: 'settings', loaded: 'always', priority: PRIORITY.keybindings });
  addCodexConfig(ctx, path.join(dir, 'config.toml'), 'user');
  addHooksFile(ctx, path.join(dir, 'hooks.json'), dir);
  addMcpFile(ctx, path.join(dir, 'mcp.json'), 'user', 'mcpServers');
  if (ctx.provider === 'claude-code') addStateMcp(ctx);

  addAgents(ctx, path.join(dir, 'agents'), 'user');
  addCommands(ctx, path.join(dir, 'commands'), (n) => /\.(md|toml)$/i.test(n));
  addCommands(ctx, path.join(dir, 'prompts'));
  addRules(ctx, path.join(dir, 'rules'), (n) => /\.(md|mdc)$/i.test(n));
  addOutputStyles(ctx, path.join(dir, 'output-styles'));
  addSkills(ctx, path.join(dir, 'skills'), 'user');
  if (ctx.provider === 'claude-code') addClaudePlugins(ctx, { registries: [dir], listInstalled: true });

  addSupportScripts(ctx);
  applyOutputStyle(ctx);
}
