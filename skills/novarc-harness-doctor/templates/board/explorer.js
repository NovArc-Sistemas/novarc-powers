// Board client, fragment 7 of 10: the Explorer sub-tab: the tree by category, the file viewer
// that draws every change inside its file (with one change in focus at a time), and the views of
// `harness.elements`: the hook lifecycle, the permission lanes, and tables for the rest.

var TREE = [
  { key: 'instructions', cats: ['instructions', 'rule'] },
  { key: 'settings', cats: ['settings'], view: 'permissions' },
  { key: 'hooks', cats: ['hook'], view: 'hooks' },
  { key: 'scripts', cats: ['script'] },
  { key: 'gates', cats: ['gate'] },
  { key: 'skills', cats: ['skill'], view: 'skills' },
  { key: 'agents', cats: ['agent', 'command'], view: 'agents' },
  { key: 'mcp', cats: ['mcp'], view: 'mcp' },
  { key: 'plugins', cats: ['plugin'], view: 'plugins' },
  { key: 'clis', cats: [], view: 'clis' },
  { key: 'docs', cats: ['doc'], view: 'docs' },
  { key: 'memory', cats: ['memory'] },
  { key: 'other', cats: ['other'] },
];
/** Unchanged stretches longer than this are folded in the Changes mode, keeping FOLD_KEEP lines of context. */
var FOLD_OVER = 40;
var FOLD_KEEP = 4;
/** Lines drawn at once in the Before and After modes; the rest comes on demand. */
var CHUNK = 1500;

var fvMode = {};
var fvExpanded = {};

function categoryKey(category) {
  for (var i = 0; i < TREE.length; i++) if (TREE[i].cats.indexOf(category) >= 0) return TREE[i].key;
  return 'other';
}

/** A change of an item the user declined (or that needs nothing) is history, not a pending edit. */
function isDead(item) {
  var st = eff(item).status;
  return st === 'declined' || st === 'not-applicable' || st === 'ok';
}

/**
 * The file a linked file stands for: same path, in the harness that owns it. A link has no text of
 * its own (`omitted: 'linked'`), so its changes and its content are the target's.
 */
function linkTarget(file) {
  if (file.omitted !== 'linked' || !file.linkTo || !file.inheritedFrom) return null;
  var list = filesOf(file.inheritedFrom);
  for (var i = 0; i < list.length; i++) if (list[i].path === file.linkTo && list[i].omitted !== 'linked') return list[i];
  return null;
}

function fileStats(file) {
  var out = { pending: 0, applied: 0, open: 0, added: 0, removed: 0 };
  var res = ANCH.files[(linkTarget(file) || file).id];
  if (res) {
    res.segments.concat(res.detached).forEach(function (s) {
      if (s.type !== 'hunk') return;
      var it = ITEM[s.item];
      if (s.applied) out.applied++;
      else if (it && !isDead(it)) { out.pending++; out.added += s.added.length; out.removed += s.removed.length; }
    });
  }
  itemsOf(file.harness).forEach(function (i) { if (isOpen(i) && !(i.changes || []).length && i.file === file.path) out.open++; });
  return out;
}

function pathParts(p) {
  var s = String(p);
  var cut = s.replace(/\/+$/, '').lastIndexOf('/');
  return cut < 0 ? ['', s] : [s.slice(0, cut + 1), s.slice(cut + 1)];
}

function fileLink(h, fileId, text) {
  var f = fileId ? FILE[fileId] : null;
  if (!f) return text ? el('span', { cls: 'mono', text: text }) : null;
  return el('a', { cls: 'mono', href: R.file(f.harness, f.id), text: text || f.path });
}

// --- tree -----------------------------------------------------------------------------------

/**
 * Views that teach the shape of a harness even when nothing is registered in them (the hook
 * lifecycle, the permission lanes): listed in the tree whenever the harness has any file.
 */
var ALWAYS_VIEWS = { hooks: true, permissions: true };

/**
 * The file tree of one harness, by category. `prefix` keeps the keys of the copy drawn in the
 * side index apart from the copy drawn in the page (narrow screens), so focus finds its way back.
 */
function treeNav(h, route, prefix) {
  var p = prefix || '';
  var files = filesOf(h.id);
  var elements = h.elements || {};
  var nav = el('nav', { cls: 'tree', 'aria-label': T.ex.tree });
  TREE.forEach(function (node) {
    var list = files.filter(function (f) { return categoryKey(f.category) === node.key; });
    var entries = node.view ? (elements[node.view] || []) : [];
    var always = !!node.view && !!ALWAYS_VIEWS[node.view] && files.length > 0;
    if (!list.length && !entries.length && !always) return;
    var ul = el('ul');
    var marked = false;
    if (entries.length || always) {
      var hot = entries.some(function (e) { return e.item && ITEM[e.item] && isOpen(ITEM[e.item]); });
      marked = marked || hot;
      ul.appendChild(el('li', null, el('a', { cls: 'vw', href: R.view(h.id, node.view), 'aria-current': route.sub === 'view' && route.arg === node.view ? 'true' : null, 'data-fk': p + 'view:' + node.view },
        el('span', { cls: 'mk' + (hot ? ' on' : ''), title: hot ? T.ex.marker : null }),
        el('span', { cls: 'nm', text: lbl(T.view, node.view) }),
        el('span', { cls: 'bdg', text: String(entries.length) }))));
    }
    list.forEach(function (f) {
      var st = fileStats(f);
      var hot = st.pending > 0 || st.open > 0;
      marked = marked || hot;
      var parts = pathParts(f.path);
      ul.appendChild(el('li', null, el('a', { href: R.file(h.id, f.id), title: f.path, 'aria-current': route.sub === 'file' && route.arg === f.id ? 'true' : null, 'data-fk': p + 'file:' + f.id },
        el('span', { cls: 'mk' + (hot ? ' on' : st.applied ? ' applied' : ''), title: hot ? T.ex.marker : null }),
        el('span', { cls: 'nm' }, parts[0] ? el('span', { cls: 'd', text: parts[0] }) : null, el('span', { cls: 'b', text: parts[1] })),
        f.virtual === 'new' ? el('span', { cls: 'bdg new', text: T.ex.isNew }) : f.virtual === 'missing' ? el('span', { cls: 'bdg', text: T.ex.missing })
          : f.omitted === 'linked' ? el('span', { cls: 'bdg link', text: T.ex.link }) : (hot && st.pending ? el('span', { cls: 'bdg', text: String(st.pending) }) : null))));
    });
    var count = list.length + (entries.length || always ? 1 : 0);
    // In the side index a group opens by itself only when it holds what is shown.
    var here = route.sub === 'view' ? node.view === route.arg : route.sub === 'file' && list.some(function (f) { return f.id === route.arg; });
    var group = fold(p + 'tree:' + h.id + ':' + node.key, null, [
      el('span', { text: lbl(T.cat, node.key) }),
      marked ? el('span', { cls: 'mk on', title: T.ex.marker }) : null,
      el('span', { cls: 'cnt', text: String(count) }),
    ], ul, p ? here : true);
    group.setAttribute('id', p + 'tree-' + node.key);
    nav.appendChild(group);
  });
  return nav;
}

