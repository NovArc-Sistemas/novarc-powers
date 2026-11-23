// serve-board.mjs: real HTTP against the spawned server on a random port.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { sandbox, securityFindings, SERVE } from './run-helpers.mjs';

/** Start the server for the sandbox's run; resolves once it printed its URL. */
function startServer(t, sb, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVE, '--run', sb.runId, '--port', '0'], { env: { ...sb.env, NOVARC_HD_SERVE_POLL_MS: '100', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { child.kill(); });
    let out = '';
    let err = '';
    const exited = new Promise((res) => child.on('close', (code) => res(code)));
    const timer = setTimeout(() => reject(new Error(`server did not start: ${err}`)), 15000);
    child.stderr.on('data', (c) => { err += c; });
    child.stdout.on('data', (c) => {
      out += c;
      if (!out.includes('\n')) return;
      clearTimeout(timer);
      const { url } = JSON.parse(out.split('\n')[0]);
      const u = new URL(url);
      resolve({ child, exited, url, origin: u.origin, token: u.searchParams.get('t'), port: Number(u.port) });
    });
    child.on('close', (code) => { clearTimeout(timer); reject(new Error(`server exited early with ${code}: ${err}`)); });
  });
}

/** One HTTP request without keep-alive. `body` is sent as given (string or Buffer). */
function request(method, url, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, agent: false, headers: { ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function ready(t) {
  const sb = sandbox(t);
  assert.equal(sb.init().code, 0);
  assert.equal(sb.complete('review:security', securityFindings()).code, 0);
  fs.writeFileSync(sb.file('board.html'), '<!doctype html><title>board</title><p>first render</p>');
  return sb;
}
const lines = (sb) => (sb.exists('decisions.jsonl') ? sb.text('decisions.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('serves the board on 127.0.0.1 with a token, and nothing else', async (t) => {
  const sb = ready(t);
  const s = await startServer(t, sb);
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{32,}$/, 'a loopback URL with a URL-safe token');

  const page = await request('GET', s.url);
  assert.equal(page.status, 200);
  assert.equal(page.text, sb.text('board.html'));
  assert.match(page.headers['content-type'], /^text\/html; charset=utf-8/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['referrer-policy'], 'no-referrer', 'the token in the URL is not sent to the font host');
  const csp = page.headers['content-security-policy'];
  for (const part of ["default-src 'none'", "script-src 'unsafe-inline'", "connect-src 'self'", 'https://fonts.googleapis.com', 'font-src https://fonts.gstatic.com', "frame-ancestors 'none'"]) assert.ok(csp.includes(part), part);
  assert.equal(page.headers['access-control-allow-origin'], undefined, 'no CORS header');

  // Wrong or missing token: 401 on every route.
  for (const p of ['/', '/api/state', '/api/decisions']) {
    assert.equal((await request('GET', `${s.origin}${p}`)).status, 401, `${p} without a token`);
    assert.equal((await request('GET', `${s.origin}${p}?t=${s.token.slice(0, -1)}x`)).status, 401, `${p} with a wrong token`);
    assert.equal((await request('GET', `${s.origin}${p}?t=`)).status, 401);
  }
  const denied = await request('POST', `${s.origin}/api/decisions?t=nope`, { body: JSON.stringify({ target: 'ACME-101', action: 'approve' }) });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers['cache-control'], 'no-store');
  assert.deepEqual(lines(sb), [], 'nothing is recorded without the token');

  // No other file, no directory: run.json sits right next to board.html.
  for (const p of ['/run.json', '/board.html', '/state.json', '/..%2Frun.json', '/api', '/api/state/', '/api/decisions/x', '/favicon.ico']) {
    assert.equal((await request('GET', `${s.origin}${p}?t=${s.token}`)).status, 404, p);
  }
  assert.equal((await request('GET', `${s.origin}/nothing`)).status, 404, 'an unknown path is 404 even without a token');

  // Methods.
  const put = await request('PUT', `${s.origin}/api/decisions?t=${s.token}`, { body: '{}' });
  assert.equal(put.status, 405);
  assert.equal(put.headers.allow, 'GET, POST');
  assert.equal((await request('POST', `${s.origin}/?t=${s.token}`, { body: '{}' })).status, 405);
  assert.equal((await request('DELETE', `${s.origin}/api/state?t=${s.token}`)).status, 405);
  assert.equal((await request('OPTIONS', `${s.origin}/api/decisions?t=${s.token}`)).status, 405, 'no preflight is answered');

  // A request that reached this port under another host name (DNS rebinding) is refused.
  const rebind = await request('GET', s.url, { headers: { Host: 'evil.example.com' } });
  assert.equal(rebind.status, 403);
  assert.equal((await request('GET', s.url, { headers: { Host: `localhost:${s.port}` } })).status, 200);
});

