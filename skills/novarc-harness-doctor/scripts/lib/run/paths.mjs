// Where a run lives on disk. Every path the run tooling touches is resolved here, so tests can
// redirect everything with NOVARC_POWERS_HOME and nothing ever lands in the real home directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SKILL_NAME = 'novarc-harness-doctor';
/** Folder that holds SKILL.md (scripts/lib/run -> three levels up). */
export const SKILL_DIR = path.resolve(HERE, '..', '..', '..');
export const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');

/** `<yyyymmdd>-<4 base36>`; also accepts any id the state schema allows, never a path. */
export const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{2,40}$/;

/**
 * The home directory the run tooling writes under. `NOVARC_POWERS_HOME` overrides it (the same
 * variable the installer honours); tests always set it.
 */
export function homeBase() {
  const override = process.env.NOVARC_POWERS_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return os.homedir();
}

/** `<home>/.novarc-powers/novarc-harness-doctor`: the one base dir of this skill at user level. */
export function baseDir() {
  return path.join(homeBase(), '.novarc-powers', SKILL_NAME);
}

export function runsDir() { return path.join(baseDir(), 'runs'); }
export function latestPath() { return path.join(baseDir(), 'latest.json'); }

/** File name for a unit id: `review:security#2` -> `review.security.2` (`:` is illegal on Windows). */
export function unitFileName(unitId) {
  return String(unitId).replace(/[:#]/g, '.');
}

/** Every file and folder of one run. */
export function runPaths(runId) {
  if (!RUN_ID_RE.test(String(runId))) throw new Error('invalid run id');
  const dir = path.join(runsDir(), runId);
  return {
    runId,
    dir,
    run: path.join(dir, 'run.json'),
    queue: path.join(dir, 'queue.json'),
    claims: path.join(dir, 'claims'),
    probes: path.join(dir, 'probes'),
    probeSummary: path.join(dir, 'probes', 'summary.json'),
    findings: path.join(dir, 'findings'),
    status: path.join(dir, 'status.json'),
    decisions: path.join(dir, 'decisions.jsonl'),
    ledger: path.join(dir, 'ledger.json'),
    backups: path.join(dir, 'backups'),
    drafts: path.join(dir, 'drafts'),
    state: path.join(dir, 'state.json'),
    board: path.join(dir, 'board.html'),
    boardMd: path.join(dir, 'board.md'),
    log: path.join(dir, 'log.jsonl'),
    groups: path.join(dir, 'groups.json'),
    buildStamp: path.join(dir, 'build.json'),
    mutex: path.join(dir, '.mutex'),
    claimFile: (unitId) => path.join(dir, 'claims', `${unitFileName(unitId)}.lock`),
    findingsFile: (unitId) => path.join(dir, 'findings', `${unitFileName(unitId)}.json`),
    probeDir: (harnessId) => path.join(dir, 'probes', harnessId),
  };
}

/** `<yyyymmdd>-<4 random base36>` from the local date. */
export function newRunId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  let rand = '';
  for (const b of crypto.randomBytes(16)) {
    if (rand.length === 4) break;
    if (b < 252) rand += (b % 36).toString(36); // 252 = 7 * 36: no modulo bias
  }
  return `${day}-${rand.padEnd(4, '0')}`;
}

/** The run id recorded by the last `init`, or null. */
export function latestRunId() {
  try {
    const v = JSON.parse(fs.readFileSync(latestPath(), 'utf8'));
    return v && typeof v.runId === 'string' && RUN_ID_RE.test(v.runId) ? v.runId : null;
  } catch { return null; }
}

/** Env var that overrides the location of one script: `snapshot-harness.mjs` -> `NOVARC_HD_SCRIPT_SNAPSHOT_HARNESS`. */
export function scriptEnvName(fileName) {
  return `NOVARC_HD_SCRIPT_${fileName.replace(/\.mjs$/, '').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`;
}

/** Path of a probe or renderer script; its env var overrides the default (tests use tiny stubs). */
export function scriptPath(fileName) {
  const override = process.env[scriptEnvName(fileName)];
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(SCRIPTS_DIR, fileName);
}
