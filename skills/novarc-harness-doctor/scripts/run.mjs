#!/usr/bin/env node
// run.mjs <command> [options]: the bookkeeping of a harness review run, so that agents only
// write findings. A run lives on disk under ~/.novarc-powers/novarc-harness-doctor/runs/<runId>/
// and any session can work on it or resume it. Commands and file formats: references/contracts.md.
//
//   init      --select <selection.json> [--mode guided|doctor] [--days 30] [--lang pt|en] [--title <t>] [--agent <a>]
//   list
//   status    [--run <id>]
//   probe     [--run <id>] [--harness <id>] [--timeout <seconds>] [--concurrency <n>]
//   claim     [--run <id>] [--unit <unitId>] --session <label> [--ttl <minutes>]
//   release   [--run <id>] --unit <unitId> --session <label>
//   complete  [--run <id>] --unit <unitId> --session <label> --findings <file>
//   build     [--run <id>] [--channel artifact|server|file] [--agent <a>] [--no-render]
//   decide    [--run <id>] --target <itemId|groupId|accounts.primary> --action approve|decline|defer|ask [--note <t>] [--exclude <id,id>]
//   decide    [--run <id>] --target <itemId|accounts.primary> --answered
//   decisions [--run <id>] [--ingest <file.json>]
//   mark      [--run <id>] --item <id> --status in-progress|fixed|failed [--verified <t>] [--not-verified <t>] [--auto]
//   record    [--run <id>] --item <id> --path <abs> (--backup <abs> | --new) [--masked]
//   undo      [--run <id>] (--item <id> | --all) [--dry-run] --yes
//   next      [--run <id>]
//   close     [--run <id>]
//
// JSON on stdout, diagnostics on stderr. Exit 0 on success, 2 on a bad command line, 1 on failure
// (stdout then holds { "ok": false, "error": ... }). Without --run the latest run is used.
// Nothing is ever written outside the run directory, except by `undo`, which restores the files
// the run itself changed. NOVARC_POWERS_HOME replaces the home directory (tests).
import { parseArgs, isMain, printJson, warn, normalizeInputPath } from './lib/common.mjs';
import { RunError, UsageError, sleepSync } from './lib/run/store.mjs';
import { resolveRunId, loadRun } from './lib/run/model.mjs';
import { init, listRuns, close } from './lib/run/init.mjs';
import { probe } from './lib/run/probe.mjs';
import { claim, release, complete, requireSession } from './lib/run/claims.mjs';
import { build } from './lib/run/build.mjs';
import { decide, decisions } from './lib/run/decisions.mjs';
import { mark, record, undo } from './lib/run/apply.mjs';
import { statusReport, next } from './lib/run/overview.mjs';
import { homeMatchers, scrubString } from './lib/run/scrub.mjs';
import { DEFAULT_TTL_MINUTES } from './lib/run/units.mjs';

const UNIT_RE = /^(review:[a-z-]+(#[0-9]{1,3})?|accounts|apply:[a-z0-9][a-z0-9-]*)$/;

const ctxOf = (args) => loadRun(resolveRunId(args));

function unitArg(args, required) {
  if (args.unit === undefined) {
    if (required) throw new UsageError('this command needs --unit <unitId> (see `run.mjs status`)');
    return null;
  }
  if (typeof args.unit !== 'string' || !UNIT_RE.test(args.unit)) throw new UsageError('--unit takes a unit id such as review:security, accounts or apply:<harness>');
  return args.unit;
}

function fileArg(args, name) {
  if (args[name] === undefined) return null;
  if (typeof args[name] !== 'string') throw new UsageError(`--${name} needs a file path`);
  return normalizeInputPath(args[name]);
}

const COMMANDS = {
  init: (args) => init(args),
  list: () => listRuns(),
  status: (args) => statusReport(ctxOf(args)),
  probe: (args) => probe(ctxOf(args), args),
  claim: (args) => {
    let ttlMinutes = DEFAULT_TTL_MINUTES;
    if (args.ttl !== undefined) {
      ttlMinutes = Number(args.ttl);
      if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > 1440) throw new UsageError('--ttl takes minutes, from 1 to 1440');
    }
    return claim(ctxOf(args), { unitId: unitArg(args, false), session: requireSession(args), ttlMinutes });
  },
  release: (args) => release(ctxOf(args), { unitId: unitArg(args, true), session: requireSession(args) }),
  complete: (args) => complete(ctxOf(args), { unitId: unitArg(args, true), session: requireSession(args), findingsPath: fileArg(args, 'findings') }),
  build: (args) => build(ctxOf(args), args),
  decide: (args) => decide(ctxOf(args), args),
  decisions: (args) => decisions(ctxOf(args), fileArg(args, 'ingest')),
  mark: (args) => mark(ctxOf(args), args),
  record: (args) => record(ctxOf(args), args),
  undo: (args) => undo(ctxOf(args), args),
  next: (args) => next(ctxOf(args)),
  close: (args) => close(ctxOf(args)),
};

/** Run one command. Returns { code, output }; never throws. */
export async function runCommand(argv) {
  const [command, ...rest] = argv;
  const scrub = (s) => scrubString(String(s), homeMatchers());
  try {
    if (!command || !Object.hasOwn(COMMANDS, command)) throw new UsageError(`usage: run.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    const args = parseArgs(rest);
    if (args._.length) throw new UsageError(`unexpected argument "${args._[0]}": every option is a --flag`);
    return { code: 0, output: await COMMANDS[command](args) };
  } catch (e) {
    if (e instanceof UsageError) return { code: 2, output: { ok: false, error: e.message } };
    if (e instanceof RunError) return { code: 1, output: { ok: false, error: e.message, ...(e.details || {}) } };
    // Unexpected: say what kind of failure, never a raw message that may carry a home path.
    return { code: 1, output: { ok: false, error: scrub(`unexpected failure: ${e && e.code ? `${e.code} ` : ''}${e && e.message ? e.message : e}`) } };
  }
}

/**
 * Test seam: NOVARC_HD_TEST_START_AT (epoch milliseconds) holds the command until that instant.
 * Processes start tens of milliseconds apart, which hides a race; released together they all
 * reach the same critical section at once, and a test of the locking means something.
 */
function startGate() {
  const at = Number(process.env.NOVARC_HD_TEST_START_AT);
  const wait = at - Date.now();
  if (Number.isFinite(wait) && wait > 0 && wait <= 30000) sleepSync(wait);
}

if (isMain(import.meta.url)) {
  startGate();
  runCommand(process.argv.slice(2)).then(({ code, output }) => {
    if (code !== 0) warn(output.error);
    printJson(output);
    process.exitCode = code;
  });
}
