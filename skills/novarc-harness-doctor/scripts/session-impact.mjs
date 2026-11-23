#!/usr/bin/env node
// session-impact.mjs --cwd <project root> [--days 30] [--config-dirs a,b] [--scope project|user] [--progress] [--weights <file>]
//                    [--sources claude,codex] [--codex-dirs a,b]
//
// Measures what a harness costs over a window, from local agent session transcripts: tokens per
// kind (input, cache write, cache read, output), the context every session starts with and peaks
// at, and the tokens spent in waste episodes (retry loops, identical-call loops, missing commands,
// hook blocks, corrected work, sessions ending on an error, exploration before the first edit).
// Also lists skills and MCP servers that were configured but never used, and shell output volume
// by command head. Aggregates only: it never prints message text, command lines beyond the
// 2-token head, tool output, file paths from inside a transcript, or absolute home paths.
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
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { IS_WIN, parseArgs, isMain, printJson, warn, normalizeInputPath, isDir, isFile, readdirSafe, realpathSafe, readJsonSafe, readTextSafe, home, approxTokens } from './lib/common.mjs';
import { claudeConfigDirs, codexDirs, agentsDirs } from './lib/locations.mjs';
import { scanCodexToml } from './discover.mjs';
import {
  SHELL_TOOLS, EDIT_TOOLS, EXPLORE_TOOLS, NOT_FOUND_RE, SAFE_NAME, safeName, resultText, isHumanText, isCorrection,
  hookBlockText, hookBlockAttachment, skillsReadIn, normalizeMcpName, eachJsonLine, listClaudeTranscripts, listJsonl, pool,
  commandHead, codexCommandString, matchesProjectDir, matchesProjectCwd,
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
  'hook-block': 'Calls blocked by a hook',
  'error-end': 'Sessions ending on an error',
  exploration: 'Exploration before the first edit',
};
const METHODS = {
  turn: 'Turn tokens are input + cacheWrite + cacheRead + output of one model call; Claude entries that repeat a message id (one entry per content block) are merged by taking each field\'s maximum, and an id already seen in an earlier file (resumed or forked sessions) is dropped as a duplicate; Codex turns are the deltas of the cumulative total_token_usage between token_count events.',
  window: 'Files modified before the window start are skipped, and inside a file only model calls whose own timestamp falls in the window are counted.',
  contextAtStart: 'Input + cacheWrite + cacheRead of the first model call of each top-level session (subagents excluded), counted only when that call falls inside the window and is not a duplicate of an earlier file.',
  contextPeak: 'Per top-level session (subagents excluded), the largest input + cacheWrite + cacheRead of any in-window model call; sessionsOver160k counts sessions whose peak exceeded 160,000 tokens.',
  retry: 'A shell command head that fails (is_error or non-zero exit) and is run again with the same head at least 3 more times before a success or the end of the thread; tokens are every turn from the first failure to the resolving success (or the last attempt).',
  loop: 'At least 5 consecutive tool calls in a thread with the same tool name and an identical input (compared by hash, never stored); tokens are the turns from the first to the last call of the run, minus turns already claimed by a retry loop.',
  notfound: 'A failed shell command whose output says the command or file does not exist (command not found, is not recognized as, No such file or directory); tokens are every turn from that failure to the last consecutive not-found attempt of the same head.',
  'hook-block': 'A tool result marked as an error whose text says a hook blocked or denied the call (plus hook attachments of a blocking type); tokens are the turn that issued the blocked call.',
  correction: 'A real user message (not a tool result, command wrapper or compaction summary) shorter than 280 characters that matches pt/en correction markers; tokens are the model turns between the previous user message and the correction (top-level threads only).',
  'error-end': 'A top-level session whose last tool result is an error; tokens are its last 3 turns.',
  exploration: 'Turns that only issued Read/Grep/Glob/LS-type calls after a real user message and before the first Edit/Write/MultiEdit/NotebookEdit that follows it (segments with no edit are not counted; top-level Claude threads only).',
  unusedContext: 'Skills are folders with a SKILL.md in the scope\'s skills dirs that were never invoked in the window (Skill tool, slash command, skill attribution or a read of their SKILL.md); MCP servers are names configured in the scope\'s settings, .mcp.json, ~/.claude.json and Codex config.toml whose tools (mcp__<name>__*) were never called.',
  carried: 'Derived from measured values, not measured itself. For each top-level session measured above: the context of its first model call, counted once for every later model call of that session in the window (turns counts the first call too), and capped on each later call at what that call really sent (input + cacheWrite + cacheRead), so a compaction that shrank the context never adds more than was sent. The assumption is that the starting context stays loaded for the whole session. carriedWeighted prices each of those re-reads at the cache-read ratio of the model of the later call (of the session\'s first call when the later call names no model), because later calls read the starting context from the prompt cache.',
  usage: 'Counts for the window. toolCalls: tool calls by tool name, from model calls whose own timestamp falls in the window and that are not replayed copies; Codex completed commands count as exec_command and its MCP calls as mcp__<server>__<tool>, by event time. mcpCalls: the mcp__<server>__* calls summed per server, under the name this scope configures the server with when there is one, otherwise the name as it appears in the tool name. skillInvocations: per session, Skill tool calls plus slash commands the user typed (every command under its own name, built-in ones included); a session where a skill only shows up as skill attribution or as a read of its SKILL.md counts once. A skill named plugin:skill is listed under that name and again under its bare name, so these values must not be summed. Skills and servers the scope configures are listed with 0 when nothing was counted for them in the window.',
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
  return { source, sessionId, sidechain, order, turns: [], byId: new Map(), events: [], calls: new Map(), cwd: null, slash: [] };
}

