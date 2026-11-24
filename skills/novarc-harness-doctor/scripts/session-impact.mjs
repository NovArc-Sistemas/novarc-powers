#!/usr/bin/env node
// session-impact.mjs --cwd <project root> [--days 30] [--config-dirs a,b] [--scope project|user] [--progress] [--weights <file>]
//                    [--sources claude,codex] [--codex-dirs a,b]
//
// Measures what a harness costs over a window, from local agent session transcripts: tokens per
// kind (input, cache write, cache read, output), the context every session starts with and peaks
// at, and the tokens spent in waste episodes (retry loops, identical-call loops, missing commands,
// tool calls a hook denied, corrected work, sessions ending on an error, exploration before the
// first edit). Each kind's exact rule is its METHODS string below, printed with the number:
//   - retry: the SAME command line (whitespace collapsed, not just its head) failing and run again
//     3 or more times. A search that finds nothing is not a failure (`rg`, `grep`, `ag`, `ack`,
//     `findstr`, `Select-String`, `git grep`, `diff`, `cmp`, `test` / `[` exiting 1, judged on the
//     program whose status the line reports, its last segment). An edit between two attempts (an
//     Edit/Write-type call, a Codex apply_patch, or a shell command that recognisably writes files)
//     ends the chain: fixing and rerunning is not a repetition.
//   - loop: 5+ consecutive identical calls (same tool, same input; a shell call compared by its
//     normalised command line).
//   - notfound: consecutive shell calls, with no other call between them, that fail because the
//     same executable does not exist.
//   - hook-block: only a hook that DENIED a tool call before it ran, read from structured fields
//     (lib/transcripts.mjs, hook outcomes), never from result text. A Stop / SubagentStop hook that
//     blocks the end of a response makes the agent keep working: that is the hook doing its job,
//     counted apart in `hookOutcomes`, like UserPromptSubmit blocks and outcomes with no event.
//   - correction: a real user message that follows a turn that did work, is not a question, is not
//     a short answer to a question the assistant just asked, and carries a marker about the work
//     (lib/transcripts.mjs, corrections). A bare leading "não" / "no" is not enough.
// Also lists skills and MCP servers that were configured but never used, and shell output volume
// by command head. Aggregates only: it never prints message text, command lines beyond the
// 2-token head, tool output, file paths from inside a transcript, or absolute home paths.
//
// One definition of a counted event feeds every number. A model call counts when its own
// timestamp falls in the window and it is not a replayed copy of a call already seen in an
// earlier file. A Claude tool call, the skill it names and the output it produced count with the
// model call that issued them. A Codex tool call counts once per call id, whichever shapes the
// rollout wrote it in, by the time of its first record, and its output counts with it. Token
// totals, tool and skill counts, the unused lists and the shell output all come from those events.
//
// "Not read" is never printed as zero. `coverage` says, per source, whether its tool calls could
// be read. A configured skill or MCP server that shows no use gets 0 only when that absence was
// measured, and `null` (plus an entry in `unusedContext.skillsUnknown` / `mcpServersUnknown`)
// when it could not be established.
//
// Raw token totals are dominated by cache reads, which cost a fraction of an input token. So every
// total also comes in input-token equivalents (`weightedTotal`, `weightedByKind`, `weighted` on
// each waste kind, `contextAtStart.weightedTotal` and `carriedWeighted`), using the list-price ratios in
// references/catalog/pricing-weights.json (or `--weights <file>`). The `weights` block says which
// ratios were applied. When the file is missing, or a model call cannot be matched to a confirmed
// ratio, the weighted fields are left out and a note says why. Raw counts never change.
//
// `--sources` picks which transcripts are read: `claude`, `codex` or both (the default). With one
// source the other agent's sessions are not counted and its own configuration is left out of
// `unusedContext`, so one account can be measured alone: `--scope user --config-dirs <dir> --sources
// claude` for a Claude account, `--scope user --sources codex` for Codex. `--codex-dirs` names the
// Codex home(s) to read instead of the default discovery, the way `--config-dirs` does for Claude.
//
// Naming accounts with `--config-dirs` or `--codex-dirs` also narrows what counts as configured to
// those accounts: `~/.claude.json` (the state file of the default `~/.claude`) is read only when
// `~/.claude` is one of the config dirs named, and the skills of `~/.agents` are left out. With
// neither flag every account on the machine is read, `~/.claude.json` and `~/.agents` included.
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { IS_WIN, parseArgs, isMain, printJson, warn, normalizeInputPath, isDir, isFile, readdirSafe, realpathSafe, readJsonSafe, readTextSafe, home, approxTokens } from './lib/common.mjs';
import { claudeConfigDirs, codexDirs, agentsDirs } from './lib/locations.mjs';
import { scanCodexToml } from './discover.mjs';
import {
  SHELL_TOOLS, EDIT_TOOLS, EXPLORE_TOOLS, NOT_FOUND_RE, SAFE_NAME, safeName, resultText, isHumanText, isCorrection, asksUser,
  hookDenialOf, hookOutcomeOf, normalizeCommand, noMatchExit, claudeExitCode, writesFiles, retryRuns,
  skillsReadIn, normalizeMcpName, eachJsonLine, listClaudeTranscripts, listJsonl, pool,
  commandHead, matchesProjectDir, matchesProjectCwd, codexCallReader, codexCallName, codexCallLine,
} from './lib/transcripts.mjs';

