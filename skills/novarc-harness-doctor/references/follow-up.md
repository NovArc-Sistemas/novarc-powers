# Review records and follow-up

A review is worth more when the next one can check it. Every run leaves a **review record** per
harness: what was found, what was decided, what was changed, what each change was expected to
save, and the measurements of that moment. A later run on the same harness reads the record and
answers three questions:

1. Did the expected effect happen? (measured again, since the review)
2. Is what was applied still there? (checked on disk)
3. What came back, and what is new? (the harness reviewed again)

## Where the records live

```text
~/.novarc-powers/novarc-harness-doctor/history/
  index.json                         every harness reviewed on this machine
  <harnessKey>/
    <runId>.json                     one review of that harness (the record)
    <runId>.md                       the same, to read
```

Records stay on the machine. They hold display paths (`~`, or relative to the project root),
masked text only, and no e-mail; the absolute path of each harness is in `index.json` alone.

A run id starts with its date (`20261123-d6oj`), so the files sort by time.

**Harness key.** `<slug>-<8 hex>`: the slug of the harness name and the first 8 hex characters
of a SHA-256 over `kind`, `provider` and the real absolute path (lower-cased on Windows). The
same account dir or repo folder gets the same key in every run; a repo that moved is a new
harness. It is `harnessKey` in `run.json`, in the record and in the index, and `key` in
`state.harnesses[]`. (Do not confuse it with the short prefix of item ids, such as `ACME`.)

`index.json`:

```json
{ "schema": 1,
  "harnesses": {
    "acme-shop-1a2b3c4d": {
      "kind": "project", "provider": null, "name": "acme-shop",
      "path": "~/dev/acme-shop", "pathAbs": "<absolute>",
      "reviews": [ { "runId": "20261123-d6oj", "reviewedAt": "<ISO>", "file": "20261123-d6oj.json",
                     "score": 82.5, "grade": "B", "fixed": 6, "followUpAfter": "<ISO>" } ] } } }
```

## The record

Written by `run.mjs close` (and by `run.mjs history --write` for a run that was never closed),
one per harness of the run, validated against `templates/record.schema.json`. Writing it again
for the same run replaces it. Once a run has records, `mark`, `record` and `undo` write them
again, so a record never claims a change that was undone and never misses one applied later.
`reviewedAt` is the close time.

```json
{ "schema": 1, "skillVersion": "0.2.0",
  "harnessKey": "acme-shop-1a2b3c4d", "runId": "20261123-d6oj",
  "kind": "project", "provider": null, "name": "acme-shop", "path": "~/dev/acme-shop",
  "startedAt": "<ISO>", "reviewedAt": "<ISO, when the record was written>",
  "changesAppliedAt": "<ISO of the last applied change, or null>",
  "followUpAfter": "<reviewedAt + followUpAfterDays>",
  "followUpOf": { "runId": "...", "reviewedAt": "<ISO>" },
  "scores": { "baseline": 70.1, "current": 82.5, "projected": 88.0, "grade": "B",
              "rounds": [ { "round": 1, "status": "done", "score": 75 } ] },
  "measure": {
    "window": { "from": "<ISO>", "to": "<ISO>", "days": 30 },
    "sessions": 120, "activeDays": 22,
    "metrics": { "tokens-per-session": 2400000, "weighted-per-session": 310000,
                 "context-at-start": 111000, "context-peak": 168000, "waste-share": 2.1,
                 "waste:retry": 5200, "waste:loop": 900, "tool-output": 410000 },
    "unused": { "skills": ["..."], "mcpServers": ["..."] },
    "coverage": { "claude": "complete", "codex": "partial" } },
  "elements": { "skills": 17, "hooks": 8, "mcp": 4, "permissions": 29, "plugins": 3, "clis": 12 },
  "items": [
    { "id": "ACME-204", "rev": "0a1b2c3d4e5f", "round": 2, "severity": "medium", "class": "reversible",
      "title": "...", "status": "fixed", "decision": { "action": "approve", "at": "<ISO>", "note": "..." },
      "fixedAt": "<ISO>", "verified": "...", "principle": "...",
      "saves": { "tokens": 380000, "basis": "measured", "metric": "context-at-start", "how": "..." },
      "previous": { "run": "...", "item": "..." },
      "changes": [ { "path": "CLAUDE.md", "before": "...", "after": "...", "insertAfter": "...",
                     "hashAfter": "<sha256 of the file after the change, from the ledger>" } ] } ],
  "outcome": { "...": "the followUp object of this run, when it was itself a follow-up" } }
```

Rules:

- **Every item of the harness goes in**, whatever its status: fixed, failed, declined, deferred,
  still open. `changes` is kept for fixed items only (it is what the on-disk check needs).
- **`measure.metrics`** holds the comparable numbers, already per session (the table below).
  A metric that was not measured is absent, never 0. A harness with no impact measurement has
  `"measure": null` and `"measureSkipped": "<reason>"`.
- Text comes from `state.json`, so it is already masked. A record never holds a secret; the same
  barrier that guards `state.json` runs over it.

### Comparable metrics

| Metric | Value | From `impact` |
|---|---|---|
| `tokens-per-session` | tokens / session | `totalTokens / sessions` |
| `weighted-per-session` | input-token equivalents / session | `weightedTotal / sessions` |
| `context-at-start` | tokens / session | `contextAtStart.perSessionMedian` |
| `context-peak` | tokens / session | `contextPeak.median` |
| `waste-share` | percent | measured waste over total (weighted when both are known) |
| `waste:<kind>` | tokens / session | `waste[kind].tokens / sessions` |
| `tool-output` | chars / session | shell output characters / sessions |

