// Board client, fragment 3 of 9: boot data, DOM helpers, indexes over the state, and the store
// that overlays the decisions made on this page.
//
// Every string that comes from the state is untrusted: it only ever reaches the DOM through
// textContent (the `el` helper) or an attribute set with setAttribute, never through markup.

var BOOT = JSON.parse(document.getElementById('board-data').textContent);
var ST = BOOT.state;
var T = BOOT.t;
var LOCALE = BOOT.locale;
var RUN_ID = ST.run.id;
var SVG_NS = 'http://www.w3.org/2000/svg';
var SEVERITIES = ['critical', 'high', 'medium', 'low'];
var SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// --- DOM ------------------------------------------------------------------------------------

function append(node, children) {
  for (var i = 0; i < children.length; i++) {
    var c = children[i];
    if (c === null || c === undefined || c === false || c === '') continue;
    if (Array.isArray(c)) append(node, c);
    else node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

function setAttrs(node, attrs) {
  if (!attrs) return;
  for (var k in attrs) {
    var v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === 'cls') node.setAttribute('class', v);
    else if (k === 'text') node.textContent = v;
    else if (k === 'on') { for (var ev in v) node.addEventListener(ev, v[ev]); }
    else if (k === 'style') { for (var p in v) node.style.setProperty(p, v[p]); }
    else node.setAttribute(k, v === true ? '' : String(v));
  }
}

/** el('div', { cls: 'x', text: 'y' }, child, 'text', [more]) */
function el(tag, attrs) {
  var n = document.createElement(tag);
  setAttrs(n, attrs);
  return append(n, Array.prototype.slice.call(arguments, 2));
}

function svg(tag, attrs) {
  var n = document.createElementNS(SVG_NS, tag);
  setAttrs(n, attrs);
  return append(n, Array.prototype.slice.call(arguments, 2));
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

/** A link only for http(s) URLs; anything else is shown as text. */
function extLink(url, cls) {
  var text = String(url);
  if (!/^https?:\/\/[^\s]+$/i.test(text)) return el('span', { cls: cls, text: text });
  return el('a', { cls: cls, href: text, target: '_blank', rel: 'noopener noreferrer', text: text.replace(/^https?:\/\//i, '') });
}

// --- text -----------------------------------------------------------------------------------

function tx(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, function (m, k) { return vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m; });
}

function pl(forms, n, vars) {
  var all = { n: fmtInt(n) };
  if (vars) for (var k in vars) all[k] = vars[k];
  return tx(forms && typeof forms === 'object' ? (n === 1 ? forms.one : forms.other) : forms, all);
}

function lbl(map, v) { return map && Object.prototype.hasOwnProperty.call(map, v) ? map[v] : String(v === undefined || v === null ? '' : v); }

/** A template split around one placeholder, so that the value can be its own element. */
function txNodes(tpl, key, node) {
  var parts = String(tpl).split('{' + key + '}');
  var out = [];
  parts.forEach(function (p, i) { if (i) out.push(node); if (p) out.push(p); });
  return out;
}

function fmtInt(n) { return typeof n === 'number' && isFinite(n) ? Math.round(n).toLocaleString(LOCALE) : '-'; }

/** Floors like the renderer: a score shown is never rounded up. */
function fmtScore(n) {
  if (n === null || n === undefined) return '-';
  return (Math.floor(n * 10 + 1e-7) / 10).toLocaleString(LOCALE, { maximumFractionDigits: 1 });
}

function fmtTokens(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '-';
  var one = function (v, unit) { return (Math.floor(v * 10 + 1e-7) / 10).toLocaleString(LOCALE, { maximumFractionDigits: 1 }) + unit; };
  var abs = Math.abs(n);
  if (abs >= 1e9) return one(n / 1e9, T.tokenUnits.b);
  if (abs >= 1e6) return one(n / 1e6, T.tokenUnits.m);
  if (abs >= 1e3) return one(n / 1e3, T.tokenUnits.k);
  return fmtInt(n);
}

function fmtPct(part, whole) {
  if (!whole) return '0';
  var p = part / whole * 100;
  return (p < 10 ? Math.floor(p * 10 + 1e-7) / 10 : Math.floor(p + 1e-7)).toLocaleString(LOCALE, { maximumFractionDigits: 1 });
}

function fmtBytes(n) {
  if (typeof n !== 'number') return '';
  if (n >= 1048576) return (Math.round(n / 104857.6) / 10).toLocaleString(LOCALE) + ' MB';
  if (n >= 1024) return (Math.round(n / 102.4) / 10).toLocaleString(LOCALE) + ' KB';
  return fmtInt(n) + ' B';
}

function fmtDate(iso, withTime) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || '');
  try { return withTime ? d.toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }) : d.toLocaleDateString(LOCALE, { dateStyle: 'medium' }); } catch (e) { return d.toISOString().slice(0, withTime ? 16 : 10).replace('T', ' '); }
}