function welcomePane(h) {
  var files = filesOf(h.id);
  var box = el('div', { cls: 'welcome' }, el('h3', { text: T.ex.welcomeH }), el('p', { text: T.ex.welcomeP }));
  var changed = files.map(function (f) { return { f: f, st: fileStats(f) }; }).filter(function (x) { return x.st.pending > 0; });
  box.appendChild(el('span', { cls: 'lbl', text: T.ex.changedFiles }));
  if (!changed.length) { box.appendChild(el('p', { cls: 'muted', text: files.length ? T.ex.noChanged : T.ex.empty })); return box; }
  var ul = el('ul', { cls: 'flist' });
  changed.forEach(function (x) {
    ul.appendChild(el('li', null, el('a', { href: R.file(h.id, x.f.id) }, x.f.path,
      el('span', { text: pl(T.ex.pending, x.st.pending) + (x.st.applied ? ' · ' + pl(T.ex.appliedN, x.st.applied) : '') }),
      x.f.virtual === 'new' ? tag(T.ex.isNew, 'ok') : null)));
  });
  box.appendChild(ul);
  return box;
}

// --- file viewer ----------------------------------------------------------------------------
// One change can be put in focus: its card in the margin is marked as selected, its lines get a
// signal-blue band (neither the red nor the green of the diff), and the rest of the file and the
// other changes are dimmed, not hidden. The focus lives in the route (`?c=<item>.<change>`, with
// the older `?at=` read the same way), so a reload or a shared link keeps it. Hovering a card, or
// moving the keyboard onto it, previews the same highlight.

/** The change in focus in a route, as `<itemId>.<change>`, or null. */
function focusOf(route) { return (route && route.q && (route.q.c || route.q.at)) || null; }

function annotation(h, seg, first, focused) {
  var item = ITEM[seg.item];
  var c = item.changes[seg.change] || {};
  var L = item.lesson || {};
  var nthText = item.changes.length > 1 ? tx(T.ann.change, { n: seg.change + 1, m: item.changes.length }) : null;
  // A group the keyboard can reach: Enter or Space puts its change in focus (see fileViewer).
  var card = el('div', { cls: 'ann' + (focused ? ' on' : ''), tabindex: '0', role: 'group', 'aria-current': focused ? 'true' : null,
    'aria-label': tx(T.focus.cardAria, { id: item.id, title: item.title }) + (nthText ? ', ' + nthText : ''), 'data-fk': 'ann:' + seg.item + '.' + seg.change });
  card.appendChild(el('div', { cls: 'ann-h' }, el('a', { cls: 'cid', href: R.item(item.id), title: T.ann.openCase, text: item.id }),
    first ? sevMarks(item.severity) : null, nthText ? el('span', { cls: 'ann-n', text: nthText }) : null,
    focused ? el('span', { cls: 'ann-on', text: T.focus.on }) : null, first ? statusTags(item) : null));
  if (first) card.appendChild(el('div', { cls: 'ann-t', text: item.title }));
  if (c.why || first) card.appendChild(el('p', { cls: 'ann-why', text: c.why || item.finding }));
  if (seg.detached) card.appendChild(el('p', { cls: 'problem', text: lbl(T.problem, seg.code) }));
  if (first && (L.why || L.impact || L.better)) {
    var dl = el('dl');
    ['why', 'impact', 'better', 'principle', 'tradeoff'].forEach(function (k) {
      if (L[k]) { dl.appendChild(el('dt', { text: T.lesson[k] })); dl.appendChild(el('dd', { text: L[k] })); }
    });
    if (L.learnMore) { dl.appendChild(el('dt', { text: T.lesson.learnMore })); dl.appendChild(el('dd', null, extLink(L.learnMore))); }
    card.appendChild(fold('ann:' + item.id + ':' + seg.change, 'fold', T.lesson.summary, dl, false));
  }
  return card;
}

function hunkCell(seg, focus) {
  var key = seg.item + '.' + seg.change;
  var dead = ITEM[seg.item] && isDead(ITEM[seg.item]) && !seg.applied;
  var cell = el('div', { cls: 'fv-code hunk' + (seg.applied ? ' applied' : '') + (dead ? ' dead' : '') + (focus === key ? ' focus' : ''), id: 'hunk-' + key, 'data-key': key, title: T.focus.hunkTitle });
  seg.rows.forEach(function (r) { cell.appendChild(lineEl(r.t, r.text, seg.detached ? null : r.old, seg.detached ? null : r['new'], true)); });
  return cell;
}

