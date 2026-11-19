# Environment: Codex

## Where the harness lives

- User: `~/.codex/` (`AGENTS.md`, `config.toml` with model, sandbox, approval policy, MCP
  servers and profiles, `hooks.json`, `skills/`, `agents/`, `auth.json` — never read or copy
  `auth.json`). `~/.agents/skills/` is a shared skills dir several agents read.
- Project: `AGENTS.md` (root and nested; the closest one to the edited file wins),
  `.agents/skills/`, `.codex/` if present.
- Transcripts: `~/.codex/sessions/**/*.jsonl`; each session records its working directory.

## Things to check that differ from Claude Code

- Sandbox mode and approval policy in `config.toml` are the permission layer. A profile with
  full access and no approvals is the equivalent of an allow-all rule.
- Plugins and their hooks must be trusted in `/hooks` before they run; an installed but
  untrusted hook is a gate that does not exist.
- `AGENTS.md` is often shared with other agents. A rule meant for one agent only belongs in that
  agent's own file.

## Showing the board

No artifact surface. Write `<ws>/board.html` and give the user its path to open in a browser;
summarise each change in chat from `board.md`.

## Subagents

Depends on version and configuration. If none, do each item yourself, one at a time.