export const DEFAULT_WEIGHTS_FILE = fileURLToPath(new URL('../references/catalog/pricing-weights.json', import.meta.url));
const WEIGHTS_DISPLAY = 'references/catalog/pricing-weights.json';
const SOURCES = ['claude', 'codex'];
const DAY = 86400000;
const PEAK_LIMIT = 160000;
const LOOP_MIN = 5;
const KINDS = ['retry', 'loop', 'notfound', 'hook-block', 'correction', 'error-end', 'exploration']; // claim priority
const OUTPUT_ORDER = ['retry', 'loop', 'notfound', 'correction', 'hook-block', 'error-end', 'exploration'];
const LABELS = {
  retry: 'Retry loops on a failing command',
  loop: 'Identical tool calls repeated in a row',
  notfound: 'Commands that do not exist here',
  correction: 'Work the user corrected',
  'hook-block': 'Tool calls a hook denied',
  'error-end': 'Sessions ending on an error',
  exploration: 'Exploration before the first edit',
};
const METHODS = {
  turn: 'Turn tokens are input + cacheWrite + cacheRead + output of one model call; Claude entries that repeat a message id (one entry per content block) are merged by taking each field\'s maximum, and an id already seen in an earlier file (resumed or forked sessions) is dropped as a duplicate; Codex turns are the deltas of the cumulative total_token_usage between token_count events.',
  window: 'Files modified before the window start are skipped, and inside a file only model calls whose own timestamp falls in the window are counted.',
  contextAtStart: 'Input + cacheWrite + cacheRead of the first model call of each top-level session (subagents excluded), counted only when that call falls inside the window and is not a duplicate of an earlier file.',
  contextPeak: 'Per top-level session (subagents excluded), the largest input + cacheWrite + cacheRead of any in-window model call; sessionsOver160k counts sessions whose peak exceeded 160,000 tokens.',
  retry: 'The same shell command, compared on its whole command line with whitespace collapsed (never on its first words alone), that fails and is run again at least 3 more times in the same thread, each attempt failing except possibly the last, before a success or the end of the thread. A failure is is_error or a non-zero exit, except a search or test finding nothing: exit status 1 of rg, grep, egrep, fgrep, zgrep, ag, ack, findstr, Select-String, git grep, git diff, diff, cmp, test or [ (the program whose status the line reports, its last segment) is not a failure. An edit between two attempts ends the chain (an Edit/Write/MultiEdit/NotebookEdit call, a Codex apply_patch, or a shell command that recognisably writes files: a redirection into a file, tee, sed -i, mv, cp, rm, git checkout/restore/apply and the like), because fixing and running again is not a repetition; other calls in between do not end it. Tokens are every turn from the first failure to the resolving success (or the last attempt).',
  loop: 'At least 5 consecutive tool calls in a thread with the same tool name and an identical input (a shell call compared by its whole command line with whitespace collapsed, any other call by its full input; compared by hash, never stored); tokens are the turns from the first to the last call of the run, minus turns already claimed by a retry loop.',
  notfound: 'A failed shell command whose output says the program does not exist (command not found, is not recognized as, a shell reporting No such file or directory for the program it runs); consecutive such failures of the same executable with no other tool call between them are one episode; tokens are the turns from the first to the last of them.',
  'hook-block': 'A tool call that a hook denied before it ran, read only from structured transcript fields: a tool result whose permissionDecision is a rejection by a hook (PreToolUse, or PermissionRequest), or a hook_blocking_error record whose hookEvent is PreToolUse or PermissionRequest; one episode per denied call; tokens are the turn that issued it. The text of a tool result is never read for this, so a result that only mentions a hook is not counted. A Stop or SubagentStop hook that blocks (makes the agent continue), a UserPromptSubmit block and a blocking outcome with no event are not waste: see hookOutcomes.',
  correction: 'A real user message (not a tool result, command wrapper or compaction summary) shorter than 280 characters that (a) follows at least one tool call in the same thread since the previous user message, (b) is not a question (does not end with "?" or open with a question form such as "por que", "dá pra", "não dá pra", "pode", "why", "can you"), (c) is not an answer of 12 words or fewer to a question the assistant just asked (its last text ended a paragraph with "?" or offered options), and (d) carries a pt/en marker about the work ("não era isso", "está errado", "desfaz", "reverte", "volta como estava", "você apagou/mudou/quebrou", "eu disse/pedi", "não mexe/não faça", "that\'s wrong", "revert", "undo", "I said/asked", "don\'t touch", "you broke"); a bare leading "não" or "no" is not a marker. Tokens are the model turns between the previous user message and the correction (top-level threads only).',
  'error-end': 'A top-level session whose last tool result is an error (a search finding nothing is not an error, as in retry); tokens are its last 3 turns.',
  hookOutcomes: 'Hook outcomes read from structured transcript fields, counted with the model turn they follow (so only in the window and never twice). denials: tool calls a hook denied before they ran, by event (the hook-block waste, before turns claimed by a higher kind are taken away). continues: a Stop or SubagentStop hook blocked the end of a response, so the agent kept working; promptBlocks: a UserPromptSubmit hook blocked a prompt; stopped: a hook stopped the agent (continue: false); otherBlocking: blocking outcomes of other events, by event; unknown: blocking outcomes that name no event. None of these is waste.',
  exploration: 'Turns that only issued Read/Grep/Glob/LS-type calls after a real user message and before the first Edit/Write/MultiEdit/NotebookEdit that follows it (segments with no edit are not counted; top-level Claude threads only).',
  unusedContext: 'Skills are folders with a SKILL.md in the scope\'s skills dirs whose skillInvocations count for the window is 0 (no Skill tool call, slash command, skill attribution or read of their SKILL.md among the counted events); MCP servers are names configured in the scope\'s settings, .mcp.json, ~/.claude.json and Codex config.toml whose mcpCalls count is 0. A name whose absence from the counts could not be established is listed under skillsUnknown or mcpServersUnknown instead and never here: see coverage. When --config-dirs or --codex-dirs names the accounts to read, only what those accounts hold is listed: ~/.claude.json counts only when ~/.claude is one of the config dirs named, and the skills of ~/.agents are left out.',
  carried: 'Derived from measured values, not measured itself. For each top-level session measured above: the context of its first model call, counted once for every later model call of that session in the window (turns counts the first call too), and capped on each later call at what that call really sent (input + cacheWrite + cacheRead), so a compaction that shrank the context never adds more than was sent. The assumption is that the starting context stays loaded for the whole session. carriedWeighted prices each of those re-reads at the cache-read ratio of the model of the later call (of the session\'s first call when the later call names no model), because later calls read the starting context from the prompt cache.',
  usage: 'Counts for the window, from the same counted events as the token totals. toolCalls: tool calls by tool name. A Claude tool call counts with the model call that issued it: when that call\'s own timestamp falls in the window and it is not a replayed copy. A Codex tool call counts once per call id, whichever record shapes carry it (a response_item function, custom tool or local shell call; an exec_command_end or mcp_tool_call_end event; a completed CommandExecution or McpToolCall item), when the time of its first record falls in the window; it is listed under the tool name the rollout records, as exec_command when only the completed command is recorded, and as mcp__<server>__<tool> when it is an MCP call. mcpCalls: the mcp__<server>__* calls summed per server, under the name this scope configures the server with when there is one, otherwise the name as it appears in the tool name. skillInvocations: per session, Skill tool calls plus slash commands the user typed (every command under its own name, built-in ones included; a typed command counts by its own timestamp, once per entry id); a session where a skill only shows up as skill attribution or as a read of its SKILL.md counts once. A skill named plugin:skill is listed under that name and again under its bare name, so these values must not be summed. Skills and servers the scope configures are listed even when nothing was counted for them: with 0 when that absence was measured, with null when it could not be established (see coverage).',
  toolOutput: 'Characters of shell tool results (Claude Bash/PowerShell results, Codex command output) grouped by the 2-token command head. A result counts with the call it answers, so only the results of counted calls are in: calls in the window that are not replayed copies. Approximate tokens are chars / 4. Outputs too large for the transcript are stored elsewhere and only their preview is counted.',
  coverage: 'Whether the tool calls of each source could be read. complete: every transcript file was read and every line that can hold a call was parsed. partial: some lines could not be parsed; they were searched for the name of each configured skill and MCP server, and a name they mention is reported as unknown (null) instead of 0. unknown: a transcript file could not be read, a record that looks like a tool call has a shape that is not read, or (project scope) a rollout with tool calls records no working directory; every skill or MCP server that source could have used and that shows no use is reported as unknown. not-read: the source was left out with --sources. A count above 0 is what was read, so under partial or unknown it is a lower bound.',
  dedupe: 'A turn belongs to at most one waste kind, claimed in priority order retry > loop > notfound > hook-block > correction > error-end > exploration; an episode whose in-window turns were all claimed by a higher kind is not counted.',
  weighted: 'Input-token equivalents: the tokens of each model call are multiplied by the list price of their kind divided by the base input price of the same model (cache writes by their lifetime, cache reads, output), with the ratios picked by the model id the transcript names; a call over a model\'s long-context threshold uses the higher prices of that tier against the same base. The unit compares token kinds inside one model\'s price list: it is not money, it does not compare models whose base prices differ, and a subscription is not billed per token. Each figure is rounded on its own, so parts can differ from their total by a few units.',
};

function bump(obj, key, n = 1) { obj[key] = (obj[key] || 0) + n; }
const num = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);

function parseTs(ts) {
  if (typeof ts !== 'string') return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

/** Short hash of a tool input, so identical calls can be compared without keeping the input. */
function inputHash(v) {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v === undefined ? null : v); } catch { s = ''; }
  return createHash('sha1').update(String(s)).digest('base64').slice(0, 16);
}

function newThread(source, sessionId, sidechain, order) {
  // work: a tool call since the last real user message; asked: the assistant's last text asked something.
  return { source, sessionId, sidechain, order, turns: [], byId: new Map(), events: [], calls: new Map(), cwd: null, slash: [], hooks: [], denied: new Set(), work: false, asked: false };
}

/** A hook outcome that is not waste, hung on the turn it follows: counted exactly when that turn is. */
function neutralHook(th, h) {
  const key = h.outcome === 'continue' || h.outcome === 'other' ? `${h.outcome}:${h.event}` : h.outcome;
  th.hooks.push([Math.max(0, th.turns.length - 1), key]);
}

// ---------------------------------------------------------------- Claude

// Decide from the first bytes of a line. Assistant lines put "message" (with its role) before
// "type"; attachment and system lines matter only when they are about a hook.
function claudeWant(head) {
  if (head.startsWith('{"type":"api-request')) return false;
  if (head.includes('"role":"assistant"') || head.includes('"role":"user"') || head.includes('"type":"assistant"') || head.includes('"type":"user"')) return true;
  return (head.includes('"type":"attachment"') || head.includes('"attachment":') || head.includes('"type":"system"')) && /hook/i.test(head);
}

