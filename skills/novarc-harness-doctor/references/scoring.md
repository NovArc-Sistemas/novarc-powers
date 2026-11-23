# Scoring

`scripts/render-board.mjs` computes the score from `state.json`. Never write a score by hand and
never round one up; the number is only useful if it is the same number for the same state.

The model is confidence-weighted: every round starts at 100 and loses points for what is still
wrong, and a finding counts less when it lives somewhere the agent does not actually load. The
idea is inspired by AgentShield's scorer (`src/reporter/score.ts` in
[affaan-m/agentshield](https://github.com/affaan-m/agentshield), MIT). This is a
re-implementation of the idea, not a copy of its code, and the numbers are our own.

## Formula

One score per scope (`user`, `project`), from 0 to 100.

```
item deduction  = severity points × status factor × origin weight
round deduction = sum of the item deductions, where the non-active items of one file
                  (secrets excepted) together deduct at most 10
round score     = max(0, 100 − round deduction)
scope score     = Σ(round weight × round score) ÷ Σ(round weight), over `done` rounds only
```

The scope score is floored to one decimal, never rounded up (a tiny epsilon absorbs float error,
so 64.99999999 reads as 65). Round scores are shown floored the same way.

### Rounds and weights

Only rounds whose status for that scope is `done` count; `pending`, `skipped` and
`not-applicable` rounds are left out of both sums. A round that ran and found nothing is `done`
with no items, and scores 100. With no `done` round the scope has no score yet, and the board
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

| Status | Factor |
|---|---|
| `open`, `queued`, `in-progress`, `failed` | 1 |
| `accepted` (the user chose to keep it) | 0.5 |
| `fixed`, `ok`, `wontfix-not-applicable` | 0 |

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
the same file reported in two rounds is capped separately in each.

### Baseline and current

`current` uses the real statuses. The baseline is the same computation with every item treated
as open (status factor 1), with origin weights and caps still applied: what the harness scored
before anything was fixed or accepted. Both are computed on every render, so a round finished
later still enters the baseline. The board shows both, so the user sees what the session bought.

On a re-run, the previous run's `current` is copied to `scores.<scope>.previous` before the new
run starts, and the board shows the trend across runs. The renderer keeps `previous` as it finds
it.

### Grade

| Grade | Score |
|---|---|
| A | ≥ 90 |
| B | ≥ 75 |
| C | ≥ 60 |
| D | ≥ 40 |
| F | below 40 |

### Defenses

`defenses` is an optional top-level list of `{ scope, title, detail? }`: what already protects
the harness, such as a deny list, a blocking `PreToolUse` hook or a sandbox. Record only defenses
that were checked in this run. The board lists them under "Recognized defenses" and says that
they add no points. They never enter the formula.

## Worked example

A project scope with rounds 1, 2 and 4 `done` (weights 20 + 15 + 15 = 50) and round 3 `skipped`.

| Item | Round | Severity | Status | Origin | File | Deduction |
|---|---|---|---|---|---|---|
| P1 | 1 | critical | open | active | `./.claude/settings.json` | 25 × 1 × 1 = 25 |
| P2 | 1 | high | open | plugin | `~/.claude/plugins/acme/hooks.json` | 15 × 1 × 0.5 = 7.5 |
| P3 | 1 | high | accepted | plugin | `~/.claude/plugins/acme/hooks.json` | 15 × 0.5 × 0.5 = 3.75 |
| P4 | 1 | medium | open | plugin | `~/.claude/plugins/acme/hooks.json` | 5 × 1 × 0.5 = 2.5 |
| P5 | 2 | critical | open | example, class `secret` | `./examples/.env.sample` | 25 × 1 × 1 = 25 |
| P6 | 2 | medium | fixed | active | `./CLAUDE.md` | 5 × 0 × 1 = 0 |
| P7 | 3 | high | open | active | `./docs/setup.md` | round not counted |
| P8 | 4 | low | open | project-optional | none | 2 × 1 × 0.75 = 1.5 |

- Round 1: P2, P3 and P4 share a plugin file: 7.5 + 3.75 + 2.5 = 13.75, capped at 10. P1 is
  active, so it is not capped. Deduction 25 + 10 = 35, score 65.
- Round 2: P5 is a secret, so its example origin does not discount it. Score 75.
- Round 4: P8 has no file, so it is not grouped. Score 98.5.
- Current = (20 × 65 + 15 × 75 + 15 × 98.5) ÷ 50 = 3902.5 ÷ 50 = 78.05, floored to **78**,
  grade **B**.
- Baseline: P3 counts as open (7.5), so the plugin group is 17.5, still capped at 10, and round
  1 stays at 65. P6 counts as open (5), so round 2 is 100 − 30 = 70. Round 4 stays at 98.5.
  Baseline = (1300 + 1050 + 1477.5) ÷ 50 = 76.55, floored to **76.5**.

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

## Severity guide

Assign severity by consequence, not by how easy the fix is.

- **critical**: a credential is exposed, or the agent can do something destructive or
  irreversible that the user believes is blocked.
- **high**: the agent silently runs with wrong or missing instructions, or a gate the user
  relies on does not run.
- **medium**: wasted context or time in every session; a recurring failure with a known fix.
- **low**: clutter, a missing nicety, a recommendation not adopted.

A recommendation the user declines is `accepted`, not `open`. A harness is allowed to be
deliberately small; the score should not punish a choice.
