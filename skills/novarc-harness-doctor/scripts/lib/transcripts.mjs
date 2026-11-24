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

// ---------------------------------------------------------------- corrections
//
// A correction is a real user message that tells the agent its work was wrong. It counts only when
// all of these hold, and when unsure it does not count:
//   (a) work: the assistant issued at least one tool call in the same thread since the previous
//       real user message;
//   (b) not a question: it does not end with "?" and does not open with a question form ("por
//       que", "dá pra", "não dá pra", "can you", "why", ...);
//   (c) not a short answer: when the assistant's last text before it asked something (its last
//       paragraph has a "?") or offered options (a numbered or lettered list with a word about
//       choosing), a reply of SHORT_ANSWER_WORDS words or fewer is an answer, not a correction;
//   (d) a marker about the work, pt or en: "não era isso", "está errado", "desfaz", "volta como
//       estava", "você apagou/quebrou/mudou", "eu disse/pedi", "não mexe/não faça", "that's wrong",
//       "revert", "undo", "I said/asked", "don't touch", "you broke"... A bare leading "não" or
//       "no" is not a marker: it opens answers ("não precisa agora") as often as corrections.
//   It is also shorter than CORRECTION_MAX_CHARS characters.
export const CORRECTION_MAX_CHARS = 280;
export const SHORT_ANSWER_WORDS = 12;
// Accented letters are not word characters for `\b`, so a word end is spelled out.
const END = '(?=[\\s,.!?:;…)"\'”]|$)';
const rx = (src) => new RegExp(src, 'i');
const QUESTION_START = [
  rx(`^\\s*(?:why|how|what|which|when|where|who|whose|can|could|would|should|shall|is|are|was|were|does|did|will|have|has|isn'?t|aren'?t|wasn'?t|doesn'?t|didn'?t|won'?t|wouldn'?t|shouldn'?t|couldn'?t|can'?t|any idea|do(?!\\s+not\\b))${END}`),
  rx(`^\\s*(?:por ?qu[eê]|pq|como|qual|quais|quando|onde|aonde|quem|quanto|quantos|quantas|o que|que tal|ser[áa](?: que)?|d[áa] (?:pra|para)|tem como|teria como|pode|podemos|poderia|consegue|conseguimos|voc[êe] (?:pode|poderia|consegue|acha|sabe)|n[ãa]o (?:d[áa]|daria|seria|tem como|era melhor|ficaria|poderia|pode|consegue|deveria|devia)|e se)${END}`),
];
const CORRECTION_MARKERS = {
  pt: [
    rx(`(?:^|[\\s,.;:])n[ãa]o (?:era|é|e|foi) (?:isso|assim|bem isso|o que eu|isso que eu|esse|essa|esse aqui|essa aqui)${END}`),
    rx(`(?:^|[\\s,.;:])(?:est[áa]|t[áa]|ficou|ficaram|est[ãa]o)(?: tudo| todo| toda)? errad[oa]s?${END}`),
    rx(`^\\s*(?:isso est[áa] |isso t[áa] |tudo )?errad[oa]s?${END}`),
    rx(`(?:^|[\\s,.;:])(?:desfa(?:z|[çc]a|zer|[çc]am)|revert(?:e|a|er)|reverte isso)${END}`),
    rx(`(?:^|[\\s,.;:])volt(?:a|e|ar) (?:como (?:estava|era)|ao que (?:estava|era)|pro que (?:estava|era)|atr[áa]s|isso|a vers[ãa]o anterior|o que (?:voc[êe] )?(?:fez|mudou|apagou))${END}`),
    rx(`(?:^|[\\s,.;:])voc[êe] (?:mudou|apagou|quebrou|removeu|deletou|tirou|alterou|estragou|sobrescreveu|reverteu|esqueceu|ignorou|errou)${END}`),
    rx(`(?:^|[\\s,.;:])eu (?:disse|pedi|falei|mandei|tinha (?:dito|pedido|falado))${END}`),
    rx(`(?:^|[\\s,.;:])n[ãa]o (?:fa[çc]a|faz isso|fazer isso|mexe|mexa|mude|altere|apague|apaga|toque|remova|delete|precisava|pedi|mandei)${END}`),
    rx(`(?:^|[\\s,.;:])par[ae] de [a-zà-ú]+(?:ar|er|ir)${END}`),
    rx(`^\\s*pare${END}`),
    rx(`^\\s*isso n[ãa]o(?=\\s*(?:[,.!:;…]|$))`),
  ],
  en: [
    rx(`\\bthat(?:'s| is| was) (?:not (?:it|what|right|correct)|wrong)${END}`),
    rx(`\\bnot what I (?:asked|wanted|meant|said)${END}`),
    rx(`\\b(?:this|it)(?:'s| is| was) wrong${END}`),
    rx(`\\bwrong (?:file|place|one|approach|thing|branch|function|directory|folder|path|command|name|way)${END}`),
    rx(`^\\s*wrong${END}`),
    rx(`\\b(?:revert|undo)${END}`),
    rx(`\\b(?:roll (?:it |that |this )?back|put (?:it|that|this) back)${END}`),
    rx(`\\bI (?:said|asked|told you|meant|did not ask|didn'?t ask)${END}`),
    rx(`\\b(?:don'?t|do not|never) (?:touch|change|do that|modify|delete|remove|edit|rename|move)${END}`),
    rx(`\\bstop (?:doing|changing|editing|touching|deleting)${END}`),
    rx(`^\\s*stop(?=\\s*(?:[,.!:;…]|$))`),
    rx(`\\byou (?:broke|deleted|removed|changed|reverted|overwrote|messed up|forgot|ignored|undid)${END}`),
  ],
};
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

