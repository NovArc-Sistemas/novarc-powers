// Checks on hook commands (and the scripts they run, when readable).
import { finding, lineOfJsonString, safeSnippet } from './util.mjs';

const ALLOW_RE = /["']?\b(permissionDecision|decision|behavior)\b["']?\s*[:=]\s*\\?["']?(allow|approve)\b/i;
const CONDITIONAL_RE = /\b(if|elif|case|switch|when|unless|match)\b|&&|\|\||\?[^:\n]*:|\bgrep\b|\bselect\(|\btest\s|\[\[|\[\s|\bfilter\(|\bincludes\(|\bstartsWith\(|\.test\(/;
const SWALLOW_RE = /\|\|\s*(true\b|:(?=\s|;|\)|$)|exit\s+0\b)|2>\s*\/dev\/null|&>\s*\/dev\/null|>\s*\/dev\/null\s+2>&1|2>\s*\$null|\|\s*Out-Null\b|-ErrorAction\s+(SilentlyContinue|Ignore)\b|2>\s*nul\b/i;
const EXPENSIVE_RE = /\b(tsc|eslint|prettier|jest|vitest|pytest|mypy|pyright|webpack|rollup|next\s+build|vite\s+build|cargo\s+(build|test|check|clippy)|go\s+(build|test|vet)|mvn|gradlew?|dotnet\s+(build|test)|(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck|type-check|check))\b/i;

const hookText = (h) => `${h.command || ''}\n${h.scriptText || ''}`;
const where = (h) => ({ ...h, line: h.command ? lineOfJsonString(h.text, h.command) : null });

export const hookAutoAllow = {
  id: 'hook-auto-allow', round: 1, severity: 'high',
  title: 'Hook approves tool calls unconditionally',
  why: 'A hook that answers allow skips the permission prompt for every call it sees, so the allow and ask rules you wrote stop mattering for that tool.',
  fix: 'Make the hook return allow only for the exact cases it checks, and let everything else fall through to the normal permission rules.',
  run(model) {
    const out = [];
    for (const h of model.hooks) {
      if (h.type !== 'command' || !h.command) continue;
      const text = hookText(h);
      if (!ALLOW_RE.test(text)) continue;
      const src = h.scriptDisplay ? ` (script ${h.scriptDisplay})` : '';
      const ev = `${h.event}${h.matcher ? ` [${safeSnippet(h.matcher, model.projectRoot, 40)}]` : ''}: ${safeSnippet(h.command, model.projectRoot, 120)}${src}`;
      if (/updatedInput/.test(text)) {
        out.push(finding(this, where(h), ev, {
          severity: 'medium', title: 'Hook approves tool calls after rewriting their input',
          why: 'A hook that rewrites a command and answers allow runs the rewritten command without a prompt, so check that deny and ask rules still see it.',
          fix: 'Keep the rewrite, but return allow only when the original command was already allowed, or return no decision and let the permission rules decide.',
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

export const HOOK_CHECKS = [hookAutoAllow, hookSwallowsErrors, hookExpensiveUnscoped];
