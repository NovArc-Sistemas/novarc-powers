#!/usr/bin/env node
// render-board.mjs <state.json> [--out-dir <dir>] [--channel artifact|server|file] [--files all|changed]
//                  [--offline] [--lang pt|en]
//
// Validates a harness-doctor state file against templates/state.schema.json, computes the scores
// per harness exactly as references/scoring.md describes, writes them back into the state (only
// each harness's `scores` key changes), checks that every change is anchored in its file, and
// writes board.html (one self-contained file) and board.md next to the state or into --out-dir.
//
// The page is assembled from templates/board/: the skeleton, the stylesheet and the client
// fragments are inlined, together with lib/scoring.mjs and lib/anchors.mjs, so the board works
// from disk, inside a frame and as a claude.ai Artifact. Its only external request is the web
// font stylesheet, left out with --offline. `--files changed` embeds the text of only the files a
// change touches (the others keep their metadata), which makes a large run small enough to
// publish as an Artifact; the state file itself is never trimmed. The board chrome follows `state.language`, else
// --lang, else English (lib/i18n.mjs). Re-rendering an unchanged state is byte-identical.
//
// stdout: { ok, language, scores, warnings: [{ item, change, problem }], bytes, files }
// Exit 0 on success, 2 on bad arguments, 1 on failure (an invalid state changes nothing on disk).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseJsonSafe, isMain, warn, printJson, normalizeInputPath } from './lib/common.mjs';
import { STRINGS, LOCALES, resolveLanguage, fill, plural, label, compactTokens } from './lib/i18n.mjs';
import { ROUNDS_TOTAL, floor1, gradeFor, roundBreakdown, applyScores, averageScore, wasteOf, fleetImpact } from './lib/scoring.mjs';
import { anchorState } from './lib/anchors.mjs';

export * from './lib/scoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = path.join(HERE, '..', 'templates', 'state.schema.json');
export const BOARD_DIR = path.join(HERE, '..', 'templates', 'board');
export const CHANNELS = ['artifact', 'server', 'file'];
/** `all` embeds every file's text; `changed` only the files a change touches. */
export const FILE_MODES = ['all', 'changed'];
/** Where the footer's "made with" link goes. */
export const HOMEPAGE_URL = 'https://github.com/NovArc-Sistemas/novarc-powers';
/** Client fragments, in the order they are concatenated into one function scope. */
export const CLIENT_PARTS = ['logic.js', 'channel.js', 'core.js', 'parts.js', 'overview.js', 'harness.js', 'explorer.js', 'decide.js', 'board.js'];
export const FONTS_URL = 'https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=JetBrains+Mono:wght@400;500;700&display=swap';
/** Above this size the page no longer fits a claude.ai Artifact (16 MB), so the caller is told. */
const ARTIFACT_WARN_BYTES = 15 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Validation: a small hand-written validator for the JSON Schema subset the state schema uses
// (type, const, enum, required, properties, additionalProperties:false, items, minItems,
// uniqueItems, minimum, maximum, pattern, format:date-time, $ref to #/$defs). Messages name the
// path and the rule, never the offending value.
// ---------------------------------------------------------------------------------------------

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

