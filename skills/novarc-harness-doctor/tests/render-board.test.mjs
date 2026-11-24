// render-board.mjs end to end: validation, scores written back, board.html and board.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, tmpDir, rmrf, runScript } from './helpers.mjs';
import { validateState, SCHEMA_PATH, FONTS_URL, HOMEPAGE_URL, scoreHarness, applyScores, renderHtml, renderMarkdown, embedJson, embedJsonLines, decideCommand, SHELLS, shellOf } from '../scripts/render-board.mjs';
import { anchorState } from '../scripts/lib/anchors.mjs';
import { STRINGS } from '../scripts/lib/i18n.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DATA_RE = /<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/;
/** What a page fragment must not bring, because the Artifact publisher supplies it. */
const SHELL_TAGS = /<!doctype|<\/?(html|head|body)\b/i;
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

test('--channel artifact writes a page fragment; server and file write a standalone document', () => {
  // Text that would open a second document if any of it reached the page as markup.
  const hostile = '</script><body><html lang="x"><head><!doctype html><title>x</title></head>';
  const mutate = (st) => {
    st.items[0].title = `Nested ${hostile}`;
    st.files[0].content = `line one\n${hostile}\nline three\n`;
    st.run.title = '<title>Board</title>';
  };
  const out = Object.fromEntries(['artifact', 'server', 'file'].map((c) => [c, render(mutate, ['--channel', c])]));
  try {
    for (const x of Object.values(out)) assert.equal(x.r.code, 0, x.r.stderr);
    const frag = out.artifact.read('board.html');
    // It starts at its title and brings no document, root, head or body tag: not in the markup,
    // the stylesheet, the script or the data, whatever the state holds.
    assert.ok(frag.startsWith('<title>Harness doctor · &lt;title&gt;Board&lt;/title&gt;</title>\n<style>\n'), frag.slice(0, 90));
    assert.equal(SHELL_TAGS.exec(frag), null);
    for (const tag of ['<title>', '</title>', '<style>', '</style>']) assert.equal(frag.split(tag).length - 1, 1, `exactly one ${tag}`);
    assert.ok(!/<meta\b/i.test(frag), 'charset and viewport come from the publisher');
    // The title, then the stylesheet and the font link, then the content, the data and the script.
    const order = ['<title>', '<style>', '</style>', '<link rel="stylesheet" href="https://fonts.googleapis.com/', '<a class="skip" href="#view" id="skip">',
      '<nav class="nav" id="nav"', '<main id="view"', '<footer id="foot">', '<div class="tray on-dark" id="tray"', '<script type="application/json" id="board-data">', '<script>\n'];
    const at = order.map((s) => frag.indexOf(s));
    assert.ok(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])), `${order.map((s, k) => `${s} at ${at[k]}`).join('; ')}`);
    assert.ok(frag.endsWith('</script>\n'));
    // Only a stylesheet may come from outside; both scripts are inline.
    assert.equal((frag.match(/<link\b/g) || []).length, 1);
    assert.equal(frag.split('<script').length - 1, 2);
    assert.ok(!/<script[^>]*\bsrc\s*=/i.test(frag));
    // What the root and body tags used to say now comes from the stylesheet and the script.
    assert.match(frag, /body \{[^}]*background: var\(--white\)/);
    assert.match(frag, /:root \{\s*color-scheme: light/);
    assert.ok(frag.includes('document.documentElement.lang = "en";'));
    assert.equal(JSON.parse(DATA_RE.exec(frag)[1]).state.items[0].title, `Nested ${hostile}`);
    assert.equal(out.artifact.r.json.bytes, Buffer.byteLength(frag));

    for (const c of ['server', 'file']) {
      const doc = out[c].read('board.html');
      assert.ok(doc.startsWith('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Harness doctor'), c);
      assert.ok(doc.endsWith('</script>\n</body>\n</html>\n'), c);
      for (const tag of ['<!doctype html>', '<html ', '<head>', '</head>', '<body>', '</body>', '</html>', '<title>', '<meta charset="utf-8">']) assert.equal(doc.split(tag).length - 1, 1, `${c}: exactly one ${tag}`);
      assert.ok(doc.indexOf('</style>') < doc.indexOf('</head>') && doc.indexOf('</head>') < doc.indexOf('<a class="skip"'), `${c}: the stylesheet is in the head, the content in the body`);
      assert.ok(doc.includes('document.documentElement.lang = "en";'), c);
      assert.equal(out[c].boot().channel, c);
    }
    assert.equal(out.artifact.read('board.md'), out.file.read('board.md'), 'board.md does not depend on the channel');
  } finally { for (const x of Object.values(out)) rmrf(x.dir); }
});

/**
 * The page with what legitimately differs between the channels taken out: the embedded data, and
 * the two texts that say where to read the report when the page cannot draw itself.
 */
function comparable(html, T, artifact) {
  const noscript = `<noscript><p class="fatal">${artifact ? T.noscriptArtifact : T.noscript}</p></noscript>`;
  const failed = `.textContent = ${JSON.stringify(artifact ? T.renderErrorArtifact : T.renderError)};`;
  for (const part of [noscript, failed]) assert.equal(html.split(part).length - 1, 1, `exactly one: ${part.slice(0, 60)}`);
  return html.replace(DATA_RE, () => '<script type="application/json" id="board-data"></script>').replace(noscript, '<noscript></noscript>').replace(failed, '.textContent = "";');
}

