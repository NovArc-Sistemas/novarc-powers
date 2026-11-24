// Compares every other account with the primary, element by element. Read-only.
//
// Same provider   -> the account can be LINKED: each harness element is compared as a file or a
//                    folder (linked / copied / divergent / missing / account-only).
// Other provider  -> the portable subset can be REPLICATED: the instruction file is generated,
//                    each skill is linked, MCP servers are translated; the rest is not-portable.
//
// States, modes and suggestions are machine values. Every sentence shown to a person (`note`,
// `detail`, `notes`, `warnings`, `suggestionText`) comes from strings.mjs in the run language.
import path from 'node:path';
import {
  IS_WIN, homeDir, displayPath, pathKey, isInside, isFile, isDir, lstatSafe, statSafe, realpathSafe, readdirSafe,
  readText, parseJson, hashFile, sha256, canon, linkStatus, collectImports, generateInstructions,
  readServers, reconcileServers, destinationProblem, GENERATED_PREFIX, MCP_PREFIX, SKILL_PREFIX,
} from '../../sync-check.mjs';
import { PROVIDERS, isNeverTop, mcpFile, accountLabel } from './detect.mjs';
import { compareTrees, sameContent, signature } from './fsops.mjs';
import { translator } from './strings.mjs';

export const STATES = ['linked', 'generated', 'copied', 'divergent', 'missing', 'account-only', 'not-portable'];
const CODEX_DOC_LIMIT = 32 * 1024; // project_doc_max_bytes default

function readJsonObject(file) {
  const j = parseJson(readText(file));
  return j.ok && j.value && typeof j.value === 'object' && !Array.isArray(j.value) ? j.value : null;
}

