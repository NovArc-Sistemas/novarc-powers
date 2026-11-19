import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { ROOT, cliEnv, readJson, sandbox } from './helpers.js';

const HOOK = path.join(ROOT, 'hooks', 'check-update.js');

/** Run the hook from its installed location (outside any package.json), as Claude Code does. */
function runHook(sb, registry) {
  const installed = path.join(sb.home, '.novarc-powers', 'hooks', 'check-update.js');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.copyFileSync(HOOK, installed);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [installed], { env: cliEnv(sb, { NOVARC_POWERS_REGISTRY_URL: registry }) });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

async function withRegistry(version, fn) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ name: 'novarc-powers', version }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/novarc-powers/latest`;
  try {
    return await fn(url, () => hits);
  } finally {
    server.close();
  }
}

function writeConfig(sb, cfg) {
  const dir = path.join(sb.home, '.novarc-powers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
}

test('hook prints one line when a newer version exists, then waits 24h', async (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  writeConfig(sb, { updates: 'notify', lastCheck: null, installedVersion: '0.1.0' });
  await withRegistry('0.2.0', async (url, hits) => {
    const first = await runHook(sb, url);
    assert.equal(first.code, 0);
    assert.equal(first.stdout.trim().split('\n').length, 1);
    assert.match(first.stdout, /npx novarc-powers@latest update/);
    assert.ok(readJson(path.join(sb.home, '.novarc-powers', 'config.json')).lastCheck);
    const second = await runHook(sb, url);
    assert.equal(second.stdout, '');
    assert.equal(hits(), 1, 'no second request within 24h');
  });
});

test('hook is silent when up to date, when off, and on network failure', async (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  writeConfig(sb, { updates: 'notify', lastCheck: null, installedVersion: '0.2.0' });
  await withRegistry('0.2.0', async (url) => {
    assert.equal((await runHook(sb, url)).stdout, '');
  });
  writeConfig(sb, { updates: 'off', lastCheck: null, installedVersion: '0.1.0' });
  await withRegistry('9.0.0', async (url, hits) => {
    assert.equal((await runHook(sb, url)).stdout, '');
    assert.equal(hits(), 0);
  });
  writeConfig(sb, { updates: 'notify', lastCheck: null, installedVersion: '0.1.0' });
  const dead = await runHook(sb, 'http://127.0.0.1:9/never');
  assert.equal(dead.code, 0);
  assert.equal(dead.stdout, '');
});