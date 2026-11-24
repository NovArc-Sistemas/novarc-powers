// Shared by the run-*.test.mjs and serve-board.test.mjs files: a sandbox with a temporary home
// (NOVARC_POWERS_HOME, HOME and USERPROFILE all point at it), tiny stub probe scripts and a stub
// renderer wired in through the NOVARC_HD_SCRIPT_* overrides, and builders for selections and
// findings. Nothing here touches the real home, and every absolute path is built at run time.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpDir, rmrf, write, homeEnv, SCRIPTS } from './helpers.mjs';
import { itemRev } from '../scripts/lib/run/rev.mjs';

export const RUN = path.join(SCRIPTS, 'run.mjs');
export const SERVE = path.join(SCRIPTS, 'serve-board.mjs');

// Every stub appends { script, args } to STUB_LOG so a test can see how it was called.
const STUB_HEAD = `
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf('--' + name); return i === -1 ? undefined : argv[i + 1]; };
const self = path.basename(process.argv[1], '.mjs');
if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ script: self, args: argv }) + '\\n');
const fail = (process.env.STUB_FAIL || '').split(',');
if (fail.includes(self)) { process.stderr.write('stub failure in ' + process.cwd() + ' home ' + (process.env.NOVARC_POWERS_HOME || '') + '\\n'); process.exit(3); }
if ((process.env.STUB_HANG || '').split(',').includes(self)) { setTimeout(() => {}, 60000); await new Promise(() => {}); }
if ((process.env.STUB_GARBAGE || '').split(',').includes(self)) { process.stdout.write('not json at all'); process.exit(0); }
const print = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\\n');
`;

