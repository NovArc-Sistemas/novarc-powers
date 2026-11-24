// The board page as a whole: board.html is parsed and its inline script runs against a small
// stand-in for the DOM, so these tests cover what the pure-logic tests cannot: that the page boots
// in both shells (standalone document, Artifact fragment), where it opens, that it only shows (no
// channel sends anything), and how a value that was not measured is drawn.
// The stand-in implements only what the client calls. It is not a browser: layout is all zeros.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES } from './helpers.mjs';
import { renderHtml, SCHEMA_PATH, HOOK_EVENTS } from '../scripts/render-board.mjs';
import { applyScores } from '../scripts/lib/scoring.mjs';
import { STRINGS } from '../scripts/lib/i18n.mjs';

const fixture = () => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'state.fixture.json'), 'utf8'));
const example = () => JSON.parse(fs.readFileSync(path.join(path.dirname(SCHEMA_PATH), 'state.example.json'), 'utf8'));
const REV_A = '0123456789ab';
const REV_B = 'ba9876543210';
const REV_G = 'feedfacecafe';

// ---------------------------------------------------------------------------------------------
// A DOM small enough to read
// ---------------------------------------------------------------------------------------------

const VOID = new Set(['meta', 'link', 'br', 'hr', 'img', 'input']);
const RAW = new Set(['script', 'style', 'title']);
const unescape = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[k]));

/** `a.b#c[d="e"] f`: tag, id, classes and attributes, with the descendant combinator. */
function parseSelector(selector) {
  return selector.match(/(?:\[[^\]]*\]|[^\s[])+/g).map((part) => {
    const m = /^([a-zA-Z][\w-]*)?(.*)$/.exec(part);
    const tests = [];
    if (m[1]) tests.push((n) => n.tagName === m[1].toUpperCase());
    const tokens = m[2].match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]/g) || [];
    assert.equal(tokens.join(''), m[2], `selector not supported by the stand-in: ${selector}`);
    for (const t of tokens) {
      if (t[0] === '#') tests.push((n) => n.getAttribute('id') === t.slice(1));
      else if (t[0] === '.') tests.push((n) => n.classList.contains(t.slice(1)));
      else {
        const a = /^\[([\w-]+)(?:(\^?=)"((?:[^"\\]|\\.)*)")?\]$/.exec(t);
        const value = a[3] === undefined ? null : a[3].replace(/\\(.)/g, '$1');
        tests.push((n) => {
          const v = n.getAttribute(a[1]);
          return v !== null && (value === null || (a[2] === '^=' ? v.startsWith(value) : v === value));
        });
      }
    }
    return (n) => tests.every((f) => f(n));
  });
}

class FakeNode {
  constructor(tag) {
    this.nodeType = tag === null ? 3 : 1;
    this.tagName = tag === null ? undefined : String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.listeners = {};
    this.data = '';
    this.style = { setProperty(k, v) { this[k] = String(v); }, removeProperty(k) { delete this[k]; } };
    this.scrollWidth = 0; this.clientWidth = 0; this.offsetTop = 0; this.offsetHeight = 0;
    const node = this;
    this.classList = {
      list: () => (node.getAttribute('class') || '').split(/\s+/).filter(Boolean),
      contains(c) { return this.list().includes(c); },
      add(c) { if (!this.contains(c)) node.setAttribute('class', [...this.list(), c].join(' ')); },
      remove(c) { node.setAttribute('class', this.list().filter((x) => x !== c).join(' ')); },
      toggle(c, on) { if (on === undefined ? !this.contains(c) : on) this.add(c); else this.remove(c); },
    };
  }

  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  get previousElementSibling() {
    const sibs = this.parentNode ? this.parentNode.children : [];
    return sibs[sibs.indexOf(this) - 1] || null;
  }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) {
    if (this.nodeType === 3) { this.data = String(v); return; }
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v !== null && v !== undefined) { const t = new FakeNode(null); t.data = String(v); this.appendChild(t); }
  }
  get open() { return this.attrs.has('open'); }
  set open(v) { if (v) this.attrs.set('open', ''); else this.attrs.delete('open'); }

  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(n) { return this.insertBefore(n, null); }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(n); else this.childNodes.splice(at, 0, n);
    n.parentNode = this;
    return n;
  }
  removeChild(n) {
    const at = this.childNodes.indexOf(n);
    if (at < 0) throw new Error('removeChild: not a child');
    this.childNodes.splice(at, 1);
    n.parentNode = null;
    return n;
  }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  /** Not DOM: runs the listeners of this node only (no bubbling). */
  fire(type, event = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {}, ...event }); }
  click() { this.fire('click', { button: 0 }); }
  focus() {} blur() {} select() {} scrollIntoView() {} setSelectionRange() {}
  getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; }

  matches(selector) {
    // A selector list: any of its selectors.
    if (selector.includes(',') && !/[[^]]*,/.test(selector)) return selector.split(',').some((one) => this.matches(one.trim()));
    const parts = parseSelector(selector);
    if (!parts[parts.length - 1](this)) return false;
    let k = parts.length - 2;
    for (let up = this.parentNode; up && k >= 0; up = up.parentNode) if (up.nodeType === 1 && parts[k](up)) k--;
    return k < 0;
  }
  closest(selector) { for (let n = this; n; n = n.parentNode) if (n.nodeType === 1 && n.matches(selector)) return n; return null; }
  querySelectorAll(selector) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c.matches(selector)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

