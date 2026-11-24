// Validation of a findings file (references/contracts.md, "Findings file"): what a reviewer hands
// to `run.mjs complete`. The file is rejected as a whole, with JSON pointers, so that nothing a
// reviewer wrote reaches the state half-checked. Messages never quote a value from the file.
//
// A findings file never holds a credential. Text quoted from a harness file is copied from the
// snapshot, which is already masked; a file that carries a credential anywhere is rejected with
// the JSON pointers of the offending strings and nothing else.
import { validate, sub, def, isDateTime } from './schema.mjs';
import { homeMatchers, findHomePaths, findLongStrings } from './scrub.mjs';
import { findCredentials, credentialErrors } from './secrets.mjs';
import { roundApplies, ACCOUNTS_ID_BLOCK, ROUNDS } from './units.mjs';
import { nowMs } from './store.mjs';

export const MAX_STRING_BYTES = 200 * 1024;
export const REVIEWER_STATUSES = ['open', 'ok', 'not-applicable'];
const TOP_KEYS = ['unit', 'session', 'completedAt', 'rounds', 'items', 'inventory', 'defenses', 'leads', 'layers', 'groups', 'elements', 'fileRoles'];
const LISTS = ['rounds', 'items', 'inventory', 'defenses', 'leads', 'layers', 'groups'];
/** Item fields only the run writes; a reviewer's value is dropped with a warning. */
const RUN_ONLY_ITEM_FIELDS = ['decision', 'question', 'verified', 'notVerified', 'backup', 'updatedAt', 'group', 'rev', 'history'];
/** Used when the state schema cannot be loaded. */
const ITEM_REQUIRED = ['id', 'harness', 'round', 'severity', 'class', 'title', 'finding', 'proposal', 'opinion'];

/**
 * Elements a reviewer may annotate. `key`: the fields that identify an entry of the snapshot;
 * `match`: optional fields that narrow the match when several entries share the key;
 * `annotate`: the only fields copied onto the snapshot entry. The base inventory is never
 * taken from a reviewer.
 */
