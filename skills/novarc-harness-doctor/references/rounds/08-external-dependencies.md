# Round 8 — External dependencies and portability

What the harness depends on that the user does not control, and whether the harness survives a
new machine.

## Check

- **Marketplaces and plugin sources.** Each is a repo someone else can change. Note the owner,
  whether it is pinned to a version or follows a branch, and whether it updates automatically.
  Auto-updating instructions from a third-party branch means their next push runs in the user's
  sessions with the user's permissions.
- **Remote MCP servers and hosted services** the harness calls: what breaks when one is down,
  what data goes to it.
- **Skills fetched at run time** (including this one): pinned or latest.
- **Scripts the harness downloads and runs** (`curl | sh`, `npx <package>@latest` in a hook).
- **Scheduled updaters**: what they update, and whether a failed update is noticed.
- **Portability.** Could the user rebuild this harness on a new machine today? Is anything only
  in their head, or only on this disk?

## Fix

The run's own changes are a dependency too: every file the review edits is in the ledger with
its hashes and a backup, so `run.mjs undo` restores a single item or the whole run. Say so in
the report; it is what makes approving easy.

| Finding | Proposal | Class |
|---|---|---|
| Third-party source following a branch, auto-updating | Pin to a version, or switch to notify-then-update | `reversible` |
| Hook runs `@latest` from a registry | Pin the version | `reversible` |
| Dependency with no fallback | Document what breaks and the manual path | `additive` |
| Harness not reproducible | Offer the mirror below | `additive` + `external` |

## The portable mirror (user scope)

Offer once, at close. A private git repo that holds a copy of the user harness, so it can be
restored on another device:

- A `sync` script that copies the harness elements in, **redacts secrets, and then aborts if a
  token pattern survives**. Never bypass the abort.
- An `install` script that puts them back and recreates links.
- Credentials, auth files, session transcripts and project memory never go in.
- A README listing what is covered and what must be set up by hand (logins, keychain entries).

Creating the remote repo and pushing are the user's actions or need their explicit yes
(`external`). Build the local folder, show the first diff, and stop there.

## Verify

For a pinned source: the pin is the version currently installed, and a new session still loads
it. For the mirror: run `sync` twice and confirm the second run is a no-op; run the secret scan
on the mirror folder.
