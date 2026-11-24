// Board client, fragment 3 of 10: boot data, DOM helpers, indexes over the state, and what the
// state says about each item (the board only shows it).
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
  // A share of something that was not measured is not 0%.
  if (countOf(part) === null || countOf(whole) === null) return '-';
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

/** The page's formatters, in the shape the wording helpers of the first fragment take (followUpLine, historyLine). */
var FMT = { date: function (iso) { return fmtDate(iso); }, plural: pl, fill: tx, label: lbl };

/** A number with at most one decimal, the way the language writes it. */
function fmtNum1(n) { return (Math.round(n * 10) / 10).toLocaleString(LOCALE, { maximumFractionDigits: 1 }); }

function signOf(n) { return n > 0 ? '+' : n < 0 ? '-' : ''; }

/** A change in percent with its sign ("-17%", "+38.7%"), or "-" when it cannot be told. */
function fmtSignedPct(pct) { return countOf(pct) === null ? '-' : signOf(pct) + fmtNum1(Math.abs(pct)) + '%'; }

/** A change in tokens with its sign, in the compact form of fmtTokens. */
function fmtSignedTokens(n) { return countOf(n) === null ? '-' : signOf(n) + fmtTokens(Math.abs(n)); }

/**
 * A value of a comparable metric in its unit: the compact number of the Impact tab for tokens and
 * characters per session, a percentage for a share. Null when it was not measured.
 */
function fmtMetric(v, unit) {
  if (countOf(v) === null) return null;
  return unit === 'percent' ? fmtNum1(v) + '%' : fmtTokens(v);
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

// --- routes (parseRoute, which reads them back, is in the first fragment) --------------------

function enc(s) { return encodeURIComponent(String(s)); }
var R = {
  overview: function () { return '#/overview'; },
  harness: function (hid) { return '#/h/' + enc(hid); },
  diagnosis: function (hid, itemId) { return '#/h/' + enc(hid) + '/diagnosis' + (itemId ? '?item=' + enc(itemId) : ''); },
  /** `focus` is `<itemId>.<change>`: the change the file viewer highlights (`?c=`). */
  file: function (hid, fid, focus) { return '#/h/' + enc(hid) + '/file/' + enc(fid) + (focus ? '?c=' + enc(focus) : ''); },
  view: function (hid, name) { return '#/h/' + enc(hid) + '/view/' + enc(name); },
  impact: function (hid) { return '#/h/' + enc(hid) + '/impact'; },
  pending: function () { return '#/pending'; },
  item: function (itemId) { var i = ITEM[itemId]; return i ? R.diagnosis(i.harness, i.id) : '#/overview'; },
};

// --- what the state says --------------------------------------------------------------------

var scoreCache = {};
var QUEUE = pendingQueue(ST);

/** The status of an item and the question waiting on it, as the state records them. */
function eff(item) { return { status: item.status, asked: !!item.question, question: item.question || '' }; }

/** Scores of one harness, from the statuses the state records. */
function scoresOf(hid) {
  if (!scoreCache[hid]) {
    var s = Scoring.scoreHarness({ rounds: ST.rounds, items: ST.items || [] }, hid);
    var stored = HARNESS[hid].scores || {};
    s.previous = stored.previous === undefined ? null : stored.previous;
    scoreCache[hid] = s;
  }
  return scoreCache[hid];
}

function isOpen(item) { return item.status === 'open'; }
function openItems(hid) { return (ST.items || []).filter(function (i) { return (!hid || i.harness === hid) && isOpen(i); }); }

function countBy(items) {
  var c = { open: 0, approved: 0, 'in-progress': 0, fixed: 0, failed: 0, declined: 0, deferred: 0, ok: 0, 'not-applicable': 0 };
  items.forEach(function (i) { c[i.status] = (c[i.status] || 0) + 1; });
  return c;
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
    button.textContent = ok ? T.copy.done : T.copy.failed;
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
