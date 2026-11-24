// Checks on MCP servers, plugin sources, package managers and duplicated installs.
import { finding, lineOfJsonKey, safeSnippet } from './util.mjs';

const lineOfName = (text, name) => (typeof text === 'string' ? (lineOfJsonKey(text, name) ?? (() => {
  const i = text.search(new RegExp(`\\[\\s*mcp_servers\\.["']?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*\\]`));
  return i < 0 ? null : text.slice(0, i).split('\n').length;
})()) : null);

export const mcpServerCount = {
  id: 'mcp-server-count', round: 7, severity: 'medium',
  title: 'Many MCP servers load at one level',
  why: 'Every server adds its tool definitions to the context of each session at that level, used or not, and a long tool list also makes the agent pick the wrong tool more often.',
  fix: 'Keep at user level only the servers nearly every session needs, move the rest to the projects that use them, and prefer an official CLI where one exists.',
  run(model) {
    const groups = new Map();
    for (const m of model.mcp) {
      const key = `${m.agent}|${m.level}|${m.level === 'user' ? m.configKey : 'project'}`;
      if (!groups.has(key)) groups.set(key, { first: m, names: new Set() });
      groups.get(key).names.add(m.name);
    }
    const out = [];
    for (const { first, names } of groups.values()) {
      if (names.size <= 10) continue;
      const list = [...names].sort();
      out.push(finding(this, { ...first, line: null },
        `${names.size} servers at ${first.level} level (${first.agent}): ${safeSnippet(list.slice(0, 12).join(', '), model.projectRoot, 140)}${list.length > 12 ? ', …' : ''}; connectors from a claude.ai account are not visible in config files`));
    }
    return out;
  },
};

