// Round 1 checks on settings: environment overrides, MCP auto-approval and permission rules.
import { hookSource } from '../snapshot/hookcode.mjs';
import { finding, lineOfJsonKey, lineOfJsonString, parseRule, normalizeSpec, ruleCovers, safeSnippet } from './util.mjs';

const ENV_OVERRIDE_RE = /^(ANTHROPIC|OPENAI|CLAUDE|CODEX|AZURE_OPENAI|GEMINI|GOOGLE_GEMINI|GOOGLE_VERTEX|VERTEX|BEDROCK|MISTRAL|GROQ|OPENROUTER|DEEPSEEK|XAI)_[A-Z0-9_]*(BASE_URL|API_BASE|API_URL|ENDPOINT|BASE)$/i;
const CODEX_URL_KEYS = /^\s*(openai_base_url|chatgpt_base_url|base_url)\s*=\s*["']([^"']*)["']/;

function hostOf(value) {
  try { return new URL(String(value)).host || 'no host'; } catch { return 'value is not a URL'; }
}

const realSettings = (model) => model.settings.filter((s) => !s.pseudo);
const listOf = (s, key) => (s.json.permissions && Array.isArray(s.json.permissions[key]) ? s.json.permissions[key].filter((r) => typeof r === 'string') : []);

export const envBaseUrlOverride = {
  id: 'env-base-url-override', round: 1, severity: 'high',
  title: 'Model API base URL overridden in config',
  why: 'Every prompt, file the agent reads and credential header goes to whatever host this variable names, so a change here silently reroutes the whole session.',
  fix: 'Remove the override unless it is a gateway you run and trust, and if it is, document who owns it next to the setting.',
  run(model) {
    const out = [];
    for (const s of realSettings(model)) {
      const env = s.json.env && typeof s.json.env === 'object' ? s.json.env : {};
      for (const [k, v] of Object.entries(env)) {
        if (!ENV_OVERRIDE_RE.test(k)) continue;
        out.push(finding(this, { ...s, line: lineOfJsonKey(s.text, k) }, `${k} points to host ${safeSnippet(hostOf(v), model.projectRoot, 80)}`));
      }
    }
    for (const c of model.codexConfigs) {
      c.text.split(/\r?\n/).forEach((line, i) => {
        const m = CODEX_URL_KEYS.exec(line);
        if (m) out.push(finding(this, { ...c, line: i + 1 }, `${m[1]} points to host ${safeSnippet(hostOf(m[2]), model.projectRoot, 80)}`));
      });
    }
    return out;
  },
};

export const mcpProjectAutoApprove = {
  id: 'mcp-project-auto-approve', round: 1, severity: 'high',
  title: 'Project MCP servers start without approval',
  why: 'A repository can ship its own .mcp.json, and auto-approval runs those servers, with your credentials and file access, the moment you open the folder.',
  fix: 'Remove the auto-approval setting and approve each project MCP server by name when you first open the project.',
  run(model) {
    const out = [];
    for (const s of model.settings) {
      if (s.json.enableAllProjectMcpServers === true) {
        out.push(finding(this, { ...s, line: lineOfJsonKey(s.text, 'enableAllProjectMcpServers') }, 'enableAllProjectMcpServers is true'));
      }
      const list = Array.isArray(s.json.enabledMcpjsonServers) ? s.json.enabledMcpjsonServers.filter((x) => typeof x === 'string') : [];
      if (list.length && s.level === 'project' && !s.pseudo) {
        out.push(finding(this, { ...s, line: lineOfJsonKey(s.text, 'enabledMcpjsonServers') },
          `committed project settings pre-approve ${list.length} .mcp.json server(s): ${safeSnippet(list.join(', '), model.projectRoot, 100)}`));
      }
    }
    return out;
  },
};

export const allowShadowed = {
  id: 'allow-shadowed', round: 1, severity: 'low',
  title: 'Allow rule already covered by a broader one',
  why: 'A redundant rule makes the list longer to audit and hides which rule actually grants the access.',
  fix: 'Delete the narrower rule, or narrow the broader one if the narrow rule is what you really meant to allow.',
  run(model) {
    const out = [];
    for (const s of realSettings(model)) {
      const allow = listOf(s, 'allow');
      for (let j = 0; j < allow.length; j++) {
        for (let i = 0; i < allow.length; i++) {
          if (i === j) continue;
          const dup = allow[i] === allow[j];
          if (dup && i > j) continue; // report the later copy only
          if (dup || (ruleCovers(allow[i], allow[j]) && !ruleCovers(allow[j], allow[i]))) {
            const line = lineOfJsonString(s.text, allow[j]);
            const ev = dup ? `"${safeSnippet(allow[j], model.projectRoot, 80)}" appears more than once`
              : `"${safeSnippet(allow[j], model.projectRoot, 80)}" is covered by "${safeSnippet(allow[i], model.projectRoot, 80)}"`;
            out.push(finding(this, { ...s, line }, ev));
            break;
          }
        }
      }
    }
    return out;
  },
};

