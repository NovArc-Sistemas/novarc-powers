// Turns what scan.mjs found into the element views and the layer list of the state schema.
// Pure: it reads nothing from disk. Runs after the file list has its ids.
// What it writes for a person to read (layer names and notes, hook notes) is worded through
// `ctx.t`, the translator of the language the snapshot was asked for (strings.mjs).
import { createHash } from 'node:crypto';
import { approxTokens } from '../common.mjs';
import { normalizeMcpName } from '../transcripts.mjs';
import { inline, maskLine, scrubHome } from './mask.mjs';
import { hookSource } from './hookcode.mjs';
import { translator } from './strings.mjs';

// Which agent hook events can stop their action, and through what. From the Claude Code hooks
// reference, sections "Exit code 2 behavior per event" and "Decision control"
// (https://code.claude.com/docs/en/hooks, read on 2026-11-23). Re-read it before changing a row.
//   exit:   the exit status that stops the action (2 on most events)
//   json:   the decision a hook prints on stdout that stops it
//   fields: the names of the fields that decision is written in
const EXIT_2 = /\bexit\s+2\b|exit\(2\)|exitCode\s*=\s*2\b/i;
const EXIT_NON_ZERO = /\bexit\s+[1-9]\d*\b|exit\([1-9]\d*\)|exitCode\s*=\s*[1-9]/i;
// `name: value` as JSON, jq, JavaScript or Python write it, quotes escaped or not.
const field = (name, values) => new RegExp(`${name}\\\\?["']?\\s*[:=]\\s*\\\\?["']?(?:${values})\\b`, 'i');
const either = (...res) => new RegExp(res.map((r) => r.source).join('|'), 'i');
const DECISION_BLOCK = field('decision', 'block');
const PERMISSION_DENY = field('permissionDecision', 'deny|ask');
const CONTINUE_FALSE = field('continue', 'false');
const TOP_LEVEL = { exit: EXIT_2, json: DECISION_BLOCK, fields: 'decision' };
const BLOCKING_EVENTS = {
  // deny or ask inside hookSpecificOutput; the deprecated top-level `decision: "block"` still maps
  // to deny. `continue: false` stops Claude afterwards but does not block the tool call.
  PreToolUse: { exit: EXIT_2, json: either(PERMISSION_DENY, DECISION_BLOCK), fields: 'permissionDecision|decision' },
  // Exit status 2 is not read as a decision here: the hook denies with decision.behavior "deny".
  PermissionRequest: { exit: null, json: field('behavior', 'deny'), fields: 'behavior' },
  // `continue: false` makes Claude stop processing, so the prompt goes nowhere.
  UserPromptSubmit: { exit: EXIT_2, json: either(DECISION_BLOCK, CONTINUE_FALSE), fields: 'decision|continue' },
  UserPromptExpansion: { exit: EXIT_2, json: either(DECISION_BLOCK, CONTINUE_FALSE), fields: 'decision|continue' },
  // Blocking these keeps Claude, the subagent or the teammate working. `continue: false` does the
  // opposite (the turn ends) or is ignored, so it is no sign of blocking.
  Stop: TOP_LEVEL, SubagentStop: TOP_LEVEL, TeammateIdle: TOP_LEVEL, TaskCreated: TOP_LEVEL, TaskCompleted: TOP_LEVEL,
  ConfigChange: TOP_LEVEL, PreCompact: TOP_LEVEL,
  PostToolBatch: { exit: EXIT_2, json: either(DECISION_BLOCK, CONTINUE_FALSE), fields: 'decision|continue' },
  PreModelSwitch: { exit: EXIT_2, json: either(PERMISSION_DENY, DECISION_BLOCK), fields: 'permissionDecision|decision' },
  Elicitation: { exit: EXIT_2, json: either(field('action', 'decline|cancel'), DECISION_BLOCK), fields: 'action|decision' },
  ElicitationResult: { exit: EXIT_2, json: either(field('action', 'decline|cancel'), DECISION_BLOCK), fields: 'action|decision' },
  // Any non-zero exit status makes the worktree operation fail; JSON is not a decision here.
  WorktreeCreate: { exit: EXIT_NON_ZERO, json: null, fields: null }, WorktreeRemove: { exit: EXIT_NON_ZERO, json: null, fields: null },
};
// How the evidence is read (lib/snapshot/hookcode.mjs splits the source): a decision is looked
// for in everything but the comments, because a hook prints it from a string; an exit status only
// in the code, because `echo "use exit 2 to block"` exits with nothing. The two patterns below
// are the cases where the code does block or might, but with a value the text does not show:
// an exit status that is not a number written there (`exit $rc`, `process.exit(code)`,
// `sys.exit(1 if bad else 0)`, `raise SystemExit(rc)`, `exec other-program`) ...
const COMPUTED_EXIT = /\bexit\s+(?:\$|["'`])|(?:\b|System)exit\s*\(\s*(?!\d+\s*\)|["'`)])|exitCode\s*=\s*(?!\d)[^\s;]|(?:^|[\s;&|])exec\s+(?![-<>\d])/im;
// ... and a decision field whose value is not a word written there (`permissionDecision: verdict`,
// `"decision": "$d"`, the shorthand `{ decision }`).
const computedField = (fields) => new RegExp(
  `(?<![A-Za-z0-9_])(?:${fields})\\\\?["']?\\s*[:=](?![=>])\\s*(?!\\\\?["'\`][A-Za-z_-]*\\\\?["'\`]|[{[]|(?:true|false|null)\\b|\\d)\\S|[{,]\\s*(?:${fields})\\s*[,}]`, 'i');
const COMPUTED_FIELD = {};
for (const r of Object.values(BLOCKING_EVENTS)) if (r.fields && !COMPUTED_FIELD[r.fields]) COMPUTED_FIELD[r.fields] = computedField(r.fields);
// Events the reference lists with "Can block? No": the action already happened or cannot be
// prevented. (A PostToolUse hook can still stop Claude with `continue: false`; the tool has run.)
// StatusLine is this script's own name for the statusLine command, which decides nothing.
const NEVER_BLOCK_EVENTS = new Set([
  'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'StopFailure', 'Notification', 'SubagentStart', 'SessionStart', 'Setup', 'SessionEnd',
  'CwdChanged', 'DirectoryAdded', 'FileChanged', 'PostCompact', 'PostModelSwitch', 'InstructionsLoaded', 'MessageDisplay', 'StatusLine',
]);
// `onFailure: "block"` turns a failure of the hook into a block; it exists on these hook types
// and has no effect on the events where a block means "keep working".
const ON_FAILURE_TYPES = new Set(['command', 'http', 'mcp_tool']);
const ON_FAILURE_IGNORED = new Set(['Stop', 'SubagentStop', 'TaskCompleted', 'TeammateIdle']);
// A command that forces its own exit status to success cannot stop anything through it
// (the same suppression hook-swallows-errors in lib/checks/hooks.mjs reports). What it prints
// still counts: a hook that exits 0 has its JSON applied.
const FORCED_SUCCESS_RE = /\|\|\s*(true\b|:(?=\s|;|\)|$)|exit\s+0\b)|;\s*exit\s+0\s*$/i;
const GIT_BLOCKING = new Set(['pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'pre-rebase', 'pre-push', 'pre-applypatch', 'applypatch-msg', 'pre-receive', 'update', 'proc-receive', 'push-to-checkout', 'pre-auto-gc', 'sendemail-validate', 'reference-transaction']);
// Programs whose whole effect is visible in the command line that calls them.
const TRANSPARENT = new Set(['echo', 'printf', 'cat', 'tee', 'date', 'true', ':', 'cd', 'test', '[', 'mkdir', 'touch', 'sleep', 'jq', 'sed', 'awk', 'grep', 'head', 'tail', 'wc', 'sort', 'tr', 'cut', 'logger', 'say', 'afplay', 'notify-send', 'osascript', 'terminal-notifier', 'write-output', 'write-host', 'out-file', 'add-content', 'set-content', 'exit']);

/** True when an inline command runs only programs whose behaviour its own text shows. */
function inlineIsTransparent(command) {
  if (/\$\(|`/.test(command)) return false;
  const segs = command.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
  return segs.length > 0 && segs.every((seg) => {
    const toks = seg.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    const head = (toks[0] || '').replace(/^["']|["']$/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
    return TRANSPARENT.has(head);
  });
}

/**
 * Whether a hook can stop the action it is attached to: true or false only when the code that
 * could be read shows it, null (unknown) otherwise. Unknown is: a program or script that could
 * not be read, a prompt, agent, HTTP or MCP tool hook (their decision is not in a file), an event
 * the table above does not list, a CI job (its weight depends on branch protection), and a hook
 * whose code does not settle it: the exit status or the decision is computed at run time, is
 * written only inside a string literal, or sits in source the scanner could not follow.
 * A comment is never evidence. Callers must treat null as "could not tell", never as true or false.
 */
export function hookBlocking(h) {
  if (h.source === 'git') return GIT_BLOCKING.has(h.event);
  if (h.source === 'ci') return null;
  // A background hook decides nothing: its answer arrives after the action went ahead.
  if (NEVER_BLOCK_EVENTS.has(h.event) || h.async === true || h.asyncRewake === true) return false;
  const rule = BLOCKING_EVENTS[h.event];
  if (!rule) return null;
  if (h.onFailure === 'block' && ON_FAILURE_TYPES.has(h.type) && !ON_FAILURE_IGNORED.has(h.event)) return true;
  if (h.type !== 'command' || !h.command) return null;
  const src = hookSource(h);
  if (rule.json && rule.json.test(src.text)) return src.ok ? true : null;
  const forced = FORCED_SUCCESS_RE.test(h.command);
  const computed = !!rule.fields && COMPUTED_FIELD[rule.fields].test(src.text);
  if (rule.exit && rule.exit.test(src.code)) {
    if (!forced) return src.ok ? true : null;
    // The status is thrown away: only a decision the hook still prints could block.
    return computed ? null : false;
  }
  // Where any failure of the hook stops the action, a script without an explicit exit settles nothing.
  if (rule.exit === EXIT_NON_ZERO) return null;
  // Nothing in the code blocks. That is an answer only when the text leaves nothing open ...
  if (computed || (rule.exit && !forced && (rule.exit.test(src.text) || COMPUTED_EXIT.test(src.code)))) return null;
  // ... and when everything the hook runs was read.
  if (src.read) return false;
  return !h.outside && inlineIsTransparent(h.command) ? false : null;
}

const put = (obj, key, value) => { if (value !== null && value !== undefined && value !== '') obj[key] = value; };
const trimTo = (text, max) => { const s = String(text || '').replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

function hookId(h, display, taken) {
  const base = `h${createHash('sha256').update([h.source, h.event, h.matcher || '', h.command || '', display || '', h.plugin || ''].join('\u0000')).digest('hex').slice(0, 8)}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** Per-name counts from an --impact file, in any of the shapes the probes write. */
function usage(impact) {
  if (!impact || typeof impact !== 'object') return { skill: () => null, mcp: () => null };
  const counts = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : null);
  const names = (a) => (Array.isArray(a) ? new Set(a.filter((x) => typeof x === 'string')) : null);
  const uc = impact.unusedContext && typeof impact.unusedContext === 'object' ? impact.unusedContext : {};
  const skillCounts = counts(impact.skillInvocations);
  const skillsNever = names(uc.skillsNeverInvoked);
  const mcpCounts = counts(impact.mcpCalls);
  const mcpNever = names(uc.mcpServersNeverCalled);
  // transcript-signals.mjs lists tool calls by full name: mcp__<server>__<tool>.
  const fromTools = new Map();
  const tools = counts(impact.toolCalls);
  if (tools) {
    for (const [k, v] of Object.entries(tools)) {
      if (!k.startsWith('mcp__') || typeof v !== 'number') continue;
      const end = k.indexOf('__', 5);
      if (end > 5) fromTools.set(k.slice(5, end), (fromTools.get(k.slice(5, end)) || 0) + v);
    }
  }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  return {
    skill(name, dirName, plugin) {
      for (const n of [name, dirName, plugin ? `${plugin}:${name}` : name]) {
        if (skillCounts && n in skillCounts && num(skillCounts[n]) !== null) return num(skillCounts[n]);
      }
      if (skillsNever && (skillsNever.has(name) || skillsNever.has(dirName))) return 0;
      if (skillCounts && skillsNever === null) return 0; // a full count map: absent means never invoked
      return null;
    },
    mcp(name) {
      const norm = normalizeMcpName(name);
      if (mcpCounts) for (const n of [name, norm]) if (n in mcpCounts && num(mcpCounts[n]) !== null) return num(mcpCounts[n]);
      if (fromTools.has(norm)) return fromTools.get(norm);
      if (mcpNever && (mcpNever.has(name) || mcpNever.has(norm))) return 0;
      if ((mcpCounts || tools) && mcpNever === null) return 0;
      return null;
    },
  };
}

/** Official CLI the catalog says can replace an MCP server of this name. */
function cliFor(name, catalog) {
  const lower = String(name).toLowerCase();
  const tool = (catalog || []).find((t) => Array.isArray(t.replacesMcp) && t.replacesMcp.some((r) => lower.includes(String(r).toLowerCase())));
  return tool ? String(tool.bin || tool.id) : null;
}

function clisFrom(probe, catalog) {
  const tools = probe && Array.isArray(probe.tools) ? probe.tools : [];
  const out = [];
  for (const t of tools) {
    if (!t || typeof t.id !== 'string' || typeof t.installed !== 'boolean') continue; // plugins have no binary to find
    const e = { name: t.id, installed: t.installed };
    if (typeof t.version === 'string' && t.version) e.version = trimTo(scrubHome(maskLine(t.version)), 120);
    if (typeof t.collision === 'boolean') e.collision = t.collision;
    const signals = Array.isArray(t.signalsMatched) ? t.signalsMatched.filter((s) => s && typeof s.type === 'string').map((s) => `${s.type}:${s.value}`) : [];
    if (signals.length) e.signals = signals;
    const cat = (catalog || []).find((c) => c.id === t.id);
    if (cat && cat.auth) e.auth = 'unknown'; // the probes never run a login or status command
    out.push(e);
  }
  return out;
}

export function buildElements(ctx, { impact = null, clis = null, catalog = null } = {}) {
  const idOf = (abs) => ctx.files.idOf(abs);
  const displayOf = (abs) => { const e = ctx.files.get(abs); return e ? e.display : null; };
  const use = usage(impact);
  const t = ctx.t || translator('en');
  const el = {};

  el.permissions = ctx.permissions.map((p) => {
    const o = { layer: p.layer, kind: p.kind, rule: scrubHome(maskLine(p.rule)) };
    put(o, 'file', idOf(p.fileAbs));
    return o;
  });

  const taken = new Set();
  el.hooks = ctx.hooks.map((h) => {
    const o = { id: hookId(h, displayOf(h.fileAbs), taken), source: h.source, event: h.event };
    put(o, 'matcher', h.matcher ? inline(h.matcher, 120) : '');
    put(o, 'command', h.command ? inline(h.command, 300) : '');
    put(o, 'file', idOf(h.fileAbs));
    put(o, 'script', idOf(h.scriptAbs));
    put(o, 'plugin', h.plugin);
    o.blocking = hookBlocking(h);
    const notes = [];
    if (h.note) notes.push(h.note);
    if (h.type && h.type !== 'command') notes.push(t('hook.type', { type: h.type }));
    if (h.async) notes.push(t('hook.background'));
    if (h.outside) notes.push(t('hook.outside'));
    put(o, 'note', notes.join('; '));
    return o;
  });

  el.skills = ctx.skills.map((s) => {
    const o = { name: s.name, level: s.level };
    put(o, 'plugin', s.plugin);
    o.description = inline(s.description, 300);
    o.descriptionChars = s.description.length;
    put(o, 'file', idOf(s.fileAbs));
    o.invocations = use.skill(s.name, s.dirName, s.plugin);
    return o;
  });

  el.agents = ctx.agents.map((a) => {
    const o = { name: a.name, level: a.level };
    put(o, 'model', a.model);
    put(o, 'tools', trimTo(a.tools, 300));
    o.promptChars = a.promptChars;
    put(o, 'file', idOf(a.fileAbs));
    return o;
  });

  el.plugins = ctx.plugins.map((p) => {
    const o = { name: p.name };
    put(o, 'marketplace', p.marketplace);
    if (typeof p.enabled === 'boolean') o.enabled = p.enabled;
    o.pinned = p.pinned === undefined ? null : p.pinned;
    put(o, 'note', p.note);
    return o;
  });

  el.mcp = ctx.mcp.map((m) => {
    const o = { name: m.name, level: m.level, transport: m.transport, calls: use.mcp(m.name) };
    put(o, 'cli', cliFor(m.name, catalog));
    put(o, 'file', idOf(m.fileAbs));
    put(o, 'note', m.note);
    return o;
  });

  if (clis) el.clis = clisFrom(clis, catalog);

  el.docs = ctx.docs.map((d) => {
    const o = { path: ctx.files.display(d.abs) };
    if (typeof d.bytes === 'number') o.bytes = d.bytes;
    put(o, 'lastCommit', d.lastCommit);
    put(o, 'language', d.language);
    o.status = d.status;
    put(o, 'file', idOf(d.fileAbs));
    return o;
  });
  return el;
}

/** What enters every session, in load order. Token figures are characters / 4. Names and notes are in the language of `ctx.t`. */
export function buildLayers(ctx, harnessId) {
  const layers = [];
  const layer = (name, kind, extra = {}) => {
    const l = { harness: harnessId, name, kind };
    for (const [k, v] of Object.entries(extra)) put(l, k, v);
    if (typeof l.tokens === 'number') l.basis = 'estimated';
    layers.push(l);
  };
  const t = ctx.t || translator('en');

  for (const c of ctx.chains) {
    if (c.loaded !== 'always' || !c.files.length) continue;
    const e = ctx.files.get(c.root);
    const imports = c.files.length - 1;
    const notes = [];
    if (imports) notes.push(t('layer.includes', { n: imports }));
    if (c.broken) notes.push(t('layer.broken', { n: c.broken }));
    layer(e ? e.display.split('/').pop() : t('layer.instructions'), 'instructions', {
      file: ctx.files.idOf(c.root), path: e ? e.display : null, tokens: approxTokens(c.files.reduce((s, f) => s + f.chars, 0)), note: notes.join('; '),
    });
  }
  if (ctx.rules.length) layer(t('layer.rules', { n: ctx.rules.length }), 'instructions', { tokens: approxTokens(ctx.rules.reduce((s, r) => s + r.chars, 0)) });
  for (const m of ctx.memory) {
    const e = ctx.files.get(m.abs);
    layer(t('layer.memory'), 'memory', { file: ctx.files.idOf(m.abs), path: e ? e.display : null, tokens: approxTokens(m.chars) });
  }
  const style = ctx.outputStyle;
  if (style) {
    layer(t('layer.outputStyle', { name: trimTo(style.name, 60) }), 'other', { file: ctx.files.idOf(style.abs), path: style.entry.display, tokens: approxTokens(style.chars) });
  }
  if (ctx.skills.length) {
    const fromPlugins = ctx.skills.filter((s) => s.level === 'plugin').length;
    const chars = ctx.skills.reduce((s, k) => s + k.name.length + k.description.length, 0);
    layer(t('layer.skills', { n: ctx.skills.length }), 'skills', { tokens: approxTokens(chars), note: fromPlugins ? t('layer.skillsFromPlugins', { n: fromPlugins }) : '' });
  }
  if (ctx.agents.length) {
    const chars = ctx.agents.reduce((s, a) => s + a.name.length + a.description.length, 0);
    layer(t('layer.agents', { n: ctx.agents.length }), 'other', { tokens: approxTokens(chars), note: t('layer.agentsNote') });
  }
  if (ctx.mcp.length) layer(t('layer.mcp', { n: ctx.mcp.length }), 'mcp', { note: t('layer.mcpNote') });
  const on = ctx.plugins.filter((p) => p.enabled === true).length;
  const unknown = ctx.plugins.filter((p) => typeof p.enabled !== 'boolean').length;
  if (on || unknown) {
    const counted = ctx.skills.some((s) => s.level === 'plugin') || ctx.agents.some((a) => a.level === 'plugin');
    const notes = [t(counted ? 'layer.pluginsCounted' : 'layer.pluginsUnmeasured')];
    if (unknown) notes.push(t('layer.pluginsNoState', { n: unknown }));
    layer(t('layer.plugins', { n: on }), 'plugins', { note: notes.join(' ') });
  }
  const starts = ctx.hooks.filter((h) => h.event === 'SessionStart');
  if (starts.length) layer(t('layer.sessionStart', { n: starts.length }), 'hooks', { note: t('layer.sessionStartNote') });
  return layers;
}
