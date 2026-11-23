#!/usr/bin/env node
// accounts.mjs <command>
//
//   list   [--lang pt|en]                                  every agent account on this machine
//   diff   --primary <id> [--lang pt|en]                   each other account against the primary
//   plan   --primary <id> [--lang pt|en] [--out <plan.json>]
//          [--resolve <account>:<element>=<option>]... [--only <id,id>] [--skip <id,id>]
//          [--drafts <dir>] [--symlinks]
//   apply  --plan <plan.json> [--dry-run] --yes [--new-primary]
//   undo   --stamp <stamp> [--dry-run] --yes
//   check  [--repair]
//   install-check --yes [--primary <id>] | uninstall-check --yes
//
// One account is the primary. Accounts of the same provider are LINKED to it; accounts of other
// providers get the portable subset REPLICATED from it. Credentials, sessions, history and
// caches are never linked, copied or read. `list`, `diff`, `plan` and `check` (without --repair)
// write nothing. JSON on stdout, diagnostics on stderr; exit 0 ok, 2 bad arguments, 1 failure.
// No output holds an absolute home path except the `pathAbs` field of `list`.
// `list`, `diff` and `plan` are shown to the user on the board: `--lang` (default en) words their
// labels, notes and reasons in the run language. Ids, states, modes, options and actions never
// change with the language.
// Contract: references/contracts.md. For the agent running the skill: references/accounts.md.
import fs from 'node:fs';
import path from 'node:path';
import { isMain, warn } from './lib/common.mjs';
import { IS_WIN, homeDir, displayPath, scrub, manifestFile, readManifest, mkdirp, runCheck } from './sync-check.mjs';
import { detectAccounts, publicAccount, accountsInUse } from './lib/accounts/detect.mjs';
import { computeDiff, publicDiff, countElements, manifestIsFor, primaryFromManifest } from './lib/accounts/diff.mjs';
import { buildPlan, PlanError, OPTIONS } from './lib/accounts/plan.mjs';
import { applyPlan, undoRun } from './lib/accounts/apply.mjs';
import { installCheck, uninstallCheck, isCheckInstalled } from './lib/accounts/install.mjs';
import { parseLang, translator } from './lib/accounts/strings.mjs';

const USAGE = 'usage: accounts.mjs list [--lang pt|en] | diff --primary <id> [--lang pt|en] | plan --primary <id> [--lang pt|en] [--out <file>] [--resolve <account>:<element>=<option>]... | apply --plan <file> [--dry-run] --yes | undo --stamp <stamp> --yes | check [--repair] | install-check --yes | uninstall-check --yes';
const BOOLEAN = new Set(['yes', 'dry-run', 'repair', 'new-primary', 'symlinks']);

/** `--flag value`, `--flag=value`, bare booleans; `--resolve` may repeat. */
function parseCli(argv) {
  const out = { _: [], resolve: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = eq > -1 ? a.slice(2, eq) : a.slice(2);
    let value = eq > -1 ? a.slice(eq + 1) : undefined;
    if (value === undefined && !BOOLEAN.has(key) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) value = argv[++i];
    if (key === 'resolve') { if (value) out.resolve.push(value); } else out[key] = value === undefined ? true : value;
  }
  return out;
}

function pathArg(p) {
  let s = String(p);
  if (IS_WIN) {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(s); // Git Bash form
    if (m) s = `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`;
  }
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(homeDir(), s.slice(1));
  return path.resolve(s);
}

const ids = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);

function print(obj, { raw = false } = {}) {
  const text = JSON.stringify(obj, null, 2);
  process.stdout.write((raw ? text : scrub(text)) + '\n');
}

class UsageError extends Error {}

/** The run language for what the board shows: `--lang pt|en`, English when absent. */
function langOf(args) {
  const lang = parseLang(args.lang === true ? '' : args.lang);
  if (!lang) throw new UsageError('--lang must be pt or en');
  return lang;
}

/** The account named by --primary, or the one the manifest was written for. */
function primaryOf(args, accounts, manifest) {
  if (typeof args.primary !== 'string') {
    const known = primaryFromManifest(manifest, accounts);
    if (known) return known;
    throw new UsageError('--primary <accountId> is required (see `accounts.mjs list`)');
  }
  const primary = accounts.find((a) => a.id === args.primary);
  if (!primary) throw new UsageError(`unknown account: ${args.primary} (see \`accounts.mjs list\`)`);
  return primary;
}

