#!/usr/bin/env node
// impact-estimates.mjs --impact <impact.json> [--clis <clis.json>] [--snapshot <snapshot.json>] [--discover <discover.json>]
//                      [--lang pt|en] [--catalog <estimates.json>]
//
// Savings that are NOT measured, kept apart from the measured waste of session-impact.mjs. Each
// estimate is a number that script measured, multiplied by a factor from
// references/catalog/estimates.json, and it carries one sentence saying where the factor comes
// from. Nothing here is ever added into a measured total.
//
//   - Command output a filter would cut: only when the CLI probe says `rtk` is not installed.
//   - Exploration a knowledge graph could answer: only for a project harness that holds code and
//     has no graphify-out/ folder.
//   - Descriptions of skills never invoked: description size from the snapshot, per session.
//   - MCP servers never called are listed by name under `unmeasured`, without a token number.
//
// "Never used" is taken only from what session-impact.mjs measured. A skill or server it lists as
// unknown (`unusedContext.skillsUnknown` / `mcpServersUnknown`), or whose count in
// `skillInvocations` / `mcpCalls` is null, was not measured: it gets no estimate and no "never
// called" row, and is named under `unknownUsage` instead. A name with a count above 0 is not
// unused, whatever list it sits in.
//
// `--clis` is the output of probe-clis.mjs, `--snapshot` of snapshot-harness.mjs (code project or
// not, skill description sizes, and a `signals` list when it has one) and `--discover` of
// discover.mjs (its project part says whether graphify-out/ exists). What the snapshot does not
// say is taken from the discover file. An estimate whose inputs are missing is not made:
// `skipped` says which and why. Prints names that pass the safe-name check and numbers only.
//
// Every estimate carries a stable `id` (`rtk-output`, `graph-exploration`,
// `unused-skill-descriptions`). Its `label` and `source`, and those of the `unmeasured` rows, are
// what the board shows: `--lang pt` prints them in Portuguese, the default is English.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, isMain, printJson, warn, normalizeInputPath, readJsonSafe, approxTokens } from './lib/common.mjs';
import { safeName } from './lib/transcripts.mjs';

export const DEFAULT_CATALOG = fileURLToPath(new URL('../references/catalog/estimates.json', import.meta.url));
const CATALOG_DISPLAY = 'references/catalog/estimates.json';
const METHOD = 'Estimates are not measurements. Each one multiplies a number measured by session-impact.mjs by a factor from the estimates catalog, and its source sentence says whether the factor is a project\'s own claim, documented behaviour or an assumption. They are reported apart from measured waste and are never added into a measured total.';

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const hasQuote = (q) => (typeof q === 'string' && q.length > 0) || (Array.isArray(q) && q.length > 0 && q.every((x) => typeof x === 'string' && x));
const count = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});

/**
 * Catalog entries by id. An entry counts only when it says where its number comes from: a
 * source, the date it was checked, the sentence to print and, unless it is an assumption or a
 * plain listing, the text that was read.
 */
export function loadFactors(file) {
  const r = readJsonSafe(file);
  if (!r.ok) return { ok: false, reason: r.error === 'missing' ? 'estimates catalog not found' : 'estimates catalog could not be read', byId: {} };
  const byId = {};
  for (const e of Array.isArray(obj(r.value).estimates) ? r.value.estimates : []) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string') continue;
    if (typeof e.source !== 'string' || !e.source || !isDate(e.verifiedAt) || typeof e.basis !== 'string' || !e.basis || typeof e.label !== 'string' || !e.label) continue;
    if (e.kind === 'assumption') { if (!/^assumption:/i.test(e.source)) continue; } else if (e.kind !== 'unmeasured' && !hasQuote(e.quote)) continue;
    byId[e.id] = e;
  }
  return { ok: true, byId, verifiedAt: isDate(obj(r.value).verifiedAt) ? r.value.verifiedAt : null };
}

