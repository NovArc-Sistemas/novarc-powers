// The history folder is plain files in the home of the person: anything may have edited them.
// What is read back from there (a record, the index, the name of a file) passes the same barrier
// as anything else before it is used or printed, is read only up to fixed limits, and is ignored
// with a reason when it is not a record. The records are the truth; the `.md` beside each one and
// index.json are made from them, so a history left half-written by a killed command is put right
// by the next one. Every scenario runs real run.mjs processes over a temporary home.
//
// No token and no address is written in this file: each one is put together from its parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, item, clock, historyOf, measured, writeImpact, firstReview, FIRST } from './run-helpers.mjs';
import { tmpDir, rmrf } from './helpers.mjs';
import { validateRecord, forgetRecords, listRecords } from '../scripts/lib/run/followup.mjs';
import { withLock, lostLocks } from '../scripts/lib/run/store.mjs';
import { validate, prune } from '../scripts/lib/run/schema.mjs';
import { maskDeep } from '../scripts/lib/run/secrets.mjs';
import { scrubDeep } from '../scripts/lib/run/scrub.mjs';

const one = (t) => sandbox(t, { accounts: 0, projects: ['acme-shop'] });
const TOKEN = 'ghp_' + 'T'.repeat(36);
const MAIL = ['alice', 'example.test'].join('@');
const SECOND = '2026-02-10T12:00:00.000Z';
/** A lock left by a killed process is taken over after this long. */
const IMPATIENT = { NOVARC_HD_LOCK_STALE_MS: '300' };