async function parseClaudeFile(entry, ctx) {
  const main = newThread('claude', entry.sessionId, entry.sidechainFile, `${entry.file}\u0000a`);
  const side = entry.sidechainFile ? main : newThread('claude', entry.sessionId, true, `${entry.file}\u0000b`);
  await eachJsonLine(entry.file, (o) => {
    const th = o.isSidechain === true ? side : main;
    const msg = o.message && typeof o.message === 'object' ? o.message : null;
    const content = msg ? msg.content : undefined;
    if (o.type === 'assistant' && msg) {
      const id = typeof msg.id === 'string' && msg.id ? msg.id : (typeof o.uuid === 'string' ? o.uuid : null);
      let idx = id !== null ? th.byId.get(id) : undefined;
      if (idx === undefined) {
        idx = th.turns.length;
        // tools / skills / reads / attr / res feed the usage counts only (toolCalls, skillInvocations,
        // mcpCalls, toolOutput). They hang on the turn, so they are counted exactly when the turn is.
        th.turns.push({ id, ts: parseTs(o.timestamp), input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cw1h: 0, model: null, calls: [], tools: [], skills: [], reads: [], attr: null, res: [] });
        if (id !== null) th.byId.set(id, idx);
      }
      const t = th.turns[idx];
      if (t.ts === null) t.ts = parseTs(o.timestamp);
      if (t.model === null && typeof msg.model === 'string' && msg.model) t.model = msg.model;
      if (t.attr === null && typeof o.attributionSkill === 'string' && o.attributionSkill) t.attr = o.attributionSkill;
      const u = msg.usage && typeof msg.usage === 'object' ? msg.usage : null;
      if (u) {
        t.input = Math.max(t.input, num(u.input_tokens));
        t.cacheWrite = Math.max(t.cacheWrite, num(u.cache_creation_input_tokens));
        t.cacheRead = Math.max(t.cacheRead, num(u.cache_read_input_tokens));
        t.output = Math.max(t.output, num(u.output_tokens));
        // The part of the cache writes made with the 1-hour lifetime; used for price weights only.
        if (u.cache_creation && typeof u.cache_creation === 'object') t.cw1h = Math.max(t.cw1h, num(u.cache_creation.ephemeral_1h_input_tokens));
      }
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && c.type === 'text' && typeof c.text === 'string' && c.text.trim()) th.asked = asksUser(c.text);
          if (!c || c.type !== 'tool_use' || typeof c.name !== 'string') continue;
          const input = c.input && typeof c.input === 'object' ? c.input : {};
          const call = { k: 'call', turn: idx, name: c.name, hash: inputHash(c.input), head: null, cmd: null, command: null, writes: false, shell: SHELL_TOOLS.has(c.name), explore: EXPLORE_TOOLS.has(c.name), edit: EDIT_TOOLS.has(c.name) };
          th.work = true;
          t.tools.push(c.name);
          if (call.shell && typeof input.command === 'string') {
            call.head = commandHead(input.command);
            call.command = input.command;
            call.cmd = normalizeCommand(input.command);
            call.writes = writesFiles(input.command);
            if (call.cmd !== null) call.hash = inputHash(call.cmd); // identical command line, whatever else the input says
            for (const s of skillsReadIn(input.command)) t.reads.push(s);
          }
          if (c.name === 'Read' && typeof input.file_path === 'string') for (const s of skillsReadIn(input.file_path)) t.reads.push(s);
          if (c.name === 'Skill') {
            const sk = input.skill || input.name || input.command;
            if (typeof sk === 'string') { const name = sk.trim().replace(/^\//, ''); if (name) t.skills.push(name); }
          }
          t.calls.push(call);
          th.events.push(call);
          if (typeof c.id === 'string') th.calls.set(c.id, call);
        }
      }
    } else if (o.type === 'user' && msg) {
      let sawResult = false;
      const denial = hookDenialOf(o);
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || c.type !== 'tool_result') continue;
          sawResult = true;
          const call = th.calls.get(c.tool_use_id) || null;
          const text = resultText(c.content);
          // A search that found nothing exits 1 and is marked as an error: it is not a failure.
          const isErr = c.is_error === true && !(call && call.shell && noMatchExit(call.command, claudeExitCode(text)));
          th.events.push({ k: 'result', call, isErr, notFound: isErr && NOT_FOUND_RE.test(text) });
          if (denial && c.is_error === true) {
            const key = typeof c.tool_use_id === 'string' ? c.tool_use_id : null;
            if (key === null || !th.denied.has(key)) {
              if (key !== null) th.denied.add(key);
              th.events.push({ k: 'hook', event: denial, turn: call ? call.turn : th.turns.length - 1, head: call ? call.head : null });
            }
          }
          // A shell result counts with the call it answers, so it is kept on that call's turn.
          if (call && call.shell) th.turns[call.turn].res.push(call.head || '<unknown>', text.length);
        }
      }
      if (!sawResult && o.isMeta !== true && o.isCompactSummary !== true && !o.toolUseResult) {
        const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((c) => c && c.type === 'text').map((c) => c.text) : [];
        let human = false;
        let correction = false;
        const ctx = { work: th.work, asked: th.asked };
        for (const t of texts) {
          if (typeof t !== 'string') continue;
          const cmd = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(t);
          if (cmd) { th.slash.push([parseTs(o.timestamp), typeof o.uuid === 'string' ? o.uuid : null, cmd[1]]); continue; }
          if (!isHumanText(t)) continue;
          human = true;
          if (isCorrection(t, ctx)) correction = true;
        }
        if (human) {
          th.events.push({ k: 'user', at: th.turns.length, correction });
          th.work = false;
          th.asked = false;
        }
      }
    } else if (o.type === 'attachment' || o.type === 'system') {
      const h = hookOutcomeOf(o);
      if (h && h.outcome === 'denial') {
        const call = h.toolUseId !== null ? th.calls.get(h.toolUseId) || null : null;
        if (h.toolUseId === null || !th.denied.has(h.toolUseId)) {
          if (h.toolUseId !== null) th.denied.add(h.toolUseId);
          th.events.push({ k: 'hook', event: h.event, turn: call ? call.turn : th.turns.length - 1, head: call ? call.head : null });
        }
      } else if (h) neutralHook(th, h);
    }
  }, { want: claudeWant, onUnparsable: ctx.lost });
  const out = [main];
  if (side !== main && (side.turns.length || side.events.length)) out.push(side);
  return out;
}

// ---------------------------------------------------------------- Codex

function codexWant(reader) {
  return (head) => head.includes('"token_count"') || head.includes('"item_completed"') || head.includes('"session_meta"') || head.includes('"turn_context"') || head.includes('"user_message"') || head.includes('"agent_message"') || head.includes('"patch_apply_end"') || codexCallLine(head, reader);
}

// Codex edits: an apply_patch tool call, a patch_apply_end event or a completed FileChange item.
const CODEX_EDIT_TOOLS = new Set(['apply_patch']);

async function parseCodexFile(file, ctx) {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file);
  const th = newThread('codex', m ? m[1] : path.basename(file, '.jsonl'), false, file);
  let prev = null;
  let pending = []; // shell calls first seen since the last token_count belong to the next model call
  const evUsers = [];
  const itemUsers = [];
  // One entry per call id, whichever shapes the rollout wrote the call in (lib/transcripts.mjs).
  const reader = codexCallReader();
  const callEvents = new Map(); // call -> its event in th.events
  const resultEvents = new Map(); // call -> the event of its outcome
  let sawUsage = false;
  let curModel = null; // the model named by the latest turn_context; used for price weights only
  let asked = false; // the assistant's last message asked something
  let edits = 0;
  const flush = (idx) => { for (const e of pending) e.turn = idx; pending = []; };
  const editEvent = () => {
    const ev = { k: 'call', turn: null, name: 'apply_patch', hash: `edit${edits++}`, head: null, cmd: null, command: null, writes: false, shell: false, explore: false, edit: true };
    th.events.push(ev);
    pending.push(ev);
  };
  const agentText = (text) => { if (typeof text === 'string' && text.trim()) asked = asksUser(text); };
  await eachJsonLine(file, (o) => {
    const p = o.payload && typeof o.payload === 'object' ? o.payload : null;
    if (!p) return;
    if ((o.type === 'session_meta' || o.type === 'turn_context') && typeof p.cwd === 'string' && th.cwd === null) th.cwd = p.cwd;
    if (o.type === 'turn_context' && typeof p.model === 'string' && p.model) curModel = p.model;
    const hit = reader.read(o);
    if (hit) {
      // Waste episodes are about commands and edits, so only a shell call or an edit becomes an
      // event of the thread. A shell call's details are filled in once the file is read: a later
      // record of the same call can still bring its command or a firmer outcome.
      if (hit.call.shell) {
        let ev = callEvents.get(hit.call);
        if (!ev) {
          ev = { k: 'call', turn: null, name: '', hash: '', head: null, cmd: null, command: null, writes: false, shell: true, explore: false, edit: false };
          callEvents.set(hit.call, ev);
          th.events.push(ev);
          pending.push(ev);
        }
        if (hit.completed) {
          const r = { k: 'result', call: ev, isErr: false, notFound: false };
          resultEvents.set(hit.call, r);
          th.events.push(r);
        }
      } else if (hit.created && CODEX_EDIT_TOOLS.has(hit.call.name)) editEvent();
      return;
    }
    if (o.type !== 'event_msg') return;
    if (p.type === 'patch_apply_end' || (p.type === 'item_completed' && p.item && typeof p.item === 'object' && p.item.type === 'FileChange')) { editEvent(); return; }
    if (p.type === 'agent_message') { agentText(p.message); return; }
    if (p.type === 'item_completed' && p.item && typeof p.item === 'object' && p.item.type === 'AgentMessage') {
      const it = p.item;
      agentText(typeof it.text === 'string' ? it.text : Array.isArray(it.content) ? it.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n') : null);
      return;
    }
    if (p.type === 'token_count' && p.info && p.info.total_token_usage && typeof p.info.total_token_usage === 'object') {
      sawUsage = true;
      const t = p.info.total_token_usage;
      const cur = { input: num(t.input_tokens), cached: num(t.cached_input_tokens), cw: num(t.cache_write_input_tokens), output: num(t.output_tokens) };
      let d = prev ? { input: cur.input - prev.input, cached: cur.cached - prev.cached, cw: cur.cw - prev.cw, output: cur.output - prev.output } : { ...cur };
      if (d.input < 0 || d.cached < 0 || d.cw < 0 || d.output < 0) d = { ...cur }; // counter reset
      prev = cur;
      if (d.input + d.output === 0) return; // repeated event, no new model call
      const idx = th.turns.length;
      th.turns.push({ id: null, ts: parseTs(o.timestamp), input: Math.max(0, d.input - d.cached - d.cw), cacheWrite: d.cw, cacheRead: d.cached, output: d.output, cw1h: 0, model: curModel, calls: pending.slice() });
      flush(idx);
    } else if (p.type === 'user_message' && typeof p.message === 'string') {
      evUsers.push({ at: th.turns.length, pos: th.events.length, calls: reader.calls.length + edits, asked, text: p.message });
      asked = false;
    } else if (p.type === 'item_completed' && p.item && typeof p.item === 'object' && p.item.type === 'UserMessage' && Array.isArray(p.item.content)) {
      const text = p.item.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
      itemUsers.push({ at: th.turns.length, pos: th.events.length, calls: reader.calls.length + edits, asked, text });
      asked = false;
    }
  }, { want: codexWant(reader), onUnparsable: ctx.lost });
  if (pending.length) {
    const last = th.turns.length - 1;
    if (last >= 0) th.turns[last].calls.push(...pending);
    flush(last);
  }
  let unread = 0;
  for (const [call, ev] of callEvents) {
    ev.name = codexCallName(call);
    ev.head = commandHead(call.command);
    ev.command = call.command;
    ev.cmd = normalizeCommand(call.command);
    ev.writes = writesFiles(call.command);
    // A command that could not be read never looks identical to another one.
    ev.hash = ev.cmd === null ? `?${unread++}` : inputHash(ev.cmd);
  }
  for (const [call, r] of resultEvents) {
    // A search that found nothing exits 1: it is not a failure.
    r.isErr = call.failed && !noMatchExit(call.command, call.code);
    r.notFound = r.isErr && NOT_FOUND_RE.test(call.text);
  }
  // One user turn is recorded in several places; use one source only. A message corrects work
  // only when a tool call was recorded since the previous one.
  const users = (evUsers.length ? evUsers : itemUsers).filter((u) => isHumanText(u.text));
  const ins = users.map((u, i) => ({ pos: u.pos, ev: { k: 'user', at: u.at, correction: isCorrection(u.text, { work: u.calls > (i ? users[i - 1].calls : 0), asked: u.asked }) } }));
  for (let i = ins.length - 1; i >= 0; i--) th.events.splice(ins[i].pos, 0, ins[i].ev);
  // The counted calls of this rollout: one per call, by the time of its first record. Tool names,
  // skill reads and shell output all come from this one list.
  const use = { tools: {}, reads: {}, heads: [] };
  for (const call of reader.calls) {
    if (call.ts === null || call.ts < ctx.from || call.ts > ctx.to) continue;
    bump(use.tools, codexCallName(call));
    if (!call.shell) continue;
    for (const sk of skillsReadIn(call.command)) bump(use.reads, sk);
    if (call.done) use.heads.push([commandHead(call.command) || '<unknown>', call.outChars]);
  }
  th.noUsage = !sawUsage;
  th.codexUse = use;
  th.callCount = reader.calls.length;
  th.unrecognized = [...reader.unrecognized];
  return [th];
}

