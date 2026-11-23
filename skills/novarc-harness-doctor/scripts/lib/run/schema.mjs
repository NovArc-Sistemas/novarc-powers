// The state schema, plus the small validator the run tooling needs: `build` checks what it wrote,
// `complete` checks what a reviewer handed in, and probe output is pruned to the schema so a
// diagnostic field a probe adds never breaks the board. Supports the JSON Schema subset the state
// schema uses (type, const, enum, required, properties, additionalProperties: false, items,
// minItems, minimum, maximum, pattern, format: date-time, $ref into #/$defs). Messages name the
// path and the rule, never the offending value.
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR } from './paths.mjs';

export const SCHEMA_VERSION = 2;
// templates/state.schema.json is what render-board.mjs validates against, so it wins as soon as it
// is a schemaVersion 2 schema; until then (it was the v1 schema) the v2 file next to it is used.
const CANDIDATES = ['state.schema.json', 'state.schema.v2.json'];

function readSchema(templatesDir) {
  for (const name of CANDIDATES) {
    try {
      const schema = JSON.parse(fs.readFileSync(path.join(templatesDir, name), 'utf8'));
      if (schema && schema.properties && schema.properties.schemaVersion && schema.properties.schemaVersion.const === SCHEMA_VERSION) return { schema, file: name };
    } catch { /* try the next candidate */ }
  }
  return null;
}

let ownSchema;
/**
 * `{ schema, file }` for the schemaVersion 2 state schema, or null when the folder holds none.
 * Without an argument it is this skill's templates folder, read once per process. What the state
 * may contain (which impact keys a probe's output keeps, for one) is always read from that file,
 * never from a list in the code.
 */
export function loadStateSchema(templatesDir) {
  if (templatesDir !== undefined) return readSchema(templatesDir);
  if (ownSchema === undefined) ownSchema = readSchema(path.join(SKILL_DIR, 'templates'));
  return ownSchema;
}

export function skillVersion() {
  try { return String(JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'skill.json'), 'utf8')).version || '0.0.0'); } catch { return '0.0.0'; }
}

function deref(schema, root) {
  let s = schema;
  for (let i = 0; s && s.$ref && i < 10; i++) {
    const m = /^#\/\$defs\/(.+)$/.exec(s.$ref);
    s = m && root.$defs ? root.$defs[m[1]] : null;
  }
  return s || null;
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
export function isDateTime(v) { return typeof v === 'string' && DATE_TIME.test(v) && !Number.isNaN(Date.parse(v)); }

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
function typeMatches(v, t) {
  const actual = typeOf(v);
  return t === 'number' ? actual === 'number' || actual === 'integer' : actual === t;
}

/**
 * Validate `value` against `schema`. Returns error strings prefixed with a JSON pointer.
 * `partial: true` skips `required` on the top-level object only (reviewer annotations).
 */
export function validate(value, schema, root = schema, at = '', errors = [], opts = {}) {
  const s = deref(schema, root);
  if (!s) { errors.push(`${at || '/'}: unresolvable $ref`); return errors; }
  const where = at || '/';
  if ('const' in s && value !== s.const) errors.push(`${where}: must equal ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(value)) errors.push(`${where}: not one of ${s.enum.join(', ')}`);
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeMatches(value, t))) { errors.push(`${where}: expected ${types.join(' or ')}, got ${typeOf(value)}`); return errors; }
  }
  const t = typeOf(value);
  if (t === 'object') {
    if (!opts.partial) for (const k of s.required || []) if (!(k in value)) errors.push(`${where}: missing required "${k}"`);
    const props = s.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validate(v, props[k], root, `${at}/${k}`, errors);
      else if (s.additionalProperties === false) errors.push(`${where}: unknown property "${k}"`);
    }
  } else if (t === 'array') {
    if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${where}: needs at least ${s.minItems} item(s)`);
    if (s.items) value.forEach((v, i) => validate(v, s.items, root, `${at}/${i}`, errors));
  } else if (t === 'string') {
    if (s.pattern && !new RegExp(s.pattern, 'u').test(value)) errors.push(`${where}: does not match ${s.pattern}`);
    if (s.format === 'date-time' && !isDateTime(value)) errors.push(`${where}: not an RFC 3339 date-time`);
  } else if (t === 'integer' || t === 'number') {
    if (s.minimum !== undefined && value < s.minimum) errors.push(`${where}: below minimum ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) errors.push(`${where}: above maximum ${s.maximum}`);
  }
  return errors;
}

/**
 * Deep copy of `value` keeping only what the schema knows: properties not declared by an
 * `additionalProperties: false` object are dropped. Types are not coerced; validate afterwards.
 */
export function prune(value, schema, root = schema) {
  const s = deref(schema, root);
  if (!s) return value;
  if (Array.isArray(value)) return s.items ? value.map((v) => prune(v, s.items, root)) : value.slice();
  if (value && typeof value === 'object') {
    const props = s.properties || {};
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) out[k] = prune(v, props[k], root);
      else if (s.additionalProperties !== false) out[k] = v;
    }
    return out;
  }
  return value;
}

/** Sub-schema at a property path, e.g. sub(root, 'items', '[]') -> the schema of one item. */
export function sub(root, ...steps) {
  let s = root;
  for (const step of steps) {
    s = deref(s, root);
    if (!s) return null;
    s = step === '[]' ? s.items : (s.properties || {})[step];
    if (!s) return null;
  }
  return deref(s, root);
}

/** Schema of `$defs.<name>`. */
export function def(root, name) { return root.$defs ? deref(root.$defs[name], root) : null; }

/**
 * Keep the entries of a probe-produced array that are valid once pruned to the schema; report the
 * rest as warnings instead of failing the build.
 */
export function sanitizeList(list, itemSchema, root, source, warnings) {
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { warnings.push({ source, problem: `entry ${i} is not an object; dropped` }); return; }
    const clean = prune(entry, itemSchema, root);
    const errors = validate(clean, itemSchema, root);
    if (errors.length) warnings.push({ source, problem: `entry ${i} dropped: ${errors[0]}` });
    else out.push(clean);
  });
  return out;
}
