// session-impact.mjs: one definition of a counted event, and "not read" never printed as zero.
//   - a Codex tool call is counted once per call id, whichever record shapes carry it;
//   - tool output, skill usage and the unused lists come from the same counted events as the
//     token totals, so a replayed copy or an event outside the window adds nothing to them;
//   - when a source's tool calls could not be read, a count of 0 becomes null and the name moves
//     from the "never used" lists to the "unknown" ones, all the way into the estimates.
// Every transcript is synthetic and built in os.tmpdir(); expected numbers are worked out by hand
// in the comments.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, rmrf, homeEnv, runScript, write } from './helpers.mjs';
import { encodeProjectPath } from '../scripts/lib/locations.mjs';

const MARKER = 'ZQXMARK7731'; // 11 chars; must never reach stdout or stderr
const DAY = 86400000;
const now = new Date();
// In-window entries happen two days ago, from noon UTC on; OLD is outside the 30-day window.
const BASE = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2, 12);
let clock = 0;
const ts = () => new Date(BASE + (clock++) * 1000).toISOString();
const OLD = new Date(Date.now() - 40 * DAY).toISOString();
const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const sid = (d) => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
const impact = (args, home) => runScript('session-impact.mjs', args, { env: homeEnv(home) });
// Notes about price weights are not what these tests are about.
const notesOf = (j) => j.notes.filter((n) => !/weighted|price list/.test(n));

const dirs = [];
const tmp = (prefix) => { const d = tmpDir(prefix); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmrf(d); });

// ---- Claude rows
const Z = [100, 0, 0, 10]; // 110 tokens
function asst(id, blocks, { time = ts(), attr = null } = {}) {
  const [i, cw, cr, o] = Z;
  return {
    parentUuid: null, isSidechain: false, type: 'assistant', timestamp: time, ...(attr ? { attributionSkill: attr } : {}),
    message: { model: 'claude-test-a', id, type: 'message', role: 'assistant', content: blocks, usage: { input_tokens: i, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: o } },
  };
}
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const bash = (id, command) => use(id, 'Bash', { command, description: 'run' });
const result = (id, text) => ({ parentUuid: null, isSidechain: false, type: 'user', timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: false }] }, toolUseResult: { stdout: '', stderr: '' } });
const typed = (command, uuid, time = ts()) => ({ parentUuid: null, isSidechain: false, type: 'user', uuid, timestamp: time, message: { role: 'user', content: `<command-name>/${command}</command-name>` } });
const TEXT = [{ type: 'text', text: 'ok' }];

// ---- Codex rows, in the key order the CLI writes them
const ev = (payload, time = ts()) => ({ timestamp: time, type: 'event_msg', payload });
const item = (payload, time = ts()) => ({ timestamp: time, type: 'response_item', payload });
const fn = (callId, name, args, { namespace = null, time = ts() } = {}) => item({ type: 'function_call', name, ...(namespace ? { namespace } : {}), arguments: JSON.stringify(args), call_id: callId }, time);
const output = (callId, text, type = 'function_call_output') => item({ type, call_id: callId, output: text });
const done = (it) => ev({ type: 'item_completed', item: it });
const command = (id, script, { exit = 0, out = '' } = {}) => ({ type: 'CommandExecution', id, command: ['bash', '-lc', script], exit_code: exit, status: exit ? 'failed' : 'completed', stderr: '', aggregated_output: out });
const tokens = (input, cached, out) => ev({ type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: out, total_tokens: input + out } } });
const meta = (id, cwd) => [{ timestamp: ts(), type: 'session_meta', payload: { id, cwd } }, { timestamp: ts(), type: 'turn_context', payload: { cwd, model: 'codex-test' } }];
const rollout = (home, id, rows) => write(path.join(home, '.codex', 'sessions', '2026', '11', '20', `rollout-2026-11-20T12-00-00-${id}.jsonl`), jsonl(rows));
const skill = (dir, name) => write(path.join(dir, name, 'SKILL.md'), `# ${name}\n`);

// ------------------------------------------------------------------------------------------
// A Codex tool call is one call, whichever record shapes carry it
// ------------------------------------------------------------------------------------------