// ---------------------------------------------------------------- analysis

function turnTokens(t) { return t.input + t.cacheWrite + t.cacheRead + t.output; }
function contextOf(t) { return t.input + t.cacheWrite + t.cacheRead; }
const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(i); return out; };

/** Waste episodes of one thread, as { kind, turns: [idx], heads: [head] }. */
export function episodesOf(th) {
  const eps = [];
  const top = !th.sidechain;
  const n = th.turns.length;
  const outcome = new Map();
  for (const e of th.events) if (e.k === 'result' && e.call) outcome.set(e.call, e);
  const calls = th.events.filter((e) => e.k === 'call' && e.turn !== null && e.turn >= 0);
  // retry: the same normalised command failing again and again, with no edit in between.
  const seq = calls.map((e) => {
    const r = outcome.get(e) || null;
    return { shell: !!e.shell, cmd: e.cmd || null, failed: !!(r && r.isErr), edit: !!(e.edit || e.writes) };
  });
  for (const run of retryRuns(seq)) {
    const head = calls[run.first].head;
    eps.push({ kind: 'retry', turns: range(calls[run.first].turn, calls[run.last].turn), heads: head ? [head] : [] });
  }
  // notfound: consecutive calls failing because the same executable does not exist.
  const exeOf = (e) => (e.head ? e.head.split(' ')[0] : null);
  for (let i = 0; i < calls.length;) {
    const r = outcome.get(calls[i]);
    if (!calls[i].shell || !(r && r.notFound)) { i++; continue; }
    const exe = exeOf(calls[i]);
    let j = i + 1;
    while (j < calls.length && calls[j].shell && exe !== null && exeOf(calls[j]) === exe && (outcome.get(calls[j]) || {}).notFound) j++;
    eps.push({ kind: 'notfound', turns: range(calls[i].turn, calls[j - 1].turn), heads: calls[i].head ? [calls[i].head] : [] });
    i = j;
  }
  // loop: runs of identical consecutive calls (same tool, same input hash)
  for (let i = 0; i < calls.length;) {
    let j = i + 1;
    while (j < calls.length && calls[j].name === calls[i].name && calls[j].hash === calls[i].hash) j++;
    if (j - i >= LOOP_MIN) eps.push({ kind: 'loop', turns: range(calls[i].turn, calls[j - 1].turn), heads: calls[i].head ? [calls[i].head] : [] });
    i = j;
  }
  for (const e of th.events) { // hook-block: a tool call a hook denied before it ran
    if (e.k === 'hook' && e.turn !== null && e.turn >= 0) eps.push({ kind: 'hook-block', turns: [e.turn], heads: e.head ? [e.head] : [], event: e.event });
  }
  if (top) {
    let lastAt = 0;
    for (const e of th.events) { // correction
      if (e.k !== 'user') continue;
      if (e.correction) eps.push({ kind: 'correction', turns: range(lastAt, e.at - 1), heads: [] });
      lastAt = e.at;
    }
    let lastResult = null;
    for (const e of th.events) if (e.k === 'result') lastResult = e;
    if (lastResult && lastResult.isErr && n) eps.push({ kind: 'error-end', turns: range(Math.max(0, n - 3), n - 1), heads: [] });
    if (th.source === 'claude') { // exploration, per segment between user messages
      const starts = [0, ...th.events.filter((e) => e.k === 'user').map((e) => e.at)];
      for (let s = 0; s < starts.length; s++) {
        const b = s + 1 < starts.length ? starts[s + 1] : n;
        const turns = [];
        let edited = false;
        for (let i = starts[s]; i < b && i < n; i++) {
          const cs = th.turns[i].calls;
          if (cs.some((c) => c.edit)) { edited = true; break; }
          if (cs.some((c) => c.explore)) turns.push(i);
        }
        if (edited && turns.length) eps.push({ kind: 'exploration', turns, heads: [] });
      }
    }
  }
  return eps;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1];
}

function median(sorted) {
  if (!sorted.length) return 0;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
}

// ---------------------------------------------------------------- configured context

function skillNamesIn(dir) {
  const out = [];
  for (const e of readdirSafe(dir)) {
    const full = path.join(dir, e.name);
    if (isDir(full) && isFile(path.join(full, 'SKILL.md')) && SAFE_NAME.test(e.name)) out.push(e.name);
  }
  return out;
}

function mcpNames(obj) { return obj && typeof obj === 'object' ? Object.keys(obj) : []; }

function samePath(a, b) { return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b; }

/**
 * Skills and MCP servers configured for the scope. What belongs to one agent only (its config dir,
 * a project's .claude/ and .mcp.json) is listed only when that agent's transcripts are read;
 * a project's own .agents/skills folder always is. `origin` says, per name, which sources'
 * sessions can use it: a count of 0 is a measured zero only when those sources were read in full.
 *
 * `named` says whether `--config-dirs` / `--codex-dirs` named the accounts to read. A named
 * account holds nothing of another one:
 *   - `~/.claude.json` is the state file of the default account (`~/.claude`), kept outside its
 *     config dir. It is read when no Claude account was named, or when `~/.claude` is one of the
 *     dirs named; any other Claude config dir brings only what lives inside it.
 *   - `~/.agents` is a harness of its own: its skills are listed only when no account was named.
 */
function configuredContext({ scope, projectRoot, claudeDirs, codexHomes, want, named }) {
  const origin = { skills: new Map(), mcp: new Map() };
  const add = (kind, name, sources) => {
    const set = origin[kind].get(name) || new Set();
    for (const s of sources) set.add(s);
    origin[kind].set(name, set);
  };
  const CLAUDE = ['claude'];
  const CODEX = ['codex'];
  const either = [...want]; // .agents/skills is read by whichever agent runs
  const claude = want.has('claude');
  const defaultDir = path.join(home(), '.claude');
  const sameDir = (a, b) => samePath(realpathSafe(a) || a, realpathSafe(b) || b);
  const defaultAccount = claude && (!named.claude || claudeDirs.some((d) => sameDir(d.path, defaultDir)));
  const userClaudeJson = defaultAccount ? readJsonSafe(path.join(home(), '.claude.json')) : { ok: false };
  const sharedDirs = named.claude || named.codex ? [] : agentsDirs();
  if (scope === 'user') {
    for (const d of claude ? claudeDirs : []) {
      for (const s of skillNamesIn(path.join(d.path, 'skills'))) add('skills', s, CLAUDE);
      for (const f of ['settings.json', 'settings.local.json', '.claude.json']) {
        const r = readJsonSafe(path.join(d.path, f));
        if (r.ok && r.value) for (const n of mcpNames(r.value.mcpServers)) add('mcp', n, CLAUDE);
      }
    }
    for (const d of sharedDirs) for (const s of skillNamesIn(path.join(d.path, 'skills'))) add('skills', s, either);
    for (const d of codexHomes) {
      for (const s of skillNamesIn(path.join(d.path, 'skills'))) add('skills', s, CODEX);
      const toml = readTextSafe(path.join(d.path, 'config.toml'));
      if (toml !== null) for (const s of scanCodexToml(toml).mcpServers) add('mcp', s.name, CODEX);
    }
    if (userClaudeJson.ok && userClaudeJson.value) for (const n of mcpNames(userClaudeJson.value.mcpServers)) add('mcp', n, CLAUDE);
  } else {
    for (const s of skillNamesIn(path.join(projectRoot, '.agents', 'skills'))) add('skills', s, either);
    if (claude) {
      for (const s of skillNamesIn(path.join(projectRoot, '.claude', 'skills'))) add('skills', s, CLAUDE);
      const mj = readJsonSafe(path.join(projectRoot, '.mcp.json'));
      if (mj.ok && mj.value) for (const n of mcpNames(mj.value.mcpServers)) add('mcp', n, CLAUDE);
      for (const f of ['settings.json', 'settings.local.json']) {
        const r = readJsonSafe(path.join(projectRoot, '.claude', f));
        if (r.ok && r.value) for (const n of mcpNames(r.value.mcpServers)) add('mcp', n, CLAUDE);
      }
      const v = userClaudeJson.ok && userClaudeJson.value ? userClaudeJson.value.projects : null;
      if (v && typeof v === 'object') for (const [k, p] of Object.entries(v)) if (p && samePath(normalizeInputPath(k), projectRoot)) for (const n of mcpNames(p.mcpServers)) add('mcp', n, CLAUDE);
    }
  }
  return { skills: [...origin.skills.keys()].sort(), mcp: [...origin.mcp.keys()].filter((n) => SAFE_NAME.test(n)).sort(), origin };
}

