# Orchestration: one run, many harnesses, several workers

A run can cover a dozen harnesses. Reading is safe to parallelise; writing is not. So the run is
split into **review units** that any number of workers take in parallel, and **apply units**
with exactly one writer per harness. The session that started the run is the **owner**: it
holds the board, talks to the user and hands out work. Everything a worker learns goes into the
run directory, never only into a conversation, so a worker can stop and another can resume.

## Roles

| Role | How many | Reads | Writes |
|---|---|---|---|
| Owner | 1 | Everything in `<run>` | `run.mjs` commands, the board, the report |
| Reviewer | 1 per review unit | Probes of every harness in the unit, the harness files, the round files | One findings file |
| Executor | 1 per harness with approved items | The approved items of that harness | That harness's files, backups, ledger entries |

Why reviewers go by layer and not by harness: with ten projects, ten generalists would each
redo the same reasoning. A specialist per layer reads one or two round files, sees the same
problem repeated across projects, and turns it into one group decision instead of ten items.

Why executors go by harness: two writers in one repository overwrite each other. One writer per
harness also keeps backup and verification in one place.

## With subagents

1. After `run.mjs probe`, start one subagent per pending review unit (at most 5 at a time).
   Give each the brief below. The owner stays with the user.
2. When a reviewer finishes, check its findings file exists and `run.mjs complete` accepted
   it. A reviewer's summary is a claim; the file is the result.
3. `run.mjs build`, show the board.
4. As decisions arrive, start one executor per harness that has approved items (at most 3 at a
   time), with the executor brief. Never two executors on the same harness.
5. After each executor reports, verify a sample of its changes yourself, then rebuild.

### Reviewer brief

Fill in the brackets; send nothing less:

```text
You are a reviewer in a harness review run. Skill folder: [<skill> absolute path].
Run: [runId]. Claim your unit and read its brief:
  node [<skill>]/scripts/run.mjs claim --run [runId] --unit [unitId] --session [label]
The brief lists the harnesses, the rounds, the round files to read and the probe files.
Read also references/teaching.md, references/pitfalls.md, references/checks.md and
references/contracts.md ("Findings file", "Item ids").
Rules: read-only, you change no harness file. Rule-engine output is candidates: open the real
file and confirm each before it becomes an item. Mask secrets. Every item needs its lesson
(why, impact, better, principle, tradeoff), exact changes copied from disk with a `why` each,
`origin` when the file is not live configuration, and `saves` with its `metric` when the
measurement supports a number. Record what is fine as inventory and defenses. The same finding
in several harnesses is one group. When the brief names an earlier review record for a harness,
read its items first and follow "Reviewing a harness again" in references/follow-up.md: link
every finding that was seen before with `previous`; for one the user declined, send the same
proposal copied from the record when nothing changed (the decline is then carried), or say what
changed. You never set `declined` yourself. Write user-facing text in [language]. When done:
  node [<skill>]/scripts/run.mjs complete --run [runId] --unit [unitId] --session [label] --findings [file]
Report: how many items per harness and severity, what you could not check, and anything the
other rounds should know.
```

### Applying an item about a secret

The board and the findings never hold the secret: `changes[].before` shows the masked form the
snapshot has (`"GITHUB_TOKEN": "ghp_…40"`). The executor finds the real line by the surrounding
text, the visible prefix and the length, backs the file up **with the secret masked**, records
it with `run.mjs record --masked` (undo then leaves that file alone, it never writes a masked
value over a real one), and tells the user to rotate the credential: removing it from a file
does not un-leak it.

### Executor brief

```text
You are the executor for harness [harnessId] in run [runId]. Skill folder: [<skill>].
You are the only one allowed to edit this harness. Apply exactly these approved items, in this
order: [item ids]. For each: read the item in [<run>]/state.json; re-read the target file now;
if the text the change expects is no longer there, stop that item and report. Otherwise:
  run.mjs mark --run [runId] --item [id] --status in-progress
  copy the file to [<run>]/backups/[stamp]/ (mask secrets, or skip the copy and say so)
  make exactly the change shown, in place (open, truncate, write; no temp-file-and-rename)
  verify as the item says; then
  run.mjs record --run [runId] --item [id] --path [file] --backup [backup]
    (a file you created: --new instead of --backup; a backup with secrets masked: add --masked)
  run.mjs mark --run [runId] --item [id] --status fixed --verified "[what you checked]" --not-verified "[what you could not]"
On a failed verification restore the backup and mark the item failed. Never install software,
commit or push. When every item is done: run.mjs complete --run [runId] --unit apply:[harnessId]
--session [label]. Report per item: done or failed, and what you verified.
```

## Without subagents

Take the review units yourself, in the order `run.mjs claim` hands them out, one at a time, then
the apply units harness by harness. The board and the decisions are identical; it only takes
longer. The run can be paused at any point: `run.mjs next` says where it stands.

## Several sessions

The user can open more sessions (same agent or another one) and tell each "join harness-doctor
run <id>". A joining session runs `run.mjs status --run <id>` and claims units like any worker.
Only the owner renders the board and applies decisions about accounts. If the owner session is
gone, any session can take over: the run directory is the whole truth.

A claim expires after 90 minutes without `complete`; another worker may then take the unit.

## Limits

- At most 5 reviewers and 3 executors at once. More does not finish sooner and costs tokens.
- A reviewer that returns nothing for a harness still marks its rounds (`done` with no items is
  a full score for that round; `skipped` says why).
- Never start an executor for an item the user has not approved, whatever the mode says about
  safe classes: in doctor mode the owner marks the safe items itself with `mark --auto` first.
