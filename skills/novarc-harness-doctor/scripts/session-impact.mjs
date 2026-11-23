#!/usr/bin/env node
// session-impact.mjs --cwd <project root> [--days 30] [--config-dirs a,b] [--scope project|user] [--progress]
//
// Measures what a harness costs over a window, from local agent session transcripts: tokens per
// kind (input, cache write, cache read, output), the context every session starts with and peaks
// at, and the tokens spent in waste episodes (retry loops, identical-call loops, missing commands,
// hook blocks, corrected work, sessions ending on an error, exploration before the first edit).
// Also lists skills and MCP servers that were configured but never used, and shell output volume
// by command head. Aggregates only: it never prints message text, command lines beyond the
// 2-token head, tool output, file paths from inside a transcript, or absolute home paths.
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { IS_WIN, parseArgs, isMain, printJson, warn, normalizeInputPath, isDir, isFile, readdirSafe, realpathSafe, readJsonSafe, readTextSafe, home, approxTokens } from './lib/common.mjs';
import { claudeConfigDirs, codexDirs, agentsDirs } from './lib/locations.mjs';
import { commandHead, codexCommandString, matchesProjectDir, matchesProjectCwd } from './transcript-signals.mjs';
import { scanCodexToml } from './discover.mjs';
import {
  SHELL_TOOLS, EDIT_TOOLS, EXPLORE_TOOLS, NOT_FOUND_RE, SAFE_NAME, resultText, isHumanText, isCorrection,
  hookBlockText, hookBlockAttachment, skillsReadIn, normalizeMcpName, eachJsonLine, listClaudeTranscripts, listJsonl, pool,
} from './lib/transcripts.mjs';

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
  dedupe: 'A turn belongs to at most one waste kind, claimed in priority order retry > loop > notfound > hook-block > correction > error-end > exploration; an episode whose in-window turns were all claimed by a higher kind is not counted.',
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
  return { source, sessionId, sidechain, order, turns: [], byId: new Map(), events: [], calls: new Map(), cwd: null };
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
        th.turns.push({ id, ts: parseTs(o.timestamp), input: 0, cacheWrite: 0, cacheRead: 0, output: 0, calls: [] });
        if (id !== null) th.byId.set(id, idx);
      }
      const t = th.turns[idx];
      if (t.ts === null) t.ts = parseTs(o.timestamp);
      const u = msg.usage && typeof msg.usage === 'object' ? msg.usage : null;
      if (u) {
        t.input = Math.max(t.input, num(u.input_tokens));
        t.cacheWrite = Math.max(t.cacheWrite, num(u.cache_creation_input_tokens));
        t.cacheRead = Math.max(t.cacheRead, num(u.cache_read_input_tokens));
        t.output = Math.max(t.output, num(u.output_tokens));
      }
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || c.type !== 'tool_use' || typeof c.name !== 'string') continue;
          const input = c.input && typeof c.input === 'object' ? c.input : {};
          const call = { k: 'call', turn: idx, name: c.name, hash: inputHash(c.input), head: null, shell: SHELL_TOOLS.has(c.name), explore: EXPLORE_TOOLS.has(c.name), edit: EDIT_TOOLS.has(c.name) };
          if (call.shell && typeof input.command === 'string') {
            call.head = commandHead(input.command);
            for (const s of skillsReadIn(input.command)) ctx.usedSkills.add(s);
          }
          if (c.name === 'Read' && typeof input.file_path === 'string') for (const s of skillsReadIn(input.file_path)) ctx.usedSkills.add(s);
          if (c.name === 'Skill') {
            const sk = input.skill || input.name || input.command;
            if (typeof sk === 'string') ctx.usedSkills.add(sk.trim().replace(/^\//, ''));
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
          if (cmd) { ctx.usedSkills.add(cmd[1]); continue; }
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
  let sawUsage = false;
  const flush = (idx) => { for (const e of pending) e.turn = idx; pending = []; };
  await eachJsonLine(file, (o) => {
    const p = o.payload && typeof o.payload === 'object' ? o.payload : null;
    if (!p) return;
    if ((o.type === 'session_meta' || o.type === 'turn_context') && typeof p.cwd === 'string' && th.cwd === null) th.cwd = p.cwd;
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
      th.turns.push({ id: null, ts: parseTs(o.timestamp), input: Math.max(0, d.input - d.cached - d.cw), cacheWrite: d.cw, cacheRead: d.cached, output: d.output, calls: pending.filter((e) => e.k === 'call') });
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
      } else if (item.type === 'McpToolCall' && typeof item.server === 'string') {
        used.mcp.push(normalizeMcpName(item.server));
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

function configuredContext({ scope, projectRoot, claudeDirs }) {
  const skills = new Set();
  const mcp = new Set();
  const userClaudeJson = readJsonSafe(path.join(home(), '.claude.json'));
  if (scope === 'user') {
    for (const d of claudeDirs) {
      for (const s of skillNamesIn(path.join(d.path, 'skills'))) skills.add(s);
      for (const f of ['settings.json', 'settings.local.json', '.claude.json']) {
        const r = readJsonSafe(path.join(d.path, f));
        if (r.ok && r.value) for (const n of mcpNames(r.value.mcpServers)) mcp.add(n);
      }
    }
    for (const d of agentsDirs()) for (const s of skillNamesIn(path.join(d.path, 'skills'))) skills.add(s);
    for (const d of codexDirs()) {
      for (const s of skillNamesIn(path.join(d.path, 'skills'))) skills.add(s);
      const toml = readTextSafe(path.join(d.path, 'config.toml'));
      if (toml !== null) for (const s of scanCodexToml(toml).mcpServers) mcp.add(s.name);
    }
    if (userClaudeJson.ok && userClaudeJson.value) for (const n of mcpNames(userClaudeJson.value.mcpServers)) mcp.add(n);
  } else {
    for (const s of skillNamesIn(path.join(projectRoot, '.claude', 'skills'))) skills.add(s);
    for (const s of skillNamesIn(path.join(projectRoot, '.agents', 'skills'))) skills.add(s);
    const mj = readJsonSafe(path.join(projectRoot, '.mcp.json'));
    if (mj.ok && mj.value) for (const n of mcpNames(mj.value.mcpServers)) mcp.add(n);
    for (const f of ['settings.json', 'settings.local.json']) {
      const r = readJsonSafe(path.join(projectRoot, '.claude', f));
      if (r.ok && r.value) for (const n of mcpNames(r.value.mcpServers)) mcp.add(n);
    }
    const v = userClaudeJson.ok && userClaudeJson.value ? userClaudeJson.value.projects : null;
    if (v && typeof v === 'object') for (const [k, p] of Object.entries(v)) if (p && samePath(normalizeInputPath(k), projectRoot)) for (const n of mcpNames(p.mcpServers)) mcp.add(n);
  }
  return { skills: [...skills].sort(), mcp: [...mcp].filter((n) => SAFE_NAME.test(n)).sort() };
}

// ---------------------------------------------------------------- privacy guard

const PATHLIKE = /[A-Za-z]:[\\/]|\/Users\/|\/home\/|\\\\/;
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
    threads = threads.map((th) => ({
      source: th.source, sessionId: th.sessionId, sidechain: th.sidechain, order: th.order, cwd: th.cwd,
      noUsage: !!th.noUsage, headRows: th.headRows || [], used: th.used || { skills: [], mcp: [] },
      eps: episodesOf(th),
      turns: th.turns.map((t) => ({ id: t.id, ts: t.ts, input: t.input, cacheWrite: t.cacheWrite, cacheRead: t.cacheRead, output: t.output })),
    }));
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

export async function collect({ projectRoot, configDirs = null, days = 30, scope = 'project', progress = false, workers = null, now = Date.now() }) {
  const from = now - days * DAY;
  const ctx = { from, to: now, unparsable: 0, usedSkills: new Set(), usedMcp: new Set(), byHead: {} };

  const claudeDirs = configDirs && configDirs.length
    ? configDirs.map((p) => ({ path: normalizeInputPath(p) })).filter((d) => isDir(d.path))
    : claudeConfigDirs();
  const claudeFiles = [];
  const seenProjects = new Set();
  for (const d of claudeDirs) {
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
  for (const d of codexDirs()) codexFiles.push(...listJsonl(path.join(d.path, 'sessions'), 4, from));

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

  const byKind = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const sessions = new Map();
  const activeDays = new Set();
  const starts = [];
  const waste = Object.fromEntries(KINDS.map((k) => [k, { episodes: 0, sessions: new Set(), tokens: 0, heads: {} }]));
  const sessKey = (th) => `${th.source}\u0000${th.sessionId}`;
  let codexNoUsage = 0;

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
    if (!th.sidechain && th.turns.length && th.turns[0].win && !th.turns[0].dup) starts.push(contextOf(th.turns[0]));
    // Waste: claim turns in priority order; a turn belongs to one kind at most.
    const owner = new Array(th.turns.length).fill(null);
    const eps = th.eps;
    for (const kind of KINDS) {
      for (const ep of eps) {
        if (ep.kind !== kind) continue;
        let kept = false;
        let tokens = 0;
        for (const i of ep.turns) {
          const t = th.turns[i];
          if (!t || !t.win || t.dup) continue;
          if (owner[i] !== null && owner[i] !== kind) continue;
          kept = true;
          if (owner[i] === null) { owner[i] = kind; tokens += t.eff; }
        }
        if (!kept) continue;
        const w = waste[kind];
        w.episodes++;
        w.tokens += tokens;
        w.sessions.add(k);
        for (const hd of ep.heads) bump(w.heads, hd);
        s.wasteTokens += tokens;
      }
    }
  }

  const active = [...sessions.values()].filter((s) => s.active);
  starts.sort((a, b) => a - b);
  const peaks = active.filter((s) => s.peak > 0).map((s) => s.peak).sort((a, b) => a - b);
  const conf = configuredContext({ scope, projectRoot, claudeDirs });
  const usedMcpNorm = new Set([...ctx.usedMcp].map(normalizeMcpName));
  const shellChars = Object.values(ctx.byHead).reduce((a, r) => a + r.chars, 0);

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
    duplicates: { turnsDropped: duplicateTurns, tokensDropped: duplicateTokens },
    method: `${METHODS.turn} ${METHODS.window}`,
    contextAtStart: { perSessionMedian: median(starts), perSessionP90: percentile(starts, 0.9), total: starts.reduce((a, b) => a + b, 0), sessionsMeasured: starts.length, method: METHODS.contextAtStart },
    contextPeak: { median: median(peaks), p90: percentile(peaks, 0.9), sessionsOver160k: peaks.filter((p) => p > PEAK_LIMIT).length, sessionsMeasured: peaks.length, method: METHODS.contextPeak },
    waste: OUTPUT_ORDER.map((kind) => {
      const w = waste[kind];
      return {
        kind, label: LABELS[kind], episodes: w.episodes, sessions: w.sessions.size, tokens: w.tokens, basis: 'measured', method: METHODS[kind],
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
    toolOutput: {
      shellResultChars: shellChars,
      shellResultTokensApprox: approxTokens(shellChars),
      byHead: Object.entries(ctx.byHead).sort((a, b) => b[1].chars - a[1].chars || a[0].localeCompare(b[0])).slice(0, 25).map(([head, r]) => ({ head, calls: r.calls, chars: r.chars })),
      method: 'Characters of shell tool results (Claude Bash/PowerShell, Codex command output) grouped by the 2-token command head, in the window; approximate tokens are chars / 4. Outputs too large for the transcript are stored elsewhere and only their preview is counted.',
    },
    topSessions: active.sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id)).slice(0, 10).map((s) => ({ id: s.id, source: s.source, tokens: s.tokens, wasteTokens: s.wasteTokens })),
    notes: codexFiles.length && codexNoUsage && !active.some((s) => s.source === 'codex') ? ['codex: no usage data'] : [],
  };
  return scrubOutput(result, home());
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
  collect({ projectRoot, configDirs, days, scope, progress: args.progress === true, workers }).then((res) => {
    printJson({ generatedAt: new Date().toISOString(), project: scope === 'project' ? path.basename(projectRoot) : null, ...res, durationMs: Date.now() - started });
  }).catch((e) => {
    warn(`failed: ${e && e.code ? e.code : 'error'}`);
    process.exit(1);
  });
}