// ---------------------------------------------------------------- price weights

// Ratios are kept to 4 decimals and applied as integers, so sums do not depend on the order turns
// are added in and never drift. (A month of heavy use stays far below 2^53 at this scale.)
export const WEIGHT_SCALE = 10000;
const SCALE = WEIGHT_SCALE;
const SNAPSHOT_SUFFIX = /^-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isRatio = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const hasQuote = (q) => (typeof q === 'string' && q.length > 0) || (Array.isArray(q) && q.length > 0 && q.every((x) => typeof x === 'string' && x));
const unscale = (n) => Math.round(n / SCALE);

/** One price tier as scaled integers; a kind without a confirmed ratio stays null. */
function compileTier(ratios, P) {
  const pick = (k) => (typeof k === 'string' && isRatio(ratios[k]) ? Math.round(ratios[k] * SCALE) : null);
  const input = ratios.input === undefined ? SCALE : pick('input');
  // A provider can state that a model without a write price charges cache writes as ordinary input.
  const cw = pick(P.kinds.cacheWrite) ?? (P.writeLikeInput ? input : null);
  return { in: input, cw, cwLonger: pick(P.kinds.cacheWriteLonger), cr: pick(P.kinds.cacheRead), out: pick(P.kinds.output) };
}

/** A catalog entry counts only when it says where it came from, when it was checked and what was read. */
function compileFamily(f, P) {
  if (!f || typeof f !== 'object' || typeof f.id !== 'string' || !f.ratios || typeof f.ratios !== 'object') return null;
  if (typeof f.source !== 'string' || !f.source || !isDate(f.verifiedAt) || !hasQuote(f.quote)) return null;
  const lc = f.longContext && typeof f.longContext === 'object' && isRatio(f.longContext.overInputTokens) && f.longContext.ratios && typeof f.longContext.ratios === 'object' ? f.longContext : null;
  return {
    id: f.id, source: f.source, verifiedAt: f.verifiedAt, ratios: f.ratios,
    match: (Array.isArray(f.match) ? f.match : []).filter((m) => typeof m === 'string' && m).map((m) => m.toLowerCase()),
    w: compileTier(f.ratios, P),
    long: lc ? { over: lc.overInputTokens, ratios: lc.ratios, w: compileTier(lc.ratios, P) } : null,
  };
}

/**
 * Read the price ratio catalog. Returns `{ ok: false, reason }` when it cannot be used, otherwise
 * `{ ok: true, bySource }` with one compiled provider per transcript source (`claude`, `codex`).
 */
export function loadWeights(file) {
  const r = readJsonSafe(file);
  if (!r.ok) return { ok: false, reason: r.error === 'missing' ? 'price weights file not found' : 'price weights file could not be read' };
  const doc = r.value;
  const bySource = {};
  const providers = doc && typeof doc === 'object' && doc.providers && typeof doc.providers === 'object' ? doc.providers : {};
  for (const [name, p] of Object.entries(providers)) {
    if (!p || typeof p !== 'object' || typeof p.transcripts !== 'string' || !p.kinds || typeof p.kinds !== 'object') continue;
    const P = { name, kinds: p.kinds, writeLikeInput: !!(p.cacheWrite && p.cacheWrite.withoutWritePrice === 'input'), families: [], def: null, memo: new Map() };
    for (const f of Array.isArray(p.families) ? p.families : []) {
      const c = compileFamily(f, P);
      if (c && c.match.length) P.families.push(c);
    }
    const d = compileFamily(p.default, P);
    if (d) P.def = { ...d, idPrefix: typeof p.default.idPrefix === 'string' && p.default.idPrefix ? p.default.idPrefix.toLowerCase() : null };
    bySource[p.transcripts] = P;
  }
  if (!Object.keys(bySource).length) return { ok: false, reason: 'price weights file lists no provider' };
  return { ok: true, bySource, verifiedAt: doc && isDate(doc.verifiedAt) ? doc.verifiedAt : null };
}

/**
 * The catalog entry for a model id: the entry it equals or continues with a snapshot date, else
 * the provider default (when it has one) for a call that names no model or an unlisted model of
 * the provider's own id prefix. `{ fam: null }` means no confirmed ratio.
 */
export function familyFor(P, model) {
  const key = typeof model === 'string' ? model.trim().toLowerCase() : '';
  const hit = P.memo.get(key);
  if (hit) return hit;
  let res = { fam: null, unlisted: false };
  if (!key || key.startsWith('<')) res = { fam: P.def, unlisted: false };
  else {
    let len = 0;
    for (const f of P.families) {
      for (const m of f.match) {
        if (m.length > len && (key === m || (key.startsWith(m) && SNAPSHOT_SUFFIX.test(key.slice(m.length))))) { res = { fam: f, unlisted: false }; len = m.length; }
      }
    }
    if (!res.fam && P.def && P.def.idPrefix && key.startsWith(P.def.idPrefix)) res = { fam: P.def, unlisted: true };
  }
  P.memo.set(key, res);
  return res;
}

/** The scaled cache-read weight that applies to one turn of this family (its tier), or null when unconfirmed. */
function cacheReadRate(fam, t) {
  const tier = fam.long && t.input + t.cacheWrite + t.cacheRead > fam.long.over ? fam.long.w : fam.w;
  return tier.cr;
}

/** Scaled weights of one turn per token kind, or null when a kind it used has no confirmed ratio. */
export function weighTurn(fam, t) {
  const tier = fam.long && t.input + t.cacheWrite + t.cacheRead > fam.long.over ? fam.long.w : fam.w;
  const cwLonger = Math.min(t.cw1h || 0, t.cacheWrite);
  const cw = t.cacheWrite - cwLonger;
  if ((t.input && tier.in === null) || (cw && tier.cw === null) || (cwLonger && tier.cwLonger === null) || (t.cacheRead && tier.cr === null) || (t.output && tier.out === null)) return null;
  return {
    input: t.input * (tier.in || 0),
    cacheWrite: cw * (tier.cw || 0) + cwLonger * (tier.cwLonger || 0),
    cacheRead: t.cacheRead * (tier.cr || 0),
    output: t.output * (tier.out || 0),
  };
}

// ---------------------------------------------------------------- privacy guard

const PATHLIKE = /[A-Za-z]:[\\/]|\/Users\/|\/home\/|\\\\/;
/** A tool or skill name fit to be an output key: a plain name, never something shaped like a path. */
function safeKey(name) {
  const s = safeName(name);
  return s === null || PATHLIKE.test(s) ? '<other>' : s;
}
function scrubOutput(v, homeDir) {
  if (typeof v === 'string') return PATHLIKE.test(v) || (homeDir && v.toLowerCase().includes(homeDir.toLowerCase())) ? '<other>' : v;
  if (Array.isArray(v)) return v.map((x) => scrubOutput(x, homeDir));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubOutput(x, homeDir)]));
  return v;
}

// ---------------------------------------------------------------- parsing jobs

/**
 * Parse one transcript file into compact threads (turn usage, waste episode turn lists, and per
 * turn the tool calls, skills and shell results it carries). `watch` names the configured skills
 * and MCP servers: a line that cannot be parsed is searched for them, so a name it mentions is
 * never reported as unused. The result is plain data, so it can cross a worker boundary.
 */
async function parseJob(job, from, to, watch) {
  const mentioned = { skills: new Set(), mcp: new Set() };
  const ctx = {
    from, to, unparsable: 0,
    lost(text) {
      ctx.unparsable++;
      for (const n of watch.skills) if (text.includes(n)) mentioned.skills.add(n);
      for (const [n, norm] of watch.mcp) if (text.includes(n) || text.includes(norm)) mentioned.mcp.add(n);
    },
  };
  let threads = [];
  let failed = 0;
  try {
    threads = job.source === 'claude' ? await parseClaudeFile(job.f, ctx) : await parseCodexFile(job.f, ctx);
    threads = threads.map((th) => {
      // Model ids repeat on every turn: keep one list per thread and an index per turn.
      const models = [];
      const index = new Map();
      const modelIndex = (m) => {
        if (typeof m !== 'string' || !m) return -1;
        let i = index.get(m);
        if (i === undefined) { i = models.length; models.push(m); index.set(m, i); }
        return i;
      };
      // Tool and skill names per turn, for the usage counts: one name list per thread, indexes per turn.
      const names = [];
      const nameIndex = new Map();
      const nameOf = (s) => {
        let i = nameIndex.get(s);
        if (i === undefined) { i = names.length; names.push(s); nameIndex.set(s, i); }
        return i;
      };
      return {
        source: th.source, sessionId: th.sessionId, sidechain: th.sidechain, order: th.order, cwd: th.cwd,
        noUsage: !!th.noUsage, callCount: th.callCount || 0, unrecognized: th.unrecognized || [],
        eps: episodesOf(th),
        hooks: th.hooks || [],
        turns: th.turns.map((t) => {
          const o = { id: t.id, ts: t.ts, input: t.input, cacheWrite: t.cacheWrite, cacheRead: t.cacheRead, output: t.output, cw1h: t.cw1h || 0, m: modelIndex(t.model) };
          if (t.tools && t.tools.length) o.tc = t.tools.map(nameOf);
          if (t.skills && t.skills.length) o.sk = t.skills.map(nameOf);
          if (t.reads && t.reads.length) o.rd = t.reads.map(nameOf);
          if (typeof t.attr === 'string') o.at = nameOf(t.attr);
          // Shell results as flat pairs: command head (an index into names), characters.
          if (t.res && t.res.length) o.rs = t.res.map((x, i) => (i % 2 === 0 ? nameOf(x) : x));
          return o;
        }),
        models,
        names,
        slash: (th.slash || []).map(([ts, uuid, name]) => [ts, uuid, nameOf(name)]),
        codexUse: th.codexUse || null,
      };
    });
  } catch { failed = 1; threads = []; }
  return { threads, failed, unparsable: ctx.unparsable, mentioned: { skills: [...mentioned.skills], mcp: [...mentioned.mcp] } };
}

