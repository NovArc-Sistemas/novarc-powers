// The board with an experiment open on a harness, and the board of a measure-only run
// (references/follow-up.md, "Experiments"; run.mjs init --mode measure): board.html is parsed and
// its inline script runs against a small stand-in for the DOM, the same one board-client.test.mjs
// uses (copied here, so this file stands alone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES } from './helpers.mjs';
import { renderHtml, renderMarkdown } from '../scripts/render-board.mjs';
import { applyScores } from '../scripts/lib/scoring.mjs';
import { STRINGS } from '../scripts/lib/i18n.mjs';

const fixture = () => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'state.fixture.json'), 'utf8'));

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
/** A date the way the page writes it, so the tests do not depend on the machine's locale data or time zone. */
const day = (iso, lang) => new Date(iso).toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US', { dateStyle: 'medium' });

const UNTIL = '2026-02-09T12:00:00.000Z';
const SINCE = '2026-01-10T11:31:00.000Z';

/**
 * The fixture with an experiment open on the account u1 until UNTIL, and U1-401 (open, high) held
 * for it, the way `run.mjs build` hands it over. `note` null: the experiment is the changes the
 * last review applied, with no words of the user.
 */
function experimenting(lang, note = 'rtk em vez da saída crua do shell') {
  const st = fixture();
  st.language = lang;
  st.harnesses.find((h) => h.id === 'u1').experiment = { ...(note ? { note } : {}), since: SINCE, until: UNTIL, runId: '20260110-ab12' };
  st.items.find((i) => i.id === 'U1-401').heldForExperiment = true;
  applyScores(st);
  return st;
}

test('experiment: one calm banner on its harness, in pt and in en, with the note or the applied changes', () => {
  const banner = {
    pt: (date) => `Experimento em andamento até ${date}: rtk em vez da saída crua do shell. Mudanças no que carrega no início das sessões ficam para depois, para não confundir a medição.`,
    en: (date) => `Experiment in progress until ${date}: rtk em vez da saída crua do shell. Changes to what loads at the start of sessions wait until then, so they do not confound the measurement.`,
  };
  for (const lang of ['pt', 'en']) {
    for (const hash of ['#/h/u1', '#/h/u1/diagnosis', '#/h/u1/impact']) {
      const page = load(board(experimenting(lang), { lang }), { hash });
      const shown = page.view.querySelectorAll('.xbanner');
      assert.equal(shown.length, 1, `${lang} ${hash}: exactly one banner`);
      assert.equal(shown[0].getAttribute('role'), 'note');
      assert.equal(shown[0].textContent, banner[lang](day(UNTIL, lang)));
    }
    // The other harness has no experiment and no banner.
    const shop = load(board(experimenting(lang), { lang }), { hash: '#/h/fixture-shop' });
    assert.equal(shop.view.querySelectorAll('.xbanner').length, 0);
  }
  // No note: the experiment is what the last review applied.
  const pt = load(board(experimenting('pt', null), { lang: 'pt' }), { hash: '#/h/u1' });
  assert.equal(pt.view.querySelector('.xbanner').textContent,
    `Experimento em andamento até ${day(UNTIL, 'pt')}: as mudanças aplicadas na revisão de ${day(SINCE, 'pt')}. Mudanças no que carrega no início das sessões ficam para depois, para não confundir a medição.`);
  const en = load(board(experimenting('en', null)), { hash: '#/h/u1' });
  assert.equal(en.view.querySelector('.xbanner').textContent,
    `Experiment in progress until ${day(UNTIL, 'en')}: the changes applied in the review of ${day(SINCE, 'en')}. Changes to what loads at the start of sessions wait until then, so they do not confound the measurement.`);
});

test('experiment: a small marker in the side index and on the overview row of that harness only', () => {
  for (const [lang, word, title] of [['pt', 'experimento', 'Experimento em andamento até'], ['en', 'experiment', 'Experiment in progress until']]) {
    const page = load(board(experimenting(lang), { lang }), { hash: '#/overview' });
    const side = page.root.querySelectorAll('.side .ix-hl .xm');
    assert.deepEqual(side.map((m) => [m.closest('.ix-hl').getAttribute('data-harness'), m.textContent]), [['u1', word]]);
    assert.equal(side[0].getAttribute('title'), `${title} ${day(UNTIL, lang)}`);
    const rows = page.view.querySelectorAll('.hrow .xm');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].textContent, word);
    assert.equal(rows[0].closest('.hrow').getAttribute('href'), '#/h/u1');
  }
});