test('the fragment and the document are one page: only the shell around it differs', () => {
  const state = fixture();
  const data = (html) => JSON.parse(DATA_RE.exec(html)[1]);
  for (const [opts, htmlLang] of [[{ lang: 'en' }, 'en'], [{ lang: 'pt', offline: true }, 'pt-BR']]) {
    const T = STRINGS[opts.lang];
    const frag = comparable(renderHtml(state, { ...opts, channel: 'artifact' }), T, true);
    const cut = frag.indexOf('<a class="skip"');
    for (const channel of ['server', 'file']) {
      const doc = renderHtml(state, { ...opts, channel });
      assert.equal(comparable(doc, T, false), `<!doctype html>\n<html lang="${htmlLang}">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n`
        + `${frag.slice(0, cut)}</head>\n<body>\n${frag.slice(cut, -1)}\n</body>\n</html>\n`, `${channel} ${htmlLang}`);
      // The data says the same too; only the channel hint is each one's own.
      assert.deepEqual({ ...data(doc), channel: 'artifact' }, data(renderHtml(state, { ...opts, channel: 'artifact' })));
    }
  }
  assert.deepEqual(['artifact', 'server', 'file', undefined].map(shellOf), ['fragment', 'document', 'document', 'document']);
  assert.deepEqual(Object.keys(SHELLS).sort(), ['document', 'fragment']);
  assert.deepEqual([SHELLS.fragment.open('en'), SHELLS.fragment.body, SHELLS.fragment.close], ['', '', ''], 'a fragment adds nothing around the page');
  // A state that says "artifact" is rendered as one, flag or no flag: the shell follows the channel the page starts from.
  const viaState = structuredClone(state);
  viaState.environment.channel = 'artifact';
  assert.ok(renderHtml(viaState, { lang: 'en' }).startsWith('<title>'));
  assert.ok(renderHtml(viaState, { lang: 'en', channel: 'file' }).startsWith('<!doctype html>'));
});

test('artifact channel: the embedded data is one entry per line, still JSON, with no raw <', () => {
  const hostile = '</script><script>window.pwned=1</script> <b>&amp;</b> a > b';
  const mutate = (st) => {
    st.items[0].title = `Breakout ${hostile}`;
    st.files[0].content = `line one\n${hostile}\nline three\n`;
    st.groups = [{ id: 'G-1', title: 'Same finding twice', round: 4, items: ['U1-401', 'SHOP-501'] }];
    st.accounts = { primary: null, list: [
      { id: 'claude-1', provider: 'claude-code', label: 'Account 1', path: '~/.claude', harness: 'u1', sync: { mode: 'independent', status: 'none', elements: [{ name: 'skills/', state: 'account-only' }] } },
      { id: 'claude-2', provider: 'claude-code', label: 'Account <2>', path: '~/.claude-2', harness: 'u1' },
    ] };
  };
  // One state file rendered twice, so both pages hold the same scores and the same timestamps.
  const { dir, p } = stage(mutate);
  const run = (channel) => {
    const out = path.join(dir, channel);
    const r = runScript('render-board.mjs', [p, '--channel', channel, '--out-dir', out]);
    assert.equal(r.code, 0, r.stderr);
    return { r, html: fs.readFileSync(path.join(out, 'board.html'), 'utf8') };
  };
  try {
    const file = run('file');
    const art = run('artifact');
    const raw = DATA_RE.exec(art.html)[1];
    const oneLine = DATA_RE.exec(file.html)[1];
    assert.ok(!oneLine.includes('\n'), 'the other channels keep the data on one line');
    assert.ok(!/[<>&]/.test(raw), 'every <, > and & in the data is written as an escape');
    assert.ok(raw.includes('\\u003c/script\\u003e'));

    // Still JSON, and exactly the data of the one-line form: the same keys in the same order.
    const boot = JSON.parse(raw);
    assert.deepEqual(boot.state, JSON.parse(fs.readFileSync(p, 'utf8')));
    assert.equal(boot.state.items[0].title, `Breakout ${hostile}`);
    assert.equal(raw.replace(/\n/g, ''), embedJson(boot), 'taking the line breaks out gives the compact form back');
    assert.equal(embedJson({ ...boot, channel: 'file' }), oneLine);

    // One line per key of the boot object, of the dictionary and of the state; one per list entry.
    const lines = raw.split('\n');
    const has = (text) => assert.ok(lines.includes(text) || lines.includes(`${text},`), `a line of its own: ${text.slice(0, 70)}`);
    assert.deepEqual([lines[0], lines[lines.length - 1]], ['{', '}']);
    for (const text of ['"lang":"en"', '"channel":"artifact"', '"t":{', '"state":{', '"schemaVersion":2', '"items":[', '"files":[', '"harnesses":[', '"accounts":{', '"primary":null', '"list":[']) has(text);
    for (const [k, v] of Object.entries(boot.t)) has(`"${k}":${embedJson(v)}`);
    for (const k of ['run', 'environment', 'mode', 'skillVersion']) has(`"${k}":${embedJson(boot.state[k])}`);
    let entries = 0;
    for (const [k, v] of Object.entries(boot.state)) {
      if (!Array.isArray(v)) continue;
      if (!v.length) { has(`"${k}":[]`); continue; }
      for (const entry of v) { has(embedJson(entry)); entries++; }
    }
    for (const account of boot.state.accounts.list) has(embedJson(account));
    assert.ok(entries >= boot.state.items.length + boot.state.files.length + boot.state.rounds.length + boot.state.harnesses.length && entries > 30, `${entries} entries`);
    assert.ok(lines.length > entries + Object.keys(boot.t).length, `${lines.length} lines`);
    // Compact inside each entry: the page grows by its line breaks and nothing else.
    assert.equal(Buffer.byteLength(raw), Buffer.byteLength(embedJson(boot)) + lines.length - 1);
    // What else differs is the shell and the two fallback texts, which name where the report is.
    const T = STRINGS.en;
    const fallbackBytes = (noscript, error) => Buffer.byteLength(noscript) + Buffer.byteLength(JSON.stringify(error));
    assert.equal(art.r.json.bytes - file.r.json.bytes, lines.length - 1 + Buffer.byteLength('artifact') - Buffer.byteLength('file')
      + fallbackBytes(T.noscriptArtifact, T.renderErrorArtifact) - fallbackBytes(T.noscript, T.renderError)
      - Buffer.byteLength('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body>\n\n</body>\n</html>'));
  } finally { rmrf(dir); }
});

