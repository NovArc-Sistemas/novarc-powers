// Board client, fragment 9 of 9: the entry point: sticky navigation, the fixed tray, the hash
// router, the decision flow and the boot sequence.
//
// Routes (hash-based, so links work from disk and inside a frame):
//   #/overview   #/h/<harnessId>[/explorer]   #/h/<harnessId>/diagnosis[?item=<id>]   #/h/<harnessId>/impact
//   #/h/<harnessId>/file/<fileId>[?at=<itemId>.<change>]   #/h/<harnessId>/view/<name>
//   #/decide   #/decide/<target>   #/decide/summary

var MAX_TABS = 6;
var $nav = document.getElementById('nav');
var $view = document.getElementById('view');
var $tray = document.getElementById('tray');
var route = parseRoute(window.location.hash);
var currentHash = window.location.hash;
var channelKind = 'detecting';
var wantFocus = null;
var pendingRedraw = false;
var pendingReload = false;

var channel = createChannel({
  hint: BOOT.channel,
  runId: RUN_ID,
  onKind: function (kind) {
    channelKind = kind;
    // What was decided while the page was still finding its channel now has a definite fate.
    if (kind === 'file') for (var id in sendState) if (sendState[id] === 'sending') sendState[id] = 'paste';
    softRedraw();
  },
  onRestore: function (list) {
    var before = overlay.held.map(function (d) { return d.id; }).join(',');
    list.forEach(function (d) {
      if (!localDecisions.some(function (x) { return x.id === d.id; })) localDecisions.push(d);
      if (channelKind === 'file' && !sendState[d.id]) sendState[d.id] = 'paste';
    });
    recompute();
    if (overlay.held.map(function (d) { return d.id; }).join(',') !== before) softRedraw();
  },
  onStale: function () {
    if (isTyping()) pendingReload = true; else window.location.reload();
  },
});

function isTyping() {
  var a = document.activeElement;
  return !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'checkbox'));
}

// --- navigation bar -------------------------------------------------------------------------

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

function harnessTab(h) {
  var current = route.page === 'harness' && route.harness === h.id;
  var open = openItems(h.id).length;
  var p = h.kind === 'user' ? providerOf(h) : null;
  // The provider is shown beside the name only when the name does not already say it.
  if (p && h.name.toLowerCase().indexOf(lbl(T.provider, p).toLowerCase()) >= 0) p = null;
  return el('a', { cls: 'tab', href: R.harness(h.id), 'aria-current': current ? 'page' : null, 'data-fk': 'tab:' + h.id },
    el('span', { cls: 's' }), h.name, p ? el('small', { text: lbl(T.provider, p) }) : null,
    open ? el('span', { cls: 'dot', title: pl(T.nav.openCount, open) }, el('span', { cls: 'sr', text: pl(T.nav.openCount, open) })) : null);
}

function drawNav() {
  clear($nav);
  var tabs = el('div', { cls: 'tabs' });
  tabs.appendChild(el('a', { cls: 'tab', href: R.overview(), 'aria-current': route.page === 'overview' ? 'page' : null, 'data-fk': 'tab:overview' }, el('span', { cls: 's' }), T.nav.overview));
  var active = route.page === 'harness' ? HARNESS[route.harness] : null;
  var shown = HARNESS_ORDER.slice(0, MAX_TABS);
  var rest = HARNESS_ORDER.slice(MAX_TABS);
  if (active && rest.indexOf(active) >= 0) {
    rest = [shown[MAX_TABS - 1]].concat(rest.filter(function (h) { return h !== active; }));
    shown = shown.slice(0, MAX_TABS - 1).concat([active]);
  }
  shown.forEach(function (h) { tabs.appendChild(harnessTab(h)); });
  var menu = el('div', { cls: 'more-menu' });
  rest.forEach(function (h) { menu.appendChild(harnessTab(h)); });
  var moreLabel = el('span');
  var more = el('details', { cls: 'more', id: 'more' }, el('summary', { cls: 'tab', 'data-fk': 'tab:more' }, el('span', { cls: 's' }), moreLabel), menu);
  var open = openItems().length;
  // Until the page knows its channel, the status shows the one the renderer was told to expect.
  var label = channelKind === 'detecting' ? (T.channel[BOOT.channel] || T.channel.detecting) : T.channel[channelKind];
  var chan = el('span', { cls: 'chan ' + channelKind, role: 'status', title: label, 'aria-label': label }, el('i'), el('span', { text: label }));
  $nav.appendChild(el('div', { cls: 'nav-in' }, logo(), tabs, more,
    el('a', { cls: 'tab', href: R.decide(), 'aria-current': route.page === 'decide' ? 'page' : null, 'data-fk': 'tab:decide' },
      el('span', { cls: 's' }), T.nav.decide, el('span', { cls: 'n', text: String(open) }, el('span', { cls: 'sr', text: ' ' + pl(T.nav.openCount, open) }))),
    chan));
  // Tabs that do not fit go into the menu, last first; the overview and the current tab stay.
  // The menu button is measured with its final label, since its width takes room from the tabs.
  var fits = function () {
    moreLabel.textContent = pl(T.nav.more, Math.max(1, menu.children.length));
    return tabs.scrollWidth <= tabs.clientWidth + 1;
  };
  // The status gives up its text (it stays as a dot with a title) before any tab leaves the row.
  var roomy = function () { return tabs.scrollWidth <= tabs.clientWidth + 1; };
  if (!menu.firstChild) {
    more.style.display = 'none';
    if (!roomy()) chan.classList.add('compact');
    if (roomy()) { more.parentNode.removeChild(more); return; }
    more.style.display = '';
  } else if (!fits()) chan.classList.add('compact');
  while (!fits()) {
    var last = tabs.lastElementChild;
    if (last && last.getAttribute('aria-current') === 'page') last = last.previousElementSibling;
    if (!last || last === tabs.firstElementChild) break;
    menu.insertBefore(last, menu.firstChild);
  }
  if (!menu.firstChild) { more.parentNode.removeChild(more); return; }
  if (menu.querySelector('[aria-current="page"]')) more.firstChild.setAttribute('aria-current', 'page');
}