export function validate(value, schema, root = schema, at = '', errors = []) {
  if (schema.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    const target = m && root.$defs ? root.$defs[m[1]] : null;
    if (!target) { errors.push(`${at || '/'}: unresolvable $ref`); return errors; }
    return validate(value, target, root, at, errors);
  }
  const where = at || '/';
  if ('const' in schema && value !== schema.const) errors.push(`${where}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${where}: not one of ${schema.enum.join(', ')}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) { errors.push(`${where}: expected ${types.join(' or ')}, got ${typeOf(value)}`); return errors; }
  }
  const t = typeOf(value);
  if (t === 'object') {
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${where}: missing required "${k}"`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) validate(v, props[k], root, `${at}/${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${where}: unknown property "${k}"`);
    }
  } else if (t === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${where}: needs at least ${schema.minItems} item(s)`);
    if (schema.uniqueItems) {
      const seen = new Set(value.map((x) => JSON.stringify(x)));
      if (seen.size !== value.length) errors.push(`${where}: items must be unique`);
    }
    if (schema.items) value.forEach((v, i) => validate(v, schema.items, root, `${at}/${i}`, errors));
  } else if (t === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${where}: does not match ${schema.pattern}`);
    if (schema.format === 'date-time' && (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) errors.push(`${where}: not an RFC 3339 date-time`);
  } else if (t === 'integer' || t === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${where}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${where}: above maximum ${schema.maximum}`);
  }
  return errors;
}

/**
 * Schema validation plus the cross-field rules a schema cannot express: ids are unique, and
 * everything keyed by `harness` names a harness that exists (the board has a tab per harness, so
 * an entry for an unknown one would be shown nowhere).
 */
export function validateState(state, schema) {
  const errors = validate(state, schema);
  if (errors.length) return errors;

  const unique = (list, key, at) => {
    const seen = new Set();
    (list || []).forEach((x, i) => {
      if (seen.has(x[key])) errors.push(`${at}/${i}: duplicate ${key}`);
      seen.add(x[key]);
    });
    return seen;
  };
  const harnessIds = unique(state.harnesses, 'id', '/harnesses');
  unique(state.items, 'id', '/items');
  unique(state.files, 'id', '/files');
  unique(state.groups, 'id', '/groups');

  for (const key of ['rounds', 'layers', 'files', 'inventory', 'items', 'defenses']) {
    (state[key] || []).forEach((x, i) => {
      if (!harnessIds.has(x.harness)) errors.push(`/${key}/${i}/harness: not an id in harnesses`);
    });
  }
  const seenRounds = new Set();
  state.rounds.forEach((r, i) => {
    const k = `${r.harness}\n${r.round}`;
    if (seenRounds.has(k)) errors.push(`/rounds/${i}: duplicate entry for this harness and round`);
    seenRounds.add(k);
  });
  state.harnesses.forEach((h, i) => {
    if (h.inherits !== undefined && (!harnessIds.has(h.inherits) || h.inherits === h.id)) errors.push(`/harnesses/${i}/inherits: not the id of another harness`);
  });
  if (state.accounts) {
    const accountIds = unique(state.accounts.list, 'id', '/accounts/list');
    state.accounts.list.forEach((a, i) => {
      if (!harnessIds.has(a.harness)) errors.push(`/accounts/list/${i}/harness: not an id in harnesses`);
    });
    const p = state.accounts.primary;
    if (p !== undefined && p !== null && !accountIds.has(p)) errors.push('/accounts/primary: not an id in accounts.list');
  }
  return errors;
}

/** References that do not stop the board from being drawn, reported with the anchor warnings. */
function referenceWarnings(state) {
  const out = [];
  const itemIds = new Set(state.items.map((i) => i.id));
  const groupIds = new Set((state.groups || []).map((g) => g.id));
  for (const g of state.groups || []) {
    if (g.items.some((id) => !itemIds.has(id))) out.push({ item: g.id, change: null, problem: 'the group lists an item id that is not in items' });
  }
  for (const i of state.items) {
    if (i.group !== undefined && !groupIds.has(i.group)) out.push({ item: i.id, change: null, problem: 'group id not found in groups' });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

/** JSON safe to place inside <script type="application/json">: no `<`, `>` or `&` can close the tag. */
export function embedJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * A lib module (`export const` / `export function` only, no imports) as a classic-script
 * expression: `var Name = (function () { ...; return { exports }; })();`
 */
export function inlineModule(source, name) {
  const names = [];
  const body = source.replace(/^export\s+(const|function)\s+([A-Za-z_$][\w$]*)/gm, (m, kind, id) => { names.push(id); return `${kind} ${id}`; });
  if (/^\s*(export|import)\b/m.test(body)) throw new Error(`${name}: only "export const" and "export function" can be inlined`);
  return `var ${name} = (function () {\n${body}\nreturn { ${names.join(', ')} };\n})();`;
}

let assetsCache = null;
function assets() {
  if (assetsCache) return assetsCache;
  const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const lib = (f) => read(path.join(HERE, 'lib', f));
  const board = (f) => read(path.join(BOARD_DIR, f));
  const js = [
    inlineModule(lib('scoring.mjs'), 'Scoring'),
    inlineModule(lib('anchors.mjs'), 'Anchors'),
    ...CLIENT_PARTS.map(board),
  ].join('\n');
  const css = board('board.css');
  for (const [what, text] of [['script', js], ['stylesheet', css]]) {
    if (/<\/(script|style)|<!--/i.test(text)) throw new Error(`the board ${what} must not contain a closing tag or an HTML comment`);
  }
  assetsCache = { html: board('board.html'), css, js };
  return assetsCache;
}

/** The inline script: every fragment in one function, and a visible message if drawing fails. */
function clientScript(js, failText) {
  return `(function () {
'use strict';
function main() {
${js}
}
try { main(); } catch (err) {
  var box = document.createElement('div');
  box.className = 'fatal';
  box.setAttribute('role', 'alert');
  box.appendChild(document.createElement('p')).textContent = ${embedJson(failText)};
  box.appendChild(document.createElement('pre')).textContent = String(err && err.stack ? err.stack : err);
  var view = document.getElementById('view');
  view.textContent = '';
  view.appendChild(box);
}
})();
`;
}

/**
 * A copy of the state for a smaller page: only the files a change is drawn in keep their text;
 * every other file keeps its metadata and is marked `omitted: 'not-included'`.
 */
export function withChangedFilesOnly(state) {
  const keep = new Set(Object.keys(anchorState(state).files));
  return { ...state, files: state.files.map((f) => (keep.has(f.id) || f.omitted ? f : { ...f, content: '', omitted: 'not-included' })) };
}

export function boardTitle(state, T) {
  const name = state.run.title || (state.harnesses.length === 1 ? state.harnesses[0].name : '');
  return name ? fill(T.title, { name }) : T.titlePlain;
}

/**
 * board.html for a validated state. `opts`: { lang, channel, offline, files }.
 * State strings are untrusted: they travel only inside the embedded JSON, and the client sets
 * them with textContent.
 */
export function renderHtml(state, opts = {}) {
  const lang = opts.lang || resolveLanguage(state.language);
  const T = STRINGS[lang];
  const channel = CHANNELS.includes(opts.channel) ? opts.channel : (state.environment.channel || 'file');
  const a = assets();
  const fonts = opts.offline ? '' : `<link rel="stylesheet" href="${escHtml(FONTS_URL)}">\n`;
  const boot = { lang, locale: LOCALES[lang], channel, home: HOMEPAGE_URL, t: T, state: opts.files === 'changed' ? withChangedFilesOnly(state) : state };
  const parts = {
    LANG: lang === 'pt' ? 'pt-BR' : 'en',
    TITLE: escHtml(boardTitle(state, T)),
    FONTS: fonts,
    CSS: a.css,
    SKIP: escHtml(T.skip),
    NAV: escHtml(T.nav.label),
    TRAY: escHtml(T.tray.label),
    NOSCRIPT: escHtml(T.noscript),
    DATA: embedJson(boot),
    JS: clientScript(a.js, T.renderError),
  };
  // One pass with a function replacer: inserted text is never scanned again, so nothing in the
  // state, the stylesheet or the script can be mistaken for a placeholder or a `$` pattern.
  return a.html.replace(/%%([A-Z]+)%%/g, (m, k) => (Object.prototype.hasOwnProperty.call(parts, k) ? parts[k] : m));
}

// ---------------------------------------------------------------------------------------------
// board.md: the plain-text fallback
// ---------------------------------------------------------------------------------------------

/** ISO timestamp shown as "YYYY-MM-DD HH:MM UTC" (markdown has no client to localise it). */
export function isoDateTime(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

function cell(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
const lowerFirst = (s) => String(s).charAt(0).toLowerCase() + String(s).slice(1);
/** Deducted points as written: sums of quarters are exact in binary, so no rounding is needed. */
function pointsText(n) { return String(Number(n.toFixed(4))); }
function quoteArg(text) { return `"${String(text).replace(/\s+/g, ' ').trim().replace(/[\\"$`]/g, '\\$&')}"`; }

