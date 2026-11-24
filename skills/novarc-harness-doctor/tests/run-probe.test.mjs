// run.mjs probe: the probe scripts run as child processes (stubs here, through the
// NOVARC_HD_SCRIPT_* overrides), their JSON lands under probes/<harness>/, and a probe that
// fails, hangs or prints garbage is recorded without stopping the others.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './run-helpers.mjs';

// The language probes are asked to answer in: the sandbox run's language.
const LANG = 'en';

const argOf = (call, name) => { const i = call.args.indexOf(`--${name}`); return i === -1 ? undefined : call.args[i + 1]; };

test('probe stores every script output per harness and passes the right arguments', (t) => {
  const sb = sandbox(t, { accounts: 3 });
  sb.init(['--days', '21']);
  const r = sb.run(['probe']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.failed, 0);
  assert.equal(r.json.harnesses.length, 5);
  for (const h of ['claude-1', 'codex-1', 'gemini-1', 'acme-shop', 'novarc-powers']) {
    // No transcript reader exists for the Gemini account: it has no impact and so no estimates.
    const skipped = h === 'gemini-1' ? ['impact.json', 'estimates.json'] : [];
    for (const f of ['discover.json', 'checks.json', 'impact.json', 'clis.json', 'snapshot.json', 'estimates.json']) {
      if (skipped.includes(f)) assert.equal(fs.existsSync(sb.file('probes', h, f)), false, `${h}/${f}`);
      else assert.equal(typeof sb.read('probes', h, f), 'object', `${h}/${f}`);
    }
  }
  const calls = sb.stubCalls();
  const acme = path.join(sb.home, 'dev', 'acme-shop');

  const discover = calls.filter((c) => c.script === 'discover');
  assert.equal(discover.length, 5);
  assert.deepEqual(discover.find((c) => argOf(c, 'cwd') === acme).args, ['--scope', 'project', '--cwd', acme]);
  assert.equal(argOf(discover.find((c) => argOf(c, 'cwd') === path.join(sb.home, '.claude')), 'scope'), 'user');
  const checks = calls.filter((c) => c.script === 'harness-checks');
  assert.equal(checks.length, 5);
  assert.deepEqual(checks.find((c) => argOf(c, 'cwd') === acme).args, ['--scope', 'project', '--cwd', acme]);
  // An account is one config dir of one provider: both scripts are told which, so that neither
  // reads the other accounts (tests/probe-accounts.test.mjs runs the real scripts to prove it).
  for (const [dir, provider] of [['.claude', 'claude-code'], ['.codex', 'codex'], ['.gemini', 'gemini']]) {
    const abs = path.join(sb.home, dir);
    for (const list of [discover, checks]) {
      assert.deepEqual(list.find((c) => argOf(c, 'config-dir') === abs).args, ['--scope', 'user', '--cwd', abs, '--provider', provider, '--config-dir', abs]);
    }
  }

  // Impact: per project by --cwd; each account on its own sessions only (a Claude config dir
  // with --sources claude, the Codex home with --sources codex); none for a provider without a
  // transcript reader.
  const impact = calls.filter((c) => c.script === 'session-impact');
  assert.equal(impact.length, 4, '2 projects + the Claude account + the Codex account');
  assert.ok(impact.every((c) => argOf(c, 'days') === '21'));
  assert.deepEqual(impact.find((c) => argOf(c, 'cwd') === acme).args, ['--cwd', acme, '--days', '21']);
  const claudeImpact = impact.find((c) => argOf(c, 'config-dirs'));
  assert.equal(argOf(claudeImpact, 'config-dirs'), path.join(sb.home, '.claude'));
  assert.equal(argOf(claudeImpact, 'sources'), 'claude');
  const codexImpact = impact.find((c) => argOf(c, 'sources') === 'codex');
  assert.equal(argOf(codexImpact, 'codex-dirs'), path.join(sb.home, '.codex'));
  assert.equal(argOf(codexImpact, 'scope'), 'user');
  assert.equal(sb.read('probes', 'claude-1', 'impact.json').totalTokens, 5000);

  // The CLI probe: whole for each project. The accounts share the machine and nothing else: the
  // first of them to get there runs it whole, the others are pointed at its output for the part
  // about the machine (--tools-from), and every one is told which account it is asked about.
  const clis = calls.filter((c) => c.script === 'probe-clis');
  assert.equal(clis.length, 5);
  for (const proj of [acme, path.join(sb.home, 'dev', 'novarc-powers')]) assert.deepEqual(clis.find((c) => argOf(c, 'cwd') === proj).args, ['--cwd', proj]);
  const accountDirs = { 'claude-1': ['.claude', 'claude-code'], 'codex-1': ['.codex', 'codex'], 'gemini-1': ['.gemini', 'gemini'] };
  const clisOf = (id) => clis.find((c) => argOf(c, 'config-dir') === path.join(sb.home, accountDirs[id][0]));
  const whole = Object.keys(accountDirs).filter((id) => argOf(clisOf(id), 'tools-from') === undefined);
  assert.equal(whole.length, 1, 'one account probes the machine');
  for (const [id, [dir, provider]] of Object.entries(accountDirs)) {
    const abs = path.join(sb.home, dir);
    const reuse = id === whole[0] ? [] : ['--tools-from', sb.file('probes', whole[0], 'clis.json')];
    assert.deepEqual(clisOf(id).args, ['--cwd', abs, '--provider', provider, '--config-dir', abs, ...reuse], id);
    assert.equal(typeof sb.read('probes', id, 'clis.json'), 'object');
  }

  // The snapshot runs last and is told where the impact and CLI probes are.
  const snaps = calls.filter((c) => c.script === 'snapshot-harness');
  assert.equal(argOf(snaps.find((c) => argOf(c, 'id') === 'gemini-1'), 'impact'), undefined);
  assert.equal(snaps.length, 5);
  const snapAcme = snaps.find((c) => argOf(c, 'id') === 'acme-shop');
  assert.equal(argOf(snapAcme, 'kind'), 'project');
  assert.equal(argOf(snapAcme, 'cwd'), acme);
  assert.equal(argOf(snapAcme, 'impact'), sb.file('probes', 'acme-shop', 'impact.json'));
  assert.equal(argOf(snapAcme, 'clis'), sb.file('probes', 'acme-shop', 'clis.json'));
  const snapCodex = snaps.find((c) => argOf(c, 'id') === 'codex-1');
  assert.equal(argOf(snapCodex, 'kind'), 'user');
  assert.equal(argOf(snapCodex, 'config-dir'), path.join(sb.home, '.codex'));
  assert.equal(argOf(snapCodex, 'provider'), 'codex');
  // What the snapshot words for the board (layer names, notes) is asked for in the run language.
  assert.deepEqual(snaps.map((c) => argOf(c, 'lang')), Array(5).fill(LANG));
  assert.deepEqual(sb.read('probes', 'acme-shop', 'snapshot.json').passed, { impact: true, clis: true });

  // Estimates come last, from the files the other probes left.
  const est = calls.filter((c) => c.script === 'impact-estimates');
  assert.equal(est.length, 4);
  const estAcme = est.find((c) => argOf(c, 'impact') === sb.file('probes', 'acme-shop', 'impact.json'));
  assert.deepEqual(estAcme.args, ['--impact', sb.file('probes', 'acme-shop', 'impact.json'), '--lang', LANG, '--clis', sb.file('probes', 'acme-shop', 'clis.json'), '--snapshot', sb.file('probes', 'acme-shop', 'snapshot.json'), '--discover', sb.file('probes', 'acme-shop', 'discover.json')]);

  // Two or more accounts and a primary: the account comparison is probed too.
  const accounts = calls.filter((c) => c.script === 'accounts');
  assert.deepEqual(accounts.map((c) => c.args), [['diff', '--primary', 'claude-1', '--lang', LANG]]);
  assert.equal(sb.read('probes', 'accounts', 'diff.json').primary, 'claude-1');

  const summary = sb.read('probes', 'summary.json');
  assert.equal(summary.harnesses['acme-shop'].snapshot.ok, true);
  assert.equal(summary.harnesses['codex-1'].impact.ok, true);
  assert.deepEqual(summary.harnesses['gemini-1'].impact, { ok: false, skipped: 'no-transcript-reader' });
  assert.equal(summary.accounts.diff.ok, true);
  // The summary says whose run the machine part of an account's CLI probe came from.
  assert.deepEqual(Object.keys(accountDirs).map((id) => summary.harnesses[id].clis.toolsFrom), Object.keys(accountDirs).map((id) => (id === whole[0] ? undefined : whole[0])));
  assert.ok(!('toolsFrom' in summary.harnesses['acme-shop'].clis));
});

