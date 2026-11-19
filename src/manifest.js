// Per-scope manifest at `<scope root>/.novarc-powers/manifest.json`.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.js';
import { writeFileInPlace } from './fsutil.js';

export const MANIFEST_SCHEMA = 1;

export function manifestPath(scopeRoot) {
  return path.join(stateDir(scopeRoot), 'manifest.json');
}

export function emptyManifest(version, updates = 'notify') {
  return { schema: MANIFEST_SCHEMA, packageVersion: version, updates, entries: [] };
}

/** Read a manifest; returns null when missing, throws on corrupt JSON. */
export function readManifest(scopeRoot) {
  const file = manifestPath(scopeRoot);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const data = JSON.parse(text);
  if (!Array.isArray(data.entries)) data.entries = [];
  return data;
}

export function writeManifest(scopeRoot, manifest) {
  const sorted = {
    ...manifest,
    entries: [...manifest.entries].sort(
      (a, b) => a.skill.localeCompare(b.skill) || a.target.localeCompare(b.target),
    ),
  };
  writeFileInPlace(manifestPath(scopeRoot), JSON.stringify(sorted, null, 2) + '\n');
}

export function removeManifest(scopeRoot) {
  try {
    fs.unlinkSync(manifestPath(scopeRoot));
  } catch {
    /* already gone */
  }
}
