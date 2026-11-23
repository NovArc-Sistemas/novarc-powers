// accounts.mjs list / diff. Every test runs against a fake home under os.tmpdir().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildHome, acc, rmrf, write, snapshot, assertClean, assertCanariesUntouched, addLinkedAccount,
  planAndApply, dropLink, PRIMARY_EMAIL, SECOND_EMAIL, CANARY,
} from './accounts-fixture.mjs';

const STATES = ['linked', 'generated', 'copied', 'divergent', 'missing', 'account-only', 'not-portable'];
const stateOf = (diff, id, name) => {
  const a = diff.accounts.find((x) => x.id === id);
  const e = a && a.sync.elements.find((x) => x.name === name);
  return e ? e.state : undefined;
};

test('list: two Claude dirs, Codex and the shared agents dir, with stable ids', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  const r = acc(h.home, ['list']);
  assert.equal(r.code, 0, r.stderr);
  const byId = Object.fromEntries(r.json.accounts.map((a) => [a.id, a]));
  assert.deepEqual(Object.keys(byId), ['claude-1', 'claude-2', 'codex-1', 'agents-1']);
  assert.deepEqual(
    { provider: byId['claude-1'].provider, label: byId['claude-1'].label, path: byId['claude-1'].path, isDefault: byId['claude-1'].isDefault, host: byId['claude-1'].host, linksInto: byId['claude-1'].linksInto },
    { provider: 'claude-code', label: 'Claude Code · account 1', path: '~/.claude', isDefault: true, host: null, linksInto: null },
  );
  assert.equal(byId['claude-2'].path, '~/.hostapp/host/harness-accounts/claude-code/acc-1');
  assert.equal(byId['claude-2'].isDefault, false);
  assert.equal(byId['claude-2'].host, 'hostapp');
  assert.equal(byId['claude-2'].label, 'Claude Code · account 2');
  assert.equal(byId['codex-1'].provider, 'codex');
  assert.equal(byId['codex-1'].path, '~/.codex');
  assert.equal(byId['agents-1'].provider, 'agents');
  assert.deepEqual(r.json.inUse, { 'claude-code': 'claude-1', codex: 'codex-1' });
  for (const a of r.json.accounts) {
    assert.deepEqual(Object.keys(a).filter((k) => k !== 'identity'), ['id', 'provider', 'label', 'path', 'pathAbs', 'isDefault', 'host', 'linksInto', 'elements', 'empty']);
    assert.ok(path.isAbsolute(a.pathAbs));
    assert.match(a.id, /^[a-z0-9][a-z0-9-]*$/);
  }
});

test('list: the identity is masked, and only pathAbs is absolute', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  const r = acc(h.home, ['list']);
  const byId = Object.fromEntries(r.json.accounts.map((a) => [a.id, a]));
  assert.equal(byId['claude-1'].identity, 'pr…@example.com');
  assert.equal(byId['claude-2'].identity, 'se…@example.com');
  assert.equal(byId['codex-1'].identity, undefined, 'Codex keeps the identity in its credential file, which is never opened');
  assert.ok(!r.stdout.includes(PRIMARY_EMAIL) && !r.stdout.includes(SECOND_EMAIL), 'a full e-mail reached the output');
  assert.ok(!r.stdout.includes(PRIMARY_EMAIL.split('@')[0]), 'the local part reached the output');
  assertClean(assert, h, r.stdout + r.stderr, { allowAbs: true });
  // Without the pathAbs fields nothing absolute is left.
  const stripped = JSON.stringify({ ...r.json, accounts: r.json.accounts.map(({ pathAbs, ...rest }) => rest) });
  assertClean(assert, h, stripped);
  assertCanariesUntouched(assert, h);
});

