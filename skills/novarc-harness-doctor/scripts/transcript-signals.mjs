#!/usr/bin/env node
// transcript-signals.mjs --cwd <project root> [--config-dirs a,b] [--days 60]
//
// Reads past agent session transcripts for ONE project, locally, and prints aggregates only:
// sessions per source, date range, tool calls by name, failed shell commands grouped by command
// head (first one or two tokens, never arguments), "command not found" heads, hook blocks,
// retries, user corrections (a count), sessions that ended on an error, skill invocations, and
// the ids of the sessions with the most failures. Subagent threads (`<session>/subagents/**`)
// are read too and counted into their parent session; their prompts are written by the parent
// agent, so they never count as user messages or corrections. It never prints message text,
// command lines, tool output or file paths from inside a transcript.
import path from 'node:path';
import { IS_WIN, parseArgs, isMain, printJson, warn, normalizeInputPath, isDir, readdirSafe, realpathSafe } from './lib/common.mjs';
import { claudeConfigDirs, codexDirs } from './lib/locations.mjs';
import {
  SHELL_TOOLS, NOT_FOUND_RE, safeName, resultText, isHumanText, isCorrection, hookBlockText, hookBlockAttachment,
  commandHead, codexCommandString, matchesProjectDir, matchesProjectCwd, eachJsonLine, listClaudeTranscripts, listJsonl,
} from './lib/transcripts.mjs';

// These live in lib/transcripts.mjs; other scripts and tests import them from here too.
export { commandHead, codexCommandString, matchesProjectDir, matchesProjectCwd, projectRoots } from './lib/transcripts.mjs';

function bump(obj, key, n = 1) { obj[key] = (obj[key] || 0) + n; }

function newSession(source, id) {
  return { source, id, failures: 0, failHeads: {}, lastToolError: null, first: null, last: null };
}

function trackTime(sess, ts) {
  if (typeof ts !== 'string') return;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return;
  if (sess.first === null || t < sess.first) sess.first = t;
  if (sess.last === null || t > sess.last) sess.last = t;
}

function recordFailure(agg, sess, head, text) {
  const h = head || '<unknown>';
  bump(agg.shellFailures, h);
  bump(sess.failHeads, h);
  sess.failures++;
  if (text && NOT_FOUND_RE.test(text)) bump(agg.commandNotFound, h);
}

/**
 * One Claude transcript file, counted into `sess`. `entry.sidechainFile` marks a subagent thread:
 * its tool calls, failures and hook blocks count, its "user" turns and its last result do not.
 */
async function parseClaudeFile(entry, sess, agg) {
  const toolUses = new Map();
  await eachJsonLine(entry.file, (o) => {
    trackTime(sess, o.timestamp);
    const side = entry.sidechainFile || o.isSidechain === true;
    const content = o.message && o.message.content;
    if (o.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (!c || c.type !== 'tool_use') continue;
        const name = safeName(c.name) || '<unknown>';
        bump(agg.toolCalls, name);
        const input = c.input && typeof c.input === 'object' ? c.input : {};
        const info = { name, head: null };
        if (SHELL_TOOLS.has(c.name) && typeof input.command === 'string') info.head = commandHead(input.command);
        if (c.name === 'Skill') {
          const sk = safeName(input.skill || input.name || input.command);
          if (sk) bump(agg.skillInvocations, sk);
        }
        if (typeof c.id === 'string') toolUses.set(c.id, info);
      }
    } else if (o.type === 'user') {
      let sawToolResult = false;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || c.type !== 'tool_result') continue;
          sawToolResult = true;
          const text = resultText(c.content);
          const isErr = c.is_error === true;
          const info = toolUses.get(c.tool_use_id) || { name: null, head: null };
          if (!side) sess.lastToolError = isErr;
          if (isErr && hookBlockText(text)) agg.hookBlocks++;
          if (isErr && info.head !== null) recordFailure(agg, sess, info.head, text);
          else if (isErr && info.name && SHELL_TOOLS.has(info.name)) recordFailure(agg, sess, null, text);
        }
      }
      if (!side && !sawToolResult && o.isMeta !== true && !o.toolUseResult) {
        const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((c) => c && c.type === 'text').map((c) => c.text) : [];
        for (const t of texts) {
          if (typeof t !== 'string') continue;
          const cmd = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(t);
          if (cmd) { const n = safeName(cmd[1]); if (n) bump(agg.slashCommands, n); continue; }
          if (!isHumanText(t)) continue;
          agg.userMessages++;
          if (isCorrection(t)) agg.userCorrections++;
        }
      }
    } else if (o.type === 'attachment' && o.attachment && hookBlockAttachment(o.attachment.type)) {
      agg.hookBlocks++;
    } else if (o.type === 'system' && /hook/i.test(String(o.subtype || '')) && o.preventedContinuation === true) {
      agg.hookBlocks++;
    }
  }, { onUnparsable: () => { agg.unparsableLines++; } });
}

