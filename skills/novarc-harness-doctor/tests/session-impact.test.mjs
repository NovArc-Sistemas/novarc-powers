// session-impact.mjs against a synthetic home: Claude transcripts (top-level, subagent, replayed
// copy, out-of-window file) and one Codex rollout, all built in os.tmpdir(). Every expected number
// is worked out by hand in the comments. The weighted (input-token equivalent) numbers use a
// synthetic price list passed with --weights; the shipped list is checked on its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, rmrf, homeEnv, runScript, write } from './helpers.mjs';
import { encodeProjectPath } from '../scripts/lib/locations.mjs';

const MARKER = 'ZQXMARK7731'; // 11 chars; must never reach stdout or stderr
const DAY = 86400000;
const now = new Date();
// All in-window entries happen on one UTC day, two days ago, starting at noon.
const BASE = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2, 12);
let clock = 0;
const ts = () => new Date(BASE + (clock++) * 1000).toISOString();
const OLD = () => new Date(Date.now() - 40 * DAY).toISOString();

const U100 = [10, 20, 30, 40]; // input, cacheWrite, cacheRead, output = 100 tokens, context 60
const SID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SID_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SID_X = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

// `cw1h` is the part of the cache writes made with the 1-hour lifetime; without it the entry has
// no cache_creation breakdown at all (every write then weighs as a 5-minute write).
function asst(id, usage, blocks, { side = false, time = ts(), model = 'claude-test-a', cw1h = null } = {}) {
  const [i, cw, cr, o] = usage;
  const u = { input_tokens: i, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: o };
  if (cw1h !== null) u.cache_creation = { ephemeral_5m_input_tokens: cw - cw1h, ephemeral_1h_input_tokens: cw1h };
  return {
    parentUuid: null, isSidechain: side, type: 'assistant', timestamp: time,
    message: { model, id, type: 'message', role: 'assistant', content: blocks, usage: u },
  };
}

// Synthetic price ratios, so the weighted arithmetic below does not move when real prices do.
//   claude-test-a: cache write 5m 1.25, 1h 2, cache read 0.1, output 5
//   claude-test-b: cache read 0.05; a call whose context is over 100,000 tokens pays the long
//                  tier: input 2, cache write 2.5 / 4, cache read 0.1, output 10
//   codex-test:    cached input 0.1, output 4, no write price (a write weighs like input)
const SRC = 'https://example.com/prices';
const ANTHROPIC_KINDS = { cacheWrite: 'cacheWrite5m', cacheWriteLonger: 'cacheWrite1h', cacheRead: 'cacheRead', output: 'output' };
const OPENAI_KINDS = { cacheWrite: 'cacheWrite30m', cacheWriteLonger: 'cacheWrite12h', cacheRead: 'cachedInput', output: 'output' };
const STANDARD = { cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 };
function testWeights({ codexFamily = {} } = {}) {
  return {
    verifiedAt: '2026-01-01',
    providers: {
      anthropic: {
        transcripts: 'claude', kinds: ANTHROPIC_KINDS,
        default: { id: 'default', idPrefix: 'claude-', ratios: STANDARD, source: SRC, verifiedAt: '2026-01-01', quote: 'synthetic default' },
        families: [
          { id: 'claude-test', match: ['claude-test'], ratios: { ...STANDARD, output: 3 }, source: SRC, verifiedAt: '2026-01-04', quote: 'synthetic row' },
          { id: 'claude-test-a', match: ['claude-test-a'], ratios: STANDARD, source: SRC, verifiedAt: '2026-01-03', quote: 'synthetic row a' },
          {
            id: 'claude-test-b', match: ['claude-test-b'], ratios: { ...STANDARD, cacheRead: 0.05 },
            longContext: { overInputTokens: 100000, ratios: { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 } },
            source: SRC, verifiedAt: '2026-01-02', quote: ['synthetic row b', 'synthetic long row b'],
          },
        ],
      },
      openai: {
        transcripts: 'codex', kinds: OPENAI_KINDS, cacheWrite: { withoutWritePrice: 'input' }, default: null,
        families: [{ id: 'codex-test', match: ['codex-test'], ratios: { cachedInput: 0.1, output: 4 }, source: SRC, verifiedAt: '2026-01-05', quote: 'synthetic codex row', ...codexFamily }],
      },
    },
  };
}
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const bash = (id, command) => use(id, 'Bash', { command, description: 'run' });
function result(id, text, isError = false, side = false) {
  return { parentUuid: null, isSidechain: side, type: 'user', timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] }, toolUseResult: { stdout: '', stderr: '' } };
}
const say = (text, side = false) => ({ parentUuid: null, isSidechain: side, type: 'user', timestamp: ts(), message: { role: 'user', content: text } });
const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

let home; let project; let env; let out; let res; let weightsFile; let weightsDir;
// Every run of the main fixture uses the synthetic ratios unless a test says otherwise.
const run = (args, { weights = weightsFile } = {}) => runScript('session-impact.mjs', [...args, ...(weights ? ['--weights', weights] : [])], { env });

