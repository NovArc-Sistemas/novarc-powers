// Command-line entry: argument parsing, command dispatch and output.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pc from 'picocolors';
import { TOOL_IDS, detectTools } from './adapters/index.js';
import {
  UPDATE_MODES,
  applyPlan,
  currentBlockHash,
  desiredEntries,
  expandScopes,
  modifiedFiles,
  placement,
  planScope,
  planToJson,
  scopeRoot,
} from './engine.js';
import { listFiles, removePath, writeInside } from './fsutil.js';
import { detectLang, makeT } from './i18n.js';
import { readManifest } from './manifest.js';
import { cacheDirFor, homeDir, packageVersion, stateDir } from './paths.js';
import { CliError, PROFILES, assertSkillName, getSkill, loadSkills, skillSummary } from './skills.js';

const OPTIONS = {
  yes: { type: 'boolean', short: 'y' },
  scope: { type: 'string' },
  skills: { type: 'string' },
  tools: { type: 'string' },
  profile: { type: 'string' },
  updates: { type: 'string' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  cwd: { type: 'string' },
  force: { type: 'boolean' },
  purge: { type: 'boolean' },
  check: { type: 'boolean' },
  lang: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const COMMANDS = ['install', 'add', 'remove', 'list', 'status', 'update', 'fetch'];

/** Output channel. In --json and fetch modes stdout carries data only; text goes to stderr. */
export function makeOut({ json, quietStdout }) {
  const textStream = json || quietStdout ? process.stderr : process.stdout;
  return {
    json,
    text: (s = '') => textStream.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
    data: (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n'),
  };
}

function isInteractive() {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

function splitList(v) {
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function checkChoice(t, flag, value, allowed) {
  if (!allowed.includes(value)) {
    throw new CliError('INVALID_OPTION', t('invalidOption', { flag, value, allowed: allowed.join(', ') }));
  }
  return value;
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  const preLang = (() => {
    const i = argv.indexOf('--lang');
    if (i !== -1) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith('--lang='));
    return eq ? eq.slice(7) : undefined;
  })();
  const t = makeT(detectLang(preLang));
  const wantsJson = argv.includes('--json');
  const isFetch = argv[0] === 'fetch';
  const out = makeOut({ json: wantsJson, quietStdout: isFetch });
  try {
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (err) {
      throw new CliError('INVALID_ARGS', err.message);
    }
    const { values: o, positionals } = parsed;
    if (o.version) {
      process.stdout.write(packageVersion() + '\n');
      return 0;
    }
    if (o.help) {
      process.stdout.write(t('help') + '\n');
      return 0;
    }
    const [cmdRaw, ...rest] = positionals;
    const cmd = cmdRaw || 'install';
    if (!COMMANDS.includes(cmd)) throw new CliError('UNKNOWN_COMMAND', t('unknownCommand', { cmd }));
    const lang = detectLang(o.lang);
    const ctx = {
      home: homeDir(),
      cwd: path.resolve(o.cwd || process.cwd()),
      version: packageVersion(),
      catalog: loadSkills(),
      force: Boolean(o.force),
      dryRun: Boolean(o['dry-run']),
      lang,
      t,
    };
    if (o.cwd && !fs.existsSync(ctx.cwd)) throw new CliError('CWD_NOT_FOUND', `--cwd does not exist: ${ctx.cwd}`);
    if (o.scope) checkChoice(t, '--scope', o.scope, ['user', 'project', 'both']);
    if (o.profile) checkChoice(t, '--profile', o.profile, PROFILES);
    if (o.updates) checkChoice(t, '--updates', o.updates, UPDATE_MODES);
    if (o.tools) for (const tool of splitList(o.tools)) checkChoice(t, '--tools', tool, TOOL_IDS);
    switch (cmd) {
      case 'install':
        return await cmdInstall(ctx, o, rest, out, { interactiveAllowed: true });
      case 'add':
        return await cmdInstall(ctx, o, rest, out, { interactiveAllowed: false, positional: true });
      case 'remove':
        return await cmdRemove(ctx, o, rest, out);
      case 'list':
        return cmdList(ctx, o, out);
      case 'status':
        return cmdStatus(ctx, o, out);
      case 'update':
        return await cmdUpdate(ctx, o, out);
      case 'fetch':
        return cmdFetch(ctx, rest, out);
      default:
        return 1;
    }
  } catch (err) {
    const code = err instanceof CliError ? err.code : 'INTERNAL';
    const message = err instanceof CliError ? err.message : err.stack || String(err);
    if (wantsJson) out.data({ ok: false, code, message });
    else process.stderr.write(pc.red('error') + ' ' + message + '\n');
    return err.exitCode || 1;
  }
}

/** Build per-scope plans for installing `skillNames`. */
export function planInstall(ctx, { scopes, skillNames, tools, profile, updates }) {
  const desiredByScope = { user: [], project: [] };
  for (const name of skillNames) {
    const skill = getSkill(ctx.catalog, name);
    const p = placement(skill, scopes, profile);
    desiredByScope[p.scope].push(...desiredEntries(ctx, skill, p.scope, p.profile, tools));
  }
  return scopes.map((scope) =>
    planScope(ctx, scope, {
      desired: desiredByScope[scope],
      touched: skillNames,
      updates,
      tools,
    }),
  );
}

async function cmdInstall(ctx, o, rest, out, { interactiveAllowed, positional }) {
  const { t } = ctx;
  let skillNames = positional ? rest : [];
  if (o.skills) skillNames = [...skillNames, ...splitList(o.skills)];
  skillNames = [...new Set(skillNames)];
  for (const n of skillNames) assertSkillName(n);
  if (positional && !skillNames.length) throw new CliError('MISSING_SKILL', t('needSkillArg'));

  const detected = detectTools(ctx.home);
  let tools = o.tools ? splitList(o.tools) : null;
  let scope = o.scope || null;
  const interactive = isInteractive() && !o.json;

  const missing = [];
  if (!scope) missing.push('--scope');
  if (!skillNames.length) missing.push('--skills');
  if (!tools && !detected.length) missing.push('--tools');

  if (missing.length && interactive && interactiveAllowed) {
    const { runInteractive } = await import('./ui.js');
    return runInteractive(ctx, o, { skillNames, tools, scope, detected }, out);
  }
  if (missing.length && interactive) {
    // `add` in a terminal: ask only for what is missing.
    const { askMissing } = await import('./ui.js');
    const answers = await askMissing(ctx, { scope, tools, detected });
    if (!answers) return 1;
    scope = answers.scope;
    tools = answers.tools;
  } else if (missing.length) {
    throw new CliError('MISSING_CHOICES', t('missingChoices', { flags: missing.join(', ') }));
  }
  tools = tools || detected;
  const plans = planInstall(ctx, {
    scopes: expandScopes(scope),
    skillNames,
    tools,
    profile: o.profile,
    updates: o.updates,
  });
  return finish(ctx, o, out, 'install', plans);
}

/** Show the plan, confirm and apply. Shared by install, add, remove and update. */
export async function finish(ctx, o, out, command, plans, { confirmed = false } = {}) {
  const { t } = ctx;
  const hasChanges = plans.some((p) => p.actions.length);
  if (o.json && (ctx.dryRun || !hasChanges)) {
    out.data({ ok: true, command, dryRun: ctx.dryRun, applied: false, version: ctx.version, plan: planToJson(plans) });
    return 0;
  }
  if (!o.json) printPlan(ctx, plans, out);
  if (!hasChanges) {
    if (!o.json) out.text(pc.green(t('nothingToDo')));
    return 0;
  }
  if (ctx.dryRun) {
    out.text(pc.dim(t('dryRunDone')));
    return 0;
  }
  if (!o.yes && !confirmed) {
    if (!isInteractive() || o.json) throw new CliError('NEEDS_CONFIRMATION', t('needYes'));
    const { confirmApply } = await import('./ui.js');
    if (!(await confirmApply(ctx))) {
      out.text(t('cancelled'));
      return 1;
    }
  }
  const { backups } = applyPlan(ctx, plans);
  if (o.json) {
    out.data({ ok: true, command, dryRun: false, applied: true, version: ctx.version, plan: planToJson(plans), backups });
  } else {
    if (backups.length) out.text(pc.dim(t('backupsMade', { dir: path.dirname(backups[0]) })));
    out.text(pc.green(t('done')));
  }
  return 0;
}

const OP_COLOR = { create: pc.green, update: pc.yellow, remove: pc.red, delete: pc.red, purge: pc.red };

/** Human-readable plan: every file created or changed, then conflicts and warnings. */
export function printPlan(ctx, plans, out) {
  const { t } = ctx;
  const lines = [];
  for (const p of plans) {
    for (const a of p.actions) {
      if (a.kind === 'manifest') continue;
      const opKey = a.kind === 'delete' ? 'delete' : a.kind === 'purge' ? 'purge' : a.op;
      const label = t(`op_${opKey}`);
      const color = OP_COLOR[opKey] || pc.cyan;
      const what = a.skill ? pc.bold(a.skill) + ' ' : a.skills?.length ? pc.bold(a.skills.join(', ')) + ' ' : '';
      lines.push(`  ${color(label.padEnd(10))} ${what}${pc.dim(a.target)}`);
    }
  }
  if (lines.length) {
    out.text('');
    out.text(pc.bold(t('summaryTitle')));
    for (const l of lines) out.text(l);
  }
  const conflicts = plans.flatMap((p) => p.conflicts);
  if (conflicts.length) {
    out.text('');
    out.text(pc.yellow(pc.bold(t('conflictsTitle'))));
    for (const c of conflicts) {
      out.text(`  ${pc.bold(c.skill)} ${pc.dim(c.target)}`);
      for (const f of c.files) out.text(`    ${pc.yellow(f.reason)} ${f.file}`);
    }
  }
  const warnings = plans.flatMap((p) => p.warnings);
  if (warnings.length) {
    out.text('');
    out.text(pc.yellow(t('warningsTitle')));
    for (const w of warnings) out.text(`  ${w.code} ${w.file || ''}${w.skill ? ` (${w.skill})` : ''}`);
  }
  out.text('');
}

function scopesWithManifest(ctx) {
  return ['user', 'project'].filter((s) => readManifest(scopeRoot(ctx, s)));
}

async function cmdRemove(ctx, o, rest, out) {
  const { t } = ctx;
  let names = [...rest];
  if (o.skills) names.push(...splitList(o.skills));
  names = [...new Set(names)];
  if (!names.length) throw new CliError('MISSING_SKILL', t('needSkillArg'));
  for (const n of names) assertSkillName(n);
  const scopes = o.scope ? expandScopes(o.scope) : ['user', 'project'];
  const plans = [];
  const warnings = [];
  for (const scope of scopes) {
    const m = readManifest(scopeRoot(ctx, scope));
    const installed = new Set((m?.entries || []).map((e) => e.skill));
    const purge = o.purge ? names : [];
    if (!m && !purge.some((n) => fs.existsSync(path.join(stateDir(scopeRoot(ctx, scope)), n)))) continue;
    plans.push(planScope(ctx, scope, { desired: [], touched: names, updates: o.updates, purge }));
    for (const n of names) if (!installed.has(n)) warnings.push(n);
  }
  for (const n of names) {
    if (warnings.filter((w) => w === n).length === plans.length) {
      out.err(pc.yellow(t('notInstalled', { skill: n })));
    }
  }
  return finish(ctx, o, out, 'remove', plans);
}

async function cmdUpdate(ctx, o, out) {
  const { t } = ctx;
  const scopes = o.scope ? expandScopes(o.scope) : scopesWithManifest(ctx);
  const plans = [];
  const missingSkills = [];
  for (const scope of scopes) {
    const m = readManifest(scopeRoot(ctx, scope));
    if (!m) continue;
    const available = new Set(ctx.catalog.map((s) => s.name));
    const desired = [];
    const touched = new Set();
    for (const e of m.entries) {
      if (!available.has(e.skill)) {
        missingSkills.push(e.skill);
        continue;
      }
      touched.add(e.skill);
      desired.push({ skill: e.skill, profile: e.profile, tool: e.tool, tools: e.tools || [e.tool], target: e.target });
    }
    plans.push(planScope(ctx, scope, { desired, touched: [...touched], updates: o.updates }));
  }
  if (o.check) {
    const report = plans.map((p) => {
      const m = readManifest(p.root);
      return {
        scope: p.scope,
        root: p.root,
        outdated: (m?.entries || [])
          .filter((e) => {
            const s = ctx.catalog.find((k) => k.name === e.skill);
            return s && (s.version !== e.version || m.packageVersion !== ctx.version);
          })
          .map((e) => ({ skill: e.skill, target: e.target, from: e.version, to: ctx.catalog.find((k) => k.name === e.skill).version })),
        changes: p.actions.filter((a) => a.kind !== 'manifest').length,
        conflicts: p.conflicts,
      };
    });
    if (o.json) out.data({ ok: true, command: 'update', check: true, version: ctx.version, scopes: report, missingSkills });
    else {
      out.text(pc.bold(t('updateCheckTitle')));
      printPlan(ctx, plans, out);
      const any = report.some((r) => r.outdated.length || r.changes);
      if (!any) out.text(pc.green(t('updateNone', { version: ctx.version })));
      for (const r of report) for (const u of r.outdated) out.text('  ' + t('updateAvailable', { skill: u.skill, from: u.from, to: u.to }));
    }
    return 0;
  }
  return finish(ctx, o, out, 'update', plans);
}

function cmdList(ctx, o, out) {
  const { t } = ctx;
  const installed = new Map();
  for (const scope of ['user', 'project']) {
    const m = readManifest(scopeRoot(ctx, scope));
    for (const e of m?.entries || []) {
      const k = installed.get(e.skill) || [];
      k.push({ scope, profile: e.profile, target: e.target });
      installed.set(e.skill, k);
    }
  }
  const rows = ctx.catalog.map((s) => ({
    name: s.name,
    version: s.version,
    summary: skillSummary(s, ctx.lang),
    recommended: s.profile.recommended,
    supported: s.profile.supported,
    environments: s.environments || [],
    installed: installed.get(s.name) || [],
  }));
  if (o.json) {
    out.data({ ok: true, command: 'list', version: ctx.version, skills: rows });
    return 0;
  }
  out.text(pc.bold(t('listTitle')));
  for (const r of rows) {
    const mark = r.installed.length ? pc.green(' ● ' + t('listInstalled')) : '';
    out.text(`  ${pc.bold(r.name)} ${pc.dim(r.version)} ${pc.cyan(`[${t('listRecommended')}: ${r.recommended}]`)}${mark}`);
    out.text(`    ${r.summary}`);
  }
  return 0;
}

function cmdStatus(ctx, o, out) {
  const { t } = ctx;
  const scopes = [];
  for (const scope of ['user', 'project']) {
    const root = scopeRoot(ctx, scope);
    const m = readManifest(root);
    if (!m) continue;
    scopes.push({
      scope,
      root,
      packageVersion: m.packageVersion,
      updates: m.updates,
      entries: m.entries.map((e) => {
        let handEdited;
        if (e.profile === 'on-demand') {
          const h = currentBlockHash(e.target);
          handEdited = h === e.blockHash ? [] : [{ file: path.basename(e.target), reason: h == null ? 'missing' : 'modified' }];
        } else handEdited = modifiedFiles(e);
        return { skill: e.skill, version: e.version, profile: e.profile, tools: e.tools || [e.tool], target: e.target, handEdited };
      }),
    });
  }
  if (o.json) {
    out.data({ ok: true, command: 'status', version: ctx.version, scopes });
    return 0;
  }
  if (!scopes.length) {
    out.text(t('statusNone'));
    return 0;
  }
  out.text(pc.bold(t('statusTitle')));
  for (const s of scopes) {
    out.text('');
    out.text(pc.cyan(t('statusScope', { scope: s.scope, root: s.root })) + pc.dim(`  v${s.packageVersion}  ${t('statusUpdates', { mode: s.updates })}`));
    for (const e of s.entries) {
      out.text(`  ${pc.bold(e.skill)} ${pc.dim(e.version)} ${e.profile} ${pc.dim('(' + e.tools.join(', ') + ')')}`);
      out.text(`    ${pc.dim(e.target)}`);
      for (const h of e.handEdited) out.text(`    ${pc.yellow(t('statusHandEdited'))}: ${h.file} (${h.reason})`);
    }
  }
  return 0;
}

/** Copy the skill from the running package into the cache and print its SKILL.md path only. */
function cmdFetch(ctx, rest, out) {
  const name = rest[0];
  if (!name) throw new CliError('MISSING_SKILL', ctx.t('needSkillArg'));
  const skill = getSkill(ctx.catalog, name);
  const dest = cacheDirFor(skill.name, ctx.version);
  removePath(dest);
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of listFiles(skill.dir).files) {
    writeInside(dest, rel, fs.readFileSync(path.join(skill.dir, ...rel.split('/'))));
  }
  const skillMd = path.join(dest, 'SKILL.md');
  if (!fs.existsSync(skillMd)) throw new CliError('FETCH_FAILED', ctx.t('fetchFailed', { skill: name, error: 'SKILL.md missing' }));
  process.stdout.write(skillMd + '\n');
  return 0;
}
