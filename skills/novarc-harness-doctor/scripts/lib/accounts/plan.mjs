// Turns the account comparison into an ordered plan. Writes nothing.
//
// Same provider  -> `link` each element to the primary.
// Other provider -> `generate` the instruction file and the MCP definitions, `link` each skill.
// Whatever differs from the primary, or exists only in the other account, is a CONFLICT: it is
// never overwritten silently. Its default is to keep it as an account exception.
//
// Actions, states and options are machine values. The sentences beside them (`why`, `replaces`,
// conflict `note`, `notes`, `warnings`) come from strings.mjs in the run language, and take no
// part in the fingerprint: a plan reads the same to `apply` in every language.
import path from 'node:path';
import { homeDir, displayPath, syncDir, sha256, canon, TOOL } from '../../sync-check.mjs';
import { PROVIDERS, accountLabel } from './detect.mjs';
import { computeDiff, elementSignature } from './diff.mjs';
import { translator } from './strings.mjs';

export const PLAN_VERSION = 1;
export const OPTIONS = ['adopt-into-primary', 'keep-as-exception', 'replace-with-primary'];
export const DEFAULT_OPTION = 'keep-as-exception';

export class PlanError extends Error {}

/** Which options make sense for a conflict, and why the others are not offered. */
function optionsFor(e, t) {
  if (e.type === 'mcp') {
    if (e.state === 'not-portable') return { options: [DEFAULT_OPTION] };
    if (e.state === 'divergent' && !e.fixed) return { options: [DEFAULT_OPTION, 'replace-with-primary'], why: t('conflict.serverAdopt') };
    return { options: [DEFAULT_OPTION], why: t(e.fixed ? 'conflict.serverFixed' : 'conflict.serverOnlyHere') };
  }
  if (e.type === 'instruction') {
    if (e.state === 'divergent') return { options: [DEFAULT_OPTION, 'replace-with-primary'], why: t('conflict.instructionNoAdopt') };
    return { options: [DEFAULT_OPTION] };
  }
  return { options: [...OPTIONS] };
}

/**
 * Build the plan.
 *   resolutions  { '<account>:<element>': option } chosen explicitly (--resolve or the plan file)
 *   only, skip   account ids to restrict the plan to, or to leave out
 *   symlinks     also replace existing hardlinks with symbolic links
 *   lang         language of the sentences in the plan ('en' or 'pt')
 * Returns { plan, steps, info }: `plan` is the printable document (display paths only), `steps`
 * is what `apply` executes (absolute paths, never printed), `info` the per-account sync settings
 * that go into the manifest.
 */
