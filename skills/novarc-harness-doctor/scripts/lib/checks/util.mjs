// Pure helpers shared by the harness checks. No file system access here.
import { PATTERNS, mask } from '../../secret-scan.mjs';
import { scrubText } from '../common.mjs';

export const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Text that is safe to print as evidence: every secret-shaped value masked to its first four
 * characters, the home and project paths replaced with `~` and `.`, newlines collapsed, capped.
 */
export function safeSnippet(text, projectRoot, max = 160) {
  let s = String(text ?? '');
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    s = s.replace(p.re, (...args) => {
      const m = args[0];
      const groups = typeof args[args.length - 1] === 'object' ? args[args.length - 1] : null;
      if (groups && groups.v) return m.replace(groups.v, mask(groups.v));
      return mask(m);
    });
  }
  s = scrubText(s, projectRoot).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** 1-based line of the first occurrence of `needle` in `text`, or null. */
export function lineOf(text, needle, from = 0) {
  if (typeof text !== 'string' || !needle) return null;
  const i = text.indexOf(needle, from);
  if (i < 0) return null;
  return lineAt(text, i);
}

export function lineAt(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Line of a string value as it appears JSON-encoded in a settings file. */
export function lineOfJsonString(text, value) {
  if (typeof value !== 'string') return null;
  return lineOf(text, JSON.stringify(value).slice(1, -1)) ?? lineOf(text, value);
}

/** Line of a JSON key (`"key"`) in a settings file. */
export function lineOfJsonKey(text, key) {
  return lineOf(text, `"${key}"`);
}

/**
 * Minimal YAML front matter reader for SKILL.md / agent files: top-level `key: value` pairs,
 * quoted values, and `>` / `|` block scalars. Lists in `[a, b]` or `- a` form become arrays.
 */
export function frontmatter(text) {
  const src = String(text || '');
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(src);
  if (!m) return { data: {}, bodyStart: 0, body: src };
  const lines = m[1].split(/\r?\n/);
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (/^[>|][+-]?$/.test(val) || val === '') {
      const block = [];
      const list = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) {
        i++;
        const li = /^\s*-\s+(.*)$/.exec(lines[i]);
        if (li) list.push(unquote(li[1].trim()));
        else if (lines[i].trim()) block.push(lines[i].trim());
      }
      data[key] = list.length ? list : block.join(val.startsWith('|') ? '\n' : ' ').trim();
      continue;
    }
    if (/^\[.*\]$/.test(val)) { data[key] = val.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean); continue; }
    data[key] = unquote(val);
  }
  return { data, bodyStart: m[0].length, body: src.slice(m[0].length) };
}

function unquote(v) {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

/** Text without fenced code blocks and markdown table rows (what a reader would call prose). */
export function proseOnly(text) {
  return String(text || '')
    .replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*\|/.test(l))
    .join('\n');
}

/** Split a permission rule `Tool(spec)` into { tool, spec } (spec null when there are no parens). */
export function parseRule(rule) {
  const s = String(rule || '').trim();
  const m = /^([A-Za-z0-9_.-]+)\(([\s\S]*)\)$/.exec(s);
  if (m) return { tool: m[1], spec: m[2] };
  return { tool: s, spec: null };
}

/** Legacy `prefix:*` becomes `prefix *` so both syntaxes compare alike. */
export function normalizeSpec(spec) {
  if (spec === null || spec === undefined) return null;
  return spec.replace(/:\*$/, ' *').trim();
}

const PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS']);
const escapeRe = (x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Regex that a rule spec matches, using Claude Code's wildcard meaning for that tool. */
export function specRegex(tool, spec) {
  const legacyPrefix = /:\*$/.test(spec);
  const body = spec.replace(/:\*$/, '');
  if (PATH_TOOLS.has(tool)) {
    let out = '';
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '*' && body[i + 1] === '*') { out += '.*'; i++; }
      else if (body[i] === '*') out += '[^/]*';
      else out += escapeRe(body[i]);
    }
    return new RegExp(`^${out}$`);
  }
  const out = body.split('*').map(escapeRe).join('.*');
  return new RegExp(legacyPrefix ? `^${out}( .*)?$` : `^${out}$`);
}

/**
 * Does the allow rule `broad` already allow everything `narrow` allows?
 * Conservative: true only when the narrow rule's text (wildcards read literally) is matched by the
 * broad rule's pattern, so a true result is a real redundancy.
 */
export function ruleCovers(broad, narrow) {
  const b = parseRule(broad);
  const n = parseRule(narrow);
  if (b.spec === null) {
    if (n.tool === b.tool) return n.spec !== null; // `Bash` covers `Bash(x)`
    return b.tool.startsWith('mcp__') && n.tool.startsWith(`${b.tool}__`);
  }
  if (b.tool !== n.tool || n.spec === null) return false;
  if (/^\*+$/.test(b.spec.trim())) return true;
  const re = specRegex(b.tool, b.spec);
  return re.test(normalizeSpec(n.spec)) || re.test(n.spec);
}

/** Split a shell command into rough tokens, keeping quoted strings together. */
export function shellTokens(cmd) {
  return (String(cmd || '').match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
}

export function bySeverityThenId(a, b) {
  return (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    || a.id.localeCompare(b.id)
    || String(a.file).localeCompare(String(b.file))
    || (a.line ?? 0) - (b.line ?? 0)
    || String(a.evidence).localeCompare(String(b.evidence));
}

/** Build a finding from a check definition and the place it was found. */
export function finding(def, where, evidence, extra = {}) {
  return {
    id: def.id,
    round: def.round,
    severity: extra.severity || def.severity,
    origin: where.origin,
    file: where.display,
    line: extra.line ?? where.line ?? null,
    title: extra.title || def.title,
    evidence,
    why: extra.why || def.why,
    fix: extra.fix || def.fix,
    docs: `references/checks.md#${def.id}`,
  };
}
