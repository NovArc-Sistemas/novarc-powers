// Anchoring (scripts/lib/anchors.mjs): where each change sits in its file, and the texts rebuilt from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorFile, anchorState, diffLines, toLines, normalizeEol, hunkContext, guessCategory, guessLang, virtualFileId } from '../scripts/lib/anchors.mjs';

const FILE = 'one\ntwo\nthree\nfour\nfive\n';
const entry = (item, change, index = 0) => ({ item, index, change });
const hunks = (res) => res.segments.filter((s) => s.type === 'hunk');
const kinds = (res) => res.segments.map((s) => (s.type === 'same' ? `same:${s.lines.length}` : `hunk:${s.item}`));

test('toLines treats one trailing newline as a terminator, and CRLF as LF', () => {
  assert.deepEqual(toLines(''), []);
  assert.deepEqual(toLines('a'), ['a']);
  assert.deepEqual(toLines('a\n'), ['a']);
  assert.deepEqual(toLines('a\n\n'), ['a', '']);
  assert.deepEqual(toLines('a\r\nb\r\n'), ['a', 'b']);
  assert.equal(normalizeEol('a\r\nb\rc'), 'a\nb\nc');
});

test('diffLines marks only what differs, deletions before additions', () => {
  assert.deepEqual(diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'y', 'd']).map((r) => r.t + r.text),
    ['samea', 'delb', 'addx', 'samec', 'addy', 'samed']);
  assert.deepEqual(diffLines([], ['n']).map((r) => r.t), ['add']);
  assert.deepEqual(diffLines(['o'], []).map((r) => r.t), ['del']);
});

test('a replacement in the middle of a file is drawn in place', () => {
  const res = anchorFile({ content: FILE }, [entry('X-1', { before: 'three', after: 'THREE\n3b' })]);
  assert.deepEqual(kinds(res), ['same:2', 'hunk:X-1', 'same:2']);
  const [h] = hunks(res);
  assert.deepEqual(h.removed, ['three']);
  assert.deepEqual(h.added, ['THREE', '3b']);
  assert.deepEqual([h.oldStart, h.newStart, h.curStart], [3, 3, 3]);
  assert.deepEqual(h.rows, [{ t: 'del', text: 'three', old: 3 }, { t: 'add', text: 'THREE', new: 3 }, { t: 'add', text: '3b', new: 4 }]);
  assert.equal(res.before, FILE);
  assert.equal(res.current, FILE);
  assert.equal(res.after, 'one\ntwo\nTHREE\n3b\nfour\nfive\n');
  assert.deepEqual(res.segments[2], { type: 'same', lines: ['four', 'five'], oldStart: 4, newStart: 5, curStart: 4 });
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(res.stats, { hunks: 1, pending: 1, applied: 0, added: 2, removed: 1, detached: 0 });
});

test('common leading and trailing lines of a hunk are trimmed, so only real differences are coloured', () => {
  const res = anchorFile({ content: FILE }, [entry('X-1', { before: 'two\nthree\nfour', after: 'two\n3\nfour' })]);
  const [h] = hunks(res);
  assert.deepEqual(h.removed, ['three']);
  assert.deepEqual(h.added, ['3']);
  assert.equal(h.curStart, 3);
  assert.deepEqual(kinds(res), ['same:2', 'hunk:X-1', 'same:2']);
  assert.equal(res.after, 'one\ntwo\n3\nfour\nfive\n');
});

test('a change inside a line is shown as that whole line replaced', () => {
  const res = anchorFile({ content: 'allow: [a, b, c]\ndeny: []\n' }, [entry('X-1', { before: 'b, c', after: 'b' })]);
  const [h] = hunks(res);
  assert.deepEqual(h.removed, ['allow: [a, b, c]']);
  assert.deepEqual(h.added, ['allow: [a, b]']);
  assert.equal(res.after, 'allow: [a, b]\ndeny: []\n');
});

