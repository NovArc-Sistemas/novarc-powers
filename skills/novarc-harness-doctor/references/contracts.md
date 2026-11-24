# Contracts between the scripts

For maintainers and for agents extending the skill. `templates/state.schema.json` is the contract
for the state; this file is the contract for everything around it: the run directory, each
script's command line and output, the findings a reviewer writes, and how decisions travel.

All scripts: Node >= 20, ESM, zero npm dependencies, macOS / Windows / Linux, JSON on stdout,
diagnostics on stderr, exit 0 on success, 2 on bad arguments, 1 on failure. No script prints a
secret, transcript text, or an absolute home path (`~` for home, `./` for a project root).

## Vocabulary

- **Harness**: one user account's agent config (`kind: user`) or one project repo
  (`kind: project`). Each harness is a tab on the board.
- **Account**: one config dir of one provider (`~/.claude`, a second Claude account created by a
  host app, `~/.codex`). An account has exactly one user harness.
- **Primary account**: the account the user chose as the source of truth for the user harness.
  Same-provider accounts are **linked** to it; other providers get the portable subset
  **replicated** from it.
- **Run**: one review over a chosen set of harnesses. It lives on disk, so several sessions can
  work on it and any session can resume it.
- **Unit**: one piece of work in a run that one session (or subagent) claims.
- **Harness key**: short uppercase prefix for item ids, unique in the run: `U1`, `U2` for user
  harnesses, initials of the project name for projects (`ACME`).

## Run directory

`~/.novarc-powers/novarc-harness-doctor/runs/<runId>/`

```text
run.json            selection and settings (written by `run.mjs init`)
queue.json          units and their status (a mirror; the lock files are the truth)
claims/<unit>.lock  one file per claimed unit: {session, at, ttlMinutes}
probes/<harness>/   discover.json checks.json impact.json snapshot.json clis.json estimates.json
                    (<name>.error.json when a probe failed)
probes/accounts/    diff.json, when the run has two or more accounts and a primary
probes/summary.json what the last probe run did
findings/<unit>.json  what a reviewer found (see "Findings file")
groups.json         stable group ids
status.json         overlay of item status changes (decisions, applied, verified)
decisions.jsonl     one decision per line, appended by `run.mjs decide`
log.jsonl           run events, rendered into the state's log
ledger.json         every file change the run applied, with hashes and backup paths
backups/<stamp>/    copies taken before each change (secrets masked or file skipped)
drafts/             proposed files waiting for approval (translations, generated files)
state.json          built by `run.mjs build`; never edited by hand
board.html board.md rendered from state.json
```

`runId` is `<yyyymmdd>-<4 random base36>`. The latest run is also recorded in
`~/.novarc-powers/novarc-harness-doctor/latest.json`. In file names a unit id has `:` and `#`
replaced by `.` (`review.security.2.lock`), because `:` is not allowed on Windows.

Beside `runs/`, `history/` keeps one review record per harness and run
(`history/<harnessKey>/<runId>.json` and `.md`, plus `history/index.json`), written when a run
closes. It is what a later review compares against: `references/follow-up.md`.

## Item ids

`<KEY>-<round><nn>`: harness key, dash, the round number followed by a two-digit counter.
`ACME-104` is the fourth item of round 1 in harness ACME. Reviewers of different rounds can
therefore never collide. Group ids are `G-<n>`, assigned by `run.mjs build`.

## Units

| Unit id | Rounds | What the reviewer does |
|---|---|---|
| `review:security` | 1 | Security and permissions, across every selected harness |
| `review:instructions` | 2, 3 | Instructions, structure and documentation |
| `review:gates` | 4 | Gates and automation, from the measured failures |
| `review:skills-tools` | 6, 7 | Skills, knowledge, CLIs, MCP servers, add-ons |
| `review:cleanup-deps` | 5, 8 | Cleanup and external dependencies |
| `accounts` | - | Account comparison and the linking / replication plan |
| `apply:<harness>` | - | Applies what the user approved in that harness; one writer per harness |

With more than 6 harnesses a review unit is split into chunks of 6: `review:security#1`,
`review:security#2`. The `accounts` unit exists when the run has two or more accounts; it owns no
round, and its items use the id block `<KEY>-9nn`. `apply:<harness>` units are derived, not
stored: one exists while a harness has approved items, and it is completed without a findings
file.

