// Board client, fragment 4 of 10: the pieces every view shares: marks and tags, the kind of a
// harness, the folded "why it matters" note, code lines, the change panel and the full case.

/**
 * The severity as four slanted bars (as many filled as the severity is high, so it reads without
 * colour). `withWord` writes the severity beside them, in place of a separate tag.
 */
function sevMarks(sev, withWord) {
  var label = tx(T.severityAria, { severity: lbl(T.severity, sev) });
  var marks = el('span', { cls: 'sev ' + sev, role: withWord ? null : 'img', 'aria-label': withWord ? null : label, 'aria-hidden': withWord ? 'true' : null, title: label }, el('i'), el('i'), el('i'), el('i'));
  return withWord ? el('span', { cls: 'sevw ' + sev }, marks, lbl(T.severity, sev)) : marks;
}

// --- the kind of a harness ------------------------------------------------------------------
// An account (user harness) and a repository (project harness) never look alike: each kind has
// its own glyph, its own treatment (a filled signal-blue mark against an outlined navy one) and
// its own word, so the difference reads without colour too.

function kindGlyph(kind) {
  var user = kind === 'user';
  return svg('svg', { 'class': 'kg', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
    user ? [svg('circle', { cx: 8, cy: 5.2, r: 3 }), svg('path', { d: 'M2.2 14.6c.5-3.2 2.9-5.1 5.8-5.1s5.3 1.9 5.8 5.1z' })]
      : svg('path', { d: 'M1.5 3.5h4.6l1.5 1.7h6.9v8.3h-13z' }));
}

/** The marker of a harness kind. `opts`: { word: false } for the glyph alone (with a label for screen readers). */
function kindMark(kind, opts) {
  var k = kind === 'user' ? 'user' : 'project';
  var o = opts || {};
  var word = lbl(T.kind, k);
  if (o.word === false) return el('span', { cls: 'kind ' + k + ' bare', role: 'img', 'aria-label': word, title: word }, kindGlyph(k));
  return el('span', { cls: 'kind ' + k }, kindGlyph(k), el('span', { text: word }));
}

/** A harness name with its kind marker in front, as a link to the harness when `link` is set. */
function harnessRef(hid, link) {
  var h = HARNESS[hid];
  if (!h) return el('span', { text: String(hid) });
  var body = [kindMark(h.kind, { word: false }), el('span', { text: h.name })];
  return link ? el('a', { cls: 'href', href: R.harness(hid) }, body) : el('span', { cls: 'href' }, body);
}

/**
 * Teaching text the reader needs once: folded behind a small "why it matters" toggle, so that
 * what drives a decision is what shows at first glance. The text stays one click away.
 */
function whyNote(text, key) {
  if (!text) return null;
  return fold('why:' + (key || text.slice(0, 40)), 'why', T.why, el('p', { text: text }), false);
}


function statusTone(status) {
  if (status === 'fixed' || status === 'ok') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'open' || status === 'deferred') return 'warn';
  if (status === 'approved' || status === 'in-progress') return 'info';
  return '';
}

function tag(text, tone) { return el('span', { cls: 'tag' + (tone ? ' ' + tone : ''), text: text }); }

function statusTags(item) {
  var e = eff(item);
  var out = [el('span', { cls: 'tag st ' + statusTone(e.status), text: lbl(T.status, e.status) })];
  // What an earlier review left on this finding, beside the status it has now: a decline kept
  // because the same proposal came back, or an open finding that was declined before and comes
  // back with another proposal.
  var carried = carriedDecline(item, e.status);
  if (carried) out.push(el('span', { cls: 'tag dashed', title: carriedLine(carried, T, FMT), text: T.hist.keptChip }));
  else if (e.status === 'open' && declinedBefore(item)) out.push(tag(T.hist.declinedBefore, 'dashed'));
  if (e.asked && e.status === 'open') out.push(tag(T.statusAsked, 'info'));
  return out;
}

/** The item id as a chip that opens its diagnosis. */
function cid(itemId) {
  var item = ITEM[itemId];
  if (!item) return el('span', { cls: 'cid', text: itemId });
  return el('a', { cls: 'cid st-' + item.status, href: R.item(itemId), title: item.title, text: itemId });
}

function cids(ids) {
  return (ids || []).map(function (id) { return cid(id); });
}

function tableBox(head, rows, label) {
  var tr = el('tr');
  head.forEach(function (h) { tr.appendChild(el('th', { scope: 'col', text: h })); });
  var tb = el('tbody');
  rows.forEach(function (r) { tb.appendChild(r); });
  return el('div', { cls: 'scroll', tabindex: '0', role: 'region', 'aria-label': label || head.join(', ') }, el('table', null, el('thead', null, tr), tb));
}

function row() {
  var tr = el('tr');
  for (var i = 0; i < arguments.length; i++) {
    var c = arguments[i];
    tr.appendChild(c && c.nodeType === 1 && (c.tagName === 'TD' || c.tagName === 'TH') ? c : el('td', null, c));
  }
  return tr;
}

function groupRow(text, span) { return el('tr', { cls: 'grp' }, el('td', { colspan: span, text: text })); }

