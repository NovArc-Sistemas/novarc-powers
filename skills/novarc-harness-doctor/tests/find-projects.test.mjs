import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, rmrf, homeEnv, runScript, write, git, trySymlink } from './helpers.mjs';
import { encodeProjectPath } from '../scripts/lib/locations.mjs';
import { transcriptCwd, scanRoot } from '../scripts/find-projects.mjs';

// A string placed in every synthetic message. It must never reach stdout or stderr.
const MARKER = 'ZQXFINDMARKER4471';
const DAY = 86400000;
let fx;
let tmpRoot = null;

/** A real repository. Only one that gets worktrees needs a commit. */
function initRepo(dir, files = {}, { commit = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [rel, text] of Object.entries(files)) write(path.join(dir, rel), text);
  if (commit) {
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'init']);
  }
  return dir;
}

/** A Claude Code transcript: lines without a cwd first, then entries that carry it. */
function claudeTranscript(cwd, { fillerBytes = 0 } = {}) {
  const lines = [JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: MARKER })];
  if (fillerBytes) lines.push(JSON.stringify({ type: 'tools-used', tools: MARKER.repeat(Math.ceil(fillerBytes / MARKER.length)) }));
  lines.push(JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: `do it ${MARKER}` }, cwd, sessionId: 's' }));
  lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: MARKER }] }, cwd }));
  return `${lines.join('\n')}\n`;
}

function session(configDir, cwd, name, { ageDays = 0, folder = null, fillerBytes = 0 } = {}) {
  const file = path.join(configDir, 'projects', folder || encodeProjectPath(cwd), `${name}.jsonl`);
  write(file, claudeTranscript(cwd, { fillerBytes }));
  if (ageDays) { const t = new Date(Date.now() - ageDays * DAY); fs.utimesSync(file, t, t); }
  return file;
}

before(() => {
  const root = tmpDir('hd-find-');
  tmpRoot = root; // remembered apart from `fx`, so the folder is removed even when this hook fails
  const home = path.join(root, 'home');
  const claude = path.join(home, '.claude');
  const acc2 = path.join(home, '.hostapp', 'host', 'harness-accounts', 'claude-code', 'acc-2');
  const acc3 = path.join(home, '.hostapp', 'host', 'harness-accounts', 'claude-code', 'acc-3');
  const dev = path.join(home, 'dev');

  const projA = initRepo(path.join(dev, 'proj-a'), {
    'package.json': '{"name":"proj-a"}', 'CLAUDE.md': '# rules\n', '.mcp.json': '{"mcpServers":{}}', '.github/workflows/ci.yml': 'name: ci\non: push\n',
  }, { commit: true });
  fs.mkdirSync(path.join(projA, 'sub'));
  const wt1 = path.join(projA, '.claude', 'worktrees', 'wt-one');
  const wt2 = path.join(dev, 'outside-wt-two');
  git(projA, ['worktree', 'add', '-q', '-b', 'wt-one', wt1]);
  git(projA, ['worktree', 'add', '-q', '-b', 'wt-two', wt2]);
  const projB = initRepo(path.join(dev, 'proj-b'), { 'AGENTS.md': '# agents\n' });
  const projC = initRepo(path.join(dev, 'proj-c'), { 'CLAUDE.md': '# old but has rules\n' });
  const projD = initRepo(path.join(dev, 'proj-d'));
  const plain = path.join(dev, 'plain-folder');
  fs.mkdirSync(plain, { recursive: true });
  const deleted = path.join(dev, 'deleted-proj');

  // Default account.
  write(path.join(claude, 'settings.json'), '{}');
  session(claude, projA, 'a1');
  session(claude, projA, 'a2', { fillerBytes: 40000 }); // cwd sits past the first 16 KB
  session(claude, wt1, 'w1');
  session(claude, wt2, 'w2');
  session(claude, path.join(projA, '.claude', 'worktrees', 'removed-wt'), 'gone-wt'); // worktree deleted since
  session(claude, deleted, 'd1');
  session(claude, plain, 'p1');
  session(claude, projC, 'c-old', { ageDays: 90 });
  session(claude, projD, 'd-old', { ageDays: 90 });
  // The folder name is a lossy encoding and may say anything: only the recorded cwd counts.
  session(claude, projB, 'b-misnamed', { folder: 'zz-not-the-real-path' });
  // A subagent transcript is not a session.
  write(path.join(claude, 'projects', encodeProjectPath(projA), 'a1', 'subagents', 'agent-x.jsonl'), claudeTranscript(projA));

  // Second account with its own transcripts; third account whose projects/ links to the default one.
  write(path.join(acc2, 'settings.json'), '{}');
  session(acc2, projB, 'b2');
  session(acc2, projA, 'a-acc2');
  write(path.join(acc3, 'settings.json'), '{}');
  const linked = trySymlink(path.join(claude, 'projects'), path.join(acc3, 'projects'), 'junction');

  // Codex rollouts: one inside a subfolder of proj-a, one old one for proj-b.
  const cx = (cwd, extra = '') => `${JSON.stringify({ timestamp: '2026-01-05T10:00:00Z', type: 'session_meta', payload: { id: 'x', cwd, instructions: MARKER.repeat(400) } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: MARKER }] } })}\n${extra}`;
  const cdir = path.join(home, '.codex', 'sessions', '2026', '01', '05');
  write(path.join(cdir, 'rollout-2026-01-05T10-00-00-01a1aaaa-bbbb-7ccc-8ddd-eeeeffff0000.jsonl'), cx(path.join(projA, 'sub')));
  const oldRollout = path.join(cdir, 'rollout-2026-01-05T11-00-00-01a1aaaa-bbbb-7ccc-8ddd-eeeeffff0001.jsonl');
  write(oldRollout, cx(projB));
  const old = new Date(Date.now() - 200 * DAY);
  fs.utimesSync(oldRollout, old, old);

  // A tree to scan with --roots.
  const scan = path.join(home, 'scan');
  initRepo(path.join(scan, 'a', 'repo-near'), { 'CLAUDE.md': '# x\n' });
  initRepo(path.join(scan, 'a', 'b', 'c', 'd', 'repo-deep'), { 'AGENTS.md': '# x\n' });
  initRepo(path.join(scan, 'node_modules', 'vendored'), { 'CLAUDE.md': '# x\n' });
  initRepo(path.join(scan, 'no-harness'));

  // The ceiling keeps the repository search inside the fixture, whatever lies above the temp dir.
  fx = { root, home, claude, acc2, dev, projA, projB, projC, projD, plain, deleted, wt1, wt2, scan, linked, env: homeEnv(home, { GIT_CEILING_DIRECTORIES: root }) };
});