const STUBS = {
  'discover.mjs': `${STUB_HEAD}
print({ stub: 'discover', scope: flag('scope') });
`,
  'harness-checks.mjs': `${STUB_HEAD}
print({ checks: [], defenses: [], skipped: [] });
`,
  'session-impact.mjs': `${STUB_HEAD}
const user = flag('scope') === 'user';
// STUB_IMPACT names a JSON file: { "<project folder name>" | "user" | "*": { fields that replace the ones below } }.
const over = process.env.STUB_IMPACT ? JSON.parse(fs.readFileSync(process.env.STUB_IMPACT, 'utf8')) : {};
print({
  generatedAt: '2026-01-01T00:00:00.000Z', windowDays: Number(flag('days') || 30), scope: user ? 'user' : 'project',
  from: '2025-12-02T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z',
  sources: { claude: 3, codex: 0 }, sessions: 3, activeDays: 2, unparsableLines: 0,
  totalTokens: flag('config-dirs') ? 5000 : 9000, byKind: { input: 100, cacheWrite: 200, cacheRead: 300, output: 400 },
  weightedTotal: 1234, weightedByKind: { input: 100, cacheWrite: 250, cacheRead: 30, output: 2000 }, weights: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  method: 'stub', contextAtStart: { perSessionMedian: 10, perSessionP90: 20, total: 30, weightedTotal: 33, sessionsMeasured: 3, method: 'stub' },
  waste: [
    { kind: 'retry', label: 'Retry loops', episodes: 2, sessions: 1, tokens: 120, weighted: 150, basis: 'measured', method: 'stub', topHeads: ['npm test'] },
    { kind: 'made-up-kind', episodes: 1, tokens: 1 },
  ],
  unusedContext: { skillsNeverInvoked: ['alpha'], mcpServersNeverCalled: [], skillsConfigured: 2, method: 'stub' },
  durationMs: 1,
  ...(over[user ? 'user' : path.basename(flag('cwd') || '')] || over['*'] || {}),
});
`,
  'probe-clis.mjs': `${STUB_HEAD}
print({ tools: [{ name: 'gh', installed: true }], cwd: 'not-printed' });
`,
  'snapshot-harness.mjs': `${STUB_HEAD}
const id = flag('id');
const kind = flag('kind');
const root = kind === 'project' ? '.' : (flag('provider') === 'codex' ? '~/.codex' : '~/.claude');
const abs = flag('cwd') || flag('config-dir');
const files = [
  { id: 'f' + id + '-1', harness: id, path: root + '/CLAUDE.md', category: 'instructions', lang: 'markdown', content: '# Rules\\nline one\\nline two\\n', bytes: 27, tokens: 7, loaded: 'always', debug: 'dropped by the schema' },
  { id: 'f' + id + '-2', harness: id, path: root + '/settings.json', category: 'settings', lang: 'json', content: '{ "dir": ' + JSON.stringify(abs + path.sep + 'hooks') + ' }', bytes: 40, tokens: 10, loaded: 'always' },
  { id: 'f' + id + '-3', harness: id, path: root + '/odd.bin', category: 'not-a-category', content: '' },
];
if (process.env.STUB_OWNER === id) files.push({ id: 'f' + id + '-5', harness: id, path: root + '/skills/alpha/SKILL.md', category: 'skill', lang: 'markdown', content: 'alpha', loaded: 'on-demand' });
if (process.env.STUB_LINKED === id) files.push({ id: 'f' + id + '-4', harness: id, path: root + '/skills/alpha/SKILL.md', category: 'skill', lang: 'markdown', content: 'alpha', loaded: 'on-demand', linkTo: '~/.claude/skills/alpha/SKILL.md' });
print({
  harness: { id, kind, name: id, path: root, project: { isCode: true, defaultBranch: 'main' }, activity: { sessions: 7 }, internal: true },
  files,
  elements: {
    skills: [
      { name: 'alpha', level: 'user', description: 'Alpha skill', invocations: 0, file: 'f' + id + '-1' },
      { name: 'beta', level: 'user', description: 'Beta skill', invocations: 4 },
    ],
    hooks: [{ id: 'hook-1', source: 'agent', event: 'PreToolUse', matcher: 'Bash', blocking: true }],
    mcp: [{ name: 'github', level: 'user', transport: 'remote', calls: 0 }],
    docs: kind === 'project' ? [{ path: './README.md', bytes: 100, status: 'unchecked' }] : [],
  },
  layers: [{ harness: id, name: 'CLAUDE.md', kind: 'instructions', file: 'f' + id + '-1', tokens: 7, basis: 'estimated' }],
  passed: { impact: flag('impact') !== undefined, clis: flag('clis') !== undefined },
});
`,
  'impact-estimates.mjs': `${STUB_HEAD}
print({ generatedAt: new Date().toISOString(), estimates: [{ label: 'Compact shell output', tool: 'rtk', tokens: 4000, source: 'catalog factor x measured output', basis: 'not in the schema' }], skipped: [],
  given: { impact: flag('impact') !== undefined, clis: flag('clis') !== undefined, snapshot: flag('snapshot') !== undefined, discover: flag('discover') !== undefined } });
`,
  'accounts.mjs': `${STUB_HEAD}
print({ primary: flag('primary'), syncInstalled: false, summary: { divergent: 1 }, accounts: [
  { id: flag('primary'), provider: 'claude-code', label: 'Primary', path: '~/.claude', sync: { mode: 'primary', status: 'ok', detail: 'the source the other accounts follow', elements: [] } },
  { id: 'codex-1', provider: 'codex', label: 'Codex', path: '~/.codex', notes: ['a note the state has no place for'], sync: { mode: 'replicated', status: 'drift', detail: 'two elements differ', elements: [
    { name: 'AGENTS.md', state: 'generated' }, { name: 'skills/', state: 'divergent', note: 'one skill differs' }, { name: 'x', state: 'unknown-state' } ] } },
  { id: 'not-in-this-run', provider: 'claude-code', label: 'Other', path: '~/.other', sync: { mode: 'linked', status: 'ok', elements: [] } },
] });
`,
  // Writes board.html next to the state; with STUB_SCORES it also writes a score into every harness.
  'render-board.mjs': `${STUB_HEAD}
const statePath = argv[0];
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const scores = {};
if (process.env.STUB_SCORES) {
  for (const h of state.harnesses) {
    const open = state.items.filter((i) => i.harness === h.id && i.status === 'open').length;
    const previous = h.scores && h.scores.previous !== undefined ? h.scores.previous : null;
    const current = 100 - open;
    const same = h.scores && h.scores.current === current;
    h.scores = { current, baseline: current, previous, grade: 'A', roundsCounted: 1, roundsTotal: 8, computedAt: same ? h.scores.computedAt : new Date().toISOString() };
    scores[h.id] = h.scores;
  }
  const text = JSON.stringify(state, null, 2) + '\\n';
  if (text !== fs.readFileSync(statePath, 'utf8')) fs.writeFileSync(statePath, text);
}
// With STUB_RENDER_DUMP the page carries the whole state, as the real board does.
const dump = process.env.STUB_RENDER_DUMP ? '<script type="application/json">' + JSON.stringify(state) + '</script>' : '';
const html = '<!doctype html><title>board</title><p>channel ' + flag('channel') + ', items ' + state.items.length + ', statuses ' + state.items.map((i) => i.id + ':' + i.status).join(' ') + '</p>' + dump;
fs.writeFileSync(path.join(path.dirname(statePath), 'board.html'), html);
fs.writeFileSync(path.join(path.dirname(statePath), 'board.md'), '# board\\n');
print({ language: state.language, scores, warnings: process.env.STUB_RENDER_WARN ? [{ item: 'ACME-101', change: 0, problem: 'before text not found in the file' }] : [], bytes: html.length });
`,
};

