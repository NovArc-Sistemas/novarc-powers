// The credential barrier of a run. Nothing a session hands to the run may carry a credential: a
// findings file, a decision note, a verification note, a title or a session label is refused at
// the door, and `build` masks whatever still reaches the state by another path (a probe, a file
// written before this check existed) before state.json is written and the board is rendered.
//
// Two detectors, and a text is clean only when both agree: the fixed patterns of secret-scan.mjs
// (tokens with a known prefix, private keys, `password = ...` assignments), and the masker the
// snapshot uses on harness files. Using the snapshot's own masker is what keeps the rule simple
// for a reviewer: text copied from the snapshot is already masked and always passes; text copied
// from the file on disk does not.
//
// Nothing here ever returns, prints or logs a value, in whole or in part: a hit is a JSON pointer
// and the kind of credential.
import { scanText, redactText } from '../../secret-scan.mjs';
import { maskText } from '../snapshot/mask.mjs';
import { setOwn } from './store.mjs';

/** What to write instead; appended to every refusal. */
export const CREDENTIAL_HINT = 'write it masked (the first 4 characters, … and the length, as the snapshot shows it) or as a placeholder such as <token>';

/**
 * The snapshot's masker over a text of unknown format. A barrier must not be what stops a board
 * from being built: should the masker fail on some input, the fixed patterns still run.
 */
function snapshotMask(text) {
  try { return maskText(text); } catch { return text; }
}

/** Kinds of credential in `text`; empty when it is clean. */
export function credentialKinds(text) {
  if (typeof text !== 'string' || !text) return [];
  const kinds = [...new Set(scanText(text, { maxLineLength: Infinity }).map((f) => f.pattern))];
  if (!kinds.length && snapshotMask(text) !== text) kinds.push('secret-shaped-value');
  return kinds;
}

export function hasCredential(text) { return credentialKinds(text).length > 0; }

/** `text` with every credential masked. Line structure is kept. */
export function maskCredentials(text) {
  if (typeof text !== 'string' || !text) return text;
  return redactText(snapshotMask(text));
}

const segment = (key) => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
/** A property name that is itself a credential never becomes part of a pointer. */
const MASKED_SEGMENT = '<masked property name>';

/**
 * Every string of `value` (property names included) that holds a credential:
 * `[{ at, kinds, key }]`. `at` is the JSON pointer of the value, or of the object whose property
 * name is the credential (`key: true`).
 */
export function findCredentials(value, hits = [], at = '') {
  if (typeof value === 'string') {
    const kinds = credentialKinds(value);
    if (kinds.length) hits.push({ at: at || '/', kinds, key: false });
    return hits;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => findCredentials(v, hits, `${at}/${i}`)); return hits; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const kinds = credentialKinds(k);
      if (kinds.length) hits.push({ at: at || '/', kinds, key: true });
      findCredentials(v, hits, `${at}/${kinds.length ? MASKED_SEGMENT : segment(k)}`);
    }
  }
  return hits;
}

/** One line per hit, safe to print: the pointer, the kind, and what to write instead. */
export function credentialErrors(hits) {
  return hits.map((h) => `${h.at}: ${h.key ? 'a property name holds a credential' : 'credential'} (${h.kinds.join(', ')}); ${CREDENTIAL_HINT}`);
}

/**
 * Copy of `value` with the credentials in its strings (and property names) masked. `hits`
 * receives the JSON pointer of every string that was changed.
 */
export function maskDeep(value, hits = [], at = '') {
  if (typeof value === 'string') {
    const masked = maskCredentials(value);
    if (masked !== value) hits.push(at || '/');
    return masked;
  }
  if (Array.isArray(value)) return value.map((v, i) => maskDeep(v, hits, `${at}/${i}`));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const key = maskCredentials(k);
      if (key !== k) hits.push(`${at}/${MASKED_SEGMENT}`);
      setOwn(out, key, maskDeep(v, hits, `${at}/${key !== k ? MASKED_SEGMENT : segment(k)}`));
    }
    return out;
  }
  return value;
}
