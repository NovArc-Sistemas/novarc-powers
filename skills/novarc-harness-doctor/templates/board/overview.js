// Board client, fragment 5 of 10: the overview tab: title, totals, accounts, one row per
// harness and the group decisions.

function heroBlock(kicker, titleNodes, lead, byline, small) {
  var hero = el('div', { cls: 'hero' + (small ? ' small' : '') },
    el('div', { cls: 'kicker' }, el('span', { cls: 'glyph' }), kicker),
    el('h1', { cls: 'frame' }, el('span', { cls: 'br l' }), el('span', { cls: 'br r' }), titleNodes),
    el('span', { cls: 'sweep' }));
  if (lead) hero.appendChild(typeof lead === 'string' ? el('p', { cls: 'lead', text: lead }) : lead);
  if (byline && byline.length) {
    var by = el('div', { cls: 'byline' });
    byline.forEach(function (b) { if (b) by.appendChild(el('span', null, b[0] ? b[0] + ' ' : null, el('b', { text: b[1] }))); });
    hero.appendChild(by);
  }
  return hero;
}

function measuredWaste(impact) { return Scoring.wasteOf(impact).tokens; }

function sessionsOf(h) { return Scoring.sessionsOfHarness(h); }

/** An account or a project where the review found nothing at all to look at. */
function isEmptyHarness(h) {
  var els = h.elements || {};
  var any = Object.keys(els).some(function (k) { return (els[k] || []).length > 0; });
  return !any && !filesOf(h.id).length && !itemsOf(h.id).length && !h.impact;
}

function emptyText(h) { return h.kind === 'user' ? T.hz.emptyUser : T.hz.emptyProject; }

function totalsBand() {
  var scores = HARNESS_ORDER.map(function (h) { return scoresOf(h.id); });
  var base = Scoring.averageScore(scores.map(function (s) { return s.baseline; }));
  var proj = Scoring.averageScore(scores.map(function (s) { return s.projected; }));
  var single = ST.harnesses.length === 1;
  var band = el('div', { cls: 'totals' });
  var tot = function (value, label, note) {
    band.appendChild(el('div', { cls: 'tot' }, value, el('div', { cls: 'lbl', text: label }), note ? el('div', { cls: 'k' }, note) : null));
  };

  if (base === null) {
    tot(el('div', { cls: 'v none', text: T.notScored }), single ? T.tot.gradeOne : T.tot.gradeFleet, T.sc.ariaNone);
  } else {
    var gb = Scoring.gradeFor(base);
    var gp = Scoring.gradeFor(proj);
    var moved = proj !== base;
    tot(el('div', { cls: 'v' }, gb, moved ? [el('span', { cls: 'arrow', 'aria-hidden': 'true', text: '\u2192' }), el('span', { cls: 'to', text: gp })] : null),
      single ? T.tot.gradeOne : T.tot.gradeFleet,
      tx(moved ? T.tot.gradeNote : T.tot.gradeSame, { before: fmtScore(base), after: fmtScore(proj) }));
  }

  // What the run spent, with no session counted twice. An account's impact already contains its
  // sessions in every project, so Scoring.fleetImpact adds the measured accounts, or the measured
  // projects when no account was measured; the note under the number says which.
  var fleet = Scoring.fleetImpact(HARNESS_ORDER);
  var days = windowDays();
  if (fleet.basis) {
    var part = fleet.relative && fleet.relTotal ? txNodes(T.tot.wasteShareRelative, 'pct', el('b', { text: fmtPct(fleet.relWaste, fleet.relTotal) }))
      : fleet.total ? txNodes(T.tot.wasteShare, 'pct', el('b', { text: fmtPct(fleet.waste, fleet.total) })) : [];
    tot(el('div', { cls: 'v', text: fmtTokens(fleet.waste) }), pl(T.tot.waste, days),
      [part, part.length ? ', ' : null, pl(fleet.basis === 'accounts' ? T.tot.sumAccounts : T.tot.sumProjects, fleet.measured)]);
  } else tot(el('div', { cls: 'v none', text: T.notMeasured }), pl(T.tot.waste, days), T.tot.wasteNone);
  tot(el('div', { cls: 'v' + (fleet.sessions === null ? ' none' : ''), text: fleet.sessions === null ? T.notMeasured : fmtInt(fleet.sessions) }), T.tot.sessions,
    fleet.sessions === null ? null : pl(fleet.sessionsBasis === 'accounts' ? T.tot.inAccounts : T.tot.inProjects, fleet.sessionsFrom));

  var open = openItems();
  var groups = (ST.groups || []).filter(function (g) { return g.items.some(function (id) { return ITEM[id] && isOpen(ITEM[id]); }); });
  var covered = {};
  groups.forEach(function (g) { g.items.forEach(function (id) { if (ITEM[id] && isOpen(ITEM[id])) covered[id] = true; }); });
  tot(el('div', { cls: 'v', text: fmtInt(open.length) }), T.tot.open,
    [groups.length ? pl(T.tot.openNote, groups.length, { items: fmtInt(Object.keys(covered).length) }) + ' ' : null,
      open.length ? el('a', { cls: 'tot-go', href: R.pending(), text: T.tot.seePending }) : null]);
  return band;
}