export function buildPlan({ accounts, primaryId, manifest = null, resolutions = {}, only = null, skip = [], symlinks = false, lenient = false, lang = 'en', home = homeDir() }) {
  // `lenient` (used by apply on a plan file): a choice that no longer applies is ignored instead
  // of being an error; the fingerprint then tells whether the plan is stale.
  const outdated = (message) => { if (!lenient) throw new PlanError(message); };
  const primary = accounts.find((a) => a.id === primaryId);
  if (!primary) throw new PlanError(`unknown account: ${primaryId}`);
  for (const id of [...(only || []), ...skip]) if (!accounts.some((a) => a.id === id)) throw new PlanError(`unknown account: ${id}`);
  const selected = new Set(accounts.filter((a) => a.id !== primary.id && (!only || only.includes(a.id)) && !skip.includes(a.id)).map((a) => a.id));
  const t = translator(lang);
  const diff = computeDiff({ accounts, primaryId, manifest, selected, lang: t.lang, home });
  const show = (p) => displayPath(p, home);
  const backupRoot = `${show(path.join(syncDir(home), 'backups'))}/<stamp>`;

  const actions = [];
  const conflicts = [];
  const steps = [];
  const notPortable = [];
  const exceptions = {};
  const info = new Map();
  const print = [];
  const signatures = {};
  const changes = [];
  const used = new Set();
  const act = (account, element, action, rest) => actions.push({ n: actions.length + 1, account, element, action, ...rest });

  for (const a of diff.accounts) {
    if (!a.selected) continue;
    const id = a.account.id;
    const same = a.account.provider === primary.provider;
    const spec = PROVIDERS[primary.provider];
    const backupOf = (name) => `${backupRoot}/${id}/${name.replace(/\/$/, '')}`;
    const keep = (name) => { (exceptions[id] ||= []).push(name); steps.push({ kind: 'except', account: id, name }); };
    const mcpItems = [];
    let instructionFollows = false;

    for (const e of a.elements) {
      const key = `${id}:${e.name}`;
      let res = resolutions[key];
      if (res !== undefined) used.add(key);
      if (e.type === 'info') { notPortable.push({ account: id, element: e.name, note: e.note }); continue; }
      if (e.forget) { mcpItems.push({ name: e.server, op: 'forget' }); continue; }
      // The fingerprint holds every element's state. The content of whatever a choice could
      // change is signed separately, so `apply` compares it only for what it will really change
      // (a folder kept as an exception may move on without making the plan stale).
      print.push([id, e.name, e.state, e.stale ? 1 : 0]);
      const settled = e.state === 'linked' || (e.state === 'generated' && !e.stale) || e.state === 'not-portable';
      if (!settled) signatures[key] = sha256(elementSignature(e)).slice(0, 16);
      const changing = () => changes.push(key);
      const from = e.P ? show(e.P) : undefined;
      const to = e.S ? show(e.S) : undefined;
      const isInstructionOfPrimary = same && e.name === spec.instruction;

      // In step already.
      if (e.state === 'linked' || (e.state === 'generated' && !e.stale)) {
        if (res !== undefined) outdated(`${key} already follows the primary; there is nothing to resolve`);
        if (symlinks && e.state === 'linked' && e.linkKind === 'hardlink') {
          // Asked for: turn a hardlink into a symbolic link, which survives an atomic save.
          signatures[key] = sha256(elementSignature(e)).slice(0, 16);
          changing();
          act(id, e.name, 'backup', { from: to, to: backupOf(e.name), why: t('plan.hardlinkBackup') });
          steps.push({ kind: 'link', account: id, name: e.name, e });
          act(id, e.name, 'link', { from, to, replaces: t('plan.hardlinkReplaces'), why: t('plan.hardlinkWhy') });
          if (isInstructionOfPrimary) instructionFollows = true;
          continue;
        }
        const recorded = a.tracked && a.tracked.elements.some((x) => x.name === e.name);
        if (e.type === 'mcp') mcpItems.push({ name: e.server, op: 'keep', e });
        else if (e.type === 'instruction') steps.push({ kind: 'instructions', account: id, name: e.name, e, pre: 'same' });
        else if (e.state === 'linked') steps.push({ kind: 'record', account: id, name: e.name, e });
        act(id, e.name, 'skip', { to, why: t(e.state !== 'linked' ? 'plan.upToDate' : recorded ? 'plan.alreadyLinked' : 'plan.alreadyLinkedRecorded') });
        if (isInstructionOfPrimary) instructionFollows = true;
        continue;
      }

      // Managed and out of date: regenerate, nothing to decide.
      if (e.state === 'generated' && e.stale) {
        if (res !== undefined) outdated(`${key} is regenerated from the primary; there is nothing to resolve`);
        changing();
        if (e.type === 'mcp') {
          mcpItems.push({ name: e.server, op: e.gone ? 'remove' : 'write', e });
          act(id, e.name, 'generate', { from, to, replaces: t('plan.staleServerReplaces'), why: t(e.gone ? 'plan.serverGone' : 'plan.primaryChanged') });
        } else if (e.type === 'instruction') {
          steps.push({ kind: 'instructions', account: id, name: e.name, e, pre: 'stale' });
          act(id, e.name, 'generate', { from, to, replaces: t('plan.staleFileReplaces'), why: t('plan.primaryChanged') });
        } else {
          // A managed copy that fell behind: link it now if that has become possible, else copy again.
          act(id, e.name, 'backup', { from: to, to: backupOf(e.name), why: t('plan.staleCopyBackup') });
          steps.push({ kind: 'link', account: id, name: e.name, e });
          act(id, e.name, 'link', { from, to, replaces: t('plan.staleCopyReplaces'), why: t('plan.primaryChanged') });
          if (isInstructionOfPrimary) instructionFollows = true;
        }
        continue;
      }

      // Cannot be replicated at all: a conflict the user resolves in the primary.
      if (e.state === 'not-portable') {
        conflicts.push({ account: id, element: e.name, state: e.state, options: [DEFAULT_OPTION], default: DEFAULT_OPTION, choice: DEFAULT_OPTION, decidedBy: 'default', note: e.note });
        act(id, e.name, 'skip', { why: t('plan.notReplicated', { note: e.note }) });
        continue;
      }

      const conflict = e.state === 'divergent' || e.state === 'account-only';
      if (!conflict) {
        // missing or copied: follows the primary unless the user keeps it apart.
        if (res !== undefined && res !== DEFAULT_OPTION && res !== 'replace-with-primary') { outdated(`${key}: "${res}" does not apply to an element that is ${e.state}`); res = undefined; }
        if (res === DEFAULT_OPTION || (e.exception && res === undefined)) {
          keep(e.name);
          act(id, e.name, 'skip', { to, why: t(res === DEFAULT_OPTION ? 'plan.keptChoice' : 'plan.keptEarlier') });
          continue;
        }
        if (e.primaryImport && !instructionFollows && res === undefined) {
          act(id, e.name, 'skip', { to, why: t('plan.importSkipped', { file: spec.instruction }) });
          continue;
        }
        changing();
        if (e.type === 'mcp') {
          if (e.state === 'copied' && !e.exact) { changes.pop(); act(id, e.name, 'skip', { to, why: e.note }); continue; }
          mcpItems.push({ name: e.server, op: e.state === 'copied' ? 'adopt' : 'write', e });
          if (e.state === 'copied') act(id, e.name, 'generate', { from, to, replaces: t('plan.serverAdoptReplaces'), why: t('plan.serverAdoptWhy') });
          else act(id, e.name, 'generate', { from, to, replaces: t('plan.nothing'), why: t('plan.serverWriteWhy') });
        } else if (e.type === 'instruction') {
          steps.push({ kind: 'instructions', account: id, name: e.name, e, pre: 'missing' });
          act(id, e.name, 'generate', { from, to, replaces: t('plan.nothing'), why: t('plan.instructionWhy') });
        } else {
          if (e.state === 'copied') act(id, e.name, 'backup', { from: to, to: backupOf(e.name), why: t('plan.copyBackup') });
          steps.push({ kind: 'link', account: id, name: e.name, e });
          act(id, e.name, 'link', { from, to, replaces: t(e.state === 'copied' ? 'plan.copyReplaces' : e.broken ? 'plan.brokenReplaces' : 'plan.nothing'), why: t(same ? 'plan.linkWhy' : 'plan.skillWhy') });
          if (isInstructionOfPrimary) instructionFollows = true;
        }
        continue;
      }

      // A conflict: never decided for the user.
      const { options, why } = optionsFor(e, t);
      let choice = DEFAULT_OPTION;
      let decidedBy = 'default';
      if (res !== undefined && !options.includes(res)) { outdated(`${key}: "${res}" is not one of ${options.join(', ')}`); res = undefined; }
      if (res !== undefined) {
        choice = res;
        decidedBy = 'user';
      } else if (e.exception) decidedBy = 'previous';
      const c = { account: id, element: e.name, state: e.state, options, default: DEFAULT_OPTION, choice, decidedBy };
      if (e.note || why) c.note = [e.note, why].filter(Boolean).join('. ');
      if (from && e.state === 'divergent') c.primaryPath = from;
      if (to) c.accountPath = to;
      conflicts.push(c);
      if (choice !== DEFAULT_OPTION) changing();

      if (choice === DEFAULT_OPTION) {
        keep(e.name);
        act(id, e.name, 'skip', { to, why: t(e.state === 'divergent' ? 'plan.keptDivergent' : 'plan.keptOnly') });
      } else if (choice === 'replace-with-primary') {
        if (e.type === 'mcp') {
          mcpItems.push({ name: e.server, op: 'replace', e });
          act(id, e.name, 'generate', { from, to, replaces: t('plan.serverReplaceReplaces'), why: t('plan.serverReplaceWhy') });
        } else if (e.type === 'instruction') {
          act(id, e.name, 'backup', { from: to, to: backupOf(e.name), why: t('plan.ownFileBackup') });
          steps.push({ kind: 'instructions', account: id, name: e.name, e, pre: 'divergent' });
          act(id, e.name, 'generate', { from, to, replaces: t('plan.ownFileReplaces'), why: t('plan.instructionReplaceWhy') });
        } else if (e.state === 'account-only') {
          steps.push({ kind: 'drop', account: id, name: e.name, e });
          act(id, e.name, 'backup', { from: to, to: backupOf(e.name), why: t('plan.dropBackup') });
        } else {
          act(id, e.name, 'backup', { from: to, to: backupOf(e.name), why: t('plan.ownVersionBackup') });
          steps.push({ kind: 'link', account: id, name: e.name, e });
          act(id, e.name, 'link', { from, to, replaces: t('plan.ownVersionReplaces'), why: t('plan.becomesLink') });
          if (isInstructionOfPrimary) instructionFollows = true;
        }
      } else {
        // adopt-into-primary: the account's version becomes the primary's, then it is linked.
        if (e.state === 'divergent' && !e.dir) act(primary.id, e.name, 'backup', { from, to: `${backupRoot}/${primary.id}/${e.name}`, why: t('plan.primaryBackup') });
        act(id, e.name, 'copy', { from: to, to: from, replaces: t(e.state === 'account-only' ? 'plan.nothing' : e.dir ? 'plan.adoptFolderReplaces' : 'plan.adoptFileReplaces'), why: t('plan.adoptWhy') });
        act(id, e.name, 'backup', { from: to, to: backupOf(e.name), why: t('plan.originalBackup') });
        steps.push({ kind: 'adopt', account: id, name: e.name, e });
        act(id, e.name, 'link', { from, to, replaces: t('plan.adoptLinkReplaces'), why: t('plan.becomesLink') });
        if (isInstructionOfPrimary) instructionFollows = true;
      }
    }

    if (a.mcp && mcpItems.length) steps.push({ kind: 'mcp', account: id, mcp: a.mcp, items: mcpItems });
    const settings = { account: a.account, mode: same ? 'linked' : 'replicated' };
    if (same && spec.importSyntax && spec.instruction && instructionFollows) settings.imports = { source: path.join(primary.pathAbs, spec.instruction), root: primary.pathAbs, coveredDirs: spec.dirs };
    if (!same && a.skillsDir && a.skillsSource) settings.skills = { source: a.skillsSource, target: a.skillsDir };
    if (a.mcp) settings.mcp = a.mcp;
    info.set(id, settings);
  }

  for (const key of Object.keys(resolutions)) if (!used.has(key)) outdated(`--resolve ${key}: no such element in the plan`);

  const count = (name) => actions.filter((x) => x.action === name).length;
  const involved = diff.accounts.filter((a) => a.selected);
  const plan = {
    version: PLAN_VERSION,
    tool: TOOL,
    lang: t.lang,
    generatedAt: new Date().toISOString(),
    primary: { id: primary.id, provider: primary.provider, label: accountLabel(primary, t.lang), path: primary.path },
    accounts: involved.map((a) => {
      const out = { id: a.account.id, provider: a.account.provider, label: accountLabel(a.account, t.lang), path: a.account.path, mode: a.account.provider === primary.provider ? 'linked' : 'replicated' };
      if (a.notes.length) out.notes = a.notes;
      return out;
    }),
    actions,
    conflicts,
    exceptions,
    notPortable,
    warnings: [...diff.warnings, ...(involved.length ? [t('warning.closeApps')] : [])],
    summary: { link: count('link'), generate: count('generate'), copy: count('copy'), backup: count('backup'), skip: count('skip'), conflicts: conflicts.length, notPortable: notPortable.length },
    backups: backupRoot,
    ...(symlinks ? { options: { symlinks: true } } : {}),
    fingerprint: sha256(canon({ primary: [primary.id, primary.path], accounts: involved.map((a) => [a.account.id, a.account.path, a.account.provider]), elements: print })),
    signatures,
  };
  return { plan, steps, info, primary, changes };
}

