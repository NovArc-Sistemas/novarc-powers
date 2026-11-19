#!/usr/bin/env node
// Runs tests/*.test.js and skills/*/tests/*.test.mjs with node:test. A script instead of a glob because npm
// on Windows runs scripts through cmd.exe (no glob expansion) and Node 20 has
// no built-in --test glob support; Node 21+ treats a directory argument as a
// file. Listing the files here works on every supported version.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'tests');
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join('tests', f));
const skillsDir = path.join(root, 'skills');
for (const skill of fs.readdirSync(skillsDir).sort()) {
  const t = path.join(skillsDir, skill, 'tests');
  if (!fs.existsSync(t)) continue;
  for (const f of fs.readdirSync(t).filter((n) => n.endsWith('.test.mjs')).sort()) {
    files.push(path.join('skills', skill, 'tests', f));
  }
}
const res = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
process.exitCode = res.status ?? 1;