## Scripts

### `find-projects.mjs`

`node find-projects.mjs [--roots <dir,dir>] [--days 30] [--max-depth 4]`

Finds git repositories with agent activity or harness files. Sources: the working directories
recorded in agent session transcripts (every account), plus any `--roots` scanned for `.git`
down to `--max-depth` (skipping `node_modules`, build and cache folders). Worktrees are folded
into their main repository.

```json
{ "projects": [ { "name": "acme-shop", "path": "~/dev/acme-shop", "pathAbs": "<absolute>",
    "sessions": 412, "lastActive": "<ISO>", "worktrees": 3, "isCode": true,
    "signals": ["CLAUDE.md", "AGENTS.md", ".claude/", ".mcp.json", "graphify-out/", ".github/workflows"],
    "providers": ["claude-code", "codex"], "suggested": true } ],
  "skipped": [ { "path": "~/old", "reason": "no activity in window and no harness files" } ] }
```

`pathAbs` is the one place an absolute path is printed; it exists so the caller can pass it back
as `--cwd`. It must never be copied into the state. A project is listed (`suggested: true`) when
it had sessions in the window or has harness files; everything else goes to `skipped` with the
reason. `--config-dirs <a,b>` restricts which accounts' transcripts are read. The output also
carries `generatedAt`, `windowDays`, `scanned` (what was read) and `durationMs`.

### `accounts.mjs`

```text
node accounts.mjs list
node accounts.mjs diff   --primary <accountId>
node accounts.mjs plan   --primary <accountId> [--out <plan.json>] [--resolve <account>:<element>=<option>]...
node accounts.mjs apply  --plan <plan.json> [--dry-run] --yes
node accounts.mjs undo   --stamp <stamp> --yes
node accounts.mjs check  [--repair]
node accounts.mjs install-check --yes | uninstall-check --yes
```

`list` → `{ "accounts": [ { "id": "claude-1", "provider": "claude-code", "label": "Claude Code · account 1",
"identity": "wi…@example.com", "path": "~/.claude", "pathAbs": "<absolute>", "isDefault": true,
"host": null, "linksInto": null } ] }`. `linksInto` names the account id this account's files
already link to, when they do.

`list`, `diff` and `plan` take `--lang pt|en`: labels, notes and reasons come in that language,
machine fields never change. Each `list` entry also has `elements` (how many harness elements the
config dir holds) and `empty`; each `diff` entry has `suggested` (`link`, `replicate`, `none`) and
a one-line `suggestionText`.

`diff` → per secondary account, per harness element: `{ "name", "state": "linked" | "generated" |
"copied" | "divergent" | "missing" | "account-only" | "not-portable", "note" }` (the schema's
`accounts.list[].sync.elements`), plus `"mode"` and `"status"`.

`plan` → an ordered list of actions (`link`, `generate`, `copy`, `backup`, `skip`) with, for each,
the display path, what it replaces and why; plus `conflicts`: elements that exist only in a
secondary account or differ from the primary, each needing a decision (bring into the primary,
keep as an account exception, or drop). Nothing is written.

Conflict options are `keep-as-exception` (the default), `adopt-into-primary` and
`replace-with-primary`; a non-default choice must be recorded as the user's
(`--resolve`, or `"decidedBy": "user"` in the plan file). `list` also reports `inUse`: the
account this very session runs on.

`apply` executes a plan: backup first, then link or generate, then verify. It rebuilds the plan
from disk and refuses when the accounts no longer match the plan file. A plan signature covers
the content behind a link, not only where the link points, and each step checks its element
again right before writing: a step whose element changed after the plan ends as
`{ "result": "failed", "stale": true, "error": "... plan again" }` with nothing written for it,
the other steps still run, and the exit code is 1. Every step is journalled as an intent before it
is made, so a run that died half way can be undone back to the exact starting tree: `plan`
warns about such a run and `apply` names it in `unfinished: [stamps]`. It writes
`~/.novarc-powers/novarc-harness-doctor/sync/manifest.json` (what is managed, with hashes and,
for generated files, the `identity` of the destination) and keeps what it replaced under
`sync/backups/<stamp>/`.

