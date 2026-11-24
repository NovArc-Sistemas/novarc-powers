// Board client, fragment 8 of 9: the Decide tab: one decision at a time across every
// harness, then a summary of what was decided and what the session does next.

var DECIDE_KEYS = { approve: 'A', decline: 'R', defer: 'D', ask: 'P' };

/** True once nothing in a queue entry is waiting for the user (a question sent counts as handled). */
function entryHandled(entry) {
  var waiting = function (item) { var e = eff(item); return e.status === 'open' && !e.asked; };
  if (entry.kind === 'group') {
    var g = GROUP[entry.id];
    return !g || !g.items.some(function (id) { return ITEM[id] && waiting(ITEM[id]); });
  }
  return !ITEM[entry.id] || !waiting(ITEM[entry.id]);
}

function firstUnhandled(from) {
  for (var k = 0; k < QUEUE.length; k++) {
    var i = (from + k) % QUEUE.length;
    if (!entryHandled(QUEUE[i])) return i;
  }
  return -1;
}

function queueIndex(target) {
  for (var i = 0; i < QUEUE.length; i++) if (QUEUE[i].id === target) return i;
  return -1;
}

function summaryBox(title, items) {
  var ul = el('ul');
  items.slice(0, 12).forEach(function (i) { ul.appendChild(el('li', null, cid(i.id), el('span', { text: i.title }))); });
  if (items.length > 12) ul.appendChild(el('li', { cls: 'muted', text: '+' + (items.length - 12) }));
  return el('div', { cls: 'sumbox' }, el('b', { text: title }), ul);
}

function decideSummary() {
  var out = el('div');
  var left = firstUnhandled(0) >= 0;
  out.appendChild(heroBlock(T.nav.decide, left ? T.dc.pendingH : T.dc.doneH, null, null, true));
  var all = ST.items || [];
  var by = function (status) { return all.filter(function (i) { return eff(i).status === status; }); };
  var approved = by('approved');
  var declined = all.filter(function (i) { return overlay.items[i.id] && eff(i).status === 'declined'; });
  var deferred = all.filter(function (i) { return overlay.items[i.id] && eff(i).status === 'deferred'; });
  var asked = all.filter(function (i) { var e = eff(i); return e.status === 'open' && e.asked; });
  if (!QUEUE.length && !approved.length) out.appendChild(el('p', { cls: 'lead', text: T.dc.doneNone }));
  var boxes = el('div', { cls: 'summary' });
  if (approved.length) boxes.appendChild(summaryBox(pl(T.dc.approved, approved.length), approved));
  if (declined.length) boxes.appendChild(summaryBox(pl(T.dc.declined, declined.length), declined));
  if (deferred.length) boxes.appendChild(summaryBox(pl(T.dc.deferred, deferred.length), deferred));
  if (asked.length) boxes.appendChild(summaryBox(pl(T.dc.asked, asked.length), asked));
  if (boxes.firstChild) out.appendChild(boxes);

  var kind = channel.kind();
  var pending = pendingDecisions();
  var toPaste = kind === 'file' ? pending : pending.filter(function (d) { return sendState[d.id] === 'failed'; });
  var next = el('div', { cls: 'nextbox on-dark' }, el('h3', { text: T.dc.nextH }));
  if (!approved.length && !pending.length) next.appendChild(el('p', { text: T.dc.nextNothing }));
  else next.appendChild(el('p', { text: kind === 'file' ? T.dc.nextFile : kind === 'server' ? T.dc.nextServer : T.dc.nextArtifact }));
  if (toPaste.length) next.appendChild(pasteBox(toPaste));
  out.appendChild(next);
  if (QUEUE.length) out.appendChild(el('p', { style: { 'margin-top': '18px' } }, el('a', { cls: 'btn', href: R.decide(QUEUE[0].id), 'data-fk': 'dc:review', text: T.dc.review })));
  return out;
}

