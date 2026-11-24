// `run.mjs init`: turn a selection (accounts from `accounts.mjs list`, projects from
// `find-projects.mjs`) into a run directory, or start a run over the harnesses of an earlier one
// (`--follow-up`). `list` lives here too, and the step that marks a run closed.
//
// A harness that was reviewed before has a review record (references/follow-up.md). `init` finds
// it, notes it in run.json, and gives the harness its own measuring window: the days since that
// review, so that what is measured now is what happened after it.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeInputPath, isDir } from '../common.mjs';
import { RunError, UsageError, readJson, writeJsonAtomic, nowMs } from './store.mjs';
import { runPaths, runsDir, latestPath, latestRunId, newRunId, homeBase, RUN_ID_RE } from './paths.mjs';
import { assignHarnesses } from './ids.mjs';
import { homeMatchers, scrubString } from './scrub.mjs';
import { staticUnits, queueSnapshot, unitsView } from './units.mjs';
import { emptyStatus, appendLog } from './model.mjs';
import { isDateTime } from './schema.mjs';
import { hasCredential } from './secrets.mjs';
import { harnessKeyOf, listRecords, followUpWindow, loadThresholds } from './followup.mjs';
import { experimentFor } from './experiments.mjs';

/**
 * guided: nothing is applied without a decision. doctor: the safe classes are applied on their
 * own. measure: no review units at all; the run measures, renders and closes, and its records are
 * a baseline a later run compares with.
 */
export const MODES = ['guided', 'doctor', 'measure'];

export const PROVIDERS = ['claude-code', 'codex', 'gemini', 'opencode', 'cursor', 'copilot', 'agents', 'other'];
export const AGENTS = ['claude-code', 'codex', 'opencode', 'cursor', 'gemini', 'other'];
export const CHANNELS = ['artifact', 'server', 'file'];
const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const EMAIL_RE = /^([^@\s]+)@([^@\s]+\.[^@\s]+)$/;

/** Which agent is running this command, from its environment. A guess: `--agent` overrides it. */
export function detectAgent(env = process.env) {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED) return 'codex';
  if (env.OPENCODE) return 'opencode';
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) return 'cursor';
  if (env.GEMINI_CLI) return 'gemini';
  return 'other';
}

