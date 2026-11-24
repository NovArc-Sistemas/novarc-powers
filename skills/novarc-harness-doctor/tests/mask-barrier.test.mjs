// End to end: a finding that spells a secret name the way only a parser reads it, or wraps the
// value in an expression, is refused by the real `run.mjs complete` with a pointer to where it
// is, and the value reaches no file of the run. The masker (lib/snapshot/mask.mjs) and the
// barrier (lib/run/secrets.mjs) cannot drift apart without this failing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskText } from '../scripts/lib/snapshot/mask.mjs';
import { sandbox, item, filesContaining } from './run-helpers.mjs';

// Assembled at runtime, so the repository scan finds no credential in this file.
const join = (...parts) => parts.join('');
const VALUE = join('private', 'Credential', '9876', '54');
const BS = '\\';
const ESCAPED_KEY = `{"pass${BS}u0077ord":"${VALUE}"}`; // what a JSON file holds when `w` is written as an escape

test('the escaped-key text really is a password to a JSON parser', () => {
  assert.equal(JSON.parse(ESCAPED_KEY).password, VALUE);
  assert.equal(maskText(ESCAPED_KEY), `{"pass${BS}u0077ord":"priv…23"}`);
});

test('complete refuses each spelling with its pointer, and stores nothing of the value', (t) => {
  const sb = sandbox(t, { accounts: 0, projects: ['acme-shop'] });
  assert.equal(sb.init().code, 0);
  const rounds = [{ harness: 'acme-shop', round: 1, status: 'done' }];
  // [where it is planted, the pointer the refusal names, the text]
  const places = [
    ['title', '/items/0/title', ESCAPED_KEY],
    ['finding', '/items/0/finding', `The hook runs password = "$(printf ${VALUE})" on every call.`],
    ['proposal', '/items/0/proposal', `Replace password: "\${{ '${VALUE}' }}" with a reference.`],
    ['evidence', '/items/0/evidence', `.mcp.json:4 "args": ["--api-key", "${VALUE}"]`],
  ];
  for (const [field, pointer, text] of places) {
    const r = sb.complete('review:security', { rounds, items: [item('ACME-101', 'acme-shop', 1, { [field]: text })] });
    assert.equal(r.code, 1, `${pointer}: refused`);
    assert.equal(r.json.ok, false, pointer);
    assert.equal(r.json.errors.length, 1, pointer);
    assert.ok(r.json.errors[0].startsWith(`${pointer}: credential (`), r.json.errors[0]);
    assert.ok(!(r.stdout + r.stderr).includes(VALUE), `${pointer}: the refusal does not show the value`);
    assert.deepEqual(filesContaining(sb.dir, VALUE), [], `${pointer}: nothing under the run directory holds it`);
    // The only file that holds it is the one handed in, which the run never copies.
    assert.deepEqual(filesContaining(sb.home, VALUE), ['findings-review-security.json'], pointer);
  }

  // With what the masker writes in its place, the same finding is accepted.
  const accepted = sb.complete('review:security', { rounds, items: [item('ACME-101', 'acme-shop', 1, { title: maskText(ESCAPED_KEY) })] });
  assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
  sb.run(['close']);
  assert.deepEqual(filesContaining(sb.home, VALUE), [], 'after the run is closed no file holds the value');
});
