// Collector: reads the harness once (read-only) and builds the in-memory model every check runs
// on. All file system access of the checks engine lives here; the checks themselves are pure.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IS_WIN, home, isDir, isFile, readdirSafe, realpathSafe, readTextSafe, parseJsonSafe,
  displayPath, normalizeInputPath, git, SKIP_DIRS,
} from '../common.mjs';
import { claudeConfigDirs, codexDirs, agentsDirs } from '../locations.mjs';
import { parseImports, scanCodexToml } from '../../discover.mjs';
import { shellTokens } from './util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CATALOG_TOOLS = path.resolve(HERE, '..', '..', '..', 'references', 'catalog', 'tools.json');

const EXAMPLE_SEGMENTS = new Set([
  'docs', 'doc', 'documentation', 'example', 'examples', 'template', 'templates', 'fixture', 'fixtures',
  '__fixtures__', 'test', 'tests', '__tests__', 'sample', 'samples', 'demo', 'demos',
]);
const SCRIPT_EXT = /\.(sh|bash|zsh|js|mjs|cjs|ts|py|ps1|rb|pl)$/i;
const MAX_SCRIPT_BYTES = 512 * 1024;

const keyOf = (p) => (IS_WIN ? p.toLowerCase() : p);

function under(p, root) {
  if (!root) return false;
  const a = keyOf(path.resolve(p));
  const b = keyOf(path.resolve(root));
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * Where a file lives decides how much a finding in it matters.
 * plugin: inside a plugin install or cache; example: docs/examples/templates/test fixtures (or a
 * repo's own skill sources that this harness does not load); project-optional: opt-in copies a
 * user still has to adopt (`settings.local.example.json`, `.mcp.sample.json`); active: everything
 * the harness loads. `.local` files themselves (settings.local.json, CLAUDE.local.md) load in
 * every session, so they are active.
 */
export function originFor(abs, { scope, baseRoot, pluginRoots = [], notLoaded = false }) {
  if (pluginRoots.some((r) => under(abs, r))) return 'plugin';
  if (notLoaded) return 'example';
  const rel = baseRoot && under(abs, baseRoot) ? path.relative(baseRoot, abs) : '';
  const segs = rel.split(/[\\/]/).slice(0, -1).map((s) => s.toLowerCase());
  if (segs.some((s) => EXAMPLE_SEGMENTS.has(s))) return 'example';
  if (scope === 'project' && /\.(example|sample|template|dist)\./i.test(path.basename(abs))) return 'project-optional';
  return 'active';
}

/** Resolve the script a hook command runs, when it names one we can read. */
export function hookScriptPath(command, { pluginRoot, projectRoot, configDir }) {
  const h = home();
  const NUL = '\u0000';
  for (let tok of shellTokens(command)) {
    if (!SCRIPT_EXT.test(tok)) continue;
    tok = tok
      .replace(/^~(?=[\\/])/, h)
      .replace(/\$\{HOME\}|\$HOME|%USERPROFILE%|\$env:USERPROFILE/gi, h)
      .replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT/g, pluginRoot || NUL)
      .replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR|%CLAUDE_PROJECT_DIR%/g, projectRoot || NUL);
    if (tok.includes(NUL) || /[$%]/.test(tok)) continue;
    const base = projectRoot || configDir || process.cwd();
    const abs = path.isAbsolute(tok) ? tok : path.resolve(base, tok);
    if (isFile(abs)) return abs;
  }
  return null;
}

function readJson(abs) {
  const text = readTextSafe(abs);
  if (text === null) return null;
  const r = parseJsonSafe(text);
  return { text, json: r.ok ? r.value : null, valid: r.ok };
}

function mdFiles(dir, depth = 2) {
  const out = [];
  const visit = (d, lvl) => {
    for (const e of readdirSafe(d)) {
      const full = path.join(d, e.name);
      if (isDir(full)) { if (lvl < depth && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) visit(full, lvl + 1); }
      else if (/\.md$/i.test(e.name) && isFile(full)) out.push(full);
    }
  };
  if (isDir(dir)) visit(dir, 1);
  return out.sort();
}

function skillDirs(dir) {
  const out = [];
  for (const e of readdirSafe(dir)) {
    const full = path.join(dir, e.name);
    if (isDir(full) && isFile(path.join(full, 'SKILL.md'))) out.push({ name: e.name, file: path.join(full, 'SKILL.md') });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function hookEntries(hooksObj) {
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
        out.push({ event, matcher, type: h.type || 'command', command: typeof h.command === 'string' ? h.command : '' });
      }
    }
  }
  return out;
}

