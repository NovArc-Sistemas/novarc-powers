// Experiments (references/follow-up.md, "Experiments"): a measurement the user is waiting on.
//
// An experiment is OPEN on a harness when its latest review record
//   (a) applied changes (it has fixed items), or
//   (b) was marked as an experiment when its run was closed (`close --experiment`), which is how a
//       measure-only baseline, or any review, says "I am testing something",
// and its follow-up date (`experiment.until`, else `followUpAfter`) is still ahead, and nobody
// ended it early. While it is open, what loads at the start of every session should not change:
// the next measurement would mix the effect of the experiment with that of the new change.
//
// Ending early never edits a record. `run.mjs experiment end` writes a small marker,
// history/<harnessKey>/ended/<runId>.json, beside the records; a marker names the record whose
// experiment it ends, so a later experiment on the same harness is not ended by it. The marker
// folder is not a record name, so the record reader never opens it. A marker is a file anyone can
// edit, read like a record: capped, and used only when its shape and names agree.
//
// "Still ahead" is judged at the moment the run started (`run.createdAt`), so `build` stays free
// of the clock and every command of one run sees the same experiment; `history` and
// `experiment end` judge at this moment.
import fs from 'node:fs';
import path from 'node:path';
import { readTextCapped, writeJsonAtomic } from './store.mjs';
import { historyDir, RUN_ID_RE } from './paths.mjs';
import { isDateTime } from './schema.mjs';
import { HARNESS_KEY_RE, harnessKeyOf } from './records.mjs';
import { earlierRecords } from './followup.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const ENDED_DIR = 'ended';
const MARKER_BYTES = 4096;
export const MARKER_SCHEMA = 1;
/** The longest note `close --experiment` takes. */
export const MAX_NOTE = 300;

/** What loads at the start of every session: the instruction line of a brief names these. */
export const SESSION_START = 'instruction files and their imports, skill and agent descriptions, MCP servers, plugins, SessionStart hooks, output styles';

/** The marker that ends the experiment of the record of run `runId` on harness `key`. */
export function markerPath(key, runId) {
  return path.join(historyDir(), key, ENDED_DIR, `${runId}.json`);
}

/**
 * When the experiment of that record was ended early (ISO), or null. A marker that is too large,
 * not JSON, or names another harness or run is not one.
 */
export function endedAt(key, runId) {
  if (typeof key !== 'string' || !HARNESS_KEY_RE.test(key) || typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return null;
  const got = readTextCapped(markerPath(key, runId), MARKER_BYTES);
  if (got.reason) return null;
  let m = null;
  try { m = JSON.parse(got.text.replace(/^﻿/, '')); } catch { return null; }
  if (!isObject(m) || m.harnessKey !== key || m.runId !== runId || !isDateTime(m.endedAt)) return null;
  return m.endedAt;
}

/**
 * The experiment a review record starts, as the state shows it: `{ note?, since, until, runId }`,
 * or null when it starts none. `since` is its last applied change, else the end of that review.
 */
export function experimentOfRecord(record) {
  if (!isObject(record)) return null;
  const marked = isObject(record.experiment) && isDateTime(record.experiment.until);
  const fixed = Array.isArray(record.items) && record.items.some((i) => isObject(i) && i.status === 'fixed');
  if (!marked && !fixed) return null;
  const until = marked ? record.experiment.until : record.followUpAfter;
  if (!isDateTime(until)) return null;
  const out = {};
  if (marked && typeof record.experiment.note === 'string' && record.experiment.note.trim()) out.note = record.experiment.note.trim();
  out.since = isDateTime(record.changesAppliedAt) ? record.changesAppliedAt : record.reviewedAt;
  out.until = until;
  out.runId = record.runId;
  return out;
}

/**
 * The experiment open on harness `key` at `atMs`, judged from its records (`[{ record }]`, oldest
 * first): the experiment of the latest one, while its date is ahead and no marker ended it.
 */
export function openExperiment(key, records, atMs) {
  if (!Array.isArray(records) || !records.length) return null;
  const last = records[records.length - 1].record;
  const e = experimentOfRecord(last);
  if (!e || !(Date.parse(e.until) > atMs)) return null;
  if (endedAt(key, last.runId)) return null;
  return e;
}

/** The experiment open on harness `h` (an entry of run.json) when run `run` started. */
export function experimentFor(run, h) {
  if (!h) return null;
  return openExperiment(harnessKeyOf(h), earlierRecords(run, h), Date.parse(run.createdAt));
}

/** `{ harnessId: experiment }` for every harness of the run that has one open. */
export function experimentsOf(run) {
  const out = {};
  for (const h of run.harnesses) {
    const e = experimentFor(run, h);
    if (e) out[h.id] = e;
  }
  return out;
}

/**
 * The open items that wait for the experiment of their harness: `Map<itemId, experiment>`.
 * A reviewer's `heldForExperiment` counts only while that experiment is open.
 */
export function heldItems(run, items, experiments = experimentsOf(run)) {
  const out = new Map();
  for (const i of items) {
    if (i && i.heldForExperiment === true && i.status === 'open' && experiments[i.harness]) out.set(i.id, experiments[i.harness]);
  }
  return out;
}

/** The day an experiment ends, as a brief or an error message writes it. */
export const dayOf = (iso) => String(iso).slice(0, 10);

/**
 * The instruction line a review brief carries for a harness with an open experiment. English,
 * like the rest of a brief: it is read by the reviewing agent.
 */
export function experimentRule(h, e) {
  const what = e.note ? `"${e.note}"` : `the changes applied in run ${e.runId}`;
  return `An experiment is open on ${h.id} until ${dayOf(e.until)} (${what}). Do not propose changes to what loads at the start of every session (${SESSION_START}) in ${h.id} until ${dayOf(e.until)}, because they would confound the measurement. A finding about one of those may still be recorded: status open and "heldForExperiment": true. It waits until the experiment ends and is not listed with what the user decides now.`;
}

/** Write the marker that ends the experiment of record `runId` on `key` at `at` (ISO). */
export function writeMarker(key, runId, at) {
  const file = markerPath(key, runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { schema: MARKER_SCHEMA, harnessKey: key, runId, endedAt: at });
  return file;
}
