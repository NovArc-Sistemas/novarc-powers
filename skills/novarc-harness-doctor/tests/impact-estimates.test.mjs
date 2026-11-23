// impact-estimates.mjs against synthetic probe outputs written to os.tmpdir(). The arithmetic
// uses a synthetic factor catalog (passed with --catalog) and is worked out by hand in the
// comments; the shipped catalog is checked on its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, rmrf, runScript, write } from './helpers.mjs';
import { estimate, loadFactors, snapshotFacts, DEFAULT_CATALOG } from '../scripts/impact-estimates.mjs';

const SRC = 'https://example.com/claim';
const RTK_BASIS = 'Synthetic claim sentence for the filter.';
const GRAPH_BASIS = 'Assumption, not a measurement: synthetic share.';
const SKILL_BASIS = 'Synthetic sentence for skill descriptions.';
const MCP_BASIS = 'Synthetic sentence for servers.';
const CATALOG = {
  verifiedAt: '2026-01-01',
  estimates: [
    { id: 'rtk-output', kind: 'project-claim', tool: 'rtk', label: 'Command output a filter would cut', factor: 0.2, weighting: 'input', source: SRC, verifiedAt: '2026-01-01', quote: 'synthetic quote', basis: RTK_BASIS },
    { id: 'graph-exploration', kind: 'assumption', tool: 'graphify', label: 'Exploration a knowledge graph could answer', factor: 0.25, source: 'assumption: synthetic share', verifiedAt: '2026-01-01', quote: null, basis: GRAPH_BASIS },
    { id: 'unused-skill-descriptions', kind: 'documented', tool: null, label: 'Descriptions of skills never invoked', maxDescriptionChars: 1536, source: SRC, verifiedAt: '2026-01-01', quote: ['synthetic quote'], basis: SKILL_BASIS },
    { id: 'unused-mcp-servers', kind: 'unmeasured', tool: null, label: 'MCP server never called', source: 'session-impact.mjs', verifiedAt: '2026-01-01', quote: null, basis: MCP_BASIS },
  ],
};

// What session-impact.mjs printed for a project: only the fields the estimates read, plus
// measured totals that must never show up in the output.
const IMPACT = {
  scope: 'project', sessions: 4, totalTokens: 178150, weightedTotal: 28043,
  toolOutput: { shellResultChars: 596, shellResultTokensApprox: 149 },
  waste: [
    { kind: 'retry', tokens: 500, weighted: 1190 },
    { kind: 'exploration', tokens: 1155, weighted: 2193 },
  ],
  unusedContext: { skillsNeverInvoked: ['idle-skill', 'big-skill', 'no-size-skill'], mcpServersNeverCalled: ['idle-srv', 'other.srv'] },
};
const CLIS = (installed) => ({ tools: [{ id: 'git', bin: 'git', installed: true }, { id: 'rtk', bin: 'rtk', installed }] });
// A snapshot-harness.mjs output: a project that holds code. It carries no list of the harness
// files found in the project; `signals` adds one, as find-projects.mjs prints it.
const SNAPSHOT = (signals = null) => ({
  harness: { id: 'acme', kind: 'project', name: 'acme', path: '~/dev/acme', project: { isCode: true } },
  ...(signals ? { signals } : {}),
  elements: {
    skills: [
      { name: 'used-skill', level: 'project', descriptionChars: 900 },
      { name: 'idle-skill', level: 'project', descriptionChars: 402 },
      { name: 'big-skill', level: 'project', descriptionChars: 2000 },
      { name: 'no-size-skill', level: 'project' },
    ],
  },
});

// The project part of a discover.mjs output: it says whether graphify-out/ exists.
const DISCOVER = (exists = false) => ({ project: { name: 'acme', isCode: true, graphify: { exists, tracked: false } } });

let dir; let files;
const run = (args) => runScript('impact-estimates.mjs', args);
const put = (name, value) => { const f = path.join(dir, name); write(f, typeof value === 'string' ? value : JSON.stringify(value)); return f; };

