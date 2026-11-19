// Plan / apply core shared by every command. A plan is a list of serialisable
// actions per scope; `applyPlan` performs them. `--dry-run` stops after planning.
import fs from 'node:fs';
import path from 'node:path';
import { resolveTargets } from './adapters/index.js';
import { blockHash, extractBlock, removeBlock, renderBlock, renderBlockBody, upsertBlock } from './block.js';
import {
  backupFile,
  backupStamp,
  exists,
  hashFile,
  hashTree,
  listFiles,
  readTextOrNull,
  removePath,
  samePath,
  sha256,
  writeFileInPlace,
  writeInside,
} from './fsutil.js';
import { emptyManifest, manifestPath, readManifest, removeManifest, writeManifest } from './manifest.js';
import { installedHookPath, packageHooksDir, stateDir, userConfigPath } from './paths.js';
import { addHook, hookCommand, removeHook } from './settings-hook.js';
import { CliError } from './skills.js';

export const SCOPES = ['user', 'project'];
export const UPDATE_MODES = ['notify', 'auto', 'off'];

export function scopeRoot(ctx, scope) {
  return scope === 'user' ? ctx.home : ctx.cwd;
}

export function expandScopes(scope) {
  if (scope === 'both') return ['user', 'project'];
  if (scope === 'user' || scope === 'project') return [scope];
  throw new CliError('INVALID_SCOPE', `Invalid scope: ${scope} (user, project or both)`);
}

/**
 * Decide where a skill lands for the selected scopes. Copy profiles go to their
 * own scope when it is selected, otherwise to the other selected one. On-demand
 * pointers go to the user scope when it is selected (one pointer per agent
 * context, never duplicated in user + project), else to the project.
 */
export function placement(skill, scopes, profileOverride) {
  const wanted = profileOverride || skill.profile.recommended;
  if (!skill.profile.supported.includes(wanted)) {
    throw new CliError(
      'PROFILE_NOT_SUPPORTED',
      `${skill.name} does not support profile "${wanted}" (supported: ${skill.profile.supported.join(', ')})`,
    );
  }
  let scope;
  if (wanted === 'on-demand' || wanted === 'user') scope = scopes.includes('user') ? 'user' : 'project';
  else scope = scopes.includes('project') ? 'project' : 'user';
  const profile = wanted === 'on-demand' ? 'on-demand' : scope;
  if (!skill.profile.supported.includes(profile)) {
    throw new CliError(
      'PROFILE_NOT_SUPPORTED',
      `${skill.name} would be installed with profile "${profile}" for the selected scope, which it does not support (supported: ${skill.profile.supported.join(', ')})`,
    );
  }
  return { scope, profile };
}

/** Desired manifest entries (without hashes) for one skill in one scope. */
export function desiredEntries(ctx, skill, scope, profile, tools) {
  const env = { home: ctx.home, cwd: ctx.cwd };
  const kind = profile === 'on-demand' ? 'instructionFile' : 'skillsDir';
  return resolveTargets(tools, scope, env, kind).map((t) => ({
    skill: skill.name,
    profile,
    tool: t.tools[0],
    tools: t.tools,
    target: profile === 'on-demand' ? t.path : path.join(t.path, skill.name),
  }));
}

export function sameTarget(a, b) {
  return samePath(a, b);
}

/** Files of an installed copy that differ from what the manifest recorded. */
export function modifiedFiles(entry) {
  const out = [];
  for (const [rel, hash] of Object.entries(entry.files || {})) {
    const abs = path.join(entry.target, ...rel.split('/'));
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      out.push({ file: rel, reason: 'missing' });
      continue;
    }
    if (!st.isFile()) out.push({ file: rel, reason: 'replaced' });
    else if (hashFile(abs) !== hash) out.push({ file: rel, reason: 'modified' });
  }
  return out;
}

/** Hash of the block currently in an instruction file, or null. */
export function currentBlockHash(file) {
  const block = extractBlock(readTextOrNull(file));
  return block == null ? null : blockHash(block);
}

/**
 * Plan one scope.
 *  - `desired`: entries (skill, profile, tool, tools, target) that must exist.
 *  - `touched`: skill names whose existing entries in this scope are reconciled
 *    against `desired` (entries of other skills are kept as they are).
 */