before(() => {
  home = tmpDir('hd-impact-home-');
  project = tmpDir('hd-impact-proj-');
  weightsDir = tmpDir('hd-impact-weights-');
  weightsFile = path.join(weightsDir, 'weights.json');
  write(weightsFile, JSON.stringify(testWeights()));
  env = homeEnv(home);
  const pdir = path.join(home, '.claude', 'projects', encodeProjectPath(project));

  // Session A (top-level). Turns T0..T14; every turn is 100 tokens except T0 and T13.
  const A = [
    say(`please build the feature ${MARKER}`), // U0, at=0
    // T0: 1055 tokens, context 1005. Of its 1000 cache-write tokens, 600 are 1-hour writes.
    asst('a0', [5, 1000, 0, 50], [use('r0', 'Read', { file_path: `src/${MARKER}.js` })], { cw1h: 600 }),
    result('r0', `contents ${MARKER}`),
    asst('a1', U100, [use('g1', 'Grep', { pattern: MARKER })]), // T1
    result('g1', 'match'),
    asst('a2', U100, [use('e2', 'Edit', { file_path: 'src/x.js', old_string: 'a', new_string: MARKER })]), // T2
    result('e2', 'ok'),
    say(`now run the tests ${MARKER}`), // U1, at=3
  ];
  // T3..T6 fail, T7 passes: the same `npm test` head, identical input five times in a row.
  for (let k = 3; k <= 7; k++) {
    A.push(asst(`a${k}`, U100, [bash(`b${k}`, `npm test ${MARKER}`)]));
    A.push(result(`b${k}`, k < 7 ? `FAIL ${MARKER}` : 'PASS', k < 7)); // 16 chars x4, then 4
  }
  A.push(
    asst('a8', U100, [use('s8', 'Skill', { skill: 'used-skill' }), use('m8', 'mcp__my_server__ping', {})]), // T8
    result('s8', 'loaded'),
    result('m8', 'pong'),
    say(`no, that's wrong ${MARKER}`), // U2 correction, at=9
    asst('a9', U100, [bash('b9', `foo-cli build ${MARKER}`)]), // T9
    result('b9', 'sh: foo-cli: command not found', true), // 30 chars
    asst('a10', U100, [bash('b10', 'foo-cli --help')]), // T10
    result('b10', 'sh: foo-cli: command not found', true), // 30 chars
    asst('a11', U100, [bash('b11', 'ls')]), // T11
    result('b11', 'a.txt'), // 5 chars
    asst('a12', U100, [bash('b12', `git push origin ${MARKER}`)]), // T12
    // A PreToolUse hook denied the push: the record says so in its permissionDecision, the shape
    // Claude Code writes. The text of the result is never read for this.
    { ...result('b12', `hook blocked ${MARKER}`, true), toolDenialKind: 'permission-rule', permissionDecision: { decision: 'reject', source: 'hook', reasonType: 'hook', reasonCode: 'hook:PreToolUse' } }, // 13 + 11 = 24 chars
    // T13: one model call written as two entries with the same message id; the second carries a
    // larger output count (40 -> 60), so the turn is 10 + 20 + 30 + 60 = 120 tokens.
    asst('a13', U100, [{ type: 'text', text: MARKER }]),
    asst('a13', [10, 20, 30, 60], [bash('b13', 'rtk gain')]),
    result('b13', 'x'.repeat(400)), // 400 chars
    asst('a14', U100, [bash('b14', `make deploy ${MARKER}`)]), // T14
    result('b14', `ERR ${MARKER}`, true), // 4 + 11 = 15 chars; the session ends on an error
  );
  write(path.join(pdir, `${SID_A}.jsonl`), jsonl(A));

  // Subagent of A: a corrective-looking prompt (not a human correction), five identical Reads
  // (a loop), then an Edit (exploration does not apply to subagents). 6 turns x 100 = 600.
  const S = [say(`no, wrong again ${MARKER}`, true)];
  for (let k = 0; k < 5; k++) S.push(asst(`s${k}`, U100, [use(`sr${k}`, 'Read', { file_path: 'x.md' })], { side: true }));
  S.push(asst('s5', U100, [use('se5', 'Edit', { file_path: 'x.md', old_string: 'a', new_string: 'b' })], { side: true }));
  write(path.join(pdir, SID_A, 'subagents', 'agent-a1b2c3.jsonl'), jsonl(S));

  // Session B replays A's first call (same message id) before its own call: the copy is dropped.
  // Its last message opens with the Portuguese contraction "no" ("in the"): an instruction, not a
  // correction, so B's turn is not corrected work.
  write(path.join(pdir, `${SID_B}.jsonl`), jsonl([
    say(`hello ${MARKER}`),
    asst('a0', [5, 1000, 0, 50], [{ type: 'text', text: MARKER }]), // duplicate of T0: 1055 dropped
    asst('b1', U100, [{ type: 'text', text: 'hi' }]), // 100, context 60
    say(`no projeto, cria a pasta de testes ${MARKER}`),
  ]));

  // Session C: a big context, an unparsable line, and one call older than the window. It runs on
  // another model, whose cache reads weigh less and which has a long-context tier.
  const B = { model: 'claude-test-b' };
  write(path.join(pdir, `${SID_C}.jsonl`), jsonl([
    say('start'),
    asst('c0', [0, 2000, 1000, 10], [{ type: 'text', text: 'x' }], B), // 3010 tokens, context 3000
    'not json {"role":"user"',
    asst('c1', [10, 0, 170000, 5], [{ type: 'text', text: 'y' }], B), // 170015 tokens, context 170010
    asst('c2', [500000, 0, 0, 0], [{ type: 'text', text: 'z' }], { ...B, time: OLD() }), // outside the window
  ]));

  // Session D: the whole file is older than the window (mtime 40 days ago).
  const dFile = path.join(pdir, `${SID_D}.jsonl`);
  write(dFile, jsonl([asst('d0', [999999, 0, 0, 0], [], { time: OLD() })]));
  const old = new Date(Date.now() - 40 * DAY);
  fs.utimesSync(dFile, old, old);

  // Codex rollout in the project: cumulative token_count events (one repeated) and a failed command.
  write(path.join(home, '.codex', 'sessions', '2026', '11', '19', `rollout-2026-11-19T12-00-00-${SID_X}.jsonl`), jsonl([
    { timestamp: ts(), type: 'session_meta', payload: { id: SID_X, cwd: project } },
    { timestamp: ts(), type: 'turn_context', payload: { cwd: project, model: 'codex-test' } },
    { timestamp: ts(), type: 'event_msg', payload: { type: 'user_message', message: `build it ${MARKER}` } }, // at=0
    { timestamp: ts(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 100, total_tokens: 1100 } } } },
    // turn 0: input 1000-600 = 400, cacheRead 600, output 100 = 1100 tokens, context 1000
    { timestamp: ts(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'x1', command: ['bash', '-lc', `pnpm build ${MARKER}`], exit_code: 1, status: 'failed', stderr: '', aggregated_output: `BUILD FAILED ${MARKER}` } } }, // 13 + 11 = 24 chars
    { timestamp: ts(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 100, total_tokens: 1100 } } } }, // repeat: no new call
    { timestamp: ts(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1800, cached_input_tokens: 1200, cache_write_input_tokens: 0, output_tokens: 150, total_tokens: 1950 } } } },
    // turn 1: input (800 - 600) = 200, cacheRead 600, output 50 = 850 tokens, context 800
    { timestamp: ts(), type: 'event_msg', payload: { type: 'user_message', message: `isso não, de novo ${MARKER}` } }, // correction, at=2
  ]));

  // Configured context of the project: one used and one idle skill, one used and one idle MCP server.
  write(path.join(project, '.claude', 'skills', 'used-skill', 'SKILL.md'), '# used\n');
  write(path.join(project, '.claude', 'skills', 'idle-skill', 'SKILL.md'), '# idle\n');
  write(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'my.server': { command: 'x' }, 'idle-srv': { command: 'y' } } }));

  res = run(['--cwd', project]);
  out = res.json;
});

after(() => { rmrf(home); rmrf(project); rmrf(weightsDir); });

test('exits 0 and prints JSON', () => {
  assert.equal(res.code, 0, res.stderr);
  assert.ok(out);
  assert.equal(out.windowDays, 30);
});

test('sessions, sources, days and unparsable lines', () => {
  // A, B, C (Claude; D is outside the window) + one Codex rollout.
  assert.deepEqual(out.sources, { claude: 3, codex: 1 });
  assert.equal(out.sessions, 4);
  assert.equal(out.activeDays, 1);
  assert.equal(out.unparsableLines, 1);
});

test('token totals by kind', () => {
  // A main: T0 (5,1000,0,50) + 13 turns of (10,20,30,40) + T13 (10,20,30,60) = 2475
  // A subagent: 6 x 100 = 600 | B: 100 (its copy of a0 dropped) | C: 3010 + 170015 = 173025
  // Codex: 1100 + 850 = 1950 | total 2475 + 600 + 100 + 173025 + 1950 = 178150
  // input:      A 5+130+10=145, sub 60, B 10, C 0+10=10, codex 400+200=600        -> 825
  // cacheWrite: A 1000+14*20=1280, sub 120, B 20, C 2000                           -> 3420
  // cacheRead:  A 14*30=420, sub 180, B 30, C 1000+170000=171000, codex 600+600     -> 172830
  // output:     A 50+13*40+60=630, sub 240, B 40, C 10+5=15, codex 100+50=150       -> 1075
  assert.deepEqual(out.byKind, { input: 825, cacheWrite: 3420, cacheRead: 172830, output: 1075 });
  assert.equal(out.totalTokens, 178150);
  assert.deepEqual(out.duplicates, { turnsDropped: 1, tokensDropped: 1055 });
});

test('context at start and peak', () => {
  // First calls of top-level sessions: A 1005, C 3000, Codex 1000; B starts with a dropped copy.
  assert.deepEqual(
    { m: out.contextAtStart.perSessionMedian, p: out.contextAtStart.perSessionP90, t: out.contextAtStart.total, n: out.contextAtStart.sessionsMeasured },
    { m: 1005, p: 3000, t: 5005, n: 3 },
  );
  // Peaks: B 60, Codex 1000, A 1005, C 170010 -> median (1000+1005)/2 = 1002.5 -> 1003; p90 = 4th of 4.
  assert.deepEqual(
    { m: out.contextPeak.median, p: out.contextPeak.p90, o: out.contextPeak.sessionsOver160k, n: out.contextPeak.sessionsMeasured },
    { m: 1003, p: 170010, o: 1, n: 4 },
  );
});

