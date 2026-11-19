#!/usr/bin/env node
// Repository validator: catalog freshness, skill metadata, links that stay
// inside each skill, and leaked secrets or personal data in text files.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, renderCatalog } from './build-catalog.mjs';
import { skillJsonProblems } from '../src/skills.js';

const PLACEHOLDER_USERS = new Set([
  'you', 'user', 'username', 'name', 'yourname', 'your-name', 'your_name', 'me', 'example',
  'public', 'default', 'runner', 'runneradmin', 'someone', 'foo', 'bob', 'alice',
]);
const placeholderUser = (u) => !u || /^[<{$%]/.test(u) || PLACEHOLDER_USERS.has(u.toLowerCase());
const ALLOWED_EMAIL = (m) => {
  const e = m.toLowerCase();
  const domain = e.split('@')[1] || '';
  return (
    e.includes('noreply') ||
    e.includes('no-reply') ||
    e === 'git@github.com' ||
    /(^|\.)example\.(com|org|net)$/.test(domain) ||
    domain === 'example' ||
    /(^|[.])(invalid|test|example|localhost)$/.test(domain) ||
    // file names such as name@2x.png or n@file.md are not addresses
    /\.(png|jpe?g|gif|svg|webp|md|mdx|json|js|mjs|cjs|ts|txt|html|ya?ml)$/.test(domain)
  );
};

/** Every leak pattern, in one place. `allow` returns true for an accepted match. */
export const LEAK_PATTERNS = [
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: 'secret-key-sk', re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'supabase-token', re: /\bsbp_[A-Za-z0-9]{20,}\b/g },
  { id: 'slack-token', re: /\bxox[bap]-[A-Za-z0-9-]{10,}/g },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'aws-secret-key', re: /aws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/gi },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  {
    id: 'windows-user-path',
    re: /\b[A-Za-z]:(?:\\\\|\\|\/)+Users(?:\\\\|\\|\/)+([^\\/\s"'`<>{}$%]+)?/gi,
    allow: (m) => placeholderUser(m[1]),
  },
  { id: 'mac-user-path', re: /(?<![\w.-])\/Users\/([^/\s"'`<>{}$%]+)?/g, allow: (m) => placeholderUser(m[1]) },
  { id: 'linux-home-path', re: /(?<![\w.-])\/home\/([^/\s"'`<>{}$%]+)?/g, allow: (m) => placeholderUser(m[1]) },
  { id: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, allow: (m) => ALLOWED_EMAIL(m[0]) },
];

/** Leak findings in a string: `[{id, match, line}]`. */
export function scanText(text) {
  const findings = [];
  for (const p of LEAK_PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text))) {
      if (m[0] === '') {
        p.re.lastIndex++;
        continue;
      }
      if (p.allow && p.allow(m)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      findings.push({ id: p.id, match: m[0].length > 60 ? m[0].slice(0, 57) + '...' : m[0], line });
    }
  }
  return findings;
}

const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir, root, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      if (ent.name === 'fixtures' && path.basename(dir) === 'tests') continue;
      walk(abs, root, out);
    } else if (ent.isFile()) out.push({ abs, rel });
  }
  return out;
}

function isText(buf) {
  return !buf.subarray(0, 8000).includes(0);
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

const LINK_RE = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** Validate the repo at `root`. Returns a list of `{file, message}` problems. */
export function validate(root = REPO_ROOT) {
  const problems = [];
  const add = (file, message) => problems.push({ file, message });

  // Catalog freshness.
  const catalogPath = path.join(root, 'catalog.json');
  const expected = renderCatalog(root);
  let actual = null;
  try {
    actual = fs.readFileSync(catalogPath, 'utf8');
  } catch {
    actual = null;
  }
  if (actual === null) add('catalog.json', 'missing: run npm run catalog');
  else if (actual.replace(/\r\n/g, '\n') !== expected) add('catalog.json', 'stale: run npm run catalog');

  // Skills.
  const skillsDir = path.join(root, 'skills');
  let dirs = [];
  try {
    dirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    dirs = [];
  }
  for (const d of dirs) {
    const base = path.join(skillsDir, d.name);
    const rel = `skills/${d.name}`;
    if (!/^[a-z0-9-]+$/.test(d.name)) add(rel, 'folder name must match [a-z0-9-]+');
    const md = path.join(base, 'SKILL.md');
    if (!fs.existsSync(md)) add(rel, 'SKILL.md missing');
    else {
      const fm = parseFrontmatter(fs.readFileSync(md, 'utf8'));
      if (!fm) add(`${rel}/SKILL.md`, 'frontmatter missing');
      else {
        if (!fm.name) add(`${rel}/SKILL.md`, 'frontmatter name missing');
        else if (fm.name !== d.name) add(`${rel}/SKILL.md`, `frontmatter name "${fm.name}" differs from folder "${d.name}"`);
        if (!fm.description) add(`${rel}/SKILL.md`, 'frontmatter description missing');
      }
    }
    const sj = path.join(base, 'skill.json');
    if (!fs.existsSync(sj)) add(rel, 'skill.json missing');
    else {
      try {
        for (const p of skillJsonProblems(JSON.parse(fs.readFileSync(sj, 'utf8')), d.name)) add(`${rel}/skill.json`, p);
      } catch (err) {
        add(`${rel}/skill.json`, `invalid JSON: ${err.message}`);
      }
    }
    // Relative markdown links must stay inside the skill and resolve.
    for (const f of walk(base, base, [])) {
      if (!f.rel.endsWith('.md')) continue;
      const text = fs.readFileSync(f.abs, 'utf8');
      LINK_RE.lastIndex = 0;
      let m;
      while ((m = LINK_RE.exec(text))) {
        const target = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
        const clean = decodeURI(target.split('#')[0].split('?')[0]);
        if (!clean) continue;
        const where = `${rel}/${f.rel}`;
        if (path.isAbsolute(clean) || clean.startsWith('/')) {
          add(where, `absolute link: ${target}`);
          continue;
        }
        const resolved = path.resolve(path.dirname(f.abs), clean);
        const inside = path.relative(base, resolved);
        if (inside.startsWith('..') || path.isAbsolute(inside)) add(where, `link points outside the skill: ${target}`);
        else if (!fs.existsSync(resolved)) add(where, `broken link: ${target}`);
      }
    }
  }

  // Leaks in every text file.
  for (const f of walk(root, root, [])) {
    let buf;
    try {
      buf = fs.readFileSync(f.abs);
    } catch {
      continue;
    }
    if (buf.length > 2 * 1024 * 1024 || !isText(buf)) continue;
    for (const finding of scanText(buf.toString('utf8'))) {
      add(`${f.rel}:${finding.line}`, `possible leak (${finding.id}): ${finding.match}`);
    }
  }
  return problems;
}

function main() {
  const i = process.argv.indexOf('--root');
  const root = i !== -1 ? path.resolve(process.argv[i + 1]) : REPO_ROOT;
  const problems = validate(root);
  if (!problems.length) {
    process.stdout.write('validate: ok\n');
    return 0;
  }
  for (const p of problems) process.stderr.write(`${p.file}: ${p.message}\n`);
  process.stderr.write(`validate: ${problems.length} problem(s)\n`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();