test('artifact channel: when the page cannot draw itself it points at the agent, never at a file beside it', () => {
  const noscriptOf = (html) => /<noscript><p class="fatal">([^<]*)<\/p><\/noscript>/.exec(html)[1];
  const failedOf = (html) => JSON.parse(/createElement\('p'\)\)\.textContent = ("(?:[^"\\]|\\.)*");/.exec(html)[1]);
  for (const lang of ['en', 'pt']) {
    const T = STRINGS[lang];
    const art = renderHtml(fixture(), { lang, channel: 'artifact' });
    // An Artifact has no board.md next to it: the report comes from the agent.
    assert.deepEqual([noscriptOf(art), failedOf(art)], [T.noscriptArtifact, T.renderErrorArtifact]);
    for (const text of [noscriptOf(art), failedOf(art)]) {
      assert.ok(!/board\.md|this file|deste arquivo/.test(text), text);
      assert.match(text, lang === 'pt' ? /agente/ : /agent/);
      assert.ok(!/[–—]|\p{Extended_Pictographic}/u.test(text));
    }
    // A board on disk, or served from the run directory, does have board.md beside it.
    for (const channel of ['server', 'file']) {
      const doc = renderHtml(fixture(), { lang, channel });
      assert.deepEqual([noscriptOf(doc), failedOf(doc)], [T.noscript, T.renderError], channel);
      assert.ok(noscriptOf(doc).includes('board.md') && failedOf(doc).includes('board.md'));
    }
  }
  // The state alone can say it is an Artifact; the texts follow the channel the page is rendered for.
  const viaState = fixture();
  viaState.environment.channel = 'artifact';
  assert.equal(noscriptOf(renderHtml(viaState, { lang: 'en' })), STRINGS.en.noscriptArtifact);
});

test('embedJsonLines parses to what embedJson writes, whatever the shape', () => {
  const shapes = [null, 5, 'a<b', [], [1, { a: 1 }], {}, { state: {} }, { t: {}, state: [] }, { state: 'text', t: 7 },
    { lang: 'en', t: { a: 'x', b: { c: ['<'] }, gone: undefined }, state: { a: [], b: {}, c: [1, '</script>', null, undefined], d: { list: [{ x: 1 }, 2], n: 1, m: { deep: [1] } }, e: { f: { g: [1] } }, u: undefined, s: 'a&b' }, k: undefined, z: [undefined] }];
  for (const v of shapes) {
    const text = embedJsonLines(v);
    assert.equal(text.replace(/\n/g, ''), embedJson(v), JSON.stringify(v));
    assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(v)));
    assert.ok(!/[<>&]/.test(text));
  }
  assert.equal(embedJsonLines({ lang: 'en', state: { items: [{ id: 'A-1' }, { id: 'A-2' }], run: { id: 'r' }, accounts: { primary: null, list: [{ id: 'a' }] } } }),
    '{\n"lang":"en",\n"state":{\n"items":[\n{"id":"A-1"},\n{"id":"A-2"}\n],\n"run":{"id":"r"},\n"accounts":{\n"primary":null,\n"list":[\n{"id":"a"}\n]\n}\n}\n}');
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

