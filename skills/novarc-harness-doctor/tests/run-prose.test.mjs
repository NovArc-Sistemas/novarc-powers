// The prose policy (scripts/lib/run/prose.mjs): what the words of a review may carry of a person
// or of a machine. An e-mail address keeps two characters and its domain, the root of a harness
// becomes its display path, any other absolute path keeps its last two segments (a POSIX one only
// from a well-known root of a file system; the proposal of an item keeps its paths as written).
// It is applied to prose only, in the state and in the review records, and it rewrites: nothing is
// refused.
//
// No address is written in this file: each one is put together from its parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, item, historyOf } from './run-helpers.mjs';
import { SKILL_DIR, tmpDir, rmrf } from './helpers.mjs';
import { maskEmails, shortenPaths, proseText, proseContext, applyProse, STATE_PROSE, RECORD_PROSE, EXACT_PATHS, POSIX_ROOTS } from '../scripts/lib/run/prose.mjs';
import { loadStateSchema } from '../scripts/lib/run/schema.mjs';

const mail = (local, domain = 'example.test') => [local, domain].join('@');
/** A folder of some other machine: `C:/Clients/Acme/notes/plan.md`. */
const FOREIGN = ['C:', 'Clients', 'Acme', 'notes', 'plan.md'].join('/');
const BS = '\\';

test('an e-mail address in prose keeps two characters of its local part and its domain', () => {
  assert.equal(maskEmails(`Ask ${mail('alice')} or ${mail('bo')}, then ${mail('x', 'mail.example.org')}.`), 'Ask al…@example.test or b…@example.test, then x…@mail.example.org.');
  assert.equal(maskEmails(`<${mail('first.last+tag')}>`), '<fi…@example.test>');
  // Already masked: nothing more to take away.
  assert.equal(maskEmails('written by al…@example.test'), 'written by al…@example.test');
  // Not addresses: a package version, a scoped package, a file name, the address of a repository, a host without a domain.
  for (const kept of ['react@18.3.1', '@scope/pkg@2.0.0', 'logo@2x.png', ['git', 'github.com:owner/repo.git'].join('@'), 'user@host', 'a @ b', '@mention']) {
    assert.equal(maskEmails(kept), kept);
  }
  assert.equal(maskEmails(42), 42, 'anything that is not a text passes through');
});

test('an absolute path in prose keeps its last two segments', () => {
  const win = ['C:', 'Clients', 'Acme', 'notes', 'plan.md'].join(BS);
  const cases = [
    [`see ${win}.`, 'see …/notes/plan.md.'],
    [`see ${FOREIGN}:12, then go on`, 'see …/notes/plan.md:12, then go on'],
    [`(${FOREIGN}), [${FOREIGN}]; done`, '(…/notes/plan.md), […/notes/plan.md]; done'],
    [`"C:${BS}Program Files${BS}App Name${BS}bin${BS}tool.exe" --flag`, '"…/bin/tool.exe" --flag'],
    [`'/srv/acme corp/data/x.json' is quoted`, "'…/data/x.json' is quoted"],
    [`${BS}${BS}fileserver${BS}share${BS}clients${BS}acme${BS}notes.md`, '…/acme/notes.md'],
    ['/srv/clients/acme/CLAUDE.md', '…/acme/CLAUDE.md'],
    ['file:///srv/clients/acme/x.txt and file:///C:/Clients/Acme/y.txt', '…/acme/x.txt and …/Acme/y.txt'],
    [`C:${BS}Clients${BS}Acme Corp${BS}plan.docx next`, '…/Acme Corp/plan.docx next'],
    [`C:${BS}plan.txt`, '…/plan.txt'],
  ];
  for (const [input, output] of cases) {
    assert.equal(shortenPaths(input), output, input);
    assert.equal(shortenPaths(output), output, `${input}: applied to its own output it changes nothing`);
  }
  // What is not an absolute path of some machine stays as written.
  for (const kept of [
    '/dev/null', '/clear and /compact', '/api/users', '~/dev/acme/a.md', './a/b/c.md', '../x/y/z', 'src/lib/run/x.mjs',
    'https://example.com/a/b/c', 'http://localhost:3000/x/y/z', 'either/or/and', '12/05/2026', 'TCP/IP/UDP', '</div>', 'a windows flag /S', `C:${BS}`, 'ratio 1:2',
  ]) assert.equal(shortenPaths(kept), kept);
});

