# Environment: any other agent

The skill needs three things: reading files, running shell commands, and writing inside `<ws>`.
With those, everything works; the board is a local file.

## Where the harness lives

Ask the user which instruction files the agent reads (common names: `AGENTS.md`, `GEMINI.md`,
`.cursor/rules/`, `.windsurfrules`, `.github/copilot-instructions.md`, `CONVENTIONS.md`) and
where its settings, permissions and MCP servers are configured. Record the answers in
`state.json` as layers. `discover.mjs` finds the common file names in the project.

## Showing the board

Write `<ws>/board.html` and give the user its path. If the agent can show images or HTML
inline, use that. Summarise each change in chat from `board.md`.

## Without Node

Do the discovery by hand following each round's "Check" section, write `state.json` yourself,
and present `board.md` content in chat. Scores need `render-board.mjs`; without it, say the
review is not scored rather than estimating a number.

## Subagents

Assume none.