function sameCell(fileId, seg, index, total) {
  var cell = el('div', { cls: 'fv-code' });
  var n = seg.lines.length;
  var key = fileId + ':' + index;
  var line = function (k) { cell.appendChild(lineEl('same', seg.lines[k], seg.oldStart + k, seg.newStart + k, true)); };
  if (n <= FOLD_OVER || fvExpanded[key]) { for (var k = 0; k < n; k++) line(k); return cell; }
  var head = index === 0 ? 0 : FOLD_KEEP;
  var tail = index === total - 1 ? 0 : FOLD_KEEP;
  for (var a = 0; a < head; a++) line(a);
  var btn = el('button', { type: 'button', 'data-fk': 'exp:' + key, text: T.fv.expand });
  btn.addEventListener('click', function () { fvExpanded[key] = true; redraw(); });
  cell.appendChild(el('div', { cls: 'fold-row' }, el('span', { text: pl(T.fv.collapsed, n - head - tail) }), btn));
  for (var b = n - tail; b < n; b++) line(b);
  return cell;
}

/** The whole text of one side, in one code cell, drawn CHUNK lines at a time. */
function plainCode(lines) {
  var cell = el('div', { cls: 'fv-code first last' });
  var drawn = 0;
  var more = null;
  var draw = function () {
    if (more) cell.removeChild(more);
    var end = Math.min(lines.length, drawn + CHUNK);
    for (; drawn < end; drawn++) cell.appendChild(lineEl('same', lines[drawn], drawn + 1, null, false));
    if (drawn < lines.length) {
      var btn = el('button', { type: 'button', text: pl(T.fv.more, Math.min(CHUNK, lines.length - drawn)) });
      btn.addEventListener('click', draw);
      more = el('div', { cls: 'fold-row' }, btn);
      cell.appendChild(more);
    } else more = null;
  };
  draw();
  return cell;
}

function sideLines(res, after) {
  var out = [];
  res.segments.forEach(function (s) {
    var take = s.type === 'same' ? s.lines : (s.applied || (after && !(ITEM[s.item] && isDead(ITEM[s.item])))) ? s.added : s.removed;
    for (var i = 0; i < take.length; i++) out.push(take[i]);
  });
  return out;
}

/**
 * The header of the file viewer and of a view: the harness it belongs to (with its kind marker),
 * the path or the name, and only the facts that matter for reading it. The rest (category, size,
 * language) is in the tooltip of the size tag or in the tree.
 */
function paneHead(h, title, tags, role) {
  return el('div', { cls: 'fv-h' },
    el('div', { cls: 'fv-who' }, harnessRef(h.id, true)),
    el('h3', { cls: 'fv-path', id: 'fv-title', text: title }),
    tags && tags.length ? el('div', { cls: 'fv-meta' }, tags) : null,
    role || null);
}

