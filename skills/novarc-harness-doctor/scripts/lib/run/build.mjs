// `run.mjs build`: the deterministic merge of everything in the run directory into state.json,
// followed by render-board.mjs. Same inputs, same bytes: nothing here reads the clock, and every
// collection is ordered by the run's harness order and the queue's unit order.
//
// What a probe wrote is pruned to the schema entry by entry, and an entry that still does not fit
// is dropped with a warning, so one odd value never costs the user the whole board. What a
// reviewer wrote was validated by `complete` and is taken as it is.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { RunError, UsageError, readJson, readJsonl, readText, writeJsonAtomic, writeTextAtomic, withLock, toJsonText } from './store.mjs';
import { scriptPath } from './paths.mjs';
import { loadStateSchema, skillVersion, validate, prune, sub, def, sanitizeList, isDateTime, SCHEMA_VERSION } from './schema.mjs';
import { homeMatchers, scrubDeep } from './scrub.mjs';
import { loadFindings, loadItems, loadStatus, resolveGroups, inputsFingerprint } from './model.mjs';
import { ROUNDS, roundApplies } from './units.mjs';
import { ELEMENT_RULES } from './findings.mjs';
import { AGENTS, CHANNELS } from './init.mjs';
import { logText } from './text.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readProbe(paths, harnessId, name) {
  try { const v = readJson(`${paths.probeDir(harnessId)}/${name}`); return isObject(v) ? v : null; } catch { return null; }
}

/** Reviewer annotations onto the snapshot's elements: verdicts, notes and item links only. */
function annotateElements(elements, harnessId, findings, itemIds, warnings) {
  for (const { unit, data } of findings) {
    const byCategory = isObject(data.elements) ? data.elements[harnessId] : null;
    if (!isObject(byCategory)) continue;
    for (const [category, list] of Object.entries(byCategory)) {
      const rule = ELEMENT_RULES[category];
      if (!rule || !Array.isArray(list)) continue;
      const base = elements[category] || [];
      for (const ann of list) {
        if (!isObject(ann)) continue;
        const hits = base.filter((e) => rule.key.every((k) => e[k] === ann[k]) && rule.match.every((k) => ann[k] === undefined || e[k] === ann[k]));
        if (!hits.length) {
          warnings.push({ source: `findings of ${unit.id}`, problem: `elements.${harnessId}.${category}: no entry "${rule.key.map((k) => ann[k]).join(' ')}" in the snapshot; annotation dropped` });
          continue;
        }
        for (const e of hits) {
          for (const f of rule.annotate) {
            if (ann[f] === undefined) continue;
            if (f === 'item' && !itemIds.has(ann[f])) continue;
            e[f] = ann[f];
          }
        }
      }
    }
  }
}

