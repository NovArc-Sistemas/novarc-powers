#!/usr/bin/env node
// snapshot-harness.mjs --kind project --cwd <abs> --id <harnessId> [--impact <impact.json>] [--clis <clis.json>]
// snapshot-harness.mjs --kind user --config-dir <abs> --provider <provider> --id <harnessId> [--impact ...] [--clis ...]
//
// Read-only picture of ONE harness for the board's explorer: `{ harness, files, elements, layers }`,
// each shaped as templates/state.schema.v2.json says (a `harnesses[]` entry without scores,
// `files[]`, `$defs.elements`, `layers[]`).
//   files     text of the harness files, secrets masked line by line (line numbers stay true),
//             the home path shown as `~`, 256 KB per file and 3 MB per harness at most
//   elements  permissions, hooks (agent, plugin, git, CI), skills, agents, plugins, MCP servers,
//             CLIs (from --clis) and docs, each pointing at the file it comes from
//   layers    what enters every session, in load order, with approximate tokens
// --impact takes the output of session-impact.mjs (or transcript-signals.mjs) and fills skill
// invocations and MCP calls; --clis takes the output of probe-clis.mjs. --name sets the tab label.
// --file-cap and --budget (bytes) override the two size limits.
// It never prints a secret, transcript text or an absolute home path, and it never reads
// credential stores: files are picked by role, not by listing a config dir.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, isMain, printJson, warn, displayPath, normalizeInputPath, isDir, readJsonSafe } from './lib/common.mjs';
import { FileSet, Loader, FILE_CAP, HARNESS_BUDGET } from './lib/snapshot/files.mjs';
import { newScan, scanProject, scanUser } from './lib/snapshot/scan.mjs';
import { buildElements, buildLayers } from './lib/snapshot/elements.mjs';
import { isCodeDir, projectGitInfo } from './lib/snapshot/project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_TOOLS = path.join(HERE, '..', 'references', 'catalog', 'tools.json');
export const PROVIDERS = ['claude-code', 'codex', 'gemini', 'opencode', 'cursor', 'copilot', 'agents', 'other'];
const PROVIDER_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', opencode: 'opencode', cursor: 'Cursor', copilot: 'Copilot', agents: 'Shared agents folder', other: 'Agent' };
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Build the snapshot. `kind` project needs `cwd`; `kind` user needs `configDir` and `provider`.
 * `impact` and `clis` are the parsed probe outputs, when the caller has them. `report`, when
 * given, receives counts for diagnostics (`contentBytes`, `docsFound`).
 */
export function snapshot({ kind, id, cwd = null, configDir = null, provider = null, name = null, impact = null, clis = null, fileCap = FILE_CAP, budget = HARNESS_BUDGET }, report = null) {
  const root = kind === 'project' ? cwd : configDir;
  const loader = new Loader();
  const files = new FileSet({ harnessId: id, kind, root, loader, fileCap, budget });
  const ctx = newScan({ kind, root, provider, files, loader });
  if (kind === 'project') scanProject(ctx); else scanUser(ctx);

  const fileList = files.finalize();
  const cat = readJsonSafe(CATALOG_TOOLS);
  const catalog = cat.ok && cat.value && Array.isArray(cat.value.tools) ? cat.value.tools : [];
  const elements = buildElements(ctx, { impact, clis, catalog });
  const layers = buildLayers(ctx, id);

  const harness = { id, kind, name: name || (kind === 'project' ? path.basename(root) : `${PROVIDER_LABEL[provider] || provider} (${displayPath(root)})`), path: displayPath(root) };
  if (kind === 'user') harness.provider = provider;
  else harness.project = { isCode: isCodeDir(root), ...projectGitInfo(root) };
  if (report) Object.assign(report, { contentBytes: files.contentBytes, docsFound: ctx.docsTotal || 0 });
  return { harness, files: fileList, elements, layers };
}

function fail(msg) { warn(msg); process.exit(2); }

function jsonArg(file, flag) {
  if (file === undefined) return null;
  if (typeof file !== 'string') fail(`${flag} needs a file path`);
  const r = readJsonSafe(normalizeInputPath(file));
  if (!r.ok || !r.value || typeof r.value !== 'object') fail(`${flag}: ${r.ok ? 'not a JSON object' : r.error}`);
  return r.value;
}

function bytesArg(v, flag, dflt) {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) fail(`${flag} must be a positive number of bytes`);
  return n;
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  const kind = args.kind;
  if (kind !== 'project' && kind !== 'user') fail('--kind must be project or user');
  const id = args.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) fail('--id must be a harness id: lowercase letters, digits and dashes');
  const opts = { kind, id, name: typeof args.name === 'string' ? args.name : null };
  if (kind === 'project') {
    if (typeof args.cwd !== 'string') fail('--kind project needs --cwd <project root>');
    opts.cwd = normalizeInputPath(args.cwd);
    if (!isDir(opts.cwd)) fail('--cwd is not a directory');
  } else {
    if (typeof args['config-dir'] !== 'string') fail('--kind user needs --config-dir <dir>');
    opts.configDir = normalizeInputPath(args['config-dir']);
    if (!isDir(opts.configDir)) fail('--config-dir is not a directory');
    if (!PROVIDERS.includes(args.provider)) fail(`--provider must be one of ${PROVIDERS.join(', ')}`);
    opts.provider = args.provider;
  }
  opts.impact = jsonArg(args.impact, '--impact');
  opts.clis = jsonArg(args.clis, '--clis');
  opts.fileCap = bytesArg(args['file-cap'], '--file-cap', FILE_CAP);
  opts.budget = bytesArg(args.budget, '--budget', HARNESS_BUDGET);
  try {
    const started = Date.now();
    const stats = {};
    const out = snapshot(opts, stats);
    const omitted = out.files.filter((f) => f.omitted).length;
    const truncated = out.files.filter((f) => f.truncated).length;
    warn(`snapshot ${id}: ${out.files.length} files (${omitted} without content, ${truncated} truncated), ${stats.contentBytes} bytes of content, ${Date.now() - started} ms`);
    if (stats.docsFound > out.elements.docs.length) warn(`docs: ${stats.docsFound} found, ${out.elements.docs.length} listed (those the instructions point at, then the ones nearest the root)`);
    printJson(out);
  } catch (e) {
    warn(`failed: ${e && e.code ? e.code : 'error'}`);
    process.exit(1);
  }
}