/**
 * A temporary home with stub scripts. `accounts`: how many of [claude-1, codex-1, gemini-1] to
 * select; `projects`: project folder names. Returns helpers bound to that home.
 */
export function sandbox(t, { accounts = 2, projects = ['acme-shop', 'novarc-powers'], linksInto = null } = {}) {
  const home = tmpDir('hd-run-');
  t.after(() => rmrf(home));
  const stubDir = path.join(home, 'stubs');
  const stubLog = path.join(home, 'stub-log.jsonl');
  const overrides = {};
  for (const [name, source] of Object.entries(STUBS)) {
    write(path.join(stubDir, name), source);
    overrides[`NOVARC_HD_SCRIPT_${name.replace(/\.mjs$/, '').replace(/-/g, '_').toUpperCase()}`] = path.join(stubDir, name);
  }
  const env = homeEnv(home, { NOVARC_POWERS_HOME: home, STUB_LOG: stubLog, ...overrides });
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'STUB_FAIL', 'STUB_HANG', 'STUB_GARBAGE', 'STUB_SCORES', 'STUB_RENDER_WARN', 'STUB_RENDER_DUMP', 'STUB_LINKED', 'STUB_OWNER', 'STUB_IMPACT', 'NOVARC_HD_NOW', 'NOVARC_HD_TEST_RECORDS_GATE']) delete env[k];

  const pool = [
    { id: 'claude-1', provider: 'claude-code', label: 'Claude Code · account 1', identity: 'so…@example.com', path: '~/.claude', dir: '.claude', isDefault: true, host: null, linksInto: null },
    // Only an account of the same provider inherits, so the linked variant is a Claude account.
    { id: 'codex-1', provider: linksInto ? 'claude-code' : 'codex', label: 'Codex', path: '~/.codex', dir: '.codex', isDefault: true, host: null, linksInto },
    { id: 'gemini-1', provider: 'gemini', label: 'Gemini CLI', path: '~/.gemini', dir: '.gemini', isDefault: true, host: null, linksInto: null },
  ];
  const selection = {
    accounts: pool.slice(0, accounts).map(({ dir, ...a }) => { fs.mkdirSync(path.join(home, dir), { recursive: true }); return { ...a, pathAbs: path.join(home, dir) }; }),
    primary: accounts > 0 ? 'claude-1' : null,
    projects: projects.map((name) => { const abs = path.join(home, 'dev', name); fs.mkdirSync(abs, { recursive: true }); return { name, path: `~/dev/${name}`, pathAbs: abs }; }),
  };

  const sb = {
    home, env, selection, stubDir, stubLog, runId: null, dir: null,
    /** Run `run.mjs` and return { code, json, stdout, stderr }. */
    run(args, extraEnv = {}) {
      const r = spawnSync(process.execPath, [RUN, ...args], { encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 120000 });
      let json = null;
      try { json = JSON.parse(r.stdout); } catch { json = null; }
      return { code: r.status, json, stdout: r.stdout || '', stderr: r.stderr || '' };
    },
    /** The same, without blocking: for racing several processes. */
    runAsync(args, extraEnv = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [RUN, ...args], { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('close', (code) => { let json = null; try { json = JSON.parse(stdout); } catch { json = null; } resolve({ code, json, stdout, stderr }); });
      });
    },
    /** Write the selection and run `init`; remembers the run id and directory. */
    init(extraArgs = [], sel = selection) {
      const file = path.join(home, 'selection.json');
      fs.writeFileSync(file, JSON.stringify(sel));
      const r = sb.run(['init', '--select', file, ...extraArgs]);
      if (r.code === 0) { sb.runId = r.json.runId; sb.dir = r.json.dir; }
      return r;
    },
    file: (...parts) => path.join(sb.dir, ...parts),
    read: (...parts) => JSON.parse(fs.readFileSync(path.join(sb.dir, ...parts), 'utf8')),
    text: (...parts) => fs.readFileSync(path.join(sb.dir, ...parts), 'utf8'),
    exists: (...parts) => fs.existsSync(path.join(sb.dir, ...parts)),
    stubCalls: () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    /** Write a findings file and hand it to `complete`. */
    complete(unit, findings, session = 'tester') {
      const file = path.join(home, `findings-${unit.replace(/[^a-z0-9]+/gi, '-')}.json`);
      fs.writeFileSync(file, JSON.stringify(findings));
      return sb.run(['complete', '--unit', unit, '--session', session, '--findings', file]);
    },
  };
  return sb;
}

