---
name: novarc-harness-doctor
description: Use when someone wants their AI coding agent setup reviewed, measured, explained or fixed - "review my harness", "harness doctor", "audit my CLAUDE.md / AGENTS.md", "why does my agent keep failing on this project", "how many tokens am I wasting", "too many MCP servers", "which CLIs or plugins should I install", "set up gates for this project", "keep my Claude and Codex accounts in sync", "did the last harness review work", "review my harness again". Reviews every user account's harness and any number of project harnesses in one run, measures what they cost over the last 30 days of sessions, and shows each finding with the why and a before/after diff on one interactive board where the user decides. Records every review, so a later run measures whether the expected effect happened and reviews each harness again. Guided or doctor mode. Works in Claude Code, Codex and any agent with file and shell access.
---

# novarc-harness-doctor

A harness is everything that shapes an agent session before the user types: instruction files,
permissions, hooks, skills, plugins, MCP servers, CLIs, and a project's docs and gates. A machine
has one **user harness per account** (each Claude Code account, Codex, and so on) and one
**project harness per repository**. This skill finds them, measures what they cost, explains what
is wrong and why, and fixes what the user approves.

`<skill>` is the folder this file is in. A review is a **run** that lives on disk at
`~/.novarc-powers/novarc-harness-doctor/runs/<runId>/` (`<run>` below), so several sessions can
work on it and any session can resume it. `scripts/run.mjs` does the bookkeeping; you write
findings, never `state.json`. Every script and file format is specified in
`references/contracts.md`. The scripts need Node 20+ and no packages; without Node follow
`references/environments/generic.md`.

## Hard rules

They hold in both modes. Each one was broken once and cost real work.

1. **Read-only until the user approves something.** Finding, measuring and building the board
   change nothing outside `<run>`.
2. **Never print a secret.** Mask to the first 4 characters before anything reaches the
   conversation, the board, a findings file or a log. Use `scripts/secret-scan.mjs`, never a raw
   `grep` over config.
3. **Backup before every edit**, into `<run>/backups/<stamp>/`, and record the change with
   `run.mjs record` so it can be undone. A backup of a file that holds a secret is made with the
   secret masked, or not made and the item says so.
4. **Verify after every change** by re-reading the real state, and record what was *not*
   verified. "Should work" is not a result.
5. **Never recommend from memory.** A tool, flag, price or feature comes from
   `references/catalog/` (each entry has a source and a date) or from documentation read in this
   session. Anything else is an unconfirmed lead.
6. **Never without the user's yes:** installing software, deleting, changing permissions,
   touching secrets, adding a gate, linking or replicating accounts, committing, pushing. See
   `references/doctor-policy.md`.
7. **One writer per harness.** Reviewing is parallel; at any moment only one session or
   subagent edits a given harness.
8. **Explain everything you propose.** Every item carries the why, the cost, the exact change
   and the rule to keep (`references/teaching.md`). The user decides looking at the diff.
9. **CLI before MCP.** Prefer an official CLI to an MCP server; keep a server at user level only
   when nearly every conversation needs it. Show the options; never move or remove one unasked.
10. **Say when the user's premise is wrong**, then do what they decide.

## Flow

### 1. Find and choose

```bash
node <skill>/scripts/run.mjs history                     # what was reviewed before, and what is due
node <skill>/scripts/accounts.mjs list --lang <pt|en>
node <skill>/scripts/find-projects.mjs --days 30        # add --roots <dir,dir> if the user names folders
```

Tell the user, in one message, what you found: the accounts by provider (label and masked
identity), the projects with their activity, and which harnesses were reviewed before, when,
and whether their follow-up is due. A harness with a review record is reviewed **as a
follow-up**: the run measures what happened since, checks that what was applied is still
there, and reviews it again (`references/follow-up.md`). To go straight to the harnesses of an
earlier run: `run.mjs init --follow-up latest`. `history` also lists the experiments open now,
with their end date: tell the user before proposing anything about those harnesses. Then ask
only what the request did not already answer:

