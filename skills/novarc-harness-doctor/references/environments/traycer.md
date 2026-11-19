# Environment: Traycer

Traycer runs Claude Code, Codex and other agents inside tasks, each agent on a harness account.

## Where the harness lives

- Everything in `claude-code.md` and `codex.md` applies to the underlying agent.
- Traycer gives each account its own config dir and points the agent at it (for Claude Code,
  through `CLAUDE_CONFIG_DIR`). Those dirs live under the Traycer host folder in the home
  directory. `scripts/discover.mjs` looks for them. Each is a separate harness unless its files
  link into the main one; check that imports resolve in each.
- Transcripts of Traycer sessions are under each account dir's `projects/`, not under
  `~/.claude/projects/`. `transcript-signals.mjs` reads both.
- Traycer ships its own bundled skills; they are part of the session but not the user's to edit.

## Showing the board

Traycer shows HTML artifacts beside the chat. The artifacts folder for the current task is
given in the system prompt; do not guess or hardcode it. Copy `<ws>/board.html` into a folder
there as `index.html` (one folder per review, e.g. `harness-review/`), and copy it again after
each re-render. The user can comment on the artifact; read those comments as decisions.

Keep the real state in `<ws>/state.json`. The artifact is a view.

## Subagents

The underlying agent's own subagents work. Traycer agents in the same task can also be messaged;
do not create new ones for this skill unless the user asks.