/**
 * A page section. `sub` is a line shown under the title, or `{ why: text }` for teaching text,
 * folded behind "why it matters". `toc` (`{ id, label }`, optional, as the fourth argument when
 * it is an object with an id) lists the section in the side index.
 */
function section(kicker, title, sub) {
  var rest = Array.prototype.slice.call(arguments, 3);
  var toc = rest.length && rest[0] && rest[0].nodeType === undefined && rest[0].id ? rest.shift() : null;
  var s = el('section', { cls: 'sec', id: toc ? toc.id : null, 'data-toc': toc ? (toc.label || title) : null });
  if (kicker) s.appendChild(el('div', { cls: 'sec-k', text: kicker }));
  s.appendChild(el('h2', { text: title }));
  if (sub && typeof sub === 'object') s.appendChild(whyNote(sub.why, title));
  else if (sub) s.appendChild(el('p', { cls: 'sub', text: sub }));
  return append(s, rest);
}

/** The id of an item as a button that copies it, for saying it in the chat ("approve U1-101"). */
function copyId(id, cls) {
  var b = el('button', { type: 'button', cls: 'cid copy' + (cls ? ' ' + cls : ''), title: tx(T.pend.copy, { id: id }), 'aria-label': tx(T.pend.copy, { id: id }), 'data-fk': 'copy:' + id, text: id });
  b.addEventListener('click', function () { copyText(id, b); });
  return b;
}

// --- code -----------------------------------------------------------------------------------

/** One line of file text. `two` draws both the before and the after line number. */
function lineEl(kind, text, oldNo, newNo, two) {
  var r = el('div', { cls: 'ln' + (two ? ' two' : '') + (kind === 'same' ? '' : ' ' + kind) });
  if (two) r.appendChild(el('span', { cls: 'no', text: oldNo ? String(oldNo) : '' }));
  r.appendChild(el('span', { cls: 'no', text: two ? (newNo ? String(newNo) : '') : String(oldNo || newNo || '') }));
  r.appendChild(el('span', { cls: 'mk', text: kind === 'add' ? '+' : kind === 'del' ? '-' : '' }));
  r.appendChild(el('span', { cls: 'tx', text: text }));
  return r;
}

function changeKind(c) {
  if (c.before === '') return !c.file && !c.insertAfter ? 'created' : 'inserted';
  if (c.after === '') return 'removed';
  return 'changed';
}

/** Where a change sits: `{ file, located, code }`. */
function placeOf(item, index) {
  var list = ANCH.byItem[item.id] || [];
  return list[index] || { file: null, located: false, code: null };
}

/** One change as a dark panel: the edit with a few lines of the file around it. */
function changePanel(item, index) {
  var c = item.changes[index];
  var at = placeOf(item, index);
  var res = at.file ? anchorOf(at.file) : null;
  var ctx = res ? Anchors.hunkContext(res, item.id, index, 3) : null;
  var rows = ctx ? ctx.rows : [];
  var added = rows.filter(function (r) { return r.t === 'add'; }).length;
  var removed = rows.filter(function (r) { return r.t === 'del'; }).length;
  var head = el('div', { cls: 'dhead' },
    el('span', { cls: 'fpath', text: c.path }),
    el('span', { cls: 'fkind', text: lbl(T.dg.kind, changeKind(c)) }),
    el('span', { cls: 'cnt' }, el('b', { cls: 'p', text: '+' + added }), ' ', el('b', { cls: 'm', text: '-' + removed })),
    c.applied ? el('span', { cls: 'pill applied' }, el('i'), T.fv.applied) : el('span', { cls: 'pill prev', text: T.fv.proposal }),
    !at.located && at.code !== 'applied-removal' ? el('span', { cls: 'pill lost', title: lbl(T.problem, at.code), text: T.dg.notPlaced }) : null,
    at.file && FILE[at.file] ? el('a', { href: R.file(FILE[at.file].harness, at.file, item.id + '.' + index), text: T.dg.seeInFile }) : null);
  var body = el('div', { cls: 'dbody', role: 'group', 'aria-label': T.fv.code });
  rows.forEach(function (r) { body.appendChild(lineEl(r.t, r.text, r.old, r.new, true)); });
  return el('div', { cls: 'diff' }, head,
    c.why ? el('div', { cls: 'dwhy' }, el('span', { cls: 'glyph' }), el('span', { text: c.why })) : null,
    !at.located && at.code && at.code !== 'applied-removal' ? el('div', { cls: 'dwhy' }, el('span', { cls: 'problem', text: lbl(T.problem, at.code) })) : null,
    body);
}

// --- the case -------------------------------------------------------------------------------

function lessonCols(L) {
  var col = function (cls, key) {
    return L[key] ? el('div', { cls: 'lcol ' + cls }, el('span', { cls: 'lk' }, el('span', { cls: 'dot' }), T.lesson[key]), el('p', { text: L[key] })) : null;
  };
  return el('div', { cls: 'lesson' }, col('bad', 'why'), col('cost', 'impact'), col('good', 'better'));
}

function metaBlock(label, child) {
  return el('div', null, el('span', { cls: 'lbl', text: label }), typeof child === 'string' ? el('p', { text: child }) : el('p', null, child));
}

