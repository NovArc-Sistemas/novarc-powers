# Environment: Claude Code

## Where the harness lives

- User: `~/.claude/` (`CLAUDE.md` and its `@imports`, `settings.json`, `settings.local.json`,
  `skills/`, `agents/`, `commands/`, `rules/`, `output-styles/`, `plugins/`, `keybindings.json`,
  statusline script). `CLAUDE_CONFIG_DIR` points a session at another dir; host apps that run
  several accounts create one dir per account. Each dir is a separate harness unless linked.
- `~/.claude.json`: per-user state including MCP servers added with `claude mcp add` at user
  scope. Holds credentials and history — read only the keys you need, never copy it.
- Managed settings (enterprise) override everything; note them if present, never edit them.
- Project: `CLAUDE.md` (root and nested), `CLAUDE.local.md`, `.claude/settings.json`,
  `.claude/settings.local.json`, `.claude/skills|agents|commands|rules/`, `.mcp.json`.
- Transcripts: `<config dir>/projects/<encoded cwd>/*.jsonl` for every config dir.

## Useful read-only commands

- `claude plugin list`, `claude plugin details <name>` (component inventory and projected token
  cost), `claude mcp list`.
- `/context` inside a session shows what the session actually loaded and its size. Ask the user
  to paste it when a size estimate matters.
- `/hooks` lists registered hooks; `/permissions` lists effective rules.

## Hooks

A command hook blocks only with the exit code or JSON decision the hooks documentation defines
for that event; anything else is advice. Check the event name exists in the current docs.

## Showing the board

If the `Artifact` tool is available, publish `<ws>/board.html` as an Artifact (private by
default) and republish to the same URL after each change. Otherwise give the user the path of
`<ws>/board.html` to open in a browser, and summarise the change in chat from `board.md`.

## Subagents

Available (`Agent` tool). Give each one the exact files, the exact change and the verification
command; it does not see this conversation.