test('board.md: a command names the rev of what it answers, and a kind that was not measured says so', () => {
  const st = fixture();
  st.items.find((i) => i.id === 'U1-101').rev = '0123456789ab';
  st.groups = [{ id: 'G-1', title: 'Same finding twice', round: 4, rev: 'ba9876543210', items: ['U1-401', 'SHOP-501'] }];
  assert.deepEqual(validateState(st, schema()), []);
  // The schema does not allow an episode count of null today; the renderer must not read one as zero.
  st.harnesses[0].impact = { windowDays: 30, sessions: 3, totalTokens: 1000, waste: [
    { kind: 'retry', episodes: 2, tokens: 100 }, { kind: 'loop', episodes: 0, tokens: 0 }, { kind: 'hook-block', episodes: null, tokens: null }, { kind: 'notfound', tokens: 0 },
  ] };
  const md = renderMarkdown(st, 'en');
  for (const s of [
    '  - `run.mjs decide --run 20260110-ab12 --target G-1 --action approve --rev ba9876543210`',
    '  - `run.mjs decide --run 20260110-ab12 --target U1-101 --action approve --rev 0123456789ab`',
    '  - `run.mjs decide --run 20260110-ab12 --target U1-401 --action approve`\n', // no rev in the state, none in the command
    '- Retries of a command that keeps failing (measured): 100, 2 episodes',
    '- no occurrences: identical calls repeated in a row',
    '- not measured: calls blocked by a hook, commands that do not exist here',
  ]) assert.ok(md.includes(s), `board.md has "${s}"`);
  assert.ok(renderMarkdown(st, 'pt').includes('- sem medição: chamadas bloqueadas por um hook, comandos que não existem aqui'));
  assert.equal(decideCommand('r1', 'A-1', 'ask', 'why "this"?', 'abcdefabcdef'), 'run.mjs decide --run r1 --target A-1 --action ask --note "why \\"this\\"?" --rev abcdefabcdef');
  assert.equal(decideCommand('r1', 'accounts.primary', 'approve', 'claude-1'), 'run.mjs decide --run r1 --target accounts.primary --action approve --note "claude-1"');
  // Only a rev reaches the command line: anything else in its place is left out.
  for (const bad of ['abc', '0123456789ab; rm -rf ~', '0123456789AB', 12, null]) assert.equal(decideCommand('r1', 'A-1', 'approve', '', bad), 'run.mjs decide --run r1 --target A-1 --action approve');
});

/**
 * The fixture as a second review (references/follow-up.md): u1 was reviewed 40 days ago and has
 * enough sessions to compare; the shop was reviewed 3 days ago, too soon to tell.
 */
function reviewedBefore(st) {
  const prev = { runId: '20251201-aa11', reviewedAt: '2025-12-01T10:00:00Z' };
  st.run.followUpOf = { ...prev };
  const u1 = st.harnesses.find((h) => h.id === 'u1');
  u1.key = 'claude-code-account-1-0a1b2c3d';
  u1.history = [
    { ...prev, score: 70.5, grade: 'C', fixed: 5, tokensPerSession: 1400000 },
    { runId: '20251101-zz00', reviewedAt: '2025-11-01T09:00:00Z', score: 58.2, grade: 'D', fixed: 2, tokensPerSession: 1500000 },
  ];
  u1.followUp = {
    of: { ...prev },
    days: 40,
    sample: { sessions: 120, enough: true },
    score: { then: 70.5, expected: 80, now: 75.1 },
    metrics: [
      { metric: 'context-at-start', unit: 'tokens/session', before: 46000, expected: 38000, after: 38200, changePct: -17, verdict: 'confirmed', items: ['U1-204', 'U1-206'] },
      { metric: 'waste:notfound', unit: 'tokens/session', before: 4400, expected: 1400, after: 2670, changePct: -39.3, verdict: 'partial', items: ['U1-703'] },
      { metric: 'tokens-per-session', before: 1400000, expected: null, after: 1350000, changePct: -3.6, verdict: 'no-change' },
      { metric: 'waste:retry', before: 9800, expected: null, after: 13592, changePct: 38.7, verdict: 'worse' },
      { metric: 'waste-share', unit: 'percent', before: 2.6, expected: null, after: 2, changePct: -23.1, verdict: 'improved' },
      { metric: 'tool-output', unit: 'chars/session', before: 96000, expected: null, after: null, changePct: null, verdict: 'not-measured' },
    ],
    items: [
      { id: 'U1-204', title: 'Style guide repeated in CLAUDE.md', round: 2, status: 'fixed', check: 'in-place', paths: ['~/.claude/CLAUDE.md'], saves: 960000 },
      { id: 'U1-206', title: 'Release checklist loaded in every session', round: 2, status: 'fixed', check: 'reverted', paths: ['~/.claude/CLAUDE.md', '~/.claude/docs/release.md'], saves: 15600, now: 'U1-202' },
      { id: 'U1-703', title: 'Alias pointed at a removed program', round: 7, status: 'fixed', check: 'changed', paths: ['~/.claude/settings.json'], saves: null },
      { id: 'U1-801', title: 'Old helper script | with a pipe', round: 8, status: 'fixed', check: 'missing', paths: ['~/.claude/scripts/helper.sh'] },
      { id: 'U1-802', title: 'Plugin updated from the command line', round: 8, status: 'fixed', check: 'not-checked' },
      { id: 'U1-101', title: 'Token inline in helper script', round: 1, status: 'declined', now: 'U1-101' },
      { id: 'U1-777', title: 'Left for later, and not found again', round: 6, status: 'deferred' },
    ],
    summary: { expectedTokensPerSession: 11000, observedTokensPerSession: -50000, inPlace: 1, reverted: 1, cameBack: 1 },
  };
  const again = st.items.find((i) => i.id === 'U1-101');
  again.previous = { run: prev.runId, item: 'U1-101' };
  again.history = { firstSeenAt: '2025-11-01T09:00:00Z', times: 2, lastStatus: 'declined', lastDecisionAt: '2025-12-01T09:30:00Z', lastNote: 'The script is going away.' };
  // A link the reviewer set, with nothing from the records yet: it is not shown.
  st.items.find((i) => i.id === 'U1-401').previous = { run: prev.runId, item: 'U1-401' };

  const shop = st.harnesses.find((h) => h.id === 'fixture-shop');
  const recent = { runId: '20260107-bb22', reviewedAt: '2026-01-07T09:00:00Z' };
  shop.history = [{ ...recent, score: 95, grade: 'A', fixed: 1, tokensPerSession: null }];
  shop.followUp = {
    of: { ...recent },
    days: 3,
    sample: { sessions: 4, enough: false, reason: 'too-few-days', readyAt: '2026-01-14T09:00:00Z' },
    score: { then: 95, expected: 97, now: 90.7 },
    // The builder may already carry a verdict: while the sample is too small it does not count.
    metrics: [{ metric: 'context-at-start', before: 50000, expected: 45000, after: 44000, changePct: -12, verdict: 'confirmed' }],
    items: [{ id: 'SHOP-402', title: 'Lint gate', round: 4, status: 'fixed', check: 'in-place', paths: ['./.githooks/pre-commit'] }],
    summary: { expectedTokensPerSession: 5000, observedTokensPerSession: -6000, inPlace: 1, reverted: 0, cameBack: 0 },
  };
  return st;
}