`undo --stamp` puts that back, one step at a time. Its output has `restored`, `pending` and
`alreadyUndone`; `ok` and the exit code follow `pending`. A step that could not be undone (its
file was edited since: see `conflicts`) stays pending, and running the same `undo` again retries
only the pending steps.

`check` verifies every managed link and generated file against the manifest and prints what
drifted; `--repair` restores what is safe (a broken link, a generated file older than its
source) and never overwrites a file the user edited. A repair writes a generated file only when
it is still a plain file with a single name, in the folder recorded for it, inside the account
folder. A destination that became a link, gained a second name (hardlink) or whose folder now
leads elsewhere is reported with `decide: true` (Codex MCP block: `manual: true`) and a note, and
is not written.

**No file is ever written in place.** New bytes go to a synced temporary file that is renamed
over the old one, and each known other name of the file (a hardlink in another account folder)
is then switched to the new file by a rename of its own. After a failure or a process death at
any point, every name holds its complete old bytes or its complete new bytes. A record written
under `sync/recovery/` before the first byte lets the next run that may write (`check --repair`,
so the session-start check, `apply`, `undo`, `install-check`, `uninstall-check`) finish the
switch or clear the temporary files, and it says what it did: `recovered: [{ file, outcome }]`,
with `outcome` one of `completed`, `rolled-back`, `abandoned`, `waiting`, `removed`,
`pending`, `conflict`. Read-only commands only report `pending`. Right before each rename the
file, and each other name, is looked at once more: one that changed since the write was
prepared is left exactly as it is and reported (`left`), and when the file itself changed
nothing is written. A path counts as the same place only while its folder is the same real
folder: recovery, undo and the unattended repair do nothing in a folder that was moved,
replaced or redirected since it was recorded (`conflict`, `foreign`, or a "needs attention"
line asking for a new plan and apply). A file with a hardlink the tool has no
record of is not written at all: the command reports it with the count (`unknownNames`), and
the user removes that name or turns it into a symlink.