/** Read the first lines of a Codex rollout until its working directory shows up. */
async function codexSessionCwd(file) {
  let cwd = null;
  let n = 0;
  await eachJsonLine(file, (o) => {
    const p = o.payload;
    if (p && typeof p.cwd === 'string' && (o.type === 'session_meta' || o.type === 'turn_context')) { cwd = p.cwd; return false; }
    return ++n < 50;
  });
  return cwd;
}

async function parseCodexSession(file, agg) {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file);
  const sess = newSession('codex', m ? m[1] : path.basename(file, '.jsonl'));
  const itemUser = [];
  const eventUser = [];
  const responseUser = [];
  await eachJsonLine(file, (o) => {
    trackTime(sess, o.timestamp);
    const p = o.payload && typeof o.payload === 'object' ? o.payload : null;
    if (!p) return;
    if (o.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') bump(agg.toolCalls, safeName(p.name || p.type) || '<unknown>');
      if (p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) for (const c of p.content) if (c && typeof c.text === 'string') responseUser.push(c.text);
    } else if (o.type === 'event_msg') {
      if (p.type === 'user_message' && typeof p.message === 'string') eventUser.push(p.message);
      const item = p.item && typeof p.item === 'object' ? p.item : null;
      if (p.type === 'item_completed' && item) {
        if (item.type === 'CommandExecution') {
          const failed = (typeof item.exit_code === 'number' && item.exit_code !== 0) || item.status === 'failed';
          sess.lastToolError = failed;
          if (failed) {
            const text = `${typeof item.stderr === 'string' ? item.stderr : ''}\n${typeof item.aggregated_output === 'string' ? item.aggregated_output : ''}`;
            recordFailure(agg, sess, commandHead(codexCommandString(item.command)), text);
            if (hookBlockText(text)) agg.hookBlocks++;
          }
        } else if (item.type === 'UserMessage' && Array.isArray(item.content)) {
          for (const c of item.content) if (c && typeof c.text === 'string') itemUser.push(c.text);
        }
      }
    }
  }, { onUnparsable: () => { agg.unparsableLines++; } });
  // The same user turn can be recorded in several places; count from one source only.
  const users = itemUser.length ? itemUser : eventUser.length ? eventUser : responseUser;
  for (const t of users) {
    if (!isHumanText(t)) continue;
    agg.userMessages++;
    if (isCorrection(t)) agg.userCorrections++;
  }
  return sess;
}

