// The board page as a whole: board.html is parsed and its inline script runs against a small
// stand-in for the DOM, so these tests cover what the pure-logic tests cannot: that the page boots
// in both shells (standalone document, Artifact fragment), where it opens, what each channel
// sends when a button is pressed, and how a value that was not measured is drawn.
// The stand-in implements only what the client calls. It is not a browser: layout is all zeros.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES } from './helpers.mjs';
import { renderHtml, SCHEMA_PATH } from '../scripts/render-board.mjs';
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
    setInterval() { return 0; },
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
    current: () => root.querySelectorAll('.nav [aria-current="page"]').map((n) => n.textContent).join(' | '),
    go(hash) { window.location.hash = hash; for (const fn of window.listeners.hashchange || []) fn(); },
    press(fk) {
      const b = root.querySelector(`[data-fk="${fk}"]`);
      assert.ok(b, `a control with data-fk="${fk}" (have: ${root.querySelectorAll('[data-fk]').map((n) => n.getAttribute('data-fk')).filter((x) => /^(dec|primary|chg)/.test(x)).join(', ')})`);
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
  assert.equal(tags(doc, 'body'), 'a nav div div script script');
  // The publisher's head stays its own; everything the fragment brings lands in the body.
  assert.equal(tags(frag, 'head'), 'meta meta');
  assert.equal(tags(frag, 'body'), 'title style link a nav div div script script');
  for (const p of [doc, frag]) {
    assert.equal(p.root.querySelectorAll('title').length, 1);
    assert.equal(p.root.querySelector('link').getAttribute('rel'), 'stylesheet');
    for (const id of ['skip', 'nav', 'view', 'foot', 'tray', 'board-data']) assert.ok(p.document.getElementById(id), id);
  }
});

test('every route of the example draws, in the fragment as in the document', () => {
  const state = example();
  const routes = ['#/overview', '#/decide', '#/decide/summary', '#/decide/G-1', '#/decide/U1-101', '#/h/ghost', '#/nowhere'];
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
  const linked = load(html, { hash: '#/decide', stored: Object.fromEntries(first.stored) });
  assert.equal(linked.current().includes('decide'), true);
  assert.equal(linked.stored.get(key), '#/decide');

  // Another run does not see this one's route.
  const other = decidable();
  other.run.id = '20260111-zz99';
  assert.equal(load(board(other, { channel: 'artifact' }), { stored: Object.fromEntries(first.stored) }).current(), 'overview');
});

test('a remembered route that no longer exists in the state is ignored', () => {
  const state = decidable();
  const key = `novarc-harness-doctor:${state.run.id}:route`;
  const open = (stored) => load(board(state), { stored: { [key]: stored } }).current();
  assert.match(open('#/h/u1/file/fu1-1'), /Claude Code account 1/);
  for (const gone of ['#/h/removed-project', '#/h/u1/file/fshop-1', '#/h/u1/file/f-gone', '#/h/u1/view/secrets', '#/decide/U1-102', 'javascript:alert(1)', '', `#/h/u1/${'x'.repeat(700)}`]) {
    assert.equal(open(gone), 'overview', gone);
  }
  assert.equal(open('#/decide/summary').includes('decide'), true);
  assert.equal(open('#/decide/G-1').includes('decide'), true);
});

test('the page draws the same when browser storage is missing, throws or forgets', async () => {
  const state = decidable();
  const html = board(state);
  const base = load(html).view.textContent;
  for (const storage of ['throws', 'missing', 'refuses', 'empty-reads']) {
    const page = load(html, { storage });
    assert.equal(page.view.textContent, base, storage);
    page.go(CASE);
    assert.equal(page.fatal(), null, storage);
    // Deciding still works: the decision is held in the page and shown as a line to paste.
    page.press('dec:U1-101:approve');
    await page.settle();
    assert.equal(page.fatal(), null, storage);
    assert.deepEqual(page.texts('.paste code'), [`run.mjs decide --run ${state.run.id} --target U1-101 --action approve --rev ${REV_A}`], storage);
  }
});

// ---------------------------------------------------------------------------------------------
// Decisions carry the revision, through every channel
// ---------------------------------------------------------------------------------------------

/** A stand-in for the Artifact `db` namespace: it records what the page writes. */
function fakeDb() {
  const writes = [];
  const db = {
    collection: (name) => ({
      onSnapshot() {},
      doc: (id) => ({ set(data) { writes.push({ collection: name, id, data }); return Promise.resolve(); } }),
    }),
  };
  return { writes, claude: { use: (name) => Promise.resolve(name === 'db' ? db : null) } };
}