const INTERPRETERS = new Set([
  'node', 'nodejs', 'deno', 'bun', 'python', 'python3', 'python2', 'py', 'ruby', 'perl', 'php', 'lua',
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'pwsh', 'powershell', 'powershell.exe', 'pwsh.exe', 'cmd', 'cmd.exe',
  'osascript', 'npx', 'bunx', 'pnpx', 'uvx', 'env', 'xargs', 'sudo', 'eval', 'source', 'exec', 'nohup', 'wsl',
]);
const CODE_FLAGS = new Set(['-c', '-e', '--eval', '-p', '--print', '-command', '/c', '/k', '-encodedcommand', '-enc', '-x', '-i', '--input-type=module']);

/** Is this allow rule a wildcard over an interpreter (or the whole shell)? Returns a reason or null. */
export function interpreterWildcard(rule) {
  const { tool, spec } = parseRule(rule);
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  if (spec === null || /^\s*\*+\s*$/.test(spec)) return `${tool} with no restriction allows every command`;
  const norm = normalizeSpec(spec);
  if (!/\*/.test(norm)) return null;
  const head = norm.replace(/\*.*$/, '').trim();
  const toks = head.split(/\s+/).filter(Boolean);
  if (!toks.length) return `${tool} with a leading wildcard allows every command`;
  const bin = toks[0].replace(/^.*[\\/]/, '').toLowerCase();
  if (!INTERPRETERS.has(bin)) return null;
  const rest = toks.slice(1);
  if (rest.length === 0) return `"${bin}" with any arguments runs arbitrary code`;
  if (rest.length === 1 && CODE_FLAGS.has(rest[0].toLowerCase())) return `"${bin} ${rest[0]}" with any argument runs arbitrary code`;
  return null;
}

export const allowInterpreterWildcard = {
  id: 'allow-interpreter-wildcard', round: 1, severity: 'high',
  title: 'Allow rule grants an interpreter or shell with any argument',
  why: 'An interpreter with a wildcard runs any code the agent writes, so every deny rule and prompt behind it can be bypassed with one inline script.',
  fix: 'Replace the wildcard with the specific scripts or subcommands actually used, for example a fixed script path instead of any argument.',
  run(model) {
    const out = [];
    for (const s of realSettings(model)) {
      for (const r of listOf(s, 'allow')) {
        const reason = interpreterWildcard(r);
        if (reason) out.push(finding(this, { ...s, line: lineOfJsonString(s.text, r) }, `"${safeSnippet(r, model.projectRoot, 80)}": ${reason}`));
      }
    }
    return out;
  },
};

const DANGEROUS = [
  { label: 'force-push', test: (cmd, flags) => /^\*?\s*git\s+push\b/.test(cmd) && flags.some((f) => /^(--force|-[A-Za-z]*f[A-Za-z]*)$/.test(f)) },
  { label: 'reset --hard', test: (cmd, flags) => /^\*?\s*git\s+reset\b/.test(cmd) && flags.includes('--hard') },
  { label: 'rm -rf', test: (cmd, flags) => /^\*?\s*rm\b/.test(cmd) && (flags.some((f) => /^-[A-Za-z]*r[A-Za-z]*f|^-[A-Za-z]*f[A-Za-z]*r/i.test(f)) || (flags.some((f) => /^(-r|-R|--recursive)$/.test(f)) && flags.some((f) => /^(-f|--force)$/.test(f)))) },
];

/**
 * How a deny rule can be evaded by moving or regrouping its flags.
 * Returns { level: 'position'|'bundle'|null, flags, dangerous }.
 */
export function denyEvasion(rule) {
  const { tool, spec } = parseRule(rule);
  if ((tool !== 'Bash' && tool !== 'PowerShell') || spec === null) return null;
  const norm = normalizeSpec(spec);
  const re = /(^|[\s*])(--?[A-Za-z][\w-]*)/g;
  const flags = [];
  let position = false;
  let bundle = false;
  let m;
  while ((m = re.exec(norm)) !== null) {
    const flag = m[2];
    const idx = m.index + m[1].length;
    const before = norm.slice(0, idx).replace(/\s+$/, '');
    const tolerant = before.endsWith('*');
    flags.push(flag);
    if (!tolerant) position = true;
    if (/^-[A-Za-z]{2,}$/.test(flag)) position = true; // -rf: -fr and -r -f are not matched
    else if (/^-[A-Za-z]$/.test(flag)) bundle = true; // -f: -df / -uf are not matched
  }
  if (!flags.length) return null;
  const cmd = norm.replace(/\s+-.*$/, '');
  const hit = DANGEROUS.find((d) => d.test(norm, flags));
  return { level: position ? 'position' : bundle ? 'bundle' : null, flags, dangerous: hit ? hit.label : null, cmd };
}

