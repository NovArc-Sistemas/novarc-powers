// One account's probe holds one account. This file runs the REAL probe scripts through
// `run.mjs probe` (the stubs of run-helpers.mjs print fixed JSON and would hide a script that
// reads the wrong folder) over a fake home with four accounts, each carrying its own marker in a
// file name, in a setting and in a text. A marker of one account found in the probe output of
// another is one account's harness leaking into the review of another.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir, rmrf, write, homeEnv, runScript, SCRIPTS } from './helpers.mjs';
import { CHECK_IDS } from '../scripts/lib/checks/index.mjs';

const json = (o) => JSON.stringify(o, null, 2);
// Lower-case letters and digits only, so a marker reads the same in a path, a server name and a host name.
const MARK = { 'claude-1': 'zqxalpha7731', 'claude-2': 'zqxbravo7732', 'codex-1': 'zqxcodex7733', 'agents-1': 'zqxshared7734' };
const PROVIDER = { 'claude-1': 'claude-code', 'claude-2': 'claude-code', 'codex-1': 'codex', 'agents-1': 'agents' };
const IDS = Object.keys(MARK);
const others = (id) => IDS.filter((k) => k !== id);

/** A Claude Code config dir where every kind of element carries `mark`. */
function claudeAccount(dir, mark, stateFile, moreServers = {}) {
  write(path.join(dir, 'CLAUDE.md'), `# Rules of ${mark}\n\n@${mark}-extra.md\n`);
  write(path.join(dir, `${mark}-extra.md`), `Extra rules of ${mark}.\n`);
  write(path.join(dir, 'settings.json'), json({
    env: { ANTHROPIC_BASE_URL: `https://${mark}.example.invalid/v1` },
    permissions: { allow: [`Bash(${mark}-tool:*)`, 'Bash(node:*)'], deny: [`Bash(${mark}-rm -rf:*)`] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${path.join(dir, 'hooks', `${mark}-guard.mjs`)}"` }] }] },
    mcpServers: { [`${mark}-settings`]: { command: 'npx' } },
  }));
  write(path.join(dir, 'hooks', `${mark}-guard.mjs`), `// guard of ${mark}\nif (process.env.BAD) process.exit(2);\n`);
  write(path.join(dir, 'skills', `${mark}-skill`, 'SKILL.md'), `---\nname: ${mark}-skill\ndescription: Always use this skill for any task of ${mark}.\n---\n`);
  write(path.join(dir, 'rules', `${mark}.md`), `# Rule of ${mark}\n`);
  write(path.join(dir, 'agents', `${mark}-agent.md`), `---\nname: ${mark}-agent\ndescription: Agent of ${mark}.\n---\nPrompt.\n`);
  write(stateFile, json({ mcpServers: { [`${mark}-state`]: { command: 'npx' }, ...moreServers } }));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
}

function build() {
  const root = tmpDir('hd-accounts-');
  const home = path.join(root, 'home');
  const dirs = {
    'claude-1': path.join(home, '.claude'),
    // A second Claude account kept by a host app: the default discovery finds it like the first.
    'claude-2': path.join(home, '.hostapp', 'host', 'harness-accounts', 'claude-code', 'acc-2'),
    'codex-1': path.join(home, '.codex'),
    'agents-1': path.join(home, '.agents'),
  };
  claudeAccount(dirs['claude-1'], MARK['claude-1'], path.join(home, '.claude.json'));
  // Two servers the tool catalog knows a CLI for (an `mcp` signal), one in each of two accounts:
  // the signal has to show up for the account that has the server and for no other.
  claudeAccount(dirs['claude-2'], MARK['claude-2'], path.join(dirs['claude-2'], '.claude.json'), { supabase: { command: 'npx' } });
  const cx = MARK['codex-1'];
  write(path.join(dirs['codex-1'], 'AGENTS.md'), `# Rules of ${cx}\n`);
  write(path.join(dirs['codex-1'], 'config.toml'), `openai_base_url = "https://${cx}.example.invalid/v1"\n\n[mcp_servers.${cx}_srv]\ncommand = "npx"\n\n[mcp_servers.vercel]\nurl = "https://mcp.example.invalid/v"\n`);
  write(path.join(dirs['codex-1'], 'skills', `${cx}-skill`, 'SKILL.md'), `---\nname: ${cx}-skill\ndescription: Always use this skill for any task of ${cx}.\n---\n`);
  fs.mkdirSync(path.join(dirs['codex-1'], 'sessions'), { recursive: true });
  const sh = MARK['agents-1'];
  write(path.join(dirs['agents-1'], 'skills', `${sh}-skill`, 'SKILL.md'), `---\nname: ${sh}-skill\ndescription: Always use this skill for any task of ${sh}.\n---\n`);

  const display = (id) => `~/${path.relative(home, dirs[id]).split(path.sep).join('/')}`;
  const selection = {
    accounts: IDS.map((id) => ({ id, provider: PROVIDER[id], label: id, path: display(id), pathAbs: dirs[id] })),
    primary: null, // no account comparison: this file is about the per-harness probes
    projects: [],
  };
  const env = homeEnv(home, { NOVARC_POWERS_HOME: home, GIT_CEILING_DIRECTORIES: root });
  for (const k of Object.keys(env)) if (k.startsWith('NOVARC_HD_SCRIPT_')) delete env[k]; // the real scripts, whatever the caller exported
  const run = (args) => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'run.mjs'), ...args], { encoding: 'utf8', env, timeout: 240000 });
    let out = null;
    try { out = JSON.parse(r.stdout); } catch { out = null; }
    return { code: r.status, json: out, stderr: r.stderr || '' };
  };
  return { root, home, dirs, display, selection, env, run };
}