/** A user message that asks something: it ends with "?" or opens with a question form. */
export function isQuestion(t) {
  const s = String(t).trim().replace(/[\s)"'”»*_]+$/, '');
  return s.endsWith('?') || QUESTION_START.some((r) => r.test(s));
}

const OPTION_ITEM = /^\s*(?:\d{1,2}[.)]|\(?[a-dA-D]\)|[a-dA-D]\.)\s+\S/gm;
const CHOICE_WORD = /\b(?:options?|choose|pick|prefer|which one)\b|op[çc](?:[ãa]o|[õo]es)|escolh|prefere|qual (?:delas|deles|voc[êe])/i;
/**
 * Whether an assistant text asks the user something: its last paragraph has a "?", or it lists
 * two or more numbered / lettered options and says something about choosing. Only this flag is
 * kept; the text itself is never stored.
 */
export function asksUser(text) {
  if (typeof text !== 'string') return false;
  const s = text.trim();
  if (!s) return false;
  const last = s.split(/\n\s*\n/).pop();
  if (last.includes('?')) return true;
  const items = s.match(OPTION_ITEM);
  return !!items && items.length >= 2 && CHOICE_WORD.test(s);
}

/**
 * Whether a real user message corrects the work (see the rule above). `work`: the assistant made
 * a tool call in this thread since the previous user message; `asked`: the assistant's last text
 * before it asked something. The defaults (work, no question asked) are for testing the markers.
 */
export function isCorrection(t, { work = true, asked = false } = {}) {
  const s = String(t).trim();
  if (!s || s.length >= CORRECTION_MAX_CHARS || !work) return false;
  if (isQuestion(s)) return false;
  if (asked && s.split(/\s+/).length <= SHORT_ANSWER_WORDS) return false;
  return CORRECTION_MARKERS.pt.some((r) => r.test(s)) || CORRECTION_MARKERS.en.some((r) => r.test(s));
}

