// run.mjs as a command line: --help in every form prints the usage and runs nothing, and the
// usage and the accepted options are one table, so they cannot drift apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, securityFindings } from './run-helpers.mjs';
import { SCRIPTS, runScript } from './helpers.mjs';
import { optionsOf, helpText } from '../scripts/run.mjs';

const COMMANDS = ['init', 'list', 'history', 'status', 'probe', 'claim', 'release', 'complete', 'build', 'decide', 'decisions', 'mark', 'record', 'undo', 'next', 'close'];

test('run.mjs --help, -h and help print the usage on stdout and exit 0', (t) => {
  const sb = sandbox(t);
  const forms = [['--help'], ['-h'], ['help'], ['--run', 'whatever', '--help']];
  const texts = forms.map((args) => {
    const r = sb.run(args);
    assert.equal(r.code, 0, args.join(' '));
    assert.equal(r.stderr, '');
    assert.equal(r.json, null, 'usage is text, not JSON');
    return r.stdout;
  });
  assert.ok(texts.every((x) => x === texts[0]), 'every form prints the same');
  assert.equal(texts[0], helpText());
  assert.match(texts[0], /^run\.mjs <command> \[options\]\n/);
  for (const name of COMMANDS) {
    assert.match(texts[0], new RegExp(`^  ${name}$`, 'm'), name);
    // Every option of every command is in the general usage.
    for (const option of optionsOf(name)) assert.ok(texts[0].split('\n').some((line) => line.includes(`run.mjs ${name}`) && line.includes(`--${option}`)), `${name} --${option}`);
  }
  assert.ok(!fs.existsSync(path.join(sb.home, '.novarc-powers')), 'asking for help writes nothing');

  // Without a command it is still a bad command line, and says where the usage is.
  const none = sb.run([]);
  assert.equal(none.code, 2);
  assert.match(none.json.error, /^usage: run\.mjs <init\|list\|.*\|close> \[options\] \(run\.mjs --help lists every option\)$/);
  assert.equal(sb.run(['frobnicate']).code, 2);
  assert.equal(sb.run(['frobnicate', '--help']).code, 2, 'an unknown command is an error with or without --help');
});

test('<command> --help and -h print that command and run nothing', (t) => {
  const sb = sandbox(t);
  // No run exists yet: a command that needs one would fail if it ran.
  for (const name of COMMANDS) {
    const r = sb.run([name, '--help']);
    assert.equal(r.code, 0, `${name} --help`);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, helpText(name));
    assert.ok(r.stdout.startsWith(`run.mjs ${name}`), r.stdout);
    for (const other of COMMANDS) if (other !== name) assert.ok(!r.stdout.includes(`run.mjs ${other} `), `${name} --help is about ${name} only`);
  }
  for (const name of ['status', 'decide', 'undo']) {
    const short = sb.run([name, '-h']);
    assert.deepEqual([short.code, short.stdout], [0, helpText(name)], `${name} -h`);
    assert.equal(sb.run(['help', name]).stdout, helpText(name));
  }
  assert.match(helpText('decide'), /--target <itemId\|groupId\|accounts\.primary> --action approve\|decline\|defer\|ask \[--note <t>\] \[--exclude <id,id>\] \[--rev <rev>\]\nrun\.mjs decide \[--run <id>\] --target <itemId\|accounts\.primary> --answered\n/);
  assert.match(helpText('decisions'), /\[--ingest <file\.json\|directory>\]/);
  assert.ok(!fs.existsSync(path.join(sb.home, '.novarc-powers')));

  // With every other argument in place, and wherever the flag stands, nothing happens.
  const selection = path.join(sb.home, 'selection.json');
  fs.writeFileSync(selection, JSON.stringify(sb.selection));
  assert.equal(sb.run(['init', '--select', selection, '--help']).code, 0);
  assert.equal(sb.run(['init', '-h', '--select', selection]).code, 0);
  assert.ok(!fs.existsSync(path.join(sb.home, '.novarc-powers')), 'init --help starts no run');

  assert.equal(sb.init().code, 0);
  const findings = path.join(sb.home, 'findings.json');
  fs.writeFileSync(findings, JSON.stringify(securityFindings()));
  const before = () => JSON.stringify(fs.readdirSync(sb.dir, { recursive: true }).sort()) + sb.text('run.json') + sb.text('status.json') + sb.text('queue.json') + sb.text('log.jsonl');
  const snapshot = before();
  const calls = [
    ['claim', '--session', 'me', '--help'],
    ['complete', '--unit', 'review:security', '--session', 'me', '--findings', findings, '-h'],
    ['probe', '--help'],
    ['build', '--no-render', '--help'],
    ['decide', '--target', 'accounts.primary', '--action', 'approve', '--note', 'codex-1', '--help'],
    ['decide', '--help', '--target', 'accounts.primary', '--action', 'approve', '--note', 'codex-1'],
    ['decisions', '--ingest', findings, '-h'],
    ['mark', '--item', 'ACME-101', '--status', 'in-progress', '--auto', '--help'],
    ['undo', '--all', '--yes', '--help'],
    ['close', '--help'],
    ['close', '-h'],
  ];
  for (const args of calls) {
    const r = sb.run(args);
    assert.equal(r.code, 0, args.join(' '));
    assert.equal(r.stdout, helpText(args[0]), args.join(' '));
  }
  assert.equal(before(), snapshot, 'the run directory is exactly as it was');
  assert.equal(sb.read('run.json').closed, false);
  assert.equal(sb.read('run.json').primary, 'claude-1');
  assert.deepEqual(sb.stubCalls(), [], 'no probe was started');
});

