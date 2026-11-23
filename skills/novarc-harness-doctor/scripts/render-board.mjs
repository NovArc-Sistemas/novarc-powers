#!/usr/bin/env node
// render-board.mjs <state.json> [--out-dir <dir>] [--lang en|pt]
//
// Validates a harness-doctor state file against templates/state.schema.json, computes the scores
// exactly as references/scoring.md describes (confidence-weighted, 0 to 100 per round), writes them back into the state (only the `scores`
// key changes), and writes board.html + board.md next to the state or into --out-dir.
// The board chrome follows `state.language`, else --lang, else English (scripts/lib/i18n.mjs).
// Re-rendering an unchanged state produces byte-identical files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseJsonSafe, isMain, warn, printJson, normalizeInputPath } from './lib/common.mjs';
import { STRINGS, LOCALES, resolveLanguage, fill, label, jsLiteral } from './lib/i18n.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = path.join(HERE, '..', 'templates', 'state.schema.json');

// ---------------------------------------------------------------------------------------------
// Scoring (references/scoring.md)
// ---------------------------------------------------------------------------------------------

export const ROUND_WEIGHTS = { 1: 20, 2: 15, 3: 10, 4: 15, 5: 5, 6: 15, 7: 10, 8: 10 };
/** English round names; the localised ones live in lib/i18n.mjs. */
export const ROUND_NAMES = STRINGS.en.rounds;
export const ROUNDS_TOTAL = 8;
// Confidence-weighted model: every counted round starts at 100 and loses points per unresolved
// item, weighted by status and by where the finding lives, with the noise of one non-active file
// capped. The idea is inspired by AgentShield's src/reporter/score.ts (MIT,
// affaan-m/agentshield); this is a re-implementation. Rationale in references/scoring.md.
export const SEVERITY_POINTS = { critical: 25, high: 15, medium: 5, low: 2 };
// `in-progress` counts in full: an item being worked on is not resolved yet.
export const STATUS_FACTOR = {
  open: 1, queued: 1, failed: 1, 'in-progress': 1,
  accepted: 0.5,
  fixed: 0, ok: 0, 'wontfix-not-applicable': 0,
};
/** How much a finding counts by where it lives. An item without `origin` is `active`. */
export const ORIGIN_WEIGHT = { active: 1, 'project-optional': 0.75, plugin: 0.5, example: 0.25 };
/** Most points the non-active items of one file can take from one round. */
export const FILE_CAP = 10;
export const ROUND_MAX = 100;

/** Floor to one decimal ("never round one up"), with an epsilon so 64.99999999 reads as 65. */
export function floor1(x) {
  return Math.floor(x * 10 + 1e-7) / 10;
}

