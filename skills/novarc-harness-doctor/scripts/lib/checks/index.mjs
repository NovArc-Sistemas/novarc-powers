// Registry of every harness check plus the defense detector.
// Each check is { id, round, severity, title, why, fix, run(model) } where run is pure and returns
// an array of findings or { skip: reason }.
import { hookBlocking } from '../snapshot/elements.mjs';
import { PERMISSION_CHECKS } from './permissions.mjs';
import { HOOK_CHECKS, withBlockingFields } from './hooks.mjs';
import { CONTENT_CHECKS } from './content.mjs';
import { TOOLING_CHECKS } from './tooling.mjs';
import { bySeverityThenId, parseRule, safeSnippet } from './util.mjs';

export const CHECKS = [...PERMISSION_CHECKS, ...HOOK_CHECKS, ...CONTENT_CHECKS, ...TOOLING_CHECKS];
export const CHECK_IDS = CHECKS.map((c) => c.id);

const SECRET_SCANNERS = /\b(gitleaks|trufflehog|detect-secrets|git-secrets|secretlint|ggshield|talisman|secret-scan)\b/i;

/** Protections already in place. Never findings; the board shows them as what is fine. */
export function detectDefenses(model) {
  const out = [];
  for (const s of model.settings) {
    if (s.pseudo) continue;
    const deny = s.json.permissions && Array.isArray(s.json.permissions.deny) ? s.json.permissions.deny : [];
    if (deny.length) {
      const tools = [...new Set(deny.map((r) => parseRule(r).tool))].sort();
      out.push({ scope: s.scope, title: 'Deny rules', detail: `${s.display}: ${deny.length} deny rule(s) on ${safeSnippet(tools.join(', '), model.projectRoot, 80)}` });
    }
    if (s.json.sandbox && typeof s.json.sandbox === 'object' && s.json.sandbox.enabled === true) {
      out.push({ scope: s.scope, title: 'Sandbox enabled', detail: `${s.display}: sandbox.enabled is true` });
    }
    const ask = s.json.permissions && Array.isArray(s.json.permissions.ask) ? s.json.permissions.ask : [];
    if (ask.length) out.push({ scope: s.scope, title: 'Ask rules', detail: `${s.display}: ${ask.length} ask rule(s)` });
  }
  for (const h of model.hooks) {
    // A defense only when the hook can really stop the tool call, by the test the snapshot uses
    // (hookBlocking in snapshot/elements.mjs, from https://code.claude.com/docs/en/hooks, read on
    // 2026-11-23): exit status 2 unless the command throws its status away, a printed deny, ask
    // or block decision, or `onFailure: "block"` ("a failure does what exit code 2 does on that
    // event"); never a background hook ("Async hooks can't block or control Claude's behavior").
    if (h.event !== 'PreToolUse' || hookBlocking(withBlockingFields(h)) !== true) continue;
    out.push({ scope: h.scope, title: 'Blocking PreToolUse hook', detail: `${h.display}: matcher ${h.matcher ? safeSnippet(h.matcher, model.projectRoot, 40) : '(all tools)'}${h.scriptDisplay ? `, script ${h.scriptDisplay}` : ''}` });
  }
  for (const g of model.gitHookTexts) {
    const m = SECRET_SCANNERS.exec(g.text);
    if (m) out.push({ scope: 'project', title: 'Secret scan before commit', detail: `${g.display}: runs ${m[1]}` });
  }
  return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.title.localeCompare(b.title) || a.detail.localeCompare(b.detail));
}

/** Run the selected checks over a model. */
export function runChecks(model, only = null) {
  const checks = [];
  const skipped = [];
  for (const c of CHECKS) {
    if (only && !only.includes(c.id)) continue;
    let res;
    try { res = c.run(model); } catch (e) { skipped.push({ id: c.id, reason: `check failed: ${e && e.name ? e.name : 'error'}` }); continue; }
    if (res && !Array.isArray(res) && res.skip) { skipped.push({ id: c.id, reason: res.skip }); continue; }
    checks.push(...res);
  }
  // The same file can be reached through two config dirs; report each finding once.
  const seen = new Set();
  const unique = checks.filter((f) => {
    const k = `${f.id}|${f.file}|${f.line}|${f.evidence}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort(bySeverityThenId);
  const defenses = detectDefenses(model).filter((d) => {
    const k = `defense|${d.scope}|${d.title}|${d.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { checks: unique, defenses, skipped };
}