/** Parse all jobs, CPU-parallel in worker threads when there are many files. */
async function runJobs(jobs, from, to, watch, { workers, onDone }) {
  if (workers > 0 && jobs.length > 0) {
    try {
      const results = new Array(jobs.length);
      let next = 0;
      await Promise.all(Array.from({ length: workers }, () => new Promise((resolve, reject) => {
        const w = new Worker(new URL(import.meta.url), { workerData: { sessionImpactWorker: true, from, to, watch } });
        const feed = () => {
          if (next >= jobs.length) { w.terminate().then(() => resolve()); return; }
          const i = next++;
          w.postMessage({ i, job: jobs[i] });
        };
        w.on('message', ({ i, res }) => { results[i] = res; onDone(); feed(); });
        w.on('error', reject);
        w.on('online', feed);
      })));
      return results;
    } catch {
      warn('worker threads unavailable; parsing on one thread');
    }
  }
  return pool(jobs, 8, async (job) => { const r = await parseJob(job, from, to, watch); onDone(); return r; });
}

if (!isMainThread && workerData && workerData.sessionImpactWorker) {
  parentPort.on('message', async ({ i, job }) => {
    parentPort.postMessage({ i, res: await parseJob(job, workerData.from, workerData.to, workerData.watch) });
  });
}

// ---------------------------------------------------------------- collect

/**
 * How well the tool calls of one source were read, from its coverage counts: `not-read`,
 * `complete`, `partial` (lines lost: a name they mention is unknown) or `unknown` (files, call
 * shapes or rollouts lost: every name that shows no use is unknown). See METHODS.coverage.
 */
export function toolCallCoverage(c) {
  if (!c.read) return 'not-read';
  if (c.filesFailed > 0 || c.unrecognizedCallRecords > 0 || c.rolloutsWithoutProject > 0) return 'unknown';
  return c.unparsableLines > 0 ? 'partial' : 'complete';
}