function buildHarness(h, ctx, root, findings, itemIds, prevScores, warnings) {
  const { paths, run } = ctx;
  const hSchema = sub(root, 'harnesses', '[]');
  const snap = readProbe(paths, h.id, 'snapshot.json');
  const source = `probes/${h.id}/snapshot.json`;
  const out = { id: h.id, kind: h.kind, name: h.name, path: h.path };
  if (h.provider) out.provider = h.provider;
  if (h.account) out.account = h.account;
  if (h.inherits) out.inherits = h.inherits;

  // `project` and `activity`: what find-projects.mjs knew at selection time, then the snapshot.
  const fromSnap = snap && isObject(snap.harness) ? prune(snap.harness, hSchema, root) : {};
  for (const k of h.kind === 'project' ? ['project', 'activity'] : ['activity']) {
    const merged = { ...((h.hints && h.hints[k]) || {}), ...(isObject(fromSnap[k]) ? fromSnap[k] : {}) };
    if (!Object.keys(merged).length) continue;
    if (validate(merged, hSchema.properties[k], root).length) warnings.push({ source, problem: `harness.${k} does not fit the schema; left out` });
    else out[k] = merged;
  }

  const elementsSchema = def(root, 'elements');
  if (snap && isObject(snap.elements)) {
    const elements = {};
    for (const category of Object.keys(elementsSchema.properties)) {
      if (!Array.isArray(snap.elements[category])) continue;
      elements[category] = sanitizeList(snap.elements[category], elementsSchema.properties[category].items, root, `${source} elements.${category}`, warnings);
    }
    annotateElements(elements, h.id, findings, itemIds, warnings);
    out.elements = elements;
  } else {
    annotateElements({}, h.id, findings, itemIds, warnings);
  }

  const impactSchema = def(root, 'impact');
  const rawImpact = readProbe(paths, h.id, 'impact.json');
  let impact = null;
  if (rawImpact) {
    const clean = prune(rawImpact, impactSchema, root);
    if (Array.isArray(clean.waste)) clean.waste = sanitizeList(clean.waste, impactSchema.properties.waste.items, root, `probes/${h.id}/impact.json waste`, warnings);
    delete clean.estimates; // estimates come from their own file, never from the measurement
    const errors = validate(clean, impactSchema, root);
    if (errors.length) warnings.push({ source: `probes/${h.id}/impact.json`, problem: `does not fit the schema (${errors[0]}); impact left out` });
    else impact = clean;
  }
  const rawEstimates = readProbe(paths, h.id, 'estimates.json');
  if (rawEstimates && Array.isArray(rawEstimates.estimates)) {
    const list = sanitizeList(rawEstimates.estimates, impactSchema.properties.estimates.items, root, `probes/${h.id}/estimates.json`, warnings);
    if (!impact) warnings.push({ source: `probes/${h.id}/estimates.json`, problem: 'estimates need the measured impact of the same harness; left out' });
    else if (list.length) impact.estimates = list;
  }
  if (impact) out.impact = impact;
  else {
    // Not measured on purpose (see probe.mjs impactSkips): say why, so the board does not read
    // as "nothing happened here".
    const summary = readProbe(paths, '', 'summary.json');
    const skip = summary && isObject(summary.harnesses) && isObject(summary.harnesses[h.id]) ? summary.harnesses[h.id].impact : null;
    if (isObject(skip) && (skip.skipped === 'shared-sessions' || skip.skipped === 'no-transcript-reader')) {
      out.impactSkipped = { reason: skip.skipped, ...(typeof skip.with === 'string' ? { with: skip.with } : {}) };
    }
  }

  // Scores belong to the renderer. Carry what it wrote last time so `previous` and an unchanged
  // `computedAt` survive a rebuild; on a first build seed `previous` from the earlier run.
  if (isObject(prevScores[h.id])) out.scores = prevScores[h.id];
  else if (run.previousScores && typeof run.previousScores[h.id] === 'number') out.scores = { previous: run.previousScores[h.id] };
  return { entry: out, snap, source };
}