test('a Portuguese run asks every probe that words something for the board to answer in Portuguese', (t) => {
  const sb = sandbox(t, { accounts: 2, projects: ['acme-shop'] });
  assert.equal(sb.init(['--lang', 'pt']).code, 0);
  assert.equal(sb.read('run.json').language, 'pt');
  assert.equal(sb.run(['probe']).json.failed, 0);
  const calls = sb.stubCalls();
  const langs = (script) => calls.filter((c) => c.script === script).map((c) => argOf(c, 'lang'));
  assert.deepEqual(langs('snapshot-harness'), ['pt', 'pt', 'pt'], 'one snapshot per harness, project and accounts alike');
  assert.deepEqual(langs('impact-estimates'), ['pt', 'pt', 'pt']);
  assert.deepEqual(langs('accounts'), ['pt']);
  // The snapshot's own arguments, in full, for one harness of each kind.
  const acme = path.join(sb.home, 'dev', 'acme-shop');
  const snap = (id) => calls.find((c) => c.script === 'snapshot-harness' && argOf(c, 'id') === id).args;
  assert.deepEqual(snap('acme-shop'), ['--kind', 'project', '--cwd', acme, '--id', 'acme-shop', '--lang', 'pt', '--impact', sb.file('probes', 'acme-shop', 'impact.json'), '--clis', sb.file('probes', 'acme-shop', 'clis.json')]);
  assert.deepEqual(snap('codex-1'), ['--kind', 'user', '--config-dir', path.join(sb.home, '.codex'), '--provider', 'codex', '--id', 'codex-1', '--lang', 'pt', '--impact', sb.file('probes', 'codex-1', 'impact.json'), '--clis', sb.file('probes', 'codex-1', 'clis.json')]);
});

