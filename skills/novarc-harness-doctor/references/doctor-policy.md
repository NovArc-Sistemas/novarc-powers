# Doctor policy: what is applied without asking

Every item carries a `class`. In guided mode the class is informational; the user decides
everything. In doctor mode the class decides: "Apply" items are marked with
`run.mjs mark --auto` and applied; "Ask" items stay `open` on the board until the user decides.

| Class | Meaning | Doctor mode | Examples |
|---|---|---|---|
| `reversible` | Edits an existing harness file; a backup restores it exactly. | Apply | Fix a broken `@import`; drop a duplicate plugin record; replace a hardlink with a symlink. |
| `additive` | Adds a file, section or rule; removes nothing. | Apply | Add a missing good-practice rule; add the skills index; add the knowledge-graph instruction. |
| `translate-agent` | Rewrites an agent-facing file in English. | Ask. A wholesale rewrite of the user's instructions is never unattended; doctor mode drafts the translation in `<run>/drafts/` so approving it is one step | `CLAUDE.md`, `AGENTS.md`, rules, agent definitions, skill files. |
| `translate-human` | Rewrites a human-facing doc in English. | Ask | `README.md`, user guides, anything customers read. |
| `permission` | Changes what the agent is allowed to do. | Ask | Tighten a deny rule; narrow an allow rule; change permission mode. |
| `secret` | Moves, rotates or removes a credential. | Ask | A token in a config file or script. |
| `delete` | Removes a file, skill, plugin, hook or MCP server. | Ask | An obsolete instruction file; an unused skill. |
| `install` | Installs or updates software. | Ask | A CLI, a plugin, a marketplace. |
| `gate` | Adds a hook or check that can block or slow the user's work. | Ask | A pre-push check; a commit guard; the account sync check at session start. |
| `sync` | Links or replicates one account's harness from another. | Ask, with the plan shown first | Linking a second Claude account to the primary; generating `AGENTS.md` for Codex from the primary's instructions. |
| `external` | Acts outside the machine. | Ask | Anything on a remote, a registry, a SaaS dashboard. |

Rules that override the table:

- An item that fits two classes takes the stricter one.
- Moving, replacing or removing an MCP server always asks, whatever its class: it changes what
  the agent can do, and the user picks between the options round 7 lists.
- Enabling an opt-in feature (round 6) is applied only when the feature was confirmed for the
  installed version in this run and every precondition holds; its `confirm` check runs right
  after, and a failed check reverts it.
- A `reversible` or `additive` item asks anyway when its backup would hold an unmasked secret,
  when the target file is rewritten by a running app (see `pitfalls.md`), when the file is a
  link shared with another account, or when the file has uncommitted changes in a git repo that
  the user did not make in this session.
- After each applied item, verify. On a failed verification, restore the backup, mark the item
  `failed`, and continue with the next one. Three failures in a row stop doctor mode and hand
  the rest to the user.
- An item applied without asking still carries its full `lesson` and its `changes`, so the user
  reads afterwards what changed and why (`references/teaching.md`), and `run.mjs undo --item`
  reverts it.
- Doctor mode never commits or pushes. Changes in a project are left in the working tree and
  listed in the report.

## Item statuses

| Status | Meaning |
|---|---|
| `open` | Needs the user's decision |
| `approved` | The user said yes; waiting for an executor |
| `in-progress` | Being applied |
| `fixed` | Applied and verified |
| `failed` | Applied, verification failed, backup restored |
| `declined` | The user keeps it as it is |
| `deferred` | The user will decide later |
| `ok` | Looked at; nothing to change |
| `not-applicable` | Does not apply to this harness |

A declined recommendation is a choice, not a defect: it counts half in the score, and a harness
is allowed to be deliberately small.
