// Revisions: what a decision is bound to. An approval is a yes to one exact proposal, so every
// item carries `rev`, a short hash of the fields that define what would be applied or done, and a
// decision only takes effect on the revision it was made on. When a reviewer completes a unit
// again and an item comes back under the same id with another class or other changes, its rev
// changes and the earlier decision no longer applies.
//
// The hash is computed here and nowhere else: `build` writes it into state.json, `decide` and
// `decisions` compare it, `complete` uses it to clear decisions made on an earlier revision, and
// `mark` checks it again when an item is about to be applied. It is always computed from the item
// as the findings file stores it, before `build` links a change to its file in the snapshot.
import { readJson, sha256 } from './store.mjs';

export const REV_LENGTH = 12;
export const REV_RE = /^[0-9a-f]{12}$/;
/** Statuses that are the user's decision on one revision of an item. */
export const DECISION_STATUSES = ['approved', 'declined', 'deferred'];

const text = (v) => (typeof v === 'string' ? v : null);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** JSON text with the keys of every object in code-unit order and no whitespace. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * What the rev of an item is a hash of: the harness, the class, the target file of an item that
 * has no changes, the proposal (which carries the command of an install), and of every change, in
 * the order written, the file, path, before, after and insertAfter. A field that is absent or not
 * a string counts as null. Title, finding, evidence, opinion, lesson, severity and each change's
 * `why` are wording: they can be improved without asking the user again.
 */
export function revInput(item) {
  const it = isObject(item) ? item : {};
  return {
    harness: text(it.harness),
    class: text(it.class),
    file: text(it.file),
    proposal: text(it.proposal),
    changes: (Array.isArray(it.changes) ? it.changes : []).map((c) => {
      const o = isObject(c) ? c : {};
      return { file: text(o.file), path: text(o.path), before: text(o.before), after: text(o.after), insertAfter: text(o.insertAfter) };
    }),
  };
}

/** The 12 hex characters that name one revision of an item. */
export function itemRev(item) {
  return sha256(canonicalJson(revInput(item))).slice(0, REV_LENGTH);
}

/**
 * The rev of a group: a hash of the `itemId:rev` of its members, sorted and joined by a line
 * feed. It changes when any member changes, so a group decision is a yes to every member as shown.
 */
export function groupRev(memberIds, revOf) {
  const parts = memberIds.map((id) => `${id}:${revOf.get(id) || ''}`).sort();
  return sha256(parts.join('\n')).slice(0, REV_LENGTH);
}

/**
 * The revs in the last built state.json: `{ items: Map, groups: Map }`, or null when no board
 * was built. That state is the only board the user can have looked at, so a decision that arrives
 * from the board without a rev is bound to these.
 */
export function builtRevs(paths) {
  let state;
  try { state = readJson(paths.state); } catch { return null; }
  if (!isObject(state)) return null;
  const collect = (list) => new Map((Array.isArray(list) ? list : [])
    .filter((x) => isObject(x) && typeof x.id === 'string' && typeof x.rev === 'string' && REV_RE.test(x.rev))
    .map((x) => [x.id, x.rev]));
  return { items: collect(state.items), groups: collect(state.groups) };
}
