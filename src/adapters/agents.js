// Generic AGENTS.md-compatible tools: `~/.agents/skills` at user level (no user
// instruction file), `.agents/skills` + AGENTS.md in the project.
import fs from 'node:fs';
import path from 'node:path';

export const id = 'agents';

export function detect(home) {
  return fs.existsSync(path.join(home, '.agents'));
}

export function userTargets(home) {
  const dir = path.join(home, '.agents');
  return [{ configDir: dir, skillsDir: path.join(dir, 'skills'), instructionFile: null }];
}

export function projectTargets(cwd) {
  return [{ configDir: path.join(cwd, '.agents'), skillsDir: path.join(cwd, '.agents', 'skills'), instructionFile: path.join(cwd, 'AGENTS.md') }];
}