export function detectOs(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

/** First 2 characters of the local part, then the domain. Anything that is not an e-mail passes through. */
export function maskIdentity(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const v = value.trim();
  const m = EMAIL_RE.exec(v);
  if (!m) return v.slice(0, 80);
  if (m[1].includes('…') || m[1].includes('*')) return v;
  return `${m[1].slice(0, m[1].length > 2 ? 2 : 1)}…@${m[2]}`;
}

function displayOf(abs) {
  const home = homeBase();
  const rel = path.relative(home, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return `~/${rel.split(path.sep).join('/')}`;
  if (!rel) return '~';
  return abs.split(path.sep).join('/');
}

function absDir(value, what) {
  if (typeof value !== 'string' || !value.trim()) throw new UsageError(`${what}: pathAbs is missing`);
  const raw = value.trim();
  if (!path.isAbsolute(raw) && !/^\/[a-zA-Z](\/|$)/.test(raw) && !raw.startsWith('~')) throw new UsageError(`${what}: pathAbs must be an absolute path`);
  const abs = normalizeInputPath(raw);
  if (!isDir(abs)) throw new UsageError(`${what}: pathAbs is not a directory on this machine`);
  return abs;
}

function parseSelection(sel) {
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) throw new UsageError('the selection must be a JSON object { accounts, primary, projects }');
  const matchers = homeMatchers();
  const display = (p, abs) => (typeof p === 'string' && p.trim() ? scrubString(p.trim(), matchers) : displayOf(abs));

  const accounts = [];
  const seen = new Set();
  for (const [i, a] of (Array.isArray(sel.accounts) ? sel.accounts : []).entries()) {
    const what = `accounts[${i}]`;
    if (!a || typeof a !== 'object') throw new UsageError(`${what}: pass the account objects printed by \`accounts.mjs list\`, not ids`);
    if (typeof a.id !== 'string' || !ACCOUNT_ID_RE.test(a.id)) throw new UsageError(`${what}: id must match [a-z0-9][a-z0-9-]*`);
    if (seen.has(a.id)) throw new UsageError(`${what}: duplicate account id`);
    seen.add(a.id);
    const pathAbs = absDir(a.pathAbs, what);
    const out = {
      id: a.id,
      provider: PROVIDERS.includes(a.provider) ? a.provider : 'other',
      label: typeof a.label === 'string' && a.label.trim() ? a.label.trim() : a.id,
      path: display(a.path, pathAbs),
      pathAbs,
    };
    const identity = maskIdentity(a.identity);
    if (identity) out.identity = identity;
    if (typeof a.isDefault === 'boolean') out.isDefault = a.isDefault;
    if (typeof a.host === 'string' && a.host.trim()) out.host = a.host.trim();
    if (typeof a.linksInto === 'string' && a.linksInto.trim()) out.linksInto = a.linksInto.trim();
    if (Number.isInteger(a.elements) && a.elements >= 0) out.elements = a.elements;
    if (typeof a.empty === 'boolean') out.empty = a.empty;
    accounts.push(out);
  }

  const projects = [];
  for (const [i, raw] of (Array.isArray(sel.projects) ? sel.projects : []).entries()) {
    const what = `projects[${i}]`;
    const p = typeof raw === 'string' ? { pathAbs: raw } : raw;
    if (!p || typeof p !== 'object') throw new UsageError(`${what}: expected { name, path, pathAbs }`);
    const pathAbs = absDir(p.pathAbs, what);
    const out = {
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : path.basename(pathAbs),
      path: display(p.path, pathAbs),
      pathAbs,
    };
    // What find-projects.mjs already knows; the snapshot's own values win when it has them.
    const hints = {};
    const project = {};
    if (typeof p.isCode === 'boolean') project.isCode = p.isCode;
    if (Number.isInteger(p.worktrees) && p.worktrees >= 0) project.worktrees = p.worktrees;
    const activity = {};
    if (Number.isInteger(p.sessions) && p.sessions >= 0) activity.sessions = p.sessions;
    if (isDateTime(p.lastActive)) activity.lastActive = p.lastActive;
    if (Object.keys(project).length) hints.project = project;
    if (Object.keys(activity).length) hints.activity = activity;
    if (Object.keys(hints).length) out.hints = hints;
    projects.push(out);
  }

  if (!accounts.length && !projects.length) throw new UsageError('the selection has no account and no project');
  let primary = null;
  if (sel.primary !== undefined && sel.primary !== null) {
    if (!accounts.some((a) => a.id === sel.primary)) throw new UsageError('primary must be the id of one of the selected accounts, or null');
    primary = sel.primary;
  }
  return { accounts, projects, primary };
}

/**
 * The score each harness ended its last review with, per new harness id: from its review record,
 * else, for a harness whose reviews predate records, from the state.json of the most recent
 * earlier run that scored it. `unrecorded` lists those runs: `history --write` gives them a
 * record, so the next review can compare with them.
 */
function previousScores(harnesses) {
  const scores = {};
  const pending = [];
  for (const h of harnesses) {
    const list = listRecords(h.harnessKey);
    if (!list.length) { pending.push(h); continue; }
    const last = list[list.length - 1].record;
    if (typeof last.scores.current === 'number') scores[h.id] = last.scores.current;
  }
  const unrecorded = new Set();
  let runs = [];
  try { runs = pending.length ? fs.readdirSync(runsDir()).filter((n) => RUN_ID_RE.test(n)).sort().reverse().slice(0, 25) : []; } catch { runs = []; }
  const states = [];
  for (const id of runs) {
    try {
      const p = runPaths(id);
      const state = JSON.parse(fs.readFileSync(p.state, 'utf8'));
      if (state && Array.isArray(state.harnesses) && state.run && typeof state.run.startedAt === 'string') states.push(state);
    } catch { /* no state yet, or unreadable */ }
  }
  states.sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));
  for (const h of pending) {
    for (const s of states) {
      const old = s.harnesses.find((x) => x.kind === h.kind && x.path === h.path && (h.kind !== 'user' || x.account === h.account));
      if (old && old.scores && typeof old.scores.current === 'number') {
        scores[h.id] = old.scores.current;
        if (typeof s.run.id === 'string' && RUN_ID_RE.test(s.run.id)) unrecorded.add(s.run.id);
        break;
      }
    }
  }
  return { scores, unrecorded };
}

/**
 * `--follow-up <runId|latest>`: the selection of an earlier run, as far as it still exists.
 * `{ runId, run, selection, dropped }`; `dropped` lists the harnesses whose folder is gone.
 */
