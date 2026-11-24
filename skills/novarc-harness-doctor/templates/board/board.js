// Board client, fragment 10 of 10: the entry point: the top bar, the hash router, the events and
// the boot sequence. The board only shows; deciding happens in the chat with the agent.
//
// Routes (hash-based, so links work from disk and inside a frame):
//   #/overview   #/h/<harnessId>[/explorer]   #/h/<harnessId>/diagnosis[?item=<id>]   #/h/<harnessId>/impact
//   #/h/<harnessId>/file/<fileId>[?c=<itemId>.<change>]   #/h/<harnessId>/view/<name>   #/pending
// The route the page is on is remembered per run and reopened when the URL names none: a reload
// inside a frame (a board published as an Artifact) loses the hash.

var $nav = document.getElementById('nav');
var $view = document.getElementById('view');
var routeStore = safeStore(function () { return window.localStorage; });
var START_HASH = routeToRestore(window.location.hash, routeStore.get(routeKey(RUN_ID)), knownRoutes()) || window.location.hash;
var route = parseRoute(START_HASH);
var currentHash = START_HASH;
var wantFocus = null;

var refresher = createRefresh({
  onStale: function () { window.location.reload(); },
});

// --- top bar ---------------------------------------------------------------------------------

function logo() {
  var navy = '#04122E';
  var blue = '#0A6CFF';
  var word = function (x, anchor, fill, text) {
    return svg('text', { x: x, y: 38, 'text-anchor': anchor, 'font-family': 'Sora, Helvetica, sans-serif', 'font-size': 28, 'font-weight': 700, 'letter-spacing': '-0.98', fill: fill, text: text });
  };
  return svg('svg', { 'class': 'logo', viewBox: '0 0 181 56', role: 'img', 'aria-label': 'NovArc' },
    svg('path', { d: 'M19 6 H6 V50 H19 V44 H12 V12 H19 Z', fill: navy }),
    svg('path', { d: 'M162 6 H175 V50 H162 V44 H169 V12 H162 Z', fill: navy }),
    word(85, 'end', navy, 'Nov'),
    svg('path', { d: 'M95 12 H103 L95 44 H87 Z', fill: blue }),
    word(105, 'start', blue, 'Arc'));
}

/** Where the reader is, in a few words: shown in the bar on narrow screens, where the index is folded. */
function crumb() {
  if (route.page === 'pending') return el('span', { cls: 'crumb', text: T.nav.pending });
  if (route.page === 'harness' && HARNESS[route.harness]) return el('span', { cls: 'crumb' }, harnessRef(route.harness, false));
  return el('span', { cls: 'crumb', text: T.nav.overview });
}

/**
 * The bar: the logo (to the overview), the button that opens the index on a narrow screen, where
 * the reader is, and the pending decisions. The harnesses are in the side index, not here.
 */
