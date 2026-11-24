// Registers (and removes) the session-start sync check in the PRIMARY account.
//
// The check script is copied to a stable place under the home directory so it survives the skill
// being fetched on demand. The hook entry is merged into the primary's settings.json (Claude
// Code) or hooks.json (Codex) with a surgical edit: every other byte of the file is kept. The
// file is replaced, never written in place: a link on it survives, its known other names follow,
// and a write that fails, or a process that dies, leaves it whole.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IS_WIN, homeDir, syncDir, manifestFile, stableCheckPath, displayPath, lstatSafe, readBuf, readText,
  parseJson, sha256, hashFile, mkdirp, writeKeepingLinks, writeAtomic, removeLink, readManifest,
  unknownNames, unknownNamesError,
} from '../../sync-check.mjs';
import { scanText } from '../../secret-scan.mjs';
import { detectAccounts } from './detect.mjs';
import { primaryFromManifest } from './diff.mjs';
import { Run, peerCandidates, pendingNote, leftNote } from './apply.mjs';
import { appendIn, removeIn, removeItem, makePatch, revertPatch } from './jsonedit.mjs';

const RECORD_VERSION = 1;
const SKILL_CHECK = fileURLToPath(new URL('../../sync-check.mjs', import.meta.url));
const STABLE_RE = /[\\/]\.novarc-powers[\\/]novarc-harness-doctor[\\/]sync[\\/]sync-check\.mjs/i;

function recordFile(home) { return path.join(syncDir(home), 'check-install.json'); }

export function hookCommand(home = homeDir()) {
  return `node "${stableCheckPath(home).replace(/\\/g, '/')}" --repair`;
}

/** Where each provider registers a session-start command, and the entry to add. */
function hookTarget(account, home) {
  const entry = { matcher: 'startup|resume', hooks: [{ type: 'command', command: hookCommand(home), timeout: 15 }] };
  if (account.provider === 'claude-code') return { file: path.join(account.pathAbs, 'settings.json'), entry };
  if (account.provider === 'codex') return { file: path.join(account.pathAbs, 'hooks.json'), entry, trust: 'Codex runs a hook only after you review and trust it: open /hooks in Codex once.' };
  return null;
}

function isOurCommand(command, home) {
  if (typeof command !== 'string') return false;
  const norm = (s) => { const x = s.replace(/\\/g, '/'); return IS_WIN ? x.toLowerCase() : x; };
  return norm(command).includes(norm(stableCheckPath(home))) || STABLE_RE.test(command);
}

/** Positions of our hook inside `hooks.SessionStart`: [{ group, hook, alone }]. */
function findHooks(value, home) {
  const out = [];
  const groups = value && value.hooks && typeof value.hooks === 'object' ? value.hooks.SessionStart : null;
  if (!Array.isArray(groups)) return out;
  groups.forEach((g, gi) => {
    const hooks = g && Array.isArray(g.hooks) ? g.hooks : [];
    hooks.forEach((h, hi) => { if (h && isOurCommand(h.command, home)) out.push({ group: gi, hook: hi, alone: hooks.length === 1 }); });
  });
  return out;
}

/** 'ok' when a SessionStart entry can be merged in, otherwise why not. */
function shapeProblem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'the file is not a JSON object';
  if (value.hooks !== undefined && (!value.hooks || typeof value.hooks !== 'object' || Array.isArray(value.hooks))) return '"hooks" is not an object';
  if (value.hooks && value.hooks.SessionStart !== undefined && !Array.isArray(value.hooks.SessionStart)) return '"hooks.SessionStart" is not a list';
  return null;
}

/** True when the session-start check is registered in that account. */
export function isCheckInstalled(account, home = homeDir()) {
  const t = account ? hookTarget(account, home) : null;
  if (!t) return false;
  const j = parseJson(readText(t.file));
  return j.ok && findHooks(j.value, home).length > 0;
}

function pickPrimary({ primaryId, home, env }) {
  const accounts = detectAccounts({ home, env });
  if (!primaryId) {
    const known = primaryFromManifest(readManifest(manifestFile(home)), accounts);
    return known ? { account: known, accounts } : { error: 'pass --primary <accountId>, or apply a plan first' };
  }
  const account = accounts.find((a) => a.id === primaryId);
  if (!account) return { error: `unknown account: ${primaryId}` };
  return { account, accounts };
}