function followUpBase(value) {
  if (typeof value !== 'string' || !value.trim()) throw new UsageError('--follow-up takes a run id, or latest');
  const runId = value.trim() === 'latest' ? latestRunId() : value.trim();
  if (!runId) throw new RunError('no run found to follow up: start one with `run.mjs init --select <selection.json>`');
  if (!RUN_ID_RE.test(runId)) throw new UsageError('--follow-up takes a run id such as 20260101-ab12, or latest');
  let old = null;
  try { old = readJson(runPaths(runId).run); } catch { old = null; }
  if (!old || !Array.isArray(old.harnesses)) throw new RunError(`run ${runId} not found`);
  const dropped = [];
  const accounts = [];
  for (const a of Array.isArray(old.accounts) ? old.accounts : []) {
    if (!a || typeof a !== 'object') continue;
    if (typeof a.pathAbs === 'string' && isDir(a.pathAbs)) { const { harness: _harness, ...account } = a; accounts.push(account); }
    else dropped.push({ kind: 'user', name: a.label || a.id, path: a.path, reason: 'folder not found' });
  }
  const projects = [];
  for (const h of old.harnesses) {
    if (!h || h.kind !== 'project') continue;
    if (typeof h.pathAbs === 'string' && isDir(h.pathAbs)) {
      // What the folder is does not change from one run to the next; how active it was does.
      const project = (h.hints && h.hints.project) || {};
      projects.push({ name: h.name, path: h.path, pathAbs: h.pathAbs, ...(typeof project.isCode === 'boolean' ? { isCode: project.isCode } : {}), ...(Number.isInteger(project.worktrees) ? { worktrees: project.worktrees } : {}) });
    } else dropped.push({ kind: 'project', name: h.name, path: h.path, reason: 'folder not found' });
  }
  if (!accounts.length && !projects.length) throw new RunError(`none of the harnesses of run ${runId} exists any more`, { dropped });
  const primary = accounts.some((a) => a.id === old.primary) ? old.primary : null;
  return { runId, run: old, selection: { accounts, primary, projects }, dropped };
}

