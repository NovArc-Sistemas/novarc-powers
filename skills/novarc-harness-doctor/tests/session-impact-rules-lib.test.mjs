// The pieces of the waste rules in lib/transcripts.mjs, one by one: hook outcomes from structured
// fields, the command comparison, no-match exits, file writes and retry runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hookDenialOf, hookOutcomeOf, normalizeCommand, noMatchExit, claudeExitCode, writesFiles, retryRuns,
} from '../scripts/lib/transcripts.mjs';

test('hook denials come from a hook\'s permissionDecision, never from text', () => {
  const pd = (permissionDecision) => ({ type: 'user', permissionDecision });
  assert.equal(hookDenialOf(pd({ decision: 'reject', source: 'hook', reasonType: 'hook', reasonCode: 'hook:PreToolUse' })), 'PreToolUse');
  assert.equal(hookDenialOf(pd({ decision: 'reject', source: 'hook', reasonType: 'hook', reasonCode: 'hook:PermissionRequest' })), 'PermissionRequest');
  assert.equal(hookDenialOf(pd({ decision: 'reject', source: 'hook', reasonType: 'hook' })), 'PreToolUse', 'a permission decision is always made before the call runs');
  assert.equal(hookDenialOf(pd({ decision: 'reject', source: 'config', reasonType: 'classifier', reasonCode: 'classifier:auto-mode' })), null, 'the permission classifier is not a hook');
  assert.equal(hookDenialOf(pd({ decision: 'reject', source: 'user_reject', reasonCode: 'bashMiss:no-rule-match' })), null, 'the person said no');
  assert.equal(hookDenialOf(pd({ decision: 'accept', source: 'hook', reasonType: 'hook' })), null);
  assert.equal(hookDenialOf({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'PreToolUse:Bash hook error: blocked' }] } }), null, 'text is never read');
});

test('hook_blocking_error is classified by its event', () => {
  const att = (a) => ({ type: 'attachment', attachment: { type: 'hook_blocking_error', toolUseID: 't1', ...a } });
  assert.deepEqual(hookOutcomeOf(att({ hookEvent: 'PreToolUse', hookName: 'PreToolUse:Bash' })), { outcome: 'denial', event: 'PreToolUse', toolUseId: 't1' });
  assert.deepEqual(hookOutcomeOf(att({ hookName: 'PermissionRequest:Bash' })), { outcome: 'denial', event: 'PermissionRequest', toolUseId: 't1' }, 'the event part of hookName when hookEvent is missing');
  assert.deepEqual(hookOutcomeOf(att({ hookEvent: 'Stop', hookName: 'Stop' })), { outcome: 'continue', event: 'Stop', toolUseId: 't1' });
  assert.deepEqual(hookOutcomeOf(att({ hookEvent: 'SubagentStop' })), { outcome: 'continue', event: 'SubagentStop', toolUseId: 't1' });
  assert.deepEqual(hookOutcomeOf(att({ hookEvent: 'UserPromptSubmit' })), { outcome: 'prompt-block', event: 'UserPromptSubmit', toolUseId: 't1' });
  assert.deepEqual(hookOutcomeOf(att({ hookEvent: 'PostToolUse' })), { outcome: 'other', event: 'PostToolUse', toolUseId: 't1' });
  assert.deepEqual(hookOutcomeOf(att({ hookName: 'x' })), { outcome: 'unknown', event: null, toolUseId: 't1' });
  assert.equal(hookOutcomeOf({ type: 'attachment', attachment: { type: 'hook_non_blocking_error', hookEvent: 'PreToolUse' } }), null);
  assert.equal(hookOutcomeOf({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'Stop' } }), null);
  assert.equal(hookOutcomeOf({ type: 'attachment', attachment: { type: 'hook_cancelled', hookEvent: 'PreToolUse' } }), null);
  assert.deepEqual(hookOutcomeOf({ type: 'system', subtype: 'stop_hook_summary', preventedContinuation: true }), { outcome: 'stopped', event: 'Stop', toolUseId: null });
  assert.equal(hookOutcomeOf({ type: 'system', subtype: 'stop_hook_summary', preventedContinuation: false }), null);
});

