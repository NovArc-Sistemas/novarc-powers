# Pitfalls

Each of these was hit in a real harness review. Check the ones that apply before trusting a
finding or declaring a fix done.

## Reading the state

- **The local checkout may be stale.** Run `git fetch` (read-only for the working tree) and
  compare the default branch with its remote. If it is behind, read with
  `git show <remote>/<branch>:<path>`. A review of a checkout a thousand commits behind is a
  review of a project that no longer exists.
- **More than one account, more than one tool.** A machine can have several config dirs for the
  same agent (profiles selected by an environment variable, dirs created by a host app), plus
  other agents' dirs, plus a desktop app config. `scripts/discover.mjs` lists the ones it can
  find; ask the user whether there are more. Work out which are shared, linked or copied.
- **Imports resolve relative to the file that imports them.** An `@file.md` import in an
  instruction file inside a second config dir points into that second dir. If the file is not
  there, the agent runs without it and says nothing. `discover.mjs` reports unresolved imports.
- **Hardlinks between config dirs break silently.** An editor that saves atomically replaces the
  file and the link is gone; both copies then drift. Prefer symlinks, and add a check that the
  link still resolves. When this skill edits a harness file, it writes in place (open, truncate,
  write), never temp-file-plus-rename, and checks afterwards that a link is still a link.
- **`CLAUDE_CONFIG_DIR` may point at a secondary account.** Inside a host app the current
  session's config dir is often not the main one. Edit the file the link resolves to, once.
- **Some harness changes have a follow-up the user owns.** A user who mirrors the harness in a
  repo, or whose instructions say a change must be synced somewhere, gets that step in the item's
  proposal. Read the user's instruction files for such rules before the first edit.
- **A running app rewrites its config from memory.** An edit to a desktop app's config file can
  be undone minutes later. Such an edit needs the app quit first; say so and queue it.

- **A tool can rewrite the file you manage.** `codex mcp add` rewrites the MCP tables of
  `config.toml` and drops comments; an app that owns a JSON state file rewrites it whole. Never
  rely on marker comments surviving in a file another program writes: record what you manage
  (name and content hash) somewhere of your own.

## Secrets

- **Tokens sit in config files and one-off scripts**, including MCP server definitions, shell
  profiles and old helper scripts. Scan every dir the harness loads from.
- **A filter that is too narrow leaks.** Do not `grep` config and print the match. Use
  `scripts/secret-scan.mjs`, which prints the file, line and a masked value only.
- **A backup duplicates the secret.** Mask in the backup or do not back up that file.
- **A token that reached a transcript or a log is compromised.** The fix is rotation, which
  only the user can do. Queue it as `secret`.

## Permissions

- **A deny rule that matches by prefix is evadable.** `deny git push --force` does not match
  `git push origin main --force`. Test each deny rule with the argument in another position.
- **A broad allow for an interpreter makes every deny moot.** If `bash -c`, `node -e`, `python
  -c` or `powershell -Command` is allowed wholesale, anything can be run through it.
- **Permission prose is not a permission.** "Never run X" in an instruction file is a request.
  If a broader allow rule approves the command, the prose is dead letter. Report the pair.

## Working with the user

- **A premise can be partly wrong.** Rules the user believes belong to an abandoned feature may
  serve another flow. Check what reads a thing before agreeing to remove it. Say what you found,
  then do what is decided.
- **Regressions happen in the same session.** A subagent can remove more than it was asked to;
  a cleanup can be undone by a tool that recreates its records. Verify after the change, and
  re-check earlier fixes before closing.

## Tooling on Windows

- Heredocs in Git Bash mangle backslashes; write files with the file tool instead.
- MSYS rewrites arguments that look like paths. `git show origin/main:.claude/x` needs
  `MSYS_NO_PATHCONV=1`.
- A subagent may be refused when editing outside its working directory. Give it paths it can
  reach or do that edit yourself.

## Instruction files

- **Two files that disagree.** An `AGENTS.md` that contradicts `CLAUDE.md` means the behaviour
  depends on which agent opens the project.
- **A file everything is told to read, that grew without bound.** A pendings or notes file of
  hundreds of kilobytes, loaded every session, is a finding in its own right.
