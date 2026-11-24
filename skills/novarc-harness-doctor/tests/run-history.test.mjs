// Review records (references/follow-up.md): what `run.mjs close` leaves under history/ for every
// harness of a run, `run.mjs history`, `history --write`, the rewrite after `undo`, and how
// `init` starts the follow-up of an earlier run. Every command is a real run.mjs process over a
// temporary home; the clock is NOVARC_HD_NOW.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sandbox, item, clock, historyOf, measured, writeImpact, firstReview, FIRST, filesContaining, together } from './run-helpers.mjs';
import { SKILL_DIR } from './helpers.mjs';
import { itemRev } from '../scripts/lib/run/rev.mjs';
import { validateRecord, harnessHash } from '../scripts/lib/run/followup.mjs';
import { recordMarkdown, historyText } from '../scripts/lib/run/text.mjs';

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const SKILL_VERSION = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'skill.json'), 'utf8')).version;
const one = (t) => sandbox(t, { accounts: 0, projects: ['acme-shop'] });
const ROUNDS_79 = [{ round: 1, status: 'done', score: 79 }, ...[2, 3, 4, 5, 6, 7, 8].map((round) => ({ round, status: 'pending', score: null }))];
const METRICS = { 'tokens-per-session': 100000, 'weighted-per-session': 20000, 'context-at-start': 50000, 'context-peak': 120000, 'waste-share': 5, 'waste:retry': 5000, 'tool-output': 40000 };
const MEASURE = {
  window: { from: '2025-12-11T10:00:00.000Z', to: '2026-01-10T10:00:00.000Z', days: 30 }, sessions: 20, activeDays: 12, metrics: METRICS,
  // The share of waste on both bases, and which one `waste-share` is.
  wasteShare: { base: 'weighted', weighted: 5, raw: 5 },
  unused: { skills: ['alpha'], mcpServers: [] }, coverage: { claude: 'complete', codex: 'not-read' },
};
/** Start a run from the sandbox's selection at `at`; remembers it as the current run. */
function start(sb, at, args = [], selection = sb.selection) {
  const file = path.join(sb.home, `selection-${at.replace(/\W/g, '')}.json`);
  fs.writeFileSync(file, JSON.stringify(selection));
  const r = sb.run(['init', '--select', file, ...args], clock(at));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  sb.runId = r.json.runId;
  sb.dir = r.json.dir;
  return r.json;
}

test('close writes the record, the .md and the index: exactly what was decided and applied', (t) => {
  const sb = one(t);
  const first = firstReview(sb, { close: false });
  const history = historyOf(sb);
  assert.deepEqual(history.keys(), [], 'nothing is recorded before the run is closed');

  const closed = sb.run(['close'], clock(FIRST.closed));
  assert.equal(closed.code, 0, closed.stdout + closed.stderr);
  const key = first.key;
  assert.match(key, /^acme-shop-[0-9a-f]{8}$/);
  assert.deepEqual(closed.json, {
    runId: first.runId, closed: true, closedAt: FIRST.closed, historyDir: history.dir,
    records: [{ harness: 'acme-shop', harnessKey: key, file: `${key}/${first.runId}.json`, md: `${key}/${first.runId}.md`, items: 4, fixed: 1, written: true }],
  });
  assert.deepEqual(history.keys(), [key]);
  assert.deepEqual(history.files(key), [`${first.runId}.json`, `${first.runId}.md`]);

  const [f101, f102, f103, f104] = first.findings.items;
  const record = history.record(key, first.runId);
  assert.deepEqual(record, {
    schema: 1, skillVersion: SKILL_VERSION, harnessKey: key, runId: first.runId, language: 'en', mode: 'guided',
    kind: 'project', provider: null, name: 'acme-shop', path: '~/dev/acme-shop',
    startedAt: FIRST.started, reviewedAt: FIRST.closed, changesAppliedAt: FIRST.fixed, followUpAfter: '2026-02-09T12:00:00.000Z',
    // Found: 5 + 2 + 15 + 5 points lost. Left: the fixed one costs nothing, the declined one half.
    scores: { baseline: 73, current: 79, projected: 79, grade: 'B', rounds: ROUNDS_79 },
    measure: MEASURE,
    elements: {},
    items: [
      {
        id: 'ACME-101', rev: itemRev(f101), round: 1, severity: 'medium', class: 'reversible', title: 'Finding ACME-101', status: 'fixed', proposal: 'What to change.',
        decision: { action: 'approve', at: FIRST.decided, note: 'yes, do it' }, fixedAt: FIRST.fixed, verified: 'Read the file back.', principle: 'The rule to keep.',
        saves: { tokens: 200000, basis: 'measured', metric: 'context-at-start', how: 'Loaded in every session.' },
        changes: [{ path: './CLAUDE.md', before: 'line one', after: 'line one, improved', hashAfter: sha('# Rules\nline one, improved\nline two\n') }],
      },
      {
        id: 'ACME-102', rev: itemRev(f102), round: 1, severity: 'low', class: 'additive', title: 'Finding ACME-102', status: 'declined', proposal: 'What to change.',
        decision: { action: 'decline', at: FIRST.decided, note: 'not now' }, principle: 'The rule to keep.',
        changes: [{ path: './AGENTS.md', before: '', after: 'A new rule.\n' }],
      },
      { id: 'ACME-103', rev: itemRev(f103), round: 1, severity: 'high', class: 'reversible', title: 'Finding ACME-103', status: 'deferred', file: './settings.json', proposal: 'What to change.', decision: { action: 'defer', at: FIRST.decided }, principle: 'The rule to keep.' },
      { id: 'ACME-104', rev: itemRev(f104), round: 1, severity: 'medium', class: 'reversible', title: 'Finding ACME-104', status: 'open', file: './README.md', proposal: 'What to change.', principle: 'The rule to keep.' },
    ],
  });
  assert.deepEqual(validateRecord(record), [], 'the record fits templates/record.schema.json');
  // Every item keeps what its revision is made of, whatever its status: the next review can tell
  // from the record alone whether a proposal is the one the user already answered.
  for (const i of record.items) {
    assert.equal(itemRev({ harness: 'acme-shop', class: i.class, file: i.file, proposal: i.proposal, changes: i.changes }), i.rev, `${i.id}: the record holds what its rev is a hash of`);
  }
  assert.ok(!('hashAfter' in record.items[1].changes[0]), 'only a change that was applied has the hash of its file');

  assert.equal(history.md(key, first.runId), [
    '# Review of acme-shop, 2026-01-10',
    '',
    '- Harness: acme-shop (project harness), `~/dev/acme-shop`',
    `- Run: ${first.runId}, started 2026-01-10`,
    '- Score: 73 as found, 79 after this review, 79 once what was approved is applied (grade B)',
    '- Last change applied: 2026-01-10',
    '- Follow-up from: 2026-02-09',
    '',
    '## Measured',
    '',
    '30 days, 20 sessions. Every number is per session.',
    '',
    '| Measure | Value |',
    '|---|---|',
    '| All tokens spent (tokens per session) | 100k |',
    '| Relative cost (tokens per session) | 20k |',
    '| Context at the start of a session (tokens per session) | 50k |',
    '| Context peak of a session (tokens per session) | 120k |',
    '| Share of the spend wasted (percent of the spend) | 5% |',
    '| Retries of a command that keeps failing (tokens per session) | 5k |',
    '| Shell output read by the agent (characters per session) | 40k |',
    '',
    '## Fixed (1)',
    '',
    '- **ACME-101** Finding ACME-101 (medium, reversible)',
    '  - Decision: approved on 2026-01-10. "yes, do it"',
    '  - Fixed on 2026-01-10.',
    '  - Verified: Read the file back.',
    '  - Expected saving: 200k tokens (measured); the next review checks it in: Context at the start of a session',
    '  - To carry forward: The rule to keep.',
    '  - Changed: `./CLAUDE.md`',
    '',
    '## Declined (1)',
    '',
    '- **ACME-102** Finding ACME-102 (low, additive)',
    '  - Decision: declined on 2026-01-10. "not now"',
    '  - To carry forward: The rule to keep.',
    '',
    '## Deferred (1)',
    '',
    '- **ACME-103** Finding ACME-103 (high, reversible)',
    '  - Decision: deferred on 2026-01-10.',
    '  - To carry forward: The rule to keep.',
    '',
    '## Open (1)',
    '',
    '- **ACME-104** Finding ACME-104 (medium, reversible)',
    '  - To carry forward: The rule to keep.',
    '',
  ].join('\n'));

  // The index: the one place that keeps the absolute path of the harness.
  assert.deepEqual(history.index(), {
    schema: 1,
    harnesses: {
      [key]: {
        kind: 'project', provider: null, name: 'acme-shop', path: '~/dev/acme-shop', pathAbs: path.join(sb.home, 'dev', 'acme-shop'),
        reviews: [{ runId: first.runId, reviewedAt: FIRST.closed, file: `${first.runId}.json`, score: 79, grade: 'B', fixed: 1, followUpAfter: '2026-02-09T12:00:00.000Z' }],
      },
    },
  });
  for (const name of history.files(key)) {
    const text = fs.readFileSync(path.join(history.dir, key, name), 'utf8');
    for (const spelling of [sb.home, sb.home.replace(/\\/g, '\\\\'), sb.home.replace(/\\/g, '/')]) assert.ok(!text.includes(spelling), `${name} holds display paths only`);
  }
  assert.deepEqual(fs.readdirSync(history.dir).filter((n) => /\.tmp$/.test(n) || n === '.mutex'), [], 'no temp file and no lock is left behind');

  // Closing again changes nothing: same bytes, same moment.
  const before = history.files(key).map((n) => fs.readFileSync(path.join(history.dir, key, n), 'utf8')).join('') + fs.readFileSync(path.join(history.dir, 'index.json'), 'utf8');
  const again = sb.run(['close'], clock('2026-01-15T09:00:00.000Z'));
  assert.equal(again.code, 0, again.stdout);
  assert.deepEqual({ already: again.json.already, closedAt: again.json.closedAt, written: again.json.records.map((r) => r.written) }, { already: true, closedAt: FIRST.closed, written: [false] });
  assert.equal(history.files(key).map((n) => fs.readFileSync(path.join(history.dir, key, n), 'utf8')).join('') + fs.readFileSync(path.join(history.dir, 'index.json'), 'utf8'), before);
  assert.ok(!sb.exists('state.json'), 'close reads the run directory itself: it needs no board, and writes none');
});