function buildAccounts(ctx, root, warnings) {
  const { run, paths } = ctx;
  if (!Array.isArray(run.accounts) || !run.accounts.length) return null;
  const syncSchema = sub(root, 'accounts', 'list', '[]', 'sync');
  let diff = null;
  try { diff = readJson(`${paths.probeDir('accounts')}/diff.json`); } catch { diff = null; }
  // `accounts.mjs diff` lists the secondary accounts; accept a list or a map keyed by account id.
  const byId = new Map();
  const entryById = new Map();
  if (isObject(diff)) {
    const list = Array.isArray(diff.accounts) ? diff.accounts : (isObject(diff.accounts) ? Object.entries(diff.accounts).map(([id, v]) => ({ id, ...(isObject(v) ? v : {}) })) : []);
    for (const e of list) if (isObject(e) && typeof e.id === 'string') { byId.set(e.id, isObject(e.sync) ? e.sync : e); entryById.set(e.id, e); }
  }
  const out = { primary: run.primary ?? null };
  if (isObject(diff) && typeof diff.syncInstalled === 'boolean') out.syncInstalled = diff.syncInstalled;
  out.list = run.accounts.map((a) => {
    const entry = { id: a.id, provider: a.provider, label: a.label };
    if (a.identity) entry.identity = a.identity;
    entry.path = a.path;
    if (typeof a.isDefault === 'boolean') entry.isDefault = a.isDefault;
    if (a.host) entry.host = a.host;
    entry.harness = a.harness;
    if (Number.isInteger(a.elements) && a.elements >= 0) entry.elements = a.elements;
    if (typeof a.empty === 'boolean') entry.empty = a.empty;
    // What the comparison suggests for this account, worded for the board in the run language.
    const whole = entryById.get(a.id);
    if (whole && ['link', 'replicate', 'none'].includes(whole.suggested)) entry.suggested = whole.suggested;
    if (whole && typeof whole.suggestionText === 'string' && whole.suggestionText.trim()) entry.suggestionText = whole.suggestionText.trim();
    const raw = byId.get(a.id);
    if (raw) {
      const sync = prune(raw, syncSchema, root);
      if (Array.isArray(sync.elements)) sync.elements = sanitizeList(sync.elements, syncSchema.properties.elements.items, root, 'probes/accounts/diff.json elements', warnings);
      if (validate(sync, syncSchema, root).length) warnings.push({ source: 'probes/accounts/diff.json', problem: `sync of ${a.id} does not fit the schema; left out` });
      else entry.sync = sync;
    } else if (byId.size && run.primary === a.id) {
      entry.sync = { mode: 'primary', status: 'ok' };
    }
    return entry;
  });
  return out;
}

