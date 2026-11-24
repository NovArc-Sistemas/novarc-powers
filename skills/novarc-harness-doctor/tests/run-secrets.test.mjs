// The credential barrier of a run (scripts/lib/run/secrets.mjs): a findings file, a decision note
// or a verification note that holds a credential is refused, naming only where it is; whatever
// still reaches `build` by another path is masked before state.json and the board are written.
//
// Every assertion about a leak is made on the literal token: the scanner is never asked whether
// its own output is clean. The tokens are assembled at run time, so this file holds none.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, securityFindings, item, filesContaining } from './run-helpers.mjs';
import { credentialKinds, findCredentials, credentialErrors, maskCredentials, maskDeep } from '../scripts/lib/run/secrets.mjs';

const GITHUB = 'ghp_' + 'Q'.repeat(36);
const ANTHROPIC = 'sk-' + 'ant-' + 'api03-' + 'x'.repeat(40);
const AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const PEM = '-----BEGIN ' + 'RSA PRIVATE KEY' + '-----';
const PASSWORD = 'Corr3ctHorse' + 'BatteryStaple99';
const ASSIGNMENT = 'pass' + 'word = ' + PASSWORD;
/** [text that holds a credential, the literal that must never be seen again]. */
const SECRETS = [
  [`token=${GITHUB}`, GITHUB],
  [`"apiKey": "${ANTHROPIC}"`, ANTHROPIC],
  [`aws_access_key_id = ${AWS}`, AWS],
  [`${PEM}\nMIIEowIBAAKCAQEA`, PEM],
  [ASSIGNMENT, PASSWORD],
];
/** True when `text` shows the secret, or any 10-character run of its start. */
const shows = (text, secret) => text.includes(secret) || text.includes(secret.slice(0, 10));
const at = (s) => `2020-06-01T10:00:${String(s).padStart(2, '0')}.000Z`;

function ready(t) {
  const sb = sandbox(t);
  assert.equal(sb.init().code, 0);
  return sb;
}

test('a credential is found with its JSON pointer and never quoted, not even in part', () => {
  for (const [text, secret] of SECRETS) {
    assert.ok(credentialKinds(text).length > 0, `found: ${text.slice(0, 12)}`);
    const hits = findCredentials({ items: [{ evidence: `see ${text}` }] });
    assert.deepEqual(hits.map((h) => h.at), ['/items/0/evidence']);
    assert.ok(!shows(JSON.stringify(hits) + credentialErrors(hits).join('\n'), secret), 'a hit carries the pointer and the kind only');
    assert.ok(!shows(maskCredentials(`see ${text}`), secret), 'masking leaves no usable part of it');
  }
  // The masked form is the first 4 characters, an ellipsis and the length.
  assert.equal(maskCredentials(`token=${GITHUB}`), 'token=ghp_…40');
  assert.deepEqual(credentialKinds(`token=${GITHUB}`), ['github-token']);

  // A property name that is a credential never becomes part of a pointer.
  const keyed = findCredentials({ fileRoles: { [GITHUB]: 'x', fine: `uses ${ANTHROPIC}` }, [AWS]: { deep: [GITHUB] } });
  assert.deepEqual(keyed.map((h) => [h.at, h.key]), [['/fileRoles', true], ['/fileRoles/fine', false], ['/', true], ['/<masked property name>/deep/0', false]]);
  for (const secret of [GITHUB, ANTHROPIC, AWS]) assert.ok(!shows(JSON.stringify(keyed) + credentialErrors(keyed).join('\n'), secret));
  assert.match(credentialErrors(keyed)[0], /^\/fileRoles: a property name holds a credential \(github-token\); write it masked/);

  const masked = [];
  const out = maskDeep({ a: [`x ${GITHUB}`, 'clean'], [GITHUB]: { b: ANTHROPIC } }, masked);
  assert.deepEqual(masked, ['/a/0', '/<masked property name>', '/<masked property name>/b']);
  assert.ok(!shows(JSON.stringify(out) + masked.join(' '), GITHUB) && !shows(JSON.stringify(out), ANTHROPIC));
  assert.equal(out.a[1], 'clean');

  // What a reviewer is told to write instead passes: the masked form, a reference, a placeholder.
  for (const fine of ['token=ghp_…40', '"apiKey": "sk-a…53"', 'token = "${GITHUB_TOKEN}"', 'export GITHUB_TOKEN=<token>', 'Authorization: Bearer ${TOKEN}', 'Says the same in fewer tokens.', 'CLAUDE.md:2', '~/.claude/settings.json']) {
    assert.deepEqual(credentialKinds(fine), [], fine);
    assert.equal(maskCredentials(fine), fine);
  }
});

