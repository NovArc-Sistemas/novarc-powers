#!/usr/bin/env node
// serve-board.mjs [--run <id>] [--port 0]
//
// Serves one run's board on 127.0.0.1 so the user can read it in a browser while the session
// works (channel `server`, references/contracts.md). The board only shows: decisions are taken in
// the chat (`run.mjs decide`), so nothing is ever sent back here. Prints
// { "url": "http://127.0.0.1:<port>/?t=<token>" } on stdout once it listens.
//
//   GET /?t=                     board.html
//   GET /api/state?t=&v=<ver>    { version, changed }: the board reloads when it changed
//
// Any other method is 405. `--help` prints the usage.
//
// Every route needs the token (random per start, compared in constant time). It serves no other
// file and no directory, sets no CORS header, accepts no request body, answers only requests
// addressed to this machine, and exits after 12 hours or when run.json says the run is closed.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { parseArgs, isMain, warn } from './lib/common.mjs';
import { runPaths, latestRunId, RUN_ID_RE } from './lib/run/paths.mjs';
import { readJson, sha256 } from './lib/run/store.mjs';

export const MAX_AGE_MS = 12 * 60 * 60 * 1000;
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
  };

  return http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { send(res, 400, { ok: false, error: 'bad request' }); return; }
    const route = Object.hasOwn(routes, url.pathname) ? routes[url.pathname] : null;
    if (!route) { send(res, 404, { ok: false, error: 'not found' }); return; }
    if (!hostAllowed(req.headers.host)) { send(res, 403, { ok: false, error: 'this server only answers on 127.0.0.1' }); return; }
    // Nothing is ever written through this server: any method but GET is refused before the token
    // is even looked at, and its body is read and thrown away.
    const handler = Object.hasOwn(route, req.method) ? route[req.method] : null;
    if (!handler) { req.resume(); send(res, 405, { ok: false, error: 'method not allowed' }, { Allow: 'GET', Connection: 'close' }); return; }
    if (!tokenOk(url.searchParams.get('t'))) { send(res, 401, { ok: false, error: 'missing or wrong token' }); return; }
    Promise.resolve().then(() => handler(req, res, url)).catch(() => { if (!res.headersSent) send(res, 500, { ok: false, error: 'internal error' }); else res.destroy(); });
  });
}

function envMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const USAGE = 'usage: serve-board.mjs [--run <id>] [--port 0]';

function main() {
  if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
    process.stdout.write(`${USAGE}\n\nServes one run's board on 127.0.0.1 (the latest run without --run) and prints { "url": ... }.\n`);
    return;
  }
  const args = parseArgs();
  const fail = (msg, code) => { warn(msg); process.exit(code); };
  let runId = args.run;
  if (runId === undefined) runId = latestRunId();
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) fail(USAGE, 2);
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