export async function collect({ projectRoot, configDirs = null, days = 30, scope = 'project', progress = false, workers = null, now = Date.now(), weightsFile = null, sources = null, codexHomeDirs = null }) {
  const from = now - days * DAY;

  // Which transcripts are read: both agents unless `sources` names one.
  const want = new Set(sources && sources.length ? SOURCES.filter((x) => sources.includes(x)) : SOURCES);
  const claudeDirs = configDirs && configDirs.length
    ? configDirs.map((p) => ({ path: normalizeInputPath(p) })).filter((d) => isDir(d.path))
    : claudeConfigDirs();
  const codexHomes = !want.has('codex') ? [] : codexHomeDirs && codexHomeDirs.length
    ? codexHomeDirs.map((p) => ({ path: normalizeInputPath(p) })).filter((d) => isDir(d.path))
    : codexDirs();
  const claudeFiles = [];
  const seenProjects = new Set();
  for (const d of want.has('claude') ? claudeDirs : []) {
    const pdir = path.join(d.path, 'projects');
    const real = realpathSafe(pdir);
    if (!real) continue;
    const key = IS_WIN ? real.toLowerCase() : real;
    if (seenProjects.has(key)) continue;
    seenProjects.add(key);
    for (const e of readdirSafe(pdir)) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (scope === 'project' && !matchesProjectDir(e.name, projectRoot)) continue;
      claudeFiles.push(...listClaudeTranscripts(path.join(pdir, e.name), from));
    }
  }
  const codexFiles = [];
  for (const d of codexHomes) codexFiles.push(...listJsonl(path.join(d.path, 'sessions'), 4, from));

  // What the scope configures. Known before the files are read, so that a line that cannot be
  // parsed can still be searched for these names.
  const named = { claude: !!(configDirs && configDirs.length), codex: !!(codexHomeDirs && codexHomeDirs.length) };
  const conf = configuredContext({ scope, projectRoot, claudeDirs, codexHomes, want, named });
  const watch = { skills: conf.skills, mcp: conf.mcp.map((n) => [n, normalizeMcpName(n)]) };

  const jobs = [...claudeFiles.map((f) => ({ source: 'claude', f })), ...codexFiles.map((f) => ({ source: 'codex', f }))];
  let done = 0;
  const nWorkers = workers === null ? Math.max(0, Math.min(8, os.cpus().length - 1)) : workers;
  const parsed = await runJobs(jobs, from, now, watch, {
    workers: workers !== null ? workers : (jobs.length >= 32 ? nWorkers : 0),
    onDone: () => { done++; if (progress && (done % 250 === 0 || done === jobs.length)) warn(`progress: ${done}/${jobs.length} files`); },
  });

  // Coverage: what was read of each source, and what was not. It decides below whether a count
  // of 0 is a measured zero.
  const cover = Object.fromEntries(SOURCES.map((s) => [s, { read: want.has(s), files: 0, filesFailed: 0, unparsableLines: 0 }]));
  Object.assign(cover.codex, { unrecognizedCallRecords: 0, rolloutsWithoutProject: 0 });
  const oddKinds = new Map();
  const mentioned = { skills: new Set(), mcp: new Set() };
  const threads = [];
  parsed.forEach((r, i) => {
    const c = cover[jobs[i].source];
    if (r.failed) c.filesFailed++;
    // Project scope: a Codex rollout belongs to the project by its recorded cwd.
    const keep = r.threads.filter((t) => t.source !== 'codex' || scope === 'user' || matchesProjectCwd(t.cwd, projectRoot));
    if (!keep.length && r.threads.length) {
      // A rollout that records no cwd cannot be given to any project: its calls may be this one's.
      if (r.threads.some((t) => t.source === 'codex' && t.cwd === null && t.callCount > 0)) c.rolloutsWithoutProject++;
      return;
    }
    if (!r.failed) c.files++;
    c.unparsableLines += r.unparsable;
    threads.push(...keep);
    for (const s of r.mentioned.skills) mentioned.skills.add(s);
    for (const s of r.mentioned.mcp) mentioned.mcp.add(s);
    for (const t of keep) {
      for (const [kind, n] of t.unrecognized) {
        cover.codex.unrecognizedCallRecords += n;
        oddKinds.set(kind, (oddKinds.get(kind) || 0) + n);
      }
    }
  });
  const failedFiles = cover.claude.filesFailed + cover.codex.filesFailed;
  if (failedFiles) warn(`${failedFiles} transcript file(s) could not be read; skipped`);
  for (const s of SOURCES) cover[s].toolCalls = toolCallCoverage(cover[s]);
  /** A source whose tool calls were not all read: nothing can be said about what it did not show. */
  const blind = (s) => cover[s].toolCalls === 'unknown';
  threads.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));

  // THE definition of a counted model call, used by every number below: its own timestamp falls
  // in the window and it is not a replayed copy. Claude message ids are unique per model call, so
  // an id seen in an earlier file is a copy.
  const seenIds = new Set();
  let duplicateTurns = 0;
  let duplicateTokens = 0;
  for (const th of threads) {
    for (const t of th.turns) {
      t.win = t.ts !== null && t.ts >= from && t.ts <= now;
      t.dup = false;
      if (t.id !== null && th.source === 'claude') {
        if (seenIds.has(t.id)) {
          t.dup = true;
          if (t.win) { duplicateTurns++; duplicateTokens += turnTokens(t); }
        } else seenIds.add(t.id);
      }
      t.counted = t.win && !t.dup;
      t.eff = t.counted ? turnTokens(t) : 0;
    }
  }

  // Price weights: every counted turn gets its input-token equivalents (scaled integers). One
  // turn that cannot be weighted with a confirmed ratio turns the whole weighted view off.
  const W = loadWeights(weightsFile || DEFAULT_WEIGHTS_FILE);
  const wByKind = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const famStats = new Map();
  const unpriced = new Map();
  let unpricedTurns = 0;
  let unlistedTurns = 0;
  for (const th of threads) {
    const P = W.ok ? W.bySource[th.source] || null : null;
    // A call that names no model re-reads the starting context at the rate of the session's first model.
    const first = th.turns[0];
    const firstFam = P && first && first.m >= 0 ? familyFor(P, th.models[first.m]).fam : null;
    for (const t of th.turns) {
      t.wAll = 0;
      t.wCtx = 0;
      t.cr = null;
      if (!W.ok || t.eff === 0) continue;
      const model = t.m >= 0 ? th.models[t.m] : null;
      const hit = P ? familyFor(P, model) : null;
      const parts = hit && hit.fam ? weighTurn(hit.fam, t) : null;
      if (!parts) {
        unpricedTurns++;
        const label = `${th.source}: ${model ? safeName(model) : 'no model named'}`;
        unpriced.set(label, (unpriced.get(label) || 0) + 1);
        continue;
      }
      t.wCtx = parts.input + parts.cacheWrite + parts.cacheRead;
      t.cr = cacheReadRate(t.m < 0 && firstFam ? firstFam : hit.fam, t);
      t.wAll = t.wCtx + parts.output;
      wByKind.input += parts.input; wByKind.cacheWrite += parts.cacheWrite; wByKind.cacheRead += parts.cacheRead; wByKind.output += parts.output;
      if (hit.unlisted) unlistedTurns++;
      const key = `${P.name}/${hit.fam.id}`;
      const st = famStats.get(key) || { fam: hit.fam, turns: 0, tokens: 0, w: 0 };
      st.turns++; st.tokens += t.eff; st.w += t.wAll;
      famStats.set(key, st);
    }
  }
  const weighted = W.ok && unpricedTurns === 0;

  const byKind = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const sessions = new Map();
  const activeDays = new Set();
  const starts = [];
  const waste = Object.fromEntries(KINDS.map((k) => [k, { episodes: 0, sessions: new Set(), tokens: 0, weighted: 0, heads: {} }]));
  const hookOutcomes = { denials: {}, continues: {}, promptBlocks: 0, stopped: 0, otherBlocking: {}, unknown: 0 };
  const sessKey = (th) => `${th.source}\u0000${th.sessionId}`;
  let codexNoUsage = 0;
  let startsWeighted = 0;
  let startTurns = 0; // model calls of the sessions whose start was measured
  let carried = 0; // starting context counted again on each later call
  let carriedScaled = 0;
  let carriedUnrated = 0;

  for (const th of threads) {
    if (th.source === 'codex' && th.noUsage) codexNoUsage++;
    const k = sessKey(th);
    if (!sessions.has(k)) sessions.set(k, { source: th.source, id: th.sessionId, tokens: 0, wasteTokens: 0, active: false, peak: 0 });
    const s = sessions.get(k);
    for (const t of th.turns) {
      if (!t.counted) continue;
      s.active = true;
      s.tokens += t.eff;
      byKind.input += t.input; byKind.cacheWrite += t.cacheWrite; byKind.cacheRead += t.cacheRead; byKind.output += t.output;
      activeDays.add(new Date(t.ts).toISOString().slice(0, 10));
      if (!th.sidechain) s.peak = Math.max(s.peak, contextOf(t));
    }
    if (!th.sidechain && th.turns.length && th.turns[0].counted) {
      const firstContext = contextOf(th.turns[0]);
      starts.push(firstContext);
      startsWeighted += th.turns[0].wCtx;
      startTurns++;
      for (let i = 1; i < th.turns.length; i++) {
        const t = th.turns[i];
        if (!t.counted) continue;
        startTurns++;
        const again = Math.min(firstContext, contextOf(t)); // never more than this call really sent
        carried += again;
        if (again > 0) { if (t.cr === null) carriedUnrated++; else carriedScaled += again * t.cr; }
      }
    }
    // Hook outcomes, waste or not, count with the turn they follow.
    for (const ep of th.eps) {
      if (ep.kind !== 'hook-block') continue;
      const t = th.turns[ep.turns[0]];
      if (t && t.counted) bump(hookOutcomes.denials, ep.event || 'PreToolUse');
    }
    for (const [i, key] of th.hooks || []) {
      const t = th.turns[i];
      if (!t || !t.counted) continue;
      const [kind, event] = key.split(':');
      if (kind === 'continue') bump(hookOutcomes.continues, event);
      else if (kind === 'other') bump(hookOutcomes.otherBlocking, event);
      else if (kind === 'prompt-block') hookOutcomes.promptBlocks++;
      else if (kind === 'stopped') hookOutcomes.stopped++;
      else if (kind === 'unknown') hookOutcomes.unknown++;
    }
    // Waste: claim turns in priority order; a turn belongs to one kind at most.
    const owner = new Array(th.turns.length).fill(null);
    const eps = th.eps;
    for (const kind of KINDS) {
      for (const ep of eps) {
        if (ep.kind !== kind) continue;
        let kept = false;
        let tokens = 0;
        let weightedTokens = 0;
        for (const i of ep.turns) {
          const t = th.turns[i];
          if (!t || !t.counted) continue;
          if (owner[i] !== null && owner[i] !== kind) continue;
          kept = true;
          if (owner[i] === null) { owner[i] = kind; tokens += t.eff; weightedTokens += t.wAll; }
        }
        if (!kept) continue;
        const w = waste[kind];
        w.episodes++;
        w.tokens += tokens;
        w.weighted += weightedTokens;
        w.sessions.add(k);
        for (const hd of ep.heads) bump(w.heads, hd);
        s.wasteTokens += tokens;
      }
    }
  }

  const active = [...sessions.values()].filter((s) => s.active);
  starts.sort((a, b) => a - b);
  const peaks = active.filter((s) => s.peak > 0).map((s) => s.peak).sort((a, b) => a - b);

  // Everything that is not a token total comes from the same counted events. A configured name
  // with nothing counted gets 0 when its absence was measured and null when it was not: a line
  // that could not be parsed names it, or a source that could have used it was not read in full.
  const unknownZero = (kind, name) => mentioned[kind].has(name) || [...conf.origin[kind].get(name)].some(blind);
  const usage = usageCounts(threads, from, now, conf, unknownZero);
  const { skillInvocations, mcpCalls } = usage;
  const unknownNames = [...conf.skills.filter((n) => skillInvocations[n] === null), ...conf.mcp.filter((n) => mcpCalls[n] === null)];
  const shellChars = [...usage.heads.values()].reduce((a, r) => a + r.chars, 0);

  const notes = codexFiles.length && codexNoUsage && !active.some((s) => s.source === 'codex') ? ['codex: no usage data'] : [];
  if (want.size < SOURCES.length) notes.push(`transcript sources read: ${[...want].join(', ')}`);
  for (const s of SOURCES) {
    const c = cover[s];
    if (c.toolCalls !== 'unknown') continue;
    const why = [];
    if (c.filesFailed) why.push(`${c.filesFailed} transcript file(s) could not be read`);
    if (c.unrecognizedCallRecords) why.push(`${c.unrecognizedCallRecords} record(s) that look like a tool call have a shape that is not read`);
    if (c.rolloutsWithoutProject) why.push(`${c.rolloutsWithoutProject} rollout(s) with tool calls record no working directory`);
    notes.push(`${s}: tool calls not fully read (${why.join('; ')}); a skill or MCP server it could have used and that shows no use is reported as unknown, not as unused`);
  }
  if (unknownNames.some((n) => mentioned.skills.has(n) || mentioned.mcp.has(n))) notes.push('lines that could not be parsed name a configured skill or MCP server that shows no use; it is reported as unknown, not as unused');
  if (!W.ok) notes.push(`weighted totals omitted: ${W.reason}`);
  else if (unpricedTurns) {
    const which = [...unpriced].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([label, n]) => `${label} (${n})`).join(', ');
    notes.push(`weighted totals omitted: ${unpricedTurns} model call(s) have no confirmed price ratio (${which})`);
  } else if (carriedUnrated) notes.push(`carried context not weighted: ${carriedUnrated} model call(s) have no confirmed cache-read ratio`);
  if (W.ok && !unpricedTurns && unlistedTurns) notes.push(`${unlistedTurns} model call(s) name a model that is not in the price list; they were weighted with the provider's standard ratios`);

  const result = {
    windowDays: days,
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    scope,
    sources: { claude: active.filter((s) => s.source === 'claude').length, codex: active.filter((s) => s.source === 'codex').length },
    sessions: active.length,
    activeDays: activeDays.size,
    unparsableLines: cover.claude.unparsableLines + cover.codex.unparsableLines,
    coverage: {
      claude: cover.claude,
      // The kinds are type names taken from the rollouts: schema identifiers, masked like any other name.
      codex: { ...cover.codex, unrecognizedKinds: [...oddKinds].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 5).map(([kind]) => safeKey(kind)) },
      method: METHODS.coverage,
    },
    totalTokens: byKind.input + byKind.cacheWrite + byKind.cacheRead + byKind.output,
    byKind,
    ...(weighted ? {
      weightedTotal: unscale(wByKind.input + wByKind.cacheWrite + wByKind.cacheRead + wByKind.output),
      weightedByKind: { input: unscale(wByKind.input), cacheWrite: unscale(wByKind.cacheWrite), cacheRead: unscale(wByKind.cacheRead), output: unscale(wByKind.output) },
      weights: null, // filled after the privacy scrub: it holds source URLs from the catalog
    } : {}),
    duplicates: { turnsDropped: duplicateTurns, tokensDropped: duplicateTokens },
    method: `${METHODS.turn} ${METHODS.window}`,
    contextAtStart: {
      perSessionMedian: median(starts), perSessionP90: percentile(starts, 0.9), total: starts.reduce((a, b) => a + b, 0),
      ...(weighted ? { weightedTotal: unscale(startsWeighted) } : {}),
      turns: startTurns, carriedTokens: carried,
      ...(weighted && carriedUnrated === 0 ? { carriedWeighted: unscale(carriedScaled) } : {}),
      sessionsMeasured: starts.length, method: METHODS.contextAtStart, carriedMethod: METHODS.carried,
    },
    contextPeak: { median: median(peaks), p90: percentile(peaks, 0.9), sessionsOver160k: peaks.filter((p) => p > PEAK_LIMIT).length, sessionsMeasured: peaks.length, method: METHODS.contextPeak },
    waste: OUTPUT_ORDER.map((kind) => {
      const w = waste[kind];
      return {
        kind, label: LABELS[kind], episodes: w.episodes, sessions: w.sessions.size, tokens: w.tokens,
        ...(weighted ? { weighted: unscale(w.weighted) } : {}),
        basis: 'measured', method: METHODS[kind],
        topHeads: Object.entries(w.heads).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([hd]) => hd),
      };
    }),
    wasteMethod: METHODS.dedupe,
    hookOutcomes: { ...hookOutcomes, method: METHODS.hookOutcomes },
    unusedContext: {
      // Measured zeros only. A name whose absence could not be established is in the Unknown lists.
      skillsNeverInvoked: conf.skills.filter((n) => skillInvocations[n] === 0),
      mcpServersNeverCalled: conf.mcp.filter((n) => mcpCalls[n] === 0),
      skillsUnknown: conf.skills.filter((n) => skillInvocations[n] === null),
      mcpServersUnknown: conf.mcp.filter((n) => mcpCalls[n] === null),
      skillsConfigured: conf.skills.length,
      mcpServersConfigured: conf.mcp.length,
      method: METHODS.unusedContext,
    },
    skillInvocations,
    mcpCalls,
    toolCalls: usage.toolCalls,
    usageMethod: METHODS.usage,
    toolOutput: {
      shellResultChars: shellChars,
      shellResultTokensApprox: approxTokens(shellChars),
      byHead: [...usage.heads].sort((a, b) => b[1].chars - a[1].chars || a[0].localeCompare(b[0])).slice(0, 25).map(([head, r]) => ({ head, calls: r.calls, chars: r.chars })),
      method: METHODS.toolOutput,
    },
    topSessions: active.sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id)).slice(0, 10).map((s) => ({ id: s.id, source: s.source, tokens: s.tokens, wasteTokens: s.wasteTokens })),
    notes,
  };
  const out = scrubOutput(result, home());
  if (weighted) out.weights = weightsBlock(famStats, W, weightsFile);
  return out;
}

