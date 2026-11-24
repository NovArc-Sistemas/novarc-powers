// Shared transcript reading pieces for the harness-doctor probes that read agent session logs.
// Zero dependencies, read-only. Nothing here prints. What a caller gets to print is flags, counts,
// command heads and names that pass SAFE_NAME; a result text, a command or a line that could not
// be parsed is handed over only to be tested in memory.
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

// ---------------------------------------------------------------- Codex tool calls

// A Codex rollout records one tool call in up to three shapes, depending on the CLI version and
// on who made the call:
//   response_item  `function_call`, `custom_tool_call`, `local_shell_call` (and their `*_output`
//                  items), keyed by `call_id`: what the model asked for;
//   event_msg      `exec_command_end`, `mcp_tool_call_end`, keyed by `call_id`: the completion
//                  events of older versions;
//   event_msg      `item_completed` with a `CommandExecution` or `McpToolCall` item, keyed by the
//                  item `id`: the call id when the model made the call itself, an id of its own
//                  when a script tool made it.
// Records that share an id are one call, so a call written in two shapes is counted once.

/** Tools whose `response_item` call carries a shell command. A script tool (`exec`) is not one. */
const CODEX_SHELL_TOOLS = new Set(['shell', 'local_shell', 'exec_command', 'shell_command', 'container.exec']);
// Record kinds that can hold a tool call and are not read here: a completed item of another
// `...Call` / `...Execution` type (the only record a call made from inside a script tool leaves),
// and another MCP or exec end event. They are counted, never guessed at. Events of other tools
// are left alone: a call the model makes itself is always a response_item too.
const CODEX_ITEM_CALL_LIKE = /(?:Call|Execution)$/;
const CODEX_EVENT_CALL_LIKE = /^(?:mcp|exec)_[a-z_]*_end$/;

function timeOf(ts) {
  if (typeof ts !== 'string') return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

function codexText(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
  if (v && typeof v === 'object' && typeof v.content === 'string') return v.content;
  return '';
}

/**
 * What the output item of a Codex shell call says: whether the command failed and the command's
 * own output. Older rollouts wrap both in JSON (`{"output": "...", "metadata": {"exit_code": 1}}`);
 * newer ones put a short header before the output (`Exit code: 1` or `Process exited with code 1`,
 * then `Output:`). An output that names no exit code is not a failure. The text stays in memory.
 */
export function codexShellOutput(output) {
  const raw = codexText(output);
  const refused = !!output && typeof output === 'object' && !Array.isArray(output) && output.success === false;
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object' && !Array.isArray(j) && (typeof j.output === 'string' || (j.metadata && typeof j.metadata === 'object'))) {
        const code = j.metadata && typeof j.metadata === 'object' && typeof j.metadata.exit_code === 'number' ? j.metadata.exit_code : null;
        return { failed: code !== null ? code !== 0 : refused, text: typeof j.output === 'string' ? j.output : '' };
      }
    } catch { /* plain text that happens to open with a brace */ }
  }
  let code = null;
  let from = 0;
  let pos = 0;
  for (let n = 0; n < 8; n++) { // the header is a few short lines; the command's own output is never searched
    const end = raw.indexOf('\n', pos);
    const line = (end === -1 ? raw.slice(pos) : raw.slice(pos, end)).trimEnd();
    const m = /^(?:Exit code:|Process exited with code) (-?\d+)$/.exec(line);
    if (m && code === null) code = Number(m[1]);
    if (line === 'Output:') { from = end === -1 ? raw.length : end + 1; break; }
    if (end === -1) break;
    pos = end + 1;
  }
  return { failed: code !== null ? code !== 0 : refused, text: raw.slice(from) };
}

/** The shell command a `response_item` call carries, or null when it has none that can be read. */
function codexCallCommand(p) {
  if (p.type === 'local_shell_call') return codexCommandString(p.action && typeof p.action === 'object' ? p.action.command : null);
  let a = p.arguments;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return null; } }
  if (!a || typeof a !== 'object') return null;
  return codexCommandString(a.command !== undefined ? a.command : a.cmd);
}