test('Codex tool calls count once per call id, in every record shape', () => {
  const home = tmp('hd-shapes-home-');
  const proj = tmp('hd-shapes-proj-');
  const [SL, SB] = [sid('1'), sid('2')];

  // Rollout L: an older CLI. The model's calls are response_items, MCP completions are
  // mcp_tool_call_end events, and there is no item_completed at all. One model call: 110 tokens.
  rollout(home, SL, [
    ...meta(SL, proj),
    // L0: first recorded 40 days ago. The call is outside the window, and so is its output,
    // although the output item itself is two days old.
    fn('L0', 'shell', { command: ['bash', '-lc', 'npm run old'] }, { time: OLD }),
    output('L0', JSON.stringify({ output: 'y'.repeat(300), metadata: { exit_code: 0 } })),
    // L1: `shell` with the old JSON output wrapper; exit 1. Output: 4 + 1 + 11 = 16 chars.
    fn('L1', 'shell', { command: ['bash', '-lc', `npm test ${MARKER}`] }),
    output('L1', JSON.stringify({ output: `FAIL ${MARKER}`, metadata: { exit_code: 1, duration_seconds: 0.1 } })),
    // L2: a command that does not exist; exit 127. Output: 32 chars.
    fn('L2', 'shell', { command: ['bash', '-lc', 'foo-cli build'] }),
    output('L2', JSON.stringify({ output: 'bash: foo-cli: command not found', metadata: { exit_code: 127 } })),
    // L3: `exec_command` with the plain-text header; it reads a skill. Output: 10 chars.
    fn('L3', 'exec_command', { cmd: 'cat .codex/skills/legacy-skill/SKILL.md' }),
    output('L3', 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nskill text'),
    // L4: a local_shell_call. Output: 5 chars.
    item({ type: 'local_shell_call', call_id: 'L4', status: 'completed', action: { type: 'exec', command: ['git', 'status'] } }),
    output('L4', 'Process exited with code 0\nOutput:\nclean'),
    // L5: an MCP call known only from its end event.
    ev({ type: 'mcp_tool_call_end', call_id: 'L5', invocation: { server: 'legacy_srv', tool: 'ping', arguments: {} }, result: { Ok: { content: [] } } }),
    // L6: an MCP call known only from the model's call, under its full tool name.
    fn('L6', 'mcp__named_srv__lookup', {}),
    output('L6', 'ok'),
    // L7: a custom tool that is not a shell.
    item({ type: 'custom_tool_call', call_id: 'L7', name: 'apply_patch', input: `*** Begin Patch ${MARKER}` }),
    output('L7', 'Success', 'custom_tool_call_output'),
    tokens(100, 0, 10),
  ]);

  // Rollout B: calls written in more than one shape. One model call: 150 + 50 cached + 20 = 220.
  rollout(home, SB, [
    ...meta(SB, proj),
    // B3: the model's call, the completed item and the output item of one command. 5 chars.
    fn('B3', 'shell_command', { command: 'ls' }),
    done(command('B3', 'ls', { out: 'a.txt' })),
    output('B3', 'Exit code: 0\nOutput:\na.txt'),
    // B4: a script tool. It is one call; what the script ran arrives as items with ids of their own.
    item({ type: 'custom_tool_call', call_id: 'B4', name: 'exec', input: `script ${MARKER}` }),
    done(command('exec-1', 'rtk gain', { out: 'x'.repeat(40) })),
    done({ type: 'McpToolCall', id: 'exec-2', server: 'both_srv', tool: 'ping', arguments: {}, status: 'completed' }),
    output('B4', 'done', 'custom_tool_call_output'),
    // B2: ONE MCP call in three shapes: the model's call, the completed item, the older end event.
    fn('B2', 'ping', {}, { namespace: 'mcp__both_srv' }),
    done({ type: 'McpToolCall', id: 'B2', server: 'both_srv', tool: 'ping', arguments: {}, status: 'completed' }),
    ev({ type: 'mcp_tool_call_end', call_id: 'B2', invocation: { server: 'both_srv', tool: 'ping', arguments: {} }, result: { Ok: { content: [] } } }),
    output('B2', 'pong'),
    // B5: a tool of another namespace.
    fn('B5', 'sleep', { duration_ms: 1 }, { namespace: 'clock' }),
    // B1: ONE command in three shapes. The end event says it failed (exit 2, 13 + 11 = 24 chars);
    // the output item, read later, says exit 0: the event is the one kept.
    fn('B1', 'exec_command', { cmd: `pnpm build ${MARKER}` }),
    ev({ type: 'exec_command_end', call_id: 'B1', command: ['bash', '-lc', `pnpm build ${MARKER}`], exit_code: 2, stderr: '', aggregated_output: `BUILD FAILED ${MARKER}` }),
    output('B1', 'Process exited with code 0\nOutput:\nok'),
    tokens(200, 50, 20),
  ]);
  for (const n of ['legacy-skill', 'idle-skill']) skill(path.join(home, '.codex', 'skills'), n);
  write(path.join(home, '.codex', 'config.toml'), ['legacy_srv', 'named_srv', 'both_srv', 'idle_srv'].map((n) => `[mcp_servers.${n}]\ncommand = "x"\n`).join('\n'));

  const args = ['--scope', 'user', '--sources', 'codex'];
  const r = impact(args, home);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(MARKER), 'marker leaked');
  const j = r.json;
  assert.deepEqual([j.sources, j.sessions, j.totalTokens], [{ claude: 0, codex: 2 }, 2, 330]);
  // L: shell x2 (L1, L2; L0 is old), exec_command (L3), local_shell (L4), the two MCP calls, apply_patch.
  // B: shell_command (B3, three records), exec (B4), exec_command x2 (exec-1 known from its
  //    completion only, B1 under its recorded name), mcp__both_srv__ping x2 (exec-2, and B2 once
  //    for its three records), clock.sleep (B5).
  assert.deepEqual(j.toolCalls, {
    exec_command: 3, shell: 2, mcp__both_srv__ping: 2,
    apply_patch: 1, 'clock.sleep': 1, exec: 1, local_shell: 1, mcp__legacy_srv__ping: 1, mcp__named_srv__lookup: 1, shell_command: 1,
  });
  assert.deepEqual(j.mcpCalls, { both_srv: 2, legacy_srv: 1, named_srv: 1, idle_srv: 0 });
  // L3 read the skill's SKILL.md.
  assert.deepEqual(j.skillInvocations, { 'legacy-skill': 1, 'idle-skill': 0 });
  assert.deepEqual(
    [j.unusedContext.skillsNeverInvoked, j.unusedContext.skillsUnknown, j.unusedContext.mcpServersNeverCalled, j.unusedContext.mcpServersUnknown],
    [['idle-skill'], [], ['idle_srv'], []],
  );
  // Output of each completed command, once: 40 + 32 + 24 + 16 + 10 + 5 + 5 = 132 chars -> 33 tokens.
  assert.deepEqual(j.toolOutput.byHead.map((h) => [h.head, h.calls, h.chars]), [
    ['rtk gain', 1, 40], ['foo-cli', 1, 32], ['pnpm build', 1, 24], ['npm test', 1, 16], ['cat', 1, 10], ['git status', 1, 5], ['ls', 1, 5],
  ]);
  assert.deepEqual([j.toolOutput.shellResultChars, j.toolOutput.shellResultTokensApprox], [132, 33]);
  // The outcomes were read too. L: foo-cli does not exist (its turn, 110). B: the session ends on
  // the failed build (220), because the end event wins over the output item that said exit 0.
  const w = Object.fromEntries(j.waste.map((x) => [x.kind, [x.episodes, x.tokens, x.topHeads]]));
  assert.deepEqual(w.notfound, [1, 110, ['foo-cli']]);
  assert.deepEqual(w['error-end'], [1, 220, []]);
  assert.deepEqual([w.retry[0], w.loop[0], w.correction[0], w['hook-block'][0], w.exploration[0]], [0, 0, 0, 0, 0]);
  assert.deepEqual(j.coverage.codex, {
    read: true, files: 2, filesFailed: 0, unparsableLines: 0, unrecognizedCallRecords: 0, rolloutsWithoutProject: 0, toolCalls: 'complete', unrecognizedKinds: [],
  });
  assert.deepEqual(j.coverage.claude, { read: false, files: 0, filesFailed: 0, unparsableLines: 0, toolCalls: 'not-read' });
  assert.deepEqual(notesOf(j), ['transcript sources read: codex']);
  // The same counts when the files are parsed in worker threads.
  const wk = impact([...args, '--workers', '2'], home).json;
  assert.deepEqual([wk.toolCalls, wk.mcpCalls, wk.skillInvocations, wk.toolOutput, wk.waste, wk.coverage], [j.toolCalls, j.mcpCalls, j.skillInvocations, j.toolOutput, j.waste, j.coverage]);
});

