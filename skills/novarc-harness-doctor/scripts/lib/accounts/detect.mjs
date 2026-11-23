// Agent accounts on this machine. An account is one config dir of one provider; each has its own
// user harness. Read-only: nothing here writes, and the only file content read is the masked
// account identity (one key of the Claude Code state file).
import path from 'node:path';
import {
  IS_WIN, homeDir, displayPath, pathKey, isInside, isDir, isFile, lstatSafe, realpathSafe, readdirSafe,
  readText, parseJson, sameFile, isNeverTop,
} from '../../sync-check.mjs';
import { translator } from './strings.mjs';

/**
 * What each provider's user harness is made of.
 *   instruction   the instruction file at the root of the config dir
 *   importSyntax  true when that file can `@import` others (they must then exist per account)
 *   files, dirs   the other harness elements that can be linked between accounts
 *   skills        folder holding one sub-folder per skill
 *   skillsOptional  link skills only when that folder already exists (support varies by version)
 *   mcp           where user-level MCP servers are defined, and in which format
 *   sharedSkills  the provider also reads the shared ~/.agents/skills folder
 *   markers       what makes a folder found under a host app an account of this provider: any of
 *                 these files (settings, instructions, credentials or state; only their presence
 *                 is checked, they are not opened), or any of these folders when it is a real
 *                 folder and not a link
 *   extra         harness files and folders this feature does not link or generate, but which
 *                 count when asking whether an account holds any harness at all
 */
export const PROVIDERS = {
  'claude-code': {
    key: 'claude', label: 'Claude Code', instruction: 'CLAUDE.md', importSyntax: true,
    files: ['settings.json', 'keybindings.json'],
    dirs: ['skills', 'agents', 'commands', 'rules', 'output-styles', 'scripts', 'hooks', 'plugins'],
    skills: 'skills', mcp: { file: '.claude.json', format: 'claude-json' },
    markers: { files: ['settings.json', 'CLAUDE.md', '.claude.json', '.credentials.json'], dirs: ['projects'] },
    extra: { files: [], dirs: [] },
  },
  codex: {
    key: 'codex', label: 'Codex', instruction: 'AGENTS.md', importSyntax: false,
    files: ['hooks.json'], dirs: ['skills', 'agents', 'prompts'],
    skills: 'skills', mcp: { file: 'config.toml', format: 'codex-toml' }, sharedSkills: true,
    markers: { files: ['config.toml', 'AGENTS.md', 'auth.json'], dirs: ['sessions'] },
    extra: { files: ['config.toml'], dirs: [] },
  },
  gemini: {
    key: 'gemini', label: 'Gemini CLI', instruction: 'GEMINI.md', importSyntax: true,
    files: [], dirs: ['skills'], skills: 'skills', skillsOptional: true, mcp: null,
    markers: { files: ['settings.json', 'GEMINI.md'], dirs: [] },
    extra: { files: ['settings.json'], dirs: [] },
  },
  opencode: {
    key: 'opencode', label: 'OpenCode', instruction: 'AGENTS.md', importSyntax: false,
    files: [], dirs: ['skills'], skills: 'skills', skillsOptional: true, mcp: null,
    markers: { files: ['opencode.json', 'opencode.jsonc', 'AGENTS.md'], dirs: [] },
    extra: { files: ['opencode.json', 'opencode.jsonc'], dirs: [] },
  },
  cursor: {
    key: 'cursor', label: 'Cursor', instruction: null, importSyntax: false,
    files: [], dirs: [], skills: null, mcp: null,
    markers: { files: ['mcp.json'], dirs: [] },
    extra: { files: ['mcp.json'], dirs: ['rules', 'skills'] },
  },
  agents: {
    key: 'agents', label: 'Shared agents dir', instruction: null, importSyntax: false,
    files: [], dirs: ['skills'], skills: 'skills', mcp: null,
    markers: { files: [], dirs: [] },
    extra: { files: [], dirs: [] },
  },
};

export { isNeverTop };

/** Folder names that are never an account: lock, backup and temporary folders, hidden ones. */
const NOT_AN_ACCOUNT = /\.(lock|bak|old|tmp|backup)$|^[._]/i;

/**
 * True when a folder holds at least one thing an account of that provider has: a settings,
 * instruction, credentials or state file, or a real `projects` / `sessions` folder (a link to
 * somebody else's does not count). Files are only checked for presence.
 */
export function hasAccountMarker(provider, dir) {
  const m = PROVIDERS[provider].markers;
  if (m.files.some((n) => isFile(path.join(dir, n)))) return true;
  return m.dirs.some((n) => { const l = lstatSafe(path.join(dir, n)); return !!l && l.isDirectory() && !l.isSymbolicLink(); });
}

function normalizeEnvPath(p) {
  let s = String(p).trim();
  if (IS_WIN) {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(s); // Git Bash form
    if (m) s = `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`;
  }
  return path.resolve(s);
}