before(() => {
  dir = tmpDir('hd-estimates-');
  files = {
    catalog: put('catalog.json', CATALOG),
    impact: put('impact.json', IMPACT),
    clisNo: put('clis-no.json', CLIS(false)),
    clisYes: put('clis-yes.json', CLIS(true)),
    snapshot: put('snapshot.json', SNAPSHOT()),
    discover: put('discover.json', DISCOVER()),
  };
  files.all = ['--impact', files.impact, '--clis', files.clisNo, '--snapshot', files.snapshot, '--discover', files.discover];
});

after(() => rmrf(dir));

test('all three estimates, with their arithmetic', () => {
  const r = run([...files.all, '--catalog', files.catalog]);
  assert.equal(r.code, 0, r.stderr);
  // rtk is not installed: 149 shell-output tokens * 0.2 = 29.8 -> 30; as input they weigh 1 each.
  // A code project (snapshot) with no graphify-out/ (discover file): exploration 1155 * 0.25 = 288.75 -> 289, weighted 2193 * 0.25 = 548.25 -> 548.
  // Skills never invoked, 4 sessions: idle-skill 402 chars / 4 = 100.5 -> 101 tokens * 4 = 404;
  //   big-skill 2000 chars capped at 1536 / 4 = 384 * 4 = 1536; no-size-skill has no size. 404 + 1536 = 1940.
  assert.deepEqual(r.json.estimates, [
    { id: 'rtk-output', label: 'Command output a filter would cut', tool: 'rtk', tokens: 30, weighted: 30, source: RTK_BASIS },
    { id: 'graph-exploration', label: 'Exploration a knowledge graph could answer', tool: 'graphify', tokens: 289, weighted: 548, source: GRAPH_BASIS },
    { id: 'unused-skill-descriptions', label: 'Descriptions of skills never invoked', tokens: 1940, source: SKILL_BASIS },
  ]);
  assert.deepEqual(r.json.detail, {
    sessions: 4,
    skills: [
      { name: 'big-skill', descriptionChars: 2000, countedChars: 1536, tokensPerSession: 384, tokens: 1536 },
      { name: 'idle-skill', descriptionChars: 402, countedChars: 402, tokensPerSession: 101, tokens: 404 },
    ],
    skillsWithoutSize: ['no-size-skill'],
  });
  // MCP servers: names only, no token number.
  assert.deepEqual(r.json.unmeasured, [
    { id: 'unused-mcp-servers', label: 'MCP server never called', tool: 'idle-srv', source: MCP_BASIS },
    { id: 'unused-mcp-servers', label: 'MCP server never called', tool: 'other.srv', source: MCP_BASIS },
  ]);
  assert.deepEqual(r.json.skipped, []);
  assert.deepEqual(r.json.catalog, { source: 'catalog.json', verifiedAt: '2026-01-01' });
  assert.equal(typeof r.json.method, 'string');
});

test('estimates stay apart from measured totals and carry a fixed set of keys', () => {
  const r = run([...files.all, '--catalog', files.catalog]);
  const allowed = new Set(['id', 'label', 'tool', 'tokens', 'weighted', 'source']);
  for (const e of r.json.estimates) {
    for (const k of Object.keys(e)) assert.ok(allowed.has(k), `unexpected key ${k}`);
    assert.ok(Number.isInteger(e.tokens) && e.tokens > 0);
    assert.ok(typeof e.source === 'string' && e.source.length > 10);
  }
  for (const k of ['totalTokens', 'weightedTotal', 'waste', 'byKind']) assert.ok(!(k in r.json), `${k} is a measured field`);
  assert.ok(!r.stdout.includes('178150') && !r.stdout.includes('28043'), 'measured totals are not repeated or summed');
});