test('the Codex call reader: ids, names, outcomes and what it does not recognize', async () => {
  const { codexCallReader, codexCallName, codexShellOutput, codexCallLine } = await import('../scripts/lib/transcripts.mjs');
  const T = '2026-01-05T10:00:00.000Z';
  const line = (type, payload) => ({ timestamp: T, type, payload });

  // One call id in three shapes is one call, named after the server the event reports.
  const a = codexCallReader();
  const first = a.read(line('response_item', { type: 'function_call', name: 'ping', namespace: 'mcp__my_server', arguments: '{}', call_id: 'c1' }));
  assert.deepEqual([first.created, first.completed], [true, false]);
  assert.equal(a.read(line('event_msg', { type: 'item_completed', item: { type: 'McpToolCall', id: 'c1', server: 'my.server', tool: 'ping' } })).created, false);
  assert.equal(a.read(line('event_msg', { type: 'mcp_tool_call_end', call_id: 'c1', invocation: { server: 'my.server', tool: 'ping' } })).created, false);
  assert.equal(a.calls.length, 1);
  assert.equal(codexCallName(a.calls[0]), 'mcp__my_server__ping');
  assert.equal(a.calls[0].ts, Date.parse(T));
  // A record without an id is always a call of its own.
  a.read(line('response_item', { type: 'custom_tool_call', name: 'exec', input: 'x' }));
  a.read(line('response_item', { type: 'custom_tool_call', name: 'exec', input: 'x' }));
  assert.deepEqual(a.calls.map(codexCallName), ['mcp__my_server__ping', 'exec', 'exec']);
  assert.deepEqual([...a.unrecognized], []);

  // Names: the recorded tool name; namespace.name outside MCP; exec_command for a bare completion;
  // `unnamed` for an MCP tool whose name is not a plain name.
  const b = codexCallReader();
  b.read(line('response_item', { type: 'function_call', name: 'sleep', namespace: 'clock', arguments: '{}', call_id: 'n1' }));
  b.read(line('response_item', { type: 'local_shell_call', call_id: 'n2', action: { type: 'exec', command: ['git', 'status'] } }));
  b.read(line('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'n3', command: ['bash', '-lc', 'ls'], exit_code: 0 } }));
  b.read(line('event_msg', { type: 'item_completed', item: { type: 'McpToolCall', id: 'n4', server: 'srv', tool: 'bad tool name' } }));
  b.read(line('response_item', { type: 'web_search_call', id: 'ws_1', status: 'completed' }));
  assert.deepEqual(b.calls.map(codexCallName), ['clock.sleep', 'local_shell', 'exec_command', 'mcp__srv__unnamed', 'web_search']);
  assert.deepEqual(b.calls.map((c) => [c.shell, c.command]), [[false, null], [true, 'git status'], [true, 'ls'], [false, null], [false, null]]);

  // Outcome: the output item is read first (exit 0), then the end event (exit 3): the event is kept,
  // and the call completes once.
  const c = codexCallReader();
  c.read(line('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'make'] }), call_id: 'o1' }));
  assert.equal(c.awaits('o1'), true);
  assert.equal(c.read(line('response_item', { type: 'function_call_output', call_id: 'o1', output: 'Exit code: 0\nOutput:\nfine' })).completed, true);
  assert.deepEqual([c.calls[0].failed, c.calls[0].outChars, c.awaits('o1')], [false, 4, false]);
  assert.equal(c.read(line('event_msg', { type: 'exec_command_end', call_id: 'o1', command: ['bash', '-lc', 'make'], exit_code: 3, stderr: 'boom', aggregated_output: 'broken' })).completed, false);
  assert.deepEqual([c.calls.length, c.calls[0].failed, c.calls[0].outChars, c.calls[0].text], [1, true, 6, 'boom\nbroken']);
  // The other order: once an event has settled it, a later output item changes nothing.
  assert.equal(c.read(line('response_item', { type: 'function_call_output', call_id: 'o1', output: 'Exit code: 0\nOutput:\nfine' })).completed, false);
  assert.equal(c.calls[0].failed, true);
  // An output for a call that is not a command, or that was never seen, is not a record of a call.
  assert.equal(c.read(line('response_item', { type: 'function_call_output', call_id: 'nope', output: 'x' })), null);

  // Records that look like a tool call in a shape that is not read are counted, never guessed at.
  const d = codexCallReader();
  assert.equal(d.read(line('event_msg', { type: 'item_completed', item: { type: 'RemoteToolCall', id: 'd1', tool: 'x' } })), null);
  d.read(line('event_msg', { type: 'item_completed', item: { type: 'RemoteToolCall', id: 'd2', tool: 'x' } }));
  d.read(line('event_msg', { type: 'mcp_resource_read_end', call_id: 'd1' }));
  d.read(line('event_msg', { type: 'item_completed', item: { type: 'McpToolCall', id: 'd3', tool: 'ping' } })); // no server
  d.read(line('event_msg', { type: 'mcp_tool_call_end', call_id: 'd4', invocation: { tool: 'ping' } }));
  // Not tool calls, or the second record of a call the model made itself (always a response_item
  // too): nothing counted, nothing flagged.
  for (const t of ['Reasoning', 'AgentMessage', 'UserMessage', 'ContextCompaction', 'Extension']) d.read(line('event_msg', { type: 'item_completed', item: { type: t, id: 'x' } }));
  for (const t of ['token_count', 'user_message', 'task_complete', 'mcp_tool_call_begin', 'exec_command_begin', 'patch_apply_end', 'web_search_end', 'dynamic_tool_call_response']) d.read(line('event_msg', { type: t }));
  d.read(line('response_item', { type: 'message', role: 'user', content: [] }));
  assert.deepEqual(d.calls, []);
  assert.deepEqual([...d.unrecognized].sort(), [['McpToolCall:no-server', 1], ['event:mcp_resource_read_end', 1], ['item:RemoteToolCall', 2], ['mcp_tool_call_end:no-server', 1]]);

  // Output formats of a command.
  assert.deepEqual(codexShellOutput(JSON.stringify({ output: 'abc', metadata: { exit_code: 2 } })), { failed: true, text: 'abc' });
  assert.deepEqual(codexShellOutput(JSON.stringify({ output: 'abc', metadata: { exit_code: 0 } })), { failed: false, text: 'abc' });
  assert.deepEqual(codexShellOutput('Exit code: 1\nWall time: 0.2 seconds\nOutput:\nline 1\nline 2'), { failed: true, text: 'line 1\nline 2' });
  assert.deepEqual(codexShellOutput('Chunk ID: a1\nWall time: 0.2 seconds\nProcess exited with code 0\nOriginal token count: 3\nOutput:\nok'), { failed: false, text: 'ok' });
  assert.deepEqual(codexShellOutput('Process exited with code 1\nfailed'), { failed: true, text: 'Process exited with code 1\nfailed' });
  assert.deepEqual(codexShellOutput([{ type: 'input_text', text: 'Exit code: 0\nOutput:\nfine' }]), { failed: false, text: 'fine' });
  // No exit code named: not a failure. The command's own output is never searched for one.
  assert.deepEqual(codexShellOutput('just text'), { failed: false, text: 'just text' });
  assert.deepEqual(codexShellOutput('Output:\nExit code: 1'), { failed: false, text: 'Exit code: 1' });
  assert.deepEqual(codexShellOutput({ content: 'denied', success: false }), { failed: true, text: 'denied' });
  assert.deepEqual(codexShellOutput(undefined), { failed: false, text: '' });

  // The line filter: every call is parsed; an output only while a command waits for it.
  const e = codexCallReader();
  const head = (o) => JSON.stringify(o).slice(0, 512);
  const call = line('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['ls'] }), call_id: 'w1' });
  const out = line('response_item', { type: 'function_call_output', call_id: 'w1', output: 'x' });
  assert.equal(codexCallLine(head(call), e), true);
  assert.equal(codexCallLine(head(out), e), false, 'no command waits for it yet');
  e.read(call);
  assert.equal(codexCallLine(head(out), e), true);
  e.read(out);
  assert.equal(codexCallLine(head(out), e), false, 'already settled');
  assert.equal(codexCallLine(head(line('response_item', { type: 'message', role: 'user', content: [] })), e), false);
  assert.equal(codexCallLine(head(line('event_msg', { type: 'mcp_tool_call_end', call_id: 'x' })), e), true);
  assert.equal(codexCallLine(head(line('event_msg', { type: 'exec_command_end', call_id: 'x' })), e), true);
  assert.equal(codexCallLine(head(line('event_msg', { type: 'agent_message', message: 'hi' })), e), false);
});

// ------------------------------------------------------------------------------------------
// Every count comes from the same counted events as the token totals
// ------------------------------------------------------------------------------------------

test('a session copied into a second file and an event outside the window add nothing to any count', () => {
  const home = tmp('hd-counted-home-');
  const proj = tmp('hd-counted-proj-');
  const pdir = path.join(home, '.claude', 'projects', encodeProjectPath(proj));
  const [SA, SB] = [sid('a'), sid('b')];
  // 40 days ago: a typed command and a model call that names one skill in each way a skill can
  // show up, runs a command and calls an MCP server. Its command's result is read two days ago.
  const before = [
    typed('slash-old', 'uuid-old', OLD),
    asst('o1', [use('k0', 'Skill', { skill: 'old-skill' }), bash('b0', 'npm run old'), use('m0', 'mcp__old_srv__ping', {}), use('r0', 'Read', { file_path: '.claude/skills/read-old/SKILL.md' })], { time: OLD, attr: 'attr-old' }),
    result('b0', 'y'.repeat(100)),
  ];
  // Two days ago: the same things under other names.
  const live = [
    typed('slash-live', 'uuid-live'),
    asst('m1', [use('k1', 'Skill', { skill: 'live-skill' }), bash('b1', `npm test ${MARKER}`), use('m1c', 'mcp__live_srv__ping', {}), use('r1', 'Read', { file_path: '.claude/skills/read-live/SKILL.md' })], { attr: 'attr-live' }),
    result('b1', 'x'.repeat(400)),
    result('k1', 'loaded'),
    result('m1c', 'pong'),
    result('r1', 'text'),
  ];
  write(path.join(pdir, `${SA}.jsonl`), jsonl([...before, ...live]));
  // A resumed session: every entry above again (same message ids, same entry ids), then one new call.
  write(path.join(pdir, `${SB}.jsonl`), jsonl([...before, ...live, asst('m2', [bash('b2', 'npm test')]), result('b2', 'z'.repeat(50))]));
  for (const n of ['old-skill', 'live-skill', 'read-old', 'read-live', 'attr-old', 'attr-live', 'slash-old', 'slash-live', 'idle-skill']) skill(path.join(proj, '.claude', 'skills'), n);
  write(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { old_srv: { command: 'x' }, live_srv: { command: 'x' }, idle_srv: { command: 'x' } } }));

  const args = ['--cwd', proj];
  const r = impact(args, home);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(MARKER), 'marker leaked');
  const j = r.json;
  // Token totals, as before: m1 once (110) and m2 (110). B's copy of m1 is dropped; o1 is old.
  assert.deepEqual([j.totalTokens, j.sessions, j.duplicates], [220, 2, { turnsDropped: 1, tokensDropped: 110 }]);
  // Every other count comes from those same two model calls.
  // Tool calls: m1 has Skill, Bash, the MCP tool and Read; m2 has Bash.
  assert.deepEqual(j.toolCalls, { Bash: 2, Read: 1, Skill: 1, mcp__live_srv__ping: 1 });
  // Shell output: b1 (400) and b2 (50). Not the copy of b1's result in the second file, and not
  // b0's result (100, twice): it is two days old, but the call it answers is 40 days old.
  assert.deepEqual(j.toolOutput.byHead, [{ head: 'npm test', calls: 2, chars: 450 }]);
  assert.deepEqual([j.toolOutput.shellResultChars, j.toolOutput.shellResultTokensApprox], [450, 113]);
  // Skills: the live names once each (the Skill tool, the typed command, the read, the
  // attribution); the old names and the idle one not at all.
  assert.deepEqual(j.skillInvocations, {
    'attr-live': 1, 'live-skill': 1, 'read-live': 1, 'slash-live': 1,
    'attr-old': 0, 'idle-skill': 0, 'old-skill': 0, 'read-old': 0, 'slash-old': 0,
  });
  assert.deepEqual(j.mcpCalls, { live_srv: 1, idle_srv: 0, old_srv: 0 });
  // The unused lists say the same thing as the counts: a use outside the window is not a use.
  assert.deepEqual(j.unusedContext.skillsNeverInvoked, ['attr-old', 'idle-skill', 'old-skill', 'read-old', 'slash-old']);
  assert.deepEqual(j.unusedContext.mcpServersNeverCalled, ['idle_srv', 'old_srv']);
  assert.deepEqual([j.unusedContext.skillsUnknown, j.unusedContext.mcpServersUnknown], [[], []]);
  for (const n of j.unusedContext.skillsNeverInvoked) assert.equal(j.skillInvocations[n], 0, n);
  for (const n of j.unusedContext.mcpServersNeverCalled) assert.equal(j.mcpCalls[n], 0, n);
  assert.deepEqual(j.coverage.claude, { read: true, files: 2, filesFailed: 0, unparsableLines: 0, toolCalls: 'complete' });
  assert.deepEqual(notesOf(j), []);

  // One file alone gives the single in-window count of everything it holds: the copy added nothing.
  fs.rmSync(path.join(pdir, `${SB}.jsonl`));
  const one = impact(args, home).json;
  assert.deepEqual([one.totalTokens, one.duplicates.turnsDropped], [110, 0]);
  assert.deepEqual(one.toolCalls, { Bash: 1, Read: 1, Skill: 1, mcp__live_srv__ping: 1 });
  assert.deepEqual(one.toolOutput.byHead, [{ head: 'npm test', calls: 1, chars: 400 }]);
  assert.deepEqual(one.skillInvocations, j.skillInvocations);
  assert.deepEqual(one.mcpCalls, j.mcpCalls);
  assert.deepEqual(one.unusedContext, j.unusedContext);
});

// ------------------------------------------------------------------------------------------
// "Not read" is never a measured zero
// ------------------------------------------------------------------------------------------

test('a line that cannot be parsed: a name it mentions is unknown, the others stay measured', () => {
  const home = tmp('hd-partial-home-');
  const proj = tmp('hd-partial-proj-');
  const pdir = path.join(home, '.claude', 'projects', encodeProjectPath(proj));
  write(path.join(pdir, `${sid('c')}.jsonl`), jsonl([
    asst('g1', TEXT),
    // An assistant entry cut short while it was written: it calls a server and a skill.
    `{"type":"assistant","timestamp":"${ts()}","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"mcp__ghost_srv__ping","input":{}},{"type":"tool_use","id":"t2","name":"Skill","input":{"skill":"ghost-skill"`,
  ]));
  for (const n of ['ghost-skill', 'idle-skill']) skill(path.join(proj, '.claude', 'skills'), n);
  // The server is configured as `ghost.srv`; its tools carry `ghost_srv`.
  write(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'ghost.srv': { command: 'x' }, idle_srv: { command: 'x' } } }));

  const r = impact(['--cwd', proj], home);
  assert.equal(r.code, 0, r.stderr);
  const j = r.json;
  assert.deepEqual([j.totalTokens, j.unparsableLines], [110, 1]);
  assert.deepEqual(j.coverage.claude, { read: true, files: 1, filesFailed: 0, unparsableLines: 1, toolCalls: 'partial' });
  assert.deepEqual(j.skillInvocations, { 'idle-skill': 0, 'ghost-skill': null });
  assert.deepEqual(j.mcpCalls, { idle_srv: 0, 'ghost.srv': null });
  assert.deepEqual(j.unusedContext.skillsNeverInvoked, ['idle-skill']);
  assert.deepEqual(j.unusedContext.skillsUnknown, ['ghost-skill']);
  assert.deepEqual(j.unusedContext.mcpServersNeverCalled, ['idle_srv']);
  assert.deepEqual(j.unusedContext.mcpServersUnknown, ['ghost.srv']);
  assert.deepEqual(notesOf(j), ['lines that could not be parsed name a configured skill or MCP server that shows no use; it is reported as unknown, not as unused']);
  // JSON keeps null as null: a consumer cannot read it as 0.
  assert.ok(r.stdout.includes('"ghost-skill": null'));
  // In worker threads the names to look for travel with the job.
  const wk = impact(['--cwd', proj, '--workers', '2'], home).json;
  assert.deepEqual([wk.skillInvocations, wk.mcpCalls, wk.unusedContext, wk.coverage], [j.skillInvocations, j.mcpCalls, j.unusedContext, j.coverage]);
});