/** A valid item; `extra` overrides any field. */
export function item(id, harness, round, extra = {}) {
  return {
    id, harness, round, severity: 'medium', class: 'reversible',
    title: `Finding ${id}`, finding: 'What is wrong.', evidence: 'CLAUDE.md:2', proposal: 'What to change.', opinion: 'Worth doing.',
    lesson: { why: 'Why it matters.', impact: 'What it costs.', better: 'Why the result is better.', principle: 'The rule to keep.' },
    changes: [{ path: harness.startsWith('claude') ? '~/.claude/CLAUDE.md' : './CLAUDE.md', lang: 'markdown', before: 'line one', after: 'line one, improved', why: 'Says the same in fewer tokens.' }],
    ...extra,
  };
}

/** Findings for `review:security` over the default sandbox: two items per project, one for the account. */
export function securityFindings(extra = {}) {
  return {
    rounds: [
      { harness: 'claude-1', round: 1, status: 'done' },
      { harness: 'codex-1', round: 1, status: 'skipped', note: 'nothing to read' },
      { harness: 'acme-shop', round: 1, status: 'done' },
      { harness: 'novarc-powers', round: 1, status: 'done' },
    ],
    items: [
      item('U1-101', 'claude-1', 1, { severity: 'high', class: 'permission' }),
      item('ACME-101', 'acme-shop', 1),
      item('ACME-102', 'acme-shop', 1, { class: 'additive', severity: 'low' }),
      item('NP-101', 'novarc-powers', 1),
      item('NP-102', 'novarc-powers', 1, { status: 'ok', changes: undefined, file: './CLAUDE.md' }),
    ],
    inventory: [{ id: 'inv-1', harness: 'acme-shop', category: 'permissions', name: 'deny list', verdict: 'attention', opinion: 'Too short.', item: 'ACME-101' }],
    defenses: [{ harness: 'acme-shop', title: 'Force-push is blocked', detail: 'PreToolUse hook' }],
    leads: [{ harness: 'acme-shop', title: 'A scanner worth a look', source: 'seen in a README, not confirmed' }],
    layers: [{ harness: 'acme-shop', name: 'CLAUDE.md', kind: 'instructions', note: 'Loaded in every session.' }],
    groups: [{ title: 'Same wording problem in two projects', round: 1, summary: 'One decision covers both.', items: ['ACME-101', 'NP-101'] }],
    elements: { 'acme-shop': { skills: [{ name: 'alpha', verdict: 'retire', reason: 'Never invoked in the window.', item: 'ACME-102' }], hooks: [{ id: 'hook-1', note: 'Blocks force-push.' }] } },
    fileRoles: { 'facme-shop-1': 'The rules every session starts with.' },
    ...extra,
  };
}

