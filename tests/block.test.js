import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCK_END, BLOCK_START, extractBlock, removeBlock, renderBlockBody, upsertBlock } from '../src/block.js';

const body = renderBlockBody([{ name: 'alpha', summary: 'Alpha summary.' }], '9.9.9');
const body2 = renderBlockBody(
  [
    { name: 'alpha', summary: 'Alpha summary.' },
    { name: 'gamma', summary: 'Gamma summary.' },
  ],
  '9.9.9',
);

test('block body names the skill, the summary and the pinned fetch command', () => {
  assert.match(body, /`alpha`: Alpha summary\./);
  assert.match(body, /npx -y novarc-powers@9\.9\.9 fetch alpha/);
  assert.match(body, /read the SKILL\.md at the printed path and follow it/);
});

test('insert into a missing file creates just the block', () => {
  const out = upsertBlock(null, body);
  assert.ok(out.startsWith(BLOCK_START));
  assert.ok(out.trimEnd().endsWith(BLOCK_END));
  assert.equal(upsertBlock(out, body), out, 'second upsert is a no-op');
});

test('insert keeps surrounding text byte for byte and is idempotent', () => {
  const original = '# My rules\n\nBe nice.\n';
  const once = upsertBlock(original, body);
  assert.ok(once.startsWith(original), 'text before the block is untouched');
  assert.equal(upsertBlock(once, body), once);
  const withAfter = once + '\n## Later section\nkeep me\n';
  const replaced = upsertBlock(withAfter, body2);
  assert.ok(replaced.startsWith(original));
  assert.ok(replaced.endsWith('\n## Later section\nkeep me\n'), 'text after the block is untouched');
  assert.match(extractBlock(replaced), /gamma/);
  assert.equal(upsertBlock(replaced, body2), replaced);
});

test('replace swaps only the block content', () => {
  const start = 'top\n' + upsertBlock('', body) + 'bottom\n';
  const next = upsertBlock(start, body2);
  assert.ok(next.startsWith('top\n' + BLOCK_START));
  assert.ok(next.endsWith(BLOCK_END + '\nbottom\n'));
  assert.equal(next.split(BLOCK_START).length, 2, 'exactly one block');
});

test('CRLF files keep CRLF everywhere, including the block', () => {
  const original = '# Rules\r\n\r\nLine two\r\n';
  const out = upsertBlock(original, body);
  assert.ok(out.startsWith(original));
  assert.equal(out.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF introduced');
  const replaced = upsertBlock(out, body2);
  assert.equal(replaced.replace(/\r\n/g, '').includes('\n'), false);
  const removed = removeBlock(replaced);
  assert.equal(removed, original, 'remove restores the original CRLF text');
});

test('remove restores the original text and is idempotent', () => {
  const original = '# Mine\n\nstuff\n';
  const added = upsertBlock(original, body);
  const removed = removeBlock(added);
  assert.equal(removed, original);
  assert.equal(removeBlock(removed), removed);
  assert.equal(removeBlock(upsertBlock(null, body)), '');
});

test('remove keeps text that follows the block', () => {
  const text = 'a\n\n' + upsertBlock('', body) + 'z\n';
  assert.equal(removeBlock(text), 'a\n\nz\n');
});