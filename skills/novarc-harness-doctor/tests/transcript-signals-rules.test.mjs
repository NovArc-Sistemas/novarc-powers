// transcript-signals.mjs follows the same corrected rules as session-impact.mjs: hook blocks from
// structured fields only, retries of the same whole command with no edit between, searches that
// find nothing are not failures, and corrections need work before them. Same fixture as
// session-impact-waste-rules.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDir, rmrf, homeEnv, runScript } from './helpers.mjs';
import { buildWasteRules, MARKER } from './fixtures/waste-rules.mjs';

let home; let project; let res; let j;

before(() => {
  home = tmpDir('hd-signals-rules-home-');
  project = tmpDir('hd-signals-rules-proj-');
  buildWasteRules(home, project);
  res = runScript('transcript-signals.mjs', ['--cwd', project, '--days', '7'], { env: homeEnv(home) });
  j = res.json;
});

after(() => { rmrf(home); rmrf(project); });

test('runs and prints nothing from the transcripts', () => {
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!(res.stdout + res.stderr).includes(MARKER));
  assert.equal(j.sessions, 4);
});

test('hook blocks: denied calls only, one per call', () => {
  assert.equal(j.hookBlocks, 2, 'not the classifier refusal, not a result that mentions a hook, not the Stop hook continuing');
});

test('retries: the same whole command failing again and again with no edit between', () => {
  assert.deepEqual(j.retries, [{ head: 'cargo build', sessions: 1 }, { head: 'make', sessions: 1 }]);
});

test('a search that finds nothing is not a failure', () => {
  assert.equal(j.shellFailures.rg, undefined);
  assert.equal(j.shellFailures.node, 4);
  assert.equal(j.shellFailures['npm test'], 4);
  assert.equal(j.shellFailures['pnpm test'], 4);
  assert.equal(j.shellFailures.make, 4);
  assert.equal(j.sessionsEndingOnError, 0);
});

test('corrections: after work, not questions, not short answers', () => {
  assert.equal(j.userMessages, 15);
  assert.equal(j.userCorrections, 3, '"não era isso, desfaz", "that\'s wrong, undo it", "isso está errado, reverte"');
});
