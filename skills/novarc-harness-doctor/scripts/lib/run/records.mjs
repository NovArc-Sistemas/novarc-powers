// Review records on disk (references/follow-up.md): the key of a harness, the name of a record
// file, the record schema, and how a record is read.
//
// The history folder is plain files in the home of the person, written by this tool and editable
// by anything. So a record is trusted for what it says about an earlier review and for nothing
// else, and reading one is where that line is drawn:
//
//   limits      a file is opened once and read only up to `LIMITS.recordBytes`; of a harness
//               folder at most `recordsPerHarness` files are opened (the newest by name) and
//               `harnessBytes` read, and one command reads at most `totalBytes` of the whole
//               history folder. The limits are on what is read, whatever it turns out to be:
//               a file that is not JSON, not a record, or someone else's costs its bytes like a
//               good one. Records are read newest first, and the first one that does not fit
//               what is left ends the reading: it and everything older are not opened. The
//               harnesses of a run are read before anything else, so the budget of a command
//               goes to them first.
//   shape       the file must fit templates/record.schema.json (which bounds every string and
//               list), belong to the folder it is in, and carry the name its run id gives it.
//   barrier     what is kept then passes the barriers of the state on the way in: home paths
//               become `~`, credentials are masked, and its prose follows the prose policy
//               (prose.mjs). Schema validation is not a privacy barrier; this is.
//
// A file that fails is ignored and listed with a reason and nothing of its content. The records
// are the truth of the history folder: index.json is a cache made from them (history.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunError, readTextCapped, sha256 } from './store.mjs';
import { SKILL_DIR, homeBase, historyDir, historyIndexPath } from './paths.mjs';
import { slugify } from './ids.mjs';
import { loadStateSchema, validate, def, isDateTime } from './schema.mjs';
import { homeMatchers, scrubDeep } from './scrub.mjs';
import { maskDeep, hasCredential } from './secrets.mjs';
import { applyProse, proseContext, RECORD_PROSE } from './prose.mjs';

export const RECORD_SCHEMA = 1;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const MB = 1024 * 1024;

/** What is read from the history folder, at most. */
export const LIMITS = Object.freeze({
  recordBytes: 4 * MB, // one record file
  indexBytes: 4 * MB, // index.json
  recordsPerHarness: 400, // the newest ones
  harnessBytes: 64 * MB, // all the records of one harness
  totalBytes: 256 * MB, // everything one command reads
  harnesses: 2000, // harness folders listed
});

/**
 * The limits in force. Test seam: NOVARC_HD_TEST_HISTORY_LIMITS (a JSON object) lowers them, so a
 * test of "too many" does not need hundreds of files. It can only lower.
 */