- **Which harnesses.** Default: every account that is not `empty` plus every `suggested`
  project; with more than about eight projects, propose the most active ones and name the
  rest. A request about one project ("review this repo") selects that project and the account
  in use (`inUse`); do not ask.
- **Which account is the primary** when there are two or more. Recommend the one with the most
  activity. Explain in one sentence what it means: the primary's harness becomes the source,
  the other accounts follow it (`references/accounts.md`).
- **Mode**: guided review (default), doctor, or measure only (no review, see Modes).

Read the environment file for where config lives and how to show the board:
`references/environments/claude-code.md`, `codex.md`, else `generic.md`.

### 2. Start the run and measure

```bash
node <skill>/scripts/run.mjs init --select <selection.json> --mode guided --days 30 --lang <pt|en> --title "<name>"
node <skill>/scripts/run.mjs probe
```

`probe` inventories each harness, runs the rule engine (candidate findings with evidence,
`references/checks.md`), measures the last 30 days of sessions (tokens, context at start,
retries, corrections, exploration, unused context) and snapshots the files the board shows, all
into `<run>/probes/`. `--lang` is the language you speak with the user.

**Measure only.** `init --mode measure`, `probe`, `build`, then `close`: no review units, no
subagents, no findings and no score ("não avaliado"); the board shows the measurements, the
explorer and any follow-up, and the records are the baseline a later review compares with.
After a measure run, `init --follow-up <runId|latest>` is a guided review unless
`--mode measure` is given again.

To join a run another session started: `run.mjs status --run <id>`, then claim units as below.

### 3. Review

The work is split into units (`references/contracts.md`). With subagents, orchestrate as
`references/orchestration.md` says: one reviewer per unit, all selected harnesses each. Without
subagents, take the units yourself, in this order:

```bash
node <skill>/scripts/run.mjs claim --session <label>       # prints the unit's brief
# ... review, write the findings file ...
node <skill>/scripts/run.mjs complete --unit <id> --session <label> --findings <file>
```

For each unit: read the round files its brief names, read `references/teaching.md` and
`references/pitfalls.md`, then work from the probes. Rule-engine output is **candidates**: verify
each one in the real file before it becomes an item, and drop the false ones. Every item gets
its `lesson`, its exact `changes` (text copied from disk, each with a `why`), `origin` when it
is not live configuration, and `saves` when the measurement supports a number. Write what is
fine too (`inventory`, `defenses`): the board is also the map of the harness. For a project,
read the true state first: if the default branch is behind its remote, read from the remote ref.

| # | Round | File | Applies to |
|---|---|---|---|
| 1 | Security and permissions | `references/rounds/01-security-permissions.md` | all |
| 2 | Instructions and structure | `references/rounds/02-instructions-structure.md` | all |
| 3 | Documentation | `references/rounds/03-documentation.md` | projects |
| 4 | Gates and automation | `references/rounds/04-gates-automation.md` | all |
| 5 | Cleanup | `references/rounds/05-cleanup.md` | all |
| 6 | Skills and knowledge | `references/rounds/06-skills-knowledge.md` | all |
| 7 | CLIs, MCP servers and tools | `references/rounds/07-clis-tools.md` | all |
| 8 | External dependencies | `references/rounds/08-external-dependencies.md` | all |

A linked account inherits the primary's harness: review the primary, and for the linked
account only what differs. The same finding in several harnesses becomes one `group`.

### 4. Show the board

```bash
node <skill>/scripts/run.mjs build --channel <artifact|server|file>
```

It merges everything into `<run>/state.json`, computes the scores (`references/scoring.md`; never
write one by hand), checks that every change is anchored in its file (fix any warning it
prints), and renders `<run>/board.html`. Open it the way the environment file says. The board
is for looking, not for deciding: an overview (every harness before and after, accounts,
group decisions), one tab per harness (impact, explorer of its files with each change drawn in
place, diagnosis) and a Pending tab that lists what waits for a decision, by id. Tell the user
in two sentences that they read the board and decide here, in the conversation, and start with
the three findings that matter most.

### 5. Decide and apply