test('a POSIX path is shortened only from a well-known root of a file system; a route or a path inside a repository is left alone', () => {
  assert.deepEqual([...POSIX_ROOTS], [
    'home', 'Users', 'root', 'var', 'etc', 'opt', 'usr', 'tmp', 'mnt', 'media', 'srv', 'private',
    'Volumes', 'Library', 'Applications', 'System', 'bin', 'sbin', 'lib', 'proc', 'dev', 'run',
  ]);
  // Shortened: the path of some machine.
  const shortened = [
    ['/home/someone/projects/acme/CLAUDE.md', '…/acme/CLAUDE.md'],
    ['/Users/someone/dev/acme/notes.md:7', '…/acme/notes.md:7'],
    ['/root/work/acme/plan.md', '…/acme/plan.md'],
    ['/var/www/client-site/index.php', '…/client-site/index.php'],
    ['/etc/acme/conf.d/rules.conf', '…/conf.d/rules.conf'],
    ['/opt/acme/bin/tool', '…/bin/tool'],
    ['/usr/local/bin/acme', '…/bin/acme'],
    ['/tmp/build-1234/out/report.txt', '…/out/report.txt'],
    ['/mnt/c/Clients/Acme/plan.md', '…/Acme/plan.md'],
    ['/media/disk/clients/acme.txt', '…/clients/acme.txt'],
    ['/srv/clients/acme/CLAUDE.md', '…/acme/CLAUDE.md'],
    ['/private/var/folders/ab/T/x.txt', '…/T/x.txt'],
    ['/Volumes/Backup/Clients/Acme', '…/Clients/Acme'],
    ['"/Library/Application Support/Acme/config.json"', '"…/Acme/config.json"'],
    ['/Library/Preferences/Acme/config.plist', '…/Acme/config.plist'],
    ['/Applications/Acme.app/Contents/Info.plist', '…/Contents/Info.plist'],
    ['/System/Library/Frameworks/X.framework', '…/Frameworks/X.framework'],
    ['/bin/acme/x/y', '…/x/y'], ['/sbin/acme/x/y', '…/x/y'], ['/lib/acme/x/y.so', '…/x/y.so'],
    ['/proc/1234/cwd/secret', '…/cwd/secret'], ['/dev/disk/by-id/acme', '…/by-id/acme'], ['/run/user/1000/acme.sock', '…/1000/acme.sock'],
    ['see (/home/someone/a/b.md), then /var/log/acme/x.log.', 'see (…/a/b.md), then …/acme/x.log.'],
  ];
  for (const [input, output] of shortened) {
    assert.equal(shortenPaths(input), output, input);
    assert.equal(shortenPaths(output), output, `${input}: applied to its own output it changes nothing`);
  }
  // Left alone: the same shape, and not a path of a machine.
  for (const kept of [
    '/api/v1/users', '/api/v1/users/{id}/orders', '/src/app/page.tsx', '/docs/guides/setup.md', '/packages/api/src/index.ts',
    'GET /users/42/orders and POST /orders/42/items', '(/app/routes/home.tsx)', '/c/Clients/Acme/plan.md',
    // The names of the roots are exact: a route that looks like one is a route.
    '/users/list/all', '/Home/someone/x', '/library/books/42', '/homepage/sections/hero', '/variables/env/list',
    // Two segments have nothing to shorten.
    '/etc/hosts', '/dev/null', '/tmp/x', '/usr/bin',
  ]) assert.equal(shortenPaths(kept), kept, kept);
  // The Windows forms and `file:` do not depend on a root.
  assert.equal(shortenPaths(`E:${BS}api${BS}v1${BS}users and file:///api/v1/users`), '…/v1/users and …/v1/users');
});

