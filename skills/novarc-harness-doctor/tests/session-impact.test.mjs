// session-impact.mjs against a synthetic home: Claude transcripts (top-level, subagent, replayed
// copy, out-of-window file) and one Codex rollout, all built in os.tmpdir(). Every expected number
// is worked out by hand in the comments.
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

function asst(id, usage, blocks, { side = false, time = ts() } = {}) {
  const [i, cw, cr, o] = usage;
  return {
    parentUuid: null, isSidechain: side, type: 'assistant', timestamp: time,
    message: { model: 'm', id, type: 'message', role: 'assistant', content: blocks, usage: { input_tokens: i, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: o } },
  };
}
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const bash = (id, command) => use(id, 'Bash', { command, description: 'run' });
function result(id, text, isError = false, side = false) {
  return { parentUuid: null, isSidechain: side, type: 'user', timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] }, toolUseResult: { stdout: '', stderr: '' } };
}
const say = (text, side = false) => ({ parentUuid: null, isSidechain: side, type: 'user', timestamp: ts(), message: { role: 'user', content: text } });
const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

let home; let project; let env; let out; let res;

before(() => {
  home = tmpDir('hd-impact-home-');
  project = tmpDir('hd-impact-proj-');
  env = homeEnv(home);
  const pdir = path.join(home, '.claude', 'projects', encodeProjectPath(project));

  // Session A (top-level). Turns T0..T14; every turn is 100 tokens except T0 and T13.
  const A = [
    say(`please build the feature ${MARKER}`), // U0, at=0
    asst('a0', [5, 1000, 0, 50], [use('r0', 'Read', { file_path: `src/${MARKER}.js` })]), // T0: 1055 tokens, context 1005
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
    result('b12', `hook blocked ${MARKER}`, true), // 13 + 11 = 24 chars
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
  write(path.join(pdir, `${SID_B}.jsonl`), jsonl([
    say(`hello ${MARKER}`),
    asst('a0', [5, 1000, 0, 50], [{ type: 'text', text: MARKER }]), // duplicate of T0: 1055 dropped
    asst('b1', U100, [{ type: 'text', text: 'hi' }]), // 100, context 60
  ]));

  // Session C: a big context, an unparsable line, and one call older than the window.
  write(path.join(pdir, `${SID_C}.jsonl`), jsonl([
    say('start'),
    asst('c0', [0, 2000, 1000, 10], [{ type: 'text', text: 'x' }]), // 3010 tokens, context 3000
    'not json {"role":"user"',
    asst('c1', [10, 0, 170000, 5], [{ type: 'text', text: 'y' }]), // 170015 tokens, context 170010
    asst('c2', [500000, 0, 0, 0], [{ type: 'text', text: 'z' }], { time: OLD() }), // outside the window
  ]));

  // Session D: the whole file is older than the window (mtime 40 days ago).
  const dFile = path.join(pdir, `${SID_D}.jsonl`);
  write(dFile, jsonl([asst('d0', [999999, 0, 0, 0], [], { time: OLD() })]));
  const old = new Date(Date.now() - 40 * DAY);
  fs.utimesSync(dFile, old, old);

  // Codex rollout in the project: cumulative token_count events (one repeated) and a failed command.
  write(path.join(home, '.codex', 'sessions', '2026', '11', '19', `rollout-2026-11-19T12-00-00-${SID_X}.jsonl`), jsonl([
    { timestamp: ts(), type: 'session_meta', payload: { id: SID_X, cwd: project } },
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

  res = runScript('session-impact.mjs', ['--cwd', project], { env });
  out = res.json;
});

after(() => { rmrf(home); rmrf(project); });

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
  // correction covers turns 0..1 = 1950. The subagent prompt is not a human correction.
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

test('every block that explains a number carries a method string', () => {
  assert.equal(typeof out.contextAtStart.method, 'string');
  assert.equal(typeof out.contextPeak.method, 'string');
  assert.equal(typeof out.unusedContext.method, 'string');
  for (const x of out.waste) assert.ok(x.method.length > 20, x.kind);
});

test('never prints message text, commands, results or home paths', () => {
  const runs = [res, runScript('session-impact.mjs', ['--cwd', project, '--progress'], { env })];
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
  const r = runScript('session-impact.mjs', ['--cwd', project, '--days', '1'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.totalTokens, 0);
  assert.equal(r.json.sessions, 0);
  // D (999999 input) and C's old call (500000) never show up in the 30-day run either.
  assert.ok(out.byKind.input < 500000);
});

test('worker threads give the same result as one thread', () => {
  const r = runScript('session-impact.mjs', ['--cwd', project, '--workers', '2'], { env });
  assert.equal(r.code, 0, r.stderr);
  const strip = (o) => ({ ...o, generatedAt: null, durationMs: null, from: null, to: null });
  assert.deepEqual(strip(r.json), strip(out));
});

test('user scope reads every project and the user-level config', () => {
  write(path.join(home, '.claude', 'skills', 'user-idle', 'SKILL.md'), '# idle\n');
  write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'user-srv': { command: 'z' } } }));
  const r = runScript('session-impact.mjs', ['--scope', 'user'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.totalTokens, 178150);
  assert.deepEqual(r.json.unusedContext.skillsNeverInvoked, ['user-idle']);
  assert.deepEqual(r.json.unusedContext.mcpServersNeverCalled, ['user-srv']);
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