function recordOf(sb, first) {
  const history = historyOf(sb);
  const file = path.join(history.dir, first.key, `${first.runId}.json`);
  return { history, file, dir: path.join(history.dir, first.key), text: fs.readFileSync(file, 'utf8'), json: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
function followUp(sb, at = SECOND) {
  const r = sb.run(['init', '--follow-up', 'latest'], clock(at));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  sb.runId = r.json.runId;
  sb.dir = r.json.dir;
  writeImpact(sb, 'acme-shop', measured({ from: '2026-01-11T12:00:00.000Z', to: at, sessions: 25 }));
  return r;
}
const spellings = (home) => [home, home.replace(/\\/g, '\\\\'), home.replace(/\\/g, '/')];

test('a record edited by hand: a token, an address and a home path in it never reach stdout, the state or the board', (t) => {
  const sb = one(t);
  const first = firstReview(sb);
  const rec = recordOf(sb, first);
  const hostile = rec.json();
  hostile.name = `${TOKEN} ${MAIL} ${path.join(sb.home, 'private')}`;
  hostile.items[0].title = `Fixed for ${MAIL}, key ${TOKEN}`;
  hostile.items[1].decision.note = `ask ${MAIL}, token ${TOKEN}, see ${path.join(sb.home, 'notes.txt')}`;
  assert.deepEqual(validateRecord(hostile), [], 'it is still a valid record: the schema is not what keeps this in');
  fs.writeFileSync(rec.file, JSON.stringify(hostile));

  const leaks = (text) => [TOKEN, TOKEN.slice(0, 12), MAIL, ...spellings(sb.home)].filter((s) => text.includes(s));
  const listed = sb.run(['history', '--json']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(leaks(listed.stdout.replace(JSON.stringify(listed.json.historyDir).slice(1, -1), '<historyDir>')), [], 'apart from the folder the command is documented to name');
  assert.match(listed.json.harnesses[0].name, /^ghp_…40 al…@example\.test ~[\\/]private$/, 'masked, not dropped: the review is still listed');
  const asText = sb.run(['history']);
  assert.deepEqual(leaks(asText.stdout), []);

  // A follow-up reads that record: what it takes from it is masked on the way in.
  const started = followUp(sb);
  assert.deepEqual(leaks(started.stdout.replace(/"(dir|file)": "[^"]*"/g, '')), []);
  const prev = { run: first.runId, item: 'ACME-102' };
  assert.equal(sb.complete('review:security', {
    rounds: [{ harness: 'acme-shop', round: 1, status: 'done' }],
    items: [item('ACME-101', 'acme-shop', 1, { previous: prev, class: 'additive', changes: [{ path: './AGENTS.md', lang: 'markdown', before: '', after: 'A new rule.\n', why: 'Adds the rule.' }] })],
  }).code, 0);
  const built = sb.run(['build'], { STUB_RENDER_DUMP: '1' });
  assert.equal(built.code, 0, built.stdout + built.stderr);
  const state = sb.read('state.json');
  assert.equal(state.harnesses[0].followUp.items[0].title, 'Fixed for al…@example.test, key ghp_…40');
  const note = `ask al…@example.test, token ghp_…40, see ~${path.sep}notes.txt`;
  assert.deepEqual([state.items[0].status, state.items[0].decision, state.items[0].history.lastNote], ['declined', note, note], 'the carried decline brings the note as it was read');
  for (const name of ['state.json', 'board.html']) assert.deepEqual(leaks(sb.text(name)), [], name);
  // And the record this run leaves is made from what was read, not from what is on disk.
  assert.equal(sb.run(['close'], clock('2026-02-10T13:00:00.000Z')).code, 0);
  for (const name of [`${sb.runId}.json`, `${sb.runId}.md`]) assert.deepEqual(leaks(fs.readFileSync(path.join(rec.dir, name), 'utf8')), [], name);
  // The `.md` of the edited record was made again from the record as it is read.
  assert.deepEqual(leaks(rec.history.md(first.key, first.runId)), []);
});

test('files in a harness folder that are not its records are ignored, each with a reason and nothing of its content', (t) => {
  const sb = one(t);
  const first = firstReview(sb);
  const rec = recordOf(sb, first);
  const before = sb.run(['history', '--json']).json;
  const variant = (name, change) => {
    const record = JSON.parse(rec.text);
    const text = change(record);
    fs.writeFileSync(path.join(rec.dir, name), typeof text === 'string' ? text : JSON.stringify(record));
  };
  // A record of another run saved under a name that is not its own.
  variant('20250101-evil.json', () => undefined);
  // Fields that point elsewhere.
  variant('20250102-runid.json', (r) => { r.runId = '../../outside'; });
  variant('20250103-key0.json', (r) => { r.runId = '20250103-key0'; r.harnessKey = '../someone-else-00000000'; });
  variant('20250104-key1.json', (r) => { r.runId = '20250104-key1'; r.harnessKey = 'someone-else-00000000'; });
  variant('20250105-path.json', (r) => { r.runId = '20250105-path'; r.items[0].changes[0].path = { not: 'a text' }; });
  // Keys of the prototype: unknown properties like any other.
  variant('20250106-prot.json', (r) => { r.runId = '20250106-prot'; return JSON.stringify(r).replace(/^\{/, '{"__proto__":{"polluted":true},'); });
  variant('20250107-ctor.json', (r) => { r.runId = '20250107-ctor'; return JSON.stringify(r).replace(/^\{/, '{"constructor":{"prototype":{"polluted":true}},'); });
  // An 8 MB name: over the size a record may have, so it is never parsed.
  variant('20250108-huge.json', (r) => { r.runId = '20250108-huge'; r.name = 'n'.repeat(8 * 1024 * 1024); });
  // A name within the file limit and over the limit of the field.
  variant('20250109-long.json', (r) => { r.runId = '20250109-long'; r.name = 'n'.repeat(301); });
  variant('20250110-list.json', (r) => { r.runId = '20250110-list'; r.items = Array.from({ length: 1001 }, () => r.items[0]); });
  variant('20250111-json.json', () => '{ "schema": 1, ');
  variant('20250112-arr0.json', () => '[]');
  fs.mkdirSync(path.join(rec.dir, '20250113-dir0.json'));
  // Absolute paths where an id belongs.
  variant('20250114-abs0.json', (r) => { r.runId = path.join(sb.home, 'outside'); });
  variant('20250115-abs1.json', (r) => { r.runId = '20250115-abs1'; r.harnessKey = path.join(sb.home, 'dev', 'acme-shop'); });
  // Names that are not record names are counted, never repeated: one of them looks like a token.
  fs.writeFileSync(path.join(rec.dir, `${TOKEN}.json`), '{}');
  fs.writeFileSync(path.join(rec.dir, 'Notes About The Client.json'), '{}');
  // A name that is a record name and looks like a credential is not repeated either.
  const tokenLike = 'sk-' + 'ant-' + 'x'.repeat(40);
  fs.writeFileSync(path.join(rec.dir, `${tokenLike}.json`), '{}');
  fs.writeFileSync(path.join(rec.dir, 'notes.txt'), 'not JSON: not looked at');

  const listed = sb.run(['history', '--json']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.ok(listed.stdout.length < 20000, 'nothing of an 8 MB file is printed');
  for (const secret of [TOKEN, tokenLike, 'polluted', 'Notes About']) assert.ok(!listed.stdout.includes(secret), secret);
  assert.deepEqual(listed.json.harnesses, before.harnesses, 'the one real review is listed as before');
  const reasons = Object.fromEntries(listed.json.ignored.filter((x) => x.file).map((x) => [x.file, x.reason]));
  assert.deepEqual(reasons, {
    '20250101-evil.json': 'misnamed', '20250102-runid.json': 'invalid', '20250103-key0.json': 'other-harness', '20250104-key1.json': 'other-harness',
    '20250105-path.json': 'invalid', '20250106-prot.json': 'invalid', '20250107-ctor.json': 'invalid', '20250108-huge.json': 'too-large',
    '20250109-long.json': 'invalid', '20250110-list.json': 'invalid', '20250111-json.json': 'not-json', '20250112-arr0.json': 'invalid', '20250113-dir0.json': 'not-a-file',
    '20250114-abs0.json': 'invalid', '20250115-abs1.json': 'other-harness',
  });
  assert.deepEqual(spellings(sb.home).filter((s) => listed.stdout.replace(JSON.stringify(listed.json.historyDir).slice(1, -1), '').includes(s)), [], 'no path of this machine but the folder the command names');
  assert.deepEqual(listed.json.ignored.filter((x) => !x.file), [
    { harness: first.key, file: null, count: 2, reason: 'not-a-record-name' },
    { harness: first.key, file: null, reason: 'other-harness' },
  ], 'two names that are not record names, and one record name that is not repeated');
  assert.ok(listed.json.ignored.every((x) => x.harness === first.key));
  assert.match(sb.run(['history']).stdout, /^18 files under history\/ are not review records this version reads and were ignored/m);

  // A run on that harness says the same in its build, and reads the one record.
  followUp(sb);
  const built = sb.run(['build', '--no-render']);
  assert.equal(built.code, 0, built.stdout + built.stderr);
  for (const secret of [TOKEN, tokenLike, 'polluted']) assert.ok(!built.stdout.includes(secret));
  const warned = built.json.mergeWarnings.filter((w) => w.source.startsWith('history/'));
  assert.equal(warned.length, 17);
  assert.ok(warned.some((w) => w.source === `history/${first.key}/20250108-huge.json` && w.problem === 'not a review record this version reads (too-large); ignored'));
  assert.ok(warned.some((w) => w.source === `history/${first.key}` && w.problem === '2 file(s) ignored (not-a-record-name)'));
  assert.deepEqual(sb.read('state.json').harnesses[0].history.map((x) => x.runId), [first.runId]);
});

test('the validator and the copies of the barriers treat prototype keys as plain keys', () => {
  const schema = { type: 'object', additionalProperties: false, properties: { name: { type: 'string', maxLength: 5 }, list: { type: 'array', maxItems: 2, items: { type: 'string' } } } };
  const hostile = JSON.parse('{"name":"ok","__proto__":{"polluted":true},"constructor":1,"toString":2}');
  assert.deepEqual(validate(hostile, schema), ['/: unknown property "__proto__"', '/: unknown property "constructor"', '/: unknown property "toString"']);
  assert.deepEqual(validate({ name: 'too long', list: ['a', 'b', 'c'] }, schema), ['/name: longer than 5 characters', '/list: more than 2 item(s)']);
  assert.deepEqual(validate({ name: 'ok', list: ['a', 'b'] }, schema), []);
  assert.deepEqual(validate({}, { type: 'object', required: ['constructor'] }), ['/: missing required "constructor"'], 'an inherited name is not a property');
  // A key the schema does not know is dropped by `prune`, whatever its name; a schema that allows it keeps it as a key.
  assert.deepEqual(Object.keys(prune(hostile, schema)), ['name']);
  const open = prune(hostile, { type: 'object' });
  assert.ok(Object.hasOwn(open, '__proto__') && Object.getPrototypeOf(open) === Object.prototype);
  // The deep copies keep such a key as a key, and never as a prototype.
  for (const copy of [maskDeep(hostile), scrubDeep(hostile, [])]) {
    assert.ok(Object.hasOwn(copy, '__proto__') && Object.getPrototypeOf(copy) === Object.prototype);
    assert.equal(copy.polluted, undefined);
  }
  assert.equal({}.polluted, undefined);
});

test('limits: the newest records are read, up to a number and a size; the rest is said, not parsed', (t) => {
  const sb = one(t);
  const first = firstReview(sb);
  followUp(sb);
  assert.equal(sb.run(['close'], clock('2026-02-10T13:00:00.000Z')).code, 0);
  const second = sb.runId;
  const rec = recordOf(sb, first);
  const runs = (r) => r.json.harnesses.flatMap((h) => h.reviews.map((x) => x.runId));
  const limited = (limits) => sb.run(['history', '--json'], { NOVARC_HD_TEST_HISTORY_LIMITS: JSON.stringify(limits) });

  assert.deepEqual(runs(sb.run(['history', '--json'])), [first.runId, second]);
  const fewer = limited({ recordsPerHarness: 1 });
  assert.deepEqual([runs(fewer), fewer.json.ignored], [[second], [{ harness: first.key, file: null, count: 1, reason: 'too-many' }]]);
  const size = fs.statSync(path.join(rec.dir, `${second}.json`)).size;
  const small = limited({ harnessBytes: size + 10 });
  assert.deepEqual([runs(small), small.json.ignored], [[second], [{ harness: first.key, file: `${first.runId}.json`, reason: 'over-budget' }]], 'the budget of a harness goes to its newest records');
  const total = limited({ totalBytes: size + 10 });
  assert.deepEqual([runs(total), total.json.ignored.map((x) => x.reason)], [[second], ['over-total-budget']], 'and so does the budget of one command');
  const tiny = limited({ recordBytes: 100 });
  assert.deepEqual([runs(tiny), tiny.json.ignored.map((x) => x.reason)], [[], ['too-large', 'too-large']]);
  // The seam only ever lowers a limit.
  assert.deepEqual(runs(limited({ recordsPerHarness: 100000, recordBytes: 1e12 })), [first.runId, second]);
  // The index is made from what is read: with the limits back, it lists both again.
  assert.deepEqual(rec.history.index().harnesses[first.key].reviews.map((r) => r.runId), [first.runId, second]);

  // In process: the same cap on what one command reads.
  const home = process.env.NOVARC_POWERS_HOME;
  process.env.NOVARC_POWERS_HOME = sb.home;
  t.after(() => { if (home === undefined) delete process.env.NOVARC_POWERS_HOME; else process.env.NOVARC_POWERS_HOME = home; forgetRecords(); });
  forgetRecords();
  assert.deepEqual(listRecords(first.key).map((e) => e.record.runId), [first.runId, second]);
  assert.deepEqual(listRecords('../../etc'), [], 'a key that is not a harness key names no folder');
});

/**
 * Run `history --json` under lowered limits with the read log on. Returns the answer and what
 * was opened of the history folder, in order: `[file, bytes read]`, `file` relative to it.
 */
function watched(sb, limits, args = []) {
  const log = path.join(sb.home, 'history-reads.jsonl');
  fs.rmSync(log, { force: true });
  const r = sb.run(['history', '--json', ...args], { ...clock('2026-03-01T00:00:00.000Z'), NOVARC_HD_TEST_HISTORY_LIMITS: JSON.stringify(limits), NOVARC_HD_TEST_HISTORY_READS: log });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const opened = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((x) => [x.file, x.bytes]) : [];
  return { json: r.json, opened, bytes: opened.reduce((sum, [, n]) => sum + n, 0) };
}

test('the limits are on bytes read, whatever they turn out to be: damaged files spend the budget, and the rest is not opened', (t) => {
  const sb = one(t);
  const history = historyOf(sb);
  // Ten files of 1000 bytes that are not JSON, in the folder of a harness.
  const key = 'sample-12345678';
  const dir = path.join(history.dir, key);
  fs.mkdirSync(dir, { recursive: true });
  const names = Array.from({ length: 10 }, (_, i) => `20260101-a${i}.json`);
  for (const name of names) fs.writeFileSync(path.join(dir, name), '!'.repeat(1000));
  const reasons = (r) => Object.fromEntries(r.json.ignored.map((x) => [x.file, x.reason]));
  const all = (list, reason) => Object.fromEntries(list.map((n) => [n, reason]));

  // A record may have 1500 bytes; a harness and a command may read 2000. Two files are read,
  // newest first, and the budget is spent: the other eight are not opened.
  const two = watched(sb, { recordBytes: 1500, harnessBytes: 2000, totalBytes: 2000 });
  assert.deepEqual(two.opened, [[`${key}/20260101-a9.json`, 1000], [`${key}/20260101-a8.json`, 1000]]);
  assert.equal(two.bytes, 2000, 'what was read is the budget, not the folder');
  assert.deepEqual(reasons(two), { ...all(names.slice(0, 8), 'over-budget'), ...all(names.slice(8), 'not-json') });
  assert.deepEqual(two.json.harnesses, []);
  assert.ok(two.json.ignored.every((x) => x.harness === key));
  assert.ok(!fs.existsSync(path.join(history.dir, 'index.json')), 'and nothing is written from a part of the folder nobody could read');

  // The budget of the command is the smaller one: the third file is measured, found too big for
  // what is left, and not read; from there on nothing is opened.
  const command = watched(sb, { recordBytes: 1500, harnessBytes: 5000, totalBytes: 2500 });
  assert.deepEqual(command.opened, [[`${key}/20260101-a9.json`, 1000], [`${key}/20260101-a8.json`, 1000], [`${key}/20260101-a7.json`, 0]]);
  assert.deepEqual(reasons(command), { ...all(names.slice(0, 8), 'over-total-budget'), ...all(names.slice(8), 'not-json') });
  // A budget that ends exactly at the end of a file: the next one is not opened to find out.
  const exact = watched(sb, { recordBytes: 1500, harnessBytes: 3000, totalBytes: 1000000 });
  assert.deepEqual([exact.opened, Object.values(reasons(exact)).filter((x) => x === 'over-budget').length], [[[`${key}/20260101-a9.json`, 1000], [`${key}/20260101-a8.json`, 1000], [`${key}/20260101-a7.json`, 1000]], 7]);
  // (This command could read the whole folder as far as its limits go, found no record in it,
  // and left the index that says so.)
  assert.deepEqual(history.index(), { schema: 1, harnesses: {} });
  const ofHarness = (r) => r.opened.filter(([file]) => file.startsWith(`${key}/`));

  // Where the limit is a number of files, it counts files, good or bad: the newest two by name.
  const counted = watched(sb, { recordsPerHarness: 2 });
  assert.deepEqual(ofHarness(counted).map(([file]) => file), [`${key}/20260101-a9.json`, `${key}/20260101-a8.json`]);
  assert.deepEqual(counted.json.ignored, [
    { harness: key, file: null, count: 8, reason: 'too-many' },
    { harness: key, file: '20260101-a8.json', reason: 'not-json' }, { harness: key, file: '20260101-a9.json', reason: 'not-json' },
  ]);
  // A file over the size a record may have is measured, never read, and does not end the reading.
  fs.writeFileSync(path.join(dir, '20260102-big0.json'), '!'.repeat(5000));
  const big = watched(sb, { recordBytes: 1500, harnessBytes: 2000, totalBytes: 2000 });
  assert.deepEqual(big.opened, [[`${key}/20260102-big0.json`, 0], [`${key}/20260101-a9.json`, 1000], [`${key}/20260101-a8.json`, 1000]]);
  assert.equal(reasons(big)['20260102-big0.json'], 'too-large');
  // Without lowered limits every file is read, once.
  fs.rmSync(path.join(dir, '20260102-big0.json'));
  const free = watched(sb, {});
  assert.deepEqual([ofHarness(free).length, ofHarness(free).reduce((sum, [, n]) => sum + n, 0), reasons(free)], [10, 10000, all(names, 'not-json')]);
});

test('every way a file fails to be a record costs its bytes: the good record behind four bad ones is left unread when they spend the budget', (t) => {
  const sb = one(t);
  const first = firstReview(sb);
  const rec = recordOf(sb, first);
  const good = `${first.runId}.json`;
  // Four files with newer names: not JSON, JSON that is no record, the record of another harness, a record under a name that is not its own.
  const other = JSON.parse(rec.text);
  other.runId = '20270103-bad3';
  other.harnessKey = 'someone-else-00000000';
  const bad = {
    '20270101-bad1.json': '!'.repeat(3000),
    '20270102-bad2.json': JSON.stringify({ harnessKey: first.key, pad: 'x'.repeat(3000) }),
    '20270103-bad3.json': JSON.stringify(other),
    '20270104-bad4.json': rec.text,
  };
  for (const [name, text] of Object.entries(bad)) fs.writeFileSync(path.join(rec.dir, name), text);
  const sizeOf = (name) => fs.statSync(path.join(rec.dir, name)).size;
  const badBytes = Object.keys(bad).reduce((sum, name) => sum + sizeOf(name), 0);
  const rel = (name) => `${first.key}/${name}`;
  const records = (r) => r.opened.filter(([file]) => file.endsWith('.json') && file !== 'index.json');
  const why = { '20270101-bad1.json': 'not-json', '20270102-bad2.json': 'invalid', '20270103-bad3.json': 'other-harness', '20270104-bad4.json': 'misnamed' };
  const reasons = (r) => Object.fromEntries(r.json.ignored.map((x) => [x.file, x.reason]));

  // A harness budget of exactly the four bad files: each is read whole and answered for what it
  // is, and the real record, older than all of them, is not opened.
  const spent = watched(sb, { harnessBytes: badBytes });
  assert.deepEqual(records(spent), Object.keys(bad).reverse().map((name) => [rel(name), sizeOf(name)]), 'newest first, each one read whole');
  assert.deepEqual(reasons(spent), { ...why, [good]: 'over-budget' });
  assert.deepEqual(spent.json.harnesses, [], 'so the review is not listed: the limit is on what is read, not on what is good');
  // One byte less: the oldest bad file no longer fits. It is measured, not read, and ends the reading.
  const short = watched(sb, { harnessBytes: badBytes - 1 });
  assert.deepEqual(records(short), [...Object.keys(bad).reverse().slice(0, 3).map((name) => [rel(name), sizeOf(name)]), [rel('20270101-bad1.json'), 0]]);
  assert.deepEqual(reasons(short), { ...why, '20270101-bad1.json': 'over-budget', [good]: 'over-budget' });
  // The same through the budget of the command.
  const command = watched(sb, { totalBytes: badBytes });
  assert.deepEqual(reasons(command), { ...why, [good]: 'over-total-budget' });
  assert.ok(command.bytes <= badBytes, `read ${command.bytes} of ${badBytes}`);
  // With room for all five, the record is read and the review is there.
  const room = watched(sb, { harnessBytes: badBytes + sizeOf(good) });
  assert.deepEqual([reasons(room), room.json.harnesses.map((h) => h.reviews.map((x) => x.runId))], [why, [[first.runId]]]);
});

test('the .md beside a record and index.json are compared without being read whole, and what is read of them counts', (t) => {
  const sb = one(t);
  const first = firstReview(sb);
  const rec = recordOf(sb, first);
  const mdName = `${first.key}/${first.runId}.md`;
  const mdFile = path.join(rec.dir, `${first.runId}.md`);
  const indexFile = path.join(rec.history.dir, 'index.json');
  const good = { md: fs.readFileSync(mdFile, 'utf8'), index: fs.readFileSync(indexFile, 'utf8') };
  const recordBytes = fs.statSync(rec.file).size;
  const of = (r, file) => r.opened.filter(([name]) => name === file).map(([, bytes]) => bytes);

  // Nothing to put right: the record, its .md and the index are each read once, and no more than they hold.
  const calm = watched(sb, {});
  assert.deepEqual(calm.opened, [[`${first.key}/${first.runId}.json`, recordBytes], [mdName, Buffer.byteLength(good.md)], ['index.json', Buffer.byteLength(good.index)]]);
  assert.ok(!('healed' in calm.json));

  // A .md of another size is not the .md of this record: it is replaced without one byte of it being read.
  fs.writeFileSync(mdFile, 'x'.repeat(3 * 1024 * 1024));
  const huge = watched(sb, {});
  assert.deepEqual([huge.json.healed, of(huge, mdName)], [{ index: false, md: 1 }, []], 'never opened');
  assert.equal(fs.readFileSync(mdFile, 'utf8'), good.md);
  // One of the same size is read, up to that size and no further.
  fs.writeFileSync(mdFile, good.md.replace(/[a-z]/g, 'x'));
  const same = watched(sb, {});
  assert.deepEqual(same.json.healed, { index: false, md: 1 });
  assert.ok(of(same, mdName).length > 0 && of(same, mdName).every((n) => n === Buffer.byteLength(good.md)), JSON.stringify(same.opened));
  assert.equal(fs.readFileSync(mdFile, 'utf8'), good.md);

  // An index over the size an index may have is measured and replaced, not read.
  fs.writeFileSync(indexFile, 'x'.repeat(5 * 1024 * 1024));
  const bigIndex = watched(sb, {});
  assert.deepEqual([bigIndex.json.healed, new Set(of(bigIndex, 'index.json'))], [{ index: true, md: 0 }, new Set([0])]);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), good.index);

  // What a command may read covers these too: with the budget spent on the record, a .md and an
  // index that cannot be compared are left as they are, for the next command.
  fs.writeFileSync(mdFile, good.md.replace(/[a-z]/g, 'x'));
  fs.writeFileSync(indexFile, good.index.replace(/[a-z]/g, 'x'));
  const broke = watched(sb, { totalBytes: recordBytes + 10 });
  assert.deepEqual(broke.opened, [[`${first.key}/${first.runId}.json`, recordBytes], ['index.json', 0]], 'the .md is not opened; the index is measured and does not fit');
  assert.ok(!('healed' in broke.json) && broke.bytes <= recordBytes + 10);
  assert.deepEqual(broke.json.harnesses.map((h) => h.key), [first.key], 'the answer does not depend on them');
  const next = watched(sb, {});
  assert.deepEqual(next.json.healed, { index: true, md: 1 });
  assert.deepEqual([fs.readFileSync(mdFile, 'utf8'), fs.readFileSync(indexFile, 'utf8')], [good.md, good.index]);
});

test('a record over the size that is read back loses the text of its changes, the unapplied ones first; one that still does not fit is not written', (t) => {
  const sb = one(t);
  const first = firstReview(sb, { close: false });
  // One more finding, with a change of 60 KB.
  const long = item('ACME-105', 'acme-shop', 1, { changes: [{ path: './docs/long.md', lang: 'markdown', before: '', after: 'word '.repeat(12000), why: 'A long text.' }] });
  assert.equal(sb.complete('review:security', { ...first.findings, items: [...first.findings.items, long] }).code, 0);
  const history = historyOf(sb);
  const limit = (bytes) => ({ ...clock(FIRST.closed), NOVARC_HD_TEST_HISTORY_LIMITS: JSON.stringify({ recordBytes: bytes }) });

  const refused = sb.run(['close'], limit(500));
  assert.equal(refused.code, 1);
  assert.deepEqual([refused.json.error, refused.json.errors], ['a review record does not fit templates/record.schema.json; nothing was written', ['acme-shop: the record is larger than 500 bytes even without the text of its changes']]);
  assert.deepEqual(history.keys(), [], 'nothing was written');
  assert.equal(sb.read('run.json').closed, false, 'and the run is not closed');

  const closed = sb.run(['close'], limit(30000));
  assert.equal(closed.code, 0, closed.stdout + closed.stderr);
  const record = history.record(first.key, first.runId);
  assert.deepEqual(validateRecord(record), []);
  assert.deepEqual(record.items.map((i) => [i.id, i.status, 'changes' in i, i.changesOmitted]), [
    ['ACME-101', 'fixed', true, undefined], ['ACME-102', 'declined', false, true], ['ACME-103', 'deferred', false, undefined], ['ACME-104', 'open', false, undefined], ['ACME-105', 'open', false, true],
  ], 'the fixed item keeps what the on-disk check needs');
  assert.equal(record.items[0].changes[0].hashAfter.length, 64);
  assert.ok(fs.statSync(path.join(history.dir, first.key, `${first.runId}.json`)).size < 30000);

  // The next review still checks the fix on disk, and still knows the declined proposal by its revision.
  followUp(sb);
  const same = item('ACME-101', 'acme-shop', 1, { previous: { run: first.runId, item: 'ACME-102' }, class: 'additive', changes: [{ path: './AGENTS.md', lang: 'markdown', before: '', after: 'A new rule.\n', why: 'Adds the rule.' }] });
  const done = sb.complete('review:security', { rounds: [{ harness: 'acme-shop', round: 1, status: 'done' }], items: [same] });
  assert.deepEqual(done.json.declinedBefore, { same: ['ACME-101'], changed: [] });
  assert.equal(sb.run(['build', '--no-render']).code, 0);
  const state = sb.read('state.json');
  assert.deepEqual([state.items[0].status, state.harnesses[0].followUp.items[0].check], ['declined', 'in-place']);
});

test('the index is a cache: deleted, stale or hostile, it is made again from the records, and so is a missing .md', (t) => {
  const sb = one(t);
  const first = firstReview(sb);
  const rec = recordOf(sb, first);
  const indexFile = path.join(rec.history.dir, 'index.json');
  const mdFile = path.join(rec.dir, `${first.runId}.md`);
  const good = { index: fs.readFileSync(indexFile, 'utf8'), md: fs.readFileSync(mdFile, 'utf8') };
  // One clock for every listing: the answer carries the moment it was given.
  const list = (args = []) => sb.run(['history', '--json', ...args], clock('2026-03-01T00:00:00.000Z'));
  const before = list().json;
  assert.ok(!('healed' in before), 'nothing to put right');
  const again = (healed, what) => {
    const r = list();
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.healed, healed, what);
    assert.deepEqual({ ...r.json, healed: undefined }, { ...before, healed: undefined }, `${what}: the answer comes from the records`);
    assert.equal(fs.readFileSync(indexFile, 'utf8'), good.index, `${what}: the index is back`);
    assert.equal(fs.readFileSync(mdFile, 'utf8'), good.md, `${what}: the .md is back`);
    assert.ok(!('healed' in list().json), 'and stays');
  };

  fs.rmSync(indexFile);
  again({ index: true, md: 0 }, 'index deleted');
  fs.writeFileSync(indexFile, '{ "schema": 1, "harnesses": ');
  again({ index: true, md: 0 }, 'index cut short');
  // Stale: it does not know the review, and it names things that are not there.
  const stale = JSON.parse(good.index);
  stale.harnesses[first.key].reviews = [];
  stale.harnesses[first.key].name = `${TOKEN} ${MAIL}`;
  stale.harnesses[first.key].pathAbs = path.join(sb.home, 'somewhere', 'else');
  stale.harnesses['../../outside-00000000'] = { kind: 'project', provider: null, name: 'x', path: '~/x', pathAbs: sb.home, reviews: [{ runId: 'x', file: '../../../x.json' }, { runId: 'y', file: path.join(sb.home, 'y.json') }] };
  stale.harnesses['ghost-00000000'] = { kind: 'project', provider: null, name: 'ghost', path: '~/ghost', pathAbs: path.join(sb.home, 'ghost'), reviews: [] };
  fs.writeFileSync(indexFile, JSON.stringify(stale));
  const hostile = list();
  assert.ok(!hostile.stdout.includes(TOKEN) && !hostile.stdout.includes(MAIL) && !hostile.stdout.includes('ghost'), 'nothing of the index is printed');
  fs.writeFileSync(indexFile, JSON.stringify(stale));
  again({ index: true, md: 0 }, 'index stale and hostile');
  assert.equal(JSON.parse(good.index).harnesses[first.key].pathAbs, path.join(sb.home, 'dev', 'acme-shop'), 'a path that is not that harness\'s own is not kept');

  fs.rmSync(mdFile);
  again({ index: false, md: 1 }, '.md deleted');
  fs.writeFileSync(mdFile, '# something else\n');
  again({ index: false, md: 1 }, '.md edited');
  // `--harness <path>` needs no index: a path names a harness when it gives the hash its key ends in.
  fs.rmSync(indexFile);
  const byPath = list(['--harness', path.join(sb.home, 'dev', 'acme-shop')]);
  assert.deepEqual(byPath.json.harnesses.map((h) => h.key), [first.key]);
  assert.deepEqual(list(['--harness', path.join(sb.home, 'dev')]).json.harnesses, []);

  // `init` and `close` put it right too.
  fs.rmSync(indexFile);
  fs.rmSync(mdFile);
  followUp(sb);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), good.index, 'init');
  assert.equal(fs.readFileSync(mdFile, 'utf8'), good.md, 'init');
  fs.rmSync(mdFile);
  const closed = sb.run(['close'], clock('2026-02-10T13:00:00.000Z'));
  assert.equal(closed.code, 0, closed.stdout + closed.stderr);
  assert.deepEqual(closed.json.healed, { index: false, md: 1 }, 'close');
  assert.equal(fs.readFileSync(mdFile, 'utf8'), good.md);
  assert.deepEqual(rec.history.index().harnesses[first.key].reviews.map((r) => r.runId), [first.runId, sb.runId]);
});

test('a command killed between the record, its .md, the index and the closing of the run: the next one heals', (t) => {
  for (const [point, left] of [
    ['record-json', { json: true, md: false, index: false }],
    ['record-md', { json: true, md: true, index: false }],
    ['index', { json: true, md: true, index: true }],
  ]) {
    const sb = one(t);
    const first = firstReview(sb, { close: false });
    const history = historyOf(sb);
    const files = { json: path.join(history.dir, first.key, `${first.runId}.json`), md: path.join(history.dir, first.key, `${first.runId}.md`), index: path.join(history.dir, 'index.json') };
    const killed = sb.run(['close'], { ...clock(FIRST.closed), NOVARC_HD_TEST_CRASH_AT: point });
    assert.notEqual(killed.code, 0, `${point}: the command died`);
    assert.equal(killed.stdout, '', `${point}: it answered nothing`);
    assert.deepEqual(Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.existsSync(f)])), left, `${point}: what the kill left`);
    assert.equal(sb.read('run.json').closed, false, `${point}: the run is not closed`);
    assert.ok(fs.existsSync(path.join(history.dir, '.mutex')) && sb.exists('.mutex'), `${point}: its locks are still there`);

    // The record is the truth: the review is listed, and what was missing is made.
    const listed = sb.run(['history', '--json'], { ...clock(FIRST.closed), ...IMPATIENT });
    assert.equal(listed.code, 0, `${point}: ${listed.stdout}${listed.stderr}`);
    assert.deepEqual(listed.json.harnesses.map((h) => [h.key, h.reviews.map((r) => r.runId)]), [[first.key, [first.runId]]], point);
    assert.deepEqual(listed.json.healed, point === 'index' ? undefined : { index: true, md: point === 'record-json' ? 1 : 0 }, point);
    assert.ok(Object.values(files).every((f) => fs.existsSync(f)), `${point}: record, .md and index are all there`);
    assert.deepEqual(JSON.parse(fs.readFileSync(files.index, 'utf8')).harnesses[first.key].reviews.map((r) => r.runId), [first.runId]);
    const md = fs.readFileSync(files.md, 'utf8');

    // Closing again finishes the job: the same record, and the run closed.
    const closed = sb.run(['close'], { ...clock(FIRST.closed), ...IMPATIENT });
    assert.equal(closed.code, 0, `${point}: ${closed.stdout}${closed.stderr}`);
    assert.deepEqual({ closed: closed.json.closed, closedAt: closed.json.closedAt, already: closed.json.already, written: closed.json.records.map((r) => r.written) }, { closed: true, closedAt: FIRST.closed, already: undefined, written: [false] }, point);
    assert.equal(sb.read('run.json').closed, true);
    assert.equal(fs.readFileSync(files.md, 'utf8'), md);
    assert.deepEqual(fs.readdirSync(history.dir).filter((n) => n.startsWith('.')), [], `${point}: no lock is left`);
    assert.deepEqual(validateRecord(JSON.parse(fs.readFileSync(files.json, 'utf8'))), []);
  }
});

