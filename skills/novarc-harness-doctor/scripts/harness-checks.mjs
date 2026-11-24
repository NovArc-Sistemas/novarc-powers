#!/usr/bin/env node
// harness-checks.mjs --scope user|project|both --cwd <root> [--only <id,...>] [--provider <p> --config-dir <dir>]
//
// Deterministic rule engine over the harness config: turns settings, hooks, instruction files,
// skills, agents, MCP servers and plugin sources into candidate findings, so each round starts
// from evidence. Read-only. Prints JSON { checks, defenses, skipped }. Evidence never contains a
// secret value (secret-shaped text is masked) nor an absolute home path (`~` and `./` are used).
// Findings are candidates for the agent to verify, never accepted automatically.
// With --provider and --config-dir the user scope is one account: only that config dir is read,
// and the output says which in `account`. Without them every account on the machine is read.
// Rule ideas inspired by AgentShield (MIT); the checks and their text are our own.
import { parseArgs, isMain, printJson, warn, normalizeInputPath, isDir, displayPath } from './lib/common.mjs';
import { accountFromArgs, accountSupported } from './lib/locations.mjs';
import { collect } from './lib/checks/collect.mjs';
import { CHECK_IDS, runChecks } from './lib/checks/index.mjs';

/** `account`: `{ provider, configDir }` to read one account's config dir instead of all of them. */
export function harnessChecks({ scope = 'both', cwd = process.cwd(), only = null, account = null } = {}) {
  // An account of a provider the collector has no reader for, asked about on its own: nothing
  // is read, so nothing was checked. Every check says so in `skipped`; an empty `checks` list
  // alone would read as a pass.
  if (account && scope === 'user' && !accountSupported(account.provider)) {
    const reason = `no reader for the config of a "${account.provider}" account: nothing was read, so nothing was checked`;
    return { checks: [], defenses: [], skipped: CHECK_IDS.filter((id) => !only || only.includes(id)).map((id) => ({ id, reason })) };
  }
  const model = collect({ scope, cwd, account });
  return runChecks(model, only);
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  const scope = args.scope || 'both';
  if (!['user', 'project', 'both'].includes(scope)) { warn('--scope must be user, project or both'); process.exit(2); }
  const cwd = normalizeInputPath(typeof args.cwd === 'string' ? args.cwd : process.cwd());
  if ((scope === 'project' || scope === 'both') && !isDir(cwd)) { warn('--cwd is not a directory'); process.exit(2); }
  const { account, error } = accountFromArgs(args);
  if (error) { warn(error); process.exit(2); }
  if (account && scope === 'project') { warn('--provider and --config-dir narrow the user scope; they have no meaning with --scope project'); process.exit(2); }
  let only = null;
  if (args.only !== undefined) {
    only = String(args.only === true ? '' : args.only).split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = only.filter((id) => !CHECK_IDS.includes(id));
    if (!only.length || unknown.length) { warn(`--only takes check ids from: ${CHECK_IDS.join(', ')}`); process.exit(2); }
  }
  const out = harnessChecks({ scope, cwd, only, account });
  // `supported: false`: the checks have no reader for that provider's config. With --scope user
  // every check is then listed in `skipped`; with --scope both only the project half was read.
  printJson(account ? { account: { provider: account.provider, path: displayPath(account.configDir), supported: account.supported }, ...out } : out);
}