test('waste episodes, tokens and the no-double-count rule', () => {
  const w = Object.fromEntries(out.waste.map((x) => [x.kind, x]));
  assert.deepEqual(out.waste.map((x) => x.kind), ['retry', 'loop', 'notfound', 'correction', 'hook-block', 'error-end', 'exploration']);
  // retry: npm test fails T3..T6 and passes at T7 (4 reruns after the first failure): T3..T7 = 500.
  assert.deepEqual([w.retry.episodes, w.retry.sessions, w.retry.tokens, w.retry.topHeads], [1, 1, 500, ['npm test']]);
  // loop: T3..T7 are also 5 identical calls, but retry owns those turns, so only the subagent's
  // 5 identical Reads count: S0..S4 = 500.
  assert.deepEqual([w.loop.episodes, w.loop.sessions, w.loop.tokens], [1, 1, 500]);
  // notfound: foo-cli at T9 and T10 = 200.
  assert.deepEqual([w.notfound.episodes, w.notfound.tokens, w.notfound.topHeads], [1, 200, ['foo-cli']]);
  // hook-block: T12 = 100.
  assert.deepEqual([w['hook-block'].episodes, w['hook-block'].tokens, w['hook-block'].topHeads], [1, 100, ['git push']]);
  // correction: A's U2 covers T3..T8, but T3..T7 belong to retry, so only T8 = 100. Codex: its
  // correction covers turns 0..1 = 1950. The subagent prompt is not a human correction, and
  // neither is B's "no projeto, ..." (it would have added an episode of 100 tokens).
  assert.deepEqual([w.correction.episodes, w.correction.sessions, w.correction.tokens], [2, 2, 2050]);
  // error-end: A's last 3 turns T12..T14, T12 owned by hook-block -> T13 120 + T14 100 = 220.
  // Codex also ends on a failed command, but correction owns both its turns, so it is not counted.
  assert.deepEqual([w['error-end'].episodes, w['error-end'].tokens], [1, 220]);
  // exploration: T0 (1055) + T1 (100) before the Edit at T2; the subagent is excluded.
  assert.deepEqual([w.exploration.episodes, w.exploration.tokens], [1, 1155]);
  for (const x of out.waste) assert.equal(x.basis, 'measured');
  // Sum of waste never exceeds the total, and every turn is counted once.
  const wasteTotal = out.waste.reduce((a, x) => a + x.tokens, 0);
  assert.equal(wasteTotal, 500 + 500 + 200 + 100 + 2050 + 220 + 1155);
});

test('top sessions', () => {
  // C 173025; A 2475 + 600 = 3075 with waste 500+500+200+100+100+220+1155 = 2775; Codex 1950; B 100.
  assert.deepEqual(out.topSessions.map((s) => [s.id, s.tokens, s.wasteTokens]), [
    [SID_C, 173025, 0], [SID_A, 3075, 2775], [SID_X, 1950, 1950], [SID_B, 100, 0],
  ]);
});

test('tool output by command head', () => {
  // npm test 4x16 + 4 = 68; foo-cli 2x30 = 60; ls 5; git push 24; rtk gain 400; make deploy 15;
  // pnpm build (Codex) 24. Total 596 chars, 596 / 4 = 149 tokens.
  assert.equal(out.toolOutput.shellResultChars, 596);
  assert.equal(out.toolOutput.shellResultTokensApprox, 149);
  const by = Object.fromEntries(out.toolOutput.byHead.map((r) => [r.head, [r.calls, r.chars]]));
  assert.deepEqual(by, {
    'npm test': [5, 68], 'foo-cli': [2, 60], ls: [1, 5], 'git push': [1, 24], 'rtk gain': [1, 400], 'make deploy': [1, 15], 'pnpm build': [1, 24],
  });
});

test('unused skills and MCP servers', () => {
  assert.deepEqual(out.unusedContext.skillsNeverInvoked, ['idle-skill']);
  // `my.server` is called as mcp__my_server__ping (Claude Code normalizes the name).
  assert.deepEqual(out.unusedContext.mcpServersNeverCalled, ['idle-srv']);
});

test('coverage: what was read of each source, and nothing left unknown', () => {
  // Claude: A, its subagent, B and C (D is older than the window and is never opened). C holds the
  // one line that cannot be parsed; it names no configured skill or server, so every 0 stays a 0.
  assert.deepEqual(out.coverage.claude, { read: true, files: 4, filesFailed: 0, unparsableLines: 1, toolCalls: 'partial' });
  assert.deepEqual(out.coverage.codex, {
    read: true, files: 1, filesFailed: 0, unparsableLines: 0, unrecognizedCallRecords: 0, rolloutsWithoutProject: 0, toolCalls: 'complete', unrecognizedKinds: [],
  });
  assert.ok(out.coverage.method.length > 40);
  assert.deepEqual([out.unusedContext.skillsUnknown, out.unusedContext.mcpServersUnknown], [[], []]);
  // The lists and the count maps say the same thing: never used is a count of 0, and only that.
  assert.deepEqual(out.unusedContext.skillsNeverInvoked, Object.keys(out.skillInvocations).filter((n) => out.skillInvocations[n] === 0));
  assert.deepEqual(out.unusedContext.mcpServersNeverCalled, Object.keys(out.mcpCalls).filter((n) => out.mcpCalls[n] === 0));
});

test('usage counts of the main fixture', () => {
  // Bash: A's T3..T7 (5) and T9..T14 (6). Read: A's T0 and the subagent's 5. Edit: A's T2 and the
  // subagent's. Grep T1; Skill and the MCP tool at T8; the Codex command counts as exec_command.
  assert.deepEqual(out.toolCalls, { Bash: 11, Read: 6, Edit: 2, Grep: 1, Skill: 1, exec_command: 1, mcp__my_server__ping: 1 });
  // Configured skills and servers that were not used are listed with 0.
  assert.deepEqual(out.skillInvocations, { 'used-skill': 1, 'idle-skill': 0 });
  // The project configures the server as `my.server`; the tool name carries `my_server`.
  assert.deepEqual(out.mcpCalls, { 'my.server': 1, 'idle-srv': 0 });
  assert.ok(out.usageMethod.length > 40);
  // Most used first.
  assert.deepEqual(Object.keys(out.toolCalls).slice(0, 3), ['Bash', 'Read', 'Edit']);
});

test('every block that explains a number carries a method string', () => {
  assert.equal(typeof out.contextAtStart.method, 'string');
  assert.equal(typeof out.contextPeak.method, 'string');
  assert.equal(typeof out.unusedContext.method, 'string');
  assert.ok(out.toolOutput.method.length > 40);
  assert.ok(out.usageMethod.includes('once per call id'));
  for (const x of out.waste) assert.ok(x.method.length > 20, x.kind);
});

test('never prints message text, commands, results or home paths', () => {
  const runs = [res, run(['--cwd', project, '--progress']), run(['--cwd', project], { weights: null })];
  for (const r of runs) {
    assert.equal(r.code, 0, r.stderr);
    for (const s of [r.stdout, r.stderr]) {
      assert.ok(!s.includes(MARKER), 'marker leaked');
      assert.ok(!s.includes(home) && !s.includes(home.replace(/\\/g, '/')), 'home path leaked');
      assert.ok(!s.includes('foo-cli build') && !s.includes('origin'), 'command arguments leaked');
    }
  }
});

test('the window filter drops files and calls outside it', () => {
  // With a 1-day window every in-window entry (two days old) falls out too.
  const r = run(['--cwd', project, '--days', '1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.totalTokens, 0);
  assert.equal(r.json.sessions, 0);
  // Nothing to weigh is still a weighted view: zero, with no model family listed.
  assert.equal(r.json.weightedTotal, 0);
  assert.deepEqual(r.json.weights.perModelFamily, {});
  assert.deepEqual([r.json.toolCalls, r.json.skillInvocations, r.json.mcpCalls], [{}, { 'idle-skill': 0, 'used-skill': 0 }, { 'idle-srv': 0, 'my.server': 0 }]);
  // D (999999 input) and C's old call (500000) never show up in the 30-day run either.
  assert.ok(out.byKind.input < 500000);
});

test('worker threads give the same result as one thread', () => {
  const r = run(['--cwd', project, '--workers', '2']);
  assert.equal(r.code, 0, r.stderr);
  const strip = (o) => ({ ...o, generatedAt: null, durationMs: null, from: null, to: null });
  assert.deepEqual(strip(r.json), strip(out));
  assert.equal(r.json.weightedTotal, 28043);
});

test('user scope reads every project and the user-level config', () => {
  write(path.join(home, '.claude', 'skills', 'user-idle', 'SKILL.md'), '# idle\n');
  write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'user-srv': { command: 'z' } } }));
  const r = runScript('session-impact.mjs', ['--scope', 'user'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.totalTokens, 178150);
  assert.deepEqual(r.json.unusedContext.skillsNeverInvoked, ['user-idle']);
  assert.deepEqual(r.json.unusedContext.mcpServersNeverCalled, ['user-srv']);
  // The user scope does not configure `my.server`, so its calls stay under the name in the tool name.
  assert.deepEqual(r.json.mcpCalls, { my_server: 1, 'user-srv': 0 });
  assert.deepEqual(r.json.skillInvocations, { 'used-skill': 1, 'user-idle': 0 });
});

// ------------------------------------------------------------------------------------------
// Input-token equivalents
// ------------------------------------------------------------------------------------------