// ---------------------------------------------------------------- hook outcomes
//
// What a hook did is read only from structured transcript fields, never from the text of a tool
// result (a result that merely mentions "hook" and "blocked" says nothing about a hook):
//   - a tool_result line whose `permissionDecision` is a rejection made by a hook (`source` or
//     `reasonType` "hook", or a `reasonCode` "hook:<Event>"): a hook denied that tool call before
//     it ran. A permission decision only exists before a call runs, so it is a denial whatever
//     event it names (PreToolUse when it says none);
//   - a `hook_blocking_error` attachment, classified by its `hookEvent` (or the event part of its
//     `hookName`, "PreToolUse:Bash"): PreToolUse / PermissionRequest denied the call its
//     `toolUseID` names; Stop / SubagentStop blocked the end of a response, which makes the agent
//     keep working (the hook doing its job); UserPromptSubmit blocked a prompt; any other event is
//     neutral, and no event at all is unknown;
//   - a `hook_stopped_continuation` attachment, or a `stop_hook_summary` system line with
//     `preventedContinuation`, is a hook that stopped the agent.
export const HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop', 'SubagentStop', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Notification', 'PreCompact', 'SubagentStart']);
const DENYING_EVENTS = new Set(['PreToolUse', 'PermissionRequest']);
const CONTINUING_EVENTS = new Set(['Stop', 'SubagentStop']);

function hookEventOf(a) {
  if (typeof a.hookEvent === 'string' && HOOK_EVENTS.has(a.hookEvent)) return a.hookEvent;
  const n = typeof a.hookName === 'string' ? a.hookName.split(':')[0] : '';
  return HOOK_EVENTS.has(n) ? n : null;
}

/**
 * The event of a hook that denied the tool call answered on this Claude `user` line, from the
 * line's `permissionDecision`; null when no hook denied it. A denial that names no event is
 * reported as PreToolUse, the event that decides permissions before a call runs.
 */
export function hookDenialOf(o) {
  const d = o && o.permissionDecision && typeof o.permissionDecision === 'object' ? o.permissionDecision : null;
  if (!d || d.decision !== 'reject') return null;
  const code = typeof d.reasonCode === 'string' ? d.reasonCode : '';
  if (d.source !== 'hook' && d.reasonType !== 'hook' && !code.startsWith('hook:')) return null;
  const ev = code.startsWith('hook:') ? code.slice(5) : '';
  return DENYING_EVENTS.has(ev) ? ev : 'PreToolUse';
}

/**
 * What a hook record on a Claude line did: `{ outcome, event, toolUseId }` with outcome `denial`
 * (a tool call refused before it ran), `continue` (a Stop / SubagentStop hook made the agent keep
 * working), `prompt-block` (a UserPromptSubmit hook blocked a prompt), `stopped` (a hook stopped
 * the agent), `other` (a blocking outcome of another event) or `unknown` (a blocking outcome with
 * no event); null when the line records no blocking hook outcome.
 */
export function hookOutcomeOf(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.type === 'system' && o.subtype === 'stop_hook_summary') return o.preventedContinuation === true ? { outcome: 'stopped', event: 'Stop', toolUseId: null } : null;
  if (o.type !== 'attachment' || !o.attachment || typeof o.attachment !== 'object') return null;
  const a = o.attachment;
  const type = String(a.type || '');
  const event = hookEventOf(a);
  const toolUseId = typeof a.toolUseID === 'string' ? a.toolUseID : typeof o.toolUseID === 'string' ? o.toolUseID : null;
  if (type === 'hook_stopped_continuation') return { outcome: 'stopped', event, toolUseId };
  if (type !== 'hook_blocking_error') return null;
  if (!event) return { outcome: 'unknown', event: null, toolUseId };
  if (DENYING_EVENTS.has(event)) return { outcome: 'denial', event, toolUseId };
  if (CONTINUING_EVENTS.has(event)) return { outcome: 'continue', event, toolUseId };
  if (event === 'UserPromptSubmit') return { outcome: 'prompt-block', event, toolUseId };
  return { outcome: 'other', event, toolUseId };
}

// ---------------------------------------------------------------- command attempts