export function init(args) {
  if (args.select !== undefined && args['follow-up'] !== undefined) throw new UsageError('pass --select <selection.json> or --follow-up <runId|latest>, not both');
  if (args['follow-up'] === undefined && typeof args.select !== 'string') throw new UsageError('init needs --select <selection.json>, or --follow-up <runId|latest>');
  // The run this one follows up gives the selection, and the mode and language unless a flag says
  // otherwise. Measuring is not a way of reviewing that carries over: the run after a measure-only
  // baseline is a review (guided) unless `--mode measure` asks to measure again.
  const base = args['follow-up'] === undefined ? null : followUpBase(args['follow-up']);
  const mode = args.mode === undefined ? (base && ['guided', 'doctor'].includes(base.run.mode) ? base.run.mode : 'guided') : args.mode;
  if (!MODES.includes(mode)) throw new UsageError('--mode must be guided, doctor or measure');
  const days = args.days === undefined ? 30 : Number(args.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new UsageError('--days must be a whole number from 1 to 365');
  const language = args.lang === undefined ? (base && ['pt', 'en'].includes(base.run.language) ? base.run.language : 'en') : args.lang;
  if (!['pt', 'en'].includes(language)) throw new UsageError('--lang must be pt or en');
  let title;
  if (args.title !== undefined) {
    if (typeof args.title !== 'string' || !args.title.trim()) throw new UsageError('--title needs a text');
    title = args.title.trim().slice(0, 80);
    if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(title)) throw new UsageError('--title must not be an e-mail address: use a first name or the project name');
    if (hasCredential(args.title)) throw new UsageError('--title must not hold a credential: use a first name or the project name');
    title = scrubString(title, homeMatchers());
  }
  const agent = args.agent === undefined ? detectAgent() : args.agent;
  if (!AGENTS.includes(agent)) throw new UsageError(`--agent must be one of ${AGENTS.join(', ')}`);

  let rawSelection = base ? base.selection : null;
  if (!base) {
    rawSelection = readJson(normalizeInputPath(args.select));
    if (rawSelection === null) throw new UsageError('selection file not found');
  }
  const selection = parseSelection(rawSelection);
  const { accounts, harnesses } = assignHarnesses(selection.accounts, selection.projects);

  // Review records: the stable key of every harness and, for one that was reviewed before, its
  // last record and its own window (references/follow-up.md, "Window").
  const now = nowMs();
  const followed = new Map();
  let reviewedAt = null;
  for (const h of harnesses) {
    h.harnessKey = harnessKeyOf(h);
    const list = listRecords(h.harnessKey);
    if (!list.length) continue;
    const last = list[list.length - 1];
    const window = followUpWindow(last.record, now, days, loadThresholds());
    h.lastRecord = { runId: last.record.runId, reviewedAt: last.record.reviewedAt, file: last.file };
    h.windowDays = window.windowDays;
    followed.set(h.id, { runId: last.record.runId, reviewedAt: last.record.reviewedAt, days: window.days, windowDays: window.windowDays });
    const ofBase = base ? list.find((e) => e.record.runId === base.runId) : null;
    if (ofBase && (reviewedAt === null || ofBase.record.reviewedAt > reviewedAt)) reviewedAt = ofBase.record.reviewedAt;
  }
  // An experiment open on a harness (experiments.mjs): judged at the moment this run starts, as
  // every later command of the run judges it.
  const createdAt = new Date(now).toISOString();
  for (const h of harnesses) {
    const e = experimentFor({ runId: '', createdAt }, h);
    if (e) h.experiment = e;
  }
  const previous = previousScores(harnesses);
  if (base && reviewedAt === null) previous.unrecorded.add(base.runId);
  const unrecorded = [...previous.unrecorded].sort();
  const followUpOf = base ? { runId: base.runId, ...(reviewedAt ? { reviewedAt } : {}) } : null;

  // Reserve the run directory: an exclusive mkdir, so two inits never share one.
  fs.mkdirSync(runsDir(), { recursive: true });
  let paths = null;
  for (let i = 0; i < 20 && !paths; i++) {
    const candidate = runPaths(newRunId());
    try { fs.mkdirSync(candidate.dir); paths = candidate; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  if (!paths) throw new RunError('could not reserve a run id');

  const run = {
    version: 1,
    runId: paths.runId,
    createdAt,
    mode,
    language,
    ...(title ? { title } : {}),
    windowDays: days,
    ...(followUpOf ? { followUpOf } : {}),
    primary: selection.primary,
    environment: { agent, os: detectOs() },
    accounts,
    harnesses,
    previousScores: previous.scores,
    closed: false,
  };
  for (const d of [paths.claims, paths.probes, paths.findings, paths.backups, paths.drafts]) fs.mkdirSync(d, { recursive: true });
  writeJsonAtomic(paths.run, run);
  writeJsonAtomic(paths.queue, queueSnapshot(unitsView(paths, run, null, [])));
  writeJsonAtomic(paths.status, emptyStatus());
  writeJsonAtomic(paths.ledger, { version: 1, entries: [] });
  appendLog(paths, { event: 'run-started', harnesses: harnesses.length });
  writeJsonAtomic(latestPath(), { runId: paths.runId, at: run.createdAt });

  return {
    runId: paths.runId,
    dir: paths.dir,
    mode,
    harnesses: harnesses.map((h) => ({
      id: h.id, key: h.key, kind: h.kind, name: h.name, path: h.path, ...(h.inherits ? { inherits: h.inherits } : {}),
      harnessKey: h.harnessKey, ...(followed.has(h.id) ? { followUp: followed.get(h.id) } : {}),
      ...(h.experiment ? { experiment: h.experiment } : {}),
    })),
    units: staticUnits(run).map((u) => u.id),
    ...(followUpOf ? { followUpOf } : {}),
    ...(base && base.dropped.length ? { dropped: base.dropped } : {}),
    ...(unrecorded.length ? { unrecordedRuns: unrecorded, hint: 'these earlier runs left no review record: `run.mjs history --write --run <id>` writes it, and a run started after that is compared with it' } : {}),
  };
}

/** `run.mjs list`: runs on this machine, newest first. */
export function listRuns() {
  let names = [];
  try { names = fs.readdirSync(runsDir()).filter((n) => RUN_ID_RE.test(n)); } catch { /* no run yet */ }
  const latest = latestRunId();
  const runs = [];
  for (const id of names) {
    let run = null;
    try { run = readJson(runPaths(id).run); } catch { run = null; }
    if (!run || !Array.isArray(run.harnesses)) continue;
    runs.push({
      runId: id, createdAt: run.createdAt || null, ...(run.title ? { title: run.title } : {}), mode: run.mode,
      harnesses: run.harnesses.length, closed: run.closed === true, ...(run.closedAt ? { closedAt: run.closedAt } : {}), latest: id === latest,
    });
  }
  runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.runId.localeCompare(a.runId));
  return { runs };
}

/**
 * Mark the run closed at `at` (the last step of `run.mjs close`, history.mjs). Must run under the
 * run mutex. `serve-board.mjs` exits when it sees it.
 */
export function markClosed(ctx, at) {
  const run = readJson(ctx.paths.run);
  run.closed = true;
  run.closedAt = at;
  writeJsonAtomic(ctx.paths.run, run);
  ctx.run = run;
  appendLog(ctx.paths, { at, event: 'run-closed' });
  return { runId: ctx.paths.runId, closed: true, closedAt: at };
}