test('complete rejects a findings file that holds a credential, naming the pointers only', (t) => {
  const sb = ready(t);
  const places = [
    ['/items/1/evidence', (f, text) => { f.items[1].evidence = `settings.json:3 ${text}`; }],
    ['/items/1/changes/0/before', (f, text) => { f.items[1].changes[0].before = text; }],
    ['/items/1/changes/0/after', (f, text) => { f.items[1].changes[0].after = text; }],
    ['/items/0/lesson/why', (f, text) => { f.items[0].lesson.why = `It ships ${text} to every session.`; }],
    ['/inventory/0/opinion', (f, text) => { f.inventory[0].opinion = text; }],
    ['/leads/0/source', (f, text) => { f.leads[0].source = text; }],
    ['/elements/acme-shop/hooks/0/note', (f, text) => { f.elements['acme-shop'].hooks[0].note = text; }],
    ['/fileRoles/facme-shop-1', (f, text) => { f.fileRoles['facme-shop-1'] = text; }],
    ['/session', (f, text) => { f.session = text; }],
  ];
  let n = 0;
  for (const [pointer, plant] of places) {
    const [text, secret] = SECRETS[n++ % SECRETS.length];
    const f = securityFindings();
    plant(f, text);
    const r = sb.complete('review:security', f);
    assert.equal(r.code, 1, pointer);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /^findings rejected: 1 problem/);
    assert.equal(r.json.errors.length, 1, 'the credential, and nothing else');
    assert.ok(r.json.errors[0].startsWith(`${pointer}: credential (`), r.json.errors[0]);
    assert.match(r.json.errors[0], /write it masked/);
    assert.ok(!shows(r.stdout + r.stderr, secret), `${pointer}: the rejection does not show the value`);
  }

  // A property name: the pointer stops at the object, and no other message echoes the name.
  const named = securityFindings();
  named.fileRoles[GITHUB] = 'a role';
  named[ANTHROPIC] = 'an unknown top-level key';
  const r = sb.complete('review:security', named);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json.errors.map((e) => e.split(' (')[0]), ['/fileRoles: a property name holds a credential', '/: a property name holds a credential']);
  assert.ok(!shows(r.stdout + r.stderr, GITHUB) && !shows(r.stdout + r.stderr, ANTHROPIC));

  // Several at once are all named; nothing was stored, logged or queued along the way.
  const many = securityFindings();
  many.items[1].evidence = SECRETS[0][0];
  many.items[2].changes[0].after = SECRETS[1][0];
  assert.deepEqual(sb.complete('review:security', many).json.errors.map((e) => e.split(':')[0]), ['/items/1/evidence', '/items/2/changes/0/after']);
  assert.ok(!sb.exists('findings', 'review.security.json'), 'a rejected file stores nothing');
  assert.equal(sb.read('queue.json').units[0].status, 'pending');
  for (const [, secret] of SECRETS) assert.deepEqual(filesContaining(sb.dir, secret), [], 'nothing under the run directory holds it');
});

test('a secret in a config file is reported masked, as the snapshot shows it, and builds clean', (t) => {
  const sb = ready(t);
  assert.equal(sb.run(['probe']).code, 0);
  // The file on disk holds the token; the snapshot shows `ghp_…40`. The item quotes the snapshot,
  // puts a reference in its place, and is classed `secret`.
  const f = securityFindings();
  f.items[1] = item('ACME-101', 'acme-shop', 1, {
    class: 'secret', severity: 'critical', evidence: './settings.json:1 github-token ghp_…40',
    proposal: 'Read the token from the environment; rotate the one that was in the file.',
    changes: [{ path: './settings.json', lang: 'json', before: '"token": "ghp_…40"', after: '"token": "${GITHUB_TOKEN}"', why: 'The file no longer holds the credential.' }],
  });
  const ok = sb.complete('review:security', f);
  assert.equal(ok.code, 0, ok.stdout);
  // Copied from the file on disk instead, it is refused.
  const raw = securityFindings();
  raw.items[1] = { ...f.items[1], changes: [{ ...f.items[1].changes[0], before: `"token": "${GITHUB}"` }] };
  const refused = sb.complete('review:security', raw);
  assert.equal(refused.code, 1);
  assert.deepEqual(refused.json.errors.map((e) => e.split(':')[0]), ['/items/1/changes/0/before']);

  const b = sb.run(['build'], { STUB_RENDER_DUMP: '1' });
  assert.equal(b.code, 0, b.stdout);
  assert.ok(!b.json.mergeWarnings.some((w) => /credential/.test(w.problem)), 'nothing to mask: the masked form is not a credential');
  const shownItem = sb.read('state.json').items.find((i) => i.id === 'ACME-101');
  assert.equal(shownItem.changes[0].before, '"token": "ghp_…40"');
  assert.equal(shownItem.changes[0].after, '"token": "${GITHUB_TOKEN}"');
  assert.deepEqual(filesContaining(sb.dir, GITHUB), []);
});