// --- accounts -------------------------------------------------------------------------------

function elementTone(state) {
  if (state === 'linked' || state === 'generated' || state === 'copied') return 'ok';
  if (state === 'divergent') return 'warn';
  if (state === 'missing') return 'bad';
  if (state === 'account-only') return 'info';
  return 'dashed';
}

var ELEMENT_STATES = ['linked', 'generated', 'copied', 'divergent', 'missing', 'account-only', 'not-portable'];

/**
 * One account as one row: who it is, how it relates to the primary and how many elements are in
 * each state. The element list and the notes open on demand. Labels and notes are shown as they
 * arrive: the scripts already write them in the run language.
 */
function accountItem(a, accounts) {
  var sync = a.sync || { mode: accounts.primary === a.id ? 'primary' : 'independent', status: 'none' };
  var isPrimary = accounts.primary === a.id || sync.mode === 'primary';
  var els = sync.elements || [];
  var counts = el('span', { cls: 'acc-counts' });
  ELEMENT_STATES.forEach(function (state) {
    var n = els.filter(function (e) { return e.state === state; }).length;
    if (n) counts.appendChild(tag(pl(T.elementCount[state], n), elementTone(state)));
  });
  var body = el('div', { cls: 'acc-body' }, el('p', { cls: 'muted', text: lbl(T.syncModeHelp, sync.mode) }));
  var extra = [a.isDefault ? T.acc.isDefault : null, a.host ? tx(T.acc.host, { host: a.host }) : null].filter(Boolean).join(' · ');
  if (extra) body.appendChild(el('p', { cls: 'muted', text: extra }));
  if (sync.detail) body.appendChild(el('p', { text: sync.detail }));
  // What the account comparison suggests, already worded in the run language by accounts.mjs.
  if (a.suggestionText && a.suggested && a.suggested !== 'none') body.appendChild(el('p', { cls: 'acc-suggest', text: a.suggestionText }));
  if (els.length) {
    var list = el('ul', { cls: 'els' });
    els.forEach(function (e) {
      list.appendChild(el('li', null, el('span', { cls: 'mono', text: e.name }), tag(lbl(T.elementState, e.state), elementTone(e.state)), e.note ? el('small', { text: e.note }) : null));
    });
    body.appendChild(list);
  }
  if (HARNESS[a.harness]) body.appendChild(el('div', null, el('a', { cls: 'btn ghost small', href: R.harness(a.harness), text: T.acc.openHarness })));
  var row = fold('acc:' + a.id, 'acc-row', [
    el('span', { cls: 'acc-main' }, el('b', { text: a.label }), el('small', { text: [a.identity, a.path].filter(Boolean).join(' · ') })),
    el('span', { cls: 'acc-tags' }, tag(lbl(T.syncMode, sync.mode), isPrimary ? 'navy' : 'info'),
      sync.mode !== 'primary' ? tag(lbl(T.syncStatus, sync.status), sync.status === 'ok' ? 'ok' : sync.status === 'drift' ? 'warn' : sync.status === 'broken' ? 'bad' : '') : null),
    counts,
  ], body, false);
  return el('div', { cls: 'acc-item' + (isPrimary ? ' primary' : '') }, row);
}