let fx;

before(() => {
  fx = build();
  const file = path.join(fx.home, 'selection.json');
  fs.writeFileSync(file, JSON.stringify(fx.selection));
  fx.init = fx.run(['init', '--select', file]);
  fx.probe = fx.init.code === 0 ? fx.run(['probe', '--concurrency', '4']) : { code: null, json: null, stderr: 'init failed' };
  fx.read = (harness, name) => {
    try { return fs.readFileSync(path.join(fx.init.json.dir, 'probes', harness, name), 'utf8'); } catch { return null; }
  };
});

after(() => { if (fx) rmrf(fx.root); });

test('the probes ran for every account, with the real scripts', () => {
  assert.equal(fx.init.code, 0, fx.init.stderr);
  assert.equal(fx.probe.code, 0, fx.probe.stderr);
  assert.deepEqual(fx.probe.json.harnesses.map((h) => h.id), IDS);
  for (const h of fx.probe.json.harnesses) {
    for (const name of ['discover', 'checks', 'clis', 'snapshot']) assert.equal(h.probes[name].ok, true, `${h.id}/${name}: ${h.probes[name].error || ''}`);
  }
});

test('discover, checks, clis and snapshot of one account hold nothing of another', () => {
  for (const id of IDS) {
    for (const name of ['discover.json', 'checks.json', 'clis.json', 'snapshot.json']) {
      const text = fx.read(id, name);
      assert.equal(typeof text, 'string', `${id}/${name} exists`);
      for (const other of others(id)) assert.ok(!text.includes(MARK[other]), `${id}/${name} holds the marker of ${other}`);
    }
  }
});

