# Authoring a skill

The pattern every skill in this repo follows. Written for the person or agent adding one.

## Folder

```text
skills/<name>/
├── SKILL.md        # required: frontmatter + the procedure the agent follows
├── skill.json      # required: catalog metadata and install profile
├── README.md       # required: human page in Portuguese, linkable on its own
├── README.en.md    # required: the same page in English
├── references/     # loaded on demand from SKILL.md
├── scripts/        # deterministic helpers; Node >= 20, zero dependencies
├── templates/
└── tests/          # node:test, synthetic fixtures only
```

- `<name>` is kebab-case and starts with `novarc-`. The folder name equals the frontmatter
  `name`.
- **Self-contained.** Nothing in the folder links or refers to a path outside it. Someone who
  copies only this folder gets a working skill.
- Everything an agent reads (`SKILL.md`, `references/`, script output) is in English. The two
  READMEs are for people.
- **macOS and Windows are both first-class** (Linux too). Scripts are Node, not bash or
  PowerShell; paths go through `node:path`; commands shown to the user name both platforms
  when they differ. CI runs every test on macOS, Windows and Linux.

## `SKILL.md`

- Frontmatter `description` says **when** to use the skill, in the words a user would type, and
  what it covers. It is what the agent sees in every session; keep it under about 750 characters.
- The body is the procedure. Keep it short and push detail into `references/`, loaded when the
  step needs it.
- State the hard rules (what the skill never does without a yes) near the top, each with the
  reason.

## `skill.json`

```json
{
  "name": "novarc-example",
  "version": "0.1.0",
  "summary": "English one-liner",
  "summary_pt": "Resumo em português",
  "profile": { "recommended": "on-demand", "supported": ["on-demand", "user", "project"] },
  "environments": ["claude-code", "codex", "traycer"],
  "requires": [],
  "workspace": { "shared": ["state.json"], "local": ["backups/", "logs/"] }
}
```

Choose `profile.recommended` with the table in [profiles.md](profiles.md).

## Working files: `.novarc-powers/<name>/`

A skill that needs to keep files writes them **only** in `.novarc-powers/<name>/`, under the
project root (project work) or the home directory (user work). It creates the folder on first
run; it does not rely on the installer having run.

`workspace.shared` lists what may be committed with the project; `workspace.local` lists what
must not (backups, logs, anything that can hold machine paths or config excerpts). The installer
generates `.novarc-powers/.gitignore` from it.

## Public by default

This repo is public. No client names or data, no tokens, no absolute personal paths, no e-mail
addresses. `npm run validate` scans for them and fails the build.

## Before opening a PR

```bash
npm run catalog    # regenerates catalog.json from every skill.json
npm run validate   # structure, links, leaks
npm test
```

Add a line to `CHANGELOG.md` under `Unreleased`.