// ---------------------------------------------------------------- Claude

// Decide from the first bytes of a line. Assistant lines put "message" (with its role) before
// "type"; attachment and system lines matter only when they are about a hook.
function claudeWant(head) {
  if (head.startsWith('{"type":"api-request')) return false;
  if (head.includes('"role":"assistant"') || head.includes('"role":"user"') || head.includes('"type":"assistant"') || head.includes('"type":"user"')) return true;
  return (head.includes('"type":"attachment"') || head.includes('"attachment":') || head.includes('"type":"system"')) && head.includes('hook');
}

async function parseClaudeFile(entry, ctx) {
  const main = newThread('claude', entry.sessionId, entry.sidechainFile, `${entry.file}\u0000a`);
  const side = entry.sidechainFile ? main : newThread('claude', entry.sessionId, true, `${entry.file}\u0000b`);
  await eachJsonLine(entry.file, (o) => {
    const th = o.isSidechain === true ? side : main;
    const msg = o.message && typeof o.message === 'object' ? o.message : null;
    const content = msg ? msg.content : undefined;
    if (o.type === 'assistant' && msg) {
      if (typeof o.attributionSkill === 'string') ctx.usedSkills.add(o.attributionSkill);
      const id = typeof msg.id === 'string' && msg.id ? msg.id : (typeof o.uuid === 'string' ? o.uuid : null);
      let idx = id !== null ? th.byId.get(id) : undefined;
      if (idx === undefined) {
        idx = th.turns.length;
        // tools / skills / reads / attr feed the usage counts only (toolCalls, skillInvocations, mcpCalls).
        th.turns.push({ id, ts: parseTs(o.timestamp), input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cw1h: 0, model: null, calls: [], tools: [], skills: [], reads: [], attr: null });
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
          if (!c || c.type !== 'tool_use' || typeof c.name !== 'string') continue;
          const input = c.input && typeof c.input === 'object' ? c.input : {};
          const call = { k: 'call', turn: idx, name: c.name, hash: inputHash(c.input), head: null, shell: SHELL_TOOLS.has(c.name), explore: EXPLORE_TOOLS.has(c.name), edit: EDIT_TOOLS.has(c.name) };
          t.tools.push(c.name);
          if (call.shell && typeof input.command === 'string') {
            call.head = commandHead(input.command);
            for (const s of skillsReadIn(input.command)) { ctx.usedSkills.add(s); t.reads.push(s); }
          }
          if (c.name === 'Read' && typeof input.file_path === 'string') for (const s of skillsReadIn(input.file_path)) { ctx.usedSkills.add(s); t.reads.push(s); }
          if (c.name === 'Skill') {
            const sk = input.skill || input.name || input.command;
            if (typeof sk === 'string') { const name = sk.trim().replace(/^\//, ''); ctx.usedSkills.add(name); if (name) t.skills.push(name); }
          }
          if (c.name.startsWith('mcp__')) {
            const end = c.name.indexOf('__', 5);
            if (end > 5) ctx.usedMcp.add(c.name.slice(5, end));
          }
          t.calls.push(call);
          th.events.push(call);
          if (typeof c.id === 'string') th.calls.set(c.id, call);
        }
      }
    } else if (o.type === 'user' && msg) {
      let sawResult = false;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || c.type !== 'tool_result') continue;
          sawResult = true;
          const call = th.calls.get(c.tool_use_id) || null;
          const text = resultText(c.content);
          const isErr = c.is_error === true;
          th.events.push({ k: 'result', call, isErr, notFound: isErr && NOT_FOUND_RE.test(text), hook: isErr && hookBlockText(text) });
          if (call && call.shell) {
            const ts = parseTs(o.timestamp);
            if (ts === null || (ts >= ctx.from && ts <= ctx.to)) {
              const h = call.head || '<unknown>';
              const row = ctx.byHead[h] || (ctx.byHead[h] = { calls: 0, chars: 0 });
              row.calls++;
              row.chars += text.length;
            }
          }
        }
      }
      if (!sawResult && o.isMeta !== true && o.isCompactSummary !== true && !o.toolUseResult) {
        const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((c) => c && c.type === 'text').map((c) => c.text) : [];
        let human = false;
        let correction = false;
        for (const t of texts) {
          if (typeof t !== 'string') continue;
          const cmd = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(t);
          if (cmd) { ctx.usedSkills.add(cmd[1]); th.slash.push([parseTs(o.timestamp), typeof o.uuid === 'string' ? o.uuid : null, cmd[1]]); continue; }
          if (!isHumanText(t)) continue;
          human = true;
          if (isCorrection(t)) correction = true;
        }
        if (human) th.events.push({ k: 'user', at: th.turns.length, correction });
      }
    } else if (o.type === 'attachment' && o.attachment && hookBlockAttachment(o.attachment.type)) {
      th.events.push({ k: 'hook', turn: th.turns.length - 1 });
    } else if (o.type === 'system' && /hook/i.test(String(o.subtype || '')) && o.preventedContinuation === true) {
      th.events.push({ k: 'hook', turn: th.turns.length - 1 });
    }
  }, { want: claudeWant, onUnparsable: () => { ctx.unparsable++; } });
  const out = [main];
  if (side !== main && (side.turns.length || side.events.length)) out.push(side);
  return out;
}