test('the root of a harness becomes its display path; one text takes the whole policy', () => {
  const ctx = proseContext([
    { abs: 'D:/work/acme', display: 'D:/work/acme', literal: true },
    { abs: 'D:/work/acme/packages/api', display: 'D:/work/acme/packages/api', literal: true },
    { abs: '/srv/repos/shop', display: '/srv/repos/shop', literal: true },
  ]);
  const cases = [
    [`D:${BS}work${BS}acme${BS}docs${BS}guide.md`, 'D:/work/acme/docs/guide.md'],
    ['in D:/work/acme and D:/work/acme-other/x/y.md', 'in D:/work/acme and …/x/y.md'],
    // The longest root is the one that is named.
    [`D:${BS}work${BS}acme${BS}packages${BS}api${BS}src${BS}a.ts`, 'D:/work/acme/packages/api/src/a.ts'],
    // Git Bash and WSL spell the same folder another way.
    ['/d/work/acme/CLAUDE.md and /mnt/d/work/acme/CLAUDE.md', 'D:/work/acme/CLAUDE.md and D:/work/acme/CLAUDE.md'],
    ['/srv/repos/shop/CLAUDE.md, not /srv/repos/other/CLAUDE.md', '/srv/repos/shop/CLAUDE.md, not …/other/CLAUDE.md'],
    [`${mail('alice')} keeps ${FOREIGN} beside D:/work/acme/a.md`, 'al…@example.test keeps …/notes/plan.md beside D:/work/acme/a.md'],
  ];
  for (const [input, output] of cases) {
    assert.equal(proseText(input, ctx), output, input);
    assert.equal(proseText(output, ctx), output, `${input}: idempotent`);
  }
  assert.equal(proseText('nothing to do here'), 'nothing to do here');
  assert.equal(proseText(''), '');

  // A folder of this machine is known by its real path too.
  const dir = tmpDir('hd-prose-');
  try {
    const real = fs.realpathSync.native(dir);
    const here = proseContext([{ abs: dir, display: '~/dev/shop' }]);
    assert.equal(proseText(`edit ${path.join(real, 'docs', 'a.md')} now`, here), 'edit ~/dev/shop/docs/a.md now');
  } finally { rmrf(dir); }
});