Loop until `run.mjs next` suggests `close`:

1. **Decide with the user, in chat.** Walk through the pending items (most impact first, or
   in the order the user asks), answer every question in the same teaching style, and record
   each decision the user states with `run.mjs decide --target <id> --action
   approve|decline|defer [--note "..."]`, groups included (`--exclude` for the items the user
   leaves out). Never record a decision the user did not state. When the user asks something
   about an item, answer it; record `ask` only if they want the question kept on the board.
2. **Apply what was approved**, one executor per harness (`apply:<harness>` units): for each
   item `run.mjs mark --status in-progress`, back up, make exactly the change the item shows,
   verify, `run.mjs record`, then `run.mjs mark --status fixed --verified "..."` (or `failed`,
   after restoring the backup). A subagent's report is a claim: check the files yourself.
3. **Rebuild** (`run.mjs build`) so the board shows the new state and scores.

Guided mode applies nothing without a decision on that item. Doctor mode applies the safe
classes on its own (`references/doctor-policy.md`, `run.mjs mark --auto`) and leaves the rest
open on the board; everything it applied still shows its lesson and diff.

A decision is about the exact proposal the user saw. When `run.mjs decisions` returns `stale`,
or `run.mjs next` returns `decideAgain`, the proposal changed after the decision: build the
board again and ask the user to decide on the current version. Never apply from a stale
approval.

### 6. Accounts

When there is more than one account, after the primary's harness is in the state the user
wants: `accounts.mjs plan --primary <id>`, show the plan and its conflicts on the board (class
`sync`), apply what the user approves with `accounts.mjs apply`, then offer the session-start
check that keeps the accounts in step (`accounts.mjs install-check`, a gate). Details and
safety rules: `references/accounts.md`.

### 7. Close

`run.mjs close` writes the **review record** of each harness under
`~/.novarc-powers/novarc-harness-doctor/history/<harness>/`: every item with its decision and
status, the exact changes applied, what each one is expected to save and in which measurement,
the scores, and the measurements of today. That record is what the next review compares
against, so close every run, including one where the user approved nothing.

Then write `<run>/report.md` from the record's `.md`: per harness the score before and after,
what changed, what was declined or deferred, what could not be verified, the unconfirmed leads,
and "what to carry forward": the `principle` of every fixed item. In a follow-up, lead with
what the comparison showed. Tell the user that `run.mjs undo` reverts the run, and the date
from which a new review can measure the real effect (`followUpAfter`, 30 days by default): they
only need to ask for the review again. For a project, offer to copy the report into
`.novarc-powers/novarc-harness-doctor/reports/` in the repo.

If the user is testing something (a change applied in this run, or a measure-only baseline),
close with `run.mjs close --experiment "<what is being tested>" [--follow-up-days <n>]`. A run
that applied changes opens an experiment anyway, until `followUpAfter`. `run.mjs experiment
end --harness <key|path>` ends one early.

## Modes

- **Guided review**: nothing is applied without the user's decision on that item.
- **Doctor**: reversible and additive fixes are applied with backup and shown afterwards;
  permissions, secrets, deletions, installs, gates, account sync and translations wait for a
  decision (translations arrive drafted in `<run>/drafts/`).
- **Measure only**: no review rounds, no subagents, no findings; only the measurements, the
  explorer and the follow-up. The cheap way to take a baseline before trying something.

## Experiments

While an experiment is open on a harness (its last review applied changes, or was closed with
`--experiment`, and its follow-up date has not come), do not propose changes to what loads at
the start of every session (instruction files and their imports, skill and agent descriptions,
MCP servers, plugins, SessionStart hooks, output styles): they would confound the measurement.
Reviewers record such findings `open` with `heldForExperiment: true`; the board lists them
apart, "held until <date>". `decide --action approve` on one is refused; pass
`--override-experiment` only when the user, told the cost, still wants it now.

## Concurrency

If another session may be editing the same harness right now (the user says so, or a file
changes under you between reads), use guided mode and re-read every file immediately before
editing it. Never edit a harness another executor has claimed.
