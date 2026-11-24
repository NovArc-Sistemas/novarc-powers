// The waste rules that outside field testing corrected, end to end through session-impact.mjs:
// hook outcomes read from structured fields (a Stop hook that makes the agent continue is not
// waste), corrections that need work before them and are not questions or short answers, and
// retries that compare the whole command line, skip searches that find nothing and stop at an
// edit. The fixture is tests/fixtures/waste-rules.mjs; every turn is 100 tokens.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDir, rmrf, homeEnv, runScript } from './helpers.mjs';
import { buildWasteRules, MARKER } from './fixtures/waste-rules.mjs';

let home; let project; let res; let out; let w;

before(() => {
  home = tmpDir('hd-rules-home-');
  project = tmpDir('hd-rules-proj-');
  buildWasteRules(home, project);
  res = runScript('session-impact.mjs', ['--cwd', project, '--workers', '0'], { env: homeEnv(home) });
  out = res.json;
  w = out ? Object.fromEntries(out.waste.map((x) => [x.kind, x])) : {};
});

after(() => { rmrf(home); rmrf(project); });

test('runs and prints nothing from the transcripts', () => {
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!(res.stdout + res.stderr).includes(MARKER));
  assert.deepEqual(out.sources, { claude: 3, codex: 1 });
});

test('hook-block: only calls a hook denied before they ran, one per call', () => {
  // H0 (permissionDecision by a PreToolUse hook) and H3 (permissionDecision plus a
  // hook_blocking_error for the same call). Not H1 (the permission classifier, whose message
  // mentions a hook being blocked) nor H2 (a failed command whose output mentions a hook).
  assert.deepEqual([w['hook-block'].episodes, w['hook-block'].sessions, w['hook-block'].tokens, w['hook-block'].topHeads], [2, 1, 200, ['git push', 'npm publish']]);
  assert.match(w['hook-block'].method, /never read/);
});

test('hook outcomes that are not waste are counted apart', () => {
  const { method, ...counts } = out.hookOutcomes;
  assert.deepEqual(counts, {
    denials: { PreToolUse: 2 },
    continues: { Stop: 1 }, // the Stop hook that blocked the end of a response: the agent continued
    promptBlocks: 1, // UserPromptSubmit
    stopped: 1, // a stop_hook_summary with preventedContinuation
    otherBlocking: {},
    unknown: 1, // a hook_blocking_error that names no event
  });
  assert.ok(method.includes('None of these is waste'));
});

test('retry: the same whole command, failing, with no edit between', () => {
  // Only `cargo build --release` (4 failures in a row, Claude) and `make` (4 failures, Codex).
  // Not rg finding nothing 4 times (exit 1, Claude and Codex), not 4 different `node` commands,
  // not `npm test` / `pnpm build` / `pnpm test` with an Edit, a `sed -i` or an apply_patch
  // halfway (2 + 2 failures).
  assert.deepEqual([w.retry.episodes, w.retry.sessions, w.retry.tokens, w.retry.topHeads], [2, 2, 800, ['cargo build', 'make']]);
  assert.match(w.retry.method, /whole command line/);
  assert.match(w.retry.method, /rg, grep/);
});

test('notfound: consecutive failures of the same missing program', () => {
  // foo-cli twice with `ls` between: two episodes of one turn; bar-cli twice in a row: one of two.
  assert.deepEqual([w.notfound.episodes, w.notfound.tokens, w.notfound.topHeads], [3, 400, ['foo-cli', 'bar-cli']]);
});

test('correction: after work, not a question, not a short answer, with a marker', () => {
  // Claude: "não era isso, desfaz" (after Edit c2: 100) and "that's wrong, undo it" (after Edit
  // c5: 100). Codex: "isso está errado, reverte" covers turns 0..14, of which 10..13 are the make
  // retry: 11 turns = 1100. Not: "não precisa agora" (an answer, no work before it), "não dá pra
  // usar o X?" and "não dá pra usar o X" (questions), "no, not now" and "no, undo that too" and
  // "não, desfaz o resto" (short answers to a question just asked), "can't you use the X
  // helper?" (a question).
  assert.deepEqual([w.correction.episodes, w.correction.sessions, w.correction.tokens], [3, 2, 1300]);
});

test('nothing else is waste here', () => {
  assert.deepEqual([w.loop.episodes, w['error-end'].episodes, w.exploration.episodes], [0, 0, 0], 'every session ends on a success; no run of 5 identical calls; no reads before an edit');
});
