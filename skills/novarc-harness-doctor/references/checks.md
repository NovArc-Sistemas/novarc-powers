# Harness checks

`scripts/harness-checks.mjs` is a deterministic rule engine over the harness configuration. It
reads settings, hooks (and the scripts they run, when the path can be resolved), instruction
files and their imports, rules, skills, agents, commands, MCP server definitions, plugin
marketplaces and package manager config, and turns them into **candidate findings**. Each round
starts from this evidence instead of from eyeballing the files.

The rule ideas are inspired by AgentShield (MIT). The checks, their thresholds and their text are
our own; no code or rule text was copied.

## Running it

```bash
node <skill>/scripts/harness-checks.mjs --scope user|project|both --cwd <project root> [--only <id,...>]
```

Read-only. Zero dependencies, Node 20+. Exit 0 when the run completes (findings are not
errors); exit 2 on a bad argument or an unknown `--only` id. Prints JSON:

```json
{
  "checks": [{ "id": "", "round": 1, "severity": "high", "origin": "active", "file": "~/.claude/settings.json",
               "line": 12, "title": "", "evidence": "", "why": "", "fix": "", "docs": "references/checks.md#<id>" }],
  "defenses": [{ "scope": "user", "title": "Deny rules", "detail": "~/.claude/settings.json: 32 deny rule(s) on Bash, Read" }],
  "skipped": [{ "id": "npm-release-age-gate-missing", "reason": "no package.json at the project root" }]
}
```

- `checks` are sorted by severity, then id, file and line. The same finding reached through two
  config dirs (an account that links its `settings.json` to another) is reported once.
- `file` uses `~` for home and `./` for the project root. `evidence` never contains a secret
  value: secret-shaped text is masked to its first four characters (`scripts/secret-scan.mjs`
  patterns), API override URLs are reduced to their host, MCP servers appear by name only (never
  `args`, `env` or headers), and hook commands are capped at about 120 characters.
- `why` and `fix` are one English sentence each. The agent rewrites them in the user's language
  as the lesson of the item (`references/teaching.md`); they are a starting point, not the text
  the user reads.
- `line` is 1-based, or `null` when the finding is about a whole file or a group of files.

### Origin

`origin` says where the file lives, because the same pattern matters differently there:

| Origin | Where | Meaning |
|---|---|---|
| `active` | User config dirs, `~/.claude.json`, `~/.codex`, `~/.agents`, the project's `.claude/`, root instruction files and their imports | Loaded into sessions now |
| `project-optional` | Opt-in copies a user still has to adopt: `.example.`, `.sample.`, `.template.` or `.dist.` in the name (`settings.local.example.json`, `.mcp.sample.json`) | Not loaded until someone copies them. `.local` files themselves (`.claude/settings.local.json`, `CLAUDE.local.md`) load in every session and are `active` |
| `plugin` | Inside a config dir's `plugins/` folder or a plugin install path | Loaded, but owned by the plugin's publisher; fix upstream or replace the plugin |
| `example` | Paths with a `docs`, `examples`, `templates`, `fixtures`, `tests`, `samples` or `demo` segment, and a repository's own `SKILL.md` sources outside `.claude/` and `.agents/` | Not loaded by this harness; shipped or sample content |

Only the plugin version that loads is scanned: for each enabled plugin, the user-scope install (or
the one recorded for this project) with the latest `lastUpdated`. Older versions left in the
plugin cache are ignored.

## Checks