function decideGroup(group) {
  var members = group.items.map(function (id) { return ITEM[id]; }).filter(Boolean);
  var harnesses = [];
  members.forEach(function (m) { if (harnesses.indexOf(m.harness) < 0) harnesses.push(m.harness); });
  var chips = el('div', { cls: 'chips' });
  harnesses.forEach(function (hid) { chips.appendChild(HARNESS[hid] ? el('a', { href: R.harness(hid), text: harnessName(hid) }) : el('span', { text: hid })); });
  var saving = groupSaving(group);
  var box = el('article', { cls: 'case', 'aria-labelledby': 'dc-title' },
    el('header', { cls: 'chead' }, el('span', { cls: 'cid', text: group.id }), tag(T.dc.group, 'info'), tag(group.round + ' ' + lbl(T.rounds, group.round))),
    el('h3', { cls: 'ctitle', id: 'dc-title', text: group.title }),
    group.summary ? el('p', { cls: 'cfind', text: group.summary }) : null,
    chips,
    saving ? el('span', { cls: 'gain', text: saving }) : null,
    el('div', null, el('span', { cls: 'lbl', text: T.dc.members }), memberList(group, true)));
  members.forEach(function (m) {
    box.appendChild(fold('dc:case:' + m.id, 'foldbox', [m.id + ' · ' + harnessName(m.harness), el('span', { text: T.dc.fullCase })], el('div', { style: { padding: '0 14px 14px' } }, caseCard(m, { actions: false })), false));
  });
  return box;
}

function viewDecide(route) {
  if (route.arg === 'summary' || !QUEUE.length) return decideSummary();
  var index = route.arg ? queueIndex(route.arg) : -1;
  if (index < 0) index = firstUnhandled(0);
  if (index < 0) return decideSummary();
  var entry = QUEUE[index];
  var handled = QUEUE.filter(entryHandled).length;
  var out = el('div');
  out.appendChild(el('div', { cls: 'hero small' }, el('div', { cls: 'kicker' }, el('span', { cls: 'glyph' }), T.nav.decide), el('h2', { text: T.dc.h }), el('p', { cls: 'sub', text: T.dc.sub })));

  var prev = el('a', { cls: 'btn small', id: 'dc-prev', 'data-fk': 'dc:prev', href: R.decide(QUEUE[(index - 1 + QUEUE.length) % QUEUE.length].id), text: '‹ ' + T.dc.prev });
  var next = el('a', { cls: 'btn small', id: 'dc-next', 'data-fk': 'dc:next', href: index === QUEUE.length - 1 ? R.decide('summary') : R.decide(QUEUE[index + 1].id), text: T.dc.next + ' ›' });
  out.appendChild(el('div', { cls: 'dc-bar' }, prev,
    el('span', { cls: 'dc-prog', 'aria-live': 'polite', text: tx(T.dc.progress, { n: index + 1, m: QUEUE.length }) }),
    el('div', { cls: 'dc-track', 'aria-hidden': 'true' }, el('i', { style: { width: (handled / QUEUE.length * 100) + '%' } })),
    next));

  if (entry.kind === 'group') out.appendChild(decideGroup(GROUP[entry.id]));
  else {
    var item = ITEM[entry.id];
    out.appendChild(el('p', { cls: 'pathline', style: { 'margin-bottom': '10px' } }, T.dc.finding + ' ', txNodes(T.dc.inHarness, 'name', el('a', { href: R.diagnosis(item.harness, item.id), text: harnessName(item.harness) }))));
    out.appendChild(caseCard(item, { actions: false }));
  }
  var bar = decisionBar(entry.id, { big: true, keys: DECIDE_KEYS });
  if (bar) out.appendChild(el('div', { cls: 'dc-act', id: 'dc-act' }, bar));
  out.appendChild(el('p', { cls: 'dc-keys', text: T.dc.keys }));
  return out;
}

/** Where the Decide tab goes after a decision on `target`: the next waiting entry, or the summary. */
function afterDecision(target) {
  var index = queueIndex(target);
  if (index < 0) return null;
  if (!entryHandled(QUEUE[index])) return null;
  var nextIndex = firstUnhandled(index + 1);
  return nextIndex < 0 ? R.decide('summary') : R.decide(QUEUE[nextIndex].id);
}