test('rtk installed, or not probed: no estimate for it', () => {
  const yes = run(['--impact', files.impact, '--clis', files.clisYes, '--snapshot', files.snapshot, '--discover', files.discover, '--catalog', files.catalog]).json;
  assert.deepEqual(yes.estimates.map((e) => e.tool || null), ['graphify', null]);
  assert.deepEqual(yes.skipped, [{ estimate: 'rtk-output', reason: 'the filter is installed' }]);

  const none = run(['--impact', files.impact, '--snapshot', files.snapshot, '--discover', files.discover, '--catalog', files.catalog]).json;
  assert.deepEqual(none.estimates.map((e) => e.tool || null), ['graphify', null]);
  assert.equal(none.skipped[0].estimate, 'rtk-output');

  // The probe ran but has no answer for rtk (not in its catalog, or installed: null).
  const f = factorsOf();
  for (const clis of [{ tools: [{ id: 'git', installed: true }] }, { tools: [{ id: 'rtk', installed: null }] }]) {
    const res = estimate({ impact: IMPACT, clis, snapshot: SNAPSHOT(), discover: DISCOVER(), factors: f });
    assert.ok(!res.estimates.some((e) => e.tool === 'rtk'));
    assert.ok(res.estimates.some((e) => e.tool === 'graphify'));
  }
});

function factorsOf(catalog = CATALOG) {
  const f = path.join(dir, `factors-${Math.random().toString(36).slice(2)}.json`);
  write(f, JSON.stringify(catalog));
  return loadFactors(f);
}

test('the knowledge graph estimate needs a code project without graphify-out/', () => {
  const f = factorsOf();
  const graph = (impact, snapshot, discover = null) => estimate({ impact, clis: CLIS(true), snapshot, discover, factors: f }).estimates.find((e) => e.tool === 'graphify') || null;
  // The snapshot says it is a code project, the discover file says there is no graph.
  assert.equal(graph(IMPACT, SNAPSHOT(), DISCOVER(false)).tokens, 289);
  assert.equal(graph(IMPACT, SNAPSHOT(), DISCOVER(true)), null, 'the project already has a graph');
  // The snapshot alone does not say whether the folder exists, so nothing is estimated.
  assert.equal(graph(IMPACT, SNAPSHOT()), null);
  // A snapshot with a signals list answers on its own, and wins over the discover file.
  assert.equal(graph(IMPACT, SNAPSHOT(['CLAUDE.md', '.claude/'])).tokens, 289);
  assert.equal(graph(IMPACT, SNAPSHOT(['CLAUDE.md', 'graphify-out/'])), null);
  assert.equal(graph(IMPACT, SNAPSHOT(['./graphify-out']), DISCOVER(false)), null);
  // User scope.
  assert.equal(graph({ ...IMPACT, scope: 'user' }, SNAPSHOT(), DISCOVER(false)), null);
  assert.equal(graph(IMPACT, { ...SNAPSHOT(), harness: { kind: 'user' } }, DISCOVER(false)), null);
  // Not a code project, or no file says.
  assert.equal(graph(IMPACT, { ...SNAPSHOT(), harness: { kind: 'project', project: { isCode: false } } }, DISCOVER(false)), null);
  assert.equal(graph(IMPACT, { ...SNAPSHOT(), harness: { kind: 'project' } }, { project: { graphify: { exists: false } } }), null);
  // Neither file given.
  assert.equal(graph(IMPACT, null), null);
  // No exploration measured.
  assert.equal(graph({ ...IMPACT, waste: [{ kind: 'exploration', tokens: 0 }] }, SNAPSHOT(), DISCOVER(false)), null);
  // The discover file alone answers both questions.
  assert.equal(graph(IMPACT, null, DISCOVER(false)).tokens, 289);
  assert.equal(graph(IMPACT, null, DISCOVER(true)), null);
});

test('what a snapshot says, and what it does not', () => {
  assert.deepEqual(snapshotFacts(SNAPSHOT()), { kind: 'project', isCode: true, hasGraph: null, skills: SNAPSHOT().elements.skills });
  assert.equal(snapshotFacts(SNAPSHOT(['CLAUDE.md'])).hasGraph, false);
  assert.equal(snapshotFacts(SNAPSHOT(['graphify-out/'])).hasGraph, true);
  assert.deepEqual(snapshotFacts(DISCOVER(true)), { kind: null, isCode: true, hasGraph: true, skills: null });
  assert.equal(snapshotFacts({ harness: { kind: 'project', project: { isCode: true } } }).hasGraph, null);
  // A file list can confirm the folder, never rule it out.
  assert.equal(snapshotFacts({ files: [{ path: './graphify-out/graph.json' }] }).hasGraph, true);
  assert.equal(snapshotFacts({ files: [{ path: './CLAUDE.md' }] }).hasGraph, null);
  assert.deepEqual(snapshotFacts({}), { kind: null, isCode: null, hasGraph: null, skills: null });
});