test('board.md: "Since the last review" per harness, with the metric table and the item checks', () => {
  const st = reviewedBefore(fixture());
  assert.deepEqual(validateState(st, schema()), []);
  applyScores(st);
  const md = renderMarkdown(st, 'en');
  const has = (text, s) => assert.ok(text.includes(s), `board.md has "${s}"`);
  has(md, 'Run: 20260110-ab12 · Follow-up of the review of 2025-12-01');
  const u1 = md.slice(md.indexOf('## Claude Code account 1'), md.indexOf('## fixture-shop'));
  for (const s of [
    // The earlier reviews, oldest first whatever order the state lists them in, ending in the score now.
    'Earlier reviews: 2025-11-01 58.2 (D) › 2025-12-01 70.5 (C) › now 79.5 (B)\n',
    '### Since the last review\n\nThe review of 2025-12-01, 40 days ago, against what was measured since. 120 sessions since then. 1 of 2 expected effects confirmed.\n',
    'Score at that review: 70.5 (C) · score that review expected: 80 (B) · score as found today: 75.1 (B)\n',
    '| Measure | Before | Expected | Now | Change | Verdict |\n|---|---|---|---|---|---|\n',
    '| Context at the start of a session (tokens per session) | 46k | 38k | 38.2k | -17% | confirmed |\n',
    '| Commands that do not exist here (tokens per session) | 4.4k | 1.4k | 2.6k | -39.3% | partly confirmed |\n',
    '| All tokens spent (tokens per session) | 1.4M | - | 1.3M | -3.6% | no change |\n',
    '| Retries of a command that keeps failing (tokens per session) | 9.8k | - | 13.5k | +38.7% | worse |\n',
    '| Share of the spend wasted (percent of the spend) | 2.6% | - | 2% | -23.1% | improved |\n',
    '| Shell output read by the agent (characters per session) | 96k | - | not measured | - | not measured |\n',
    'Expected saving, in tokens per session: 11k · measured change, in tokens per session: -50k · 1 fix still in place · 1 fix reverted · 1 fix back as a finding\n',
    '#### What that review fixed, checked on disk\n\n- **U1-204** Style guide repeated in CLAUDE.md: still in place · ~/.claude/CLAUDE.md · expected saving 960k tokens\n',
    '- **U1-206** Release checklist loaded in every session: reverted · ~/.claude/CLAUDE.md, ~/.claude/docs/release.md · expected saving 15.6k tokens · in this review: U1-202\n',
    '- **U1-703** Alias pointed at a removed program: rewritten since · ~/.claude/settings.json\n',
    '- **U1-801** Old helper script \\| with a pipe: file is gone · ~/.claude/scripts/helper.sh\n',
    '- **U1-802** Plugin updated from the command line: not checked\n',
    '#### 2 items that review left undone\n\n- **U1-101** Token inline in helper script: declined · in this review: U1-101\n- **U1-777** Left for later, and not found again: later\n',
    'Two periods are compared here, not two versions of the same work',
    'A confirmed effect is not proof that the change caused it, and a number that got worse is a lead to check, not a reason to undo the fix.\n',
    // The finding seen before says so; the one with only a link from the reviewer says nothing.
    '- **U1-101** A GitHub token sits in a helper script.\n  - History: First seen on 2025-11-01 · seen in 2 earlier reviews · declined on 2025-12-01: The script is going away.\n  - Evidence: scripts/helper.sh:3, masked\n',
  ]) has(u1, s);
  assert.equal(u1.split('History:').length - 1, 1, 'only the item the records know');
  // The block sits between the scores by round and this run's own measurement of the items.
  assert.ok(u1.indexOf('### Scores by round') < u1.indexOf('### Since the last review') && u1.indexOf('### Since the last review') < u1.indexOf('### Items by round'));

  // Too little data: no verdict counts, and the text says when the comparison will be ready.
  const shop = md.slice(md.indexOf('## fixture-shop'));
  for (const s of [
    'Earlier reviews: 2026-01-07 95 (A) › now 97.5 (A)\n',
    'The review of 2026-01-07, 3 days ago, against what was measured since. 4 sessions since then. Not enough data yet: ready to compare on 2026-01-14.\n',
    '| Context at the start of a session (tokens per session) | 50k | 45k | 44k | -12% | not enough data yet |\n',
    '- **SHOP-402** Lint gate: still in place · ./.githooks/pre-commit\n',
  ]) has(shop, s);
  assert.ok(!shop.includes('| confirmed |') && !shop.includes('expected effects confirmed'));
  assert.ok(!shop.includes('left undone'), 'no carried items, no heading for them');

  const pt = renderMarkdown(st, 'pt');
  for (const s of [
    'Acompanha a revisão de 2025-12-01',
    'Revisões anteriores: 2025-11-01 58.2 (D) › 2025-12-01 70.5 (C) › agora 79.5 (B)\n',
    '### Desde a última revisão\n\nA revisão de 2025-12-01, há 40 dias, contra o que foi medido desde então. 120 sessões desde então. 1 de 2 efeitos esperados confirmados.\n',
    '| Medida | Antes | Esperado | Agora | Mudança | Resultado |',
    '| Contexto no início da sessão (tokens por sessão) | 46 mil | 38 mil | 38,2 mil | -17% | confirmado |',
    '| Parcela do gasto que foi à toa (por cento do gasto) | 2,6% | - | 2% | -23,1% | melhorou |',
    '| Saída de terminal lida pelo agente (caracteres por sessão) | 96 mil | - | sem medição | - | sem medição |',
    '- **U1-206** Release checklist loaded in every session: desfeito · ~/.claude/CLAUDE.md, ~/.claude/docs/release.md · economia esperada 15,6 mil tokens · nesta revisão: U1-202',
    '  - Histórico: Visto pela primeira vez em 2025-11-01 · apareceu em 2 revisões anteriores · recusado em 2025-12-01: The script is going away.',
    'Ainda sem dados suficientes: pronto para comparar em 2026-01-14.',
    'Aqui são comparados dois períodos, não duas versões do mesmo trabalho',
  ]) has(pt, s);
  for (const text of [md, pt]) assert.ok(!/[–—]|\p{Extended_Pictographic}/u.test(text), 'no dash or emoji');

  // Variations: nothing expected, a reason without a date, nothing fixed, a check the state left out.
  const vary = (mutate) => { const v = reviewedBefore(fixture()); mutate(v.harnesses[0].followUp, v); return renderMarkdown(v, 'en'); };
  has(vary((fu) => { for (const m of fu.metrics) m.expected = null; }), 'against what was measured since. 120 sessions since then. No expected effect to check.\n');
  has(vary((fu) => { fu.sample = { enough: false, reason: 'too-few-sessions' }; }), 'Not enough data yet: too few sessions since the review to compare.\n');
  has(vary((fu) => { fu.sample = { enough: false }; }), 'against what was measured since. Not enough data yet.\n');
  has(vary((fu) => { fu.items = fu.items.filter((i) => i.status !== 'fixed'); }), '#### What that review fixed, checked on disk\n\nThat review fixed nothing.\n');
  has(vary((fu) => { delete fu.items[0].check; }), '- **U1-204** Style guide repeated in CLAUDE.md: not checked · ~/.claude/CLAUDE.md');
  has(vary((fu) => { fu.metrics = []; }), 'No expected effect to check.\n\nScore at that review: 70.5 (C)');
  has(vary((fu) => { fu.metrics = []; }), '\nNo measurement to compare.\n');
  const bare = vary((fu, v) => { delete fu.score; delete fu.summary; fu.metrics = []; fu.items = []; delete v.harnesses[1].followUp; });
  has(bare, '### Since the last review');
  assert.ok(!bare.includes('Score at that review') && !bare.includes('fix still in place'));
});

