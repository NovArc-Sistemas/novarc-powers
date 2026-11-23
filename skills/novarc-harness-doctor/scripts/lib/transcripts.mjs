// Shared transcript reading pieces for the harness-doctor probes that read agent session logs.
// Zero dependencies, read-only. Nothing here returns message text: callers get flags, counts,
// command heads and names that pass SAFE_NAME.
import fs from 'node:fs';
import path from 'node:path';
import { readdirSafe, statSafe } from './common.mjs';

export const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'bash', 'shell', 'local_shell', 'exec_command']);
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'Search']);

// "No such file or directory" counts only for the executable itself: a shell reporting that it
// could not run the program, or a spawn/exec failure. `cat missing.txt` failing is not a missing command.
export const NOT_FOUND_RE = /command not found|is not recognized as (?:an internal or external command|the name of a cmdlet)|: not found\b|(?:^|\n)(?:\S*\/)?(?:bash|sh|zsh|dash|env)(?:: line \d+)?: [^\n:]+: No such file or directory|No such file or directory.*(?:exec|spawn)|ENOENT.*spawn|CommandNotFoundException/i;
// Correction markers (pt/en). A short real user message that starts with a refusal word, or
// contains a "that is not it / again / undo" phrase anywhere.
const CORRECTION_START = /^\s*(?:no|não|nao|stop|pare|wrong|errado|errada|undo|desfaz|desfa[çc]a)(?=[\s,.!?:;]|$)/i;
const CORRECTION_ANY = /\b(?:wrong|again|that'?s not|that is not|not what|undo)\b|errad[oa]|de novo|desfa[zç]|isso não|isso nao|não é isso|nao e isso/i;
export const CORRECTION_MAX_CHARS = 280;
export const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:\-/]{0,99}$/;

export function safeName(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return SAFE_NAME.test(t) ? t : '<other>';
}

/** Text of a tool_result content (string or array of blocks). Stays in memory; never printed. */
export function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
  return '';
}

/** A message a person typed (not a command wrapper, caveat, interruption marker or system tag). */
export function isHumanText(t) {
  if (typeof t !== 'string') return false;
  const s = t.trim();
  if (!s) return false;
  if (s.startsWith('<') || s.startsWith('Caveat:') || s.startsWith('[Request interrupted')) return false;
  return true;
}

export function isCorrection(t) {
  const s = String(t).trim();
  if (s.length >= CORRECTION_MAX_CHARS) return false;
  return CORRECTION_START.test(s) || CORRECTION_ANY.test(s);
}

export function hookBlockText(text) {
  return /hook/i.test(text) && /\b(?:block(?:ed|ing)?|denied|deny|prevented|rejected)\b/i.test(text);
}

export function hookBlockAttachment(type) {
  const t = String(type || '').toLowerCase();
  if (!t.includes('hook') || /non[_-]?blocking/.test(t)) return false;
  return /blocking|denied|deny|block(?:ed)?(?:_|$)/.test(t);
}

/** Skill folder names referenced by paths like `.../skills/<name>/SKILL.md` inside a string. */
export function skillsReadIn(s) {
  if (typeof s !== 'string' || !s.includes('SKILL.md')) return [];
  const out = [];
  const re = /skills[\/]+([A-Za-z0-9_.-]{1,80})[\/]+SKILL\.md/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1]);
  return out;
}

/** Claude Code turns an MCP server name into the `mcp__<name>__` tool prefix this way. */
export function normalizeMcpName(name) { return String(name).replace(/[^A-Za-z0-9_-]/g, '_'); }

/**
 * Stream a JSONL file. `want(head)` sees only the first HEAD_BYTES of a line (decoded as latin1) and
 * decides whether the line is worth decoding and parsing, so big irrelevant entries cost a byte
 * scan only. Only wanted lines that fail JSON.parse count as unparsable. Lines are split on raw
 * bytes: readline and full-string scans are several times slower on multi-megabyte lines.
 */
export const HEAD_BYTES = 512;
export async function eachJsonLine(file, onObj, { want = null, onUnparsable = null } = {}) {
  const input = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  const handle = (buf, start, end) => {
    if (end > start && buf[end - 1] === 13) end--;
    if (end <= start) return;
    if (want && !want(buf.toString('latin1', start, Math.min(end, start + HEAD_BYTES)))) return;
    let obj;
    try { obj = JSON.parse(buf.toString('utf8', start, end)); } catch { if (onUnparsable) onUnparsable(); return; }
    if (obj && typeof obj === 'object') onObj(obj);
  };
  let pieces = [];
  try {
    for await (const chunk of input) {
      let start = 0;
      let i;
      while ((i = chunk.indexOf(10, start)) !== -1) {
        if (pieces.length) {
          pieces.push(chunk.subarray(start, i));
          const whole = Buffer.concat(pieces);
          pieces = [];
          handle(whole, 0, whole.length);
        } else handle(chunk, start, i);
        start = i + 1;
      }
      if (start < chunk.length) pieces.push(chunk.subarray(start));
    }
    if (pieces.length) { const whole = Buffer.concat(pieces); handle(whole, 0, whole.length); }
  } finally {
    input.destroy();
  }
}

/**
 * Claude transcripts of one `projects/<dir>`: top-level `<sid>.jsonl` plus subagent threads under
 * `<sid>/subagents/**` (`agent-*.jsonl`). Subagents carry their parent's session id.
 * Files whose mtime is older than `cutoff` are skipped.
 */
export function listClaudeTranscripts(projectDir, cutoff) {
  const out = [];
  for (const e of readdirSafe(projectDir)) {
    const full = path.join(projectDir, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      const st = statSafe(full);
      if (st && st.mtimeMs >= cutoff) out.push({ file: full, sessionId: e.name.slice(0, -6), sidechainFile: false });
    } else if (e.isDirectory()) {
      const stack = [[path.join(full, 'subagents'), 0]];
      while (stack.length) {
        const [d, depth] = stack.pop();
        for (const s of readdirSafe(d)) {
          const f = path.join(d, s.name);
          if (s.isDirectory()) { if (depth < 3) stack.push([f, depth + 1]); continue; }
          if (!s.isFile() || !/^agent-.*\.jsonl$/.test(s.name)) continue;
          const st = statSafe(f);
          if (st && st.mtimeMs >= cutoff) out.push({ file: f, sessionId: e.name, sidechainFile: true });
        }
      }
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** Every `*.jsonl` under `dir` up to `maxDepth`, mtime >= cutoff, sorted. */
export function listJsonl(dir, maxDepth, cutoff) {
  const out = [];
  const stack = [[dir, 0]];
  while (stack.length) {
    const [d, depth] = stack.pop();
    for (const e of readdirSafe(d)) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < maxDepth) stack.push([full, depth + 1]); continue; }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const st = statSafe(full);
      if (st && st.mtimeMs >= cutoff) out.push(full);
    }
  }
  return out.sort();
}

/** Run `fn` over `items` with at most `size` in flight. Results keep input order. */
export async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}