test('without a weighted view in the impact, estimates carry no weighted number', () => {
  const { weightedTotal, ...raw } = IMPACT;
  const impact = { ...raw, waste: raw.waste.map(({ weighted, ...w }) => w) };
  const res = estimate({ impact, clis: CLIS(false), snapshot: SNAPSHOT(), discover: DISCOVER(), factors: factorsOf() });
  assert.deepEqual(res.estimates.map((e) => [e.tool || null, e.tokens, 'weighted' in e]), [['rtk', 30, false], ['graphify', 289, false], [null, 1940, false]]);
});

test('skill descriptions: nothing to estimate without sizes, sessions or idle skills', () => {
  const f = factorsOf();
  const skills = (impact, snapshot) => estimate({ impact, clis: CLIS(true), snapshot, discover: snapshot ? DISCOVER() : null, factors: f });
  // No snapshot: sizes unknown, but the MCP servers are still listed.
  const a = skills(IMPACT, null);
  assert.ok(!a.estimates.some((e) => e.label === 'Descriptions of skills never invoked'));
  assert.equal(a.unmeasured.length, 2);
  // Every skill was invoked.
  const b = skills({ ...IMPACT, unusedContext: { skillsNeverInvoked: [], mcpServersNeverCalled: [] } }, SNAPSHOT());
  assert.deepEqual([b.estimates.length, b.unmeasured.length], [1, 0]); // only the graph estimate
  // No session in the window.
  const c = skills({ ...IMPACT, sessions: 0 }, SNAPSHOT());
  assert.ok(!c.estimates.some((e) => e.label === 'Descriptions of skills never invoked'));
  // The same name at two levels: the entry of the harness's own level is the one counted.
  const snap = SNAPSHOT();
  snap.elements.skills.unshift({ name: 'idle-skill', level: 'user', descriptionChars: 40 });
  assert.equal(skills(IMPACT, snap).detail.skills.find((s) => s.name === 'idle-skill').descriptionChars, 402);
});

