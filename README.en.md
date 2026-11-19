<div align="center">

# NOVARC Powers

**Skills that make your coding agent better at what it already does.**
For Claude Code, Codex and any agent that reads files and runs commands. macOS, Windows and Linux.

[![npm](https://img.shields.io/npm/v/novarc-powers?color=111)](https://www.npmjs.com/package/novarc-powers)
[![CI](https://github.com/NovArc-Sistemas/novarc-powers/actions/workflows/validate.yml/badge.svg)](https://github.com/NovArc-Sistemas/novarc-powers/actions/workflows/validate.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-111)](LICENSE)

**English** · [Português](README.md)

</div>

---

<p align="center">
  <img src="https://raw.githubusercontent.com/NovArc-Sistemas/novarc-powers/main/assets/harness-doctor-board.png" alt="The novarc-harness-doctor board: a 0 to 100 score for the user harness and the project harness, with the score of each of the eight rounds" width="820">
</p>

## Start in 30 seconds

```bash
npx novarc-powers
```

The installer detects your agents, groups the skills by the profile we recommend for each, and
lists every file it will create or change before asking you to confirm.

Rather not install anything? Paste this into your agent:

> Run `npx -y novarc-powers fetch novarc-harness-doctor`, read the SKILL.md at the path it
> prints and follow it to review my harness.

## Catalog

| Skill | What it does | Recommended profile | Agents |
|---|---|---|---|
| [**novarc-harness-doctor**](skills/novarc-harness-doctor) | Inventories, scores and fixes your agent harness: instructions, permissions, hooks, skills, plugins, MCP servers (CLI before MCP), CLIs, hidden features, docs and gates. Guided or automatic. | On-demand | Claude Code · Codex · Traycer |

More skills are coming. Follow the [CHANGELOG](CHANGELOG.md).

## Install profiles

Every skill ships with the profile we recommend. You can change it at install time.

| Profile | For | What the installer does | Cost in every session |
|---|---|---|---|
| **On-demand** | Rare tasks with a start and an end | Writes one line in `CLAUDE.md` / `AGENTS.md` telling the agent how to fetch the skill when needed | One line |
| **User harness** | Your habits, in every project | Copies the skill to `~/.claude/skills`, `~/.codex/skills` or `~/.agents/skills` | The skill description |
| **Project harness** | The team's process, versioned with the code | Copies the skill to the project's `.claude/skills` or `.agents/skills` | The description, in that project only |

Details in [docs/profiles.md](docs/profiles.md).

## Commands

```bash
npx novarc-powers               # interactive install
npx novarc-powers list          # catalog with recommended profiles
npx novarc-powers add <skill>   # one skill, no menu
npx novarc-powers status        # what is installed, where, which version
npx novarc-powers update        # shows what changes, applies after you confirm
npx novarc-powers remove <skill>
```

All accept `--yes`, `--scope user|project|both`, `--skills a,b`, `--dry-run` and `--json`, so
an agent or a script can run them without a menu.

## Updates

At install time you choose:

- **Notify** (recommended): one line at session start when a new version exists; you run
  `npx novarc-powers update`, which shows what changes before applying.
- **Apply automatically**: updates land without review.
- **Off**.

We recommend notify. A skill is text your agent obeys with your permissions; reading what
changed before applying it costs one command.

## Where skills keep their files

Every skill that needs working files uses a single `.novarc-powers/` folder, in the project or
in your home, with one subfolder per skill:

```text
.novarc-powers/
├── manifest.json              # what the installer installed
└── novarc-harness-doctor/     # each skill writes only in its own folder
    ├── state.json
    ├── reports/
    ├── backups/               # never committed
    └── logs/                  # never committed
```

Removing a skill keeps its data unless you pass `--purge`.

## Guarantees

No skill here does any of the following without your confirmation:

- install software;
- delete files;
- change permissions;
- touch secrets;
- commit, push or publish anything.

Secrets are never printed, and every edit is backed up first.

## Share a single skill

Each folder in [`skills/`](skills) is self-contained with its own README. To share a skill,
send the folder link. To install only that one:

```bash
npx novarc-powers add novarc-harness-doctor
```

In Claude Code you can also use the plugin marketplace, one skill per plugin:

```text
/plugin marketplace add NovArc-Sistemas/novarc-powers
/plugin install novarc-harness-doctor@novarc-powers
```

## Contributing

Ideas and fixes are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the pattern for a new
skill in [docs/authoring.md](docs/authoring.md).

## License

[MIT](LICENSE) © NOVARC Sistemas