function fileViewer(h, shown, focus) {
  // A linked file has no text of its own: the viewer draws the file it links to, with its changes.
  var target = linkTarget(shown);
  var file = target || shown;
  var res = anchorOf(file.id);
  var hunks = res.segments.filter(function (s) { return s.type === 'hunk'; });
  var hasChanges = hunks.length + res.detached.length > 0;
  var mode = hasChanges ? (fvMode[file.id] || 'changes') : 'before';
  var st = fileStats(shown);
  var pane = el('div', { cls: 'pane' });
  var pick = function (k) { return shown[k] === undefined ? file[k] : shown[k]; };

  var tags = [];
  if (shown.omitted === 'linked') tags.push(tag(T.ex.link, 'dashed'));
  if (file.virtual === 'new') tags.push(tag(T.ex.isNew, 'ok'));
  if (file.virtual === 'missing') tags.push(tag(T.ex.missing, 'warn'));
  if (pick('loaded')) tags.push(tag(lbl(T.fv.loaded, pick('loaded')), pick('loaded') === 'always' ? 'navy' : pick('loaded') === 'never' ? 'dashed' : ''));
  var facts = [lbl(T.cat, categoryKey(shown.category)), typeof pick('bytes') === 'number' ? fmtBytes(pick('bytes')) : null, pick('lang') || null].filter(Boolean).join(' · ');
  if (typeof pick('tokens') === 'number') tags.push(el('span', { cls: 'tag', title: facts, text: tx(T.fv.tokens, { n: fmtInt(pick('tokens')) }) }));
  if (shown.omitted !== 'linked') {
    if (shown.linkTo) tags.push(tag(tx(T.fv.linkTo, { path: shown.linkTo }), 'dashed'));
    if (shown.inheritedFrom) tags.push(HARNESS[shown.inheritedFrom] ? el('a', { cls: 'tag info', href: R.harness(shown.inheritedFrom), text: tx(T.fv.inherited, { name: harnessName(shown.inheritedFrom) }) }) : tag(tx(T.fv.inherited, { name: shown.inheritedFrom })));
  }
  pane.appendChild(paneHead(h, shown.path, tags, pick('role') ? el('p', { cls: 'fv-role', text: pick('role') }) : null));

  if (shown.omitted === 'linked') {
    pane.appendChild(el('p', { cls: 'note-line' }, el('span', { cls: 'glyph' }), el('span', null,
      tx(T.fv.linkBanner, { path: shown.linkTo || '?', name: shown.inheritedFrom ? harnessName(shown.inheritedFrom) : '?' }),
      target ? [' ', el('a', { href: R.file(target.harness, target.id), text: T.fv.openThere })] : null)));
  }
  if (file.virtual === 'new') pane.appendChild(el('p', { cls: 'fv-msg', text: T.fv.newFile }));
  if (file.virtual === 'missing') pane.appendChild(el('p', { cls: 'fv-msg', text: T.fv.missingFile }));
  if (file.omitted) pane.appendChild(el('p', { cls: 'fv-msg', text: lbl(T.fv.omitted, file.omitted) }));
  if (file.truncated) pane.appendChild(el('p', { cls: 'fv-msg', text: T.fv.truncated }));

  if (hasChanges) {
    var toggle = el('div', { cls: 'toggle', role: 'group', 'aria-label': T.fv.modeLabel });
    [['changes', T.fv.modeChanges], ['before', T.fv.modeBefore], ['after', T.fv.modeAfter]].forEach(function (m) {
      var b = el('button', { type: 'button', 'aria-pressed': mode === m[0] ? 'true' : 'false', 'data-fk': 'mode:' + m[0], text: m[1] });
      b.addEventListener('click', function () { fvMode[file.id] = m[0]; redraw(); });
      toggle.appendChild(b);
    });
    pane.appendChild(el('div', { cls: 'fv-bar' }, toggle,
      el('span', { cls: 'fv-stat' }, mode === 'before' ? T.fv.beforeNote : mode === 'after' ? T.fv.afterNote :
        [pl(T.ex.pending, st.pending), st.applied ? ' · ' + pl(T.ex.appliedN, st.applied) : null, ' · ', el('span', { cls: 'p', text: '+' + st.added }), ' ', el('span', { cls: 'm', text: '-' + st.removed })])));
  }

  if (mode === 'changes') {
    var all = hunks.concat(res.detached);
    var focused = focus && all.some(function (s) { return s.item + '.' + s.change === focus; }) ? focus : null;
    var toggleFocus = function (key) { navigate(R.file(h.id, shown.id, focused === key ? null : key)); };
    if (all.length) {
      // One line that says what the cards do, or which change is in focus and how to leave it.
      var bar = el('div', { cls: 'fv-focus' + (focused ? ' on' : ''), role: 'status' });
      if (focused) {
        var fi = ITEM[focused.slice(0, focused.lastIndexOf('.'))];
        var clearBtn = el('button', { type: 'button', cls: 'btn ghost small', 'data-fk': 'focus:clear', text: T.focus.clear });
        clearBtn.addEventListener('click', function () { toggleFocus(focused); });
        bar.appendChild(el('span', { cls: 'fband', 'aria-hidden': 'true' }));
        bar.appendChild(el('span', null, tx(T.focus.now, { id: fi ? fi.id : focused }), fi ? ' ' : null, fi ? el('b', { text: fi.title }) : null));
        bar.appendChild(clearBtn);
      } else bar.appendChild(el('span', { text: T.focus.hint }));
      pane.appendChild(bar);
    }
    var seen = {};
    var noted = function (wrap, code, seg) {
      var key = seg.item + '.' + seg.change;
      var card = annotation(h, seg, !seen[seg.item], focused === key);
      var note = el('div', { cls: 'fv-note' + (focused === key ? ' focus' : ''), 'data-key': key }, card);
      seen[seg.item] = true;
      var peek = function (on) {
        return function () {
          wrap.classList.toggle('peeking', on);
          code.classList.toggle('peek', on);
          note.classList.toggle('peek', on);
        };
      };
      card.addEventListener('mouseenter', peek(true));
      card.addEventListener('mouseleave', peek(false));
      card.addEventListener('focus', peek(true));
      card.addEventListener('blur', peek(false));
      // The card toggles its change; its own link and its fold keep working as before.
      card.addEventListener('click', function (e) {
        var t = e.target;
        if (t && t.closest && t !== card && t.closest('a, button, summary')) return;
        toggleFocus(key);
      });
      card.addEventListener('keydown', function (e) {
        if (e.target !== card || (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar')) return;
        e.preventDefault();
        toggleFocus(key);
      });
      // The reverse: a change in the file selects its card.
      code.addEventListener('click', function () { toggleFocus(key); });
      wrap.appendChild(code);
      wrap.appendChild(note);
      return note;
    };
    var total = res.segments.length;
    if (total) {
      var wrap = el('div', { cls: 'fv-wrap notes' + (focused ? ' focusing' : ''), role: 'group', 'aria-label': T.fv.code });
      res.segments.forEach(function (seg, index) {
        var code = seg.type === 'same' ? sameCell(file.id, seg, index, total) : hunkCell(seg, focused);
        if (index === 0) code.classList.add('first');
        if (index === total - 1) code.classList.add('last');
        if (seg.type === 'same') wrap.appendChild(code);
        else {
          var note = noted(wrap, code, seg);
          if (index === total - 1) { code.classList.add('has-note'); note.classList.add('last'); }
        }
      });
      pane.appendChild(wrap);
    }
    if (res.detached.length) {
      pane.appendChild(el('h4', { cls: 'lbl fv-sec', text: T.fv.detachedH }));
      res.detached.forEach(function (seg) {
        var code = hunkCell(seg, focused);
        code.setAttribute('class', code.getAttribute('class') + ' first last has-note');
        var box = el('div', { cls: 'fv-wrap notes' + (focused ? ' focusing' : '') });
        noted(box, code, seg).classList.add('last');
        pane.appendChild(box);
      });
    }
  } else if (!file.omitted && file.virtual !== 'missing') {
    var lines = sideLines(res, mode === 'after');
    pane.appendChild(lines.length ? el('div', { cls: 'fv-wrap', role: 'group', 'aria-label': T.fv.code }, plainCode(lines)) : el('p', { cls: 'fv-msg', text: T.fv.empty }));
  }
  if (!hasChanges && !file.omitted && st.open === 0 && Anchors.toLines(file.content).length) pane.appendChild(el('p', { cls: 'muted', text: T.fv.noChanges }));
  return pane;
}

/**
 * Places each annotation card in the margin, level with its hunk, pushing a card down when the
 * one above would overlap it. On narrow screens the cards flow below their hunks instead (CSS).
 */
function layoutNotes() {
  var wide = window.matchMedia('(min-width: 1021px)').matches;
  var wraps = document.querySelectorAll('.fv-wrap.notes');
  for (var w = 0; w < wraps.length; w++) {
    var bottom = 0;
    var kids = wraps[w].children;
    for (var k = 0; k < kids.length; k++) {
      var note = kids[k];
      if (!note.classList.contains('fv-note')) continue;
      if (!wide) { note.style.removeProperty('top'); continue; }
      var hunk = note.previousElementSibling;
      var top = Math.max(hunk ? hunk.offsetTop : 0, bottom ? bottom + 10 : 0);
      note.style.top = top + 'px';
      bottom = top + note.offsetHeight;
    }
    wraps[w].style.minHeight = wide && bottom ? bottom + 'px' : '';
  }
}

// --- structured views -----------------------------------------------------------------------

/** How a view is sorted, per harness and view, kept across redraws. */
var viewSort = {};

function sortChips(key, current, options) {
  var box = el('div', { cls: 'fgroup', role: 'group', 'aria-label': T.v.sort }, el('span', { text: T.v.sort }));
  options.forEach(function (o) {
    var b = el('button', { type: 'button', cls: 'chip', 'aria-pressed': current === o[0] ? 'true' : 'false', 'data-fk': 'sort:' + key + ':' + o[0] }, el('span', { cls: 'slash' }), o[1]);
    b.addEventListener('click', function () { viewSort[key] = o[0]; redraw(); });
    box.appendChild(b);
  });
  return box;
}

/** A copy sorted by a use count; an unknown count (missing or null) always goes last. Stable. */
function byUse(list, field, mostFirst) {
  return list.map(function (x, i) { return { x: x, i: i }; }).sort(function (a, b) {
    var av = countOf(a.x[field]);
    var bv = countOf(b.x[field]);
    if (av === null || bv === null) return ((av === null) - (bv === null)) || (a.i - b.i);
    return (mostFirst ? bv - av : av - bv) || (a.i - b.i);
  }).map(function (e) { return e.x; });
}

/**
 * A measured count: zero is a real zero and is said out loud. A count that is missing or null
 * was not measured, and says so: it is never drawn as zero.
 */
function useCell(value, zeroForms, days) {
  var n = countOf(value);
  if (n === null) return el('td', { cls: 'num' }, el('span', { cls: 'muted', text: T.notMeasured }));
  if (n === 0) return el('td', { cls: 'num' }, tag(pl(zeroForms, days), 'warn soft'));
  return el('td', { cls: 'num', text: fmtInt(n) });
}

/** Only a real true or false is an answer; anything else reads "unknown", never "no". */
function yesNo(v) { return lbl({ yes: T.yes, no: T.no, unknown: T.unknown }, triState(v)); }
function measured(v) { return typeof v === 'number' ? fmtInt(v) : T.notMeasured; }
function noteCell(text) { return text ? el('small', { text: text }) : null; }
function itemCell(id) { return id ? cid(id) : null; }

// --- hooks: the agent's lifecycle as slots ---------------------------------------------------
// Each moment of the agent's lifecycle is a slot, in order, whether something is registered there
// or not, so the reader learns the shape of the lifecycle. Which moments a hook can stop comes
// from the verified table the snapshot uses (HOOK_EVENTS, embedded by render-board.mjs; see
// references/checks.md). Git hooks and CI jobs are not agent moments: they get a group of their own.

/** Hook events of Claude Code, in lifecycle order: `[{ event, phase, core, canBlock, keeps }]`. */
var HOOK_EVENTS = BOOT.hookEvents || [];
var HOOK_PHASES = ['start', 'prompt', 'tool', 'agents', 'env', 'context', 'end'];

/** The agent whose lifecycle a harness's hooks follow: its provider, else where they are registered. */
function hookProvider(h, list) {
  var p = providerOf(h);
  if (p) return p;
  var codex = list.some(function (k) { var f = k.file && FILE[k.file]; return f && /(^|\/)\.codex\//.test(f.path); });
  return codex ? 'codex' : 'claude-code';
}

/** Whether a hook in this slot can stop what it is attached to, in words. */
function canBlockTag(ev) {
  if (!ev || typeof ev.canBlock !== 'boolean') return tag(T.hk.unverified, 'dashed');
  return ev.canBlock ? el('span', { cls: 'tag navy cb' }, T.hk.canBlock) : tag(T.hk.onlyReports);
}

/** One registered hook: what it matches, whether it blocks, where it comes from, and its files. */
function hookEntry(h, k) {
  var blocks = triState(k.blocking);
  var script = k.script && FILE[k.script] ? k.script : null;
  return el('li', { cls: 'hk', 'data-hook': k.id },
    el('div', { cls: 'hk-h' },
      tag(lbl(T.blocking, blocks), { yes: 'navy', no: '', unknown: 'dashed' }[blocks]),
      tag(k.plugin ? tx(T.v.pluginOf, { name: k.plugin }) : lbl(T.hookSource, k.source), k.source === 'agent' ? 'info' : ''),
      k.matcher ? el('code', { cls: 'hk-m', title: T.hk.matcher, text: k.matcher }) : null,
      k.item ? cid(k.item) : null),
    k.command ? el('span', { cls: 'mono hk-c', text: k.command }) : null,
    k.note ? el('small', { text: k.note }) : null,
    el('div', { cls: 'hk-f' },
      script ? el('span', null, T.hk.script + ' ', fileLink(h, script)) : null,
      k.file && FILE[k.file] && k.file !== script ? el('span', null, T.hk.registered + ' ', fileLink(h, k.file)) : null));
}

/** One moment of the lifecycle. `ev` may be null for an event the table does not know. */
function hookSlot(h, event, ev, hooks) {
  var text = (T.hk.ev && Object.prototype.hasOwnProperty.call(T.hk.ev, event)) ? T.hk.ev[event] : null;
  var filled = hooks.length > 0;
  var head = el('div', { cls: 'slot-h' }, el('code', { cls: 'slot-n', text: event }), canBlockTag(ev),
    ev && ev.keeps ? el('small', { cls: 'keeps', text: T.hk.keeps }) : null);
  // A moment nobody uses and few people need is drawn small; its explanation opens on demand.
  if (!filled && ev && !ev.core) {
    return el('li', { cls: 'slot mini', 'data-event': event }, fold('slot:' + event, 'slot-f', head, text ? el('p', { cls: 'slot-w', text: text.what }) : null, false));
  }
  var li = el('li', { cls: 'slot' + (filled ? ' filled' : ' empty'), 'data-event': event }, head);
  if (text) li.appendChild(el('p', { cls: 'slot-w', text: text.what }));
  if (text && text.use) li.appendChild(el('p', { cls: 'slot-u', text: text.use }));
  if (filled) {
    var ul = el('ul', { cls: 'hks' });
    hooks.forEach(function (k) { ul.appendChild(hookEntry(h, k)); });
    li.appendChild(ul);
  } else li.appendChild(el('p', { cls: 'slot-e' }, el('span', { cls: 'lbl', text: T.hk.empty }), text && text.idea ? ' ' + tx(T.hk.idea, { idea: text.idea }) : null));
  return li;
}

function hooksView(h, list) {
  var provider = hookProvider(h, list);
  var agent = list.filter(function (k) { return k.source === 'agent' || k.source === 'plugin'; });
  var outside = list.filter(function (k) { return k.source !== 'agent' && k.source !== 'plugin'; });
  var byEvent = {};
  agent.forEach(function (k) { (byEvent[k.event] = byEvent[k.event] || []).push(k); });
  var out = [];
  var legend = el('p', { cls: 'legend-line' }, el('span', { cls: 'tag navy cb', text: T.hk.canBlock }), el('span', { text: T.hk.canBlockMeans }), tag(T.hk.onlyReports), el('span', { text: T.hk.onlyReportsMeans }));
  var known = {};
  var life = el('div', { cls: 'life' });
  if (provider === 'claude-code' && HOOK_EVENTS.length) {
    HOOK_EVENTS.forEach(function (ev) { known[ev.event] = true; });
    HOOK_PHASES.forEach(function (phase, n) {
      var evs = HOOK_EVENTS.filter(function (ev) { return ev.phase === phase; });
      if (!evs.length) return;
      var ol = el('ol', { cls: 'slots' });
      evs.forEach(function (ev) { ol.appendChild(hookSlot(h, ev.event, ev, byEvent[ev.event] || [])); });
      life.appendChild(el('section', { cls: 'phase', 'data-phase': phase }, el('h4', null, el('span', { cls: 'pn', text: String(n + 1) }), lbl(T.hk.phase, phase)), ol));
    });
    out.push(el('div', { cls: 'ih' }, el('h3', { text: tx(T.hk.lifeH, { agent: lbl(T.provider, provider) }) })), legend, life);
  } else {
    // Another agent: only the moments its own hooks name, without a verdict this board cannot back.
    var events = [];
    agent.forEach(function (k) { if (events.indexOf(k.event) < 0) events.push(k.event); });
    var ol2 = el('ol', { cls: 'slots' });
    events.forEach(function (event) { ol2.appendChild(hookSlot(h, event, null, byEvent[event])); });
    out.push(el('div', { cls: 'ih' }, el('h3', { text: tx(T.hk.lifeOther, { agent: lbl(T.provider, provider) }) })),
      el('p', { cls: 'muted', text: T.hk.otherNote }), events.length ? el('div', { cls: 'life' }, el('section', { cls: 'phase' }, ol2)) : el('p', { cls: 'empty', text: T.hk.noAgentHooks }));
    events.forEach(function (event) { known[event] = true; });
  }
  // Agent hooks on an event the table does not list are shown, never dropped.
  var stray = Object.keys(byEvent).filter(function (event) { return !known[event]; });
  if (stray.length) {
    var ol3 = el('ol', { cls: 'slots' });
    stray.forEach(function (event) { ol3.appendChild(hookSlot(h, event, null, byEvent[event])); });
    out.push(el('section', { cls: 'phase stray' }, el('h4', { text: T.hk.stray }), ol3));
  }
  var ul = el('ul', { cls: 'hks outside' });
  outside.forEach(function (k) {
    ul.appendChild(el('li', { cls: 'slot filled', 'data-event': k.event }, el('div', { cls: 'slot-h' }, el('code', { cls: 'slot-n', text: k.event })), el('ul', { cls: 'hks' }, hookEntry(h, k))));
  });
  out.push(el('section', { cls: 'phase outside-g', 'data-phase': 'outside' }, el('h4', { text: T.hk.outside }), whyNote(T.hk.outsideWhy, 'hk-outside'),
    outside.length ? ul : el('p', { cls: 'slot-e' }, el('span', { cls: 'lbl', text: T.hk.empty }), ' ' + T.hk.outsideIdea)));
  return out;
}

// --- permissions: three lanes in the order they decide ----------------------------------------
// Claude Code checks deny rules first, then ask, then allow, and the first match decides; what
// matches no rule follows the permission mode (the Claude Code permissions page, read on
// 2026-11-24; the page carries no address but the font). Codex has no rule lists: it decides by
// approval_policy and sandbox_mode.

var LANES = ['deny', 'ask', 'allow'];

/** A rule split into its tool and its pattern: `Bash(git push *)` -> { tool: 'Bash', pattern: 'git push *' }. */
function ruleParts(rule) {
  var text = String(rule);
  var m = /^([^()]+)\(([\s\S]*)\)$/.exec(text);
  var tool = (m ? m[1] : text).trim();
  var pattern = m ? m[2] : null;
  if (/^mcp__/i.test(tool)) return { tool: 'MCP', pattern: pattern === null ? tool.replace(/^mcp__/i, '') : tool.replace(/^mcp__/i, '') + '(' + pattern + ')' };
  return { tool: tool, pattern: pattern };
}

function permRule(h, p) {
  var parts = ruleParts(p.rule);
  var risky = p.kind === 'allow' && !!p.item;
  var from = p.file && FILE[p.file] ? el('a', { cls: 'tag src', href: R.file(h.id, p.file), title: FILE[p.file].path, text: lbl(T.perm.layer, p.layer) }) : tag(lbl(T.perm.layer, p.layer), 'src');
  return el('li', { cls: 'rule' + (risky ? ' risky' : ''), 'data-rule': p.rule },
    el('div', { cls: 'rule-h' }, parts.pattern === null ? el('span', { cls: 'any', text: T.perm.anyUse }) : el('code', { text: parts.pattern }), from, p.item ? cid(p.item) : null),
    risky ? el('small', { cls: 'risk', text: T.perm.risky }) : null,
    p.note ? el('small', { text: p.note }) : null);
}

function permissionsView(h, list) {
  var out = [];
  var modes = list.filter(function (p) { return p.kind === 'mode'; });
  var strip = el('div', { cls: 'pmode' }, el('span', { cls: 'lbl', text: T.perm.modeH }));
  if (modes.length) {
    modes.forEach(function (p) {
      strip.appendChild(el('span', { cls: 'pm' }, el('code', { text: p.rule }), p.file && FILE[p.file] ? el('a', { cls: 'tag src', href: R.file(h.id, p.file), text: lbl(T.perm.layer, p.layer) }) : tag(lbl(T.perm.layer, p.layer), 'src')));
    });
  } else strip.appendChild(el('span', { cls: 'muted', text: T.perm.modeNone }));
  var codex = providerOf(h) === 'codex' || (list.length > 0 && list.every(function (p) { return p.kind === 'mode' && /^(approval_policy|sandbox_mode)/.test(p.rule); }));
  if (codex) {
    out.push(strip, el('p', { cls: 'note-line' }, el('span', { cls: 'glyph' }), el('span', { text: T.perm.codex })));
    return out;
  }
  out.push(el('p', { cls: 'porder' }, el('span', { cls: 'arrows', 'aria-hidden': 'true' }, T.perm.lane.deny, el('i', { text: '›' }), T.perm.lane.ask, el('i', { text: '›' }), T.perm.lane.allow), el('span', { text: T.perm.order })), whyNote(T.perm.orderWhy, 'perm-order'), strip);
  var lanes = el('div', { cls: 'lanes' });
  LANES.forEach(function (kind, n) {
    var rules = list.filter(function (p) { return p.kind === kind; });
    var lane = el('section', { cls: 'lane ' + kind, 'data-lane': kind, 'aria-label': lbl(T.perm.lane, kind) },
      el('div', { cls: 'lane-h' }, el('span', { cls: 'ln-n', text: String(n + 1) }), el('h4', { text: lbl(T.perm.lane, kind) }), el('span', { cls: 'cnt', text: String(rules.length) })),
      el('p', { cls: 'lane-w', text: lbl(T.perm.laneWhat, kind) }));
    if (!rules.length) lane.appendChild(el('p', { cls: 'lane-e', text: lbl(T.perm.laneEmpty, kind) }));
    var tools = [];
    rules.forEach(function (p) { var t = ruleParts(p.rule).tool; if (tools.indexOf(t) < 0) tools.push(t); });
    tools.forEach(function (t) {
      var ul = el('ul', { cls: 'rules' });
      rules.filter(function (p) { return ruleParts(p.rule).tool === t; }).forEach(function (p) { ul.appendChild(permRule(h, p)); });
      lane.appendChild(el('div', { cls: 'tgroup' }, el('b', { text: t }), ul));
    });
    lanes.appendChild(lane);
  });
  out.push(lanes);
  return out;
}

var VIEWS = {
  permissions: permissionsView,
  hooks: hooksView,
  skills: function (h, list) {
    var tone = { keep: 'ok', improve: 'warn', update: 'warn', retire: 'bad', merge: 'info', unmeasured: 'dashed' };
    var rank = { retire: 0, merge: 1, update: 2, improve: 3, unmeasured: 4, keep: 5 };
    var key = h.id + ':skills';
    var anyVerdict = list.some(function (s) { return !!s.verdict; });
    // By default what needs a decision comes first: by verdict when the review gave one, else the
    // least used first, so the skills nobody invokes surface.
    var sort = viewSort[key] || (anyVerdict ? 'verdict' : 'least');
    var ordered = byUse(list, 'invocations', sort === 'most');
    if (sort === 'verdict') {
      var rankOf = function (s) { return Object.prototype.hasOwnProperty.call(rank, s.verdict) ? rank[s.verdict] : 6; };
      ordered = ordered.map(function (s, i) { return { s: s, i: i }; }).sort(function (a, b) { return (rankOf(a.s) - rankOf(b.s)) || (a.i - b.i); }).map(function (e) { return e.s; });
    }
    var days = (h.impact && h.impact.windowDays) || windowDays();
    var rows = ordered.map(function (s) {
      var chars = typeof s.descriptionChars === 'number' ? s.descriptionChars : null;
      return row([s.file && FILE[s.file] ? fileLink(h, s.file, s.name) : el('b', { text: s.name }), s.plugin ? noteCell(tx(T.v.pluginOf, { name: s.plugin })) : null],
        lbl(T.level, s.level),
        el('td', { cls: 'wide' }, s.description || '', chars === null ? null : chars > 1000 ? el('small', null, tag(tx(T.v.longDescription, { n: fmtInt(chars) }), 'warn soft')) : noteCell(tx(T.v.chars, { n: fmtInt(chars) }))),
        useCell(s.invocations, T.v.uses0, days),
        el('td', { cls: 'wide' }, s.verdict ? tag(lbl(T.skillVerdict, s.verdict), tone[s.verdict]) : null, s.verdict === 'merge' && s.mergeInto ? noteCell(tx(T.v.mergeInto, { name: s.mergeInto })) : null, noteCell(s.reason)),
        itemCell(s.item));
    });
    var options = (anyVerdict ? [['verdict', T.v.sortVerdict]] : []).concat([['least', T.v.sortLeast], ['most', T.v.sortMost]]);
    return [sortChips(key, sort, options), tableBox([T.col.name, T.col.level, T.col.description, T.col.invocations, T.col.verdict, T.col.item], rows, T.view.skills)];
  },
  agents: function (h, list) {
    var rows = list.map(function (a) {
      return row(a.file && FILE[a.file] ? fileLink(h, a.file, a.name) : el('b', { text: a.name }), a.level ? lbl(T.level, a.level) : '', a.model || '',
        a.tools ? el('span', { cls: 'mono', text: a.tools }) : '', typeof a.promptChars === 'number' ? tx(T.v.chars, { n: fmtInt(a.promptChars) }) : '', itemCell(a.item));
    });
    return tableBox([T.col.name, T.col.level, T.col.model, T.col.tools, T.col.prompt, T.col.item], rows, T.view.agents);
  },
  mcp: function (h, list) {
    var key = h.id + ':mcp';
    var sort = viewSort[key] || 'least';
    var days = (h.impact && h.impact.windowDays) || windowDays();
    var rows = byUse(list, 'calls', sort === 'most').map(function (m) {
      return row([m.file && FILE[m.file] ? fileLink(h, m.file, m.name) : el('b', { text: m.name }), noteCell(m.note)], lbl(T.level, m.level), m.transport ? lbl(T.transport, m.transport) : '',
        useCell(m.calls, T.v.calls0, days), m.cli ? el('span', { cls: 'mono', title: tx(T.v.cli, { cli: m.cli }), text: m.cli }) : '', itemCell(m.item));
    });
    return [sortChips(key, sort, [['least', T.v.sortLeast], ['most', T.v.sortMost]]), tableBox([T.col.name, T.col.level, T.col.transport, T.col.calls, T.col.cli, T.col.item], rows, T.view.mcp)];
  },
  plugins: function (h, list) {
    var rows = list.map(function (p) {
      // A plugin listed without an on/off state, or without a known pin, says "unknown": a blank
      // cell under "Enabled" would read as "no".
      return row([el('b', { text: p.name }), noteCell(p.note)], p.marketplace || '', yesNo(p.enabled), yesNo(p.pinned), itemCell(p.item));
    });
    return tableBox([T.col.name, T.col.marketplace, T.col.enabled, T.col.pinned, T.col.item], rows, T.view.plugins);
  },
  clis: function (h, list) {
    var rows = list.map(function (c) {
      return row([el('b', { cls: 'mono', text: c.name }), c.collision ? el('small', null, tag(T.v.collision, 'warn')) : null, noteCell(c.note)],
        tag(yesNo(c.installed), { yes: 'ok', no: '', unknown: 'dashed' }[triState(c.installed)]), c.version || '', c.auth ? lbl(T.auth, c.auth) : '',
        (c.signals || []).length ? el('span', { cls: 'mono', text: c.signals.join(', ') }) : '', itemCell(c.item));
    });
    return tableBox([T.col.name, T.col.installed, T.col.version, T.col.auth, T.col.signals, T.col.item], rows, T.view.clis);
  },
  docs: function (h, list) {
    var tone = { fine: 'ok', stale: 'warn', orphan: 'warn', contradicts: 'bad', 'always-loaded': 'warn', unchecked: 'dashed' };
    var rows = list.map(function (d) {
      return row([d.file && FILE[d.file] ? fileLink(h, d.file, d.path) : el('span', { cls: 'mono', text: d.path }), noteCell(d.note)],
        typeof d.bytes === 'number' ? fmtBytes(d.bytes) : '', d.lastCommit ? fmtDate(d.lastCommit) : '', d.language || '',
        d.reader ? lbl(T.docReader, d.reader) : '', d.status ? tag(lbl(T.docStatus, d.status), tone[d.status]) : '', itemCell(d.item));
    });
    return tableBox([T.col.path, T.col.size, T.col.lastCommit, T.col.language, T.col.reader, T.col.status, T.col.item], rows, T.view.docs);
  },
};

/** Views drawn by their own function rather than as a table. */
var RICH_VIEWS = { hooks: hooksView, permissions: permissionsView };

function structuredView(h, name) {
  var list = (h.elements || {})[name] || [];
  var pane = el('div', { cls: 'pane view-' + name });
  // The permission lanes explain themselves (and fold why they decide in that order): one toggle, not two.
  pane.appendChild(paneHead(h, lbl(T.view, name), [tag(pl(T.ex.entries, list.length))], name === 'permissions' ? null : whyNote(lbl(T.viewSub, name), 'view:' + name)));
  // A linked account shows only what differs: what it inherits is listed in the account it links to.
  if (h.inherits && HARNESS[h.inherits]) {
    pane.appendChild(el('p', { cls: 'note-line' }, el('span', { cls: 'glyph' }), el('span', null,
      txNodes(T.v.inherits, 'name', el('a', { href: R.view(h.inherits, name), text: harnessName(h.inherits) })))));
  }
  if (Object.prototype.hasOwnProperty.call(RICH_VIEWS, name)) append(pane, [RICH_VIEWS[name](h, list)]);
  else append(pane, [list.length && VIEWS[name] ? VIEWS[name](h, list) : el('p', { cls: 'empty', text: T.v.empty })]);
  return pane;
}

function explorerPane(h, route) {
  var selected = route.sub === 'file' || route.sub === 'view';
  var right;
  if (route.sub === 'file') {
    var f = FILE[route.arg];
    right = f && f.harness === h.id ? fileViewer(h, f, focusOf(route)) : el('div', { cls: 'pane' }, el('p', { cls: 'empty', text: T.ex.notFound }));
  } else if (route.sub === 'view' && Object.prototype.hasOwnProperty.call(VIEWS, route.arg)) {
    right = structuredView(h, route.arg);
  } else {
    selected = false;
    right = welcomePane(h);
  }
  var count = filesOf(h.id).length;
  // On a wide screen the tree lives in the side index; this copy is for narrow screens.
  return el('div', { cls: 'ex', 'data-sel': selected ? '1' : null },
    el('div', { cls: 'ex-side' },
      el('a', { cls: 'btn ghost small ex-back', href: R.harness(h.id), 'data-fk': 'ex:back' }, '‹ ' + T.ex.tree + ' (' + count + ')'),
      treeNav(h, route, '')),
    right);
}
