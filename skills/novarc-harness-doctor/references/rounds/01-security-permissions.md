# Round 1 — Security and permissions

First, because later rounds read and edit files that may hold credentials, and because a
permission hole makes every other rule optional.

## Check

Start from the rule engine: `probes/<harness>/checks.json` has the round 1 candidates
(`references/checks.md` lists every check and its false positives). Confirm each in the real
file; the checks below are what the engine cannot judge.

Keep one picture in mind while reading: an agent that holds **private data**, reads **untrusted
content** and has **a way out** (network, push, mail) can be talked into leaking. A harness does
not need to remove all three; it needs to know where they meet and put a rule or a gate there.

**Secrets**

- Run `scripts/secret-scan.mjs` over every config dir, every instruction file, MCP server
  definitions, hook scripts, helper scripts the harness calls, and (project scope) tracked files
  plus `.env*` files that are not ignored.
- For each hit: is the file tracked by git, synced to a mirror, or readable by a tool that
  uploads context? That decides severity.
- Check that `.env*`, key files and tool credential files are ignored by git in the project.

**Permissions**

- List allow, deny and ask rules from every settings layer (user, project, local, managed) and
  note which layer wins.
- For each deny rule, test evasion on paper: flag moved to another position, command behind
  `bash -c`, an alias, a different binary that does the same (`rm` vs `git clean`).
- Flag any allow rule for an interpreter or shell with a wildcard argument.
- Find permission prose in instruction files ("never run…", "always ask before…") and check
  whether a rule enforces it. Prose with no rule, or prose contradicted by an allow rule, is a
  finding.
- Note the default permission mode and any "skip permissions" or "full access" default.

**Exposure**

- MCP servers: which run with write access, which hold tokens inline, which are remote.
- Hooks that run on every tool call: what they execute and from where. A hook that runs a script
  from a path any process can write is a finding.
- Plugins and marketplaces from sources the user does not recognise.

## Fix

Rule-engine findings and their usual fix:

| Check | Proposal | Class |
|---|---|---|
| `env-base-url-override` | Ask who owns the endpoint; remove it unless it is a gateway the user runs on purpose | `permission` |
| `mcp-project-auto-approve` | Turn auto-approval off; approve project servers one by one | `permission` |
| `hook-auto-allow` | Make the hook decide on the command it sees, or remove the blanket allow | `permission` |
| `deny-baseline-missing` | Add deny rules for credential folders, `.env` files and piping downloads into a shell | `permission` |
| `hook-swallows-errors` | Let the hook fail visibly, or log the failure where the next review reads it | `reversible` |
| `instructions-hidden-text` | Show the hidden text to the user and remove it; ask where the file came from | `reversible` |
| `instructions-external-import` | Vendor the content into the repo, pinned, or drop the import | `reversible` |
| `skill-shell-injection` | Quote the argument or pass it as data, not as shell text | `reversible` |
| `npm-release-age-gate-missing` | Add the package manager's minimum release age setting (read its docs for the key) | `additive` |

| Finding | Proposal | Class |
|---|---|---|
| Token inline in a config or script | Move to the OS keychain or an untracked env file; rotate if it ever left the machine | `secret` |
| Evadable deny rule | Rewrite to match the dangerous argument anywhere, or replace with a hook that inspects the full command | `permission` |
| Wildcard allow for an interpreter | Narrow to the specific scripts actually used | `permission` |
| Permission prose with no rule | Add the rule, or delete the prose so it stops giving false comfort | `permission` |
| Credential file not ignored by git | Add to `.gitignore`; if already committed, say so — history rewriting is the user's call | `additive` / `external` |
| Unknown plugin source | Ask what it is for before proposing anything | — |

## Verify

Re-run the secret scan. For a permission change, show the user the exact command that was
previously allowed and is now blocked; do not run a destructive command to prove it.