test('list: a dir named by CLAUDE_CONFIG_DIR is an account, and is the one in use', (t) => {
  const h = buildHome({ second: false, codex: false, agents: false });
  t.after(() => rmrf(h.root));
  const extra = path.join(h.root, 'profile-b');
  write(path.join(extra, 'settings.json'), '{}\n');
  const r = acc(h.home, ['list'], { CLAUDE_CONFIG_DIR: extra });
  assert.deepEqual(r.json.accounts.map((a) => a.id), ['claude-1', 'claude-2']);
  assert.equal(r.json.accounts[1].isDefault, false);
  assert.equal(r.json.accounts[1].host, null);
  assert.equal(r.json.inUse['claude-code'], 'claude-2');
  // The default dir named again by the variable is still one account.
  const again = acc(h.home, ['list'], { CLAUDE_CONFIG_DIR: h.claude });
  assert.deepEqual(again.json.accounts.map((a) => a.id), ['claude-1']);
});

test('list: an account whose files already link into another is detected', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  addLinkedAccount(h);
  const r = acc(h.home, ['list']);
  const third = r.json.accounts.find((a) => a.path.endsWith('/acc-2'));
  assert.equal(third.id, 'claude-3');
  assert.equal(third.linksInto, 'claude-1');
  assert.equal(r.json.accounts.find((a) => a.id === 'claude-2').linksInto, null);
  assert.equal(r.json.accounts.find((a) => a.id === 'claude-1').linksInto, null);
});

test('list: hardlinked files count as links into the default account, not the other way round', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  addLinkedAccount(h, { hard: true });
  const r = acc(h.home, ['list']);
  assert.equal(r.json.accounts.find((a) => a.id === 'claude-3').linksInto, 'claude-1');
  assert.equal(r.json.accounts.find((a) => a.id === 'claude-1').linksInto, null);
});