/** Resolve a path-like reference written in an instruction file. */
export function resolveRef(raw, fromFile) {
  const h = home();
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(h, raw.slice(2));
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) return normalizeInputPath(raw);
  return path.resolve(path.dirname(fromFile), raw);
}

export function collect({ scope, cwd }) {
  const wantUser = scope === 'user' || scope === 'both';
  const wantProject = scope === 'project' || scope === 'both';
  const projectRoot = wantProject ? cwd : null;
  const h = home();
  const model = {
    scope, projectRoot, home: h,
    docs: [], rootInstructions: [], settings: [], hooks: [], mcp: [], marketplaces: [],
    codexConfigs: [], skills: [], claudeDirs: [], packageProject: null, catalog: null,
    gitHookTexts: [], fileExists: (p) => isFile(p) || isDir(p), resolveRef,
  };
  const seenDocs = new Set();
  const disp = (abs, sc) => displayPath(abs, sc === 'project' ? projectRoot : undefined);
  // realpath is slow on some file systems (several ms per call on Windows); resolve each path once.
  const realCache = new Map();
  const realOf = (abs) => {
    if (!realCache.has(abs)) realCache.set(abs, realpathSafe(abs) || abs);
    return realCache.get(abs);
  };

  const addDoc = (abs, meta) => {
    const real = realOf(abs);
    if (seenDocs.has(keyOf(real))) return null;
    seenDocs.add(keyOf(real));
    const text = readTextSafe(abs);
    if (text === null) return null;
    const doc = { abs, real, display: disp(abs, meta.scope), text, ...meta };
    delete doc.originCtx;
    model.docs.push(doc);
    return doc;
  };

  /** A root instruction file plus everything it imports (Claude follows up to 5 hops). */
  const seenRoots = new Set();
  const addInstructionRoot = (abs, meta) => {
    if (!isFile(abs)) return;
    if (seenRoots.has(keyOf(realOf(abs)))) return; // a second account linking the same file
    seenRoots.add(keyOf(realOf(abs)));
    const chain = [];
    const visited = new Set();
    const walk = (file, depth) => {
      const real = realOf(file);
      if (visited.has(keyOf(real))) return;
      visited.add(keyOf(real));
      const text = readTextSafe(file);
      if (text === null) return;
      chain.push({ abs: file, display: disp(file, meta.scope), chars: text.length });
      addDoc(file, { ...meta, kind: 'instruction', imported: depth > 0, origin: depth > 0 ? originFor(file, meta.originCtx) : meta.origin });
      if (meta.agent !== 'claude' || depth >= 5) return;
      for (const raw of parseImports(text)) {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue;
        const target = resolveRef(raw, file);
        if (target && isFile(target)) walk(target, depth + 1);
      }
    };
    walk(abs, 0);
    if (!chain.length) return;
    model.rootInstructions.push({
      abs, display: disp(abs, meta.scope), scope: meta.scope, origin: meta.origin, agent: meta.agent,
      alwaysLoaded: meta.alwaysLoaded !== false, chain, totalChars: chain.reduce((s, c) => s + c.chars, 0),
    });
  };

  const addHooks = (hooksObj, where) => {
    for (const e of hookEntries(hooksObj)) {
      const scriptAbs = e.command ? hookScriptPath(e.command, where) : null;
      const scriptText = scriptAbs ? readTextSafe(scriptAbs, MAX_SCRIPT_BYTES) : null;
      model.hooks.push({
        ...e,
        display: where.display, scope: where.scope, origin: where.origin, agent: where.agent,
        configKey: where.configKey, configKeys: where.configKeys || [where.configKey], text: where.text, scriptText,
        scriptDisplay: scriptAbs ? disp(scriptAbs, where.scope) : null,
      });
    }
  };

  const addMcp = (obj, where) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const name of Object.keys(obj).sort()) model.mcp.push({ name, ...where });
  };

  const seenSettings = new Map();
  const addSettings = (abs, meta) => {
    // Accounts that link their settings.json to another account's file share one entry.
    const real = keyOf(realOf(abs));
    if (seenSettings.has(real)) {
      const prev = seenSettings.get(real);
      if (!prev.configKeys.includes(meta.configKey)) prev.configKeys.push(meta.configKey);
      return prev;
    }
    const r = readJson(abs);
    if (!r || !r.json || typeof r.json !== 'object' || Array.isArray(r.json)) return null;
    const s = { abs, display: disp(abs, meta.scope), text: r.text, json: r.json, ...meta, configKeys: [meta.configKey] };
    seenSettings.set(real, s);
    model.settings.push(s);
    addHooks(r.json.hooks, { ...s, pluginRoot: null, projectRoot, configDir: meta.configDir });
    addMcp(r.json.mcpServers, { level: meta.scope === 'project' ? 'project' : 'user', agent: 'claude', configKey: meta.configKey, display: s.display, scope: meta.scope, origin: meta.origin, text: r.text });
    if (r.json.extraKnownMarketplaces && typeof r.json.extraKnownMarketplaces === 'object') {
      for (const [name, def] of Object.entries(r.json.extraKnownMarketplaces)) {
        model.marketplaces.push({ name, def: def || {}, display: s.display, scope: meta.scope, origin: meta.origin, configKey: meta.configKey, text: r.text });
      }
    }
    return s;
  };

  // ------------------------------------------------------------------ user scope
  for (const d of claudeConfigDirs()) {
    const dir = d.path;
    const configKey = `claude:${keyOf(d.realpath)}`;
    model.claudeDirs.push({ configKey, display: displayPath(dir) });
    if (!wantUser) continue;
    const pluginRoots = [path.join(dir, 'plugins')];
    const ctx = { scope: 'user', baseRoot: dir, pluginRoots };
    const settingsObjs = [];
    for (const n of ['settings.json', 'settings.local.json']) {
      const f = path.join(dir, n);
      if (isFile(f)) { const s = addSettings(f, { scope: 'user', origin: 'active', agent: 'claude', configKey, configDir: dir, level: 'user' }); if (s) settingsObjs.push(s); }
    }
    addInstructionRoot(path.join(dir, 'CLAUDE.md'), { scope: 'user', origin: 'active', agent: 'claude', configKey, originCtx: ctx });
    for (const f of mdFiles(path.join(dir, 'rules'), 3)) addDoc(f, { scope: 'user', origin: originFor(f, ctx), agent: 'claude', configKey, kind: 'rule' });
    for (const f of mdFiles(path.join(dir, 'agents'), 2)) addDoc(f, { scope: 'user', origin: originFor(f, ctx), agent: 'claude', configKey, kind: 'agent' });
    for (const f of mdFiles(path.join(dir, 'commands'), 3)) addDoc(f, { scope: 'user', origin: originFor(f, ctx), agent: 'claude', configKey, kind: 'command' });
    for (const s of skillDirs(path.join(dir, 'skills'))) {
      const origin = originFor(s.file, ctx);
      model.skills.push({ name: s.name, real: realOf(s.file), display: disp(s.file, 'user'), set: configKey, origin, scope: 'user' });
      addDoc(s.file, { scope: 'user', origin, agent: 'claude', configKey, kind: 'skill' });
    }
    // ~/.claude.json: user-level MCP servers and the approvals recorded for this project.
    const defaultDir = realpathSafe(path.join(h, '.claude')) || path.join(h, '.claude');
    const cjPath = isFile(path.join(dir, '.claude.json')) ? path.join(dir, '.claude.json')
      : (keyOf(d.realpath) === keyOf(defaultDir) && isFile(path.join(h, '.claude.json')) ? path.join(h, '.claude.json') : null);
    if (cjPath) {
      const cj = readJson(cjPath);
      if (cj && cj.json) {
        addMcp(cj.json.mcpServers, { level: 'user', agent: 'claude', configKey, display: disp(cjPath, 'user'), scope: 'user', origin: 'active', text: cj.text });
        const projects = cj.json.projects && typeof cj.json.projects === 'object' ? cj.json.projects : {};
        for (const [k, v] of Object.entries(projects)) {
          if (!v || typeof v !== 'object' || !projectRoot) continue;
          if (keyOf(normalizeInputPath(k)) !== keyOf(projectRoot)) continue;
          addMcp(v.mcpServers, { level: 'local', agent: 'claude', configKey, display: disp(cjPath, 'user'), scope: 'project', origin: 'active', text: cj.text });
          model.settings.push({
            abs: cjPath, display: disp(cjPath, 'user'), text: cj.text, scope: 'project', origin: 'active', agent: 'claude', configKey, level: 'local', pseudo: true,
            json: { enableAllProjectMcpServers: v.enableAllProjectMcpServers, enabledMcpjsonServers: v.enabledMcpjsonServers },
          });
        }
      }
    }
    // Marketplaces and enabled plugins.
    const kmPath = path.join(dir, 'plugins', 'known_marketplaces.json');
    const km = readJson(kmPath);
    if (km && km.json && typeof km.json === 'object') {
      for (const [name, def] of Object.entries(km.json)) model.marketplaces.push({ name, def: def || {}, display: disp(kmPath, 'user'), scope: 'user', origin: 'active', configKey, text: km.text });
    }
    const enabled = new Set();
    for (const s of settingsObjs) {
      const ep = s.json.enabledPlugins && typeof s.json.enabledPlugins === 'object' ? s.json.enabledPlugins : {};
      for (const [k, v] of Object.entries(ep)) if (v === true) enabled.add(k);
    }
    const ip = readJson(path.join(dir, 'plugins', 'installed_plugins.json'));
    const installs = ip && ip.json ? (ip.json.plugins && typeof ip.json.plugins === 'object' ? ip.json.plugins : ip.json) : {};
    const seenInstall = new Set();
    for (const [key, val] of Object.entries(installs || {})) {
      if (key === 'version' || !enabled.has(key)) continue;
      // One install loads per plugin: the user-scope one, or the one recorded for this project.
      // Older versions left in the cache are not loaded and are not scanned.
      const entries = (Array.isArray(val) ? val : [val]).filter((inst) => inst && typeof inst.installPath === 'string');
      const applicable = entries.filter((inst) => !inst.projectPath || (projectRoot && keyOf(normalizeInputPath(inst.projectPath)) === keyOf(projectRoot)));
      const pick = applicable.sort((a, b) => String(a.lastUpdated || '').localeCompare(String(b.lastUpdated || ''))).slice(-1);
      for (const inst of pick) {
        const root = normalizeInputPath(inst.installPath);
        if (!isDir(root) || seenInstall.has(keyOf(root))) continue;
        seenInstall.add(keyOf(root));
        const pctx = { scope: 'user', baseRoot: root, pluginRoots: [...pluginRoots, root] };
        const pluginName = key.split('@')[0];
        for (const s of skillDirs(path.join(root, 'skills'))) {
          model.skills.push({ name: s.name, real: realOf(s.file), display: disp(s.file, 'user'), set: configKey, origin: 'plugin', scope: 'user', plugin: pluginName });
          addDoc(s.file, { scope: 'user', origin: 'plugin', agent: 'claude', configKey, kind: 'skill' });
        }
        for (const f of mdFiles(path.join(root, 'agents'), 2)) addDoc(f, { scope: 'user', origin: originFor(f, pctx), agent: 'claude', configKey, kind: 'agent' });
        for (const f of mdFiles(path.join(root, 'commands'), 3)) addDoc(f, { scope: 'user', origin: originFor(f, pctx), agent: 'claude', configKey, kind: 'command' });
        const hkPath = path.join(root, 'hooks', 'hooks.json');
        const hk = readJson(hkPath);
        if (hk && hk.json) {
          const hooksObj = hk.json.hooks && typeof hk.json.hooks === 'object' ? hk.json.hooks : hk.json;
          addHooks(hooksObj, { display: disp(hkPath, 'user'), scope: 'user', origin: 'plugin', agent: 'claude', configKey, text: hk.text, pluginRoot: root, projectRoot, configDir: dir });
        }
        const pm = readJson(path.join(root, '.mcp.json'));
        if (pm && pm.json) addMcp(pm.json.mcpServers || pm.json, { level: 'user', agent: 'claude', configKey, display: disp(path.join(root, '.mcp.json'), 'user'), scope: 'user', origin: 'plugin', text: pm.text });
        const pj = readJson(path.join(root, '.claude-plugin', 'plugin.json'));
        if (pj && pj.json && pj.json.mcpServers && typeof pj.json.mcpServers === 'object') addMcp(pj.json.mcpServers, { level: 'user', agent: 'claude', configKey, display: disp(path.join(root, '.claude-plugin', 'plugin.json'), 'user'), scope: 'user', origin: 'plugin', text: pj.text });
      }
    }
  }

  if (wantUser) {
    for (const d of codexDirs()) {
      const dir = d.path;
      const configKey = `codex:${keyOf(d.realpath)}`;
      const ctx = { scope: 'user', baseRoot: dir, pluginRoots: [path.join(dir, 'plugins')] };
      for (const n of ['AGENTS.md', 'AGENTS.override.md']) addInstructionRoot(path.join(dir, n), { scope: 'user', origin: 'active', agent: 'codex', configKey, originCtx: ctx });
      const tomlPath = path.join(dir, 'config.toml');
      const toml = readTextSafe(tomlPath);
      if (toml !== null) {
        const display = disp(tomlPath, 'user');
        model.codexConfigs.push({ display, text: toml, scope: 'user', origin: 'active' });
        for (const s of scanCodexToml(toml).mcpServers) model.mcp.push({ name: s.name, level: 'user', agent: 'codex', configKey, display, scope: 'user', origin: 'active', text: toml });
      }
      const hkPath = path.join(dir, 'hooks.json');
      const hk = readJson(hkPath);
      if (hk && hk.json) addHooks(hk.json.hooks && typeof hk.json.hooks === 'object' ? hk.json.hooks : hk.json, { display: disp(hkPath, 'user'), scope: 'user', origin: 'active', agent: 'codex', configKey, text: hk.text, projectRoot, configDir: dir });
      for (const s of skillDirs(path.join(dir, 'skills'))) {
        const origin = originFor(s.file, ctx);
        model.skills.push({ name: s.name, real: realOf(s.file), display: disp(s.file, 'user'), set: 'codex', origin, scope: 'user' });
        addDoc(s.file, { scope: 'user', origin, agent: 'codex', configKey, kind: 'skill' });
      }
    }
    for (const d of agentsDirs()) {
      for (const s of skillDirs(path.join(d.path, 'skills'))) {
        model.skills.push({ name: s.name, real: realOf(s.file), display: disp(s.file, 'user'), set: 'codex', origin: 'active', scope: 'user' });
        addDoc(s.file, { scope: 'user', origin: 'active', agent: 'codex', configKey: 'codex', kind: 'skill' });
      }
    }
  }

  // ------------------------------------------------------------------ project scope
  if (wantProject) {
    const ctx = { scope: 'project', baseRoot: projectRoot };
    const dc = path.join(projectRoot, '.claude');
    for (const n of ['settings.json', 'settings.local.json']) {
      const f = path.join(dc, n);
      if (isFile(f)) addSettings(f, { scope: 'project', origin: originFor(f, ctx), agent: 'claude', configKey: 'project', configDir: dc, level: n === 'settings.json' ? 'project' : 'local' });
    }
    for (const n of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      addInstructionRoot(path.join(projectRoot, n), { scope: 'project', origin: originFor(path.join(projectRoot, n), ctx), agent: 'claude', configKey: 'project', originCtx: ctx });
    }
    for (const n of ['AGENTS.md', 'AGENTS.override.md']) {
      addInstructionRoot(path.join(projectRoot, n), { scope: 'project', origin: originFor(path.join(projectRoot, n), ctx), agent: 'codex', configKey: 'project', originCtx: ctx });
    }
    for (const f of mdFiles(path.join(dc, 'rules'), 3)) addDoc(f, { scope: 'project', origin: originFor(f, ctx), agent: 'claude', configKey: 'project', kind: 'rule' });
    for (const f of mdFiles(path.join(dc, 'agents'), 2)) addDoc(f, { scope: 'project', origin: originFor(f, ctx), agent: 'claude', configKey: 'project', kind: 'agent' });
    for (const f of mdFiles(path.join(dc, 'commands'), 3)) addDoc(f, { scope: 'project', origin: originFor(f, ctx), agent: 'claude', configKey: 'project', kind: 'command' });
    for (const [base, set, agent] of [[path.join(dc, 'skills'), 'project-claude', 'claude'], [path.join(projectRoot, '.agents', 'skills'), 'codex', 'codex']]) {
      for (const s of skillDirs(base)) {
        const origin = originFor(s.file, ctx);
        model.skills.push({ name: s.name, real: realOf(s.file), display: disp(s.file, 'project'), set, origin, scope: 'project' });
        addDoc(s.file, { scope: 'project', origin, agent, configKey: 'project', kind: 'skill' });
      }
    }
    const mcp = readJson(path.join(projectRoot, '.mcp.json'));
    if (mcp && mcp.json) addMcp(mcp.json.mcpServers, { level: 'project', agent: 'claude', configKey: 'project', display: './.mcp.json', scope: 'project', origin: 'active', text: mcp.text });

    // Nested instruction files and the repo's own skill sources (not loaded by this harness).
    const stack = [[projectRoot, 0]];
    while (stack.length) {
      const [d, depth] = stack.pop();
      for (const e of readdirSafe(d)) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || depth >= 6) continue;
          if (e.name.startsWith('.') && e.name !== '.github') continue;
          stack.push([full, depth + 1]);
        } else if (e.isFile()) {
          if (depth > 0 && depth <= 3 && ['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md'].includes(e.name)) {
            addInstructionRoot(full, { scope: 'project', origin: originFor(full, ctx), agent: e.name === 'AGENTS.md' ? 'codex' : 'claude', configKey: 'project', originCtx: ctx, alwaysLoaded: false });
          } else if (e.name === 'SKILL.md') {
            addDoc(full, { scope: 'project', origin: originFor(full, { ...ctx, notLoaded: true }), agent: 'claude', configKey: 'repo', kind: 'skill' });
          }
        }
      }
    }

    // Package manager signals for the release-age check.
    const pkg = readJson(path.join(projectRoot, 'package.json'));
    if (pkg && pkg.json && typeof pkg.json === 'object') {
      const deps = ['dependencies', 'devDependencies', 'optionalDependencies']
        .reduce((n, k) => n + (pkg.json[k] && typeof pkg.json[k] === 'object' ? Object.keys(pkg.json[k]).length : 0), 0);
      const pmField = typeof pkg.json.packageManager === 'string' ? pkg.json.packageManager : '';
      const managers = [];
      if (isFile(path.join(projectRoot, 'pnpm-lock.yaml')) || isFile(path.join(projectRoot, 'pnpm-workspace.yaml')) || pmField.startsWith('pnpm@')) managers.push('pnpm');
      if (isFile(path.join(projectRoot, 'yarn.lock')) || pmField.startsWith('yarn@')) managers.push('yarn');
      if (isFile(path.join(projectRoot, 'bun.lockb')) || isFile(path.join(projectRoot, 'bun.lock'))) managers.push('bun');
      if (isFile(path.join(projectRoot, 'package-lock.json')) || managers.length === 0) managers.push('npm');
      const configs = {};
      for (const [label, abs] of [
        ['./.npmrc', path.join(projectRoot, '.npmrc')], ['./pnpm-workspace.yaml', path.join(projectRoot, 'pnpm-workspace.yaml')],
        ['./.yarnrc.yml', path.join(projectRoot, '.yarnrc.yml')], ['./bunfig.toml', path.join(projectRoot, 'bunfig.toml')],
        ['~/.npmrc', path.join(h, '.npmrc')], ['~/.yarnrc.yml', path.join(h, '.yarnrc.yml')], ['~/.bunfig.toml', path.join(h, '.bunfig.toml')],
      ]) { const t = readTextSafe(abs); if (t !== null) configs[label] = t; }
      model.packageProject = { display: './package.json', deps, managers, configs };
    }

    // Git hooks and pre-commit frameworks, for the secret-scan defense.
    for (const rel of ['.pre-commit-config.yaml', '.husky/pre-commit', 'lefthook.yml', '.lefthook.yml', 'lefthook.yaml']) {
      const t = readTextSafe(path.join(projectRoot, rel));
      if (t !== null) model.gitHookTexts.push({ display: `./${rel}`, text: t });
    }
    const hp = git(projectRoot, ['config', '--get', 'core.hooksPath']);
    const common = git(projectRoot, ['rev-parse', '--git-common-dir']);
    const hooksDir = hp.ok && hp.stdout.trim() ? path.resolve(projectRoot, hp.stdout.trim())
      : (common.ok && common.stdout.trim() ? path.join(path.resolve(projectRoot, common.stdout.trim()), 'hooks') : null);
    if (hooksDir) {
      const t = readTextSafe(path.join(hooksDir, 'pre-commit'), MAX_SCRIPT_BYTES);
      if (t !== null) model.gitHookTexts.push({ display: displayPath(path.join(hooksDir, 'pre-commit'), projectRoot), text: t });
    }
  }

  // Tool catalog for the CLI-over-MCP check.
  const cat = readJson(CATALOG_TOOLS);
  model.catalog = cat && cat.json && Array.isArray(cat.json.tools) ? cat.json.tools : null;
  return model;
}