test('artifact channel: each decision is written to its document with the rev of what it answers', async () => {
  const state = decidable();
  const { writes, claude } = fakeDb();
  const page = load(board(state, { channel: 'artifact' }), { claude, hash: '#/h/u1/diagnosis' });
  await page.settle();
  page.press('dec:U1-101:approve');
  page.go('#/overview');
  page.press('dec:G-1:decline');
  page.press('primary:claude-1');
  await page.settle();
  assert.deepEqual(writes.map((w) => [w.collection, w.id, w.data.target, w.data.action, w.data.rev]), [
    ['decisions', 'U1-101', 'U1-101', 'approve', REV_A],
    ['decisions', 'G-1', 'G-1', 'decline', REV_G],
    ['decisions', 'accounts.primary', 'accounts.primary', 'approve', undefined],
  ]);
  assert.ok(!('rev' in writes[2].data), 'the primary account has no revision');
  assert.equal(writes[2].data.note, 'claude-1');
  for (const w of writes) {
    assert.deepEqual(Object.keys(w.data).filter((k) => !['id', 'at', 'runId', 'target', 'action', 'note', 'exclude', 'rev', 'via'].includes(k)), [], 'only contract fields');
    assert.equal(w.data.runId, state.run.id);
    assert.equal(w.data.via, 'board');
  }
  assert.equal(page.fatal(), null);
});

