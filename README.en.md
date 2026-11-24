<div align="center">

# NovArc Powers

**On-demand superpowers for your coding agent.**
Skills for the tasks you do now and then, each with the right install profile.
Claude Code, Codex and any agent that reads files and runs commands. macOS, Windows and Linux.

[![CI](https://github.com/NovArc-Sistemas/novarc-powers/actions/workflows/validate.yml/badge.svg)](https://github.com/NovArc-Sistemas/novarc-powers/actions/workflows/validate.yml)
[![npm](https://img.shields.io/npm/v/novarc-powers?color=0a6cff)](https://www.npmjs.com/package/novarc-powers)
[![MIT license](https://img.shields.io/badge/license-MIT-111)](LICENSE)

**English** · [Português](README.md)

</div>

---

NovArc Powers is a collection of skills for the moments your agent needs to go beyond the daily
routine: review its own harness, measure where the tokens went, keep several accounts in step.
Each skill does one task with a beginning and an end, comes with the install profile we
recommend, and costs nothing in the sessions where you do not use it.

## Contents

- [How it works](#how-it-works)
- [Installation](#installation)
- [What's inside](#whats-inside)
- [Install profiles](#install-profiles)
- [Philosophy](#philosophy)
- [Updates](#updates)
- [Where skills keep their files](#where-skills-keep-their-files)
- [Contributing](#contributing)

## How it works

A skill is a set of instructions and scripts the agent follows to do one task well. Most
collections install everything into the harness, and every skill's description is read in every
session, whether you use it or not. For a skill you use once a month, that is cost with no
return.

NovArc Powers starts from the opposite: the default is **on demand**. The installer writes a
few lines into your `CLAUDE.md` or `AGENTS.md` saying the skill exists and how to fetch it.
When you ask ("review my harness"), the agent downloads the pinned version, reads the
`SKILL.md` and follows it. In every other session the cost is that short block. A skill you use
every day can go into your user or project harness instead: the installer asks.

Every skill here follows the same rules: it measures before it gives an opinion, explains why
behind each recommendation, asks for your confirmation before any change that matters, keeps
what it did in one folder, and works the same on macOS, Windows and Linux.

## Installation

Needs Node 20 or newer.

### Any agent, nothing installed

Paste into your agent:

> Run `npx -y novarc-powers fetch novarc-harness-doctor`, read the SKILL.md at the path it
> prints and follow it.

Swap the name for the skill you want. It is the quickest way to try one.

### Installer

```bash
npx novarc-powers
```

It detects your agents (Claude Code, Codex, and the tools that read `AGENTS.md` and `.agents/skills`), shows the skills with the profile
we recommend for each, and lists every file it will create or change before asking you to
confirm.

```bash
npx novarc-powers list            # catalog with the recommended profile
npx novarc-powers add <skill>     # one skill, no menu
npx novarc-powers status          # what is installed, where and which version
npx novarc-powers update          # shows what changes and applies after you confirm
npx novarc-powers remove <skill>
```

All of them take `--yes`, `--scope user|project|both`, `--skills a,b`, `--dry-run` and `--json`,
to run without a menu, from an agent or a script.

### Claude Code: plugin marketplace

```text
/plugin marketplace add NovArc-Sistemas/novarc-powers
/plugin install novarc-harness-doctor@novarc-powers
```

One skill per plugin: install only the ones you want.

### A fixed version, straight from GitHub

```bash
npx -y github:NovArc-Sistemas/novarc-powers#v0.2.2 fetch <skill>
```

## What's inside

### Diagnosis and maintenance

- **[novarc-harness-doctor](skills/novarc-harness-doctor)**: reviews every harness on your
  machine (each account, each project) in one run. Measures what they cost over the last 30
  days, explains each problem with the why, shows the change inside the file, applies what you
  approve, and comes back a month later to check whether the expected effect happened.
  *Recommended profile: on demand.*

Each skill has its own folder under [`skills/`](skills), with a README, `SKILL.md`, scripts and
references. More skills are coming: follow the [CHANGELOG](CHANGELOG.md).

## Install profiles

| Profile | For | What the installer does | Cost in every session |
|---|---|---|---|
| **On demand** | A rare task with a beginning and an end | Writes only a short block into `CLAUDE.md` / `AGENTS.md` saying how to fetch the skill when needed | A few lines |
| **User harness** | Your habit, in every project | Copies the skill to `~/.claude/skills`, `~/.codex/skills` or `~/.agents/skills` | The skill's description |
| **Project harness** | The team's process, versioned with the code | Copies the skill to the project's `.claude/skills` or `.agents/skills` | The description, in that project only |

Each skill comes with the profile we recommend, and you can change it at install time. Details
in [docs/profiles.md](docs/profiles.md).

## Philosophy

- **On demand first.** What enters every session costs in every session. A skill you rarely use
  stays out until it is called.
- **Measure before giving an opinion.** Numbers come from your own data, and what is estimated
  is shown apart from what was measured.
- **Teach while doing.** Every recommendation says why it matters, what it costs and the rule
  worth keeping for next time.
- **You decide.** No installing software, deleting files, changing permissions, touching
  secrets, committing or publishing without your confirmation. Every edit has a backup and an
  undo.
- **Local first.** Your data stays on your machine unless you choose to publish something.

## Updates

At install time you choose: **notify** (recommended), apply on its own, or off. A skill is text
your agent obeys with your permissions; reading what changed before applying it costs one
command (`npx novarc-powers update`).

## Where skills keep their files

Every skill uses one folder, `.novarc-powers/`, in your home or in the project, with one
subfolder per skill. Removing a skill does not delete its data unless you ask for `--purge`.

## Contributing

Ideas, fixes and new skills are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the pattern
for a new skill in [docs/authoring.md](docs/authoring.md): a self-contained folder, a
recommended profile, tests, and working on all three operating systems.

## Credits

Each skill credits its own sources in its README.

## License

[MIT](LICENSE) © NovArc Sistemas