/** A user-level home where Codex wrote tool call records in a shape that is not read. */
function blindCodexHome() {
  const home = tmp('hd-blind-home-');
  const proj = tmp('hd-blind-proj-');
  const SX = sid('3');
  write(path.join(home, '.claude', 'projects', encodeProjectPath(proj), `${sid('d')}.jsonl`), jsonl([asst('h1', TEXT)]));
  rollout(home, SX, [
    ...meta(SX, proj),
    done(command('x1', 'cat .codex/skills/codex-used/SKILL.md', { out: 'text' })),
    done({ type: 'McpToolCall', id: 'x2', server: 'codex_used', tool: 'ping', arguments: {}, status: 'completed' }),
    // Three records that can hold a tool call and are not read: an item type and an MCP end event
    // this version does not know, and an MCP call that names no server.
    done({ type: 'RemoteToolCall', id: 'x3', tool: `tool ${MARKER}`, arguments: {} }),
    ev({ type: 'mcp_resource_read_end', call_id: 'x5', result: MARKER }),
    done({ type: 'McpToolCall', id: 'x4', tool: 'ping', arguments: {}, status: 'completed' }), // names no server
    tokens(100, 0, 10),
  ]);
  skill(path.join(home, '.claude', 'skills'), 'claude-idle');
  skill(path.join(home, '.agents', 'skills'), 'shared-idle');
  for (const n of ['codex-used', 'codex-idle']) skill(path.join(home, '.codex', 'skills'), n);
  write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { claude_srv: { command: 'x' } } }));
  write(path.join(home, '.codex', 'config.toml'), ['codex_used', 'codex_idle'].map((n) => `[mcp_servers.${n}]\ncommand = "x"\n`).join('\n'));
  return { home, proj };
}