test('a credential in a note, a title or a label is refused wherever it comes in', (t) => {
  const sb = ready(t);
  assert.equal(sb.complete('review:security', securityFindings()).code, 0);
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  const before = sb.text('status.json');
  const clean = (r, secret, what) => assert.ok(!shows(r.stdout + r.stderr, secret), `${what}: the answer does not show the value`);

  // Chat.
  const said = sb.run(['decide', '--target', 'ACME-101', '--action', 'approve', '--note', `ok, and use ${GITHUB} for it`]);
  assert.equal(said.code, 2);
  assert.match(said.json.error, /^note holds a credential: write it masked/);
  clean(said, GITHUB, 'decide');
  const asked = sb.run(['decide', '--target', 'ACME-101', '--action', 'ask', '--note', ASSIGNMENT]);
  assert.equal(asked.code, 2);
  clean(asked, PASSWORD, 'decide ask');

  // An export from the Artifact database, as a file and as a directory; a line in decisions.jsonl.
  const file = path.join(sb.home, 'export.json');
  fs.writeFileSync(file, JSON.stringify([
    { id: 'leak-1', at: at(1), target: 'ACME-101', action: 'approve', note: `token ${ANTHROPIC}` },
    { id: GITHUB, at: at(2), target: 'ACME-102', action: 'approve' },
    { id: 'fine-1', at: at(3), target: 'NP-101', action: 'decline', note: 'the token is ghp_…40, masked' },
  ]));
  const ingested = sb.run(['decisions', '--ingest', file]);
  assert.equal(ingested.code, 0, ingested.stdout);
  assert.deepEqual(ingested.json.new.map((d) => [d.id, d.result]), [['fine-1', 'applied']]);
  assert.deepEqual(ingested.json.rejected.map((x) => [x.source, x.reason.split(':')[0]]), [['entry 1', 'note holds a credential'], ['entry 2', 'id must be a short token, not a credential']]);
  clean(ingested, ANTHROPIC, 'ingest');
  clean(ingested, GITHUB, 'ingest');
  const dir = path.join(sb.home, 'export-dir');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'ACME-102.json'), JSON.stringify({ id: 'leak-2', at: at(4), action: 'defer', note: SECRETS[2][0] }));
  const fromDir = sb.run(['decisions', '--ingest', dir]);
  assert.deepEqual(fromDir.json.rejected.map((x) => [x.source, x.reason.split(':')[0]]), [['file ACME-102.json', 'note holds a credential']]);
  clean(fromDir, AWS, 'ingest directory');

  // After applying.
  sb.run(['decide', '--target', 'ACME-101', '--action', 'approve']);
  sb.run(['mark', '--item', 'ACME-101', '--status', 'in-progress']);
  for (const flag of ['--verified', '--not-verified']) {
    const marked = sb.run(['mark', '--item', 'ACME-101', '--status', 'fixed', flag, `checked with ${GITHUB}`]);
    assert.equal(marked.code, 2, flag);
    assert.match(marked.json.error, /holds a credential: write it masked/);
    clean(marked, GITHUB, flag);
  }
  assert.equal(sb.read('status.json').items['ACME-101'].status, 'in-progress');

  // The title of a run and the label of a session.
  const titled = sb.init(['--title', ANTHROPIC]);
  assert.equal(titled.code, 2);
  clean(titled, ANTHROPIC, 'init --title');
  const label = 'sk-' + 'ant-' + 'a1b2c3d4e5f6a7b8c9d0e1f2';
  const claimed = sb.run(['claim', '--session', label]);
  assert.equal(claimed.code, 2);
  clean(claimed, label, 'claim --session');

  // None of it is anywhere under the home the run tooling writes to, apart from the two export
  // files this test wrote itself.
  for (const secret of [GITHUB, ANTHROPIC, AWS, PASSWORD, label]) {
    assert.deepEqual(filesContaining(sb.home, secret).filter((p) => !p.startsWith('export')), [], 'no file holds it');
  }
  assert.notEqual(sb.text('status.json'), before, 'the clean decisions were taken in');
});

