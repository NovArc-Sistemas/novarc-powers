# Round 3 — Documentation

Project scope. Documentation is part of the harness when the agent reads it, and a trap when it
is wrong: an agent trusts a stale doc more readily than a person does.

## Check

List every documentation file (`README*`, `docs/`, `*.md` at the root, ADRs, specs, plans,
runbooks, `CONTRIBUTING`, architecture notes) with size, last commit date and the reader it is
written for (agent, developer, customer).

- **Stale.** A doc whose subject changed after its last edit. Compare the doc's last commit with
  the last commit of the code it describes; then spot-check: do the commands in it run, do the
  paths exist, do the named scripts and env vars exist? Report each failed check, not "seems
  outdated".
- **Contradicting the code or another doc.** The setup steps in `README` versus
  `package.json` scripts; the architecture note versus the folder layout.
- **Orphaned.** Not linked from anywhere and not named by any instruction file. The agent will
  never find it; a person probably will not either.
- **Loaded but irrelevant.** A doc an instruction file tells the agent to read every session,
  that most tasks do not need.
- **Missing.** What an agent new to the project cannot work out from the code: how to run,
  test and deploy; the conventions that are not enforced by a linter; where the dangerous
  parts are; the decisions that look wrong and are deliberate.
- **Finished plans and specs kept as if current.** They describe intent at a past date. They
  belong in an archive folder the agent is told not to treat as truth.
- **Language.** Agent-facing docs follow the English practice of round 2. Human-facing docs are
  listed with their language and left alone unless the user asks.

## Fix

| Finding | Proposal | Class |
|---|---|---|
| Stale doc, facts verifiable from the repo | Correct the failed checks only; do not rewrite the doc | `reversible` |
| Stale doc, facts not verifiable | Mark it at the top as unverified with the date, and list the open questions for the user | `reversible` |
| Contradiction | Show both; the code wins unless the user says the code is the bug | — |
| Orphaned doc | Link it from the index, or propose removal | `additive` / `delete` |
| Always-loaded doc most tasks skip | Replace the "always read" with a one-line pointer saying when to read it | `reversible` |
| Missing essentials | Draft from what the repo shows, marked as a draft for the user to confirm | `additive` |
| Old plans mixed with current docs | Move to an archive folder and tell the agent what the folder is | `reversible` |
| Agent-facing doc not in English | Translate (round 2 procedure) | `translate-agent` |
| Human-facing doc not in English | List it; translate only on request | `translate-human` |

A docs index that the instruction file points to (one line per doc: path, what it answers, when
to read it) is usually the single most useful addition. Propose it when there are more than
about ten docs and no index.

## Verify

Re-run the spot checks on every corrected doc. For a moved file, search the repo for the old
path and fix the references.
