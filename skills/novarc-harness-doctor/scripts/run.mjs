#!/usr/bin/env node
// run.mjs <command> [options]: the bookkeeping of a harness review run, so that agents only
// write findings. A run lives on disk under ~/.novarc-powers/novarc-harness-doctor/runs/<runId>/
// and any session can work on it or resume it. Commands and file formats: references/contracts.md.
//
// `run.mjs --help` lists every command with its options; `run.mjs <command> --help` shows one.
// Both come from the COMMANDS table below, which is also the list of options a command accepts.
//
// JSON on stdout, diagnostics on stderr. Exit 0 on success, 2 on a bad command line, 1 on failure
// (stdout then holds { "ok": false, "error": ... }). Without --run the latest run is used.
// Nothing is ever written outside the run directory, except by `undo`, which restores the files
// the run itself changed, and by what leaves a review record under history/ next to runs/: `close`
// and `history --write`, then `mark`, `record` and `undo` for a run that already has one.
// NOVARC_POWERS_HOME replaces the home directory and NOVARC_HD_NOW the clock (tests).
import { parseArgs, isMain, printJson, warn, normalizeInputPath } from './lib/common.mjs';
import { RunError, UsageError, Plain, sleepSync } from './lib/run/store.mjs';
import { resolveRunId, loadRun } from './lib/run/model.mjs';
import { init, listRuns } from './lib/run/init.mjs';
import { closeRun, history } from './lib/run/history.mjs';
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

const RUN = '[--run <id>]';

/**
 * Every command: its options (one line per form), what it does, and the function that runs it.
 * The usage that `--help` prints and the options a command accepts are both read from `usage`, so
 * they cannot drift apart: an option that is not written there is refused as a bad command line.
 */
const COMMANDS = {
  init: {
    usage: [
      '--select <selection.json> [--mode guided|doctor] [--days 30] [--lang pt|en] [--title <t>] [--agent <a>]',
      '--follow-up <runId|latest> [--mode guided|doctor] [--days 30] [--lang pt|en] [--title <t>] [--agent <a>]',
    ],
    about: 'Start a run from a selection of accounts and projects, or over the harnesses of an earlier run (the ones that still exist). A harness that has a review record is measured since that review.',
    run: (args) => init(args),
  },
  list: {
    usage: [''],
    about: 'List the runs on this machine.',
    run: () => listRuns(),
  },
  history: {
    usage: ['[--harness <key|path>] [--json] [--lang pt|en]', `--write ${RUN}`],
    about: 'Say what was reviewed before, per harness, and which follow-ups are due (text, or JSON with --json); with --write, write the review records of a run without closing it.',
    run: (args) => history(args),
  },
  status: {
    usage: [RUN],
    about: 'Show where a run stands: harnesses, units, decisions.',
    run: (args) => statusReport(ctxOf(args)),
  },
  probe: {
    usage: [`${RUN} [--harness <id>|accounts] [--timeout <seconds>] [--concurrency <n>]`],
    about: 'Inventory and measure every harness (or one) into probes/.',
    run: (args) => probe(ctxOf(args), args),
  },
  claim: {
    usage: [`${RUN} [--unit <unitId>] --session <label> [--ttl <minutes>]`],
    about: 'Take the next free unit, or the one named, and print its brief.',
    run: (args) => {
      let ttlMinutes = DEFAULT_TTL_MINUTES;
      if (args.ttl !== undefined) {
        ttlMinutes = Number(args.ttl);
        if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > 1440) throw new UsageError('--ttl takes minutes, from 1 to 1440');
      }
      return claim(ctxOf(args), { unitId: unitArg(args, false), session: requireSession(args), ttlMinutes });
    },
  },
  release: {
    usage: [`${RUN} --unit <unitId> --session <label>`],
    about: 'Give a claimed unit back.',
    run: (args) => release(ctxOf(args), { unitId: unitArg(args, true), session: requireSession(args) }),
  },
  complete: {
    usage: [`${RUN} --unit <unitId> --session <label> --findings <file>`, `${RUN} --unit apply:<harness> --session <label>`],
    about: 'Hand in the findings of a review unit, or finish an apply unit. A decision made on an item that comes back changed is cleared.',
    run: (args) => complete(ctxOf(args), { unitId: unitArg(args, true), session: requireSession(args), findingsPath: fileArg(args, 'findings') }),
  },
  build: {
    usage: [`${RUN} [--channel artifact|server|file] [--files all|changed] [--agent <a>] [--no-render]`],
    about: 'Merge the run into state.json and render the board.',
    run: (args) => build(ctxOf(args), args),
  },
  decide: {
    usage: [
      `${RUN} --target <itemId|groupId|accounts.primary> --action approve|decline|defer|ask [--note <t>] [--exclude <id,id>] [--rev <rev>]`,
      `${RUN} --target <itemId|accounts.primary> --answered`,
    ],
    about: 'Record a decision made in chat (bound to --rev, else to the item as it is now), or clear a question that was answered.',
    run: (args) => decide(ctxOf(args), args),
  },
  decisions: {
    usage: [`${RUN} [--ingest <file.json|directory>]`],
    about: 'Take in the decisions the board sent, and those of an Artifact database export (one file, or a directory of one JSON file per document).',
    run: (args) => decisions(ctxOf(args), fileArg(args, 'ingest')),
  },
  mark: {
    usage: [`${RUN} --item <id> --status in-progress|fixed|failed [--verified <t>] [--not-verified <t>] [--auto] [--rev <rev>]`],
    about: 'Move an item along approved -> in-progress -> fixed | failed. With --rev, in-progress is refused unless the item still is that revision. A run that already left review records has them written again.',
    run: (args) => mark(ctxOf(args), args),
  },
  record: {
    usage: [`${RUN} --item <id> --path <abs> (--backup <abs> [--masked] | --new)`],
    about: 'Record a file change in the ledger, so that it can be undone.',
    run: (args) => record(ctxOf(args), args),
  },
  undo: {
    usage: [`${RUN} (--item <id> | --all) [--dry-run] --yes`],
    about: 'Restore the files the run changed, for one item or for all. A run that already left review records has them written again.',
    run: (args) => undo(ctxOf(args), args),
  },
  next: {
    usage: [RUN],
    about: 'Say what should happen next.',
    run: (args) => next(ctxOf(args)),
  },
  close: {
    usage: [RUN],
    about: 'Write the review record of every harness, then mark the run closed.',
    run: (args) => closeRun(ctxOf(args)),
  },
};