test('weighted totals by kind, in input-token equivalents', () => {
  // claude-test-a (session A, its subagent, B): input 1, write 5m 1.25, write 1h 2, read 0.1, output 5
  //   T0 (5, 1000 = 400 5m + 600 1h, 0, 50): 5 + 400*1.25 + 600*2 + 0 + 50*5 = 5 + 500 + 1200 + 250 = 1955
  //   a 100-token turn (10, 20, 30, 40), no breakdown so the write is 5m: 10 + 25 + 3 + 200 = 238
  //   T13 (10, 20, 30, 60): 10 + 25 + 3 + 300 = 338
  //   A main: 1955 + 13*238 + 338 = 5387 | subagent: 6*238 = 1428 | B: 238
  // claude-test-b (session C): read 0.05; context over 100,000 pays input 2, read 0.1, output 10
  //   c0 (0, 2000, 1000, 10), context 3000: 2000*1.25 + 1000*0.05 + 10*5 = 2500 + 50 + 50 = 2600
  //   c1 (10, 0, 170000, 5), context 170010: 10*2 + 170000*0.1 + 5*10 = 20 + 17000 + 50 = 17070
  //   C: 19670
  // codex-test: input 1, cached 0.1, output 4
  //   turn 0 (400, 0, 600, 100): 400 + 60 + 400 = 860 | turn 1 (200, 0, 600, 50): 200 + 60 + 200 = 460 -> 1320
  // total: 5387 + 1428 + 238 + 19670 + 1320 = 28043
  // input:      A 145, sub 60, B 10, C 0 + 10*2 = 20, codex 600                       -> 835
  // cacheWrite: A 1700 + 14*25 = 2050, sub 150, B 25, C 2500                           -> 4725
  // cacheRead:  A 14*3 = 42, sub 18, B 3, C 50 + 17000 = 17050, codex 120              -> 17233
  // output:     A 250 + 13*200 + 300 = 3150, sub 1200, B 200, C 50 + 50, codex 600     -> 5250
  assert.equal(out.weightedTotal, 28043);
  assert.deepEqual(out.weightedByKind, { input: 835, cacheWrite: 4725, cacheRead: 17233, output: 5250 });
  // The raw counts next to them are the same numbers as before.
  assert.equal(out.totalTokens, 178150);
  assert.deepEqual(out.byKind, { input: 825, cacheWrite: 3420, cacheRead: 172830, output: 1075 });
});

test('weighted context at start and weighted waste', () => {
  // Context of the first call of A, C and Codex (B starts with a dropped copy), no output:
  //   A T0: 5 + 500 + 1200 = 1705 | C c0: 2500 + 50 = 2550 | Codex turn 0: 400 + 60 = 460 -> 4715
  assert.equal(out.contextAtStart.weightedTotal, 4715);
  // The starting context is still loaded on every later call of its session. Counted again per
  // later call, never above what that call really sent (input + cacheWrite + cacheRead):
  //   A: 15 calls, start 1005; each of the 14 later calls sent only 60     -> 14 * 60 = 840 (capped)
  //   C: 2 calls in the window, start 3000; c1 sent 170010                 -> 3000
  //   Codex: 2 calls, start 1000; the second sent 200 + 600 = 800          -> 800 (capped)
  // turns 15 + 2 + 2 = 19; carried 840 + 3000 + 800 = 4640 (uncapped it would be 14*1005 + 3000 + 1000).
  // Weighted at the cache-read ratio of each later call: A 840 * 0.1 = 84; C's c1 is over
  // 100,000 tokens, so its long tier applies: 3000 * 0.1 = 300 (not 0.05); Codex 800 * 0.1 = 80.
  assert.deepEqual([out.contextAtStart.turns, out.contextAtStart.carriedTokens, out.contextAtStart.carriedWeighted], [19, 4640, 84 + 300 + 80]);
  assert.ok(out.contextAtStart.carriedMethod.includes('assumption'));
  assert.equal(out.contextAtStart.total, 5005);
  const w = Object.fromEntries(out.waste.map((x) => [x.kind, [x.tokens, x.weighted]]));
  assert.deepEqual(w, {
    retry: [500, 1190], // T3..T7: 5 * 238
    loop: [500, 1190], // subagent S0..S4: 5 * 238
    notfound: [200, 476], // T9, T10
    correction: [2050, 1558], // T8 238 + both Codex turns 1320
    'hook-block': [100, 238], // T12
    'error-end': [220, 576], // T13 338 + T14 238
    exploration: [1155, 2193], // T0 1955 + T1 238
  });
});

test('the weights block names the ratios that were applied', () => {
  const wt = out.weights;
  assert.equal(wt.unit, 'input-token equivalents');
  assert.equal(wt.source, 'weights.json');
  assert.equal(wt.verifiedAt, '2026-01-02', 'the oldest check among the families used');
  assert.deepEqual(wt.sources, [SRC]);
  assert.ok(wt.method.length > 40);
  // Sorted by tokens. Turns: A 15 + subagent 6 + B 1 = 22; C 2; Codex 2.
  assert.deepEqual(Object.keys(wt.perModelFamily), ['anthropic/claude-test-b', 'anthropic/claude-test-a', 'openai/codex-test']);
  const a = wt.perModelFamily['anthropic/claude-test-a'];
  assert.deepEqual([a.turns, a.tokens, a.weighted], [22, 2475 + 600 + 100, 5387 + 1428 + 238]);
  assert.deepEqual(a.ratios, { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 });
  assert.deepEqual([a.source, a.verifiedAt], [SRC, '2026-01-03']);
  const b = wt.perModelFamily['anthropic/claude-test-b'];
  assert.deepEqual([b.turns, b.tokens, b.weighted], [2, 173025, 19670]);
  assert.deepEqual(b.longContext, { overInputTokens: 100000, ratios: { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 } });
  const c = wt.perModelFamily['openai/codex-test'];
  assert.deepEqual([c.turns, c.tokens, c.weighted], [2, 1950, 1320]);
  assert.deepEqual(c.ratios, { input: 1, cachedInput: 0.1, output: 4 });
  assert.deepEqual(out.notes, []);
});

const WEIGHTED_KEYS = ['weightedTotal', 'weightedByKind', 'weights'];
/** The output with every weighted field removed, to compare the measured part of two runs. */
function measuredOnly(o) {
  const c = JSON.parse(JSON.stringify(o));
  for (const k of [...WEIGHTED_KEYS, 'generatedAt', 'durationMs', 'from', 'to', 'notes']) delete c[k];
  delete c.contextAtStart.weightedTotal;
  delete c.contextAtStart.carriedWeighted;
  for (const x of c.waste) delete x.weighted;
  return c;
}
function assertNoWeightedFields(o) {
  for (const k of WEIGHTED_KEYS) assert.ok(!(k in o), `${k} must be left out`);
  assert.ok(!('weightedTotal' in o.contextAtStart));
  assert.ok(!('carriedWeighted' in o.contextAtStart), 'carriedWeighted must be left out');
  for (const x of o.waste) assert.ok(!('weighted' in x), x.kind);
}

test('a missing weights file leaves the weighted fields out and says so', () => {
  const r = run(['--cwd', project], { weights: path.join(weightsDir, 'nope.json') });
  assert.equal(r.code, 0, r.stderr);
  assertNoWeightedFields(r.json);
  assert.deepEqual(r.json.notes, ['weighted totals omitted: price weights file not found']);
  // Every measured number is the same with and without weights.
  assert.deepEqual(measuredOnly(r.json), measuredOnly(out));
  assert.equal(r.json.totalTokens, 178150);
});

test('an unconfirmed ratio leaves the weighted fields out instead of guessing', () => {
  const cases = [
    // The Codex entry does not say what was read at its source: it does not count.
    [{ quote: '' }, 'weighted totals omitted: 2 model call(s) have no confirmed price ratio (codex: codex-test (2))'],
    // It has no date of verification.
    [{ verifiedAt: null }, 'weighted totals omitted: 2 model call(s) have no confirmed price ratio (codex: codex-test (2))'],
    // It has no ratio for cached input, and both Codex calls read from the cache.
    [{ ratios: { output: 4 } }, 'weighted totals omitted: 2 model call(s) have no confirmed price ratio (codex: codex-test (2))'],
  ];
  for (const [codexFamily, note] of cases) {
    const f = path.join(weightsDir, 'partial.json');
    write(f, JSON.stringify(testWeights({ codexFamily })));
    const r = run(['--cwd', project], { weights: f });
    assert.equal(r.code, 0, r.stderr);
    assertNoWeightedFields(r.json);
    assert.deepEqual(r.json.notes, [note]);
    assert.deepEqual(measuredOnly(r.json), measuredOnly(out));
  }
  // An unreadable file is the same as none.
  const bad = path.join(weightsDir, 'bad.json');
  write(bad, '{ not json');
  const r = run(['--cwd', project], { weights: bad });
  assertNoWeightedFields(r.json);
  assert.deepEqual(r.json.notes, ['weighted totals omitted: price weights file could not be read']);
});