/**
 * What a plan file asks for, as resolutions for a fresh buildPlan. Refuses a destructive choice
 * that was not made explicitly: a conflict whose `choice` is not the default must carry
 * `"decidedBy": "user"`.
 */
export function resolutionsFromPlan(plan) {
  const out = {};
  const problems = [];
  const conflictKeys = new Set();
  for (const c of Array.isArray(plan.conflicts) ? plan.conflicts : []) {
    const key = `${c.account}:${c.element}`;
    conflictKeys.add(key);
    const choice = c.choice === undefined || c.choice === null ? c.default : c.choice;
    if (!OPTIONS.includes(choice)) { problems.push(`${key}: "${choice}" is not a known option`); continue; }
    if (choice !== DEFAULT_OPTION) {
      if (c.decidedBy !== 'user') { problems.push(`${key}: "${choice}" needs an explicit decision. Set "decidedBy": "user" on that conflict in the plan file, or plan again with --resolve ${key}=${choice}`); continue; }
      out[key] = choice;
    } else if (c.decidedBy === 'user') out[key] = choice;
  }
  const ex = plan.exceptions && typeof plan.exceptions === 'object' ? plan.exceptions : {};
  for (const [account, names] of Object.entries(ex)) {
    for (const name of Array.isArray(names) ? names : []) {
      const key = `${account}:${name}`;
      if (!conflictKeys.has(key) && out[key] === undefined) out[key] = DEFAULT_OPTION;
    }
  }
  return { resolutions: out, problems };
}