function lowerFirst(text) { var s = String(text); return s.charAt(0).toLowerCase() + s.slice(1); }

/** The label of a comparable metric (`$defs.metric` in the state schema). */
function metricLabel(name) { return lbl(T.fu.metric, name); }

function savesText(saves) {
  return pl(T.dg.saves, windowDays(), { tokens: fmtTokens(saves.tokens), basis: lbl(T.basis, saves.basis) }) + (saves.how ? ' · ' + saves.how : '')
    // The measurement the saving should show up in: what the next review will compare.
    + (saves.metric ? ' · ' + tx(T.fu.checkedIn, { metric: lowerFirst(metricLabel(saves.metric)) }) : '');
}

/**
 * What happened to this finding in earlier reviews: one line, or nothing when the records say
 * nothing. A decline that was kept because the same proposal came back says so first, in its own
 * line, with the note of that decision; the history line then leaves that decision out.
 */
function historyNote(item) {
  var hist = itemHistory(item);
  var carried = carriedDecline(item, eff(item).status);
  var rest = hist ? historyLine(hist, T, FMT, !!carried) : '';
  return [
    carried ? el('p', { cls: 'chist kept', text: carriedLine(carried, T, FMT) }) : null,
    rest ? el('p', { cls: 'chist', text: rest }) : null,
  ];
}

/**
 * The full case of one item: what is wrong, the lesson, the exact change, the rule to keep and
 * what was decided, as the state records it. `opts`: { target }.
 */
function caseCard(item, opts) {
  var o = opts || {};
  var L = item.lesson || {};
  var e = eff(item);
  var slim = !item.lesson && !(item.changes || []).length && (e.status === 'ok' || e.status === 'not-applicable');
  var card = el('article', { cls: 'case' + (slim ? ' slim' : '') + (o.target ? ' target' : ''), id: 'case-' + item.id, 'aria-labelledby': 'case-t-' + item.id });
  var head = el('header', { cls: 'chead' },
    copyId(item.id),
    sevMarks(item.severity, true),
    tag(item.round + ' ' + lbl(T.rounds, item.round)),
    item['class'] && item['class'] !== 'none' ? tag(lbl(T['class'], item['class'])) : null,
    item.origin && item.origin !== 'active' ? tag(lbl(T.origin, item.origin), 'dashed') : null,
    item.group && GROUP[item.group] ? el('a', { cls: 'tag info', href: R.pending(), text: tx(T.dg.group, { id: item.group }) }) : null,
    statusTags(item));
  card.appendChild(head);
  card.appendChild(el('h3', { cls: 'ctitle', id: 'case-t-' + item.id, text: item.title }));
  card.appendChild(el('p', { cls: 'cfind' }, item.finding, item.evidence ? [' ', el('span', { cls: 'evid', text: item.evidence })] : null));
  append(card, [historyNote(item)]);
  if (slim) {
    card.appendChild(el('p', { cls: 'muted', text: item.opinion }));
    return card;
  }
  if (L.why || L.impact || L.better) card.appendChild(lessonCols(L));

  var changes = item.changes || [];
  if (changes.length) {
    var box = el('div', { cls: 'changes' }, el('div', { cls: 'clabel' }, el('span', { cls: 'lbl', text: T.dg.change }), el('span', { text: pl(T.dg.edits, changes.length) })));
    changes.forEach(function (c, k) { box.appendChild(changePanel(item, k)); });
    card.appendChild(box);
  } else {
    card.appendChild(el('div', { cls: 'nodiff' }, el('span', { cls: 'lbl', text: T.dg.proposal }), el('p', { text: item.proposal }),
      item.file ? el('p', { cls: 'pathline', text: item.file }) : null));
  }

  var meta = el('div', { cls: 'meta2' },
    L.tradeoff ? metaBlock(T.lesson.tradeoff, L.tradeoff) : null,
    changes.length ? metaBlock(T.field.proposal, item.proposal) : null,
    metaBlock(T.field.opinion, item.opinion),
    item.saves ? metaBlock(T.field.saves, savesText(item.saves)) : null,
    item.decision ? metaBlock(T.field.decision, item.decision) : null,
    e.question ? metaBlock(T.field.question, e.question) : null,
    item.verified ? metaBlock(T.field.verified, item.verified) : null,
    item.notVerified ? metaBlock(T.field.notVerified, item.notVerified) : null,
    item.backup ? metaBlock(T.field.backup, el('span', { cls: 'mono', text: item.backup })) : null,
    item.updatedAt ? el('p', { cls: 'upd', text: T.field.updated + ' ' + fmtDate(item.updatedAt, true) }) : null,
    L.learnMore ? metaBlock(T.lesson.learnMore, extLink(L.learnMore)) : null);
  card.appendChild(el('div', { cls: 'cfoot' + (L.principle ? '' : ' solo') },
    L.principle ? el('div', { cls: 'principle' }, el('span', { cls: 'pk' }, el('span', { cls: 'glyph' }), T.lesson.principle), el('p', { text: L.principle })) : null,
    meta));
  return card;
}