export const mcpUserLevelHasCli = {
  id: 'mcp-user-level-has-cli', round: 7, severity: 'medium',
  title: 'User-level MCP server for a service with an official CLI',
  why: 'The server costs context in every session, while the CLI costs nothing until the agent runs it and is usually what the agent already knows how to use.',
  fix: 'Install and log in to the CLI from the catalog, then remove the server or move it to the projects that truly need it.',
  run(model) {
    if (!model.catalog) return { skip: 'references/catalog/tools.json could not be read' };
    const cli = model.catalog.filter((t) => Array.isArray(t.replacesMcp) && t.replacesMcp.length);
    const out = [];
    const seen = new Set();
    for (const m of model.mcp) {
      if (m.level !== 'user') continue;
      const lower = m.name.toLowerCase();
      const tool = cli.find((t) => t.replacesMcp.some((r) => lower.includes(String(r).toLowerCase())));
      if (!tool) continue;
      const key = `${m.display}|${m.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(finding(this, { ...m, line: lineOfName(m.text, m.name) }, `server "${safeSnippet(m.name, model.projectRoot, 60)}" (${m.agent}); catalog CLI "${tool.id}" covers this service`));
    }
    return out;
  },
};

const OFFICIAL_MARKETPLACES = new Set(['claude-plugins-official']);

export const pluginSourceUnpinned = {
  id: 'plugin-source-unpinned', round: 1, severity: 'low',
  title: 'Plugin marketplace auto-updates from a moving branch',
  why: 'Whatever is pushed to that branch reaches your harness on the next update, with no review step between the publisher and your sessions.',
  fix: 'Turn off auto-update for third-party marketplaces, or pin the source to a reviewed commit and update it on purpose.',
  run(model) {
    const out = [];
    const seen = new Set();
    for (const mk of model.marketplaces) {
      const src = mk.def && typeof mk.def.source === 'object' && mk.def.source ? mk.def.source : null;
      if (!src || mk.def.autoUpdate !== true || OFFICIAL_MARKETPLACES.has(mk.name)) continue;
      const kind = String(src.source || '').toLowerCase();
      if (!['github', 'git', 'url'].includes(kind)) continue;
      const ref = String(src.ref || src.sha || src.commit || '');
      if (/^[0-9a-f]{40}$/i.test(ref)) continue;
      const key = `${mk.configKey}|${mk.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(finding(this, { ...mk, line: lineOfJsonKey(mk.text, mk.name) },
        `marketplace "${safeSnippet(mk.name, model.projectRoot, 60)}" (${kind}) follows ${ref ? `ref "${safeSnippet(ref, model.projectRoot, 40)}"` : 'its default branch'} with autoUpdate true`));
    }
    return out;
  },
};

const RELEASE_AGE_KEYS = /minimumReleaseAge|minimum-release-age|min-release-age|npmMinimalAgeGate|^\s*before\s*=/m;

export const npmReleaseAgeGateMissing = {
  id: 'npm-release-age-gate-missing', round: 1, severity: 'low',
  title: 'No minimum release age for new packages',
  why: 'Most malicious package versions are caught and pulled within days, so installing a version minutes after it is published is when the risk is highest.',
  fix: "Set the package manager's minimum release age setting (check the manager's current docs for the exact key) so new versions wait a few days before install.",
  run(model) {
    if (model.scope === 'user') return { skip: 'project scope not requested' };
    const p = model.packageProject;
    if (!p) return { skip: 'no package.json at the project root' };
    if (!p.deps) return { skip: 'package.json declares no dependencies' };
    const files = Object.keys(p.configs);
    if (files.some((f) => RELEASE_AGE_KEYS.test(p.configs[f]))) return [];
    return [finding(this, { display: p.display, origin: 'active', line: null },
      `package manager: ${p.managers.join(', ')}; no release-age setting in ${files.length ? files.join(', ') : 'any .npmrc, pnpm-workspace.yaml, .yarnrc.yml or bunfig.toml'}`)];
  },
};

export const duplicateInstall = {
  id: 'duplicate-install', round: 6, severity: 'low',
  title: 'Same skill or hook installed twice',
  why: 'Two copies load twice, cost context twice and drift apart, and when they differ nobody knows which one the agent is following.',
  fix: 'Keep one copy at the level where it belongs and remove the other, or link one to the other if both locations must exist.',
  run(model) {
    const out = [];
    const userClaudeKeys = [...new Set(model.skills.filter((s) => s.set.startsWith('claude:')).map((s) => s.set))];
    const sets = new Map();
    const push = (k, s) => { if (!sets.has(k)) sets.set(k, []); sets.get(k).push(s); };
    for (const s of model.skills) {
      if (s.set === 'project-claude') {
        if (userClaudeKeys.length) for (const k of userClaudeKeys) push(k, s);
        else push('project-claude', s);
      } else push(s.set, s);
    }
    const reported = new Set();
    for (const list of sets.values()) {
      const byName = new Map();
      for (const s of list) {
        const n = s.name.toLowerCase();
        if (!byName.has(n)) byName.set(n, new Map());
        byName.get(n).set(process.platform === 'win32' ? s.real.toLowerCase() : s.real, s);
      }
      for (const [name, reals] of byName) {
        if (reals.size < 2) continue;
        const copies = [...reals.values()].sort((a, b) => a.display.localeCompare(b.display));
        const key = `skill|${name}|${copies.map((c) => c.display).join('|')}`;
        if (reported.has(key)) continue;
        reported.add(key);
        const [first, ...rest] = copies;
        for (const c of rest) {
          out.push(finding(this, { ...c, line: 1 }, `skill "${safeSnippet(name, model.projectRoot, 60)}" also at ${first.display}${first.plugin ? ` (plugin ${first.plugin})` : ''}`));
        }
      }
    }
    const hookSets = new Map();
    for (const h of model.hooks) {
      if (h.type !== 'command' || !h.command) continue;
      const keys = h.scope === 'project' ? ['project'] : (h.configKeys || [h.configKey]);
      for (const k of keys) {
        if (!hookSets.has(k)) hookSets.set(k, []);
        hookSets.get(k).push(h);
      }
    }
    // Project hooks run alongside every user config's hooks.
    const projectHooks = hookSets.get('project') || [];
    for (const [k, list] of hookSets) {
      const all = k === 'project' ? list : [...list, ...projectHooks];
      const byCmd = new Map();
      for (const h of all) {
        const norm = `${h.event}|${h.command.replace(/\s+/g, ' ').trim()}`;
        if (!byCmd.has(norm)) byCmd.set(norm, []);
        byCmd.get(norm).push(h);
      }
      for (const [norm, hs] of byCmd) {
        const files = [...new Set(hs.map((h) => h.display))].sort();
        if (files.length < 2) continue;
        const key = `hook|${norm}|${files.join('|')}`;
        if (reported.has(key)) continue;
        reported.add(key);
        const h = hs.find((x) => x.display === files[1]);
        out.push(finding(this, { ...h, line: null }, `${h.event} hook "${safeSnippet(h.command, model.projectRoot, 80)}" also in ${files[0]}`));
      }
    }
    return out;
  },
};

export const TOOLING_CHECKS = [mcpServerCount, mcpUserLevelHasCli, pluginSourceUnpinned, npmReleaseAgeGateMissing, duplicateInstall];