// --- indexes --------------------------------------------------------------------------------

var HARNESS = {};
ST.harnesses.forEach(function (h) { HARNESS[h.id] = h; });
/** Tab order: user harnesses first, then projects, each in state order. */
var HARNESS_ORDER = ST.harnesses.filter(function (h) { return h.kind === 'user'; }).concat(ST.harnesses.filter(function (h) { return h.kind !== 'user'; }));
var ITEM = {};
(ST.items || []).forEach(function (i) { ITEM[i.id] = i; });
var GROUP = {};
(ST.groups || []).forEach(function (g) { GROUP[g.id] = g; });
var ACCOUNT_OF = {};
((ST.accounts || {}).list || []).forEach(function (a) { ACCOUNT_OF[a.harness] = a; });

var ANCH = Anchors.anchorState(ST);
var FILE = {};
(ST.files || []).forEach(function (f) { FILE[f.id] = f; });
ANCH.virtual.forEach(function (f) { FILE[f.id] = f; });

function harnessName(id) { return HARNESS[id] ? HARNESS[id].name : String(id); }
function itemsOf(hid) { return (ST.items || []).filter(function (i) { return i.harness === hid; }); }
function filesOf(hid) {
  return (ST.files || []).concat(ANCH.virtual).filter(function (f) { return f.harness === hid; });
}
function whereOf(hid, key) { return (ST[key] || []).filter(function (x) { return x.harness === hid; }); }
function providerOf(h) {
  if (h.provider) return h.provider;
  var a = ACCOUNT_OF[h.id];
  return a ? a.provider : null;
}
function windowDays() {
  if (ST.run.windowDays) return ST.run.windowDays;
  var d = 0;
  ST.harnesses.forEach(function (h) { if (h.impact && h.impact.windowDays > d) d = h.impact.windowDays; });
  return d || 30;
}
function anchorOf(fileId) {
  if (ANCH.files[fileId]) return ANCH.files[fileId];
  var f = FILE[fileId];
  return f ? (ANCH.files[fileId] = Anchors.anchorFile(f, [])) : null;
}

// --- routes ---------------------------------------------------------------------------------

function enc(s) { return encodeURIComponent(String(s)); }
var R = {
  overview: function () { return '#/overview'; },
  harness: function (hid) { return '#/h/' + enc(hid); },
  diagnosis: function (hid, itemId) { return '#/h/' + enc(hid) + '/diagnosis' + (itemId ? '?item=' + enc(itemId) : ''); },
  file: function (hid, fid, at) { return '#/h/' + enc(hid) + '/file/' + enc(fid) + (at ? '?at=' + enc(at) : ''); },
  view: function (hid, name) { return '#/h/' + enc(hid) + '/view/' + enc(name); },
  impact: function (hid) { return '#/h/' + enc(hid) + '/impact'; },
  decide: function (target) { return '#/decide' + (target ? '/' + enc(target) : ''); },
  item: function (itemId) { var i = ITEM[itemId]; return i ? R.diagnosis(i.harness, i.id) : '#/overview'; },
};

