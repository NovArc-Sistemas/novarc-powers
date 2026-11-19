// Central path resolution. Every place that needs the home directory, the
// package root or the skills root goes through this module, so tests can
// redirect everything with environment variables.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the running package (the folder holding package.json). */
export const PACKAGE_ROOT = path.resolve(here, '..');

let cachedPkg = null;
/** The running package's package.json, read once. */
export function packageJson() {
  if (!cachedPkg) {
    cachedPkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  }
  return cachedPkg;
}

/** Version of the running package. Never hardcoded elsewhere. */
export function packageVersion() {
  return packageJson().version;
}

/**
 * The user's home directory. `NOVARC_POWERS_HOME` overrides it; tests always
 * set it so nothing touches the real home.
 */
export function homeDir() {
  const override = process.env.NOVARC_POWERS_HOME;
  if (override && override.trim()) return path.resolve(override);
  return os.homedir();
}

/** Root folder holding `skills/<name>/`. `NOVARC_POWERS_SKILLS_DIR` overrides it. */
export function skillsRoot() {
  const override = process.env.NOVARC_POWERS_SKILLS_DIR;
  if (override && override.trim()) return path.resolve(override);
  return path.join(PACKAGE_ROOT, 'skills');
}

/** Directory where the bundled hook script lives inside the package. */
export function packageHooksDir() {
  return path.join(PACKAGE_ROOT, 'hooks');
}

/** `<scope root>/.novarc-powers` */
export function stateDir(scopeRoot) {
  return path.join(scopeRoot, '.novarc-powers');
}

/** Absolute path of the user-level config read by the update hook. */
export function userConfigPath() {
  return path.join(stateDir(homeDir()), 'config.json');
}

/** Absolute path where the update hook is installed for the user. */
export function installedHookPath() {
  return path.join(stateDir(homeDir()), 'hooks', 'check-update.js');
}

/** Folder where `fetch` caches a skill for the running version. */
export function cacheDirFor(skill, version = packageVersion()) {
  return path.join(stateDir(homeDir()), 'cache', `${skill}@${version}`);
}