test('a run where nothing was approved still leaves a record; a harness that was not measured says why; Portuguese', (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop', 'novarc-powers'] });
  start(sb, FIRST.started, ['--lang', 'pt']);
  // acme-shop: measured without a peak and without shell output. novarc-powers: its sessions cannot be read.
  const { contextPeak: _peak, toolOutput: _output, coverage: _coverage, ...partly } = measured();
  writeImpact(sb, 'acme-shop', partly);
  fs.writeFileSync(sb.file('probes', 'summary.json'), JSON.stringify({ version: 1, harnesses: { 'novarc-powers': { impact: { skipped: 'no-transcript-reader' } } } }));
  assert.equal(sb.complete('review:security', { rounds: [{ harness: 'acme-shop', round: 1, status: 'done' }], items: [item('ACME-101', 'acme-shop', 1), item('ACME-102', 'acme-shop', 1, { status: 'ok', changes: undefined, file: './CLAUDE.md' })] }).code, 0);
  const closed = sb.run(['close'], clock(FIRST.closed));
  assert.equal(closed.code, 0, closed.stdout + closed.stderr);
  assert.deepEqual(closed.json.records.map((r) => [r.harness, r.items, r.fixed, r.written]), [['acme-shop', 2, 0, true], ['novarc-powers', 0, 0, true]]);

  const history = historyOf(sb);
  const [acmeKey, npKey] = closed.json.records.map((r) => r.harnessKey);
  const acme = history.record(acmeKey, sb.runId);
  assert.equal(acme.changesAppliedAt, null);
  assert.deepEqual(acme.items.map((i) => [i.id, i.status, 'decision' in i]), [['ACME-101', 'open', false], ['ACME-102', 'ok', false]], 'every item goes in, whatever its status');
  // The baseline counts every item as if it were open, the one that is fine too.
  assert.deepEqual(acme.scores, { baseline: 90, current: 95, projected: 95, grade: 'A', rounds: [{ round: 1, status: 'done', score: 95 }, ...ROUNDS_79.slice(1)] });
  // A metric that was not measured is absent, never 0.
  assert.deepEqual(acme.measure.metrics, { 'tokens-per-session': 100000, 'weighted-per-session': 20000, 'context-at-start': 50000, 'waste-share': 5, 'waste:retry': 5000 });
  assert.ok(!('coverage' in acme.measure));

  const np = history.record(npKey, sb.runId);
  assert.deepEqual({ measure: np.measure, measureSkipped: np.measureSkipped, items: np.items, scores: np.scores.current }, { measure: null, measureSkipped: 'no-transcript-reader', items: [], scores: null });
  assert.deepEqual(validateRecord(np), []);
  assert.deepEqual(Object.keys(history.index().harnesses), [acmeKey, npKey].sort());

  // The same record to read, in the language of the run: names and numbers as a person reads them.
  assert.equal(history.md(acmeKey, sb.runId), [
    '# Revisão de acme-shop, 2026-01-10',
    '',
    '- Harness: acme-shop (harness de projeto), `~/dev/acme-shop`',
    `- Execução: ${sb.runId}, iniciada em 2026-01-10`,
    '- Nota: 90 como foi encontrado, 95 depois desta revisão, 95 quando o que foi aprovado estiver aplicado (conceito A)',
    '- Nenhuma mudança foi aplicada.',
    '- Acompanhamento a partir de: 2026-02-09',
    '',
    '## Medido',
    '',
    '30 dias, 20 sessões. Todo número é por sessão.',
    '',
    '| Medida | Valor |',
    '|---|---|',
    '| Todos os tokens gastos (tokens por sessão) | 100 mil |',
    '| Custo relativo (tokens por sessão) | 20 mil |',
    '| Contexto no início da sessão (tokens por sessão) | 50 mil |',
    '| Parcela do gasto que foi à toa (por cento do gasto) | 5% |',
    '| Repetições de um comando que continua falhando (tokens por sessão) | 5 mil |',
    '',
    '## Em aberto (1)',
    '',
    '- **ACME-101** Finding ACME-101 (média, reversível)',
    '  - Para levar: The rule to keep.',
    '',
    '## Nada a mudar (1)',
    '',
    '- **ACME-102** Finding ACME-102 (média, reversível)',
    '  - Para levar: The rule to keep.',
    '',
  ].join('\n'));
  assert.deepEqual(history.md(npKey, sb.runId).split('\n').slice(8), ['## Medido', '', 'A skill ainda não lê as sessões deste agente.', '', 'Nenhum item nesta revisão.', '']);
  assert.ok(history.md(npKey, sb.runId).split('\n').includes('- Nota: sem nota'));

  // Never probed at all: not measured, and it still closes.
  start(sb, '2026-01-11T10:00:00.000Z', [], { ...sb.selection, projects: [sb.selection.projects[1]] });
  const bare = sb.run(['close'], clock('2026-01-11T11:00:00.000Z'));
  assert.equal(bare.code, 0, bare.stdout + bare.stderr);
  const second = history.record(npKey, sb.runId);
  assert.deepEqual({ measure: second.measure, measureSkipped: second.measureSkipped }, { measure: null, measureSkipped: 'not-measured' });
  assert.deepEqual(history.index().harnesses[npKey].reviews.map((r) => [r.reviewedAt, r.score, r.fixed]), [[FIRST.closed, null, 0], ['2026-01-11T11:00:00.000Z', null, 0]], 'reviews are listed oldest first');
});

