// Register / unregister the update-check hook as a Claude Code SessionStart
// command hook. The settings file is parsed, mutated and re-serialised; an
// invalid JSON file is never written.
import { readTextOrNull } from './fsutil.js';

export const HOOK_MARKER = '.novarc-powers/hooks/check-update.js';

/** Shell command stored in settings.json. Forward slashes survive JSON and Git Bash. */
export function hookCommand(hookPath) {
  return `node "${hookPath.replace(/\\/g, '/')}"`;
}

function isOurs(hook) {
  return (
    hook &&
    typeof hook === 'object' &&
    typeof hook.command === 'string' &&
    hook.command.replace(/\\/g, '/').includes(HOOK_MARKER)
  );
}

/** Parse settings text. Returns `{ok:true, data}` or `{ok:false}` for invalid JSON. */
export function parseSettings(text) {
  if (text == null || /^\s*$/.test(text)) return { ok: true, data: {} };
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false };
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}

function serialise(data, original) {
  const indentMatch = original && original.match(/^\{\r?\n([ \t]+)"/);
  const indent = indentMatch ? indentMatch[1] : 2;
  const eol = original && original.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(data, null, indent).replace(/\n/g, eol) + eol;
}

/**
 * Return `{status, text}`: status is 'invalid', 'unchanged' or 'changed'.
 * `text` is the new file content when changed.
 */
export function addHook(original, command) {
  const parsed = parseSettings(original);
  if (!parsed.ok) return { status: 'invalid' };
  const data = parsed.data;
  if (data.hooks !== undefined && (typeof data.hooks !== 'object' || data.hooks === null || Array.isArray(data.hooks))) {
    return { status: 'invalid' };
  }
  data.hooks = data.hooks || {};
  const groups = data.hooks.SessionStart;
  if (groups !== undefined && !Array.isArray(groups)) return { status: 'invalid' };
  const list = groups || [];
  let found = false;
  let changed = false;
  for (const g of list) {
    if (!g || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) {
      if (!isOurs(h)) continue;
      if (found) continue;
      found = true;
      if (h.command !== command || h.type !== 'command') {
        h.type = 'command';
        h.command = command;
        changed = true;
      }
    }
  }
  if (!found) {
    list.push({ hooks: [{ type: 'command', command }] });
    changed = true;
  }
  data.hooks.SessionStart = list;
  if (!changed) return { status: 'unchanged' };
  return { status: 'changed', text: serialise(data, original) };
}

/** Remove every hook of ours; empty groups / keys this removal leaves behind go too. */
export function removeHook(original) {
  if (original == null) return { status: 'unchanged' };
  const parsed = parseSettings(original);
  if (!parsed.ok) return { status: 'invalid' };
  const data = parsed.data;
  const groups = data.hooks && Array.isArray(data.hooks.SessionStart) ? data.hooks.SessionStart : null;
  if (!groups) return { status: 'unchanged' };
  let changed = false;
  const kept = [];
  for (const g of groups) {
    if (!g || !Array.isArray(g.hooks)) {
      kept.push(g);
      continue;
    }
    const remaining = g.hooks.filter((h) => !isOurs(h));
    if (remaining.length !== g.hooks.length) changed = true;
    if (remaining.length) kept.push({ ...g, hooks: remaining });
    else if (remaining.length === g.hooks.length) kept.push(g);
  }
  if (!changed) return { status: 'unchanged' };
  if (kept.length) data.hooks.SessionStart = kept;
  else delete data.hooks.SessionStart;
  if (Object.keys(data.hooks).length === 0) delete data.hooks;
  return { status: 'changed', text: serialise(data, original) };
}

export function hasHook(file) {
  const parsed = parseSettings(readTextOrNull(file));
  if (!parsed.ok) return false;
  const groups = parsed.data.hooks && parsed.data.hooks.SessionStart;
  return Array.isArray(groups) && groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some(isOurs));
}