function parseResolutions(list) {
  const out = {};
  for (const r of list) {
    const eq = r.lastIndexOf('=');
    const colon = r.indexOf(':');
    if (eq === -1 || colon === -1 || colon > eq) throw new UsageError(`--resolve expects <account>:<element>=<option>, got "${r}"`);
    const option = r.slice(eq + 1);
    if (!OPTIONS.includes(option)) throw new UsageError(`--resolve: "${option}" is not one of ${OPTIONS.join(', ')}`);
    out[r.slice(0, eq)] = option;
  }
  return out;
}

function main(argv) {
  const args = parseCli(argv);
  const cmd = args._[0];
  const home = homeDir();

  if (cmd === 'list') {
    const lang = langOf(args);
    const accounts = detectAccounts();
    // `elements`: how many harness elements the config dir holds; `empty` lets a caller leave an
    // account with none out of a review by default.
    const entries = accounts.map((a) => { const n = countElements(a, home); return { ...publicAccount(a, lang), elements: n, empty: n === 0 }; });
    print({ accounts: entries, inUse: accountsInUse(accounts) }, { raw: true });
    return 0;
  }

  if (cmd === 'diff') {
    const lang = langOf(args);
    const accounts = detectAccounts();
    const manifest = readManifest(manifestFile(home));
    const primary = primaryOf(args, accounts, manifest);
    const out = publicDiff(computeDiff({ accounts, primaryId: primary.id, manifest, lang }));
    out.syncInstalled = isCheckInstalled(primary, home);
    print(out);
    return 0;
  }

  if (cmd === 'plan') {
    const lang = langOf(args);
    const accounts = detectAccounts();
    const manifest = readManifest(manifestFile(home));
    const primary = primaryOf(args, accounts, manifest);
    const usable = manifestIsFor(manifest, primary) ? manifest : null;
    let built;
    try {
      built = buildPlan({ accounts, primaryId: primary.id, manifest: usable, resolutions: parseResolutions(args.resolve), only: ids(args.only), skip: ids(args.skip) || [], symlinks: args.symlinks === true, lang });
    } catch (err) {
      if (err instanceof PlanError) throw new UsageError(err.message);
      throw err;
    }
    const { plan, steps } = built;
    if (manifest && !usable) plan.warnings.unshift(translator(lang)('warning.otherPrimary', { id: manifest.primary }));
    const extra = {};
    if (typeof args.drafts === 'string') {
      const dir = pathArg(args.drafts);
      extra.drafts = [];
      for (const s of steps) {
        if (s.kind !== 'instructions' || typeof s.e.text !== 'string') continue;
        const f = path.join(dir, s.account, s.name);
        mkdirp(path.dirname(f));
        fs.writeFileSync(f, s.e.text);
        extra.drafts.push(displayPath(f, home));
      }
    }
    if (typeof args.out === 'string') {
      const f = pathArg(args.out);
      mkdirp(path.dirname(f));
      fs.writeFileSync(f, scrub(JSON.stringify(plan, null, 2)) + '\n');
      extra.out = displayPath(f, home);
    }
    print({ ...plan, ...extra });
    return 0;
  }

  if (cmd === 'apply') {
    if (typeof args.plan !== 'string') throw new UsageError('--plan <plan.json> is required');
    const r = applyPlan({ planFile: pathArg(args.plan), yes: args.yes === true, dryRun: args['dry-run'] === true, newPrimary: args['new-primary'] === true });
    if (r.out.error) warn(scrub(r.out.error));
    print(r.out);
    return r.code;
  }

  if (cmd === 'undo') {
    const r = undoRun({ stamp: typeof args.stamp === 'string' ? args.stamp : null, yes: args.yes === true, dryRun: args['dry-run'] === true });
    if (r.out.error) warn(scrub(r.out.error));
    print(r.out);
    return r.code;
  }

  if (cmd === 'check') {
    print(runCheck({ repair: args.repair === true }));
    return 0;
  }

  if (cmd === 'install-check' || cmd === 'uninstall-check') {
    const fn = cmd === 'install-check' ? installCheck : uninstallCheck;
    const r = fn({ primaryId: typeof args.primary === 'string' ? args.primary : null, yes: args.yes === true });
    if (r.out.error) warn(scrub(r.out.error));
    print(r.out);
    return r.code;
  }

  throw new UsageError(cmd ? `unknown command: ${cmd}` : 'a command is required');
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      warn(scrub(err.message));
      warn(USAGE);
      process.exitCode = 2;
    } else {
      warn(scrub(String(err && err.message ? err.message : err)));
      process.exitCode = 1;
    }
  }
}