test('diff: every state, with the schema shape', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  addLinkedAccount(h);
  const r = acc(h.home, ['diff', '--primary', 'claude-1']);
  assert.equal(r.code, 0, r.stderr);
  const d = r.json;
  assert.equal(d.primary, 'claude-1');
  assert.deepEqual(d.accounts[0].sync, { mode: 'primary', status: 'ok', detail: 'the source the other accounts follow', elements: [] });
  // Same provider: compared as files and folders.
  assert.equal(stateOf(d, 'claude-2', 'CLAUDE.md'), 'divergent');
  assert.equal(stateOf(d, 'claude-2', 'settings.json'), 'copied');
  assert.equal(stateOf(d, 'claude-2', 'commands/'), 'copied');
  assert.equal(stateOf(d, 'claude-2', 'skills/'), 'divergent');
  assert.equal(stateOf(d, 'claude-2', 'keybindings.json'), 'missing');
  assert.equal(stateOf(d, 'claude-2', 'RTK.md'), 'missing', 'an import of the primary instruction file');
  assert.equal(stateOf(d, 'claude-2', 'NESTED.md'), 'missing', 'an import of an import');
  assert.equal(stateOf(d, 'claude-2', 'docs/extra.md'), 'missing', 'an import in a sub-folder');
  assert.equal(stateOf(d, 'claude-2', 'statusline.sh'), 'missing', 'the status line script named in settings.json');
  assert.equal(stateOf(d, 'claude-2', 'output-styles/'), 'account-only');
  assert.equal(stateOf(d, 'claude-2', 'rules/style.md'), undefined, 'an import inside a linked folder is covered by the folder');
  assert.equal(stateOf(d, 'claude-3', 'CLAUDE.md'), 'linked');
  assert.equal(stateOf(d, 'claude-3', 'skills/'), 'linked');
  // MCP servers of the same provider.
  assert.equal(stateOf(d, 'claude-2', 'mcp servers/context7'), 'copied');
  assert.equal(stateOf(d, 'claude-2', 'mcp servers/remote'), 'missing');
  assert.equal(stateOf(d, 'claude-2', 'mcp servers/only-here'), 'account-only');
  assert.equal(stateOf(d, 'claude-2', 'mcp servers/leaky'), 'not-portable');
  // Another provider: instruction file, MCP servers, and what cannot travel.
  assert.equal(stateOf(d, 'codex-1', 'AGENTS.md'), 'divergent');
  assert.equal(stateOf(d, 'codex-1', 'mcp servers/context7'), 'missing');
  assert.equal(stateOf(d, 'codex-1', 'mcp servers/existing'), 'account-only');
  assert.equal(stateOf(d, 'codex-1', 'mcp servers/streamy'), 'not-portable', 'SSE has no Codex equivalent');
  for (const n of ['permissions', 'hooks', 'plugins', 'keybindings']) assert.equal(stateOf(d, 'codex-1', n), 'not-portable');
  const note = (n) => d.accounts.find((a) => a.id === 'codex-1').sync.elements.find((e) => e.name === n).note;
  assert.match(note('permissions'), /1 deny, 1 ask and 2 allow/);
  assert.match(note('hooks'), /PreToolUse/);
  // The shared skills folder takes skills only.
  assert.equal(stateOf(d, 'agents-1', 'skills/alpha'), 'missing');
  assert.equal(stateOf(d, 'agents-1', 'skills/shared-skill'), 'account-only');
  assert.equal(stateOf(d, 'agents-1', 'permissions'), undefined);
  // Codex reads the shared folder, so it gets no skill links of its own while that folder takes part.
  assert.equal(stateOf(d, 'codex-1', 'skills/alpha'), undefined);
  assert.ok(d.accounts.find((a) => a.id === 'codex-1').notes.some((n) => /~\/\.agents\/skills/.test(n)));

  // Shape: exactly what the state schema's accounts.list[].sync accepts.
  for (const a of d.accounts) {
    assert.deepEqual(Object.keys(a.sync), ['mode', 'status', 'detail', 'elements']);
    assert.ok(['primary', 'linked', 'replicated', 'independent'].includes(a.sync.mode));
    assert.ok(['ok', 'drift', 'broken', 'none'].includes(a.sync.status));
    for (const e of a.sync.elements) {
      assert.ok(STATES.includes(e.state), e.state);
      assert.ok(Object.keys(e).every((k) => ['name', 'state', 'note'].includes(k)));
    }
  }
  assert.equal(d.accounts.find((a) => a.id === 'claude-2').sync.mode, 'independent');
  assert.equal(d.accounts.find((a) => a.id === 'claude-3').sync.mode, 'linked', 'links made by hand already count');
  assert.equal(d.syncInstalled, false);
  assert.deepEqual(Object.keys(d.summary), STATES);
  assert.ok(STATES.filter((s) => s !== 'generated').every((s) => d.summary[s] > 0), JSON.stringify(d.summary));
  assertClean(assert, h, r.stdout + r.stderr);
});

test('diff: after an apply the generated state appears and the accounts read ok', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  const run = planAndApply(h, 'claude-1', ['--resolve', 'codex-1:AGENTS.md=replace-with-primary', '--resolve', 'claude-2:CLAUDE.md=replace-with-primary', '--resolve', 'claude-2:skills/=replace-with-primary']);
  assert.equal(run.apply.code, 0, run.apply.stdout);
  const d = acc(h.home, ['diff']).json; // the primary now comes from the manifest
  assert.equal(d.primary, 'claude-1');
  assert.equal(stateOf(d, 'codex-1', 'AGENTS.md'), 'generated');
  assert.equal(stateOf(d, 'codex-1', 'mcp servers/context7'), 'generated');
  assert.equal(stateOf(d, 'claude-2', 'CLAUDE.md'), 'linked');
  assert.equal(stateOf(d, 'claude-2', 'mcp servers/remote'), 'generated');
  const mode = Object.fromEntries(d.accounts.map((a) => [a.id, `${a.sync.mode}/${a.sync.status}`]));
  assert.deepEqual(mode, { 'claude-1': 'primary/ok', 'claude-2': 'linked/ok', 'codex-1': 'replicated/ok', 'agents-1': 'replicated/ok' });
  const kept = d.accounts.find((a) => a.id === 'claude-2').sync.elements.find((e) => e.name === 'output-styles/');
  assert.match(kept.note, /kept as an account exception/);
});

