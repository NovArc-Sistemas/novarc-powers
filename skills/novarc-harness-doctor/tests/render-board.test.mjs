// render-board.mjs end to end: validation, scores written back, board.html and board.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, tmpDir, rmrf, runScript } from './helpers.mjs';
import { validateState, SCHEMA_PATH, FONTS_URL, HOMEPAGE_URL, scoreHarness } from '../scripts/render-board.mjs';
import { anchorState } from '../scripts/lib/anchors.mjs';
import { STRINGS } from '../scripts/lib/i18n.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DATA_RE = /<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/;
const fixture = () => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'state.fixture.json'), 'utf8'));
const schema = () => JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

function stage(mutate) {
  const dir = tmpDir('hd-render-');
  const state = fixture();
  if (mutate) mutate(state);
  const p = path.join(dir, 'state.json');
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
  return { dir, p };
}

function render(mutate, args = []) {
  const { dir, p } = stage(mutate);
  const r = runScript('render-board.mjs', [p, ...args]);
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  return { dir, p, r, read, boot: () => JSON.parse(DATA_RE.exec(read('board.html'))[1]) };
}

test('scores match the hand-computed values for the fixture', () => {
  const { dir, p, r } = render();
  try {
    assert.equal(r.code, 0, r.stderr);
    const byId = Object.fromEntries(JSON.parse(fs.readFileSync(p, 'utf8')).harnesses.map((h) => [h.id, h.scores]));
    /*
      Weights: r1 20, r2 15, r3 10, r4 15, r5 5, r6 15, r7 10, r8 10.
      Points: critical 25, high 15, medium 5, low 2. Status factor: open/approved/in-progress/failed/deferred 1,
      declined .5, fixed/ok/not-applicable 0. Every fixture item is active (origin weight 1, no file cap).
      Round score = max(0, 100 - deductions). Harness = sum(weight x round score) / sum(weight) over `done` rounds.

      u1: done rounds 1 and 2 (3 not-applicable, 4 skipped, 5-8 pending) -> weight 35.
        current   r1: U1-101 critical open 25 + U1-102 low fixed 0 = 25 -> 75
                  r2: U1-201 high declined 7.5 + U1-202 medium approved 5 + U1-203 low in-progress 2 = 14.5 -> 85.5
                  (U1-401 is in skipped round 4 -> excluded)
                  (20 x 75 + 15 x 85.5) / 35 = 2782.5 / 35 = 79.5 -> grade B
        baseline  r1: 25 + 2 = 27 -> 73 ; r2: 15 + 5 + 2 = 22 -> 78
                  (1460 + 1170) / 35 = 75.142... -> floor to one decimal = 75.1 -> grade B
        projected r1: 75 ; r2: 7.5 + 0 (approved) + 0 (in-progress) = 7.5 -> 92.5
                  (1500 + 1387.5) / 35 = 82.5 -> grade B

      fixture-shop: done rounds 1, 2, 3, 4, 8 (5 skipped, 6 not-applicable, 7 pending) -> weight 70.
        current   r1: SHOP-101 medium ok 0 -> 100 ; r2: no items -> 100
                  r3: SHOP-301 medium failed 5 + SHOP-302 low not-applicable 0 = 5 -> 95 ; r4: SHOP-401 high fixed 0 -> 100
                  r8: SHOP-801 critical declined 12.5 -> 87.5   (SHOP-501 in skipped round 5 -> excluded)
                  (2000 + 1500 + 950 + 1500 + 875) / 70 = 6825 / 70 = 97.5 -> grade A
        baseline  r1: 5 -> 95 ; r2: 100 ; r3: 5 + 2 = 7 -> 93 ; r4: 15 -> 85 ; r8: 25 -> 75
                  (1900 + 1500 + 930 + 1275 + 750) / 70 = 6355 / 70 = 90.785... -> 90.7 -> grade A
        projected nothing approved or in progress -> 97.5
        previous: 72 (kept from the input state)
    */
    const u = byId.u1;
    assert.deepEqual([u.current, u.baseline, u.projected], [79.5, 75.1, 82.5]);
    assert.deepEqual([u.grade, u.baselineGrade, u.projectedGrade], ['B', 'B', 'B']);
    assert.deepEqual([u.roundsCounted, u.roundsTotal, u.previous], [2, 7, null]);
    const s = byId['fixture-shop'];
    assert.deepEqual([s.current, s.baseline, s.projected], [97.5, 90.7, 97.5]);
    assert.deepEqual([s.grade, s.baselineGrade, s.projectedGrade], ['A', 'A', 'A']);
    assert.deepEqual([s.roundsCounted, s.roundsTotal, s.previous], [5, 7, 72]);
    assert.match(s.computedAt, /^\d{4}-\d{2}-\d{2}T/);
    // stdout follows references/contracts.md.
    assert.equal(r.json.ok, true);
    assert.equal(r.json.language, 'en');
    assert.deepEqual(r.json.scores, byId);
    assert.deepEqual(r.json.warnings, []);
    assert.equal(r.json.bytes, fs.statSync(path.join(dir, 'board.html')).size);
    assert.deepEqual(r.json.files, { state: 'state.json', html: 'board.html', md: 'board.md' });
  } finally { rmrf(dir); }
});