test('tool call records in a shape that is not read: every zero of that source is unknown', () => {
  const { home } = blindCodexHome();
  const r = impact(['--scope', 'user'], home);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(MARKER), 'marker leaked');
  const j = r.json;
  assert.deepEqual([j.sources, j.totalTokens], [{ claude: 1, codex: 1 }, 220]);
  assert.deepEqual(j.coverage.codex, {
    read: true, files: 1, filesFailed: 0, unparsableLines: 0, unrecognizedCallRecords: 3, rolloutsWithoutProject: 0, toolCalls: 'unknown',
    unrecognizedKinds: ['McpToolCall:no-server', 'event:mcp_resource_read_end', 'item:RemoteToolCall'],
  });
  assert.deepEqual(j.coverage.claude, { read: true, files: 1, filesFailed: 0, unparsableLines: 0, toolCalls: 'complete' });
  // What was read is counted as usual.
  assert.deepEqual(j.toolCalls, { exec_command: 1, mcp__codex_used__ping: 1 });
  // What shows no use: Claude's own skill and server were measured (0). Codex's were not, and
  // neither was the shared skill, which either agent can use (null).
  assert.deepEqual(j.skillInvocations, { 'codex-used': 1, 'claude-idle': 0, 'codex-idle': null, 'shared-idle': null });
  assert.deepEqual(j.mcpCalls, { codex_used: 1, claude_srv: 0, codex_idle: null });
  assert.deepEqual(j.unusedContext.skillsNeverInvoked, ['claude-idle']);
  assert.deepEqual(j.unusedContext.skillsUnknown, ['codex-idle', 'shared-idle']);
  assert.deepEqual(j.unusedContext.mcpServersNeverCalled, ['claude_srv']);
  assert.deepEqual(j.unusedContext.mcpServersUnknown, ['codex_idle']);
  assert.deepEqual([j.unusedContext.skillsConfigured, j.unusedContext.mcpServersConfigured], [4, 3]);
  assert.deepEqual(notesOf(j), ['codex: tool calls not fully read (3 record(s) that look like a tool call have a shape that is not read); a skill or MCP server it could have used and that shows no use is reported as unknown, not as unused']);
  for (const k of ['method']) assert.ok(j.coverage[k].length > 40);

  // Measured alone, the Claude account is complete: what Codex could not read does not touch it.
  const c = impact(['--scope', 'user', '--sources', 'claude'], home).json;
  assert.deepEqual(c.skillInvocations, { 'claude-idle': 0, 'shared-idle': 0 });
  assert.deepEqual([c.coverage.claude.toolCalls, c.coverage.codex.toolCalls], ['complete', 'not-read']);
});

