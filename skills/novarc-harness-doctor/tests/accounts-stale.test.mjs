// A plan signs what it was shown, content behind links included, and `apply` compares again right
// before each step writes. "Adopt into primary" must never copy bytes the user did not see.
// Every test runs against a fake home under os.tmpdir().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildHome, acc, rmrf, write, read, json, exists, isLink, snapshot, resolvesTo, planAndApply, CAN_SYMLINK,
} from './accounts-fixture.mjs';

const PRIMARY_KEYS = '{"bindings": []}\n'; // what the fixture's primary holds
const stamps = (h) => (exists(path.join(h.sync, 'backups')) ? fs.readdirSync(path.join(h.sync, 'backups')) : []);
/** The tree outside this tool's own workspace, for byte-identical comparisons. */
const harness = (h) => Object.fromEntries(Object.entries(snapshot(h.home)).filter(([k]) => !k.includes('.novarc-powers')));

/** Change a file's content without changing its size or its modification time. */
function rewriteQuietly(file, content) {
  const st = fs.statSync(file);
  assert.equal(Buffer.byteLength(content), st.size, 'the test needs content of the same length');
  fs.writeFileSync(file, content);
  fs.utimesSync(file, st.atime, st.mtime);
}

test('apply: content changed behind a file link after the plan is refused, and nothing is written', { skip: !CAN_SYMLINK && 'symbolic links cannot be created here' }, (t) => {
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  // The second account's key bindings are a link to a file kept elsewhere.
  const elsewhere = path.join(h.root, 'elsewhere', 'keys.json');
  write(elsewhere, '{"bindings": ["seen in the plan"]}\n');
  fs.symlinkSync(elsewhere, path.join(h.acc, 'keybindings.json'), 'file');
  const planFile = path.join(h.root, 'plan.json');
  const resolve = ['--resolve', 'claude-2:keybindings.json=adopt-into-primary'];
  const shown = acc(h.home, ['plan', '--primary', 'claude-1', '--out', planFile, ...resolve]).json;
  assert.match(shown.signatures['claude-2:keybindings.json'], /^[0-9a-f]{16}$/);
  assert.deepEqual(shown.actions.filter((a) => a.element === 'keybindings.json').map((a) => a.action), ['backup', 'copy', 'backup', 'link']);

  // The link is the same; what it leads to is not. Same size, same time.
  rewriteQuietly(elsewhere, '{"bindings": ["never seen, ever"]}\n');
  const again = acc(h.home, ['plan', '--primary', 'claude-1', ...resolve]).json;
  assert.equal(again.fingerprint, shown.fingerprint, 'the element states are the same');
  assert.notEqual(again.signatures['claude-2:keybindings.json'], shown.signatures['claude-2:keybindings.json'], 'the signature did not see the content behind the link');

  const before = harness(h);
  const r = acc(h.home, ['apply', '--plan', planFile, '--yes']);
  assert.equal(r.code, 1);
  assert.equal(r.json.refused, true);
  assert.match(r.json.error, /changed since this plan was made/);
  assert.deepEqual(r.json.changed, ['claude-2:keybindings.json']);
  assert.equal(read(path.join(h.claude, 'keybindings.json')), PRIMARY_KEYS, 'unseen bytes reached the primary');
  assert.deepEqual(harness(h), before, 'a refused apply wrote something');
  assert.deepEqual(stamps(h), []);

  // The plan made from what is there now is carried out.
  const fresh = planAndApply(h, 'claude-1', resolve);
  assert.equal(fresh.apply.code, 0, fresh.apply.stdout);
  assert.equal(read(path.join(h.claude, 'keybindings.json')), '{"bindings": ["never seen, ever"]}\n');
});

