// session-impact.mjs told which account to read holds nothing of another account.
// A fake home with two Claude accounts (the default `~/.claude`, whose state file is
// `~/.claude.json`, and a second one kept by a host app, whose state file lives inside its own
// dir), a Codex home and `~/.agents`. Every skill and MCP server carries the marker of the
// account it belongs to, so a marker of one account in the output of another is a leak.
// Without `--config-dirs` / `--codex-dirs` every account is read, as it always was.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpDir, rmrf, homeEnv, runScript, write } from './helpers.mjs';
import { encodeProjectPath } from '../scripts/lib/locations.mjs';

const ONE = 'zqxone8801'; // the default Claude account
const TWO = 'zqxtwo8802'; // the second Claude account
const CDX = 'zqxcdx8803'; // the Codex home
const SHR = 'zqxshr8804'; // ~/.agents
const MARKS = [ONE, TWO, CDX, SHR];

const now = new Date();
const BASE = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2, 12);
let clock = 0;
const ts = () => new Date(BASE + (clock++) * 1000).toISOString();
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const sid = (d) => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
const server = { command: 'x' };
// One model call of 100 + 10 = 110 tokens.
const asst = (id, blocks) => ({
  parentUuid: null, isSidechain: false, type: 'assistant', timestamp: ts(),
  message: { model: 'claude-test-a', id, type: 'message', role: 'assistant', content: blocks, usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 } },
});
const skill = (dir, name) => write(path.join(dir, 'skills', name, 'SKILL.md'), `# ${name}\n`);

let home; let proj; let claude1; let claude2; let codex; let env;
const impact = (args) => {
  const r = runScript('session-impact.mjs', args, { env });
  assert.equal(r.code, 0, r.stderr);
  return r;
};
/** The markers found anywhere in what a run printed. */
const marksIn = (r) => MARKS.filter((m) => (r.stdout + r.stderr).includes(m));
const configured = (j) => ({ skills: Object.keys(j.skillInvocations).sort(), mcp: Object.keys(j.mcpCalls).sort() });

before(() => {
  home = tmpDir('hd-acct-home-');
  proj = tmpDir('hd-acct-proj-');
  env = homeEnv(home);
  claude1 = path.join(home, '.claude');
  claude2 = path.join(home, '.hostapp', 'host', 'harness-accounts', 'claude-code', 'acc-2');
  codex = path.join(home, '.codex');

  // The default account: its state file is in the home folder, outside its config dir. It also
  // records one server for the project.
  write(path.join(claude1, 'settings.json'), JSON.stringify({ mcpServers: { [`${ONE}-settings`]: server } }));
  write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { [`${ONE}-state`]: server }, projects: { [proj]: { mcpServers: { [`${ONE}-proj`]: server } } } }));
  skill(claude1, `${ONE}-skill`);
  // Its one session calls the server of its state file once.
  write(path.join(claude1, 'projects', encodeProjectPath(proj), `${sid('1')}.jsonl`), jsonl([asst('p1', [{ type: 'tool_use', id: 't1', name: `mcp__${ONE}-state__ping`, input: {} }])]));

  // The second account: everything it has lives inside its own dir.
  write(path.join(claude2, 'settings.json'), JSON.stringify({ mcpServers: { [`${TWO}-settings`]: server } }));
  write(path.join(claude2, '.claude.json'), JSON.stringify({ mcpServers: { [`${TWO}-state`]: server } }));
  skill(claude2, `${TWO}-skill`);
  write(path.join(claude2, 'projects', encodeProjectPath(proj), `${sid('2')}.jsonl`), jsonl([asst('q1', [{ type: 'text', text: 'ok' }])]));

  // The Codex home, with one session in the project: 100 input + 10 output = 110 tokens.
  write(path.join(codex, 'config.toml'), `[mcp_servers.${CDX}_srv]\ncommand = "x"\n`);
  skill(codex, `${CDX}-skill`);
  write(path.join(codex, 'sessions', '2026', '11', '20', `rollout-2026-11-20T12-00-00-${sid('3')}.jsonl`), jsonl([
    { timestamp: ts(), type: 'session_meta', payload: { id: sid('3'), cwd: proj } },
    { timestamp: ts(), type: 'turn_context', payload: { cwd: proj, model: 'codex-test' } },
    { timestamp: ts(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10, total_tokens: 110 } } } },
  ]));

  // The shared folder, a harness of its own.
  skill(path.join(home, '.agents'), `${SHR}-skill`);
});

after(() => { rmrf(home); rmrf(proj); });

