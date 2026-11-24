# Accounts: one primary, the others follow

Read this when `accounts.mjs list` shows more than one account. Command lines and JSON shapes are
in `contracts.md`; this file is how to use them with the user.

## What an account is

An account is one config dir of one provider: the default `~/.claude`, a second Claude Code dir
that a host app created and selects through `CLAUDE_CONFIG_DIR`, `~/.codex` (or `CODEX_HOME`),
`~/.gemini`, the OpenCode config dir, `~/.cursor`, and the shared skills folder `~/.agents`. Each
has its own user harness, and left alone they drift: a rule added in one never reaches the
others, and an `@import` that resolves in the first dir is silently missing in the second.

`accounts.mjs list` gives each one a stable id (`claude-1` is the default Claude dir, `claude-2`
onward the others sorted by path, `codex-1`, ...), a label, the host app when the path shows one,
`linksInto` when its files already link to another account, and a masked `identity` (`wi…@example.com`)
for Claude Code accounts. `inUse` says which account this very session runs on: inside a host
app that is often a secondary one. Ids are positional; a plan carries each account's path and
`apply` refuses when they no longer match.

A folder a host app keeps beside its accounts is listed only when it is one: its name is not a
lock, backup or temporary name (`*.lock`, `*.bak`, `*.old`, `*.tmp`, `*.backup`, or starting with
`.` or `_`), and it holds at least one account marker: a settings file, an instruction file, a
state or credentials file (its presence is checked; it is never opened), or a `projects` /
`sessions` folder of its own (a link to another account's does not count).

Each entry also carries `elements`, how many harness elements that config dir holds (the
instruction file and the files it imports, settings, key bindings, each non-empty harness folder,
its user-level MCP servers counted as one), and `empty`, true when that is 0. An empty account
has nothing to review: leave it out of the review by default and say that you did, in one line,
so the user can bring it in. It can still be a target: linking or replicating is exactly what
gives it a harness.

## How the user sees it

- `list`, `diff` and `plan` are what the board shows, so pass them the run language:
  `--lang pt|en` (English when omitted; anything else is refused). It words the `label`, every
  `detail`, `note`, `notes` and `warnings` entry, each action's `why` and `replaces`, each
  conflict's `note`, and `suggestionText`. Ids, states, modes, options, actions and paths never
  change with the language, and a plan has the same fingerprint in both, so `apply` does not care
  which one it was written in. The generated files themselves are not translated: they are the
  primary's own text.
- Each account's user harness is its own tab on the board. The overview lists the accounts with
  provider, label and masked identity; never show a full e-mail or an absolute path.
- The user picks ONE primary, on the board or in chat. The decision target is `accounts.primary`
  with the account id in `note` (`run.mjs decide --target accounts.primary --action approve --note claude-1`).
  Recommend the account with the most activity, and say in one sentence what it means: the
  primary's harness becomes the source and the others follow it.
- After the choice, `accounts.mjs diff --primary <id> --lang <run language>` fills
  `accounts.list[].sync` in the state: each entry's `sync` object is already in the schema's
  shape (`mode`, `status`, `detail`, `elements`). Set `inherits` on a linked account's harness to
  the primary's harness id.
- Beside `sync`, each entry of `diff` has `suggested` and a one-line `suggestionText` for the
  board:

  | `suggested` | Means | What to offer |
  |---|---|---|
  | `link` | Same provider as the primary, and some elements do not follow it yet | A plan that links it |
  | `replicate` | Another provider, and part of the primary's harness can be generated for it | A plan that replicates into it |
  | `none` | It is the primary, it already follows, or nothing in it can follow | Nothing |

  An account nobody has synced yet still reads `mode: independent`, `status: none`: that is its
  state. `suggested` is what could be done about it, never something already decided: it becomes
  real only through a plan the user has seen and approved. The text also says how many of those
  elements wait for a decision (they differ from the primary), so do not present the count as
  "will be linked".

## Linked, replicated, independent

| Mode | When | What happens |
|---|---|---|
| `linked` | Same provider as the primary | Each harness element becomes a link into the primary's. One file, two paths: an edit shows in both at once. |
| `replicated` | Another provider | The portable subset is generated from the primary and regenerated when the primary changes. The generated files are outputs: edit the primary, never them. |
| `independent` | Not managed | The account keeps its own harness. This is a legitimate choice, per account or per element. |

Elements that are linked, per provider:

- Claude Code: `CLAUDE.md` and every file it imports that lives in the config dir, `settings.json`,
  `keybindings.json`, the status line script, and the folders `skills/`, `agents/`, `commands/`,
  `rules/`, `output-styles/`, `scripts/`, `hooks/`, `plugins/`.
- Codex: `AGENTS.md`, `hooks.json`, `skills/`, `agents/`, `prompts/`. `config.toml` is never
  linked: only its MCP server tables are managed.
- Gemini CLI and OpenCode: the instruction file and `skills/`.

User-level MCP servers cannot be linked, because they live in a file that also holds account
state (`.claude.json`) or account settings (`config.toml`). They are copied as definitions, one
element per server (`mcp servers/<name>`), for linked and replicated accounts alike.

Never linked, copied, generated from or read, in any mode: `.credentials.json`, `auth.json`,
`.claude.json` as a file (only its `oauthAccount` e-mail and `mcpServers` keys are read),
`settings.local.json` (account-local by design), `projects/`, `sessions/`, `todos/`,
`shell-snapshots/`, `statsig/`, `history*`, databases, logs and caches. The most that happens to
a credentials file or a sessions folder is being seen to exist, to tell an account folder from a
stray one.

## What crosses providers, and what does not

| Element | Crosses? | How, or why not |
|---|---|---|
| Instructions | Yes, generated | `AGENTS.md` (Codex, OpenCode), `GEMINI.md` or `CLAUDE.md` is built from the primary's instruction file: imports inlined in place (the other formats have no imports), provider fences applied, and a first-line marker comment naming the source. |
| Skills | Yes, linked one by one | Each skill folder of the primary is linked into the target's skills folder. A name the target already uses is a conflict, not an overwrite. |
| MCP servers | Yes, translated | Claude's `mcpServers` JSON and Codex's `[mcp_servers.<name>]` TOML are translated both ways. In `config.toml` the managed tables sit between `# novarc-harness-doctor:start` and `:end`; nothing else in the file is touched. |
| Permissions | No | Allow/deny/ask rules and Codex's sandbox and approval policy are different models. Tell the user what to mirror by hand; the `note` of the `permissions` element counts the rules. |
| Hooks | No | Events, matchers and payloads differ, and Codex runs a hook only after it is trusted through `/hooks`. The `note` lists the registered events to re-create. |
| Plugins, key bindings, subagents, commands, rules, output styles | No | Provider-specific formats. Rewrite what is needed, or fold the content into the instruction file. |

Not-portable elements come back with state `not-portable` and a `note`. Put them on the board as
information for the user, never as something the skill will do.

An MCP server is also `not-portable` when its definition carries an inline secret, uses SSE
(Codex has stdio and streamable HTTP only), or uses variable expansion the target cannot express.
For a secret, the fix belongs to round 1 and to the user: move it to an environment variable in
the primary, then plan again. The output names where the secret is (`env GITHUB_TOKEN`), never
its value.

### Provider fences

Text that only one provider should read is fenced in the primary's instruction file:

```markdown
<!-- only: claude-code -->
Use the Skill tool to load a skill.
<!-- /only -->

<!-- except: codex -->
This paragraph reaches every account but Codex.
<!-- /except -->
```

Names: `claude-code`, `codex`, `gemini`, `opencode`; a comma-separated list is allowed. The fence
lines never reach a generated file. Propose a fence when a rule names a tool or a feature that
exists in one provider only; that is a round 2 finding in the primary.

### Verified provider facts

Checked on 2026-11-23 against the Codex documentation and codex-cli 0.171, and the Claude Code
hooks documentation. Re-verify when the versions move.

- Codex reads at most `project_doc_max_bytes` of instructions (32 KiB by default). The plan warns
  when a generated `AGENTS.md` is larger. If `AGENTS.override.md` exists in the Codex home,
  `AGENTS.md` there is ignored; the plan warns about that too.
- Codex loads user skills from its own `skills/` folder and from `~/.agents/skills`, and follows
  links. When the shared folder takes part in a plan, Codex gets no skill links of its own, so a
  skill is not listed twice.
- `codex mcp add` rewrites the MCP tables and drops the block's start comment. The check does not
  depend on the comments: it recognises a definition it wrote by its content, and the next
  repair puts the block back.

## Conflicts

Whatever differs from the primary (`divergent`) or exists only in the other account
(`account-only`) is a conflict. Nothing decides it for the user.

| Option | What it does | Recommend when |
|---|---|---|
| `keep-as-exception` (default) | Leaves the element alone and records it, so later plans stop asking. | The difference is on purpose (an account-specific setting), or nobody has looked yet. |
| `adopt-into-primary` | The account's version becomes the primary's, then the account is linked. For a folder, entries the primary lacks are added; where both have an entry the primary's stays and the account's goes to the backup. | The secondary account has the better or newer version. |
| `replace-with-primary` | The account's version is moved to the backup and the element is linked or generated. For something only the account has, it is moved out of the account. | The account's version is an old copy of the primary's. |

Rules:

1. The default stays `keep-as-exception` until the user has seen the difference. Never recommend
   `replace-with-primary` from the state name alone: read both files (`primaryPath` and
   `accountPath` of the conflict are display paths) and show the diff. For a generated file,
   `plan --drafts <dir>` writes what would be generated, to diff against the current one.
2. An instruction file of another provider cannot be adopted back: merge by hand what should
   survive into the primary first, then replace.
3. An MCP server that exists only in a secondary account stays there. If every account should
   have it, the user adds it to the primary with the provider's own CLI and plans again.
4. A choice other than the default must be explicit: `--resolve <account>:<element>=<option>`
   on `plan`, or `"choice"` plus `"decidedBy": "user"` on that conflict in the plan file. `apply`
   refuses anything else.
5. Any element can be kept apart, conflict or not:
   `--resolve claude-2:settings.json=keep-as-exception`.

## Order in a review

1. **Compare first.** Run `accounts.mjs list` and, once the primary is chosen, `diff`. It tells
   which harnesses are really separate: the review plan depends on it.
2. **Review the primary.** A linked account inherits the primary's findings; reviewing both is
   reviewing the same files twice.
3. **For a linked account, review only its exceptions**: the elements that are `divergent`,
   `account-only` or kept apart.
4. **Fix the primary, then sync.** Linking or replicating before the fixes spreads the problems
   to every account. `plan` comes after the primary's approved items are applied.
5. **Then offer the session-start check.**

## Approval

- Linking and replication are class `sync`: always the user's decision, in guided and in doctor
  mode, with the plan shown first. Show the actions, every conflict with its options, the
  not-portable list and the warnings. `plan` writes nothing; `apply --dry-run` shows what a plan
  file would do right now.
- The session-start check is class `gate`: it runs at every session start of the primary
  account. Offer it after a successful apply and install it only on a yes
  (`accounts.mjs install-check --yes`).
- `apply` and `undo` need `--yes`. Passing it is the record that the user approved; never add it
  on your own.

## Safety

- **Close the other agent apps first.** A running app can rewrite its own config and undo a
  change. The session running the skill cannot close itself: tell the user that its own account
  picks the change up at the next start, and apply while the other apps are closed.
- **Everything replaced is moved, not deleted**, into
  `~/.novarc-powers/novarc-harness-doctor/sync/backups/<stamp>/`. The backups hold the account's
  own earlier files, including anything sensitive they contained: tell the user to delete the
  folder once they are satisfied.
- **Undo is one command**, printed by `apply`: `accounts.mjs undo --stamp <stamp> --yes`. It
  restores the originals byte for byte and removes what the run created, only where each thing
  is still as the run left it; anything edited since is reported and left alone.
- **An undo that could not finish is run again.** Each step is marked in the run's journal the
  moment it is undone, and the run counts as undone only when every step is. This holds for a
  run that died half way as well ("When `apply` itself dies half way", below). When the result
  has `pending` above 0, `conflicts` says why each of those steps is still there (a file edited
  since the run, something else at the original place, a backup out of reach). Clear the cause
  and run the same command: it skips what is already undone (`alreadyUndone`) and retries only
  what is pending. Tell the user what is pending; never report a partial undo as done.
- **`apply` verifies each action** (the link resolves to the primary, the generated file has the
  expected hash, each server reads back as written) and rolls a failed one back. Check its
  `done` list yourself: a result is `done` or `failed`, never assumed.
- **A stale plan is refused.** If an account changed between `plan` and `apply`, plan again and
  show the new plan. The plan signs the content of everything it is about to change, and what a
  link leads to counts as content: a file edited behind a symbolic link, or inside a linked
  folder, makes the plan stale although the link itself did not change. `apply` compares the
  whole plan before it starts, and each element once more right before that step writes. A step
  whose element moved in between is given up with nothing written: its `done` entry is `failed`
  with `"stale": true`, the other steps still run and the exit code is 1. Plan again for it.
- **No file is ever written in place.** New bytes go to a temp file in the same folder (written,
  synced to disk, read back), and that temp file is renamed over the old one: a single step
  that either happened or did not. A symbolic link is kept, and the file it resolves to is
  replaced that way. So a write that fails, and a process that dies at any point of a write,
  leave the file holding its complete old bytes or its complete new bytes: never a mix, never
  an empty file. `apply`, `undo`, `install-check`, `uninstall-check` and `check --repair` all
  write through this one path.
- **A file with other names follows as a whole.** Where symbolic links are refused, a linked
  file is a hardlink: one file under two names (the primary's `settings.json` and the second
  account's). Replacing the file under one name alone would leave the other name on the old
  file, so each KNOWN other name is switched over right after: a link to the new file is made
  under a temp name beside it and renamed over it. Every name therefore holds complete old or
  complete new bytes at every moment. The only in-between state is "one name already new,
  another still old", and it lasts until the switch is done. Known names are the ones the
  manifest records and the same file in another account's folder.

### When a run dies in the middle of a write

Before the first byte of a write, a small record of it goes to
`~/.novarc-powers/novarc-harness-doctor/sync/recovery/`: the file, what it holds and what it
will hold (as hashes, never the content), its other names, and the temp files involved. The
record is removed when the write is done. A run that finds one knows that an earlier run died,
and:

- when the rename had gone through, switches over the other names that still hold the old bytes
  (`completed`, with how many in `relinked`);
- when it had not, removes the temp files: every name is as it was (`rolled-back`);
- never touches a name whose content changed since the death (`abandoned` for the file itself,
  `left` for another name), and never removes or renames anything that is not a temp file of
  this tool, whatever the record says.

`check --repair` (so the session-start hook), `apply`, `undo`, `install-check` and
`uninstall-check` do this before anything else and say what they did: a `recovered` list in
their JSON, a line on stderr, and the first part of the hook's one line (`recovered 1 (...)`).
`list`, `diff`, `plan`, `check` without `--repair` and the dry runs change nothing, as always:
they report the same entries with outcome `pending`. When a result carries `recovered`, tell
the user what it says first; after a `pending`, run `check --repair`.

What this guarantees, and where it stops:

- After a death at any point of a write, every name of the file holds the complete old or the
  complete new bytes, at once and with no repair needed. The next run that may write then
  finishes the switch of the other names, or clears the temp files, by itself, and reports it.
- Between the death and that run, the names of one file can differ: the primary already new, a
  linked account still old. Both are whole files. The account that is behind catches up at the
  next session start of the primary.
- The operation that was running is not resumed: see "When `apply` itself dies half way" below.
- A temp file is named `<file>.nhd-<pid>-<random>.tmp` and is never read as if it were the file.
  Those of a write, a copy or a re-link are removed by the next run that may write; those of
  the tool's own bookkeeping (at the top of its `sync/` folder) once they are a minute old.
- A power cut is covered as far as the disk and the filesystem honour a sync: the record is
  synced before anything else, and the temp file before the rename.
- The file that replaces the old one is a new file on disk. It keeps the permission bits of
  the old one; on Windows it takes the folder's default access rules, and a program that had
  the old file open keeps reading the old bytes until it opens the file again.
- Two runs of the tool at once are not coordinated. A run that starts while another is in the
  middle of a write takes that write for an interrupted one; nothing is torn by it, but the
  other run's step can then fail with nothing changed. Do not start an `apply` while another
  runs, and keep the agent apps closed during one (their session start runs the check).
- When another program holds the file open in a way that forbids replacing it (Windows), the
  write fails with nothing changed: close the app and run again. When that happens for one of
  the OTHER names after the file itself was replaced, the result says so (`warnings` of
  `apply`, `notes` of `install-check`, `note` of `undo`), that name keeps its complete old
  bytes, and the next run that may write tries it again (`waiting` until it works).

### When `apply` itself dies half way

`apply` writes each step into the run's journal BEFORE it makes it (synced to disk) and marks
it done after: a move to the backup, a new folder, a link, a file replaced in the primary, each
file added to a folder of the primary, a folder brought into it, each generated file and edit,
and the manifest. A folder brought into the primary is built under a temp name beside its place
and renamed, so it is there whole or not at all. A run that dies therefore leaves, at worst,
one step that is in the journal and not marked: `undo` and the next `apply` do not take the
journal's word for that step, they look at the disk (is the original in the backup, is the link
there, does the file still hold what it held).

What to do, and what to tell the user:

- `plan` says so first, as its first warning: "An earlier run did not finish ...: <stamp>".
  `apply` says the same (`unfinished: [stamps]`, and a note with the undo command) in its result,
  refused or not.
- `accounts.mjs undo --stamp <stamp> --yes` returns the accounts to the exact bytes they had
  before that run, wherever it died, with nothing to clear by hand. This is the recommended
  move: undo, then apply the plan the user had approved (it is valid again), or plan anew.
- Applying the same plan without the undo is safe as well: it completes when the dead run had
  changed nothing the plan depends on, and is refused as stale otherwise, with nothing written.
- Several runs are undone newest first. Before a new `apply` makes anything, it strikes from a
  dead run's journal the steps that run never got to, so an undo of the dead run cannot take
  the new run's links for its own. Undone in the wrong order, the older run reports "something
  else is at the original place now" for what the newer one put there, and waits.
- `undo` is safe to kill too: run it again and it finishes.

What a death can still leave that `undo` does not take back:

- Changes somebody made after the death. A file edited since, something new at an original's
  place: reported as a conflict and left, exactly as after a run that finished.
- Files inside the tool's own folder: copies in that run's backup folder, a temp file of the
  journal less than a minute old, the installed copy of the check. None of them is part of an
  account.
- `install-check` and `uninstall-check` are one edit of one file. Killed in the middle, the
  hook is either in the file or not, never half: run the same command again.
- Two runs at the same time (see above): a run that is alive is judged like one that died.
- A power cut, as opposed to a process that dies. The journal entry is synced before its step;
  the step itself and its done mark are not, so the last of them may not have reached the disk
  in that order. `undo` judges an unmarked step by the disk, and reports a step marked done
  that it does not find as a conflict.

### Names of a file this tool does not know

A file can have a hardlink this tool never made and finds nowhere: a second name of
`settings.json` kept in a dotfiles folder with `mklink /H` or `ln`. Replacing the file would
leave that name behind on the old content, silently. So the write is refused before anything
changes, with the count: `unknownNames` in the result (the `done[]` entry of `apply`, with
`"decide": true`; the output of `install-check` and `uninstall-check`, with `"refused": true`;
a `conflicts` entry of `undo`), and the message "the file has N other name(s) (hardlinks) that
this tool has no record of". What happens to those names is the user's decision, never the
skill's:

- find them (`fsutil hardlink list <file>` on Windows; `find <folder> -samefile <file>`
  elsewhere);
- remove the ones that are not needed, or turn them into symbolic links to the file (a symbolic
  link follows the file by itself and is not counted);
- run the command again.

The session-start check never writes a file that has a second name (see "Where the check is
allowed to write"), so this comes up in `apply`, `undo`, `install-check` and `uninstall-check`
only.

## The session-start check

`check` reads `sync/manifest.json` and verifies every managed element. With `--repair` it:

- re-creates a link that is gone, or that became a separate copy nobody edited;
- regenerates a generated file or MCP definition whose source changed;
- links what the primary gained: a new import of the instruction file, a new skill;
- follows what the primary dropped: a link that now points nowhere is removed, and a replicated
  MCP definition nobody edited is removed with its source. A file that still has content is left
  and mentioned once. None of this happens while the primary's own folder is missing;
- never overwrites a file somebody edited by hand: it reports it, with both paths, until the user
  decides (edit the primary and delete the copy, or keep it apart with `keep-as-exception`);
- never follows a generated file to a new destination, and never leaves one half written: see
  "Where the check is allowed to write" below;
- first of all, finishes or clears a write that an earlier run died in the middle of (see "When
  a run dies in the middle of a write").

It prints nothing when all is well and one line otherwise, and always exits 0, so it cannot
block a session. `install-check` copies `scripts/sync-check.mjs` (one self-contained file) to
`~/.novarc-powers/novarc-harness-doctor/sync/` and registers it as a `SessionStart` command hook
in the primary's `settings.json`, or in `hooks.json` for a Codex primary, where the user must
also trust it once through `/hooks`. When the hook reports something, tell the user what it
says before doing anything else.

### Where the check is allowed to write

The check runs unattended, so it never writes to a place nobody approved. `apply` records where
each generated file is: the real path of the file and of its folder, that it is a plain file
with one name, and its volume and file ids (`identity` in the manifest). Before a repair the
check looks again and rewrites the file only while the path is still a plain file with no other
name (or is missing), in that same folder, inside the account folder. Otherwise it reports the
element as needing a decision and writes nothing:

| Note in the report | What happened |
|---|---|
| `it became a link to another place` | The generated file was replaced by a symbolic link. |
| `it now shares its content with another file (a hardlink)` | The path is now a second name of some other file. |
| `its folder now leads somewhere else`, `... outside the account folder` | A folder above the file was replaced by a link, or the account folder was moved and linked. |
| `its place was never recorded and cannot be confirmed` | The manifest is from a version that did not record places, and the account folder is a link. |

Two ways out, both the user's choice. Put a plain file back (delete the link; the check
re-creates the file at the next session start). Or plan again: a generated instruction file in
that state shows as `divergent`, where `replace-with-primary` moves whatever sits at the path to
the backup and generates a plain file, and `keep-as-exception` stops managing it. `apply`
records the place it ends up in.

The same rule guards a Codex `config.toml`. When it is a link, has another name or sits behind a
redirected folder, its servers are reported as behind (`manual`) with the reason in the note,
and the file is left to `plan` and `apply`, which write through links on purpose.

A file that an editor or a sync tool saved again with the same bytes is a different file on
disk (another file id) but still a plain file at the recorded place: that alone is not a reason
to refuse, and the check keeps repairing it.

A manifest written before places were recorded has none. The first `check --repair` records one
for each generated file that is provably the generated one: a plain single-name file holding the
generated bytes, with no link anywhere from the account folder down. Anything else is reported
as above until a plan and apply.

## Links on Windows

The preferred link is a symbolic link everywhere. Windows refuses one without Developer Mode or
an elevated shell; then a folder becomes a junction (no privilege needed, same behaviour for
reading) and a file becomes a hardlink.

A hardlink breaks silently when an editor saves the PRIMARY file atomically (write a temp file,
rename it over the original): the secondary keeps the old content. This tool saves that way
too, on purpose, and switches the other names over itself; an editor does not. This is why the
manifest records the content last seen through each link. The check links again when the
secondary still has that content, and reports it instead when somebody edited it. Tell a user
whose files are hardlinks that the session-start check is what keeps them honest, and that
after turning on Developer Mode, `plan --symlinks` followed by `apply` turns the hardlinks
(including ones made by hand) into symbolic links, which survive an atomic save of the primary.

A symbolic link has the mirror weakness: an editor that saves the SECONDARY path atomically
replaces the link with a regular file. The same rule covers it. The habit to teach is simple:
edit the primary.

Where a file cannot be linked at all (symbolic links refused and the two config dirs on
different volumes), it becomes a managed copy: the check copies it again when the primary
changes, under the same never-overwrite rule. `diff` shows it as `generated`.