test('a pure insertion goes after its insertAfter line, or at the end without one', () => {
  const after = anchorFile({ content: FILE }, [entry('X-1', { before: '', after: 'two and a half\n', insertAfter: 'two' })]);
  assert.deepEqual(kinds(after), ['same:2', 'hunk:X-1', 'same:3']);
  assert.deepEqual(hunks(after)[0].removed, []);
  assert.deepEqual(hunks(after)[0].added, ['two and a half']);
  assert.equal(after.after, 'one\ntwo\ntwo and a half\nthree\nfour\nfive\n');

  const end = anchorFile({ content: FILE }, [entry('X-2', { before: '', after: 'six' })]);
  assert.deepEqual(kinds(end), ['same:5', 'hunk:X-2']);
  assert.equal(end.after, 'one\ntwo\nthree\nfour\nfive\nsix\n');
  assert.equal(hunks(end)[0].newStart, 6);

  const lost = anchorFile({ content: FILE }, [entry('X-3', { before: '', after: 'x', insertAfter: 'zero' })]);
  assert.deepEqual(lost.warnings, [{ item: 'X-3', change: 0, problem: 'insertAfter line not found in the file', code: 'insert-after-not-found' }]);
  assert.equal(lost.detached.length, 1);
  assert.equal(lost.after, FILE, 'a change that is not placed changes nothing');
});

test('a removal takes its lines out of the after text', () => {
  const res = anchorFile({ content: FILE }, [entry('X-1', { before: 'two\nthree\n', after: '' })]);
  assert.deepEqual(hunks(res)[0].removed, ['two', 'three']);
  assert.deepEqual(hunks(res)[0].added, []);
  assert.equal(res.after, 'one\nfour\nfive\n');
});

test('an applied change is located by its after text, and reverted in the before text', () => {
  const res = anchorFile({ content: FILE }, [entry('X-1', { before: 'TWO (old)', after: 'two', applied: true })]);
  const [h] = hunks(res);
  assert.equal(h.applied, true);
  assert.deepEqual(h.removed, ['TWO (old)']);
  assert.deepEqual(h.added, ['two']);
  assert.equal(res.current, FILE);
  assert.equal(res.after, FILE, 'what is applied is already there');
  assert.equal(res.before, 'one\nTWO (old)\nthree\nfour\nfive\n');
  assert.deepEqual(res.stats, { hunks: 1, pending: 0, applied: 1, added: 1, removed: 1, detached: 0 });

  // An applied removal leaves nothing to look for: kept as history, without a warning.
  const gone = anchorFile({ content: FILE }, [entry('X-2', { before: 'zero', after: '', applied: true })]);
  assert.deepEqual(gone.warnings, []);
  assert.equal(gone.detached[0].code, 'applied-removal');

  const lost = anchorFile({ content: FILE }, [entry('X-3', { before: 'a', after: 'not in the file', applied: true })]);
  assert.equal(lost.warnings[0].code, 'after-not-found');
});

test('CRLF is normalised on both sides before matching', () => {
  const res = anchorFile({ content: 'one\r\ntwo\r\nthree\r\n' }, [entry('X-1', { before: 'two\r\nthree', after: 'TWO\r\nthree' })]);
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(hunks(res)[0].removed, ['two']);
  assert.equal(res.after, 'one\nTWO\nthree\n');
  const lf = anchorFile({ content: 'one\ntwo\n' }, [entry('X-2', { before: 'one\r\n', after: 'ONE\r\n' })]);
  assert.equal(lf.after, 'ONE\ntwo\n');
});

test('a change that cannot be located is a warning and a detached hunk', () => {
  const res = anchorFile({ content: FILE }, [entry('X-1', { before: 'seven', after: '7' }, 2)]);
  assert.deepEqual(res.warnings, [{ item: 'X-1', change: 2, problem: 'before text not found in the file', code: 'before-not-found' }]);
  assert.deepEqual(kinds(res), ['same:5']);
  assert.equal(res.detached.length, 1);
  assert.deepEqual(res.detached[0].removed, ['seven']);
  assert.deepEqual(res.detached[0].added, ['7']);
  assert.equal(res.after, FILE);
  const same = anchorFile({ content: FILE }, [entry('X-2', { before: 'two', after: 'two' })]);
  assert.equal(same.warnings[0].code, 'no-op');
});

