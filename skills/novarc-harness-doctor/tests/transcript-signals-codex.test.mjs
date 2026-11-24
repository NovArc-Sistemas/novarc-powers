// transcript-signals.mjs on a Codex rollout that records its tool calls in more than one shape:
// the model's calls as response_items, older end events, and completed items. Each call is one
// call whichever shapes carry it, and a command's failure is read from whichever record has it.
// The rollout is synthetic and built in os.tmpdir().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpDir, rmrf, homeEnv, runScript, write } from './helpers.mjs';

const MARKER = 'ZQXMARK7731'; // must never reach stdout or stderr
const SID = '01b2bbbb-cccc-7ddd-8eee-ffff00001111';
let clock = 0;
const ts = () => new Date(Date.UTC(2026, 0, 5, 10, 0, clock++)).toISOString();
const ev = (payload) => ({ timestamp: ts(), type: 'event_msg', payload });
const item = (payload) => ({ timestamp: ts(), type: 'response_item', payload });
const fn = (callId, name, args, namespace = null) => item({ type: 'function_call', name, ...(namespace ? { namespace } : {}), arguments: JSON.stringify(args), call_id: callId });
const output = (callId, text) => item({ type: 'function_call_output', call_id: callId, output: text });
const failedTest = (id) => [
  fn(id, 'shell', { command: ['bash', '-lc', `npm test ${MARKER}`] }),
  output(id, JSON.stringify({ output: `FAIL ${MARKER}`, metadata: { exit_code: 1 } })),
];

const dirs = [];
after(() => { for (const d of dirs) rmrf(d); });

test('transcript-signals reads Codex calls in every record shape, once per call id', () => {
  const home = tmpDir('hd-signals-codex-home-');
  const proj = tmpDir('hd-signals-codex-proj-');
  dirs.push(home, proj);
  write(path.join(home, '.codex', 'sessions', '2026', '01', '05', `rollout-2026-01-05T10-00-00-${SID}.jsonl`), [
    { timestamp: ts(), type: 'session_meta', payload: { id: SID, cwd: proj } },
    // Three failures of one command, known only from the model's calls and their output items.
    ...failedTest('s1'), ...failedTest('s2'), ...failedTest('s3'),
    // One MCP call in three shapes, and another known only from its end event.
    fn('m1', 'ping', {}, 'mcp__my_server'),
    ev({ type: 'item_completed', item: { type: 'McpToolCall', id: 'm1', server: 'my.server', tool: 'ping', arguments: {}, status: 'completed' } }),
    ev({ type: 'mcp_tool_call_end', call_id: 'm1', invocation: { server: 'my.server', tool: 'ping', arguments: {} }, result: { Ok: { content: [] } } }),
    ev({ type: 'mcp_tool_call_end', call_id: 'm2', invocation: { server: 'my.server', tool: 'ping', arguments: {} }, result: { Ok: { content: [] } } }),
    // A script tool, and the command it ran (an item with an id of its own).
    item({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: `script ${MARKER}` }),
    ev({ type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-1', command: ['bash', '-lc', 'ls'], exit_code: 0, status: 'completed', stderr: '', aggregated_output: MARKER } }),
    // The last command, in three shapes: the end event says it failed, the output item does not.
    fn('s4', 'exec_command', { cmd: `foo-cli run ${MARKER}` }),
    ev({ type: 'exec_command_end', call_id: 's4', command: ['bash', '-lc', `foo-cli run ${MARKER}`], exit_code: 127, stderr: 'sh: foo-cli: command not found', aggregated_output: '' }),
    output('s4', 'Process exited with code 0\nOutput:\n'),
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');

  const r = runScript('transcript-signals.mjs', ['--cwd', proj, '--days', '100000'], { env: homeEnv(home) });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(MARKER), 'marker leaked');
  const j = r.json;
  assert.equal(j.sources.codex.sessions, 1);
  // shell: s1..s3. exec_command: s4 under its recorded name, exec-1 known from its completion.
  // The MCP tool: m1 once for its three records, and m2. exec: the script tool itself.
  assert.deepEqual(j.toolCalls, { shell: 3, exec_command: 2, mcp__my_server__ping: 2, exec: 1 });
  assert.deepEqual(j.shellFailures, { 'npm test': 3, 'foo-cli': 1 });
  assert.deepEqual(j.commandNotFound, { 'foo-cli': 1 });
  assert.deepEqual(j.retries, [{ head: 'npm test', sessions: 1 }]);
  assert.equal(j.sessionsEndingOnError, 1);
  assert.deepEqual(j.topFailureSessions, [{ source: 'codex', id: SID, failures: 4 }]);
});
