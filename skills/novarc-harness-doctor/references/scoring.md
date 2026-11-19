# Scoring

`scripts/render-board.mjs` computes the score from `state.json`. Never write a score by hand and
never round one up; the number is only useful if it is the same number for the same state.

## Formula

One score per scope (`user`, `project`), from 0 to 100.

Each round has a weight. Only rounds whose status for that scope is `done` count; `pending`,
`skipped` and `not-applicable` rounds are left out and the remaining weights are rescaled to 100.
A round that ran and found nothing is `done` with no items, and scores full marks. With no
`done` round the scope has no score yet, and the board says "not scored" instead of a number.
The board also shows how many applicable rounds the score covers (for example "6 of 8"; a
`not-applicable` round lowers the total), so a
partial review never reads as a complete one.

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

Within a round, every item that is not resolved costs points by severity:

| Severity | Points |
|---|---|
| `critical` | 10 |
| `high` | 5 |
| `medium` | 2 |
| `low` | 1 |

Status decides how much of the cost counts:

| Status | Counts |
|---|---|
| `open`, `queued`, `in-progress`, `failed` | 100% |
| `accepted` (the user chose to keep it) | 50% |
| `fixed`, `ok`, `wontfix-not-applicable` | 0% |

Round score = weight × (1 − min(1, cost ÷ 10)). Ten points of open findings zero a round, so a
single critical finding does.

Scope score = sum of round scores, rescaled. Grade: A ≥ 90, B ≥ 80, C ≥ 65, D ≥ 50, E below 50.

## Baseline and current

The baseline is the score of the run's findings with every status treated as `open`: what the
harness scored before anything was fixed. `current` uses the real statuses. Both are computed on
every render, so a round finished later still enters the baseline. The board shows both, so the
user sees what the session bought.

On a re-run, the previous run's `current` is copied to `scores.<scope>.previous` before the new
run starts, and the board shows the trend across runs.

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