test('the second Claude account alone: its own dir, not ~/.claude.json and not ~/.agents', () => {
  // What `run.mjs probe` asks for a Claude account.
  const r = impact(['--scope', 'user', '--config-dirs', claude2, '--sources', 'claude']);
  const j = r.json;
  assert.deepEqual([j.sources, j.totalTokens], [{ claude: 1, codex: 0 }, 110]);
  assert.deepEqual(j.skillInvocations, { [`${TWO}-skill`]: 0 });
  // Its own settings and its own state file. `zqxone8801-state` (in ~/.claude.json) is not its.
  assert.deepEqual(j.mcpCalls, { [`${TWO}-settings`]: 0, [`${TWO}-state`]: 0 });
  assert.deepEqual(j.toolCalls, {});
  assert.deepEqual(
    [j.unusedContext.skillsNeverInvoked, j.unusedContext.mcpServersNeverCalled, j.unusedContext.skillsConfigured, j.unusedContext.mcpServersConfigured],
    [[`${TWO}-skill`], [`${TWO}-settings`, `${TWO}-state`], 1, 2],
  );
  assert.deepEqual(marksIn(r), [TWO]);
});

test('the default Claude account alone: ~/.claude.json is its state file, ~/.agents is not its', () => {
  const r = impact(['--scope', 'user', '--config-dirs', claude1, '--sources', 'claude']);
  const j = r.json;
  assert.deepEqual([j.sources, j.totalTokens], [{ claude: 1, codex: 0 }, 110]);
  assert.deepEqual(j.skillInvocations, { [`${ONE}-skill`]: 0 });
  assert.deepEqual(j.mcpCalls, { [`${ONE}-state`]: 1, [`${ONE}-settings`]: 0 });
  assert.deepEqual(j.toolCalls, { [`mcp__${ONE}-state__ping`]: 1 });
  assert.deepEqual(j.unusedContext.mcpServersNeverCalled, [`${ONE}-settings`]);
  assert.deepEqual(marksIn(r), [ONE]);
  // The default dir is the default dir however it is spelled.
  const spelled = impact(['--scope', 'user', '--config-dirs', '~/.claude', '--sources', 'claude']);
  assert.deepEqual(spelled.json.mcpCalls, j.mcpCalls);
  assert.deepEqual(marksIn(spelled), [ONE]);
});

test('the Codex home alone: not ~/.agents, and nothing of a Claude account', () => {
  const r = impact(['--scope', 'user', '--sources', 'codex', '--codex-dirs', codex]);
  const j = r.json;
  assert.deepEqual([j.sources, j.totalTokens], [{ claude: 0, codex: 1 }, 110]);
  assert.deepEqual(j.skillInvocations, { [`${CDX}-skill`]: 0 });
  assert.deepEqual(j.mcpCalls, { [`${CDX}_srv`]: 0 });
  assert.deepEqual(marksIn(r), [CDX]);
});

test('with neither flag every account is read, as before', () => {
  const r = impact(['--scope', 'user']);
  const j = r.json;
  // Both Claude accounts (the second is found under the host app's folder) and the Codex home.
  assert.deepEqual([j.sources, j.totalTokens], [{ claude: 2, codex: 1 }, 330]);
  assert.deepEqual(j.skillInvocations, { [`${CDX}-skill`]: 0, [`${ONE}-skill`]: 0, [`${SHR}-skill`]: 0, [`${TWO}-skill`]: 0 });
  assert.deepEqual(j.mcpCalls, { [`${ONE}-state`]: 1, [`${CDX}_srv`]: 0, [`${ONE}-settings`]: 0, [`${TWO}-settings`]: 0, [`${TWO}-state`]: 0 });
  assert.deepEqual([j.unusedContext.skillsConfigured, j.unusedContext.mcpServersConfigured], [4, 5]);
  assert.deepEqual(marksIn(r), MARKS);
});