/** Environment that sets the clock of the run library (NOVARC_HD_NOW) for one command. */
export function clock(iso) {
  return { NOVARC_HD_NOW: iso };
}

/** The history folder of a sandbox: where it is, and readers for what `close` writes there. */
export function historyOf(sb) {
  const dir = path.join(sb.home, '.novarc-powers', 'novarc-harness-doctor', 'history');
  const json = (...parts) => JSON.parse(fs.readFileSync(path.join(dir, ...parts), 'utf8'));
  return {
    dir,
    keys: () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /-[0-9a-f]{8}$/.test(n)).sort() : []),
    index: () => json('index.json'),
    record: (key, runId) => json(key, `${runId}.json`),
    md: (key, runId) => fs.readFileSync(path.join(dir, key, `${runId}.md`), 'utf8'),
    files: (key) => fs.readdirSync(path.join(dir, key)).sort(),
  };
}

/**
 * What the impact probe measured: 20 sessions in 30 days. Per session that is 100000 tokens,
 * 20000 weighted, 50000 at the start, 120000 at the peak, 5000 lost to retries (5% of the weighted
 * total) and 40000 characters of shell output. `extra` replaces fields.
 */
export function measured(extra = {}) {
  return {
    windowDays: 30, from: '2025-12-11T10:00:00.000Z', to: '2026-01-10T10:00:00.000Z', sessions: 20, activeDays: 12,
    totalTokens: 2000000, weightedTotal: 400000,
    contextAtStart: { perSessionMedian: 50000, sessionsMeasured: 20 },
    contextPeak: { median: 120000, sessionsMeasured: 20 },
    waste: [{ kind: 'retry', episodes: 4, sessions: 3, tokens: 100000, weighted: 20000, basis: 'measured' }],
    unusedContext: { skillsNeverInvoked: ['alpha'], mcpServersNeverCalled: [] },
    toolOutput: { shellResultChars: 800000 },
    coverage: { claude: { read: true, toolCalls: 'complete' }, codex: { read: false, toolCalls: 'not-read' } },
    ...extra,
  };
}