export function limits() {
  const raw = process.env.NOVARC_HD_TEST_HISTORY_LIMITS;
  if (!raw) return LIMITS;
  let over = null;
  try { over = JSON.parse(raw); } catch { over = null; }
  if (!isObject(over)) return LIMITS;
  const out = { ...LIMITS };
  for (const k of Object.keys(LIMITS)) if (Number.isInteger(over[k]) && over[k] >= 0) out[k] = Math.min(LIMITS[k], over[k]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The key of a harness
// ---------------------------------------------------------------------------------------------

export const HARNESS_KEY_RE = /^[a-z0-9][a-z0-9-]{0,110}-[0-9a-f]{8}$/;
const keyMemo = new Map();

/**
 * The 8 hex characters that tell one harness from another: the start of a SHA-256 over its kind,
 * its provider (empty for a project) and its real absolute path, joined by line feeds. The path
 * is lower-cased on Windows, where case does not tell two folders apart.
 */
export function harnessHash(h) {
  let real = path.resolve(str(h.pathAbs));
  try { real = fs.realpathSync.native(real); } catch { /* the folder is gone: the path as it was written */ }
  if (process.platform === 'win32') real = real.toLowerCase();
  return sha256([str(h.kind), str(h.provider), real].join('\n')).slice(0, 8);
}

/**
 * `<slug of the name>-<8 hex>`: the name of the harness's folder under history/. `h` is a harness
 * entry of run.json; the key `init` wrote there wins. The name of a harness can change between
 * runs (an account label follows the language of the run), so a folder that already holds the
 * records of this same kind, provider and path keeps its name.
 */
export function harnessKeyOf(h) {
  if (typeof h.harnessKey === 'string' && HARNESS_KEY_RE.test(h.harnessKey)) return h.harnessKey;
  const memo = JSON.stringify([historyDir(), h.kind, h.provider, h.pathAbs, h.name]);
  if (keyMemo.has(memo)) return keyMemo.get(memo);
  const hash = harnessHash(h);
  let existing = null;
  try { existing = fs.readdirSync(historyDir()).filter((n) => n.endsWith(`-${hash}`) && HARNESS_KEY_RE.test(n)).sort()[0] || null; } catch { existing = null; }
  const key = existing || `${slugify(h.name, h.kind === 'user' ? 'account' : 'project')}-${hash}`;
  keyMemo.set(memo, key);
  return key;
}

/**
 * Is `pathAbs` the folder of the harness `key` names? The key ends in the hash of the kind, the
 * provider and the real path, so a path that gives that hash is the one the key was made from.
 * This is how an absolute path that was read from a file (index.json) is checked before use.
 */
export function ownsPath(key, record, pathAbs) {
  if (typeof pathAbs !== 'string' || !pathAbs || pathAbs.length > 32767 || !path.isAbsolute(pathAbs)) return false;
  return harnessHash({ kind: record.kind, provider: record.provider, pathAbs }) === key.slice(-8);
}

/** File name of a record, without extension: the run id, which starts with the day it started. */
export function recordBaseName(runId, startedAt) {
  if (/^\d{8}-/.test(runId)) return runId;
  const day = isDateTime(startedAt) ? startedAt.slice(0, 10).replace(/-/g, '') : '00000000';
  return `${day}-${runId}`;
}

/** A record file is named after a run id: nothing else in a harness folder is read as a record. */
const RECORD_FILE_RE = /^[a-z0-9][a-z0-9-]{2,60}\.json$/;

// ---------------------------------------------------------------------------------------------
// The record schema
// ---------------------------------------------------------------------------------------------

let recordSchema;
function loadRecordSchema() {
  if (recordSchema !== undefined) return recordSchema;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'templates', 'record.schema.json'), 'utf8'));
    recordSchema = s && s.properties && s.properties.schema && s.properties.schema.const === RECORD_SCHEMA ? s : null;
  } catch { recordSchema = null; }
  return recordSchema;
}

/**
 * Errors of `record` against templates/record.schema.json; its `outcome` is checked against the
 * `followUp` definition of the state schema, which is where that object comes from.
 */