function accountsPanel() {
  var accounts = ST.accounts;
  if (!accounts || !(accounts.list || []).length) return null;
  var undecided = accounts.primary === null || accounts.primary === undefined;
  var s = section(null, T.acc.h, { why: T.acc.sub }, { id: 'ov-accounts', label: T.acc.h });
  // With no primary yet, the choice comes first: what it does, and that it is made in the chat.
  if (undecided) s.appendChild(el('div', { cls: 'callout' }, el('b', { text: T.acc.noPrimaryTitle }), el('p', { text: T.acc.noPrimaryBody })));
  var byProvider = {};
  var order = [];
  accounts.list.forEach(function (a) {
    if (!byProvider[a.provider]) { byProvider[a.provider] = []; order.push(a.provider); }
    byProvider[a.provider].push(a);
  });
  var box = el('div', { cls: 'accounts' });
  order.forEach(function (p) {
    var list = byProvider[p].slice().sort(function (a, b) { return (accounts.primary === b.id) - (accounts.primary === a.id); });
    var rows = el('div', { cls: 'acc-list' });
    list.forEach(function (a) { rows.appendChild(accountItem(a, accounts)); });
    box.appendChild(el('div', null, el('div', { cls: 'prov-h' }, el('span', { cls: 'glyph' }), el('b', { text: lbl(T.provider, p) }), el('span', { cls: 'muted mono', text: pl(T.acc.accounts, list.length) })), rows));
  });
  s.appendChild(box);
  if (typeof accounts.syncInstalled === 'boolean') s.appendChild(el('p', { cls: 'sync-note', style: { 'margin-top': '14px' }, text: accounts.syncInstalled ? T.acc.syncInstalled : T.acc.syncNotInstalled }));
  return s;
}

// --- fleet ----------------------------------------------------------------------------------

function scoreBar(sc) {
  if (sc.baseline === null) return el('div', { cls: 'muted mono', text: T.notScored });
  var b = Math.max(0, Math.min(100, sc.baseline));
  var p = Math.max(0, Math.min(100, sc.projected));
  var grade = function (g, n, cls, word) {
    return el('div', { cls: 'g' + (cls ? ' ' + cls : '') }, el('span', { cls: 'sr', text: word + ' ' }), g, el('small', { text: fmtScore(n) }));
  };
  return el('div', { cls: 'score' },
    grade(sc.baselineGrade, sc.baseline, '', T.fleet.before),
    el('div', { cls: 'sbar', role: 'img', 'aria-label': tx(T.fleet.barAria, { before: fmtScore(sc.baseline), after: fmtScore(sc.projected) }) },
      el('i', { cls: 'b', style: { width: Math.min(b, p) + '%' } }),
      p > b ? el('i', { cls: 'a', style: { left: b + '%', width: (p - b) + '%' } }) : null),
    grade(sc.projectedGrade, sc.projected, p > b ? 'after' : '', T.fleet.after));
}

/** The provider of a harness in words, when its name does not already say it; null otherwise. */
function providerWord(h) {
  var p = providerOf(h);
  if (!p) return null;
  var word = lbl(T.provider, p);
  return h.name.toLowerCase().indexOf(word.toLowerCase()) >= 0 ? null : word;
}

/**
 * The score an earlier review ended with and the score the harness has now, in the visual language
 * of scoreBar: grade, bar, grade. What was gained since is the green part; what was lost, the red one.
 */
function thenNowBar(then, now) {
  if (countOf(then) === null || countOf(now) === null) return null;
  var t = Math.max(0, Math.min(100, then));
  var n = Math.max(0, Math.min(100, now));
  var grade = function (value, cls, word) {
    return el('div', { cls: 'g' + (cls ? ' ' + cls : '') }, el('span', { cls: 'sr', text: word + ' ' }), Scoring.gradeFor(value), el('small', { text: fmtScore(value) }));
  };
  return el('div', { cls: 'score' },
    grade(then, '', T.fu.then),
    el('div', { cls: 'sbar', role: 'img', 'aria-label': tx(T.fu.scoreAria, { then: fmtScore(then), now: fmtScore(now) }) },
      el('i', { cls: 'b', style: { width: Math.min(t, n) + '%' } }),
      n > t ? el('i', { cls: 'a', style: { left: t + '%', width: (n - t) + '%' } })
        : n < t ? el('i', { cls: 'd', style: { left: n + '%', width: (t - n) + '%' } }) : null),
    grade(now, n > t ? 'after' : n < t ? 'down' : '', T.fu.now));
}

/**
 * A harness that was reviewed before: the score then and now, and in one line what came of what
 * that review expected, or when there will be enough data to tell. Null for a first review.
 * Returns `{ node, say }`; `say` is the same in words, for the label of the row.
 */
function followUpRow(h) {
  var fu = h.followUp;
  var sum = followUpSummary(fu);
  if (!sum) return null;
  var score = fu.score || {};
  var when = fu.of && dateOf(fu.of.reviewedAt) ? tx(T.fu.since, { date: fmtDate(fu.of.reviewedAt) }) : T.fu.h;
  var line = followUpLine(sum, T, FMT);
  return {
    say: when + ': ' + line,
    node: el('div', { cls: 'hfu' }, el('span', { cls: 'lbl', text: when }), thenNowBar(score.then, score.now),
      el('span', { cls: 'hfu-t' + (sum.state === 'waiting' ? ' wait' : ''), text: line })),
  };
}