| Id | Round | Severity | Detects | Why it matters | False positives |
|---|---|---|---|---|---|
| <a id="env-base-url-override"></a>`env-base-url-override` | 1 | high | `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and similar API base or endpoint variables in a settings `env`, and `base_url` / `openai_base_url` in Codex `config.toml` | Every prompt, file and credential header goes to that host | A gateway the user runs on purpose (LiteLLM, a corporate proxy, a local model server); ask who owns it |
| <a id="mcp-project-auto-approve"></a>`mcp-project-auto-approve` | 1 | high | `enableAllProjectMcpServers: true` in any settings layer or in this project's `~/.claude.json` entry; `enabledMcpjsonServers` in the committed project `settings.json` | A cloned repository starts its own MCP servers with the user's access | A personal repo whose `.mcp.json` the user wrote; still prefer approving by name |
| <a id="hook-auto-allow"></a>`hook-auto-allow` | 1 | high (medium when the hook rewrites input) | A foreground PreToolUse or PermissionRequest command hook whose command or script prints an approval with no conditional in sight: `permissionDecision: "allow"` (or the deprecated top-level `decision: "approve"`) on PreToolUse, `decision.behavior: "allow"` on PermissionRequest. An approval printed together with `updatedInput` is reported separately at medium, conditional or not. Hooks on other events, `async` and `asyncRewake` hooks and a top-level `decision: "allow"` are ignored: none of them approves a tool call | The allow skips the permission prompt for every call the hook sees that no deny or ask rule covers. Deny and ask rules still apply, to rewritten input too; what a rewrite with allow takes away is the user seeing the call that actually runs | A script whose condition the text heuristic misses (a lookup table, an early `exit`); a hook that answers `AskUserQuestion` or `ExitPlanMode`, which needs `updatedInput` together with allow; read the script |
| <a id="allow-shadowed"></a>`allow-shadowed` | 1 | low | An allow rule matched entirely by a broader one in the same file, or listed twice | Longer list to audit; hides which rule grants access | Compared within one file only; rules across layers are not compared |
| <a id="allow-interpreter-wildcard"></a>`allow-interpreter-wildcard` | 1 | high | `Bash` / `PowerShell` with no restriction, or an interpreter, shell or runner (`node`, `python`, `bash -c`, `pwsh -Command`, `cmd /c`, `npx`, `env`, `sudo`, ...) followed only by a wildcard | One inline script bypasses every other rule | A sandboxed machine where the user accepts it; still narrow to scripts |
| <a id="deny-baseline-missing"></a>`deny-baseline-missing` | 1 | medium | No deny rule or PreToolUse hook mentioning `~/.ssh`, `~/.aws`, `**/.env*`, or a pipe from `curl`/`wget` into a shell; lists which are missing. User and project rules are combined; skipped in project-only scope | Nothing stops the agent from reading keys or running a downloaded script | Hooks are matched by text, so a hook that blocks these without naming them is missed; protection by OS sandbox is not seen |
| <a id="deny-prefix-evadable"></a>`deny-prefix-evadable` | 1 | critical for force-push, `reset --hard`, `rm -rf` when the flag is position-bound; high otherwise; medium (high for those targets) when only a single-letter flag can be bundled | A deny rule whose flag is not preceded by `*` (so moving it evades the rule), a combined short flag like `-rf` (so `-fr` or `-r -f` evades it), or a single-letter flag that can be bundled (`-f` vs `-df`) | The same dangerous command runs unblocked when written differently | A rule kept for documentation next to a blocking hook; the defenses list shows those hooks |
| <a id="hook-swallows-errors"></a>`hook-swallows-errors` | 1 | medium | A hook command that ends a failure with an or-true, or-colon or or-exit-0 fallback, or discards errors with `2>/dev/null`, `&>/dev/null`, `2>$null`, a pipe to `Out-Null` or `-ErrorAction SilentlyContinue` | A failing gate looks the same as a passing one | Cosmetic hooks (status line, greeting) where silence is intended |
| <a id="instructions-hidden-text"></a>`instructions-hidden-text` | 1 | high | Zero-width, bidirectional control and Unicode tag characters; HTML comments with imperative text; base64-like blobs of 200+ characters, in instruction, rule, skill, agent and command files | The agent reads what a reviewer cannot see | Translated text using U+200C/U+200D legitimately; tooling comments are ignored (`markdownlint`, `prettier-ignore`, `toc`, ...) |
| <a id="instructions-external-import"></a>`instructions-external-import` | 1 | medium | `@https://...` imports and "read / fetch / load / follow / download ... <URL>" outside code blocks in instruction and rule files | Whoever controls the URL controls the next session's instructions | Plain reference links are not flagged; a fetch of a trusted, versioned URL may be accepted |
| <a id="skill-shell-injection"></a>`skill-shell-injection` | 1 | medium (low for shell blocks) | `` !`...` `` pre-run lines in skills and commands that contain `$ARGUMENTS` or `$1`..`$9`; unquoted `$ARGUMENTS` inside a shell code block | User text is pasted into a shell line before it runs | Commands only the user invokes with trusted input; the risk grows when another agent or a pasted document supplies arguments |
| <a id="plugin-source-unpinned"></a>`plugin-source-unpinned` | 1 | low | A `github`/`git`/`url` marketplace with `autoUpdate: true` and no 40-character commit `ref`. The official Anthropic marketplace is exempt | New pushes reach the harness with no review | Publishers the user trusts with that level of access |
| <a id="npm-release-age-gate-missing"></a>`npm-release-age-gate-missing` | 1 | low | A project with dependencies and no minimum release age key (`minimumReleaseAge`, `minimum-release-age`, `min-release-age`, `npmMinimalAgeGate`, `before`) in the project or user `.npmrc`, `pnpm-workspace.yaml`, `.yarnrc.yml`, `bunfig.toml` | Fresh versions are when a hijacked package is most likely | Key names differ by manager and version; confirm the right key in the manager's docs before proposing one |
| <a id="instruction-file-oversized"></a>`instruction-file-oversized` | 2 | medium | An always-loaded root instruction file whose text plus imports exceeds about 8000 tokens (characters / 4) | Fixed cost on every session; long files are followed less | Rules files and nested directory instruction files are not added to the total |
| <a id="broken-reference"></a>`broken-reference` | 2 | medium | `@` imports that do not resolve, and backticked `~/`, `./`, `../` paths with an extension (or a trailing `/`) that do not exist, in instruction and rule files | The agent follows a pointer to nothing | Paths with placeholders (`<`, `*`, `{`, `$`) are skipped; in user-level files only `~/` paths and imports are checked, since `./` depends on the session's folder |
| <a id="hook-expensive-unscoped"></a>`hook-expensive-unscoped` | 4 | medium | `tsc`, `eslint`, `prettier`, `jest`, `vitest`, `pytest`, `mypy`, builds, and the `build`, `test` or `lint` script of npm, pnpm, yarn or bun in a PreToolUse or PostToolUse hook whose matcher is empty, `*` or includes Edit/Write | Adds the full run time to every edit | A script that filters by path or runs on the edited file only; read the script |
| <a id="hook-policy-exit-1"></a>`hook-policy-exit-1` | 4 | medium | A foreground Claude Code command hook (a Codex `hooks.json` is not judged by this contract) on an event where exit code 2 blocks (PreToolUse, UserPromptSubmit, Stop and the like) that never exits 2, prints no JSON decision and has no `onFailure: "block"`, and that either writes a refusal to stderr (blocked, denied, forbidden, refused, rejected, not allowed, ...) and exits 1 on that line or within the next three, or is a script whose file name says `block`, `deny`, `guard` or `forbid` and has an explicit `exit 1` | Exit code 1 is a non-blocking error: the refusal is printed and the action goes ahead anyway | Narrow on purpose, so expect misses before false alarms: it fires only when everything the hook runs was read, and a hook that reaches its status another way (`exit $code`, `set -e`, a wrapper) is not guessed at. What can still be wrong: a script named for a policy whose `exit 1` is its own failure path (a missing dependency) and which never meant to block; and Windows without Git Bash, where a failing shell-form PreToolUse hook does block the call |
| <a id="agent-prompt-oversized"></a>`agent-prompt-oversized` | 6 | medium | An agent definition with more than 5000 characters of prose (front matter, code blocks and tables excluded) | Re-read on every call; buries the rules that matter | Agents that are deliberately long playbooks and run rarely |
| <a id="skill-description-hijack"></a>`skill-description-hijack` | 6 | medium | A skill description over 1000 characters, or catch-all phrasing ("always use this skill", "for any task", "before any response", "use when starting any conversation") | Descriptions load every session and decide which skill fires | Methodology bootstrap skills that are meant to fire first; the user decides whether that is wanted |
| <a id="agent-expensive-model-readonly"></a>`agent-expensive-model-readonly` | 6 | low | An agent whose `tools` are only Read, Grep, Glob, LS and whose `model` names opus | Lookup work rarely needs the most expensive model | A read-only reviewer whose judgement needs the stronger model |
| <a id="duplicate-install"></a>`duplicate-install` | 6 | low | The same skill name at two different real paths in what one agent loads (a Claude config dir with its plugins and the project's `.claude/skills`; or Codex with `~/.codex/skills`, `~/.agents/skills` and the project's `.agents/skills`), and the same hook command for the same event in two files of one harness | Loads twice, drifts apart | Two copies reached through a link are one copy and are not reported; a deliberate override of a plugin skill |
| <a id="mcp-server-count"></a>`mcp-server-count` | 7 | medium | More than 10 distinct MCP servers at one level (user, local or project) for one agent, counting plugin-bundled servers | Every server costs context in every session at that level | Connectors that come from a claude.ai account are not in config files; complete the count with `/mcp` |
| <a id="mcp-user-level-has-cli"></a>`mcp-user-level-has-cli` | 7 | medium | A user-level MCP server whose name contains a `replacesMcp` entry of a CLI in `references/catalog/tools.json` | The CLI costs nothing until used | Servers that do something the CLI cannot; skipped when the catalog is unreadable |