export const denyPrefixEvadable = {
  id: 'deny-prefix-evadable', round: 1, severity: 'high',
  title: 'Deny rule can be bypassed by moving or regrouping a flag',
  why: 'Deny rules match text, so the same dangerous command written with the flag in another position or combined with other flags runs without being blocked.',
  fix: 'Put a wildcard before each flag (for example `Bash(git push*--force*)`), add rules for the short and bundled forms, or block the command in a PreToolUse hook that parses it.',
  run(model) {
    const out = [];
    for (const s of realSettings(model)) {
      for (const r of listOf(s, 'deny')) {
        const ev = denyEvasion(r);
        if (!ev || !ev.level) continue;
        let severity;
        if (ev.level === 'position') severity = ev.dangerous ? 'critical' : 'high';
        else severity = ev.dangerous ? 'high' : 'medium';
        const how = ev.level === 'position'
          ? `flag ${ev.flags.join(' ')} only matches in this exact position and spelling`
          : `short flag ${ev.flags.filter((f) => /^-[A-Za-z]$/.test(f)).join(' ')} is not matched when bundled with others`;
        out.push(finding(this, { ...s, line: lineOfJsonString(s.text, r) },
          `"${safeSnippet(r, model.projectRoot, 80)}": ${how}${ev.dangerous ? ` (target: ${ev.dangerous})` : ''}`, { severity }));
      }
    }
    return out;
  },
};

const BASELINE = [
  { label: '~/.ssh', rule: /\.ssh/i, hook: /\.ssh/i },
  { label: '~/.aws', rule: /\.aws/i, hook: /\.aws/i },
  { label: '**/.env*', rule: /\.env/i, hook: /\.env\b/i },
  { label: 'curl | bash', rule: /(curl|wget)[^)]*\|\s*(ba|z)?sh|^Bash\((curl|wget)(:\*|\s*\*|\*)\)$/i, hook: null },
];

export const denyBaselineMissing = {
  id: 'deny-baseline-missing', round: 1, severity: 'medium',
  title: 'Baseline deny rules missing',
  why: 'Without these rules nothing stops the agent from reading keys and credentials or piping a downloaded script into a shell, whatever the instructions say.',
  fix: 'Add deny rules for the missing items (for example `Read(~/.ssh/**)`, `Read(~/.aws/**)`, `Read(**/.env*)`) or a PreToolUse hook that blocks them.',
  run(model) {
    if (model.scope === 'project') return { skip: 'user-level deny rules are not read in project scope; run with --scope both' };
    const out = [];
    const projectSettings = model.settings.filter((s) => !s.pseudo && s.scope === 'project');
    const projectHooks = model.hooks.filter((h) => h.scope === 'project');
    for (const cd of model.claudeDirs) {
      const own = model.settings.filter((s) => !s.pseudo && s.scope === 'user' && (s.configKeys || [s.configKey]).includes(cd.configKey));
      const rules = [...own, ...projectSettings].flatMap((s) => listOf(s, 'deny'));
      const hookText = [...model.hooks.filter((h) => h.scope === 'user' && (h.configKeys || [h.configKey]).includes(cd.configKey)), ...projectHooks]
        .filter((h) => h.event === 'PreToolUse').map((h) => hookSource(h).text).join('\n'); // comments are no protection
      const missing = BASELINE.filter((b) => {
        if (rules.some((r) => b.rule.test(r))) return false;
        if (b.hook && b.hook.test(hookText)) return false;
        if (b.label === 'curl | bash' && /(curl|wget)/i.test(hookText) && /\|[^\n]{0,12}sh/.test(hookText)) return false;
        return true;
      }).map((b) => b.label);
      if (!missing.length) continue;
      const where = own[0] ? { ...own[0], line: lineOfJsonKey(own[0].text, 'deny') ?? lineOfJsonKey(own[0].text, 'permissions') } : { display: `${cd.display}/settings.json`, origin: 'active', line: null };
      out.push(finding(this, where, `no deny rule or PreToolUse hook covers: ${missing.join(', ')}${model.scope === 'both' ? ' (user and project rules combined)' : ''}`));
    }
    return out;
  },
};

export const PERMISSION_CHECKS = [envBaseUrlOverride, mcpProjectAutoApprove, allowShadowed, allowInterpreterWildcard, denyBaselineMissing, denyPrefixEvadable];