/**
 * Every count that is not a token total, in one pass over the same counted events as the token
 * totals: tool calls, MCP calls and skill invocations as `{ name: count }` maps, and shell output
 * by command head. What hangs on a Claude turn (its tool calls, the skills it names, the results
 * that answer its calls) counts exactly when the turn does; Codex calls were filtered by their own
 * time, once per call id, when the rollout was parsed. `unknownZero(kind, name)` says whether a
 * configured name with nothing counted is unknown (null) rather than a measured 0.
 */
function usageCounts(threads, from, to, conf, unknownZero) {
  const toolCalls = {};
  const servers = new Map(); // MCP server, as it appears in the tool name -> calls
  const heads = new Map(); // command head -> { calls, chars }
  const tool = (name, n = 1) => {
    bump(toolCalls, safeKey(name), n);
    if (typeof name !== 'string' || !name.startsWith('mcp__')) return;
    const end = name.indexOf('__', 5);
    if (end > 5) servers.set(name.slice(5, end), (servers.get(name.slice(5, end)) || 0) + n);
  };
  const output = (head, chars) => {
    const row = heads.get(head) || { calls: 0, chars: 0 };
    row.calls++;
    row.chars += chars;
    heads.set(head, row);
  };
  const bareOf = (name) => name.slice(name.lastIndexOf(':') + 1);
  // Per session: explicit invocations (Skill tool, slash command) by name, and the skills that
  // only left a trace (attribution, a read of their SKILL.md), one name per bare skill name.
  const perSession = new Map();
  const sessionOf = (th) => {
    const k = `${th.source}\u0000${th.sessionId}`;
    let s = perSession.get(k);
    if (!s) { s = { calls: new Map(), traces: new Map() }; perSession.set(k, s); }
    return s;
  };
  const call = (s, name) => s.calls.set(name, (s.calls.get(name) || 0) + 1);
  const trace = (s, name) => {
    const b = bareOf(name);
    const cur = s.traces.get(b);
    if (cur === undefined || (!cur.includes(':') && name.includes(':'))) s.traces.set(b, name); // keep the plugin:skill form
  };
  const seenSlash = new Set();
  for (const th of threads) {
    const s = sessionOf(th);
    const names = th.names || [];
    for (const t of th.turns) {
      if (!t.counted) continue;
      if (t.tc) for (const i of t.tc) tool(names[i]);
      if (t.sk) for (const i of t.sk) call(s, names[i]);
      if (t.rd) for (const i of t.rd) trace(s, names[i]);
      if (t.at !== undefined) trace(s, names[t.at]);
      if (t.rs) for (let i = 0; i < t.rs.length; i += 2) output(names[t.rs[i]], t.rs[i + 1]);
    }
    for (const [ts, uuid, i] of th.slash || []) {
      if (ts === null || ts < from || ts > to) continue;
      if (uuid !== null) { if (seenSlash.has(uuid)) continue; seenSlash.add(uuid); } // replayed in a resumed session
      call(s, names[i]);
    }
    if (th.codexUse) {
      for (const [name, n] of Object.entries(th.codexUse.tools)) tool(name, n);
      for (const name of Object.keys(th.codexUse.reads)) trace(s, name);
      for (const [head, chars] of th.codexUse.heads) output(head, chars);
    }
  }
  const skillInvocations = {};
  const add = (name, n) => {
    const key = safeKey(name);
    bump(skillInvocations, key, n);
    if (key !== '<other>' && key.includes(':') && bareOf(key)) bump(skillInvocations, bareOf(key), n); // so a lookup by folder name works
  };
  for (const s of perSession.values()) {
    const called = new Set();
    for (const [name, n] of s.calls) { add(name, n); called.add(bareOf(name)); }
    for (const [bare, name] of s.traces) if (!called.has(bare)) add(name, 1);
  }
  // MCP calls per server, under the configured name when this scope configures the server. Two
  // configured names that give the same tool prefix cannot be told apart: both get the calls.
  const configured = new Map();
  for (const n of conf.mcp) configured.set(normalizeMcpName(n), [...(configured.get(normalizeMcpName(n)) || []), n]);
  const mcpCalls = {};
  for (const [server, n] of servers) for (const name of configured.get(server) || [safeKey(server)]) bump(mcpCalls, name, n);
  // What the scope configures is listed even when nothing was counted: 0 when that absence was
  // measured, null when it could not be established. A missing key is never a zero.
  for (const n of conf.skills) if (!Object.hasOwn(skillInvocations, n)) skillInvocations[n] = unknownZero('skills', n) ? null : 0;
  for (const n of conf.mcp) if (!Object.hasOwn(mcpCalls, n)) mcpCalls[n] = unknownZero('mcp', n) ? null : 0;
  // Most used first; names with an unknown count go last.
  const rank = (v) => (v === null ? -1 : v);
  const sortDesc = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => rank(b[1]) - rank(a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  return { toolCalls: sortDesc(toolCalls), skillInvocations: sortDesc(skillInvocations), mcpCalls: sortDesc(mcpCalls), heads };
}

/** Which ratios produced the weighted figures: one entry per model family that had tokens in the window. */
function weightsBlock(famStats, W, weightsFile) {
  const rows = [...famStats].sort((a, b) => b[1].tokens - a[1].tokens || a[0].localeCompare(b[0]));
  const perModelFamily = {};
  const sources = [];
  let verifiedAt = null;
  for (const [key, s] of rows) {
    perModelFamily[key] = {
      turns: s.turns, tokens: s.tokens, weighted: unscale(s.w),
      ratios: { input: 1, ...s.fam.ratios },
      ...(s.fam.long ? { longContext: { overInputTokens: s.fam.long.over, ratios: s.fam.long.ratios } } : {}),
      source: s.fam.source, verifiedAt: s.fam.verifiedAt,
    };
    if (!sources.includes(s.fam.source)) sources.push(s.fam.source);
    if (verifiedAt === null || s.fam.verifiedAt < verifiedAt) verifiedAt = s.fam.verifiedAt;
  }
  return {
    unit: 'input-token equivalents',
    source: weightsFile ? path.basename(weightsFile) : WEIGHTS_DISPLAY,
    verifiedAt: verifiedAt || W.verifiedAt,
    sources,
    perModelFamily,
    method: METHODS.weighted,
  };
}

if (isMainThread && isMain(import.meta.url)) {
  const args = parseArgs();
  const projectRoot = normalizeInputPath(typeof args.cwd === 'string' ? args.cwd : process.cwd());
  const days = args.days !== undefined ? Number(args.days) : 30;
  if (!Number.isFinite(days) || days <= 0) { warn('--days must be a positive number'); process.exit(2); }
  const scope = typeof args.scope === 'string' ? args.scope : 'project';
  if (!['project', 'user'].includes(scope)) { warn('--scope must be project or user'); process.exit(2); }
  if (scope === 'project' && !isDir(projectRoot)) { warn('--cwd is not a directory'); process.exit(2); }
  const configDirs = typeof args['config-dirs'] === 'string' ? args['config-dirs'].split(',').map((s) => s.trim()).filter(Boolean) : null;
  const started = Date.now();
  const workers = args.workers !== undefined ? Math.max(0, Math.floor(Number(args.workers)) || 0) : null;
  const weightsFile = typeof args.weights === 'string' ? normalizeInputPath(args.weights) : null;
  const list = (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
  let sources = null;
  if (args.sources !== undefined) {
    sources = [...new Set(list(args.sources).map((x) => x.toLowerCase()))];
    if (!sources.length || sources.some((x) => !SOURCES.includes(x))) { warn('--sources must be claude, codex or claude,codex'); process.exit(2); }
  }
  const codexHomeDirs = args['codex-dirs'] !== undefined ? list(args['codex-dirs']) : null;
  if (codexHomeDirs !== null && !codexHomeDirs.length) { warn('--codex-dirs needs at least one directory'); process.exit(2); }
  collect({ projectRoot, configDirs, days, scope, progress: args.progress === true, workers, weightsFile, sources, codexHomeDirs }).then((res) => {
    printJson({ generatedAt: new Date().toISOString(), project: scope === 'project' ? path.basename(projectRoot) : null, ...res, durationMs: Date.now() - started });
  }).catch((e) => {
    warn(`failed: ${e && e.code ? e.code : 'error'}`);
    process.exit(1);
  });
}