// --- tray -----------------------------------------------------------------------------------

function drawTray() {
  clear($tray);
  var items = ST.items || [];
  var c = countBy(items);
  var open = items.filter(isOpen);
  var seg = el('span', { cls: 'seg', role: 'img', 'aria-label': T.tray.severityAria });
  var tones = { critical: '#f87171', high: '#f87171', medium: '#fbbf24', low: '#6ba6ff' };
  SEVERITIES.forEach(function (sv) {
    var n = open.filter(function (i) { return i.severity === sv; }).length;
    if (n) seg.appendChild(el('i', { title: lbl(T.severity, sv) + ' ' + n, style: { flex: String(n), background: tones[sv] } }));
  });
  var counts = el('span', { cls: 'counts' });
  var count = function (n, label, always) { if (n || always) counts.appendChild(el('span', null, el('b', { text: String(n) }), ' ' + label)); };
  count(c.approved, T.tray.approved, true);
  count(c['in-progress'], T.tray.applying, true);
  count(c.fixed, T.tray.applied, true);
  count(c.declined, T.tray.declined, true);
  count(c.deferred, T.tray.deferred, false);
  count(c.failed, T.tray.failed, false);
  var acts = el('span', { cls: 'acts' });
  var pending = pendingDecisions();
  var toPaste = channelKind === 'file' ? pending : pending.filter(function (d) { return sendState[d.id] === 'failed'; });
  if (toPaste.length) {
    var copy = el('button', { type: 'button', cls: 'btn small', 'data-fk': 'tray:copy', text: pl(T.tray.commands, toPaste.length) });
    copy.addEventListener('click', function () { copyText(toPaste.map(decisionCommand).join('\n'), copy); });
    acts.appendChild(copy);
  }
  var waiting = QUEUE.filter(function (e) { return !entryHandled(e); }).length;
  acts.appendChild(waiting
    ? el('a', { cls: 'btn primary', href: R.decide(), 'data-fk': 'tray:go' }, el('span', { cls: 's' }), pl(T.tray.go, waiting))
    : el('a', { cls: 'btn', href: R.decide('summary'), 'data-fk': 'tray:go', text: T.tray.summary }));
  $tray.appendChild(el('div', { cls: 'tray-in' }, el('b', { text: pl(T.tray.toDecide, open.length) }), open.length ? seg : null, counts, acts));
}

// --- render ---------------------------------------------------------------------------------

