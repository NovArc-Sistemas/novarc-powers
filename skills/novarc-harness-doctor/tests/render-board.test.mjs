import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, tmpDir, rmrf, runScript } from './helpers.mjs';
import { floor1, gradeFor, scoreScope, roundBreakdown, validateState, SCHEMA_PATH } from '../scripts/render-board.mjs';

function stageFixture(mutate) {
  const dir = tmpDir('hd-render-');
  const state = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'state.fixture.json'), 'utf8'));
  if (mutate) mutate(state);
  const p = path.join(dir, 'state.json');
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
  return { dir, p };
}

/** A small in-memory project scope: `done` lists the rounds that count; items default to round 1, open, active. */
function mini(items, done = [1]) {
  return {
    scopes: ['project'],
    rounds: done.map((round) => ({ round, scope: 'project', status: 'done' })),
    items: items.map((it, k) => ({ id: `X-${k + 1}`, scope: 'project', round: 1, status: 'open', class: 'none', ...it })),
  };
}

test('scores match the hand-computed values for the fixture', () => {
  const { dir, p } = stageFixture();
  try {
    const r = runScript('render-board.mjs', [p]);
    assert.equal(r.code, 0, r.stderr);
    const s = JSON.parse(fs.readFileSync(p, 'utf8')).scores;
    /*
      Weights: r1 20, r2 15, r3 10, r4 15, r5 5, r6 15, r7 10, r8 10.
      Points: critical 25, high 15, medium 5, low 2. Status factor: open/queued/failed/in-progress 1,
      accepted .5, fixed/ok/wontfix 0. Every fixture item is active (origin weight 1, no file cap).
      Round score = max(0, 100 - deductions). Scope = sum(weight * round score) / sum(weight) over `done` rounds.

      USER: done rounds 1 and 2 (3 not-applicable, 4 skipped, 5-8 pending) -> weight 35.
        current  r1: U-1 critical open (secret) 25 + U-2 low fixed 0 = 25 -> 75
                 r2: U-3 high accepted 7.5 + U-4 medium queued 5 + U-5 low in-progress 2 = 14.5 -> 85.5
                 (U-6 is in skipped round 4 -> excluded)
                 (20 * 75 + 15 * 85.5) / 35 = (1500 + 1282.5) / 35 = 2782.5 / 35 = 79.5 -> grade B
        baseline r1: 25 + 2 = 27 -> 73 ; r2: 15 + 5 + 2 = 22 -> 78
                 (1460 + 1170) / 35 = 2630 / 35 = 75.142... -> floor to one decimal = 75.1

      PROJECT: done rounds 1, 2, 3, 4, 8 (5 skipped, 6 not-applicable, 7 pending) -> weight 70.
        current  r1: P-1 medium ok 0 -> 100 ; r2: no items -> 100
                 r3: P-2 medium failed 5 + P-3 low wontfix 0 = 5 -> 95 ; r4: P-4 high fixed 0 -> 100
                 r8: P-5 critical accepted 12.5 -> 87.5   (P-6 in skipped round 5 -> excluded)
                 (2000 + 1500 + 950 + 1500 + 875) / 70 = 6825 / 70 = 97.5 -> grade A
        baseline r1: 5 -> 95 ; r2: 100 ; r3: 5 + 2 = 7 -> 93 ; r4: 15 -> 85 ; r8: 25 -> 75
                 (1900 + 1500 + 930 + 1275 + 750) / 70 = 6355 / 70 = 90.785... -> 90.7
        previous: 72 (preserved from the input state)
    */
    assert.equal(s.user.current, 79.5);
    assert.equal(s.user.baseline, 75.1);
    assert.equal(s.user.grade, 'B');
    assert.equal(s.user.roundsCounted, 2);
    assert.equal(s.user.roundsTotal, 7); // the fixture marks one user round not-applicable
    assert.equal(s.user.previous, null);
    assert.equal(s.project.current, 97.5);
    assert.equal(s.project.baseline, 90.7);
    assert.equal(s.project.grade, 'A');
    assert.equal(s.project.roundsCounted, 5);
    assert.equal(s.project.roundsTotal, 7);
    assert.equal(s.project.previous, 72);
    assert.match(s.project.computedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally { rmrf(dir); }
});

test('floor1 never rounds up and survives float error', () => {
  assert.equal(floor1(2630 / 35), 75.1);
  assert.equal(floor1(6355 / 70), 90.7);
  assert.equal(floor1(96.25), 96.2);
  assert.equal(floor1((45.5 / 70) * 100), 65); // 64.99999... in floating point
  assert.equal(floor1(89.99), 89.9);
});

test('grades: A >= 90, B >= 75, C >= 60, D >= 40, otherwise F', () => {
  const cases = [[100, 'A'], [90, 'A'], [89.9, 'B'], [75, 'B'], [74.9, 'C'], [60, 'C'], [59.9, 'D'], [40, 'D'], [39.9, 'F'], [0, 'F']];
  for (const [score, grade] of cases) assert.equal(gradeFor(score), grade, `score ${score}`);
  assert.equal(gradeFor(null), null);
});

test('the worked example in scoring.md computes as documented', () => {
  const plugin = '~/.claude/plugins/acme/hooks.json';
  const st = mini([
    { round: 1, severity: 'critical', file: './.claude/settings.json' },
    { round: 1, severity: 'high', origin: 'plugin', file: plugin },
    { round: 1, severity: 'high', status: 'accepted', origin: 'plugin', file: plugin },
    { round: 1, severity: 'medium', origin: 'plugin', file: plugin },
    { round: 2, severity: 'critical', class: 'secret', origin: 'example', file: './examples/.env.sample' },
    { round: 2, severity: 'medium', status: 'fixed', file: './CLAUDE.md' },
    { round: 3, severity: 'high', file: './docs/setup.md' },
    { round: 4, severity: 'low', origin: 'project-optional' },
  ], [1, 2, 4]);
  /*
    r1: 25 + min(10, 7.5 + 3.75 + 2.5) = 35 -> 65 ; r2: 25 (secret, not discounted) -> 75 ; r4: 1.5 -> 98.5
    current  (20 * 65 + 15 * 75 + 15 * 98.5) / 50 = 3902.5 / 50 = 78.05 -> 78, grade B
    baseline r1: 25 + min(10, 17.5) = 35 -> 65 ; r2: 25 + 5 -> 70 ; r4 98.5
             (1300 + 1050 + 1477.5) / 50 = 76.55 -> 76.5
  */
  const s = scoreScope(st, 'project');
  assert.equal(s.current, 78);
  assert.equal(s.baseline, 76.5);
  assert.equal(s.grade, 'B');
  assert.equal(s.roundsCounted, 3);
});

test('origin weights scale a deduction: active 1, project-optional .75, plugin .5, example .25', () => {
  const one = (extra) => scoreScope(mini([{ severity: 'high', ...extra }]), 'project');
  assert.equal(one({}).current, 85); // no origin = active: 15
  assert.equal(one({ origin: 'active' }).current, 85);
  assert.equal(one({ origin: 'project-optional' }).current, 88.7); // 11.25 -> 88.75, floored
  assert.equal(one({ origin: 'plugin' }).current, 92.5); // 7.5
  assert.equal(one({ origin: 'example' }).current, 96.2); // 3.75 -> 96.25, floored
  // Origin and status multiply: 15 * .5 accepted * .5 plugin = 3.75; baseline 15 * .5 = 7.5.
  const acc = one({ origin: 'plugin', status: 'accepted' });
  assert.equal(acc.current, 96.2);
  assert.equal(acc.baseline, 92.5);
});

test('a secret is never discounted by origin and never capped', () => {
  const secret = scoreScope(mini([{ severity: 'critical', class: 'secret', origin: 'example', file: './examples/.env' }]), 'project');
  assert.equal(secret.current, 75); // 25 in full, not 25 * .25
  const notSecret = scoreScope(mini([{ severity: 'critical', class: 'permission', origin: 'example', file: './examples/.env' }]), 'project');
  assert.equal(notSecret.current, 93.7); // 6.25 -> 93.75, floored
  // Two secrets in one plugin file: 50, not capped at 10.
  const two = scoreScope(mini([
    { severity: 'critical', class: 'secret', origin: 'plugin', file: 'p/x.json' },
    { severity: 'critical', class: 'secret', origin: 'plugin', file: 'p/x.json' },
  ]), 'project');
  assert.equal(two.current, 50);
  // A secret next to capped items in the same file: 25 + min(10, 7.5 + 7.5) = 35.
  const mixed = scoreScope(mini([
    { severity: 'critical', class: 'secret', origin: 'plugin', file: 'p/x.json' },
    { severity: 'high', origin: 'plugin', file: 'p/x.json' },
    { severity: 'high', origin: 'plugin', file: 'p/x.json' },
  ]), 'project');
  assert.equal(mixed.current, 65);
});

test('per-file cap: non-active items of one file deduct at most 10 per round', () => {
  const sc = (items, done) => scoreScope(mini(items, done), 'project');
  // Three high plugin items in one file: 7.5 * 3 = 22.5 -> capped at 10.
  const three = Array.from({ length: 3 }, () => ({ severity: 'high', origin: 'plugin', file: 'p/a.md' }));
  assert.equal(sc(three).current, 90);
  // A second file is a second group: 10 + 7.5.
  assert.equal(sc([...three, { severity: 'high', origin: 'plugin', file: 'p/b.md' }]).current, 82.5);
  // The first changes[].path wins over `file`: both items land in group "p/a.md" (15 -> 10).
  // If `file` won, they would be two groups of 7.5 and the round would score 85.
  assert.equal(sc([
    { severity: 'high', origin: 'plugin', file: 'p/a.md' },
    { severity: 'high', origin: 'plugin', file: 'p/b.md', changes: [{ path: 'p/a.md', before: 'x', after: 'y' }] },
  ]).current, 90);
  // Active items are never capped, even in one file: 25 + 25.
  assert.equal(sc([{ severity: 'critical', file: 'a.json' }, { severity: 'critical', file: 'a.json' }]).current, 50);
  // Non-active items without a file are not grouped: 7.5 * 3 = 22.5.
  assert.equal(sc(Array.from({ length: 3 }, () => ({ severity: 'high', origin: 'plugin' }))).current, 77.5);
  // The cap is per round: the same file in rounds 1 and 2 is capped in each.
  const both = mini([...three, ...three.map((i) => ({ ...i, round: 2 }))], [1, 2]);
  const rows = roundBreakdown(both, 'project');
  assert.equal(rows[0].deductions, 10);
  assert.equal(rows[1].deductions, 10);
  assert.equal(scoreScope(both, 'project').current, 90);
  // The baseline is capped too: two accepted plugin highs = 3.75 * 2 = 7.5 now, 15 -> 10 as open.
  const acc = sc([
    { severity: 'high', origin: 'plugin', status: 'accepted', file: 'p/a.md' },
    { severity: 'high', origin: 'plugin', status: 'accepted', file: 'p/a.md' },
  ]);
  assert.equal(acc.current, 92.5);
  assert.equal(acc.baseline, 90);
});

test('a round never goes below zero, and a low score grades F on the board', () => {
  assert.equal(scoreScope(mini(Array.from({ length: 5 }, () => ({ severity: 'critical' }))), 'project').current, 0);
  const { dir, r, read, p } = renderBoards((st) => {
    for (const x of st.rounds) if (x.scope === 'project' && x.round !== 1) x.status = x.status === 'done' ? 'pending' : x.status;
    for (const n of [7, 8, 9]) {
      st.items.push({ id: `P-${n}`, scope: 'project', round: 1, severity: 'critical', class: 'permission', title: 'Wide allow', finding: 'f', proposal: 'p', opinion: 'o', status: 'open' });
    }
  });
  try {
    assert.equal(r.code, 0, r.stderr);
    const s = JSON.parse(fs.readFileSync(p, 'utf8')).scores;
    // Only round 1 counts: 3 open criticals = 75 -> 25 ; baseline adds P-1 medium 5 -> 20.
    assert.equal(s.project.current, 25);
    assert.equal(s.project.baseline, 20);
    assert.equal(s.project.grade, 'F');
    assert.match(read('board.md'), /\| project \| 25 \| F \| 20 \|/);
    assert.match(read('board.html'), /\.g-F \{/);
    assert.ok(!read('board.html').includes('.g-E'), 'no E grade left in the board');
  } finally { rmrf(dir); }
});

test('only the scores key changes in the state file, with 2-space formatting', () => {
  const { dir, p } = stageFixture();
  try {
    const before = JSON.parse(fs.readFileSync(p, 'utf8'));
    runScript('render-board.mjs', [p]);
    const text = fs.readFileSync(p, 'utf8');
    const after = JSON.parse(text);
    delete before.scores; delete after.scores;
    assert.deepEqual(after, before);
    assert.ok(text.startsWith('{\n  "schemaVersion": 1,'));
    assert.ok(text.endsWith('}\n'));
  } finally { rmrf(dir); }
});

test('a scope with zero done rounds is "not scored"', () => {
  const { dir, p } = stageFixture((st) => {
    for (const r of st.rounds) if (r.scope === 'project') r.status = r.status === 'done' ? 'pending' : r.status;
  });
  try {
    const r = runScript('render-board.mjs', [p]);
    assert.equal(r.code, 0, r.stderr);
    const s = JSON.parse(fs.readFileSync(p, 'utf8')).scores;
    assert.equal(s.project.current, null);
    assert.equal(s.project.baseline, null);
    assert.equal(s.project.grade, null);
    assert.equal(s.project.roundsCounted, 0);
    assert.equal(s.project.previous, 72);
    const md = fs.readFileSync(path.join(dir, 'board.md'), 'utf8');
    assert.match(md, /\| project \| not scored \|/);
    const html = fs.readFileSync(path.join(dir, 'board.html'), 'utf8');
    assert.ok(html.includes("'not scored'"), 'client renders the not-scored label');
  } finally { rmrf(dir); }
});

test('board.html loads nothing over the network and embeds the state safely', () => {
  const { dir, p } = stageFixture((st) => { st.items[0].title = 'Breakout </script><img src=x> attempt'; });
  try {
    const r = runScript('render-board.mjs', [p]);
    assert.equal(r.code, 0, r.stderr);
    const html = fs.readFileSync(path.join(dir, 'board.html'), 'utf8');
    // The embedded state JSON may legitimately hold a URL as text (a lead's source); what must not
    // exist is markup, CSS or script that loads anything.
    const markup = html.replace(/<script type="application\/json" id="board-data">[\s\S]*?<\/script>/, '');
    const style = (/<style>([\s\S]*?)<\/style>/.exec(html) || [])[1] || '';
    const ok = (re, msg) => assert.ok(!re.test(markup), msg);
    ok(/(?:src|href|action|poster|data)\s*=\s*["']?\s*(?:https?:)?\/\//i, 'no attribute pointing at a remote resource');
    ok(/https?:\/\//i, 'no http(s) URL anywhere outside the embedded state');
    ok(/<link\b|<iframe\b|<img\b|<object\b|<embed\b/i, 'no loading elements in the static markup');
    ok(/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|import\(/, 'no network or storage calls in script');
    assert.ok(!/@import|url\(/i.test(style), 'no CSS imports or url()');
    assert.equal(html.split('</script>').length - 1, 2, 'only the two real closing script tags');
    assert.match(html, /--bg: var\(--color-background-primary, #ffffff\)/);
    assert.match(html, /@media \(prefers-color-scheme: dark\)/);
    // The embedded JSON parses back to the state.
    const m = /<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/.exec(html);
    const data = JSON.parse(m[1]);
    assert.equal(data.state.items[0].title, 'Breakout </script><img src=x> attempt');
  } finally { rmrf(dir); }
});

test('render is idempotent: a second render is byte-identical', () => {
  const { dir, p } = stageFixture((st) => {
    st.items[1].origin = 'plugin';
    st.items[1].file = '~/.claude/plugins/x/settings.json';
    st.defenses = [{ scope: 'user', title: 'Deny list', detail: 'Tested.' }];
  });
  try {
    runScript('render-board.mjs', [p]);
    const snap = ['state.json', 'board.html', 'board.md'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    const r2 = runScript('render-board.mjs', [p]);
    assert.equal(r2.code, 0, r2.stderr);
    const snap2 = ['state.json', 'board.html', 'board.md'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.deepEqual(snap2, snap);
  } finally { rmrf(dir); }
});

test('--out-dir writes the boards elsewhere and the state in place', () => {
  const { dir, p } = stageFixture();
  const out = path.join(dir, 'out');
  try {
    const r = runScript('render-board.mjs', [p, '--out-dir', out]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(out, 'board.html')));
    assert.ok(fs.existsSync(path.join(out, 'board.md')));
    assert.ok(!fs.existsSync(path.join(dir, 'board.html')));
  } finally { rmrf(dir); }
});

test('an invalid state is rejected without echoing values', () => {
  const marker = 'BOGUS-STATUS-VALUE-9917';
  const { dir, p } = stageFixture((st) => { st.items[0].status = marker; st.items[1].round = 9; delete st.log; });
  try {
    const before = fs.readFileSync(p, 'utf8');
    const r = runScript('render-board.mjs', [p]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\/items\/0\/status: not one of/);
    assert.match(r.stderr, /\/items\/1\/round: above maximum 8/);
    assert.match(r.stderr, /missing required "log"/);
    assert.ok(!r.stderr.includes(marker) && !r.stdout.includes(marker));
    assert.equal(fs.readFileSync(p, 'utf8'), before, 'state untouched on failure');
    assert.ok(!fs.existsSync(path.join(dir, 'board.html')));
  } finally { rmrf(dir); }
});

test('the schema accepts origin, file and defenses, and rejects malformed ones', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const base = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'state.fixture.json'), 'utf8'));
  const good = structuredClone(base);
  good.items[0].origin = 'example';
  good.items[1].origin = 'project-optional';
  good.items[1].file = './settings.local.example.json';
  good.defenses = [{ scope: 'user', title: 'Deny list' }, { scope: 'project', title: 'Sandbox', detail: 'On by default.' }];
  assert.deepEqual(validateState(good, schema), []);

  const bad = structuredClone(good);
  bad.items[0].origin = 'vendored';
  bad.defenses[0].points = 5;
  delete bad.defenses[1].title;
  const errors = validateState(bad, schema);
  assert.ok(errors.some((e) => /^\/items\/0\/origin: not one of active, project-optional, plugin, example$/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /^\/defenses\/0: unknown property "points"$/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /^\/defenses\/1: missing required "title"$/.test(e)), errors.join('\n'));
});

test('a non-JSON state file fails without printing its content', () => {
  const dir = tmpDir('hd-render-');
  try {
    const p = path.join(dir, 'state.json');
    fs.writeFileSync(p, '{ "schemaVersion": 1, SECRET-LOOKING-TEXT-4242 }');
    const r = runScript('render-board.mjs', [p]);
    assert.equal(r.code, 1);
    assert.ok(!(r.stdout + r.stderr).includes('SECRET-LOOKING-TEXT-4242'));
  } finally { rmrf(dir); }
});

test('the template example state validates, scores and exercises the model', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const exPath = path.join(path.dirname(SCHEMA_PATH), 'state.example.json');
  if (!fs.existsSync(exPath)) return; // owned by another author; may not exist yet
  const ex = JSON.parse(fs.readFileSync(exPath, 'utf8'));
  assert.deepEqual(validateState(ex, schema), []);
  for (const scope of ex.scopes) {
    const s = scoreScope(ex, scope);
    assert.equal(typeof s.current, 'number', `${scope} is scored`);
    assert.ok(s.current >= s.baseline, `${scope}: fixing things never lowers the score`);
  }
  assert.ok(ex.items.some((i) => i.origin && i.origin !== 'active'), 'the example has a non-active origin');
  assert.ok((ex.defenses || []).length >= 1, 'the example lists defenses');
});

// ---------------------------------------------------------------------------------------------
// Defenses and localised chrome
// ---------------------------------------------------------------------------------------------

function renderBoards(mutate, args = []) {
  const { dir, p } = stageFixture(mutate);
  const r = runScript('render-board.mjs', [p, ...args]);
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  return { dir, p, r, read };
}

test('defenses are shown on the board and never change the score', () => {
  const defenses = [
    { scope: 'user', title: 'Blocking PreToolUse hook for force-push', detail: 'Refuses --force in any position; tested.' },
    { scope: 'project', title: 'Sandbox on by default' },
  ];
  const without = renderBoards();
  const withDef = renderBoards((st) => { st.defenses = defenses; });
  const withPt = renderBoards((st) => { st.defenses = defenses; st.language = 'pt'; });
  try {
    for (const x of [without, withDef, withPt]) assert.equal(x.r.code, 0, x.r.stderr);
    const strip = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...v, computedAt: undefined }]));
    const scoresOf = (x) => strip(JSON.parse(fs.readFileSync(x.p, 'utf8')).scores);
    assert.deepEqual(scoresOf(withDef), scoresOf(without));
    assert.deepEqual(scoresOf(withPt), scoresOf(without));

    const md = withDef.read('board.md');
    assert.ok(md.includes('## Recognized defenses'));
    assert.ok(md.includes('Defenses never add points'));
    assert.ok(md.includes('- **Blocking PreToolUse hook for force-push** (user): Refuses --force in any position; tested.'));
    assert.ok(md.includes('- **Sandbox on by default** (project)'));
    const html = withDef.read('board.html');
    assert.ok(html.includes('<h2 id="h-defenses">Recognized defenses</h2>'));
    assert.ok(html.includes('Defenses never add points'));
    assert.ok(without.read('board.md').includes('No defenses recorded.'));

    const mdPt = withPt.read('board.md');
    assert.ok(mdPt.includes('## Defesas reconhecidas'));
    assert.ok(mdPt.includes('Defesas nunca somam pontos'));
    assert.ok(mdPt.includes('(usuário)'));
    assert.ok(withPt.read('board.html').includes('<h2 id="h-defenses">Defesas reconhecidas</h2>'));
  } finally { for (const x of [without, withDef, withPt]) rmrf(x.dir); }
});

test('the board labels each item with its origin and shows round deductions', () => {
  const en = renderBoards((st) => { st.items[6].origin = 'project-optional'; st.items[6].file = './settings.local.example.json'; });
  const pt = renderBoards((st) => { st.language = 'pt'; st.items[6].origin = 'project-optional'; });
  try {
    assert.equal(en.r.code, 0, en.r.stderr);
    const md = en.read('board.md');
    assert.match(md, /\| P-1 \| project \| medium \| ok \| additive \| project \(optional\) \|/);
    assert.match(md, /\| U-1 \| user \| critical \| open \| secret \| active \|/);
    assert.ok(md.includes('  - File: ./settings.local.example.json'));
    // User round 1: U-1 critical open = 25 deducted, score 75.
    assert.match(md, /\| 1 Security and permissions \| 20 \| done \| 75 \| 25 \| 2 \|/);
    assert.match(md, /\| 3 Documentation \| 10 \| not applicable \| - \| - \| 0 \|/);
    assert.ok(en.read('board.html').includes("'project (optional)'"));
    assert.equal(pt.r.code, 0, pt.r.stderr);
    assert.match(pt.read('board.md'), /\| P-1 \| projeto \| média \| ok \| aditiva \| opcional do projeto \|/);
  } finally { rmrf(en.dir); rmrf(pt.dir); }
});

test('language "pt" renders Portuguese chrome in board.html and board.md', () => {
  const { dir, r, read } = renderBoards((st) => {
    st.language = 'pt';
    st.mode = 'guided';
    for (const x of st.rounds) if (x.scope === 'project') x.status = x.status === 'done' ? 'pending' : x.status;
  });
  try {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.language, 'pt');
    const html = read('board.html');
    const md = read('board.md');
    assert.match(html, /<html lang="pt-BR">/);
    assert.ok(html.includes("var LOCALE = 'pt-BR';"));
    for (const s of ['Segurança e permissões', 'Dependências externas', "'sem nota'", 'Harness de usuário', 'Harness de projeto',
      'Pistas não confirmadas', "'em andamento'", "'não se aplica'", "'concluída'", "'crítica'", "'média'", "'atenção'",
      '{n} de {m} itens', 'tokens por sessão', 'revisão guiada', 'Defesas reconhecidas', "'ativo'"]) {
      assert.ok(html.includes(s), `board.html has "${s}"`);
    }
    for (const s of ['## Notas', 'Segurança e permissões', '| projeto | sem nota |', '## Pistas não confirmadas', 'Modo: revisão guiada',
      '| crítica |', '| aberto |', 'concluída', 'não se aplica', 'Rodada 1: Segurança e permissões', 'tokens por sessão',
      '## Defesas reconhecidas', 'Nenhuma defesa registrada.', '| Descontado |', '| Origem |']) {
      assert.ok(md.includes(s), `board.md has "${s}"`);
    }
    assert.ok(!md.includes('not scored') && !md.includes('Security and permissions'), 'no English chrome left in board.md');
    // Enum values in the embedded data stay untouched.
    const data = JSON.parse(/<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/.exec(html)[1]);
    assert.equal(data.state.language, 'pt');
    assert.ok(data.state.items.every((i) => ['open', 'queued', 'in-progress', 'fixed', 'accepted', 'failed', 'ok', 'wontfix-not-applicable'].includes(i.status)));
  } finally { rmrf(dir); }
});

test('English is the default and --lang applies only when the state has no language', () => {
  const plain = renderBoards();
  try {
    assert.equal(plain.r.code, 0, plain.r.stderr);
    assert.equal(plain.r.json.language, 'en');
    assert.match(plain.read('board.html'), /<html lang="en">/);
    assert.ok(plain.read('board.md').includes('Round 1: Security and permissions'));
    assert.ok(!plain.read('board.md').includes('Segurança'));
  } finally { rmrf(plain.dir); }

  const flag = renderBoards(undefined, ['--lang', 'pt']);
  try {
    assert.equal(flag.r.json.language, 'pt');
    assert.ok(flag.read('board.md').includes('Rodada 1: Segurança e permissões'));
  } finally { rmrf(flag.dir); }

  const stateWins = renderBoards((st) => { st.language = 'en'; }, ['--lang', 'pt']);
  try {
    assert.equal(stateWins.r.json.language, 'en');
  } finally { rmrf(stateWins.dir); }

  const unknown = renderBoards(undefined, ['--lang', 'fr']);
  try {
    assert.equal(unknown.r.code, 0, unknown.r.stderr);
    assert.equal(unknown.r.json.language, 'en');
  } finally { rmrf(unknown.dir); }
});

test('an unsupported state.language is rejected by the schema', () => {
  const { dir, r } = renderBoards((st) => { st.language = 'fr'; });
  try {
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\/language: not one of en, pt/);
  } finally { rmrf(dir); }
});

test('a Portuguese render is byte-identical on re-render', () => {
  const { dir, p } = stageFixture((st) => { st.language = 'pt'; });
  try {
    runScript('render-board.mjs', [p]);
    const snap = ['state.json', 'board.html', 'board.md'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    const r2 = runScript('render-board.mjs', [p]);
    assert.equal(r2.code, 0, r2.stderr);
    const snap2 = ['state.json', 'board.html', 'board.md'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.deepEqual(snap2, snap);
  } finally { rmrf(dir); }
});

test('board.md shows dates as ISO date and time', () => {
  const { dir, r, read } = renderBoards();
  try {
    assert.equal(r.code, 0, r.stderr);
    const md = read('board.md');
    assert.match(md, /Date: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    assert.match(md, /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC /m);
    assert.match(read('board.html'), /<time datetime="[^"]+" data-local>/);
  } finally { rmrf(dir); }
});

test('both dictionaries carry the same keys', async () => {
  const { STRINGS } = await import('../scripts/lib/i18n.mjs');
  const shape = (o) => Object.entries(o).map(([k, v]) => (v && typeof v === 'object' ? `${k}{${shape(v)}}` : k)).sort().join(',');
  assert.equal(shape(STRINGS.pt), shape(STRINGS.en));
});
