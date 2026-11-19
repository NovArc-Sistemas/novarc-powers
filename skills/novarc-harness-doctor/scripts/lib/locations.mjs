// Where agent harnesses live on this machine. Shared by discover.mjs and transcript-signals.mjs.
import path from 'node:path';
import { IS_WIN, home, isDir, isFile, exists, readdirSafe, realpathSafe, normalizeInputPath } from './common.mjs';

/**
 * Encode a working directory the way Claude Code names its `projects/<dir>`:
 * every character that is not an ASCII letter or digit becomes `-`.
 * `C:\dev\Projects\x` -> `C--dev-Projects-x`.
 */
export function encodeProjectPath(p) {
  return String(p).replace(/[^A-Za-z0-9]/g, '-');
}

function looksLikeClaudeConfig(dir) {
  return isFile(path.join(dir, 'settings.json')) || isFile(path.join(dir, 'CLAUDE.md')) || isDir(path.join(dir, 'projects'));
}

function guessAgent(dir, hint) {
  const s = `${hint || ''} ${path.basename(dir)}`.toLowerCase();
  if (s.includes('codex')) return 'codex';
  if (s.includes('gemini')) return 'gemini';
  if (s.includes('cursor')) return 'cursor';
  return 'claude';
}

/**
 * Host apps (agent orchestrators, desktop shells) keep one config dir per account, e.g.
 * `~/.<app>/host/harness-accounts/<agent>/<account>/`. We look one level under every dot-dir
 * in home for a `harness-accounts` (or `host/harness-accounts`) folder.
 */
function hostAppConfigDirs() {
  const h = home();
  const found = [];
  for (const ent of readdirSafe(h)) {
    if (!ent.isDirectory() || !ent.name.startsWith('.')) continue;
    for (const base of [path.join(h, ent.name, 'harness-accounts'), path.join(h, ent.name, 'host', 'harness-accounts')]) {
      if (!isDir(base)) continue;
      for (const agentEnt of readdirSafe(base)) {
        const agentDir = path.join(base, agentEnt.name);
        if (!isDir(agentDir)) continue;
        for (const accEnt of readdirSafe(agentDir)) {
          const acc = path.join(agentDir, accEnt.name);
          if (isDir(acc) && looksLikeClaudeConfig(acc)) found.push({ path: acc, agent: guessAgent(acc, agentEnt.name), source: 'host-app' });
        }
      }
    }
  }
  return found;
}

function envDirs(name) {
  const v = process.env[name];
  if (!v) return [];
  return v.split(IS_WIN ? /[;,]/ : /[:,]/).map((s) => s.trim()).filter(Boolean).map(normalizeInputPath);
}

/** Claude-style config dirs (anything holding settings.json / CLAUDE.md / projects/), deduped by realpath. */
export function claudeConfigDirs({ extra = [] } = {}) {
  const h = home();
  const candidates = [
    { path: path.join(h, '.claude'), agent: 'claude', source: 'default' },
    ...envDirs('CLAUDE_CONFIG_DIR').map((p) => ({ path: p, agent: 'claude', source: 'CLAUDE_CONFIG_DIR' })),
    ...hostAppConfigDirs(),
    ...extra.map((p) => ({ path: normalizeInputPath(p), agent: 'claude', source: 'argument' })),
  ];
  return dedupe(candidates.filter((c) => isDir(c.path)));
}

export function codexDirs() {
  const h = home();
  const c = [{ path: path.join(h, '.codex'), agent: 'codex', source: 'default' }, ...envDirs('CODEX_HOME').map((p) => ({ path: p, agent: 'codex', source: 'CODEX_HOME' }))];
  return dedupe(c.filter((x) => isDir(x.path)));
}

export function agentsDirs() {
  const p = path.join(home(), '.agents');
  return isDir(p) ? [{ path: p, agent: 'shared', source: 'default', realpath: realpathSafe(p) || p, aliases: [] }] : [];
}

/** Claude desktop app config file candidates for every OS; only existing ones are returned. */
export function desktopConfigFiles() {
  const h = home();
  const c = [];
  if (process.env.APPDATA) c.push(path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json'));
  c.push(path.join(h, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  c.push(path.join(h, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  c.push(path.join(process.env.XDG_CONFIG_HOME || path.join(h, '.config'), 'Claude', 'claude_desktop_config.json'));
  const seen = new Set();
  const out = [];
  for (const p of c) {
    if (!exists(p)) continue;
    const rp = realpathSafe(p) || p;
    const key = IS_WIN ? rp.toLowerCase() : rp;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function dedupe(list) {
  const seen = new Map();
  const out = [];
  for (const c of list) {
    const rp = realpathSafe(c.path) || c.path;
    const key = IS_WIN ? rp.toLowerCase() : rp;
    if (seen.has(key)) { seen.get(key).aliases.push(c.path); continue; }
    const entry = { ...c, realpath: rp, aliases: [] };
    seen.set(key, entry);
    out.push(entry);
  }
  return out;
}