function fleetRow(h) {
  var pw = providerWord(h);
  // Under its group heading the row needs only the glyph of its kind, not the word again.
  var name = el('div', { cls: 'hname' }, el('b', { cls: 'hn' }, kindMark(h.kind, { word: false }), el('span', { text: h.name })), el('span', { cls: 'p', text: (pw ? pw + ' · ' : '') + h.path }));
  var since = followUpRow(h);
  var label = tx(T.fleet.open, { name: h.name }) + (since ? '. ' + since.say : '');
  if (isEmptyHarness(h)) return el('a', { cls: 'hrow', href: R.harness(h.id), 'aria-label': label }, name, el('span', { cls: 'hempty', text: emptyText(h) }), since ? since.node : null);
  var sc = scoresOf(h.id);
  var open = openItems(h.id).sort(function (a, b) { return SEV_RANK[a.severity] - SEV_RANK[b.severity]; });
  var sessions = sessionsOf(h);
  var skip = h.impactSkipped || {};
  // Where the measurement would be: the number, or why there is none.
  var value = h.impact ? fmtTokens(measuredWaste(h.impact)) : skip.reason || sessions === null ? '-' : fmtInt(sessions);
  var note = h.impact ? pl(T.fleet.wasted, sessions)
    : skip.reason === 'shared-sessions' && skip['with'] ? tx(T.fleet.sharedWith, { name: harnessName(skip['with']) })
      : skip.reason === 'no-transcript-reader' ? T.fleet.noReader
        : sessions === null ? T.notMeasured : pl(T.fleet.unmeasured, sessions);
  return el('a', { cls: 'hrow', href: R.harness(h.id), 'aria-label': label }, name,
    scoreBar(sc),
    el('div', { cls: 'metric' }, el('b', { text: value }), el('span', { text: note })),
    // The count, and how serious the worst of them is (the one severity that drives the order).
    el('div', { cls: 'pend' }, el('span', { cls: 'p', text: open.length ? pl(T.fleet.toDecide, open.length) : T.fleet.nothing }), open.length ? sevMarks(open[0].severity, true) : null),
    el('span', { cls: 'go', 'aria-hidden': 'true', text: '\u203a' }),
    since ? since.node : null);
}

// --- groups ---------------------------------------------------------------------------------

function groupSaving(group) {
  var sum = 0;
  var estimated = false;
  group.items.forEach(function (id) {
    var s = ITEM[id] && ITEM[id].saves;
    if (!s) return;
    sum += s.tokens || 0;
    if (s.basis === 'estimated') estimated = true;
  });
  if (!sum) return null;
  return pl(T.grp.saving, windowDays(), { tokens: fmtTokens(sum) }) + (estimated ? ' (' + T.grp.estimated + ')' : '');
}

/** The members of a group, each with its status as the state records it. */
function memberList(group) {
  var list = el('ul', { cls: 'mlist' });
  group.items.forEach(function (id) {
    var m = ITEM[id];
    if (!m) return;
    list.appendChild(el('li', null, cid(id), el('span', { cls: 't' }, m.title, el('small', null, harnessRef(m.harness, false))), el('span', null, statusTags(m))));
  });
  return list;
}

function groupCard(group) {
  var members = group.items.map(function (id) { return ITEM[id]; }).filter(Boolean);
  var harnesses = [];
  members.forEach(function (m) { if (harnesses.indexOf(m.harness) < 0) harnesses.push(m.harness); });
  var chips = el('div', { cls: 'chips' });
  harnesses.forEach(function (hid) { chips.appendChild(harnessRef(hid, true)); });
  var saving = groupSaving(group);
  var open = members.filter(isOpen).length;
  return el('div', { cls: 'grp' },
    el('div', { cls: 'grp-h' }, copyId(group.id), tag(lbl(T.rounds, group.round)),
      open ? tag(pl(T.fleet.toDecide, open), 'warn') : tag(tx(T.grp.decided, { done: members.length, total: members.length }), 'ok')),
    el('h3', { text: group.title }),
    group.summary ? el('p', { text: group.summary }) : null,
    chips,
    saving ? el('span', { cls: 'gain', text: saving }) : null,
    fold('grp:' + group.id, 'members', pl(T.grp.members, members.length), memberList(group), false));
}

