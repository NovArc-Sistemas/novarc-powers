#!/usr/bin/env node
// harness-checks.mjs --scope user|project|both --cwd <root> [--only <id,...>]
//
// Deterministic rule engine over the harness config: turns settings, hooks, instruction files,
// skills, agents, MCP servers and plugin sources into candidate findings, so each round starts
// from evidence. Read-only. Prints JSON { checks, defenses, skipped }. Evidence never contains a
// secret value (secret-shaped text is masked) nor an absolute home path (`~` and `./` are used).
// Findings are candidates for the agent to verify, never accepted automatically.
// Rule ideas inspired by AgentShield (MIT); the checks and their text are our own.
import { parseArgs, isMain, printJson, warn, normalizeInputPath, isDir } from './lib/common.mjs';
import { collect } from './lib/checks/collect.mjs';
import { CHECK_IDS, runChecks } from './lib/checks/index.mjs';

export function harnessChecks({ scope = 'both', cwd = process.cwd(), only = null } = {}) {
  const model = collect({ scope, cwd });
  return runChecks(model, only);
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  const scope = args.scope || 'both';
  if (!['user', 'project', 'both'].includes(scope)) { warn('--scope must be user, project or both'); process.exit(2); }
  const cwd = normalizeInputPath(typeof args.cwd === 'string' ? args.cwd : process.cwd());
  if ((scope === 'project' || scope === 'both') && !isDir(cwd)) { warn('--cwd is not a directory'); process.exit(2); }
  let only = null;
  if (args.only !== undefined) {
    only = String(args.only === true ? '' : args.only).split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = only.filter((id) => !CHECK_IDS.includes(id));
    if (!only.length || unknown.length) { warn(`--only takes check ids from: ${CHECK_IDS.join(', ')}`); process.exit(2); }
  }
  printJson(harnessChecks({ scope, cwd, only }));
}