test('server channel: the posted decision carries the rev', async () => {
  const state = decidable();
  const page = load(board(state, { channel: 'server' }), { protocol: 'http:', hostname: '127.0.0.1', search: '?t=tok', hash: '#/h/fixture-shop/diagnosis' });
  await page.settle();
  page.press('dec:SHOP-501:defer');
  await page.settle();
  const posts = page.requests.filter((r) => r.opts.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/decisions?t=tok');
  const sent = JSON.parse(posts[0].opts.body);
  assert.deepEqual([sent.target, sent.action, sent.rev, sent.runId, sent.via], ['SHOP-501', 'defer', REV_B, state.run.id, 'board']);
});

test('file channel: the line to paste carries the rev, and so does what the page remembers', async () => {
  const state = decidable();
  const line = `run.mjs decide --run ${state.run.id} --target U1-101 --action approve --rev ${REV_A}`;
  const page = load(board(state, { channel: 'file' }), { hash: CASE });
  await page.settle();
  page.press('dec:U1-101:approve');
  await page.settle();
  assert.deepEqual(page.texts('.paste code'), [line]);
  const kept = JSON.parse(page.stored.get(`novarc-harness-doctor:${state.run.id}`));
  assert.deepEqual(kept.map((d) => [d.target, d.rev]), [['U1-101', REV_A]]);

  // Reopened from disk, the decision is restored with its rev and still offered for pasting.
  const again = load(board(state, { channel: 'file' }), { stored: Object.fromEntries(page.stored), hash: CASE });
  await again.settle();
  assert.deepEqual(again.texts('.paste code'), [line]);
  assert.equal(again.root.querySelector('[data-fk="dec:U1-101:approve"]'), null, 'shown as decided');

  // After a rebuild that changed the proposal, the remembered decision no longer holds.
  const changed = decidable();
  changed.items.find((i) => i.id === 'U1-101').rev = 'cccccccccccc';
  const stale = load(board(changed, { channel: 'file' }), { stored: Object.fromEntries(page.stored), hash: CASE });
  await stale.settle();
  assert.deepEqual(stale.texts('.paste code'), []);
  assert.ok(stale.root.querySelector('[data-fk="dec:U1-101:approve"]'), 'the item is open for a decision again');
});

test('a state without revisions sends decisions without one', async () => {
  const state = fixture();
  const { writes, claude } = fakeDb();
  const page = load(board(state, { channel: 'artifact' }), { claude, hash: '#/h/u1/diagnosis' });
  await page.settle();
  page.press('dec:U1-101:approve');
  await page.settle();
  assert.equal(writes.length, 1);
  assert.ok(!('rev' in writes[0].data));
});

// ---------------------------------------------------------------------------------------------
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
  const en = load(board(withUnknowns()), { hash: '#/h/u1/view/hooks' });
  assert.deepEqual(rowsOf(en).map((r) => [r[1], r[3]]), [
    ['PreToolUse', 'blocks'], ['Stop', 'does not block'], ['SessionStart', 'could not tell'], ['push', 'could not tell'],
  ]);
  const pt = load(board(withUnknowns('pt'), { lang: 'pt' }), { hash: '#/h/u1/view/hooks' });
  assert.deepEqual(rowsOf(pt).map((r) => r[3]), ['bloqueia', 'não bloqueia', 'não deu para saber', 'não deu para saber']);
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
  assert.deepEqual(sections.map((s) => [s.getAttribute('id'), s.getAttribute('class')]).slice(0, 2), [['since', 'sec first fu'], [null, 'sec']], 'first in the tab; the measurement of this run follows');
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
  const box = since.querySelector('details');
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
  assert.equal(ptSince.querySelector('summary').textContent, '2 itens que aquela revisão deixou por fazer');
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
  assert.equal(since.querySelector('details'), null, 'nothing was left undone, so nothing to unfold');
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

test('item: one line of history in the diagnosis and on the decide screen; a previous link alone shows nothing', () => {
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

  const decide = pageOf('en', '#/decide/U1-101');
  assert.deepEqual(decide.texts('.case .chist'), [line]);
  assert.deepEqual(pageOf('en', '#/decide/U1-401').texts('.chist'), []);
  const pt = pageOf('pt', '#/decide/U1-101');
  assert.deepEqual(pt.texts('.chist'), [`Visto pela primeira vez em ${day('2025-11-01T12:00:00Z', 'pt')} · apareceu em 2 revisões anteriores · recusado em ${day('2025-12-01T12:30:00Z', 'pt')}: The script is going away.`]);
  assert.ok(pt.view.textContent.includes('a próxima revisão confere em: contexto no início da sessão'));
  // A member of a group shows it too, inside its case.
  const grouped = pageOf('en', '#/decide/G-1', (u, s, st) => { st.groups = [{ id: 'G-1', title: 'Same finding twice', round: 1, items: ['U1-101', 'U1-401'] }]; });
  assert.deepEqual(grouped.texts('.chist'), [line]);
});

test('a state without any of the new fields renders exactly the sections it rendered before', () => {
  const NEW = ['.hfu', '.trail', '.chist', '.fu', '#since', '.fu-nums', '.fu-lead', '.oid', '.fu-chg'];
  const headings = (page) => page.view.querySelectorAll('h1').concat(page.view.querySelectorAll('h2'), page.view.querySelectorAll('h3')).map((h) => h.textContent);
  for (const [state, lang] of [[fixture(), 'en'], [withUnknowns('pt'), 'pt']]) {
    applyScores(state);
    const page = load(board(state, { lang }));
    const routes = ['#/overview', '#/decide', '#/decide/summary'];
    for (const h of state.harnesses) routes.push(`#/h/${h.id}`, `#/h/${h.id}/diagnosis`, `#/h/${h.id}/impact`);
    for (const i of state.items) routes.push(`#/h/${i.harness}/diagnosis?item=${i.id}`, `#/decide/${i.id}`);
    for (const r of routes) {
      page.go(r);
      for (const sel of NEW) assert.equal(page.root.querySelectorAll(sel).length, 0, `${lang} ${r} ${sel}`);
      for (const word of [STRINGS[lang].fu.h, STRINGS[lang].fu.trail, STRINGS[lang].fu.runOf, STRINGS[lang].fu.kicker]) assert.ok(!page.view.textContent.includes(word), `${lang} ${r}: ${word}`);
    }
    for (const row of (page.go('#/overview'), page.root.querySelectorAll('.hrow'))) assert.ok(/^(Open|Abrir) [^.]+$/.test(row.getAttribute('aria-label')), row.getAttribute('aria-label'));
  }
  // The sections of each screen, by their headings, for the fixture: the list they had before.
  const page = load(board(fixture()));
  assert.deepEqual(headings(page), ['The harnesses of Fixture', 'Each harness, before and after', 'Unconfirmed leads', 'Log']);
  page.go('#/h/u1/impact');
  assert.deepEqual(headings(page), ['Claude Code account 1', 'No measurement for this harness', 'What enters every session']);
  assert.deepEqual(page.view.querySelectorAll('section').map((s) => s.getAttribute('class')), ['sec first']);
  page.go('#/h/u1/diagnosis');
  const titles = fixture().items.map((i) => i.title);
  assert.deepEqual(headings(page).filter((h) => !titles.includes(h)), ['Claude Code account 1', 'What is wrong, why, and how it looks after', 'Recognized defenses', 'Review progress', 'Inventory', 'Unconfirmed leads', 'Log']);
  assert.deepEqual(page.view.querySelectorAll('.case').map((c) => c.children.slice(0, 3).map((x) => x.getAttribute('class'))), [['chead', 'ctitle', 'cfind'], ['chead', 'ctitle', 'cfind']]);
  // With a measurement, the Impact tab opens on it, as before.
  const measured = load(board(withUnknowns()), { hash: '#/h/u1/impact' });
  assert.deepEqual(measured.view.querySelectorAll('section').map((s) => s.getAttribute('class')), ['sec first']);
  assert.equal(measured.view.querySelector('section .sec-k').textContent, 'Impact');
});