test('a lock that outlived its time and was taken over: its first holder can tell, leaves the other one alone, and it is counted', (t) => {
  const dir = tmpDir('hd-lock-');
  t.after(() => rmrf(dir));
  const lockPath = path.join(dir, '.mutex');
  const lostBefore = lostLocks();
  // A section that ends in time holds its lock throughout and leaves nothing behind.
  assert.equal(withLock(lockPath, (lock) => lock.held()), true);
  assert.ok(!fs.existsSync(lockPath));
  assert.equal(lostLocks(), lostBefore);

  // A section that outlives the stale time: another process removes the lock and takes it.
  const result = withLock(lockPath, (lock) => {
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, 'another-process.0123456789ab');
    lock.touch(); // not its lock any more: touching it must not keep the other one's alive as its own
    return { held: lock.held(), owner: fs.readFileSync(lockPath, 'utf8') };
  });
  assert.deepEqual(result, { held: false, owner: 'another-process.0123456789ab' });
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'another-process.0123456789ab', 'the lock of the one that took over is not released by the first holder');
  assert.equal(lostLocks(), lostBefore + 1, 'and the loss is counted: run.mjs adds lockLost to its answer and warns');
  fs.unlinkSync(lockPath);
  // Taken over and already released again counts too.
  withLock(lockPath, () => fs.unlinkSync(lockPath));
  assert.equal(lostLocks(), lostBefore + 2);
});