test('naming the accounts of one agent leaves the other agent on its default discovery', () => {
  // A Claude dir named, Codex not: the second account plus the Codex home. No ~/.claude.json
  // (the default dir is not among the dirs named) and no ~/.agents (an account was named).
  const a = impact(['--scope', 'user', '--config-dirs', claude2]);
  assert.deepEqual(a.json.sources, { claude: 1, codex: 1 });
  assert.deepEqual(configured(a.json), { skills: [`${CDX}-skill`, `${TWO}-skill`], mcp: [`${CDX}_srv`, `${TWO}-settings`, `${TWO}-state`] });
  assert.deepEqual(marksIn(a), [TWO, CDX]);
  // The Codex home named, Claude not: every Claude account, ~/.claude.json included, and no ~/.agents.
  const b = impact(['--scope', 'user', '--codex-dirs', codex]);
  assert.deepEqual(b.json.sources, { claude: 2, codex: 1 });
  assert.deepEqual(configured(b.json), {
    skills: [`${CDX}-skill`, `${ONE}-skill`, `${TWO}-skill`],
    mcp: [`${CDX}_srv`, `${ONE}-settings`, `${ONE}-state`, `${TWO}-settings`, `${TWO}-state`],
  });
  assert.deepEqual(marksIn(b), [ONE, TWO, CDX]);
  // Both Claude dirs named: the default one is among them, so ~/.claude.json is read.
  const c = impact(['--scope', 'user', '--config-dirs', `${claude2},${claude1}`, '--sources', 'claude']);
  assert.deepEqual(configured(c.json), { skills: [`${ONE}-skill`, `${TWO}-skill`], mcp: [`${ONE}-settings`, `${ONE}-state`, `${TWO}-settings`, `${TWO}-state`] });
  assert.deepEqual(marksIn(c), [ONE, TWO]);
});

test('project scope: the servers ~/.claude.json records for the project belong to the default account', () => {
  // No flag: the three sessions of the project, and the server recorded for it in ~/.claude.json.
  // The state server the default account called is not configured for the project: it is listed
  // under the name its tool carries.
  const all = impact(['--cwd', proj]);
  assert.deepEqual([all.json.sources, all.json.totalTokens], [{ claude: 2, codex: 1 }, 330]);
  assert.deepEqual(all.json.mcpCalls, { [`${ONE}-state`]: 1, [`${ONE}-proj`]: 0 });
  assert.deepEqual(all.json.unusedContext.mcpServersNeverCalled, [`${ONE}-proj`]);
  // The second account in this project: ~/.claude.json is not its.
  const two = impact(['--cwd', proj, '--config-dirs', claude2, '--sources', 'claude']);
  assert.deepEqual([two.json.sources, two.json.totalTokens, two.json.mcpCalls], [{ claude: 1, codex: 0 }, 110, {}]);
  assert.deepEqual(marksIn(two), []);
  // The default account in this project: it is.
  const one = impact(['--cwd', proj, '--config-dirs', claude1, '--sources', 'claude']);
  assert.deepEqual(one.json.mcpCalls, { [`${ONE}-state`]: 1, [`${ONE}-proj`]: 0 });
  assert.deepEqual(marksIn(one), [ONE]);
});

test('the estimates of one account name nothing of another', () => {
  const dir = path.join(home, 'estimates');
  const catalog = path.join(dir, 'catalog.json');
  write(catalog, JSON.stringify({
    verifiedAt: '2026-01-01',
    estimates: [
      { id: 'unused-skill-descriptions', kind: 'documented', tool: null, label: 'Descriptions of skills never invoked', maxDescriptionChars: 1536, source: 'https://example.com/claim', verifiedAt: '2026-01-01', quote: ['synthetic quote'], basis: 'Synthetic sentence for skill descriptions.' },
      { id: 'unused-mcp-servers', kind: 'unmeasured', tool: null, label: 'MCP server never called', source: 'session-impact.mjs', verifiedAt: '2026-01-01', quote: null, basis: 'Synthetic sentence for servers.' },
    ],
  }));
  // A snapshot that knows the size of every skill on the machine: only the measurement decides
  // which of them are this account's.
  const snapshot = path.join(dir, 'snapshot.json');
  write(snapshot, JSON.stringify({ harness: { id: 'u2', kind: 'user', name: 'account 2' }, elements: { skills: MARKS.map((m) => ({ name: `${m}-skill`, level: 'user', descriptionChars: 400 })) } }));
  const file = path.join(dir, 'impact.json');
  write(file, impact(['--scope', 'user', '--config-dirs', claude2, '--sources', 'claude']).stdout);
  const r = runScript('impact-estimates.mjs', ['--impact', file, '--snapshot', snapshot, '--catalog', catalog]);
  assert.equal(r.code, 0, r.stderr);
  // Its one idle skill: 400 chars / 4 = 100 tokens x 1 session. Its two idle servers, by name.
  assert.deepEqual(r.json.estimates.map((e) => [e.id, e.tokens]), [['unused-skill-descriptions', 100]]);
  assert.deepEqual(r.json.detail.skills.map((s) => s.name), [`${TWO}-skill`]);
  assert.deepEqual(r.json.unmeasured.map((u) => u.tool), [`${TWO}-settings`, `${TWO}-state`]);
  assert.deepEqual(MARKS.filter((m) => r.stdout.includes(m)), [TWO]);
});