/** The whole command line with whitespace collapsed: two attempts are the same command only when these are equal. */
export function normalizeCommand(cmd) {
  if (typeof cmd !== 'string') return null;
  const s = cmd.trim().replace(/\s+/g, ' ');
  return s || null;
}

const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
function programsOf(segment) {
  let toks = segment.trim().split(/\s+/).filter(Boolean);
  while (toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0]) || PREFIX_WORDS.has(toks[0].toLowerCase()))) toks = toks.slice(1);
  if (!toks.length) return [];
  const exe = (toks[0].replace(/^["'(]+|["')]+$/g, '').split(/[\\/]/).pop() || '').replace(/\.(exe|cmd|bat|ps1|sh)$/i, '').toLowerCase();
  return [exe, (toks[1] || '').toLowerCase()];
}

/**
 * The program whose exit status a command line reports: the last segment of its last line. A known
 * limit: `rg x && echo found` exiting 1 is judged on `echo`, so it still counts as a failure.
 */
function statusProgram(cmd) {
  const lines = cmd.replace(QUOTED, 'Q').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const segs = lines[lines.length - 1].split(/&&|\|\||;|\||&/).map((s) => s.trim()).filter(Boolean);
  return segs.length ? programsOf(segs[segs.length - 1]) : [];
}

// Programs whose exit status 1 means "no match", "files differ" or "false", not a failure.
const NO_MATCH_EXES = new Set(['rg', 'grep', 'egrep', 'fgrep', 'zgrep', 'ag', 'ack', 'findstr', 'select-string', 'sls', 'diff', 'cmp', 'test', '[', '[[']);
const NO_MATCH_GIT = new Set(['grep', 'diff']);

/** Whether exit status `code` of `cmd` is a search finding nothing (or a test being false) rather than a failure. */
export function noMatchExit(cmd, code) {
  if (code !== 1 || typeof cmd !== 'string') return false;
  const [exe, second] = statusProgram(cmd);
  if (!exe) return false;
  return NO_MATCH_EXES.has(exe) || (exe === 'git' && NO_MATCH_GIT.has(second));
}

/**
 * Retry runs in ONE thread's calls, in call order. Each item of `seq` is `{ shell, cmd, failed,
 * edit }`: `cmd` the normalised command line of a shell call, `failed` whether it failed (a
 * no-match exit is not a failure), `edit` whether it changed files (an edit tool call, or a shell
 * command that writes files). A retry is the SAME command failing and then run again at least
 * `minReruns` more times, each of them failing except possibly the last, before a success or the
 * end of the thread. An edit between two attempts ends the chain of every other command (that is
 * the fix-and-rerun cycle, not a repetition); other calls in between do not. Returns
 * `[{ cmd, first, last }]`, indexes into `seq` of the first failure and of the last attempt.
 */
export const RETRY_MIN_RERUNS = 3;
export function retryRuns(seq, minReruns = RETRY_MIN_RERUNS) {
  const out = [];
  const open = new Map(); // command -> indexes of its attempts since the last edit
  const close = (cmd) => {
    const list = open.get(cmd);
    open.delete(cmd);
    for (let i = 0; i < list.length;) {
      if (!seq[list[i]].failed) { i++; continue; }
      let j = i + 1;
      while (j < list.length && seq[list[j]].failed) j++;
      const end = j < list.length ? j : list.length - 1;
      if (end - i >= minReruns) out.push({ cmd, first: list[i], last: list[end] });
      i = j + 1;
    }
  };
  seq.forEach((c, idx) => {
    if (c.edit) for (const k of [...open.keys()]) if (!(c.shell && k === c.cmd)) close(k);
    if (!c.shell || !c.cmd) return;
    if (!open.has(c.cmd)) open.set(c.cmd, []);
    open.get(c.cmd).push(idx);
  });
  for (const k of [...open.keys()]) close(k);
  return out.sort((a, b) => a.first - b.first);
}

/** The exit status a Claude shell tool_result reports on its first line ("Exit code 1"), or null. */
export function claudeExitCode(text) {
  const m = /^(?:Error: )?Exit code (-?\d+)/.exec(typeof text === 'string' ? text : '');
  return m ? Number(m[1]) : null;
}

// A redirection into a file (not into /dev/null, NUL, $null or another stream), or a program that
// writes or moves files. Quoted text is dropped first, so `rg "a > b"` is not a write.
const WRITE_REDIRECT = /(?:^|[^0-9&>-])>>?\s*(?!&|\/dev\/null\b|nul\b|\$null\b)[^\s&|;)]/i;
const WRITE_EXES = new Set(['tee', 'mv', 'cp', 'rm', 'mkdir', 'touch', 'patch', 'apply_patch', 'set-content', 'add-content', 'out-file', 'new-item', 'remove-item', 'copy-item', 'move-item', 'rename-item', 'ni', 'del', 'move', 'copy', 'ren']);
const WRITE_GIT = new Set(['apply', 'checkout', 'restore', 'stash', 'reset', 'mv', 'rm', 'am', 'cherry-pick', 'revert', 'merge', 'rebase', 'pull', 'switch']);

/** Whether a shell command recognisably writes files (an edit made from the shell). */
export function writesFiles(cmd) {
  if (typeof cmd !== 'string') return false;
  const bare = cmd.replace(QUOTED, 'Q');
  if (WRITE_REDIRECT.test(bare)) return true;
  if (/\b(?:sed|perl)\s+(?:-[A-Za-z]+\s+)*(?:-[A-Za-z]*i|--in-place)/.test(bare)) return true; // in-place edit
  for (const line of bare.split(/\r?\n/)) {
    for (const seg of line.split(/&&|\|\||;|\||&/)) {
      const [exe, second] = programsOf(seg);
      if (!exe) continue;
      if (WRITE_EXES.has(exe) || (exe === 'git' && WRITE_GIT.has(second))) return true;
    }
  }
  return false;
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
        return { failed: code !== null ? code !== 0 : refused, code, text: typeof j.output === 'string' ? j.output : '' };
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
  return { failed: code !== null ? code !== 0 : refused, code, text: raw.slice(from) };
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
 *   { id, ts, name, shell, command, mcp: { server, tool } | null, done, failed, code, text, outChars }
 * `ts` is the time of the first record that mentions the call, `name` the tool name a
 * `response_item` gave it (null when only its completion was recorded), `done` whether an outcome
 * was read (shell calls only), `code` the exit status when the rollout recorded one (else null).
 * `command` and `text` are never to be printed.
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
    call = { id: key, ts, name: null, shell: false, command: null, mcp: null, done: false, sure: false, failed: false, code: null, text: '', outChars: 0 };
    calls.push(call);
    if (key !== null) byId.set(key, call);
    return { call, created: true };
  };
  // The outcome a completion event reports is kept over the one read from an output item.
  const settle = (call, failed, code, text, outChars, sure) => {
    const first = !call.done;
    if (first || (sure && !call.sure)) { call.failed = failed; call.code = code; call.text = text; call.outChars = outChars; call.sure = sure; }
    call.done = true;
    return first;
  };
  const command = (id, ts, cmd, o) => {
    const { call, created } = open(id, ts);
    call.shell = true;
    if (call.command === null) call.command = codexCommandString(cmd);
    const failed = (typeof o.exit_code === 'number' && o.exit_code !== 0) || o.status === 'failed';
    const out = typeof o.aggregated_output === 'string' ? o.aggregated_output : typeof o.stdout === 'string' ? o.stdout : '';
    const code = typeof o.exit_code === 'number' ? o.exit_code : null;
    const completed = settle(call, failed, code, `${typeof o.stderr === 'string' ? o.stderr : ''}\n${out}`, out.length, true);
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
          return { call, created: false, completed: settle(call, out.failed, out.code, out.text, out.text.length, false) };
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
