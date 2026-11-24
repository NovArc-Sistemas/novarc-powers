// `run.mjs probe`: run the read-only probe scripts for every harness of the run, as child
// processes of this same Node binary, and keep their JSON under `probes/<harness>/`:
// discover, harness-checks, session-impact, probe-clis, then snapshot-harness (told where the
// impact and CLI results are) and impact-estimates (told where all of them are).
// A probe that fails, times out or prints something that is not JSON is recorded next to where
// its output would be (`<name>.error.json`) and never stops the others.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RunError, UsageError, readJson, writeJsonAtomic, writeTextAtomic, withLock, nowIso } from './store.mjs';
import { scriptPath } from './paths.mjs';
import { homeMatchers, scrubString } from './scrub.mjs';

/** probe name -> script file and output file. */
export const PROBES = {
  discover: { script: 'discover.mjs', file: 'discover.json' },
  checks: { script: 'harness-checks.mjs', file: 'checks.json' },
  impact: { script: 'session-impact.mjs', file: 'impact.json' },
  clis: { script: 'probe-clis.mjs', file: 'clis.json' },
  snapshot: { script: 'snapshot-harness.mjs', file: 'snapshot.json' },
  estimates: { script: 'impact-estimates.mjs', file: 'estimates.json' },
};
const ACCOUNTS_SCRIPT = 'accounts.mjs';
const MAX_OUTPUT_BYTES = 96 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300000;

/** Run one script and collect its stdout. Never rejects. */
function runScript(scriptFile, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const file = scriptPath(scriptFile);
    if (!fs.existsSync(file)) { resolve({ ok: false, error: 'script not found', ms: 0 }); return; }
    let child;
    try {
      child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env });
    } catch (e) { resolve({ ok: false, error: `could not start (${e && e.code ? e.code : 'spawn error'})`, ms: 0 }); return; }
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    let timedOut = false;
    let tooLarge = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_OUTPUT_BYTES) { tooLarge = true; child.kill(); return; }
      chunks.push(c);
    });
    child.stderr.on('data', (c) => { stderr = (stderr + c.toString('utf8')).slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: `could not start (${e && e.code ? e.code : 'spawn error'})`, ms: Date.now() - started }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      const tail = stderr.trim();
      if (timedOut) { resolve({ ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)} s`, timedOut: true, stderr: tail, ms }); return; }
      if (tooLarge) { resolve({ ok: false, error: 'output too large', stderr: tail, ms }); return; }
      if (code !== 0) { resolve({ ok: false, error: signal ? `killed by ${signal}` : `exit code ${code}`, exitCode: code, stderr: tail, ms }); return; }
      const stdout = Buffer.concat(chunks).toString('utf8');
      let parsed;
      try { parsed = JSON.parse(stdout.replace(/^﻿/, '')); } catch { parsed = undefined; }
      if (parsed === null || typeof parsed !== 'object') { resolve({ ok: false, error: 'output is not a JSON object', exitCode: 0, stderr: tail, ms }); return; }
      resolve({ ok: true, stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`, bytes, ms });
    });
  });
}