### Hook checks and the hooks reference

`hook-auto-allow`, `hook-policy-exit-1` and the **Blocking PreToolUse hook** defense follow the
Claude Code hooks reference (<https://code.claude.com/docs/en/hooks>, read on 2026-11-23). The
sentences they rely on:

- Which output approves a tool call: on PreToolUse, `permissionDecision`, where "`"allow"` skips
  the permission prompt, except for actions no mode auto-approves and reads from network paths";
  on PermissionRequest, `decision.behavior`, where "`"allow"` grants the permission". For a
  top-level `decision`, "The only value for `decision` is `"block"`", and on PreToolUse "The
  deprecated values `"approve"` and `"block"` map to `"allow"` and `"deny"` respectively."
- What an allow leaves in place: "Deny and ask rules are still evaluated regardless of what the
  hook returns" (PreToolUse); "The hook can't approve what a deny rule refuses, unless a mod
  overrides the rule" (PermissionRequest).
- Rewritten input: "Claude Code evaluates permission rules ... against the input your hook
  returns, not the input Claude sent. Combine with `"allow"` to auto-approve, or `"ask"` to show
  the modified input to the user." (PreToolUse); "The modified input is re-evaluated against deny
  and ask rules." (PermissionRequest).
- Exit codes: "Exit code 1 without valid JSON output is a non-blocking error unless the hook is
  one whose failure blocks the action, even though 1 is the conventional Unix failure code. If
  your hook is meant to enforce a policy, use `exit 2`."
- `onFailure`: "With `"block"` set, a failure does what exit code 2 does on that event, except on
  `PermissionRequest`, where it denies the request." The field has no effect on `Stop`,
  `SubagentStop`, `TaskCompleted` and `TeammateIdle` hooks, nor on background command hooks.
- Background hooks: "Async hooks can't block or control Claude's behavior: response fields like
  `decision`, `permissionDecision`, and `continue` have no effect, because the action they would
  have controlled has already completed."

Re-read the page before changing one of these rules. Which events can block, and through what,
is decided in one place: `hookBlocking` in `scripts/lib/snapshot/elements.mjs`.

## Permission precedence

Claude Code evaluates permission rules in order: deny, then ask, then allow. The first match in
that order decides, and a more specific rule does not change the order. A call that matches no
rule follows the default mode (`permissions.defaultMode`). Source: the Claude Code permissions
documentation, read on 2026-11-24.

## Defenses

Reported in `defenses`, never as findings, so the board can show what is already fine:

- **Deny rules** and **Ask rules**: count per settings file and the tools they cover.
- **Blocking PreToolUse hook**: a PreToolUse hook that can really stop a tool call, by the test
  the snapshot uses for a hook's `blocking` field: its command or script exits with 2 (`exit 2`,
  `exit(2)`, `process.exitCode = 2`) and the command does not throw that status away (an or-true
  or `; exit 0` ending), or it prints a deny, ask or block decision, or it sets
  `onFailure: "block"`. A hook that runs in the background (`async`, `asyncRewake`) is never
  listed. Only the hook's code counts: an `exit 2` in a comment or inside a message proves
  nothing. When the code does not show which it is (a computed exit status, a decision held in
  a variable), `blocking` is `null`: no defense is listed and no check fires on it. Never turn
  an unknown into "blocks" or "does not block" in a finding; read the script.