`install-check` registers `check --repair` to run at session start in the primary account (a
gate: only with the user's yes).

### `snapshot-harness.mjs`

```text
node snapshot-harness.mjs --kind project --cwd <abs> --id <harnessId> [--impact <impact.json>]
node snapshot-harness.mjs --kind user --config-dir <abs> --provider <p> --id <harnessId> [--impact <impact.json>]
```

Output: `{ "harness": {…}, "files": [...], "elements": {…}, "layers": [...] }`, each shaped exactly
as in the state schema (`harnesses[]` entry without scores, `files[]`, `$defs.elements`,
`layers[]`). File content is masked and capped. Masking is by key first: every string under a
key named like a secret (password, token, secret, credentials, api key and the like), in JSON,
TOML, YAML, `KEY=value` lines and command flags, whatever its length, descendants included;
then by known token shapes. Under such a key a value stays readable only when ALL of it is a
reference (`${VAR}`, `$VAR` in upper case, `$(command)`, `%VAR%`, `<placeholder>`, code that
reads the environment); a reference with any literal around it, and a number, are masked. When
in doubt it masks: a lower-case `$token` in a script shows masked too. A key is judged as it
reads, not as it is spelled (`"pass\u0077ord"` is `password`), and an expression is exempt only
when it can be shown to carry no literal of its own (`$(op read ...)` yes, `$(echo text)` no;
`process.env.X` yes, `process.env.X || "text"` no). A masked value keeps its first four characters and its length
(`abcd…29`), or only the length when it is short (`…7`). Caps: 256 KB per file, 3 MB per
harness; over budget, lower-priority files keep their metadata and get `"omitted": "budget"`.
Priority: instruction files and their imports, settings, hook registrations and the scripts they
run, git hooks and CI workflows, MCP config, agent / command / rule files, skill `SKILL.md`
files, then docs (metadata only unless small). File ids are `f<harnessId-hash>-<n>`, stable for
the same path across runs. `--lang pt|en` words the layer names and notes and the notes of hooks,
plugins and MCP servers in the run language (machine fields never change); `run.mjs probe` passes
it. `--clis <probe-clis.json>` fills `elements.clis`; `--name <label>`
overrides the harness name; `--budget <bytes>` and `--file-cap <bytes>` change the caps (tests).
The account's `.claude.json` never becomes a file: its MCP servers appear as elements only.

### `session-impact.mjs`, `impact-estimates.mjs`

`session-impact.mjs --cwd <abs> [--days 30]` (one project) or `--scope user [--config-dirs <a,b>]`
(every session of those accounts). Naming accounts also narrows what counts as configured:
`~/.claude.json` is read only when the default `~/.claude` is among the dirs named, and
`~/.agents/skills` only when no account is named. Its header documents each measure; its output fills
`harnesses[].impact`. Besides raw tokens it gives the **relative cost** in input-token
equivalents (`weightedTotal`, `weightedByKind`, `waste[].weighted`, `contextAtStart.weightedTotal`)
using the price ratios in `references/catalog/pricing-weights.json` (`--weights <file>` to
override); when a call's model has no confirmed ratio the weighted view is left out, with a
note.

Every aggregate (tokens, context, waste, tool calls, MCP calls, skill invocations, shell output)
comes from the same counted events: inside the window, and counted once when a session was
copied into a second file. Codex tool calls are read from every rollout shape (`response_item`
call items, `exec_command_end` / `mcp_tool_call_end` events, `item_completed` items) and counted
once per call id.

**A count that was not measured is `null`, never 0.**

| Field | Meaning |
|---|---|
| `skillInvocations`, `mcpCalls` | Uses per configured name: a number, or `null` when absence could not be established |
| `unusedContext.skillsNeverInvoked`, `.mcpServersNeverCalled` | Names measured as 0 uses |
| `unusedContext.skillsUnknown`, `.mcpServersUnknown` | Names whose count is `null`. Never propose removing one of these as "unused" |
| `coverage.<source>.toolCalls` | `complete`, `partial` (some lines unparsable: `null` only for names those lines mention), `unknown` (a file unreadable or a call record in an unread shape: `null` for every name that source could have used), `not-read` |
| `notes` | Says in words what was not fully read |

`impact-estimates.mjs --impact <impact.json> [--clis <clis.json>] [--snapshot <snapshot.json>]
[--discover <discover.json>]` prints `{ "estimates": [ { "label", "tool", "tokens", "weighted",
"source" } ], "unmeasured": [...], "unknownUsage": { "skills": [...], "mcpServers": [...] },
"skipped": [...] }` using the factors in `references/catalog/estimates.json`. Estimates are never
added into measured totals, and an "unused" estimate is built only on a measured zero.

### `run.mjs`

```text
node run.mjs init    --select <selection.json> | --follow-up <runId|latest>  [--mode guided|doctor] [--days 30] [--lang pt|en] [--title <t>] [--agent <name>]
node run.mjs list
node run.mjs history [--harness <key|path>] [--json] | history --write [--run <id>]
node run.mjs status  [--run <id>]
node run.mjs probe   [--run <id>] [--harness <id>|accounts] [--timeout <s>] [--concurrency <n>]
node run.mjs claim   [--run <id>] [--unit <unitId>] --session <label> [--ttl <minutes>]
node run.mjs release [--run <id>] --unit <unitId> --session <label>
node run.mjs complete [--run <id>] --unit <unitId> --session <label> --findings <file>
node run.mjs build   [--run <id>] [--channel artifact|server|file] [--files all|changed] [--no-render] [--agent <name>]
node run.mjs decide  [--run <id>] --target <itemId|groupId|accounts.primary> --action approve|decline|defer|ask [--note <t>] [--exclude <id,id>] [--rev <rev>] [--answered]
node run.mjs decisions [--run <id>] [--ingest <file.json|directory>]
node run.mjs mark    [--run <id>] --item <id> --status in-progress|fixed|failed [--rev <rev>] [--verified <t>] [--not-verified <t>] [--auto]
node run.mjs record  [--run <id>] --item <id> --path <abs> (--backup <abs> [--masked] | --new)
node run.mjs undo    [--run <id>] (--item <id> | --all) [--dry-run] --yes
node run.mjs next    [--run <id>]
node run.mjs close   [--run <id>]
node run.mjs --help | <command> --help
```

`--help` and `-h` print the usage of the script or of one command and run nothing. An option a
command does not know is an error (exit 2), so a mistyped flag is never silently ignored.

- `init` reads a selection `{ "accounts": [objects from `accounts.mjs list`], "primary": id|null,
  "projects": [objects from `find-projects.mjs`, or bare absolute paths] }`, assigns harness ids
  and keys, writes `run.json` and `queue.json`, prints `{ runId, dir, harnesses }`. `run.json`
  keeps absolute paths; nothing absolute reaches `state.json`. Each harness also gets its
  `harnessKey` (stable across runs) and, when it was reviewed before, `lastRecord` and its own
  `windowDays`; the output then has `harnesses[].followUp { runId, reviewedAt, days,
  windowDays }`. `--follow-up <runId|latest>` takes the selection, mode and language from that
  run instead of `--select`, reports folders that no longer exist under `dropped`, and sets
  `followUpOf`. `unrecordedRuns` names earlier runs that have no review record yet
  (`history --write --run <id>` writes them).
- `probe` runs `discover`, `harness-checks`, `session-impact`, `snapshot-harness`, `probe-clis`
  and `impact-estimates` for each harness, and `accounts.mjs diff` when there is a primary,
  storing each result under `probes/`. A probe that fails is recorded and does not stop the
  others; the command still exits 0 and reports `failed: n`.
- `claim` takes the next pending unit atomically (exclusive create of the lock file) and prints
  its brief: the harnesses (each with `lastRecord.file`, the absolute path of its last review
  record, when there is one), the rounds, the round files to read, the probe files, and the id
  range. A claim older than its `ttlMinutes` (default 90) can be taken over.
- `complete` validates the findings file and stores it; `release` gives a unit back. A reviewer
  may only set `open`, `ok` or `not-applicable`: a decline is the user's, and one made in an
  earlier review is carried by the run when the same proposal comes back with `previous`
  (output `declinedBefore: { same: [...], changed: [...] }`). It refuses
  a file that holds a credential, naming where (`/items/0/evidence: credential (github-token)`)
  and never the value. When an item the user already decided comes back as another revision,
  that decision no longer holds: the item is `open` again and the output lists it under
  `invalidated: [{ item, was, decidedRev, currentRev }]`. An item that is being applied or is
  fixed cannot change its proposal.
- `build` merges `run.json`, probes, findings, `status.json` and decisions into `state.json`,
  assigns group ids, writes the revision (`rev`) of every item and group, then runs
  `render-board.mjs`. It is idempotent. As a last barrier it masks any credential still in the
  state and reports it in `mergeWarnings` (`credential masked at <pointer>`); the board still
  builds. For a harness with a review record it also writes `history` and `followUp`
  (`references/follow-up.md`).
- `decide` records a decision made in chat; `decisions` ingests new lines of `decisions.jsonl`,
  a JSON array exported from the Artifact database, or a directory with one JSON document per
  file, into `status.json` and prints what changed:
  `{ "new": [decision...], "approvedByHarness": { "<harness>": [itemIds] }, "questions": [...],
  "stale": [...], "rejected": [...] }`. `stale` lists decisions made on a revision that is no
  longer the current one (`{ target, action, decidedRev, currentRev, reason, reopened? }`):
  nothing was applied for them, and the user has to decide again on the current board.
- `decide --answered` clears a question the user asked from the board once it was answered in
  chat.
- `mark` and `record` are what an executor calls after each change. `mark` only moves along
  approved → in-progress → fixed | failed, and only while the approved revision is still the
  current one (pass `--rev` from the brief's `revs` to make that explicit); `fixed` needs `--verified` or `--not-verified`;
  `--auto` (doctor mode, classes `reversible` and `additive` only) takes an open item straight
  to in-progress. `record` hashes the file before (from the backup) and after and appends to
  `ledger.json`; `--new` records a file the run created, `--masked` a backup whose secrets were
  masked.
- `undo` restores backups for an item or the whole run, in reverse order, only where the file
  still has the hash the run left; anything edited since is a conflict and is left alone. A
  masked backup is never restored (it would overwrite the real secret); the item is reported.
- `close` writes the review record of every harness (`references/follow-up.md`), then marks the
  run closed; the local page stops. Output: `{ runId, closed, closedAt, already?, historyDir,
  records: [{ harness, harnessKey, file, md, items, fixed, written }] }`. It exits 1 and leaves
  the run open when a record does not fit its schema. `history --json` may add
  `ignored: [{ harness, file, reason }]` (files in `history/` that are not usable records) and
  `healed` (an index or `.md` rebuilt from the records). Any command adds `lockLost: true` when
  it outlived the run lock and another process may have written meanwhile. Once a run has records, every command that changes
  a status (`decide`, `decisions`, `complete`, `mark`, `record`, `undo`) writes them again and adds
  `records` to its output, or `recordsNotWritten` with the reason. `history --json` prints
  `{ historyDir, at, harnesses: [{ key, kind, provider, name, path, reviews, followUpAfter,
  due }], due, unrecordedRuns }`. `list` shows the runs on this machine; `history` shows what
  was reviewed before, per harness, and which follow-ups are due.
- `next` prints what should happen next: pending units, undecided items, approved items waiting
  per harness, questions waiting for an answer, and `decideAgain`: items whose proposal changed
  after the user decided.

### `render-board.mjs`

`node render-board.mjs <state.json> [--out-dir <dir>] [--channel artifact|server|file] [--files all|changed] [--offline] [--lang pt|en]`

Validates the state, computes scores per harness (`references/scoring.md`), writes them back
(only the `scores` keys change), checks that every change is anchored in its file, and writes
`board.html` (one self-contained file) and `board.md`. Prints
`{ "language", "scores": {…}, "warnings": [ { "item", "change", "problem" } ], "bytes" }`.
`--offline` leaves out the web font link. `--files changed` embeds the text of only the files a
change touches (the others keep their metadata), for a board small enough to publish as an
Artifact; the state file on disk is not changed.

The channel decides the shape of `board.html`:

| Channel | `board.html` is |
|---|---|
| `server`, `file` | A standalone document (doctype, head, body) |
| `artifact` | E-mail addresses are masked in everything it embeds, file text included, because this copy leaves the machine (a change that can no longer be placed in its file once masked is listed under `warnings`). A page fragment for the Artifact publisher, which adds its own document around it: `<title>` first, then styles, content and inline scripts, with no doctype, `html`, `head` or `body` tag. The embedded data is printed one entry per line so the publishing agent can read and patch it. Do not open this file from disk or serve it: build again with `--channel server` for the local page |

The board is view-only: it has no decision control and sends nothing back; its Pending view
(`#/pending`, old `#/decide` links open it) lists what waits for a decision by id. A side index
lists the harnesses (accounts, then projects) and the sections of the open page. A change in a
file can be put in focus with `?c=<item>.<change>` in the route. The page data carries
`hookEvents`, the hook lifecycle the explorer draws, checked against the blocking tables of
`lib/snapshot/elements.mjs` by a test.

The board remembers the open route per run in the browser's storage and reopens it after a
reload when the URL has no hash; it works the same without storage.

### `serve-board.mjs`

`node serve-board.mjs --run <id> [--port 0]`

Serves the run's board on `127.0.0.1` only and prints `{ "url": "http://127.0.0.1:<port>/?t=<token>" }`.

| Route | Does |
|---|---|
| `GET /?t=` | `board.html` |
| `GET /api/state?t=&v=<version>` | `{ "version", "changed": bool }`; the board reloads when it changed |
Every route needs the token; any request that is not a `GET` is refused (405), before the token
is checked. The server
serves no other file, sets no CORS headers, refuses a `Host` that is not loopback (403), and
exits after 12 hours or when the run is closed. Without `--run` it serves the latest run.

## Findings file

What a reviewer hands to `run.mjs complete`:

```json
{ "unit": "review:security", "session": "claude-main", "completedAt": "<ISO>",
  "rounds":    [ { "harness": "acme-shop", "round": 1, "status": "done" } ],
  "items":     [ { "...": "a state item; status defaults to open" } ],
  "inventory": [ ], "defenses": [ ], "leads": [ ], "layers": [ ],
  "groups":    [ { "title": "...", "round": 2, "summary": "...", "items": ["U1-201", "ACME-203"] } ],
  "elements":  { "acme-shop": { "skills": [ { "name": "x", "verdict": "retire", "reason": "..." } ] } },
  "fileRoles": { "fabc-3": "Blocks force-push before the command runs." } }
```

`elements` entries are merged by `name` (hooks by `id`) into the snapshot's elements: a reviewer
adds verdicts, notes and item links, never the base inventory.

## Decisions

**The board is view-only.** The user reads it and decides in the conversation with the agent,
which records each decision with `run.mjs decide`. The board shows the decisions recorded so
far, and its Pending tab lists what still waits, by id.

One decision:

```json
{ "id": "<uuid>", "at": "<ISO>", "runId": "<runId>", "target": "ACME-104",
  "action": "approve", "note": "optional text", "exclude": [], "rev": "0a1b2c3d4e5f", "via": "chat" }
```

`target` is an item id, a group id, or `accounts.primary` (with the chosen account id in `note`).

**A decision is about one revision.** `rev` is the revision of the item or group the user was
looking at. `run.mjs decide` takes the current one unless `--rev` is given; a decision that
arrives without one through `decisions --ingest` is bound to the revision in the last built
board. A decision whose `rev` is
not the current revision is not applied (it comes back under `stale`).

- Item `rev`: the first 12 hex characters of a SHA-256 over the canonical JSON (sorted keys, no
  whitespace, absent fields as `null`) of what would be applied: `harness`, `class`,
  `proposal`, `file`, and for each change `file`, `path`, `before`, `after`, `insertAfter`.
  Wording (title, lesson, each change's `why`), severity and status are not part of it.
- Group `rev`: the same hash over its members' `itemId:rev`, sorted.
- `state.json` holds the authoritative values; never compute them by hand.

A note that holds a credential is refused.

**Privacy of what the run writes and prints.** `state.json`, the review records and every
answer of `run.mjs` pass the same barriers: credentials masked; the home directory as `~`; and
in prose fields (titles, findings, evidence, opinions, lessons, notes, log text; not file
content, not the text of a change, not the proposal) e-mail addresses masked and absolute paths
outside the run's harnesses cut to their last two segments. `build` reports how many places it
rewrote. Data read back from disk (records, the index, file names given to `--ingest`) is
untrusted and goes through the same barriers before it is used or printed.

Effect on an item: `approve` → `approved`; `decline` → `declined`; `defer` → `deferred`; `ask` →
stays `open` with `question` set. A group decision applies to every item of the group not listed
in `exclude`.

## Discovery and checks for one account

`discover.mjs`, `harness-checks.mjs` and `probe-clis.mjs` take `--provider <p> --config-dir <abs>`
(both or neither) to read one account only; `run.mjs probe` passes them for every user harness,
so the probes of one account hold nothing of another. Without them the scripts read every
account on the machine, as before. With them the output has
`account: { provider, path, supported }`; `supported: false` means the skill has no reader for
that provider's config, and `harness-checks.mjs` then lists every check under `skipped` instead
of printing an empty result that would read as a pass. `probe-clis.mjs --tools-from <clis.json>` reuses
what an earlier output found installed on the machine and recomputes only the account part, so
the machine is probed once per run.

## Environment variables

| Variable | Used for |
|---|---|
| `NOVARC_POWERS_HOME` | Replaces the home directory for everything the scripts write (tests) |
| `NOVARC_HD_NOW` | Replaces the run library's clock: RFC 3339 or epoch milliseconds (tests) |
| `NOVARC_POWERS_TEST_FAULT` | Makes one write of the account sync fail at a named stage (tests) |
| `NOVARC_HD_SCRIPT_<NAME>` | Path of a replacement for one probe or the renderer (tests) |
| `NOVARC_HD_PROBE_TIMEOUT_MS` | Timeout of each probe |
| `NOVARC_HD_LOCK_TIMEOUT_MS`, `NOVARC_HD_LOCK_STALE_MS` | Waiting for, and breaking, the run's write lock |
| `NOVARC_HD_SERVE_POLL_MS`, `NOVARC_HD_SERVE_MAX_MS` | Local page: how often it checks the run, and its maximum life |