test('unknown coverage reaches the estimates: no "never used" claim and no estimate for an unknown name', () => {
  const { home } = blindCodexHome();
  const dir = tmp('hd-blind-est-');
  const measured = impact(['--scope', 'user'], home);
  assert.equal(measured.code, 0, measured.stderr);
  const files = {
    impact: path.join(dir, 'impact.json'), snapshot: path.join(dir, 'snapshot.json'), catalog: path.join(dir, 'catalog.json'),
  };
  write(files.impact, measured.stdout);
  write(files.snapshot, JSON.stringify({
    harness: { id: 'u1', kind: 'user', name: 'account' },
    elements: { skills: ['claude-idle', 'codex-idle', 'shared-idle', 'codex-used'].map((name) => ({ name, level: 'user', descriptionChars: 400 })) },
  }));
  write(files.catalog, JSON.stringify({
    verifiedAt: '2026-01-01',
    estimates: [
      { id: 'unused-skill-descriptions', kind: 'documented', tool: null, label: 'Descriptions of skills never invoked', maxDescriptionChars: 1536, source: 'https://example.com/claim', verifiedAt: '2026-01-01', quote: ['synthetic quote'], basis: 'Synthetic sentence for skill descriptions.' },
      { id: 'unused-mcp-servers', kind: 'unmeasured', tool: null, label: 'MCP server never called', source: 'session-impact.mjs', verifiedAt: '2026-01-01', quote: null, basis: 'Synthetic sentence for servers.' },
    ],
  }));
  const r = runScript('impact-estimates.mjs', ['--impact', files.impact, '--snapshot', files.snapshot, '--catalog', files.catalog]);
  assert.equal(r.code, 0, r.stderr);
  // Only claude-idle was measured as never invoked: 400 chars / 4 = 100 tokens x 2 sessions = 200.
  // codex-idle and shared-idle (800 more tokens had they been counted) are not in the estimate.
  assert.deepEqual(r.json.estimates, [{ id: 'unused-skill-descriptions', label: 'Descriptions of skills never invoked', tokens: 200, source: 'Synthetic sentence for skill descriptions.' }]);
  assert.deepEqual(r.json.detail.skills.map((s) => [s.name, s.tokens]), [['claude-idle', 200]]);
  // Only claude_srv was measured as never called.
  assert.deepEqual(r.json.unmeasured.map((u) => u.tool), ['claude_srv']);
  assert.deepEqual(r.json.unknownUsage, { skills: ['codex-idle', 'shared-idle'], mcpServers: ['codex_idle'] });
});