test('apply: content changed behind a folder link after the plan is refused, and nothing is written', (t) => {
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  // The second account's output styles are a link (a junction on Windows) to a folder elsewhere.
  const elsewhere = path.join(h.root, 'elsewhere', 'styles');
  write(path.join(elsewhere, 'terse.md'), 'Terse, as shown.\n');
  fs.rmSync(path.join(h.acc, 'output-styles'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(h.acc, 'output-styles'), 'junction');
  const planFile = path.join(h.root, 'plan.json');
  const resolve = ['--resolve', 'claude-2:output-styles/=adopt-into-primary'];
  const shown = acc(h.home, ['plan', '--primary', 'claude-1', '--out', planFile, ...resolve]).json;
  assert.equal(shown.conflicts.find((c) => c.element === 'output-styles/').choice, 'adopt-into-primary');

  rewriteQuietly(path.join(elsewhere, 'terse.md'), 'Terse, replaced.\n');
  const before = harness(h);
  const r = acc(h.home, ['apply', '--plan', planFile, '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.json.error, /changed since this plan was made/);
  assert.deepEqual(r.json.changed, ['claude-2:output-styles/']);
  assert.ok(!exists(path.join(h.claude, 'output-styles')), 'unseen content reached the primary');
  assert.deepEqual(harness(h), before, 'a refused apply wrote something');

  // A file added behind the link is a change too.
  assert.equal(acc(h.home, ['plan', '--primary', 'claude-1', '--out', planFile, ...resolve]).code, 0);
  write(path.join(elsewhere, 'added.md'), 'Added after the plan.\n');
  const added = acc(h.home, ['apply', '--plan', planFile, '--yes']);
  assert.equal(added.code, 1);
  assert.deepEqual(added.json.changed, ['claude-2:output-styles/']);
  assert.ok(!exists(path.join(h.claude, 'output-styles')));
});

test('apply: a step whose input changed while the plan was being applied is given up, the others run', (t) => {
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  // Two elements are adopted into the primary. The second one is a link INTO the folder the
  // first one changes, so what it leads to moves between the start of apply and its own turn.
  write(path.join(h.acc, 'agents', 'extra.md'), 'Only in the second account.\n');
  fs.rmSync(path.join(h.acc, 'output-styles'), { recursive: true });
  fs.symlinkSync(path.join(h.claude, 'agents'), path.join(h.acc, 'output-styles'), 'junction');
  const { plan, apply } = planAndApply(h, 'claude-1', ['--resolve', 'claude-2:agents/=adopt-into-primary', '--resolve', 'claude-2:output-styles/=adopt-into-primary']);
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(apply.code, 1, apply.stdout);
  assert.equal(apply.json.refused, undefined, 'the plan was current when apply started');
  assert.equal(apply.json.failed, 1);
  const done = (name) => apply.json.done.find((d) => d.account === 'claude-2' && d.element === name);
  assert.equal(done('agents/').result, 'done');
  assert.deepEqual(done('output-styles/'), {
    account: 'claude-2', element: 'output-styles/', result: 'failed', stale: true,
    error: 'output-styles/ changed after the plan was made (its content, or what a link leads to, is not what the plan showed); nothing was written for it: plan again',
  });
  // The first step was carried out.
  assert.equal(read(path.join(h.claude, 'agents', 'extra.md')), 'Only in the second account.\n');
  assert.ok(resolvesTo(path.join(h.acc, 'agents'), path.join(h.claude, 'agents')));
  // Nothing of the second: not in the primary, not moved to the backup, not recorded.
  assert.ok(!exists(path.join(h.claude, 'output-styles')));
  assert.ok(resolvesTo(path.join(h.acc, 'output-styles'), path.join(h.claude, 'agents')), 'the account\'s element was touched');
  assert.ok(!exists(path.join(h.sync, 'backups', apply.json.stamp, 'claude-2', 'output-styles')));
  const record = json(path.join(h.sync, 'manifest.json')).accounts.find((a) => a.id === 'claude-2');
  assert.ok(!record.elements.some((e) => e.name === 'output-styles/') && !record.exceptions.includes('output-styles/'));
});

test('apply: the same, with a file link whose target an earlier step rewrites', { skip: !CAN_SYMLINK && 'symbolic links cannot be created here' }, (t) => {
  const h = buildHome({ codex: false, agents: false });
  t.after(() => rmrf(h.root));
  write(path.join(h.acc, 'settings.json'), '{"model": "second"}\n');
  fs.symlinkSync(path.join(h.claude, 'settings.json'), path.join(h.acc, 'keybindings.json'), 'file');
  const { apply } = planAndApply(h, 'claude-1', ['--resolve', 'claude-2:settings.json=adopt-into-primary', '--resolve', 'claude-2:keybindings.json=adopt-into-primary']);
  assert.equal(apply.code, 1, apply.stdout);
  const done = (name) => apply.json.done.find((d) => d.account === 'claude-2' && d.element === name);
  assert.equal(done('settings.json').result, 'done');
  assert.deepEqual([done('keybindings.json').result, done('keybindings.json').stale], ['failed', true]);
  assert.equal(read(path.join(h.claude, 'settings.json')), '{"model": "second"}\n');
  // The plan showed the link leading to the primary's old settings; those bytes are gone, and
  // the new ones were never shown as key bindings: the primary's key bindings stay.
  assert.equal(read(path.join(h.claude, 'keybindings.json')), PRIMARY_KEYS);
  assert.ok(isLink(path.join(h.acc, 'keybindings.json')));
});
