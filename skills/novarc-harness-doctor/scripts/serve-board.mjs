#!/usr/bin/env node
// serve-board.mjs [--run <id>] [--port 0]
//
// Serves one run's board on 127.0.0.1 so the board can send decisions back to the session
// (channel `server`, references/contracts.md). Prints { "url": "http://127.0.0.1:<port>/?t=<token>" }
// on stdout once it listens.
//
//   GET  /?t=                     board.html
//   GET  /api/state?t=&v=<ver>    { version, changed }: the board reloads when it changed
//   GET  /api/decisions?t=        { decisions: [...] } recorded so far
//   POST /api/decisions?t=        validates one decision and appends it to decisions.jsonl
//
// Every route needs the token (random per start, compared in constant time). It serves no other
// file and no directory, sets no CORS header, rejects bodies over 16 KB, answers only requests
// addressed to this machine, and exits after 12 hours or when run.json says the run is closed.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { parseArgs, isMain, warn } from './lib/common.mjs';
import { runPaths, latestRunId, RUN_ID_RE } from './lib/run/paths.mjs';
import { RunError, readJson, readJsonl, appendJsonLine, withLock, sha256, nowIso } from './lib/run/store.mjs';
import { normalizeDecision } from './lib/run/decisions.mjs';

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const DRAIN_LIMIT = 1024 * 1024;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// The board is one self-contained file: inline script and style, web fonts from Google Fonts,
// requests only back to this server.
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com data:',
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': CSP,
  // The token is in the URL: never hand it to the font host in a Referer header.
  'Referrer-Policy': 'no-referrer',
};