test('a factor that does not say where it comes from is not used', () => {
  const strip = (id, patch) => ({ ...CATALOG, estimates: CATALOG.estimates.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
  const tools = (catalog) => estimate({ impact: IMPACT, clis: CLIS(false), snapshot: SNAPSHOT(), discover: DISCOVER(), factors: factorsOf(catalog) }).estimates.map((e) => e.tool || null);
  assert.deepEqual(tools(CATALOG), ['rtk', 'graphify', null]);
  assert.deepEqual(tools(strip('rtk-output', { quote: null })), ['graphify', null], 'a claim needs its quote');
  assert.deepEqual(tools(strip('rtk-output', { verifiedAt: null })), ['graphify', null]);
  assert.deepEqual(tools(strip('rtk-output', { factor: 3 })), ['graphify', null], 'a share is between 0 and 1');
  assert.deepEqual(tools(strip('graph-exploration', { source: 'https://example.com/x' })), ['rtk', null], 'an assumption has to say it is one');
  assert.deepEqual(tools(strip('unused-skill-descriptions', { basis: '' })), ['rtk', 'graphify']);
});

test('a missing catalog gives no estimate, and bad arguments exit 2', () => {
  const r = run([...files.all, '--catalog', path.join(dir, 'nope.json')]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.estimates, []);
  assert.deepEqual(r.json.unmeasured, []);
  assert.deepEqual(r.json.skipped, [{ estimate: '*', reason: 'estimates catalog not found' }]);

  assert.equal(run([]).code, 2);
  assert.equal(run(['--impact', path.join(dir, 'nope.json')]).code, 2);
  assert.equal(run(['--impact', put('broken.json', '{ not json')]).code, 2);
  assert.equal(run(['--impact', files.impact, '--clis', put('list.json', '"text"')]).code, 2);
});

test('names that are not plain names are masked, and no path is printed', () => {
  const MARKER = 'ZQXMARK7731';
  const impact = put('impact-odd.json', {
    ...IMPACT,
    unusedContext: { skillsNeverInvoked: [`bad name ${MARKER}`, 'idle-skill'], mcpServersNeverCalled: [`srv ${MARKER}`] },
    toolOutput: { shellResultTokensApprox: 149, byHead: [{ head: `secret ${MARKER}`, calls: 1, chars: 4 }] },
  });
  const r = run(['--impact', impact, '--clis', files.clisNo, '--snapshot', files.snapshot, '--discover', files.discover, '--catalog', files.catalog]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(MARKER), 'marker leaked');
  assert.ok(!r.stdout.includes(dir) && !r.stdout.includes(dir.replace(/\\/g, '/')), 'input path leaked');
  assert.deepEqual(r.json.detail.skillsWithoutSize, ['<other>']);
  assert.deepEqual(r.json.unmeasured.map((u) => u.tool), ['<other>']);
});

test('the shipped catalog is sourced and dated, and its sentences reach the output', () => {
  const doc = JSON.parse(fs.readFileSync(DEFAULT_CATALOG, 'utf8'));
  const ids = doc.estimates.map((e) => e.id);
  assert.deepEqual(ids, ['rtk-output', 'graph-exploration', 'unused-skill-descriptions', 'unused-mcp-servers']);
  // Both languages for what the board shows: a label and one sentence, no "source:" prefix, no dash used as a pause.
  for (const e of doc.estimates) {
    for (const t of [{ label: e.label, basis: e.basis }, e.pt]) {
      assert.ok(t && t.label.length > 5 && t.basis.length > 30, `${e.id} has a label and a sentence`);
      assert.ok(!/[\u2014\u2013]/.test(t.label + t.basis), `${e.id}: no dash`);
      assert.ok(!/^(source|fonte)\s*:/i.test(t.basis), `${e.id}: no prefix`);
      assert.ok(!t.basis.includes('\n'));
    }
    assert.notEqual(e.pt.label, e.label);
  }
  assert.match(doc.estimates[1].pt.basis, /^Suposição, não medição:/, 'the Portuguese sentence says it is an assumption too');
  for (const e of doc.estimates) {
    assert.match(e.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, e.id);
    assert.ok(e.basis.length > 30 && !e.basis.includes('\n'), `${e.id} has a one-sentence basis`);
    if (e.kind === 'assumption') {
      assert.match(e.source, /^assumption:/, e.id);
      assert.equal(e.quote, null);
      assert.match(e.basis, /^Assumption/, 'the printed sentence says it is an assumption');
    } else if (e.kind !== 'unmeasured') {
      assert.match(e.source, /^https:\/\//, e.id);
      assert.ok(e.quote && e.quote.length > 0, `${e.id} keeps what was read`);
    }
    if ('factor' in e) assert.ok(e.factor > 0 && e.factor <= 1, e.id);
  }
  const byId = Object.fromEntries(doc.estimates.map((e) => [e.id, e]));
  assert.equal(byId['rtk-output'].kind, 'project-claim');
  assert.equal(byId['graph-exploration'].kind, 'assumption');
  // Every entry is accepted by the loader, and a default run prints the catalog's own sentences.
  assert.deepEqual(Object.keys(loadFactors(DEFAULT_CATALOG).byId), ids);
  const r = run(files.all);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.estimates.map((e) => e.source), [byId['rtk-output'].basis, byId['graph-exploration'].basis, byId['unused-skill-descriptions'].basis]);
  assert.deepEqual(r.json.estimates.map((e) => e.tokens), [
    Math.round(149 * byId['rtk-output'].factor),
    Math.round(1155 * byId['graph-exploration'].factor),
    (Math.round(402 / 4) + Math.round(Math.min(2000, byId['unused-skill-descriptions'].maxDescriptionChars) / 4)) * 4,
  ]);
  assert.equal(r.json.catalog.source, 'references/catalog/estimates.json');
});

// ------------------------------------------------------------------------------------------
// Language
// ------------------------------------------------------------------------------------------

const PT_CATALOG = {
  ...CATALOG,
  estimates: CATALOG.estimates.map((e) => ({ ...e, pt: { label: `PT ${e.label}`, basis: `PT ${e.basis}` } })),
};

test('--lang pt prints labels and sources in Portuguese, with the same ids and numbers', () => {
  const catalog = put('catalog-pt.json', PT_CATALOG);
  const en = run([...files.all, '--catalog', catalog]);
  const ptRun = run([...files.all, '--catalog', catalog, '--lang', 'pt']);
  assert.equal(en.code, 0, en.stderr);
  assert.equal(ptRun.code, 0, ptRun.stderr);
  assert.equal(en.json.language, 'en');
  assert.equal(ptRun.json.language, 'pt');
  // English is the default, and is what the catalog's own label and basis say.
  assert.deepEqual(en.json.estimates.map((e) => [e.id, e.label, e.source]), [
    ['rtk-output', 'Command output a filter would cut', RTK_BASIS],
    ['graph-exploration', 'Exploration a knowledge graph could answer', GRAPH_BASIS],
    ['unused-skill-descriptions', 'Descriptions of skills never invoked', SKILL_BASIS],
  ]);
  assert.deepEqual(ptRun.json.estimates.map((e) => [e.id, e.label, e.source]), [
    ['rtk-output', 'PT Command output a filter would cut', `PT ${RTK_BASIS}`],
    ['graph-exploration', 'PT Exploration a knowledge graph could answer', `PT ${GRAPH_BASIS}`],
    ['unused-skill-descriptions', 'PT Descriptions of skills never invoked', `PT ${SKILL_BASIS}`],
  ]);
  assert.deepEqual(ptRun.json.unmeasured, [
    { id: 'unused-mcp-servers', label: 'PT MCP server never called', tool: 'idle-srv', source: `PT ${MCP_BASIS}` },
    { id: 'unused-mcp-servers', label: 'PT MCP server never called', tool: 'other.srv', source: `PT ${MCP_BASIS}` },
  ]);
  // Only the texts change.
  const numbers = (j) => j.estimates.map((e) => [e.id, e.tool || null, e.tokens, e.weighted ?? null]);
  assert.deepEqual(numbers(ptRun.json), numbers(en.json));
  assert.deepEqual(ptRun.json.detail, en.json.detail);
});

test('--lang: region tags are accepted, other values are refused, a missing translation falls back', () => {
  const catalog = put('catalog-pt2.json', PT_CATALOG);
  assert.equal(run([...files.all, '--catalog', catalog, '--lang', 'pt-BR']).json.language, 'pt');
  assert.equal(run([...files.all, '--catalog', catalog, '--lang', 'EN']).json.language, 'en');
  assert.equal(run([...files.all, '--catalog', catalog, '--lang', 'es']).code, 2);
  assert.equal(run([...files.all, '--catalog', catalog, '--lang']).code, 2);
  // The synthetic catalog of the other tests has no Portuguese: the English text is printed.
  const r = run([...files.all, '--catalog', files.catalog, '--lang', 'pt']);
  assert.deepEqual(r.json.estimates.map((e) => e.label), ['Command output a filter would cut', 'Exploration a knowledge graph could answer', 'Descriptions of skills never invoked']);
});

test('the shipped catalog in Portuguese', () => {
  const doc = JSON.parse(fs.readFileSync(DEFAULT_CATALOG, 'utf8'));
  const byId = Object.fromEntries(doc.estimates.map((e) => [e.id, e]));
  const r = run([...files.all, '--lang', 'pt']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.estimates.map((e) => e.id), ['rtk-output', 'graph-exploration', 'unused-skill-descriptions']);
  for (const e of r.json.estimates) {
    assert.equal(e.label, byId[e.id].pt.label);
    assert.equal(e.source, byId[e.id].pt.basis);
  }
  assert.deepEqual(r.json.unmeasured.map((u) => [u.id, u.label, u.source]), [
    ['unused-mcp-servers', byId['unused-mcp-servers'].pt.label, byId['unused-mcp-servers'].pt.basis],
    ['unused-mcp-servers', byId['unused-mcp-servers'].pt.label, byId['unused-mcp-servers'].pt.basis],
  ]);
  // Accented text survives the trip through stdout.
  assert.ok(r.json.estimates[1].source.startsWith('Suposição, não medição:'));
  assert.ok(r.json.estimates[0].label.includes('Saída'));
});