test('the shipped price list: unlisted models get the standard ratios, a foreign model gets none', () => {
  // No --weights: references/catalog/pricing-weights.json. The fixture's claude-test-* ids are
  // not in it, so they take the provider default; codex-test has no default to fall back on.
  const r = run(['--cwd', project], { weights: null });
  assert.equal(r.code, 0, r.stderr);
  assertNoWeightedFields(r.json);
  assert.deepEqual(r.json.notes, ['weighted totals omitted: 2 model call(s) have no confirmed price ratio (codex: codex-test (2))']);
  assert.deepEqual(measuredOnly(r.json), measuredOnly(out));
});

test('model ids resolve to a family, the default, or nothing', async () => {
  const { loadWeights, familyFor, weighTurn, WEIGHT_SCALE: K } = await import('../scripts/session-impact.mjs');
  const W = loadWeights(weightsFile);
  assert.equal(W.ok, true);
  const claude = W.bySource.claude;
  const codex = W.bySource.codex;
  const id = (P, m) => { const h = familyFor(P, m); return h.fam ? [h.fam.id, h.unlisted] : null; };
  assert.deepEqual(id(claude, 'claude-test-a'), ['claude-test-a', false]);
  assert.deepEqual(id(claude, 'Claude-Test-A-20260115'), ['claude-test-a', false], 'a snapshot date continues the id');
  assert.deepEqual(id(claude, 'claude-test-20260115'), ['claude-test', false]);
  assert.deepEqual(id(claude, 'claude-test-ab'), ['default', true], 'a longer name is another model, not this one');
  assert.deepEqual(id(claude, 'claude-test-a-2'), ['default', true]);
  assert.deepEqual(id(claude, null), ['default', false], 'no model named');
  assert.deepEqual(id(claude, '<synthetic>'), ['default', false]);
  assert.equal(id(claude, 'other-vendor-model'), null, 'a model of another vendor has no confirmed ratio');
  assert.deepEqual(id(codex, 'codex-test'), ['codex-test', false]);
  assert.deepEqual(id(codex, 'codex-test-2026-01-15'), ['codex-test', false]);
  assert.equal(id(codex, 'codex-other'), null, 'this provider has no default');
  assert.equal(id(codex, null), null);

  // Weights are integers scaled by K, so fractions survive until the final rounding.
  // (40, 0, 30, 0) at read 0.05: 40 + 30*0.05 = 41.5 input-token equivalents, kept as 41.5 * K.
  const b = familyFor(claude, 'claude-test-b').fam;
  assert.deepEqual(weighTurn(b, { input: 40, cacheWrite: 0, cacheRead: 30, output: 0, cw1h: 0 }), { input: 40 * K, cacheWrite: 0, cacheRead: 1.5 * K, output: 0 });
  // A 1-hour part larger than the write count is capped at it: 100 writes, all 1h = 100*2.
  assert.equal(weighTurn(b, { input: 0, cacheWrite: 100, cacheRead: 0, output: 0, cw1h: 500 }).cacheWrite, 200 * K);
  // codex-test has no write price: a cache write weighs like input (1).
  const c = familyFor(codex, 'codex-test').fam;
  assert.equal(weighTurn(c, { input: 0, cacheWrite: 10, cacheRead: 0, output: 0, cw1h: 0 }).cacheWrite, 10 * K);
  // A kind with no ratio only matters when the call used it.
  const partial = { w: { in: K, cw: null, cwLonger: null, cr: null, out: 4 * K }, long: null };
  assert.deepEqual(weighTurn(partial, { input: 1, cacheWrite: 0, cacheRead: 0, output: 2, cw1h: 0 }), { input: K, cacheWrite: 0, cacheRead: 0, output: 8 * K });
  assert.equal(weighTurn(partial, { input: 1, cacheWrite: 0, cacheRead: 5, output: 2, cw1h: 0 }), null);
});

test('the shipped price list is sourced, dated and consistent with the rows it quotes', async () => {
  const { loadWeights, familyFor, DEFAULT_WEIGHTS_FILE } = await import('../scripts/session-impact.mjs');
  const doc = JSON.parse(fs.readFileSync(DEFAULT_WEIGHTS_FILE, 'utf8'));
  const usd = (cell) => { const m = /\$([0-9]+(?:\.[0-9]+)?)/.exec(cell); return m ? Number(m[1]) : null; };
  const cells = (row) => row.split('|').slice(1, -1).map((c) => usd(c));
  const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} != ${b}`);
  let families = 0;
  for (const [name, p] of Object.entries(doc.providers)) {
    assert.match(p.source, /^https:\/\//, name);
    assert.match(p.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, name);
    for (const f of p.families) {
      families++;
      assert.match(f.source, /^https:\/\//, f.id);
      assert.match(f.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, f.id);
      assert.ok(typeof f.quote === 'string' && f.quote.includes('$'), `${f.id} quotes its price row`);
      // Recompute every ratio from the quoted row: price of the kind / base input price.
      const c = cells(f.quote);
      if (name === 'anthropic') {
        const [, base, w5, w1, read, outp] = c; // model | base input | 5m write | 1h write | cache hit | output
        near(f.ratios.cacheWrite5m, w5 / base, `${f.id} 5m`);
        near(f.ratios.cacheWrite1h, w1 / base, `${f.id} 1h`);
        near(f.ratios.cacheRead, read / base, `${f.id} read`);
        near(f.ratios.output, outp / base, `${f.id} output`);
        if (f.longContext) {
          // The long-prompt row, against the base input price of the short-prompt row.
          const [, lb, l5, l1, lr, lo] = cells(f.longContext.quote);
          const r = f.longContext.ratios;
          near(r.input, lb / base, `${f.id} long input`);
          near(r.cacheWrite5m, l5 / base, `${f.id} long 5m`);
          near(r.cacheWrite1h, l1 / base, `${f.id} long 1h`);
          near(r.cacheRead, lr / base, `${f.id} long read`);
          near(r.output, lo / base, `${f.id} long output`);
        }
      } else {
        // Input, output and cached input are the first three priced cells of every row shape.
        const [inp, outp, cached] = c.filter((x) => x !== null);
        near(f.ratios.output, outp / inp, `${f.id} output`);
        near(f.ratios.cachedInput, cached / inp, `${f.id} cached`);
        if (c.length === 11) {
          // model | short: input, output, cached, 30m write, 12h write | long: the same five
          if (f.ratios.cacheWrite30m !== undefined) near(f.ratios.cacheWrite30m, c[4] / inp, `${f.id} 30m`);
          if (f.ratios.cacheWrite12h !== undefined) near(f.ratios.cacheWrite12h, c[5] / inp, `${f.id} 12h`);
          if (f.longContext) {
            near(f.longContext.ratios.input, c[6] / inp, `${f.id} long input`);
            near(f.longContext.ratios.output, c[7] / inp, `${f.id} long output`);
            near(f.longContext.ratios.cachedInput, c[8] / inp, `${f.id} long cached`);
          }
        }
      }
    }
  }
  assert.ok(families > 20);
  // It loads, and every listed id resolves to its own entry.
  const W = loadWeights(DEFAULT_WEIGHTS_FILE);
  assert.equal(W.ok, true);
  for (const p of Object.values(doc.providers)) {
    const P = W.bySource[p.transcripts];
    assert.equal(P.families.length, p.families.length, 'every entry is confirmed (source, date, quote)');
    for (const f of p.families) for (const m of f.match) assert.equal(familyFor(P, m).fam.id, f.id);
  }
});

test('carried starting context: rates, the cap, and what is left out', () => {
  const home5 = tmpDir('hd-carried-home-');
  const proj5 = tmpDir('hd-carried-proj-');
  try {
    const pdir = path.join(home5, '.claude', 'projects', encodeProjectPath(proj5));
    const text = [{ type: 'text', text: 'x' }];
    const [S1, S2] = ['5', '6'].map((d) => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`);
    const B = { model: 'claude-test-b' }; // cache read 0.05
    const start = asst('p0', [10, 0, 990, 0], text, B); // starting context 1000
    write(path.join(pdir, `${S1}.jsonl`), jsonl([
      start,
      asst('p1', [0, 0, 2000, 10], text, { model: null }), // names no model: the first call's rate, 1000 * 0.05 = 50
      asst('p2', [0, 0, 500, 0], text, { model: 'claude-test-a' }), // sent 500 only: 500 * 0.1 = 50
      asst('p3', [0, 0, 4000, 0], text, { ...B, time: OLD() }), // outside the window: not a later call
      asst('p4', [0, 0, 0, 0], text, B), // sent nothing: a call, but nothing carried
    ]));
    // A subagent thread has its own context and is not measured here.
    write(path.join(pdir, S1, 'subagents', 'agent-c1.jsonl'), jsonl([asst('q0', [0, 0, 800, 0], text, { ...B, side: true }), asst('q1', [0, 0, 800, 0], text, { ...B, side: true })]));
    // A session that opens with a replayed copy has no measured start, so nothing is carried for it.
    write(path.join(pdir, `${S2}.jsonl`), jsonl([start, asst('r1', [0, 0, 900, 0], text, B)]));

    const r = runScript('session-impact.mjs', ['--cwd', proj5, '--weights', weightsFile], { env: homeEnv(home5) });
    assert.equal(r.code, 0, r.stderr);
    const c = r.json.contextAtStart;
    // One session measured, start 1000. Calls in the window: p0, p1, p2, p4 = 4.
    // Carried: min(1000, 2000) + min(1000, 500) + min(1000, 0) = 1000 + 500 + 0 = 1500.
    // Weighted: 1000 * 0.05 + 500 * 0.1 = 100.
    assert.deepEqual([c.sessionsMeasured, c.total, c.turns, c.carriedTokens, c.carriedWeighted], [1, 1000, 4, 1500, 100]);
    // The raw part does not need the price list; the weighted part does.
    const raw = runScript('session-impact.mjs', ['--cwd', proj5, '--weights', path.join(weightsDir, 'nope.json')], { env: homeEnv(home5) }).json.contextAtStart;
    assert.deepEqual([raw.turns, raw.carriedTokens, 'carriedWeighted' in raw], [4, 1500, false]);
    // A family without a cache-read ratio: its calls can be weighted when they read nothing from
    // the cache, but the context carried into them cannot.
    const noRead = testWeights();
    delete noRead.providers.anthropic.families[1].ratios; // claude-test-a
    noRead.providers.anthropic.families[1].ratios = { cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 };
    const f = path.join(weightsDir, 'no-read.json');
    write(f, JSON.stringify(noRead));
    write(path.join(pdir, `${S1}.jsonl`), jsonl([start, asst('p2', [500, 0, 0, 0], text, { model: 'claude-test-a' })]));
    const partial = runScript('session-impact.mjs', ['--cwd', proj5, '--weights', f], { env: homeEnv(home5) }).json;
    assert.equal(typeof partial.weightedTotal, 'number', 'the totals are still weighted');
    assert.deepEqual([partial.contextAtStart.carriedTokens, 'carriedWeighted' in partial.contextAtStart], [500, false]);
    assert.deepEqual(partial.notes, ['carried context not weighted: 1 model call(s) have no confirmed cache-read ratio']);
  } finally {
    rmrf(home5);
    rmrf(proj5);
  }
});