test('an option that is not in the usage is refused, so a typo never changes what a command does', (t) => {
  const sb = sandbox(t);
  assert.equal(sb.init().code, 0);
  assert.equal(sb.complete('review:security', securityFindings()).code, 0);
  assert.equal(sb.run(['build', '--no-render']).code, 0);

  // `--exlude` would otherwise be ignored, and the whole group approved.
  const typo = sb.run(['decide', '--target', 'G-1', '--action', 'approve', '--exlude', 'NP-101']);
  assert.equal(typo.code, 2);
  assert.equal(typo.json.error, 'unknown option --exlude for decide (see run.mjs decide --help)');
  assert.ok(!sb.exists('decisions.jsonl'), 'nothing was decided');
  assert.equal(sb.run(['status', '--verbose']).code, 2);
  assert.equal(sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress', '--force']).code, 2);
  assert.equal(sb.run(['next', '--run', sb.runId, '--json']).code, 2);
  assert.equal(sb.run(['list', '--run', sb.runId]).code, 2, 'list takes no option');
  // An option of another command is not an option of this one.
  assert.equal(sb.run(['decisions', '--note', 'x']).code, 2);
  assert.equal(sb.run(['decisions', '--run', sb.runId]).code, 0);
  assert.equal(sb.run(['decide', '--target=G-1', '--action=approve', '--exclude=NP-101']).code, 0, 'the --name=value form is the same option');
});

test('the usage table lists exactly the options the code reads', () => {
  // Every `args.<name>`, `args['<name>']` and helper(args, '<name>') in run.mjs and lib/run.
  const sources = ['run.mjs', ...fs.readdirSync(path.join(SCRIPTS, 'lib', 'run')).filter((f) => f.endsWith('.mjs')).map((f) => path.join('lib', 'run', f))];
  const read = new Set();
  for (const rel of sources) {
    const text = fs.readFileSync(path.join(SCRIPTS, rel), 'utf8');
    for (const re of [/\bargs\.([A-Za-z][A-Za-z0-9]*)\b/g, /\bargs\['([a-z][a-z0-9-]*)'\]/g, /\b(?:fileArg|noteArg)\(args, '([a-z][a-z0-9-]*)'\)/g]) {
      for (const m of text.matchAll(re)) read.add(m[1]);
    }
  }
  read.delete('_');
  const listed = new Set(COMMANDS.flatMap((name) => [...optionsOf(name)]));
  assert.deepEqual([...read].filter((o) => !listed.has(o)).sort(), [], 'read by the code, missing from the usage table in run.mjs');
  assert.deepEqual([...listed].filter((o) => !read.has(o)).sort(), [], 'in the usage table, read by nothing');
});

test('serve-board.mjs and secret-scan.mjs print their usage for --help instead of running', (t) => {
  const sb = sandbox(t);
  assert.equal(sb.init().code, 0);
  for (const flag of ['--help', '-h']) {
    const serve = runScript('serve-board.mjs', ['--run', sb.runId, flag], { env: sb.env, timeout: 20000 });
    assert.equal(serve.code, 0, 'it did not start a server and wait');
    assert.match(serve.stdout, /^usage: serve-board\.mjs \[--run <id>\] \[--port 0\]\n/);
    assert.ok(!serve.stdout.includes('http://'), 'no server address: nothing listens');
    const scan = runScript('secret-scan.mjs', [flag, sb.home], { env: sb.env });
    assert.equal(scan.code, 0);
    assert.match(scan.stdout, /^usage: secret-scan\.mjs <path\.\.\.>/);
    assert.equal(scan.json, null, 'nothing was scanned');
  }
});