export function gradeFor(score) {
  if (score === null || score === undefined) return null;
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function roundStatus(state, scope, round) {
  const r = (state.rounds || []).find((x) => x.scope === scope && x.round === round);
  return r ? r.status : 'pending';
}

/** The file an item is about: its first change's path, else `file`, else null. */
export function itemFile(item) {
  const c = Array.isArray(item.changes) ? item.changes[0] : null;
  if (c && c.path) return c.path;
  return item.file || null;
}

/** Origin weight. A `secret` item always counts in full, wherever it lives. */
export function originWeight(item) {
  if (item.class === 'secret') return 1;
  return ORIGIN_WEIGHT[item.origin || 'active'] ?? 1;
}

/** True when the item's deduction goes into its file's capped group. */
function inFileCap(item) {
  return (item.origin || 'active') !== 'active' && item.class !== 'secret' && itemFile(item) !== null;
}

/**
 * Points one round loses to its items: severity x status factor x origin weight, summed, with the
 * items of each non-active file (secrets excepted) capped together at FILE_CAP. `baseline` treats
 * every item as open (status factor 1); origin weights and the cap apply either way.
 */
export function roundDeductions(items, { baseline = false } = {}) {
  let total = 0;
  const perFile = new Map();
  for (const i of items) {
    const status = baseline ? 1 : (STATUS_FACTOR[i.status] ?? 1);
    const d = (SEVERITY_POINTS[i.severity] ?? 0) * status * originWeight(i);
    if (inFileCap(i)) {
      const f = itemFile(i);
      perFile.set(f, (perFile.get(f) || 0) + d);
    } else {
      total += d;
    }
  }
  for (const d of perFile.values()) total += Math.min(FILE_CAP, d);
  return total;
}

/**
 * Per-round breakdown for one scope. Round score = max(0, 100 - deductions), from 0 to 100, and
 * null for a round that is not `done`. `baselineScore` treats every item as open.
 */
export function roundBreakdown(state, scope) {
  const out = [];
  for (let r = 1; r <= ROUNDS_TOTAL; r++) {
    const status = roundStatus(state, scope, r);
    const items = (state.items || []).filter((i) => i.scope === scope && i.round === r);
    const deductions = roundDeductions(items);
    const baselineDeductions = roundDeductions(items, { baseline: true });
    const counted = status === 'done';
    out.push({
      round: r,
      name: ROUND_NAMES[r],
      status,
      weight: ROUND_WEIGHTS[r],
      counted,
      items: items.length,
      deductions,
      baselineDeductions,
      score: counted ? Math.max(0, ROUND_MAX - deductions) : null,
      baselineScore: counted ? Math.max(0, ROUND_MAX - baselineDeductions) : null,
    });
  }
  return out;
}

/** Scope score = weighted average of the `done` rounds' scores, floored to one decimal. */
export function scoreScope(state, scope) {
  const rows = roundBreakdown(state, scope);
  const done = rows.filter((r) => r.counted);
  // Rounds that do not apply to this scope are not part of the total ("7 of 7", not "7 of 8").
  const roundsTotal = rows.filter((r) => r.status !== 'not-applicable').length;
  if (done.length === 0) {
    return { current: null, baseline: null, grade: null, roundsCounted: 0, roundsTotal, breakdown: rows };
  }
  const w = done.reduce((s, r) => s + r.weight, 0);
  const cur = floor1(done.reduce((s, r) => s + r.weight * r.score, 0) / w);
  const base = floor1(done.reduce((s, r) => s + r.weight * r.baselineScore, 0) / w);
  return { current: cur, baseline: base, grade: gradeFor(cur), roundsCounted: done.length, roundsTotal, breakdown: rows };
}

/**
 * New `scores` object. `previous` is preserved from the existing state (it is set when a re-run
 * starts, not by the renderer). `computedAt` only moves when a computed value changed, so an
 * unchanged state renders byte-identically.
 */
export function computeScores(state, now = new Date()) {
  const scores = {};
  const old = state.scores || {};
  for (const scope of state.scopes || []) {
    const s = scoreScope(state, scope);
    const prev = old[scope] || {};
    const same = prev.current === s.current && prev.baseline === s.baseline && prev.grade === s.grade
      && prev.roundsCounted === s.roundsCounted && prev.roundsTotal === s.roundsTotal;
    scores[scope] = {
      current: s.current,
      baseline: s.baseline,
      previous: prev.previous === undefined ? null : prev.previous,
      grade: s.grade,
      roundsCounted: s.roundsCounted,
      roundsTotal: s.roundsTotal,
      computedAt: same && prev.computedAt ? prev.computedAt : now.toISOString(),
    };
  }
  return scores;
}

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
      if (props[k]) validate(v, props[k], root, `${at}/${k}`, errors);
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

/** Schema validation plus the cross-field rules a schema cannot express. */
export function validateState(state, schema) {
  const errors = validate(state, schema);
  if (errors.length) return errors;
  const seenRounds = new Set();
  state.rounds.forEach((r, i) => {
    const k = `${r.scope}:${r.round}`;
    if (seenRounds.has(k)) errors.push(`/rounds/${i}: duplicate entry for round ${r.round} scope ${r.scope}`);
    seenRounds.add(k);
  });
  const ids = new Set();
  state.items.forEach((it, i) => {
    if (ids.has(it.id)) errors.push(`/items/${i}: duplicate id "${it.id}"`);
    ids.add(it.id);
  });
  return errors;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function boardData(state) {
  const derived = {};
  for (const scope of state.scopes) derived[scope] = scoreScope(state, scope).breakdown;
  return { state, breakdown: derived, weights: ROUND_WEIGHTS };
}

/** JSON safe to place inside <script type="application/json">: no `<`, `>` or `&` can close the tag. */
function embedJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: var(--color-background-primary, #ffffff);
  --bg2: var(--color-background-secondary, #f4f4f2);
  --bg3: var(--color-background-tertiary, #e9e9e6);
  --fg: var(--color-text-primary, #1d1d1b);
  --fg2: var(--color-text-secondary, #4f4f4a);
  --border: var(--color-border-primary, #c9c9c4);
  --border2: var(--color-border-secondary, #e2e2de);
  --ok-bg: var(--color-background-success, #dff3e4);
  --ok-fg: var(--color-text-success, #14532d);
  --warn-bg: var(--color-background-warning, #fbefd5);
  --warn-fg: var(--color-text-warning, #713f12);
  --bad-bg: var(--color-background-danger, #fbe0e0);
  --bad-fg: var(--color-text-danger, #7f1d1d);
  --info-bg: var(--color-background-info, #dde9fb);
  --info-fg: var(--color-text-info, #1e3a8a);
  --sans: var(--font-sans, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif);
  --mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  --radius: var(--border-radius-md, 6px);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: var(--color-background-primary, #161615);
    --bg2: var(--color-background-secondary, #1f1f1d);
    --bg3: var(--color-background-tertiary, #2a2a27);
    --fg: var(--color-text-primary, #ededea);
    --fg2: var(--color-text-secondary, #b4b4ae);
    --border: var(--color-border-primary, #45453f);
    --border2: var(--color-border-secondary, #33332f);
    --ok-bg: var(--color-background-success, #12301c);
    --ok-fg: var(--color-text-success, #a7e8b8);
    --warn-bg: var(--color-background-warning, #3a2c0c);
    --warn-fg: var(--color-text-warning, #f4d58d);
    --bad-bg: var(--color-background-danger, #3d1414);
    --bad-fg: var(--color-text-danger, #f6b4b4);
    --info-bg: var(--color-background-info, #152544);
    --info-fg: var(--color-text-info, #b5ccf5);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--sans); line-height: 1.45; }
body { padding: 16px; }
main { max-width: 75rem; margin: 0 auto; display: flex; flex-direction: column; gap: 28px; }
h1 { font-size: 1.5rem; margin: 0; }
h2 { font-size: 1.15rem; margin: 0 0 10px; }
h3 { font-size: 1rem; margin: 0 0 8px; }
p { margin: 0; }
.muted { color: var(--fg2); }
.mono { font-family: var(--mono); font-size: 0.85em; }
.nowrap { white-space: nowrap; }
header { display: flex; flex-direction: column; gap: 4px; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--fg2); font-size: 0.9rem; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr)); gap: 16px; }
.card { border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; background: var(--bg2); display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.score-row { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.big { font-size: 2.6rem; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
.big.none { font-size: 1.4rem; font-weight: 600; color: var(--fg2); }
.grade { font-size: 1.3rem; font-weight: 700; padding: 2px 10px; border-radius: var(--radius); }
.g-A, .g-B { background: var(--ok-bg); color: var(--ok-fg); }
.g-C, .g-D { background: var(--warn-bg); color: var(--warn-fg); }
.g-F { background: var(--bad-bg); color: var(--bad-fg); }
.bars { display: flex; flex-direction: column; gap: 6px; }
.bar { display: grid; grid-template-columns: minmax(0, 11rem) minmax(0, 1fr) 4.5rem; gap: 8px; align-items: center; font-size: 0.85rem; }
.bar .track { height: 10px; background: var(--bg3); border-radius: 999px; overflow: hidden; border: 1px solid var(--border2); }
.bar .fill { height: 100%; background: var(--info-fg); }
.bar .num { text-align: right; font-variant-numeric: tabular-nums; color: var(--fg2); }
.bar .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.layers { display: flex; flex-direction: column; gap: 6px; }
.layer { display: grid; grid-template-columns: 6.5rem minmax(0, 1fr) 6rem; gap: 8px; align-items: center; padding: 8px 10px; border: 1px solid var(--border2); border-radius: var(--radius); background: var(--bg2); }
.layer .kind { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg2); }
.layer .what { min-width: 0; overflow-wrap: anywhere; }
.layer .tok { text-align: right; font-variant-numeric: tabular-nums; font-size: 0.85rem; }
.layer .tokbar { grid-column: 1 / -1; height: 4px; background: var(--bg3); border-radius: 999px; overflow: hidden; }
.layer .tokbar > div { height: 100%; background: var(--info-fg); }
.scroll { overflow-x: auto; border: 1px solid var(--border2); border-radius: var(--radius); }
table { border-collapse: collapse; width: 100%; font-size: 0.88rem; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border2); vertical-align: top; }
th { background: var(--bg2); font-weight: 600; white-space: nowrap; }
tr:last-child td { border-bottom: none; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.78rem; white-space: nowrap; background: var(--bg3); color: var(--fg); }
.s-critical, .st-failed, .v-problem, .r-pending { background: var(--bad-bg); color: var(--bad-fg); }
.s-high, .st-open, .st-queued, .v-attention, .r-skipped { background: var(--warn-bg); color: var(--warn-fg); }
.s-medium, .st-in-progress, .st-accepted, .r-not-applicable { background: var(--info-bg); color: var(--info-fg); }
.s-low { background: var(--bg3); color: var(--fg); }
.st-fixed, .st-ok, .st-wontfix-not-applicable, .v-fine, .r-done { background: var(--ok-bg); color: var(--ok-fg); }
.filters { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: end; margin-bottom: 10px; }
.filters label { display: flex; flex-direction: column; gap: 2px; font-size: 0.8rem; color: var(--fg2); }
select { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 4px 6px; }
details { border: 1px solid var(--border2); border-radius: var(--radius); background: var(--bg); }
details + details { margin-top: 8px; }
summary { cursor: pointer; padding: 8px 10px; font-weight: 600; }
details > .scroll { border: none; border-top: 1px solid var(--border2); border-radius: 0; }
td details { border: none; background: transparent; }
td summary { padding: 0; font-weight: 400; }
.detail-grid { display: grid; gap: 6px; padding: 8px 0 2px; }
.detail-grid b { font-weight: 600; }
ul.plain { margin: 0; padding-left: 1.2rem; display: flex; flex-direction: column; gap: 6px; }
.defenses-note { margin-bottom: 10px; }
`;

// The client receives `T` (the chrome dictionary for the board's language) and `LOCALE` from a
// small script block written by renderHtml; every user-visible string comes from `T`.
const CLIENT_JS = `
(function () {
  var data = JSON.parse(document.getElementById('board-data').textContent);
  var st = data.state;
  function el(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'cls') n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return n;
  }
  function fill(tpl, vars) { return String(tpl).replace(/\\{(\\w+)\\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m; }); }
  function lbl(map, v) { return map && Object.prototype.hasOwnProperty.call(map, v) ? map[v] : String(v); }
  function pill(prefix, v, map) { return el('span', { cls: 'pill ' + prefix + String(v), text: lbl(map, v) }); }
  // Floors like the renderer: a score shown is never rounded up.
  function fmt(n) { return n === null || n === undefined ? '-' : (Math.floor(n * 10 + 1e-7) / 10).toLocaleString(LOCALE); }
  function when(iso) { var d = new Date(iso); return isNaN(d.getTime()) ? String(iso) : d.toLocaleString(LOCALE); }
  function table(head, rows) {
    var t = el('table');
    var tr = el('tr');
    head.forEach(function (h) { tr.appendChild(el('th', { scope: 'col', text: h })); });
    t.appendChild(el('thead', null, tr));
    var tb = el('tbody');
    rows.forEach(function (r) { tb.appendChild(r); });
    t.appendChild(tb);
    return el('div', { cls: 'scroll' }, t);
  }
  function td() { var n = el('td'); for (var i = 0; i < arguments.length; i++) { var c = arguments[i]; if (c === null || c === undefined) continue; n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c); } return n; }

  // Dates written by the renderer as ISO, shown in the board's locale.
  Array.prototype.forEach.call(document.querySelectorAll('time[data-local]'), function (t) { t.textContent = when(t.getAttribute('datetime')); });

  // Score cards
  var cards = document.getElementById('cards');
  st.scopes.forEach(function (scope) {
    var sc = (st.scores || {})[scope] || {};
    var rows = data.breakdown[scope] || [];
    var card = el('section', { cls: 'card', 'aria-label': fill(T.scoreAria, { scope: lbl(T.scopeHarness, scope) }) });
    card.appendChild(el('h3', { text: lbl(T.scopeHarness, scope) }));
    var row = el('div', { cls: 'score-row' });
    if (sc.current === null || sc.current === undefined) {
      row.appendChild(el('span', { cls: 'big none', text: T.notScored }));
    } else {
      row.appendChild(el('span', { cls: 'big', text: fmt(sc.current) }));
      row.appendChild(el('span', { cls: 'muted', text: T.outOf }));
      if (sc.grade) row.appendChild(el('span', { cls: 'grade g-' + sc.grade, text: sc.grade }));
    }
    card.appendChild(row);
    var meta = el('div', { cls: 'meta' });
    meta.appendChild(el('span', { text: fill(T.baselineCurrent, { baseline: fmt(sc.baseline), current: fmt(sc.current) }) }));
    meta.appendChild(el('span', { text: fill(T.previousRun, { previous: sc.previous === null || sc.previous === undefined ? T.none : fmt(sc.previous) }) }));
    meta.appendChild(el('span', { text: fill(T.roundsOf, { n: sc.roundsCounted || 0, m: sc.roundsTotal || 8 }) }));
    card.appendChild(meta);
    var bars = el('div', { cls: 'bars' });
    rows.forEach(function (r) {
      var b = el('div', { cls: 'bar' });
      var name = lbl(T.rounds, r.round);
      b.appendChild(el('span', { cls: 'label', title: name, text: r.round + ' ' + name }));
      var track = el('div', { cls: 'track', role: 'img', 'aria-label': r.counted ? fill(T.pointsOf, { score: fmt(r.score), weight: r.weight }) : lbl(T.roundStatus, r.status) });
      var pct = r.counted ? Math.max(0, Math.min(100, r.score)) : 0;
      var fillBar = el('div', { cls: 'fill' }); fillBar.style.width = pct + '%';
      track.appendChild(fillBar);
      b.appendChild(track);
      b.appendChild(el('span', { cls: 'num', text: r.counted ? fmt(r.score) : lbl(T.roundStatus, r.status) }));
      bars.appendChild(b);
    });
    card.appendChild(bars);
    cards.appendChild(card);
  });

  // Recognized defenses: listed for context, never part of the score.
  var defBox = document.getElementById('defenses');
  var defs = st.defenses || [];
  if (!defs.length) defBox.appendChild(el('p', { cls: 'muted', text: T.noDefenses }));
  else {
    var dul = el('ul', { cls: 'plain' });
    defs.forEach(function (d) {
      dul.appendChild(el('li', null, el('b', { text: d.title }), ' \\u2014 ', el('span', { cls: 'muted', text: lbl(T.scope, d.scope) }), d.detail ? el('div', { cls: 'muted', text: d.detail }) : null));
    });
    defBox.appendChild(dul);
  }

  // Layers
  var layersBox = document.getElementById('layers');
  st.scopes.forEach(function (scope) {
    var ls = (st.layers || []).filter(function (l) { return l.scope === scope; });
    var total = ls.reduce(function (s, l) { return s + (l.tokens || 0); }, 0);
    var max = ls.reduce(function (m, l) { return Math.max(m, l.tokens || 0); }, 0) || 1;
    var wrap = el('div', { cls: 'layers' });
    wrap.appendChild(el('h3', { text: fill(T.tokensPerSession, { scope: lbl(T.scopeTitle, scope), total: total.toLocaleString(LOCALE) }) }));
    if (!ls.length) wrap.appendChild(el('p', { cls: 'muted', text: T.noLayers }));
    ls.forEach(function (l) {
      var row = el('div', { cls: 'layer' });
      row.appendChild(el('span', { cls: 'kind', text: lbl(T.kind, l.kind) }));
      var what = el('span', { cls: 'what' }, el('span', { text: l.name }));
      if (l.path) what.appendChild(el('span', { cls: 'muted mono', text: '  ' + l.path }));
      if (l.note) what.appendChild(el('div', { cls: 'muted', text: l.note }));
      row.appendChild(what);
      row.appendChild(el('span', { cls: 'tok', text: l.tokens === undefined ? '-' : l.tokens.toLocaleString(LOCALE) }));
      var tb = el('div', { cls: 'tokbar' }); var f = el('div'); f.style.width = ((l.tokens || 0) / max * 100) + '%'; tb.appendChild(f);
      row.appendChild(tb);
      wrap.appendChild(row);
    });
    layersBox.appendChild(wrap);
  });

  // Rounds progress
  var rp = [];
  for (var r = 1; r <= 8; r++) {
    var tr = el('tr');
    tr.appendChild(td(r + ' ' + lbl(T.rounds, r)));
    tr.appendChild(td(String(data.weights[r])));
    st.scopes.forEach(function (scope) {
      var e = (st.rounds || []).filter(function (x) { return x.round === r && x.scope === scope; })[0];
      var s = e ? e.status : 'pending';
      var cell = td(pill('r-', s, T.roundStatus));
      if (e && e.note) cell.appendChild(el('div', { cls: 'muted', text: e.note }));
      tr.appendChild(cell);
    });
    rp.push(tr);
  }
  document.getElementById('rounds').appendChild(table([T.col.round, T.col.weight].concat(st.scopes.map(function (s) { return lbl(T.scope, s); })), rp));

  // Items with filters
  var filters = { scope: '', round: '', status: '', severity: '' };
  var optionLabel = {
    scope: function (v) { return lbl(T.scope, v); },
    round: function (v) { return v + ' ' + lbl(T.rounds, v); },
    status: function (v) { return lbl(T.status, v); },
    severity: function (v) { return lbl(T.severity, v); }
  };
  var fbox = document.getElementById('item-filters');
  function uniq(key) { var s = {}; (st.items || []).forEach(function (i) { s[i[key]] = 1; }); return Object.keys(s).sort(); }
  ['scope', 'round', 'status', 'severity'].forEach(function (key) {
    var id = 'f-' + key;
    var sel = el('select', { id: id });
    sel.appendChild(el('option', { value: '', text: T.all }));
    uniq(key).forEach(function (v) { sel.appendChild(el('option', { value: v, text: optionLabel[key](v) })); });
    sel.addEventListener('change', function () { filters[key] = sel.value; drawItems(); });
    fbox.appendChild(el('label', { 'for': id }, T.filter[key], sel));
  });
  var count = el('span', { cls: 'muted' });
  fbox.appendChild(count);
  var itemsBox = document.getElementById('items');
  function drawItems() {
    itemsBox.textContent = '';
    var list = (st.items || []).filter(function (i) {
      return (!filters.scope || i.scope === filters.scope) && (!filters.round || String(i.round) === filters.round)
        && (!filters.status || i.status === filters.status) && (!filters.severity || i.severity === filters.severity);
    });
    count.textContent = fill(T.itemsCount, { n: list.length, m: (st.items || []).length });
    var rows = list.map(function (i) {
      var tr = el('tr');
      tr.appendChild(td(el('span', { cls: 'mono nowrap', text: i.id })));
      tr.appendChild(td(lbl(T.scope, i.scope)));
      tr.appendChild(td(String(i.round)));
      tr.appendChild(td(pill('s-', i.severity, T.severity)));
      tr.appendChild(td(pill('st-', i.status, T.status)));
      tr.appendChild(td(lbl(T['class'], i['class'])));
      tr.appendChild(td(lbl(T.origin, i.origin || 'active')));
      var d = el('details');
      d.appendChild(el('summary', { text: i.title }));
      var g = el('div', { cls: 'detail-grid' });
      [['finding', i.finding], ['evidence', i.evidence], ['proposal', i.proposal], ['opinion', i.opinion], ['decision', i.decision],
       ['verified', i.verified], ['notVerified', i.notVerified], ['backup', i.backup], ['file', i.file], ['updated', i.updatedAt ? when(i.updatedAt) : '']].forEach(function (p) {
        if (p[1]) g.appendChild(el('p', null, el('b', { text: T.field[p[0]] + ': ' }), p[1]));
      });
      d.appendChild(g);
      tr.appendChild(td(d));
      return tr;
    });
    if (!rows.length) { var e = el('tr'); var c = td(T.noItemsMatch); c.setAttribute('colspan', '8'); e.appendChild(c); rows.push(e); }
    itemsBox.appendChild(table([T.col.id, T.col.scope, T.col.round, T.col.severity, T.col.status, T.col['class'], T.col.origin, T.col.title], rows));
  }
  drawItems();

  // Inventory, grouped by scope and category
  var inv = document.getElementById('inventory');
  var groups = {};
  (st.inventory || []).forEach(function (e) { var k = lbl(T.scope, e.scope) + ' \\u00b7 ' + e.category; (groups[k] = groups[k] || []).push(e); });
  var keys = Object.keys(groups).sort();
  if (!keys.length) inv.appendChild(el('p', { cls: 'muted', text: T.inventoryEmpty }));
  keys.forEach(function (k) {
    var list = groups[k];
    var flagged = list.filter(function (e) { return e.verdict !== 'fine'; }).length;
    var d = el('details');
    if (flagged) d.setAttribute('open', '');
    d.appendChild(el('summary', { text: k + ' (' + list.length + (flagged ? ', ' + fill(T.flagged, { n: flagged }) : '') + ')' }));
    var rows = list.map(function (e) {
      var tr = el('tr');
      tr.appendChild(td(pill('v-', e.verdict, T.verdict)));
      var n = td(e.name);
      if (e.path) n.appendChild(el('div', { cls: 'muted mono', text: e.path }));
      tr.appendChild(n);
      tr.appendChild(td(e.detail || ''));
      tr.appendChild(td(e.opinion));
      tr.appendChild(td(e.itemId ? el('span', { cls: 'mono', text: e.itemId }) : ''));
      return tr;
    });
    d.appendChild(table([T.col.verdict, T.col.name, T.col.detail, T.col.opinion, T.col.item], rows));
    inv.appendChild(d);
  });

  // Leads
  var leads = document.getElementById('leads');
  if (!(st.leads || []).length) leads.appendChild(el('p', { cls: 'muted', text: T.noLeads }));
  else {
    var ul = el('ul', { cls: 'plain' });
    st.leads.forEach(function (l) {
      ul.appendChild(el('li', null, el('b', { text: l.title }), ' \\u2014 ', el('span', { cls: 'mono', text: l.source }), l.note ? el('div', { cls: 'muted', text: l.note }) : null));
    });
    leads.appendChild(ul);
  }

  // Log
  var logRows = (st.log || []).map(function (l) {
    var tr = el('tr');
    tr.appendChild(td(el('time', { cls: 'mono nowrap', datetime: l.at, text: when(l.at) })));
    tr.appendChild(td(l.itemId ? el('span', { cls: 'mono', text: l.itemId }) : ''));
    tr.appendChild(td(l.text));
    return tr;
  });
  if (!logRows.length) { var e2 = el('tr'); var c2 = td(T.logEmpty); c2.setAttribute('colspan', '3'); e2.appendChild(c2); logRows.push(e2); }
  document.getElementById('log').appendChild(table([T.col.at, T.col.item, T.col.entry], logRows));
})();
`;

/** ISO timestamp shown as "YYYY-MM-DD HH:MM UTC" (markdown has no client to localise it). */
export function isoDateTime(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

export function renderHtml(state, lang = resolveLanguage(state.language)) {
  const T = STRINGS[lang];
  const name = (state.project && state.project.name) || 'Harness';
  const when = state.lastRun || state.startedAt || '';
  const scopes = state.scopes.map((s) => label(T.scope, s)).join(' + ');
  const agentOn = fill(T.agentOn, { agent: escHtml(state.environment.agent), os: escHtml(state.environment.os) });
  return `<!doctype html>
<html lang="${lang === 'pt' ? 'pt-BR' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(fill(T.title, { name }))}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
<h1>${escHtml(fill(T.heading, { name }))}</h1>
<div class="meta"><span>${escHtml(T.mode)}: ${escHtml(label(T.modeName, state.mode))}</span><span>${escHtml(T.scopesLabel)}: ${escHtml(scopes)}</span><span>${escHtml(T.date)}: <time datetime="${escHtml(when)}" data-local>${escHtml(isoDateTime(when))}</time></span><span>${escHtml(T.agent)}: ${agentOn}</span></div>
<noscript><p>${escHtml(T.noscript)}</p></noscript>
</header>
<section aria-labelledby="h-scores"><h2 id="h-scores">${escHtml(T.hScores)}</h2><div class="cards" id="cards"></div></section>
<section aria-labelledby="h-defenses"><h2 id="h-defenses">${escHtml(T.hDefenses)}</h2><p class="muted defenses-note">${escHtml(T.defensesNote)}</p><div id="defenses"></div></section>
<section aria-labelledby="h-layers"><h2 id="h-layers">${escHtml(T.hLayers)}</h2><div class="cards" id="layers"></div></section>
<section aria-labelledby="h-rounds"><h2 id="h-rounds">${escHtml(T.hRounds)}</h2><div id="rounds"></div></section>
<section aria-labelledby="h-items"><h2 id="h-items">${escHtml(T.hItems)}</h2><div class="filters" id="item-filters"></div><div id="items"></div></section>
<section aria-labelledby="h-inv"><h2 id="h-inv">${escHtml(T.hInventory)}</h2><div id="inventory"></div></section>
<section aria-labelledby="h-leads"><h2 id="h-leads">${escHtml(T.hLeads)}</h2><div id="leads"></div></section>
<section aria-labelledby="h-log"><h2 id="h-log">${escHtml(T.hLog)}</h2><div id="log"></div></section>
</main>
<script type="application/json" id="board-data">${embedJson(boardData(state))}</script>
<script>
var T = ${jsLiteral(T)};
var LOCALE = ${jsLiteral(LOCALES[lang])};
${CLIENT_JS}</script>
</body>
</html>
`;
}

function cell(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
function num(n) { return n === null || n === undefined ? '-' : String(n); }
/** Deducted points as written: sums of quarters are exact in binary, so no rounding is needed. */
function pointsText(n) { return String(Number(n.toFixed(4))); }

export function renderMarkdown(state, lang = resolveLanguage(state.language)) {
  const T = STRINGS[lang];
  const C = T.col;
  const sc = (s) => label(T.scope, s);
  const name = (state.project && state.project.name) || 'Harness';
  const L = [];
  L.push(`# ${fill(T.heading, { name })}`, '');
  L.push(`${T.mode}: ${label(T.modeName, state.mode)} · ${T.scopesLabel}: ${state.scopes.map(sc).join(' + ')} · ${T.date}: ${isoDateTime(state.lastRun || state.startedAt || '')} · ${T.agent}: ${fill(T.agentOn, { agent: state.environment.agent, os: state.environment.os })}`, '');

  L.push(`## ${T.hScores}`, '');
  L.push(`| ${C.scope} | ${C.score} | ${C.grade} | ${C.baseline} | ${C.previous} | ${C.roundsCounted} |`, '|---|---|---|---|---|---|');
  for (const scope of state.scopes) {
    const s = (state.scores || {})[scope] || {};
    const score = s.current === null || s.current === undefined ? T.notScored : String(s.current);
    L.push(`| ${sc(scope)} | ${score} | ${s.grade ?? '-'} | ${num(s.baseline)} | ${num(s.previous)} | ${fill(T.countOf, { n: s.roundsCounted ?? 0, m: s.roundsTotal ?? ROUNDS_TOTAL })} |`);
  }
  L.push('');
  for (const scope of state.scopes) {
    L.push(`### ${fill(T.scopeByRound, { scope: label(T.scopeTitle, scope) })}`, '', `| ${C.round} | ${C.weight} | ${C.status} | ${C.score} | ${C.deducted} | ${C.items} |`, '|---|---|---|---|---|---|');
    for (const r of roundBreakdown(state, scope)) {
      L.push(`| ${r.round} ${T.rounds[r.round]} | ${r.weight} | ${label(T.roundStatus, r.status)} | ${r.counted ? floor1(r.score) : '-'} | ${r.counted ? pointsText(r.deductions) : '-'} | ${r.items} |`);
    }
    L.push('');
  }

  L.push(`## ${T.hDefenses}`, '', T.defensesNote, '');
  const defenses = state.defenses || [];
  if (!defenses.length) L.push(T.noDefenses);
  for (const d of defenses) L.push(`- **${cell(d.title)}** (${sc(d.scope)})${d.detail ? `: ${cell(d.detail)}` : ''}`);
  L.push('');

  L.push(`## ${T.hLayers}`, '');
  for (const scope of state.scopes) {
    const ls = state.layers.filter((l) => l.scope === scope);
    const total = ls.reduce((s, l) => s + (l.tokens || 0), 0);
    L.push(`### ${fill(T.tokensPerSessionMd, { scope: label(T.scopeTitle, scope), total })}`, '');
    if (!ls.length) { L.push(T.noLayers, ''); continue; }
    L.push(`| ${C.num} | ${C.kind} | ${C.name} | ${C.path} | ${C.tokens} |`, '|---|---|---|---|---|');
    ls.forEach((l, i) => L.push(`| ${i + 1} | ${cell(label(T.kind, l.kind))} | ${cell(l.name)} | ${cell(l.path || '')} | ${l.tokens ?? '-'} |`));
    L.push('');
  }

  L.push(`## ${T.hItemsByRound}`, '');
  if (!state.items.length) L.push(T.noItems, '');
  const F = T.field;
  for (let r = 1; r <= ROUNDS_TOTAL; r++) {
    const items = state.items.filter((i) => i.round === r);
    if (!items.length) continue;
    L.push(`### ${fill(T.roundHeading, { n: r, name: T.rounds[r] })}`, '');
    L.push(`| ${C.id} | ${C.scope} | ${C.severity} | ${C.status} | ${C.class} | ${C.origin} | ${C.title} |`, '|---|---|---|---|---|---|---|');
    for (const i of items) L.push(`| ${cell(i.id)} | ${sc(i.scope)} | ${label(T.severity, i.severity)} | ${label(T.status, i.status)} | ${label(T.class, i.class)} | ${label(T.origin, i.origin || 'active')} | ${cell(i.title)} |`);
    L.push('');
    for (const i of items) {
      L.push(`- **${i.id}** ${cell(i.finding)}`);
      if (i.evidence) L.push(`  - ${F.evidence}: ${cell(i.evidence)}`);
      if (i.file) L.push(`  - ${F.file}: ${cell(i.file)}`);
      L.push(`  - ${F.proposal}: ${cell(i.proposal)}`);
      L.push(`  - ${F.opinion}: ${cell(i.opinion)}`);
      if (i.decision) L.push(`  - ${F.decision}: ${cell(i.decision)}`);
      if (i.verified) L.push(`  - ${F.verified}: ${cell(i.verified)}`);
      if (i.notVerified) L.push(`  - ${F.notVerified}: ${cell(i.notVerified)}`);
    }
    L.push('');
  }

  L.push(`## ${T.hQueue}`, '');
  const queue = state.items.filter((i) => i.status === 'queued');
  if (!queue.length) L.push(T.nothingQueued);
  for (const i of queue) {
    const meta = fill(T.queueEntry, { scope: sc(i.scope), round: i.round, severity: label(T.severity, i.severity), class: label(T.class, i.class) });
    L.push(`- **${i.id}** (${meta}) ${cell(i.title)}`);
  }
  L.push('');

  L.push(`## ${T.hInventory}`, '');
  const groups = new Map();
  for (const e of state.inventory) {
    const k = `${sc(e.scope)} · ${e.category}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  if (!groups.size) L.push(T.inventoryEmpty, '');
  for (const k of [...groups.keys()].sort()) {
    L.push(`### ${k}`, '', `| ${C.verdict} | ${C.name} | ${C.path} | ${C.detail} | ${C.opinion} | ${C.item} |`, '|---|---|---|---|---|---|');
    for (const e of groups.get(k)) L.push(`| ${label(T.verdict, e.verdict)} | ${cell(e.name)} | ${cell(e.path || '')} | ${cell(e.detail || '')} | ${cell(e.opinion)} | ${cell(e.itemId || '')} |`);
    L.push('');
  }

  L.push(`## ${T.hLeads}`, '');
  const leads = state.leads || [];
  if (!leads.length) L.push(T.noLeads);
  for (const l of leads) L.push(`- **${cell(l.title)}**: ${cell(l.source)}${l.note ? ` (${cell(l.note)})` : ''}`);
  L.push('');

  L.push(`## ${T.hLog}`, '');
  if (!state.log.length) L.push(T.logEmpty);
  for (const l of state.log) L.push(`- ${isoDateTime(l.at)}${l.itemId ? ` [${l.itemId}]` : ''} ${cell(l.text)}`);
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

  state.scores = computeScores(state);
  const postErrors = validateState(state, schemaRes.value);
  if (postErrors.length) return { ok: false, errors: postErrors };

  const out = outDir || path.dirname(statePath);
  fs.mkdirSync(out, { recursive: true });
  const stateText = JSON.stringify(state, null, 2) + '\n';
  if (stateText !== text) fs.writeFileSync(statePath, stateText);
  const htmlPath = path.join(out, 'board.html');
  const mdPath = path.join(out, 'board.md');
  const lang = resolveLanguage(state.language, opts.lang);
  fs.writeFileSync(htmlPath, renderHtml(state, lang));
  fs.writeFileSync(mdPath, renderMarkdown(state, lang));
  return { ok: true, language: lang, scores: state.scores, files: { state: statePath, html: htmlPath, md: mdPath } };
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  const statePath = args._[0];
  if (!statePath) {
    warn('usage: render-board.mjs <state.json> [--out-dir <dir>] [--lang en|pt]');
    process.exit(2);
  }
  const lang = typeof args.lang === 'string' ? args.lang : undefined;
  if (lang !== undefined && !(lang in STRINGS)) warn('unsupported --lang; falling back to en');
  const res = renderFile(normalizeInputPath(statePath), args['out-dir'] ? normalizeInputPath(args['out-dir']) : undefined, { lang });
  if (!res.ok) {
    warn('state is invalid:');
    for (const e of res.errors) warn(`  ${e}`);
    printJson({ ok: false, errors: res.errors });
    process.exit(1);
  }
  printJson({ ok: true, language: res.language, scores: res.scores, files: { state: path.basename(res.files.state), html: 'board.html', md: 'board.md' } });
}
