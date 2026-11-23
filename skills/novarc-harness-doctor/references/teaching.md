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
2. **`changes`**: one entry per contiguous edit. The board draws each one **inside the file it
   touches**: the text that goes away in red, the text that arrives in green, and the change's
   `why` beside it. A user reading `CLAUDE.md` on the board sees the whole file, with every
   proposed edit in place.
3. **`saves`**, when the measurement supports it: the tokens this fix is expected to save over
   the window, `measured` or `estimated`, with one line on where the number comes from.

Items that change nothing (status `ok`, a fine inventory entry) need no lesson; their `opinion`
says why they are fine, which teaches too.

## Writing the changes

The board finds a change in its file by exact text, so precision is what makes it appear in the
right place. `run.mjs build` prints a warning for every change it could not place; fix them all.

- **`before` is the exact, contiguous text on disk**, as it appears in the file snapshot
  (`<run>/probes/<harness>/snapshot.json`): same spaces, same line breaks, no `...` elisions.
  Take just the lines that change, plus a neighbouring line when the text alone would be
  ambiguous in the file. If a secret sits in those lines, copy the masked form the snapshot
  shows.
- **`after` is exactly what will be written.** After applying, it is what was written.
- **One entry per place.** Three edits in one file are three entries, each with its own `why`.
- **Insertion:** `before` is `""` and `insertAfter` is the exact line the new text goes after
  (omit it to append at the end of the file). **Removal:** `after` is `""`.
- **New file:** no `file`, `before` is `""`, `path` is where it will live.
- **`why`** is one or two sentences about *this* edit, in the user's language: what it does and
  why it is better. The lesson explains the problem; `why` explains the line.
- **Translations:** the changes cover the whole file, section by section, so the user can read
  the translated file on the board. Draft the full file in `<run>/drafts/` first.
- **Installs** have no diff of their own. Show the files the installer will touch when its
  documentation says which, and the command in `proposal`. If the effect is unknown before
  running it, say so and add the changes after it runs.
- **`role`** on a file (through `fileRoles` in the findings): one line on what the file does in
  the harness. The explorer shows it; write it for every file a user would not recognise.

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