/** Assemble the state from the run directory. Pure apart from reading files. */
export function assembleState(ctx, root, groups) {
  const { paths, run } = ctx;
  const warnings = [];
  const findings = loadFindings(paths, run);
  const status = loadStatus(paths);
  const { items, duplicates } = loadItems(paths, run, findings, status);
  for (const id of duplicates) warnings.push({ source: 'findings', problem: `item id ${id} appears in two units; the first one is kept` });
  const itemIds = new Set(items.map((i) => i.id));
  const harnessIds = new Set(run.harnesses.map((h) => h.id));
  const order = new Map(run.harnesses.map((h, i) => [h.id, i]));
  const byHarnessOrder = (a, b) => (order.get(a.harness) ?? 1e9) - (order.get(b.harness) ?? 1e9);

  let prevScores = {};
  try {
    const old = readJson(paths.state);
    if (old && Array.isArray(old.harnesses)) for (const h of old.harnesses) if (isObject(h.scores)) prevScores[h.id] = h.scores;
  } catch { prevScores = {}; }

  // Harnesses, files and layers from the snapshots.
  const harnesses = [];
  const files = [];
  const layers = [];
  const fileIds = new Set();
  const fileSchema = sub(root, 'files', '[]');
  const layerSchema = sub(root, 'layers', '[]');
  for (const h of run.harnesses) {
    const { entry, snap, source } = buildHarness(h, ctx, root, findings, itemIds, prevScores, warnings);
    harnesses.push(entry);
    if (!snap) continue;
    const parent = h.inherits ? run.harnesses.find((x) => x.id === h.inherits) : null;
    for (const f of sanitizeList((snap.files || []).map((x) => (isObject(x) ? { ...x, harness: h.id } : x)), fileSchema, root, `${source} files`, warnings)) {
      if (fileIds.has(f.id)) { warnings.push({ source, problem: `file id ${f.id} is used twice; the second one is dropped` }); continue; }
      fileIds.add(f.id);
      if (f.inheritedFrom !== undefined && (!harnessIds.has(f.inheritedFrom) || f.inheritedFrom === h.id)) delete f.inheritedFrom;
      if (parent && f.inheritedFrom === undefined && typeof f.linkTo === 'string' && (f.linkTo === parent.path || f.linkTo.startsWith(`${parent.path}/`))) f.inheritedFrom = parent.id;
      files.push(f);
    }
    for (const l of sanitizeList((snap.layers || []).map((x) => (isObject(x) ? { ...x, harness: h.id } : x)), layerSchema, root, `${source} layers`, warnings)) layers.push(l);
  }

  // Linked files: when a file is a link to a file another entry already carries, keep the text
  // once. The linked entry points at its owner (`linkTo`, `inheritedFrom`) and the board shows
  // the owner's content there. Without this a linked account repeats its primary's whole harness.
  const ownerByPath = new Map();
  for (const f of files) if (typeof f.linkTo !== 'string' && !f.omitted && !ownerByPath.has(f.path)) ownerByPath.set(f.path, f);
  for (const f of files) {
    if (typeof f.linkTo !== 'string' || f.omitted) continue;
    const owner = ownerByPath.get(f.linkTo);
    if (!owner || owner === f) continue;
    f.content = '';
    f.omitted = 'linked';
    delete f.truncated;
    if (owner.harness !== f.harness) f.inheritedFrom = owner.harness; else delete f.inheritedFrom;
  }

  // Reviewers: file roles, layers (merged by harness + name), inventory, defenses, leads.
  const fileById = new Map(files.map((f) => [f.id, f]));
  const inventory = [];
  const inventoryIds = new Set();
  const defenses = [];
  const leads = [];
  const seenFlat = new Set();
  const roundStatus = new Map();
  for (const { unit, data } of findings) {
    const src = `findings of ${unit.id}`;
    for (const [fileId, role] of Object.entries(isObject(data.fileRoles) ? data.fileRoles : {})) {
      const f = fileById.get(fileId);
      if (f) f.role = role; else warnings.push({ source: src, problem: `fileRoles: no file ${fileId} in the snapshots; role dropped` });
    }
    for (const l of Array.isArray(data.layers) ? data.layers : []) {
      const existing = layers.find((x) => x.harness === l.harness && x.name === l.name);
      if (existing) Object.assign(existing, l); else layers.push({ ...l });
    }
    for (const raw of Array.isArray(data.inventory) ? data.inventory : []) {
      const e = { ...raw };
      if (inventoryIds.has(e.id)) {
        let n = 2;
        while (inventoryIds.has(`${raw.id}-${n}`)) n++;
        e.id = `${raw.id}-${n}`;
      }
      inventoryIds.add(e.id);
      if (e.item !== undefined && !itemIds.has(e.item)) delete e.item;
      inventory.push(e);
    }
    for (const [list, target] of [[data.defenses, defenses], [data.leads, leads]]) {
      for (const e of Array.isArray(list) ? list : []) {
        const key = JSON.stringify([target === defenses ? 'd' : 'l', e]);
        if (seenFlat.has(key)) continue;
        seenFlat.add(key);
        target.push({ ...e });
      }
    }
    for (const r of Array.isArray(data.rounds) ? data.rounds : []) roundStatus.set(`${r.harness}:${r.round}`, r);
  }
  for (const l of layers) if (l.file !== undefined && !fileById.has(l.file)) { delete l.file; warnings.push({ source: 'layers', problem: `layer "${l.name}" of ${l.harness} pointed at a file that is not in the snapshots; link dropped` }); }
  for (const e of inventory) if (e.file !== undefined && !fileById.has(e.file)) { delete e.file; warnings.push({ source: 'inventory', problem: `inventory entry ${e.id} pointed at a file that is not in the snapshots; link dropped` }); }
  layers.sort(byHarnessOrder);
  inventory.sort(byHarnessOrder);
  defenses.sort(byHarnessOrder);

  // Rounds: pending unless a reviewer said otherwise; round 3 does not apply to a user harness.
  const rounds = [];
  for (const h of run.harnesses) {
    for (const round of ROUNDS) {
      const said = roundStatus.get(`${h.id}:${round}`);
      const entry = { harness: h.id, round, status: roundApplies(h, round) ? 'pending' : 'not-applicable' };
      if (said && roundApplies(h, round)) { entry.status = said.status; if (typeof said.note === 'string' && said.note) entry.note = said.note; }
      rounds.push(entry);
    }
  }

  // Items: link each change to its file in the snapshot, and each item to its group.
  const fileByPath = new Map(files.map((f) => [`${f.harness}\n${f.path}`, f.id]));
  const groupOf = new Map();
  for (const g of groups) for (const id of g.items) if (!groupOf.has(id)) groupOf.set(id, g.id);
  for (const item of items) {
    if (groupOf.has(item.id)) item.group = groupOf.get(item.id);
    if (!Array.isArray(item.changes)) continue;
    item.changes = item.changes.map((c) => {
      const out = { ...c };
      if (out.file !== undefined && !fileById.has(out.file)) delete out.file;
      if (out.file === undefined) {
        const id = fileByPath.get(`${item.harness}\n${out.path}`);
        if (id) out.file = id;
      }
      return out;
    });
  }

  const decisionSchema = def(root, 'decision');
  const decisions = status.decisions
    .filter((d) => d.result === 'applied')
    .map((d, i) => ({ d, i }))
    .sort((a, b) => String(a.d.at).localeCompare(String(b.d.at)) || a.i - b.i)
    .map(({ d }) => {
      // Whatever the schema's decision carries (older copies have no `runId`) and nothing else.
      const out = prune({ id: d.id, at: d.at, runId: d.runId, target: d.target, action: d.action, note: d.note, exclude: d.exclude, via: d.via }, decisionSchema, root);
      for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === '' || (Array.isArray(out[k]) && !out[k].length)) delete out[k];
      if (out.via !== 'board' && out.via !== 'chat') out.via = 'board';
      return out;
    });

  const events = readJsonl(paths.log).filter((l) => l.value && isDateTime(l.value.at)).map((l, i) => ({ e: l.value, i }))
    .sort((a, b) => a.e.at.localeCompare(b.e.at) || a.i - b.i).map((x) => x.e);
  const log = [];
  for (const e of events) {
    const text = logText(e, run.language);
    if (!text) continue;
    const entry = { at: e.at };
    if (typeof e.harness === 'string' && harnessIds.has(e.harness)) entry.harness = e.harness;
    if (typeof e.item === 'string') entry.item = e.item;
    entry.text = text;
    log.push(entry);
  }

  const env = run.environment || {};
  const state = {
    schemaVersion: SCHEMA_VERSION,
    skillVersion: skillVersion(),
    language: run.language === 'pt' ? 'pt' : 'en',
    mode: run.mode,
    run: {
      id: run.runId,
      ...(run.title ? { title: run.title } : {}),
      startedAt: run.createdAt,
      ...(events.length ? { lastRun: events.reduce((m, e) => (e.at > m ? e.at : m), events[0].at) } : {}),
      windowDays: run.windowDays,
    },
    environment: { agent: AGENTS.includes(env.agent) ? env.agent : 'other', os: env.os || 'linux', channel: CHANNELS.includes(env.channel) ? env.channel : 'file' },
  };
  const accounts = buildAccounts(ctx, root, warnings);
  if (accounts) state.accounts = accounts;
  Object.assign(state, { harnesses, rounds, layers, files, inventory, items, groups, defenses, leads, decisions, log });

  // Last line of defence: no absolute home path leaves this machine through the board.
  const hits = [];
  const clean = scrubDeep(state, homeMatchers(), hits);
  if (hits.length) warnings.push({ source: 'state', problem: `absolute home path replaced by ~ in ${hits.length} place(s), first at ${hits[0]}` });
  return { state: clean, warnings };
}

