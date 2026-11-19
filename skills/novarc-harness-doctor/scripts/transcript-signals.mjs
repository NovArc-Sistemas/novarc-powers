#!/usr/bin/env node
// transcript-signals.mjs --cwd <project root> [--config-dirs a,b] [--days 60]
//
// Reads past agent session transcripts for ONE project, locally, and prints aggregates only:
// sessions per source, date range, tool calls by name, failed shell commands grouped by command
// head (first one or two tokens, never arguments), "command not found" heads, hook blocks,
// retries, user corrections (a count), sessions that ended on an error, skill invocations, and
// the ids of the sessions with the most failures. It never prints message text, command lines,
// tool output or file paths from inside a transcript.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { IS_WIN, parseArgs, isMain, printJson, warn, normalizeInputPath, isDir, statSafe, readdirSafe, realpathSafe } from './lib/common.mjs';
import { claudeConfigDirs, codexDirs, encodeProjectPath } from './lib/locations.mjs';

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'bash', 'shell', 'local_shell', 'exec_command']);
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

const NOT_FOUND_RE = /command not found|is not recognized as (?:an internal or external command|the name of a cmdlet)|: not found\b|No such file or directory.*(?:exec|spawn)|ENOENT.*spawn|CommandNotFoundException/i;
const CORRECTION_START = /^\s*(?:no|não|nao|stop|pare|wrong|errado|errada)(?=[\s,.!?:;]|$)/i;
const CORRECTION_ANY = /\b(?:wrong|again|that'?s not|that is not|not what i)\b|errad[oa]|de novo|não é isso|nao e isso|isso não|isso nao/i;
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:\-/]{0,99}$/;

function bump(obj, key, n = 1) { obj[key] = (obj[key] || 0) + n; }

function safeName(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return SAFE_NAME.test(t) ? t : '<other>';
}

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

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
  return '';
}

function isHumanText(t) {
  if (typeof t !== 'string') return false;
  const s = t.trim();
  if (!s) return false;
  if (s.startsWith('<') || s.startsWith('Caveat:') || s.startsWith('[Request interrupted')) return false;
  return true;
}

function isCorrection(t) {
  const s = t.trim();
  if (s.length > 300) return false;
  return CORRECTION_START.test(s) || CORRECTION_ANY.test(s);
}

function hookBlockAttachment(type) {
  const t = String(type || '').toLowerCase();
  if (!t.includes('hook')) return false;
  return /(?<!non_)(?<!non-)blocking|denied|deny|block(?:ed)?(?:_|$)/.test(t) && !/non[_-]?blocking/.test(t);
}

function hookBlockText(text) {
  return /hook/i.test(text) && /\b(?:block(?:ed|ing)?|denied|deny|prevented|rejected)\b/i.test(text);
}

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

async function eachJsonLine(file, onObj, agg) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { agg.unparsableLines++; continue; }
    if (obj && typeof obj === 'object') onObj(obj);
  }
}

function recordFailure(agg, sess, head, text) {
  const h = head || '<unknown>';
  bump(agg.shellFailures, h);
  bump(sess.failHeads, h);
  sess.failures++;
  if (text && NOT_FOUND_RE.test(text)) bump(agg.commandNotFound, h);
}

async function parseClaudeSession(file, agg) {
  const sess = newSession('claude', path.basename(file, '.jsonl'));
  const toolUses = new Map();
  await eachJsonLine(file, (o) => {
    trackTime(sess, o.timestamp);
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
          sess.lastToolError = isErr;
          if (isErr && hookBlockText(text)) agg.hookBlocks++;
          if (isErr && info.head !== null) recordFailure(agg, sess, info.head, text);
          else if (isErr && info.name && SHELL_TOOLS.has(info.name)) recordFailure(agg, sess, null, text);
        }
      }
      if (!sawToolResult && o.isMeta !== true && !o.toolUseResult) {
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
  }, agg);
  return sess;
}

/** Read the first lines of a Codex rollout until its working directory shows up. */
async function codexSessionCwd(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      if (++n > 50) break;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const p = o && o.payload;
      if (p && typeof p.cwd === 'string' && (o.type === 'session_meta' || o.type === 'turn_context')) return p.cwd;
    }
  } finally { rl.close(); }
  return null;
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
  }, agg);
  // The same user turn can be recorded in several places; count from one source only.
  const users = itemUser.length ? itemUser : eventUser.length ? eventUser : responseUser;
  for (const t of users) {
    if (!isHumanText(t)) continue;
    agg.userMessages++;
    if (isCorrection(t)) agg.userCorrections++;
  }
  return sess;
}

function eqPath(a, b) { return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b; }

/** Does a Claude `projects/<name>` dir belong to this project (itself or one of its worktrees)? */
export function matchesProjectDir(name, projectRoot) {
  return projectRoots(projectRoot).some((r) => matchesOneProjectDir(name, r));
}

/** The project path as given plus its real path, when they differ (symlinked dirs, /var on macOS). */
export function projectRoots(projectRoot) {
  const rp = realpathSafe(projectRoot);
  return rp && !eqPath(rp, projectRoot) ? [projectRoot, rp] : [projectRoot];
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

function listJsonl(dir, maxDepth, cutoff) {
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

export async function collect({ projectRoot, configDirs, days = 60 }) {
  const cutoff = Date.now() - days * 86400000;
  const agg = {
    unparsableLines: 0, toolCalls: {}, shellFailures: {}, commandNotFound: {}, hookBlocks: 0,
    userMessages: 0, userCorrections: 0, skillInvocations: {}, slashCommands: {},
  };
  const sessions = [];

  // Claude-style config dirs: <dir>/projects/<encoded cwd>/*.jsonl, deduped by real path
  // (host-app account dirs often link their projects/ to the default one).
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
      for (const f of listJsonl(path.join(pdir, e.name), 0, cutoff)) sessions.push(await parseClaudeSession(f, agg));
    }
  }

  // Codex: ~/.codex/sessions/YYYY/MM/DD/*.jsonl, filtered by the session's recorded cwd.
  let codexScanned = 0;
  for (const d of codexDirs()) {
    for (const f of listJsonl(path.join(d.path, 'sessions'), 4, cutoff)) {
      codexScanned++;
      if (!matchesProjectCwd(await codexSessionCwd(f), projectRoot)) continue;
      sessions.push(await parseCodexSession(f, agg));
    }
  }

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
