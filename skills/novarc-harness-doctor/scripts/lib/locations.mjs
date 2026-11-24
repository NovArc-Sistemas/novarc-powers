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

/** What an account can be an account of: the `provider` values a run and the probes use. */
export const ACCOUNT_PROVIDERS = ['claude-code', 'codex', 'gemini', 'opencode', 'cursor', 'copilot', 'agents', 'other'];
/** The providers whose config dir discover.mjs and harness-checks.mjs know how to read. */
const ACCOUNT_KIND = { 'claude-code': 'claude', codex: 'codex', agents: 'agents' };
/** False for a provider those two scripts have no reader for: its account is listed, never read. */
export const accountSupported = (provider) => Object.hasOwn(ACCOUNT_KIND, String(provider));

/**
 * The user-level locations a probe reads, as `{ claude, codex, agents, desktop }`.
 * Without `account`: every account found on this machine (the functions above), which is what a
 * probe run by hand has always read. With `account` (`{ provider, configDir }`): that one config
 * dir and nothing that belongs to another account, the shared `~/.agents` folder and the desktop
 * app included, since each of them is somebody else's harness. A provider the probes have no
 * reader for gets no location at all.
 */
export function userLocations(account = null) {
  if (!account) return { claude: claudeConfigDirs(), codex: codexDirs(), agents: agentsDirs(), desktop: desktopConfigFiles() };
  const out = { claude: [], codex: [], agents: [], desktop: [] };
  const kind = ACCOUNT_KIND[account.provider];
  const dir = normalizeInputPath(account.configDir);
  if (kind && isDir(dir)) out[kind] = [{ path: dir, agent: kind === 'agents' ? 'shared' : kind, source: 'argument', realpath: realpathSafe(dir) || dir, aliases: [] }];
  return out;
}

/**
 * The account a probe was asked about on its command line: `--provider <p> --config-dir <dir>`,
 * both or neither. Returns `{ account }` (null when the flags are absent) or `{ error }`.
 */
export function accountFromArgs(args) {
  const provider = args.provider;
  const dir = args['config-dir'];
  if (provider === undefined && dir === undefined) return { account: null };
  if (typeof dir !== 'string' || typeof provider !== 'string') return { error: '--provider and --config-dir go together: one account is one config dir of one provider' };
  if (!ACCOUNT_PROVIDERS.includes(provider)) return { error: `--provider must be one of ${ACCOUNT_PROVIDERS.join(', ')}` };
  const configDir = normalizeInputPath(dir);
  if (!isDir(configDir)) return { error: '--config-dir is not a directory' };
  return { account: { provider, configDir, supported: accountSupported(provider) } };
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