after(() => { if (tmpRoot) rmrf(tmpRoot); });

const runs = new Map();
/** Runs the script; the same arguments are run once (nothing in the fixture changes between tests). */
function run(args = []) {
  const key = args.join('\u0000');
  if (!runs.has(key)) runs.set(key, runScript('find-projects.mjs', args, { env: fx.env }));
  return runs.get(key);
}
const byName = (out, name) => out.projects.find((p) => p.name === name);
const slashes = (s) => s.replace(/\\/g, '/').toLowerCase();

test('transcriptCwd reads the cwd from the head of a transcript, wherever the field sits', () => {
  const dir = path.join(fx.root, 'unit');
  const near = path.join(dir, 'near.jsonl');
  const far = path.join(dir, 'far.jsonl');
  const none = path.join(dir, 'none.jsonl');
  const codex = path.join(dir, 'codex.jsonl');
  write(near, claudeTranscript(fx.projA));
  write(far, claudeTranscript(fx.projA, { fillerBytes: 120000 }));
  write(none, `${JSON.stringify({ type: 'summary', summary: MARKER })}\n`);
  write(codex, `${JSON.stringify({ type: 'session_meta', payload: { cwd: fx.projB, instructions: 'x'.repeat(300000) } })}\n`);
  assert.equal(transcriptCwd(near), fx.projA);
  assert.equal(transcriptCwd(far), fx.projA);
  assert.equal(transcriptCwd(none), null);
  assert.equal(transcriptCwd(codex), fx.projB, 'cwd is found although the first line is longer than what is read');
  assert.equal(transcriptCwd(path.join(dir, 'missing.jsonl')), null);
});

test('worktrees, subfolders, accounts and providers fold into one project per repository', () => {
  const r = run();
  assert.equal(r.code, 0, r.stderr);
  const a = byName(r.json, 'proj-a');
  assert.ok(a, 'proj-a is listed');
  assert.equal(r.json.projects.filter((p) => slashes(p.pathAbs).startsWith(slashes(fx.projA))).length, 1, 'no separate entry for a worktree inside the repo');
  assert.equal(byName(r.json, 'wt-one'), undefined);
  assert.equal(byName(r.json, 'outside-wt-two'), undefined);
  // main: a1, a2, a-acc2 (second account); worktrees: w1, w2, the deleted one; codex: 1 in a subfolder.
  assert.equal(a.sessions, 7);
  assert.equal(a.worktrees, 2);
  assert.deepEqual(a.providers, ['claude-code', 'codex']);
  assert.equal(a.isCode, true);
  for (const s of ['CLAUDE.md', '.claude/', '.mcp.json', '.github/workflows']) assert.ok(a.signals.includes(s), `signal ${s}`);
  assert.equal(a.suggested, true);
  assert.equal(a.path, '~/dev/proj-a');
  assert.equal(slashes(a.pathAbs), slashes(fx.projA));
  assert.ok(Date.now() - Date.parse(a.lastActive) < 10 * 60 * 1000, 'lastActive is the newest transcript');
});

test('the recorded cwd decides the project, not the name of the transcript folder', () => {
  const b = byName(run().json, 'proj-b');
  assert.ok(b);
  assert.equal(b.sessions, 2, 'one from the misnamed folder, one from the second account; the old rollout is outside the window');
  assert.deepEqual(b.providers, ['claude-code', 'codex']);
  assert.equal(b.isCode, false);
  assert.deepEqual(b.signals, ['AGENTS.md']);
});