test('each of those probes did read its own account, and says which one it read', () => {
  for (const id of IDS) {
    const m = MARK[id];
    const discover = JSON.parse(fx.read(id, 'discover.json'));
    assert.deepEqual(discover.account, { provider: PROVIDER[id], path: fx.display(id), supported: true });
    assert.ok(fx.read(id, 'discover.json').includes(`${m}-skill`), `${id}: its own skill is listed`);
    assert.ok(fx.read(id, 'snapshot.json').includes(`${m}-skill`), `${id}: its own skill is in the snapshot`);
    const checks = JSON.parse(fx.read(id, 'checks.json'));
    assert.deepEqual(checks.account, discover.account);
    assert.ok(checks.checks.some((c) => c.evidence.includes(m) || String(c.file).includes(m)), `${id}: a finding of its own`);
  }
  // One account is one config dir: the sections of the other providers stay empty.
  const d1 = JSON.parse(fx.read('claude-1', 'discover.json')).user;
  assert.deepEqual([d1.configDirs.length, d1.codex.length, d1.agentsDirs.length, d1.desktopConfigs.length], [1, 0, 0, 0]);
  assert.equal(d1.configDirs[0].path, '~/.claude');
  assert.deepEqual(d1.configDirs[0].mcpServers.map((s) => s.name), [`${MARK['claude-1']}-state`]);
  const d2 = JSON.parse(fx.read('claude-2', 'discover.json')).user;
  assert.deepEqual(d2.configDirs.map((c) => c.path), ['~/.hostapp/host/harness-accounts/claude-code/acc-2']);
  assert.deepEqual(d2.configDirs[0].mcpServers.map((s) => s.name), ['supabase', `${MARK['claude-2']}-state`], 'its own state file, not the one in the home folder');
  const dc = JSON.parse(fx.read('codex-1', 'discover.json')).user;
  assert.deepEqual([dc.configDirs.length, dc.codex.length, dc.agentsDirs.length], [0, 1, 0]);
  const da = JSON.parse(fx.read('agents-1', 'discover.json')).user;
  assert.deepEqual([da.configDirs.length, da.codex.length, da.agentsDirs.length], [0, 0, 1]);
  // The findings of an account are that account's: one base-URL override each, never two.
  for (const id of ['claude-1', 'claude-2', 'codex-1']) {
    const urls = JSON.parse(fx.read(id, 'checks.json')).checks.filter((c) => c.id === 'env-base-url-override');
    assert.deepEqual(urls.map((c) => c.evidence.includes(MARK[id])), [true], id);
  }
});

// The CLI probe has a part about the machine (what is installed) and a part about the account
// (which MCP servers it has configured, and so which `mcp` signals match). The accounts share
// the first and nothing of the second.
test('the CLI probe of an account names its own MCP servers; only the machine part is shared', () => {
  const clis = Object.fromEntries(IDS.map((id) => [id, JSON.parse(fx.read(id, 'clis.json'))]));
  const [a, b, c] = [MARK['claude-1'], MARK['claude-2'], MARK['codex-1']];
  assert.deepEqual(Object.fromEntries(IDS.map((id) => [id, clis[id].context.mcpServers])), {
    'claude-1': [`${a}-settings`, `${a}-state`],
    'claude-2': ['supabase', `${b}-settings`, `${b}-state`],
    'codex-1': ['vercel', `${c}_srv`],
    'agents-1': [],
  });
  for (const id of IDS) assert.deepEqual(clis[id].account, { provider: PROVIDER[id], path: fx.display(id), supported: true });

  // A server one account has is a signal for that account's tools, in its probe and in its snapshot.
  const want = { 'claude-1': [], 'claude-2': ['supabase'], 'codex-1': ['vercel'], 'agents-1': [] };
  const inProbe = (id) => clis[id].tools.filter((t) => t.signalsMatched.some((s) => s.type === 'mcp')).map((t) => t.id);
  const inSnapshot = (id) => JSON.parse(fx.read(id, 'snapshot.json')).elements.clis.filter((t) => (t.signals || []).some((s) => s.startsWith('mcp:'))).map((t) => t.name);
  assert.ok(['supabase', 'vercel'].every((tool) => clis['claude-1'].tools.some((t) => t.id === tool)), 'the catalog still lists both tools');
  assert.deepEqual(Object.fromEntries(IDS.map((id) => [id, inProbe(id)])), want);
  assert.deepEqual(Object.fromEntries(IDS.map((id) => [id, inSnapshot(id)])), want);

  // The machine was probed once, by the first account to get there; the others took that part from it.
  const whole = IDS.filter((id) => !('toolsReused' in clis[id]));
  assert.equal(whole.length, 1);
  const machine = (id) => [clis[id].tools.map(({ signalsMatched, unknownSignalTypes, ...rest }) => rest), clis[id].packageManagers];
  assert.ok(clis[whole[0]].tools.length > 0);
  for (const id of IDS) {
    assert.deepEqual(machine(id), machine(whole[0]), id);
    const entry = fx.probe.json.harnesses.find((h) => h.id === id).probes.clis;
    if (id === whole[0]) { assert.ok(!('toolsFrom' in entry)); continue; }
    assert.equal(clis[id].toolsReused, clis[id].tools.length, id);
    assert.equal(entry.toolsFrom, whole[0]);
  }
});

