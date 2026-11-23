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
decisions.jsonl     one decision per line, appended by the board channel or `run.mjs decide`
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
from disk and refuses when the accounts no longer match the plan file. It writes
`~/.novarc-powers/novarc-harness-doctor/sync/manifest.json` (what is managed, with hashes) and
keeps what it replaced under `sync/backups/<stamp>/`; `undo --stamp` puts that back. `check` verifies every
managed link and generated file against the manifest and prints what drifted; `--repair` restores
what is safe (a broken link, a generated file older than its source) and never overwrites a file
the user edited. `install-check` registers `check --repair` to run at session start in the
primary account (a gate: only with the user's yes).

### `snapshot-harness.mjs`

```text
node snapshot-harness.mjs --kind project --cwd <abs> --id <harnessId> [--impact <impact.json>]
node snapshot-harness.mjs --kind user --config-dir <abs> --provider <p> --id <harnessId> [--impact <impact.json>]
```

Output: `{ "harness": {…}, "files": [...], "elements": {…}, "layers": [...] }`, each shaped exactly
as in the state schema (`harnesses[]` entry without scores, `files[]`, `$defs.elements`,
`layers[]`). File content is masked with the secret scanner and capped: 256 KB per file, 3 MB per
harness; over budget, lower-priority files keep their metadata and get `"omitted": "budget"`.
Priority: instruction files and their imports, settings, hook registrations and the scripts they
run, git hooks and CI workflows, MCP config, agent / command / rule files, skill `SKILL.md`
files, then docs (metadata only unless small). File ids are `f<harnessId-hash>-<n>`, stable for
the same path across runs. `--clis <probe-clis.json>` fills `elements.clis`; `--name <label>`
overrides the harness name; `--budget <bytes>` and `--file-cap <bytes>` change the caps (tests).
The account's `.claude.json` never becomes a file: its MCP servers appear as elements only.

### `session-impact.mjs`, `impact-estimates.mjs`

`session-impact.mjs --cwd <abs> [--days 30]` (one project) or `--scope user [--config-dirs <a,b>]`
(every session of those accounts). Its header documents each measure; its output fills
`harnesses[].impact`. Besides raw tokens it gives the **relative cost** in input-token
equivalents (`weightedTotal`, `weightedByKind`, `waste[].weighted`, `contextAtStart.weightedTotal`)
using the price ratios in `references/catalog/pricing-weights.json` (`--weights <file>` to
override); when a call's model has no confirmed ratio the weighted view is left out, with a
note. `skillInvocations` and `mcpCalls` count uses per name.

`impact-estimates.mjs --impact <impact.json> [--clis <clis.json>] [--snapshot <snapshot.json>]
[--discover <discover.json>]` prints `{ "estimates": [ { "label", "tool", "tokens", "weighted",
"source" } ], "unmeasured": [...] }` using the factors in `references/catalog/estimates.json`.
Estimates are never added into measured totals.

### `run.mjs`

```text
node run.mjs init    --select <selection.json> [--mode guided|doctor] [--days 30] [--lang pt|en] [--title <t>] [--agent <name>]
node run.mjs list
node run.mjs status  [--run <id>]
node run.mjs probe   [--run <id>] [--harness <id>|accounts] [--timeout <s>] [--concurrency <n>]
node run.mjs claim   [--run <id>] [--unit <unitId>] --session <label> [--ttl <minutes>]
node run.mjs release [--run <id>] --unit <unitId> --session <label>
node run.mjs complete [--run <id>] --unit <unitId> --session <label> --findings <file>
node run.mjs build   [--run <id>] [--channel artifact|server|file] [--files all|changed] [--no-render]
node run.mjs decide  [--run <id>] --target <itemId|groupId|accounts.primary> --action approve|decline|defer|ask [--note <t>] [--exclude <id,id>] [--answered]
node run.mjs decisions [--run <id>] [--ingest <file.json>]
node run.mjs mark    [--run <id>] --item <id> --status in-progress|fixed|failed [--verified <t>] [--not-verified <t>] [--auto]
node run.mjs record  [--run <id>] --item <id> --path <abs> (--backup <abs> [--masked] | --new)
node run.mjs undo    [--run <id>] (--item <id> | --all) [--dry-run] --yes
node run.mjs next    [--run <id>]
node run.mjs close   [--run <id>]
```

- `init` reads a selection `{ "accounts": [objects from `accounts.mjs list`], "primary": id|null,
  "projects": [objects from `find-projects.mjs`, or bare absolute paths] }`, assigns harness ids
  and keys, writes `run.json` and `queue.json`, prints `{ runId, dir, harnesses }`. `run.json`
  keeps absolute paths; nothing absolute reaches `state.json`.
- `probe` runs `discover`, `harness-checks`, `session-impact`, `snapshot-harness`, `probe-clis`
  and `impact-estimates` for each harness, and `accounts.mjs diff` when there is a primary,
  storing each result under `probes/`. A probe that fails is recorded and does not stop the
  others; the command still exits 0 and reports `failed: n`.
- `claim` takes the next pending unit atomically (exclusive create of the lock file) and prints
  its brief: the harnesses, the rounds, the round files to read, the probe files, and the id
  range. A claim older than its `ttlMinutes` (default 90) can be taken over.
- `complete` validates the findings file and stores it; `release` gives a unit back.
- `build` merges `run.json`, probes, findings, `status.json` and decisions into `state.json`,
  assigns group ids, then runs `render-board.mjs`. It is idempotent.
- `decide` records a decision made in chat; `decisions` ingests new lines of `decisions.jsonl`
  (or a JSON array exported from the Artifact database) into `status.json` and prints what
  changed: `{ "new": [decision...], "approvedByHarness": { "<harness>": [itemIds] }, "questions": [...] }`.
- `decide --answered` clears a question the user asked from the board once it was answered in
  chat.
- `mark` and `record` are what an executor calls after each change. `mark` only moves along
  approved → in-progress → fixed | failed; `fixed` needs `--verified` or `--not-verified`;
  `--auto` (doctor mode, classes `reversible` and `additive` only) takes an open item straight
  to in-progress. `record` hashes the file before (from the backup) and after and appends to
  `ledger.json`; `--new` records a file the run created, `--masked` a backup whose secrets were
  masked.
- `undo` restores backups for an item or the whole run, in reverse order, only where the file
  still has the hash the run left; anything edited since is a conflict and is left alone. A
  masked backup is never restored (it would overwrite the real secret); the item is reported.
- `close` marks the run closed; the local page stops. `list` shows the runs on this machine.
- `next` prints what should happen next: pending units, undecided items, approved items waiting
  per harness, questions waiting for an answer.

### `render-board.mjs`

`node render-board.mjs <state.json> [--out-dir <dir>] [--channel artifact|server|file] [--files all|changed] [--offline] [--lang pt|en]`

Validates the state, computes scores per harness (`references/scoring.md`), writes them back
(only the `scores` keys change), checks that every change is anchored in its file, and writes
`board.html` (one self-contained file) and `board.md`. Prints
`{ "language", "scores": {…}, "warnings": [ { "item", "change", "problem" } ], "bytes" }`.
`--offline` leaves out the web font link. `--files changed` embeds the text of only the files a
change touches (the others keep their metadata), for a board small enough to publish as an
Artifact; the state file on disk is not changed.

### `serve-board.mjs`

`node serve-board.mjs --run <id> [--port 0]`

Serves the run's board on `127.0.0.1` only and prints `{ "url": "http://127.0.0.1:<port>/?t=<token>" }`.

| Route | Does |
|---|---|
| `GET /?t=` | `board.html` |
| `GET /api/state?t=&v=<version>` | `{ "version", "changed": bool }`; the board reloads when it changed |
| `GET /api/decisions?t=` | decisions recorded so far |
| `POST /api/decisions?t=` | appends one decision to `decisions.jsonl` |

Every route needs the token; the server serves no other file, sets no CORS headers, refuses a
`Host` that is not loopback (403), rejects bodies over 16 KB (413) and invalid decisions (400),
stamps each decision with its own clock, and exits after 12 hours or when the run is closed
(409 on writes once closed). Without `--run` it serves the latest run.

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

One decision, wherever it travels:

```json
{ "id": "<uuid>", "at": "<ISO>", "runId": "<runId>", "target": "ACME-104",
  "action": "approve", "note": "optional text", "exclude": [], "via": "board" }
```

`target` is an item id, a group id, or `accounts.primary` (with the chosen account id in `note`).

| Channel | Board side | Session side |
|---|---|---|
| `artifact` (claude.ai Artifact with the `db` capability) | `db.collection("decisions").doc(<target>).set(decision)` | List the `decisions` collection, save it as a JSON array, `run.mjs decisions --ingest <file>` |
| `server` (`serve-board.mjs`) | `POST /api/decisions` | `run.mjs decisions` |
| `file` (board opened from disk) | Copies `run.mjs decide ...` text for the user to paste in chat | The agent runs what the user pasted |

Effect on an item: `approve` → `approved`; `decline` → `declined`; `defer` → `deferred`; `ask` →
stays `open` with `question` set. A group decision applies to every item of the group not listed
in `exclude`.

## Environment variables

| Variable | Used for |
|---|---|
| `NOVARC_POWERS_HOME` | Replaces the home directory for everything the scripts write (tests) |
| `NOVARC_HD_SCRIPT_<NAME>` | Path of a replacement for one probe or the renderer (tests) |
| `NOVARC_HD_PROBE_TIMEOUT_MS` | Timeout of each probe |
| `NOVARC_HD_LOCK_TIMEOUT_MS`, `NOVARC_HD_LOCK_STALE_MS` | Waiting for, and breaking, the run's write lock |
| `NOVARC_HD_SERVE_POLL_MS`, `NOVARC_HD_SERVE_MAX_MS` | Local page: how often it checks the run, and its maximum life |