test('the key of a harness: the same for the same folder in every run, another for another folder with the same name', (t) => {
  const sb = sandbox(t, { accounts: 1, projects: ['acme-shop'] });
  const twin = path.join(sb.home, 'other', 'acme-shop');
  fs.mkdirSync(twin, { recursive: true });
  const selection = { ...sb.selection, projects: [...sb.selection.projects, { name: 'acme-shop', path: '~/other/acme-shop', pathAbs: twin }] };
  const a = start(sb, FIRST.started, [], selection);
  const keys = Object.fromEntries(a.harnesses.map((h) => [h.id, h.harnessKey]));
  assert.deepEqual(Object.keys(keys), ['claude-1', 'acme-shop', 'acme-shop-2']);
  assert.match(keys['acme-shop'], /^acme-shop-[0-9a-f]{8}$/);
  assert.match(keys['acme-shop-2'], /^acme-shop-[0-9a-f]{8}$/);
  assert.notEqual(keys['acme-shop'], keys['acme-shop-2'], 'two folders with the same name are two harnesses');
  assert.match(keys['claude-1'], /^claude-code-account-1-[0-9a-f]{8}$/);
  // The 8 hex characters: SHA-256 over kind, provider and the real path (lower-cased on Windows), joined by line feeds.
  const real = (p) => (process.platform === 'win32' ? fs.realpathSync.native(p).toLowerCase() : fs.realpathSync.native(p));
  const hash = (kind, provider, abs) => sha(`${kind}\n${provider}\n${real(abs)}`).slice(0, 8);
  assert.equal(keys['acme-shop'], `acme-shop-${hash('project', '', path.join(sb.home, 'dev', 'acme-shop'))}`);
  assert.equal(keys['claude-1'], `claude-code-account-1-${hash('user', 'claude-code', path.join(sb.home, '.claude'))}`);
  assert.equal(harnessHash({ kind: 'project', pathAbs: twin }), keys['acme-shop-2'].slice(-8));
  assert.deepEqual(sb.read('run.json').harnesses.slice(0, 2).map((h) => [h.id, h.key, h.harnessKey]), [['claude-1', 'U1', keys['claude-1']], ['acme-shop', 'ACME', keys['acme-shop']]], 'run.json keeps both: the item prefix and the stable key');
  assert.equal(sb.read('run.json').harnesses[2].harnessKey, keys['acme-shop-2']);
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  assert.deepEqual(sb.read('state.json').harnesses.map((h) => h.key), [keys['claude-1'], keys['acme-shop'], keys['acme-shop-2']]);
  assert.equal(sb.run(['close'], clock(FIRST.closed)).code, 0);
  assert.deepEqual(historyOf(sb).keys(), Object.values(keys).sort());

  // Another run, months later, in another language: the account's label changed, its folder did not.
  const relabelled = { ...selection, accounts: [{ ...selection.accounts[0], label: 'Claude Code · conta 1' }], projects: [selection.projects[0]] };
  const b = start(sb, '2026-04-01T10:00:00.000Z', ['--lang', 'pt'], relabelled);
  assert.deepEqual(b.harnesses.map((h) => [h.id, h.name, h.harnessKey]), [['claude-1', 'Claude Code · conta 1', keys['claude-1']], ['acme-shop', 'acme-shop', keys['acme-shop']]]);
  assert.deepEqual(b.harnesses.map((h) => h.followUp && h.followUp.runId), [a.runId, a.runId], 'so both are found again as reviewed before');
});