/**
 * The hook file may have other names (where symbolic links are refused, a linked account's
 * settings.json is a hardlink to the primary's). Those the manifest records, or that sit at the
 * same place in another account, are switched over with it. Any other name is not this tool's to
 * detach: the file is then left alone and the count goes back to the user.
 */
function refuseUnknownNames(file, peers, home, base) {
  const n = unknownNames(file, { home, peers });
  if (!n) return null;
  return { code: 1, out: { ok: false, refused: true, ...base, file: displayPath(file, home), unknownNames: n, error: `${path.basename(file)}: ${unknownNamesError(n).message}` } };
}

function manualStep(account, home) {
  return `No hook was registered for ${account.label}. Make this command run when a session starts there: node "${displayPath(stableCheckPath(home), home)}" --repair (write the home directory in full).`;
}

export function installCheck({ primaryId, yes = false, home = homeDir(), env = process.env }) {
  if (!yes) return { code: 2, out: { ok: false, refused: true, error: 'install-check adds a hook that runs at every session start (a gate): pass --yes after the user approved it' } };
  const picked = pickPrimary({ primaryId, home, env });
  if (picked.error) return { code: 2, out: { ok: false, error: picked.error } };
  const account = picked.account;
  const notes = [];

  // 1. The script, at its stable place.
  const stable = stableCheckPath(home);
  if (hashFile(stable) !== hashFile(SKILL_CHECK)) writeAtomic(stable, fs.readFileSync(SKILL_CHECK));
  const base = { account: account.id, script: displayPath(stable, home) };

  // 2. The hook, in the primary account.
  const target = hookTarget(account, home);
  if (!target) return { code: 0, out: { ok: true, installed: false, ...base, manual: manualStep(account, home) } };
  const shown = displayPath(target.file, home);
  if (target.trust) notes.push(target.trust);
  const record = { version: RECORD_VERSION, account: account.id, provider: account.provider, file: target.file, installedAt: new Date().toISOString() };

  if (!lstatSafe(target.file)) {
    const text = JSON.stringify({ hooks: { SessionStart: [target.entry] } }, null, 2) + '\n';
    writeKeepingLinks(target.file, text, { home });
    writeAtomic(recordFile(home), JSON.stringify({ ...record, created: true, afterHash: sha256(Buffer.from(text, 'utf8')) }, null, 2) + '\n');
    return { code: 0, out: { ok: true, installed: true, changed: true, ...base, file: shown, backup: null, notes: [...notes, 'The file did not exist; it was created.'] } };
  }
  const buf = readBuf(target.file);
  const text = buf === null ? null : buf.toString('utf8');
  const parsed = parseJson(text);
  if (text === null || !Buffer.from(text, 'utf8').equals(buf) || !parsed.ok) {
    return { code: 1, out: { ok: false, refused: true, ...base, file: shown, error: `${path.basename(target.file)} is not valid JSON; nothing was written. Fix the file first.` } };
  }
  const problem = shapeProblem(parsed.value);
  if (problem) {
    if (account.provider === 'claude-code') return { code: 1, out: { ok: false, refused: true, ...base, file: shown, error: `${path.basename(target.file)} has an unexpected shape (${problem}); nothing was written.` } };
    return { code: 0, out: { ok: true, installed: false, ...base, file: shown, manual: manualStep(account, home), notes: [`${path.basename(target.file)} has a shape this tool does not recognise (${problem}); nothing was written.`] } };
  }
  if (findHooks(parsed.value, home).length) return { code: 0, out: { ok: true, installed: true, changed: false, ...base, file: shown, notes } };

  const run = new Run(home, account.id);
  run.accounts = picked.accounts;
  const refusal = refuseUnknownNames(target.file, run.peersOf(target.file), home, base);
  if (refusal) return refusal;

  // Backup first. A file that holds a secret is not copied: uninstall-check reverses the edit.
  let backup = null;
  if (scanText(text).length) notes.push('No backup copy was made: the file holds a secret. uninstall-check removes exactly what was added.');
  else {
    const b = run.backupPath(account.id, path.basename(target.file));
    mkdirp(path.dirname(b));
    fs.writeFileSync(b, buf);
    backup = displayPath(b, home);
  }
  const next = appendIn(text, ['hooks', 'SessionStart'], target.entry);
  const patch = makePatch(text, next);
  const afterHash = sha256(Buffer.from(next, 'utf8'));
  const edit = run.intend({ op: 'patch', path: target.file, beforeHash: sha256(buf), afterHash, patch });
  try { run.write(target.file, next, sha256(buf)); } catch (err) {
    run.unop(); // a failed write leaves the file as it was
    throw err;
  }
  run.did(edit);
  const check = parseJson(readText(target.file));
  if (!check.ok || !findHooks(check.value, home).length) {
    run.write(target.file, buf);
    run.unop();
    return { code: 1, out: { ok: false, ...base, file: shown, error: 'verification failed; the file was restored', ...(run.notes.length ? { notes: [...run.notes] } : {}) } };
  }
  run.journal.finishedAt = new Date().toISOString();
  run.save();
  writeAtomic(recordFile(home), JSON.stringify({ ...record, afterHash, patch }, null, 2) + '\n');
  // What the writes themselves had to say goes out with the result, read after the last of
  // them: another name of the file left alone because something else changed it meanwhile, or
  // one that could not be switched over yet.
  return { code: 0, out: { ok: true, installed: true, changed: true, ...base, file: shown, backup, stamp: run.stamp, notes: [...notes, ...run.notes] } };
}

