// Board client, fragment 4 of 9: the pieces every view shares: marks and tags, code lines, the
// change panel, the full case, the decision bar and the paste-in-chat box.

function sevMarks(sev) {
  var label = tx(T.severityAria, { severity: lbl(T.severity, sev) });
  return el('span', { cls: 'sev ' + sev, role: 'img', 'aria-label': label, title: label }, el('i'), el('i'), el('i'), el('i'));
}

function sevTone(sev) { return sev === 'critical' || sev === 'high' ? 'bad' : sev === 'medium' ? 'warn' : 'info'; }

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
  if (e.asked && e.status === 'open') out.push(tag(T.statusAsked, 'info'));
  return out;
}

/** The item id as a chip that opens its diagnosis. */
function cid(itemId) {
  var item = ITEM[itemId];
  if (!item) return el('span', { cls: 'cid', text: itemId });
  return el('a', { cls: 'cid st-' + eff(item).status, href: R.item(itemId), title: item.title, text: itemId });
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

function section(kicker, title, sub) {
  var s = el('section', { cls: 'sec' });
  if (kicker) s.appendChild(el('div', { cls: 'sec-k', text: kicker }));
  s.appendChild(el('h2', { text: title }));
  if (sub) s.appendChild(el('p', { cls: 'sub', text: sub }));
  return append(s, Array.prototype.slice.call(arguments, 3));
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

function savesText(saves) {
  return pl(T.dg.saves, windowDays(), { tokens: fmtTokens(saves.tokens), basis: lbl(T.basis, saves.basis) }) + (saves.how ? ' · ' + saves.how : '');
}

/**
 * The full case of one item: what is wrong, the lesson, the exact change, the rule to keep and
 * the decision. `opts`: { target, actions, big }.
 */
function caseCard(item, opts) {
  var o = opts || {};
  var L = item.lesson || {};
  var e = eff(item);
  var slim = !item.lesson && !(item.changes || []).length && (e.status === 'ok' || e.status === 'not-applicable');
  var card = el('article', { cls: 'case' + (slim ? ' slim' : '') + (o.target ? ' target' : ''), id: 'case-' + item.id, 'aria-labelledby': 'case-t-' + item.id });
  var head = el('header', { cls: 'chead' },
    el('span', { cls: 'cid', text: item.id }),
    sevMarks(item.severity),
    tag(lbl(T.severity, item.severity), sevTone(item.severity)),
    tag(item.round + ' ' + lbl(T.rounds, item.round)),
    item['class'] && item['class'] !== 'none' ? tag(lbl(T['class'], item['class'])) : null,
    item.origin && item.origin !== 'active' ? tag(lbl(T.origin, item.origin), 'dashed') : null,
    item.group && GROUP[item.group] ? el('a', { cls: 'tag info', href: R.decide(item.group), text: tx(T.dg.group, { id: item.group }) }) : null,
    statusTags(item));
  card.appendChild(head);
  card.appendChild(el('h3', { cls: 'ctitle', id: 'case-t-' + item.id, text: item.title }));
  card.appendChild(el('p', { cls: 'cfind' }, item.finding, item.evidence ? [' ', el('span', { cls: 'evid', text: item.evidence })] : null));
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
    item.updatedAt ? metaBlock(T.field.updated, fmtDate(item.updatedAt, true)) : null,
    L.learnMore ? metaBlock(T.lesson.learnMore, extLink(L.learnMore)) : null);
  card.appendChild(el('div', { cls: 'cfoot' + (L.principle ? '' : ' solo') },
    L.principle ? el('div', { cls: 'principle' }, el('span', { cls: 'pk' }, el('span', { cls: 'glyph' }), T.lesson.principle), el('p', { text: L.principle })) : null,
    meta));
  if (o.actions !== false) {
    var bar = decisionBar(item.id, { big: o.big });
    if (bar) card.appendChild(el('div', { cls: 'cact' }, bar));
  }
  return card;
}

// --- decisions ------------------------------------------------------------------------------

/** What the user typed or toggled in a decision bar, kept across redraws. */
var barState = {};
var excluded = {};
var uidSeq = 0;

function barOf(target) { return barState[target] || (barState[target] = { reopen: false, note: false, ask: false, text: '', error: false }); }

function excludedOf(groupId) { return Object.keys(excluded[groupId] || {}).filter(function (id) { return excluded[groupId][id]; }); }

function pasteMini(decision, failed) {
  var cmd = decisionCommand(decision);
  var btn = el('button', { type: 'button', cls: 'btn small', text: T.send.copy });
  btn.addEventListener('click', function () { copyText(cmd, btn); });
  return el('div', { cls: 'paste' }, el('p', { text: failed ? T.send.failed : T.send.pasteOne }), el('code', { text: cmd }), el('div', { cls: 'row' }, btn));
}

/** Several commands in one box, for the summary and the tray. */
function pasteBox(decisions) {
  var text = decisions.map(decisionCommand).join('\n');
  var ta = el('textarea', { readonly: true, rows: String(Math.min(12, Math.max(2, decisions.length))), 'aria-label': T.send.pasteTitle, spellcheck: 'false' });
  ta.value = text;
  ta.addEventListener('focus', function () { ta.select(); });
  var btn = el('button', { type: 'button', cls: 'btn primary small', text: T.send.copyAll });
  btn.addEventListener('click', function () { copyText(text, btn); });
  return el('div', { cls: 'paste' }, el('p', { text: T.send.pasteHint }), ta, el('div', { cls: 'row' }, btn));
}

/**
 * Buttons and status for one target (an item or a group). Returns null when there is nothing to
 * decide and nothing decided here. `opts`: { big, keys, compact }.
 */
function decisionBar(target, opts) {
  var o = opts || {};
  var group = GROUP[target] || null;
  var item = group ? null : ITEM[target];
  if (!group && !item) return null;
  var ui = barOf(target);
  var local = group ? overlay.groups[target] || null : overlay.items[target] || null;
  var members = group ? group.items.map(function (id) { return ITEM[id]; }).filter(Boolean) : [];
  var decidable = group ? members.some(canDecide) : canDecide(item);
  var settled = group ? !members.some(function (m) { return eff(m).status === 'open'; }) : item.status !== 'open';
  var wrap = el('div', { cls: 'dbar' });

  var showButtons = decidable && (ui.reopen || (!local && !settled));
  if (local && !ui.reopen) {
    var line = el('div', { cls: 'dstate ' + local.action }, el('span', { cls: 'pip' }), el('span', { text: T.decided[local.action] }));
    if (local.note && local.action !== 'ask') line.appendChild(el('span', { cls: 'muted', text: local.note }));
    if (sendState[local.id] === 'sending') line.appendChild(el('span', { cls: 'muted', text: T.send.sending }));
    wrap.appendChild(line);
    if (local.action === 'ask' && local.note) wrap.appendChild(el('p', { cls: 'muted', text: local.note }));
    if (sendState[local.id] === 'failed' || sendState[local.id] === 'paste') wrap.appendChild(pasteMini(local, sendState[local.id] === 'failed'));
  } else if (!local && settled && !ui.reopen) {
    if (!decidable) return null;
    if (group) wrap.appendChild(el('div', { cls: 'dstate' }, el('span', { cls: 'pip' }), el('span', { text: tx(T.grp.decided, { done: members.length, total: members.length }) })));
    else wrap.appendChild(el('div', { cls: 'dstate' }, el('span', { cls: 'pip' }), el('span', { text: lbl(T.status, item.status) }), item.decision ? el('span', { cls: 'muted', text: item.decision }) : null));
  }

  if (!showButtons) {
    if (decidable) {
      var change = el('button', { type: 'button', cls: 'btn ghost small', 'data-fk': 'chg:' + target, text: T.act.change });
      change.addEventListener('click', function () { ui.reopen = true; redraw(); });
      wrap.firstChild ? wrap.firstChild.appendChild(change) : wrap.appendChild(change);
    }
    return wrap;
  }

  var send = function (action) {
    var note = ui.text.trim();
    if (action === 'ask' && !note) { ui.ask = true; ui.note = true; ui.error = true; redraw(); return; }
    barState[target] = { reopen: false, note: false, ask: false, text: '', error: false };
    decide(target, action, note, group ? excludedOf(target) : []);
  };
  var button = function (action, primary) {
    var b = el('button', { type: 'button', cls: 'btn' + (primary ? ' primary' : '') + (o.big ? '' : ' small'), 'data-fk': 'dec:' + target + ':' + action, 'data-act': action },
      primary ? el('span', { cls: 's' }) : null, action === 'ask' && ui.ask ? T.act.sendQuestion : T.act[action],
      o.keys ? el('kbd', { text: o.keys[action] }) : null);
    b.addEventListener('click', function () {
      if (action === 'ask' && !ui.ask) { ui.ask = true; ui.note = true; redraw(); return; }
      send(action);
    });
    return b;
  };
  var btns = el('div', { cls: 'dbtns', 'data-target': target }, button('approve', true), button('decline'), button('defer'), button('ask'));
  if (!ui.note && !o.compact) {
    var add = el('button', { type: 'button', cls: 'btn ghost small', 'data-fk': 'note:' + target, text: T.act.addNote });
    add.addEventListener('click', function () { ui.note = true; redraw(); });
    btns.appendChild(add);
  } else if (ui.reopen || ui.ask) {
    var cancel = el('button', { type: 'button', cls: 'btn ghost small', text: T.act.cancel });
    cancel.addEventListener('click', function () { ui.reopen = false; ui.ask = false; ui.note = false; ui.error = false; redraw(); });
    btns.appendChild(cancel);
  }
  wrap.appendChild(btns);
  if (ui.note) {
    var id = 'note-' + (++uidSeq);
    var ta = el('textarea', { id: id, 'data-fk': 'ta:' + target, rows: '2' });
    ta.value = ui.text;
    ta.addEventListener('input', function () { ui.text = ta.value; if (ui.error && ta.value.trim()) { ui.error = false; } });
    wrap.appendChild(el('div', { cls: 'dnote-f' }, el('label', { 'for': id, text: ui.ask ? T.act.questionLabel : T.act.noteLabel }), ta,
      ui.error ? el('span', { cls: 'err', role: 'alert', text: T.act.questionRequired }) : null));
  }
  if (item && item.question && !local) wrap.appendChild(el('p', { cls: 'muted', text: T.statusAsked + ': ' + item.question }));
  return wrap;
}