test('a projects folder linked from another account is counted once', (t) => {
  if (!fx.linked) { t.skip('this OS refused the directory link'); return; }
  const out = run().json;
  assert.equal(out.scanned.configDirs, 3, 'all three accounts were seen');
  assert.equal(byName(out, 'proj-a').sessions, 7);
});

test('deleted projects and folders outside git are skipped with a reason', () => {
  const out = run().json;
  assert.equal(byName(out, 'deleted-proj'), undefined);
  assert.equal(byName(out, 'plain-folder'), undefined);
  const reason = (p) => (out.skipped.find((s) => s.path === p) || {}).reason;
  assert.equal(reason('~/dev/deleted-proj'), 'path no longer exists');
  assert.equal(reason('~/dev/plain-folder'), 'not a git repository');
});

test('the window filters sessions by file time; harness files keep an idle project listed', () => {
  const out = run().json; // the default window is 30 days
  assert.equal(out.windowDays, 30);
  const c = byName(out, 'proj-c');
  assert.ok(c, 'idle but has CLAUDE.md');
  assert.equal(c.sessions, 0);
  assert.deepEqual(c.providers, ['claude-code']);
  assert.ok(Date.now() - Date.parse(c.lastActive) > 80 * DAY, 'lastActive still says when it was last used');
  assert.equal(byName(out, 'proj-d'), undefined);
  assert.equal(out.skipped.find((s) => s.path === '~/dev/proj-d').reason, 'no activity in window and no harness files');

  const wide = run(['--days', '365']).json;
  assert.equal(byName(wide, 'proj-c').sessions, 1);
  assert.equal(byName(wide, 'proj-d').sessions, 1);
  assert.equal(byName(wide, 'proj-b').sessions, 3, 'the 200-day-old rollout is inside a 365-day window');
});

test('projects are sorted by sessions, most first', () => {
  const out = run().json;
  const counts = out.projects.map((p) => p.sessions);
  assert.deepEqual(counts, [...counts].sort((x, y) => y - x));
  assert.equal(out.projects[0].name, 'proj-a');
  assert.equal(out.projects[1].name, 'proj-b');
});

test('--roots finds repositories down to --max-depth and skips dependency folders', () => {
  assert.deepEqual(scanRoot(fx.scan, 3).map((p) => path.basename(p)).sort(), ['no-harness', 'repo-near']);
  assert.deepEqual(scanRoot(fx.scan, 5).map((p) => path.basename(p)).sort(), ['no-harness', 'repo-deep', 'repo-near']);

  const shallow = run(['--roots', fx.scan, '--max-depth', '3']).json;
  const near = byName(shallow, 'repo-near');
  assert.ok(near);
  assert.equal(near.sessions, 0);
  assert.equal(near.lastActive, null);
  assert.deepEqual(near.providers, []);
  assert.equal(near.suggested, true, 'it has a CLAUDE.md');
  assert.equal(byName(shallow, 'repo-deep'), undefined);
  assert.equal(byName(shallow, 'vendored'), undefined);
  assert.equal(byName(shallow, 'no-harness'), undefined);
  assert.equal(shallow.skipped.find((s) => s.path === '~/scan/no-harness').reason, 'no activity in window and no harness files');

  const deep = run(['--roots', fx.scan, '--max-depth', '5']).json;
  assert.ok(byName(deep, 'repo-deep'));
  assert.equal(byName(deep, 'vendored'), undefined);
});

test('--config-dirs limits the Claude accounts that are read', () => {
  const out = run(['--config-dirs', fx.acc2]).json;
  assert.equal(byName(out, 'proj-b').sessions, 1);
  const a = byName(out, 'proj-a');
  assert.equal(a.sessions, 2, 'one transcript of that account plus the Codex rollout');
});

test('no absolute path outside pathAbs, and no transcript text anywhere', () => {
  const r = run(['--roots', fx.scan]);
  const stripped = JSON.stringify({ ...r.json, projects: r.json.projects.map(({ pathAbs, ...rest }) => { assert.ok(path.isAbsolute(pathAbs)); return rest; }) });
  for (const text of [stripped, r.stderr]) {
    // Once as printed, once with JSON's doubled backslashes folded back.
    for (const t of [text, text.replace(/\\\\/g, '\\')]) assert.ok(!slashes(t).includes(slashes(fx.root)), 'an absolute path leaked');
  }
  assert.ok(!r.stdout.includes(MARKER) && !r.stderr.includes(MARKER), 'transcript text leaked');
  for (const p of r.json.projects) assert.ok(p.path.startsWith('~/'), 'display paths start at ~');
  for (const s of r.json.skipped) assert.ok(s.path.startsWith('~'), 'skipped paths are display paths');
});

test('bad arguments exit 2', () => {
  assert.equal(run(['--days', '0']).code, 2);
  assert.equal(run(['--max-depth', 'x']).code, 2);
  assert.equal(run(['--roots']).code, 2);
  assert.equal(run(['--roots', path.join(fx.root, 'does-not-exist')]).code, 2);
});