test('diff: a generated file edited by hand reads divergent, and a changed primary reads out of date', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  planAndApply(h, 'claude-1', ['--resolve', 'codex-1:AGENTS.md=replace-with-primary']);
  fs.appendFileSync(path.join(h.claude, 'CLAUDE.md'), '\nOne more rule.\n');
  let d = acc(h.home, ['diff']).json;
  let el = d.accounts.find((a) => a.id === 'codex-1').sync.elements.find((e) => e.name === 'AGENTS.md');
  assert.equal(el.state, 'generated');
  assert.match(el.note, /out of date/);
  assert.equal(d.accounts.find((a) => a.id === 'codex-1').sync.status, 'drift');
  fs.appendFileSync(path.join(h.codexDir, 'AGENTS.md'), '\nHand edit.\n');
  d = acc(h.home, ['diff']).json;
  el = d.accounts.find((a) => a.id === 'codex-1').sync.elements.find((e) => e.name === 'AGENTS.md');
  assert.equal(el.state, 'divergent');
  assert.match(el.note, /edited by hand/);
});

test('diff and list write nothing and never touch credentials or sessions', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  const before = snapshot(h.home);
  const outputs = [acc(h.home, ['list']), acc(h.home, ['diff', '--primary', 'claude-1']), acc(h.home, ['diff', '--primary', 'codex-1']), acc(h.home, ['plan', '--primary', 'claude-1'])];
  for (const r of outputs) assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(snapshot(h.home), before);
  assertCanariesUntouched(assert, h);
  for (const r of outputs.slice(1)) assertClean(assert, h, r.stdout + r.stderr);
  assert.ok(outputs.every((r) => !r.stdout.includes(CANARY)));
});

test('diff: Codex as the primary generates CLAUDE.md and translates its servers', (t) => {
  const h = buildHome({ second: false, agents: false });
  t.after(() => rmrf(h.root));
  const d = acc(h.home, ['diff', '--primary', 'codex-1']).json;
  assert.equal(stateOf(d, 'claude-1', 'CLAUDE.md'), 'divergent');
  assert.equal(stateOf(d, 'claude-1', 'mcp servers/existing'), 'missing');
  assert.equal(stateOf(d, 'claude-1', 'mcp servers/context7'), 'account-only');
  assert.equal(stateOf(d, 'claude-1', 'skills/own-skill'), 'missing');
  assert.equal(stateOf(d, 'claude-1', 'skills/alpha'), 'account-only');
  assert.equal(stateOf(d, 'claude-1', 'permissions'), 'not-portable');
});

test('diff: a folder the primary keeps elsewhere through a link is compared by what it holds', (t) => {
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  // The primary's commands/ is a link into a mirror folder; the account has an identical real folder.
  const mirror = path.join(h.root, 'mirror', 'commands');
  write(path.join(mirror, 'ship.md'), 'Ship it.\n');
  fs.rmSync(path.join(h.claude, 'commands'), { recursive: true, force: true });
  fs.symlinkSync(mirror, path.join(h.claude, 'commands'), 'junction');
  let d = acc(h.home, ['diff', '--primary', 'claude-1']).json;
  assert.equal(stateOf(d, 'claude-2', 'commands/'), 'copied');
  write(path.join(h.acc, 'commands', 'extra.md'), 'Only here.\n');
  d = acc(h.home, ['diff', '--primary', 'claude-1']).json;
  assert.equal(stateOf(d, 'claude-2', 'commands/'), 'divergent');
  // An account folder that is a link to somewhere other than the primary is not "linked".
  fs.rmSync(path.join(h.acc, 'commands'), { recursive: true, force: true });
  const elsewhere = path.join(h.root, 'elsewhere');
  write(path.join(elsewhere, 'ship.md'), 'Ship it.\n');
  fs.symlinkSync(elsewhere, path.join(h.acc, 'commands'), 'junction');
  d = acc(h.home, ['diff', '--primary', 'claude-1']).json;
  const el = d.accounts.find((a) => a.id === 'claude-2').sync.elements.find((e) => e.name === 'commands/');
  assert.equal(el.state, 'copied');
  assert.match(el.note, /a link to another place/);
});