const isFactor = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= 1;

export const LANGS = ['en', 'pt'];
/** `label` and `source` of a catalog entry in the asked language; English when it has no translation. */
function texts(entry, lang) {
  const t = lang !== 'en' && entry[lang] && typeof entry[lang] === 'object' ? entry[lang] : {};
  const pick = (k) => (typeof t[k] === 'string' && t[k] ? t[k] : entry[k]);
  return { label: pick('label'), source: pick('basis') };
}

/** What a snapshot (or the project part of discover.mjs) says about the project: `null` = it does not say. */
export function snapshotFacts(snapshot) {
  const s = obj(snapshot);
  const h = obj(s.harness);
  const projects = [obj(h.project), obj(s.project)];
  const firstBool = (xs) => { for (const x of xs) if (typeof x === 'boolean') return x; return null; };
  const isCode = firstBool([...projects.map((p) => p.isCode), h.isCode, s.isCode]);
  let hasGraph = firstBool([...projects.map((p) => obj(p.graphify).exists), obj(h.graphify).exists, obj(s.graphify).exists]);
  if (hasGraph === null) {
    const signals = [s.signals, h.signals, ...projects.map((p) => p.signals)].find(Array.isArray);
    const nameOf = (x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? x.name || x.path || x.value || '' : '');
    const isGraph = (x) => /^(?:\.\/)?graphify-out\/?$/.test(String(nameOf(x)).trim().replace(/\\/g, '/'));
    // A signals list names what was found, so a list without the folder means it is not there.
    if (signals) hasGraph = signals.some(isGraph);
    // A file list is not complete, so it can only confirm that the folder exists.
    else if (Array.isArray(s.files) && s.files.some((f) => /^(?:\.\/)?graphify-out\//.test(String(obj(f).path || '').replace(/\\/g, '/')))) hasGraph = true;
  }
  const kind = typeof h.kind === 'string' ? h.kind : typeof s.kind === 'string' ? s.kind : null;
  const skills = Array.isArray(obj(s.elements).skills) ? s.elements.skills : null;
  return { kind, isCode, hasGraph, skills };
}

/**
 * Split the names a measurement lists as never used into the ones it really measured as unused
 * and the ones whose use is unknown. `counts` is the measurement's `{ name: count }` map when it
 * has one: null there means "not measured", a number above 0 means the name was used.
 */
export function settledUnused(list, unknownList, counts) {
  const names = (x) => (Array.isArray(x) ? x : []).filter((n) => typeof n === 'string');
  const map = obj(counts);
  const unknown = new Set(names(unknownList));
  const never = [];
  for (const n of names(list)) {
    if (unknown.has(n)) continue;
    const c = Object.hasOwn(map, n) ? map[n] : 0; // no map entry: the list is all the measurement says
    if (c === null) unknown.add(n);
    else if (!count(c)) never.push(n);
  }
  // A null count is unknown even when the name sits in neither list.
  for (const [n, c] of Object.entries(map)) if (c === null) unknown.add(n);
  return { never, unknown: [...unknown].sort() };
}

/** The sources whose tool calls the measurement could not read in full (`coverage.<source>.toolCalls` is `unknown`). */
function blindSources(impact) {
  const cov = obj(obj(impact).coverage);
  return Object.keys(cov).filter((s) => obj(cov[s]).toolCalls === 'unknown').sort();
}

/** Facts from the snapshot, completed by what only the discover file says. `null` when neither was given. */
function projectFacts(snapshot, discover) {
  if (!snapshot && !discover) return null;
  const a = snapshotFacts(snapshot);
  const b = snapshotFacts(discover);
  const facts = {};
  for (const k of Object.keys(a)) facts[k] = a[k] !== null ? a[k] : b[k];
  return facts;
}

export function estimate({ impact, clis = null, snapshot = null, discover = null, factors, lang = 'en' }) {
  const imp = obj(impact);
  const estimates = [];
  const unmeasured = [];
  const skipped = [];
  const skip = (id, reason) => skipped.push({ estimate: id, reason });
  const weightedView = typeof imp.weightedTotal === 'number';
  const facts = projectFacts(snapshot, discover);
  const blind = blindSources(imp);

  // 1. Unfiltered command output.
  {
    const id = 'rtk-output';
    const f = factors.byId[id];
    const base = count(obj(imp.toolOutput).shellResultTokensApprox);
    const tools = clis && Array.isArray(obj(clis).tools) ? clis.tools : null;
    const probe = tools && f ? tools.find((t) => t && (t.id === f.tool || t.bin === f.tool)) : null;
    if (!f || !isFactor(f.factor) || typeof f.tool !== 'string') skip(id, 'no confirmed factor in the catalog');
    else if (!tools) skip(id, 'no CLI probe given, so it is not known whether the filter is installed');
    else if (!probe || typeof probe.installed !== 'boolean') skip(id, 'the CLI probe has no answer for the filter');
    else if (probe.installed) skip(id, 'the filter is installed');
    else if (!base && blind.length) skip(id, `shell output could not be measured: the tool calls of ${blind.join(' and ')} were not fully read`);
    else if (!base) skip(id, 'no shell output was measured in the window');
    else {
      const tokens = Math.round(base * f.factor);
      const t = texts(f, lang);
      estimates.push({ id, label: t.label, tool: f.tool, tokens, ...(weightedView && f.weighting === 'input' ? { weighted: tokens } : {}), source: t.source });
    }
  }

  // 2. Exploration a knowledge graph could answer.
  {
    const id = 'graph-exploration';
    const f = factors.byId[id];
    const row = (Array.isArray(imp.waste) ? imp.waste : []).find((w) => w && w.kind === 'exploration');
    const base = count(obj(row).tokens);
    if (!f || !isFactor(f.factor)) skip(id, 'no confirmed factor in the catalog');
    else if (imp.scope !== 'project' || (facts && facts.kind !== null && facts.kind !== 'project')) skip(id, 'not a project harness');
    else if (!facts) skip(id, 'no snapshot or discover file given, so it is not known whether the project has a knowledge graph');
    else if (facts.isCode !== true) skip(id, facts.isCode === false ? 'the project holds no code' : 'neither file says whether the project holds code');
    else if (facts.hasGraph === null) skip(id, 'neither file says whether graphify-out/ exists (the discover file does)');
    else if (facts.hasGraph) skip(id, 'the project already has graphify-out/');
    else if (!base) skip(id, 'no exploration before an edit was measured in the window');
    else {
      const w = obj(row).weighted;
      const t = texts(f, lang);
      estimates.push({
        id, label: t.label, ...(typeof f.tool === 'string' ? { tool: f.tool } : {}), tokens: Math.round(base * f.factor),
        ...(weightedView && typeof w === 'number' ? { weighted: Math.round(w * f.factor) } : {}), source: t.source,
      });
    }
  }

  // 3. Descriptions of skills never invoked, and MCP servers never called.
  // Only what the measurement established: a name it could not measure is unknown, never unused.
  const unused = obj(imp.unusedContext);
  const skillUse = settledUnused(unused.skillsNeverInvoked, unused.skillsUnknown, imp.skillInvocations);
  const mcpUse = settledUnused(unused.mcpServersNeverCalled, unused.mcpServersUnknown, imp.mcpCalls);
  const unknownUsage = { skills: skillUse.unknown.map((n) => safeName(n)), mcpServers: mcpUse.unknown.map((n) => safeName(n)) };
  const never = skillUse.never;
  const sessions = count(imp.sessions);
  const detail = { sessions, skills: [], skillsWithoutSize: [] };
  {
    const id = 'unused-skill-descriptions';
    const f = factors.byId[id];
    const cap = f && count(f.maxDescriptionChars) ? f.maxDescriptionChars : Infinity;
    if (!f) skip(id, 'no confirmed factor in the catalog');
    else if (!never.length && skillUse.unknown.length) skip(id, `whether ${skillUse.unknown.length} configured skill(s) were invoked could not be measured, and no other skill was measured as never invoked`);
    else if (!never.length) skip(id, 'every configured skill was invoked in the window, or none is configured');
    else if (!facts || !facts.skills) skip(id, 'no snapshot with a skill inventory given, so description sizes are unknown');
    else if (!sessions) skip(id, 'no session in the window');
    else {
      // The same name can exist at two levels: prefer the entry of the harness's own level.
      const sizes = new Map();
      for (const sk of facts.skills) {
        if (!sk || typeof sk.name !== 'string' || !count(sk.descriptionChars)) continue;
        if (!sizes.has(sk.name) || sk.level === imp.scope) sizes.set(sk.name, sk.descriptionChars);
      }
      for (const name of never) {
        const shown = safeName(name);
        if (!sizes.has(name)) { detail.skillsWithoutSize.push(shown); continue; }
        const chars = sizes.get(name);
        const counted = Math.min(chars, cap);
        const perSession = approxTokens(counted);
        detail.skills.push({ name: shown, descriptionChars: chars, countedChars: counted, tokensPerSession: perSession, tokens: perSession * sessions });
      }
      detail.skills.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
      const tokens = detail.skills.reduce((a, s) => a + s.tokens, 0);
      if (tokens) estimates.push({ id, label: texts(f, lang).label, tokens, source: texts(f, lang).source });
      else skip(id, 'no skill that was never invoked has a description size in the snapshot');
    }
  }
  {
    const id = 'unused-mcp-servers';
    const f = factors.byId[id];
    if (f) for (const n of mcpUse.never) unmeasured.push({ id, label: texts(f, lang).label, tool: safeName(n), source: texts(f, lang).source });
    if (f && !mcpUse.never.length && mcpUse.unknown.length) skip(id, `whether ${mcpUse.unknown.length} configured MCP server(s) were called could not be measured`);
  }

  return { estimates, unmeasured, unknownUsage, detail, skipped };
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  if (typeof args.impact !== 'string') { warn('--impact <impact.json> is required'); process.exit(2); }
  // `pt-BR` and the like are read as `pt`.
  const lang = args.lang === undefined ? 'en' : typeof args.lang === 'string' ? args.lang.trim().toLowerCase().split(/[-_]/)[0] : '';
  if (!LANGS.includes(lang)) { warn('--lang must be pt or en'); process.exit(2); }
  const read = (flag) => {
    if (typeof args[flag] !== 'string') return null;
    const r = readJsonSafe(normalizeInputPath(args[flag]));
    if (!r.ok || !r.value || typeof r.value !== 'object') { warn(`--${flag}: ${r.ok ? 'not a JSON object' : r.error}`); process.exit(2); }
    return r.value;
  };
  try {
    const impact = read('impact');
    const clis = read('clis');
    const snapshot = read('snapshot');
    const discover = read('discover');
    const catalogPath = typeof args.catalog === 'string' ? normalizeInputPath(args.catalog) : DEFAULT_CATALOG;
    const factors = loadFactors(catalogPath);
    const res = estimate({ impact, clis, snapshot, discover, factors, lang });
    if (!factors.ok) res.skipped = [{ estimate: '*', reason: factors.reason }];
    printJson({
      generatedAt: new Date().toISOString(),
      language: lang,
      ...res,
      catalog: { source: typeof args.catalog === 'string' ? path.basename(catalogPath) : CATALOG_DISPLAY, verifiedAt: factors.verifiedAt || null },
      method: METHOD,
    });
  } catch (e) {
    warn(`failed: ${e && e.code ? e.code : 'error'}`);
    process.exit(1);
  }
}