function persistEnvironment(ctx, args) {
  const patch = {};
  if (args.channel !== undefined) {
    if (!CHANNELS.includes(args.channel)) throw new UsageError(`--channel must be one of ${CHANNELS.join(', ')}`);
    patch.channel = args.channel;
  }
  if (args.agent !== undefined) {
    if (!AGENTS.includes(args.agent)) throw new UsageError(`--agent must be one of ${AGENTS.join(', ')}`);
    patch.agent = args.agent;
  }
  const env = ctx.run.environment || {};
  if (!Object.keys(patch).some((k) => env[k] !== patch[k])) return;
  withLock(ctx.paths.mutex, () => {
    const run = readJson(ctx.paths.run);
    run.environment = { ...(run.environment || {}), ...patch };
    writeJsonAtomic(ctx.paths.run, run);
    ctx.run = run;
  });
}

function render(ctx, channel, files) {
  const script = scriptPath('render-board.mjs');
  if (!fs.existsSync(script)) return { ok: false, error: 'render-board.mjs not found' };
  const r = spawnSync(process.execPath, [script, ctx.paths.state, '--channel', channel, '--files', files], {
    encoding: 'utf8', timeout: 180000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
  let out = null;
  try { out = JSON.parse(r.stdout || ''); } catch { out = null; }
  if (r.error || r.status !== 0) {
    const errors = out && Array.isArray(out.errors) ? out.errors.slice(0, 30) : undefined;
    return { ok: false, error: r.error ? `could not run render-board.mjs (${r.error.code || 'error'})` : `render-board.mjs exited with code ${r.status}`, ...(errors ? { errors } : {}), stderr: String(r.stderr || '').trim().slice(-2000) };
  }
  if (!isObject(out)) return { ok: false, error: 'render-board.mjs printed no JSON' };
  return { ok: true, output: out };
}

/**
 * `build [--channel artifact|server|file] [--files all|changed] [--agent <a>] [--no-render]`.
 * `--files` defaults to `changed` for the artifact channel (a page small enough to publish) and
 * to `all` otherwise.
 */
export function build(ctx, args) {
  persistEnvironment(ctx, args);
  const loaded = loadStateSchema();
  if (!loaded) throw new RunError('templates/state.schema.json (schemaVersion 2) not found: the skill folder is incomplete');
  const root = loaded.schema;
  const { paths, run } = ctx;

  // Group ids are assigned once and kept: the only write of the merge, done under the mutex.
  const groups = withLock(paths.mutex, () => {
    const findings = loadFindings(paths, run);
    const { items } = loadItems(paths, run, findings);
    return resolveGroups(paths, run, findings, new Set(items.map((i) => i.id)), { assign: true });
  });
  const { state, warnings } = assembleState(ctx, root, groups);
  const errors = validate(state, root);
  if (errors.length) throw new RunError('the merged state does not match the schema; state.json was not written', { errors: errors.slice(0, 50), mergeWarnings: warnings });

  const text = toJsonText(state);
  if (readText(paths.state) !== text) writeTextAtomic(paths.state, text);
  writeJsonAtomic(paths.buildStamp, { version: 1, inputs: inputsFingerprint(paths, ctx.run) });

  const summary = {
    runId: paths.runId,
    state: paths.state,
    schema: loaded.file,
    harnesses: state.harnesses.length,
    files: state.files.length,
    items: state.items.length,
    groups: state.groups.length,
    decisions: state.decisions.length,
    mergeWarnings: warnings,
  };
  if (args['no-render'] === true) return { ...summary, rendered: false, warnings: [] };
  if (args.files !== undefined && !['all', 'changed'].includes(args.files)) throw new UsageError('--files must be all or changed');
  const files = args.files !== undefined ? args.files : (state.environment.channel === 'artifact' ? 'changed' : 'all');
  const r = render(ctx, state.environment.channel, files);
  if (!r.ok) throw new RunError(`state.json was written, but the board was not rendered: ${r.error}`, { ...summary, rendered: false, render: r });
  const out = r.output;
  return {
    ...summary,
    rendered: true,
    board: paths.board,
    ...(out.language !== undefined ? { language: out.language } : {}),
    ...(out.scores !== undefined ? { scores: out.scores } : {}),
    ...(out.bytes !== undefined ? { bytes: out.bytes } : {}),
    warnings: Array.isArray(out.warnings) ? out.warnings : [],
  };
}