function viewOverview() {
  var users = HARNESS_ORDER.filter(function (h) { return h.kind === 'user'; }).length;
  var projects = HARNESS_ORDER.length - users;
  var single = HARNESS_ORDER.length === 1;
  var name = ST.run.title;
  var g = function (text) { return el('span', { cls: 'g', text: text }); };
  var title = single ? txNodes(T.ov.titleOne, 'name', g(HARNESS_ORDER[0].name)) : name ? txNodes(T.ov.titleMany, 'name', g(name)) : T.ov.titleManyPlain;
  var counts = { users: pl(T.ov.users, users), projects: pl(T.ov.projects, projects) };
  var lead = single ? T.ov.leadOne : tx(users && projects ? T.ov.leadMany : users ? T.ov.leadOnlyUsers : T.ov.leadOnlyProjects, counts);
  var out = el('div');
  // The mode and the system are in the footer: they describe the run, not what to decide.
  out.appendChild(heroBlock(single ? T.ov.kickerOne : T.ov.kickerFleet, title, lead.charAt(0).toUpperCase() + lead.slice(1), [
    [T.by.agent, ST.environment.agent],
    [T.by.window, pl(T.windowDays, windowDays())],
    [T.by.date, fmtDate(ST.run.lastRun || ST.run.startedAt, true)],
    // A run started as the follow-up of an earlier one says which.
    ST.run.followUpOf && dateOf(ST.run.followUpOf.reviewedAt) ? [T.fu.runOf, fmtDate(ST.run.followUpOf.reviewedAt)] : null,
  ]));
  out.appendChild(totalsBand());
  if (ST.harnesses.some(function (h) { return h.impact && h.impact.example; })) out.appendChild(el('p', { cls: 'example', text: T.imp.example }));

  // Accounts first, then projects, each under its own marker: the two kinds never mix.
  var fleet = el('div', { cls: 'fleet' });
  ['user', 'project'].forEach(function (kind) {
    var list = HARNESS_ORDER.filter(function (h) { return (h.kind === 'user') === (kind === 'user'); });
    if (!list.length) return;
    if (!single) fleet.appendChild(el('h3', { cls: 'fleet-h' }, kindMark(kind, { word: false }), lbl(T.kindGroup, kind), el('span', { cls: 'muted', text: String(list.length) })));
    list.forEach(function (h) { fleet.appendChild(fleetRow(h)); });
  });
  out.appendChild(section(null, single ? T.fleet.hOne : T.fleet.hMany, { why: T.fleet.sub }, { id: 'ov-fleet', label: single ? T.fleet.hOne : T.fleet.hMany }, fleet));

  var acc = accountsPanel();
  if (acc) out.appendChild(acc);

  if ((ST.groups || []).length) {
    var groups = el('div', { cls: 'groups' });
    ST.groups.forEach(function (gr) { groups.appendChild(groupCard(gr)); });
    out.appendChild(section(null, T.grp.h, { why: T.grp.sub }, { id: 'ov-groups', label: T.grp.h }, groups));
  }

  var leads = (ST.leads || []).filter(function (l) { return !l.harness || !HARNESS[l.harness]; });
  if (leads.length) out.appendChild(section(null, T.lead.h, { why: T.lead.sub }, { id: 'ov-leads', label: T.lead.h }, leadList(leads)));
  if ((ST.log || []).length) out.appendChild(section(null, T.log.h, null, { id: 'ov-log', label: T.log.h }, ST.log.length > 8 ? fold('log:all', 'foldbox', pl(T.ex.entries, ST.log.length), logTable(ST.log, true), false) : logTable(ST.log, true)));
  return out;
}

function leadList(leads) {
  var ul = el('ul', { cls: 'plain' });
  leads.forEach(function (l) { ul.appendChild(el('li', null, el('b', { text: l.title }), el('small', null, extLink(l.source, 'mono')), l.note ? el('small', { text: l.note }) : null)); });
  return ul;
}

function logTable(entries, withHarness) {
  var rows = entries.map(function (l) {
    var cells = [el('td', null, el('time', { datetime: l.at, cls: 'mono', text: fmtDate(l.at, true) }))];
    if (withHarness) cells.push(el('td', null, l.harness && HARNESS[l.harness] ? el('a', { href: R.harness(l.harness), text: harnessName(l.harness) }) : null));
    cells.push(el('td', null, l.item ? cid(l.item) : null), el('td', { text: l.text }));
    return append(el('tr'), cells);
  });
  var head = [T.col.at].concat(withHarness ? [T.col.harness] : [], [T.col.item, T.col.entry]);
  return tableBox(head, rows, T.log.h);
}