test('impact and estimates of one account hold nothing of another', () => {
  for (const id of IDS) {
    for (const name of ['impact.json', 'estimates.json']) {
      const text = fx.read(id, name);
      if (text === null) continue; // not measured for this provider
      for (const other of others(id)) assert.ok(!text.includes(MARK[other]), `${id}/${name} holds the marker of ${other}`);
    }
  }
});

test('without the two flags the scripts still read every account, as they always did', () => {
  for (const script of ['discover.mjs', 'harness-checks.mjs']) {
    const r = runScript(script, ['--scope', 'user', '--cwd', fx.dirs['claude-1']], { env: fx.env });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!('account' in r.json));
    for (const id of IDS) assert.ok(r.stdout.includes(MARK[id]), `${script}: ${id}`);
  }
});

test('the two flags go together, name a real folder and a known provider, and belong to the user scope', () => {
  const dir = fx.dirs['claude-2'];
  const bad = {
    'discover.mjs': [
      ['--scope', 'user', '--config-dir', dir],
      ['--scope', 'user', '--provider', 'nobody', '--config-dir', dir],
      ['--scope', 'project', '--cwd', fx.root, '--provider', 'claude-code', '--config-dir', dir],
    ],
    'harness-checks.mjs': [
      ['--scope', 'user', '--provider', 'claude-code'],
      ['--scope', 'user', '--provider', 'claude-code', '--config-dir', path.join(fx.root, 'nope')],
      ['--scope', 'project', '--cwd', fx.root, '--provider', 'claude-code', '--config-dir', dir],
    ],
  };
  for (const [script, cases] of Object.entries(bad)) {
    for (const args of cases) {
      const r = runScript(script, args, { env: fx.env });
      assert.equal(r.code, 2, `${script} ${args.join(' ')}`);
      assert.equal(r.stdout, '');
      assert.ok(!r.stderr.replace(/\\/g, '/').includes(fx.root.replace(/\\/g, '/')), 'no absolute path in the message');
    }
    // A provider the script has no reader for: nothing is read, and the output says so.
    const none = runScript(script, ['--scope', 'user', '--provider', 'gemini', '--config-dir', dir], { env: fx.env });
    assert.equal(none.code, 0, none.stderr);
    assert.deepEqual(none.json.account, { provider: 'gemini', path: fx.display('claude-2'), supported: false });
    for (const id of IDS) assert.ok(!none.stdout.includes(MARK[id]), `${script}: ${id}`);
    if (script !== 'harness-checks.mjs') continue;
    // "Nothing was read" must not read as "nothing was found": every check is listed as skipped.
    assert.deepEqual([none.json.checks, none.json.defenses], [[], []]);
    assert.deepEqual(none.json.skipped.map((s) => s.id), CHECK_IDS);
    assert.ok(none.json.skipped.every((s) => /"gemini" account: nothing was read, so nothing was checked$/.test(s.reason)));
    const one = runScript(script, ['--scope', 'user', '--provider', 'gemini', '--config-dir', dir, '--only', 'hook-auto-allow'], { env: fx.env });
    assert.deepEqual(one.json.skipped.map((s) => s.id), ['hook-auto-allow']);
  }
});