test('history: what was reviewed, when, and whether the follow-up is due', (t) => {
  const sb = one(t);
  const none = sb.run(['history']);
  assert.deepEqual([none.code, none.stdout], [0, 'No review recorded yet.\n']);
  assert.deepEqual(sb.run(['history', '--json']).json.harnesses, []);

  const first = firstReview(sb);
  const line = `acme-shop (project harness) ~/dev/acme-shop [${first.key}]`;
  const review = `  2026-01-10  run ${first.runId}  score 79 (B)  1 fixed  expected saving 200k tokens`;
  // Ten days later the follow-up is not due; it is from the moment followUpAfter passes.
  const early = sb.run(['history'], clock('2026-01-20T12:00:00.000Z'));
  assert.equal(early.code, 0, early.stderr);
  // It applied a change, so until then an experiment is open on it (the change is what is measured).
  assert.equal(early.stdout, ['Review history: 1 harness', '', line, review, '  Follow-up from 2026-02-09 (in 20 days).', '  Experiment in progress until 2026-02-09: the changes applied on 2026-01-10.', ''].join('\n'));
  assert.equal(sb.run(['history'], clock('2026-02-09T11:59:59.000Z')).stdout.split('\n')[4], '  Follow-up from 2026-02-09 (in 1 day).');
  const due = sb.run(['history'], clock('2026-02-09T12:00:00.000Z'));
  assert.equal(due.stdout, ['Review history: 1 harness', '', line, review, '  Follow-up due since 2026-02-09.', ''].join('\n'));
  assert.equal(sb.run(['history', '--lang', 'pt'], clock('2026-02-20T12:00:00.000Z')).stdout, [
    'Histórico de revisões: 1 harness', '',
    `acme-shop (harness de projeto) ~/dev/acme-shop [${first.key}]`,
    `  2026-01-10  execução ${first.runId}  nota 79 (B)  1 corrigido  economia esperada 200 mil tokens`,
    '  Acompanhamento pendente desde 2026-02-09.', '',
  ].join('\n'));
  assert.equal(sb.run(['history', '--lang', 'pt'], clock('2026-01-20T12:00:00.000Z')).stdout.split('\n')[4], '  Acompanhamento a partir de 2026-02-09 (em 20 dias).');

  const json = (at, ...args) => sb.run(['history', '--json', ...args], clock(at)).json;
  assert.deepEqual(json('2026-01-20T12:00:00.000Z'), {
    historyDir: historyOf(sb).dir,
    at: '2026-01-20T12:00:00.000Z',
    harnesses: [{
      key: first.key, kind: 'project', provider: null, name: 'acme-shop', path: '~/dev/acme-shop',
      reviews: [{ runId: first.runId, reviewedAt: FIRST.closed, score: 79, grade: 'B', fixed: 1, expectedTokens: 200000, followUpAfter: '2026-02-09T12:00:00.000Z', mode: 'guided' }],
      followUpAfter: '2026-02-09T12:00:00.000Z', due: false,
      experiment: { since: '2026-01-10T11:31:00.000Z', until: '2026-02-09T12:00:00.000Z', runId: first.runId },
    }],
    due: [],
    experiments: [{ harness: first.key, name: 'acme-shop', since: '2026-01-10T11:31:00.000Z', until: '2026-02-09T12:00:00.000Z', runId: first.runId }],
    unrecordedRuns: [],
  });
  const later = json('2026-02-10T00:00:00.000Z');
  assert.deepEqual([later.harnesses[0].due, later.due], [true, [first.key]]);

  // One harness, by key, by display path or by its folder.
  for (const wanted of [first.key, '~/dev/acme-shop', path.join(sb.home, 'dev', 'acme-shop')]) {
    assert.deepEqual(json('2026-01-20T12:00:00.000Z', '--harness', wanted).harnesses.map((h) => h.key), [first.key], wanted);
  }
  assert.deepEqual(json('2026-01-20T12:00:00.000Z', '--harness', path.join(sb.home, 'dev', 'elsewhere')).harnesses, []);
  assert.equal(sb.run(['history', '--harness', 'nothing-00000000']).stdout, 'No review recorded for that harness.\n');
  const printed = sb.run(['history', '--json'], clock('2026-01-20T12:00:00.000Z')).stdout;
  assert.ok(!printed.includes(path.join(sb.home, 'dev').replace(/\\/g, '\\\\')), 'the folder of a harness is never printed');

  assert.equal(sb.run(['history', '--run', first.runId]).code, 2, '--run goes with --write');
  assert.equal(sb.run(['history', '--lang', 'fr']).code, 2);
  assert.equal(sb.run(['history', '--json', 'yes']).code, 2);
  assert.equal(sb.run(['history', '--write', '--json']).code, 2);
  assert.equal(sb.run(['history', '--harness']).code, 2);
});

test('history speaks the language of the latest run; history --write records a run that stays open', (t) => {
  const sb = one(t);
  const first = firstReview(sb, { close: false, initArgs: ['--lang', 'pt'] });
  const history = historyOf(sb);
  assert.equal(sb.run(['history']).stdout, 'Nenhuma revisão registrada ainda.\n');
  assert.equal(sb.run(['history', '--lang', 'en']).stdout, 'No review recorded yet.\n');

  const written = sb.run(['history', '--write'], clock('2026-01-10T11:45:00.000Z'));
  assert.equal(written.code, 0, written.stdout + written.stderr);
  assert.deepEqual(written.json, {
    runId: first.runId, closed: false, historyDir: history.dir,
    records: [{ harness: 'acme-shop', harnessKey: first.key, file: `${first.key}/${first.runId}.json`, md: `${first.key}/${first.runId}.md`, items: 4, fixed: 1, written: true }],
  });
  assert.equal(sb.read('run.json').closed, false, 'the run stays open');
  assert.deepEqual([history.record(first.key, first.runId).reviewedAt, history.record(first.key, first.runId).followUpAfter], ['2026-01-10T11:45:00.000Z', '2026-02-09T11:45:00.000Z']);
  assert.ok(history.md(first.key, first.runId).startsWith('# Revisão de acme-shop, 2026-01-10\n'));

  // Closing is when the review ends: the record takes that moment, and keeps it from then on.
  assert.equal(sb.run(['close'], clock(FIRST.closed)).code, 0);
  assert.equal(history.record(first.key, first.runId).reviewedAt, FIRST.closed);
  const after = sb.run(['history', '--write', '--run', first.runId], clock('2026-01-12T08:00:00.000Z'));
  assert.deepEqual([after.json.closed, after.json.records.map((r) => r.written)], [true, [false]]);
  assert.equal(history.record(first.key, first.runId).reviewedAt, FIRST.closed);
  assert.deepEqual(history.index().harnesses[first.key].reviews.map((r) => r.reviewedAt), [FIRST.closed], 'one review, however often it is written');
  assert.equal(sb.run(['history', '--write', '--run', '20200101-none']).code, 1);
});

test('undo after close rewrites the record: it never claims a change that was undone', (t) => {
  const sb = one(t);
  const first = firstReview(sb);
  const history = historyOf(sb);
  assert.equal(history.record(first.key, first.runId).items[0].status, 'fixed');

  const dry = sb.run(['undo', '--item', 'ACME-101', '--dry-run'], clock('2026-01-12T09:00:00.000Z'));
  assert.ok(!('records' in dry.json), 'a dry run writes nothing');
  assert.equal(history.record(first.key, first.runId).items[0].status, 'fixed');

  const undo = sb.run(['undo', '--item', 'ACME-101', '--yes'], clock('2026-01-12T10:00:00.000Z'));
  assert.equal(undo.code, 0, undo.stdout + undo.stderr);
  assert.deepEqual(undo.json.flipped, ['ACME-101']);
  assert.deepEqual(undo.json.records, [{ harness: 'acme-shop', harnessKey: first.key, file: `${first.key}/${first.runId}.json`, md: `${first.key}/${first.runId}.md`, items: 4, fixed: 0, written: true }]);
  assert.equal(fs.readFileSync(first.file, 'utf8'), '# Rules\nline one\nline two\n');

  const record = history.record(first.key, first.runId);
  assert.deepEqual(record.items[0], {
    id: 'ACME-101', rev: itemRev(first.findings.items[0]), round: 1, severity: 'medium', class: 'reversible', title: 'Finding ACME-101', status: 'approved', proposal: 'What to change.',
    decision: { action: 'approve', at: FIRST.decided, note: 'yes, do it' }, principle: 'The rule to keep.',
    saves: { tokens: 200000, basis: 'measured', metric: 'context-at-start', how: 'Loaded in every session.' },
    changes: [{ path: './CLAUDE.md', before: 'line one', after: 'line one, improved' }],
  }, 'approved again: the change as proposed, with no hash of an applied file, no fixedAt and nothing verified');
  assert.deepEqual({ reviewedAt: record.reviewedAt, changesAppliedAt: record.changesAppliedAt, followUpAfter: record.followUpAfter }, { reviewedAt: FIRST.closed, changesAppliedAt: null, followUpAfter: '2026-02-09T12:00:00.000Z' }, 'the review still ended when it was closed');
  // What is approved but not applied counts in full now, and as fixed in the projection.
  assert.deepEqual({ baseline: record.scores.baseline, current: record.scores.current, projected: record.scores.projected, grade: record.scores.grade }, { baseline: 73, current: 74, projected: 79, grade: 'C' });
  assert.deepEqual(history.index().harnesses[first.key].reviews, [{ runId: first.runId, reviewedAt: FIRST.closed, file: `${first.runId}.json`, score: 74, grade: 'C', fixed: 0, followUpAfter: '2026-02-09T12:00:00.000Z' }]);
  const md = history.md(first.key, first.runId).split('\n');
  assert.ok(md.includes('- No change was applied.') && md.includes('## Approved, not applied yet (1)') && !md.includes('## Fixed (1)'), md.join('\n'));

  // A run that left no record gets none from undo.
  const other = one(t);
  const open = firstReview(other, { close: false });
  const quiet = other.run(['undo', '--item', 'ACME-101', '--yes']);
  assert.equal(quiet.code, 0, quiet.stdout);
  assert.ok(!('records' in quiet.json));
  assert.deepEqual(historyOf(other).keys(), []);
  assert.ok(open.runId);
});

