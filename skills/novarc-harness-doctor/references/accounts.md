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
- **`apply` verifies each action** (the link resolves to the primary, the generated file has the
  expected hash, each server reads back as written) and rolls a failed one back. Check its
  `done` list yourself: a result is `done` or `failed`, never assumed.
- **A stale plan is refused.** If an account changed between `plan` and `apply`, plan again and
  show the new plan.
- **Files are written in place** (open, truncate, write), so a link on `settings.json` survives.
  The one exception is the Claude Code state file, which nothing links to and the app rewrites
  often: there the managed keys are written through a temp file, and the session-start check
  never writes that file at all.

## The session-start check

`check` reads `sync/manifest.json` and verifies every managed element. With `--repair` it:

- re-creates a link that is gone, or that became a separate copy nobody edited;
- regenerates a generated file or MCP definition whose source changed;
- links what the primary gained: a new import of the instruction file, a new skill;
- follows what the primary dropped: a link that now points nowhere is removed, and a replicated
  MCP definition nobody edited is removed with its source. A file that still has content is left
  and mentioned once. None of this happens while the primary's own folder is missing;
- never overwrites a file somebody edited by hand: it reports it, with both paths, until the user
  decides (edit the primary and delete the copy, or keep it apart with `keep-as-exception`).

It prints nothing when all is well and one line otherwise, and always exits 0, so it cannot
block a session. `install-check` copies `scripts/sync-check.mjs` (one self-contained file) to
`~/.novarc-powers/novarc-harness-doctor/sync/` and registers it as a `SessionStart` command hook
in the primary's `settings.json`, or in `hooks.json` for a Codex primary, where the user must
also trust it once through `/hooks`. When the hook reports something, tell the user what it
says before doing anything else.

## Links on Windows

The preferred link is a symbolic link everywhere. Windows refuses one without Developer Mode or
an elevated shell; then a folder becomes a junction (no privilege needed, same behaviour for
reading) and a file becomes a hardlink.

A hardlink breaks silently when an editor saves the PRIMARY file atomically (write a temp file,
rename it over the original): the secondary keeps the old content. This is why the manifest
records the content last seen through each link. The check links again when the secondary still
has that content, and reports it instead when somebody edited it. Tell a user whose files are
hardlinks that the session-start check is what keeps them honest, and that after turning on
Developer Mode, `plan --symlinks` followed by `apply` turns the hardlinks (including ones made by
hand) into symbolic links, which survive an atomic save of the primary.

A symbolic link has the mirror weakness: an editor that saves the SECONDARY path atomically
replaces the link with a regular file. The same rule covers it. The habit to teach is simple:
edit the primary.

Where a file cannot be linked at all (symbolic links refused and the two config dirs on
different volumes), it becomes a managed copy: the check copies it again when the primary
changes, under the same never-overwrite rule. `diff` shows it as `generated`.