test('experiment: a held finding is not in what to decide now; it waits in its own group with the date', () => {
  const state = experimenting('pt');
  const page = load(board(state, { lang: 'pt' }), { hash: '#/pending' });
  // What is decided now: the open findings, without U1-401.
  const actionable = page.view.querySelectorAll('.psec').filter((s) => !s.classList.contains('pheld')).flatMap((s) => s.querySelectorAll('.prow').map((r) => r.getAttribute('data-item')));
  assert.deepEqual(actionable.sort(), ['SHOP-501', 'U1-101']);
  assert.equal(page.view.querySelector('.hero h1').textContent, '2 decisões esperando por você');
  // Held, apart, with the date it waits for and why.
  const held = page.view.querySelector('#p-held-u1');
  assert.ok(held, 'the held group');
  assert.deepEqual(held.querySelectorAll('.prow').map((r) => r.getAttribute('data-item')), ['U1-401']);
  assert.equal(held.getAttribute('data-toc'), `Em espera até ${day(UNTIL, 'pt')}: 1 achado`);
  assert.equal(held.querySelector('p.muted').textContent, 'São sobre o que carrega no início de toda sessão. Decidir agora confundiria a medição do experimento, então ficam para quando ele terminar.');
  // The side index counts only what is decided now.
  assert.equal(page.root.querySelector('[data-fk="ix:pending"] .n').textContent, '2');
  // Its case says it is held, and until when.
  const dg = load(board(state, { lang: 'pt' }), { hash: '#/h/u1/diagnosis?item=U1-401' });
  const tags = dg.view.querySelector('#case-U1-401 .chead').querySelectorAll('.tag').map((t) => t.textContent);
  assert.ok(tags.includes(`em espera até ${day(UNTIL, 'pt')}`), tags.join(' | '));
  // Without the experiment the flag means nothing: build drops it, and the finding is decided now.
  const plain = fixture();
  plain.items.find((i) => i.id === 'U1-401').heldForExperiment = true;
  applyScores(plain);
  const p2 = load(board(plain), { hash: '#/pending' });
  assert.equal(p2.view.querySelectorAll('.pheld').length, 0);
  // And should the flag reach the page without its experiment, the finding is still decided now.
  assert.deepEqual(p2.view.querySelectorAll('.prow').map((r) => r.getAttribute('data-item')).sort(), ['SHOP-501', 'U1-101', 'U1-401']);
});

/** The fixture as a measure-only run hands it over: no findings, every round skipped. */
function measure(lang) {
  const st = fixture();
  st.language = lang;
  st.mode = 'measure';
  st.items = [];
  st.inventory = [];
  st.rounds = st.rounds.map((r) => ({ harness: r.harness, round: r.round, status: r.status === 'not-applicable' ? 'not-applicable' : 'skipped' }));
  applyScores(st);
  return st;
}

test('measure only: no score ("not scored"), no rounds, no findings, an empty Pending, the impact as usual', () => {
  for (const [lang, notScored, console, noDiagnosis, mode] of [
    ['pt', 'não avaliado', 'Execução só de medição: sem rodadas de revisão e sem achados, por isso não há nota. O que é medido aqui é a base com que uma revisão futura compara.', 'Execução só de medição: nada foi revisado neste harness, por isso não há achados.', 'somente medição'],
    ['en', 'not scored', 'Measure-only run: no review rounds and no findings, so there is no score. What is measured here is the baseline a later review compares with.', 'Measure-only run: nothing was reviewed in this harness, so there are no findings.', 'measure only'],
  ]) {
    const st = measure(lang);
    const ov = load(board(st, { lang }), { hash: '#/overview' });
    assert.equal(ov.view.querySelector('.tot .v').textContent, notScored);
    assert.equal(ov.view.querySelector('.tot .k').textContent, console);
    assert.deepEqual(ov.view.querySelectorAll('.hrow .score, .hrow .muted.mono').map((n) => n.textContent), [notScored, notScored]);
    assert.ok(ov.root.querySelector('#foot').textContent.includes(mode));
    const h = load(board(st, { lang }), { hash: '#/h/u1' });
    assert.equal(h.view.querySelector('.mnote').textContent, `${notScored}. ${console}`);
    assert.equal(h.view.querySelectorAll('.console').length, 0, 'no score console');
    assert.ok(h.view.querySelector('.istrip'), 'the impact strip is still there');
    const dg = load(board(st, { lang }), { hash: '#/h/u1/diagnosis' });
    assert.equal(dg.view.querySelector('.empty').textContent, noDiagnosis);
    assert.equal(dg.view.querySelectorAll('#dg-rounds').length, 0, 'no rounds timeline');
    const pend = load(board(st, { lang }), { hash: '#/pending' });
    assert.equal(pend.view.querySelector('.hero h1').textContent, STRINGS[lang].pend.noneH);
    assert.equal(pend.view.querySelectorAll('.prow').length, 0);
  }
});

// ---------------------------------------------------------------------------------------------
// board.md says the same: the banner, the held group, the measure-only run
// ---------------------------------------------------------------------------------------------