/** Keep a probe's output, or the record of its failure, under `dir`. Returns the summary entry. */
function store(dir, name, fileName, scriptFile, res, matchers) {
  const out = path.join(dir, fileName);
  const err = path.join(dir, `${name}.error.json`);
  if (res.ok) {
    writeTextAtomic(out, res.stdout);
    fs.rmSync(err, { force: true });
    return { ok: true, ms: res.ms, bytes: res.bytes, ...(res.toolsFrom ? { toolsFrom: res.toolsFrom } : {}) };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(out, { force: true }); // the folder reflects the last probe run, not an older success
  writeJsonAtomic(err, {
    probe: name,
    script: scriptFile,
    error: res.error,
    ...(res.exitCode !== undefined ? { exitCode: res.exitCode } : {}),
    ...(res.timedOut ? { timedOut: true } : {}),
    stderr: scrubString(res.stderr || '', matchers),
    at: nowIso(),
  });
  return { ok: false, error: res.error, ms: res.ms };
}

async function probeHarness(ctx, h, opts, shared) {
  const dir = ctx.paths.probeDir(h.id);
  fs.mkdirSync(dir, { recursive: true });
  // A harness with an earlier review record may carry its own window (`run.mjs init` writes it:
  // the days since that review); every other harness is measured over the run's window.
  const days = String(Number.isInteger(h.windowDays) && h.windowDays > 0 ? h.windowDays : (ctx.run.windowDays || 30));
  const result = {};
  const one = async (name, args, runner) => {
    const p = PROBES[name];
    const res = runner ? await runner() : await runScript(p.script, args, opts.timeoutMs);
    result[name] = store(dir, name, p.file, p.script, res, opts.matchers);
    return result[name].ok;
  };

  const fileOf = (name) => path.join(dir, PROBES[name].file);
  // A user harness is one account: one config dir of one provider. Told so, the two scripts read
  // that dir and nothing of any other account; without the two flags `--scope user` means every
  // account on the machine, and each account's probe would carry the others' files and findings.
  const where = h.kind === 'project'
    ? ['--scope', 'project', '--cwd', h.pathAbs]
    : ['--scope', 'user', '--cwd', h.pathAbs, '--provider', h.provider || 'other', '--config-dir', h.pathAbs];
  const discoverOk = await one('discover', where);
  await one('checks', where);
  let impactOk = false;
  const skip = shared.impactSkip.get(h.id);
  if (h.kind === 'project') impactOk = await one('impact', ['--cwd', h.pathAbs, '--days', days]);
  else if (skip) {
    // Not measured on purpose: its sessions are another account's, or no reader exists for it.
    fs.rmSync(fileOf('impact'), { force: true });
    fs.rmSync(path.join(dir, 'impact.error.json'), { force: true });
    result.impact = { ok: false, skipped: skip.reason, ...(skip.with ? { with: skip.with } : {}) };
  }
  // An account is measured on its own sessions: one Claude config dir, or the Codex home.
  else if (h.provider === 'claude-code') impactOk = await one('impact', ['--scope', 'user', '--days', days, '--config-dirs', h.pathAbs, '--sources', 'claude']);
  else impactOk = await one('impact', ['--scope', 'user', '--days', days, '--sources', 'codex', '--codex-dirs', h.pathAbs]);
  // The CLI probe has a part about the machine (which CLIs are on PATH, what they answer) and a
  // part about the harness (its signals, the MCP servers configured for it). A project runs it
  // whole. The accounts share the machine: the first of them runs it whole, the others reuse
  // that part and read only their own config dir, so each account's file names its own servers.
  const clisOk = h.kind === 'project'
    ? await one('clis', ['--cwd', h.pathAbs])
    : await one('clis', null, () => shared.userClis(h, fileOf('clis')));

  // What the board shows as it is comes in the language of the run: the snapshot's layer names
  // and notes here, the estimates below.
  const lang = ctx.run.language === 'pt' ? 'pt' : 'en';
  const snapArgs = h.kind === 'project'
    ? ['--kind', 'project', '--cwd', h.pathAbs, '--id', h.id, '--lang', lang]
    : ['--kind', 'user', '--config-dir', h.pathAbs, '--provider', h.provider || 'other', '--id', h.id, '--lang', lang];
  if (impactOk) snapArgs.push('--impact', fileOf('impact'));
  if (clisOk) snapArgs.push('--clis', fileOf('clis'));
  const snapshotOk = await one('snapshot', snapArgs);

  // Estimates multiply what was measured by catalog factors: no measurement, nothing to estimate.
  if (impactOk) {
    const estArgs = ['--impact', fileOf('impact'), '--lang', lang];
    if (clisOk) estArgs.push('--clis', fileOf('clis'));
    if (snapshotOk) estArgs.push('--snapshot', fileOf('snapshot'));
    if (discoverOk) estArgs.push('--discover', fileOf('discover'));
    await one('estimates', estArgs);
  } else {
    fs.rmSync(fileOf('estimates'), { force: true });
    fs.rmSync(path.join(dir, 'estimates.error.json'), { force: true });
  }
  return { id: h.id, probes: result };
}

/**
 * User harnesses whose impact is not measured, and why. Accounts that share one sessions folder
 * (a linked account) are measured once, under the primary when it is one of them; providers
 * without a transcript reader are not measured at all.
 */
export function impactSkips(run) {
  const skips = new Map();
  const owner = new Map();
  const users = (run.harnesses || []).filter((h) => h.kind === 'user');
  const primaryHarness = (run.accounts || []).find((a) => a.id === run.primary);
  const first = primaryHarness ? users.filter((h) => h.account === primaryHarness.id || h.id === primaryHarness.harness) : [];
  for (const h of [...first, ...users.filter((u) => !first.includes(u))]) {
    if (h.provider === 'claude-code') {
      let real = null;
      try { real = fs.realpathSync.native(path.join(h.pathAbs, 'projects')); } catch { real = null; }
      if (!real) continue;
      const key = process.platform === 'win32' ? real.toLowerCase() : real;
      if (owner.has(key)) skips.set(h.id, { reason: 'shared-sessions', with: owner.get(key) });
      else owner.set(key, h.id);
    } else if (h.provider !== 'codex') skips.set(h.id, { reason: 'no-transcript-reader' });
  }
  return skips;
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(lanes);
  return out;
}

/** `probe [--harness <id>] [--timeout <seconds>] [--concurrency <n>]`. */
export async function probe(ctx, args) {
  const { run, paths } = ctx;
  const envTimeout = Number(process.env.NOVARC_HD_PROBE_TIMEOUT_MS);
  let timeoutMs = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS;
  if (args.timeout !== undefined) {
    const s = Number(args.timeout);
    if (!Number.isFinite(s) || s <= 0) throw new UsageError('--timeout takes seconds, e.g. --timeout 600');
    timeoutMs = Math.round(s * 1000);
  }
  let concurrency = 3;
  if (args.concurrency !== undefined) {
    concurrency = Number(args.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new UsageError('--concurrency takes a whole number from 1 to 16');
  }
  const wantAccounts = (run.accounts || []).length >= 2 && !!run.primary;
  let targets = run.harnesses;
  let accountsOnly = false;
  if (args.harness !== undefined) {
    if (args.harness === 'accounts') { accountsOnly = true; targets = []; }
    else {
      targets = run.harnesses.filter((h) => h.id === args.harness);
      if (!targets.length) throw new RunError(`no harness "${args.harness}" in this run`);
    }
  }
  const opts = { timeoutMs, matchers: homeMatchers() };

  // The whole CLI probe of the first account to ask for it: { owner, file, done }.
  let machine = null;
  const accountArgs = (h) => ['--cwd', h.pathAbs, '--provider', h.provider || 'other', '--config-dir', h.pathAbs];
  const shared = {
    impactSkip: impactSkips(run),
    /** The CLI probe of account `h`, whose output is kept in `file`. */
    userClis: async (h, file) => {
      if (!machine) {
        // The output is written here, before anything waiting on `done` goes on: it is what the
        // other accounts are pointed at. (The caller stores the same text again; each write is
        // a rename into place, so a reader gets one whole copy or the other.)
        const done = runScript(PROBES.clis.script, accountArgs(h), timeoutMs).then((res) => { if (res.ok) writeTextAtomic(file, res.stdout); return res; });
        machine = { owner: h.id, file, done };
        return done;
      }
      const whole = await machine.done;
      if (!whole.ok) return whole; // the machine could not be probed: one failure, not one per account
      const res = await runScript(PROBES.clis.script, [...accountArgs(h), '--tools-from', machine.file], timeoutMs);
      return res.ok ? { ...res, toolsFrom: machine.owner } : res;
    },
  };
  const started = Date.now();
  const harnesses = await pool(targets, concurrency, (h) => probeHarness(ctx, h, opts, shared));

  // Account comparison, once a primary is chosen: the `accounts` section of the state reads it.
  let accounts = null;
  if (wantAccounts && (accountsOnly || args.harness === undefined)) {
    const res = await runScript(ACCOUNTS_SCRIPT, ['diff', '--primary', run.primary, '--lang', run.language === 'pt' ? 'pt' : 'en'], timeoutMs);
    accounts = { diff: store(paths.probeDir('accounts'), 'diff', 'diff.json', ACCOUNTS_SCRIPT, res, opts.matchers) };
  }

  const at = nowIso();
  withLock(paths.mutex, () => {
    const prev = readJson(paths.probeSummary) || { harnesses: {} };
    const merged = { version: 1, at, windowDays: run.windowDays, harnesses: { ...(prev.harnesses || {}) } };
    for (const h of harnesses) merged.harnesses[h.id] = { at, ...h.probes };
    if (accounts) merged.accounts = { at, ...accounts };
    else if (prev.accounts) merged.accounts = prev.accounts;
    writeJsonAtomic(paths.probeSummary, merged);
  });

  const all = harnesses.flatMap((h) => Object.values(h.probes)).concat(accounts ? [accounts.diff] : []);
  return {
    runId: paths.runId,
    probesDir: paths.probes,
    harnesses,
    ...(accounts ? { accounts } : {}),
    ok: all.filter((p) => p.ok).length,
    failed: all.filter((p) => !p.ok && !p.skipped).length,
    skipped: all.filter((p) => p.skipped).length,
    ms: Date.now() - started,
  };
}
