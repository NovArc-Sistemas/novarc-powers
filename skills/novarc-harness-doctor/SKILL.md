---
name: novarc-harness-doctor
description: Use when someone wants their AI coding agent setup reviewed, scored or fixed - "review my harness", "harness doctor", "audit my CLAUDE.md / AGENTS.md", "why does my agent keep failing on this project", "which CLIs or plugins should I install", "too many MCP servers", "set up gates for this project". Covers the user harness (config dirs, instructions, permissions, hooks, skills, plugins, MCP servers, CLIs), the project harness (instruction files, docs, gates, knowledge graph), or both. Two modes - guided review (the user decides item by item) and doctor (safe fixes applied automatically, the rest queued). Works in Claude Code, Codex, Traycer and any agent with file and shell access.
---

# novarc-harness-doctor

A harness is everything that shapes an agent session before the user types: instruction files,
permissions, hooks, skills, plugins, MCP servers, CLIs, and the project's docs and gates. This
skill inventories it, scores it, and fixes it with the user.

`<skill>` below is the folder this file is in. `<ws>` is the workspace: `.novarc-powers/novarc-harness-doctor/`
under the project root for project scope, under the home directory for user scope. When both
scopes run, use the project workspace and record both scopes in the same state file.

## Hard rules

These hold in both modes. They exist because each one was broken once and cost real work.

1. **Read-only until the board exists.** Discovery changes nothing.
2. **Never print a secret.** Mask to the first 4 characters before anything reaches the
   conversation, the board, the state file or a log. Use `scripts/secret-scan.mjs`, never a raw
   `grep` over config.
3. **Backup before every edit**, into `<ws>/backups/<timestamp>/`. A backup of a file that holds a
   secret is made with the secret already masked, or not made and the item says so.
4. **Verify after every change**, by re-reading the real state, and record what was *not*
   verified. "Should work" is not a result.
5. **Never recommend from memory.** A tool, flag or feature is recommended only from
   `references/catalog/` (which carries a source and a verification date) or from documentation
   read in this session. Anything else is listed as an unconfirmed lead.
6. **Never without the user's yes:** installing software, deleting, changing permissions,
   touching secrets, committing, pushing. See `references/doctor-policy.md`.
7. **Write only inside `<ws>`** and the harness files an approved item names.
8. **Say when the user's premise is wrong**, then do what they decide.
9. **CLI before MCP.** Prefer an official CLI to an MCP server for the same service; keep an MCP
   server at user level only when nearly every conversation needs it, otherwise at project
   level. Always show the user the options; never move or remove a server without their choice.

## Flow

### 1. Prepare

Ask, in one message, only what is not already clear from the request:

- **Scope**: user harness, project harness, or both.
- **Mode**: guided review or doctor.

Detect the environment and read the matching file in `references/environments/`
(`claude-code.md`, `codex.md`, `traycer.md`, otherwise `generic.md`). It says where config
lives, how to show the board and whether subagents exist.

Create `<ws>` and an empty `<ws>/state.json` that follows `templates/state.schema.json`
(`templates/state.example.json` shows a filled one; do not copy its data). In project scope,
make sure local parts are ignored by git: if `.novarc-powers/.gitignore` is missing or lacks
them, add the lines `*/backups/`, `*/logs/`, `*/drafts/` and `*/board.html` to it (the installer
writes the same file; append, never replace). If a state file already exists, this is a re-run: copy each
`scores.<scope>.current` to `previous`, keep the items, and report what changed since `lastRun`.

### 2. Discover (read-only)

Run the probes. They need Node 20+ and no packages; without Node, follow the manual steps each
round file gives.

```bash
node <skill>/scripts/discover.mjs --scope <user|project|both> --cwd <project root>
node <skill>/scripts/probe-clis.mjs --cwd <project root>
node <skill>/scripts/secret-scan.mjs <each config dir and instruction file found>
node <skill>/scripts/transcript-signals.mjs --cwd <project root>     # project scope only
```

Each prints JSON. Then read `references/pitfalls.md` and check every pitfall that applies; the
probes do not catch all of them.

For project scope, read the true state: compare the local default branch with its remote first.
If the checkout is behind, read files from the remote ref, not from disk.

### 3. Build the board

Fill `state.json`: the `layers` (what enters a session, in load order), the full `inventory`
**including what is fine**, and one `item` per finding with `round`, `severity`, `finding`,
`proposal`, and `opinion`. Every inventory entry gets an opinion, not only the ones you want to
change. Then:

```bash
node <skill>/scripts/render-board.mjs <ws>/state.json
```

Mark each round's status per scope in `rounds` as you go (`pending`, `done`, `skipped`,
`not-applicable`); only `done` rounds count toward the score.

It computes the score per scope (`references/scoring.md`; never write a score by hand) and writes
`<ws>/board.html` and `<ws>/board.md`. Show the board the way the environment file says.
Re-render after every status change.
Set `language` in `state.json` to the language you speak with the user (`pt` or `en`; other
languages fall back to `en`).

### 4. Rounds

Work the queue in this order; each round unblocks the next. Read the round file when you reach it.

| # | Round | File | Scope |
|---|---|---|---|
| 1 | Security and permissions | `references/rounds/01-security-permissions.md` | both |
| 2 | Instructions and structure | `references/rounds/02-instructions-structure.md` | both |
| 3 | Documentation | `references/rounds/03-documentation.md` | project |
| 4 | Gates and automation | `references/rounds/04-gates-automation.md` | both |
| 5 | Cleanup | `references/rounds/05-cleanup.md` | both |
| 6 | Skills and knowledge | `references/rounds/06-skills-knowledge.md` | both |
| 7 | CLIs, MCP servers and tools | `references/rounds/07-clis-tools.md` | both |
| 8 | External dependencies | `references/rounds/08-external-dependencies.md` | both |

### 5. Per item

1. **Decide.** Guided: present finding, proposal and your opinion; one item at a time; wait.
   Doctor: apply `references/doctor-policy.md` — the safe classes are applied, everything else
   goes to the queue with status `queued`.
2. **Backup** (rule 3).
3. **Execute.** If the environment has subagents, hand the execution to one with the exact
   files, the exact change and the verification to run, and stay with the user. Otherwise do it
   yourself.
4. **Verify** (rule 4). A subagent's report is a claim; check the files yourself.
5. **Record.** Set the item's `status`, add a dated `log` line with what was verified and what
   was not, re-render the board.

### 6. Close

Write `<ws>/reports/<date>.md`: score before and after per scope, what changed, what is queued,
what could not be verified, and the unconfirmed leads. In doctor mode, list the queue as the
next thing the user should look at. For user scope, offer the portable mirror described in
`references/rounds/08-external-dependencies.md`. Set `lastRun`.

## Modes in one line each

- **Guided review**: nothing is applied without an answer to that item.
- **Doctor**: reversible and additive fixes are applied with backup; permissions, secrets,
  deletions, installs, gates and translations wait in the queue (translations arrive drafted).

## Concurrency

If another agent session may be editing the same harness right now (the user says so, or a
config file changes under you between reads), switch to guided mode and re-read every file
immediately before editing it.
