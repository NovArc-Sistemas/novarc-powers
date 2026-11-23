# Teaching: diagnosis that explains itself

The board is a diagnosis first and a to-do list second. A user who reads it should come away
knowing **why** each finding matters, **what** exactly changes, and **what rule** to apply the
next time they touch a harness, without this skill. Every item is written to that standard.

## Every item that proposes a change carries

1. **`lesson`**, written in the user's language:
   - `why`: the mechanism, in plain words. Not "this is bad practice" but how it fails:
     "Claude Code matches deny rules by prefix. `git push --force` is blocked, but
     `git push origin main --force` starts differently and goes through."
   - `impact`: what it costs this user, with a number from this harness whenever there is one:
     tokens per session, sessions affected, minutes added per commit, how many files.
   - `better`: what changes in the agent's behaviour after the fix, concretely.
   - `principle`: one sentence the user can reuse anywhere: "Block dangerous arguments wherever
     they appear, not by the start of the command."
   - `tradeoff`: what the change costs or risks. Every change has one; say it.
   - `learnMore`: an official doc URL when one backs the lesson. Never a URL from memory: only
     one you opened in this session.
2. **`changes`**: one entry per file, with the `before` and `after` excerpt the board renders as
   a diff.

Items that change nothing (status `ok`, a fine inventory entry) need no lesson; their `opinion`
says why they are fine, which teaches too.

## Writing the diff excerpts

- **Excerpt, not the whole file.** The changed lines plus 2 or 3 lines of context on each side,
  so the reader sees where the change sits. Cut with a line `...` when skipping.
- **Before is real, after is exact.** `before` is copied from disk. `after` is exactly what will
  be written, not a paraphrase; after applying, update it to what was written and set
  `applied: true`.
- **New file:** `before` is `""`. **Deleted file or removed block:** `after` is `""`.
- **Mask secrets** in both sides with the scanner's mask (first 4 characters, then `…`).
- **Translations:** show one representative section side by side, not the whole file, and say
  in `note` how many sections the full change covers.
- **Installs** have no file diff of their own. Show the files the installer will touch (settings,
  instruction files) when known from its docs, and the command in `proposal`. If the installer's
  effect is unknown before running it, say so in `note` and fill the diff after it runs.
- `note` points at the one thing to look at: "the `--force` check now matches anywhere in the
  command".

## Tone

- Teach like a senior colleague reviewing a setup with a junior one: direct, specific, no
  condescension, no jargon left unexplained. The first time a term appears (deny rule, hook,
  MCP server), explain it in half a sentence.
- Concrete over general. "This file loads 2,100 tokens into every session; 60% of it is the
  release checklist you use once a month" beats "the file is large".
- Never blame. The harness grew; the review is about where it goes next.
- Short. A lesson field is one to three sentences. If it needs more, the finding is two findings.

## In the conversation

In guided mode, present each item the way the board shows it: the finding, the lesson (`why`,
`impact`, `better`), the diff, the trade-off, then your recommendation and the question. The
user decides with the diff in front of them, never on a description of it.

At close, the report lists the principles of the items that were fixed, as a short "what to
carry forward" section.
