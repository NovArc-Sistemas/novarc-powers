# novarc-harness-doctor

[Português](README.md) · **English**

Reviews your coding agent's harness, scores it from 0 to 100, and fixes it with you.

The harness is everything that shapes a session before you type: instruction files,
permissions, hooks, skills, plugins, MCP servers, CLIs, the project's docs, and the gates that
stop mistakes.

## How to use it

Without installing anything, ask your agent:

> Run `npx -y novarc-powers fetch novarc-harness-doctor`, read the SKILL.md at the path it
> prints and follow it to review my harness.

Or install the pointer with `npx novarc-powers add novarc-harness-doctor`, then just ask
"review my harness" in any session.

## What it does

1. **Asks** for the scope (user harness, project harness or both) and the mode.
2. **Discovers**, changing nothing: every config dir of every account, imports that do not
   resolve, exposed secrets (always masked), installed CLIs, docs, hooks and, for a project,
   where past sessions tend to fail.
3. **Builds a board** with a score per scope, the full inventory (including what is fine, with
   an opinion on each entry) and the decision queue.
4. **Works through eight rounds**: security and permissions; instructions and structure;
   documentation; gates and automation; cleanup; skills and knowledge; CLIs, MCP servers and tools; external
   dependencies.
5. **Fixes item by item**: backup, change, verification after the change, and a record of what
   could not be verified.

## The two modes

| | Guided review | Doctor |
|---|---|---|
| Reversible fixes with backup | you decide | applied |
| Additions (missing rule, skills index) | you decide | applied |
| Translating agent files to English | you decide | drafted for your approval |
| Turning on an opt-in feature confirmed for your version | you decide | applied and checked |
| Permissions, secrets, deletions, installs, gates, MCP servers | you decide | queued for you |

## What it recommends

Only what was verified at the source, with a date. Today:

- **Superpowers** as a methodology that triggers on its own, plus a short skills index in
  `CLAUDE.md` so skills fire without being named.
- **rtk**, **caveman** and **ponytail** to spend fewer tokens, with a note on where they overlap.
- **Graphify** for code projects, checking that the graph's update hooks work without slowing
  development and that the agent is told to query the graph.
- **Agent-facing files in English**, which cost fewer tokens.
- **Gates** built from the problems you actually had in the project, not a generic list.
- **CLI before MCP.** Every MCP server becomes your decision, with the options laid out: replace
  it with the official CLI, move it to project level, keep it at user level (only what nearly
  every conversation needs) or turn it off. The skill suggests the missing CLIs, walks you
  through each login without asking for a token in chat, and writes the CLI preference into
  `CLAUDE.md`.
- **Hidden and experimental features** that help, such as Claude Code's Code Mode: confirmed for
  your installed version, turned on when every condition holds, and checked right after.

## Privacy

Everything runs on your machine. Reading past sessions returns counts only (failed commands,
corrections, hook blocks), never conversation text. Secrets show only their first 4 characters.

## Files it creates

```text
.novarc-powers/novarc-harness-doctor/
├── state.json      # review state
├── board.html      # the board
├── board.md        # the same board as text
├── reports/        # one report per run
├── drafts/         # translations waiting for approval
├── backups/        # local, never committed
└── logs/           # local, never committed
```

## Requirements

Node 20 or newer for the diagnostic scripts (no dependencies). Without Node, the skill follows
the manual steps and reports the review as not scored.