test('only prose is touched: the lists name text fields of the schemas, never file content or a path', () => {
  const state = loadStateSchema().schema;
  const record = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'templates', 'record.schema.json'), 'utf8'));
  const deref = (node, root) => (node && typeof node.$ref === 'string' ? root.$defs[node.$ref.split('/').pop()] : node);
  /** The schema nodes a pattern names. */
  const resolve = (pattern, root, from = root) => {
    let nodes = [from];
    for (const step of pattern.split('/').slice(1)) {
      const next = [];
      for (const raw of nodes) {
        const node = deref(raw, root);
        if (!node) continue;
        if (step === '*') {
          if (node.items) next.push(node.items);
          else for (const v of Object.values(node.properties || {})) next.push(v);
        } else if (node.properties && Object.hasOwn(node.properties, step)) next.push(node.properties[step]);
      }
      nodes = next;
    }
    return nodes.map((n) => deref(n, root)).filter(Boolean);
  };
  const isText = (n) => n.type === 'string' && !n.enum && !n.pattern && !n.format;
  for (const pattern of STATE_PROSE) {
    assert.ok(resolve(pattern, state).some(isText), `${pattern} names a free-text field of state.schema.json`);
  }
  for (const pattern of RECORD_PROSE) {
    // `outcome` is the followUp object of the state schema.
    const nodes = pattern.startsWith('/outcome/') ? resolve(pattern.slice('/outcome'.length), state, state.$defs.followUp) : resolve(pattern, record);
    assert.ok(nodes.some(isText), `${pattern} names a free-text field of record.schema.json`);
  }
  for (const pattern of [...STATE_PROSE, ...RECORD_PROSE]) {
    assert.ok(!/\/(path|paths|content|before|after|insertAfter|file|linkTo|id|rev)(\/\*)?$/.test(pattern), `${pattern} is not prose`);
  }

  // What the lists leave out stays byte for byte, in the same object.
  const doc = {
    items: [{
      title: `Ask ${mail('alice')}`, file: FOREIGN, evidence: `${FOREIGN}:3`, lesson: { why: mail('bob'), learnMore: 'https://example.com/a/b/c' },
      changes: [{ path: FOREIGN, before: `owner: ${mail('carol')}`, after: `see ${FOREIGN}`, insertAfter: mail('dave'), why: `asked by ${mail('erin')}` }],
    }],
    files: [{ path: FOREIGN, content: `${mail('frank')} ${FOREIGN}`, role: `kept by ${mail('grace')}` }],
    log: [{ text: `note from ${mail('heidi')}` }],
  };
  const hits = [];
  const out = applyProse(doc, STATE_PROSE, proseContext(), hits);
  assert.deepEqual(out, {
    items: [{
      title: 'Ask al…@example.test', file: FOREIGN, evidence: '…/notes/plan.md:3', lesson: { why: 'bo…@example.test', learnMore: 'https://example.com/a/b/c' },
      changes: [{ path: FOREIGN, before: `owner: ${mail('carol')}`, after: `see ${FOREIGN}`, insertAfter: mail('dave'), why: 'asked by er…@example.test' }],
    }],
    files: [{ path: FOREIGN, content: `${mail('frank')} ${FOREIGN}`, role: 'kept by gr…@example.test' }],
    log: [{ text: 'note from he…@example.test' }],
  });
  assert.deepEqual(hits, ['/items/0/title', '/items/0/evidence', '/items/0/lesson/why', '/items/0/changes/0/why', '/files/0/role', '/log/0/text'], 'where it acted, as pointers: never a value');
  assert.equal(doc.items[0].title, `Ask ${mail('alice')}`, 'the input is not changed');
});

test('a proposal keeps its paths as written: it is what gets applied, and what the user approves', () => {
  assert.deepEqual(EXACT_PATHS, ['/items/*/proposal'], 'the one prose field that keeps its paths');
  assert.ok(STATE_PROSE.includes('/items/*/proposal') && RECORD_PROSE.includes('/items/*/proposal'), 'it is prose all the same');
  const ctx = proseContext([{ abs: 'D:/work/acme', display: 'D:/work/acme', literal: true }]);
  const win = ['E:', 'Tools', 'setup', 'install.cmd'].join(BS);
  const proposal = `Run "${win}" /quiet, then copy /home/someone/out/acme.bin to ${BS}${BS}fileserver${BS}share${BS}bin, as ${mail('alice')} asked. Edit D:${BS}work${BS}acme${BS}docs${BS}guide.md.`;
  // Paths as written; the address masked; the root of a harness as its display path.
  const kept = `Run "${win}" /quiet, then copy /home/someone/out/acme.bin to ${BS}${BS}fileserver${BS}share${BS}bin, as al…@example.test asked. Edit D:/work/acme/docs/guide.md.`;
  assert.equal(proseText(proposal, ctx, { paths: false }), kept);
  assert.equal(proseText(kept, ctx, { paths: false }), kept, 'idempotent');
  // The same text anywhere else in prose loses its foreign paths.
  const shortened = 'Run "…/setup/install.cmd" /quiet, then copy …/out/acme.bin to …/share/bin, as al…@example.test asked. Edit D:/work/acme/docs/guide.md.';
  assert.equal(proseText(proposal, ctx), shortened);

  // Field by field, in the state and in a record: only `proposal` is the exception.
  const stateHits = [];
  const state = applyProse({ items: [{ title: proposal, finding: proposal, proposal, question: proposal, opinion: proposal }] }, STATE_PROSE, ctx, stateHits);
  assert.deepEqual(state, { items: [{ title: shortened, finding: shortened, proposal: kept, question: shortened, opinion: shortened }] });
  assert.deepEqual(stateHits, ['/items/0/title', '/items/0/finding', '/items/0/proposal', '/items/0/question', '/items/0/opinion']);
  const record = applyProse({ name: proposal, items: [{ title: proposal, proposal, decision: { note: proposal } }] }, RECORD_PROSE, ctx);
  assert.deepEqual(record, { name: shortened, items: [{ title: shortened, proposal: kept, decision: { note: shortened } }] });
  // A proposal with nothing of a person in it is not touched at all.
  const plain = `Run ${FOREIGN} --check and read /var/log/acme/out.log`;
  const untouched = [];
  assert.deepEqual(applyProse({ items: [{ proposal: plain }] }, STATE_PROSE, proseContext(), untouched), { items: [{ proposal: plain }] });
  assert.deepEqual(untouched, []);
});