- **Sandbox enabled**: `sandbox.enabled: true` in a settings layer.
- **Secret scan before commit**: the project's git `pre-commit` hook (respecting
  `core.hooksPath`), `.pre-commit-config.yaml`, `.husky/pre-commit` or `lefthook.yml` runs
  gitleaks, trufflehog, detect-secrets, git-secrets, secretlint, ggshield, talisman or a
  `secret-scan` script.

## How the agent uses the output

1. `run.mjs probe` runs it for every harness in the run and stores the result as
   `probes/<harness>/checks.json`; a reviewer reads the candidates of its own rounds from there.
2. **Every entry in `checks` is a candidate, never an accepted finding.** Before it becomes an
   item, open the file at `line`, read the surrounding config or script, and confirm the problem
   is real in this harness. Drop it when it is not, and say why in the log. The heuristics read
   text; they do not run anything, so a script with a condition they cannot see, a gateway the
   user owns or a deliberate override all look like problems.
3. A confirmed candidate becomes one item in the reviewer's findings file, with the candidate's
   id in `check` and its `round` and `severity` as the starting point. Adjust severity with what verification showed (for example a
   tracked file versus an untracked one) and record the reason.
4. `origin` feeds scoring: an `example` finding is usually informational, a `plugin` finding is
   resolved by updating, replacing or reporting upstream rather than by editing the cache (edits
   there are overwritten on update), and a `project-optional` finding affects only this machine.
   See `references/scoring.md` for how origin weighs.
5. Rewrite `why` and `fix` into the lesson in the user's language (`references/teaching.md`);
   the diff in `changes` comes from reading the real file, never from the evidence string.
6. `defenses` go into the findings' `defenses` list for the harness they protect, once you have
   seen them in the real file. They appear on the board and add no points.
7. `skipped` entries are noted on the board as "not checked" with their reason, so a skipped
   check never reads as a pass.
8. The checks do not replace the round files: secrets still go through `secret-scan.mjs`, and
   every round still has manual checks the engine cannot do.