test('commands compare on the whole line, whitespace collapsed', () => {
  assert.equal(normalizeCommand('  npm   test\n'), 'npm test');
  assert.notEqual(normalizeCommand('gh pr view 1'), normalizeCommand('gh pr view 2'));
  assert.equal(normalizeCommand(''), null);
  assert.equal(normalizeCommand(null), null);
});

test('exit 1 of a search or a test is "nothing found", judged on the last segment', () => {
  for (const c of ['rg foo', 'grep -r foo .', 'egrep x f', 'ag foo', 'ack foo', 'findstr /s foo *.txt', 'Select-String -Pattern x a.txt', 'git grep foo', 'git diff --exit-code', 'diff a b', 'cmp a b', 'test -f x', '[ -f x ]', 'cat a.txt | grep foo', 'cd src && rg "a|b"']) {
    assert.equal(noMatchExit(c, 1), true, c);
  }
  assert.equal(noMatchExit('rg foo', 2), false, 'exit 2 is an error');
  assert.equal(noMatchExit('rg foo', null), false, 'no exit status read');
  assert.equal(noMatchExit('rg foo | wc -l', 1), false, 'the status is the last program\'s');
  assert.equal(noMatchExit('npm test', 1), false);
  assert.equal(noMatchExit('grep foo a; npm test', 1), false);
  assert.equal(claudeExitCode('Exit code 1\nmore'), 1);
  assert.equal(claudeExitCode('Error: Exit code 127'), 127);
  assert.equal(claudeExitCode('the Exit code 1 is mentioned later'), null);
});

test('shell commands that write files are recognised, reads are not', () => {
  for (const c of ['echo x > a.txt', 'cat <<EOF >> notes.md', "sed -i 's/a/b/' f", 'perl -pi -e s/a/b/ f', 'mv a b', 'cp a b', 'rm -f a', 'git checkout -- a', 'git apply p.diff', 'Set-Content a.txt x', 'apply_patch <<EOF', 'npm test && tee out.log']) {
    assert.equal(writesFiles(c), true, c);
  }
  for (const c of ['npm test 2>&1', 'rg foo > /dev/null', 'node a.js 2>/dev/null', 'rg "a > b"', 'ls -la', 'git status', 'Get-ChildItem > $null', 'cmd > NUL']) {
    assert.equal(writesFiles(c), false, c);
  }
});

test('retry runs: the same command, 3 reruns, no edit between', () => {
  const F = (cmd) => ({ shell: true, cmd, failed: true, edit: false });
  const OK = (cmd) => ({ shell: true, cmd, failed: false, edit: false });
  const E = { shell: false, cmd: null, failed: false, edit: true };
  const R = { shell: false, cmd: null, failed: false, edit: false }; // a read: no effect
  assert.deepEqual(retryRuns([F('a'), F('a'), F('a'), F('a')]), [{ cmd: 'a', first: 0, last: 3 }]);
  assert.deepEqual(retryRuns([F('a'), F('a'), F('a'), OK('a')]), [{ cmd: 'a', first: 0, last: 3 }], 'the success that resolves it is part of the run');
  assert.deepEqual(retryRuns([F('a'), F('a'), F('a')]), [], 'two reruns are not enough');
  assert.deepEqual(retryRuns([F('a'), F('b'), F('c'), F('d')]), []);
  assert.deepEqual(retryRuns([F('a'), F('a'), E, F('a'), F('a')]), [], 'fix and rerun');
  assert.deepEqual(retryRuns([F('a'), R, F('a'), OK('x'), F('a'), F('a')]), [{ cmd: 'a', first: 0, last: 5 }], 'reads and other commands do not end it');
  assert.deepEqual(retryRuns([F('a'), F('a'), { shell: true, cmd: 'w', failed: false, edit: true }, F('a'), F('a')]), [], 'a shell command that writes is an edit');
  assert.deepEqual(retryRuns([{ shell: true, cmd: 'w', failed: true, edit: true }, { shell: true, cmd: 'w', failed: true, edit: true }, { shell: true, cmd: 'w', failed: true, edit: true }, { shell: true, cmd: 'w', failed: true, edit: true }]), [{ cmd: 'w', first: 0, last: 3 }], 'a writing command does not end its own chain');
});