/** The line that records a decision from chat (references/contracts.md, `run.mjs decide`). */
export function decideCommand(runId, target, action, note) {
  return `run.mjs decide --run ${runId} --target ${target} --action ${action}${note ? ` --note ${quoteArg(note)}` : ''}`;
}

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

export function renderMarkdown(state, lang = resolveLanguage(state.language), warnings = []) {
  const T = STRINGS[lang];
  const C = T.col;
  const days = state.run.windowDays || Math.max(0, ...state.harnesses.map((h) => (h.impact ? h.impact.windowDays : 0))) || 30;
  const nameOf = (id) => (state.harnesses.find((h) => h.id === id) || { name: id }).name;
  const tk = (n) => compactTokens(n, lang);
  /** A share as a percentage, floored to one decimal and written the way the language writes numbers. */
  const share = (part, whole) => (whole ? floor1(part / whole * 100) : 0).toLocaleString(LOCALES[lang], { maximumFractionDigits: 1 });
  const title = state.run.title || (state.harnesses.length === 1 ? state.harnesses[0].name : '');
  const L = [];
  L.push(`# ${title ? fill(T.md.heading, { name: title }) : T.md.headingPlain}`, '');
  L.push([
    `${T.by.mode}: ${label(T.modeName, state.mode)}`,
    `${T.by.agent}: ${state.environment.agent} (${state.environment.os})`,
    `${T.by.window}: ${plural(T.windowDays, days)}`,
    `${T.by.date}: ${isoDateTime(state.run.lastRun || state.run.startedAt)}`,
    `${T.by.run}: ${state.run.id}`,
  ].join(' · '), '');

  // Fleet
  const ordered = [...state.harnesses.filter((h) => h.kind === 'user'), ...state.harnesses.filter((h) => h.kind !== 'user')];
  const openOf = (hid) => state.items.filter((i) => i.harness === hid && i.status === 'open');
  L.push(`## ${T.md.fleet}`, '');
  L.push(`| ${C.harness} | ${C.kind} | ${C.baseline} | ${C.current} | ${C.projected} | ${C.grade} | ${C.roundsCounted} | ${T.tot.open} |`, '|---|---|---|---|---|---|---|---|');
  for (const h of ordered) {
    const s = h.scores || {};
    const score = (v) => (v === null || v === undefined ? T.notScored : String(v));
    const grades = s.grade ? (s.projectedGrade && s.projectedGrade !== s.grade ? `${s.grade} → ${s.projectedGrade}` : s.grade) : '-';
    L.push(`| ${cell(h.name)} | ${label(T.harnessKind, h.kind)} | ${score(s.baseline)} | ${score(s.current)} | ${score(s.projected)} | ${grades} | ${fill(T.md.countOf, { n: s.roundsCounted ?? 0, m: s.roundsTotal ?? ROUNDS_TOTAL })} | ${openOf(h.id).length} |`);
  }
  const avgBase = averageScore(ordered.map((h) => (h.scores || {}).baseline));
  const avgProj = averageScore(ordered.map((h) => (h.scores || {}).projected));
  if (ordered.length > 1 && avgBase !== null) {
    L.push('', `${T.tot.gradeFleet}: ${gradeFor(avgBase)} → ${gradeFor(avgProj)} (${fill(avgProj !== avgBase ? T.tot.gradeNote : T.tot.gradeSame, { before: avgBase, after: avgProj })})`);
  }
  // The fleet totals add the measured accounts, or the measured projects when no account was
  // measured: an account's impact already contains its sessions in every project.
  const fleet = fleetImpact(state.harnesses);
  if (fleet.basis) {
    const part = fleet.relative && fleet.relTotal ? fill(T.tot.wasteShareRelative, { pct: share(fleet.relWaste, fleet.relTotal) }) : fill(T.tot.wasteShare, { pct: share(fleet.waste, fleet.total) });
    L.push('', `${plural(T.tot.waste, days)}: ${tk(fleet.waste)} (${part}; ${plural(fleet.basis === 'accounts' ? T.tot.sumAccounts : T.tot.sumProjects, fleet.measured)})`);
  }
  if (fleet.sessions !== null) L.push('', `${T.tot.sessions}: ${fleet.sessions} (${plural(fleet.sessionsBasis === 'accounts' ? T.tot.inAccounts : T.tot.inProjects, fleet.sessionsFrom)})`);
  L.push('');

  // Accounts
  if (state.accounts && state.accounts.list.length) {
    L.push(`## ${T.md.accounts}`, '');
    if (state.accounts.primary === null || state.accounts.primary === undefined) L.push(T.md.primaryNone, '');
    for (const a of state.accounts.list) {
      const sync = a.sync || { mode: state.accounts.primary === a.id ? 'primary' : 'independent', status: 'none' };
      const bits = [label(T.provider, a.provider), label(T.syncMode, sync.mode)];
      if (sync.mode !== 'primary') bits.push(label(T.syncStatus, sync.status));
      L.push(`- **${cell(a.label)}** (${bits.join(', ')}): ${cell(a.path)}${sync.detail ? `. ${cell(sync.detail)}` : ''}`);
      for (const e of sync.elements || []) L.push(`  - ${cell(e.name)}: ${label(T.elementState, e.state)}${e.note ? ` (${cell(e.note)})` : ''}`);
    }
    L.push('');
  }

  // Group decisions
  const groups = state.groups || [];
  if (groups.length) {
    L.push(`## ${T.md.groups}`, '');
    for (const g of groups) {
      L.push(`- **${g.id}** ${cell(g.title)} (${fill(T.md.roundHeading, { n: g.round, name: T.rounds[g.round] })}): ${g.items.join(', ')}${g.summary ? `. ${cell(g.summary)}` : ''}`);
    }
    L.push('');
  }

  // Pending decisions, each with the exact command for chat
  const openItems = state.items.filter((i) => i.status === 'open');
  const openIds = new Set(openItems.map((i) => i.id));
  const openGroups = groups.filter((g) => g.items.some((id) => openIds.has(id)));
  const needsPrimary = state.accounts && (state.accounts.primary === null || state.accounts.primary === undefined) && state.accounts.list.length > 0;
  L.push(`## ${T.md.pending}`, '');
  if (!openItems.length && !needsPrimary) L.push(T.md.pendingNone, '');
  else {
    L.push(T.md.pendingHint, '');
    if (needsPrimary) {
      L.push(`- **${T.acc.noPrimaryTitle}**`);
      for (const a of state.accounts.list) L.push(`  - ${cell(a.label)}: \`${decideCommand(state.run.id, 'accounts.primary', 'approve', a.id)}\``);
    }
    for (const g of openGroups) {
      L.push(`- **${g.id}** (${T.dc.group}) ${cell(g.title)}: ${g.items.filter((id) => openIds.has(id)).join(', ')}`);
      L.push(`  - \`${decideCommand(state.run.id, g.id, 'approve')}\``);
    }
    const sorted = openItems.map((i, k) => ({ i, k })).sort((a, b) => (SEVERITY_ORDER[a.i.severity] - SEVERITY_ORDER[b.i.severity]) || (a.i.round - b.i.round) || (a.k - b.k));
    for (const { i } of sorted) {
      L.push(`- **${i.id}** (${label(T.severity, i.severity)}, ${cell(nameOf(i.harness))}${i.group ? `, ${i.group}` : ''}) ${cell(i.title)}`);
      L.push(`  - \`${decideCommand(state.run.id, i.id, 'approve')}\``);
      if (i.question) L.push(`  - ${T.field.question}: ${cell(i.question)}`);
    }
    L.push('');
  }

  // One section per harness
  for (const h of ordered) {
    const s = h.scores || {};
    L.push(`## ${cell(h.name)}`, '');
    const head = [label(T.harnessKindLong, h.kind)];
    if (h.provider) head.push(label(T.provider, h.provider));
    head.push(h.path);
    L.push(head.map(cell).join(' · '), '');
    if (h.inherits) L.push(fill(T.hz.inherits, { name: nameOf(h.inherits) }), '');
    if (s.current === null || s.current === undefined) L.push(`${T.sc.label}: ${T.notScored}`, '');
    else {
      L.push(`${T.sc.label}: ${C.baseline} ${s.baseline} (${s.baselineGrade}) · ${C.current} ${s.current} (${s.grade}) · ${C.projected} ${s.projected} (${s.projectedGrade})${s.previous === null || s.previous === undefined ? '' : ` · ${C.previous} ${s.previous}`}`, '');
    }

    L.push(`### ${T.md.scoresByRound}`, '', `| ${C.round} | ${C.weight} | ${C.status} | ${C.score} | ${C.deducted} | ${C.projected} | ${C.items} |`, '|---|---|---|---|---|---|---|');
    for (const r of roundBreakdown(state, h.id)) {
      L.push(`| ${r.round} ${T.rounds[r.round]} | ${r.weight} | ${label(T.roundStatus, r.status)} | ${r.counted ? floor1(r.score) : '-'} | ${r.counted ? pointsText(r.deductions) : '-'} | ${r.counted ? floor1(r.projectedScore) : '-'} | ${r.items} |`);
    }
    L.push('');

    if (h.impact) {
      const I = h.impact;
      const w = wasteOf(I);
      L.push(`### ${T.md.impact}`, '');
      L.push(fill(T.md.impactLine, { sessions: I.sessions, total: tk(I.totalTokens), days: I.windowDays, waste: tk(w.tokens), pct: share(w.tokens, I.totalTokens) }) + (I.example ? ` ${T.md.impactExample}` : ''), '');
      if (w.weighted !== null) L.push(fill(T.md.impactRelative, { total: tk(I.weightedTotal), waste: tk(w.weighted), pct: share(w.weighted, I.weightedTotal) }), '');
      const start = I.contextAtStart || {};
      if (typeof start.carriedTokens === 'number' && typeof start.carriedWeighted === 'number' && I.weightedTotal) {
        L.push(fill(T.imp.carriedLead, { tokens: tk(start.carriedTokens), pct: share(start.carriedWeighted, I.weightedTotal) }), '');
      } else if (typeof start.total === 'number' && typeof start.perSessionMedian === 'number') {
        L.push(fill(T.md.impactFixed, { total: tk(start.total), median: tk(start.perSessionMedian) }), '');
      }
      const kinds = [...(I.waste || [])].sort((a, b) => b.tokens - a.tokens);
      for (const k of kinds.filter((x) => x.episodes > 0)) {
        L.push(`- ${label(T.waste, k.kind)} (${T.basis.measured}): ${tk(k.tokens)}, ${plural(T.imp.episodes, k.episodes)}${(k.items || []).length ? `; ${T.imp.addressedBy} ${k.items.join(', ')}` : ''}`);
      }
      const quiet = kinds.filter((x) => !(x.episodes > 0)).map((x) => lowerFirst(label(T.waste, x.kind)));
      if (quiet.length) L.push(`- ${fill(T.imp.noEpisodes, { list: quiet.join(', ') })}`);
      for (const e of I.estimates || []) L.push(`- ${cell(e.label)} (${T.basis.estimated}): ${tk(e.tokens)}; ${fill(T.imp.source, { source: cell(e.source) })}`);
      L.push('');
    } else if (h.impactSkipped) {
      const skip = h.impactSkipped;
      const why = skip.reason === 'shared-sessions' && skip.with ? fill(T.imp.skippedShared, { name: nameOf(skip.with) }) : skip.reason === 'no-transcript-reader' ? T.imp.skippedNoReader : T.imp.none;
      L.push(`### ${T.md.impact}`, '', why, '');
    }

    const items = state.items.filter((i) => i.harness === h.id);
    L.push(`### ${T.md.itemsByRound}`, '');
    if (!items.length) L.push(T.md.noItems, '');
    const F = T.field;
    for (let r = 1; r <= ROUNDS_TOTAL; r++) {
      const inRound = items.filter((i) => i.round === r);
      if (!inRound.length) continue;
      L.push(`#### ${fill(T.md.roundHeading, { n: r, name: T.rounds[r] })}`, '');
      L.push(`| ${C.id} | ${C.severity} | ${C.status} | ${C.class} | ${C.origin} | ${C.title} |`, '|---|---|---|---|---|---|');
      for (const i of inRound) L.push(`| ${cell(i.id)} | ${label(T.severity, i.severity)} | ${label(T.status, i.status)} | ${label(T.class, i.class)} | ${label(T.origin, i.origin || 'active')} | ${cell(i.title)} |`);
      L.push('');
      for (const i of inRound) {
        L.push(`- **${i.id}** ${cell(i.finding)}`);
        if (i.evidence) L.push(`  - ${F.evidence}: ${cell(i.evidence)}`);
        const paths = [...new Set((i.changes || []).map((c) => c.path))];
        if (paths.length) L.push(`  - ${F.file}: ${paths.map(cell).join(', ')} (${plural(T.md.changes, i.changes.length)})`);
        else if (i.file) L.push(`  - ${F.file}: ${cell(i.file)}`);
        L.push(`  - ${F.proposal}: ${cell(i.proposal)}`);
        L.push(`  - ${F.opinion}: ${cell(i.opinion)}`);
        if (i.lesson && i.lesson.principle) L.push(`  - ${T.lesson.principle}: ${cell(i.lesson.principle)}`);
        if (i.decision) L.push(`  - ${F.decision}: ${cell(i.decision)}`);
        if (i.question) L.push(`  - ${F.question}: ${cell(i.question)}`);
        if (i.verified) L.push(`  - ${F.verified}: ${cell(i.verified)}`);
        if (i.notVerified) L.push(`  - ${F.notVerified}: ${cell(i.notVerified)}`);
      }
      L.push('');
    }

    L.push(`### ${T.md.defenses}`, '', T.def.note, '');
    const defenses = (state.defenses || []).filter((d) => d.harness === h.id);
    if (!defenses.length) L.push(T.def.none);
    for (const d of defenses) L.push(`- **${cell(d.title)}**${d.detail ? `: ${cell(d.detail)}` : ''}`);
    L.push('');

    const layers = (state.layers || []).filter((l) => l.harness === h.id);
    const total = layers.reduce((a, l) => a + (l.tokens || 0), 0);
    L.push(`### ${T.md.layers}`, '');
    if (!layers.length) L.push(T.lay.none, '');
    else {
      L.push(fill(T.lay.total, { total }), '');
      L.push(`| ${C.num} | ${C.kind} | ${C.name} | ${C.path} | ${C.tokens} | ${C.basis} |`, '|---|---|---|---|---|---|');
      layers.forEach((l, k) => L.push(`| ${k + 1} | ${cell(label(T.layerKind, l.kind))} | ${cell(l.name)} | ${cell(l.path || '')} | ${l.tokens ?? '-'} | ${l.basis ? label(T.basis, l.basis) : ''} |`));
      L.push('');
    }

    const leads = (state.leads || []).filter((l) => l.harness === h.id);
    if (leads.length) {
      L.push(`### ${T.md.leads}`, '');
      for (const l of leads) L.push(`- **${cell(l.title)}**: ${cell(l.source)}${l.note ? ` (${cell(l.note)})` : ''}`);
      L.push('');
    }
  }

  if (warnings.length) {
    L.push(`## ${T.md.warnings}`, '');
    for (const w of warnings) L.push(`- **${w.item}**${w.change === null || w.change === undefined ? '' : ` #${w.change + 1}`}: ${cell(w.problem)}`);
    L.push('');
  }

  const general = (state.leads || []).filter((l) => !l.harness || !state.harnesses.some((h) => h.id === l.harness));
  if (general.length) {
    L.push(`## ${T.md.leads}`, '');
    for (const l of general) L.push(`- **${cell(l.title)}**: ${cell(l.source)}${l.note ? ` (${cell(l.note)})` : ''}`);
    L.push('');
  }

  L.push(`## ${T.md.log}`, '');
  if (!state.log.length) L.push(T.log.empty);
  for (const l of state.log) {
    const tags = [l.harness ? nameOf(l.harness) : null, l.item || null].filter(Boolean);
    L.push(`- ${isoDateTime(l.at)}${tags.length ? ` [${tags.map(cell).join(' · ')}]` : ''} ${cell(l.text)}`);
  }
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export function renderFile(statePath, outDir, opts = {}) {
  const schemaRes = parseJsonSafe(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  if (!schemaRes.ok) return { ok: false, errors: ['schema file is not valid JSON'] };
  let text;
  try { text = fs.readFileSync(statePath, 'utf8'); } catch (e) { return { ok: false, errors: [`cannot read state file (${e.code || 'error'})`] }; }
  const parsed = parseJsonSafe(text);
  if (!parsed.ok) return { ok: false, errors: ['state file is not valid JSON'] };
  const state = parsed.value;
  const errors = validateState(state, schemaRes.value);
  if (errors.length) return { ok: false, errors };

  const scores = applyScores(state);
  const postErrors = validateState(state, schemaRes.value);
  if (postErrors.length) return { ok: false, errors: postErrors };

  const anchors = anchorState(state);
  const warnings = [...anchors.warnings.map((w) => ({ item: w.item, change: w.change, problem: w.problem })), ...referenceWarnings(state)];
  const lang = resolveLanguage(state.language, opts.lang);
  const html = renderHtml(state, { lang, channel: opts.channel, offline: opts.offline === true, files: opts.files });
  const md = renderMarkdown(state, lang, warnings);

  const out = outDir || path.dirname(statePath);
  fs.mkdirSync(out, { recursive: true });
  const stateText = JSON.stringify(state, null, 2) + '\n';
  if (stateText !== text) fs.writeFileSync(statePath, stateText);
  const htmlPath = path.join(out, 'board.html');
  const mdPath = path.join(out, 'board.md');
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(mdPath, md);
  return { ok: true, language: lang, scores, warnings, bytes: Buffer.byteLength(html), files: { state: statePath, html: htmlPath, md: mdPath } };
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  // --offline takes no value: a path that follows it is the state file, not its argument.
  if (typeof args.offline === 'string') { args._.push(args.offline); args.offline = true; }
  const statePath = args._[0];
  const channel = typeof args.channel === 'string' ? args.channel : undefined;
  const files = typeof args.files === 'string' ? args.files : undefined;
  const badChoice = args.channel === true || (channel !== undefined && !CHANNELS.includes(channel)) || args.files === true || (files !== undefined && !FILE_MODES.includes(files));
  if (!statePath || args._.length > 1 || badChoice) {
    warn('usage: render-board.mjs <state.json> [--out-dir <dir>] [--channel artifact|server|file] [--files all|changed] [--offline] [--lang pt|en]');
    process.exit(2);
  }
  const lang = typeof args.lang === 'string' ? args.lang : undefined;
  if (lang !== undefined && !(lang in STRINGS)) warn('unsupported --lang; falling back to en');
  let res;
  try {
    res = renderFile(normalizeInputPath(statePath), typeof args['out-dir'] === 'string' ? normalizeInputPath(args['out-dir']) : undefined, { lang, channel, files, offline: args.offline === true });
  } catch (e) {
    // Never echo file content: an unexpected failure is reported by its kind only.
    const kind = e && e.code ? e.code : e && e.name ? e.name : 'error';
    warn(`could not render the board (${kind})`);
    printJson({ ok: false, errors: [`render failed (${kind})`] });
    process.exit(1);
  }
  if (!res.ok) {
    warn('state is invalid:');
    for (const e of res.errors) warn(`  ${e}`);
    printJson({ ok: false, errors: res.errors });
    process.exit(1);
  }
  if (res.bytes > ARTIFACT_WARN_BYTES) warn(`board.html is ${Math.round(res.bytes / 1048576)} MB, over what a claude.ai Artifact accepts (16 MB): show it with the local server instead`);
  for (const w of res.warnings) warn(`warning: ${w.item}${w.change === null ? '' : ` change ${w.change + 1}`}: ${w.problem}`);
  printJson({ ok: true, language: res.language, scores: res.scores, warnings: res.warnings, bytes: res.bytes, files: { state: path.basename(res.files.state), html: 'board.html', md: 'board.md' } });
}