test('whatever changes a status after the run was closed reaches the record: a decision, an applied change', (t) => {
  const sb = one(t);
  const first = firstReview(sb);
  const history = historyOf(sb);
  const itemOf = (id) => history.record(first.key, first.runId).items.find((i) => i.id === id);
  const wrote = (r) => (r.json.records || []).map((x) => [x.harness, x.fixed, x.written]);

  // The next day the user approves one more item in chat...
  const decided = sb.run(['decide', '--target', 'ACME-104', '--action', 'approve'], clock('2026-01-11T09:00:00.000Z'));
  assert.equal(decided.code, 0, decided.stdout + decided.stderr);
  assert.deepEqual(wrote(decided), [['acme-shop', 1, true]]);
  assert.deepEqual([itemOf('ACME-104').status, itemOf('ACME-104').decision], ['approved', { action: 'approve', at: '2026-01-11T09:00:00.000Z' }]);
  // ...and declines, on the board, what had been left for later.
  const late = path.join(sb.home, 'late-decisions.json');
  fs.writeFileSync(late, JSON.stringify([{ id: 'late-103', at: '2026-01-11T09:05:00.000Z', target: 'ACME-103', action: 'decline', note: 'never mind', rev: itemRev(first.findings.items[2]) }]));
  const ingested = sb.run(['decisions', '--ingest', late], clock('2026-01-11T09:05:00.000Z'));
  assert.deepEqual(wrote(ingested), [['acme-shop', 1, true]]);
  assert.deepEqual([itemOf('ACME-103').status, itemOf('ACME-103').decision], ['declined', { action: 'decline', at: '2026-01-11T09:05:00.000Z', note: 'never mind' }]);
  assert.ok(history.md(first.key, first.runId).split('\n').includes('  - Decision: declined on 2026-01-11. "never mind"'));
  // A decision that changes nothing writes nothing.
  const stale = sb.run(['decide', '--target', 'ACME-102', '--action', 'approve', '--rev', '0123456789ab'], clock('2026-01-10T10:30:00.000Z'));
  assert.deepEqual([stale.json.new[0].result, 'records' in stale.json], ['stale', false]);
  const unknown = sb.run(['decide', '--target', 'ZZ-101', '--action', 'approve']);
  assert.ok(!('records' in unknown.json));

  // Then the approved item is applied.
  const started = sb.run(['mark', '--item', 'ACME-104', '--status', 'in-progress'], clock('2026-01-11T09:10:00.000Z'));
  assert.equal(started.code, 0, started.stdout);
  assert.deepEqual(wrote(started), [['acme-shop', 1, true]]);
  assert.equal(itemOf('ACME-104').status, 'in-progress');
  const readme = path.join(sb.home, 'dev', 'acme-shop', 'README.md');
  fs.writeFileSync(readme, '# acme-shop\n');
  const recorded = sb.run(['record', '--item', 'ACME-104', '--path', readme, '--new'], clock('2026-01-11T09:20:00.000Z'));
  assert.equal(recorded.code, 0, recorded.stdout);
  assert.ok(Array.isArray(recorded.json.records));
  const fixed = sb.run(['mark', '--item', 'ACME-104', '--status', 'fixed', '--verified', 'The file is there.'], clock('2026-01-11T09:21:00.000Z'));
  assert.deepEqual(wrote(fixed), [['acme-shop', 2, true]]);

  const record = history.record(first.key, first.runId);
  assert.deepEqual({ status: itemOf('ACME-104').status, fixedAt: itemOf('ACME-104').fixedAt, verified: itemOf('ACME-104').verified }, { status: 'fixed', fixedAt: '2026-01-11T09:21:00.000Z', verified: 'The file is there.' });
  assert.deepEqual({ reviewedAt: record.reviewedAt, changesAppliedAt: record.changesAppliedAt, followUpAfter: record.followUpAfter }, { reviewedAt: FIRST.closed, changesAppliedAt: '2026-01-11T09:21:00.000Z', followUpAfter: '2026-02-09T12:00:00.000Z' }, 'the review ended when it was closed; its last change is later');
  // Two fixed, two declined (1 and 7.5 points): 91.5.
  assert.deepEqual(history.index().harnesses[first.key].reviews.map((r) => [r.score, r.grade, r.fixed]), [[91.5, 'A', 2]]);
  assert.deepEqual(validateRecord(record), []);
  // The next review counts its days from that last change.
  const next = sb.run(['init', '--follow-up', first.runId, '--days', '90'], clock('2026-02-11T09:20:00.000Z'));
  assert.deepEqual(next.json.harnesses[0].followUp, { runId: first.runId, reviewedAt: FIRST.closed, days: 30, windowDays: 30 });

  // A run that left no record gets none from any of them.
  const other = one(t);
  firstReview(other, { close: false });
  const quiet = [
    other.run(['decide', '--target', 'ACME-104', '--action', 'approve']),
    other.run(['mark', '--item', 'ACME-104', '--status', 'in-progress']),
  ];
  for (const r of quiet) assert.ok(r.code === 0 && !('records' in r.json) && !('recordsNotWritten' in r.json), r.stdout);
  assert.deepEqual(historyOf(other).keys(), []);
});

