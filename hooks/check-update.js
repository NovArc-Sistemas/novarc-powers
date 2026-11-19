#!/usr/bin/env node
// novarc-powers update check. Standalone and dependency-free: it is copied to
// ~/.novarc-powers/hooks/ and run as a Claude Code SessionStart hook.
// Silent on every failure; always exits 0. At most one registry request per 24h.
// No static imports: the installed copy lives outside any package.json, so it
// must parse as CommonJS or ESM alike on every supported Node version.
let spawn, fs, os, path;

const DAY_MS = 24 * 60 * 60 * 1000;
const REGISTRY = process.env.NOVARC_POWERS_REGISTRY_URL || 'https://registry.npmjs.org/novarc-powers/latest';

function home() {
  const o = process.env.NOVARC_POWERS_HOME;
  return o && o.trim() ? path.resolve(o) : os.homedir();
}

function newer(a, b) {
  const pa = String(a).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function run() {
  [{ spawn }, { default: fs }, { default: os }, { default: path }] = await Promise.all([
    import('node:child_process'),
    import('node:fs'),
    import('node:os'),
    import('node:path'),
  ]);
  const cfgPath = path.join(home(), '.novarc-powers', 'config.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return;
  }
  if (!cfg || cfg.updates === 'off' || !cfg.installedVersion) return;
  const last = Date.parse(cfg.lastCheck || '') || 0;
  if (Date.now() - last < DAY_MS) return;

  // Record the attempt first so a failing network never retries every session.
  cfg.lastCheck = new Date().toISOString();
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  } catch {
    return;
  }

  const res = await fetch(REGISTRY, { signal: AbortSignal.timeout(2000), headers: { accept: 'application/json' } });
  if (!res.ok) return;
  const latest = (await res.json()).version;
  if (!latest || !newer(latest, cfg.installedVersion)) return;

  if (cfg.updates === 'auto') {
    const child = spawn('npx', ['-y', 'novarc-powers@latest', 'update', '--yes', '--scope', 'user'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    child.on('error', () => {});
    child.unref();
    return;
  }
  process.stdout.write(
    `novarc-powers ${latest} is available (installed ${cfg.installedVersion}). Run \`npx novarc-powers@latest update\` to update.\n`,
  );
}

run()
  .catch(() => {})
  .finally(() => {
    process.exitCode = 0;
  });