export function planScope(ctx, scope, { desired, touched, updates, tools, purge = [] }) {
  const root = scopeRoot(ctx, scope);
  const old = readManifest(root);
  const manifest = old ? structuredClone(old) : emptyManifest(ctx.version, updates || 'notify');
  const actions = [];
  const warnings = [];
  const conflicts = [];
  const touchedSet = new Set(touched);
  const kept = manifest.entries.filter((e) => !touchedSet.has(e.skill));
  const previous = manifest.entries.filter((e) => touchedSet.has(e.skill));
  const finalEntries = [...kept];
  const catalog = new Map(ctx.catalog.map((s) => [s.name, s]));

  // 1. Copy installs.
  for (const want of desired.filter((d) => d.profile !== 'on-demand')) {
    const skill = catalog.get(want.skill);
    const prev = previous.find((e) => e.profile !== 'on-demand' && sameTarget(e.target, want.target));
    const { files: srcFiles, skipped } = listFiles(skill.dir);
    for (const s of skipped) warnings.push({ code: 'SYMLINK_SKIPPED', skill: skill.name, file: s });
    const pkgHashes = hashTree(skill.dir);
    let op;
    if (prev) {
      const mods = modifiedFiles(prev);
      if (mods.length && !ctx.force) {
        conflicts.push({ scope, skill: skill.name, target: want.target, files: mods });
        finalEntries.push(prev);
        continue;
      }
      const same = !mods.length && JSON.stringify(prev.files) === JSON.stringify(pkgHashes);
      op = same ? 'unchanged' : 'update';
    } else if (exists(want.target)) {
      const st = fs.lstatSync(want.target);
      const current = st.isDirectory() && !st.isSymbolicLink() ? hashTree(want.target) : null;
      const matches = current && Object.entries(pkgHashes).every(([rel, h]) => current[rel] === h);
      if (matches) op = 'adopt';
      else if (!ctx.force) {
        conflicts.push({ scope, skill: skill.name, target: want.target, files: [{ file: '.', reason: 'unmanaged' }] });
        continue;
      } else op = 'update';
    } else op = 'create';
    const stale = prev ? Object.keys(prev.files || {}).filter((rel) => !(rel in pkgHashes)) : [];
    if (op !== 'unchanged' && op !== 'adopt') {
      actions.push({ kind: 'copy', scope, op, skill: skill.name, source: skill.dir, target: want.target, files: srcFiles, stale });
    }
    finalEntries.push({ ...want, version: skill.version, files: pkgHashes });
  }

  // 2. Copy removals (touched skills whose previous target is no longer desired).
  for (const prev of previous.filter((e) => e.profile !== 'on-demand')) {
    if (desired.some((d) => d.profile !== 'on-demand' && sameTarget(d.target, prev.target))) continue;
    const mods = modifiedFiles(prev).filter((m) => m.reason !== 'missing');
    if (mods.length && !ctx.force) {
      conflicts.push({ scope, skill: prev.skill, target: prev.target, files: mods });
      finalEntries.push(prev);
      continue;
    }
    actions.push({ kind: 'delete', scope, skill: prev.skill, target: prev.target, files: Object.keys(prev.files || {}) });
  }

  // 3. On-demand pointer blocks, one per instruction file.
  const wantOnDemand = desired.filter((d) => d.profile === 'on-demand');
  const prevOnDemand = previous.filter((e) => e.profile === 'on-demand');
  const keptOnDemand = kept.filter((e) => e.profile === 'on-demand');
  const files = [];
  for (const e of [...wantOnDemand, ...prevOnDemand, ...keptOnDemand]) {
    if (!files.some((f) => sameTarget(f, e.target))) files.push(e.target);
  }
  for (const file of files) {
    const inFile = (e) => sameTarget(e.target, file);
    const recorded = [...prevOnDemand, ...keptOnDemand].filter(inFile);
    if (recorded.length) {
      const hash = currentBlockHash(file);
      if (hash !== recorded[0].blockHash && !ctx.force) {
        conflicts.push({
          scope,
          skill: [...new Set(recorded.map((e) => e.skill))].join(','),
          target: file,
          files: [{ file: path.basename(file), reason: hash == null ? 'missing' : 'modified' }],
        });
        // Leave this file alone: keep exactly what was recorded for it.
        for (const e of prevOnDemand.filter(inFile)) finalEntries.push(e);
        continue;
      }
    }
    const next = [...keptOnDemand.filter(inFile), ...wantOnDemand.filter(inFile)];
    const skills = next
      .map((e) => catalog.get(e.skill) || { name: e.skill, summary: '' })
      .filter((s, i, arr) => arr.findIndex((x) => x.name === s.name) === i);
    const text = readTextOrNull(file);
    let newText;
    let op;
    let hash = null;
    if (skills.length) {
      const body = renderBlockBody(skills.map((s) => ({ name: s.name, summary: s.summary })), ctx.version);
      newText = upsertBlock(text, body);
      hash = blockHash(renderBlock(body, '\n'));
      op = text == null ? 'create' : newText === text ? 'unchanged' : 'update';
    } else {
      newText = removeBlock(text);
      op = text == null || newText === text ? 'unchanged' : 'remove';
    }
    if (op !== 'unchanged') {
      actions.push({ kind: 'block', scope, op, target: file, skills: skills.map((s) => s.name), text: newText, existed: text != null });
    }
    for (const e of keptOnDemand.filter(inFile)) {
      const idx = finalEntries.indexOf(e);
      if (idx !== -1) finalEntries[idx] = { ...e, version: catalog.get(e.skill)?.version || e.version, blockHash: hash };
    }
    for (const e of wantOnDemand.filter(inFile)) {
      finalEntries.push({ ...e, version: catalog.get(e.skill).version, blockHash: hash });
    }
  }

  // 4. Purge skill data folders.
  for (const name of purge) {
    const dir = path.join(stateDir(root), name);
    if (exists(dir)) actions.push({ kind: 'purge', scope, skill: name, target: dir });
  }

  // 5. Manifest, update settings, hook, .gitignore.
  const nextManifest = {
    ...manifest,
    packageVersion: ctx.version,
    updates: updates || manifest.updates || 'notify',
    tools: finalEntries.length ? [...new Set([...(manifest.tools || []), ...(tools || [])])] : [],
    entries: finalEntries,
  };
  const changed = JSON.stringify(normalise(old)) !== JSON.stringify(normalise(nextManifest));
  if (finalEntries.length) {
    if (changed) actions.push({ kind: 'manifest', scope, op: old ? 'update' : 'create', target: manifestPath(root) });
  } else if (old) actions.push({ kind: 'manifest', scope, op: 'remove', target: manifestPath(root) });

  if (scope === 'user') planUserUpdates(ctx, nextManifest, actions, warnings);
  if (scope === 'project') planGitignore(ctx, root, nextManifest, actions, old);

  return { scope, root, actions, warnings, conflicts, manifest: nextManifest };
}

