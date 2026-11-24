# Environment: Codex

## Where the harness lives

- User: `~/.codex/` (or `CODEX_HOME`): `AGENTS.md`, `config.toml` (model, sandbox, approval
  policy, MCP servers, profiles), `hooks.json`, `skills/`, `agents/`, `prompts/`, and `auth.json`
  (never read or copy it). `~/.agents/skills/` is a shared skills dir several agents read.
- Project: `AGENTS.md` (root and nested; the one closest to the edited file wins),
  `.agents/skills/`, `.codex/` when present.
- Transcripts: `~/.codex/sessions/**/*.jsonl`; each session records its working directory.

## What differs from Claude Code

- Sandbox mode and approval policy in `config.toml` are the permission layer. A profile with
  full access and no approvals is the equivalent of an allow-all rule.
- Plugins and their hooks must be trusted in `/hooks` before they run; an installed but
  untrusted hook is a gate that does not exist.
- `AGENTS.md` is often shared with other agents. A rule meant for one agent belongs in that
  agent's own file. Codex stops reading project instructions past a size limit
  (`project_doc_max_bytes`, 32 KiB by default): an oversized `AGENTS.md` is silently cut.
- `codex mcp add` rewrites the MCP tables of `config.toml` and drops comments, so a managed
  block there is recognised by content, not by its marker comments.
- Skills load from `$CODEX_HOME/skills` and from the shared `~/.agents/skills`. With both
  populated, every skill shows up twice.

## Showing the board

`run.mjs build --channel server`, then start the local page as a background process:

```bash
node <skill>/scripts/serve-board.mjs --run <id>
```

Give the user the URL it prints (it only answers on this machine). The user decides with the
buttons on the page; read the decisions with `run.mjs decisions`. If a background process is
not possible here, `run.mjs build --channel file` and give the path of `<run>/board.html`: the
board then shows, for each decision, the line to paste in chat.

## Subagents

Depends on the version and configuration. Without them, take the units yourself, one at a time
(`references/orchestration.md`, "Without subagents").