function send(res, code, body, headers = {}) {
  const isText = typeof body === 'string' || Buffer.isBuffer(body);
  const payload = isText ? body : JSON.stringify(body);
  res.writeHead(code, {
    ...BASE_HEADERS,
    'Content-Type': isText ? (headers['Content-Type'] || 'text/plain; charset=utf-8') : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/**
 * Collect a request body up to `limit` bytes: { body } or { tooLarge: true }.
 * An oversized body is read to its end and thrown away before answering: closing the socket on
 * unread data would reset the connection and the client would never see the 413. Past
 * DRAIN_LIMIT that courtesy ends (`abort: true`: answer, then drop the connection).
 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > DRAIN_LIMIT) { done({ tooLarge: true, abort: true }); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > DRAIN_LIMIT) { done({ tooLarge: true, abort: true }); return; }
      if (size > limit) chunks.length = 0; else chunks.push(c);
    });
    req.on('end', () => done(size > limit ? { tooLarge: true } : { body: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => done({ body: '' }));
  });
}

function hostAllowed(header) {
  if (typeof header !== 'string') return false;
  const host = header.trim().toLowerCase().replace(/:\d+$/, '');
  return LOCAL_HOSTS.has(host);
}

/** The http.Server for one run. `paths` from runPaths(); `token` a URL-safe secret. */
export function createBoardServer(paths, token) {
  const expected = crypto.createHash('sha256').update(token).digest();
  const tokenOk = (given) => typeof given === 'string' && crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), expected);

  const boardVersion = () => {
    try { const st = fs.statSync(paths.board); return sha256(`${st.mtimeMs}:${st.size}`).slice(0, 16); } catch { return 'none'; }
  };

  const routes = {
    '/': {
      GET: (req, res) => {
        let html;
        try { html = fs.readFileSync(paths.board); } catch { send(res, 404, { ok: false, error: 'the board is not built yet: run.mjs build --channel server' }); return; }
        send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
      },
    },
    '/api/state': {
      GET: (req, res, url) => {
        const version = boardVersion();
        const seen = url.searchParams.get('v');
        send(res, 200, { version, changed: !!seen && seen !== version });
      },
    },
    '/api/decisions': {
      GET: (req, res) => {
        send(res, 200, { decisions: readJsonl(paths.decisions).filter((l) => l.value && typeof l.value === 'object').map((l) => l.value) });
      },
      POST: async (req, res) => {
        const got = await readBody(req, MAX_BODY_BYTES);
        if (got.tooLarge) {
          if (got.abort) res.on('finish', () => req.destroy());
          send(res, 413, { ok: false, error: 'body larger than 16 KB' }, got.abort ? { Connection: 'close' } : {});
          return;
        }
        let raw;
        try { raw = JSON.parse(got.body); } catch { send(res, 400, { ok: false, error: 'body is not valid JSON' }); return; }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { send(res, 400, { ok: false, error: 'a decision must be a JSON object' }); return; }
        // One clock for every decision of the run: the time this server received it.
        const candidate = { ...raw, at: nowIso(), via: 'board' };
        if (candidate.id === undefined) candidate.id = crypto.randomUUID();
        const checked = normalizeDecision(candidate, { runId: paths.runId, via: 'board', strict: true });
        if (!checked.ok) { send(res, 400, { ok: false, error: checked.reason }); return; }
        let run = null;
        try { run = readJson(paths.run); } catch { run = null; }
        if (!run || run.closed === true) { send(res, 409, { ok: false, error: 'the run is closed' }); return; }
        try {
          withLock(paths.mutex, () => appendJsonLine(paths.decisions, checked.decision), { timeoutMs: 3000 });
        } catch (e) {
          send(res, 503, { ok: false, error: e instanceof RunError ? 'the run directory is busy; try again' : 'could not record the decision' });
          return;
        }
        send(res, 201, { ok: true, decision: checked.decision });
      },
    },
  };

  return http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { send(res, 400, { ok: false, error: 'bad request' }); return; }
    const route = Object.hasOwn(routes, url.pathname) ? routes[url.pathname] : null;
    if (!route) { send(res, 404, { ok: false, error: 'not found' }); return; }
    if (!hostAllowed(req.headers.host)) { send(res, 403, { ok: false, error: 'this server only answers on 127.0.0.1' }); return; }
    if (!tokenOk(url.searchParams.get('t'))) { send(res, 401, { ok: false, error: 'missing or wrong token' }); return; }
    const handler = Object.hasOwn(route, req.method) ? route[req.method] : null;
    if (!handler) { send(res, 405, { ok: false, error: 'method not allowed' }, { Allow: Object.keys(route).join(', ') }); return; }
    Promise.resolve().then(() => handler(req, res, url)).catch(() => { if (!res.headersSent) send(res, 500, { ok: false, error: 'internal error' }); else res.destroy(); });
  });
}

function envMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function main() {
  const args = parseArgs();
  const fail = (msg, code) => { warn(msg); process.exit(code); };
  let runId = args.run;
  if (runId === undefined) runId = latestRunId();
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) fail('usage: serve-board.mjs --run <id> [--port 0]', 2);
  const port = args.port === undefined ? 0 : Number(args.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port takes a number from 0 to 65535 (0 picks a free one)', 2);
  const paths = runPaths(runId);
  const isClosed = () => { try { const run = readJson(paths.run); return !run || run.closed === true; } catch { return false; } };
  if (!fs.existsSync(paths.run)) fail(`run ${runId} not found`, 1);
  if (isClosed()) fail(`run ${runId} is closed`, 1);

  const token = crypto.randomBytes(24).toString('base64url');
  const server = createBoardServer(paths, token);
  server.on('error', (e) => fail(`could not listen: ${e.code || 'error'}`, 1));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 1500).unref();
    server.close(() => process.exit(0));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  };
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/?t=${token}` })}\n`);
    setTimeout(stop, envMs('NOVARC_HD_SERVE_MAX_MS', MAX_AGE_MS));
    setInterval(() => { if (isClosed()) stop(); }, envMs('NOVARC_HD_SERVE_POLL_MS', 3000));
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (isMain(import.meta.url)) main();
