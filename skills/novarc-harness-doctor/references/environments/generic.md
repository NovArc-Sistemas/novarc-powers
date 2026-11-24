# Environment: any other agent

OpenCode, Cursor, Gemini CLI, a host app that runs several agents, anything else. The skill
needs three things: reading files, running shell commands, and writing inside the run folder.

## Where the harness lives

`accounts.mjs list` and `find-projects.mjs` find the common locations. For an agent they do not
know, ask the user which instruction files it reads (common names: `AGENTS.md`, `GEMINI.md`,
`.cursor/rules/`, `.windsurfrules`, `.github/copilot-instructions.md`, `CONVENTIONS.md`) and
where its settings, permissions and MCP servers are configured, and record the answers as
`layers` and `inventory` in your findings.

A host app that runs agents on several accounts gives each account its own config dir and
points the agent at it through an environment variable. The session you are in may be on a
secondary account: trust `accounts.mjs list`, not the default path.

## Showing the board

`run.mjs build --channel server`, then start `node <skill>/scripts/serve-board.mjs --run <id>`
as a background process and give the user the URL it prints (it only answers on this machine;
if the host app has a built-in browser, open it there). The board is view-only: the user
reads it and decides in the conversation, where you record each decision with `run.mjs decide`.

If a background process is not possible, `run.mjs build --channel file` and give the path of
`<run>/board.html` to open from disk.

## Without Node

Do the discovery by hand following each round's "Check" section, keep your findings in a
markdown file, and present them in chat in the same shape: the why, the cost, the exact change
as a before/after block, the rule to keep. Scores and the board need the scripts; without them
say the review is not scored instead of estimating a number.

## Subagents

Assume none: take the units yourself, one at a time.
