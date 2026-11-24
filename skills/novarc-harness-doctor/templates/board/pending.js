// Board client, fragment 8 of 10: the Pending view. What waits for the user's decision, read from
// the state: groups first, then each harness (accounts before projects) with its open findings,
// most serious first. The board does not decide anything: each entry has its id as a button that
// copies it, so the user can name it in the chat with the agent. What was already decided is
// listed below, folded.

/** Statuses that mean the user (or the session) already decided the finding. */
var DECIDED = { approved: true, 'in-progress': true, fixed: true, failed: true, declined: true, deferred: true };

/** The expected saving of one item, in the words of the group card, or null. */
function itemSaving(item) {
  var s = item.saves;
  if (!s || !countOf(s.tokens)) return null;
  return pl(T.grp.saving, windowDays(), { tokens: fmtTokens(s.tokens) }) + (s.basis === 'estimated' ? ' (' + T.grp.estimated + ')' : '');
}

/** One open finding as one row: id to copy, severity, title (a link to its full case), saving. */
function pendingRow(item) {
  var saving = itemSaving(item);
  return el('li', { cls: 'prow', 'data-item': item.id },
    copyId(item.id),
    sevMarks(item.severity, true),
    el('span', { cls: 'pt' }, el('a', { href: R.item(item.id), text: item.title }),
      declinedBefore(item) ? tag(T.hist.declinedBefore, 'dashed') : null,
      item.question ? el('small', { cls: 'pq', text: T.field.question + ': ' + item.question }) : null),
    saving ? el('span', { cls: 'gain', text: saving }) : el('span'));
}

function pendingGroup(group) {
  var members = group.items.map(function (id) { return ITEM[id]; }).filter(Boolean);
  var open = members.filter(isOpen);
  var harnesses = [];
  members.forEach(function (m) { if (harnesses.indexOf(m.harness) < 0) harnesses.push(m.harness); });
  var saving = groupSaving(group);
  return el('li', { cls: 'pgroup', 'data-item': group.id },
    el('div', { cls: 'pg-h' }, copyId(group.id), el('b', { text: group.title }), tag(group.round + ' ' + lbl(T.rounds, group.round))),
    group.summary ? el('p', { text: group.summary }) : null,
    el('div', { cls: 'pg-m' }, el('span', { cls: 'lbl', text: pl(T.pend.inGroup, open.length) }), cids(open.map(function (m) { return m.id; })),
      harnesses.map(function (hid) { return harnessRef(hid, true); })),
    saving ? el('span', { cls: 'gain', text: saving }) : null);
}

function viewPending() {
  var out = el('div', { cls: 'pending' });
  var open = openItems();
  out.appendChild(heroBlock(T.pend.kicker, open.length ? pl(T.pend.h, open.length) : T.pend.noneH, el('p', { cls: 'lead chat-line', text: T.pend.line }), null, true));

  var groups = QUEUE.filter(function (e) { return e.kind === 'group'; }).map(function (e) { return GROUP[e.id]; }).filter(Boolean);
  if (groups.length) {
    var gl = el('ul', { cls: 'plist' });
    groups.forEach(function (g) { gl.appendChild(pendingGroup(g)); });
    out.appendChild(section(null, T.grp.h, { why: T.grp.sub }, { id: 'p-groups', label: T.grp.h }, gl));
  }

  // Each harness with what it still has open, in the order of the queue (most serious first,
  // what was declined before last). An item a group covers is listed under its harness too.
  var order = {};
  QUEUE.forEach(function (e, k) { order[e.id] = k; });
  var rank = function (i) { return Object.prototype.hasOwnProperty.call(order, i.id) ? order[i.id] : QUEUE.length + SEV_RANK[i.severity]; };
  HARNESS_ORDER.forEach(function (h) {
    var list = openItems(h.id).sort(function (a, b) { return rank(a) - rank(b); });
    if (!list.length) return;
    var ul = el('ul', { cls: 'plist' });
    list.forEach(function (i) { ul.appendChild(pendingRow(i)); });
    var head = el('div', { cls: 'ph' }, kindMark(h.kind), el('h2', null, el('a', { href: R.diagnosis(h.id), text: h.name })), el('span', { cls: 'muted', text: pl(T.fleet.toDecide, list.length) }));
    out.appendChild(el('section', { cls: 'sec psec', id: 'p-' + h.id, 'data-toc': h.name }, head, ul));
  });
  if (!open.length) out.appendChild(el('p', { cls: 'empty', text: T.pend.none }));

  // Findings held for an experiment, apart from what is decided now: one group per harness, with
  // the date they wait for.
  HARNESS_ORDER.forEach(function (h) {
    var e = experimentOf(h.id);
    var held = itemsOf(h.id).filter(isHeld);
    if (!e || !held.length) return;
    var ul = el('ul', { cls: 'plist held' });
    held.forEach(function (i) { ul.appendChild(pendingRow(i)); });
    var title = pl(T.xp.heldH, held.length, { date: fmtDate(e.until) });
    out.appendChild(el('section', { cls: 'sec psec pheld', id: 'p-held-' + h.id, 'data-toc': title },
      el('div', { cls: 'ph' }, kindMark(h.kind), el('h2', null, el('a', { href: R.diagnosis(h.id), text: h.name })), el('span', { cls: 'muted', text: title })),
      el('p', { cls: 'muted', text: T.xp.heldSub }), ul));
  });

  // What was decided already, with the note the decision left: folded, it is history.
  var decided = (ST.items || []).filter(function (i) { return DECIDED[i.status]; });
  if (decided.length) {
    var rows = decided.map(function (i) {
      return row(cid(i.id), [i.title, el('small', null, harnessRef(i.harness, false))], statusTags(i), i.decision ? el('small', { text: i.decision }) : '');
    });
    var title = pl(T.pend.decidedH, decided.length);
    out.appendChild(el('section', { cls: 'sec', id: 'p-decided', 'data-toc': title },
      fold('pend:decided', 'foldbox', title, tableBox([T.col.item, T.col.title, T.col.status, T.field.decision], rows, title), false)));
  }
  return out;
}