test('list: lock, backup, temporary and hidden folders beside an account are not accounts', (t) => {
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  const base = path.dirname(h.acc); // ~/.hostapp/host/harness-accounts/claude-code
  // What a host app leaves beside a real account folder. Each of these even holds a marker file,
  // so only its name keeps it out.
  for (const name of ['acc-1.lock', 'acc-1.bak', 'acc-1.old', 'acc-1.tmp', 'acc-1.backup', 'ACC-1.LOCK', '.staging', '_trash']) {
    write(path.join(base, name, 'settings.json'), '{}\n');
    write(path.join(base, name, '.claude.json'), '{}\n');
  }
  // A lock folder as the real case had it: nothing of its own, only a link to the account's projects.
  const lock = path.join(base, '0c9d7a52-uuid.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.symlinkSync(path.join(h.acc, 'projects'), path.join(lock, 'projects'), 'junction');
  // A plain folder with an ordinary name but nothing an account has: no marker, not an account.
  const stray = path.join(base, 'stray');
  write(path.join(stray, 'skills', 'x', 'SKILL.md'), 'x\n');
  write(path.join(stray, 'notes.txt'), 'x\n');
  fs.symlinkSync(path.join(h.acc, 'projects'), path.join(stray, 'projects'), 'junction');
  // The same rules one level up, for the per-agent folders.
  write(path.join(path.dirname(base), 'claude-code.bak', 'acc-7', 'settings.json'), '{}\n');
  write(path.join(path.dirname(base), '_old', 'acc-8', 'settings.json'), '{}\n');
  const r = acc(h.home, ['list']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.accounts.map((a) => `${a.id}=${a.path}`), ['claude-1=~/.claude', 'claude-2=~/.hostapp/host/harness-accounts/claude-code/acc-1']);

  // Each kind of marker makes an ordinary-named folder an account: settings, instructions,
  // state, credentials (its presence only: it is never opened), or a real projects folder.
  write(path.join(base, 'm-settings', 'settings.json'), '{}\n');
  write(path.join(base, 'm-instructions', 'CLAUDE.md'), '# x\n');
  write(path.join(base, 'm-state', '.claude.json'), '{}\n');
  write(path.join(base, 'm-credentials', '.credentials.json'), `{"token":"${CANARY}"}\n`);
  write(path.join(base, 'm-projects', 'projects', 'p', 's.jsonl'), `${CANARY}\n`);
  const again = acc(h.home, ['list']);
  assert.deepEqual(again.json.accounts.map((a) => a.path.split('/').pop()), ['.claude', 'acc-1', 'm-credentials', 'm-instructions', 'm-projects', 'm-settings', 'm-state']);
  assert.ok(!again.stdout.includes(CANARY));
  // Codex account folders of a host app follow the same rules with their own markers.
  const cbase = path.join(path.dirname(base), 'codex');
  write(path.join(cbase, 'c-1', 'config.toml'), 'model = "x"\n');
  write(path.join(cbase, 'c-1.lock', 'config.toml'), 'model = "x"\n');
  write(path.join(cbase, 'c-2', 'notes.txt'), 'x\n');
  write(path.join(cbase, 'c-3', 'auth.json'), `{"t":"${CANARY}"}\n`);
  const codex = acc(h.home, ['list']).json.accounts.filter((a) => a.provider === 'codex');
  assert.deepEqual(codex.map((a) => `${a.id}=${a.path.split('/').pop()}`), ['codex-1=c-1', 'codex-2=c-3']);
});

test('list: elements counts the harness an account holds, and empty marks one with none', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  const base = path.dirname(h.acc);
  // A fresh account: logged in, used, but with no harness of its own.
  write(path.join(base, 'fresh', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: SECOND_EMAIL }, mcpServers: {} }));
  write(path.join(base, 'fresh', '.credentials.json'), `{"token":"${CANARY}"}\n`);
  write(path.join(base, 'fresh', 'projects', 'p', 's.jsonl'), `${CANARY}\n`);
  fs.mkdirSync(path.join(base, 'fresh', 'skills'), { recursive: true }); // an empty folder is not harness
  write(path.join(base, 'fresh', 'settings.local.json'), '{}\n'); // account-local: never counted
  // An account whose only harness is a user-level MCP server.
  write(path.join(base, 'only-mcp', '.claude.json'), JSON.stringify({ mcpServers: { one: { command: 'node' } } }));
  fs.mkdirSync(path.join(h.home, '.cursor'), { recursive: true });
  const r = acc(h.home, ['list']);
  assert.equal(r.code, 0, r.stderr);
  const by = Object.fromEntries(r.json.accounts.map((a) => [a.path.split('/').pop(), a]));
  // .claude: CLAUDE.md + 3 imported files + settings.json + keybindings.json + statusline.sh
  //          + skills, agents, commands, rules, plugins + its MCP servers.
  assert.deepEqual([by['.claude'].elements, by['.claude'].empty], [13, false]);
  // acc-1: CLAUDE.md, settings.json, skills, commands, output-styles, MCP servers.
  assert.deepEqual([by['acc-1'].elements, by['acc-1'].empty], [6, false]);
  // .codex: AGENTS.md, config.toml, skills.
  assert.deepEqual([by['.codex'].elements, by['.codex'].empty], [3, false]);
  assert.deepEqual([by['.agents'].elements, by['.agents'].empty], [1, false]);
  assert.deepEqual([by.fresh.elements, by.fresh.empty], [0, true]);
  assert.deepEqual([by['only-mcp'].elements, by['only-mcp'].empty], [1, false]);
  assert.deepEqual([by['.cursor'].elements, by['.cursor'].empty], [0, true]);
  for (const a of r.json.accounts) {
    assert.ok(Number.isInteger(a.elements) && a.elements >= 0);
    assert.equal(a.empty, a.elements === 0);
  }
  assert.equal(by.fresh.identity, 'se…@example.com', 'an empty account is still identified');
  assertClean(assert, h, r.stdout, { allowAbs: true });
  // A Cursor folder with its own MCP file is not empty, even though nothing in it is linked.
  write(path.join(h.home, '.cursor', 'mcp.json'), '{"mcpServers": {}}\n');
  assert.equal(acc(h.home, ['list']).json.accounts.find((a) => a.provider === 'cursor').empty, false);
});