function drawNav() {
  clear($nav);
  var btn = el('button', { type: 'button', cls: 'btn small ix-btn', id: 'ix-btn', 'aria-controls': 'side', 'aria-expanded': sideOpen ? 'true' : 'false', 'data-fk': 'ix:open' },
    el('span', { cls: 'bars', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')), el('span', { cls: 'ix-w', text: T.ix.open }));
  btn.addEventListener('click', function () { setSide(!sideOpen); });
  var waiting = openItems().length;
  $nav.appendChild(el('div', { cls: 'nav-in' },
    el('a', { cls: 'home', href: R.overview(), 'aria-label': T.nav.overview, 'data-fk': 'nav:home' }, logo()),
    btn, crumb(),
    el('a', { cls: 'tab pend-tab', href: R.pending(), 'aria-current': route.page === 'pending' ? 'page' : null, 'data-fk': 'tab:pending' },
      el('span', { cls: 's' }), T.nav.pending, el('span', { cls: 'n', text: String(waiting) }, el('span', { cls: 'sr', text: ' ' + pl(T.nav.openCount, waiting) })))));
}

// --- render ---------------------------------------------------------------------------------

function render(opts) {
  var o = opts || {};
  var active = document.activeElement;
  var fk = wantFocus || (active && active.getAttribute ? active.getAttribute('data-fk') : null);
  wantFocus = null;
  var y = window.pageYOffset;
  drawNav();
  clear($view);
  $view.appendChild(route.page === 'harness' ? viewHarness(route) : route.page === 'pending' ? viewPending() : viewOverview());
  drawSide();
  layoutNotes();
  watchNotes();
  if (o.keepScroll) window.scrollTo(0, y);
  if (fk) {
    var again = document.querySelector('[data-fk="' + String(fk).replace(/["\\]/g, '\\$&') + '"]');
    if (again) { try { again.focus({ preventScroll: true }); } catch (e) { again.focus(); } }
  }
}

var noteObserver = window.ResizeObserver ? new window.ResizeObserver(function () { layoutNotes(); }) : null;

/** A card that grows (an expander, a note field) moves the cards below it. */
function watchNotes() {
  if (!noteObserver) return;
  noteObserver.disconnect();
  var notes = document.querySelectorAll('.fv-note');
  for (var i = 0; i < notes.length; i++) noteObserver.observe(notes[i]);
}

function redraw() { render({ keepScroll: true }); }

function reveal(node, block) {
  if (!node) return false;
  try { node.scrollIntoView({ block: block || 'start', behavior: 'instant' }); } catch (e) { node.scrollIntoView(block !== 'center'); }
  return true;
}

/** Scrolls to a node only when it is not already in sight (a focused change next to its card). */
function revealIfHidden(node) {
  if (!node) return false;
  var box = node.getBoundingClientRect();
  var bar = $nav.getBoundingClientRect().bottom || 0;
  if (box.top >= bar && box.bottom <= (window.innerHeight || 0) && box.bottom > box.top) return true;
  return reveal(node, 'center');
}

/** What a remembered route may point at in this state (routeExists, in the first fragment). */
function knownRoutes() {
  var known = { harnesses: {}, files: {}, views: {} };
  for (var hid in HARNESS) known.harnesses[hid] = true;
  for (var fid in FILE) known.files[fid] = FILE[fid].harness;
  for (var name in VIEWS) known.views[name] = true;
  return known;
}

/** Keeps the route for the next load. Storage may be missing or refuse: nothing depends on it. */
function rememberRoute(hash) {
  var h = String(hash || '').slice(0, 2) === '#/' ? String(hash) : R.overview();
  if (h.length <= ROUTE_MAX) routeStore.set(routeKey(RUN_ID), h);
}

function onRoute(hash, initial) {
  var prev = route;
  route = parseRoute(hash);
  currentHash = hash;
  rememberRoute(hash);
  var sameHarness = !initial && prev.page === 'harness' && route.page === 'harness' && prev.harness === route.harness;
  var sameFile = sameHarness && prev.sub === 'file' && route.sub === 'file' && prev.arg === route.arg;
  render({ keepScroll: sameHarness });
  var focus = route.page === 'harness' && route.sub === 'file' ? focusOf(route) : null;
  if (focus && (sameFile ? revealIfHidden : function (n) { return reveal(n, 'center'); })(document.getElementById('hunk-' + focus))) return;
  if (sameFile) return;
  if (route.page === 'harness' && route.q.item && reveal(document.getElementById('case-' + route.q.item), 'start')) return;
  if (sameHarness) {
    // Keep the reader where they are, unless the part that changed is out of sight.
    var tabs = document.getElementById('subtabs');
    var title = document.getElementById('fv-title');
    var anchor = title && window.matchMedia('(max-width: 900px)').matches ? title : tabs;
    if (anchor) {
      var box = anchor.getBoundingClientRect();
      if (box.top < 60 || box.top > window.innerHeight - 120) window.scrollBy(0, box.top - 76);
    }
    return;
  }
  if (initial) {
    // A link straight to a file, a view or the diagnosis opens on that part of the harness tab.
    var sub = route.page === 'harness' && route.sub !== 'explorer' ? document.getElementById('subtabs') : null;
    if (sub) window.scrollBy(0, sub.getBoundingClientRect().top - 76);
    return;
  }
  window.scrollTo(0, 0);
  if (prev.page !== route.page || prev.harness !== route.harness) { try { $view.focus({ preventScroll: true }); } catch (e) { /* focus is a courtesy */ } }
}

function navigate(hash) {
  if (hash === currentHash) { onRoute(hash); return; }
  currentHash = hash;
  try { window.location.hash = hash; } catch (e) { /* a frame may refuse; the page still routes in memory */ }
  onRoute(hash);
}

/** Leaves the focused change of the file viewer, if there is one. */
function clearFocus() {
  if (route.page !== 'harness' || route.sub !== 'file' || !focusOf(route)) return false;
  navigate(R.file(route.harness, route.arg, null));
  return true;
}

// --- events ---------------------------------------------------------------------------------

document.addEventListener('click', function (e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  var t = e.target && e.target.closest ? e.target : null;
  if (t && sideOpen && t.closest('#scrim')) { setSide(false); return; }
  // A section of the page shown: scroll to it, the route stays as it is.
  var sec = t ? t.closest('a[data-sec]') : null;
  if (sec && sec.getAttribute('href') === currentHash.split('?')[0]) {
    e.preventDefault();
    reveal(document.getElementById(sec.getAttribute('data-sec')), 'start');
    if (sideOpen) setSide(false);
    return;
  }
  var a = t ? t.closest('a[href^="#/"]') : null;
  if (a) {
    e.preventDefault();
    if (sideOpen) setSide(false);
    navigate(a.getAttribute('href'));
    return;
  }
  // A click on empty space in the file viewer leaves the focused change.
  if (t && t.closest('#view') && !t.closest('.fv-note, .fv-code.hunk, .fv-focus, a, button, summary, input, textarea, label, select')) clearFocus();
});

window.addEventListener('hashchange', function () {
  if (window.location.hash !== currentHash) onRoute(window.location.hash);
});

document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape' && e.key !== 'Esc') return;
  if (sideOpen) { setSide(false); return; }
  if (clearFocus()) e.preventDefault();
});

window.addEventListener('resize', function () {
  layoutNotes();
  if (sideOpen && window.matchMedia('(min-width: 1021px)').matches) setSide(false);
});
document.addEventListener('toggle', layoutNotes, true);
if (document.fonts && document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(layoutNotes);

document.getElementById('skip').addEventListener('click', function (e) {
  e.preventDefault();
  try { $view.focus(); } catch (err) { /* nothing to do */ }
});

// --- boot -----------------------------------------------------------------------------------

// The mode and the system of the run live here, out of the way of what drives a decision.
append(document.getElementById('foot'), [
  el('span', { text: tx(T.footer, { version: ST.skillVersion, run: RUN_ID }) + ' · ' + lbl(T.modeName, ST.mode) + ' · ' + ST.environment.os }),
  el('span', { cls: 'made' }, el('span', { cls: 'glyph' }),
    /^https:\/\//.test(String(BOOT.home || '')) ? el('a', { href: BOOT.home, target: '_blank', rel: 'noopener noreferrer', text: T.madeWith }) : T.madeWith),
]);
onRoute(START_HASH, true);
refresher.start();