function parseRoute(hash) {
  var raw = String(hash || '').replace(/^#\/?/, '');
  var q = {};
  var qi = raw.indexOf('?');
  if (qi >= 0) {
    raw.slice(qi + 1).split('&').forEach(function (kv) {
      var p = kv.split('=');
      try { q[decodeURIComponent(p[0])] = decodeURIComponent(p.slice(1).join('=')); } catch (e) { /* ignore a broken pair */ }
    });
    raw = raw.slice(0, qi);
  }
  var seg = raw.split('/').filter(Boolean).map(function (s) { try { return decodeURIComponent(s); } catch (e) { return s; } });
  if (seg[0] === 'h' && seg[1]) return { page: 'harness', harness: seg[1], sub: seg[2] || 'explorer', arg: seg.slice(3).join('/') || null, q: q };
  if (seg[0] === 'decide') return { page: 'decide', arg: seg.slice(1).join('/') || null, q: q };
  return { page: 'overview', q: q };
}

// --- store: decisions made on this page, laid over the state ------------------------------------

var localDecisions = [];
var freshIds = {};
var sendState = {};
var overlay = overlayFor(ST, [], {});
var scoreCache = {};
var QUEUE = decisionQueue(ST);

function recompute() {
  overlay = overlayFor(ST, localDecisions, freshIds);
  scoreCache = {};
}

function eff(item) { return effectiveOf(item, overlay); }

/** Scores of one harness as the page shows them: the state's statuses moved by local decisions. */
function scoresOf(hid) {
  if (!scoreCache[hid]) {
    var s = Scoring.scoreHarness({ rounds: ST.rounds, items: effectiveItems(ST, overlay) }, hid);
    var stored = HARNESS[hid].scores || {};
    s.previous = stored.previous === undefined ? null : stored.previous;
    scoreCache[hid] = s;
  }
  return scoreCache[hid];
}

function isOpen(item) { return eff(item).status === 'open'; }
function openItems(hid) { return (ST.items || []).filter(function (i) { return (!hid || i.harness === hid) && isOpen(i); }); }
function canDecide(item) { return item.status === 'open' || DECIDABLE[item.status] === true; }

function countBy(items) {
  var c = { open: 0, approved: 0, 'in-progress': 0, fixed: 0, failed: 0, declined: 0, deferred: 0, ok: 0, 'not-applicable': 0 };
  items.forEach(function (i) { var s = eff(i).status; c[s] = (c[s] || 0) + 1; });
  return c;
}

/** Local decisions that are not in the state yet and still hold: what the user has to hand over. */
function pendingDecisions() { return overlay.held; }

function newId() {
  var bytes = new Uint8Array(16);
  try { window.crypto.getRandomValues(bytes); } catch (e) { for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256); }
  return uuidFromBytes(bytes);
}

// --- details that remember being open across redraws -----------------------------------------

var openKeys = {};
function fold(key, cls, summaryChildren, body, openByDefault) {
  var isOpenNow = Object.prototype.hasOwnProperty.call(openKeys, key) ? openKeys[key] : !!openByDefault;
  var d = el('details', { cls: cls, open: isOpenNow }, el('summary', null, summaryChildren));
  append(d, [body]);
  d.addEventListener('toggle', function () { openKeys[key] = d.open; });
  return d;
}

function copyText(text, button) {
  var done = function (ok) {
    if (!button) return;
    var old = button.getAttribute('data-label') || button.textContent;
    button.setAttribute('data-label', old);
    button.textContent = ok ? T.send.copied : T.send.copyFailed;
    window.setTimeout(function () { button.textContent = old; }, 1800);
  };
  var legacy = function () {
    var ta = el('textarea', { 'aria-hidden': 'true', style: { position: 'fixed', top: '-1000px', opacity: '0' } });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    done(ok);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(function () { done(true); }, legacy); return; }
  } catch (e) { /* fall through */ }
  legacy();
}
