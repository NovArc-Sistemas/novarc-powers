#!/usr/bin/env node
// Writes catalog.json from every skills/*/skill.json. Deterministic output (no
// timestamps) so `validate` can detect a stale catalog by comparison.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Catalog object for the repo at `root`. Unreadable skill.json files are skipped (validate reports them). */
export function buildCatalog(root = REPO_ROOT) {
  const skillsDir = path.join(root, 'skills');
  const skills = [];
  let entries = [];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const ent of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(skillsDir, ent.name, 'skill.json'), 'utf8'));
    } catch {
      continue;
    }
    skills.push({
      name: meta.name,
      version: meta.version,
      summary: meta.summary,
      summary_pt: meta.summary_pt,
      profile: meta.profile,
      environments: meta.environments || [],
      requires: meta.requires || [],
      workspace: meta.workspace || {},
      path: `skills/${ent.name}`,
    });
  }
  return { schema: 1, skills };
}

export function renderCatalog(root = REPO_ROOT) {
  return JSON.stringify(buildCatalog(root), null, 2) + '\n';
}

function main() {
  const i = process.argv.indexOf('--root');
  const root = i !== -1 ? path.resolve(process.argv[i + 1]) : REPO_ROOT;
  const file = path.join(root, 'catalog.json');
  const text = renderCatalog(root);
  fs.writeFileSync(file, text);
  process.stdout.write(`catalog.json: ${JSON.parse(text).skills.length} skill(s)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();