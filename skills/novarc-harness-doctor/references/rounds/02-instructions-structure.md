# Round 2 — Instructions and structure

What the agent is told before the user speaks, and whether it actually arrives.

## Check

- **Load order.** Map every instruction file that enters a session, per agent and per account:
  managed, user, project, nested directory files, imports. This is the `layers` diagram on the
  board.
- **Imports.** `discover.mjs` reports imports that do not resolve. Check each config dir
  separately; a second account often lacks the files the first one imports.
- **Size.** Bytes and an approximate token count per file (`discover.mjs` gives chars ÷ 4).
  Anything loaded every session and larger than a few thousand tokens needs a reason.
- **Contradictions.** Between files for different agents (`CLAUDE.md` vs `AGENTS.md`), between
  user and project level, and inside one file.
- **Duplication.** The same rule stated in several files drifts. Find the owner; the others
  should import or point.
- **Dead rules.** Rules about tools, paths or flows that no longer exist. Verify by searching
  for what the rule names before calling it dead.
- **Language.** See below.
- **Rules without a reason.** A rule that states why is followed in the cases its author did not
  foresee; one that does not is followed literally or ignored.

## Language of agent-facing files

Recommended practice, installed when missing: **files written for agents are in English**,
whatever language the user and the agent speak to each other. English text takes fewer tokens
than the same text in most other languages, and agent tooling, examples and skill descriptions
are in English, so mixed-language instructions are also harder for the model to match against.

Agent-facing: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, rule files, agent and command definitions,
skill files, memory files, hook messages addressed to the agent, and project docs whose reader
is the agent (specs, plans, ADRs, conventions).

Human-facing, left alone unless the user asks: `README` files, user guides, changelogs for
customers, anything published.

Two things to install:

1. The rule itself, in the user-level instruction file (`additive`). Model text:

   > Files written for agents (instruction files, rules, skills, specs, plans, memory) are in
   > English: fewer tokens, and it matches the tooling. Talk to the user in their language.

2. Translation of existing agent-facing files that are not in English (`translate-agent`).
   Per file: back up; translate keeping every path, command, identifier, quoted string and
   example byte-identical; keep any phrase the agent must output in the user's language in
   that language; then diff the structure (same headings, same number of rules, same code
   blocks) and report any rule whose meaning you were unsure of instead of guessing.

Measure before and after with the approximate token count and put the saving in the log. If the
saving for a file is under 5%, say so; the consistency argument still holds, the token one does
not.

## Fix

| Finding | Proposal | Class |
|---|---|---|
| Unresolved import | Create the link or correct the path | `reversible` |
| Second account missing imported files | Symlink the files, plus a check that the links resolve | `reversible` |
| Oversized always-loaded file | Split: keep the rules, move reference material behind a pointer the agent reads on demand | `reversible` |
| Contradiction | Present both versions; the user picks | — |
| Duplicated rule | Keep one owner, replace the rest with an import or a pointer | `reversible` |
| Dead rule | Remove after showing what you searched | `delete` |
| Agent-facing file not in English | Translate as above | `translate-agent` |
| Language rule missing | Add it | `additive` |

## Verify

Start from the file list again and confirm every import resolves in every config dir. For a
translation, re-read the result against the backup for one rule in three, picked at random.