test('only the scores keys change in the state file, with 2-space formatting', () => {
  const { dir, p } = stage();
  try {
    const before = JSON.parse(fs.readFileSync(p, 'utf8'));
    runScript('render-board.mjs', [p]);
    const text = fs.readFileSync(p, 'utf8');
    const after = JSON.parse(text);
    for (const st of [before, after]) for (const h of st.harnesses) delete h.scores;
    assert.deepEqual(after, before);
    assert.ok(text.startsWith('{\n  "schemaVersion": 2,'));
    assert.ok(text.endsWith('}\n'));
  } finally { rmrf(dir); }
});

test('a harness with zero done rounds is "not scored", and a low score grades F', () => {
  const { dir, r, read, p } = render((st) => {
    for (const x of st.rounds) if (x.harness === 'fixture-shop' && x.status === 'done') x.status = 'pending';
    // u1 keeps only round 1, with three more open criticals: 25 x 4 = 100 deducted -> 0.
    for (const x of st.rounds) if (x.harness === 'u1' && x.round === 2) x.status = 'pending';
    for (const n of [103, 104, 105]) st.items.push({ id: `U1-${n}`, harness: 'u1', round: 1, severity: 'critical', class: 'permission', title: 'Wide allow', finding: 'f', proposal: 'p', opinion: 'o', status: 'open' });
  });
  try {
    assert.equal(r.code, 0, r.stderr);
    const byId = Object.fromEntries(JSON.parse(fs.readFileSync(p, 'utf8')).harnesses.map((h) => [h.id, h.scores]));
    assert.deepEqual([byId['fixture-shop'].current, byId['fixture-shop'].baseline, byId['fixture-shop'].projected, byId['fixture-shop'].grade], [null, null, null, null]);
    assert.equal(byId['fixture-shop'].roundsCounted, 0);
    assert.equal(byId['fixture-shop'].previous, 72);
    assert.deepEqual([byId.u1.current, byId.u1.grade], [0, 'F']);
    const md = read('board.md');
    assert.match(md, /\| fixture-shop \| project \| not scored \| not scored \| not scored \| - \|/);
    assert.match(md, /\| Claude Code account 1 \| user \| 0 \| 0 \| 0 \| F \|/);
  } finally { rmrf(dir); }
});

test('board.html embeds the state safely: hostile strings cannot break out', () => {
  const hostile = '</script><script>window.pwned=1</script><img src=x onerror=alert(1)> ${x} %%JS%% $& <!--';
  const { dir, r, read, boot } = render((st) => {
    st.files[0].content = `line one\n${hostile}\nline three\n`;
    st.items[0].title = `Breakout ${hostile}`;
    st.items[2].changes[0] = { file: 'fu1-1', path: '~/.claude/CLAUDE.md', before: hostile, after: `safe ${hostile}`, why: hostile };
    st.items[4].changes = [];
    st.run.title = '<b>Title</b> & "quotes"';
  });
  try {
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.warnings, [], 'the hostile text still anchors by exact match');
    const html = read('board.html');
    // The whole page has exactly two script elements and two closing tags, whatever the state holds.
    assert.equal(html.split('</script>').length - 1, 2);
    assert.equal(html.split('<script').length - 1, 2);
    assert.ok(!html.includes('<img'), 'no markup from the state reaches the page source');
    assert.ok(!html.includes('window.pwned=1</script>'));
    assert.ok(!/<!--/.test(html), 'no HTML comment can swallow the script');
    // The embedded JSON round-trips to exactly the state that was written.
    const data = boot();
    const state = JSON.parse(read('state.json'));
    assert.deepEqual(data.state, state);
    assert.equal(data.state.files[0].content, `line one\n${hostile}\nline three\n`);
    assert.equal(data.state.items[0].title, `Breakout ${hostile}`);
    // The document title is escaped as HTML, and placeholders in the state are never expanded.
    assert.ok(html.includes('<title>Harness doctor · &lt;b&gt;Title&lt;/b&gt; &amp; &quot;quotes&quot;</title>'));
    assert.ok(!DATA_RE.exec(html)[1].includes('<'), 'every < in the embedded JSON is written as \\u003c');
    // The client never builds markup from strings: no innerHTML, no document.write, no eval.
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(script));
  } finally { rmrf(dir); }
});