function normalise(m) {
  if (!m) return null;
  const entries = [...m.entries].sort((a, b) => (a.skill + a.target).localeCompare(b.skill + b.target));
  return { ...m, entries };
}

/** Hook registration, hook script and config.json for the user scope. */
function planUserUpdates(ctx, manifest, actions, warnings) {
  const hasEntries = manifest.entries.length > 0;
  const wantHook = hasEntries && manifest.updates !== 'off' && (manifest.tools || []).includes('claude-code');
  const hookPath = installedHookPath();
  const cmd = hookCommand(hookPath);
  const settingsTargets = resolveTargets(['claude-code'], 'user', { home: ctx.home, cwd: ctx.cwd }, 'settingsFile');
  for (const t of settingsTargets) {
    const text = readTextOrNull(t.path);
    if (!wantHook && text == null) continue;
    const res = wantHook ? addHook(text, cmd) : removeHook(text);
    if (res.status === 'invalid') {
      warnings.push({ code: 'SETTINGS_INVALID_JSON', file: t.path });
      continue;
    }
    if (res.status === 'changed') {
      actions.push({
        kind: 'settings',
        scope: 'user',
        op: wantHook ? 'register-hook' : 'unregister-hook',
        target: t.path,
        text: res.text,
        existed: text != null,
      });
    }
  }
  const src = path.join(packageHooksDir(), 'check-update.js');
  if (wantHook) {
    const same = exists(hookPath) && hashFile(hookPath) === hashFile(src);
    if (!same) actions.push({ kind: 'hook-script', scope: 'user', op: exists(hookPath) ? 'update' : 'create', source: src, target: hookPath });
  } else if (exists(hookPath)) {
    actions.push({ kind: 'hook-script', scope: 'user', op: 'remove', target: hookPath });
  }
  const cfgPath = userConfigPath();
  const prevCfg = readJson(cfgPath) || {};
  if (hasEntries) {
    const cfg = { updates: manifest.updates, lastCheck: prevCfg.lastCheck ?? null, installedVersion: ctx.version };
    const prev = { updates: prevCfg.updates, lastCheck: prevCfg.lastCheck ?? null, installedVersion: prevCfg.installedVersion };
    if (JSON.stringify(cfg) !== JSON.stringify(prev)) {
      actions.push({ kind: 'config', scope: 'user', op: exists(cfgPath) ? 'update' : 'create', target: cfgPath, data: cfg });
    }
  } else if (exists(cfgPath)) {
    actions.push({ kind: 'config', scope: 'user', op: 'remove', target: cfgPath });
  }
}

