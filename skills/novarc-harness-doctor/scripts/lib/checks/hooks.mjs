// Checks on hook commands (and the scripts they run, when readable).
//
// What a hook's output and exit status do comes from the Claude Code hooks reference
// (https://code.claude.com/docs/en/hooks, read on 2026-11-23). The sentence each rule relies on is
// quoted next to it; re-read the page before changing one. Whether a hook can block is never
// decided here: hookBlocking in snapshot/elements.mjs is the one implementation of that.
import { parseJsonSafe } from '../common.mjs';
import { hookBlocking } from '../snapshot/elements.mjs';
import { finding, lineOfJsonString, safeSnippet } from './util.mjs';

// `name: value` as JSON, jq, JavaScript or Python write it, quotes escaped or not. The guard in
// front keeps `decision` from matching inside `permissionDecision`.
const field = (name, values) => new RegExp(`(?<![A-Za-z0-9_])${name}\\\\?["']?\\s*[:=]\\s*\\\\?["']?(?:${values})\\b`, 'i');
const either = (...res) => new RegExp(res.map((r) => r.source).join('|'), 'i');

// The two events whose hooks can approve a tool call, and the output that does it:
//   PreToolUse: hookSpecificOutput.permissionDecision, where "`"allow"` skips the permission
//     prompt, except for actions no mode auto-approves and reads from network paths". Its
//     top-level `decision` is deprecated but still read: "The deprecated values `"approve"` and
//     `"block"` map to `"allow"` and `"deny"` respectively."
//   PermissionRequest: hookSpecificOutput.decision.behavior, where "`"allow"` grants the
//     permission".
// A top-level `decision: "allow"` approves nothing: "The only value for `decision` is `"block"`."
const APPROVES = {
  PreToolUse: either(field('permissionDecision', 'allow'), field('decision', 'approve')),
  PermissionRequest: field('behavior', 'allow'),
};
const CONDITIONAL_RE = /\b(if|elif|case|switch|when|unless|match)\b|&&|\|\||\?[^:\n]*:|\bgrep\b|\bselect\(|\btest\s|\[\[|\[\s|\bfilter\(|\bincludes\(|\bstartsWith\(|\.test\(/;
const SWALLOW_RE = /\|\|\s*(true\b|:(?=\s|;|\)|$)|exit\s+0\b)|2>\s*\/dev\/null|&>\s*\/dev\/null|>\s*\/dev\/null\s+2>&1|2>\s*\$null|\|\s*Out-Null\b|-ErrorAction\s+(SilentlyContinue|Ignore)\b|2>\s*nul\b/i;
const EXPENSIVE_RE = /\b(tsc|eslint|prettier|jest|vitest|pytest|mypy|pyright|webpack|rollup|next\s+build|vite\s+build|cargo\s+(build|test|check|clippy)|go\s+(build|test|vet)|mvn|gradlew?|dotnet\s+(build|test)|(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck|type-check|check))\b/i;

// Signs that a hook means to refuse something: a refusal written to stderr right before the exit,
// or a script named for the job. Both are narrow on purpose (hook-policy-exit-1 in checks.md).
const EXIT_1_RE = /\bexit\s+1\b|exit\(1\)|exitCode\s*=\s*1\b/i;
const STDERR_RE = />&\s*2\b|\/dev\/stderr|console\.error\(|process\.stderr|sys\.stderr|\bWrite-Error\b|\[Console\]::Error|\$stderr|\bSTDERR\b/;
const REFUSAL_RE = /(?<!non[- ])\b(?:block(?:ed|ing|s)?|den(?:y|ied|ies|ying)|forbid(?:den|s)?|refus(?:e|ed|es|ing)|reject(?:ed|s|ing)?|disallow(?:ed|s)?|prohibit(?:ed|s)?|not\s+(?:allowed|permitted))\b/i;
const policyName = (base) => /(?:^|[^a-z])(?:block|deny|guard|forbid)/.test(base.toLowerCase()) || /[a-z](?:Block|Deny|Guard|Forbid)/.test(base);

const hookText = (h) => `${h.command || ''}\n${h.scriptText || ''}`;
const where = (h) => ({ ...h, line: h.command ? lineOfJsonString(h.text, h.command) : null });
const label = (h, model) => `${h.event}${h.matcher ? ` [${safeSnippet(h.matcher, model.projectRoot, 40)}]` : ''}: ${safeSnippet(h.command, model.projectRoot, 120)}${h.scriptDisplay ? ` (script ${h.scriptDisplay})` : ''}`;
// "Async hooks can't block or control Claude's behavior: response fields like `decision`,
// `permissionDecision`, and `continue` have no effect". asyncRewake also "runs in the background".
const background = (h) => h.async === true || h.asyncRewake === true;

let memoText = null;
let memoHooks = null;
/** The `hooks` object of a registration file's text (the last file read is kept). */
function registeredHooks(text) {
  if (text === memoText) return memoHooks;
  const r = parseJsonSafe(text);
  const j = r.ok && r.value && typeof r.value === 'object' ? r.value : null;
  memoText = text;
  memoHooks = j ? (j.hooks && typeof j.hooks === 'object' ? j.hooks : j) : null;
  return memoHooks;
}

/**
 * A model hook together with the `async`, `asyncRewake` and `onFailure` fields of its
 * registration, which decide whether it can block or approve anything (hookBlocking reads them).
 * hookEntries() in collect.mjs keeps event, matcher, type and command only, so the three fields
 * are read back from the text of the file the hook is registered in, which every model hook
 * carries. A hook that already has one of them is returned as it is: once the collector forwards
 * the fields, everything below the first line can go.
 */
export function withBlockingFields(h) {
  if ('async' in h || 'asyncRewake' in h || 'onFailure' in h) return h;
  const hooks = typeof h.text === 'string' ? registeredHooks(h.text) : null;
  const groups = hooks && Array.isArray(hooks[h.event]) ? hooks[h.event] : [];
  const same = [];
  for (const g of groups) {
    if (!g || typeof g !== 'object' || (typeof g.matcher === 'string' ? g.matcher : '') !== (h.matcher || '')) continue;
    for (const r of Array.isArray(g.hooks) ? g.hooks : (g.command || g.type ? [g] : [])) {
      if (r && typeof r === 'object' && (r.type || 'command') === h.type && (typeof r.command === 'string' ? r.command : '') === (h.command || '')) same.push(r);
    }
  }
  // The same command registered twice: the copy that runs in the foreground is the one that decides.
  const reg = same.find((r) => !background(r)) || same[0];
  if (!reg) return h;
  return { ...h, async: reg.async === true, asyncRewake: reg.asyncRewake === true, onFailure: typeof reg.onFailure === 'string' ? reg.onFailure : undefined };
}

export const hookAutoAllow = {
  id: 'hook-auto-allow', round: 1, severity: 'high',
  title: 'Hook approves tool calls unconditionally',
  // "Deny and ask rules are still evaluated regardless of what the hook returns" (PreToolUse);
  // "The hook can't approve what a deny rule refuses" (PermissionRequest). What an allow removes
  // is the prompt, for everything those rules do not name.
  why: 'An unconditional allow from a hook skips the permission prompt for every call the hook sees that no deny or ask rule covers, so those calls run with nobody reviewing them.',
  fix: 'Return allow only for the exact calls the hook has checked and print no decision for the rest, so they go through the normal permission rules and prompt.',
  run(model) {
    const out = [];
    for (const raw of model.hooks) {
      const approves = APPROVES[raw.event];
      if (!approves || raw.type !== 'command' || !raw.command) continue;
      const h = withBlockingFields(raw);
      if (background(h)) continue;
      const text = hookText(h);
      if (!approves.test(text)) continue;
      const ev = label(h, model);
      if (/updatedInput/.test(text)) {
        // PreToolUse: "Claude Code evaluates permission rules ... against the input your hook
        // returns, not the input Claude sent. Combine with `"allow"` to auto-approve, or `"ask"`
        // to show the modified input to the user." PermissionRequest: "The modified input is
        // re-evaluated against deny and ask rules."
        out.push(finding(this, where(h), ev, {
          severity: 'medium', title: 'Hook approves tool calls after rewriting their input',
          why: 'Deny and ask rules are checked against the rewritten input, but the allow means the rewritten call runs without ever being shown to the user.',
          fix: 'Keep the rewrite and answer ask instead of allow where the event has it (PreToolUse), so the rewritten input is shown before it runs, or allow only the exact rewrites the hook has checked.',
        }));
      } else if (!CONDITIONAL_RE.test(text)) out.push(finding(this, where(h), ev));
    }
    return out;
  },
};

export const hookSwallowsErrors = {
  id: 'hook-swallows-errors', round: 1, severity: 'medium',
  title: 'Hook command hides its own failures',
  why: 'When a hook silences errors, a broken gate looks exactly like a passing one and nobody finds out until the damage it was meant to stop happens.',
  fix: 'Remove the error suppression, or log the failure to a file the user reads, so a failing hook is visible.',
  run(model) {
    const out = [];
    for (const h of model.hooks) {
      if (h.type !== 'command' || !h.command) continue;
      const m = SWALLOW_RE.exec(h.command);
      if (!m) continue;
      out.push(finding(this, where(h), `${h.event}: "${safeSnippet(m[0], model.projectRoot, 40)}" in ${safeSnippet(h.command, model.projectRoot, 120)}`));
    }
    return out;
  },
};

export const hookExpensiveUnscoped = {
  id: 'hook-expensive-unscoped', round: 4, severity: 'medium',
  title: 'Slow build or test step runs on every edit',
  why: 'A type check, linter or test suite on every Edit or Write adds its full run time to each edit, and on a large repo the agent spends most of its turn waiting.',
  fix: 'Scope the hook to the files it checks (filter by path or extension inside the hook), run only the affected files, or move the full run to a Stop or pre-commit gate.',
  run(model) {
    const out = [];
    for (const h of model.hooks) {
      if (h.type !== 'command' || !h.command) continue;
      if (h.event !== 'PreToolUse' && h.event !== 'PostToolUse') continue;
      const matcher = (h.matcher || '').trim();
      if (!(matcher === '' || matcher === '*' || /Edit|Write/.test(matcher))) continue;
      const m = EXPENSIVE_RE.exec(hookText(h));
      if (!m) continue;
      out.push(finding(this, where(h), `${h.event} [${matcher || 'all tools'}] runs "${safeSnippet(m[0], model.projectRoot, 40)}"${h.scriptDisplay ? ` via ${h.scriptDisplay}` : ''}`));
    }
    return out;
  },
};

/** The line where a hook writes a refusal to stderr and exits 1 on it or within three lines, or null. */
function refusalThenExit1(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (STDERR_RE.test(lines[i]) && REFUSAL_RE.test(lines[i]) && EXIT_1_RE.test(lines.slice(i, i + 4).join('\n'))) return lines[i].trim();
  }
  return null;
}

export const hookPolicyExit1 = {
  id: 'hook-policy-exit-1', round: 4, severity: 'medium',
  title: 'Policy hook refuses with exit code 1, which blocks nothing',
  // "Exit code 1 without valid JSON output is a non-blocking error unless the hook is one whose
  // failure blocks the action, even though 1 is the conventional Unix failure code. If your hook
  // is meant to enforce a policy, use `exit 2`."
  why: 'Exit code 1 from a hook is a non-blocking error, so the hook prints its refusal and the action it was meant to stop goes ahead anyway.',
  fix: 'Exit with code 2 where the hook refuses, or print the blocking decision as JSON and exit 0, then prove it with a call the hook must stop.',
  run(model) {
    const out = [];
    for (const raw of model.hooks) {
      // The contract quoted above is Claude Code's; a Codex hooks.json is not judged by it.
      if (raw.agent === 'codex' || raw.type !== 'command' || !raw.command) continue;
      const h = withBlockingFields(raw);
      // false: everything the hook runs was read and nothing in it blocks (no exit 2 that
      // survives, no JSON decision, no onFailure "block"). true: it blocks already. null: part
      // of it could not be read, so nothing is claimed.
      if (hookBlocking(h) !== false) continue;
      // Asked of hookBlocking instead of copying its tables: would this registration block if
      // its script exited 2 (an event exit 2 blocks on, a foreground hook, a command that keeps
      // its exit status), and is exit 1 not enough there (a worktree hook fails on any status)?
      if (hookBlocking({ ...h, scriptText: 'exit 2' }) !== true || hookBlocking({ ...h, scriptText: 'exit 1' }) !== false) continue;
      const text = hookText(h);
      const line = refusalThenExit1(text);
      const named = !line && h.scriptDisplay && policyName(h.scriptDisplay.split(/[\\/]/).pop()) && EXIT_1_RE.test(text);
      if (!line && !named) continue;
      const how = line ? `exits 1 after "${safeSnippet(line, model.projectRoot, 80)}"` : 'is named like a policy and has "exit 1", no exit 2 and no JSON decision';
      out.push(finding(this, where(h), `${label(h, model)} ${how}`));
    }
    return out;
  },
};

export const HOOK_CHECKS = [hookAutoAllow, hookSwallowsErrors, hookExpensiveUnscoped, hookPolicyExit1];
