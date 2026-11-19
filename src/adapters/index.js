// Adapter registry and realpath-based target resolution.
import * as claudeCode from './claude-code.js';
import * as codex from './codex.js';
import * as agents from './agents.js';
import { fileIdentity, pathKey, resolveReal } from '../fsutil.js';

export const ADAPTERS = { 'claude-code': claudeCode, codex, agents };
export const TOOL_IDS = Object.keys(ADAPTERS);

export function getAdapter(id) {
  return ADAPTERS[id] || null;
}

/** Tools whose user-level config dir exists. */
export function detectTools(home) {
  return TOOL_IDS.filter((id) => ADAPTERS[id].detect(home));
}

/**
 * Collect the distinct targets of one kind (`skillsDir` or `instructionFile`)
 * for the given tools and scope. Targets are deduplicated by realpath, so two
 * config dirs linked into each other yield one target. Each result carries the
 * resolved path (the one written to) and every tool that maps to it.
 */
export function resolveTargets(tools, scope, { home, cwd }, kind) {
  const byKey = new Map();
  for (const tool of tools) {
    const adapter = ADAPTERS[tool];
    if (!adapter) continue;
    const list = scope === 'user' ? adapter.userTargets(home) : adapter.projectTargets(cwd);
    for (const t of list) {
      const p = t[kind];
      if (!p) continue;
      // Realpath collapses symlinks; dev:ino collapses hardlinked files too.
      const key = pathKey(p);
      const ident = fileIdentity(p);
      const existing = byKey.get(key) || (ident ? [...byKey.values()].find((v) => v.ident === ident) : undefined);
      if (existing) {
        if (!existing.tools.includes(tool)) existing.tools.push(tool);
      } else {
        byKey.set(key, { path: resolveReal(p), declared: p, tools: [tool], ident });
      }
    }
  }
  return [...byKey.values()];
}