An item names the metric its saving should show up in with `saves.metric`
(`references/teaching.md`). A saving with no metric counts toward `tokens-per-session`. An
expectation exists only for the metrics counted in tokens per session: savings are in tokens,
so `waste-share` (percent) and `tool-output` (characters) are read as a plain change.
`saves.tokens` is a total over the review's window, written so that dividing it by the sessions
of that window gives the expected fall of the metric (`references/teaching.md` says how to
compute it for each metric).

## The follow-up

Any run on a harness that has a record is a follow-up for that harness; nothing special has to
be asked for. `run.mjs init --follow-up <runId|latest>` is the shortcut that selects the same
harnesses as that run (the ones that still exist; the others are reported).

**Window.** When at least `minDays` have passed since the record, the harness is measured over
the days since `changesAppliedAt` (or `reviewedAt`), at most the run's window. Before that, the
harness is measured over the normal window, and the comparison says "not enough data yet" with
the date it will be ready (`sample.readyAt`).

**`run.mjs build` writes `harnesses[].followUp`** (schema: `$defs.followUp`):

- `score`: `then` (how that review ended), `expected` (its projected score), `now` (this run's
  baseline: the harness as found today).
- `days`: whole days since the record (rounded down).
- `metrics`: one row for every metric measured on either side: `before`, `after`, `changePct`,
  and `expected` when fixed items named that metric. `expected = before - (sum of their
  saves.tokens / sessions of that review)`. A metric missing on one side is a row with the
  verdict `not-measured`.
- `sample.readyAt` is set only when the reason is `too-few-days`.
- `items`: every fixed item of the record with its on-disk `check`, and every declined,
  deferred, failed or still-open item, each with `now` when a reviewer linked a new item to it.
- `summary`.

**Verdicts.** Thresholds are in `references/catalog/follow-up.json`, not in code. The first row
that applies wins:

| Verdict | When |
|---|---|
| `not-enough-data` | fewer than `minDays` days or `minSessions` sessions since the review |
| `not-measured` | the metric is missing on one side |
| `worse` | the metric rose by more than `noisePct`, with or without an expectation |
| `confirmed` | with an expectation: at least `confirmedShare` of the expected reduction happened |
| `partial` | with an expectation: at least `partialShare` of it happened |
| `improved` | no expectation: the metric fell by more than `noisePct` |
| `no-change` | everything else |

**On-disk check of a fixed item** (per change, the worst result wins: `missing` > `reverted` >
`changed` > `in-place`):

| Check | When |
|---|---|
| `in-place` | the file has `hashAfter`, or holds the `after` text (the `before` text is looked for only outside it, since an edit often keeps part of what was there) |
| `reverted` | the file holds the `before` text and not the `after` text |
| `changed` | the file holds neither: someone rewrote that part |
| `missing` | the file is gone (and the change did not delete it) |
| `not-checked` | the change has no text to look for (a command, a setting outside a file) |

**What a comparison is, and is not.** Two periods are compared, not two versions of the same
work: the kind of task, the models and the amount of activity change too. Say so wherever a
verdict is shown, and never present a `confirmed` as proof that the change caused the saving.
A `worse` after a fix is a lead to investigate, not a reason to undo it.

## Reviewing a harness again

The brief of each unit carries the path of the harness's last record. The reviewer:

1. Reads the record's items before proposing anything.
2. Sets `previous: { "run", "item" }` on every finding that is the same as an item of the
   record. A rule-engine candidate with the same check id on the same path is the same finding.
3. **Declined before:** propose it again only when something changed, and say what. Otherwise
   write it with status `declined` and `previous` pointing at the declined item: `build` carries
   the earlier note, and the board shows "declined on <date>". This is the only case in which a
   reviewer sets `declined`; `run.mjs complete` refuses it anywhere else.
4. **Deferred before, or left open:** it comes back `open`; the board shows when it was first
   seen and how many times.
5. **Fixed before and back again** (reverted on disk, or the same problem in another place): a
   new item with `previous` set, and the lesson says that it came back and how to keep it from
   coming back (usually a gate, round 4).
6. **Fixed before and still in place:** no item. It is listed in `followUp.items`.

`run.mjs build` fills `items[].history` from `previous` and the records (`firstSeenAt`, `times`,
`lastStatus`, `lastDecisionAt`, `lastNote`). A `previous` that points at nothing is a warning.

## What the user sees

- **Overview:** per harness, the score then and now, and one line: "N of M expected effects
  confirmed", or "ready to compare on <date>". A follow-up run names the run it follows.
- **Harness, Impact tab:** "Since the last review": the score then, expected and now; the metric
  table (before, expected, now, verdict); the expected and the measured change per session; the
  fixed items with their check; the items that review left undecided or declined, folded; and
  the note on what a comparison is. While there is not enough data, the section says so and
  shows no verdict.
- **Harness header:** the score of each earlier review, oldest first.
- **Item:** when it has `history`, a line with when it was first seen and what was decided; its
  expected saving names the measurement the next review will check.
- **`board.md`:** the same block per harness, in text.

## Commands

```text
node run.mjs history [--harness <key|path>] [--json]     what was reviewed, when, and what is due
node run.mjs history --write [--run <id>]                 write the records of a run without closing it
node run.mjs init --follow-up <runId|latest> [...]        a new run over the harnesses of that run (not with --select)
node run.mjs close [--run <id>]                           writes the records, then closes
```

`history` prints, per harness: each review (date, score, fixed items, expected saving) and
`due`: whether `followUpAfter` has passed. At the start of any session of this skill, run it
and tell the user which harnesses have a follow-up due.