test('diff: suggested says what could follow the primary, without changing mode or status', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  write(path.join(h.home, '.cursor', 'mcp.json'), '{"mcpServers": {}}\n');
  write(path.join(h.home, '.config', 'opencode', 'opencode.json'), '{}\n');
  let d = acc(h.home, ['diff', '--primary', 'claude-1']).json;
  const by = (id) => d.accounts.find((a) => a.id === id);
  for (const a of d.accounts) {
    assert.ok(['link', 'replicate', 'none'].includes(a.suggested), a.suggested);
    assert.ok(typeof a.suggestionText === 'string' && a.suggestionText.length > 10 && !a.suggestionText.includes('\n'));
    assert.deepEqual(Object.keys(a.sync), ['mode', 'status', 'detail', 'elements'], 'the suggestion sits beside sync, not inside it');
  }
  assert.deepEqual([by('claude-1').suggested, by('claude-1').sync.mode], ['none', 'primary']);
  assert.match(by('claude-1').suggestionText, /This is the primary/);
  // Same provider, not linked yet: still independent / none, and the suggestion is to link.
  assert.deepEqual([by('claude-2').sync.mode, by('claude-2').sync.status, by('claude-2').suggested], ['independent', 'none', 'link']);
  assert.match(by('claude-2').suggestionText, /^Same provider as the primary: \d+ elements can be linked to it, 2 of them after your decision\.$/);
  // Another provider with something portable: replicate.
  assert.deepEqual([by('codex-1').sync.mode, by('codex-1').sync.status, by('codex-1').suggested], ['independent', 'none', 'replicate']);
  assert.match(by('codex-1').suggestionText, /^Another provider: 3 elements can be generated from the primary, 1 of them after your decision\.$/);
  assert.deepEqual([by('agents-1').suggested, by('opencode-1').suggested], ['replicate', 'replicate']);
  assert.match(by('opencode-1').suggestionText, /^Another provider: 1 element can be generated from the primary\.$/);
  // Nothing portable at all.
  assert.deepEqual([by('cursor-1').sync.mode, by('cursor-1').suggested], ['independent', 'none']);
  assert.match(by('cursor-1').suggestionText, /Nothing in this account can follow the primary/);
  // Once everything follows (or was kept apart on purpose), there is nothing left to suggest.
  const run = planAndApply(h, 'claude-1', ['--resolve', 'codex-1:AGENTS.md=replace-with-primary', '--resolve', 'claude-2:CLAUDE.md=replace-with-primary', '--resolve', 'claude-2:skills/=replace-with-primary']);
  assert.equal(run.apply.code, 0, run.apply.stdout);
  d = acc(h.home, ['diff']).json;
  for (const id of ['claude-2', 'codex-1', 'agents-1', 'opencode-1']) {
    assert.deepEqual([by(id).suggested, by(id).sync.status], ['none', 'ok'], id);
    assert.match(by(id).suggestionText, /Already follows the primary/);
  }
  // A new gap brings the suggestion back for that account only.
  dropLink(path.join(h.acc, 'keybindings.json'));
  d = acc(h.home, ['diff']).json;
  assert.deepEqual([by('claude-2').sync.mode, by('claude-2').sync.status, by('claude-2').suggested], ['linked', 'drift', 'link']);
  assert.equal(by('codex-1').suggested, 'none');
});

