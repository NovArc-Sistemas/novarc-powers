// Shared transcript reading pieces for the harness-doctor probes that read agent session logs.
// Zero dependencies, read-only. Nothing here returns message text: callers get flags, counts,
// command heads and names that pass SAFE_NAME.
import fs from 'node:fs';
import path from 'node:path';
import { IS_WIN, readdirSafe, statSafe, realpathSafe, normalizeInputPath } from './common.mjs';
import { encodeProjectPath } from './locations.mjs';

export const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'bash', 'shell', 'local_shell', 'exec_command']);
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'Search']);

// "No such file or directory" counts only for the executable itself: a shell reporting that it
// could not run the program, or a spawn/exec failure. `cat missing.txt` failing is not a missing command.
export const NOT_FOUND_RE = /command not found|is not recognized as (?:an internal or external command|the name of a cmdlet)|: not found\b|(?:^|\n)(?:\S*\/)?(?:bash|sh|zsh|dash|env)(?:: line \d+)?: [^\n:]+: No such file or directory|No such file or directory.*(?:exec|spawn)|ENOENT.*spawn|CommandNotFoundException/i;

// Correction markers, kept per language. A short real user message is a correction when it opens
// with a refusal word, or contains a "that is not it / again / undo" phrase anywhere.
//
// English "no" is spelled like the Portuguese contraction "no" (em + o: "no arquivo", "no
// projeto"), which opens ordinary instructions. So a bare "no" counts only as a reply of its own
// or when punctuation, a dash or a line break follows it ("No.", "no, use the other one"). "no"
// followed by a word never counts, in either language. Portuguese "não" / "nao" has no such twin
// and keeps the plain rule.
const NO_REPLY = /^\s*no(?=[ \t]*(?:[,.!?:;…]|[-–—](?:\s|$)|\r?\n|$))/i;
const START_WORDS = {
  en: ['stop', 'wrong', 'undo'],
  pt: ['não', 'nao', 'pare', 'errado', 'errada', 'desfaz', 'desfaça', 'desfaca'],
};
const CORRECTION_START = new RegExp(`^\\s*(?:${[...START_WORDS.en, ...START_WORDS.pt].join('|')})(?=[\\s,.!?:;]|$)`, 'i');
const CORRECTION_ANY = {
  en: /\b(?:wrong|again|that'?s not|that is not|not what|undo)\b/i,
  pt: /errad[oa]|de novo|desfa[zç]|isso não|isso nao|não é isso|nao e isso/i,
};
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
  return NO_REPLY.test(s) || CORRECTION_START.test(s) || CORRECTION_ANY.en.test(s) || CORRECTION_ANY.pt.test(s);
}

export function hookBlockText(text) {
  return /hook/i.test(text) && /\b(?:block(?:ed|ing)?|denied|deny|prevented|rejected)\b/i.test(text);
}

export function hookBlockAttachment(type) {
  const t = String(type || '').toLowerCase();
  if (!t.includes('hook') || /non[_-]?blocking/.test(t)) return false;
  return /blocking|denied|deny|block(?:ed)?(?:_|$)/.test(t);
}

/** Skill folder names referenced by paths like `.../skills/<name>/SKILL.md` (either slash) inside a string. */
export function skillsReadIn(s) {
  if (typeof s !== 'string' || !s.includes('SKILL.md')) return [];
  const out = [];
  const re = /skills[\\/]+([A-Za-z0-9_.-]{1,80})[\\/]+SKILL\.md/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1]);
  return out;
}

/** Claude Code turns an MCP server name into the `mcp__<name>__` tool prefix this way. */
export function normalizeMcpName(name) { return String(name).replace(/[^A-Za-z0-9_-]/g, '_'); }

// ---------------------------------------------------------------- command heads

const SKIP_HEADS = new Set(['cd', 'pushd', 'popd', 'set', 'export', 'source', '.', 'set-location', 'sl', 'chdir']);
const PREFIX_WORDS = new Set(['sudo', 'time', 'env', 'command', 'exec', 'nohup', '&', 'call', 'start']);
// CLIs whose second token is a subcommand (`git push`, `npm test`). For every other program the
// second token is an argument (a file, a database, a host, a message) and is never reported.
const SUBCOMMAND_CLIS = new Set([
  'git', 'gh', 'glab', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'deno', 'cargo', 'go', 'dotnet', 'mvn', 'mvnw', 'gradle', 'gradlew',
  'pip', 'pip3', 'pipx', 'uv', 'uvx', 'poetry', 'pdm', 'hatch', 'conda', 'docker', 'docker-compose', 'podman', 'kubectl', 'helm', 'minikube',
  'supabase', 'vercel', 'railway', 'netlify', 'wrangler', 'firebase', 'flyctl', 'fly', 'heroku', 'gcloud', 'aws', 'az', 'terraform', 'tofu', 'pulumi',
  'brew', 'winget', 'scoop', 'choco', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'rtk', 'rake', 'bundle', 'rails', 'composer', 'artisan',
  'flutter', 'dart', 'rustup', 'nvm', 'volta', 'corepack', 'turbo', 'nx', 'lerna', 'prisma', 'drizzle-kit', 'expo', 'eas', 'claude', 'codex',
  'make', 'just', 'task', 'systemctl', 'graphify', 'stripe', 'tsc', 'vitest', 'jest', 'playwright', 'pytest', 'ruff', 'mypy', 'eslint', 'prettier',
]);

/**
 * The head of a shell command: the executable's base name plus, for tools that take
 * subcommands, the second token when it is a plain lowercase word. Leading `cd ... &&`,
 * environment assignments and wrappers like `sudo` are skipped. Arguments never appear.
 */