export function uninstallCheck({ primaryId, yes = false, home = homeDir(), env = process.env }) {
  if (!yes) return { code: 2, out: { ok: false, refused: true, error: 'uninstall-check edits the primary account\'s hook file: pass --yes' } };
  const rec = parseJson(readText(recordFile(home)));
  const record = rec.ok && rec.value && rec.value.version === RECORD_VERSION ? rec.value : null;
  let file = record ? record.file : null;
  let accountId = record ? record.account : null;
  if (!file) {
    const picked = pickPrimary({ primaryId, home, env });
    if (picked.error) return { code: 2, out: { ok: false, error: picked.error } };
    const t = hookTarget(picked.account, home);
    file = t ? t.file : null;
    accountId = picked.account.id;
  }
  const out = { ok: true, account: accountId, changed: false };
  const buf = file ? readBuf(file) : null;
  if (buf !== null) {
    out.file = displayPath(file, home);
    const text = buf.toString('utf8');
    let next = null; // what the file should hold; null when nothing in it changes
    if (record && sha256(buf) === record.afterHash) {
      // Untouched since the install: restore the exact previous bytes.
      if (record.created) { removeLink(file); out.changed = true; } else next = revertPatch(text, record.patch);
    } else {
      const parsed = parseJson(text);
      if (!parsed.ok) return { code: 1, out: { ok: false, refused: true, file: out.file, error: `${path.basename(file)} is not valid JSON; nothing was written. Remove the sync-check entry by hand.` } };
      let edited = text;
      for (const h of findHooks(parsed.value, home).reverse()) {
        edited = h.alone ? removeItem(edited, ['hooks', 'SessionStart'], h.group) : removeItem(edited, ['hooks', 'SessionStart', h.group, 'hooks'], h.hook);
      }
      if (edited !== text) {
        const now = parseJson(edited).value;
        if (Array.isArray(now.hooks.SessionStart) && !now.hooks.SessionStart.length) {
          edited = removeIn(edited, ['hooks', 'SessionStart']);
          if (!Object.keys(parseJson(edited).value.hooks).length) edited = removeIn(edited, ['hooks']);
        }
        next = edited;
      }
    }
    if (next !== null) {
      const peers = peerCandidates(file, { manifests: [readManifest(manifestFile(home))], accounts: detectAccounts({ home, env }) });
      const refusal = refuseUnknownNames(file, peers, home, { account: accountId });
      if (refusal) return refusal;
      const r = writeKeepingLinks(file, next, { home, peers, expect: sha256(buf) });
      if (r.pending.length) out.notes = [pendingNote(file, r, home)];
      if (r.left) (out.notes ||= []).push(leftNote(file, r, home));
      out.changed = true;
    }
  }
  for (const f of [stableCheckPath(home), recordFile(home)]) if (lstatSafe(f)) { removeLink(f); out.removedScript = true; }
  return { code: 0, out };
}