test('overlapping changes: the first wins, the other is a warning', () => {
  const res = anchorFile({ content: FILE }, [
    entry('X-1', { before: 'two\nthree', after: '2\n3' }),
    entry('X-2', { before: 'three\nfour', after: 'III\nIV' }),
    entry('X-3', { before: '', after: 'inside', insertAfter: 'two' }),
  ]);
  assert.deepEqual(hunks(res).map((h) => h.item), ['X-1']);
  assert.deepEqual(res.warnings.map((w) => [w.item, w.code]), [['X-2', 'overlap'], ['X-3', 'overlap']]);
  assert.equal(res.after, 'one\n2\n3\nfour\nfive\n');
  // Context lines may overlap when the real edits do not.
  const ok = anchorFile({ content: FILE }, [
    entry('X-1', { before: 'one\ntwo\nthree', after: 'one\nTWO\nthree' }),
    entry('X-2', { before: 'three\nfour\nfive', after: 'three\nFOUR\nfive' }),
  ]);
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.after, 'one\nTWO\nthree\nFOUR\nfive\n');
});

test('the same text twice in a file: each change takes the next free occurrence', () => {
  const res = anchorFile({ content: 'x\nrepeat\ny\nrepeat\n' }, [
    entry('X-1', { before: 'repeat', after: 'first' }),
    entry('X-2', { before: 'repeat', after: 'second' }),
  ]);
  assert.deepEqual(res.warnings, []);
  assert.equal(res.after, 'x\nfirst\ny\nsecond\n');
});

test('several changes in one file come out in file order, with running line numbers', () => {
  const res = anchorFile({ content: FILE }, [
    entry('X-2', { before: 'five', after: '5' }),
    entry('X-1', { before: '', after: 'zero.five\nzero.six', insertAfter: 'one' }),
  ]);
  assert.deepEqual(kinds(res), ['same:1', 'hunk:X-1', 'same:3', 'hunk:X-2']);
  assert.deepEqual(hunks(res).map((h) => [h.oldStart, h.newStart]), [[2, 2], [5, 7]]);
  assert.equal(res.after, 'one\nzero.five\nzero.six\ntwo\nthree\nfour\n5\n');
});

test('anchorState: new files, files outside the snapshot, omitted files and warnings in state order', () => {
  const state = {
    files: [
      { id: 'f1', harness: 'h', path: './a.md', category: 'doc', content: FILE },
      { id: 'f2', harness: 'h', path: './big.md', category: 'doc', content: '', omitted: 'too-large' },
    ],
    items: [
      { id: 'H-1', harness: 'h', changes: [
        { file: 'f1', path: './a.md', before: 'one', after: 'ONE' },
        { path: './.githooks/pre-push', before: '', after: '#!/bin/sh\nnpm test\n' },
        { file: 'f2', path: './big.md', before: 'x', after: 'y' },
      ] },
      { id: 'H-2', harness: 'h', changes: [
        { path: './a.md', before: 'four', after: 'FOUR' },
        { path: './elsewhere.md', before: 'x', after: 'y' },
        { file: 'nope', path: './ghost.md', before: 'x', after: 'y' },
      ] },
    ],
  };
  const a = anchorState(state);
  const newId = virtualFileId('h', './.githooks/pre-push');
  assert.deepEqual(a.virtual.map((v) => [v.path, v.virtual, v.category, v.lang]), [
    ['./.githooks/pre-push', 'new', 'gate', 'shell'],
    ['./elsewhere.md', 'missing', 'other', 'markdown'],
    ['./ghost.md', 'missing', 'other', 'markdown'],
  ]);
  // The new file is all added; the change without a file id found ./a.md by its path.
  assert.deepEqual(a.files[newId].segments.map((s) => [s.type, s.added.length, s.removed.length]), [['hunk', 2, 0]]);
  assert.equal(a.files[newId].after, '#!/bin/sh\nnpm test\n');
  assert.equal(a.files[newId].current, '');
  assert.equal(a.files.f1.after, 'ONE\ntwo\nthree\nFOUR\nfive\n');
  assert.deepEqual(a.byItem['H-1'], [
    { change: 0, file: 'f1', located: true, code: null },
    { change: 1, file: newId, located: true, code: null },
    { change: 2, file: 'f2', located: false, code: 'file-omitted' },
  ]);
  assert.deepEqual(a.warnings.map((w) => [w.item, w.change, w.code]), [
    ['H-1', 2, 'file-omitted'], ['H-2', 1, 'file-not-in-snapshot'], ['H-2', 2, 'file-id-unknown'],
  ]);
  assert.ok(a.warnings.every((w) => typeof w.problem === 'string' && w.problem.length > 5));
});