test('the records are made without holding the run mutex: the run can change meanwhile, and they are made again', async (t) => {
  const sb = one(t);
  const first = firstReview(sb, { close: false });
  const history = historyOf(sb);
  // `close` stops once its records are made, before anything is written, until the gate file exists.
  const gate = path.join(sb.home, 'records-gate');
  const closing = sb.runAsync(['close'], { NOVARC_HD_TEST_RECORDS_GATE: gate, ...clock(FIRST.closed) });
  for (let i = 0; i < 800 && !fs.existsSync(`${gate}.waiting`); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(`${gate}.waiting`), 'close reached the point where its records are made');

  // No lock is held while the slow part runs: there is nothing another command could take for a
  // dead lock and break, and nothing to wait for.
  assert.ok(!sb.exists('.mutex'), 'the run mutex is free');
  assert.deepEqual(history.keys(), [], 'and nothing is written yet');
  const decided = sb.run(['decide', '--target', 'ACME-104', '--action', 'approve', '--note', 'this one too'], clock('2026-01-10T11:59:00.000Z'));
  assert.equal(decided.code, 0, decided.stdout + decided.stderr);
  assert.equal(decided.json.new[0].result, 'applied');
  assert.equal(sb.read('run.json').closed, false);

  // Let `close` go on: the run is no longer what its records were made from, so it makes them again.
  fs.writeFileSync(gate, '');
  const closed = await closing;
  assert.equal(closed.code, 0, closed.stdout + closed.stderr);
  assert.deepEqual([closed.json.closed, closed.json.closedAt, closed.json.records.map((r) => [r.items, r.fixed, r.written])], [true, FIRST.closed, [[4, 1, true]]]);
  const record = history.record(first.key, first.runId);
  assert.deepEqual(record.items.map((i) => [i.id, i.status]), [['ACME-101', 'fixed'], ['ACME-102', 'declined'], ['ACME-103', 'deferred'], ['ACME-104', 'approved']], 'the decision taken meanwhile is in the record');
  assert.deepEqual(record.items[3].decision, { action: 'approve', at: '2026-01-10T11:59:00.000Z', note: 'this one too' });
  assert.equal(record.reviewedAt, FIRST.closed);
  assert.equal(sb.read('run.json').closed, true);
  assert.ok(!sb.exists('.mutex') && !fs.existsSync(path.join(history.dir, '.mutex')), 'no lock is left behind');
});

test('the texts for people: names instead of ids, compact numbers, in English and in Portuguese', () => {
  const record = {
    schema: 1, skillVersion: '0.0.0', harnessKey: 'conta-1-0a1b2c3d', runId: '20261124-ab12', kind: 'user', provider: 'claude-code',
    name: 'Claude Code · conta 1', path: '~/.claude',
    startedAt: '2026-11-24T10:00:00.000Z', reviewedAt: '2026-11-24T12:00:00.000Z', changesAppliedAt: null, followUpAfter: '2026-12-24T12:00:00.000Z',
    scores: { baseline: 61.5, current: 82.57, projected: 90, grade: 'B', rounds: [] },
    measure: {
      window: { days: 1 }, sessions: 1,
      metrics: { 'tokens-per-session': 57176222, 'weighted-per-session': 1234567890, 'context-at-start': 111234, 'waste-share': 2, 'waste:notfound': 950, 'tool-output': 4100 },
    },
    elements: {},
    items: [
      { id: 'U1-201', rev: '0123456789ab', round: 2, severity: 'critical', class: 'translate-agent', title: 'A title | with a bar', status: 'approved', saves: { tokens: 3000000, basis: 'estimated', metric: 'context-at-start' } },
      { id: 'U1-701', rev: '0123456789ab', round: 7, severity: 'high', class: 'install', title: 'No metric named', status: 'failed', notVerified: 'The check did not pass.', saves: { tokens: 1500, basis: 'measured' } },
    ],
  };
  const en = recordMarkdown(record, 'en').split('\n');
  const pt = recordMarkdown(record, 'pt').split('\n');
  const has = (lines, line) => assert.ok(lines.includes(line), `${line}\n--- in:\n${lines.join('\n')}`);
  has(en, '- Harness: Claude Code · conta 1 (user harness), `~/.claude`');
  has(en, '- Score: 61.5 as found, 82.5 after this review, 90 once what was approved is applied (grade B)');
  has(en, '1 day, 1 session. Every number is per session.');
  has(en, '| All tokens spent (tokens per session) | 57.1M |');
  has(en, '| Relative cost (tokens per session) | 1.2B |');
  has(en, '| Context at the start of a session (tokens per session) | 111.2k |');
  has(en, '| Share of the spend wasted (percent of the spend) | 2% |');
  has(en, '| Commands that do not exist here (tokens per session) | 950 |');
  has(en, '| Shell output read by the agent (characters per session) | 4.1k |');
  has(en, '## Approved, not applied yet (1)');
  has(en, '- **U1-201** A title / with a bar (critical, translate (agent))');
  has(en, '  - Expected saving: 3M tokens (estimated); the next review checks it in: Context at the start of a session');
  has(en, '## Failed (1)');
  has(en, '  - Not verified: The check did not pass.');
  has(en, '  - Expected saving: 1.5k tokens (measured)');
  has(pt, '- Harness: Claude Code · conta 1 (harness de usuário), `~/.claude`');
  has(pt, '- Nota: 61,5 como foi encontrado, 82,5 depois desta revisão, 90 quando o que foi aprovado estiver aplicado (conceito B)');
  has(pt, '1 dia, 1 sessão. Todo número é por sessão.');
  has(pt, '| Todos os tokens gastos (tokens por sessão) | 57,1 mi |');
  has(pt, '| Custo relativo (tokens por sessão) | 1,2 bi |');
  has(pt, '| Contexto no início da sessão (tokens por sessão) | 111,2 mil |');
  has(pt, '| Parcela do gasto que foi à toa (por cento do gasto) | 2% |');
  has(pt, '| Comandos que não existem aqui (tokens por sessão) | 950 |');
  has(pt, '| Saída de terminal lida pelo agente (caracteres por sessão) | 4,1 mil |');
  has(pt, '## Aprovados, ainda não aplicados (1)');
  has(pt, '- **U1-201** A title / with a bar (crítica, tradução (agente))');
  has(pt, '  - Economia esperada: 3 mi tokens (estimado); a próxima revisão confere em: Contexto no início da sessão');
  has(pt, '## Falharam (1)');
  has(pt, '  - Não verificado: The check did not pass.');
  has(pt, '  - Economia esperada: 1,5 mil tokens (medido)');

  const report = {
    at: '2026-12-01T12:00:00.000Z', unrecordedRuns: ['20261001-old1'],
    harnesses: [
      { key: 'conta-1-0a1b2c3d', kind: 'user', name: 'Claude Code · conta 1', path: '~/.claude', followUpAfter: '2026-12-24T12:00:00.000Z', due: false, reviews: [
        { runId: '20261024-aa11', reviewedAt: '2026-10-24T12:00:00.000Z', score: 61.5, grade: 'C', fixed: 4, expectedTokens: 3000000, followUpAfter: '2026-11-23T12:00:00.000Z' },
        { runId: '20261124-ab12', reviewedAt: '2026-11-24T12:00:00.000Z', score: null, grade: null, fixed: 1, expectedTokens: 0, followUpAfter: '2026-12-24T12:00:00.000Z' },
      ] },
      { key: 'loja-web-8c2d4b7a', kind: 'project', name: 'loja-web', path: '~/dev/loja-web', followUpAfter: '2026-11-30T12:00:00.000Z', due: true, reviews: [
        { runId: '20261031-cc33', reviewedAt: '2026-10-31T12:00:00.000Z', score: 76.4, grade: 'B', fixed: 2, expectedTokens: 111234, followUpAfter: '2026-11-30T12:00:00.000Z' },
      ] },
    ],
  };
  assert.equal(historyText(report, 'en'), [
    'Review history: 2 harnesses',
    '',
    'Claude Code · conta 1 (user harness) ~/.claude [conta-1-0a1b2c3d]',
    '  2026-10-24  run 20261024-aa11  score 61.5 (C)  4 fixed  expected saving 3M tokens',
    '  2026-11-24  run 20261124-ab12  not scored  1 fixed',
    '  Follow-up from 2026-12-24 (in 23 days).',
    '',
    'loja-web (project harness) ~/dev/loja-web [loja-web-8c2d4b7a]',
    '  2026-10-31  run 20261031-cc33  score 76.4 (B)  2 fixed  expected saving 111.2k tokens',
    '  Follow-up due since 2026-11-30.',
    '',
    'Runs without a review record: 20261001-old1. Write them with: run.mjs history --write --run <id>',
    '',
  ].join('\n'));
  assert.equal(historyText(report, 'pt'), [
    'Histórico de revisões: 2 harnesses',
    '',
    'Claude Code · conta 1 (harness de usuário) ~/.claude [conta-1-0a1b2c3d]',
    '  2026-10-24  execução 20261024-aa11  nota 61,5 (C)  4 corrigidos  economia esperada 3 mi tokens',
    '  2026-11-24  execução 20261124-ab12  sem nota  1 corrigido',
    '  Acompanhamento a partir de 2026-12-24 (em 23 dias).',
    '',
    'loja-web (harness de projeto) ~/dev/loja-web [loja-web-8c2d4b7a]',
    '  2026-10-31  execução 20261031-cc33  nota 76,4 (B)  2 corrigidos  economia esperada 111,2 mil tokens',
    '  Acompanhamento pendente desde 2026-11-30.',
    '',
    'Execuções sem registro de revisão: 20261001-old1. Para gravar: run.mjs history --write --run <id>',
    '',
  ].join('\n'));
  // No line carries an em dash, an en dash or an emoji.
  for (const text of [en.join('\n'), pt.join('\n'), historyText(report, 'en'), historyText(report, 'pt')]) assert.ok(!/[‒-―]|\p{Extended_Pictographic}/u.test(text));
});