/** Parses the page markup into a tree. It only knows what board.html uses: no comments, no CDATA. */
function parseHtml(html) {
  const root = new FakeNode('#document');
  let cur = root;
  const re = /<!doctype[^>]*>|<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>/gi;
  let last = 0;
  const text = (to) => {
    const s = html.slice(last, to);
    if (s.trim()) { const t = new FakeNode(null); t.data = unescape(s); cur.appendChild(t); }
  };
  for (let m = re.exec(html); m; m = re.exec(html)) {
    text(m.index);
    last = re.lastIndex;
    if (m[1]) {
      let n = cur;
      while (n !== root && n.tagName !== m[1].toUpperCase()) n = n.parentNode;
      assert.notEqual(n, root, `closing tag without an opening one: ${m[1]}`);
      cur = n.parentNode;
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const node = cur.appendChild(new FakeNode(tag));
      for (const a of m[3].matchAll(/([a-z-]+)(?:="([^"]*)")?/gi)) node.setAttribute(a[1], unescape(a[2] || ''));
      if (RAW.has(tag)) {
        const end = html.toLowerCase().indexOf(`</${tag}>`, last);
        assert.ok(end >= 0, `unclosed ${tag}`);
        const raw = html.slice(last, end);
        const t = new FakeNode(null);
        t.data = tag === 'title' ? unescape(raw) : raw;
        node.appendChild(t);
        last = re.lastIndex = end + tag.length + 3;
      } else if (!VOID.has(tag)) cur = node;
    }
  }
  text(html.length);
  assert.equal(cur, root, 'every element is closed');
  return root;
}

/** What the Artifact publisher does with a fragment: it puts it in the body of its own document. */
const published = (fragment) => `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body>\n${fragment}</body>\n</html>\n`;

/**
 * Loads a rendered board. `env`: { hash, search, protocol, hostname, storage, stored, claude, fetch }.
 * `storage` is 'ok' (default), 'throws' (reading window.localStorage throws), 'missing',
 * 'refuses' (every read and write throws) or 'empty-reads' (reads return null, writes are lost).
 */
function load(html, env = {}) {
  const fragment = !/^<!doctype/i.test(html);
  const root = parseHtml(fragment ? published(html) : html);
  const find = (tag) => root.querySelector(tag);
  const stored = new Map(Object.entries(env.stored || {}));
  const mode = env.storage || 'ok';
  const storage = {
    getItem(k) { if (mode === 'refuses') throw new Error('denied'); return mode === 'empty-reads' ? null : (stored.has(k) ? stored.get(k) : null); },
    setItem(k, v) { if (mode === 'refuses') throw new Error('denied'); if (mode !== 'empty-reads') stored.set(k, String(v)); },
  };
  const document = {
    documentElement: find('html'),
    body: find('body'),
    activeElement: null,
    listeners: {},
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (ns, tag) => new FakeNode(tag),
    createTextNode: (s) => { const t = new FakeNode(null); t.data = String(s); return t; },
    getElementById: (id) => root.querySelectorAll('[id]').find((n) => n.getAttribute('id') === id) || null,
    querySelector: (s) => root.querySelector(s),
    querySelectorAll: (s) => root.querySelectorAll(s),
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
  };
  const window = {
    location: { hash: env.hash || '', search: env.search || '', protocol: env.protocol || 'file:', hostname: env.hostname || '', reload() { window.reloads++; } },
    reloads: 0,
    listeners: {},
    timers: [],
    pageYOffset: 0,
    innerHeight: 800,
    crypto: globalThis.crypto,
    claude: env.claude,
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    matchMedia: () => ({ matches: false }),
    scrollTo() {}, scrollBy() {},
    setTimeout(fn) { window.timers.push(fn); return window.timers.length; },
    clearTimeout() {},
    intervals: [],
    setInterval(fn) { window.intervals.push(fn); return window.intervals.length; },
  };
  Object.defineProperty(window, 'localStorage', {
    get() { if (mode === 'throws') throw new Error('SecurityError'); return mode === 'missing' ? undefined : storage; },
  });
  const requests = [];
  const fetch = (url, opts) => {
    requests.push({ url, opts: opts || {} });
    return env.fetch ? env.fetch(url, opts) : Promise.resolve({ ok: true, json: () => Promise.resolve(String(url).startsWith('/api/state') ? { version: 1, changed: false } : { decisions: [] }) });
  };
  const scripts = root.querySelectorAll('script').filter((s) => s.getAttribute('type') === null);
  assert.equal(scripts.length, 1, 'one inline script');
  new Function('window', 'document', 'navigator', 'fetch', scripts[0].textContent)(window, document, {}, fetch);
  const page = {
    root, document, window, stored, requests, fragment,
    view: document.getElementById('view'),
    /** Text of every element that matches, in document order. */
    texts: (selector) => root.querySelectorAll(selector).map((n) => n.textContent),
    /** The message the page shows when its script failed, or null. */
    fatal: () => { const f = root.querySelector('main .fatal'); return f ? f.textContent : null; },
    /** The entry of the side index marked as the page shown: `overview`, `pending` or `h:<harnessId>`. */
    current: () => root.querySelectorAll('.side [aria-current="page"]').map((n) => n.getAttribute('data-fk').replace(/^ix:/, '')).join(' | '),
    go(hash) { window.location.hash = hash; for (const fn of window.listeners.hashchange || []) fn(); },
    press(fk) {
      const b = root.querySelector(`[data-fk="${fk}"]`);
      assert.ok(b, `a control with data-fk="${fk}"`);
      b.click();
    },
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
  assert.equal(page.fatal(), null, 'the page drew without an error');
  return page;
}

const board = (state, opts = {}) => renderHtml(state, { lang: 'en', offline: true, ...opts });
/** The diagnosis opened on one finding: its card stays on the page whatever its status becomes. */
const CASE = '#/h/u1/diagnosis?item=U1-101';

/** The fixture with revisions and a group, the way `run.mjs build` hands it over. */
function decidable() {
  const st = fixture();
  st.items.find((i) => i.id === 'U1-101').rev = REV_A;
  st.items.find((i) => i.id === 'SHOP-501').rev = REV_B;
  st.items.find((i) => i.id === 'U1-401').rev = '111111111111';
  st.groups = [{ id: 'G-1', title: 'Same finding twice', round: 4, rev: REV_G, items: ['U1-401', 'SHOP-501'] }];
  st.accounts = { primary: null, list: [{ id: 'claude-1', provider: 'claude-code', label: 'Account 1', path: '~/.claude', harness: 'u1' }] };
  return st;
}

// ---------------------------------------------------------------------------------------------
// Shells
// ---------------------------------------------------------------------------------------------

test('the page boots the same in both shells, and the script sets the page language', () => {
  for (const [state, lang, htmlLang] of [[fixture(), 'en', 'en'], [example(), 'pt', 'pt-BR']]) {
    const doc = load(board(state, { lang, channel: 'file' }));
    const frag = load(board(state, { lang, channel: 'artifact' }));
    assert.equal(doc.fragment, false);
    assert.equal(frag.fragment, true);
    // In a document the markup already carries the language; in a fragment only the script can.
    assert.equal(doc.document.documentElement.getAttribute('lang'), htmlLang);
    assert.equal(frag.document.documentElement.getAttribute('lang'), null);
    for (const p of [doc, frag]) assert.equal(p.document.documentElement.lang, htmlLang);
    // Same page either way: the same text, tab for tab.
    assert.ok(doc.view.textContent.length > 500);
    assert.equal(frag.view.textContent, doc.view.textContent);
    assert.equal(frag.texts('.nav .tab').join('|'), doc.texts('.nav .tab').join('|'));
    assert.equal(frag.texts('title').join(), doc.texts('title').join());
  }
});

test('where each part sits: in the head of a document, in the body of a published fragment', () => {
  const doc = load(board(fixture(), { offline: false, channel: 'server' }));
  const frag = load(board(fixture(), { offline: false, channel: 'artifact' }));
  const tags = (p, where) => p.root.querySelector(where).children.map((n) => n.tagName.toLowerCase()).join(' ');
  assert.equal(tags(doc, 'head'), 'meta meta title style link');
  assert.equal(tags(doc, 'body'), 'a nav div script script');
  // The publisher's head stays its own; everything the fragment brings lands in the body.
  assert.equal(tags(frag, 'head'), 'meta meta');
  assert.equal(tags(frag, 'body'), 'title style link a nav div script script');
  for (const p of [doc, frag]) {
    assert.equal(p.root.querySelectorAll('title').length, 1);
    assert.equal(p.root.querySelector('link').getAttribute('rel'), 'stylesheet');
    for (const id of ['skip', 'nav', 'side', 'view', 'foot', 'board-data']) assert.ok(p.document.getElementById(id), id);
  }
});

test('every route of the example draws, in the fragment as in the document', () => {
  const state = example();
  const routes = ['#/overview', '#/pending', '#/decide', '#/decide/G-1', '#/h/ghost', '#/nowhere'];
  for (const h of state.harnesses) {
    routes.push(`#/h/${h.id}`, `#/h/${h.id}/diagnosis`, `#/h/${h.id}/impact`, `#/h/${h.id}/file/missing`, `#/h/${h.id}/view/nothing`);
    for (const name of ['permissions', 'hooks', 'skills', 'agents', 'mcp', 'plugins', 'clis', 'docs']) routes.push(`#/h/${h.id}/view/${name}`);
    for (const f of state.files.filter((x) => x.harness === h.id)) routes.push(`#/h/${h.id}/file/${f.id}`);
    for (const i of state.items.filter((x) => x.harness === h.id)) routes.push(`#/h/${h.id}/diagnosis?item=${i.id}`);
  }
  for (const channel of ['artifact', 'file']) {
    const page = load(board(state, { lang: 'pt', channel }));
    for (const r of routes) {
      page.go(r);
      assert.equal(page.fatal(), null, `${channel} ${r}`);
      assert.ok(page.view.textContent.length > 20, `${channel} ${r} drew something`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// The remembered route
// ---------------------------------------------------------------------------------------------

test('a reload with no hash reopens the remembered route; a hash in the URL wins', async () => {
  const state = decidable();
  const html = board(state, { channel: 'artifact' });
  const key = `novarc-harness-doctor:${state.run.id}:route`;

  const first = load(html);
  assert.equal(first.current(), 'overview');
  assert.equal(first.stored.get(key), '#/overview', 'the route is kept from the first draw on');
  first.go('#/h/fixture-shop/diagnosis');
  assert.equal(first.stored.get(key), '#/h/fixture-shop/diagnosis');
  assert.match(first.current(), /fixture-shop/);

  // The frame reloads: same storage, no hash.
  const again = load(html, { stored: Object.fromEntries(first.stored) });
  assert.match(again.current(), /fixture-shop/);
  assert.ok(again.view.querySelector('#subtabs [data-fk="sub:diagnosis"][aria-current="true"]'), 'on the same sub-tab');
  assert.equal(again.window.location.hash, '', 'the URL is left alone');

  // A link that names a route is obeyed, and becomes the remembered one.
  const linked = load(html, { hash: '#/pending', stored: Object.fromEntries(first.stored) });
  assert.equal(linked.current(), 'pending');
  assert.equal(linked.stored.get(key), '#/pending');
  // A link from a board that still had a Decide tab opens the Pending view.
  assert.equal(load(html, { hash: '#/decide/G-1' }).current(), 'pending');

  // Another run does not see this one's route.
  const other = decidable();
  other.run.id = '20260111-zz99';
  assert.equal(load(board(other, { channel: 'artifact' }), { stored: Object.fromEntries(first.stored) }).current(), 'overview');
});

test('a remembered route that no longer exists in the state is ignored', () => {
  const state = decidable();
  const key = `novarc-harness-doctor:${state.run.id}:route`;
  const open = (stored) => load(board(state), { stored: { [key]: stored } }).current();
  assert.equal(open('#/h/u1/file/fu1-1'), 'h:u1');
  for (const gone of ['#/h/removed-project', '#/h/u1/file/fshop-1', '#/h/u1/file/f-gone', '#/h/u1/view/secrets', 'javascript:alert(1)', '', `#/h/u1/${'x'.repeat(700)}`]) {
    assert.equal(open(gone), 'overview', gone);
  }
  assert.equal(open('#/pending'), 'pending');
  assert.equal(open('#/decide/summary'), 'pending');
});

test('the page draws the same when browser storage is missing, throws or forgets', () => {
  const state = decidable();
  const html = board(state);
  const base = load(html).view.textContent;
  for (const storage of ['throws', 'missing', 'refuses', 'empty-reads']) {
    const page = load(html, { storage });
    assert.equal(page.view.textContent, base, storage);
    page.go(CASE);
    assert.equal(page.fatal(), null, storage);
    page.go('#/h/u1/file/fu1-1?c=U1-101.0');
    assert.equal(page.fatal(), null, storage);
  }
});

// ---------------------------------------------------------------------------------------------
// The board only shows: decisions are taken in the chat
// ---------------------------------------------------------------------------------------------

/** Every label a decision control had, in both languages: none may be on the page any more. */
const CONTROL_WORDS = ['Approve', 'Decline', 'Send question', 'Decide the next', 'Aprovar', 'Recusar', 'Enviar pergunta', 'Decidir as próximas', 'Make primary', 'Tornar principal', 'leave out', 'deixar de fora'];

test('no channel can decide: no decision control, no database, no POST, no command to paste', async () => {
  const state = decidable();
  for (const lang of ['en', 'pt']) {
    for (const channel of ['artifact', 'server', 'file']) {
      const html = board(state, { lang, channel });
      const script = html.slice(html.lastIndexOf('<script>'));
      for (const needle of ['claude.use', 'collection(', "method: 'POST'", 'method:"POST"', '/api/decisions', 'run.mjs decide', 'localStorage.setItem(storageKey']) {
        assert.ok(!script.includes(needle), `${lang} ${channel}: ${needle}`);
      }
      // Whatever the database would give, the page never asks for it.
      let asked = 0;
      const claude = { use: () => { asked++; return Promise.resolve(null); } };
      const page = load(html, { claude, hash: CASE });
      await page.settle();
      assert.equal(asked, 0, 'the db capability is never requested');
      const routes = ['#/overview', '#/pending', CASE, '#/h/u1/file/fu1-1', '#/h/fixture-shop/diagnosis'];
      for (const r of routes) {
        page.go(r);
        assert.equal(page.root.querySelectorAll('textarea').length, 0, `${r}: no note or question box`);
        assert.equal(page.root.querySelectorAll('[data-act]').length, 0, `${r}: no decision button`);
        assert.equal(page.root.querySelectorAll('input').length, 0, `${r}: no checkbox`);
        const buttons = page.root.querySelectorAll('button').map((b) => b.textContent);
        for (const word of CONTROL_WORDS) assert.ok(!buttons.some((b) => b.includes(word)), `${lang} ${channel} ${r}: ${word}`);
      }
      assert.equal(page.document.getElementById('tray'), null, 'no decision tray');
    }
  }
});

test('the local page still reloads when the run is rebuilt; elsewhere the page asks for nothing', async () => {
  const state = decidable();
  let version = 1;
  const fetchState = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve({ version, changed: false }) });
  const page = load(board(state, { channel: 'server' }), { protocol: 'http:', hostname: '127.0.0.1', search: '?t=tok', fetch: fetchState });
  await page.settle();
  assert.deepEqual(page.requests.map((r) => [r.url, r.opts.method || 'GET']), [['/api/state?t=tok&v=', 'GET']]);
  assert.equal(page.window.reloads, 0);
  // The interval is not run by the stand-in: the next poll is called by hand, after a rebuild.
  version = 2;
  const tick = page.window.intervals[0];
  tick();
  await page.settle();
  assert.equal(page.requests[1].url, '/api/state?t=tok&v=1');
  assert.equal(page.window.reloads, 1, 'a rebuilt board reloads the page');
  // Opened from disk or published, nothing is fetched at all.
  for (const env of [{}, { claude: { use: () => Promise.resolve(null) } }]) {
    const quiet = load(board(state, { channel: 'artifact' }), env);
    await quiet.settle();
    assert.deepEqual(quiet.requests, []);
  }
});

test('Pending: exactly the open findings, by harness, each with its id to copy, and the decided ones folded', async () => {
  const state = decidable();
  for (const lang of ['en', 'pt']) {
    const page = load(board(state, { lang }), { hash: '#/pending' });
    const T = STRINGS[lang];
    assert.equal(page.view.querySelector('.chat-line').textContent, T.pend.line);
    // Groups first, then each harness with its open items, most serious first.
    const listed = page.view.querySelectorAll('[data-item]').map((n) => n.getAttribute('data-item'));
    assert.deepEqual(listed, ['G-1', 'U1-101', 'U1-401', 'SHOP-501']);
    const open = state.items.filter((i) => i.status === 'open').map((i) => i.id).sort();
    assert.deepEqual(page.view.querySelectorAll('.prow').map((r) => r.getAttribute('data-item')).sort(), open);
    // Each row: the id as a button that copies it, the severity in words, the title as a link to the case.
    const row = page.view.querySelector('[data-item="U1-101"]');
    const copy = row.querySelector('button.copy');
    assert.equal(copy.textContent, 'U1-101');
    assert.equal(row.querySelector('.sevw').textContent, T.severity.critical);
    assert.equal(row.querySelector('.pt a').getAttribute('href'), '#/h/u1/diagnosis?item=U1-101');
    // The harnesses carry their kind marker.
    assert.deepEqual(page.view.querySelectorAll('.psec .ph .kind').map((k) => k.getAttribute('class')), ['kind user', 'kind project']);
    // What was decided is listed, closed until asked for.
    const decided = page.view.querySelector('#p-decided details');
    assert.equal(decided.open, false);
    assert.deepEqual(decided.querySelectorAll('tbody tr').map((tr) => tr.children[0].textContent).sort(),
      state.items.filter((i) => ['approved', 'in-progress', 'fixed', 'failed', 'declined', 'deferred'].includes(i.status)).map((i) => i.id).sort());
  }
  // Clicking the id copies the id and nothing else (the stand-in has no clipboard: the page falls back to a text field).
  const copied = [];
  const page = load(board(state), { hash: '#/pending' });
  page.document.execCommand = () => { copied.push(page.document.body.children.find((n) => n.tagName === 'TEXTAREA').value); return true; };
  const btn = page.view.querySelector('[data-item="U1-401"] button.copy');
  assert.equal(btn.getAttribute('title'), 'Copy U1-401');
  btn.click();
  assert.deepEqual(copied, ['U1-401']);
  assert.equal(btn.textContent, 'Copied');
  // Nothing open: the view says so.
  const none = decidable();
  for (const i of none.items) if (i.status === 'open') i.status = 'approved';
  const empty = load(board(none), { hash: '#/pending' });
  assert.equal(empty.view.querySelector('.empty').textContent, STRINGS.en.pend.none);
  assert.equal(empty.view.querySelectorAll('.prow').length, 0);
});

// ---------------------------------------------------------------------------------------------
// Unknown is drawn as unknown// ---------------------------------------------------------------------------------------------
// Unknown is drawn as unknown
// ---------------------------------------------------------------------------------------------

/** The rows of the view's table as arrays of cell texts. */
const rowsOf = (page) => page.root.querySelectorAll('.pane tbody tr').map((tr) => tr.children.map((td) => td.textContent));

function withUnknowns(lang) {
  const st = fixture();
  if (lang) st.language = lang;
  const u1 = st.harnesses[0];
  u1.elements = {
    hooks: [
      { id: 'h-yes', source: 'agent', event: 'PreToolUse', blocking: true },
      { id: 'h-no', source: 'agent', event: 'Stop', blocking: false },
      { id: 'h-null', source: 'plugin', event: 'SessionStart', blocking: null, note: 'Runs a program that could not be read.' },
      { id: 'h-absent', source: 'ci', event: 'push' },
    ],
    mcp: [
      { name: 'used', level: 'user', calls: 12 },
      { name: 'idle', level: 'user', calls: 0 },
      { name: 'null-count', level: 'user', calls: null, note: 'Tool calls are not recorded in the sessions of this agent.' },
      { name: 'no-count', level: 'user' },
    ],
    skills: [
      { name: 'used-skill', level: 'user', invocations: 3 },
      { name: 'idle-skill', level: 'user', invocations: 0 },
      { name: 'null-skill', level: 'user', invocations: null },
      { name: 'no-skill', level: 'user' },
    ],
    plugins: [{ name: 'known', enabled: true, pinned: false }, { name: 'half', enabled: false, pinned: null }, { name: 'bare' }],
    clis: [{ name: 'gh', installed: true }, { name: 'rtk', installed: false }, { name: 'odd', installed: null }],
  };
  u1.impact = {
    windowDays: 30, sessions: 10, totalTokens: 1000,
    waste: [
      { kind: 'retry', episodes: 4, tokens: 300 },
      { kind: 'loop', episodes: 0, tokens: 0 },
      { kind: 'hook-block', episodes: null, tokens: null },
      { kind: 'notfound', tokens: 0 },
    ],
    // Names whose use could not be read are listed apart (session-impact.mjs: skillsUnknown,
    // mcpServersUnknown); a list that is null was not measured at all.
    unusedContext: { skillsNeverInvoked: ['idle-skill'], skillsUnknown: ['null-skill', 'no-skill'], mcpServersNeverCalled: null },
  };
  st.layers = [
    { harness: 'u1', name: 'CLAUDE.md', kind: 'instructions', tokens: 400, basis: 'measured' },
    { harness: 'u1', name: 'MCP servers (4)', kind: 'mcp', note: 'Their size is not measured here.' },
  ];
  applyScores(st);
  return st;
}

test('a hook that could not be told is "could not tell", never "does not block"', () => {
  const blocks = (page) => page.root.querySelectorAll('.pane li.hk').map((li) => [li.closest('.slot').getAttribute('data-event'), li.querySelector('.hk-h .tag').textContent]);
  const en = load(board(withUnknowns()), { hash: '#/h/u1/view/hooks' });
  assert.deepEqual(blocks(en), [
    ['SessionStart', 'could not tell'], ['PreToolUse', 'blocks'], ['Stop', 'does not block'], ['push', 'could not tell'],
  ]);
  const pt = load(board(withUnknowns('pt'), { lang: 'pt' }), { hash: '#/h/u1/view/hooks' });
  assert.deepEqual(blocks(pt).map((r) => r[1]), ['não deu para saber', 'bloqueia', 'não bloqueia', 'não deu para saber']);
});

test('a call count that was not measured says so, and a real zero stays a zero', () => {
  const en = load(board(withUnknowns()), { hash: '#/h/u1/view/mcp' });
  // Least used first, the unmeasured ones last.
  assert.deepEqual(rowsOf(en).map((r) => [r[0], r[3]]), [
    ['idle', '0 calls in 30 days'], ['used', '12'],
    ['null-countTool calls are not recorded in the sessions of this agent.', 'not measured'], ['no-count', 'not measured'],
  ]);
  en.go('#/h/u1/view/skills');
  assert.deepEqual(rowsOf(en).map((r) => [r[0], r[3]]), [
    ['idle-skill', '0 uses in 30 days'], ['used-skill', '3'], ['null-skill', 'not measured'], ['no-skill', 'not measured'],
  ]);
  const pt = load(board(withUnknowns('pt'), { lang: 'pt' }), { hash: '#/h/u1/view/mcp' });
  assert.deepEqual(rowsOf(pt).map((r) => r[3]), ['0 chamadas em 30 dias', '12', 'sem medição', 'sem medição']);
});

test('yes, no and unknown in the plugin and CLI views', () => {
  const page = load(board(withUnknowns()), { hash: '#/h/u1/view/plugins' });
  assert.deepEqual(rowsOf(page).map((r) => [r[0], r[2], r[3]]), [['known', 'yes', 'no'], ['half', 'no', 'unknown'], ['bare', 'unknown', 'unknown']]);
  page.go('#/h/u1/view/clis');
  assert.deepEqual(rowsOf(page).map((r) => [r[0], r[1]]), [['gh', 'yes'], ['rtk', 'no'], ['odd', 'unknown']]);
});

test('impact: a kind that was not measured is not "no occurrences", and a null list is not "none unused"', () => {
  const page = load(board(withUnknowns()), { hash: '#/h/u1/impact' });
  assert.deepEqual(page.texts('.quiet'), ['no occurrences: identical calls repeated in a row', 'not measured: calls blocked by a hook, commands that do not exist here']);
  assert.deepEqual(page.texts('.ilist .iname'), ['Retries of a command that keeps failing']);
  const unused = (p) => p.root.querySelector('.unused').children.map((box) => box.children.map((n) => n.textContent));
  assert.deepEqual(unused(page), [['1 skill never invoked in the window', 'idle-skill'], ['Skills', 'not measured', 'null-skillno-skill'], ['MCP servers', 'not measured']]);
  // A layer without a figure says so; the total adds only the ones that have one.
  assert.deepEqual(page.texts('.lrow .tk'), ['400 measured', 'not measured']);
  assert.deepEqual(page.texts('.pathline').filter((t) => t.includes('per session')), ['about 400 tokens per session']);

  const pt = load(board(withUnknowns('pt'), { lang: 'pt' }), { hash: '#/h/u1/impact' });
  assert.equal(pt.texts('.quiet')[1], 'sem medição: chamadas bloqueadas por um hook, comandos que não existem aqui');
  assert.deepEqual(unused(pt).slice(1), [['Skills', 'sem medição', 'null-skillno-skill'], ['Servidores MCP', 'sem medição']]);
});

// ---------------------------------------------------------------------------------------------
// What an earlier review expected, and what happened since (references/follow-up.md)
// ---------------------------------------------------------------------------------------------

const PREV = { runId: '20251201-aa11', reviewedAt: '2025-12-01T12:00:00Z' };
const RECENT = { runId: '20260107-bb22', reviewedAt: '2026-01-07T12:00:00Z' };
/** A date the way the page writes it, so the tests do not depend on the machine's locale data or time zone. */
const day = (iso, lang = 'en') => new Date(iso).toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US', { dateStyle: 'medium' });

/**
 * The fixture as a second review: u1 was reviewed 40 days ago and has enough sessions to compare;
 * the shop was reviewed 3 days ago, too soon to tell. `mutate(u1FollowUp, shopFollowUp, state)`.
 */
function reviewedBefore(lang, mutate) {
  const st = fixture();
  if (lang) st.language = lang;
  st.run.followUpOf = { ...PREV };
  const u1 = st.harnesses.find((h) => h.id === 'u1');
  u1.key = 'claude-code-account-1-0a1b2c3d';
  u1.impact = { windowDays: 30, sessions: 120, totalTokens: 162000000, waste: [{ kind: 'retry', episodes: 4, tokens: 1631040 }] };
  u1.history = [
    { ...PREV, score: 70.5, grade: 'C', fixed: 5, tokensPerSession: 1400000 },
    { runId: '20251101-zz00', reviewedAt: '2025-11-01T12:00:00Z', score: 58.2, grade: 'D', fixed: 2, tokensPerSession: 1500000 },
  ];
  u1.followUp = {
    of: { ...PREV },
    days: 40,
    sample: { sessions: 120, enough: true },
    score: { then: 70.5, expected: 80, now: 75.1 },
    metrics: [
      { metric: 'context-at-start', unit: 'tokens/session', before: 46000, expected: 38000, after: 38200, changePct: -17, verdict: 'confirmed', items: ['U1-204', 'U1-206'] },
      { metric: 'waste:notfound', unit: 'tokens/session', before: 4400, expected: 1400, after: 2670, changePct: -39.3, verdict: 'partial', items: ['U1-703'] },
      { metric: 'tokens-per-session', before: 1400000, expected: null, after: 1350000, changePct: -3.6, verdict: 'no-change' },
      { metric: 'waste:retry', before: 9800, expected: null, after: 13592, changePct: 38.7, verdict: 'worse' },
      { metric: 'waste-share', unit: 'percent', before: 2.6, expected: null, after: 2, changePct: -23.1, verdict: 'improved' },
      { metric: 'tool-output', unit: 'chars/session', before: 96000, expected: null, after: null, changePct: null, verdict: 'not-measured' },
    ],
    items: [
      { id: 'U1-204', title: 'Style guide repeated in CLAUDE.md', round: 2, status: 'fixed', check: 'in-place', paths: ['~/.claude/CLAUDE.md'], saves: 960000 },
      { id: 'U1-206', title: 'Release checklist loaded in every session', round: 2, status: 'fixed', check: 'reverted', paths: ['~/.claude/CLAUDE.md', '~/.claude/docs/release.md'], saves: 15600, now: 'U1-202' },
      { id: 'U1-703', title: 'Alias pointed at a removed program', round: 7, status: 'fixed', check: 'changed', paths: ['~/.claude/settings.json'], saves: null },
      { id: 'U1-801', title: 'Old helper script', round: 8, status: 'fixed', check: 'missing', paths: ['~/.claude/scripts/helper.sh'] },
      { id: 'U1-802', title: 'Plugin updated from the command line', round: 8, status: 'fixed', check: 'not-checked' },
      { id: 'U1-101', title: 'Token inline in helper script', round: 1, status: 'declined', now: 'U1-101' },
      { id: 'U1-777', title: 'Left for later, and not found again', round: 6, status: 'deferred' },
    ],
    summary: { expectedTokensPerSession: 11000, observedTokensPerSession: -50000, inPlace: 1, reverted: 1, cameBack: 1 },
  };
  const again = st.items.find((i) => i.id === 'U1-101');
  again.previous = { run: PREV.runId, item: 'U1-101' };
  again.history = { firstSeenAt: '2025-11-01T12:00:00Z', times: 2, lastStatus: 'declined', lastDecisionAt: '2025-12-01T12:30:00Z', lastNote: 'The script is going away.' };
  again.saves = { tokens: 1200, basis: 'estimated', metric: 'context-at-start' };
  // A link the reviewer set, with nothing from the records yet: it is not shown.
  st.items.find((i) => i.id === 'U1-401').previous = { run: PREV.runId, item: 'U1-401' };

  const shop = st.harnesses.find((h) => h.id === 'fixture-shop');
  shop.history = [{ ...RECENT, score: 95, grade: 'A', fixed: 1, tokensPerSession: null }];
  shop.followUp = {
    of: { ...RECENT },
    days: 3,
    sample: { sessions: 4, enough: false, reason: 'too-few-days', readyAt: '2026-01-14T12:00:00Z' },
    score: { then: 95, expected: 97, now: 90.7 },
    // The builder may already carry a verdict: while the sample is too small it does not count.
    metrics: [{ metric: 'context-at-start', before: 50000, expected: 45000, after: 44000, changePct: -12, verdict: 'confirmed' }],
    items: [{ id: 'SHOP-402', title: 'Lint gate', round: 4, status: 'fixed', check: 'in-place', paths: ['./.githooks/pre-commit'] }],
    summary: { expectedTokensPerSession: 5000, observedTokensPerSession: -6000, inPlace: 1, reverted: 0, cameBack: 0 },
  };
  if (mutate) mutate(u1.followUp, shop.followUp, st);
  applyScores(st);
  return st;
}

const pageOf = (lang, hash, mutate) => load(board(reviewedBefore(lang, mutate), { lang: lang || 'en' }), { hash });
/** The rows of a table as arrays of cells; a cell is the list of its parts (its elements, or its text). */
const cellsOf = (table) => table.querySelectorAll('tbody tr').map((tr) => tr.children.map((td) => (td.children.length ? td.children.map((c) => c.textContent) : [td.textContent])));
const tagsOf = (node) => node.querySelectorAll('.tag').map((t) => [t.textContent, t.getAttribute('class')]);

test('overview: a harness reviewed before shows the score then and now, and what came of it', () => {
  const en = pageOf('en', '#/overview');
  const rows = en.root.querySelectorAll('.hrow');
  const [u1, shop] = rows.map((r) => r.querySelector('.hfu'));
  assert.equal(rows.length, 2);

  // u1: the score went up since that review, and one of the two expected effects came true.
  assert.equal(u1.querySelector('.lbl').textContent, `Since the review of ${day(PREV.reviewedAt)}`);
  assert.deepEqual(u1.querySelectorAll('.score .g').map((g) => [g.children.map((c) => c.textContent), g.getAttribute('class')]), [[['then ', '70.5'], 'g'], [['now ', '75.1'], 'g after']]);
  assert.deepEqual(u1.querySelectorAll('.score .g').map((g) => g.textContent), ['then C70.5', 'now B75.1']);
  assert.equal(u1.querySelector('.sbar').getAttribute('aria-label'), 'Score 70.5 at that review, 75.1 now');
  assert.deepEqual(u1.querySelectorAll('.sbar i').map((i) => [i.getAttribute('class'), i.style.width, i.style.left]), [['b', '70.5%', undefined], ['a', `${75.1 - 70.5}%`, '70.5%']]);
  assert.deepEqual([u1.querySelector('.hfu-t').textContent, u1.querySelector('.hfu-t').getAttribute('class')], ['1 of 2 expected effects confirmed', 'hfu-t']);
  assert.equal(rows[0].getAttribute('aria-label'), `Open Claude Code account 1. Since the review of ${day(PREV.reviewedAt)}: 1 of 2 expected effects confirmed`);
  // The row keeps what it had: the score of this run, the measurement and what is left to decide.
  assert.equal(rows[0].querySelectorAll('.score').length, 2);
  assert.ok(rows[0].querySelector('.metric') && rows[0].querySelector('.pend'));

  // The shop: reviewed too recently, so the line says when; its score fell, which the bar shows in red.
  assert.deepEqual([shop.querySelector('.hfu-t').textContent, shop.querySelector('.hfu-t').getAttribute('class')], [`ready to compare on ${day('2026-01-14T12:00:00Z')}`, 'hfu-t wait']);
  assert.deepEqual(shop.querySelectorAll('.score .g').map((g) => [g.textContent, g.getAttribute('class')]), [['then A95', 'g'], ['now A90.7', 'g down']]);
  assert.deepEqual(shop.querySelectorAll('.sbar i').map((i) => i.getAttribute('class')), ['b', 'd']);
  assert.ok(en.texts('.byline span').includes(`Follow-up of the review of ${day(PREV.reviewedAt)}`));

  const pt = pageOf('pt', '#/overview');
  assert.deepEqual(pt.texts('.hfu .lbl'), [`Desde a revisão de ${day(PREV.reviewedAt, 'pt')}`, `Desde a revisão de ${day(RECENT.reviewedAt, 'pt')}`]);
  assert.deepEqual(pt.texts('.hfu-t'), ['1 de 2 efeitos esperados confirmados', `pronto para comparar em ${day('2026-01-14T12:00:00Z', 'pt')}`]);
  assert.equal(pt.root.querySelector('.hfu .sbar').getAttribute('aria-label'), 'Nota 70,5 naquela revisão, 75,1 agora');
  assert.ok(pt.texts('.byline span').includes(`Acompanha a revisão de ${day(PREV.reviewedAt, 'pt')}`));

  // The line in its other states, and a follow-up with no score to draw.
  const line = (mutate) => pageOf('en', '#/overview', mutate).texts('.hfu-t');
  assert.deepEqual(line((u, s) => { delete s.sample.readyAt; s.sample.reason = 'too-few-sessions'; for (const m of u.metrics) m.expected = null; }),
    ['no expected effect to check', 'too few sessions since the review to compare']);
  assert.deepEqual(line((u, s) => { s.sample = { enough: false }; u.metrics = u.metrics.slice(0, 1); }), ['1 of 1 expected effect confirmed', 'not enough data yet']);
  const noScore = pageOf('en', '#/overview', (u, s) => { delete u.score; s.score = { then: null, expected: null, now: 90.7 }; });
  assert.equal(noScore.root.querySelectorAll('.hfu .score').length, 0);
  assert.equal(noScore.texts('.hfu-t').length, 2);

  // History without a follow-up changes nothing on the overview.
  const historyOnly = pageOf('en', '#/overview', (u, s, st) => { for (const h of st.harnesses) delete h.followUp; delete st.run.followUpOf; });
  assert.equal(historyOnly.root.querySelectorAll('.hfu').length, 0);
  assert.equal(historyOnly.root.querySelector('.hrow').getAttribute('aria-label'), 'Open Claude Code account 1');
});

test('impact tab: "Since the last review" comes first, with the metric table, the checks and the note', () => {
  const page = pageOf('en', '#/h/u1/impact');
  const sections = page.view.querySelectorAll('section');
  const since = sections[0];
  assert.deepEqual(sections.map((s) => [s.getAttribute('id'), s.getAttribute('class')]).slice(0, 2), [['since', 'sec first fu'], ['imp-main', 'sec']], 'first in the tab; the measurement of this run follows');
  assert.deepEqual([since.querySelector('.sec-k').textContent, since.querySelector('h2').textContent], ['Follow-up', 'Since the last review']);
  assert.equal(since.querySelector('.sub').textContent, `The review of ${day(PREV.reviewedAt)}, 40 days ago, against what was measured since. 120 sessions since then.`);
  assert.equal(since.querySelector('.fu-lead').textContent, '1 of 2 expected effects confirmed.');
  assert.equal(since.querySelector('.callout'), null);
  const strips = since.querySelectorAll('.fu-nums').map((s) => s.children.map((c) => c.children.map((x) => x.textContent)));
  assert.deepEqual(strips, [
    [['C 70.5', 'score at that review'], ['B 80', 'score that review expected'], ['B 75.1', 'score as found today']],
    [['11k', 'expected saving, in tokens per session'], ['-50k', 'measured change, in tokens per session']],
  ]);
  assert.deepEqual(since.querySelectorAll('h3').map((h) => h.textContent), ['What was expected and what was measured', 'What that review fixed, checked on disk']);

  // The metric table: before, expected (a dash when nothing was expected), now, change, verdict.
  const [metrics, fixed, carried] = since.querySelectorAll('table');
  assert.deepEqual(metrics.querySelectorAll('th').map((th) => th.textContent), ['Measure', 'Before', 'Expected', 'Now', 'Change', 'Verdict']);
  assert.deepEqual(cellsOf(metrics), [
    [['Context at the start of a session', 'tokens per session', 'expected from U1-204, U1-206'], ['46k'], ['38k'], ['38.2k'], ['-17%'], ['confirmed']],
    [['Commands that do not exist here', 'tokens per session', 'expected from U1-703'], ['4.4k'], ['1.4k'], ['2.6k'], ['-39.3%'], ['partly confirmed']],
    [['All tokens spent', 'tokens per session'], ['1.4M'], ['-'], ['1.3M'], ['-3.6%'], ['no change']],
    [['Retries of a command that keeps failing', 'tokens per session'], ['9.8k'], ['-'], ['13.5k'], ['+38.7%'], ['worse']],
    [['Share of the spend wasted', 'percent of the spend'], ['2.6%'], ['-'], ['2%'], ['-23.1%'], ['improved']],
    [['Shell output read by the agent', 'characters per session'], ['96k'], ['-'], ['not measured'], ['-'], ['not measured']],
  ]);
  // Lower is better in every row: a fall is drawn as good, a rise as bad, and no change stays neutral.
  assert.deepEqual(metrics.querySelectorAll('.fu-chg').map((c) => c.getAttribute('class')), ['fu-chg good', 'fu-chg good', 'fu-chg', 'fu-chg bad', 'fu-chg good', 'fu-chg']);
  assert.deepEqual(tagsOf(metrics), [['confirmed', 'tag ok'], ['partly confirmed', 'tag ok soft'], ['no change', 'tag'], ['worse', 'tag bad'], ['improved', 'tag ok'], ['not measured', 'tag dashed']]);

  // What that review fixed, each with its check on disk and the item of this run when it came back.
  assert.deepEqual(tagsOf(since.querySelector('.legend-line')), [['1 fix still in place', 'tag ok'], ['1 fix reverted', 'tag bad'], ['1 fix back as a finding', 'tag warn']]);
  assert.deepEqual(fixed.querySelectorAll('th').map((th) => th.textContent), ['Item', 'Title', 'Expected saving', 'On disk', 'In this review']);
  assert.deepEqual(cellsOf(fixed), [
    [['U1-204'], ['~/.claude/CLAUDE.md'], ['960k tokens'], ['still in place'], ['']],
    [['U1-206'], ['~/.claude/CLAUDE.md, ~/.claude/docs/release.md'], ['15.6k tokens'], ['reverted'], ['U1-202']],
    [['U1-703'], ['~/.claude/settings.json'], ['-'], ['rewritten since'], ['']],
    [['U1-801'], ['~/.claude/scripts/helper.sh'], ['-'], ['file is gone'], ['']],
    [['U1-802'], ['Plugin updated from the command line'], ['-'], ['not checked'], ['']],
  ]);
  assert.deepEqual(fixed.querySelectorAll('tbody tr').map((tr) => tr.children[1].textContent.replace(tr.children[1].children.map((c) => c.textContent).join(''), '')),
    ['Style guide repeated in CLAUDE.md', 'Release checklist loaded in every session', 'Alias pointed at a removed program', 'Old helper script', 'Plugin updated from the command line']);
  assert.deepEqual(tagsOf(fixed), [['still in place', 'tag ok'], ['reverted', 'tag bad'], ['rewritten since', 'tag warn'], ['file is gone', 'tag bad'], ['not checked', 'tag dashed']]);
  // An id of that review is never a link; the item of this run is.
  assert.deepEqual(fixed.querySelectorAll('.oid').map((o) => [o.tagName, o.textContent]).slice(0, 2), [['SPAN', 'U1-204'], ['SPAN', 'U1-206']]);
  assert.deepEqual(fixed.querySelectorAll('a').map((a) => [a.textContent, a.getAttribute('href')]), [['U1-202', '#/h/u1/diagnosis?item=U1-202']]);

  // What it left undone is there, closed until asked for.
  const box = since.querySelector('details.foldbox');
  assert.deepEqual([box.getAttribute('class'), box.open, box.querySelector('summary').textContent], ['foldbox', false, '2 items that review left undone']);
  assert.deepEqual(carried.querySelectorAll('th').map((th) => th.textContent), ['Item', 'Title', 'Left as', 'In this review']);
  assert.deepEqual(cellsOf(carried), [[['U1-101'], ['Token inline in helper script'], ['declined'], ['U1-101']], [['U1-777'], ['Left for later, and not found again'], ['later'], ['']]]);
  assert.deepEqual(carried.querySelectorAll('a').map((a) => a.getAttribute('href')), ['#/h/u1/diagnosis?item=U1-101']);
  assert.equal(carried.querySelector('.oid').tagName, 'SPAN', 'the same id in this run does not make the old one a link');

  // The standing note: two periods, not two versions of the same work.
  const note = since.querySelector('.note-line').textContent;
  assert.equal(note, STRINGS.en.fu.note);
  for (const part of ['Two periods are compared', 'not proof that the change caused it', 'a lead to check, not a reason to undo the fix']) assert.ok(note.includes(part), part);
  // The measurement of this run is still there, after it.
  assert.equal(sections[1].querySelector('.sec-k').textContent, 'Impact');
  assert.ok(page.view.textContent.indexOf('Since the last review') < page.view.textContent.indexOf('What enters every session'));

  // In Portuguese.
  const pt = pageOf('pt', '#/h/u1/impact');
  const ptSince = pt.view.querySelector('#since');
  assert.deepEqual([ptSince.querySelector('.sec-k').textContent, ptSince.querySelector('h2').textContent], ['Acompanhamento', 'Desde a última revisão']);
  assert.equal(ptSince.querySelector('.sub').textContent, `A revisão de ${day(PREV.reviewedAt, 'pt')}, há 40 dias, contra o que foi medido desde então. 120 sessões desde então.`);
  assert.equal(ptSince.querySelector('.fu-lead').textContent, '1 de 2 efeitos esperados confirmados.');
  const [ptMetrics, ptFixed, ptCarried] = ptSince.querySelectorAll('table');
  assert.deepEqual(ptMetrics.querySelectorAll('th').map((th) => th.textContent), ['Medida', 'Antes', 'Esperado', 'Agora', 'Mudança', 'Resultado']);
  assert.deepEqual(cellsOf(ptMetrics).map((r) => [r[0][0], r[0][1], r[1][0], r[2][0], r[3][0], r[4][0], r[5][0]]), [
    ['Contexto no início da sessão', 'tokens por sessão', '46 mil', '38 mil', '38,2 mil', '-17%', 'confirmado'],
    ['Comandos que não existem aqui', 'tokens por sessão', '4,4 mil', '1,4 mil', '2,6 mil', '-39,3%', 'confirmado em parte'],
    ['Todos os tokens gastos', 'tokens por sessão', '1,4 mi', '-', '1,3 mi', '-3,6%', 'sem mudança'],
    ['Repetições de um comando que continua falhando', 'tokens por sessão', '9,8 mil', '-', '13,5 mil', '+38,7%', 'piorou'],
    ['Parcela do gasto que foi à toa', 'por cento do gasto', '2,6%', '-', '2%', '-23,1%', 'melhorou'],
    ['Saída de terminal lida pelo agente', 'caracteres por sessão', '96 mil', '-', 'sem medição', '-', 'sem medição'],
  ]);
  assert.deepEqual(tagsOf(ptFixed).map((t) => t[0]), ['continua no lugar', 'desfeito', 'reescrito depois', 'o arquivo sumiu', 'não conferido']);
  assert.deepEqual(tagsOf(ptSince.querySelector('.legend-line')).map((t) => t[0]), ['1 correção que continua no lugar', '1 correção desfeita', '1 correção que voltou como achado']);
  assert.equal(ptSince.querySelector('details.foldbox summary').textContent, '2 itens que aquela revisão deixou por fazer');
  assert.deepEqual(tagsOf(ptCarried).map((t) => t[0]), ['recusado', 'adiado']);
  assert.equal(ptSince.querySelector('.note-line').textContent, STRINGS.pt.fu.note);
  for (const text of [since.textContent, ptSince.textContent]) assert.ok(!/[–—]|\p{Extended_Pictographic}/u.test(text), 'no dash or emoji');
});

test('impact tab: with too little data the section says so, and no verdict is shown', () => {
  const page = pageOf('en', '#/h/fixture-shop/impact');
  const since = page.view.querySelector('#since');
  assert.equal(page.view.querySelectorAll('section')[0], since, 'still first in the tab, before "no measurement for this harness"');
  assert.equal(since.querySelector('.sub').textContent, `The review of ${day(RECENT.reviewedAt)}, 3 days ago, against what was measured since. 4 sessions since then.`);
  assert.deepEqual(since.querySelector('.callout').children.map((c) => c.textContent), ['Not enough data yet',
    `Too few days since the review to compare. The comparison will be ready on ${day('2026-01-14T12:00:00Z')}. Until then the numbers below say nothing about the changes.`]);
  assert.equal(since.querySelector('.fu-lead'), null, 'no "N of M confirmed" while there is nothing to confirm');
  // The numbers measured so far are shown; the verdict the state carries is not, and nothing is coloured.
  const [metrics, fixed] = since.querySelectorAll('table');
  assert.deepEqual(cellsOf(metrics), [[['Context at the start of a session', 'tokens per session'], ['50k'], ['45k'], ['44k'], ['-12%'], ['not enough data yet']]]);
  assert.deepEqual(tagsOf(metrics), [['not enough data yet', 'tag dashed']]);
  assert.deepEqual(metrics.querySelectorAll('.fu-chg').map((c) => c.getAttribute('class')), ['fu-chg']);
  assert.ok(!metrics.textContent.includes('confirmed'));
  // The check on disk does not depend on the sample: it is shown either way.
  assert.deepEqual(cellsOf(fixed), [[['SHOP-402'], ['./.githooks/pre-commit'], ['-'], ['still in place'], ['']]]);
  assert.equal(since.querySelector('details.foldbox'), null, 'nothing was left undone, so nothing to unfold');
  assert.equal(since.querySelector('.note-line').textContent, STRINGS.en.fu.note);
  // This harness has no measurement of its own: that section follows, as before.
  assert.equal(page.view.querySelectorAll('section')[1].querySelector('h2').textContent, 'No measurement for this harness');

  const pt = pageOf('pt', '#/h/fixture-shop/impact').view.querySelector('#since');
  assert.deepEqual(pt.querySelector('.callout').children.map((c) => c.textContent), ['Ainda sem dados suficientes',
    `Poucos dias desde a revisão para comparar. A comparação fica pronta em ${day('2026-01-14T12:00:00Z', 'pt')}. Até lá, os números abaixo não dizem nada sobre as mudanças.`]);
  assert.deepEqual(tagsOf(pt.querySelector('table')), [['ainda sem dados suficientes', 'tag dashed']]);

  // Without a date the reason stands alone; without a table there is only the state.
  const callout = (mutate) => pageOf('en', '#/h/fixture-shop/impact', mutate).view.querySelector('#since .callout').children[1].textContent;
  assert.equal(callout((u, s) => { s.sample = { enough: false, reason: 'too-few-sessions' }; }), 'Too few sessions since the review to compare. Until there is enough data, the numbers below say nothing about the changes.');
  assert.equal(callout((u, s) => { s.sample = { enough: false }; }), 'Until there is enough data, the numbers below say nothing about the changes.');
  const empty = pageOf('en', '#/h/fixture-shop/impact', (u, s) => { s.metrics = []; s.items = []; delete s.summary; delete s.score; }).view.querySelector('#since');
  assert.deepEqual(empty.querySelectorAll('h3').map((h) => h.textContent), ['What that review fixed, checked on disk']);
  assert.deepEqual([empty.querySelectorAll('table').length, empty.querySelectorAll('.fu-nums').length, empty.querySelector('.empty').textContent], [0, 0, 'That review fixed nothing.']);
});

test('impact tab: what the state leaves out of a follow-up is not invented', () => {
  const since = (mutate) => pageOf('en', '#/h/u1/impact', mutate).view.querySelector('#since');
  // A fix without a check reads "not checked"; an item of this run that does not exist is plain text.
  const odd = since((u) => { delete u.items[0].check; u.items[1].now = 'GONE-9'; });
  assert.deepEqual(tagsOf(odd.querySelectorAll('table')[1]).slice(0, 1), [['not checked', 'tag dashed']]);
  assert.equal(odd.querySelectorAll('table')[1].querySelectorAll('a').length, 0);
  assert.ok(odd.querySelectorAll('table')[1].textContent.includes('GONE-9'));
  // No metrics although the sample is enough: the section says there is nothing to compare.
  const none = since((u) => { u.metrics = []; delete u.summary; });
  assert.equal(none.querySelector('.fu-lead').textContent, 'No expected effect to check.');
  assert.deepEqual([none.querySelector('.empty').textContent, none.querySelectorAll('.fu-nums').length, none.querySelector('.legend-line')], ['No measurement to compare.', 1, null]);
  // A metric without a changePct gets it from before and after; a unit the state leaves out comes from the metric.
  const bare = since((u) => { u.metrics = [{ metric: 'waste-share', before: 4, expected: null, after: 3, verdict: 'improved' }, { metric: 'tool-output', before: 2000, expected: null, after: 2500, verdict: 'worse' }]; });
  assert.deepEqual(cellsOf(bare.querySelector('table')), [
    [['Share of the spend wasted', 'percent of the spend'], ['4%'], ['-'], ['3%'], ['-25%'], ['improved']],
    [['Shell output read by the agent', 'characters per session'], ['2k'], ['-'], ['2.5k'], ['+25%'], ['worse']],
  ]);
  // A harness where this run found nothing at all has no sub-tabs: what the last review left is shown under the notice.
  const emptied = pageOf('en', '#/h/fixture-shop', (u, s, st) => {
    st.items = st.items.filter((i) => i.harness !== 'fixture-shop');
    st.files = st.files.filter((f) => f.harness !== 'fixture-shop');
  });
  assert.equal(emptied.view.querySelector('#subtabs'), null);
  assert.deepEqual([emptied.view.querySelectorAll('.blank').length, emptied.view.querySelector('#since').getAttribute('class')], [1, 'sec fu']);
  assert.ok(emptied.view.querySelector('#since').textContent.includes('Lint gate'));
});

test('harness header: the earlier reviews, oldest first, ending in the score it has now', () => {
  const page = pageOf('en', '#/h/u1');
  const trail = page.view.querySelector('.hero .trail');
  assert.equal(trail.querySelector('.lbl').textContent, 'Earlier reviews');
  assert.equal(trail.querySelector('ol').getAttribute('aria-label'), 'Earlier reviews');
  // The state lists them newest first here; the trail does not depend on that.
  assert.deepEqual(trail.querySelectorAll('li').map((li) => [li.children.map((c) => c.textContent), li.getAttribute('class')]), [
    [[day('2025-11-01T12:00:00Z'), 'D', '58.2'], null], [[day(PREV.reviewedAt), 'C', '70.5'], null], [['now', 'B', '79.5'], 'now'],
  ]);
  assert.deepEqual(trail.querySelectorAll('time').map((t) => t.getAttribute('datetime')), ['2025-11-01T12:00:00Z', PREV.reviewedAt]);
  // The same on every sub-tab of the harness, and on the other harness with its own history.
  for (const hash of ['#/h/u1/diagnosis', '#/h/u1/impact']) assert.equal(pageOf('en', hash).view.querySelectorAll('.trail li').length, 3, hash);
  assert.deepEqual(pageOf('pt', '#/h/fixture-shop').view.querySelectorAll('.trail li').map((li) => li.children.map((c) => c.textContent)), [[day(RECENT.reviewedAt, 'pt'), 'A', '95'], ['agora', 'A', '97,5']]);
  assert.equal(pageOf('pt', '#/h/fixture-shop').view.querySelector('.trail .lbl').textContent, 'Revisões anteriores');

  // A review without a score says so; a grade the state leaves out comes from the score; a long history is folded.
  const many = pageOf('en', '#/h/u1', (u, s, st) => {
    st.harnesses[0].history = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ runId: `r${n}`, reviewedAt: `2025-0${n}-15T12:00:00Z`, score: n === 6 ? null : 40 + n * 5, grade: n === 7 ? undefined : n === 6 ? null : 'X' }));
  });
  const steps = many.view.querySelectorAll('.trail li').map((li) => li.children.length ? li.children.map((c) => c.textContent) : [li.textContent]);
  assert.deepEqual(steps, [['2 older reviews'], [day('2025-03-15T12:00:00Z'), 'X', '55'], [day('2025-04-15T12:00:00Z'), 'X', '60'], [day('2025-05-15T12:00:00Z'), 'X', '65'],
    [day('2025-06-15T12:00:00Z'), 'not scored'], [day('2025-07-15T12:00:00Z'), 'B', '75'], ['now', 'B', '79.5']]);
});

test('item: one line of history in the diagnosis; a previous link alone shows nothing', () => {
  const line = `First seen on ${day('2025-11-01T12:00:00Z')} · seen in 2 earlier reviews · declined on ${day('2025-12-01T12:30:00Z')}: The script is going away.`;
  const diagnosis = pageOf('en', '#/h/u1/diagnosis');
  assert.deepEqual(diagnosis.texts('#case-U1-101 .chist'), [line]);
  assert.ok(diagnosis.view.querySelector('#case-U1-401'), 'the item with only a link is on the page');
  assert.deepEqual(diagnosis.texts('.chist'), [line], 'and it has no history line');
  // The line sits right under the finding, before the lesson and the change.
  const card = diagnosis.view.querySelector('#case-U1-101');
  assert.deepEqual(card.children.slice(0, 4).map((c) => c.getAttribute('class')), ['chead', 'ctitle', 'cfind', 'chist']);
  // The expected saving says in which measurement the next review will look for it.
  assert.ok(card.textContent.includes('the next review checks it in: context at the start of a session'));

  const pt = pageOf('pt', '#/h/u1/diagnosis?item=U1-101');
  assert.deepEqual(pt.texts('#case-U1-101 .chist'), [`Visto pela primeira vez em ${day('2025-11-01T12:00:00Z', 'pt')} · apareceu em 2 revisões anteriores · recusado em ${day('2025-12-01T12:30:00Z', 'pt')}: The script is going away.`]);
  assert.ok(pt.view.textContent.includes('a próxima revisão confere em: contexto no início da sessão'));
});

test('a state without any of the new fields renders exactly the sections it rendered before', () => {
  const NEW = ['.hfu', '.trail', '.chist', '.fu', '#since', '.fu-nums', '.fu-lead', '.oid', '.fu-chg'];
  const headings = (page) => page.view.querySelectorAll('h1').concat(page.view.querySelectorAll('h2'), page.view.querySelectorAll('h3')).map((h) => h.textContent);
  for (const [state, lang] of [[fixture(), 'en'], [withUnknowns('pt'), 'pt']]) {
    applyScores(state);
    const page = load(board(state, { lang }));
    const routes = ['#/overview', '#/pending'];
    for (const h of state.harnesses) routes.push(`#/h/${h.id}`, `#/h/${h.id}/diagnosis`, `#/h/${h.id}/impact`);
    for (const i of state.items) routes.push(`#/h/${i.harness}/diagnosis?item=${i.id}`);
    for (const r of routes) {
      page.go(r);
      for (const sel of NEW) assert.equal(page.root.querySelectorAll(sel).length, 0, `${lang} ${r} ${sel}`);
      for (const word of [STRINGS[lang].fu.h, STRINGS[lang].fu.trail, STRINGS[lang].fu.runOf, STRINGS[lang].fu.kicker]) assert.ok(!page.view.textContent.includes(word), `${lang} ${r}: ${word}`);
    }
    for (const row of (page.go('#/overview'), page.root.querySelectorAll('.hrow'))) assert.ok(/^(Open|Abrir) [^.]+$/.test(row.getAttribute('aria-label')), row.getAttribute('aria-label'));
  }
  // The sections of each screen, by their headings, for the fixture: the list they had before.
  const page = load(board(fixture()));
  assert.deepEqual(headings(page), ['The harnesses of Fixture', 'Each harness, before and after', 'Unconfirmed leads', 'Log', 'Accounts1', 'Projects1']);
  page.go('#/h/u1/impact');
  assert.deepEqual(headings(page), ['Claude Code account 1', 'No measurement for this harness', 'What enters every session']);
  assert.deepEqual(page.view.querySelectorAll('section').map((s) => s.getAttribute('class')), ['sec first']);
  page.go('#/h/u1/diagnosis');
  const titles = fixture().items.map((i) => i.title);
  const rounds = page.texts('.rhead');
  assert.deepEqual(rounds, ['1Security and permissions', '4Gates and automation']);
  assert.deepEqual(headings(page).filter((h) => !titles.includes(h) && !rounds.includes(h)), ['Claude Code account 1', 'What is wrong, why, and how it looks after', 'Recognized defenses', 'Review progress', 'Inventory', 'Unconfirmed leads', 'Log']);
  assert.deepEqual(page.view.querySelectorAll('.case').map((c) => c.children.slice(0, 3).map((x) => x.getAttribute('class'))), [['chead', 'ctitle', 'cfind'], ['chead', 'ctitle', 'cfind']]);
  // With a measurement, the Impact tab opens on it, as before.
  const measured = load(board(withUnknowns()), { hash: '#/h/u1/impact' });
  assert.deepEqual(measured.view.querySelectorAll('section').map((s) => s.getAttribute('class')), ['sec first']);
  assert.equal(measured.view.querySelector('section .sec-k').textContent, 'Impact');
});

// ---------------------------------------------------------------------------------------------
// A decline that was kept, a finding declined before, and what a follow-up row is measured on
// ---------------------------------------------------------------------------------------------

const KEPT_NOTE = 'The import is fine on my other machine.';
/**
 * reviewedBefore, where the decline of U1-201 comes from the last review: the same proposal came
 * back, so the user was not asked again (`carriedFrom`). `mutate(item, state, u1FollowUp, shopFollowUp)`.
 */
function keptPage(lang, hash, mutate) {
  const state = reviewedBefore(lang, (u, s, st) => {
    const kept = st.items.find((i) => i.id === 'U1-201');
    kept.previous = { run: PREV.runId, item: 'U1-201' };
    kept.history = { firstSeenAt: '2025-11-01T12:00:00Z', times: 2, lastStatus: 'declined', lastDecisionAt: '2025-12-01T12:20:00Z', lastNote: KEPT_NOTE };
    kept.carriedFrom = { run: PREV.runId, item: 'U1-201' };
    if (mutate) mutate(kept, st, u, s);
  });
  return load(board(state, { lang: lang || 'en' }), { hash });
}
/** The chips in the header of a case: severity, round, class, then the status and what goes beside it. */
const headOf = (page, id) => tagsOf(page.view.querySelector(`#case-${id} .chead`));

test('a decline kept from an earlier review says so with the earlier note', () => {
  const sentence = `Decline kept from the review of ${day('2025-12-01T12:20:00Z')}: the same proposal came back. Your note then: ${KEPT_NOTE}`;
  const seen = `First seen on ${day('2025-11-01T12:00:00Z')} · seen in 2 earlier reviews`;
  const page = keptPage('en', '#/h/u1/diagnosis?item=U1-201');
  const lines = (p) => p.view.querySelectorAll('#case-U1-201 .chist').map((x) => [x.textContent, x.getAttribute('class')]);
  // In the case: its own line under the finding, then the history without that decision.
  assert.deepEqual(lines(page), [[sentence, 'chist kept'], [seen, 'chist']]);
  assert.deepEqual(page.view.querySelector('#case-U1-201').children.slice(0, 5).map((c) => c.getAttribute('class')), ['chead', 'ctitle', 'cfind', 'chist kept', 'chist']);
  // Beside the status, wherever the status is shown: the case, the margin card in the file, a group's member list.
  assert.deepEqual(headOf(page, 'U1-201').slice(-2), [['declined', 'tag st '], ['decline kept', 'tag dashed']]);
  assert.equal(page.view.querySelector('#case-U1-201 .chead .tag.dashed').getAttribute('title'), sentence);
  page.go('#/h/u1/file/fu1-1');
  const margin = page.view.querySelectorAll('.ann').find((a) => a.querySelector('.cid').textContent === 'U1-201');
  assert.deepEqual(tagsOf(margin).map((t) => t[0]), ['declined', 'decline kept']);
  const grouped = keptPage('en', '#/overview', (kept, st) => { st.groups = [{ id: 'G-1', title: 'Same finding twice', round: 2, items: ['U1-201', 'U1-401'] }]; });
  // Every member shows its status now that the board only shows: U1-401 is still open.
  assert.deepEqual(tagsOf(grouped.view.querySelector('.mlist')).map((t) => t[0]), ['declined', 'decline kept', 'open']);

  // It was not asked again: it is not pending, it is among what was decided, with its chip.
  const pending = keptPage('en', '#/pending');
  assert.equal(pending.view.querySelector('[data-item="U1-201"]'), null);
  assert.deepEqual(tagsOf(pending.view.querySelector('#p-decided')).filter((t) => t[0] === 'decline kept').length, 1);

  const pt = keptPage('pt', '#/h/u1/diagnosis?item=U1-201');
  assert.deepEqual(lines(pt).map((l) => l[0]), [
    `Recusa mantida da revisão de ${day('2025-12-01T12:20:00Z', 'pt')}: a mesma proposta voltou. Sua nota na época: ${KEPT_NOTE}`,
    `Visto pela primeira vez em ${day('2025-11-01T12:00:00Z', 'pt')} · apareceu em 2 revisões anteriores`,
  ]);
  assert.deepEqual(headOf(pt, 'U1-201').slice(-2).map((t) => t[0]), ['recusado', 'recusa mantida']);

  // Records that say little: the sentence stays true and says less, and there is no second line.
  const sparse = keptPage('en', '#/h/u1/diagnosis?item=U1-201', (kept) => { kept.history = { lastStatus: 'declined' }; });
  assert.deepEqual(lines(sparse), [['Decline kept from an earlier review: the same proposal came back.', 'chist kept']]);
  // Without the field the same item reads as it did before: a declined item with its history line.
  const plain = keptPage('en', '#/h/u1/diagnosis?item=U1-201', (kept) => { delete kept.carriedFrom; });
  assert.deepEqual(lines(plain), [[`${seen} · declined on ${day('2025-12-01T12:20:00Z')}: ${KEPT_NOTE}`, 'chist']]);
  assert.deepEqual(headOf(plain, 'U1-201').slice(-1), [['declined', 'tag st ']]);
});

test('an open finding that was declined before is marked, and listed after the others', () => {
  // In reviewedBefore, U1-101 (critical) was declined in the last review and is open again.
  const chips = [['open', 'tag st warn'], ['declined before', 'tag dashed']];
  const page = pageOf('en', '#/h/u1/diagnosis?item=U1-101');
  assert.deepEqual(headOf(page, 'U1-101').slice(-2), chips);
  assert.deepEqual(headOf(page, 'U1-401').slice(-2), [['gate', 'tag'], ['open', 'tag st warn']], 'a finding the records do not know has no chip');
  assert.equal(page.texts('#case-U1-101 .chist').length, 1, 'the history line already says when and with what note');

  // Pending: the findings never declined first, most severe first; the critical one waits at the end of its harness.
  const order = (p) => p.view.querySelectorAll('.prow').map((r) => r.getAttribute('data-item'));
  const pending = pageOf('en', '#/pending');
  assert.deepEqual(order(pending), ['U1-401', 'U1-101', 'SHOP-501']);
  assert.deepEqual(tagsOf(pending.view.querySelector('[data-item="U1-101"]')).map((t) => t[0]), ['declined before']);

  const pt = pageOf('pt', '#/h/u1/diagnosis?item=U1-101');
  assert.deepEqual(headOf(pt, 'U1-101').slice(-2).map((t) => t[0]), ['aberto', 'recusado antes']);

  // A group still comes first and covers its members, declined before or not.
  const grouped = pageOf('en', '#/pending', (u, s, st) => { st.groups = [{ id: 'G-1', title: 'Same finding twice', round: 1, items: ['U1-101', 'U1-401'] }]; });
  assert.equal(grouped.view.querySelector('[data-item]').getAttribute('data-item'), 'G-1');

  // Left for later last time, not declined: its usual place at the head of its harness, and no chip.
  const usual = pageOf('en', '#/pending', (u, s, st) => { st.items.find((i) => i.id === 'U1-101').history.lastStatus = 'deferred'; });
  assert.deepEqual(order(usual), ['U1-101', 'U1-401', 'SHOP-501']);
  const plain = pageOf('en', '#/h/u1/diagnosis?item=U1-101', (u, s, st) => { st.items.find((i) => i.id === 'U1-101').history.lastStatus = 'deferred'; });
  assert.deepEqual(headOf(plain, 'U1-101').slice(-2), [['secret', 'tag'], ['open', 'tag st warn']]);
});

test('follow-up rows: the base of the wasted share, and why two numbers are not compared', () => {
  const rows = (lang, mutate, hash = '#/h/u1/impact') => cellsOf(pageOf(lang, hash, mutate).view.querySelector('#since table'));
  const add = (u) => {
    u.metrics.find((m) => m.metric === 'waste-share').base = 'weighted';
    u.metrics.push({ metric: 'weighted-per-session', before: 181000, expected: null, after: 175000, changePct: -3.3, verdict: 'not-measured', reason: 'weights-changed' });
    u.metrics.push({ metric: 'waste:loop', before: 900, expected: null, after: 1200, changePct: null, verdict: 'not-measured', reason: 'no-common-base' });
  };
  const en = rows('en', add);
  // The sub-label of the share says which base both numbers are on.
  assert.deepEqual(en[4], [['Share of the spend wasted', 'percent of the spend, in relative cost'], ['2.6%'], ['-'], ['2%'], ['-23.1%'], ['improved']]);
  // Both reviews have a number, on bases that do not compare: both are shown, no difference is, and the row says why.
  assert.deepEqual(en[6], [['Relative cost', 'tokens per session'], ['181k'], ['-'], ['175k'], ['-'],
    ['not measured', 'the price weights changed between the two reviews, so the relative cost cannot be compared']]);
  assert.deepEqual(en[7], [['Identical calls repeated in a row', 'tokens per session'], ['900'], ['-'], ['1.2k'], ['-'],
    ['not measured', 'one review measured in relative cost and the other in raw tokens']]);
  // A row that is not measured because one side is missing says nothing more, as before.
  assert.deepEqual(en[5], [['Shell output read by the agent', 'characters per session'], ['96k'], ['-'], ['not measured'], ['-'], ['not measured']]);

  const pt = rows('pt', add);
  assert.deepEqual(pt[4][0], ['Parcela do gasto que foi à toa', 'por cento do gasto, em custo relativo']);
  assert.deepEqual(pt[6][5], ['sem medição', 'os pesos de preço mudaram entre as duas revisões, então o custo relativo não é comparável']);
  assert.deepEqual(pt[7][5], ['sem medição', 'uma revisão mediu em custo relativo e a outra em tokens brutos']);
  assert.equal(rows('en', (u) => { u.metrics[4].base = 'raw'; })[4][0][1], 'percent of the spend, in raw tokens');
  assert.equal(rows('pt', (u) => { u.metrics[4].base = 'raw'; })[4][0][1], 'por cento do gasto, em tokens brutos');

  // A reason only explains a row that is not measured; while the sample is too small it goes with the verdict.
  assert.deepEqual(rows('en', (u) => { u.metrics[0].reason = 'weights-changed'; })[0][5], ['confirmed']);
  assert.deepEqual(rows('en', (u, s) => { Object.assign(s.metrics[0], { verdict: 'not-measured', reason: 'weights-changed' }); }, '#/h/fixture-shop/impact')[0].slice(4), [['-'], ['not enough data yet']]);
  // Without the two fields a row reads as it did: the unit alone, and a verdict with nothing under it.
  const plain = rows('en');
  assert.deepEqual(plain[4], [['Share of the spend wasted', 'percent of the spend'], ['2.6%'], ['-'], ['2%'], ['-23.1%'], ['improved']]);
  assert.ok(plain.every((r) => r[5].length === 1));
});

test('a state without carriedFrom, a declined-before finding, base or reason renders as before', () => {
  const NEW_WORDS = (T) => [T.hist.keptChip, T.hist.declinedBefore, T.hist.carriedNoDate.slice(0, 14), T.fu.rowReason['weights-changed'], T.fu.rowReason['no-common-base']];
  const states = [
    ['en', fixture()],
    ['pt', withUnknowns('pt')],
    // A second review where nothing was declined before: U1-101 was left for later.
    ['en', reviewedBefore('en', (u, s, st) => { st.items.find((i) => i.id === 'U1-101').history.lastStatus = 'deferred'; })],
  ];
  for (const [lang, state] of states) {
    applyScores(state);
    const page = load(board(state, { lang }));
    const routes = ['#/overview', '#/pending'];
    for (const h of state.harnesses) routes.push(`#/h/${h.id}`, `#/h/${h.id}/diagnosis`, `#/h/${h.id}/impact`);
    for (const i of state.items) routes.push(`#/h/${i.harness}/diagnosis?item=${i.id}`);
    for (const f of state.files) routes.push(`#/h/${f.harness}/file/${f.id}`);
    for (const r of routes) {
      page.go(r);
      assert.equal(page.root.querySelectorAll('.kept').length, 0, `${lang} ${r}`);
      for (const word of NEW_WORDS(STRINGS[lang])) assert.ok(!page.view.textContent.includes(word), `${lang} ${r}: ${word}`);
    }
  }
  // And Pending is in the order it always had: most severe first.
  const page = load(board(states[2][1]), { hash: '#/pending' });
  assert.deepEqual(page.view.querySelectorAll('.prow').map((r) => r.getAttribute('data-item')), ['U1-101', 'U1-401', 'SHOP-501']);
});

// ---------------------------------------------------------------------------------------------
// The board that leaves the machine draws no e-mail address
// ---------------------------------------------------------------------------------------------

test('a published board draws no e-mail address, and the change that quotes one is still in its file', () => {
  const OWNER = 'alice.smith@example.com';
  const BACKUP = 'bo@mail.example.org';
  const state = fixture();
  const file = state.files.find((f) => f.id === 'fu1-1');
  file.content += `\nOwner: ${OWNER}\nBackup contact: ${BACKUP}\nPinned: react@18.3.1 from git@host.example:owner/repo\n`;
  state.items.find((i) => i.id === 'U1-203').changes.push({ file: 'fu1-1', path: file.path, before: `Owner: ${OWNER}`, after: `Owner: ${OWNER}, on call`, why: `What ${OWNER} asked for.` });
  applyScores(state);
  const routes = ['#/overview', '#/decide', '#/h/u1', '#/h/u1/diagnosis', '#/h/u1/file/fu1-1', '#/h/u1/file/fu1-1?at=U1-203.1', '#/h/fixture-shop/file/fshop-1'];
  for (const i of state.items) routes.push(`#/h/${i.harness}/diagnosis?item=${i.id}`);
  /** Everything a route puts on the page: its text, and the texts kept in attributes. */
  const drawn = (page) => `${page.document.body.textContent}\n${page.document.body.querySelectorAll('[title]').map((n) => n.getAttribute('title')).join('\n')}`;
  const lines = (page) => page.view.querySelectorAll('.fv-code.hunk .tx').map((n) => n.textContent);

  const published = load(board(state, { channel: 'artifact' }));
  for (const r of routes) {
    published.go(r);
    for (const address of [OWNER, BACKUP]) assert.ok(!drawn(published).includes(address), `${r}: ${address}`);
  }
  // The file is drawn with the addresses masked, and the change sits in it, on its line.
  published.go('#/h/u1/file/fu1-1');
  assert.ok(lines(published).includes('Owner: al…@example.com') && lines(published).includes('Owner: al…@example.com, on call'), lines(published).join(' | '));
  assert.ok(published.view.textContent.includes('Backup contact: b…@mail.example.org'));
  assert.ok(published.view.textContent.includes('What al…@example.com asked for.'));
  assert.ok(published.view.textContent.includes('react@18.3.1 from git@host.example:owner/repo'), 'what only looks like an address is left as written');
  assert.equal(published.view.querySelectorAll('.fv-sec').length, 0, 'no change is left outside the file');

  // The same state on a board that stays on the machine is drawn as it is on disk, at the same place.
  const local = load(board(state, { channel: 'file' }), { hash: '#/h/u1/file/fu1-1' });
  assert.ok(lines(local).includes(`Owner: ${OWNER}`) && lines(local).includes(`Owner: ${OWNER}, on call`));
  assert.ok(local.view.textContent.includes(`Backup contact: ${BACKUP}`));
  assert.equal(lines(local).length, lines(published).length);
  assert.equal(local.view.querySelectorAll('.ln').length, published.view.querySelectorAll('.ln').length, 'line for line the same file');
});

// ---------------------------------------------------------------------------------------------
// One change in focus in the file viewer
// ---------------------------------------------------------------------------------------------

/** Runs the page's own document-level listeners (the stand-in does not bubble). */
const fireDoc = (page, type, event) => { for (const fn of page.document.listeners[type] || []) fn({ button: 0, preventDefault() {}, ...event }); };
const FILE_U1 = '#/h/u1/file/fu1-1';

test('focus: a card puts only its change in focus, the route keeps it, and Escape, a second click or empty space clear it', () => {
  for (const lang of ['en', 'pt']) {
    const page = load(board(example(), { lang }), { hash: FILE_U1 });
    const T = STRINGS[lang];
    const keys = page.view.querySelectorAll('.fv-code.hunk').map((h) => h.getAttribute('data-key'));
    assert.ok(keys.length >= 3, 'the file has several changes');
    assert.equal(page.view.querySelectorAll('.focus').length, 0, 'nothing in focus at first');
    assert.equal(page.view.querySelector('.fv-focus').textContent, T.focus.hint);
    const card = (key) => page.view.querySelector(`.fv-note[data-key="${key}"] .ann`);

    // A click on a card: its hunk and its card, and nothing else, are in focus; the rest is dimmed.
    const key = keys[1];
    card(key).click();
    assert.equal(page.window.location.hash, `${FILE_U1}?c=${encodeURIComponent(key)}`);
    assert.deepEqual(page.view.querySelectorAll('.fv-code.focus').map((h) => h.getAttribute('data-key')), [key]);
    assert.deepEqual(page.view.querySelectorAll('.fv-note.focus').map((n) => n.getAttribute('data-key')), [key]);
    assert.ok(page.view.querySelector('.fv-wrap.notes').classList.contains('focusing'), 'the rest is dimmed, not hidden');
    assert.equal(page.view.querySelectorAll('.fv-code.hunk').length, keys.length, 'every change is still drawn');
    assert.equal(card(key).getAttribute('aria-current'), 'true');
    assert.equal(card(key).querySelector('.ann-on').textContent, T.focus.on);
    assert.equal(page.view.querySelector('.fv-focus.on [data-fk="focus:clear"]').textContent, T.focus.clear);
    // A reload or a shared link keeps it: the route is remembered with the focus.
    assert.equal(page.stored.get(`novarc-harness-doctor:${example().run.id}:route`), `${FILE_U1}?c=${encodeURIComponent(key)}`);
    const again = load(board(example(), { lang }), { stored: Object.fromEntries(page.stored) });
    assert.deepEqual(again.view.querySelectorAll('.fv-code.focus').map((h) => h.getAttribute('data-key')), [key]);

    // The same card again clears it.
    card(key).click();
    assert.equal(page.window.location.hash, FILE_U1);
    assert.equal(page.view.querySelectorAll('.focus').length, 0);

    // A click on a change in the file selects its card.
    page.view.querySelector(`.fv-code.hunk[data-key="${keys[0]}"]`).click();
    assert.equal(card(keys[0]).getAttribute('aria-current'), 'true');
    // Escape clears it.
    fireDoc(page, 'keydown', { key: 'Escape' });
    assert.equal(page.window.location.hash, FILE_U1);
    assert.equal(page.view.querySelectorAll('.focus').length, 0);

    // The keyboard: a card is focusable, and Enter or Space toggles it.
    assert.equal(card(keys[2]).getAttribute('tabindex'), '0');
    card(keys[2]).fire('keydown', { key: 'Enter', target: card(keys[2]) });
    assert.equal(card(keys[2]).getAttribute('aria-current'), 'true');
    card(keys[2]).fire('keydown', { key: ' ', target: card(keys[2]) });
    assert.equal(page.view.querySelectorAll('.focus').length, 0);

    // A click on empty space clears it; a click on the card's own link does not toggle anything.
    card(keys[0]).click();
    fireDoc(page, 'click', { target: page.view.querySelector('.fv-path') });
    assert.equal(page.window.location.hash, FILE_U1, 'a click on empty space');
    const link = card(keys[0]).querySelector('a.cid');
    card(keys[0]).fire('click', { target: link });
    assert.equal(page.window.location.hash, FILE_U1, 'the id link is left to the router');

    // Hovering a card previews the same highlight, and leaving it takes it away.
    const note = page.view.querySelector(`.fv-note[data-key="${keys[1]}"]`);
    card(keys[1]).fire('mouseenter');
    assert.ok(page.view.querySelector('.fv-wrap.notes').classList.contains('peeking'));
    assert.ok(note.classList.contains('peek') && page.view.querySelector(`.fv-code[data-key="${keys[1]}"]`).classList.contains('peek'));
    card(keys[1]).fire('mouseleave');
    assert.equal(page.view.querySelectorAll('.peek').length, 0);
  }
  // A link from the diagnosis ("see in the file") opens the file with that change in focus; the older ?at= does too.
  const page = load(board(example()), { hash: '#/h/u1/diagnosis?item=U1-201' });
  const see = page.view.querySelectorAll('#case-U1-201 .dhead a')[0];
  assert.match(see.getAttribute('href'), /\?c=U1-201\.0$/);
  const old = load(board(example()), { hash: `${FILE_U1}?at=U1-201.0` });
  assert.deepEqual(old.view.querySelectorAll('.fv-code.focus').map((h) => h.getAttribute('data-key')), ['U1-201.0']);
  // A focus on a change this file does not have is ignored.
  assert.equal(load(board(example()), { hash: `${FILE_U1}?c=NOPE-1.0` }).view.querySelectorAll('.focus').length, 0);
});

// ---------------------------------------------------------------------------------------------
// Accounts and projects never look alike; the side index
// ---------------------------------------------------------------------------------------------

test('kind markers: an account and a project are marked apart wherever a harness appears', () => {
  for (const lang of ['en', 'pt']) {
    const T = STRINGS[lang];
    const state = example();
    const kindOf = (id) => state.harnesses.find((h) => h.id === id).kind;
    const page = load(board(state, { lang }), { hash: '#/overview' });
    // The side index (what the tab bar was): accounts first, then projects, each under its own heading.
    const groups = page.root.querySelectorAll('.side .ix-group');
    assert.deepEqual(groups.map((g) => g.getAttribute('data-kind')), ['user', 'project']);
    assert.deepEqual(groups.map((g) => g.querySelector('.ix-gh').textContent), [T.kindGroup.user, T.kindGroup.project]);
    for (const g of groups) {
      for (const a of g.querySelectorAll('.ix-hl')) {
        assert.equal(kindOf(a.getAttribute('data-harness')), g.getAttribute('data-kind'));
        assert.equal(a.querySelector('.kind').getAttribute('aria-label'), T.kind[g.getAttribute('data-kind')], 'the glyph has its word for a screen reader');
      }
    }
    // Overview rows: under a heading per kind, each with the glyph of its kind.
    assert.deepEqual(page.view.querySelectorAll('.fleet-h').map((h) => h.querySelector('.kind').getAttribute('class')), ['kind user bare', 'kind project bare']);
    assert.deepEqual(page.view.querySelectorAll('.hrow').map((r) => r.querySelector('.kind').getAttribute('class')),
      state.harnesses.filter((h) => h.kind === 'user').concat(state.harnesses.filter((h) => h.kind !== 'user')).map((h) => `kind ${h.kind} bare`));
    // The header of a harness says its kind in words.
    for (const h of state.harnesses) {
      page.go(`#/h/${h.id}`);
      assert.equal(page.view.querySelector('.hero .kicker .kind').textContent, T.kind[h.kind], h.id);
    }
    // The file viewer names the harness with its marker.
    page.go('#/h/loja-web/file/floja-1');
    assert.equal(page.view.querySelector('.fv-who .kind').getAttribute('class'), 'kind project bare');
    page.go(FILE_U1);
    assert.equal(page.view.querySelector('.fv-who .kind').getAttribute('class'), 'kind user bare');
    // Pending: each harness group with the marker in words.
    page.go('#/pending');
    assert.deepEqual(page.view.querySelectorAll('.psec .ph .kind').map((k) => k.textContent),
      ['u1', 'u2', 'u3', 'loja-web', 'api-pedidos'].filter((id) => state.items.some((i) => i.harness === id && i.status === 'open')).map((id) => T.kind[kindOf(id)]));
  }
});

test('side index: every entry is a route, the page shown is marked, its sections are listed, and on a phone it is a drawer', () => {
  const state = example();
  const page = load(board(state, { lang: 'pt' }), { hash: '#/overview' });
  const side = page.root.querySelector('#side');
  const hrefs = side.querySelectorAll('a').map((a) => a.getAttribute('href'));
  assert.ok(hrefs.every((h) => /^#\//.test(h)), 'only hash routes: the same in the three channels');
  assert.deepEqual(side.querySelectorAll('.ix-hl').map((a) => a.getAttribute('href')), state.harnesses.filter((h) => h.kind === 'user').concat(state.harnesses.filter((h) => h.kind !== 'user')).map((h) => `#/h/${h.id}`));
  assert.equal(page.current(), 'overview');
  // Each harness with its grade and how many decisions wait for it.
  const u1 = side.querySelector('[data-harness="u1"]');
  assert.equal(u1.querySelector('.gr').textContent, state.harnesses[0].scores.grade);
  assert.equal(u1.querySelector('.n').textContent, String(state.items.filter((i) => i.harness === 'u1' && i.status === 'open').length));
  // The sections of the overview, as links to the overview route that scroll instead of navigating.
  const secs = side.querySelectorAll('a[data-sec]');
  assert.deepEqual(secs.map((a) => a.getAttribute('data-sec')), page.view.querySelectorAll('[data-toc]').map((n) => n.getAttribute('id')));
  assert.ok(secs.every((a) => a.getAttribute('href') === '#/overview'));
  assert.equal(side.querySelectorAll('a[aria-current="location"]').length, 1, 'the section being read is marked');
  fireDoc(page, 'click', { target: secs[1] });
  assert.equal(page.current(), 'overview', 'a section link does not leave the page');

  // A harness: its three views under it, and the current one with its parts.
  page.go('#/h/u1/diagnosis');
  assert.equal(page.current(), 'h:u1');
  const sub = page.root.querySelectorAll('.side .ix-sub a');
  assert.deepEqual(sub.map((a) => [a.getAttribute('href'), a.getAttribute('aria-current')]), [['#/h/u1', null], ['#/h/u1/diagnosis', 'true'], ['#/h/u1/impact', null]]);
  const labels = page.root.querySelectorAll('.side a[data-sec]').map((a) => a.textContent);
  // The rounds of the findings shown (the diagnosis opens on what is still open).
  for (const r of [...new Set(state.items.filter((i) => i.harness === 'u1' && (i.status === 'open' || i.status === 'failed')).map((i) => i.round))]) assert.ok(labels.includes(`${r} · ${STRINGS.pt.rounds[r]}`), `round ${r}`);
  for (const h of ['Defesas reconhecidas', 'Registro']) assert.ok(labels.some((l) => l.startsWith(h.slice(0, 6))), h);
  page.go('#/h/u1/impact');
  assert.ok(page.root.querySelectorAll('.side a[data-sec]').map((a) => a.getAttribute('data-sec')).includes('since'), 'Desde a última revisão');
  // The Explorer: the file tree and the views, hooks and permissions among them.
  page.go('#/h/u1/view/hooks');
  const tree = page.root.querySelector('.side .tree');
  assert.ok(tree.querySelector('[data-fk="ix:view:hooks"][aria-current="true"]'));
  assert.ok(tree.querySelector('[data-fk="ix:view:permissions"]'));
  assert.ok(tree.querySelector('[data-fk="ix:file:fu1-1"]'));
  // Pending is an entry too.
  page.go('#/pending');
  assert.equal(page.current(), 'pending');

  // On a phone the index is a drawer behind a button in the bar.
  const btn = page.root.querySelector('#ix-btn');
  assert.equal(btn.getAttribute('aria-controls'), 'side');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  btn.click();
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.ok(page.document.body.classList.contains('ix-open'));
  // A link inside closes it, and so does Escape.
  fireDoc(page, 'click', { target: page.root.querySelector('.side [data-harness="loja-web"]') });
  assert.equal(page.current(), 'h:loja-web');
  assert.ok(!page.document.body.classList.contains('ix-open'));
  page.root.querySelector('#ix-btn').click();
  fireDoc(page, 'keydown', { key: 'Escape' });
  assert.ok(!page.document.body.classList.contains('ix-open'));
  assert.equal(page.root.querySelector('#ix-btn').getAttribute('aria-expanded'), 'false');
});

// ---------------------------------------------------------------------------------------------
// Hooks as lifecycle slots, permissions as lanes
// ---------------------------------------------------------------------------------------------

test('hooks: one slot per moment of the lifecycle, in order, with what is registered there and the git and CI group apart', () => {
  for (const lang of ['en', 'pt']) {
    const T = STRINGS[lang];
    const page = load(board(example(), { lang }), { hash: '#/h/u1/view/hooks' });
    const slots = page.view.querySelectorAll('.life .slot');
    assert.deepEqual(slots.map((s) => s.getAttribute('data-event')), HOOK_EVENTS.map((e) => e.event), 'every event once, in lifecycle order');
    const slot = (event) => page.view.querySelector(`.life .slot[data-event="${event}"]`);
    // A registered hook sits in its slot with what it matches, whether it blocks, where it comes from.
    const pre = slot('PreToolUse');
    assert.ok(pre.classList.contains('filled'));
    assert.equal(pre.querySelector('.slot-h .tag').textContent, T.hk.canBlock);
    assert.deepEqual(pre.querySelectorAll('.hk').map((h) => [h.querySelector('.hk-m').textContent, h.querySelector('.hk-h .tag').textContent, h.querySelectorAll('.hk-h .tag')[1].textContent]),
      [['Read|Edit|Write', T.blocking.yes, T.hookSource.agent]]);
    assert.equal(slot('PostToolUse').querySelector('.slot-h .tag').textContent, T.hk.onlyReports);
    assert.equal(slot('PostToolUse').querySelector('.hk .hk-h .tag').textContent, T.blocking.no);
    // A plugin hook whose code could not be read: "could not tell", with its plugin and finding.
    const start = slot('SessionStart').querySelector('.hk');
    assert.deepEqual([start.querySelector('.hk-h .tag').textContent, start.querySelectorAll('.hk-h .tag')[1].textContent, start.querySelector('.cid').textContent],
      [T.blocking.unknown, T.v.pluginOf.replace('{name}', 'exemplo-tools'), 'U1-802']);
    // The script a hook runs links to the file in the explorer.
    assert.equal(slot('Stop').querySelector('.hk-f a').getAttribute('href'), '#/h/u1/file/fu1-3');
    assert.equal(slot('Stop').querySelector('.keeps').textContent, T.hk.keeps);
    // An empty slot is drawn empty, with what people usually put there.
    const empty = slot('UserPromptSubmit');
    assert.ok(empty.classList.contains('empty'));
    assert.equal(empty.querySelector('.slot-w').textContent, T.hk.ev.UserPromptSubmit.what);
    assert.ok(empty.querySelector('.slot-e').textContent.includes(T.hk.ev.UserPromptSubmit.idea));
    // A moment few people use is drawn small, its explanation one click away.
    assert.ok(slot('Setup').classList.contains('mini'));
    assert.equal(slot('Setup').querySelector('.slot-w').textContent, T.hk.ev.Setup.what);
    // Git and CI come after the lifecycle, in their own group.
    page.go('#/h/loja-web/view/hooks');
    const outside = page.view.querySelector('.outside-g');
    assert.equal(outside.querySelector('h4').textContent, T.hk.outside);
    assert.deepEqual(outside.querySelectorAll('.slot').map((s) => [s.getAttribute('data-event'), s.querySelector('.hk-h .tag').textContent]),
      [['pre-commit', T.blocking.no], ['push, pull_request', T.blocking.yes]]);
    assert.equal(page.view.querySelectorAll('.life .slot.filled').length, 0, 'no agent hook in this project: every slot is empty');
    assert.equal(page.view.querySelectorAll('.life .slot').length, HOOK_EVENTS.length);
  }
});

test('hooks and permissions with nothing registered, for another agent, and for a linked account', () => {
  const state = example();
  // A project with files and no hook or rule: the empty lifecycle and the empty lanes still teach.
  const bare = state.harnesses.find((h) => h.id === 'loja-web');
  bare.elements.hooks = [];
  bare.elements.permissions = [];
  const page = load(board(state, { lang: 'pt' }), { hash: '#/h/loja-web/view/hooks' });
  assert.equal(page.view.querySelectorAll('.life .slot').length, HOOK_EVENTS.length);
  assert.ok(page.view.querySelector('.outside-g .slot-e').textContent.includes(STRINGS.pt.hk.outsideIdea));
  page.go('#/h/loja-web/view/permissions');
  assert.deepEqual(page.view.querySelectorAll('.lane .lane-e').map((p) => p.textContent), ['deny', 'ask', 'allow'].map((k) => STRINGS.pt.perm.laneEmpty[k]));
  assert.equal(page.view.querySelector('.pmode .muted').textContent, STRINGS.pt.perm.modeNone);
  // Another agent: only the moments its own hooks name, with no "can block" this board cannot back.
  const codex = example();
  const u3 = codex.harnesses.find((h) => h.id === 'u3');
  u3.elements = { hooks: [{ id: 'cx-1', source: 'agent', event: 'stop', command: 'notify-send done', blocking: null }], permissions: [{ layer: 'user', kind: 'mode', rule: 'approval_policy = on-request' }] };
  const cx = load(board(codex, { lang: 'en' }), { hash: '#/h/u3/view/hooks' });
  assert.deepEqual(cx.view.querySelectorAll('.life .slot').map((s) => s.getAttribute('data-event')), ['stop']);
  assert.equal(cx.view.querySelector('.life .slot .slot-h .tag').textContent, STRINGS.en.hk.unverified);
  cx.go('#/h/u3/view/permissions');
  assert.equal(cx.view.querySelectorAll('.lane').length, 0, 'Codex has no allow, ask and deny lists');
  assert.equal(cx.view.querySelector('.pmode code').textContent, 'approval_policy = on-request');
  // A linked account says where the rest comes from.
  const linked = example();
  const u2 = linked.harnesses.find((h) => h.id === 'u2');
  u2.elements = { hooks: [] };
  const ln = load(board(linked, { lang: 'pt' }), { hash: '#/h/u2/view/hooks' });
  const note = ln.view.querySelector('.pane .note-line');
  assert.ok(note.textContent.startsWith('Herda de Claude Code'));
  assert.equal(note.querySelector('a').getAttribute('href'), '#/h/u1/view/hooks');
});

test('permissions: three lanes in the order they decide, each rule under its tool with the file it comes from', () => {
  for (const lang of ['en', 'pt']) {
    const T = STRINGS[lang];
    const state = example();
    const page = load(board(state, { lang }), { hash: '#/h/u1/view/permissions' });
    assert.deepEqual(page.view.querySelectorAll('.lane').map((l) => [l.getAttribute('data-lane'), l.querySelector('h4').textContent]),
      [['deny', T.perm.lane.deny], ['ask', T.perm.lane.ask], ['allow', T.perm.lane.allow]]);
    assert.ok(page.view.querySelector('.porder').textContent.endsWith(T.perm.order));
    // The default mode, from the file that sets it.
    assert.deepEqual([page.view.querySelector('.pmode code').textContent, page.view.querySelector('.pmode .tag').textContent], ['acceptEdits', T.perm.layer.user]);
    // Every rule of the state in its lane, under its tool, pattern as code, source as a tag that opens the file.
    const rules = state.harnesses[0].elements.permissions.filter((p) => p.kind !== 'mode');
    for (const p of rules) {
      const li = page.view.querySelector(`.lane[data-lane="${p.kind}"] li.rule[data-rule="${p.rule}"]`);
      assert.ok(li, `${p.kind} ${p.rule}`);
      assert.equal(li.closest('.tgroup').querySelector('b').textContent, p.rule.split('(')[0]);
      assert.equal(li.querySelector('code').textContent, /\((.*)\)$/.exec(p.rule)[1]);
      assert.deepEqual([li.querySelector('.tag.src').textContent, li.querySelector('.tag.src').getAttribute('href')], [T.perm.layer[p.layer], '#/h/u1/file/fu1-2']);
      if (p.item) assert.equal(li.querySelector('.cid').textContent, p.item, 'the finding that points at the rule');
    }
    assert.equal(page.view.querySelectorAll('li.rule').length, rules.length);
    // An allow a finding flags is highlighted, with no new judgement: the finding says why.
    page.go('#/h/loja-web/view/permissions');
    const risky = page.view.querySelectorAll('li.rule.risky');
    assert.deepEqual(risky.map((r) => [r.getAttribute('data-rule'), r.querySelector('.cid').textContent, r.querySelector('.risk').textContent]), [['Bash(rm -rf *)', 'LOJA-101', T.perm.risky]]);
    assert.ok(risky.every((r) => r.closest('.lane').getAttribute('data-lane') === 'allow'));
  }
});