test('board.md: a state without any follow-up field says nothing new', () => {
  for (const [lang, words] of [['en', ['Since the last review', 'Earlier reviews', 'History:', 'Follow-up', 'Two periods are compared']], ['pt', ['Desde a última revisão', 'Revisões anteriores', 'Histórico:', 'Acompanha', 'dois períodos']]]) {
    const md = renderMarkdown(fixture(), lang);
    for (const w of words) assert.ok(!md.includes(w), `${lang}: ${w}`);
  }
  // History without a follow-up (the records exist, no comparison was built): the trail only.
  const st = fixture();
  st.harnesses[0].history = [{ runId: '20251201-aa11', reviewedAt: '2025-12-01T10:00:00Z', score: null, grade: null }];
  applyScores(st);
  const md = renderMarkdown(st, 'en');
  assert.ok(md.includes('Earlier reviews: 2025-12-01 not scored › now 79.5 (B)\n'));
  assert.ok(!md.includes('Since the last review'));
  // Apart from that one line, the text is the one a first review gets.
  const first = fixture();
  applyScores(first);
  assert.equal(md.replace('Earlier reviews: 2025-12-01 not scored › now 79.5 (B)\n\n', ''), renderMarkdown(first, 'en'));
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
    const ex = JSON.parse(before);
    const revOf = (id) => [...ex.items, ...ex.groups].find((x) => x.id === id).rev;
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
      // Each command names the revision this board shows, so it is applied only to that proposal.
      `\`run.mjs decide --run 20261120-k3x9 --target G-1 --action approve --rev ${revOf('G-1')}\``,
      `\`run.mjs decide --run 20261120-k3x9 --target LOJA-101 --action approve --rev ${revOf('LOJA-101')}\``,
      // The example is a second review: what the first one expected, and what happened since.
      'Execução: 20261120-k3x9 · Acompanha a revisão de 2026-10-18',
      'Revisões anteriores: 2026-09-14 61.5 (C) › 2026-10-18 76.4 (B) › agora 79.6 (B)',
      'A revisão de 2026-10-18, há 33 dias, contra o que foi medido desde então. 412 sessões desde então. 1 de 2 efeitos esperados confirmados.',
      '| Contexto no início da sessão (tokens por sessão) | 46 mil | 37,8 mil | 38,2 mil | -17% | confirmado |',
      '| Comandos que não existem aqui (tokens por sessão) | 4,4 mil | 1,4 mil | 2,6 mil | -39,3% | confirmado em parte |',
      '| Trabalho que você precisou corrigir (tokens por sessão) | 21,5 mil | 18,5 mil | 24,5 mil | +14,4% | piorou |',
      '- **U1-206** Checklist de release carregado em toda sessão: desfeito · ~/.claude/CLAUDE.md · economia esperada 52 mil tokens · nesta revisão: U1-202',
      '- **LOJA-303** Guia de deploy descrevia um servidor desativado: o arquivo sumiu · ./docs/deploy.md',
      'A revisão de 2026-11-16, há 4 dias, contra o que foi medido desde então. 14 sessões desde então. Ainda sem dados suficientes: pronto para comparar em 2026-11-23.',
      '  - Histórico: Visto pela primeira vez em 2026-09-14 · apareceu em 2 revisões anteriores · deixado para depois em 2026-10-18: Depois de migrar o último projeto para npm.',
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
  // Revisions: every item and the group carry one, and the decision made on the board names the one it answered.
  const withRev = [...ex.items, ...ex.groups];
  for (const x of withRev) assert.match(x.rev || '', /^[0-9a-f]{12}$/, `${x.id} has a rev`);
  assert.equal(new Set(withRev.map((x) => x.rev)).size, withRev.length, 'each rev names one proposal');
  const onBoard = ex.decisions.filter((d) => d.via === 'board');
  assert.ok(onBoard.length && onBoard.every((d) => d.rev === ex.items.find((i) => i.id === d.target).rev));
  // What cannot be told is in the example too: a hook nobody could read, a skill nobody measured.
  const elements = ex.harnesses.flatMap((h) => Object.entries(h.elements || {}));
  assert.ok(elements.some(([k, list]) => k === 'hooks' && list.some((x) => x.blocking === null)));
  assert.ok(elements.some(([k, list]) => k === 'skills' && list.some((x) => x.invocations === null)));
  for (const h of ex.harnesses) {
    const s = scoreHarness(ex, h.id);
    assert.equal(typeof s.current, 'number', `${h.id} is scored`);
    assert.ok(s.baseline <= s.current && s.current <= s.projected, `${h.id}: fixing and approving never lower the score`);
    assert.deepEqual([h.scores.baseline, h.scores.current, h.scores.projected], [s.baseline, s.current, s.projected], `${h.id}: stored scores are the computed ones`);
  }
});

