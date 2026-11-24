# Round 7 — CLIs, MCP servers and tools

Which command-line tools are on the machine, which MCP servers load into sessions and at what
level, what is missing given what the user and the project actually do, and which agent add-ons
are worth their cost.

**Default stance: CLI first.** A CLI costs nothing until the agent runs it. An MCP server adds
its tool definitions to the context of every session where it is loaded, whether or not the
session needs it, and many hold credentials in config. Be strict about this; it is one of the
largest recurring costs a harness carries.

## Check

Run `scripts/probe-clis.mjs --cwd <project root>`. It reports, for every CLI in
`references/catalog/tools.json`: installed or not, version, the path it resolved to, whether
more than one binary answers to the name, the package managers present, and the project signals
it matched.

Then list every MCP server with the level it loads at. `scripts/discover.mjs` reports the ones in
config files: user level (`~/.claude.json`, user settings, `~/.codex/config.toml`), project level
(`.mcp.json`), and local level (per-project entries in `~/.claude.json`). Complete the list with
what config files do not show: `claude mcp list` and `/mcp` (servers bundled by plugins, and
connectors that come from the user's claude.ai account). For each server record: level, where it
is defined, transport (local or remote), whether it holds a credential inline, and its context
cost (`/context` in a session, or `claude plugin details <plugin>` for plugin-bundled servers).

Then, by hand:

- **Name collisions.** Two different programs with the same name (a known case: two unrelated
  projects both called `rtk`). Confirm the binary is the one the instructions assume by running
  a subcommand only the right one has.
- **Outdated.** Compare with the latest release only for tools the user relies on daily.
- **Installed and unused.** Mention, do not push.

## MCP policy

Every MCP server gets one item, decided with the table below. Present the options to the user
with the trade-off and your recommendation; in doctor mode these items are queued, because
removing or moving a server changes what the agent can do.

| Situation | Recommendation | Class |
|---|---|---|
| The service has an official CLI (`replacesMcp` in the catalog, or the service's docs) | Install the CLI, walk through its login, add the CLI-first instruction, then disable or remove the server | `install`, then `delete` |
| No CLI, and only some projects need it | Move it to project level (`.mcp.json` in those projects, or local scope if it holds a personal credential) and remove it from user level | `reversible` |
| No CLI, and genuinely useful in nearly every conversation regardless of project | Keep at user level; say why in the item | `none` |
| Connector from the claude.ai account, not needed by this user | Tell the user where to turn it off (claude.ai connector settings); the skill cannot do it | `external` |
| Holds a token inline | Move the token to an env var the server reads or to the OS keychain, and see round 1 | `secret` |
| Required by the project (its docs or team depend on it) | Keep it at project level, committed in `.mcp.json` without secrets | `none` / `reversible` |

The bar for user level is high: "I use it sometimes" means project level or on demand. When in
doubt, propose project level and let the user decide. Two questions settle most cases, and a
server stays at user level only with a yes to both:

1. **Is it universal?** Would nearly every session, in every project, use it?
2. **Does it do what a CLI behind a skill cannot?** Interactive session state, streaming, an
   authentication handshake, structured browsing. A request-and-response API is a CLI's job.

Use the measurement: `impact.unusedContext.mcpServersNeverCalled` names the servers that were
loaded in every session of the window and never called once, and the board's MCP view shows the
call count of each. More than ten servers at one level is a finding by itself, whatever each
one does: every tool definition is paid for in every session.

A server listed in `impact.unusedContext.mcpServersUnknown` (call count `null`) was not measured:
its transcripts could not be fully read. Never propose removing it as unused; say that its use
is unknown and ask the user.

Options to put in front of the user for each server, in this order: replace with CLI; move to
project level; keep at user level; disable for now. One line each on what changes.

## CLI-first instruction

Install it in the user-level instruction file, and in a project's instruction file when the
project uses a service with both a CLI and an MCP server (class `additive`). Generate the list
from what is actually installed:

```markdown
## CLI over MCP

Use the official CLI for these services, reads included: <service → `cli`, one per line>.
Use an MCP server only for what the CLI cannot do, and say so when you do.
```

If the project keeps an MCP server deliberately, add one line saying what it is for, so the
agent does not route around it.

## Logins

For each CLI proposed or installed, guide the login with the `auth` commands in the catalog:

1. Tell the user the login command and let them run it themselves. Most open a browser; never
   ask them to paste a token into the conversation.
2. Prefer the CLI's keychain-backed login over a token in an env file.
3. Run the status command with the user's ok and report logged-in or not. Never print the
   account details or the token.
4. For per-project links (`supabase link`, `vercel link`, `railway link`), do it in the project
   with the user's ok; note that links are often per checkout and a fresh worktree needs it again.

## Decide which CLIs are worth adding

A CLI is proposed only with a signal that justifies it. Signals, from strongest to weakest:

1. The project's files (`supabase/` → the Supabase CLI; a `Dockerfile` → Docker; a deploy
   config for a platform → that platform's CLI; GitHub remote → `gh`).
2. A configured MCP server the CLI can replace.
3. The user's instruction files naming a tool that is not installed.
4. `transcript-signals.mjs` showing a command that failed with "not found".

Do not read shell history. It holds secrets, and this skill is public.

## Token and discipline add-ons

Recommend these at user level, each as its own item, from the catalog entries:

- **`rtk`** — filters command output before it reaches the model.
- **`caveman`** — shorter agent answers and smaller tool output.
- **`ponytail`** — pushes the agent to reuse what exists and write only what the task needs.

They overlap. Before recommending more than one, check what is already doing the same job:
another output filter, an output style that already asks for brevity, a hook that already
rewrites commands. Two tools compressing the same output can hide information the agent needs,
and two tools rewriting the same command can fight. Say which ones you would stack and which
you would pick between, for this user. After installing one, tell the user how to measure it
(each has its own savings report) so the next review can keep or drop it on numbers.

Every install is class `install`: show the exact command from the tool's own documentation and
wait. If an installer changes instruction files or settings, back those up first and list what
it changed afterwards.

## Verify

After an install: the binary resolves, the version prints, the tool's own self-check passes,
and a new session shows it active. After moving or removing an MCP server: `/mcp` in a new
session shows it where intended and nowhere else, and the session's context size dropped by
roughly its cost. Record the files every installer or change touched.