test('what reaches build by another path is masked, with a warning that says where; the board still builds', (t) => {
  const sb = ready(t);
  assert.equal(sb.run(['probe']).code, 0);
  assert.equal(sb.complete('review:security', securityFindings()).code, 0);
  sb.run(['decide', '--target', 'ACME-101', '--action', 'approve', '--note', 'go ahead']);

  // A probe that did not mask a file; a findings file, a status overlay and a log line written
  // before the check existed (planted on disk: none of them could come in through a command).
  const snapshotFile = sb.file('probes', 'acme-shop', 'snapshot.json');
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  snapshot.files[0].content += `api_token = "${GITHUB}"\n`;
  snapshot.elements.hooks[0].matcher = `Bash(${SECRETS[2][0]})`;
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot));
  const findingsFile = sb.file('findings', 'review.security.json');
  const findings = JSON.parse(fs.readFileSync(findingsFile, 'utf8'));
  findings.items.find((i) => i.id === 'ACME-102').evidence = `settings.json:3 ${SECRETS[1][0]}`;
  findings.defenses[0].detail = `${PEM} is in the repo`;
  fs.writeFileSync(findingsFile, JSON.stringify(findings));
  const status = sb.read('status.json');
  status.items['ACME-101'].decision = `yes, with ${ASSIGNMENT}`;
  fs.writeFileSync(sb.file('status.json'), JSON.stringify(status));
  fs.appendFileSync(sb.file('log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), event: 'decision', harness: 'acme-shop', item: 'ACME-102', action: 'approve', via: 'chat', note: `use ${GITHUB}` })}\n`);

  const b = sb.run(['build'], { STUB_RENDER_DUMP: '1' });
  assert.equal(b.code, 0, b.stdout + b.stderr);
  assert.equal(b.json.rendered, true, 'the board is built all the same');
  const state = sb.read('state.json');
  const where = b.json.mergeWarnings.filter((w) => /^credential masked at /.test(w.problem)).map((w) => w.problem.slice('credential masked at '.length)).sort();
  const fileAt = state.files.findIndex((f) => f.id === 'facme-shop-1');
  const itemAt = (id) => state.items.findIndex((i) => i.id === id);
  const harnessAt = state.harnesses.findIndex((h) => h.id === 'acme-shop');
  const logAt = state.log.findIndex((l) => l.item === 'ACME-102' && /Approved in chat/.test(l.text));
  assert.deepEqual(where, [
    '/defenses/0/detail',
    `/files/${fileAt}/content`,
    `/harnesses/${harnessAt}/elements/hooks/0/matcher`,
    `/items/${itemAt('ACME-101')}/decision`,
    `/items/${itemAt('ACME-102')}/evidence`,
    `/log/${logAt}/text`,
  ].sort());

  // On the literal strings: not in the state, not on the board, not in what the command printed.
  for (const name of ['state.json', 'board.html', 'board.md']) {
    const text = sb.text(name);
    for (const [, secret] of SECRETS) assert.ok(!shows(text, secret), `${name} does not hold ${secret.slice(0, 4)}…`);
  }
  for (const [, secret] of SECRETS) assert.ok(!shows(b.stdout + b.stderr, secret));
  assert.match(sb.text('board.html'), /api_token = \\"ghp_…40\\"/, 'the board shows the masked form, in place');
  assert.equal(state.files[fileAt].content, `# Rules\nline one\nline two\napi_token = "ghp_…40"\n`, 'the rest of the file is untouched');
  assert.equal(state.items[itemAt('ACME-102')].evidence, 'settings.json:3 "apiKey": "sk-a…53"');

  // The same inputs give the same state, masked the same way.
  const first = sb.text('state.json');
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  assert.equal(sb.text('state.json'), first);
});