function envDirs(env, name) {
  const v = env[name];
  if (!v) return [];
  return v.split(IS_WIN ? /[;,]/ : /[:,]/).map((s) => s.trim()).filter(Boolean).map(normalizeEnvPath);
}

function guessProvider(hint, dir) {
  const s = String(hint).toLowerCase();
  for (const [word, provider] of [['codex', 'codex'], ['gemini', 'gemini'], ['opencode', 'opencode'], ['cursor', 'cursor'], ['claude', 'claude-code']]) {
    if (s.includes(word)) return provider;
  }
  if (hasAccountMarker('claude-code', dir)) return 'claude-code';
  if (hasAccountMarker('codex', dir)) return 'codex';
  return null;
}

/**
 * Host apps (agent orchestrators, desktop shells) keep one config dir per account under
 * `~/.<app>/harness-accounts/<agent>/<account>/` or `~/.<app>/host/harness-accounts/...`.
 * Beside the account folders they also keep things that are not accounts (`<id>.lock`, backups,
 * temporary folders): a folder counts only when its name is not one of those and it holds at
 * least one account marker.
 */
function hostAppDirs(home) {
  const out = [];
  for (const ent of readdirSafe(home)) {
    if (!ent.name.startsWith('.') || !isDir(path.join(home, ent.name))) continue;
    for (const base of [path.join(home, ent.name, 'harness-accounts'), path.join(home, ent.name, 'host', 'harness-accounts')]) {
      for (const agentEnt of readdirSafe(base)) {
        const agentDir = path.join(base, agentEnt.name);
        if (NOT_AN_ACCOUNT.test(agentEnt.name) || !isDir(agentDir)) continue;
        for (const accEnt of readdirSafe(agentDir)) {
          const dir = path.join(agentDir, accEnt.name);
          if (NOT_AN_ACCOUNT.test(accEnt.name) || !isDir(dir)) continue;
          const provider = guessProvider(agentEnt.name, dir);
          if (!provider || !hasAccountMarker(provider, dir)) continue;
          out.push({ provider, dir, source: 'host-app', host: ent.name.replace(/^\./, '') });
        }
      }
    }
  }
  return out;
}

/** The Claude Code state file of an account: `.claude.json` in the dir, or in home for the default dir. */
export function claudeStateFile(account, home = homeDir()) {
  const inside = path.join(account.pathAbs, '.claude.json');
  if (lstatSafe(inside)) return inside;
  if (account.isDefault) return path.join(home, '.claude.json');
  return inside;
}

/** The file that defines an account's user-level MCP servers, or null when it has none we manage. */
export function mcpFile(account, home = homeDir()) {
  const spec = PROVIDERS[account.provider].mcp;
  if (!spec) return null;
  const file = spec.format === 'claude-json' ? claudeStateFile(account, home) : path.join(account.pathAbs, spec.file);
  return { file, format: spec.format };
}

/** `someone@example.com` -> `so…@example.com`. Never returns the full local part. */
export function maskIdentity(email) {
  if (typeof email !== 'string') return undefined;
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(email.trim());
  if (!m) return undefined;
  return `${m[1].slice(0, 2)}…@${m[2]}`;
}

/**
 * What is taken from a Claude Code account's state file, and nothing else: the masked identity
 * (the e-mail recorded under `oauthAccount`) and how many user-level MCP servers it defines.
 * Other providers keep the identity inside their credential file, which is never opened, so
 * they have none.
 */
function claudeState(account, home) {
  if (account.provider !== 'claude-code') return {};
  const text = readText(claudeStateFile(account, home), 64 * 1024 * 1024);
  if (text === null) return {};
  const j = parseJson(text);
  if (!j.ok || !j.value || typeof j.value !== 'object') return {};
  const oa = j.value.oauthAccount;
  const servers = j.value.mcpServers;
  return {
    identity: oa && typeof oa === 'object' ? maskIdentity(oa.emailAddress) : undefined,
    mcpServers: servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers).length : 0,
  };
}

/** The label people read: `Claude Code · account 2`, `Claude Code · conta 2`. */
export function accountLabel(account, lang) {
  const t = translator(lang);
  if (account.provider === 'agents') return t('label.agents');
  return t('label.account', { provider: PROVIDERS[account.provider].label, n: account.ordinal });
}

/** Paths of an account that may be links into another account. */
function linkProbes(account) {
  const p = PROVIDERS[account.provider];
  const out = [];
  for (const n of [p.instruction, ...p.files, ...p.dirs]) if (n) out.push(n);
  if (p.skills) for (const ent of readdirSafe(path.join(account.pathAbs, p.skills))) if (!ent.name.startsWith('.')) out.push(path.join(p.skills, ent.name));
  if (account.provider === 'claude-code') {
    for (const ent of readdirSafe(account.pathAbs)) if (/\.md$/i.test(ent.name) && ent.name !== p.instruction && !isNeverTop(ent.name)) out.push(ent.name);
  }
  return out;
}