export async function collect({ projectRoot, configDirs, days = 60 }) {
  const cutoff = Date.now() - days * 86400000;
  const agg = {
    unparsableLines: 0, toolCalls: {}, shellFailures: {}, commandNotFound: {}, hookBlocks: 0,
    userMessages: 0, userCorrections: 0, skillInvocations: {}, slashCommands: {},
  };
  const sessions = [];
  let unreadable = 0;

  // Claude-style config dirs: <dir>/projects/<encoded cwd>/<session>.jsonl plus that session's
  // subagent threads, deduped by real path (host-app account dirs often link their projects/ to
  // the default one).
  const dirs = configDirs && configDirs.length
    ? configDirs.map((p) => ({ path: normalizeInputPath(p) })).filter((d) => isDir(d.path))
    : claudeConfigDirs();
  const seenProjects = new Set();
  let matchedDirs = 0;
  for (const d of dirs) {
    const pdir = path.join(d.path, 'projects');
    const real = realpathSafe(pdir);
    if (!real) continue;
    const key = IS_WIN ? real.toLowerCase() : real;
    if (seenProjects.has(key)) continue;
    seenProjects.add(key);
    for (const e of readdirSafe(pdir)) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (!matchesProjectDir(e.name, projectRoot)) continue;
      matchedDirs++;
      // One session per top-level file of this dir; its subagent files join it.
      const bySession = new Map();
      for (const entry of listClaudeTranscripts(path.join(pdir, e.name), cutoff)) {
        let sess = bySession.get(entry.sessionId);
        if (!sess) { sess = newSession('claude', entry.sessionId); bySession.set(entry.sessionId, sess); sessions.push(sess); }
        try { await parseClaudeFile(entry, sess, agg); } catch { unreadable++; }
      }
    }
  }

  // Codex: ~/.codex/sessions/YYYY/MM/DD/*.jsonl, filtered by the session's recorded cwd.
  let codexScanned = 0;
  for (const d of codexDirs()) {
    for (const f of listJsonl(path.join(d.path, 'sessions'), 4, cutoff)) {
      codexScanned++;
      try {
        if (!matchesProjectCwd(await codexSessionCwd(f), projectRoot)) continue;
        sessions.push(await parseCodexSession(f, agg));
      } catch { unreadable++; }
    }
  }
  if (unreadable) warn(`${unreadable} transcript file(s) could not be read; skipped`);

  const retries = {};
  for (const s of sessions) for (const [h, n] of Object.entries(s.failHeads)) if (n >= 3) bump(retries, h);
  const firsts = sessions.map((s) => s.first).filter((x) => x !== null);
  const lasts = sessions.map((s) => s.last).filter((x) => x !== null);
  const sortDesc = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  return {
    sources: {
      claude: { configDirs: dirs.length, projectDirsMatched: matchedDirs, sessions: sessions.filter((s) => s.source === 'claude').length },
      codex: { sessionFilesScanned: codexScanned, sessions: sessions.filter((s) => s.source === 'codex').length },
    },
    sessions: sessions.length,
    dateRange: firsts.length ? { from: new Date(Math.min(...firsts)).toISOString().slice(0, 10), to: new Date(Math.max(...lasts)).toISOString().slice(0, 10) } : null,
    unparsableLines: agg.unparsableLines,
    toolCalls: sortDesc(agg.toolCalls),
    shellFailures: sortDesc(agg.shellFailures),
    commandNotFound: sortDesc(agg.commandNotFound),
    hookBlocks: agg.hookBlocks,
    retries: Object.entries(retries).sort((a, b) => b[1] - a[1]).map(([head, n]) => ({ head, sessions: n })),
    userMessages: agg.userMessages,
    userCorrections: agg.userCorrections,
    sessionsEndingOnError: sessions.filter((s) => s.lastToolError === true).length,
    skillInvocations: sortDesc(agg.skillInvocations),
    slashCommands: sortDesc(agg.slashCommands),
    topFailureSessions: sessions.filter((s) => s.failures > 0).sort((a, b) => b.failures - a.failures || a.id.localeCompare(b.id)).slice(0, 10).map((s) => ({ source: s.source, id: s.id, failures: s.failures })),
  };
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  const projectRoot = normalizeInputPath(args.cwd || process.cwd());
  const days = args.days !== undefined ? Number(args.days) : 60;
  if (!Number.isFinite(days) || days <= 0) { warn('--days must be a positive number'); process.exit(2); }
  const configDirs = typeof args['config-dirs'] === 'string' ? args['config-dirs'].split(',').map((s) => s.trim()).filter(Boolean) : null;
  const started = Date.now();
  collect({ projectRoot, configDirs, days }).then((res) => {
    printJson({ generatedAt: new Date().toISOString(), cwd: './', project: path.basename(projectRoot), days, ...res, durationMs: Date.now() - started });
  }).catch((e) => {
    warn(`failed: ${e && e.code ? e.code : 'error'}`);
    process.exit(1);
  });
}