test('--lang: the same structure in both languages, with Portuguese wording under pt', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  addLinkedAccount(h);
  write(path.join(h.home, '.cursor', 'mcp.json'), '{"mcpServers": {}}\n');
  const EM_DASH = String.fromCharCode(0x2014);
  // list: only the label changes.
  const listEn = acc(h.home, ['list']).json;
  const listPt = acc(h.home, ['list', '--lang', 'pt']).json;
  assert.deepEqual(acc(h.home, ['list', '--lang=en']).json, listEn, 'en is the default');
  const noLabel = (l) => ({ ...l, accounts: l.accounts.map(({ label, ...rest }) => rest) });
  assert.deepEqual(noLabel(listPt), noLabel(listEn));
  assert.deepEqual(listPt.accounts.map((a) => a.label), ['Claude Code · conta 1', 'Claude Code · conta 2', 'Claude Code · conta 3', 'Codex · conta 1', 'Cursor · conta 1', 'Pasta compartilhada de agentes']);
  assert.deepEqual(listEn.accounts.map((a) => a.label), ['Claude Code · account 1', 'Claude Code · account 2', 'Claude Code · account 3', 'Codex · account 1', 'Cursor · account 1', 'Shared agents dir']);

  // diff: every machine field identical; every sentence present in both, and different.
  const en = acc(h.home, ['diff', '--primary', 'claude-1']);
  const pt = acc(h.home, ['diff', '--primary', 'claude-1', '--lang', 'pt']);
  assert.equal(pt.code, 0, pt.stderr);
  const machine = (d) => ({
    primary: d.primary, summary: d.summary, syncInstalled: d.syncInstalled, warnings: (d.warnings || []).length,
    accounts: d.accounts.map((a) => ({ id: a.id, provider: a.provider, path: a.path, suggested: a.suggested, notes: (a.notes || []).length, mode: a.sync.mode, status: a.sync.status, elements: a.sync.elements.map((e) => [e.name, e.state, 'note' in e]) })),
  });
  assert.deepEqual(machine(pt.json), machine(en.json));
  const sentences = (d) => d.accounts.flatMap((a) => [a.label, a.sync.detail, a.suggestionText, ...(a.notes || []), ...a.sync.elements.filter((e) => e.note).map((e) => e.note)]);
  const sEn = sentences(en.json);
  const sPt = sentences(pt.json);
  assert.equal(sPt.length, sEn.length);
  sPt.forEach((s, i) => assert.notEqual(s, sEn[i], `not translated: ${s}`));
  assert.ok(!pt.stdout.includes(EM_DASH), 'an em dash reached the Portuguese output');
  const text = sPt.join('\n');
  for (const expected of [
    'a fonte que as outras contas seguem', 'Esta é a conta principal: as outras a seguem.', 'mesmo conteúdo, sem vínculo',
    'link simbólico', 'contém um segredo embutido (env GITHUB_TOKEN); mova-o antes para uma variável de ambiente na conta principal',
    'escrito para esta conta', 'o transporte SSE não tem equivalente no destino', 'As regras de permissão (1 de negar, 1 de perguntar, 2 de permitir)',
    'registrados aqui: PreToolUse', 'Os atalhos de teclado pertencem a cada app', 'skills: lê ~/.agents/skills, onde são vinculadas uma única vez (agents-1)',
    'instruções: 1 import da conta principal não resolve e fica como texto', 'O Cursor guarda as regras do usuário',
    'Mesmo provedor da conta principal:', 'Outro provedor: 3 elementos podem ser gerados a partir da conta principal, 1 deles depois da sua decisão.',
    'Nada nesta conta pode seguir a conta principal',
  ]) assert.ok(text.includes(expected), `missing in pt: ${expected}`);
  const detail = pt.json.accounts.find((a) => a.id === 'claude-2').sync.detail;
  assert.match(detail, /^\d+ copiados, \d+ divergentes, \d+ faltando, \d+ só nesta conta, 1 não portável$/);
  assert.match(en.json.accounts.find((a) => a.id === 'claude-2').sync.detail, /^\d+ copied, \d+ divergent, \d+ missing, \d+ account-only, 1 not-portable$/);
  assertClean(assert, h, pt.stdout + pt.stderr);

  // Regional forms are accepted; anything else is a usage error, never a silent fallback.
  assert.deepEqual(acc(h.home, ['diff', '--primary', 'claude-1', '--lang', 'pt-BR']).json, pt.json);
  for (const bad of [['--lang', 'es'], ['--lang'], ['--lang=']]) {
    for (const cmd of [['list'], ['diff', '--primary', 'claude-1'], ['plan', '--primary', 'claude-1']]) {
      const r = acc(h.home, [...cmd, ...bad]);
      assert.equal(r.code, 2, `${cmd[0]} ${bad.join(' ')}`);
      assert.match(r.stderr, /--lang must be pt or en/);
      assert.equal(r.stdout, '');
    }
  }
});

test('diff: bad arguments exit 2 and say why', (t) => {
  const h = buildHome({ second: false, codex: false, agents: false });
  t.after(() => rmrf(h.root));
  const none = acc(h.home, ['diff']);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /--primary/);
  const unknown = acc(h.home, ['diff', '--primary', 'claude-9']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown account/);
  assert.equal(acc(h.home, ['frobnicate']).code, 2);
  assert.equal(acc(h.home, []).code, 2);
});

test('list: an empty home has no accounts', (t) => {
  const h = buildHome({ second: false, codex: false, agents: false });
  t.after(() => rmrf(h.root));
  fs.rmSync(h.claude, { recursive: true, force: true });
  const r = acc(h.home, ['list']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.accounts, []);
  assert.deepEqual(r.json.inUse, { 'claude-code': null, codex: null });
});