test('POST /api/decisions validates and appends one decision; run.mjs decisions takes it in', async (t) => {
  const sb = ready(t);
  const s = await startServer(t, sb);
  const api = `${s.origin}/api/decisions?t=${s.token}`;

  assert.deepEqual((await request('GET', api)).json, { decisions: [] });
  const sent = { id: 'board-1', runId: sb.runId, target: 'ACME-101', action: 'approve', note: 'ok from the board', exclude: [], via: 'board' };
  const ok = await request('POST', api, { body: JSON.stringify(sent), headers: { 'Content-Type': 'application/json' } });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.ok, true);
  assert.deepEqual({ id: ok.json.decision.id, runId: ok.json.decision.runId, target: ok.json.decision.target, action: ok.json.decision.action, note: ok.json.decision.note, via: ok.json.decision.via }, { id: 'board-1', runId: sb.runId, target: 'ACME-101', action: 'approve', note: 'ok from the board', via: 'board' });
  assert.match(ok.json.decision.at, /^\d{4}-\d\d-\d\dT.*Z$/);

  // No id and no runId is fine: the server fills them in. A group and the primary account too.
  const second = await request('POST', api, { body: JSON.stringify({ target: 'G-1', action: 'decline', exclude: ['NP-101'] }) });
  assert.equal(second.status, 201, second.text);
  assert.match(second.json.decision.id, /^[0-9a-f-]{36}$/);
  assert.equal((await request('POST', api, { body: JSON.stringify({ target: 'accounts.primary', action: 'approve', note: 'codex-1' }) })).status, 201);
  assert.equal((await request('POST', api, { body: JSON.stringify({ target: 'ACME-102', action: 'ask', note: 'Why?' }) })).status, 201);

  const recorded = lines(sb);
  assert.equal(recorded.length, 4);
  assert.deepEqual(recorded.map((d) => [d.target, d.action, d.via, d.runId]), [['ACME-101', 'approve', 'board', sb.runId], ['G-1', 'decline', 'board', sb.runId], ['accounts.primary', 'approve', 'board', sb.runId], ['ACME-102', 'ask', 'board', sb.runId]]);
  assert.deepEqual((await request('GET', api)).json.decisions, recorded);

  // Invalid decisions: 400, nothing appended.
  const bad = [
    ['{"target": "ACME-101", "action":', /not valid JSON/],
    [JSON.stringify([{ target: 'ACME-101', action: 'approve' }]), /must be a JSON object/],
    [JSON.stringify({ target: 'ACME-101', action: 'delete-everything' }), /action must be one of/],
    [JSON.stringify({ target: '../run.json', action: 'approve' }), /target must be/],
    [JSON.stringify({ target: 'acme-101', action: 'approve' }), /target must be/],
    [JSON.stringify({ action: 'approve' }), /target must be/],
    [JSON.stringify({ target: 'ACME-101', action: 'approve', runId: '20200101-zzzz' }), /runId is not this run/],
    [JSON.stringify({ target: 'ACME-101', action: 'approve', status: 'fixed' }), /unknown field "status"/],
    [JSON.stringify({ target: 'ACME-101', action: 'approve', exclude: 'NP-101' }), /exclude must be a list/],
    [JSON.stringify({ target: 'ACME-101', action: 'approve', note: 42 }), /note must be a text/],
    [JSON.stringify({ target: 'ACME-101', action: 'ask' }), /ask needs the question/],
    [JSON.stringify({ target: 'accounts.primary', action: 'approve' }), /needs the account id/],
    [JSON.stringify({ target: 'ACME-101', action: 'approve', id: 'has spaces and "quotes"' }), /id must be/],
  ];
  for (const [body, reason] of bad) {
    const r = await request('POST', api, { body });
    assert.equal(r.status, 400, body);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, reason);
  }
  assert.equal(lines(sb).length, 4, 'a rejected decision is not recorded');

  // The session side: run.mjs decisions applies what the board sent.
  const taken = sb.run(['decisions']);
  assert.equal(taken.code, 0, taken.stdout);
  assert.deepEqual(taken.json.new.map((d) => [d.target, d.result]), [['ACME-101', 'applied'], ['G-1', 'applied'], ['accounts.primary', 'applied'], ['ACME-102', 'applied']]);
  assert.deepEqual(taken.json.approvedByHarness, {}, 'G-1 declined ACME-101 after the approve: nothing is left approved');
  const status = sb.read('status.json');
  assert.equal(status.items['ACME-101'].status, 'declined', 'the later group decision wins over the earlier approve');
  assert.equal(status.items['NP-101'], undefined, 'excluded from the group decision');
  assert.equal(status.items['ACME-102'].question, 'Why?');
  assert.equal(sb.read('run.json').primary, 'codex-1');
});

