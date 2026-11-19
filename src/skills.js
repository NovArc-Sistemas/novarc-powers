// Skill catalog: reads every `skills/<name>/skill.json` from the skills root.
import fs from 'node:fs';
import path from 'node:path';
import { skillsRoot } from './paths.js';

export const SKILL_NAME_RE = /^[a-z0-9-]+$/;
export const PROFILES = ['on-demand', 'user', 'project'];

export class CliError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function assertSkillName(name) {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    throw new CliError('INVALID_SKILL_NAME', `Invalid skill name: ${JSON.stringify(name)} (allowed: a-z, 0-9, -)`);
  }
}

/** Validate a parsed skill.json; returns a list of problems (empty when valid). */
export function skillJsonProblems(meta, folderName) {
  const problems = [];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return ['skill.json is not an object'];
  if (typeof meta.name !== 'string' || !SKILL_NAME_RE.test(meta.name)) problems.push('name must match [a-z0-9-]+');
  if (folderName && meta.name !== folderName) problems.push(`name "${meta.name}" differs from folder "${folderName}"`);
  if (typeof meta.version !== 'string' || !/^\d+\.\d+\.\d+/.test(meta.version)) problems.push('version must be semver');
  if (typeof meta.summary !== 'string' || !meta.summary.trim()) problems.push('summary is required');
  if (meta.summary_pt !== undefined && typeof meta.summary_pt !== 'string') problems.push('summary_pt must be a string');
  const prof = meta.profile;
  if (!prof || typeof prof !== 'object') problems.push('profile is required');
  else {
    if (!PROFILES.includes(prof.recommended)) problems.push(`profile.recommended must be one of ${PROFILES.join(', ')}`);
    if (!Array.isArray(prof.supported) || !prof.supported.length || prof.supported.some((p) => !PROFILES.includes(p))) {
      problems.push('profile.supported must be a non-empty list of profiles');
    } else if (!prof.supported.includes(prof.recommended)) problems.push('profile.supported must include the recommended profile');
  }
  for (const key of ['environments', 'requires']) {
    if (meta[key] !== undefined && (!Array.isArray(meta[key]) || meta[key].some((v) => typeof v !== 'string'))) {
      problems.push(`${key} must be a list of strings`);
    }
  }
  const ws = meta.workspace;
  if (ws !== undefined) {
    if (!ws || typeof ws !== 'object') problems.push('workspace must be an object');
    else {
      for (const key of ['shared', 'local']) {
        const v = ws[key];
        if (v !== undefined && (!Array.isArray(v) || v.some((e) => typeof e !== 'string' || e.includes('..') || path.isAbsolute(e)))) {
          problems.push(`workspace.${key} must be a list of relative paths`);
        }
      }
    }
  }
  return problems;
}

/** Load all skills from the skills root, sorted by name. */
export function loadSkills(root = skillsRoot()) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !SKILL_NAME_RE.test(ent.name)) continue;
    const dir = path.join(root, ent.name);
    const metaPath = path.join(dir, 'skill.json');
    if (!fs.existsSync(metaPath) || !fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      continue;
    }
    if (skillJsonProblems(meta, ent.name).length) continue;
    out.push({ ...meta, dir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Find one skill or throw a CliError. */
export function getSkill(skills, name) {
  assertSkillName(name);
  const s = skills.find((k) => k.name === name);
  if (!s) throw new CliError('UNKNOWN_SKILL', `Unknown skill: ${name}`);
  return s;
}

/** Localised summary of a skill. */
export function skillSummary(skill, lang) {
  if (lang === 'pt' && skill.summary_pt) return skill.summary_pt;
  return skill.summary;
}