/** `<cwd>/.novarc-powers/.gitignore` from the skills present in the project. */
function planGitignore(ctx, root, manifest, actions, old) {
  const file = path.join(stateDir(root), '.gitignore');
  if (!manifest.entries.length && !old && !exists(stateDir(root))) return;
  const catalog = new Map(ctx.catalog.map((s) => [s.name, s]));
  const lines = new Set();
  for (const e of manifest.entries) {
    for (const l of catalog.get(e.skill)?.workspace?.local || []) lines.add(`*/${l.replace(/^\/+/, '')}`);
  }
  const content =
    '# Generated by novarc-powers. Machine-local skill data stays out of git.\n' +
    [...[...lines].sort(), 'backups/', 'cache/'].join('\n') +
    '\n';
  if (readTextOrNull(file) !== content) {
    actions.push({ kind: 'gitignore', scope: 'project', op: exists(file) ? 'update' : 'create', target: file, text: content });
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Perform every action of the planned scopes. Returns the backups made. */
export function applyPlan(ctx, plans) {
  const stamp = ctx.stamp || backupStamp();
  const backups = [];
  const backup = (sd, file) => {
    const b = backupFile(sd, stamp, file);
    if (b) backups.push(b);
  };
  for (const plan of plans) {
    const sd = stateDir(plan.root);
    for (const a of plan.actions) {
      switch (a.kind) {
        case 'copy': {
          fs.mkdirSync(path.dirname(a.target), { recursive: true });
          try {
            if (fs.lstatSync(a.target).isSymbolicLink()) removePath(a.target);
          } catch {
            /* missing */
          }
          fs.mkdirSync(a.target, { recursive: true });
          for (const rel of a.files) {
            const data = fs.readFileSync(path.join(a.source, ...rel.split('/')));
            const dest = path.join(a.target, ...rel.split('/'));
            // A file about to be overwritten with different content (--force) is backed up first.
            try {
              if (fs.lstatSync(dest).isFile() && hashFile(dest) !== sha256(data)) backup(sd, dest);
            } catch {
              /* new file */
            }
            writeInside(a.target, rel, data);
          }
          for (const rel of a.stale) removePath(path.join(a.target, ...rel.split('/')));
          pruneEmptyDirs(a.target);
          break;
        }
        case 'delete': {
          for (const rel of a.files) {
            const abs = path.join(a.target, ...rel.split('/'));
            try {
              if (fs.lstatSync(abs).isFile()) fs.unlinkSync(abs);
            } catch {
              /* already gone */
            }
          }
          pruneEmptyDirs(a.target);
          try {
            fs.rmdirSync(a.target);
          } catch {
            /* not empty: hand-added files stay */
          }
          break;
        }
        case 'block':
        case 'settings':
          // In place, never rename or unlink: links shared between accounts must survive.
          if (a.existed) backup(sd, a.target);
          writeFileInPlace(a.target, a.text);
          break;
        case 'hook-script':
          if (a.op === 'remove') removePath(a.target);
          else {
            fs.mkdirSync(path.dirname(a.target), { recursive: true });
            fs.copyFileSync(a.source, a.target);
          }
          break;
        case 'config':
          if (a.op === 'remove') removePath(a.target);
          else writeFileInPlace(a.target, JSON.stringify(a.data, null, 2) + '\n');
          break;
        case 'gitignore':
          writeFileInPlace(a.target, a.text);
          break;
        case 'purge':
          removePath(a.target);
          break;
        case 'manifest':
          break; // written below, after every file action succeeded
        default:
          throw new Error(`Unknown action ${a.kind}`);
      }
    }
    if (plan.manifest.entries.length) writeManifest(plan.root, plan.manifest);
    else removeManifest(plan.root);
  }
  return { backups };
}

/** Remove empty sub-directories under `dir` (never `dir` itself). */
function pruneEmptyDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const sub = path.join(dir, ent.name);
    pruneEmptyDirs(sub);
    try {
      fs.rmdirSync(sub);
    } catch {
      /* not empty */
    }
  }
}

/** JSON-friendly view of plans (drops file contents). */
export function planToJson(plans) {
  return plans.map((p) => ({
    scope: p.scope,
    root: p.root,
    actions: p.actions.map(({ text, data, source, files, stale, ...rest }) => ({
      ...rest,
      ...(Array.isArray(files) ? { files: files.length } : {}),
    })),
    conflicts: p.conflicts,
    warnings: p.warnings,
  }));
}