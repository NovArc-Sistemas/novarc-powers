# Environment: Claude Code

## Where the harness lives

- User, per account: the config dir (`~/.claude/` by default; `CLAUDE_CONFIG_DIR` points a
  session at another one, and host apps that run several accounts create one dir per account,
  so the session you are in may be running on a secondary account). In it: `CLAUDE.md` and its
  `@imports`, `settings.json`, `settings.local.json`, `skills/`, `agents/`, `commands/`,
  `rules/`, `output-styles/`, `plugins/`, `keybindings.json`, the statusline script.
- `.claude.json` in the config dir: per-account state, including MCP servers added at user and
  local scope. It also holds credentials-adjacent data: the scripts read only the keys they
  need; never copy or print it.
- Managed settings (enterprise) override everything; note them if present, never edit them.
- Project: `CLAUDE.md` (root and nested), `CLAUDE.local.md`, `.claude/settings.json`,
  `.claude/settings.local.json`, `.claude/skills|agents|commands|rules/`, `.mcp.json`.
- Transcripts: `<config dir>/projects/<encoded cwd>/*.jsonl`, with subagent transcripts in a
  `subagents/` folder beside each session.

## Useful read-only commands

- `claude plugin list`, `claude plugin details <name>` (component inventory and projected token
  cost), `claude mcp list`.
- `/context` in a session shows what that session loaded and its size; ask the user to paste it
  when an exact number matters. `/hooks` lists registered hooks, `/permissions` the effective
  rules.

## Hooks

A command hook blocks only with the exit code or JSON decision the hooks documentation defines
for that event; anything else is advice. Check that the event name exists in the current docs.

## Showing the board

The board is view-only: the user reads it and decides in this conversation, where you record
each decision with `run.mjs decide`. Two ways to show it. Offer both in one sentence each and
let the user choose:

1. **Local page (default).** The complete board, and nothing leaves the machine.
   `run.mjs build --channel server`, start `node <skill>/scripts/serve-board.mjs --run <id>` as a
   background process and give the user the URL it prints. The page reloads itself after each
   `run.mjs build`.
2. **Private page on claude.ai (Artifact).** A page the user can open anywhere.
   `run.mjs build --channel artifact` renders a compact board: every
   finding, score and measurement, with the text of the files that have changes; files without
   changes are listed without their text. That text (secrets and e-mail addresses masked) goes to
   claude.ai, so say so and publish only on a yes. Publish `<run>/board.html` with the Artifact
   tool; it needs no runtime capability. The file built for this channel is a page fragment
   (no doctype, `html`, `head` or `body`: the publisher adds them), with its data one entry per
   line; it is not meant to be opened from disk or served. To go back to the local page, build
   again with `--channel server`. Your Artifact tooling may require you to read a file before
   publishing it; if the board is too large for that, stay with the local page.
   Republish the same file after every `run.mjs build` so it shows the new state.

If neither is possible, `run.mjs build --channel file` and give the path of `<run>/board.html`
to open from disk.

## Subagents

Available (the `Agent` tool). Give each one the brief from `references/orchestration.md`; it
does not see this conversation.