/**
 * Reads the tool calls of ONE Codex rollout, one per call id, whichever shapes recorded them.
 * Feed every parsed line to `read`; `calls` then holds each call once, in the order it was first
 * seen:
 *   { id, ts, name, shell, command, mcp: { server, tool } | null, done, failed, text, outChars }
 * `ts` is the time of the first record that mentions the call, `name` the tool name a
 * `response_item` gave it (null when only its completion was recorded), `done` whether an outcome
 * was read (shell calls only). `command` and `text` are never to be printed.
 * `unrecognized` counts, per record kind (`item:<type>`, `event:<type>`, `<kind>:no-server`), the
 * records that look like a tool call in a shape this reader does not know: with any of those,
 * "this tool was never called" is not established.
 */
export function codexCallReader() {
  const byId = new Map();
  const calls = [];
  const unrecognized = new Map();
  const odd = (kind) => { unrecognized.set(kind, (unrecognized.get(kind) || 0) + 1); return null; };
  const open = (id, ts) => {
    const key = typeof id === 'string' && id ? id : null;
    let call = key !== null ? byId.get(key) : undefined;
    if (call) return { call, created: false };
    call = { id: key, ts, name: null, shell: false, command: null, mcp: null, done: false, sure: false, failed: false, text: '', outChars: 0 };
    calls.push(call);
    if (key !== null) byId.set(key, call);
    return { call, created: true };
  };
  // The outcome a completion event reports is kept over the one read from an output item.
  const settle = (call, failed, text, outChars, sure) => {
    const first = !call.done;
    if (first || (sure && !call.sure)) { call.failed = failed; call.text = text; call.outChars = outChars; call.sure = sure; }
    call.done = true;
    return first;
  };
  const command = (id, ts, cmd, o) => {
    const { call, created } = open(id, ts);
    call.shell = true;
    if (call.command === null) call.command = codexCommandString(cmd);
    const failed = (typeof o.exit_code === 'number' && o.exit_code !== 0) || o.status === 'failed';
    const out = typeof o.aggregated_output === 'string' ? o.aggregated_output : typeof o.stdout === 'string' ? o.stdout : '';
    const completed = settle(call, failed, `${typeof o.stderr === 'string' ? o.stderr : ''}\n${out}`, out.length, true);
    return { call, created, completed };
  };
  const mcpCall = (id, ts, inv, kind) => {
    if (!inv || typeof inv !== 'object' || typeof inv.server !== 'string' || !inv.server) return odd(`${kind}:no-server`);
    const { call, created } = open(id, ts);
    call.mcp = { server: inv.server, tool: typeof inv.tool === 'string' ? inv.tool : '' }; // the event names the real server
    return { call, created, completed: false };
  };
  return {
    calls,
    unrecognized,
    /** True while a shell call with this id has no outcome yet: only then is its output item worth parsing. */
    awaits(id) {
      const call = byId.get(id);
      return !!call && call.shell && !call.done;
    },
    /** Read one parsed rollout line. Returns `{ call, created, completed }` when it is a tool call record, else null. */
    read(o) {
      const p = o && o.payload && typeof o.payload === 'object' ? o.payload : null;
      if (!p || typeof p.type !== 'string') return null;
      const ts = timeOf(o.timestamp);
      if (o.type === 'response_item') {
        if (p.type.endsWith('_call_output')) {
          const call = typeof p.call_id === 'string' ? byId.get(p.call_id) : undefined;
          if (!call || !call.shell) return null; // only a command's outcome is counted
          const out = codexShellOutput(p.output);
          return { call, created: false, completed: settle(call, out.failed, out.text, out.text.length, false) };
        }
        if (!p.type.endsWith('_call')) return null;
        const { call, created } = open(p.call_id, ts);
        const name = p.type === 'local_shell_call' ? 'local_shell' : typeof p.name === 'string' && p.name ? p.name : p.type.slice(0, -5);
        const ns = typeof p.namespace === 'string' ? p.namespace.replace(/_+$/, '') : '';
        let mcp = null;
        if (ns.startsWith('mcp__') && ns.length > 5) mcp = { server: ns.slice(5), tool: name };
        else if (!ns && name.startsWith('mcp__')) {
          const end = name.indexOf('__', 5);
          if (end > 5) mcp = { server: name.slice(5, end), tool: name.slice(end + 2) };
        }
        if (call.name === null) call.name = ns && !mcp ? `${ns}.${name}` : name;
        if (mcp && call.mcp === null) call.mcp = mcp;
        if (!mcp && !ns && (p.type === 'local_shell_call' || CODEX_SHELL_TOOLS.has(name))) {
          call.shell = true;
          if (call.command === null) call.command = codexCallCommand(p);
        }
        return { call, created, completed: false };
      }
      if (o.type !== 'event_msg') return null;
      if (p.type === 'item_completed') {
        const item = p.item && typeof p.item === 'object' ? p.item : null;
        if (!item || typeof item.type !== 'string') return null;
        if (item.type === 'CommandExecution') return command(item.id, ts, item.command, item);
        if (item.type === 'McpToolCall') return mcpCall(item.id, ts, item, 'McpToolCall');
        return CODEX_ITEM_CALL_LIKE.test(item.type) ? odd(`item:${item.type}`) : null;
      }
      if (p.type === 'exec_command_end') return command(p.call_id, ts, p.command, p);
      if (p.type === 'mcp_tool_call_end') return mcpCall(p.call_id, ts, p.invocation, 'mcp_tool_call_end');
      return CODEX_EVENT_CALL_LIKE.test(p.type) ? odd(`event:${p.type}`) : null;
    },
  };
}