test('a body over 16 KB is rejected with 413', async (t) => {
  const sb = ready(t);
  const s = await startServer(t, sb);
  const api = `${s.origin}/api/decisions?t=${s.token}`;
  const big = JSON.stringify({ target: 'ACME-101', action: 'approve', note: 'x'.repeat(17 * 1024) });
  const r = await request('POST', api, { body: big });
  assert.equal(r.status, 413);
  assert.equal(r.json.ok, false);
  // The same when the length is not announced up front.
  const chunked = await new Promise((resolve, reject) => {
    const u = new URL(api);
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname + u.search, agent: false, headers: { 'Transfer-Encoding': 'chunked' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write(big.slice(0, 9000));
    req.end(big.slice(9000));
  });
  assert.equal(chunked, 413);
  assert.deepEqual(lines(sb), []);
  // Just under the limit, a decision with a long note is still judged on its own merits.
  const fits = await request('POST', api, { body: JSON.stringify({ target: 'ACME-101', action: 'approve', note: 'x'.repeat(3000) }) });
  assert.equal(fits.status, 201);
  assert.equal(lines(sb).length, 1);
});

test('/api/state reports a new version when board.html changes', async (t) => {
  const sb = ready(t);
  const s = await startServer(t, sb);
  const state = (v) => request('GET', `${s.origin}/api/state?t=${s.token}${v === undefined ? '' : `&v=${v}`}`);

  const first = await state();
  assert.equal(first.status, 200);
  assert.match(first.json.version, /^[0-9a-f]{16}$/);
  assert.equal(first.json.changed, false, 'no version given: nothing to compare');
  assert.equal((await state('')).json.changed, false, 'the board sends an empty version on its first poll');
  assert.deepEqual((await state(first.json.version)).json, { version: first.json.version, changed: false });

  fs.writeFileSync(sb.file('board.html'), '<!doctype html><title>board</title><p>second render, after a decision</p>');
  const second = await state(first.json.version);
  assert.notEqual(second.json.version, first.json.version);
  assert.equal(second.json.changed, true);
  assert.equal((await state(second.json.version)).json.changed, false);
  assert.match((await request('GET', s.url)).text, /second render/, 'the page is read fresh on every request');

  fs.rmSync(sb.file('board.html'));
  assert.deepEqual((await state(second.json.version)).json, { version: 'none', changed: true });
  const gone = await request('GET', s.url);
  assert.equal(gone.status, 404);
  assert.match(gone.json.error, /not built yet/);
});

test('the server exits when the run is closed, and refuses to start for a closed or unknown run', async (t) => {
  const sb = ready(t);
  const s = await startServer(t, sb);
  assert.equal((await request('GET', s.url)).status, 200);
  assert.equal(sb.run(['close']).code, 0);
  const code = await Promise.race([s.exited, new Promise((r) => setTimeout(() => r('still running'), 10000))]);
  assert.equal(code, 0, 'the server noticed run.json and exited on its own');
  await assert.rejects(request('GET', s.url), 'the port is closed');

  const start = (args) => spawnSync(process.execPath, [SERVE, ...args], { env: sb.env, encoding: 'utf8', timeout: 20000 });
  const closed = start(['--run', sb.runId]);
  assert.equal(closed.status, 1);
  assert.match(closed.stderr, /is closed/);
  assert.equal(closed.stdout, '', 'no URL is printed');
  assert.equal(start(['--run', '20200101-none']).status, 1);
  assert.equal(start(['--run', '../x']).status, 2);
  sb.init();
  assert.equal(start(['--port', '70000']).status, 2);
  assert.equal(start(['--port', 'http']).status, 2);
});