test('when the machine cannot be probed, the accounts report that one failure and do not try again', (t) => {
  const sb = sandbox(t, { accounts: 3, projects: [] });
  sb.init();
  const r = sb.run(['probe'], { STUB_FAIL: 'probe-clis' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sb.stubCalls().filter((c) => c.script === 'probe-clis').length, 1);
  for (const h of r.json.harnesses) {
    assert.equal(h.probes.clis.ok, false, h.id);
    assert.match(h.probes.clis.error, /exit code 3/);
    assert.equal(sb.read('probes', h.id, 'clis.error.json').script, 'probe-clis.mjs');
    assert.ok(!sb.exists('probes', h.id, 'clis.json'));
    assert.equal(sb.read('probes', h.id, 'snapshot.json').passed.clis, false, 'no snapshot is pointed at a probe that failed');
  }
  // One account asked about on its own probes the machine itself.
  const one = sb.run(['probe', '--harness', 'codex-1']);
  assert.deepEqual(one.json.harnesses[0].probes.clis.ok, true);
  const last = sb.stubCalls().filter((c) => c.script === 'probe-clis').pop();
  assert.deepEqual(last.args, ['--cwd', path.join(sb.home, '.codex'), '--provider', 'codex', '--config-dir', path.join(sb.home, '.codex')]);
});

test('a harness that carries its own window is measured over it; the others over the run window', (t) => {
  const sb = sandbox(t);
  sb.init(['--days', '21']);
  // `run.mjs init` writes `windowDays` on a harness that has an earlier review record; the
  // probe only reads it. Anything that is not a positive whole number falls back to the run's.
  const edit = (fn) => { const run = sb.read('run.json'); fn(run, (id) => run.harnesses.find((h) => h.id === id)); fs.writeFileSync(sb.file('run.json'), JSON.stringify(run, null, 2)); };
  edit((run, h) => { h('acme-shop').windowDays = 7; h('claude-1').windowDays = 9; h('novarc-powers').windowDays = 0; h('codex-1').windowDays = '14'; });
  assert.equal(sb.run(['probe']).json.failed, 0);
  const impact = () => sb.stubCalls().filter((c) => c.script === 'session-impact');
  const daysOf = (calls) => ({
    'acme-shop': argOf(calls.find((c) => argOf(c, 'cwd') === path.join(sb.home, 'dev', 'acme-shop')), 'days'),
    'novarc-powers': argOf(calls.find((c) => argOf(c, 'cwd') === path.join(sb.home, 'dev', 'novarc-powers')), 'days'),
    'claude-1': argOf(calls.find((c) => argOf(c, 'config-dirs') === path.join(sb.home, '.claude')), 'days'),
    'codex-1': argOf(calls.find((c) => argOf(c, 'codex-dirs') === path.join(sb.home, '.codex')), 'days'),
  });
  assert.deepEqual(daysOf(impact()), { 'acme-shop': '7', 'novarc-powers': '21', 'claude-1': '9', 'codex-1': '21' });
  assert.equal(sb.read('probes', 'acme-shop', 'impact.json').windowDays, 7);
  assert.equal(sb.read('probes', 'novarc-powers', 'impact.json').windowDays, 21);
  assert.equal(sb.read('probes', 'summary.json').windowDays, 21, 'the summary keeps the window of the run');

  // Other values that are not a window, and a run that names none: 30 days.
  const before = impact().length;
  edit((run, h) => { delete run.windowDays; h('novarc-powers').windowDays = 3.5; h('codex-1').windowDays = -2; h('claude-1').windowDays = null; });
  assert.equal(sb.run(['probe']).json.failed, 0);
  assert.deepEqual(daysOf(impact().slice(before)), { 'acme-shop': '7', 'novarc-powers': '30', 'claude-1': '30', 'codex-1': '30' });
});

test('a failing probe is recorded and the others still run', (t) => {
  const sb = sandbox(t, { accounts: 1 });
  sb.init();
  assert.equal(sb.run(['probe']).json.failed, 0);
  assert.ok(sb.exists('probes', 'acme-shop', 'clis.json'));

  const r = sb.run(['probe'], { STUB_FAIL: 'probe-clis' });
  assert.equal(r.code, 0, 'a failed probe is a result, not a failure of the command');
  assert.equal(r.json.failed, 3);
  assert.equal(r.json.ok, 15);
  assert.deepEqual(sb.read('probes', 'acme-shop', 'estimates.json').given, { impact: true, clis: false, snapshot: true, discover: true });
  assert.equal(sb.stubCalls().filter((c) => c.script === 'probe-clis').length, 6, 'two probe runs, three harnesses, nothing shared with one account');
  const acme = r.json.harnesses.find((h) => h.id === 'acme-shop').probes;
  assert.equal(acme.clis.ok, false);
  assert.match(acme.clis.error, /exit code 3/);
  assert.equal(acme.snapshot.ok, true);
  assert.equal(acme.impact.ok, true);

  const err = sb.read('probes', 'acme-shop', 'clis.error.json');
  assert.equal(err.probe, 'clis');
  assert.equal(err.script, 'probe-clis.mjs');
  assert.equal(err.exitCode, 3);
  assert.ok(!err.stderr.includes(sb.home), 'the recorded stderr holds no absolute home path');
  assert.match(err.stderr, /stub failure in .* home ~/);
  assert.ok(!sb.exists('probes', 'acme-shop', 'clis.json'), 'an older success does not stay behind a failure');
  assert.deepEqual(sb.read('probes', 'acme-shop', 'snapshot.json').passed, { impact: true, clis: false }, 'the snapshot is not pointed at a probe that failed');
  assert.equal(sb.read('probes', 'summary.json').harnesses['acme-shop'].clis.ok, false);

  // A later success clears the error record.
  assert.equal(sb.run(['probe', '--harness', 'acme-shop']).json.failed, 0);
  assert.ok(!sb.exists('probes', 'acme-shop', 'clis.error.json'));
  assert.ok(sb.exists('probes', 'acme-shop', 'clis.json'));
  assert.equal(sb.read('probes', 'summary.json').harnesses['novarc-powers'].clis.ok, false, '--harness leaves the other harnesses as they were');
});

test('a probe that hangs times out, one that prints garbage is rejected, a missing script is reported', (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop'] });
  sb.init();
  const r = sb.run(['probe', '--concurrency', '1'], {
    STUB_HANG: 'discover', STUB_GARBAGE: 'harness-checks', NOVARC_HD_PROBE_TIMEOUT_MS: '5000', // long enough for a loaded machine to start the other stubs
    NOVARC_HD_SCRIPT_PROBE_CLIS: path.join(sb.stubDir, 'does-not-exist.mjs'),
  });
  assert.equal(r.code, 0, r.stderr);
  const p = r.json.harnesses[0].probes;
  assert.match(p.discover.error, /timed out/);
  assert.equal(sb.read('probes', 'acme-shop', 'discover.error.json').timedOut, true);
  assert.match(p.checks.error, /not a JSON object/);
  assert.match(p.clis.error, /script not found/);
  assert.equal(p.impact.ok, true);
  assert.equal(p.snapshot.ok, true);
  assert.equal(p.estimates.ok, true);
  assert.equal(r.json.failed, 3);

  // Without the measurement there is nothing to estimate: the step is left out, not failed.
  const noImpact = sb.run(['probe'], { STUB_FAIL: 'session-impact' });
  assert.deepEqual(Object.keys(noImpact.json.harnesses[0].probes), ['discover', 'checks', 'impact', 'clis', 'snapshot']);
  assert.ok(!sb.exists('probes', 'acme-shop', 'estimates.json'), 'estimates of an earlier run do not outlive their measurement');
  assert.deepEqual(sb.read('probes', 'acme-shop', 'snapshot.json').passed, { impact: false, clis: true });
});

test('probe --harness takes one harness; an unknown one or a bad option is an error', (t) => {
  const sb = sandbox(t, { accounts: 1 });
  sb.init();
  const r = sb.run(['probe', '--harness', 'novarc-powers']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.harnesses.map((h) => h.id), ['novarc-powers']);
  assert.ok(!fs.existsSync(sb.file('probes', 'acme-shop', 'snapshot.json')));
  assert.equal(sb.run(['probe', '--harness', 'nope']).code, 1);
  assert.equal(sb.run(['probe', '--timeout', 'soon']).code, 2);
  assert.equal(sb.run(['probe', '--concurrency', '0']).code, 2);
  assert.equal(sb.stubCalls().filter((c) => c.script === 'accounts').length, 0, 'one account: nothing to compare');
});