test('the name of an export file is data: one that looks like a token is not repeated', (t) => {
  const sb = one(t);
  assert.equal(sb.init().code, 0);
  const dir = path.join(sb.home, 'export');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${TOKEN}.json`), 'invalid');
  fs.writeFileSync(path.join(dir, `${MAIL}.json`), 'invalid');
  fs.writeFileSync(path.join(dir, `${'n'.repeat(120)}.json`), 'invalid');
  fs.writeFileSync(path.join(dir, 'ACME-101.json'), 'invalid');
  const r = sb.run(['decisions', '--ingest', dir]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes(TOKEN) && !r.stdout.includes(TOKEN.slice(0, 12)) && !r.stdout.includes(MAIL));
  assert.deepEqual(r.json.rejected.map((x) => [x.source, x.reason]).sort(), [
    ['file ACME-101.json', 'not valid JSON'],
    ['file al…@example.test.json', 'not valid JSON'],
    [`file ${'n'.repeat(79)}…`, 'not valid JSON'],
    // Its place among the JSON files of the directory, in name order, is how it is found.
    [`file #${fs.readdirSync(dir).sort().indexOf(`${TOKEN}.json`) + 1} (its name is withheld: it looks like a credential)`, 'not valid JSON'],
  ].sort());
});

test('the last barrier: whatever a command answers leaves without a credential', (t) => {
  const sb = one(t);
  assert.equal(sb.init().code, 0);
  // A value typed on the command line comes back in the refusal.
  const refused = sb.run(['status', TOKEN]);
  assert.equal(refused.code, 2);
  assert.ok(!refused.stdout.includes(TOKEN) && !refused.stderr.includes(TOKEN), refused.stdout + refused.stderr);
  assert.match(refused.json.error, /^unexpected argument "ghp_…40": every option is a --flag$/);
  // A findings file edited after it was handed in: what a command reads back from it is masked.
  assert.equal(sb.complete('review:security', { rounds: [{ harness: 'acme-shop', round: 1, status: 'done' }], items: [item('ACME-101', 'acme-shop', 1)] }).code, 0);
  const stored = sb.read('findings', 'review.security.json');
  stored.items[0].title = `key ${TOKEN}`;
  fs.writeFileSync(sb.file('findings', 'review.security.json'), JSON.stringify(stored));
  for (const command of [['status'], ['next'], ['decide', '--target', 'ACME-101', '--action', 'approve'], ['claim', '--unit', 'apply:acme-shop', '--session', 's'], ['build', '--no-render'], ['close']]) {
    const r = sb.run(command);
    assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN), `${command[0]}: ${r.stdout.slice(0, 300)}`);
  }
  assert.ok(!sb.text('state.json').includes(TOKEN));
});
