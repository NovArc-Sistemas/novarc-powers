// Board client, fragment 9 of 10: the side index. On a wide screen it stays at the left of the
// page; under 1021 px it is a drawer opened from the top bar. It holds what a tab bar used to:
// the overview, the pending decisions, and every harness, accounts first and projects after, each
// with its kind marker, its grade and how many decisions it has waiting. Under the harness that is
// open it lists the three views of that harness and, for the one shown, the parts of the page:
// the file tree and the views (Explorer), the rounds and the sections (Diagnosis), the sections of
// the Impact. Every entry is a hash route, so it works the same in the three channels.

var $side = document.getElementById('side');
var sideOpen = false;

/** The sections of the page as drawn: every element with `data-toc` and an id, in page order. */
function pageSections() {
  var out = [];
  var nodes = $view.querySelectorAll('[data-toc]');
  for (var i = 0; i < nodes.length; i++) {
    var id = nodes[i].getAttribute('id');
    if (id) out.push({ id: id, label: nodes[i].getAttribute('data-toc') });
  }
  return out;
}

/** A list of links to the sections of the page shown, under the entry of its route. */
function sectionList(base) {
  var secs = pageSections();
  if (!secs.length) return null;
  var ul = el('ul', { cls: 'ix-secs', 'aria-label': T.ix.sections });
  secs.forEach(function (s) {
    ul.appendChild(el('li', null, el('a', { href: base, 'data-sec': s.id, 'data-fk': 'ix:sec:' + s.id, text: s.label })));
  });
  return ul;
}

function harnessEntry(h, sectionsBase) {
  var current = route.page === 'harness' && route.harness === h.id;
  var sc = scoresOf(h.id);
  var open = openItems(h.id).length;
  var li = el('li', { cls: 'ix-h' + (current ? ' cur' : '') });
  li.appendChild(el('a', { cls: 'ix-hl', href: R.harness(h.id), 'aria-current': current ? 'page' : null, 'data-fk': 'ix:h:' + h.id, 'data-harness': h.id },
    kindMark(h.kind, { word: false }),
    el('span', { cls: 'nm', text: h.name }),
    el('span', { cls: 'gr', title: T.sc.label, text: sc.current === null ? '-' : sc.grade }),
    open ? el('span', { cls: 'n', title: pl(T.nav.openCount, open), text: String(open) }) : null));
  if (!current || isEmptyHarness(h)) return li;
  // The three views of the harness on one row, then the parts of the one shown.
  var sub = route.sub === 'diagnosis' || route.sub === 'impact' ? route.sub : 'explorer';
  var subs = el('ul', { cls: 'ix-sub' });
  [['explorer', R.harness(h.id), T.tab.explorer], ['diagnosis', R.diagnosis(h.id), T.tab.diagnosis], ['impact', R.impact(h.id), T.tab.impact]].forEach(function (s) {
    subs.appendChild(el('li', null, el('a', { href: s[1], 'aria-current': sub === s[0] ? 'true' : null, 'data-fk': 'ix:sub:' + s[0], text: s[2] })));
  });
  li.appendChild(subs);
  append(li, [sub === 'explorer' ? treeNav(h, route, 'ix:') : sectionList(sectionsBase)]);
  return li;
}

function drawSide() {
  clear($side);
  var head = el('div', { cls: 'ix-top' }, el('span', { cls: 'lbl', text: T.ix.label }));
  var close = el('button', { type: 'button', cls: 'btn ghost small ix-close', 'data-fk': 'ix:close', text: T.ix.close });
  close.addEventListener('click', function () { setSide(false); });
  head.appendChild(close);
  $side.appendChild(head);
  var base = currentHash.split('?')[0] || R.overview();
  var top = el('ul', { cls: 'ix-main' });
  var ov = el('li', null, el('a', { href: R.overview(), 'aria-current': route.page === 'overview' ? 'page' : null, 'data-fk': 'ix:overview', text: T.nav.overview }));
  if (route.page === 'overview') append(ov, [sectionList(R.overview())]);
  top.appendChild(ov);
  var waiting = openItems().length;
  var pend = el('li', null, el('a', { href: R.pending(), 'aria-current': route.page === 'pending' ? 'page' : null, 'data-fk': 'ix:pending' }, el('span', { text: T.nav.pending }), waiting ? el('span', { cls: 'n', text: String(waiting) }) : null));
  if (route.page === 'pending') append(pend, [sectionList(R.pending())]);
  top.appendChild(pend);
  $side.appendChild(top);
  // Accounts, then projects: the two kinds of harness in two groups with a quiet line between.
  ['user', 'project'].forEach(function (kind) {
    var list = HARNESS_ORDER.filter(function (h) { return (h.kind === 'user') === (kind === 'user'); });
    if (!list.length) return;
    var ul = el('ul', { cls: 'ix-list' });
    list.forEach(function (h) { ul.appendChild(harnessEntry(h, base)); });
    $side.appendChild(el('div', { cls: 'ix-group ' + kind, 'data-kind': kind }, el('h2', { cls: 'ix-gh' }, kindMark(kind, { word: false }), lbl(T.kindGroup, kind)), ul));
  });
  spySections();
}

/** Opens or closes the index as a drawer (narrow screens). */
function setSide(open) {
  sideOpen = !!open;
  document.body.classList.toggle('ix-open', sideOpen);
  var btn = document.getElementById('ix-btn');
  if (btn) btn.setAttribute('aria-expanded', sideOpen ? 'true' : 'false');
  if (sideOpen) { var first = $side.querySelector('[aria-current="page"]') || $side.querySelector('a'); if (first) { try { first.focus(); } catch (e) { /* courtesy */ } } }
  else if (btn) { try { btn.focus({ preventScroll: true }); } catch (e) { /* courtesy */ } }
}

/** Marks the section being read in the index: the last one whose top has passed under the bar. */
function spySections() {
  var links = $side.querySelectorAll('a[data-sec]');
  if (!links.length) return;
  var byId = {};
  var nodes = $view.querySelectorAll('[data-toc]');
  for (var n = 0; n < nodes.length; n++) byId[nodes[n].getAttribute('id')] = nodes[n];
  var limit = $nav.getBoundingClientRect().bottom + 90;
  var current = null;
  for (var i = 0; i < links.length; i++) {
    var target = byId[links[i].getAttribute('data-sec')];
    if (target && (current === null || target.getBoundingClientRect().top <= limit)) current = links[i];
  }
  for (var k = 0; k < links.length; k++) {
    if (links[k] === current) links[k].setAttribute('aria-current', 'location');
    else links[k].removeAttribute('aria-current');
  }
}

var spyTimer = 0;
window.addEventListener('scroll', function () {
  if (spyTimer) return;
  spyTimer = window.setTimeout(function () { spyTimer = 0; spySections(); }, 80);
});
