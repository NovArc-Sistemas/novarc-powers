# Round 5 — Cleanup

After security, instructions and gates are settled, so nothing is removed that an earlier round
turned out to need.

## Check

- **Duplicate records**: the same plugin, marketplace, MCP server or hook registered twice, or
  at two levels with different settings.
- **Leftovers**: config for tools no longer installed; skills or commands from a removed plugin;
  backup files (`*.bak`, `*.old`, dated copies) inside config dirs; disabled entries kept "just
  in case".
- **Fragile links**: hardlinks between config dirs; symlinks to paths that no longer exist.
- **Unused skills and plugins**: installed, and absent from recent transcripts. Every installed
  skill costs its description in every session. `transcript-signals.mjs` reports skill
  invocation counts for the project; for user scope, ask before concluding from one project.
- **Unused MCP servers**: same test. Each one adds tool definitions to context.
- **Caches and logs** that grew without bound inside the config dir.
- **Stale worktrees and branches** (project scope) that tools created and never removed. List
  them; removing is the user's call.

## Before removing anything

Search for what uses it: instruction files that name it, hooks that call it, other skills that
chain it. "Looks unused" is a hypothesis. State what you searched and what you found.

## Fix

| Finding | Proposal | Class |
|---|---|---|
| Duplicate record | Keep the one at the intended level, remove the other | `reversible` |
| Hardlink between config dirs | Replace with a symlink and add a resolve check | `reversible` |
| Broken symlink | Fix the target or remove the link | `reversible` |
| Leftover config, backup files | Remove | `delete` |
| Unused skill, plugin, MCP server | Disable first (reversible), remove later if nobody misses it | `reversible`, then `delete` |
| Unbounded cache or log | Remove, and say what will recreate it | `delete` |

## Verify

Start a fresh session (or ask the user to) and confirm nothing reports a missing file, skill or
server. Check that the tool did not recreate a record you removed.