const NAMES = Object.keys(COMMANDS);

/** The option names a command accepts: every `--name` written in its usage. */
export function optionsOf(command) {
  return new Set([...COMMANDS[command].usage.join(' ').matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
}

const usageLines = (command) => COMMANDS[command].usage.map((u) => `run.mjs ${command}${u ? ` ${u}` : ''}`);

/** The usage text: of one command, or of all of them. */
export function helpText(command) {
  if (command) return `${usageLines(command).join('\n')}\n\n${COMMANDS[command].about}\n`;
  const out = [
    'run.mjs <command> [options]',
    '',
    'The bookkeeping of a harness review run. A run lives on disk, so any session can work on it or',
    'resume it; without --run the latest run is used.',
    '',
    'Commands:',
  ];
  for (const name of NAMES) {
    out.push(`  ${name}`);
    out.push(`      ${COMMANDS[name].about}`);
    for (const line of usageLines(name)) out.push(`      ${line}`);
  }
  out.push(
    '',
    '`run.mjs <command> --help` shows one command. A command prints JSON on stdout and diagnostics on',
    'stderr, and exits 0 on success, 2 on a bad command line, 1 on failure. An option that is not',
    'listed above is refused. File formats: references/contracts.md.',
    '',
  );
  return out.join('\n');
}

const isHelpFlag = (a) => a === '--help' || a === '-h';

/**
 * Run one command. Returns { code, output }, or { code: 0, text } when usage was asked for
 * (`--help` or `-h` anywhere on the command line: nothing runs then). Never throws.
 */
export async function runCommand(argv) {
  const [command, ...rest] = argv;
  const scrub = (s) => scrubString(String(s), homeMatchers());
  try {
    if (command === 'help' || (command !== undefined && isHelpFlag(command))) {
      const about = rest.find((a) => Object.hasOwn(COMMANDS, a));
      return { code: 0, text: helpText(about) };
    }
    if (!command || !Object.hasOwn(COMMANDS, command)) {
      if (command && command.startsWith('-') && rest.some(isHelpFlag)) return { code: 0, text: helpText() };
      throw new UsageError(`usage: run.mjs <${NAMES.join('|')}> [options] (run.mjs --help lists every option)`);
    }
    if (rest.some(isHelpFlag)) return { code: 0, text: helpText(command) };
    const args = parseArgs(rest);
    if (args._.length) throw new UsageError(`unexpected argument "${args._[0]}": every option is a --flag`);
    const allowed = optionsOf(command);
    for (const k of Object.keys(args)) {
      if (k !== '_' && !allowed.has(k)) throw new UsageError(`unknown option --${k} for ${command} (see run.mjs ${command} --help)`);
    }
    const output = await COMMANDS[command].run(args);
    return output instanceof Plain ? { code: 0, text: output.text } : { code: 0, output };
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
  runCommand(process.argv.slice(2)).then(({ code, output, text }) => {
    if (text !== undefined) process.stdout.write(text);
    else {
      if (code !== 0) warn(output.error);
      printJson(output);
    }
    process.exitCode = code;
  });
}