test('a change aimed at a linked file is drawn in the file it links to', () => {
  const state = {
    files: [
      { id: 'f1', harness: 'main', path: '~/.claude/CLAUDE.md', category: 'instructions', content: FILE },
      { id: 'f2', harness: 'second', path: '~/.claude-2/CLAUDE.md', category: 'instructions', content: '', omitted: 'linked', linkTo: '~/.claude/CLAUDE.md', inheritedFrom: 'main' },
      { id: 'f3', harness: 'second', path: '~/.claude-2/lost.md', category: 'doc', content: '', omitted: 'linked', linkTo: '~/.claude/gone.md', inheritedFrom: 'main' },
    ],
    items: [
      { id: 'S-1', harness: 'second', changes: [{ file: 'f2', path: '~/.claude-2/CLAUDE.md', before: 'two', after: 'TWO' }] },
      { id: 'S-2', harness: 'second', changes: [{ path: '~/.claude-2/CLAUDE.md', before: 'four', after: 'FOUR' }] },
      { id: 'S-3', harness: 'second', changes: [{ file: 'f3', path: '~/.claude-2/lost.md', before: 'x', after: 'y' }] },
    ],
  };
  const a = anchorState(state);
  assert.equal(a.files.f1.after, 'one\nTWO\nthree\nFOUR\nfive\n', 'both changes land in the file that owns the text');
  assert.equal(a.files.f2, undefined);
  assert.deepEqual(a.byItem['S-1'], [{ change: 0, file: 'f1', located: true, code: null }]);
  assert.deepEqual(a.byItem['S-2'], [{ change: 0, file: 'f1', located: true, code: null }]);
  // A link whose target is not in the snapshot has nothing to draw the change in.
  assert.deepEqual(a.warnings.map((w) => [w.item, w.code]), [['S-3', 'file-omitted']]);
});

test('hunkContext gives the hunk with a few lines of the file around it', () => {
  const res = anchorFile({ content: FILE }, [entry('X-1', { before: 'three', after: '3' })]);
  const ctx = hunkContext(res, 'X-1', 0, 1);
  assert.deepEqual(ctx.rows, [
    { t: 'same', text: 'two', old: 2, new: 2 },
    { t: 'del', text: 'three', old: 3 },
    { t: 'add', text: '3', new: 3 },
    { t: 'same', text: 'four', old: 4, new: 4 },
  ]);
  assert.equal(ctx.located, true);
  assert.equal(hunkContext(res, 'X-9', 0), null);
});

test('display guesses for files that exist only as a proposal', () => {
  const cat = { './CLAUDE.md': 'instructions', '~/.claude/settings.json': 'settings', '~/.claude/hooks/x.sh': 'hook', './.github/workflows/ci.yml': 'gate',
    './.githooks/pre-commit': 'gate', '~/.claude/skills/x/SKILL.md': 'skill', '~/.claude/agents/r.md': 'agent', './.mcp.json': 'mcp', './docs/a.md': 'doc', './scripts/x.sh': 'script', './x.bin': 'other' };
  for (const [p, c] of Object.entries(cat)) assert.equal(guessCategory(p), c, p);
  assert.equal(guessLang('./a/b.yml'), 'yaml');
  assert.equal(guessLang('./.githooks/pre-commit'), 'shell');
  assert.equal(guessLang('./LICENSE'), 'text');
});