/** The status line script named in settings.json, when it is a file at the top of the config dir. */
function statuslineScript(account, home) {
  if (account.provider !== 'claude-code') return null;
  const s = readJsonObject(path.join(account.pathAbs, 'settings.json'));
  const cmd = s && s.statusLine && typeof s.statusLine.command === 'string' ? s.statusLine.command : null;
  if (!cmd) return null;
  for (const tokRaw of cmd.match(/"[^"]+"|'[^']+'|\S+/g) || []) {
    let tok = tokRaw.replace(/^["']|["']$/g, '');
    tok = tok
      .replace(/^\$\{?CLAUDE_CONFIG_DIR\}?/, () => account.pathAbs)
      .replace(/^(~|\$\{?HOME\}?|%USERPROFILE%)(?=[\\/]|$)/, () => home);
    if (IS_WIN) {
      const m = /^\/([a-zA-Z])\/(.*)$/.exec(tok);
      if (m) tok = `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
    }
    const abs = path.isAbsolute(tok) ? path.normalize(tok) : /\.[A-Za-z0-9]{1,5}$/.test(tok) ? path.join(account.pathAbs, tok) : null;
    if (!abs || !isInside(abs, account.pathAbs) || !isFile(abs)) continue;
    const rel = path.relative(account.pathAbs, abs).replace(/\\/g, '/');
    const top = rel.split('/')[0];
    if (!rel || rel.includes('..') || isNeverTop(top) || PROVIDERS[account.provider].dirs.includes(top)) continue;
    return rel;
  }
  return null;
}

/**
 * The harness elements of an account that can be linked into another account of the same
 * provider: name -> { abs, dir }. Folders carry a trailing slash in their name. Credentials,
 * sessions, history, caches and account-local settings are never in this list.
 */
export function linkableElements(account, home = homeDir()) {
  const spec = PROVIDERS[account.provider];
  const out = new Map();
  const add = (name, abs, dir, role) => { if (!out.has(name) && lstatSafe(abs)) out.set(name, { abs, dir, role }); };
  if (spec.instruction) {
    const f = path.join(account.pathAbs, spec.instruction);
    add(spec.instruction, f, false, 'instruction');
    if (spec.importSyntax && isFile(f)) {
      for (const abs of collectImports(f, { home })) {
        if (!isInside(abs, account.pathAbs)) continue; // a home-anchored import works from any account
        const rel = path.relative(account.pathAbs, abs).replace(/\\/g, '/');
        const top = rel.split('/')[0];
        if (isNeverTop(top) || spec.dirs.includes(top)) continue; // inside a linked folder: covered by it
        add(rel, abs, false, 'import');
      }
    }
  }
  for (const n of spec.files) add(n, path.join(account.pathAbs, n), false);
  const sl = statuslineScript(account, home);
  if (sl) add(sl, path.join(account.pathAbs, sl), false);
  for (const n of spec.dirs) add(`${n}/`, path.join(account.pathAbs, n), true);
  return out;
}

const hasContent = (dir) => readdirSafe(dir).some((e) => !e.name.startsWith('.'));

/**
 * How many harness elements an account's config dir holds: its instruction file and the files
 * that file imports, settings, key bindings, the status line script, each non-empty harness
 * folder (skills, agents, commands...), and its user-level MCP servers counted as one. Zero
 * means there is nothing to review in that account. A file that is only a broken link and a
 * folder with nothing in it do not count.
 */
export function countElements(account, home = homeDir()) {
  const spec = PROVIDERS[account.provider];
  const seen = new Set();
  for (const [name, el] of linkableElements(account, home)) {
    if (el.dir ? hasContent(el.abs) : isFile(el.abs)) seen.add(name);
  }
  for (const n of spec.extra.files) if (isFile(path.join(account.pathAbs, n))) seen.add(n);
  for (const n of spec.extra.dirs) if (hasContent(path.join(account.pathAbs, n))) seen.add(`${n}/`);
  if (account.provider === 'claude-code' && account.mcpServers > 0) seen.add('mcp servers');
  return seen.size;
}

/** State of one file or folder of an account (S) against the primary's (P). */
function pathState(P, S, t) {
  const lp = lstatSafe(P);
  const ls = lstatSafe(S);
  if (!lp && !ls) return null;
  if (!ls) return { state: 'missing' };
  if (!lp) return { state: 'account-only' };
  const st = linkStatus(S, P);
  if (st.state === 'ok') return { state: 'linked', linkKind: st.kind, note: t(`path.${st.kind}`) };
  const sp = statSafe(P);
  const ss = statSafe(S);
  if (!sp) return { state: 'account-only', note: t('path.primaryBroken') };
  if (!ss) return { state: 'missing', broken: true, note: t('path.broken') };
  // The account's element may be a link to somewhere other than the primary: say so first.
  const note = (text) => [ls.isSymbolicLink() ? t('path.elsewhere') : null, text].filter(Boolean).join('; ') || undefined;
  if (sp.isDirectory() !== ss.isDirectory()) return { state: 'divergent', note: note(t('path.typeMismatch')) };
  if (sp.isDirectory()) {
    // Either side may itself be a link to a folder kept elsewhere: compare what they hold.
    const r = compareTrees(realpathSafe(P) || P, realpathSafe(S) || S);
    if (r === 'same') return { state: 'copied', note: note(t('path.sameNotLinked')) };
    return { state: 'divergent', note: note(r === 'unknown' ? t('path.tooLarge') : null) };
  }
  if (sameContent(P, S)) return { state: 'copied', note: note(t('path.sameNotLinked')) };
  return { state: 'divergent', note: note(null) };
}

/**
 * True when the manifest was written for this primary. Accounts are matched by folder, not by
 * id: an id is positional and can shift when a config-dir variable adds or removes an account.
 */
export function manifestIsFor(manifest, primary) {
  if (!manifest) return false;
  if (manifest.primaryPathAbs) return pathKey(manifest.primaryPathAbs) === pathKey(primary.pathAbs);
  return manifest.primary === primary.id;
}

/** The account a manifest names as its primary, or null. */
export function primaryFromManifest(manifest, accounts) {
  if (!manifest) return null;
  return accounts.find((a) => manifestIsFor(manifest, a)) || null;
}

function manifestAccount(manifest, primary, account) {
  if (!manifestIsFor(manifest, primary)) return null;
  return manifest.accounts.find((a) => a.pathAbs && pathKey(a.pathAbs) === pathKey(account.pathAbs)) || null;
}

function diffLinked(primary, account, ctx) {
  const { t } = ctx;
  const pe = linkableElements(primary, ctx.home);
  const se = linkableElements(account, ctx.home);
  const names = [...new Set([...pe.keys(), ...se.keys()])];
  const out = [];
  for (const name of names) {
    const rel = name.replace(/\/$/, '');
    const dir = (pe.get(name) || se.get(name)).dir;
    // An import of the primary's instruction file matters only where that file is followed.
    const primaryImport = pe.has(name) && pe.get(name).role === 'import';
    const P = path.join(primary.pathAbs, rel);
    const S = path.join(account.pathAbs, rel);
    const st = pathState(P, S, t);
    if (!st) continue;
    // A managed copy (made where no link was possible) is a generated file: up to date, out of
    // date while nobody edited it, or divergent once somebody did.
    const el = ctx.managed.get(name);
    if (el && el.kind === 'generated' && st.state === 'copied') { st.state = 'generated'; st.note = t('path.managedCopy'); } else if (el && el.kind === 'generated' && st.state === 'divergent' && hashFile(S) === el.contentHash) { st.state = 'generated'; st.stale = true; st.note = t('path.managedCopyStale'); }
    out.push({ name, type: dir ? 'dir' : 'file', dir, primaryImport, P, S, ...st });
  }
  return out;
}

/** The folder where an account receives the primary's skills, or why it gets none. */
function skillsTarget(primary, account, ctx) {
  const { t } = ctx;
  const spec = PROVIDERS[account.provider];
  if (!spec.skills) return { dir: null };
  const shared = ctx.accounts.find((a) => a.provider === 'agents');
  if (spec.sharedSkills && shared) {
    if (shared.id === primary.id) return { dir: null, note: t('note.skillsNative', { path: shared.path }) };
    if (ctx.selected.has(shared.id)) return { dir: null, note: t('note.skillsShared', { path: shared.path, id: shared.id }) };
  }
  const dir = path.join(account.pathAbs, spec.skills);
  if (spec.skillsOptional && !isDir(dir)) return { dir: null, note: t('note.skillsNoDir', { path: displayPath(dir, ctx.home) }) };
  return { dir };
}

function skillNames(dir) {
  return readdirSafe(dir).filter((e) => !e.name.startsWith('.') && isFile(path.join(dir, e.name, 'SKILL.md'))).map((e) => e.name).sort();
}

/** What the primary has that another provider cannot take, with what to mirror by hand. */
function notPortable(primary, t) {
  const out = [];
  const add = (name, note) => out.push({ name, type: 'info', state: 'not-portable', note });
  const dirHas = (n) => readdirSafe(path.join(primary.pathAbs, n)).length > 0;
  if (primary.provider === 'claude-code') {
    const s = readJsonObject(path.join(primary.pathAbs, 'settings.json')) || {};
    const perms = s.permissions && typeof s.permissions === 'object' ? s.permissions : {};
    const n = (k) => (Array.isArray(perms[k]) ? perms[k].length : 0);
    if (n('allow') + n('deny') + n('ask') > 0 || perms.defaultMode) add('permissions', t('notPortable.claude.permissions', { deny: n('deny'), ask: n('ask'), allow: n('allow') }));
    const events = s.hooks && typeof s.hooks === 'object' ? Object.keys(s.hooks).filter((k) => Array.isArray(s.hooks[k]) && s.hooks[k].length) : [];
    if (events.length) add('hooks', t('notPortable.claude.hooksEvents', { events: events.sort().join(', ') }));
    else if (dirHas('hooks')) add('hooks', t('notPortable.claude.hooks'));
    const plugins = s.enabledPlugins && typeof s.enabledPlugins === 'object' ? Object.keys(s.enabledPlugins).filter((k) => s.enabledPlugins[k] === true).length : 0;
    if (plugins || dirHas('plugins')) add('plugins', t('notPortable.claude.plugins', { n: plugins }));
    if (lstatSafe(path.join(primary.pathAbs, 'keybindings.json'))) add('keybindings', t('notPortable.claude.keybindings'));
    for (const d of ['agents', 'commands', 'rules', 'output-styles']) if (dirHas(d)) add(`${d}/`, t(`notPortable.claude.${d}`));
  } else if (primary.provider === 'codex') {
    if (lstatSafe(path.join(primary.pathAbs, 'config.toml'))) add('permissions', t('notPortable.codex.permissions'));
    if (lstatSafe(path.join(primary.pathAbs, 'hooks.json'))) add('hooks', t('notPortable.codex.hooks'));
    for (const d of ['agents', 'prompts']) if (dirHas(d)) add(`${d}/`, t(`notPortable.codex.${d}`));
  }
  return out;
}

/** Why a server cannot be replicated, in the run language (the core only words it in English). */
function blockedNote(it, t) {
  const key = `mcp.blocked.${it.code}`;
  return it.code && t.has(key) ? t(key, it.params || {}) : it.note;
}

function diffServers(primary, account, ctx, notes) {
  const { t } = ctx;
  const none = { elements: [], mcp: null };
  const pm = mcpFile(primary, ctx.home);
  const am = mcpFile(account, ctx.home);
  if (!pm || !am) return none;
  const src = readServers(pm.file, pm.format);
  const tgt = readServers(am.file, am.format);
  if (!src.ok) { notes.push(t('note.mcpPrimaryUnreadable')); return none; }
  if (!src.exists && !ctx.managedNames.some((n) => n.startsWith(MCP_PREFIX))) return none;
  if (!tgt.ok) { notes.push(t('note.mcpTargetUnreadable', { path: displayPath(am.file, ctx.home) })); return none; }
  if (!tgt.exists && am.format === 'claude-json') {
    if (Object.keys(src.servers).length) notes.push(t('note.mcpNoState'));
    return none;
  }
  const managed = {};
  for (const [name, el] of ctx.managed) if (el.kind === 'managed-block') managed[name.slice(MCP_PREFIX.length)] = el.contentHash;
  const items = reconcileServers({ source: src.servers, target: tgt.servers, sourceFormat: pm.format, targetFormat: am.format, managed });
  const out = [];
  for (const it of items) {
    const base = { name: MCP_PREFIX + it.name, type: 'mcp', server: it.name, status: it.status, want: it.want, cur: tgt.servers[it.name] ? tgt.servers[it.name].def : undefined, P: pm.file, S: am.file, sourceDef: src.servers[it.name] ? src.servers[it.name].def : undefined };
    const cur = tgt.servers[it.name];
    const fixed = cur && (cur.inline || cur.opaque) ? t('mcp.fixed') : null;
    if (it.status === 'ok') out.push({ ...base, state: 'generated' });
    else if (it.status === 'ok-foreign') {
      if (it.exact && !fixed) out.push({ ...base, state: 'copied', exact: true, note: t('mcp.foreignIdentical') });
      else out.push({ ...base, state: 'copied', settled: true, note: fixed || t('mcp.foreignExtras') });
    } else if (it.status === 'missing') out.push({ ...base, state: 'missing' });
    else if (it.status === 'stale') out.push({ ...base, state: 'generated', stale: true, note: t('mcp.outOfDate') });
    else if (it.status === 'edited') out.push({ ...base, state: 'divergent', note: fixed || t('mcp.edited'), fixed: !!fixed });
    else if (it.status === 'differs') out.push({ ...base, state: 'divergent', note: fixed || undefined, fixed: !!fixed });
    else if (it.status === 'gone') {
      if (!it.absent) out.push({ ...base, state: 'generated', stale: true, gone: true, note: t('mcp.gone') });
      else out.push({ ...base, state: 'missing', forget: true });
    } else if (it.status === 'gone-edited') out.push({ ...base, state: 'account-only', note: t('mcp.goneEdited') });
    else if (it.status === 'account-only') out.push({ ...base, state: 'account-only' });
    else if (it.status === 'blocked') out.push({ ...base, state: 'not-portable', blocked: it.reason, note: blockedNote(it, t) });
  }
  return { elements: out, mcp: { source: pm.file, sourceFormat: pm.format, path: am.file, format: am.format } };
}

function diffReplicated(primary, account, ctx, notes, warnings) {
  const { t } = ctx;
  const ps = PROVIDERS[primary.provider];
  const as = PROVIDERS[account.provider];
  const out = [];
  // Instruction file.
  if (as.instruction) {
    const S = path.join(account.pathAbs, as.instruction);
    const source = ps.instruction ? path.join(primary.pathAbs, ps.instruction) : null;
    const gen = source && isFile(source) ? generateInstructions({ source, provider: account.provider, sourceDisplay: displayPath(source, ctx.home), inlineImports: !!ps.importSyntax, home: ctx.home }) : null;
    const base = { name: as.instruction, type: 'instruction', P: source, S };
    if (!gen) {
      if (lstatSafe(S)) out.push({ ...base, state: 'account-only', note: t('instruction.noSource') });
    } else {
      const want = sha256(Buffer.from(gen.text, 'utf8'));
      const here = lstatSafe(S) ? hashFile(S) : null;
      const el = ctx.managed.get(as.instruction);
      const gbase = { ...base, want, here, text: gen.text, inlineImports: !!ps.importSyntax, sourceDisplay: displayPath(source, ctx.home) };
      if (!lstatSafe(S)) out.push({ ...gbase, state: 'missing' });
      else if (here === want) out.push({ ...gbase, state: 'generated' });
      else if (el && el.kind === 'generated' && here !== null && here === el.contentHash) {
        // Out of date and never edited: regenerated without asking, but only while the path is
        // still the plain file that was generated. Once it is a link, or shares its content
        // with another file, rewriting it would reach a place nobody was shown: a conflict.
        if (destinationProblem(el.identity, S, account.pathAbs)) out.push({ ...gbase, state: 'divergent', note: t('instruction.moved') });
        else out.push({ ...gbase, state: 'generated', stale: true, note: t('instruction.outOfDate') });
      } else {
        const head = (readText(S, 1024 * 1024) || '').slice(0, 200);
        out.push({ ...gbase, state: 'divergent', note: t(head.startsWith(GENERATED_PREFIX) ? 'instruction.generatedEdited' : 'instruction.own') });
      }
      const bytes = Buffer.byteLength(gen.text, 'utf8');
      if (account.provider === 'codex' && bytes > CODEX_DOC_LIMIT) warnings.push(t('warning.codexLimit', { id: account.id, file: as.instruction, kib: Math.ceil(bytes / 1024), limit: CODEX_DOC_LIMIT / 1024 }));
      if (gen.unresolved.length) notes.push(t('note.unresolvedImports', { n: gen.unresolved.length }));
    }
    if (account.provider === 'codex' && lstatSafe(path.join(account.pathAbs, 'AGENTS.override.md'))) warnings.push(t('warning.codexOverride', { id: account.id, file: as.instruction }));
  }
  // Skills: one link per skill folder.
  const target = skillsTarget(primary, account, ctx);
  if (target.note) notes.push(target.note);
  const sourceDir = ps.skills ? path.join(primary.pathAbs, ps.skills) : null;
  if (target.dir && sourceDir) {
    const mine = skillNames(sourceDir);
    for (const n of mine) {
      const P = path.join(sourceDir, n);
      const S = path.join(target.dir, n);
      const st = pathState(P, S, t);
      if (st) out.push({ name: SKILL_PREFIX + n, type: 'skill', dir: true, P, S, ...st });
    }
    for (const n of skillNames(target.dir)) {
      if (mine.includes(n)) continue;
      out.push({ name: SKILL_PREFIX + n, type: 'skill', dir: true, P: path.join(sourceDir, n), S: path.join(target.dir, n), state: 'account-only' });
    }
  }
  const servers = diffServers(primary, account, ctx, notes);
  out.push(...servers.elements);
  // The shared skills folder is not an agent: there is nothing else it could take.
  if (account.provider !== 'agents') out.push(...notPortable(primary, t));
  if (account.provider === 'cursor') notes.push(t('note.cursor'));
  return { elements: out, skillsDir: target.dir, skillsSource: sourceDir, mcp: servers.mcp };
}

/** An element that does not follow the primary yet and could (it is not kept apart). */
const couldFollow = (e) => e.type !== 'info' && !e.forget && !e.exception && !e.settled && (e.stale || e.state === 'missing' || e.state === 'copied' || e.state === 'divergent');

function summarize(primary, account, all, tracked, t) {
  const same = account.provider === primary.provider;
  const elements = all.filter((e) => !e.forget);
  const counts = {};
  for (const e of elements) counts[e.state] = (counts[e.state] || 0) + 1;
  const followed = (counts.linked || 0) + (counts.generated || 0);
  const open = elements.filter(couldFollow);
  let mode = 'independent';
  let status = 'none';
  if (tracked || followed > 0) {
    mode = same ? 'linked' : 'replicated';
    status = elements.some((e) => e.broken && !e.exception) ? 'broken' : open.length ? 'drift' : 'ok';
  }
  const detail = STATES.filter((s) => counts[s]).map((s) => t(`detail.state.${s}`, { n: counts[s] })).join(', ') || t('detail.none');
  // What the caller could offer for this account. `link` and `replicate` say that something
  // here can follow the primary; whether it does stays the user's decision, through a plan.
  let suggested = 'none';
  let suggestionText;
  if (open.length) {
    suggested = same ? 'link' : 'replicate';
    const decide = open.filter((e) => e.state === 'divergent').length;
    suggestionText = `${t(`suggest.${suggested}`, { n: open.length })}${decide ? t('suggest.decisions', { n: decide }) : ''}.`;
  } else suggestionText = t(followed > 0 ? 'suggest.inStep' : 'suggest.nothing');
  return { mode, status, detail, suggested, suggestionText };
}

/**
 * Compare every other account with the primary.
 *   accounts   from detectAccounts()
 *   manifest   from readManifest(), or null
 *   selected   Set of account ids taking part (default: all but the primary)
 *   lang       language of every sentence in the result ('en' or 'pt')
 * Returns rich records for the planner; `publicDiff` reduces them to what is printed.
 */
export function computeDiff({ accounts, primaryId, manifest = null, selected = null, lang = 'en', home = homeDir() }) {
  const primary = accounts.find((a) => a.id === primaryId);
  if (!primary) throw new Error(`unknown account: ${primaryId}`);
  const t = translator(lang);
  const others = accounts.filter((a) => a.id !== primary.id);
  const sel = selected || new Set(others.map((a) => a.id));
  const result = { primary, accounts: [], warnings: [], lang: t.lang };
  for (const account of others) {
    const tracked = manifestAccount(manifest, primary, account);
    const managed = new Map((tracked ? tracked.elements : []).map((e) => [e.name, e]));
    const ctx = { home, accounts, selected: sel, managed, managedNames: [...managed.keys()], t };
    const notes = [];
    const warnings = [];
    let elements;
    let extra = {};
    if (account.provider === primary.provider) {
      const servers = diffServers(primary, account, ctx, notes);
      elements = [...diffLinked(primary, account, ctx), ...servers.elements];
      extra = { mcp: servers.mcp };
    } else {
      const r = diffReplicated(primary, account, ctx, notes, warnings);
      elements = r.elements;
      extra = { skillsDir: r.skillsDir, skillsSource: r.skillsSource, mcp: r.mcp };
    }
    const exceptions = new Set(tracked ? tracked.exceptions : []);
    for (const e of elements) if (exceptions.has(e.name)) { e.exception = true; e.note = [e.note, t('exception')].filter(Boolean).join('; '); }
    // Where the account keeps its own instruction file, the primary's imports are not needed.
    const own = PROVIDERS[primary.provider].instruction;
    if (account.provider === primary.provider && own && exceptions.has(own)) {
      for (const e of elements) if (e.primaryImport && e.state === 'missing') { e.settled = true; e.note = t('importNotNeeded', { file: own }); }
    }
    result.accounts.push({ account, tracked, selected: sel.has(account.id), elements, notes, warnings, ...extra, ...summarize(primary, account, elements, tracked, t) });
    result.warnings.push(...warnings);
  }
  return result;
}

/** The signature of one MCP server: how it compares, what would be written, what is there. */
export function serverSignature(status, want, cur) {
  return sha256(canon([status, want || null, cur || null]));
}

/** The signature of a generated instruction file: the bytes to write, and the bytes there now. */
export function instructionSignature(want, here) {
  return `${want || '-'}|${here || '-'}`;
}

/**
 * A signature of an element's current state, so a stale plan is noticed before it is applied.
 * For a file or a folder it covers both sides, content included: see `signature`.
 */
export function elementSignature(e) {
  if (e.type === 'mcp') return serverSignature(e.status, e.want, e.cur);
  if (e.type === 'instruction') return instructionSignature(e.want, e.here);
  if (e.type === 'info' || e.state === 'linked') return e.state;
  return `${signature(e.P)}|${signature(e.S)}`;
}

/**
 * The same signature of a file or folder element, read from the disk NOW: what `apply` compares
 * with the plan right before it writes. An element the plan saw as linked must still be.
 */
export function liveSignature(e) {
  if (e.state === 'linked' && linkStatus(e.S, e.P).state === 'ok') return e.state;
  return `${signature(e.P)}|${signature(e.S)}`;
}

/**
 * The printed form. Per account: `sync` is exactly the schema's `accounts.list[].sync`;
 * `suggested` ('link' | 'replicate' | 'none') and `suggestionText` sit beside it.
 */
export function publicDiff(d) {
  const t = translator(d.lang);
  const el = (e) => (e.note ? { name: e.name, state: e.state, note: e.note } : { name: e.name, state: e.state });
  const summary = Object.fromEntries(STATES.map((s) => [s, 0]));
  const accounts = [{
    id: d.primary.id, provider: d.primary.provider, label: accountLabel(d.primary, d.lang), path: d.primary.path,
    sync: { mode: 'primary', status: 'ok', detail: t('detail.primary'), elements: [] },
    suggested: 'none', suggestionText: t('suggest.primary'),
  }];
  for (const a of d.accounts) {
    for (const e of a.elements) if (!e.forget) summary[e.state]++;
    const entry = {
      id: a.account.id, provider: a.account.provider, label: accountLabel(a.account, d.lang), path: a.account.path,
      sync: { mode: a.mode, status: a.status, detail: a.detail, elements: a.elements.filter((e) => !e.forget).map(el) },
      suggested: a.suggested, suggestionText: a.suggestionText,
    };
    if (a.notes.length) entry.notes = a.notes;
    accounts.push(entry);
  }
  const out = { primary: d.primary.id, accounts, summary };
  if (d.warnings.length) out.warnings = d.warnings;
  return out;
}
