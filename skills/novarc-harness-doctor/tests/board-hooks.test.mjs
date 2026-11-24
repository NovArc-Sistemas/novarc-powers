// The hook lifecycle the board draws (HOOK_EVENTS in scripts/render-board.mjs) against the table
// the snapshot uses to decide whether a hook can block (lib/snapshot/elements.mjs, after the Claude
// Code hooks reference; see references/checks.md). The two are written apart, so this file makes
// them agree both ways: every event of that table is drawn once, and every slot says "can block"
// exactly when that table says a hook there can stop its action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR } from './helpers.mjs';
import { HOOK_EVENTS } from '../scripts/render-board.mjs';
import { hookBlocking } from '../scripts/lib/snapshot/elements.mjs';
import { STRINGS } from '../scripts/lib/i18n.mjs';

const SOURCE = fs.readFileSync(path.join(SKILL_DIR, 'scripts', 'lib', 'snapshot', 'elements.mjs'), 'utf8');

/** The keys of `BLOCKING_EVENTS`, and the entries of the sets `NEVER_BLOCK_EVENTS` and `ON_FAILURE_IGNORED`, read from the source. */
function verifiedTable() {
  const block = /const BLOCKING_EVENTS = \{([\s\S]*?)\n\};/.exec(SOURCE)[1].replace(/\/\/.*$/gm, '');
  const blocking = [...block.matchAll(/(?:^|[\s,{])([A-Z][A-Za-z]+):/g)].map((m) => m[1]);
  const setOf = (name) => {
    const body = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(SOURCE)[1];
    return [...body.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
  };
  return { blocking, never: setOf('NEVER_BLOCK_EVENTS'), keeps: setOf('ON_FAILURE_IGNORED') };
}

/** A command hook whose code shows every way an event can block: a decision in each field, and exit 2. */
const PROBE = 'echo \'{"decision":"block","permissionDecision":"deny","behavior":"deny","action":"decline","continue":false}\'; exit 2';

test('every event of the verified table is one slot of the lifecycle, and nothing else is', () => {
  const { blocking, never } = verifiedTable();
  assert.ok(blocking.length >= 15 && never.length >= 15, 'the table was read');
  // StatusLine is the snapshot's own name for the status line command: not an agent moment.
  const table = [...blocking, ...never.filter((e) => e !== 'StatusLine')].sort();
  const drawn = HOOK_EVENTS.map((e) => e.event);
  assert.equal(new Set(drawn).size, drawn.length, 'no event twice');
  assert.deepEqual([...drawn].sort(), table);
  // The slots drawn in full even when empty.
  assert.deepEqual(HOOK_EVENTS.filter((e) => e.core).map((e) => e.event), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
    'PostToolUseFailure', 'SubagentStop', 'Notification', 'PreCompact', 'Stop', 'SessionEnd']);
  // Phases follow one another: the events of one phase are never split by another one.
  const phases = HOOK_EVENTS.map((e) => e.phase).filter((p, i, a) => i === 0 || a[i - 1] !== p);
  assert.deepEqual(phases, ['start', 'prompt', 'tool', 'agents', 'env', 'context', 'end']);
});

test('"can block" is what hookBlocking says for a hook there that shows every way to block', () => {
  const { keeps } = verifiedTable();
  for (const ev of HOOK_EVENTS) {
    const answer = hookBlocking({ source: 'agent', event: ev.event, type: 'command', command: PROBE });
    assert.notEqual(answer, null, `${ev.event} is in the table`);
    assert.equal(ev.canBlock, answer, ev.event);
    // A background hook decides nothing, wherever it sits.
    assert.equal(hookBlocking({ source: 'agent', event: ev.event, type: 'command', command: PROBE, async: true }), false, `${ev.event} async`);
  }
  // Where a block means "keep working" (Stop and the like), the slot says so.
  assert.deepEqual(HOOK_EVENTS.filter((e) => e.keeps).map((e) => e.event).sort(), [...keeps].sort());
  assert.ok(HOOK_EVENTS.filter((e) => e.keeps).every((e) => e.canBlock));
});

test('every slot teaches in both languages: what happens there, and for the main ones what a hook is good for', () => {
  for (const lang of ['en', 'pt']) {
    const T = STRINGS[lang].hk;
    for (const phase of new Set(HOOK_EVENTS.map((e) => e.phase))) assert.ok(T.phase[phase], `${lang} phase ${phase}`);
    for (const ev of HOOK_EVENTS) {
      const text = T.ev[ev.event];
      assert.ok(text && text.what, `${lang} ${ev.event}`);
      if (ev.core) assert.ok(text.use && text.idea, `${lang} ${ev.event} use and idea`);
      for (const s of Object.values(text)) assert.ok(!/[–—]|\p{Extended_Pictographic}/u.test(s), `${lang} ${ev.event}: no dash or emoji`);
    }
    assert.deepEqual(Object.keys(T.ev).sort(), HOOK_EVENTS.map((e) => e.event).sort(), `${lang}: no text for an event the lifecycle does not draw`);
  }
});