/**
 * The name a Codex call is counted under: `mcp__<server>__<tool>` for an MCP call (the way Claude
 * Code names one, so both agents count under one key shape), else the tool name the rollout
 * records, else `exec_command` for a command known only from its completion record.
 */
export function codexCallName(call) {
  if (call.mcp) return `mcp__${normalizeMcpName(call.mcp.server)}__${SAFE_NAME.test(call.mcp.tool) ? call.mcp.tool : 'unnamed'}`;
  return call.name !== null ? call.name : 'exec_command';
}

/**
 * Decide from the first bytes of a rollout line whether it can be a tool call record. An output
 * item is wanted only while a shell call waits for it: the outputs of other tools are large and
 * say nothing that is counted.
 */
export function codexCallLine(head, reader) {
  if (/"type"\s*:\s*"(?:mcp|exec)_[a-z_]*_end"/.test(head)) return true;
  if (!head.includes('"response_item"')) return false;
  const m = /"payload"\s*:\s*\{\s*"type"\s*:\s*"([^"]*)"/.exec(head);
  if (!m) return true; // the item type is not where it usually is: parse the line to find out
  if (m[1].endsWith('_call')) return true;
  if (!m[1].endsWith('_call_output')) return false;
  const id = /"call_id"\s*:\s*"([^"]*)"/.exec(head);
  return id ? reader.awaits(id[1]) : true;
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
 * scan only. Only wanted lines that fail JSON.parse count as unparsable; `onUnparsable` gets the
 * line's text, so a caller can still search what it could not read (it must never print it).
 * Lines are split on raw bytes: readline and full-string scans are several times slower on
 * multi-megabyte lines. Reading stops early when `onObj` returns exactly `false`.
 */
export const HEAD_BYTES = 512;
export async function eachJsonLine(file, onObj, { want = null, onUnparsable = null } = {}) {
  const input = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  let stop = false;
  const handle = (buf, start, end) => {
    if (end > start && buf[end - 1] === 13) end--;
    if (end <= start) return;
    if (want && !want(buf.toString('latin1', start, Math.min(end, start + HEAD_BYTES)))) return;
    const text = buf.toString('utf8', start, end);
    let obj;
    try { obj = JSON.parse(text); } catch { if (onUnparsable) onUnparsable(text); return; }
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