test('the example follow-up is internally consistent and exercises every kind of row', () => {
  const dir = path.dirname(SCHEMA_PATH);
  const ex = JSON.parse(fs.readFileSync(path.join(dir, 'state.example.json'), 'utf8'));
  // The thresholds every verdict is read against (references/follow-up.md, "Verdicts").
  const limits = JSON.parse(fs.readFileSync(path.join(dir, '..', 'references', 'catalog', 'follow-up.json'), 'utf8'));
  const round1 = (n) => Math.round(n * 10) / 10;
  const days = (from, to) => (Date.parse(to) - Date.parse(from)) / 86400000;
  const verdictOf = (m) => {
    if (m.before === null || m.after === null) return 'not-measured';
    const pct = (m.after - m.before) / m.before * 100;
    if (m.expected !== null) {
      const share = (m.before - m.after) / (m.before - m.expected);
      if (share >= limits.confirmedShare) return 'confirmed';
      if (share >= limits.partialShare) return 'partial';
    } else if (pct < -limits.noisePct) return 'improved';
    return pct > limits.noisePct ? 'worse' : 'no-change';
  };
  /** What this run measured for a metric, per session, from the impact block of the harness. */
  const measuredNow = (h, name) => {
    const I = h.impact;
    if (!I) return null;
    const waste = (kind) => (I.waste.find((w) => w.kind === kind) || {});
    if (name === 'tokens-per-session') return Math.round(I.totalTokens / I.sessions);
    if (name === 'weighted-per-session') return Math.round(I.weightedTotal / I.sessions);
    if (name === 'context-at-start') return I.contextAtStart.perSessionMedian;
    if (name === 'context-peak') return I.contextPeak.median;
    if (name === 'waste-share') return round1(I.waste.reduce((s, w) => s + w.weighted, 0) / I.weightedTotal * 100);
    if (name.startsWith('waste:')) return Math.round(waste(name.slice(6)).tokens / I.sessions);
    return null; // tool-output is not in the state
  };

  assert.deepEqual(ex.run.followUpOf, { runId: '20261018-m4rt', reviewedAt: '2026-10-18T16:20:00Z' });
  const followed = ex.harnesses.filter((h) => h.followUp);
  assert.deepEqual(followed.map((h) => [h.id, h.kind, h.followUp.sample.enough]), [['u1', 'user', true], ['loja-web', 'project', true], ['api-pedidos', 'project', false]]);
  assert.ok(ex.harnesses.some((h) => !h.followUp && !h.history), 'a harness reviewed for the first time is in the example too');
  const verdicts = (h) => [...new Set(h.followUp.metrics.map((m) => m.verdict))].sort();
  assert.deepEqual(verdicts(followed[0]), ['confirmed', 'improved', 'no-change', 'not-measured', 'partial', 'worse']);
  assert.deepEqual(verdicts(followed[1]), ['confirmed', 'improved', 'no-change', 'not-measured', 'worse']);
  const checks = followed.flatMap((h) => h.followUp.items.filter((i) => i.status === 'fixed').map((i) => i.check));
  assert.deepEqual([...new Set(checks)].sort(), ['changed', 'in-place', 'missing', 'not-checked', 'reverted'], 'every on-disk check');
  assert.deepEqual([...new Set(followed.flatMap((h) => h.followUp.items.map((i) => i.status)))].sort(), ['declined', 'deferred', 'fixed', 'open']);

  for (const h of followed) {
    const fu = h.followUp;
    const at = `${h.id}:`;
    // The review it follows is the last one of the history, which is listed oldest first.
    assert.match(h.key, /^[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/, at);
    assert.deepEqual(h.history.map((r) => r.reviewedAt), [...h.history.map((r) => r.reviewedAt)].sort(), `${at} history oldest first`);
    const last = h.history[h.history.length - 1];
    assert.deepEqual([last.runId, last.reviewedAt, last.score], [fu.of.runId, fu.of.reviewedAt, fu.score.then], at);
    assert.equal(fu.score.now, h.scores.baseline, `${at} now is the harness as this run found it`);
    assert.ok(Math.abs(fu.days - days(fu.of.reviewedAt, ex.run.startedAt)) < 1, `${at} days since that review`);
    const fixed = fu.items.filter((i) => i.status === 'fixed');
    assert.equal(last.fixed, fixed.length, `${at} fixed items of that review`);

    if (!fu.sample.enough) {
      assert.ok(fu.days < limits.minDays, at);
      assert.equal(fu.sample.reason, 'too-few-days');
      assert.equal(days(fu.of.reviewedAt, fu.sample.readyAt), limits.minDays, `${at} ready once minDays have passed`);
      assert.deepEqual(fu.metrics, []);
    } else {
      assert.ok(fu.days >= limits.minDays && fu.sample.sessions >= limits.minSessions, at);
      assert.equal(fu.sample.sessions, h.impact.sessions, at);
    }

    // Expected = before minus the saving per session of the fixed items that named the metric.
    // The sessions of that review are not in the state: every metric must agree on one number.
    const savesOf = (ids) => ids.reduce((sum, id) => sum + fixed.find((i) => i.id === id).saves, 0);
    const sessionsThen = new Set();
    for (const m of fu.metrics) {
      const where = `${at} ${m.metric}`;
      assert.equal(m.verdict, verdictOf(m), `${where} verdict`);
      if (m.after !== null) assert.equal(m.after, measuredNow(h, m.metric), `${where} is what this run measured`);
      if (m.before !== null && m.after !== null) assert.equal(m.changePct, round1((m.after - m.before) / m.before * 100), `${where} change`);
      else assert.equal(m.changePct, null, where);
      if (m.expected === null) { assert.equal(m.items, undefined, where); continue; }
      assert.ok(m.items.length > 0 && m.expected < m.before, where);
      sessionsThen.add(savesOf(m.items) / (m.before - m.expected));
    }
    if (fu.metrics.length) {
      assert.equal(sessionsThen.size, 1, `${at} one session count behind every expectation (${[...sessionsThen]})`);
      const [n] = sessionsThen;
      assert.ok(Number.isInteger(n) && n > 0, at);
      const total = fu.metrics.find((m) => m.metric === 'tokens-per-session');
      assert.equal(total.before, last.tokensPerSession, at);
      assert.equal(fu.summary.observedTokensPerSession, total.after - total.before, at);
      assert.equal(fu.summary.expectedTokensPerSession * n, fixed.reduce((sum, i) => sum + (i.saves || 0), 0), `${at} expected saving per session`);
    }
    assert.deepEqual([fu.summary.inPlace, fu.summary.reverted, fu.summary.cameBack],
      [fixed.filter((i) => i.check === 'in-place').length, fixed.filter((i) => i.check === 'reverted').length, fixed.filter((i) => i.now).length], `${at} summary`);

    // An item that came back, or was carried, is linked both ways and has its history.
    for (const i of fu.items.filter((x) => x.now)) {
      const now = ex.items.find((x) => x.id === i.now);
      assert.ok(now && now.harness === h.id, `${at} ${i.id} names an item of this run`);
      assert.deepEqual(now.previous, { run: fu.of.runId, item: i.id }, `${at} ${i.now} points back`);
      assert.equal(now.history.lastStatus, i.status, `${at} ${i.now} was left as ${i.status}`);
      assert.ok(now.history.times >= 1 && Date.parse(now.history.firstSeenAt) <= Date.parse(fu.of.reviewedAt));
    }
  }
  // Only a finding the records know carries a history, and a reverted fix is among them.
  for (const i of ex.items) assert.equal(Boolean(i.history), Boolean(i.previous), i.id);
  assert.ok(followed.some((h) => h.followUp.items.some((i) => i.check === 'reverted' && i.now)));
  assert.ok(ex.items.some((i) => i.history && i.history.lastNote && i.history.lastDecisionAt));
  // Each expected saving of this run names where the next review will look for it.
  const metrics = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')).$defs.metric.enum;
  for (const i of ex.items.filter((x) => x.saves)) assert.ok(metrics.includes(i.saves.metric), `${i.id} saves.metric`);
});