test('init --follow-up starts over the harnesses of an earlier run that still exist, measured since that review', (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop', 'novarc-powers'] });
  const first = firstReview(sb, { initArgs: ['--lang', 'pt', '--mode', 'doctor'] });
  const history = historyOf(sb);
  const npKey = history.keys().find((k) => k !== first.key);
  fs.rmSync(path.join(sb.home, 'dev', 'novarc-powers'), { recursive: true });

  // 31 days after the change was applied; the run's window is the default 30 days.
  const r = sb.run(['init', '--follow-up', 'latest'], clock('2026-02-10T12:00:00.000Z'));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const follow = { runId: first.runId, reviewedAt: FIRST.closed, days: 31, windowDays: 30 };
  assert.deepEqual(r.json, {
    runId: r.json.runId, dir: r.json.dir, mode: 'doctor',
    harnesses: [{ id: 'acme-shop', key: 'ACME', kind: 'project', name: 'acme-shop', path: '~/dev/acme-shop', harnessKey: first.key, followUp: follow }],
    units: ['review:security', 'review:instructions', 'review:gates', 'review:skills-tools', 'review:cleanup-deps'],
    followUpOf: { runId: first.runId, reviewedAt: FIRST.closed },
    dropped: [{ kind: 'project', name: 'novarc-powers', path: '~/dev/novarc-powers', reason: 'folder not found' }],
  });
  sb.runId = r.json.runId;
  sb.dir = r.json.dir;
  const run = sb.read('run.json');
  assert.deepEqual({ mode: run.mode, language: run.language, windowDays: run.windowDays, createdAt: run.createdAt, followUpOf: run.followUpOf }, { mode: 'doctor', language: 'pt', windowDays: 30, createdAt: '2026-02-10T12:00:00.000Z', followUpOf: { runId: first.runId, reviewedAt: FIRST.closed } });
  assert.deepEqual(run.harnesses.map((h) => ({ id: h.id, harnessKey: h.harnessKey, windowDays: h.windowDays, lastRecord: h.lastRecord })), [{
    id: 'acme-shop', harnessKey: first.key, windowDays: 30,
    lastRecord: { runId: first.runId, reviewedAt: FIRST.closed, file: path.join(history.dir, first.key, `${first.runId}.json`) },
  }]);
  assert.deepEqual(run.previousScores, { 'acme-shop': 79 }, 'the score that review ended with, from its record');
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  assert.deepEqual(sb.read('state.json').run.followUpOf, { runId: first.runId, reviewedAt: FIRST.closed });
  // The impact probe is asked for that window (the stub records how it was called).
  assert.equal(sb.run(['probe', '--harness', 'acme-shop']).code, 0);
  const impactCall = sb.stubCalls().filter((c) => c.script === 'session-impact').pop();
  assert.equal(impactCall.args[impactCall.args.indexOf('--days') + 1], '30');

  // Explicit flags win; a longer run window lets the whole time since the change in.
  const wide = sb.run(['init', '--follow-up', first.runId, '--lang', 'en', '--mode', 'guided', '--days', '60'], clock('2026-02-10T12:00:00.000Z'));
  assert.deepEqual([wide.json.mode, wide.json.harnesses[0].followUp], ['guided', { ...follow, windowDays: 31 }]);
  sb.runId = wide.json.runId;
  sb.dir = wide.json.dir;
  assert.deepEqual([sb.read('run.json').language, sb.read('run.json').windowDays, sb.read('run.json').harnesses[0].windowDays], ['en', 60, 31]);
  // Too soon to compare: the normal window, and the days that have passed.
  const soon = sb.run(['init', '--follow-up', first.runId], clock('2026-01-13T12:00:00.000Z'));
  assert.deepEqual(soon.json.harnesses[0].followUp, { runId: first.runId, reviewedAt: FIRST.closed, days: 3, windowDays: 30 });
  const exactly = sb.run(['init', '--follow-up', first.runId, '--days', '90'], clock('2026-01-17T11:31:00.000Z'));
  assert.deepEqual(exactly.json.harnesses[0].followUp, { runId: first.runId, reviewedAt: FIRST.closed, days: 7, windowDays: 7 }, 'from minDays on, the window is the days since the change');

  // Following up a run that left no record: the same harnesses, and the hint to record it.
  const unrecorded = sb.run(['init', '--follow-up', 'latest'], clock('2026-02-11T12:00:00.000Z'));
  assert.equal(unrecorded.code, 0, unrecorded.stdout);
  assert.deepEqual(unrecorded.json.followUpOf, { runId: exactly.json.runId });
  assert.deepEqual(unrecorded.json.unrecordedRuns, [exactly.json.runId]);
  assert.match(unrecorded.json.hint, /run\.mjs history --write --run <id>/);
  assert.equal(unrecorded.json.harnesses[0].followUp.runId, first.runId, 'the harness is still compared with its last record');

  const select = path.join(sb.home, 'selection.json');
  assert.equal(sb.run(['init', '--follow-up', 'latest', '--select', select]).code, 2, 'one or the other');
  assert.equal(sb.run(['init', '--follow-up']).code, 2);
  assert.equal(sb.run(['init', '--follow-up', '../x']).code, 2);
  assert.equal(sb.run(['init', '--follow-up', '20200101-none']).code, 1);
  assert.equal(sb.run(['init']).code, 2);
  // Every folder gone: there is nothing to follow up.
  fs.rmSync(path.join(sb.home, 'dev', 'acme-shop'), { recursive: true });
  const gone = sb.run(['init', '--follow-up', first.runId]);
  assert.equal(gone.code, 1);
  assert.match(gone.json.error, /none of the harnesses of run .* exists any more/);
  assert.deepEqual(gone.json.dropped.map((d) => d.name), ['acme-shop', 'novarc-powers']);
  assert.ok(npKey);
});