// ---------------------------------------------------------------- Codex

function codexWant(head) {
  return head.includes('"token_count"') || head.includes('"item_completed"') || head.includes('"session_meta"') || head.includes('"turn_context"') || head.includes('"user_message"');
}

async function parseCodexFile(file, ctx) {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file);
  const th = newThread('codex', m ? m[1] : path.basename(file, '.jsonl'), false, file);
  let prev = null;
  let pending = []; // calls recorded since the last token_count belong to the next model call
  const evUsers = [];
  const itemUsers = [];
  const headRows = []; // shell output rows, kept until the cwd filter is known
  const used = { skills: [], mcp: [] };
  const use = { tools: {}, reads: {} }; // usage counts of events whose own time falls in the window
  const inWindow = (ts) => ts !== null && ts >= ctx.from && ts <= ctx.to;
  let sawUsage = false;
  let curModel = null; // the model named by the latest turn_context; used for price weights only
  const flush = (idx) => { for (const e of pending) e.turn = idx; pending = []; };
  await eachJsonLine(file, (o) => {
    const p = o.payload && typeof o.payload === 'object' ? o.payload : null;
    if (!p) return;
    if ((o.type === 'session_meta' || o.type === 'turn_context') && typeof p.cwd === 'string' && th.cwd === null) th.cwd = p.cwd;
    if (o.type === 'turn_context' && typeof p.model === 'string' && p.model) curModel = p.model;
    if (o.type !== 'event_msg') return;
    if (p.type === 'token_count' && p.info && p.info.total_token_usage && typeof p.info.total_token_usage === 'object') {
      sawUsage = true;
      const t = p.info.total_token_usage;
      const cur = { input: num(t.input_tokens), cached: num(t.cached_input_tokens), cw: num(t.cache_write_input_tokens), output: num(t.output_tokens) };
      let d = prev ? { input: cur.input - prev.input, cached: cur.cached - prev.cached, cw: cur.cw - prev.cw, output: cur.output - prev.output } : { ...cur };
      if (d.input < 0 || d.cached < 0 || d.cw < 0 || d.output < 0) d = { ...cur }; // counter reset
      prev = cur;
      if (d.input + d.output === 0) return; // repeated event, no new model call
      const idx = th.turns.length;
      th.turns.push({ id: null, ts: parseTs(o.timestamp), input: Math.max(0, d.input - d.cached - d.cw), cacheWrite: d.cw, cacheRead: d.cached, output: d.output, cw1h: 0, model: curModel, calls: pending.filter((e) => e.k === 'call') });
      flush(idx);
    } else if (p.type === 'user_message' && typeof p.message === 'string') {
      evUsers.push({ at: th.turns.length, pos: th.events.length, text: p.message });
    } else if (p.type === 'item_completed' && p.item && typeof p.item === 'object') {
      const item = p.item;
      if (item.type === 'CommandExecution') {
        const cmd = codexCommandString(item.command);
        const call = { k: 'call', turn: null, name: 'exec_command', hash: inputHash(cmd), head: commandHead(cmd), shell: true, explore: false, edit: false };
        used.skills.push(...skillsReadIn(cmd));
        const failed = (typeof item.exit_code === 'number' && item.exit_code !== 0) || item.status === 'failed';
        const text = `${typeof item.stderr === 'string' ? item.stderr : ''}\n${typeof item.aggregated_output === 'string' ? item.aggregated_output : ''}`;
        th.events.push(call, { k: 'result', call, isErr: failed, notFound: failed && NOT_FOUND_RE.test(text), hook: failed && hookBlockText(text) });
        pending.push(call);
        const ts = parseTs(o.timestamp);
        if (ts === null || (ts >= ctx.from && ts <= ctx.to)) headRows.push([call.head || '<unknown>', typeof item.aggregated_output === 'string' ? item.aggregated_output.length : 0]);
        if (inWindow(ts)) {
          bump(use.tools, 'exec_command');
          for (const s of skillsReadIn(cmd)) bump(use.reads, s);
        }
      } else if (item.type === 'McpToolCall' && typeof item.server === 'string') {
        used.mcp.push(normalizeMcpName(item.server));
        // Named the way Claude Code names an MCP tool, so both agents count under one key shape.
        if (inWindow(parseTs(o.timestamp))) bump(use.tools, `mcp__${normalizeMcpName(item.server)}__${typeof item.tool === 'string' && SAFE_NAME.test(item.tool) ? item.tool : 'unnamed'}`);
      } else if (item.type === 'UserMessage' && Array.isArray(item.content)) {
        const text = item.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
        itemUsers.push({ at: th.turns.length, pos: th.events.length, text });
      }
    }
  }, { want: codexWant, onUnparsable: () => { ctx.unparsable++; } });
  if (pending.length) {
    const last = th.turns.length - 1;
    if (last >= 0) for (const e of pending) if (e.k === 'call') th.turns[last].calls.push(e);
    flush(last);
  }
  // One user turn is recorded in several places; use one source only.
  const users = evUsers.length ? evUsers : itemUsers;
  const ins = users.filter((u) => isHumanText(u.text)).map((u) => ({ pos: u.pos, ev: { k: 'user', at: u.at, correction: isCorrection(u.text) } }));
  for (let i = ins.length - 1; i >= 0; i--) th.events.splice(ins[i].pos, 0, ins[i].ev);
  th.noUsage = !sawUsage;
  th.headRows = headRows;
  th.used = used;
  th.codexUse = use;
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
  // Attempts per shell head, in call order, with their outcome.
  const attempts = new Map();
  for (const e of calls) {
    if (!e.shell || !e.head) continue;
    const r = outcome.get(e) || null;
    const list = attempts.get(e.head) || [];
    list.push({ turn: e.turn, failed: !!(r && r.isErr), notFound: !!(r && r.notFound) });
    attempts.set(e.head, list);
  }
  for (const [head, list] of attempts) {
    for (let i = 0; i < list.length;) { // retry
      if (!list[i].failed) { i++; continue; }
      let j = i + 1;
      while (j < list.length && list[j].failed) j++;
      const end = j < list.length ? j : list.length - 1;
      if (end - i >= 3) eps.push({ kind: 'retry', turns: range(list[i].turn, list[end].turn), heads: [head] });
      i = j + 1;
    }
    for (let i = 0; i < list.length;) { // notfound
      if (!list[i].notFound) { i++; continue; }
      let j = i + 1;
      while (j < list.length && list[j].notFound) j++;
      eps.push({ kind: 'notfound', turns: range(list[i].turn, list[j - 1].turn), heads: [head] });
      i = j;
    }
  }
  // loop: runs of identical consecutive calls (same tool, same input hash)
  for (let i = 0; i < calls.length;) {
    let j = i + 1;
    while (j < calls.length && calls[j].name === calls[i].name && calls[j].hash === calls[i].hash) j++;
    if (j - i >= LOOP_MIN) eps.push({ kind: 'loop', turns: range(calls[i].turn, calls[j - 1].turn), heads: calls[i].head ? [calls[i].head] : [] });
    i = j;
  }
  for (const e of th.events) { // hook-block
    if (e.k === 'result' && e.hook && e.call && e.call.turn !== null && e.call.turn >= 0) eps.push({ kind: 'hook-block', turns: [e.call.turn], heads: e.call.head ? [e.call.head] : [] });
    else if (e.k === 'hook' && e.turn >= 0) eps.push({ kind: 'hook-block', turns: [e.turn], heads: [] });
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
 * the shared .agents/skills folder always is.
 */
function configuredContext({ scope, projectRoot, claudeDirs, codexHomes, want }) {
  const skills = new Set();
  const mcp = new Set();
  const claude = want.has('claude');
  const userClaudeJson = claude ? readJsonSafe(path.join(home(), '.claude.json')) : { ok: false };
  if (scope === 'user') {
    for (const d of claude ? claudeDirs : []) {
      for (const s of skillNamesIn(path.join(d.path, 'skills'))) skills.add(s);
      for (const f of ['settings.json', 'settings.local.json', '.claude.json']) {
        const r = readJsonSafe(path.join(d.path, f));
        if (r.ok && r.value) for (const n of mcpNames(r.value.mcpServers)) mcp.add(n);
      }
    }
    for (const d of agentsDirs()) for (const s of skillNamesIn(path.join(d.path, 'skills'))) skills.add(s);
    for (const d of codexHomes) {
      for (const s of skillNamesIn(path.join(d.path, 'skills'))) skills.add(s);
      const toml = readTextSafe(path.join(d.path, 'config.toml'));
      if (toml !== null) for (const s of scanCodexToml(toml).mcpServers) mcp.add(s.name);
    }
    if (userClaudeJson.ok && userClaudeJson.value) for (const n of mcpNames(userClaudeJson.value.mcpServers)) mcp.add(n);
  } else {
    for (const s of skillNamesIn(path.join(projectRoot, '.agents', 'skills'))) skills.add(s);
    if (claude) {
      for (const s of skillNamesIn(path.join(projectRoot, '.claude', 'skills'))) skills.add(s);
      const mj = readJsonSafe(path.join(projectRoot, '.mcp.json'));
      if (mj.ok && mj.value) for (const n of mcpNames(mj.value.mcpServers)) mcp.add(n);
      for (const f of ['settings.json', 'settings.local.json']) {
        const r = readJsonSafe(path.join(projectRoot, '.claude', f));
        if (r.ok && r.value) for (const n of mcpNames(r.value.mcpServers)) mcp.add(n);
      }
      const v = userClaudeJson.ok && userClaudeJson.value ? userClaudeJson.value.projects : null;
      if (v && typeof v === 'object') for (const [k, p] of Object.entries(v)) if (p && samePath(normalizeInputPath(k), projectRoot)) for (const n of mcpNames(p.mcpServers)) mcp.add(n);
    }
  }
  return { skills: [...skills].sort(), mcp: [...mcp].filter((n) => SAFE_NAME.test(n)).sort() };
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
 * Parse one transcript file into compact threads (turn usage + waste episode turn lists) and
 * what it says about skills, MCP servers and shell output. The result is plain data, so it can
 * cross a worker boundary.
 */
async function parseJob(job, from, to) {
  const ctx = { from, to, unparsable: 0, usedSkills: new Set(), usedMcp: new Set(), byHead: {} };
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
        noUsage: !!th.noUsage, headRows: th.headRows || [], used: th.used || { skills: [], mcp: [] },
        eps: episodesOf(th),
        turns: th.turns.map((t) => {
          const o = { id: t.id, ts: t.ts, input: t.input, cacheWrite: t.cacheWrite, cacheRead: t.cacheRead, output: t.output, cw1h: t.cw1h || 0, m: modelIndex(t.model) };
          if (t.tools && t.tools.length) o.tc = t.tools.map(nameOf);
          if (t.skills && t.skills.length) o.sk = t.skills.map(nameOf);
          if (t.reads && t.reads.length) o.rd = t.reads.map(nameOf);
          if (typeof t.attr === 'string') o.at = nameOf(t.attr);
          return o;
        }),
        models,
        names,
        slash: (th.slash || []).map(([ts, uuid, name]) => [ts, uuid, nameOf(name)]),
        codexUse: th.codexUse || null,
      };
    });
  } catch { failed = 1; threads = []; }
  return { threads, failed, unparsable: ctx.unparsable, usedSkills: [...ctx.usedSkills], usedMcp: [...ctx.usedMcp], byHead: ctx.byHead };
}

