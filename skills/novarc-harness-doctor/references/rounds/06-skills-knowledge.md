# Round 6 — Skills and knowledge

What the agent knows how to do, and what it knows about the project.

Recommendations in this round come from `references/catalog/tools.json`. Each entry has a
source and a verification date. Before proposing an install, open the entry's `source` and read
the current install instructions there; the catalog says what the tool is, the source says how
to install it today. If the source cannot be read, the recommendation is listed as an
unconfirmed lead.

## A working methodology: Superpowers

**Check.** Is `superpowers` (catalog id `superpowers`) installed for each agent in use? Is its
session-start injection actually arriving (look for it at the top of a recent transcript)?

**Recommend** it at user level when the user has no methodology layer: it gives the agent a
default way of working (brainstorm before building, plan before multi-step work, debug
systematically, verify before claiming done) that triggers without being asked. Class `install`.

**Skills index.** Whether skills come from Superpowers or elsewhere, a skill only helps if the
agent reaches for it. Install a short index in the user-level instruction file (`additive`),
generated from the skills actually installed, not from a fixed list:

```markdown
## Skills

Skills are how work is done here. Before acting on a task, including before asking a
clarifying question, check whether an installed skill covers it and invoke it.

- <skill> — <when to use it, in the user's terms>
```

Rules for the index: at most about ten lines; only skills the user wants to fire on their own;
each line says *when*, not what the skill is; skills that cost a lot (multi-agent reviews, cloud
runs) are marked "only when asked". If the instruction file already has such a section,
reconcile it with what is installed instead of adding a second one.

If the user says a skill "never triggers", check in this order: is it installed in the config
dir this account uses; does its description state when to use it; is another instruction telling
the agent to act before checking skills.

## A knowledge graph for code projects: Graphify

Project scope, when the project is code.

**Check.**

- Is `graphify` (catalog id `graphify`) installed, and is there a `graphify-out/` in the repo?
- **Freshness.** Compare the graph's last update with the last commit on the default branch. A
  graph weeks behind the code misleads.
- **Update hooks.** Find what refreshes the graph (git hooks, agent hooks, CI). For each: does
  the hook point at an existing binary; does it run (look for its output in recent sessions or
  in the graph's timestamps across the last few commits); does it fail silently.
- **Cost.** Read the hook to learn the command it runs, then time that command once, with the
  user's ok. If it adds seconds to every commit or edit, or blocks the commit when it fails,
  that is hurting development: propose running it in the background, on push instead of on
  commit, or in CI.
- **Git hygiene.** Is `graphify-out/` consistently committed or consistently ignored? If
  committed, is a merge driver configured, or does every parallel branch conflict on it?
- **Is the agent told to use it?** Search the instruction files. Without an instruction the
  graph is built and never queried.

**Recommend / fix.**

| Finding | Proposal | Class |
|---|---|---|
| Code project, no graph | Install Graphify and build the graph | `install` |
| Graph stale, no update hook | Add the update hook the tool provides | `gate` |
| Hook broken or silent | Repair it | `reversible` |
| Hook slow or blocking | Move it off the hot path | `reversible` |
| Merge conflicts on the graph | Configure the merge driver the tool provides, or stop committing the graph | `reversible` |
| No instruction to consult it | Add the instruction below | `additive` |

Model instruction, to adapt to the project:

```markdown
## Knowledge graph

`graphify-out/` holds a knowledge graph of this codebase. For any question about architecture,
where something lives, or what depends on what, query the graph before searching files. If the
answer contradicts the code, the code wins and the graph is stale: say so.
```

## Other good practices

Go through `references/catalog/practices.json`. For each practice not already present, write an
item. Present ones are inventory entries marked fine. Do not install a practice that conflicts
with something the user deliberately configured; raise it instead.

## Opt-in and hidden features of the agent tool

Agent tools ship features that are off by default, experimental, or missing from the quick
start. The goal is to **turn on the ones that help, when they are available**, not to list them.

1. Start from `references/catalog/features.json`. It holds the features worth looking for and,
   for each, what it does, how it was enabled when last observed, its preconditions and how to
   confirm it works.
2. Confirm each entry for the version installed **now**: read the tool's current docs or
   changelog, check the installed version, and when an entry has `docs: null`, look for the flag
   in the CLI's help or settings schema. Also look for new features the catalog does not list.
3. Check every precondition against this user's setup (version, OS, interactive terminal or host
   app, conflicting settings such as telemetry, managed settings).
4. Then, per feature:
   - `recommend: enable` and every precondition holds → item to enable it (class from the
     entry; usually `reversible`, a settings change with backup). Doctor mode applies it and
     runs the `confirm` check; if the check fails, revert and record why.
   - A precondition fails → inventory entry saying what blocks it and when to look again (for
     example "Code Mode: available from version X; you are on Y"). No item.
   - `recommend: consider` → item with the trade-off; the user decides.
   - Seen only in a binary or a third-party post and not confirmed → an unconfirmed lead, not an
     item.

Mark experimental features as experimental in the item. Never invent a flag value: if the
accepted value is not documented and the CLI does not say, the item says so and proposes how to
find out.

## Verify

After enabling a feature: run its `confirm` check in a new session. After installing a
methodology or the index: start a new session and give it a task one of the
indexed skills should catch; confirm it fires. After a graph change: make a trivial commit in a
fixture or ask the user to, and confirm the graph timestamp moves and the commit is not slowed.