export function validateRecord(record) {
  const schema = loadRecordSchema();
  if (!schema) throw new RunError('templates/record.schema.json (schema 1) not found: the skill folder is incomplete');
  const errors = validate(record, schema);
  if (isObject(record) && isObject(record.outcome)) {
    const state = loadStateSchema();
    const followUp = state ? def(state.schema, 'followUp') : null;
    if (followUp) validate(record.outcome, followUp, state.schema, '/outcome', errors);
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------
// The barrier
// ---------------------------------------------------------------------------------------------

let homeMemo = null;
function homes() {
  const key = `${os.homedir()}\n${homeBase()}`;
  if (!homeMemo || homeMemo.key !== key) homeMemo = { key, matchers: homeMatchers() };
  return homeMemo.matchers;
}

const absoluteDisplay = (p) => typeof p === 'string' && (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/'));

/**
 * A record as it may be used and shown: home paths as `~`, its prose under the prose policy,
 * credentials masked. The same function runs on a record that is about to be written and on one
 * that was just read, so what is on disk and what a run sees are the same text. The display path
 * of a harness outside the home is absolute; it is the one path its prose may keep.
 */
export function sanitizeRecord(record) {
  const scrubbed = scrubDeep(record, homes());
  const roots = absoluteDisplay(scrubbed.path) ? [{ abs: scrubbed.path, display: scrubbed.path, literal: true }] : [];
  return maskDeep(applyProse(scrubbed, RECORD_PROSE, proseContext(roots)));
}

// ---------------------------------------------------------------------------------------------
// Reading records
// ---------------------------------------------------------------------------------------------

const cache = new Map();
/**
 * Bytes this process has read of the history folder: records, whatever they turned out to be,
 * index.json, and each `.md` it compared. It only grows: reading a harness again costs again.
 */
let totalRead = 0;

/**
 * Forget what was read (after a write), so that it is read again. Without a key, everything, and
 * the count of bytes read starts over (a new command, as far as the limits go).
 */
export function forgetRecords(key) {
  if (key === undefined) { cache.clear(); totalRead = 0; return; }
  cache.delete(key);
}

/** What one command may still read of the history folder, in bytes. */
function totalLeft() { return limits().totalBytes - totalRead; }

/**
 * Every read of the history folder goes through here: at most `maxBytes` of `file`, counted
 * against what one command may read whatever the bytes turn out to be.
 * Test seam: NOVARC_HD_TEST_HISTORY_READS names a file that gets one JSON line per file opened,
 * `{ file, bytes }`, `file` relative to the history folder and `bytes` what was read of it.
 */
function readHistoryFile(file, maxBytes) {
  const got = readTextCapped(file, maxBytes);
  totalRead += got.bytes || 0;
  const log = process.env.NOVARC_HD_TEST_HISTORY_READS;
  if (log && got.reason !== 'missing') {
    try { fs.appendFileSync(log, `${JSON.stringify({ file: path.relative(historyDir(), file).split(path.sep).join('/'), bytes: got.bytes || 0 })}\n`); } catch { /* a seam must not fail a command */ }
  }
  return got;
}

/** A file name as it may be printed: one that looks like a credential is not. */
const printable = (name) => (hasCredential(name) ? null : name);

/**
 * One record file: `{ record, bytes }`, or `{ reason, bytes }`. `budget` is how many bytes may
 * still be read; `bytes` is what was read, record or not. A file within the size a record may
 * have that does not fit the budget is `over-budget` and is not read. The reason never says
 * anything of what the file holds.
 */
function readRecordFile(file, key, name, budget) {
  const max = limits().recordBytes;
  const got = readHistoryFile(file, Math.min(max, budget));
  if (got.reason) return { reason: got.reason === 'too-large' && got.size <= max ? 'over-budget' : got.reason, bytes: 0 };
  return { ...recordOf(got.text, key, name), bytes: got.bytes };
}

/** The record that the text of a file of `key` named `name` is: `{ record }`, or `{ reason }`. */
function recordOf(text, key, name) {
  let raw = null;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return { reason: 'not-json' }; }
  if (!isObject(raw)) return { reason: 'invalid' };
  if (raw.harnessKey !== key) return { reason: 'other-harness' };
  if (validateRecord(raw).length) return { reason: 'invalid' };
  if (`${recordBaseName(raw.runId, raw.startedAt)}.json` !== name) return { reason: 'misnamed' };
  return { record: sanitizeRecord(raw) };
}

/**
 * A harness folder as far as it is looked at: the record names that may be opened (`kept`, the
 * newest `recordsPerHarness` by name), how many `.json` files are left out by name or by number,
 * and a stamp of what may be opened (names, sizes, times) and of those counts. Only `kept` is
 * ever given a system call of its own.
 */
function folderOf(key) {
  const dir = path.join(historyDir(), key);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { names = []; }
  const json = names.filter((n) => /\.json$/i.test(n));
  const candidates = json.filter((n) => RECORD_FILE_RE.test(n)).sort();
  const kept = candidates.slice(Math.max(0, candidates.length - limits().recordsPerHarness));
  const stamp = sha256([`${json.length}:${candidates.length}`, ...kept.map((n) => {
    try { const s = fs.statSync(path.join(dir, n)); return `${n}:${s.size}:${Math.round(s.mtimeMs)}`; } catch { return `${n}:-`; }
  })].join('\n'));
  return { dir, strange: json.length - candidates.length, older: candidates.length - kept.length, kept, stamp };
}

/**
 * Forget the records of `key` when its folder is no longer what was read (another process wrote
 * there). A process that is about to write what it knows of a harness asks this first.
 */
export function recheckRecords(key) {
  const have = cache.get(key);
  if (have && typeof key === 'string' && HARNESS_KEY_RE.test(key) && have.stamp !== folderOf(key).stamp) forgetRecords(key);
}

function readRecords(key) {
  if (cache.has(key)) return cache.get(key);
  const out = { records: [], ignored: [], bytes: 0, stamp: '' };
  cache.set(key, out);
  if (typeof key !== 'string' || !HARNESS_KEY_RE.test(key)) return out;
  const { dir, strange, older, kept, stamp } = folderOf(key);
  out.stamp = stamp;
  if (strange) out.ignored.push({ file: null, count: strange, reason: 'not-a-record-name' });
  if (older) out.ignored.push({ file: null, count: older, reason: 'too-many' });
  const lim = limits();
  // Newest first: when a budget runs dry, what is left out is the oldest. `spent` names the
  // budget that ran dry; from there on nothing is opened.
  let spent = null;
  for (const name of kept.reverse()) {
    if (!spent) {
      const harnessLeft = lim.harnessBytes - out.bytes;
      const commandLeft = totalLeft();
      const left = Math.min(harnessLeft, commandLeft);
      const file = path.join(dir, name);
      const r = left > 0 ? readRecordFile(file, key, name, left) : { reason: 'over-budget', bytes: 0 };
      // What was read counts, record or not.
      out.bytes += r.bytes;
      if (r.record) { out.records.push({ file, name, record: r.record }); continue; }
      if (r.reason !== 'over-budget') { out.ignored.push({ file: printable(name), reason: r.reason }); continue; }
      spent = commandLeft < harnessLeft ? 'over-total-budget' : 'over-budget';
    }
    out.ignored.push({ file: printable(name), reason: spent });
  }
  out.records.sort((a, b) => Date.parse(a.record.reviewedAt) - Date.parse(b.record.reviewedAt) || a.record.runId.localeCompare(b.record.runId));
  // Counts first, then file by file in name order: the same folder always gives the same list.
  out.ignored.sort((a, b) => (b.file === null) - (a.file === null) || String(a.file).localeCompare(String(b.file)) || a.reason.localeCompare(b.reason));
  return out;
}

/** Every valid record of a harness key, oldest first: `[{ file, name, record }]`. */
export function listRecords(key) { return readRecords(key).records; }

/**
 * What was found under history/<key>/ and is not a record this tool reads:
 * `[{ file, reason, count? }]`. `file` is a file name, or null for a count of files (names that
 * are not record names are never repeated). Reasons: `not-a-record-name`, `too-many` (older than
 * the newest `recordsPerHarness`), `over-budget` (the bytes of this harness were spent, on good
 * records or bad files alike: not opened), `over-total-budget` (the same for the bytes of this
 * command), `too-large`, `not-a-file`, `unreadable`, `missing`, `not-json`, `invalid` (does not
 * fit the schema), `other-harness`, `misnamed`.
 */
export function ignoredRecords(key) { return readRecords(key).ignored; }

/**
 * Was a record of `key` left unread because this command had read its fill? What is known of
 * that harness is then less than what is on disk, and nothing made from all the records (the
 * index) may be written from it.
 */
export function starved(key) { return readRecords(key).ignored.some((x) => x.reason === 'over-total-budget'); }

/** The harness keys that have a folder under history/, sorted; at most `LIMITS.harnesses`. */
export function harnessKeys() {
  let names = [];
  try { names = fs.readdirSync(historyDir(), { withFileTypes: true }).filter((e) => e.isDirectory() && HARNESS_KEY_RE.test(e.name)).map((e) => e.name); } catch { names = []; }
  return names.sort().slice(0, limits().harnesses);
}

/**
 * index.json as text, within the limits: `{ text }`, or `{ reason }` (`missing`, `too-large`,
 * `over-total-budget` when this command has read its fill, `not-a-file`, `unreadable`). Its
 * bytes count against what a command may read, like any other file of the history folder.
 */
export function readIndexText() {
  const max = limits().indexBytes;
  const left = totalLeft();
  if (left <= 0) return { reason: 'over-total-budget' };
  const got = readHistoryFile(historyIndexPath(), Math.min(max, left));
  if (got.reason === 'too-large' && got.size <= max) return { reason: 'over-total-budget' };
  return got.reason ? { reason: got.reason } : { text: got.text };
}

/**
 * Does `file` hold exactly `text`? `same`, `differs`, `missing`, or `unknown` when this command
 * has read its fill. The file is read only when it has the size of `text`, so at most the bytes
 * of `text` are read, whatever the file is.
 */
export function holdsText(file, text) {
  const size = Buffer.byteLength(text);
  let st = null;
  try { st = fs.statSync(file); } catch (e) { return e && e.code === 'ENOENT' ? 'missing' : 'differs'; }
  if (!st.isFile() || st.size !== size) return 'differs';
  if (totalLeft() < size) return 'unknown';
  return readHistoryFile(file, size).text === text ? 'same' : 'differs';
}

/**
 * The absolute path index.json (given as text, see `readIndexText`) holds for each harness key:
 * a candidate, to be checked with `ownsPath` before any use. Nothing else of the index is ever
 * used: the rest is made again from the records.
 */
export function indexedPaths(text) {
  const out = new Map();
  if (typeof text !== 'string') return out;
  let index = null;
  try { index = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return out; }
  if (!isObject(index) || !isObject(index.harnesses)) return out;
  for (const [key, entry] of Object.entries(index.harnesses)) {
    if (HARNESS_KEY_RE.test(key) && isObject(entry) && typeof entry.pathAbs === 'string') out.set(key, entry.pathAbs);
  }
  return out;
}