test('board.md: the experiment banner under its harness, in pt and in en, with the note or the applied changes', () => {
  const name = (st) => st.harnesses.find((h) => h.id === 'u1').name;
  for (const [lang, banner, applied] of [
    ['pt', 'Experimento em andamento até 2026-02-09: rtk em vez da saída crua do shell. Mudanças no que carrega no início das sessões ficam para depois, para não confundir a medição.',
      'Experimento em andamento até 2026-02-09: as mudanças aplicadas na revisão de 2026-01-10. Mudanças no que carrega no início das sessões ficam para depois, para não confundir a medição.'],
    ['en', 'Experiment in progress until 2026-02-09: rtk em vez da saída crua do shell. Changes to what loads at the start of sessions wait until then, so they do not confound the measurement.',
      'Experiment in progress until 2026-02-09: the changes applied in the review of 2026-01-10. Changes to what loads at the start of sessions wait until then, so they do not confound the measurement.'],
  ]) {
    const st = experimenting(lang);
    const md = renderMarkdown(st, lang);
    // Once, in the section of its harness, right after the header lines.
    assert.equal(md.split(banner).length - 1, 1, banner);
    const section = md.slice(md.indexOf(`\n## ${name(st)}\n`));
    assert.ok(section.indexOf(banner) > 0 && section.indexOf(banner) < section.indexOf(`### ${STRINGS[lang].md.scoresByRound}`), 'in the u1 section, before its rounds');
    assert.ok(renderMarkdown(experimenting(lang, null), lang).includes(`\n${applied}\n`), applied);
    // No experiment, no banner.
    const plain = fixture();
    applyScores(plain);
    assert.ok(!renderMarkdown(plain, lang).includes(banner.slice(0, 20)));
  }
});

test('board.md: a held finding leaves what to decide now and waits in its own group with the date, in pt and in en', () => {
  for (const [lang, heading, tagText] of [
    ['pt', 'Em espera até 2026-02-09: 1 achado', 'em espera até 2026-02-09'],
    ['en', 'Held until 2026-02-09: 1 finding', 'held until 2026-02-09'],
  ]) {
    const T = STRINGS[lang];
    const st = experimenting(lang);
    const u1 = st.harnesses.find((h) => h.id === 'u1');
    const item = st.items.find((i) => i.id === 'U1-401');
    const md = renderMarkdown(st, lang);
    const pending = md.slice(md.indexOf(`## ${T.md.pending}\n`), md.indexOf(`\n## ${u1.name}\n`));
    assert.ok(!pending.includes('--target U1-401 '), 'no decide command for the held finding');
    assert.ok(pending.includes('--target U1-101 '), 'the other open findings are still to decide');
    assert.ok(pending.includes(`### ${u1.name}: ${heading}\n\n${T.xp.heldSub}\n\n- **U1-401** (${T.severity[item.severity]}) ${item.title}\n`), pending);
    // Its row in the items table says what it waits for.
    assert.ok(md.includes(`| U1-401 | ${T.severity[item.severity]} | ${T.status.open} (${tagText}) |`));
    // The open count of the fleet table leaves it out, the way the page does.
    const fleetRow = (text) => text.split('\n').find((l) => l.startsWith(`| ${u1.name} |`)).split('|').slice(-2, -1)[0].trim();
    const plain = fixture();
    applyScores(plain);
    assert.equal(Number(fleetRow(md)), Number(fleetRow(renderMarkdown(plain, lang))) - 1);
  }
  // Without its experiment the flag means nothing: the finding is decided now, nothing is held.
  const loose = fixture();
  loose.items.find((i) => i.id === 'U1-401').heldForExperiment = true;
  applyScores(loose);
  const md = renderMarkdown(loose, 'en');
  assert.ok(md.includes('--target U1-401 '));
  assert.ok(!md.includes('Held until'));
  assert.ok(!md.includes('(held until'));
});

test('board.md of a measure-only run: not scored, no rounds, a note that nothing was reviewed, in pt and in en', () => {
  for (const lang of ['pt', 'en']) {
    const T = STRINGS[lang];
    const st = measure(lang);
    const md = renderMarkdown(st, lang);
    assert.ok(md.includes(`${T.by.mode}: ${T.modeName.measure}`));
    for (const h of st.harnesses) {
      assert.ok(md.includes(`| ${h.name} | ${T.harnessKind[h.kind]} | ${T.ms.notScored} | ${T.ms.notScored} | ${T.ms.notScored} | - | - | 0 |`), `fleet row of ${h.id}`);
    }
    assert.equal(md.split(`${T.sc.label}: ${T.ms.notScored}. ${T.ms.console}`).length - 1, st.harnesses.length);
    assert.equal(md.split(T.ms.noDiagnosis).length - 1, st.harnesses.length);
    assert.ok(!md.includes(`### ${T.md.scoresByRound}`), 'no rounds');
    assert.ok(!md.includes(T.md.noItems));
    assert.ok(md.includes(T.md.pendingNone));
  }
  assert.ok(renderMarkdown(measure('pt'), 'pt').includes('não avaliado') && !renderMarkdown(measure('pt'), 'pt').includes('sem nota'));
});