export const ELEMENT_RULES = {
  permissions: { key: ['rule'], match: ['layer', 'kind'], annotate: ['note', 'item'] },
  hooks: { key: ['id'], match: [], annotate: ['note', 'item'] },
  skills: { key: ['name'], match: ['level', 'plugin'], annotate: ['verdict', 'reason', 'mergeInto', 'item'] },
  agents: { key: ['name'], match: ['level'], annotate: ['item'] },
  plugins: { key: ['name'], match: ['marketplace'], annotate: ['note', 'item'] },
  mcp: { key: ['name'], match: ['level'], annotate: ['cli', 'note', 'item'] },
  clis: { key: ['name'], match: [], annotate: ['note', 'item'] },
  docs: { key: ['path'], match: [], annotate: ['status', 'reader', 'language', 'note', 'item'] },
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Check `data` as the findings of `unit`. Returns `{ errors, warnings, normalized }`; `normalized`
 * is what gets stored (defaults applied, run-only fields removed) and is null when there are errors.
 */
export function validateFindings(data, { unit, run, session, schemaRoot, now = new Date(nowMs()) }) {
  const errors = [];
  const warnings = [];
  if (!isObject(data)) return { errors: ['/: the findings file must be a JSON object'], warnings, normalized: null };
  if (unit.kind === 'apply') return { errors: ['/: an apply unit takes no findings file'], warnings, normalized: null };

  // First, and alone: the checks below name property names in their messages, and no message
  // may carry a secret.
  const credentials = findCredentials(data);
  if (credentials.length) return { errors: credentialErrors(credentials), warnings, normalized: null };

  for (const at of findLongStrings(data, MAX_STRING_BYTES)) errors.push(`${at}: string longer than 200 KB`);
  for (const at of findHomePaths(data, homeMatchers())) errors.push(`${at}: absolute home path (write ~ for home and ./ for the project root)`);
  for (const k of Object.keys(data)) if (!TOP_KEYS.includes(k)) errors.push(`/: unknown property "${k}"`);
  if (data.unit !== undefined && data.unit !== unit.id) errors.push('/unit: does not match --unit');
  if (data.session !== undefined && typeof data.session !== 'string') errors.push('/session: expected string');
  if (data.completedAt !== undefined && !isDateTime(data.completedAt)) errors.push('/completedAt: not an RFC 3339 date-time');
  for (const k of LISTS) if (data[k] !== undefined && !Array.isArray(data[k])) errors.push(`/${k}: expected array`);
  for (const k of ['elements', 'fileRoles']) if (data[k] !== undefined && !isObject(data[k])) errors.push(`/${k}: expected object`);
  if (errors.length) return { errors, warnings, normalized: null };

  const harnesses = new Map(run.harnesses.filter((h) => unit.harnesses.includes(h.id)).map((h) => [h.id, h]));
  const ownsHarness = (id, at) => {
    if (typeof id !== 'string' || !harnesses.has(id)) { errors.push(`${at}/harness: not a harness of unit ${unit.id}`); return false; }
    return true;
  };
  const schemaOf = (...steps) => (schemaRoot ? sub(schemaRoot, ...steps) : null);
  const checkShape = (value, schema, at) => { if (schema) validate(value, schema, schemaRoot, at, errors); };

  // Rounds: only the rounds this unit owns, only for its harnesses.
  const rounds = [];
  const roundSeen = new Set();
  (data.rounds || []).forEach((r, i) => {
    const at = `/rounds/${i}`;
    if (!isObject(r)) { errors.push(`${at}: expected object`); return; }
    checkShape(r, schemaOf('rounds', '[]'), at);
    if (!ownsHarness(r.harness, at)) return;
    if (!unit.rounds.includes(r.round)) { errors.push(`${at}/round: unit ${unit.id} does not own this round`); return; }
    if (!roundApplies(harnesses.get(r.harness), r.round) && r.status !== 'not-applicable') errors.push(`${at}/status: this round does not apply to a user harness (use not-applicable or leave it out)`);
    const key = `${r.harness}:${r.round}`;
    if (roundSeen.has(key)) errors.push(`${at}: duplicate entry for this harness and round`);
    roundSeen.add(key);
    rounds.push(r);
  });

  // Items.
  const items = [];
  const itemIds = new Set();
  const itemSchema = schemaOf('items', '[]');
  (data.items || []).forEach((raw, i) => {
    const at = `/items/${i}`;
    if (!isObject(raw)) { errors.push(`${at}: expected object`); return; }
    const item = { ...raw };
    for (const f of RUN_ONLY_ITEM_FIELDS) if (f in item) { delete item[f]; warnings.push(`${at}/${f}: set by the run, ignored`); }
    if (item.status === undefined) item.status = 'open';
    if (Array.isArray(item.changes)) {
      item.changes = item.changes.map((c, j) => {
        if (!isObject(c)) return c;
        if (typeof c.path !== 'string' || !c.path) errors.push(`${at}/changes/${j}/path: every change needs the display path of its file`);
        if (!('applied' in c)) return c;
        const { applied: _applied, ...rest } = c;
        warnings.push(`${at}/changes/${j}/applied: set by the run, ignored`);
        return rest;
      });
    }
    if (itemSchema) checkShape(item, itemSchema, at);
    else for (const f of ITEM_REQUIRED) if (item[f] === undefined) errors.push(`${at}: missing required "${f}"`);
    // `declined` is the user's word. It comes back from a reviewer only as an earlier decision,
    // with `previous` naming the item the user declined (`complete` checks it against the record).
    if (!REVIEWER_STATUSES.includes(item.status) && !(item.status === 'declined' && isObject(item.previous))) {
      errors.push(`${at}/status: a reviewer may only set ${REVIEWER_STATUSES.join(', ')} (and declined, with \`previous\`, for a finding the user declined in an earlier review)`);
    }
    if (ownsHarness(item.harness, at) && typeof item.id === 'string') {
      const h = harnesses.get(item.harness);
      const m = /^([A-Z][A-Z0-9]*)-([0-9])([0-9]{2})$/.exec(item.id);
      if (!m || m[1] !== h.key) errors.push(`${at}/id: must be ${h.key}-<round><nn> for this harness`);
      else if (m[3] === '00') errors.push(`${at}/id: the counter starts at 01`);
      else if (unit.kind === 'accounts') {
        if (Number(m[2]) !== ACCOUNTS_ID_BLOCK) errors.push(`${at}/id: the accounts unit owns ${h.key}-${ACCOUNTS_ID_BLOCK}nn`);
      } else if (Number(m[2]) !== item.round) errors.push(`${at}/id: the digit after the dash must be the item's round`);
      else if (!unit.rounds.includes(item.round)) errors.push(`${at}/round: unit ${unit.id} does not own this round`);
      else if (!roundApplies(h, item.round)) errors.push(`${at}/round: this round does not apply to a user harness`);
    }
    if (typeof item.id === 'string') {
      if (itemIds.has(item.id)) errors.push(`${at}/id: duplicate id in this file`);
      itemIds.add(item.id);
    }
    items.push(item);
  });
  const linksItem = (value, at) => { if (value !== undefined && !itemIds.has(value)) errors.push(`${at}: no item with this id in this file`); };

  // Flat collections keyed by harness.
  const inventoryIds = new Set();
  const collect = (name, { harnessRequired }) => (data[name] || []).map((e, i) => {
    const at = `/${name}/${i}`;
    if (!isObject(e)) { errors.push(`${at}: expected object`); return e; }
    checkShape(e, schemaOf(name, '[]'), at);
    if (harnessRequired || e.harness !== undefined) ownsHarness(e.harness, at);
    if (name === 'inventory') {
      linksItem(e.item, `${at}/item`);
      if (typeof e.id === 'string') { if (inventoryIds.has(e.id)) errors.push(`${at}/id: duplicate id in this file`); inventoryIds.add(e.id); }
    }
    return e;
  });
  const inventory = collect('inventory', { harnessRequired: true });
  const defenses = collect('defenses', { harnessRequired: true });
  const leads = collect('leads', { harnessRequired: false });
  const layers = collect('layers', { harnessRequired: true });

  // Groups: no id (build assigns it), at least two items of this file.
  const groupSchema = schemaOf('groups', '[]');
  const groups = (data.groups || []).map((raw, i) => {
    const at = `/groups/${i}`;
    if (!isObject(raw)) { errors.push(`${at}: expected object`); return raw; }
    const g = { ...raw };
    if ('id' in g) { delete g.id; warnings.push(`${at}/id: assigned by build, ignored`); }
    if ('rev' in g) { delete g.rev; warnings.push(`${at}/rev: computed by build, ignored`); }
    if (groupSchema) validate(g, { ...groupSchema, required: (groupSchema.required || []).filter((k) => k !== 'id') }, schemaRoot, at, errors);
    else if (typeof g.title !== 'string' || !Array.isArray(g.items)) errors.push(`${at}: needs title, round and items`);
    if (Array.isArray(g.items)) {
      g.items.forEach((id, j) => linksItem(id, `${at}/items/${j}`));
      if (new Set(g.items).size < 2) errors.push(`${at}/items: a group needs at least two different items`);
    }
    const allowed = unit.kind === 'accounts' ? ROUNDS : unit.rounds;
    if (g.round !== undefined && !allowed.includes(g.round)) errors.push(`${at}/round: unit ${unit.id} does not own this round`);
    return g;
  });

  // Element annotations: verdicts, notes and item links on what the snapshot already lists.
  const elementsSchema = schemaRoot ? def(schemaRoot, 'elements') : null;
  const elements = {};
  for (const [harnessId, byCategory] of Object.entries(data.elements || {})) {
    const hAt = `/elements/${harnessId}`;
    if (!harnesses.has(harnessId)) { errors.push(`${hAt}: not a harness of unit ${unit.id}`); continue; }
    if (!isObject(byCategory)) { errors.push(`${hAt}: expected object`); continue; }
    elements[harnessId] = {};
    for (const [category, list] of Object.entries(byCategory)) {
      const cAt = `${hAt}/${category}`;
      const rule = ELEMENT_RULES[category];
      if (!rule) { errors.push(`${cAt}: unknown element category`); continue; }
      if (!Array.isArray(list)) { errors.push(`${cAt}: expected array`); continue; }
      const entrySchema = elementsSchema && elementsSchema.properties && elementsSchema.properties[category] ? elementsSchema.properties[category].items : null;
      elements[harnessId][category] = list.map((e, i) => {
        const at = `${cAt}/${i}`;
        if (!isObject(e)) { errors.push(`${at}: expected object`); return e; }
        for (const k of rule.key) if (typeof e[k] !== 'string' || !e[k]) errors.push(`${at}: needs "${k}" to find the element`);
        if (entrySchema) validate(e, entrySchema, schemaRoot, at, errors, { partial: true });
        const kept = {};
        for (const [k, v] of Object.entries(e)) {
          if (rule.key.includes(k) || rule.match.includes(k) || rule.annotate.includes(k)) kept[k] = v;
          else warnings.push(`${at}/${k}: base inventory comes from the snapshot, ignored`);
        }
        linksItem(kept.item, `${at}/item`);
        return kept;
      });
    }
  }

  const fileRoles = {};
  for (const [fileId, role] of Object.entries(data.fileRoles || {})) {
    if (typeof role !== 'string' || !role.trim()) errors.push(`/fileRoles/${fileId}: expected a one-line text`);
    else fileRoles[fileId] = role.trim();
  }

  // A round left unmarked stays pending and is not scored: say so, but accept the file.
  for (const h of harnesses.values()) {
    for (const r of unit.rounds) {
      if (roundApplies(h, r) && !roundSeen.has(`${h.id}:${r}`)) warnings.push(`/rounds: round ${r} of ${h.id} is not marked; it stays pending and is not scored`);
    }
  }
  for (const r of rounds) {
    if ((r.status === 'skipped' || r.status === 'not-applicable') && items.some((i) => i.harness === r.harness && i.round === r.round)) {
      warnings.push(`/rounds: round ${r.round} of ${r.harness} is ${r.status} but has items`);
    }
  }

  if (errors.length) return { errors, warnings, normalized: null };
  const normalized = {
    unit: unit.id,
    session: typeof data.session === 'string' && data.session ? data.session : session,
    completedAt: data.completedAt || now.toISOString(),
    rounds, items, inventory, defenses, leads, layers, groups, elements, fileRoles,
  };
  return { errors, warnings, normalized };
}

/** An empty findings file for a unit: what `claim` prints as `findingsTemplate`. */
export function findingsTemplate(unit, run, session) {
  const rounds = [];
  for (const id of unit.harnesses) {
    const h = run.harnesses.find((x) => x.id === id);
    for (const r of unit.rounds) if (h && roundApplies(h, r)) rounds.push({ harness: id, round: r, status: 'pending' });
  }
  return { unit: unit.id, session, rounds, items: [], inventory: [], defenses: [], leads: [], layers: [], groups: [], elements: {}, fileRoles: {} };
}