function render(opts) {
  var o = opts || {};
  var active = document.activeElement;
  var fk = wantFocus || (active && active.getAttribute ? active.getAttribute('data-fk') : null);
  wantFocus = null;
  var y = window.pageYOffset;
  drawNav();
  drawTray();
  clear($view);
  $view.appendChild(route.page === 'harness' ? viewHarness(route) : route.page === 'decide' ? viewDecide(route) : viewOverview());
  layoutNotes();
  watchNotes();
  if (o.keepScroll) window.scrollTo(0, y);
  if (fk) {
    var again = document.querySelector('[data-fk="' + String(fk).replace(/["\\]/g, '\\$&') + '"]');
    if (again) {
      try { again.focus({ preventScroll: true }); } catch (e) { again.focus(); }
      if (again.tagName === 'TEXTAREA') { var end = again.value.length; try { again.setSelectionRange(end, end); } catch (e2) { /* not selectable */ } }
    }
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

/** Redraw now, or once the user leaves the field they are typing in. */
function softRedraw() {
  if (isTyping()) { pendingRedraw = true; return; }
  redraw();
}

function reveal(node, block) {
  if (!node) return false;
  try { node.scrollIntoView({ block: block || 'start', behavior: 'instant' }); } catch (e) { node.scrollIntoView(block !== 'center'); }
  return true;
}

function onRoute(hash, initial) {
  var prev = route;
  route = parseRoute(hash);
  currentHash = hash;
  var sameHarness = !initial && prev.page === 'harness' && route.page === 'harness' && prev.harness === route.harness;
  render({ keepScroll: sameHarness });
  if (route.page === 'harness' && route.q.at && reveal(document.getElementById('hunk-' + route.q.at), 'center')) return;
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

// --- deciding -------------------------------------------------------------------------------

function decide(target, action, note, exclude) {
  var d = makeDecision(RUN_ID, target, action, note, exclude, newId(), new Date().toISOString());
  localDecisions = localDecisions.filter(function (x) { return x.target !== target; }).concat([d]);
  freshIds[d.id] = true;
  sendState[d.id] = channelKind === 'file' ? 'paste' : 'sending';
  recompute();
  channel.remember(localDecisions);
  channel.send(d).then(function (res) {
    sendState[d.id] = res && res.ok ? 'sent' : (channelKind === 'file' ? 'paste' : 'failed');
    softRedraw();
  });
  var next = route.page === 'decide' ? afterDecision(target) : null;
  if (next) navigate(next); else redraw();
}

// --- events ---------------------------------------------------------------------------------

document.addEventListener('click', function (e) {
  var more = document.getElementById('more');
  if (more && more.open && !more.contains(e.target)) more.open = false;
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  var a = e.target && e.target.closest ? e.target.closest('a[href^="#/"]') : null;
  if (!a) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});

window.addEventListener('hashchange', function () {
  if (window.location.hash !== currentHash) onRoute(window.location.hash);
});

document.addEventListener('focusout', function () {
  window.setTimeout(function () {
    if (isTyping()) return;
    if (pendingReload) { window.location.reload(); return; }
    if (pendingRedraw) { pendingRedraw = false; redraw(); }
  }, 0);
});

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { var more = document.getElementById('more'); if (more && more.open) { more.open = false; return; } }
  if (route.page !== 'decide' || e.ctrlKey || e.metaKey || e.altKey) return;
  var t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  var act = { a: 'approve', r: 'decline', d: 'defer', p: 'ask' }[String(e.key).toLowerCase()];
  if (act) {
    var b = document.querySelector('#dc-act [data-act="' + act + '"]');
    if (!b) return;
    e.preventDefault();
    if (act === 'ask') wantFocus = 'ta:' + b.parentNode.getAttribute('data-target');
    b.click();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    var link = document.getElementById(e.key === 'ArrowLeft' ? 'dc-prev' : 'dc-next');
    if (link) { e.preventDefault(); wantFocus = link.getAttribute('data-fk'); navigate(link.getAttribute('href')); }
  }
});

var navTimer = 0;
window.addEventListener('resize', function () {
  layoutNotes();
  window.clearTimeout(navTimer);
  navTimer = window.setTimeout(drawNav, 120);
});
document.addEventListener('toggle', layoutNotes, true);
if (document.fonts && document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(layoutNotes);

document.getElementById('skip').addEventListener('click', function (e) {
  e.preventDefault();
  try { $view.focus(); } catch (err) { /* nothing to do */ }
});

// --- boot -----------------------------------------------------------------------------------

append(document.getElementById('foot'), [
  el('span', { text: tx(T.footer, { version: ST.skillVersion, run: RUN_ID }) }),
  el('span', { cls: 'made' }, el('span', { cls: 'glyph' }),
    /^https:\/\//.test(String(BOOT.home || '')) ? el('a', { href: BOOT.home, target: '_blank', rel: 'noopener noreferrer', text: T.madeWith }) : T.madeWith),
]);
onRoute(window.location.hash, true);
channel.start();
