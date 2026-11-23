// Board client, fragment 7 of 9: the Explorer sub-tab: the tree by category, the file viewer
// that draws every change inside its file, and the structured views of `harness.elements`.

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

function treeNav(h, route) {
  var files = filesOf(h.id);
  var elements = h.elements || {};
  var nav = el('nav', { cls: 'tree', 'aria-label': T.ex.tree });
  TREE.forEach(function (node) {
    var list = files.filter(function (f) { return categoryKey(f.category) === node.key; });
    var entries = node.view ? (elements[node.view] || []) : [];
    if (!list.length && !entries.length) return;
    var ul = el('ul');
    var marked = false;
    if (entries.length) {
      var hot = entries.some(function (e) { return e.item && ITEM[e.item] && isOpen(ITEM[e.item]); });
      marked = marked || hot;
      ul.appendChild(el('li', null, el('a', { href: R.view(h.id, node.view), 'aria-current': route.sub === 'view' && route.arg === node.view ? 'true' : null, 'data-fk': 'view:' + node.view },
        el('span', { cls: 'mk' + (hot ? ' on' : ''), title: hot ? T.ex.marker : null }),
        el('span', { cls: 'nm', text: lbl(T.view, node.view) }),
        el('span', { cls: 'bdg', text: T.ex.viewTag + ' ' + entries.length }))));
    }
    list.forEach(function (f) {
      var st = fileStats(f);
      var hot = st.pending > 0 || st.open > 0;
      marked = marked || hot;
      var parts = pathParts(f.path);
      ul.appendChild(el('li', null, el('a', { href: R.file(h.id, f.id), title: f.path, 'aria-current': route.sub === 'file' && route.arg === f.id ? 'true' : null, 'data-fk': 'file:' + f.id },
        el('span', { cls: 'mk' + (hot ? ' on' : st.applied ? ' applied' : ''), title: hot ? T.ex.marker : null }),
        el('span', { cls: 'nm' }, parts[0] ? el('span', { cls: 'd', text: parts[0] }) : null, el('span', { cls: 'b', text: parts[1] })),
        f.virtual === 'new' ? el('span', { cls: 'bdg new', text: T.ex.isNew }) : f.virtual === 'missing' ? el('span', { cls: 'bdg', text: T.ex.missing })
          : f.omitted === 'linked' ? el('span', { cls: 'bdg link', text: T.ex.link }) : (hot && st.pending ? el('span', { cls: 'bdg', text: String(st.pending) }) : null))));
    });
    var count = list.length || entries.length;
    nav.appendChild(fold('tree:' + h.id + ':' + node.key, null, [
      el('span', { text: lbl(T.cat, node.key) }),
      marked ? el('span', { cls: 'mk on', title: T.ex.marker }) : null,
      el('span', { cls: 'cnt', text: String(count) }),
    ], ul, true));
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

function annotation(h, seg, first) {
  var item = ITEM[seg.item];
  var c = item.changes[seg.change] || {};
  var L = item.lesson || {};
  var card = el('aside', { cls: 'ann', 'aria-label': item.id + ' ' + item.title });
  var nth = item.changes.length > 1 ? el('span', { cls: 'ann-n', text: tx(T.ann.change, { n: seg.change + 1, m: item.changes.length }) }) : null;
  card.appendChild(el('div', { cls: 'ann-h' }, el('a', { cls: 'cid', href: R.item(item.id), title: T.ann.openCase, text: item.id }), first ? sevMarks(item.severity) : nth, first ? statusTags(item) : null));
  if (first) card.appendChild(el('div', { cls: 'ann-t', text: item.title }));
  if (first && nth) card.appendChild(nth);
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
  // The item is decided once: its first card in the file carries the buttons.
  var bar = first ? decisionBar(item.id, { compact: true }) : null;
  if (bar) card.appendChild(bar);
  return card;
}

function hunkCell(seg, at) {
  var key = seg.item + '.' + seg.change;
  var dead = ITEM[seg.item] && isDead(ITEM[seg.item]) && !seg.applied;
  var cell = el('div', { cls: 'fv-code hunk' + (seg.applied ? ' applied' : '') + (dead ? ' dead' : '') + (at === key ? ' target' : ''), id: 'hunk-' + key });
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

function fileViewer(h, shown, at) {
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

  var meta = el('div', { cls: 'fv-meta' }, tag(lbl(T.cat, categoryKey(shown.category)), 'info'));
  if (shown.omitted === 'linked') meta.appendChild(tag(T.ex.link, 'dashed'));
  if (file.virtual === 'new') meta.appendChild(tag(T.ex.isNew, 'ok'));
  if (file.virtual === 'missing') meta.appendChild(tag(T.ex.missing, 'warn'));
  if (pick('loaded')) meta.appendChild(tag(lbl(T.fv.loaded, pick('loaded')), pick('loaded') === 'always' ? 'navy' : pick('loaded') === 'never' ? 'dashed' : ''));
  if (typeof pick('tokens') === 'number') meta.appendChild(tag(tx(T.fv.tokens, { n: fmtInt(pick('tokens')) })));
  if (typeof pick('bytes') === 'number') meta.appendChild(tag(fmtBytes(pick('bytes'))));
  if (pick('lang')) meta.appendChild(tag(pick('lang')));
  if (shown.omitted !== 'linked') {
    if (shown.linkTo) meta.appendChild(tag(tx(T.fv.linkTo, { path: shown.linkTo }), 'dashed'));
    if (shown.inheritedFrom) meta.appendChild(HARNESS[shown.inheritedFrom] ? el('a', { cls: 'tag info', href: R.harness(shown.inheritedFrom), text: tx(T.fv.inherited, { name: harnessName(shown.inheritedFrom) }) }) : tag(tx(T.fv.inherited, { name: shown.inheritedFrom })));
  }
  pane.appendChild(el('div', { cls: 'fv-h' }, el('h3', { cls: 'fv-path', id: 'fv-title', text: shown.path }), meta, pick('role') ? el('p', { cls: 'fv-role', text: pick('role') }) : null));

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
    var seen = {};
    var noted = function (wrap, code, seg) {
      var note = el('div', { cls: 'fv-note' }, annotation(h, seg, !seen[seg.item]));
      seen[seg.item] = true;
      var lit = function (on) { return function () { code.classList.toggle('lit', on); }; };
      note.addEventListener('mouseenter', lit(true));
      note.addEventListener('mouseleave', lit(false));
      note.addEventListener('focusin', lit(true));
      note.addEventListener('focusout', lit(false));
      wrap.appendChild(code);
      wrap.appendChild(note);
      return note;
    };
    var total = res.segments.length;
    if (total) {
      var wrap = el('div', { cls: 'fv-wrap notes', role: 'group', 'aria-label': T.fv.code });
      res.segments.forEach(function (seg, index) {
        var code = seg.type === 'same' ? sameCell(file.id, seg, index, total) : hunkCell(seg, at);
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
        var code = hunkCell(seg, at);
        code.setAttribute('class', code.getAttribute('class') + ' first last has-note');
        var box = el('div', { cls: 'fv-wrap notes' });
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

/** A copy sorted by a use count; an unknown count (null) always goes last. Stable. */
function byUse(list, field, mostFirst) {
  return list.map(function (x, i) { return { x: x, i: i }; }).sort(function (a, b) {
    var av = typeof a.x[field] === 'number' ? a.x[field] : null;
    var bv = typeof b.x[field] === 'number' ? b.x[field] : null;
    if (av === null || bv === null) return ((av === null) - (bv === null)) || (a.i - b.i);
    return (mostFirst ? bv - av : av - bv) || (a.i - b.i);
  }).map(function (e) { return e.x; });
}

/** A measured count: zero is a real zero and is said out loud; null was not measured. */
function useCell(value, zeroForms, days) {
  if (typeof value !== 'number') return el('td', { cls: 'num' }, el('span', { cls: 'muted', text: T.notMeasured }));
  if (value === 0) return el('td', { cls: 'num' }, tag(pl(zeroForms, days), 'warn soft'));
  return el('td', { cls: 'num', text: fmtInt(value) });
}

function yesNo(v) { return v === true ? T.yes : v === false ? T.no : T.unknown; }
function measured(v) { return typeof v === 'number' ? fmtInt(v) : T.notMeasured; }
function noteCell(text) { return text ? el('small', { text: text }) : null; }
function itemCell(id) { return id ? cid(id) : null; }

var VIEWS = {
  permissions: function (h, list) {
    var layers = ['managed', 'user', 'project', 'local'];
    var kinds = ['deny', 'ask', 'allow', 'mode'];
    var tone = { deny: 'navy', ask: 'info', allow: '', mode: 'dashed' };
    var rows = [];
    layers.forEach(function (layer) {
      var inLayer = list.filter(function (p) { return p.layer === layer; });
      if (!inLayer.length) return;
      rows.push(groupRow(T.col.layer + ': ' + lbl(T.perm.layer, layer) + ' · ' + inLayer.length, 4));
      kinds.forEach(function (kind) {
        inLayer.filter(function (p) { return p.kind === kind; }).forEach(function (p) {
          rows.push(row(tag(lbl(T.perm.kind, p.kind), tone[p.kind]), [el('span', { cls: 'mono', text: p.rule }), noteCell(p.note)], fileLink(h, p.file), itemCell(p.item)));
        });
      });
    });
    return tableBox([T.col.kind, T.col.rule, T.col.file, T.col.item], rows, T.view.permissions);
  },
  hooks: function (h, list) {
    var tone = { yes: 'navy', no: '', unknown: 'dashed' };
    var rows = list.map(function (k) {
      var blocks = k.blocking === true ? 'yes' : k.blocking === false ? 'no' : 'unknown';
      return row([tag(lbl(T.hookSource, k.source)), k.plugin ? noteCell(tx(T.v.pluginOf, { name: k.plugin })) : null],
        [el('b', { text: k.event }), k.matcher ? el('small', { cls: 'mono', text: k.matcher }) : null],
        [k.command ? el('span', { cls: 'mono', text: k.command }) : null, noteCell(k.note)],
        tag(lbl(T.blocking, blocks), tone[blocks]),
        [fileLink(h, k.file), k.script && FILE[k.script] ? el('small', null, fileLink(h, k.script)) : null],
        itemCell(k.item));
    });
    return [
      el('p', { cls: 'legend-line' }, tag(T.blocking.yes, tone.yes), tag(T.blocking.no, tone.no), tag(T.blocking.unknown, tone.unknown), el('span', { text: T.v.hooksLegend })),
      tableBox([T.col.source, T.col.event, T.col.command, T.col.blocking, T.col.registered, T.col.item], rows, T.view.hooks),
    ];
  },
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
      return row([el('b', { text: p.name }), noteCell(p.note)], p.marketplace || '', p.enabled === undefined ? '' : yesNo(p.enabled), p.pinned === undefined ? '' : yesNo(p.pinned), itemCell(p.item));
    });
    return tableBox([T.col.name, T.col.marketplace, T.col.enabled, T.col.pinned, T.col.item], rows, T.view.plugins);
  },
  clis: function (h, list) {
    var rows = list.map(function (c) {
      return row([el('b', { cls: 'mono', text: c.name }), c.collision ? el('small', null, tag(T.v.collision, 'warn')) : null, noteCell(c.note)],
        tag(yesNo(c.installed), c.installed ? 'ok' : ''), c.version || '', c.auth ? lbl(T.auth, c.auth) : '',
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

function structuredView(h, name) {
  var list = (h.elements || {})[name] || [];
  var pane = el('div', { cls: 'pane' });
  pane.appendChild(el('div', { cls: 'fv-h' }, el('h3', { cls: 'fv-path', id: 'fv-title', text: lbl(T.view, name) }),
    el('div', { cls: 'fv-meta' }, tag(T.ex.viewTag, 'info'), tag(pl(T.ex.entries, list.length))), el('p', { cls: 'fv-role', text: lbl(T.viewSub, name) })));
  append(pane, [list.length && VIEWS[name] ? VIEWS[name](h, list) : el('p', { cls: 'empty', text: T.v.empty })]);
  return pane;
}

function explorerPane(h, route) {
  var selected = route.sub === 'file' || route.sub === 'view';
  var right;
  if (route.sub === 'file') {
    var f = FILE[route.arg];
    right = f && f.harness === h.id ? fileViewer(h, f, route.q.at || null) : el('div', { cls: 'pane' }, el('p', { cls: 'empty', text: T.ex.notFound }));
  } else if (route.sub === 'view' && Object.prototype.hasOwnProperty.call(VIEWS, route.arg)) {
    right = structuredView(h, route.arg);
  } else {
    selected = false;
    right = welcomePane(h);
  }
  var count = filesOf(h.id).length;
  return el('div', { cls: 'ex', 'data-sel': selected ? '1' : null },
    el('div', { cls: 'ex-side' },
      el('a', { cls: 'btn ghost small ex-back', href: R.harness(h.id), 'data-fk': 'ex:back' }, '‹ ' + T.ex.tree + ' (' + count + ')'),
      treeNav(h, route)),
    right);
}