test('project scope: a rollout with tool calls and no working directory leaves Codex unknown', () => {
  const home = tmp('hd-orphan-home-');
  const proj = tmp('hd-orphan-proj-');
  const [S1, S2] = [sid('4'), sid('5')];
  // No session_meta and no turn_context: nothing says which project this rollout belongs to.
  rollout(home, S1, [done(command('q1', 'cat .agents/skills/shared-idle/SKILL.md', { out: 'text' })), tokens(100, 0, 10)]);
  // Another one without a cwd, but with no tool call: it hides nothing.
  rollout(home, S2, [tokens(100, 0, 10)]);
  skill(path.join(proj, '.agents', 'skills'), 'shared-idle');
  skill(path.join(proj, '.claude', 'skills'), 'claude-idle');
  const j = impact(['--cwd', proj], home).json;
  // Nothing of the orphan rollout is counted for the project.
  assert.deepEqual([j.totalTokens, j.sessions, j.toolCalls], [0, 0, {}]);
  assert.deepEqual(j.coverage.codex, {
    read: true, files: 0, filesFailed: 0, unparsableLines: 0, unrecognizedCallRecords: 0, rolloutsWithoutProject: 1, toolCalls: 'unknown', unrecognizedKinds: [],
  });
  // The shared skill may have been read by that rollout; the Claude one cannot have been.
  assert.deepEqual(j.skillInvocations, { 'claude-idle': 0, 'shared-idle': null });
  assert.deepEqual([j.unusedContext.skillsNeverInvoked, j.unusedContext.skillsUnknown], [['claude-idle'], ['shared-idle']]);
  assert.deepEqual(notesOf(j), ['codex: tool calls not fully read (1 rollout(s) with tool calls record no working directory); a skill or MCP server it could have used and that shows no use is reported as unknown, not as unused']);
  // At user scope there is no project to give it to: the rollout is simply read.
  const u = impact(['--scope', 'user', '--sources', 'codex'], home).json;
  assert.deepEqual([u.coverage.codex.toolCalls, u.coverage.codex.files, u.toolCalls], ['complete', 2, { exec_command: 1 }]);
});

