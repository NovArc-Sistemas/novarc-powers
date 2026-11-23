# Round 4 — Gates and automation

A gate is anything that stops a mistake without relying on the agent remembering a rule: an
agent hook, a git hook, a CI check, a permission rule. This round has two halves: are the
existing gates working, and which gates would have prevented the problems this user actually had.

## Check the existing gates

- List every hook (agent hooks per event, git hooks, CI workflows, scheduled routines) with what
  it runs, when, and how long it takes.
- **Does it run?** A hook registered for an event name that does not exist, pointing at a moved
  script, or failing silently, is a gate the user believes in and does not have. Read the hook's
  script; check the path exists and is executable; look for its trace in recent transcripts.
- **Does it block?** A hook that only prints a warning is advice. Check the exit code contract
  of the environment (see the environment file).
- **What does it cost?** Time added to every tool call, commit or session start. A hook that
  takes seconds on every edit is a finding even when it is correct.
- **Can it be bypassed by accident?** `--no-verify`, a different entry point, a second account
  that does not load it.

## Find the gates this project needs

Do not propose gates from a generic list. Propose them from evidence.

1. Run `scripts/transcript-signals.mjs --cwd <project root>`. It reads past session transcripts
   for this project locally and prints counts only: failed commands grouped by command, hook
   blocks, user corrections, repeated retries, and sessions that ended on an error. It never
   prints message text. Then take the token cost of each pattern from `session-impact.mjs`
   (`waste[]`): a gate that prevents 9 million tokens of retries a month is an easy decision;
   one that prevents 50 thousand may not be worth its friction.
2. Read the project's own record of trouble: recent `fix`/`revert`/`hotfix` commits
   (`git log --oneline -200`), reverted PRs, a pendings or incidents file, CI failures on the
   default branch.
3. Ask the user one question: *what went wrong in this project that you do not want to see
   again?* Their answer outranks the counts.
4. For each recurring failure, look at two or three of the actual sessions to understand the
   mechanism before proposing anything. Read them yourself; do not paste them into the board.

Then, per failure, write an item with:

- **Evidence**: how often, since when, which sessions or commits (ids, not content).
- **Mechanism**: why the agent keeps doing it — missing information, a misleading doc, a rule
  that is prose only, a slow feedback loop.
- **Cheapest fix that would have prevented it**, in this order of preference: fix the
  misleading source; make the right thing the default (a script, a template); a permission
  rule; an agent hook; a git hook; a CI check. A gate is the answer only when the earlier
  options do not hold.
- **Cost**: time added, false-positive risk, how to bypass it deliberately.

Typical mappings, to recognise the shape and not to copy:

| Recurring failure | Gate that fits |
|---|---|
| Commits land on the wrong branch | Pre-commit check of the branch name against the session's task |
| "Done" claimed with failing types or tests | Stop/pre-push hook that runs the fast checks and blocks on failure |
| An applied migration edited afterwards | Pre-commit check that rejects changes to migrations already on the default branch |
| Generated files edited by hand | Deny rule or pre-commit check on the generated paths |
| The same wrong command retried in a loop | Instruction naming the right command, plus a hook that rewrites or blocks the wrong one |
| Secrets pasted into commits | Pre-commit secret scan |

## Fix

Every new gate is class `gate`: it can block the user's work, so it is queued in doctor mode.
Repairing an existing gate so it does what the user already intended is `reversible`.

Install one gate at a time and prove it both ways: it blocks the bad case, it lets the normal
case through. Record the time it adds.

## Verify

For each gate: the script runs from a clean shell; the bad case is blocked with a message that
tells the agent what to do instead; the good case passes. Never trigger a gate by mutating the
user's working repo — use a throwaway fixture repo in a temp dir.
