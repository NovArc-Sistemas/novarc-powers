# Scoring

`scripts/render-board.mjs` computes the scores from `state.json`, with the arithmetic in
`scripts/lib/scoring.mjs`. Never write a score by hand and never round one up; the number is only
useful if it is the same number for the same state. The board inlines the same module, so the
"after" numbers it shows while the user decides are computed by the same code.

The model is confidence-weighted: every round starts at 100 and loses points for what is still
wrong, and a finding counts less when it lives somewhere the agent does not actually load. The
idea is inspired by AgentShield's scorer (`src/reporter/score.ts` in
[affaan-m/agentshield](https://github.com/affaan-m/agentshield), MIT). This is a
re-implementation of the idea, not a copy of its code, and the numbers are our own.

## Formula

One score per harness (each user account's config and each project repo), from 0 to 100.

```
item deduction    = severity points × status factor × origin weight
round deduction   = sum of the item deductions, where the non-active items of one file
                    (secrets excepted) together deduct at most 10
round score       = max(0, 100 − round deduction)
harness score     = Σ(round weight × round score) ÷ Σ(round weight), over `done` rounds only
```

The harness score is floored to one decimal, never rounded up (a tiny epsilon absorbs float
error, so 64.99999999 reads as 65). Round scores are shown floored the same way.

Three numbers come out of the same formula, differing only in the status factor:

| Number | Status factor | What it says |
|---|---|---|
| `baseline` | every item as if `open` | The harness before this run. |
| `current` | the real statuses | The harness now. |
| `projected` | the real statuses, with `approved` and `in-progress` as if `fixed` | Where the harness lands once what the user approved is applied. |

### Rounds and weights

Only rounds whose status for that harness is `done` count; `pending`, `skipped` and
`not-applicable` rounds are left out of both sums. A round that ran and found nothing is `done`
with no items, and scores 100. With no `done` round the harness has no score yet, and the board
says "not scored" instead of a number. The board also shows how many applicable rounds the score
covers (for example "6 of 8"; a `not-applicable` round lowers the total), so a partial review
never reads as a complete one.

| Round | Weight |
|---|---|
| 1 Security and permissions | 20 |
| 2 Instructions and structure | 15 |
| 3 Documentation | 10 |
| 4 Gates and automation | 15 |
| 5 Cleanup | 5 |
| 6 Skills and knowledge | 15 |
| 7 CLIs, MCP servers and tools | 10 |
| 8 External dependencies | 10 |

### Severity

| Severity | Points |
|---|---|
| `critical` | 25 |
| `high` | 15 |
| `medium` | 5 |
| `low` | 2 |

One open critical leaves a round at 75; four empty it.

### Status

| Status | Factor in `current` | Factor in `projected` |
|---|---|---|
| `open`, `failed`, `deferred` | 1 | 1 |
| `approved`, `in-progress` | 1 | 0 |
| `declined` (the user chose to keep it) | 0.5 | 0.5 |
| `fixed`, `ok`, `not-applicable` | 0 | 0 |

`approved` and `in-progress` count in full for `current`: the user said yes, but nothing is on
disk yet. `deferred` counts in full everywhere: deciding later is not a decision. In `baseline`
every status has factor 1.

### Origin

`origin` is an optional item field that says where the finding lives. Leave it out for anything
the agent loads or runs; set it only when the file the finding is about is not part of every
session.

| `origin` | Weight | Use it for |
|---|---|---|
| `active` (default when absent) | 1 | What the agent loads or runs: settings, instructions, hooks, enabled skills, MCP servers. |
| `project-optional` | 0.75 | Project files a user opts into: a `settings.local.example.json`, an optional profile, a config that is off by default. |
| `plugin` | 0.5 | Files shipped by an installed plugin or marketplace, which the user did not write and an update replaces. |
| `example` | 0.25 | Templates, samples, fixtures and docs that show a configuration without being loaded. |

Two rules override the weight:

- An item with `class: secret` is never discounted by origin and never enters a file cap. A
  credential in an example file is still a live credential.
- An `active` item is never capped, whatever its file.

### Per-file cap

Within each round, the deductions of non-active items (secrets excepted) are grouped by file. The
file is the item's first `changes[].path`, else its optional `file` field. Each group deducts at
most 10 points from that round. A non-active item with neither `changes` nor `file` cannot share
a file, so it is not grouped and deducts in full (after its origin weight). The cap is per round:
the same file reported in two rounds is capped separately in each. It applies to all three
numbers.

### Baseline, current and projected

All three are computed on every render, so a round finished later still enters the baseline. The
baseline keeps origin weights and caps: it is what the harness scored before anything was fixed,
approved or declined. The board shows the three together, on the overview as a bar from
`baseline` to `projected` and in each harness tab as a dial, so the user sees what the run found,
what it already bought and what their approvals are about to buy.

Each harness in `state.json` carries its own `scores` object (`current`, `baseline`, `projected`,
their three grades, `roundsCounted`, `roundsTotal`, `previous`, `computedAt`). On a re-run, the
previous run's `current` is copied to `scores.previous` before the new run starts, and the board
shows the trend across runs. The renderer keeps `previous` as it finds it, and moves `computedAt`
only when a computed value changed.

The overview's average grade is the mean of the harness scores that exist, floored to one
decimal, taken once over `baseline` and once over `projected`.

### Grade

| Grade | Score |
|---|---|
| A | ≥ 90 |
| B | ≥ 75 |
| C | ≥ 60 |
| D | ≥ 40 |
| F | below 40 |

### Defenses

`defenses` is an optional top-level list of `{ harness, title, detail? }`: what already protects
a harness, such as a deny list, a blocking `PreToolUse` hook or a sandbox. Record only defenses
that were checked in this run. The board lists them under "Recognized defenses" and says that
they add no points. They never enter the formula.

## Worked example

A project harness with rounds 1, 2 and 4 `done` (weights 20 + 15 + 15 = 50) and round 3 `skipped`.

| Item | Round | Severity | Status | Origin | File | Deduction now |
|---|---|---|---|---|---|---|
| P1 | 1 | critical | open | active | `./.claude/settings.json` | 25 × 1 × 1 = 25 |
| P2 | 1 | high | open | plugin | `~/.claude/plugins/acme/hooks.json` | 15 × 1 × 0.5 = 7.5 |
| P3 | 1 | high | declined | plugin | `~/.claude/plugins/acme/hooks.json` | 15 × 0.5 × 0.5 = 3.75 |
| P4 | 1 | medium | open | plugin | `~/.claude/plugins/acme/hooks.json` | 5 × 1 × 0.5 = 2.5 |
| P5 | 2 | critical | open | example, class `secret` | `./examples/.env.sample` | 25 × 1 × 1 = 25 |
| P6 | 2 | medium | fixed | active | `./CLAUDE.md` | 5 × 0 × 1 = 0 |
| P7 | 3 | high | open | active | `./docs/setup.md` | round not counted |
| P8 | 4 | low | open | project-optional | none | 2 × 1 × 0.75 = 1.5 |
| P9 | 4 | high | approved | active | `./.githooks/pre-push` | 15 × 1 × 1 = 15 |

- Round 1: P2, P3 and P4 share a plugin file: 7.5 + 3.75 + 2.5 = 13.75, capped at 10. P1 is
  active, so it is not capped. Deduction 25 + 10 = 35, score 65.
- Round 2: P5 is a secret, so its example origin does not discount it. Score 75.
- Round 4: P8 has no file, so it is not grouped. Deduction 1.5 + 15 = 16.5, score 83.5.
- Current = (20 × 65 + 15 × 75 + 15 × 83.5) ÷ 50 = 3677.5 ÷ 50 = 73.55, floored to **73.5**,
  grade **C**.
- Baseline: P3 counts as open (7.5), so the plugin group is 17.5, still capped at 10, and round
  1 stays at 65. P6 counts as open (5), so round 2 is 100 − 30 = 70. Round 4 stays at 83.5.
  Baseline = (1300 + 1050 + 1252.5) ÷ 50 = 72.05, floored to **72**, grade **C**.
- Projected: P9 is approved, so it counts as fixed and round 4 is 100 − 1.5 = 98.5. Rounds 1 and
  2 are as in current. Projected = (1300 + 1125 + 1477.5) ÷ 50 = 78.05, floored to **78**,
  grade **B**. The board shows this harness going from C to B once the approved fix is applied.

## Why it works this way

- **Why weight by origin.** A finding in a file the agent never loads cannot hurt a session the
  way the same finding in `settings.json` can. Counting a plugin's bundled sample or a template
  as fully as live configuration buries the problems the user can act on under ones that never
  run. The weight keeps those findings on the board while scaling what they cost to how likely
  they are to reach a session.
- **Why secrets are never discounted.** Exposure does not depend on whether a file is loaded: a
  token in an example file is readable by anyone who can read the repository, and it works.
- **Why cap per file.** One vendored file with many findings is usually one decision (update,
  disable or remove the plugin), not many. Without a cap a single noisy third-party file can
  empty a round by itself and hide everything else in it. The cap covers only non-active origins:
  findings in live configuration each cost in full, because each one can bite.
- **Why defenses add no points.** A defense lowers risk, but the score measures what is still
  wrong. Crediting a defense would let it offset an open finding it does not cover, and a defense
  is the thing most often believed to work and never tested (a deny rule that only matches a
  prefix, for one). Listing defenses shows the user what already protects them without letting
  the number drift away from the findings.
- **Why only `done` rounds count.** A round that was not run has no findings, and scoring it 100
  would reward skipping the review. Leaving it out keeps the number honest about what was looked
  at, and the "n of m rounds" line says how much that is.
- **Why one score per harness.** A run can cover several accounts and several projects. One
  number for all of them would let a tidy project hide an account that leaks a token. Each
  harness is something the user can open, fix and re-check on its own, so each one gets its own
  number, and the overview only averages them.
- **Why an approval does not move `current`.** A yes changes nothing on disk. Counting it would
  make the score rise the moment the user clicks, before any risk went away, and it would stay
  risen if the change then failed. `projected` exists so the user still sees what the yes is
  worth.

## Severity guide

Assign severity by consequence, not by how easy the fix is.

- **critical**: a credential is exposed, or the agent can do something destructive or
  irreversible that the user believes is blocked.
- **high**: the agent silently runs with wrong or missing instructions, or a gate the user
  relies on does not run.
- **medium**: wasted context or time in every session; a recurring failure with a known fix.
- **low**: clutter, a missing nicety, a recommendation not adopted.

A recommendation the user declines is `declined`, not `open`. A harness is allowed to be
deliberately small; the score should not punish a choice.
