// Interactive flow built on @clack/prompts. Only loaded when stdout is a TTY.
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { TOOL_IDS } from './adapters/index.js';
import { expandScopes, placement } from './engine.js';
import { skillSummary } from './skills.js';

function bail(ctx) {
  p.cancel(ctx.t('cancelled'));
  return null;
}

function toolLabel(id) {
  return { 'claude-code': 'Claude Code', codex: 'Codex', agents: 'AGENTS.md (generic)' }[id] || id;
}

async function askScope(ctx) {
  const { t } = ctx;
  const v = await p.select({
    message: t('scopePrompt'),
    initialValue: 'user',
    options: [
      { value: 'user', label: t('scopeUser'), hint: t('scopeUserHint') },
      { value: 'project', label: t('scopeProject'), hint: t('scopeProjectHint', { cwd: ctx.cwd }) },
      { value: 'both', label: t('scopeBoth'), hint: t('scopeBothHint') },
    ],
  });
  return p.isCancel(v) ? null : v;
}

async function askTools(ctx, detected) {
  const v = await p.multiselect({
    message: ctx.t('toolsPrompt'),
    required: true,
    initialValues: detected.length ? detected : ['claude-code'],
    options: TOOL_IDS.map((id) => ({ value: id, label: toolLabel(id), hint: detected.includes(id) ? '✓' : undefined })),
  });
  return p.isCancel(v) ? null : v;
}

/** Used by `add` in a terminal when scope or tools were not passed. */
export async function askMissing(ctx, { scope, tools, detected }) {
  let s = scope;
  let tl = tools;
  if (!s) s = await askScope(ctx);
  if (!s) return bail(ctx);
  if (!tl && !detected.length) tl = await askTools(ctx, detected);
  if (!tl && !detected.length) return bail(ctx);
  return { scope: s, tools: tl || detected };
}

export async function confirmApply(ctx) {
  const ok = await p.confirm({ message: ctx.t('confirm'), initialValue: true });
  return !p.isCancel(ok) && ok === true;
}

export async function runInteractive(ctx, o, pre, out) {
  const { t } = ctx;
  const { planInstall, finish } = await import('./cli.js');
  console.log('');
  p.intro(`${pc.bgCyan(pc.black(' novarc-powers '))} ${pc.dim('v' + ctx.version)}  ${pc.dim(t('tagline'))}`);

  const detected = pre.detected;
  p.note(
    detected.length ? detected.map((d) => `${pc.green('●')} ${toolLabel(d)}`).join('\n') : pc.yellow(t('noToolsDetected')),
    t('detectedTools'),
  );

  const scope = pre.scope || (await askScope(ctx));
  if (!scope) return bail(ctx) ?? 1;
  const scopes = expandScopes(scope);

  let tools = pre.tools;
  if (!tools) tools = await askTools(ctx, detected);
  if (!tools) return bail(ctx) ?? 1;

  let skillNames = pre.skillNames;
  if (!skillNames.length) {
    if (!ctx.catalog.length) {
      p.cancel(t('noSkills'));
      return 1;
    }
    const groups = {};
    const initial = [];
    const groupTitle = { 'on-demand': t('groupOnDemand'), user: t('groupUser'), project: t('groupProject') };
    for (const prof of ['on-demand', 'user', 'project']) {
      const list = ctx.catalog.filter((s) => s.profile.recommended === prof);
      if (!list.length) continue;
      groups[groupTitle[prof]] = list.map((s) => ({ value: s.name, label: s.name, hint: skillSummary(s, ctx.lang) }));
      for (const s of list) {
        try {
          placement(s, scopes, o.profile);
          initial.push(s.name);
        } catch {
          /* not installable with this scope: leave unchecked */
        }
      }
    }
    const picked = await p.groupMultiselect({
      message: t('skillsPrompt'),
      options: groups,
      initialValues: initial,
      required: true,
      selectableGroups: false,
      groupSpacing: 1,
    });
    if (p.isCancel(picked)) return bail(ctx) ?? 1;
    skillNames = picked;
  }

  let updates = o.updates;
  if (!updates) {
    updates = await p.select({
      message: t('updatesPrompt'),
      initialValue: 'notify',
      options: [
        { value: 'notify', label: t('updatesNotify'), hint: t('updatesNotifyHint') },
        { value: 'auto', label: t('updatesAuto'), hint: pc.yellow(t('updatesAutoHint')) },
        { value: 'off', label: t('updatesOff'), hint: t('updatesOffHint') },
      ],
    });
    if (p.isCancel(updates)) return bail(ctx) ?? 1;
  }

  const plans = planInstall(ctx, { scopes, skillNames, tools, profile: o.profile, updates });
  const code = await finish(ctx, o, out, 'install', plans);
  p.outro(pc.dim('github.com/NovArc-Sistemas/novarc-powers'));
  return code;
}