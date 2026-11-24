// Synthetic transcripts for the waste rules that outside field testing corrected: hook outcomes,
// corrections and retries. The record shapes are the ones Claude Code and Codex write (keys and
// type values read from real transcripts; every text here is made up). Every model turn is 100
// tokens, so an episode's tokens are 100 x its turns.
import path from 'node:path';
import { write } from '../helpers.mjs';
import { encodeProjectPath } from '../../scripts/lib/locations.mjs';

export const MARKER = 'ZQXRULES4417'; // must never reach stdout or stderr
export const SID_HOOKS = '11111111-1111-4111-8111-111111111111';
export const SID_RETRY = '22222222-2222-4222-8222-222222222222';
export const SID_CORR = '33333333-3333-4333-8333-333333333333';
export const SID_CODEX = '44444444-4444-4444-8444-444444444444';

/** Write the fixture under `home` for `project`. Returns nothing; the numbers are in the tests. */
export function buildWasteRules(home, project) {
  const now = new Date();
  const BASE = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2, 12);
  let clock = 0;
  const ts = () => new Date(BASE + (clock++) * 1000).toISOString();
  let n = 0;
  const U100 = { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 };
  const asst = (blocks) => ({ parentUuid: null, isSidechain: false, type: 'assistant', timestamp: ts(), message: { model: 'claude-test-a', id: `msg_${n++}`, type: 'message', role: 'assistant', content: blocks, usage: U100 } });
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const bash = (id, command) => asst([use(id, 'Bash', { command, description: `run ${MARKER}` })]);
  const edit = (id) => asst([use(id, 'Edit', { file_path: 'src/app.js', old_string: 'a', new_string: `${id} ${MARKER}` })]); // distinct edits, never a loop
  const text = (t) => ({ type: 'text', text: t });
  const result = (id, content, isError = false, extra = {}) => ({ parentUuid: null, isSidechain: false, type: 'user', timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, toolUseResult: isError ? `Error: ${content}` : { stdout: '', stderr: '' }, ...extra });
  const say = (t) => ({ parentUuid: null, isSidechain: false, type: 'user', timestamp: ts(), message: { role: 'user', content: t } });
  const hookAttachment = (attachment) => ({ parentUuid: null, isSidechain: false, type: 'attachment', timestamp: ts(), attachment });
  const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const pdir = path.join(home, '.claude', 'projects', encodeProjectPath(project));
  const hookDenial = { toolDenialKind: 'permission-rule', permissionDecision: { decision: 'reject', source: 'hook', reasonType: 'hook', reasonCode: 'hook:PreToolUse' } };

  // Hooks. H0 denied by a PreToolUse hook (permissionDecision); H1 refused by the permission
  // classifier, whose message mentions a hook and a block; H2 fails with a text that mentions a
  // hook blocking something (documentation read in the terminal); H3 denied, recorded both as a
  // permissionDecision and as a hook_blocking_error for the same call (one denial); H4 answers,
  // and the Stop hook then blocks the end of the response (the agent continues: not waste).
  write(path.join(pdir, `${SID_HOOKS}.jsonl`), jsonl([
    say(`publish the release ${MARKER}`),
    bash('h0', `git push --force origin main ${MARKER}`),
    result('h0', `PreToolUse:Bash hook error: [node guard.js]: force push is not allowed ${MARKER}`, true, hookDenial),
    bash('h1', `rm -rf dist ${MARKER}`),
    result('h1', `Permission for this action was denied by the auto mode classifier; no hook allowed it, so it is blocked ${MARKER}`, true, { toolDenialKind: 'automode-blocked', permissionDecision: { decision: 'reject', source: 'config', reasonType: 'classifier', reasonCode: 'classifier:auto-mode' } }),
    bash('h2', `cat docs/hooks.md ${MARKER}`),
    result('h2', `Exit code 2\nA PreToolUse hook blocked the call and denied it ${MARKER}`, true),
    bash('h3', `npm publish ${MARKER}`),
    hookAttachment({ type: 'hook_blocking_error', hookName: 'PreToolUse:Bash', toolUseID: 'h3', hookEvent: 'PreToolUse', blockingError: { blockingError: `no publishing ${MARKER}`, command: 'node guard.js' } }),
    result('h3', `PreToolUse:Bash hook error: no publishing ${MARKER}`, true, hookDenial),
    asst([text(`Release notes are ready ${MARKER}`)]),
    hookAttachment({ type: 'hook_blocking_error', hookName: 'Stop', toolUseID: 'stop-1', hookEvent: 'Stop', blockingError: { blockingError: `run the checklist first ${MARKER}`, command: 'node stop.js' } }),
    { parentUuid: null, isSidechain: false, type: 'system', subtype: 'stop_hook_summary', hookCount: 1, hookInfos: [{ command: 'node stop.js', durationMs: 5 }], hookErrors: [], preventedContinuation: false, stopReason: '', hasOutput: true, level: 'suggestion', timestamp: ts(), toolUseID: 'stop-1' },
    bash('h5', 'git status'),
    result('h5', 'clean'),
    say(`and the tag ${MARKER}`),
    hookAttachment({ type: 'hook_blocking_error', hookName: 'UserPromptSubmit', toolUseID: 'ups-1', hookEvent: 'UserPromptSubmit', blockingError: { blockingError: MARKER, command: 'node prompt.js' } }),
    asst([text(`Tagging ${MARKER}`)]),
    hookAttachment({ type: 'hook_blocking_error', hookName: 'x', content: MARKER }), // no event: unknown
    { parentUuid: null, isSidechain: false, type: 'system', subtype: 'stop_hook_summary', hookCount: 1, hookInfos: [{ command: 'node stop.js' }], hookErrors: [], preventedContinuation: true, stopReason: MARKER, hasOutput: true, level: 'suggestion', timestamp: ts(), toolUseID: 'stop-2' },
  ]));

  // Retries. rg finding nothing (exit 1) four times; four different `node` commands failing; the
  // same `npm test` failing twice, an Edit, twice again; the same `pnpm build` failing twice, a
  // `sed -i` that writes a file, twice again; the same `cargo build` failing four times with
  // nothing between (the only retry). Then missing commands: foo-cli twice with `ls` between,
  // bar-cli twice in a row. It ends on a success.
  const R = [say(`fix the build ${MARKER}`)];
  for (let k = 0; k < 4; k++) R.push(bash(`rg${k}`, `rg -n "missingSymbol${MARKER}" src`), result(`rg${k}`, 'Exit code 1', true));
  ['build.js', 'test.js', 'lint.js', 'scripts/check.js'].forEach((f, k) => R.push(bash(`nd${k}`, `node ${f} ${MARKER}`), result(`nd${k}`, `Exit code 1\nError ${MARKER}`, true)));
  const fail = (id, cmd) => [bash(id, cmd), result(id, `Exit code 1\nFAIL ${MARKER}`, true)];
  R.push(...fail('nt0', 'npm test'), ...fail('nt1', 'npm  test'), edit('ed0'), result('ed0', 'ok'), ...fail('nt2', 'npm test'), ...fail('nt3', 'npm test'));
  R.push(...fail('pb0', 'pnpm build'), ...fail('pb1', 'pnpm build'), bash('sd0', `sed -i 's/a/b/' src/app.js`), result('sd0', ''), ...fail('pb2', 'pnpm build'), ...fail('pb3', 'pnpm build'));
  for (let k = 0; k < 4; k++) R.push(...fail(`cb${k}`, `cargo build --release ${MARKER}`));
  R.push(bash('nf0', `foo-cli build ${MARKER}`), result('nf0', 'bash: foo-cli: command not found', true));
  R.push(bash('ls0', 'ls'), result('ls0', 'a.txt'));
  R.push(bash('nf1', 'foo-cli --help'), result('nf1', 'bash: foo-cli: command not found', true));
  R.push(bash('nf2', 'bar-cli a'), result('nf2', 'bar-cli: command not found', true));
  R.push(bash('nf3', 'bar-cli b'), result('nf3', 'bar-cli: command not found', true));
  R.push(bash('ok0', 'git status'), result('ok0', 'clean'));
  write(path.join(pdir, `${SID_RETRY}.jsonl`), jsonl(R));

  // Corrections, Portuguese and English. Only "não era isso, desfaz" and "that's wrong, undo it"
  // are corrections: each follows an Edit and the assistant asked nothing.
  write(path.join(pdir, `${SID_CORR}.jsonl`), jsonl([
    say(`faz a feature ${MARKER}`),
    asst([text(`Posso seguir de dois jeitos. Prefere A ou B? ${MARKER}`)]),
    say('não precisa agora'), // an answer, and no work since the last message
    edit('c0'), result('c0', 'ok'),
    say(`não dá pra usar o X? ${MARKER}`), // a question
    edit('c1'), result('c1', 'ok'),
    say(`não dá pra usar o X ${MARKER}`), // a question form without the mark
    edit('c2'), result('c2', 'ok'),
    say(`não era isso, desfaz ${MARKER}`), // correction: it follows the Edit c2
    edit('c3'), result('c3', 'ok'),
    asst([text(`Done. Should I keep the old flag? ${MARKER}`)]),
    say('no, not now'), // a short answer to the question
    edit('c4'), result('c4', 'ok'),
    say(`can't you use the X helper? ${MARKER}`), // a question
    edit('c5'), result('c5', 'ok'),
    say(`that's wrong, undo it ${MARKER}`), // correction
    edit('c6'), asst([text(`Reverted. Want me to run the tests? ${MARKER}`)]), result('c6', 'ok'),
    say('no, undo that too'), // a short answer to the question just asked
    asst([text(`Ok ${MARKER}`)]),
  ]));

  // Codex: `rg` finding nothing (exit 1) four times; `pnpm test` failing twice, an apply_patch,
  // twice again; `make` failing four times (a retry). Then a correction after work, and a short
  // answer to a question the agent asked. One model call per command.
  const cx = [];
  let tot = 0;
  const tokens = () => { tot += 1; return { timestamp: ts(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 60 * tot, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 40 * tot, total_tokens: 100 * tot } } } }; };
  const cmd = (id, command, exitCode) => ({ timestamp: ts(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id, command: ['bash', '-lc', command], exit_code: exitCode, status: exitCode ? 'failed' : 'completed', stderr: '', aggregated_output: exitCode ? `failed ${MARKER}` : '' } } });
  cx.push({ timestamp: ts(), type: 'session_meta', payload: { id: SID_CODEX, cwd: project } });
  cx.push({ timestamp: ts(), type: 'turn_context', payload: { cwd: project, model: 'codex-test' } });
  cx.push({ timestamp: ts(), type: 'event_msg', payload: { type: 'user_message', message: `fix the tests ${MARKER}` } });
  for (let k = 0; k < 4; k++) cx.push(tokens(), cmd(`xr${k}`, `rg -n "nothing${MARKER}" src`, 1));
  cx.push(tokens(), cmd('xt0', 'pnpm test', 1), tokens(), cmd('xt1', 'pnpm test', 1));
  cx.push(tokens(), { timestamp: ts(), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'xp0', input: `*** Begin Patch ${MARKER}` } });
  cx.push(tokens(), cmd('xt2', 'pnpm test', 1), tokens(), cmd('xt3', 'pnpm test', 1));
  for (let k = 0; k < 4; k++) cx.push(tokens(), cmd(`xm${k}`, 'make', 2));
  cx.push(tokens(), cmd('xok', 'git status', 0), tokens());
  cx.push({ timestamp: ts(), type: 'event_msg', payload: { type: 'user_message', message: `isso está errado, reverte ${MARKER}` } }); // correction
  cx.push({ timestamp: ts(), type: 'event_msg', payload: { type: 'agent_message', message: `Revertido. Quer que eu rode os testes? ${MARKER}` } });
  cx.push(tokens());
  cx.push({ timestamp: ts(), type: 'event_msg', payload: { type: 'user_message', message: 'não, desfaz o resto' } }); // short answer
  cx.push(tokens());
  write(path.join(home, '.codex', 'sessions', '2026', '11', '20', `rollout-2026-11-20T12-00-00-${SID_CODEX}.jsonl`), jsonl(cx));
}