export function commandHead(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  const firstLine = cmd.trim().split(/\r?\n/)[0];
  const segments = firstLine.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  for (let si = 0; si < segments.length; si++) {
    let toks = segments[si].split(/\s+/);
    while (toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0]) || PREFIX_WORDS.has(toks[0].toLowerCase()))) toks = toks.slice(1);
    if (!toks.length) continue;
    let exe = toks[0].replace(/^["'(]+|["')]+$/g, '');
    exe = exe.split(/[\\/]/).pop() || '';
    exe = exe.replace(/\.(exe|cmd|bat|ps1|sh)$/i, '');
    if (SKIP_HEADS.has(exe.toLowerCase()) && si < segments.length - 1) continue;
    if (!/^[A-Za-z0-9][\w.+-]{0,39}$/.test(exe)) return '<other>';
    const second = toks[1];
    if (second && SUBCOMMAND_CLIS.has(exe.toLowerCase()) && /^[a-z][a-z0-9-]{0,24}$/.test(second)) return `${exe} ${second}`;
    return exe;
  }
  return null;
}

/** Codex records commands as argv arrays; unwrap `bash -lc "<script>"` / `powershell -Command "<script>"`. */
export function codexCommandString(cmd) {
  if (typeof cmd === 'string') return cmd;
  if (!Array.isArray(cmd) || !cmd.length || !cmd.every((x) => typeof x === 'string')) return null;
  const exe = (cmd[0].split(/[\\/]/).pop() || '').toLowerCase().replace(/\.exe$/, '');
  if (['bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd'].includes(exe)) {
    const i = cmd.findIndex((a, idx) => idx > 0 && /^(-l?c|-command|\/c)$/i.test(a));
    if (i > 0 && cmd[i + 1] !== undefined) return cmd[i + 1];
  }
  return cmd.join(' ');
}

// ---------------------------------------------------------------- which project a transcript belongs to

function eqPath(a, b) { return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b; }

/** The project path as given plus its real path, when they differ (symlinked dirs, /var on macOS). */
export function projectRoots(projectRoot) {
  const rp = realpathSafe(projectRoot);
  return rp && !eqPath(rp, projectRoot) ? [projectRoot, rp] : [projectRoot];
}

/** Does a Claude `projects/<name>` dir belong to this project (itself or one of its worktrees)? */
export function matchesProjectDir(name, projectRoot) {
  return projectRoots(projectRoot).some((r) => matchesOneProjectDir(name, r));
}

function matchesOneProjectDir(name, projectRoot) {
  const enc = encodeProjectPath(projectRoot);
  const encName = encodeProjectPath(path.basename(projectRoot));
  const n = IS_WIN ? name.toLowerCase() : name;
  const e = IS_WIN ? enc.toLowerCase() : enc;
  const en = IS_WIN ? encName.toLowerCase() : encName;
  if (n === e) return true;
  if (n.startsWith(`${e}--`)) return true; // <project>/.claude/worktrees/..., <project>/.worktrees/...
  if (n.includes(`-worktrees-${en}-`) || n.endsWith(`-worktrees-${en}`)) return true;
  return false;
}

/** Does a Codex session cwd belong to this project? */
export function matchesProjectCwd(cwd, projectRoot) {
  if (typeof cwd !== 'string' || !cwd) return false;
  return projectRoots(projectRoot).some((r) => matchesOneCwd(cwd, r));
}

function matchesOneCwd(cwd, projectRoot) {
  const c = path.resolve(normalizeInputPath(cwd));
  if (eqPath(c, projectRoot)) return true;
  const withSep = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
  if ((IS_WIN ? c.toLowerCase() : c).startsWith(IS_WIN ? withSep.toLowerCase() : withSep)) return true;
  const segs = c.split(/[\\/]/).map((s) => (IS_WIN ? s.toLowerCase() : s));
  const name = IS_WIN ? path.basename(projectRoot).toLowerCase() : path.basename(projectRoot);
  const wi = segs.findIndex((s) => s === 'worktrees' || s === '.worktrees');
  return wi >= 0 && segs.slice(wi + 1).includes(name);
}

// ---------------------------------------------------------------- reading

/**
 * Stream a JSONL file. `want(head)` sees only the first HEAD_BYTES of a line (decoded as latin1) and
 * decides whether the line is worth decoding and parsing, so big irrelevant entries cost a byte
 * scan only. Only wanted lines that fail JSON.parse count as unparsable. Lines are split on raw
 * bytes: readline and full-string scans are several times slower on multi-megabyte lines.
 * Reading stops early when `onObj` returns exactly `false`.
 */
export const HEAD_BYTES = 512;
export async function eachJsonLine(file, onObj, { want = null, onUnparsable = null } = {}) {
  const input = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  let stop = false;
  const handle = (buf, start, end) => {
    if (end > start && buf[end - 1] === 13) end--;
    if (end <= start) return;
    if (want && !want(buf.toString('latin1', start, Math.min(end, start + HEAD_BYTES)))) return;
    let obj;
    try { obj = JSON.parse(buf.toString('utf8', start, end)); } catch { if (onUnparsable) onUnparsable(); return; }
    if (obj && typeof obj === 'object' && onObj(obj) === false) stop = true;
  };
  let pieces = [];
  try {
    for await (const chunk of input) {
      let start = 0;
      let i;
      while (!stop && (i = chunk.indexOf(10, start)) !== -1) {
        if (pieces.length) {
          pieces.push(chunk.subarray(start, i));
          const whole = Buffer.concat(pieces);
          pieces = [];
          handle(whole, 0, whole.length);
        } else handle(chunk, start, i);
        start = i + 1;
      }
      if (stop) break;
      if (start < chunk.length) pieces.push(chunk.subarray(start));
    }
    if (!stop && pieces.length) { const whole = Buffer.concat(pieces); handle(whole, 0, whole.length); }
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