test('coverage status from the counts', async () => {
  const { toolCallCoverage } = await import('../scripts/session-impact.mjs');
  const c = (patch) => ({ read: true, files: 3, filesFailed: 0, unparsableLines: 0, unrecognizedCallRecords: 0, rolloutsWithoutProject: 0, ...patch });
  assert.equal(toolCallCoverage(c({})), 'complete');
  assert.equal(toolCallCoverage(c({ files: 0 })), 'complete', 'nothing to read is not a gap');
  assert.equal(toolCallCoverage(c({ unparsableLines: 2 })), 'partial');
  assert.equal(toolCallCoverage(c({ filesFailed: 1 })), 'unknown');
  assert.equal(toolCallCoverage(c({ filesFailed: 1, unparsableLines: 2 })), 'unknown');
  assert.equal(toolCallCoverage(c({ unrecognizedCallRecords: 1 })), 'unknown');
  assert.equal(toolCallCoverage(c({ rolloutsWithoutProject: 1 })), 'unknown');
  assert.equal(toolCallCoverage(c({ read: false, filesFailed: 1 })), 'not-read');
  // Claude has no Codex-only counters.
  assert.equal(toolCallCoverage({ read: true, files: 1, filesFailed: 0, unparsableLines: 0 }), 'complete');
});

/**
 * Make a file unreadable while it stays listed: no mode bits on POSIX; on Windows an open handle
 * that shares nothing (libuv's UV_FS_O_EXLOCK flag, which Node passes through). Returns the undo.
 */
function deny(file) {
  if (process.platform === 'win32') {
    const fd = fs.openSync(file, fs.constants.O_RDWR | 0x10000000);
    return () => fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o000);
  return () => fs.chmodSync(file, 0o600);
}

test('a transcript file that cannot be read: every zero of that source is unknown', (t) => {
  const home = tmp('hd-denied-home-');
  const proj = tmp('hd-denied-proj-');
  const pdir = path.join(home, '.claude', 'projects', encodeProjectPath(proj));
  write(path.join(pdir, `${sid('e')}.jsonl`), jsonl([asst('d1', [use('k1', 'Skill', { skill: 'used-skill' })])]));
  const locked = path.join(pdir, `${sid('f')}.jsonl`);
  write(locked, jsonl([asst('d2', [use('k2', 'Skill', { skill: 'hidden-skill' })])]));
  for (const n of ['used-skill', 'hidden-skill', 'idle-skill']) skill(path.join(proj, '.claude', 'skills'), n);
  const allow = deny(locked);
  try {
    // Where the file can still be read (root ignores mode bits), there is nothing to test.
    let readable = true;
    try { fs.readFileSync(locked); } catch { readable = false; }
    if (readable) { t.skip('this user can read a file it was denied'); return; }
    const r = impact(['--cwd', proj], home);
    assert.equal(r.code, 0, r.stderr);
    const j = r.json;
    assert.deepEqual(j.coverage.claude, { read: true, files: 1, filesFailed: 1, unparsableLines: 0, toolCalls: 'unknown' });
    assert.deepEqual(j.skillInvocations, { 'used-skill': 1, 'hidden-skill': null, 'idle-skill': null });
    assert.deepEqual([j.unusedContext.skillsNeverInvoked, j.unusedContext.skillsUnknown], [[], ['hidden-skill', 'idle-skill']]);
    assert.deepEqual(notesOf(j), ['claude: tool calls not fully read (1 transcript file(s) could not be read); a skill or MCP server it could have used and that shows no use is reported as unknown, not as unused']);
  } finally {
    allow();
  }
});
