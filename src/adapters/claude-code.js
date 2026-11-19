// Claude Code: `~/.claude` (plus CLAUDE_CONFIG_DIR) at user level, `.claude/` in the project.
import fs from 'node:fs';
import path from 'node:path';
import { pathKey } from '../fsutil.js';

export const id = 'claude-code';

/** Every user-level config dir: `<home>/.claude`, plus CLAUDE_CONFIG_DIR when it differs. */
export function configDirs(home) {
  const dirs = [path.join(home, '.claude')];
  const extra = process.env.CLAUDE_CONFIG_DIR;
  if (extra && extra.trim()) {
    const abs = path.resolve(extra);
    if (pathKey(abs) !== pathKey(dirs[0])) dirs.push(abs);
  }
  return dirs;
}

export function detect(home) {
  return configDirs(home).some((d) => fs.existsSync(d));
}

export function userTargets(home) {
  return configDirs(home).map((dir) => ({
    configDir: dir,
    skillsDir: path.join(dir, 'skills'),
    instructionFile: path.join(dir, 'CLAUDE.md'),
    settingsFile: path.join(dir, 'settings.json'),
  }));
}

export function projectTargets(cwd) {
  return [
    {
      configDir: path.join(cwd, '.claude'),
      skillsDir: path.join(cwd, '.claude', 'skills'),
      instructionFile: path.join(cwd, 'CLAUDE.md'),
    },
  ];
}