test('an e-mail address and a foreign path a reviewer wrote: masked in state.json, board.html, the record and its .md; file text untouched', (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop'] });
  // A second project that lives outside the home: its display path is its absolute path.
  const outside = tmpDir('hd-outside-');
  t.after(() => rmrf(outside));
  const selection = { ...sb.selection, projects: [...sb.selection.projects, { name: 'vault', path: outside, pathAbs: outside }] };
  const init = sb.init([], selection);
  assert.equal(init.code, 0, init.stdout + init.stderr);
  const vault = sb.read('run.json').harnesses.find((h) => h.id === 'vault');
  assert.ok(path.isAbsolute(vault.path) || /^[A-Za-z]:\//.test(vault.path), 'a project outside the home is shown by its absolute path');

  const inFile = ['D:', 'Vault', 'keys', 'readme.txt'].join('/');
  /** What the proposal runs: a path the user has to read exactly as it will be used. */
  const installer = ['E:', 'Tools', 'setup', 'install.cmd'].join('/');
  const findings = {
    rounds: [{ harness: 'acme-shop', round: 1, status: 'done' }, { harness: 'vault', round: 1, status: 'done' }],
    items: [
      item('ACME-101', 'acme-shop', 1, {
        title: `Contact ${mail('alice')} at ${FOREIGN}`,
        finding: `Seen by ${mail('bob')} in ${BS}${BS}fileserver${BS}share${BS}clients${BS}acme${BS}notes.md.`,
        evidence: `${FOREIGN}:2`,
        proposal: `Run ${installer} /quiet, as ${mail('alice')} asked.`,
        opinion: `Worth doing, says ${mail('bob')}.`,
        lesson: { why: `Why: ${mail('alice')}.`, impact: 'What it costs.', better: 'Why the result is better.', principle: `Never keep ${FOREIGN} in a rule.` },
        // The text of a change is not prose: it has to keep matching the file.
        changes: [{ path: './CLAUDE.md', lang: 'markdown', before: `owner: ${mail('carol')}`, after: `owner: see ${inFile}`, why: `Asked by ${mail('dave')}.` }],
      }),
      // The root of a harness of this run is named by its display path, whatever spelling it came in.
      item('VAULT-101', 'vault', 1, { title: `Rules of ${path.join(outside, 'docs', 'rules.md')}`, proposal: `Edit ${path.join(outside, 'CLAUDE.md')} by hand.`, changes: undefined, file: './README.md' }),
    ],
    leads: [{ harness: 'acme-shop', title: `Told by ${mail('erin')}`, source: `${FOREIGN}`, note: 'not confirmed' }],
  };
  const done = sb.complete('review:security', findings);
  assert.equal(done.code, 0, 'prose is rewritten, never refused: ' + done.stdout);

  const noted = sb.run(['decide', '--target', 'ACME-101', '--action', 'decline', '--note', `ask ${mail('frank')} first`]);
  assert.equal(noted.code, 0, noted.stdout + noted.stderr);
  const built = sb.run(['build'], { STUB_RENDER_DUMP: '1' });
  assert.equal(built.code, 0, built.stdout + built.stderr);
  const rewritten = built.json.mergeWarnings.filter((w) => /rewritten in prose/.test(w.problem));
  assert.equal(rewritten.length, 1);
  assert.match(rewritten[0].problem, /^e-mail address or absolute path rewritten in prose in \d+ place\(s\), first at \/items\/0\/title$/);

  const state = sb.read('state.json');
  const acme = state.items.find((i) => i.id === 'ACME-101');
  assert.deepEqual({
    title: acme.title, finding: acme.finding, evidence: acme.evidence, proposal: acme.proposal, opinion: acme.opinion,
    why: acme.lesson.why, principle: acme.lesson.principle, decision: acme.decision, change: acme.changes[0],
  }, {
    title: 'Contact al…@example.test at …/notes/plan.md',
    finding: 'Seen by bo…@example.test in …/acme/notes.md.',
    evidence: '…/notes/plan.md:2',
    // A proposal keeps its paths as written; an address in it is masked like anywhere else.
    proposal: `Run ${installer} /quiet, as al…@example.test asked.`,
    opinion: 'Worth doing, says bo…@example.test.',
    why: 'Why: al…@example.test.',
    principle: 'Never keep …/notes/plan.md in a rule.',
    decision: 'ask fr…@example.test first',
    change: { ...acme.changes[0], path: './CLAUDE.md', before: `owner: ${mail('carol')}`, after: `owner: see ${inFile}`, why: 'Asked by da…@example.test.' },
  });
  const vaultItem = state.items.find((i) => i.id === 'VAULT-101');
  assert.deepEqual([vaultItem.title, vaultItem.proposal], [`Rules of ${vault.path}/docs/rules.md`, `Edit ${vault.path}/CLAUDE.md by hand.`], 'in a proposal too');
  assert.deepEqual(state.leads[0], { harness: 'acme-shop', title: 'Told by er…@example.test', source: '…/notes/plan.md', note: 'not confirmed' });
  assert.equal(state.decisions[0].note, 'ask fr…@example.test first');
  assert.ok(state.log.every((l) => !l.text.includes('@example.test') || l.text.includes('…@example.test')));

  // The same for the two things that leave the run directory: the board and the record.
  assert.equal(sb.run(['close']).code, 0);
  const history = historyOf(sb);
  const key = sb.read('run.json').harnesses.find((h) => h.id === 'acme-shop').harnessKey;
  const record = history.record(key, sb.runId);
  assert.deepEqual({ title: record.items[0].title, proposal: record.items[0].proposal, principle: record.items[0].principle, note: record.items[0].decision.note, change: record.items[0].changes[0] }, {
    title: 'Contact al…@example.test at …/notes/plan.md',
    proposal: `Run ${installer} /quiet, as al…@example.test asked.`,
    principle: 'Never keep …/notes/plan.md in a rule.',
    note: 'ask fr…@example.test first',
    change: { path: './CLAUDE.md', before: `owner: ${mail('carol')}`, after: `owner: see ${inFile}` },
  });
  const texts = {
    'state.json': sb.text('state.json'),
    'board.html': sb.text('board.html'),
    record: fs.readFileSync(path.join(history.dir, key, `${sb.runId}.json`), 'utf8'),
    'record .md': history.md(key, sb.runId),
  };
  for (const [name, text] of Object.entries(texts)) {
    for (const who of ['alice', 'bob', 'dave', 'erin', 'frank']) assert.ok(!text.includes(mail(who)), `${name} does not hold the address of ${who}`);
    assert.ok(!text.includes('Clients/Acme') && !text.includes('fileserver'), `${name} does not hold the foreign path`);
  }
  // What a change quotes from a file is that file's text, and what a proposal runs is what will
  // be run: both are in the state, on the board and in the record as written.
  for (const name of ['state.json', 'board.html', 'record']) {
    assert.ok(texts[name].includes(mail('carol')) && texts[name].includes(inFile), `${name} keeps the text of the change`);
    assert.ok(texts[name].includes(`Run ${installer} /quiet`), `${name} keeps the path of the proposal`);
  }
  assert.ok(texts['record .md'].includes('- **ACME-101** Contact al…@example.test at …/notes/plan.md (medium, reversible)'));
});