/** For each account, the account most of its harness files already link to (or null). */
function computeLinksInto(accounts) {
  accounts.forEach((a, index) => {
    const votes = new Map();
    const vote = (id) => votes.set(id, (votes.get(id) || 0) + 1);
    for (const rel of linkProbes(a)) {
      const full = path.join(a.pathAbs, rel);
      const l = lstatSafe(full);
      if (!l) continue;
      if (l.isSymbolicLink()) {
        const rp = realpathSafe(full);
        if (!rp) continue;
        const owner = accounts.find((b) => b !== a && isInside(rp, b.realpath));
        if (owner) vote(owner.id);
      } else if (l.isFile() && l.nlink > 1) {
        // A hardlink has no direction: the default account, or the earlier one, is the source.
        const owner = accounts.find((b, j) => b !== a && b.provider === a.provider && (b.isDefault || (!a.isDefault && j < index)) && sameFile(full, path.join(b.pathAbs, rel)));
        if (owner) vote(owner.id);
      }
    }
    let best = null;
    for (const [id, n] of votes) if (!best || n > best[1]) best = [id, n];
    a.linksInto = best ? best[0] : null;
  });
}

/**
 * Every account found, as internal records:
 *   { id, provider, ordinal, label, identity?, path, pathAbs, realpath, isDefault, host,
 *     linksInto, source, mcpServers }
 * Ids are stable and readable: `claude-1` is the default Claude dir, `claude-2`... the others
 * sorted by path; `codex-1`, and so on. `label` here is the English one; `accountLabel` gives
 * it in another language.
 */
export function detectAccounts({ home = homeDir(), env = process.env } = {}) {
  const candidates = [];
  const add = (provider, dir, source, host = null) => candidates.push({ provider, dir: path.resolve(dir), source, host });
  add('claude-code', path.join(home, '.claude'), 'default');
  for (const d of envDirs(env, 'CLAUDE_CONFIG_DIR')) add('claude-code', d, 'CLAUDE_CONFIG_DIR');
  add('codex', path.join(home, '.codex'), 'default');
  for (const d of envDirs(env, 'CODEX_HOME')) add('codex', d, 'CODEX_HOME');
  add('gemini', path.join(home, '.gemini'), 'default');
  add('opencode', path.join(env.XDG_CONFIG_HOME ? normalizeEnvPath(env.XDG_CONFIG_HOME) : path.join(home, '.config'), 'opencode'), 'default');
  add('cursor', path.join(home, '.cursor'), 'default');
  add('agents', path.join(home, '.agents'), 'default');
  for (const h of hostAppDirs(home)) add(h.provider, h.dir, h.source, h.host);

  const seen = new Set();
  const found = [];
  for (const c of candidates) {
    if (!isDir(c.dir)) continue;
    const rp = realpathSafe(c.dir) || c.dir;
    if (seen.has(pathKey(rp))) continue;
    seen.add(pathKey(rp));
    found.push({ ...c, realpath: rp, isDefault: c.source === 'default' });
  }
  const accounts = [];
  for (const provider of Object.keys(PROVIDERS)) {
    const mine = found.filter((f) => f.provider === provider).sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return displayPath(a.dir, home).localeCompare(displayPath(b.dir, home));
    });
    mine.forEach((f, i) => {
      const spec = PROVIDERS[provider];
      const account = {
        id: `${spec.key}-${i + 1}`, provider, ordinal: i + 1, label: '',
        path: displayPath(f.dir, home), pathAbs: f.dir, realpath: f.realpath,
        isDefault: f.isDefault, host: f.host, linksInto: null, source: f.source,
      };
      account.label = accountLabel(account, 'en');
      const state = claudeState(account, home);
      if (state.identity) account.identity = state.identity;
      account.mcpServers = state.mcpServers || 0;
      accounts.push(account);
    });
  }
  computeLinksInto(accounts);
  return accounts;
}

/**
 * The shape `accounts.mjs list` prints for one account. `pathAbs` is the only absolute path;
 * `label` is the only field worded for people, in `lang`.
 */
export function publicAccount(a, lang = 'en') {
  const out = { id: a.id, provider: a.provider, label: accountLabel(a, lang) };
  if (a.identity) out.identity = a.identity;
  return { ...out, path: a.path, pathAbs: a.pathAbs, isDefault: a.isDefault, host: a.host, linksInto: a.linksInto };
}

/** The account each provider's CLI would use in this environment (the session may be on a secondary one). */
export function accountsInUse(accounts, { env = process.env } = {}) {
  const pick = (provider, envName) => {
    const dirs = envDirs(env, envName);
    if (dirs.length) {
      const rp = realpathSafe(dirs[0]) || dirs[0];
      const hit = accounts.find((a) => a.provider === provider && pathKey(a.realpath) === pathKey(rp));
      if (hit) return hit.id;
    }
    const def = accounts.find((a) => a.provider === provider && a.isDefault);
    return def ? def.id : null;
  };
  return { 'claude-code': pick('claude-code', 'CLAUDE_CONFIG_DIR'), codex: pick('codex', 'CODEX_HOME') };
}