/** Parse all jobs, CPU-parallel in worker threads when there are many files. */
async function runJobs(jobs, from, to, { workers, onDone }) {
  if (workers > 0 && jobs.length > 0) {
    try {
      const results = new Array(jobs.length);
      let next = 0;
      await Promise.all(Array.from({ length: workers }, () => new Promise((resolve, reject) => {
        const w = new Worker(new URL(import.meta.url), { workerData: { sessionImpactWorker: true, from, to } });
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
  return pool(jobs, 8, async (job) => { const r = await parseJob(job, from, to); onDone(); return r; });
}

if (!isMainThread && workerData && workerData.sessionImpactWorker) {
  parentPort.on('message', async ({ i, job }) => {
    parentPort.postMessage({ i, res: await parseJob(job, workerData.from, workerData.to) });
  });
}

// ---------------------------------------------------------------- collect

export async function collect({ projectRoot, configDirs = null, days = 30, scope = 'project', progress = false, workers = null, now = Date.now(), weightsFile = null, sources = null, codexHomeDirs = null }) {
  const from = now - days * DAY;
  const ctx = { from, to: now, unparsable: 0, usedSkills: new Set(), usedMcp: new Set(), byHead: {} };

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

  const jobs = [...claudeFiles.map((f) => ({ source: 'claude', f })), ...codexFiles.map((f) => ({ source: 'codex', f }))];
  let done = 0;
  const nWorkers = workers === null ? Math.max(0, Math.min(8, os.cpus().length - 1)) : workers;
  const parsed = await runJobs(jobs, from, now, {
    workers: workers !== null ? workers : (jobs.length >= 32 ? nWorkers : 0),
    onDone: () => { done++; if (progress && (done % 250 === 0 || done === jobs.length)) warn(`progress: ${done}/${jobs.length} files`); },
  });
  let failedFiles = 0;
  for (const r of parsed) {
    failedFiles += r.failed;
  }
  if (failedFiles) warn(`${failedFiles} transcript file(s) could not be read; skipped`);
  const mergeHeads = (rows) => { for (const [h, r] of Object.entries(rows)) { const row = ctx.byHead[h] || (ctx.byHead[h] = { calls: 0, chars: 0 }); row.calls += r.calls; row.chars += r.chars; } };
  const threads = [];
  for (const r of parsed) {
    // Project scope: a Codex rollout belongs to the project by its recorded cwd.
    const keep = r.threads.filter((t) => t.source !== 'codex' || scope === 'user' || matchesProjectCwd(t.cwd, projectRoot));
    if (!keep.length && r.threads.length) continue;
    threads.push(...keep);
    ctx.unparsable += r.unparsable;
    for (const s of r.usedSkills) ctx.usedSkills.add(s);
    for (const s of r.usedMcp) ctx.usedMcp.add(s);
    mergeHeads(r.byHead);
    for (const t of keep) {
      if (t.source !== 'codex') continue;
      for (const [h, c] of t.headRows) { const row = ctx.byHead[h] || (ctx.byHead[h] = { calls: 0, chars: 0 }); row.calls++; row.chars += c; }
      for (const s of t.used.skills) ctx.usedSkills.add(s);
      for (const s of t.used.mcp) ctx.usedMcp.add(s);
    }
  }
  threads.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));

  // Claude message ids are unique per model call: an id seen in an earlier file is a replayed copy.
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
      t.eff = t.win && !t.dup ? turnTokens(t) : 0;
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
      if (!t.win || t.dup) continue;
      s.active = true;
      s.tokens += t.eff;
      byKind.input += t.input; byKind.cacheWrite += t.cacheWrite; byKind.cacheRead += t.cacheRead; byKind.output += t.output;
      activeDays.add(new Date(t.ts).toISOString().slice(0, 10));
      if (!th.sidechain) s.peak = Math.max(s.peak, contextOf(t));
    }
    if (!th.sidechain && th.turns.length && th.turns[0].win && !th.turns[0].dup) {
      const firstContext = contextOf(th.turns[0]);
      starts.push(firstContext);
      startsWeighted += th.turns[0].wCtx;
      startTurns++;
      for (let i = 1; i < th.turns.length; i++) {
        const t = th.turns[i];
        if (!t.win || t.dup) continue;
        startTurns++;
        const again = Math.min(firstContext, contextOf(t)); // never more than this call really sent
        carried += again;
        if (again > 0) { if (t.cr === null) carriedUnrated++; else carriedScaled += again * t.cr; }
      }
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
          if (!t || !t.win || t.dup) continue;
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
  const conf = configuredContext({ scope, projectRoot, claudeDirs, codexHomes, want });
  const usedMcpNorm = new Set([...ctx.usedMcp].map(normalizeMcpName));
  const shellChars = Object.values(ctx.byHead).reduce((a, r) => a + r.chars, 0);
  const usage = usageCounts(threads, from, now, conf);

  const notes = codexFiles.length && codexNoUsage && !active.some((s) => s.source === 'codex') ? ['codex: no usage data'] : [];
  if (want.size < SOURCES.length) notes.push(`transcript sources read: ${[...want].join(', ')}`);
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
    unparsableLines: ctx.unparsable,
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
    unusedContext: {
      skillsNeverInvoked: conf.skills.filter((n) => !ctx.usedSkills.has(n)),
      mcpServersNeverCalled: conf.mcp.filter((n) => !usedMcpNorm.has(normalizeMcpName(n))),
      skillsConfigured: conf.skills.length,
      mcpServersConfigured: conf.mcp.length,
      method: METHODS.unusedContext,
    },
    skillInvocations: usage.skillInvocations,
    mcpCalls: usage.mcpCalls,
    toolCalls: usage.toolCalls,
    usageMethod: METHODS.usage,
    toolOutput: {
      shellResultChars: shellChars,
      shellResultTokensApprox: approxTokens(shellChars),
      byHead: Object.entries(ctx.byHead).sort((a, b) => b[1].chars - a[1].chars || a[0].localeCompare(b[0])).slice(0, 25).map(([head, r]) => ({ head, calls: r.calls, chars: r.chars })),
      method: 'Characters of shell tool results (Claude Bash/PowerShell, Codex command output) grouped by the 2-token command head, in the window; approximate tokens are chars / 4. Outputs too large for the transcript are stored elsewhere and only their preview is counted.',
    },
    topSessions: active.sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id)).slice(0, 10).map((s) => ({ id: s.id, source: s.source, tokens: s.tokens, wasteTokens: s.wasteTokens })),
    notes,
  };
  const out = scrubOutput(result, home());
  if (weighted) out.weights = weightsBlock(famStats, W, weightsFile);
  return out;
}

/**
 * Tool calls, skill invocations and MCP calls of the window, as `{ name: count }` maps. Claude
 * calls count when their model call falls in the window and is not a replayed copy; Codex events
 * were already filtered by their own time when the file was parsed.
 */
function usageCounts(threads, from, to, conf) {
  const toolCalls = {};
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
      if (!t.win || t.dup) continue;
      if (t.tc) for (const i of t.tc) bump(toolCalls, safeKey(names[i]));
      if (t.sk) for (const i of t.sk) call(s, names[i]);
      if (t.rd) for (const i of t.rd) trace(s, names[i]);
      if (t.at !== undefined) trace(s, names[t.at]);
    }
    for (const [ts, uuid, i] of th.slash || []) {
      if (ts === null || ts < from || ts > to) continue;
      if (uuid !== null) { if (seenSlash.has(uuid)) continue; seenSlash.add(uuid); } // replayed in a resumed session
      call(s, names[i]);
    }
    if (th.codexUse) {
      for (const [name, n] of Object.entries(th.codexUse.tools)) bump(toolCalls, safeKey(name), n);
      for (const name of Object.keys(th.codexUse.reads)) trace(s, name);
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
  // MCP calls per server, under the configured name when this scope configures the server.
  const configured = new Map(conf.mcp.map((n) => [normalizeMcpName(n), n]));
  const mcpCalls = {};
  for (const [name, n] of Object.entries(toolCalls)) {
    if (!name.startsWith('mcp__')) continue;
    const end = name.indexOf('__', 5);
    if (end > 5) bump(mcpCalls, configured.get(name.slice(5, end)) || name.slice(5, end), n);
  }
  // What the scope configures is listed even when nothing was counted, so a lookup gets a 0.
  for (const n of conf.skills) if (!(n in skillInvocations)) skillInvocations[n] = 0;
  for (const n of conf.mcp) if (!(n in mcpCalls)) mcpCalls[n] = 0;
  const sortDesc = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  return { toolCalls: sortDesc(toolCalls), skillInvocations: sortDesc(skillInvocations), mcpCalls: sortDesc(mcpCalls) };
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