test('the only external resource is the web font stylesheet, and --offline leaves it out', () => {
  const online = render();
  const offline = render(undefined, ['--offline']);
  try {
    assert.equal(online.r.code, 0, online.r.stderr);
    assert.equal(offline.r.code, 0, offline.r.stderr);
    const urls = (html) => [...html.replace(DATA_RE, '').matchAll(/https?:\/\/[^\s"'<>\\)]+/g)].map((m) => m[0].replace(/&amp;/g, '&'));
    assert.deepEqual(urls(online.read('board.html')).filter((u) => u !== SVG_NS), [FONTS_URL]);
    assert.deepEqual(urls(offline.read('board.html')).filter((u) => u !== SVG_NS), []);
    for (const [x, links] of [[online, 1], [offline, 0]]) {
      const markup = x.read('board.html').replace(DATA_RE, '');
      assert.equal((markup.match(/<link\b/g) || []).length, links);
      assert.ok(!/<(iframe|img|object|embed|video|audio|source)\b/i.test(markup), 'no loading elements');
      assert.ok(!/@import|url\(/i.test(markup), 'no CSS imports or url()');
      assert.ok(!/\bsrc\s*=/.test(markup), 'no src attribute anywhere');
      assert.ok(!/import\(|XMLHttpRequest|WebSocket|sendBeacon/.test(markup), 'no other way out');
      // fetch exists only for the local server channel, and only with relative /api paths.
      const fetches = [...markup.matchAll(/fetch\(([^)]*)/g)].map((m) => m[1]);
      assert.ok(fetches.length > 0 && fetches.every((f) => /^api\('\/api\/(decisions|state)'/.test(f)), fetches.join(' | '));
    }
    // One visual direction: an explicit light page, no dark-mode inversion.
    const html = online.read('board.html');
    assert.match(html, /color-scheme: light/);
    assert.match(html, /body \{[^}]*background: var\(--white\)/);
    assert.ok(!html.includes('prefers-color-scheme'));
    assert.match(html, /prefers-reduced-motion: reduce/);
  } finally { rmrf(online.dir); rmrf(offline.dir); }
});

test('render is idempotent: a second render is byte-identical, in English and in Portuguese', () => {
  for (const lang of [undefined, 'pt']) {
    const { dir, p } = stage((st) => {
      if (lang) st.language = lang;
      st.items[1].origin = 'plugin';
      st.items[1].file = '~/.claude/plugins/x/settings.json';
      st.defenses = [{ harness: 'u1', title: 'Deny list', detail: 'Tested.' }];
    });
    try {
      const first = runScript('render-board.mjs', [p]);
      assert.equal(first.code, 0, first.stderr);
      const snap = ['state.json', 'board.html', 'board.md'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
      const second = runScript('render-board.mjs', [p]);
      assert.equal(second.code, 0, second.stderr);
      assert.deepEqual(['state.json', 'board.html', 'board.md'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')), snap);
    } finally { rmrf(dir); }
  }
});

test('--out-dir writes the boards elsewhere and the state in place', () => {
  const { dir, p } = stage();
  const out = path.join(dir, 'out');
  try {
    const r = runScript('render-board.mjs', [p, '--out-dir', out]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(out, 'board.html')));
    assert.ok(fs.existsSync(path.join(out, 'board.md')));
    assert.ok(!fs.existsSync(path.join(dir, 'board.html')));
    assert.ok(JSON.parse(fs.readFileSync(p, 'utf8')).harnesses[0].scores, 'scores written into the state');
  } finally { rmrf(dir); }
});

test('bad arguments exit 2, and --offline may come before the state path', () => {
  const { dir, p } = stage();
  try {
    assert.equal(runScript('render-board.mjs', []).code, 2);
    assert.equal(runScript('render-board.mjs', [p, '--channel', 'carrier-pigeon']).code, 2);
    assert.equal(runScript('render-board.mjs', [p, '--files', 'some']).code, 2);
    assert.equal(runScript('render-board.mjs', [p, '--files']).code, 2);
    assert.ok(!fs.existsSync(path.join(dir, 'board.html')), 'nothing written on bad arguments');
    const r = runScript('render-board.mjs', ['--offline', p]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!fs.readFileSync(path.join(dir, 'board.html'), 'utf8').includes('fonts.googleapis.com'));
  } finally { rmrf(dir); }
});

test('--files changed embeds only the files a change touches; the state file keeps everything', () => {
  const big = 'x'.repeat(40000);
  const mutate = (st) => {
    st.files.push({ id: 'fu1-9', harness: 'u1', path: '~/.claude/notes.md', category: 'doc', content: `${big}\n`, tokens: 10000, bytes: 40001, loaded: 'on-demand', role: 'Notes.' });
    st.files.push({ id: 'fu1-8', harness: 'u1', path: '~/.claude/huge.bin', category: 'other', content: '', omitted: 'binary' });
    // A change without a file id still finds its file by path, so that file keeps its text too.
    st.items[0].changes = [{ path: '~/.claude/CLAUDE.md', before: 'Never push to main.', after: 'Never push straight to main.' }];
  };
  const all = render(mutate);
  const changed = render(mutate, ['--files', 'changed']);
  const explicit = render(mutate, ['--files', 'all']);
  try {
    for (const x of [all, changed, explicit]) assert.equal(x.r.code, 0, x.r.stderr);
    const files = Object.fromEntries(changed.boot().state.files.map((f) => [f.id, f]));
    assert.ok(files['fu1-1'].content.includes('Always run the tests.'), 'a file with changes keeps its text');
    assert.ok(files['fshop-1'].content.includes('npm run check'), 'so does one that only has an applied change');
    assert.deepEqual([files['fu1-9'].content, files['fu1-9'].omitted], ['', 'not-included']);
    assert.deepEqual([files['fu1-9'].path, files['fu1-9'].tokens, files['fu1-9'].bytes, files['fu1-9'].loaded, files['fu1-9'].role], ['~/.claude/notes.md', 10000, 40001, 'on-demand', 'Notes.'], 'the metadata stays');
    assert.equal(files['fu1-8'].omitted, 'binary', 'a file already omitted keeps its own reason');
    // The state on disk is the full one, and so are the default and the explicit "all".
    const onDisk = JSON.parse(changed.read('state.json'));
    assert.equal(onDisk.files.find((f) => f.id === 'fu1-9').content, `${big}\n`);
    assert.equal(onDisk.files.find((f) => f.id === 'fu1-9').omitted, undefined);
    assert.equal(all.boot().state.files.find((f) => f.id === 'fu1-9').content, `${big}\n`);
    assert.deepEqual(explicit.boot().state.files, all.boot().state.files, '--files all is the default');
    // The page is smaller by about the text left out, and bytes says so.
    assert.equal(changed.r.json.bytes, fs.statSync(path.join(changed.dir, 'board.html')).size);
    assert.ok(all.r.json.bytes - changed.r.json.bytes > 39000, `${all.r.json.bytes} vs ${changed.r.json.bytes}`);
    assert.deepEqual(changed.r.json.warnings, []);
    assert.equal(changed.read('board.md'), all.read('board.md'), 'board.md does not depend on the flag');
  } finally { for (const x of [all, changed, explicit]) rmrf(x.dir); }
});

test('--channel sets the hint the page starts from; the state can set it too', () => {
  const flag = render(undefined, ['--channel', 'server']);
  const fromState = render((st) => { st.environment.channel = 'artifact'; });
  const both = render((st) => { st.environment.channel = 'artifact'; }, ['--channel', 'file']);
  const none = render();
  try {
    assert.equal(flag.boot().channel, 'server');
    assert.equal(fromState.boot().channel, 'artifact');
    assert.equal(both.boot().channel, 'file');
    assert.equal(none.boot().channel, 'file');
    // The page still finds out by itself: all three ways are in every board.
    const html = none.read('board.html');
    for (const s of [".use('db')", ".collection('decisions')", '/api/decisions', '/api/state', 'run.mjs decide', 'localStorage']) assert.ok(html.includes(s), s);
    assert.ok(!/window\.claude\.db|claude\.db\b/.test(html), 'the namespace is only ever reached through use()');
  } finally { for (const x of [flag, fromState, both, none]) rmrf(x.dir); }
});

test('an invalid state is rejected without echoing values, and nothing is written', () => {
  const marker = 'BOGUS-STATUS-VALUE-9917';
  const { dir, p } = stage((st) => { st.items[0].status = marker; st.items[1].round = 9; delete st.log; });
  try {
    const before = fs.readFileSync(p, 'utf8');
    const r = runScript('render-board.mjs', [p]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\/items\/0\/status: not one of/);
    assert.match(r.stderr, /\/items\/1\/round: above maximum 8/);
    assert.match(r.stderr, /missing required "log"/);
    assert.ok(!r.stderr.includes(marker) && !r.stdout.includes(marker));
    assert.equal(r.json.ok, false);
    assert.equal(fs.readFileSync(p, 'utf8'), before, 'state untouched on failure');
    assert.ok(!fs.existsSync(path.join(dir, 'board.html')));
  } finally { rmrf(dir); }
});

test('a non-JSON state file fails without printing its content', () => {
  const dir = tmpDir('hd-render-');
  try {
    const p = path.join(dir, 'state.json');
    fs.writeFileSync(p, '{ "schemaVersion": 2, SECRET-LOOKING-TEXT-4242 }');
    const r = runScript('render-board.mjs', [p]);
    assert.equal(r.code, 1);
    assert.ok(!(r.stdout + r.stderr).includes('SECRET-LOOKING-TEXT-4242'));
  } finally { rmrf(dir); }
});

test('the schema accepts what v2 adds and rejects malformed entries', () => {
  const good = fixture();
  good.language = 'pt';
  good.environment.channel = 'artifact';
  good.items[0].origin = 'example';
  good.items[0].saves = { tokens: 1200, basis: 'estimated', how: 'x' };
  good.items[1].question = 'why?';
  good.groups = [{ id: 'G-1', title: 'Same in two', round: 2, items: ['U1-201', 'SHOP-301'] }];
  good.defenses = [{ harness: 'u1', title: 'Deny list' }, { harness: 'fixture-shop', title: 'Sandbox', detail: 'On by default.' }];
  good.accounts = { primary: null, list: [{ id: 'claude-1', provider: 'claude-code', label: 'Account 1', path: '~/.claude', harness: 'u1', sync: { mode: 'independent', status: 'none', elements: [{ name: 'skills/', state: 'account-only' }] } }] };
  good.harnesses[0].impact = {
    windowDays: 30, sessions: 3, totalTokens: 1000, waste: [{ kind: 'retry', episodes: 1, tokens: 100, weighted: 12 }], estimates: [{ label: 'x', tokens: 5, source: 'y' }],
    // Relative cost, as session-impact.mjs reports it: the weights block may carry more than the schema names.
    weightedTotal: 140, weightedByKind: { input: 10, cacheWrite: 25, cacheRead: 80, output: 25 },
    weights: { unit: 'input-token equivalents', source: 'pricing-weights.json', sources: ['https://example.com/pricing'], verifiedAt: '2026-11-10', perModelFamily: { any: { turns: 3, ratios: { input: 1 } } }, method: 'text' },
    contextAtStart: { perSessionMedian: 200, perSessionP90: 300, total: 600, weightedTotal: 70 },
  };
  good.harnesses[0].elements = { permissions: [{ layer: 'user', kind: 'deny', rule: 'Read(./.env)' }], hooks: [{ id: 'h1', source: 'git', event: 'pre-commit', blocking: null }] };
  good.harnesses[0].impact.contextAtStart = { ...good.harnesses[0].impact.contextAtStart, turns: 40, carriedTokens: 8000, carriedWeighted: 900 };
  good.harnesses[0].impact.estimates[0].id = 'some-estimate';
  good.harnesses[1].impactSkipped = { reason: 'shared-sessions', with: 'u1' };
  good.accounts.list[0].identity = null;
  good.accounts.list[0].host = null;
  good.files.push({ id: 'fshop-2', harness: 'fixture-shop', path: './CLAUDE.md', category: 'instructions', content: '', omitted: 'linked', linkTo: '~/.claude/CLAUDE.md', inheritedFrom: 'u1' });
  good.files.push({ id: 'fshop-3', harness: 'fixture-shop', path: './big.md', category: 'doc', content: '', omitted: 'not-included' });
  good.decisions.push({ at: '2026-01-10T10:00:00Z', target: 'accounts.primary', action: 'approve', note: 'claude-1', via: 'board', runId: good.run.id, exclude: [] });
  assert.deepEqual(validateState(good, schema()), []);

  const bad = structuredClone(good);
  bad.items[0].origin = 'vendored';
  bad.items[2].status = 'queued';
  bad.items[3].scope = 'user';
  bad.defenses[0].points = 5;
  delete bad.defenses[1].title;
  bad.decisions[0].action = 'maybe';
  bad.harnesses[0].impact.waste[0].kind = 'daydreaming';
  bad.harnesses[0].impact.weightedByKind.thinking = 3;
  bad.harnesses[0].impact.contextAtStart.weightedTotal = 'a lot';
  bad.files[0].id = 'not-an-id';
  bad.files[1].omitted = 'lost';
  bad.harnesses[1].impactSkipped = { reason: 'did-not-feel-like-it' };
  const errors = validateState(bad, schema());
  const has = (re) => assert.ok(errors.some((e) => re.test(e)), `${re}\n${errors.join('\n')}`);
  has(/^\/items\/0\/origin: not one of active, project-optional, plugin, example$/);
  has(/^\/items\/2\/status: not one of open, approved, in-progress, fixed, failed, declined, deferred, ok, not-applicable$/);
  has(/^\/items\/3: unknown property "scope"$/);
  has(/^\/defenses\/0: unknown property "points"$/);
  has(/^\/defenses\/1: missing required "title"$/);
  has(/^\/decisions\/0\/action: not one of approve, decline, defer, ask$/);
  has(/^\/harnesses\/0\/impact\/waste\/0\/kind: not one of /);
  has(/^\/harnesses\/0\/impact\/weightedByKind: unknown property "thinking"$/);
  has(/^\/harnesses\/0\/impact\/contextAtStart\/weightedTotal: expected integer, got string$/);
  has(/^\/files\/0\/id: does not match /);
  has(/^\/files\/1\/omitted: not one of too-large, binary, budget, unreadable, linked, not-included$/);
  has(/^\/harnesses\/1\/impactSkipped\/reason: not one of shared-sessions, no-transcript-reader$/);
  assert.deepEqual(validateState({ ...fixture(), schemaVersion: 1 }, schema()), ['/schemaVersion: must equal 2']);
  assert.match(validateState({ ...fixture(), language: 'fr' }, schema())[0], /^\/language: not one of en, pt$/);
});

test('cross-field rules: unknown harnesses and duplicate ids are errors', () => {
  const st = fixture();
  st.items[0].harness = 'ghost';
  st.items[2].id = st.items[1].id;
  st.rounds.push({ harness: 'u1', round: 1, status: 'done' });
  st.files[1].id = st.files[0].id;
  st.harnesses[1].inherits = 'nobody';
  st.accounts = { primary: 'missing', list: [{ id: 'a', provider: 'codex', label: 'A', path: '~/.codex', harness: 'nowhere' }] };
  const errors = validateState(st, schema());
  for (const e of ['/items/0/harness: not an id in harnesses', '/items/2: duplicate id', '/rounds/16: duplicate entry for this harness and round',
    '/files/1: duplicate id', '/harnesses/1/inherits: not the id of another harness', '/accounts/list/0/harness: not an id in harnesses',
    '/accounts/primary: not an id in accounts.list']) assert.ok(errors.includes(e), `${e}\n${errors.join('\n')}`);
});

test('a change that cannot be placed is a warning on stdout, on stderr and in board.md', () => {
  const { dir, r, read } = render((st) => {
    st.items[2].changes[0].before = 'this text is not in the file';
    st.items[4].changes.push({ path: '~/.gitconfig', before: 'x', after: 'y' });
    st.groups = [{ id: 'G-1', title: 'Dangling', round: 2, items: ['U1-201', 'GONE-1'] }];
  });
  try {
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.warnings, [
      { item: 'U1-201', change: 0, problem: 'before text not found in the file' },
      { item: 'U1-203', change: 1, problem: 'the file is not in the snapshot' },
      { item: 'G-1', change: null, problem: 'the group lists an item id that is not in items' },
    ]);
    assert.match(r.stderr, /warning: U1-201 change 1: before text not found in the file/);
    const md = read('board.md');
    assert.ok(md.includes('## Changes not placed in their file'));
    assert.ok(md.includes('- **U1-201** #1: before text not found in the file'));
  } finally { rmrf(dir); }
});

test('board.md lists scores, items by round with status, pending decisions with the command, and the log', () => {
  const { dir, r, read } = render((st) => {
    st.groups = [{ id: 'G-1', title: 'Same finding twice', round: 4, items: ['U1-401', 'SHOP-501'] }];
    st.items[5].group = 'G-1';
    st.defenses = [{ harness: 'u1', title: 'Blocking hook for force-push', detail: 'Tested.' }];
    st.accounts = { primary: null, list: [{ id: 'claude-1', provider: 'claude-code', label: 'Account 1', path: '~/.claude', harness: 'u1' }] };
  });
  try {
    assert.equal(r.code, 0, r.stderr);
    const md = read('board.md');
    for (const s of [
      '# Harness doctor: Fixture',
      'Mode: doctor · Agent: claude-code (linux) · Window: last 30 days · Date: 2026-01-10 11:30 UTC · Run: 20260110-ab12',
      '| Claude Code account 1 | user | 75.1 | 79.5 | 82.5 | B | 2 of 7 | 2 |',
      '| fixture-shop | project | 90.7 | 97.5 | 97.5 | A | 5 of 7 | 1 |',
      'Average grade: B → A (82.9 before, 90 after what you approved)',
      '## Pending decisions',
      '  - Account 1: `run.mjs decide --run 20260110-ab12 --target accounts.primary --action approve --note "claude-1"`',
      '- **G-1** (Group decision) Same finding twice: U1-401, SHOP-501',
      '  - `run.mjs decide --run 20260110-ab12 --target G-1 --action approve`',
      '- **U1-101** (critical, Claude Code account 1) Token inline in helper script',
      '  - `run.mjs decide --run 20260110-ab12 --target U1-101 --action approve`',
      '- **U1-401** (high, Claude Code account 1, G-1) Stop hook points at a moved script',
      '## Claude Code account 1',
      'Score: Before 75.1 (B) · Now 79.5 (B) · After approvals 82.5 (B)',
      'Score: Before 90.7 (A) · Now 97.5 (A) · After approvals 97.5 (A) · Previous 72',
      '| 1 Security and permissions | 20 | done | 75 | 25 | 75 | 2 |',
      '| 2 Instructions and structure | 15 | done | 85.5 | 14.5 | 92.5 | 3 |',
      '| 3 Documentation | 10 | not applicable | - | - | - | 0 |',
      '#### Round 2: Instructions and structure',
      '| U1-201 | high | declined | reversible | active | Broken import in CLAUDE.md |',
      '| U1-202 | medium | approved | translate (agent) | active | Rules file in Portuguese |',
      '| U1-203 | low | applying | additive | active | Rule without a reason |',
      '| SHOP-301 | medium | failed | translate (agent) | active | Agent doc in Portuguese |',
      '  - File: ~/.claude/CLAUDE.md (1 edit)',
      '  - To carry forward: Check that every import resolves.',
      '- **Blocking hook for force-push**: Tested.',
      'Defenses never add points',
      'about 2450 tokens per session',
      '## Unconfirmed leads',
      '## Log',
      '- 2026-01-10 10:00 UTC [Claude Code account 1 · U1-102] Removed unused ask rule; settings re-read.',
    ]) assert.ok(md.includes(s), `board.md has "${s}"`);
    // Average: baseline (75.1 + 90.7) / 2 = 82.9 ; projected (82.5 + 97.5) / 2 = 90.
    assert.ok(!md.includes('—'), 'no em dash in board.md');
    // An item that is not open has no command.
    assert.ok(!md.includes('--target U1-202 '));
  } finally { rmrf(dir); }
});

test('language "pt" renders Portuguese strings in both files; enum values stay untouched', () => {
  const { dir, r, read, boot } = render((st) => { st.language = 'pt'; st.mode = 'guided'; });
  try {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.language, 'pt');
    const html = read('board.html');
    const md = read('board.md');
    assert.match(html, /<html lang="pt-BR">/);
    const data = boot();
    assert.deepEqual([data.lang, data.locale], ['pt', 'pt-BR']);
    assert.deepEqual(data.t, STRINGS.pt, 'the page receives the active dictionary, and only that one');
    assert.equal(data.t.nav.overview, 'visão geral');
    assert.equal(data.t.madeWith, 'Feito com NOVARC Powers');
    assert.equal(STRINGS.en.madeWith, 'Made with NOVARC Powers');
    assert.equal(data.home, HOMEPAGE_URL, 'the footer link travels with the data, so the page source names no other address');
    assert.ok(!/NovArc Powers/.test(html), 'the product name is written NOVARC Powers');
    assert.equal(data.t.channel.file, 'cole o comando no chat');
    assert.equal(data.t.channel.artifact, 'decisões pelo painel');
    for (const s of ['Modo: revisão guiada', '## Decisões pendentes', 'Rodada 2: Instruções e estrutura', '| crítica |', '| aprovado |', '| aplicando |',
      'Nota: Antes 75.1 (B) · Agora 79.5 (B) · Depois das aprovações 82.5 (B)', '### Defesas reconhecidas', 'Nenhuma defesa registrada.', '## Registro', 'últimos 30 dias']) {
      assert.ok(md.includes(s), `board.md has "${s}"`);
    }
    assert.ok(!md.includes('not scored') && !md.includes('Security and permissions'), 'no English strings left in board.md');
    assert.ok(data.state.items.every((i) => ['open', 'approved', 'in-progress', 'fixed', 'failed', 'declined', 'deferred', 'ok', 'not-applicable'].includes(i.status)));
  } finally { rmrf(dir); }
});

test('English is the default and --lang applies only when the state has no language', () => {
  const cases = [
    [undefined, [], 'en'], [undefined, ['--lang', 'pt'], 'pt'], ['en', ['--lang', 'pt'], 'en'], [undefined, ['--lang', 'fr'], 'en'],
  ];
  for (const [stateLang, args, expected] of cases) {
    const { dir, r, read } = render((st) => { if (stateLang) st.language = stateLang; }, args);
    try {
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.json.language, expected);
      assert.match(read('board.html'), expected === 'pt' ? /<html lang="pt-BR">/ : /<html lang="en">/);
      assert.equal(read('board.md').includes('Rodada 1: Segurança e permissões'), expected === 'pt');
    } finally { rmrf(dir); }
  }
});

test('both dictionaries carry the same keys, placeholders and no em dash or emoji', () => {
  const shape = (o) => Object.entries(o).map(([k, v]) => (v && typeof v === 'object' ? `${k}{${shape(v)}}` : k)).sort().join(',');
  assert.equal(shape(STRINGS.pt), shape(STRINGS.en));
  const walk = (a, b, at) => {
    for (const k of Object.keys(a)) {
      if (typeof a[k] === 'object') { walk(a[k], b[k], `${at}.${k}`); continue; }
      const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
      assert.equal(ph(b[k]), ph(a[k]), `${at}.${k} uses the same placeholders in both languages`);
      for (const s of [a[k], b[k]]) assert.ok(!/[–—]|\p{Extended_Pictographic}/u.test(s), `${at}.${k}: no dash or emoji`);
    }
  };
  walk(STRINGS.en, STRINGS.pt, 'T');
  assert.equal(STRINGS.pt.tab.explorer, 'Explorador');
  assert.equal(STRINGS.pt.fv.modeChanges, 'Mudanças');
});

test('the example renders as stored, and board.md carries its relative cost and its fixed cost', () => {
  const dir = tmpDir('hd-render-');
  try {
    const p = path.join(dir, 'state.json');
    fs.copyFileSync(path.join(path.dirname(SCHEMA_PATH), 'state.example.json'), p);
    const before = fs.readFileSync(p, 'utf8');
    const r = runScript('render-board.mjs', [p]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.warnings, []);
    assert.equal(fs.readFileSync(p, 'utf8'), before, 'the example is stored with its scores already computed');
    const md = fs.readFileSync(path.join(dir, 'board.md'), 'utf8');
    /*
      Claude Code conta 1 (the only measured account, so the fleet totals are its own):
        raw waste 8.2M + 5.6M + 3.6M + 1.1M + 0.6M + 0.5M = 19.6M of 486M = 4.03...% -> 4
        relative waste 590k + 420k + 270k + 85k + 45k + 40k = 1.45M of 72.48M = 2.0005...% -> 2
        (72.48M reads 72,4 mi and 1.45M reads 1,4 mi: token figures are floored, never rounded up)
        carried context 38.9M of 72.48M = 53.67...% -> 53,6
      Sessions: accounts only, and conta 2 shares the folder of conta 1: 412 + 31 (Codex) = 443 in 2 accounts.
    */
    for (const s of [
      'Tokens gastos à toa em 30 dias: 19,6 mi (2% do custo relativo; da 1 conta medida)',
      'Sessões no período: 443 (em 2 contas)',
      '412 sessões, 486 mi tokens em 30 dias; desperdício medido 19,6 mi (4%). Números de exemplo.',
      'Custo relativo (tokens equivalentes de entrada): 72,4 mi; desperdício medido 1,4 mi (2%).',
      'O contexto inicial é relido a cada turno: 377 mi tokens no período, 53,6% do custo relativo.',
      '- sem ocorrências: chamadas idênticas repetidas em sequência',
      'As sessões desta conta ficam na mesma pasta de Claude Code · conta 1; a medição está lá.',
      '- **G-1** (Decisão em grupo) Arquivos de agente em português: U1-201, LOJA-201, API-201',
      '`run.mjs decide --run 20261120-k3x9 --target LOJA-101 --action approve`',
    ]) assert.ok(md.includes(s), `board.md has "${s}"`);
    assert.ok(!md.includes('\u2014'));
  } finally { rmrf(dir); }
});

test('the template example validates, anchors every change and exercises the whole model', () => {
  const exPath = path.join(path.dirname(SCHEMA_PATH), 'state.example.json');
  const text = fs.readFileSync(exPath, 'utf8');
  const ex = JSON.parse(text);
  assert.deepEqual(validateState(ex, schema()), []);
  assert.equal(ex.language, 'pt');
  assert.ok(!/[–—]|\p{Extended_Pictographic}/u.test(text), 'no dash or emoji in the example');
  assert.deepEqual(anchorState(ex).warnings, []);
  const set = (f) => [...new Set(ex.items.map(f))].sort();
  assert.deepEqual(set((i) => i.status), ['approved', 'declined', 'deferred', 'failed', 'fixed', 'in-progress', 'not-applicable', 'ok', 'open']);
  assert.deepEqual(set((i) => i.class), ['additive', 'delete', 'external', 'gate', 'install', 'none', 'permission', 'reversible', 'secret', 'sync', 'translate-agent', 'translate-human']);
  assert.deepEqual(set((i) => i.origin || 'active'), ['active', 'example', 'plugin', 'project-optional']);
  const changes = ex.items.flatMap((i) => i.changes || []);
  assert.ok(changes.some((c) => c.before !== '' && c.after !== '' && !c.applied), 'a replacement');
  assert.ok(changes.some((c) => c.before === '' && c.insertAfter), 'an insertion after a line');
  assert.ok(changes.some((c) => c.before === '' && !c.insertAfter && c.file), 'an insertion at the end');
  assert.ok(changes.some((c) => c.before === '' && !c.file), 'a new file');
  assert.ok(changes.some((c) => c.after === ''), 'a removal');
  assert.ok(changes.some((c) => c.applied === true), 'an applied change');
  assert.ok(ex.accounts.list.length >= 3 && ex.accounts.list.some((a) => a.sync.mode === 'linked') && ex.accounts.list.some((a) => a.sync.mode === 'replicated'));
  assert.ok(ex.harnesses.filter((h) => h.kind === 'project').length >= 2);
  assert.ok(ex.harnesses.some((h) => h.impact && h.impact.example === true));
  const groupHarnesses = new Set(ex.groups[0].items.map((id) => ex.items.find((i) => i.id === id).harness));
  assert.ok(groupHarnesses.size >= 2, 'one group across harnesses');
  assert.ok(ex.defenses.length && ex.leads.length && ex.log.length);
  for (const h of ex.harnesses) {
    const s = scoreHarness(ex, h.id);
    assert.equal(typeof s.current, 'number', `${h.id} is scored`);
    assert.ok(s.baseline <= s.current && s.current <= s.projected, `${h.id}: fixing and approving never lower the score`);
    assert.deepEqual([h.scores.baseline, h.scores.current, h.scores.projected], [s.baseline, s.current, s.projected], `${h.id}: stored scores are the computed ones`);
  }
});
