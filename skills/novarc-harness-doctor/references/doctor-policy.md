# Doctor policy: what is applied without asking

Every item carries a `class`. In guided mode the class is informational; the user decides
everything. In doctor mode the class decides.

| Class | Meaning | Doctor mode | Examples |
|---|---|---|---|
| `reversible` | Edits an existing harness file; a backup restores it exactly. | Apply | Fix a broken `@import`; drop a duplicate plugin record; replace a hardlink with a symlink. |
| `additive` | Adds a file, section or rule; removes nothing. | Apply | Add a missing good-practice rule; add the skills index; add the knowledge-graph instruction. |
| `translate-agent` | Rewrites an agent-facing file in English. | Queue — a wholesale rewrite of the user's instructions is never unattended. Doctor mode prepares the translation in `<ws>/drafts/` so approving it is one step | `CLAUDE.md`, `AGENTS.md`, rules, agent definitions, skill files. |
| `translate-human` | Rewrites a human-facing doc in English. | Queue | `README.md`, user guides, anything customers read. |
| `permission` | Changes what the agent is allowed to do. | Queue | Tighten a deny rule; narrow an allow rule; change permission mode. |
| `secret` | Moves, rotates or removes a credential. | Queue | A token in a config file or script. |
| `delete` | Removes a file, skill, plugin, hook or MCP server. | Queue | An obsolete instruction file; an unused skill. |
| `install` | Installs or updates software. | Queue | A CLI, a plugin, a marketplace. |
| `gate` | Adds a hook or check that can block the user's work. | Queue | A pre-push check; a commit guard. |
| `external` | Acts outside the machine. | Queue | Anything on a remote, a registry, a SaaS dashboard. |

Rules that override the table:

- An item that fits two classes takes the stricter one.
- Moving, replacing or removing an MCP server is always queued, whatever its class: it changes
  what the agent can do, and the user picks between the options round 7 lists.
- Enabling an opt-in feature (round 6) is applied only when the feature was confirmed for the
  installed version in this run and every precondition holds; its `confirm` check runs right
  after, and a failed check reverts it.
- A `reversible` or `additive` item is queued anyway when its backup would hold an unmasked
  secret, when the target file is rewritten by a running app (see `pitfalls.md`), or when the
  file has uncommitted changes in a git repo that the user did not make in this session.
- After each applied item, verify. On a failed verification, restore the backup, mark the item
  `failed`, and continue with the next one. Three failures in a row stop doctor mode and hand
  the queue to the user.
- Doctor mode never commits or pushes. Project-scope changes are left in the working tree and
  listed in the report.