/** Write the impact probe's output for a harness of the current run (probes/<id>/impact.json). */
export function writeImpact(sb, harnessId, impact) {
  const file = sb.file('probes', harnessId, 'impact.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(impact));
}

/** The moments of `firstReview`, all on 2026-01-10 (UTC). */
export const FIRST = {
  started: '2026-01-10T10:00:00.000Z',
  decided: '2026-01-10T11:00:00.000Z',
  applied: '2026-01-10T11:30:00.000Z',
  fixed: '2026-01-10T11:31:00.000Z',
  closed: '2026-01-10T12:00:00.000Z',
};

/** The findings of `firstReview`: four items of acme-shop in round 1. */
export function firstFindings() {
  return {
    rounds: [{ harness: 'acme-shop', round: 1, status: 'done' }],
    items: [
      item('ACME-101', 'acme-shop', 1, { saves: { tokens: 200000, basis: 'measured', metric: 'context-at-start', how: 'Loaded in every session.' } }),
      item('ACME-102', 'acme-shop', 1, { class: 'additive', severity: 'low', changes: [{ path: './AGENTS.md', lang: 'markdown', before: '', after: 'A new rule.\n', why: 'Adds the rule.' }] }),
      item('ACME-103', 'acme-shop', 1, { severity: 'high', changes: undefined, file: './settings.json' }),
      item('ACME-104', 'acme-shop', 1, { changes: undefined, file: './README.md' }),
    ],
  };
}

/**
 * One whole review of the project acme-shop, at fixed moments (FIRST): measured as `measured()`,
 * ACME-101 approved ("yes, do it"), applied to ./CLAUDE.md and fixed; ACME-102 declined ("not
 * now"); ACME-103 deferred; ACME-104 left open; then closed, unless `close: false`. `initArgs` are
 * more options for `init`.
 * Returns `{ runId, dir, key, file, findings }`: `key` is the harness key, `file` the CLAUDE.md
 * that was changed from "line one" to "line one, improved".
 */
export function firstReview(sb, { close = true, initArgs = [] } = {}) {
  const ok = (r, what) => { if (r.code !== 0) throw new Error(`${what} failed: ${r.stdout}${r.stderr}`); return r; };
  const selection = path.join(sb.home, 'selection.json');
  fs.writeFileSync(selection, JSON.stringify(sb.selection));
  const init = ok(sb.run(['init', '--select', selection, ...initArgs], clock(FIRST.started)), 'init');
  sb.runId = init.json.runId;
  sb.dir = init.json.dir;
  writeImpact(sb, 'acme-shop', measured());
  const findings = firstFindings();
  ok(sb.complete('review:security', findings), 'complete');
  const decisions = path.join(sb.home, 'first-decisions.json');
  fs.writeFileSync(decisions, JSON.stringify([
    { id: 'first-101', at: FIRST.decided, target: 'ACME-101', action: 'approve', note: 'yes, do it', rev: itemRev(findings.items[0]) },
    { id: 'first-102', at: FIRST.decided, target: 'ACME-102', action: 'decline', note: 'not now', rev: itemRev(findings.items[1]) },
    { id: 'first-103', at: FIRST.decided, target: 'ACME-103', action: 'defer', rev: itemRev(findings.items[2]) },
  ]));
  ok(sb.run(['decisions', '--ingest', decisions], clock(FIRST.decided)), 'decisions');
  const file = path.join(sb.home, 'dev', 'acme-shop', 'CLAUDE.md');
  fs.writeFileSync(file, '# Rules\nline one\nline two\n');
  ok(sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress'], clock(FIRST.decided)), 'mark in-progress');
  const backup = sb.file('backups', 'first', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, '# Rules\nline one, improved\nline two\n');
  ok(sb.run(['record', '--item', 'ACME-101', '--path', file, '--backup', backup], clock(FIRST.applied)), 'record');
  ok(sb.run(['mark', '--item', 'ACME-101', '--status', 'fixed', '--verified', 'Read the file back.'], clock(FIRST.fixed)), 'mark fixed');
  if (close) ok(sb.run(['close'], clock(FIRST.closed)), 'close');
  return { runId: sb.runId, dir: sb.dir, key: init.json.harnesses.find((h) => h.id === 'acme-shop').harnessKey, file, findings };
}

/** The `rev` of an item or group in the last built state.json: what the board showed. */
export function builtRev(sb, id) {
  const state = sb.read('state.json');
  const hit = [...state.items, ...state.groups].find((x) => x.id === id);
  return hit ? hit.rev : undefined;
}

/** Files under `dir` (recursively) whose bytes contain the literal `needle`, relative to `dir`. */
export function filesContaining(dir, needle) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.readFileSync(p).includes(needle)) hits.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return hits.sort();
}

/**
 * Environment that releases every process started with it at the same instant (run.mjs waits
 * for NOVARC_HD_TEST_START_AT), so they collide in the critical section instead of queueing up
 * by start-up time. `ms` must cover the start-up of all of them.
 */
export function together(ms = 4000) {
  return { NOVARC_HD_TEST_START_AT: String(Date.now() + ms) };
}