// ------------------------------------------------------------------------------------------
// Usage counts
// ------------------------------------------------------------------------------------------

test('tool calls, skill invocations and MCP calls of the window', () => {
  // Its own home and project: every way a skill or a server can show up, plus what must not count.
  const home3 = tmpDir('hd-usage-home-');
  const proj3 = tmpDir('hd-usage-proj-');
  try {
    const pdir = path.join(home3, '.claude', 'projects', encodeProjectPath(proj3));
    const Z = [1, 0, 0, 1];
    const text = [{ type: 'text', text: MARKER }];
    const attr = (entry, skill) => ({ ...entry, attributionSkill: skill });
    const [S1, S2, S3, SX] = ['1', '2', '3', '4'].map((d) => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`);
    const slash = { ...say('<command-name>/slash-skill</command-name><command-args>x</command-args>'), uuid: 'uuid-slash-1' };
    const first = asst('u0', Z, [use('k0', 'Skill', { skill: 'tool-skill' })]);

    write(path.join(pdir, `${S1}.jsonl`), jsonl([
      slash, // a command the user typed: slash-skill 1
      { ...say('<command-name>/meta-skill</command-name>'), isMeta: true }, // skill text the harness injected: not typed
      first, // Skill tool: tool-skill 1
      // plug:plug-skill 1. The attribution names a skill this session invoked, so it adds nothing.
      attr(asst('u1', Z, [use('k1', 'Skill', { skill: 'plug:plug-skill' })]), 'tool-skill'),
      attr(asst('u2', Z, text), 'plug:plug-skill'), // same: invoked above
      attr(asst('u3', Z, text), 'other:attr-only'), // only ever attributed: counts once for the session
      attr(asst('u4', Z, text), 'other:attr-only'),
      asst('u5', Z, [use('r5', 'Read', { file_path: 'C:\\x\\.claude\\skills\\read-skill\\SKILL.md' })]), // only read: once
      asst('u6', Z, [use('r6', 'Read', { file_path: '.claude/skills/read-skill/SKILL.md' })]),
      asst('u7', Z, [use('m7a', 'mcp__my_server__ping', {}), use('m7b', 'mcp__my_server__ping', {}), use('m7c', 'mcp__plugin_srv__get', {})]),
      asst('u8', Z, [use('k8', 'Skill', { skill: 'old-skill' })], { time: OLD() }), // outside the window
      asst('u9', Z, [use('k9', 'Skill', { skill: '/tool-skill' })]), // tool-skill 2
      // Names that are not plain names go to <other>: a tool, a skill, and a skill shaped like a path.
      asst('u10', Z, [use('o10', `odd tool ${MARKER}`, {}), use('k10', 'Skill', { skill: `bad name ${MARKER}` }), use('k11', 'Skill', { skill: 'D:/data/skill' })]),
    ]));
    // Its subagent thread belongs to the same session.
    write(path.join(pdir, S1, 'subagents', 'agent-u1.jsonl'), jsonl([
      attr(asst('s0', Z, [bash('sb0', 'ls')], { side: true }), 'tool-skill'), // the session invoked it: nothing added
      attr(asst('s1', Z, text, { side: true }), 'sub:sub-only'), // attributed here only: once
    ]));
    // A resumed session replays the first Skill call (same message id) and the typed command (same uuid).
    write(path.join(pdir, `${S2}.jsonl`), jsonl([slash, first, asst('v1', Z, text)]));
    // Another session where tool-skill is only attributed: +1.
    write(path.join(pdir, `${S3}.jsonl`), jsonl([attr(asst('w0', Z, text), 'tool-skill'), attr(asst('w1', Z, text), 'tool-skill')]));

    const item = (time, it) => ({ timestamp: time, type: 'event_msg', payload: { type: 'item_completed', item: it } });
    const exec = (id, script) => ({ type: 'CommandExecution', id, command: ['bash', '-lc', script], exit_code: 0, status: 'completed', stderr: '', aggregated_output: 'x' });
    write(path.join(home3, '.codex', 'sessions', '2026', '11', '19', `rollout-2026-11-19T12-00-00-${SX}.jsonl`), jsonl([
      { timestamp: ts(), type: 'session_meta', payload: { id: SX, cwd: proj3 } },
      item(ts(), exec('c1', `cat .agents/skills/codex-read/SKILL.md ${MARKER}`)), // exec_command 1; codex-read is read
      item(ts(), exec('c2', 'cat .agents/skills/codex-read/SKILL.md')), // exec_command 2; still one session
      item(OLD(), exec('c3', 'cat .agents/skills/codex-old/SKILL.md')), // outside the window
      item(ts(), { type: 'McpToolCall', id: 'm1', server: 'my.server', tool: 'ping', arguments: {}, status: 'completed' }),
      item(ts(), { type: 'McpToolCall', id: 'm2', server: 'my.server', tool: `bad tool ${MARKER}`, arguments: {}, status: 'completed' }),
    ]));
    write(path.join(proj3, '.mcp.json'), JSON.stringify({ mcpServers: { 'my.server': { command: 'x' } } }));

    const args = ['--cwd', proj3, '--weights', weightsFile];
    const r = runScript('session-impact.mjs', args, { env: homeEnv(home3) });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!(r.stdout + r.stderr).includes(MARKER), 'marker leaked');
    // Skill: u0, u1, u9 and the two at u10 (u8 is old, the replay in S2 is a copy). Read: u5, u6.
    // mcp__my_server__ping: two at u7 plus the Codex call. Bash: the subagent. exec_command: c1, c2.
    assert.deepEqual(r.json.toolCalls, {
      Skill: 5, mcp__my_server__ping: 3, Read: 2, exec_command: 2, '<other>': 1, Bash: 1, mcp__my_server__unnamed: 1, mcp__plugin_srv__get: 1,
    });
    assert.deepEqual(r.json.skillInvocations, {
      'tool-skill': 3, // S1: u0 and u9; S3: attribution only
      '<other>': 2,
      'slash-skill': 1,
      'plug:plug-skill': 1, 'plug-skill': 1, // listed under both names
      'other:attr-only': 1, 'attr-only': 1,
      'sub:sub-only': 1, 'sub-only': 1,
      'read-skill': 1,
      'codex-read': 1,
    });
    // my.server: 3 pings and the unnamed tool, under the configured name. plugin_srv is not configured here.
    assert.deepEqual(r.json.mcpCalls, { 'my.server': 4, plugin_srv: 1 });
    // The same counts when the files are parsed in worker threads.
    const w = runScript('session-impact.mjs', [...args, '--workers', '2'], { env: homeEnv(home3) });
    assert.deepEqual([w.json.toolCalls, w.json.skillInvocations, w.json.mcpCalls], [r.json.toolCalls, r.json.skillInvocations, r.json.mcpCalls]);
  } finally {
    rmrf(home3);
    rmrf(proj3);
  }
});

// ------------------------------------------------------------------------------------------
// Transcript sources
// ------------------------------------------------------------------------------------------

test('--sources reads one agent\'s transcripts, and the two halves add up', () => {
  const c = run(['--cwd', project, '--sources', 'claude']);
  const x = run(['--cwd', project, '--sources', 'codex']);
  assert.equal(c.code, 0, c.stderr);
  assert.equal(x.code, 0, x.stderr);
  // Claude only: sessions A, B and C; the Codex rollout is not read. 178150 - 1950 = 176200.
  assert.deepEqual(c.json.sources, { claude: 3, codex: 0 });
  assert.equal(c.json.totalTokens, 176200);
  assert.equal(c.json.weightedTotal, 28043 - 1320);
  assert.deepEqual(Object.keys(c.json.weights.perModelFamily), ['anthropic/claude-test-b', 'anthropic/claude-test-a']);
  assert.ok(!('exec_command' in c.json.toolCalls));
  assert.ok(!c.json.topSessions.some((t) => t.id === SID_X));
  assert.deepEqual(c.json.notes, ['transcript sources read: claude']);
  // Codex only: its two calls, 1100 + 850.
  assert.deepEqual(x.json.sources, { claude: 0, codex: 1 });
  assert.equal(x.json.totalTokens, 1950);
  assert.equal(x.json.weightedTotal, 1320);
  assert.deepEqual(Object.keys(x.json.weights.perModelFamily), ['openai/codex-test']);
  assert.deepEqual(x.json.toolCalls, { exec_command: 1 });
  assert.deepEqual(x.json.topSessions.map((t) => [t.id, t.tokens]), [[SID_X, 1950]]);
  assert.deepEqual(x.json.notes, ['transcript sources read: codex']);

  // Every measured total of the unrestricted run is the sum of the two.
  const sum = (f) => f(c.json) + f(x.json);
  assert.equal(sum((j) => j.totalTokens), out.totalTokens);
  assert.equal(sum((j) => j.weightedTotal), out.weightedTotal);
  assert.equal(sum((j) => j.sessions), out.sessions);
  for (const k of ['input', 'cacheWrite', 'cacheRead', 'output']) {
    assert.equal(sum((j) => j.byKind[k]), out.byKind[k], k);
    assert.equal(sum((j) => j.weightedByKind[k]), out.weightedByKind[k], k);
  }
  assert.equal(sum((j) => j.contextAtStart.total), out.contextAtStart.total);
  assert.equal(sum((j) => j.contextAtStart.weightedTotal), out.contextAtStart.weightedTotal);
  for (const k of ['turns', 'carriedTokens', 'carriedWeighted']) assert.equal(sum((j) => j.contextAtStart[k]), out.contextAtStart[k], k);
  assert.equal(sum((j) => j.duplicates.tokensDropped), out.duplicates.tokensDropped);
  assert.equal(sum((j) => j.toolOutput.shellResultChars), out.toolOutput.shellResultChars);
  // Waste too: A's correction (100) on one side, the Codex one (1950) on the other.
  out.waste.forEach((w, i) => {
    assert.equal(c.json.waste[i].kind, w.kind);
    for (const k of ['episodes', 'sessions', 'tokens', 'weighted']) assert.equal(sum((j) => j.waste[i][k]), w[k], `${w.kind} ${k}`);
  });
  const calls = (j) => Object.values(j.toolCalls).reduce((a, b) => a + b, 0);
  assert.equal(sum(calls), calls(out));
});

test('--sources: naming both is the default, and a wrong name is refused', () => {
  const strip = (o) => ({ ...o, generatedAt: null, durationMs: null, from: null, to: null });
  const both = run(['--cwd', project, '--sources', 'codex, claude']);
  assert.equal(both.code, 0, both.stderr);
  assert.deepEqual(strip(both.json), strip(out));
  assert.equal(run(['--cwd', project, '--sources', 'gemini']).code, 2);
  assert.equal(run(['--cwd', project, '--sources', 'claude,gemini']).code, 2);
  assert.equal(run(['--cwd', project, '--sources']).code, 2);
  assert.equal(run(['--cwd', project, '--codex-dirs']).code, 2);
});

test('with one source, what belongs to the other agent is not listed as unused', () => {
  // Claude only: the project's .claude/skills and .mcp.json, as in the unrestricted run.
  const c = run(['--cwd', project, '--sources', 'claude']).json.unusedContext;
  assert.deepEqual([c.skillsNeverInvoked, c.mcpServersNeverCalled, c.skillsConfigured, c.mcpServersConfigured], [['idle-skill'], ['idle-srv'], 2, 2]);
  // Codex only: those are Claude Code's, and Codex cannot have used them.
  const x = run(['--cwd', project, '--sources', 'codex']).json.unusedContext;
  assert.deepEqual([x.skillsNeverInvoked, x.mcpServersNeverCalled, x.skillsConfigured, x.mcpServersConfigured], [[], [], 0, 0]);
  // The shared .agents/skills folder of a project counts for either agent.
  const proj4 = tmpDir('hd-impact-proj4-');
  try {
    write(path.join(proj4, '.agents', 'skills', 'shared-idle', 'SKILL.md'), '# idle\n');
    write(path.join(proj4, '.claude', 'skills', 'claude-idle', 'SKILL.md'), '# idle\n');
    assert.deepEqual(run(['--cwd', proj4, '--sources', 'codex']).json.unusedContext.skillsNeverInvoked, ['shared-idle']);
    assert.deepEqual(run(['--cwd', proj4, '--sources', 'claude']).json.unusedContext.skillsNeverInvoked, ['claude-idle', 'shared-idle']);
    assert.deepEqual(run(['--cwd', proj4]).json.unusedContext.skillsNeverInvoked, ['claude-idle', 'shared-idle']);
  } finally {
    rmrf(proj4);
  }
});

test('--sources with --config-dirs or --codex-dirs measures one account at user scope', () => {
  const SID_Y = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const other = tmpDir('hd-impact-codex-'); // a second Codex home
  try {
    write(path.join(other, 'sessions', '2026', '11', '20', `rollout-2026-11-20T12-00-00-${SID_Y}.jsonl`), jsonl([
      { timestamp: ts(), type: 'session_meta', payload: { id: SID_Y, cwd: project } },
      { timestamp: ts(), type: 'turn_context', payload: { cwd: project, model: 'codex-test' } },
      { timestamp: ts(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 20, total_tokens: 320 } } } },
    ]));
    write(path.join(other, 'skills', 'codex-idle', 'SKILL.md'), '# idle\n');
    write(path.join(other, 'config.toml'), '[mcp_servers.codex_srv]\ncommand = "x"\n');

    // The named Codex home alone: input 300 - 100 = 200, cached 100, output 20 = 320 tokens;
    // weighted 200 + 100*0.1 + 20*4 = 290. Its own skills and servers are the configured ones.
    const r = run(['--scope', 'user', '--sources', 'codex', '--codex-dirs', other]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.sources, { claude: 0, codex: 1 });
    assert.deepEqual([r.json.totalTokens, r.json.weightedTotal], [320, 290]);
    assert.deepEqual(r.json.topSessions.map((t) => t.id), [SID_Y]);
    assert.deepEqual(r.json.unusedContext.skillsNeverInvoked, ['codex-idle']);
    assert.deepEqual(r.json.unusedContext.mcpServersNeverCalled, ['codex_srv']);
    assert.ok(!r.stdout.includes(other) && !r.stdout.includes(other.replace(/\\/g, '/')), 'the Codex home path is not printed');
    // Without --codex-dirs the default discovery finds ~/.codex.
    const d = run(['--scope', 'user', '--sources', 'codex']);
    assert.equal(d.json.totalTokens, 1950);
    assert.deepEqual(d.json.topSessions.map((t) => t.id), [SID_X]);
    // A Claude account alone: its config dir and no Codex session.
    const a = run(['--scope', 'user', '--config-dirs', path.join(home, '.claude'), '--sources', 'claude']);
    assert.deepEqual(a.json.sources, { claude: 3, codex: 0 });
    assert.equal(a.json.totalTokens, 176200);
    // Both sources with a named Codex home: the Claude sessions plus that home.
    assert.equal(run(['--scope', 'user', '--codex-dirs', other]).json.totalTokens, 176200 + 320);
    // A Codex home that does not exist reads nothing; it does not fall back to the default.
    assert.equal(run(['--scope', 'user', '--sources', 'codex', '--codex-dirs', path.join(other, 'nope')]).json.totalTokens, 0);
  } finally {
    rmrf(other);
  }
});

// ------------------------------------------------------------------------------------------
// Correction markers
// ------------------------------------------------------------------------------------------

test('correction markers: English', async () => {
  const { isCorrection } = await import('../scripts/lib/transcripts.mjs');
  // Defaults: the assistant did work and did not ask anything.
  const yes = [
    "that's not what I asked for", "no, that's wrong", 'wrong file', 'undo that', 'please revert it', 'roll it back',
    'I said to use pnpm', 'I asked for the other file', "don't touch the config", 'do not change the tests',
    'you broke the build', 'you deleted the wrong folder', 'stop.', 'this is wrong, use the old name',
  ];
  const no = [
    // A bare leading "no" opens answers as often as corrections.
    'no', 'No.', 'no, use the other file', 'No: the port is 8080', 'No\nuse pnpm here', 'try again',
    'no problem, go ahead', 'no need to run the tests', 'no worries', 'no tests were changed, right?',
    'nobody uses that flag', 'no-op is fine here', 'now run the tests', 'note the version first',
    'there is no issue with it', 'looks good, ship it', 'stop the dev server and run the tests',
    // Questions are not corrections, even with a marker in them.
    'can you undo that?', 'why did you revert it?', 'is that wrong', 'could we not touch the config',
  ];
  for (const s of yes) assert.equal(isCorrection(s), true, s);
  for (const s of no) assert.equal(isCorrection(s), false, s);
});

test('correction markers: Portuguese', async () => {
  const { isCorrection } = await import('../scripts/lib/transcripts.mjs');
  const yes = [
    'não era isso, desfaz', 'nao é isso', 'não é isso que eu pedi', 'está errado, o nome é outro', 'errado, o nome é outro',
    'desfaz isso', 'desfaça a última mudança', 'reverte isso', 'volta como estava', 'você apagou o arquivo de testes',
    'você quebrou o build', 'eu disse para usar o pnpm', 'eu pedi só o README', 'não mexe no config', 'não faça commit',
    'para de mexer nos testes', 'pare', 'isso não.',
  ];
  const no = [
    // "no" is em + o here: these open an instruction, not a refusal.
    'no arquivo config.json, muda a porta para 8080', 'no projeto, cria a pasta de testes', 'No final do script adiciona um log',
    'no caso de falha, tenta a outra rota', 'no momento só roda os testes', 'nos testes, usa o banco local',
    'nota: o prazo é sexta', 'agora roda os testes', 'pode seguir', 'ficou ótimo',
    // A bare leading "não" is not a marker: answers and plain instructions.
    'não', 'Não, usa o outro arquivo', 'não precisa agora', 'não precisa, segue', 'faz de novo', 'roda de novo agora',
    // Questions, with or without the question mark.
    'não dá pra usar o X?', 'não dá pra usar o X', 'por que você apagou isso?', 'pode desfazer?', 'está errado?',
    'será que está errado', 'tem como voltar como estava?',
  ];
  for (const s of yes) assert.equal(isCorrection(s), true, s);
  for (const s of no) assert.equal(isCorrection(s), false, s);
});

test('corrections need work before them and are not short answers to a question', async () => {
  const { isCorrection, asksUser, SHORT_ANSWER_WORDS } = await import('../scripts/lib/transcripts.mjs');
  assert.equal(isCorrection('não era isso, desfaz', { work: true, asked: false }), true);
  assert.equal(isCorrection('não era isso, desfaz', { work: false, asked: false }), false, 'no tool call since the last message');
  assert.equal(isCorrection("that's wrong, revert it", { work: false }), false);
  // A short reply to a question is an answer.
  assert.equal(isCorrection('não, desfaz', { work: true, asked: true }), false);
  assert.equal(isCorrection('no, undo it', { work: true, asked: true }), false);
  // A longer reply with a marker about the work still counts.
  const long = 'não era isso, você apagou o arquivo de configuração inteiro e eu pedi para mudar só a porta dele';
  assert.ok(long.split(/\s+/).length > SHORT_ANSWER_WORDS);
  assert.equal(isCorrection(long, { work: true, asked: true }), true);
  // What counts as the assistant asking something.
  assert.equal(asksUser('Feito.\n\nQuer que eu rode os testes agora?'), true);
  assert.equal(asksUser('Should I keep the old flag?'), true);
  assert.equal(asksUser('Two ways to do it:\n1. Keep the flag\n2. Remove it\nWhich one do you prefer'), true);
  assert.equal(asksUser('Done. Summary:\n1. Edited the config\n2. Ran the tests'), false, 'a numbered summary is not a choice');
  assert.equal(asksUser('Is it right? I checked it.\n\nAll tests pass.'), false, 'only the last paragraph counts');
});

test('correction markers: only short messages count', async () => {
  const { isCorrection, CORRECTION_MAX_CHARS } = await import('../scripts/lib/transcripts.mjs');
  assert.equal(isCorrection(`desfaz, ${'x'.repeat(CORRECTION_MAX_CHARS)}`), false);
  assert.equal(isCorrection(`desfaz, ${'x'.repeat(CORRECTION_MAX_CHARS - 10)}`), true);
});

test('a skill read through a Windows path counts as used', async () => {
  const { skillsReadIn } = await import('../scripts/lib/transcripts.mjs');
  assert.deepEqual(skillsReadIn('~/.claude/skills/alpha/SKILL.md'), ['alpha']);
  assert.deepEqual(skillsReadIn('C:\\x\\.claude\\skills\\beta\\SKILL.md and .agents/skills/gamma/SKILL.md'), ['beta', 'gamma']);
  assert.deepEqual(skillsReadIn('skills/README.md'), []);
});

test('rejects a bad scope', () => {
  const r = runScript('session-impact.mjs', ['--cwd', project, '--scope', 'nope'], { env });
  assert.equal(r.code, 2);
});

test('a missing file is not a missing command', async () => {
  const { NOT_FOUND_RE } = await import('../scripts/lib/transcripts.mjs');
  assert.equal(NOT_FOUND_RE.test('cat: notes.txt: No such file or directory'), false);
  assert.equal(NOT_FOUND_RE.test('bash: ./run.sh: No such file or directory'), true);
  assert.equal(NOT_FOUND_RE.test("'foo' is not recognized as an internal or external command"), true);
});