test('a run that predates records: the old score is still found, and history --write gives it a record', (t) => {
  const sb = one(t);
  // An earlier run that was built (the renderer stub writes a score) and never closed.
  const old = start(sb, '2025-12-01T10:00:00.000Z');
  assert.equal(sb.complete('review:security', { rounds: [{ harness: 'acme-shop', round: 1, status: 'done' }], items: [item('ACME-101', 'acme-shop', 1)] }).code, 0);
  assert.equal(sb.run(['build'], { STUB_SCORES: '1' }).code, 0);
  assert.deepEqual(historyOf(sb).keys(), []);
  assert.deepEqual(sb.run(['history', '--json']).json.unrecordedRuns, [], 'the latest run, still open, is work in progress');

  const next = start(sb, '2026-01-05T10:00:00.000Z');
  assert.deepEqual(next.unrecordedRuns, [old.runId]);
  assert.match(next.hint, /history --write/);
  assert.ok(!('followUp' in next.harnesses[0]), 'nothing to compare with yet');
  assert.deepEqual(sb.read('run.json').previousScores, { 'acme-shop': 99 }, 'the score comes from the old state.json');
  assert.deepEqual(sb.run(['history', '--json']).json.unrecordedRuns, [old.runId]);
  assert.match(sb.run(['history']).stdout, new RegExp(`^No review recorded yet\\.\n\nRuns without a review record: ${old.runId}\\. Write them with: run\\.mjs history --write --run <id>\n$`));

  const written = sb.run(['history', '--write', '--run', old.runId], clock('2026-01-06T10:00:00.000Z'));
  assert.equal(written.code, 0, written.stdout + written.stderr);
  const key = written.json.records[0].harnessKey;
  assert.deepEqual(historyOf(sb).record(key, old.runId).scores.current, 95);
  assert.deepEqual(sb.run(['history', '--json']).json.unrecordedRuns, []);
  // From now on a new run is compared with that record.
  const after = start(sb, '2026-02-10T10:00:00.000Z');
  assert.ok(!('unrecordedRuns' in after));
  assert.deepEqual(after.harnesses[0].followUp, { runId: old.runId, reviewedAt: '2026-01-06T10:00:00.000Z', days: 35, windowDays: 30 });
  assert.deepEqual(sb.read('run.json').previousScores, { 'acme-shop': 95 });
});

test('a credential planted in an item note never reaches a record', (t) => {
  const sb = one(t);
  const first = firstReview(sb, { close: false });
  const token = 'ghp_' + 'R'.repeat(36);
  const key = 'sk-' + 'ant-' + 'api03-' + 'y'.repeat(40);
  // Neither could come in through a command: both are written into the run directory by hand.
  const status = sb.read('status.json');
  status.items['ACME-102'].decision = `not now, the token ${token} is still in use`;
  status.items['ACME-101'].verified = `checked with ${key}`;
  fs.writeFileSync(sb.file('status.json'), JSON.stringify(status));
  const findings = sb.read('findings', 'review.security.json');
  findings.items[3].title = `Token ${token} in the README`;
  findings.items[0].lesson.principle = `Never write ${key} down.`;
  fs.writeFileSync(sb.file('findings', 'review.security.json'), JSON.stringify(findings));

  const closed = sb.run(['close'], clock(FIRST.closed));
  assert.equal(closed.code, 0, closed.stdout + closed.stderr);
  const history = historyOf(sb);
  for (const secret of [token, key]) {
    assert.deepEqual(filesContaining(history.dir, secret), [], 'no file under history/ holds it');
    assert.deepEqual(filesContaining(history.dir, secret.slice(0, 12)), [], 'nor the start of it');
    assert.ok(!closed.stdout.includes(secret) && !closed.stderr.includes(secret));
  }
  const record = history.record(first.key, first.runId);
  assert.equal(record.items[1].decision.note, 'not now, the token ghp_…40 is still in use');
  assert.equal(record.items[0].verified, 'checked with sk-a…53');
  assert.equal(record.items[0].principle, 'Never write sk-a…53 down.');
  assert.equal(record.items[3].title, 'Token ghp_…40 in the README');
  assert.ok(history.md(first.key, first.runId).includes('"not now, the token ghp_…40 is still in use"'));
});

test('two runs closing at the same moment both land in the index', async (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop', 'novarc-powers'] });
  const a = start(sb, FIRST.started, [], { ...sb.selection, projects: [sb.selection.projects[0]] });
  const b = start(sb, '2026-01-10T10:01:00.000Z', [], { ...sb.selection, projects: [sb.selection.projects[1]] });
  const gate = { ...together(), ...clock(FIRST.closed) };
  const results = await Promise.all([a, b, a, b].map((run) => sb.runAsync(['close', '--run', run.runId], gate)));
  for (const r of results) assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(results.filter((r) => r.json.already === true).length, 2, 'each run is closed once');
  const history = historyOf(sb);
  const index = history.index();
  assert.deepEqual(Object.keys(index.harnesses), [a.harnesses[0].harnessKey, b.harnesses[0].harnessKey].sort());
  assert.deepEqual(Object.values(index.harnesses).map((h) => h.reviews.length), [1, 1]);
  assert.deepEqual(history.files(a.harnesses[0].harnessKey), [`${a.runId}.json`, `${a.runId}.md`]);
});

test('the clock of the run library is NOVARC_HD_NOW', (t) => {
  const sb = one(t);
  const file = path.join(sb.home, 'selection.json');
  fs.writeFileSync(file, JSON.stringify(sb.selection));
  const bad = sb.run(['init', '--select', file], { NOVARC_HD_NOW: 'next tuesday' });
  assert.equal(bad.code, 2);
  assert.equal(bad.json.error, 'NOVARC_HD_NOW must be an RFC 3339 date-time or epoch milliseconds');
  // Epoch milliseconds are the same instant.
  const r = sb.run(['init', '--select', file], { NOVARC_HD_NOW: String(Date.parse(FIRST.started)) });
  assert.equal(r.code, 0, r.stdout);
  sb.runId = r.json.runId;
  sb.dir = r.json.dir;
  assert.equal(sb.read('run.json').createdAt, FIRST.started);
  assert.equal(JSON.parse(sb.text('log.jsonl').trim().split('\n')[0]).at, FIRST.started, 'the log follows it');
  // A claim made "then" is as old as that clock says: live at the time, stale 91 minutes later.
  assert.equal(sb.run(['claim', '--unit', 'review:security', '--session', 'a'], clock(FIRST.started)).code, 0);
  assert.equal(sb.run(['claim', '--unit', 'review:security', '--session', 'b'], clock('2026-01-10T11:00:00.000Z')).code, 1);
  assert.equal(sb.run(['claim', '--unit', 'review:security', '--session', 'b'], clock('2026-01-10T11:31:00.000Z')).json.takenOverFrom, 'a');
});
