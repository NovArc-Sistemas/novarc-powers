import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, tmpDir, rmrf, runScript } from './helpers.mjs';
import { floor1, scoreScope, validateState, SCHEMA_PATH } from '../scripts/render-board.mjs';

function stageFixture(mutate) {
  const dir = tmpDir('hd-render-');
  const state = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'state.fixture.json'), 'utf8'));
  if (mutate) mutate(state);
  const p = path.join(dir, 'state.json');
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
  return { dir, p };
}

test('scores match the hand-computed values for the fixture', () => {
  const { dir, p } = stageFixture();
  try {
    const r = runScript('render-board.mjs', [p]);
    assert.equal(r.code, 0, r.stderr);
    const s = JSON.parse(fs.readFileSync(p, 'utf8')).scores;
    /*
      Weights: r1 20, r2 15, r3 10, r4 15, r5 5, r6 15, r7 10, r8 10.
      Points: critical 10, high 5, medium 2, low 1. Factor: open/queued/failed/in-progress 1, accepted .5, fixed/ok/wontfix 0.
      Round score = weight * (1 - min(1, cost/10)). Only `done` rounds count; total rescaled to 100.

      USER: done rounds 1 and 2 (3 not-applicable, 4 skipped, 5-8 pending) -> weight 35.
        current  r1: U-1 critical open 10 + U-2 low fixed 0 = 10 -> 20 * 0    = 0
                 r2: U-3 high accepted 2.5 + U-4 medium queued 2 + U-5 low in-progress 1 = 5.5 -> 15 * 0.45 = 6.75
                 (U-6 is in skipped round 4 -> excluded)
                 6.75 / 35 * 100 = 19.2857 -> floor to one decimal = 19.2, grade E
        baseline r1: 10 + 1 = 11 -> 0 ; r2: 5 + 2 + 1 = 8 -> 15 * 0.2 = 3 ; 3 / 35 * 100 = 8.571 -> 8.5

      PROJECT: done rounds 1, 2, 3, 4, 8 (5 skipped, 6 not-applicable, 7 pending) -> weight 70.
        current  r1: P-1 medium ok 0 -> 20 ; r2: no items -> 15 ; r3: P-2 medium failed 2 + P-3 low wontfix 0 = 2 -> 8
                 r4: P-4 high fixed 0 -> 15 ; r8: P-5 critical accepted 5 -> 5   (P-6 in skipped round 5 -> excluded)
                 63 / 70 * 100 = 90 -> grade A
        baseline r1: 2 -> 16 ; r2: 15 ; r3: 2 + 1 = 3 -> 7 ; r4: 5 -> 7.5 ; r8: 10 -> 0
                 45.5 / 70 * 100 = 65 (floating point gives 64.99999..., the epsilon in floor1 keeps it at 65)
        previous: 72 (preserved from the input state)
    */
    assert.equal(s.user.current, 19.2);
    assert.equal(s.user.baseline, 8.5);
    assert.equal(s.user.grade, 'E');
    assert.equal(s.user.roundsCounted, 2);
    assert.equal(s.user.roundsTotal, 7); // the fixture marks one user round not-applicable
    assert.equal(s.user.previous, null);
    assert.equal(s.project.current, 90);
    assert.equal(s.project.baseline, 65);
    assert.equal(s.project.grade, 'A');
    assert.equal(s.project.roundsCounted, 5);
    assert.equal(s.project.previous, 72);
    assert.match(s.project.computedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally { rmrf(dir); }
});

test('floor1 never rounds up and survives float error', () => {
  assert.equal(floor1(19.2857), 19.2);
  assert.equal(floor1((45.5 / 70) * 100), 65);
  assert.equal(floor1(89.99), 89.9);
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
  const { dir, p } = stageFixture();
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

test('the template example state validates and scores', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const exPath = path.join(path.dirname(SCHEMA_PATH), 'state.example.json');
  if (!fs.existsSync(exPath)) return; // owned by another author; may not exist yet
  const ex = JSON.parse(fs.readFileSync(exPath, 'utf8'));
  assert.deepEqual(validateState(ex, schema), []);
  for (const scope of ex.scopes) scoreScope(ex, scope);
});

// ---------------------------------------------------------------------------------------------
// Localised chrome
// ---------------------------------------------------------------------------------------------

function renderBoards(mutate, args = []) {
  const { dir, p } = stageFixture(mutate);
  const r = runScript('render-board.mjs', [p, ...args]);
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  return { dir, p, r, read };
}

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
      '{n} de {m} itens', 'tokens por sessão', 'revisão guiada']) {
      assert.ok(html.includes(s), `board.html has "${s}"`);
    }
    for (const s of ['## Notas', 'Segurança e permissões', '| projeto | sem nota |', '## Pistas não confirmadas', 'Modo: revisão guiada',
      '| crítica |', '| aberto |', 'concluída', 'não se aplica', 'Rodada 1: Segurança e permissões', 'tokens por sessão']) {
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
