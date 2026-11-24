#!/usr/bin/env node
// secret-scan.mjs <path...> [--max-bytes N]
//
// Walks files and directories and reports likely credentials as { file, line, pattern, masked }.
// It never prints the matched line or the full value: `masked` is the first 4 characters, an
// ellipsis and the value's length. Skips node_modules, .git, binary files and files over 2 MB by
// default. Symlinked directories are not followed (config dirs often link to large trees such
// as transcripts); symlinked files are scanned once, by real path. `--help` prints the usage.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, isMain, printJson, warn, displayPath, normalizeInputPath, lstatSafe, statSafe, realpathSafe, IS_WIN } from './lib/common.mjs';

/**
 * Patterns, most specific first: a match that overlaps an earlier one on the same line is dropped.
 * When a pattern has a capture group named `v`, only that group is the secret (and is masked);
 * otherwise the whole match is.
 */
export const PATTERNS = [
  { id: 'private-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g },
  { id: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'stripe-live-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g },
  { id: 'openai-style-key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'supabase-token', re: /\bsbp_[A-Za-z0-9]{20,}\b/g },
  { id: 'slack-token', re: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: 'google-api-key', re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g },
  { id: 'generic-assignment', re: /(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?(?<v>[A-Za-z0-9_\-]{16,})/gi },
];

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);
const MAX_FINDINGS = 2000;

export function mask(value) {
  const v = String(value);
  return `${v.slice(0, 4)}…${v.length}`;
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// The same patterns with match indices, so a match can be replaced where it stands.
const INDEXED = PATTERNS.map((p) => ({ id: p.id, re: new RegExp(p.re.source, p.re.flags.includes('d') ? p.re.flags : `${p.re.flags}d`) }));

/** Matches on one line: [{ pattern, value, start, end }], `start..end` being the secret itself. */
function lineMatches(line) {
  const out = [];
  const taken = [];
  for (const p of INDEXED) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(line)) !== null) {
      if (m[0].length === 0) { p.re.lastIndex++; continue; }
      const a = m.index;
      const b = m.index + m[0].length;
      if (taken.some(([x, y]) => a < y && b > x)) continue;
      taken.push([a, b]);
      const [start, end] = m.indices.groups && m.indices.groups.v ? m.indices.groups.v : m.indices[0];
      out.push({ pattern: p.id, value: line.slice(start, end), start, end });
    }
  }
  return out;
}

/**
 * Scan one text; returns [{ line, pattern, masked }]. Pure: used by the CLI and by tests.
 * Lines longer than `maxLineLength` are skipped (minified blobs; not config); pass Infinity to
 * scan everything.
 */
export function scanText(text, { maxLineLength = 100000 } = {}) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    if (line.length > maxLineLength) continue;
    for (const m of lineMatches(line)) out.push({ line: ln + 1, pattern: m.pattern, masked: mask(m.value) });
  }
  return out;
}

/**
 * `text` with every match replaced by its masked form. The number of lines never changes. Only
 * the marker line of a private key matches a pattern: its body is the job of
 * lib/snapshot/mask.mjs, which knows where a key block ends.
 */
export function redactText(text) {
  return String(text).split('\n').map((line) => {
    const spans = lineMatches(line).sort((x, y) => x.start - y.start);
    if (!spans.length) return line;
    let out = '';
    let pos = 0;
    for (const s of spans) {
      if (s.start < pos) continue;
      out += line.slice(pos, s.start) + mask(s.value);
      pos = s.end;
    }
    return out + line.slice(pos);
  }).join('\n');
}

export function scanPaths(inputs, { maxBytes = DEFAULT_MAX_BYTES, projectRoot } = {}) {
  const findings = [];
  const skipped = { binary: 0, tooLarge: 0, unreadable: 0, symlinkedDirs: 0, missing: 0 };
  const seen = new Set();
  let filesScanned = 0;
  let truncated = false;

  const visitFile = (p) => {
    const rp = realpathSafe(p) || p;
    const key = IS_WIN ? rp.toLowerCase() : rp;
    if (seen.has(key)) return;
    seen.add(key);
    const st = statSafe(p);
    if (!st) { skipped.unreadable++; return; }
    if (st.size > maxBytes) { skipped.tooLarge++; return; }
    let buf;
    try { buf = fs.readFileSync(p); } catch { skipped.unreadable++; return; }
    if (isBinary(buf)) { skipped.binary++; return; }
    filesScanned++;
    for (const f of scanText(buf.toString('utf8'))) {
      if (findings.length >= MAX_FINDINGS) { truncated = true; return; }
      findings.push({ file: displayPath(p, projectRoot), ...f });
    }
  };

  const walk = (dir, top) => {
    const ls = lstatSafe(dir);
    if (!ls) { skipped.missing++; return; }
    if (ls.isSymbolicLink() && !top) {
      const s = statSafe(dir);
      if (s && s.isDirectory()) { skipped.symlinkedDirs++; return; }
      if (s && s.isFile()) visitFile(dir);
      return;
    }
    const st = statSafe(dir);
    if (!st) { skipped.missing++; return; }
    if (st.isFile()) { visitFile(dir); return; }
    if (!st.isDirectory()) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { skipped.unreadable++; return; }
    for (const e of ents) {
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), false);
    }
  };

  for (const input of inputs) walk(normalizeInputPath(input), true);
  return { filesScanned, findings, truncated, skipped };
}

const USAGE = 'usage: secret-scan.mjs <path...> [--max-bytes N] [--project-root <dir>]';

function main() {
  if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
    process.stdout.write(`${USAGE}

Reports likely credentials in files and folders as { file, line, pattern, masked }. It never prints a value.
`);
    return;
  }
  const args = parseArgs();
  if (!args._.length) {
    warn(USAGE);
    process.exit(2);
  }
  const maxBytes = args['max-bytes'] ? Number(args['max-bytes']) : DEFAULT_MAX_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) { warn('--max-bytes must be a positive number'); process.exit(2); }
  const projectRoot = args['project-root'] ? normalizeInputPath(args['project-root']) : undefined;
  const res = scanPaths(args._, { maxBytes, projectRoot });
  printJson({ scannedAt: new Date().toISOString(), patterns: PATTERNS.map((p) => p.id), ...res });
}

if (isMain(import.meta.url)) main();
