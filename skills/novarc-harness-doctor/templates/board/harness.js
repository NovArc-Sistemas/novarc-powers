// Board client, fragment 6 of 9: one harness tab: header with the score console and the impact
// strip, then three sub-tabs. The Explorer is in the next fragment; the Diagnosis (cases, then
// defenses, rounds, inventory, leads and log) and the Impact (the full block, with the layers) are here.

function harnessHero(h) {
  var account = ACCOUNT_OF[h.id];
  var kicker = lbl(T.harnessKindLong, h.kind) + (providerOf(h) ? ' · ' + lbl(T.provider, providerOf(h)) : '');
  var by = [];
  var sessions = sessionsOf(h);
  if (account && account.label !== h.name) by.push(['', tx(T.hz.account, { label: account.label })]);
  if (sessions !== null) by.push(['', pl(T.hz.sessions, sessions)]);
  if (h.activity && h.activity.lastActive) by.push(['', tx(T.hz.lastActive, { date: fmtDate(h.activity.lastActive) })]);
  var p = h.project || {};
  if (p.defaultBranch) by.push(['', tx(T.hz.branch, { branch: p.defaultBranch })]);
  if (p.behindRemote) by.push(['', pl(T.hz.behind, p.behindRemote)]);
  if (p.worktrees) by.push(['', pl(T.hz.worktrees, p.worktrees)]);
  if (p.isCode === false) by.push(['', T.hz.notCode]);
  var hero = heroBlock(kicker, h.name, el('p', { cls: 'pathline', text: h.path }), by, true);
  if (h.inherits) {
    var parent = HARNESS[h.inherits];
    var link = parent ? el('a', { href: R.harness(parent.id), text: parent.name }) : el('b', { text: h.inherits });
    hero.appendChild(el('div', { cls: 'note-line' }, el('span', { cls: 'glyph' }), el('span', null, txNodes(T.hz.inherits, 'name', link))));
  }
  return hero;
}

// --- score console --------------------------------------------------------------------------

function ring(cls, r, value) {
  var c = 2 * Math.PI * r;
  var v = Math.max(0, Math.min(100, value || 0));
  return svg('circle', { 'class': 'arc ' + cls, cx: 75, cy: 75, r: r, 'stroke-dasharray': c.toFixed(2), 'stroke-dashoffset': (c * (1 - v / 100)).toFixed(2) });
}

function scoreConsole(h) {
  var sc = scoresOf(h.id);
  var scored = sc.current !== null;
  var aria = scored ? tx(T.sc.aria, { current: fmtScore(sc.current), grade: sc.grade, baseline: fmtScore(sc.baseline), projected: fmtScore(sc.projected) }) : T.sc.ariaNone;
  var dial = el('div', { cls: 'dial', role: 'img', 'aria-label': aria },
    svg('svg', { viewBox: '0 0 150 150', 'aria-hidden': 'true' },
      ring('ptrack', 71, 100), ring('track', 60, 100), ring('ptrack', 49, 100),
      scored ? [ring('proj', 71, sc.projected), ring('cur', 60, sc.current), ring('base', 49, sc.baseline)] : null),
    el('div', { cls: 'c' }, el('span', { cls: 'num' + (scored ? '' : ' none'), text: scored ? fmtScore(sc.current) : T.notScored }), scored ? el('span', { cls: 'of', text: T.sc.of }) : null));
  var grade = el('div', { cls: 'grade' }, el('span', { cls: 'bk l' }), scored ? sc.grade : '-', el('span', { cls: 'bk r' }),
    scored && sc.projectedGrade !== sc.grade ? [el('span', { cls: 'arrow', 'aria-hidden': 'true', text: '→' }), el('span', { cls: 'to', text: sc.projectedGrade })] : null);
  var legendRow = function (color, label, value) {
    return el('li', null, el('i', { style: { background: color } }), el('span', null, label + ' ', el('b', { text: fmtScore(value) })));
  };
  var legend = scored ? el('ul', { cls: 'legend' },
    legendRow('var(--navy-300)', T.sc.legendBaseline, sc.baseline),
    legendRow('var(--signal-500)', T.sc.legendCurrent, sc.current),
    legendRow('#34d399', T.sc.legendProjected, sc.projected)) : null;
  var rounds = el('ul', { cls: 'rlist' });
  sc.breakdown.forEach(function (r) {
    var n = 5;
    var on = r.score === null ? 0 : Math.round(r.score / 100 * n);
    var segs = el('span', { cls: 'segs', 'aria-hidden': 'true' });
    for (var k = 0; k < n; k++) segs.appendChild(el('i', { cls: r.status === 'not-applicable' ? 'na' : k < on ? 'on' : null }));
    var value = r.counted ? fmtScore(r.score) : lbl(T.roundStatus, r.status);
    var name = lbl(T.rounds, r.round);
    rounds.appendChild(el('li', { title: tx(T.sc.roundAria, { n: r.round, name: name, value: value }) + ' · ' + tx(T.sc.weight, { weight: r.weight }) },
      el('span', { cls: 'rn', text: String(r.round) }), el('span', { cls: 'nm', text: name }), segs, el('span', { cls: 'rv' + (r.counted ? ' ok' : ''), text: value })));
  });
  return el('div', { cls: 'console on-dark' },
    el('div', { cls: 'chrome' }, el('span', { cls: 'dotz', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')), el('span', { cls: 'path', text: h.path + ' · harness-doctor' })),
    el('div', { cls: 'cgrid' },
      el('div', { cls: 'cell' }, el('div', { cls: 'dialwrap' }, dial,
        el('div', null, el('div', { cls: 'who', text: T.sc.label }), grade, legend,
          el('div', { cls: 'cov', text: tx(T.sc.rounds, { n: sc.roundsCounted, m: sc.roundsTotal }) }),
          sc.previous !== null && sc.previous !== undefined ? el('div', { cls: 'cov', text: tx(T.sc.previous, { score: fmtScore(sc.previous) }) }) : null))),
      el('div', { cls: 'cell' }, rounds)));
}

// --- impact ---------------------------------------------------------------------------------

function impactRow(name, chip, tokens, max, desc, weighted) {
  return el('div', { cls: 'irow' },
    el('div', { cls: 'ilab' }, el('span', { cls: 'iname', text: name }), chip),
    el('div', { cls: 'itrack', 'aria-hidden': 'true' }, el('i', { style: { width: (max ? Math.max(1, tokens / max * 100) : 0) + '%' } })),
    el('div', { cls: 'ival', text: fmtTokens(tokens) }),
    el('div', { cls: 'idesc' }, desc, weighted ? el('span', { text: tx(T.imp.relativeTag, { tokens: fmtTokens(weighted) }) }) : null));
}

/**
 * The fixed cost of an impact block: what the context a session starts with costs over the window.
 * When the measurement says how often that context was re-read (`carriedWeighted`), that is the
 * figure: the starting context is read again on every later turn, mostly as cache reads.
 * Returns null when nothing about the start was measured.
 */
function fixedCost(I) {
  var start = I.contextAtStart || {};
  var hasRelative = typeof I.weightedTotal === 'number' && I.weightedTotal > 0;
  var num = function (v) { return typeof v === 'number' ? v : null; };
  var out = { carried: false, tokens: null, weighted: null, ratio: null, relative: false, median: num(start.perSessionMedian), p90: num(start.perSessionP90), turns: num(start.turns) };
  if (typeof start.carriedWeighted === 'number') {
    out.carried = true;
    out.tokens = num(start.carriedTokens);
    out.weighted = start.carriedWeighted;
    if (hasRelative) { out.ratio = start.carriedWeighted / I.weightedTotal; out.relative = true; }
    return out;
  }
  out.tokens = typeof start.total === 'number' ? start.total : out.median !== null ? out.median * I.sessions : null;
  if (out.tokens === null) return null;
  if (typeof start.weightedTotal === 'number' && hasRelative) { out.weighted = start.weightedTotal; out.ratio = start.weightedTotal / I.weightedTotal; out.relative = true; }
  else if (I.totalTokens) out.ratio = out.tokens / I.totalTokens;
  return out;
}

function pctOf(ratio) { return fmtPct(ratio, 1); }

/** Why a harness has no measurement, as one sentence (with a link when it is measured elsewhere). */
function impactAbsent(h) {
  var skip = h.impactSkipped || {};
  if (skip.reason === 'shared-sessions' && skip['with']) {
    var other = HARNESS[skip['with']] ? el('a', { href: R.impact(skip['with']), text: harnessName(skip['with']) }) : el('b', { text: skip['with'] });
    return el('span', null, txNodes(T.imp.skippedShared, 'name', other));
  }
  return el('span', { text: skip.reason === 'no-transcript-reader' ? T.imp.skippedNoReader : T.imp.none });
}

/** The impact in one row, under the score console: a link into the Impact sub-tab. */
function impactStrip(h) {
  var I = h.impact;
  if (!I) return el('div', { cls: 'istrip none' }, el('span', { cls: 'glyph' }), impactAbsent(h));
  var w = Scoring.wasteOf(I);
  var relative = w.weighted !== null;
  var cell = function (value, label, small) {
    return el('div', { cls: 'is-c' }, el('b', { text: value }), el('span', { text: label }), small ? el('small', { text: small }) : null);
  };
  var fx = fixedCost(I);
  var peak = I.contextPeak || {};
  var start = null;
  if (fx && fx.carried && fx.ratio !== null) start = cell(pctOf(fx.ratio) + '%', T.strip.carried, fx.median !== null ? tx(T.imp.carriedStart, { median: fmtTokens(fx.median) }) : null);
  else if (fx && fx.median !== null) start = cell(fmtTokens(fx.median), T.strip.start);
  return el('a', { cls: 'istrip', href: R.impact(h.id), 'data-fk': 'strip', title: T.strip.label },
    cell(fmtPct(relative ? w.weighted : w.tokens, relative ? I.weightedTotal : I.totalTokens) + '%', relative ? T.strip.waste : T.strip.wasteRaw, tx(T.strip.raw, { tokens: fmtTokens(w.tokens) })),
    start,
    cell(fmtInt(I.sessions), pl(T.imp.kpiSessionsPlain, I.sessions)),
    typeof peak.sessionsOver160k === 'number' ? cell(fmtInt(peak.sessionsOver160k), pl(T.imp.kpiOver, peak.sessionsOver160k)) : null,
    el('span', { cls: 'is-go' }, T.strip.open, el('span', { 'aria-hidden': 'true', text: '\u203a' })));
}

/**
 * The full impact of one harness. `afterFixed` is drawn right after the headline panel: the
 * layers, which explain where the fixed cost comes from.
 */
function impactBlock(h, afterFixed) {
  var I = h.impact;
  var days = I.windowDays || windowDays();
  // When the measurement carries price weights, the share is taken on relative cost (a cache read
  // costs a fraction of normal input) and the raw tokens become the secondary figure.
  var w = Scoring.wasteOf(I);
  var waste = w.tokens;
  var relative = w.weighted !== null;
  var part = relative ? w.weighted : waste;
  var whole = relative ? I.weightedTotal : I.totalTokens;
  var s = section(T.imp.kicker, pl(waste ? T.imp.h : T.imp.hNone, days, { tokens: fmtTokens(waste) }), pl(T.imp.sub, I.sessions));
  s.classList.add('first');
  var hero = el('div', { cls: 'ihero' },
    el('div', { cls: 'lbl', text: relative ? T.imp.shareRelative : T.imp.share }),
    el('div', { cls: 'ipct' }, el('span', { text: fmtPct(part, whole) }), '%'),
    el('div', { cls: 'itot' }, txNodes(tx(relative ? T.imp.totalRelative : T.imp.total, { total: fmtTokens(whole) }), 'waste', el('b', { text: fmtTokens(part) }))));
  if (relative) hero.appendChild(el('div', { cls: 'irel', text: tx(T.imp.rawSecondary, { pct: fmtPct(waste, I.totalTokens), waste: fmtTokens(waste), total: fmtTokens(I.totalTokens) }) }));
  hero.appendChild(el('div', { cls: 'ibar', 'aria-hidden': 'true' }, el('i', { style: { width: (whole ? Math.min(100, part / whole * 100) : 0) + '%' } })));
  hero.appendChild(el('div', { cls: 'ilegend', 'aria-hidden': 'true' }, el('span', null, el('i', { cls: 'av' }), T.imp.legendWaste), el('span', null, el('i'), T.imp.legendUseful)));
  if (relative) {
    var checked = I.weights && I.weights.verifiedAt ? ' ' + tx(T.imp.weightsVerified, { date: fmtDate(I.weights.verifiedAt) }) : '';
    hero.appendChild(el('div', { cls: 'irel', text: T.imp.weightsNote + checked }));
  }

  var kpis = el('div', { cls: 'ikpis' });
  var kpi = function (value, label, note) { kpis.appendChild(el('div', { cls: 'kpi' }, el('div', { cls: 'v', text: value }), el('div', { cls: 'lbl', text: label }), note ? el('div', { cls: 'kn', text: note }) : null)); };
  kpi(fmtInt(I.sessions), typeof I.activeDays === 'number' ? pl(T.imp.kpiSessions, I.sessions, { days: pl(T.imp.activeDays, I.activeDays) }) : pl(T.imp.kpiSessionsPlain, I.sessions));
  kpi(fmtTokens(I.totalTokens), T.imp.kpiTotal, typeof I.weightedTotal === 'number' ? tx(T.imp.relativeTag, { tokens: fmtTokens(I.weightedTotal) }) : null);
  var peak = I.contextPeak || {};
  if (typeof peak.median === 'number') kpi(fmtTokens(peak.median), T.imp.kpiPeak, typeof peak.p90 === 'number' ? tx(T.imp.kpiPeakNote, { p90: fmtTokens(peak.p90) }) : null);
  if (typeof peak.sessionsOver160k === 'number') kpi(fmtInt(peak.sessionsOver160k), pl(T.imp.kpiOver, peak.sessionsOver160k));

  // The fixed cost: what every session loads before the first message. Usually the biggest lever.
  var fx = fixedCost(I);
  var fixed = null;
  if (fx) {
    var facts = [];
    if (fx.median !== null) facts.push(tx(fx.carried ? T.imp.carriedStart : T.imp.fixedFormula, { median: fmtTokens(fx.median), sessions: fmtInt(I.sessions) }));
    if (fx.p90 !== null) facts.push(tx(T.imp.kpiStartNote, { p90: fmtTokens(fx.p90) }));
    if (fx.carried && fx.turns !== null) facts.push(pl(T.imp.turns, fx.turns));
    if (!fx.carried && fx.weighted !== null) facts.push(tx(T.imp.relativeTag, { tokens: fmtTokens(fx.weighted) }));
    var lead = fx.carried && fx.tokens !== null && fx.relative ? tx(T.imp.carriedLead, { tokens: fmtTokens(fx.tokens), pct: pctOf(fx.ratio) }) : null;
    fixed = el('div', { cls: 'ifixed' },
      el('div', null, el('div', { cls: 'lbl', text: fx.carried ? T.imp.carriedLabel : T.imp.fixedLabel }),
        el('div', { cls: 'v', text: fmtTokens(fx.tokens !== null ? fx.tokens : fx.weighted) }),
        lead ? el('div', { cls: 'itot', text: lead }) : null,
        facts.length ? el('div', { cls: 'kn', text: facts.join(' · ') }) : null),
      el('div', null,
        fx.ratio !== null ? el('div', { cls: 'ifx-share' }, el('b', { text: pctOf(fx.ratio) + '%' }), el('span', { text: fx.relative ? T.imp.fixedShare : T.imp.fixedShareRaw })) : null,
        fx.ratio !== null ? el('div', { cls: 'ifx-bar', 'aria-hidden': 'true' }, el('i', { style: { width: Math.min(100, fx.ratio * 100) + '%' } })) : null,
        el('div', { cls: 'kn', text: (fx.carried ? T.imp.carriedNote + ' ' : '') + T.imp.fixedNote })));
  }
  s.appendChild(el('div', { cls: 'ibig on-dark' }, hero, kpis, fixed));
  if (afterFixed) s.appendChild(afterFixed);

  if (I.byKind) {
    var kinds = el('div', { cls: 'ikinds', role: 'group', 'aria-label': T.imp.kindsH });
    ['input', 'cacheWrite', 'cacheRead', 'output'].forEach(function (k) {
      if (typeof I.byKind[k] !== 'number') return;
      var rel = I.weightedByKind && typeof I.weightedByKind[k] === 'number' ? I.weightedByKind[k] : null;
      kinds.appendChild(el('div', null, el('span', { cls: 'lbl', text: lbl(T.imp.kinds, k) }), el('b', { text: fmtTokens(I.byKind[k]) }), rel === null ? null : el('span', { text: tx(T.imp.relativeTag, { tokens: fmtTokens(rel) }) })));
    });
    if (kinds.firstChild) {
      s.appendChild(el('div', { cls: 'ih' }, el('h3', { text: T.imp.kindsH })));
      s.appendChild(kinds);
    }
  }

  // Kinds with no episode in the window are named in one muted line, not drawn as empty rows.
  var all = (I.waste || []).slice().sort(function (a, b) { return b.tokens - a.tokens; });
  var rows = all.filter(function (x) { return x.episodes > 0; });
  var quiet = all.filter(function (x) { return !(x.episodes > 0); });
  if (all.length) {
    s.appendChild(el('div', { cls: 'ih' }, el('h3', { text: T.imp.wasteH })));
    if (rows.length) {
      var max = rows[0].tokens;
      var list = el('div', { cls: 'ilist' });
      rows.forEach(function (x) {
        var desc = [el('span', { text: pl(T.imp.episodes, x.episodes) })];
        if (typeof x.sessions === 'number') desc.push(el('span', { text: pl(T.imp.inSessions, x.sessions) }));
        if ((x.topHeads || []).length) desc.push(el('span', null, txNodes(T.imp.heads, 'list', el('span', { cls: 'mono', text: x.topHeads.slice(0, 5).join(', ') }))));
        if ((x.items || []).length) desc.push(el('span', null, T.imp.addressedBy + ' ', cids(x.items)));
        list.appendChild(impactRow(lbl(T.waste, x.kind), tag(T.basis.measured, 'navy'), x.tokens, max, desc, x.weighted));
      });
      s.appendChild(list);
    }
    if (quiet.length) {
      var names = quiet.map(function (x) { var t = lbl(T.waste, x.kind); return t.charAt(0).toLowerCase() + t.slice(1); });
      s.appendChild(el('p', { cls: 'quiet', text: tx(T.imp.noEpisodes, { list: names.join(', ') }) }));
    }
  }

  // Estimate labels and sources are shown as they arrive: the scripts write them in the run language.
  var est = I.estimates || [];
  if (est.length) {
    var emax = est.reduce(function (m, e) { return Math.max(m, e.tokens || 0); }, 0);
    var elist = el('div', { cls: 'ilist est' });
    est.forEach(function (e) {
      var desc = [el('span', { text: tx(T.imp.source, { source: e.source }) })];
      if (e.tool) desc.push(el('span', { text: tx(T.imp.tool, { tool: e.tool }) }));
      if ((e.items || []).length) desc.push(el('span', null, T.imp.addressedBy + ' ', cids(e.items)));
      elist.appendChild(impactRow(e.label, tag(T.basis.estimated, 'dashed'), e.tokens, emax, desc, e.weighted));
    });
    s.appendChild(el('div', { cls: 'ih' }, el('h3', { text: T.imp.estH }), el('p', { text: T.imp.estSub })));
    s.appendChild(elist);
  }

  // What was loaded and never used has names but no number: it is listed, not added up.
  var unused = I.unusedContext || {};
  var skills = unused.skillsNeverInvoked || [];
  var mcp = unused.mcpServersNeverCalled || [];
  if (skills.length || mcp.length) {
    var chipsOf = function (names) { var c = el('div', { cls: 'chips' }); names.forEach(function (n) { c.appendChild(el('span', { text: n })); }); return c; };
    s.appendChild(el('div', { cls: 'ih' }, el('h3', { text: T.imp.unusedH })));
    s.appendChild(el('div', { cls: 'unused' },
      skills.length ? el('div', null, el('b', { text: pl(T.imp.unusedSkills, skills.length) }), chipsOf(skills)) : null,
      mcp.length ? el('div', null, el('b', { text: pl(T.imp.unusedMcp, mcp.length) }), chipsOf(mcp)) : null));
  }
  if (I.example) s.appendChild(el('p', { cls: 'example', text: T.imp.example }));
  return s;
}

/** The Impact sub-tab: the full block, or why there is no measurement, and the layers either way. */
function impactPane(h) {
  var layers = layersBlock(h);
  if (h.impact) return impactBlock(h, layers);
  var s = section(T.imp.kicker, T.imp.noneH, null, el('p', { cls: 'note-line' }, el('span', { cls: 'glyph' }), impactAbsent(h)), layers);
  s.classList.add('first');
  return s;
}

// --- diagnosis ------------------------------------------------------------------------------

var dgFilter = {};

function filterOf(hid) {
  if (!dgFilter[hid]) dgFilter[hid] = { show: openItems(hid).length ? 'open' : 'all', round: 0, severity: '' };
  return dgFilter[hid];
}

function matchesShow(item, show) {
  var st = eff(item).status;
  if (show === 'open') return st === 'open' || st === 'failed';
  if (show === 'fixed') return st === 'fixed' || st === 'ok';
  return true;
}

function diagnosisPane(h, route) {
  var f = filterOf(h.id);
  var target = route.q.item && ITEM[route.q.item] && ITEM[route.q.item].harness === h.id ? route.q.item : null;
  if (target && !(matchesShow(ITEM[target], f.show) && (!f.round || ITEM[target].round === f.round) && (!f.severity || ITEM[target].severity === f.severity))) {
    f.show = 'all'; f.round = 0; f.severity = '';
  }
  var all = itemsOf(h.id);
  var pane = el('div');
  pane.appendChild(el('h2', { text: T.dg.h }));
  pane.appendChild(el('p', { cls: 'sub', text: T.dg.sub }));

  var chip = function (label, pressed, count, onClick, fk) {
    var b = el('button', { type: 'button', cls: 'chip', 'aria-pressed': pressed ? 'true' : 'false', 'data-fk': fk }, el('span', { cls: 'slash' }), label, count === null ? null : el('span', { cls: 'c', text: String(count) }));
    b.addEventListener('click', onClick);
    return b;
  };
  var filters = el('div', { cls: 'filters', role: 'group', 'aria-label': T.dg.filterLabel });
  var show = el('div', { cls: 'fgroup' });
  ['open', 'all', 'fixed'].forEach(function (k) {
    show.appendChild(chip(T.dg.filter[k], f.show === k, all.filter(function (i) { return matchesShow(i, k); }).length, function () { f.show = k; redraw(); }, 'dg:show:' + k));
  });
  filters.appendChild(show);
  var roundsUsed = [];
  all.forEach(function (i) { if (roundsUsed.indexOf(i.round) < 0) roundsUsed.push(i.round); });
  roundsUsed.sort();
  if (roundsUsed.length > 1) {
    var rg = el('div', { cls: 'fgroup' }, el('span', { text: T.dg.round }));
    rg.appendChild(chip(T.dg.any, !f.round, null, function () { f.round = 0; redraw(); }, 'dg:round:0'));
    roundsUsed.forEach(function (r) {
      var b = chip(String(r), f.round === r, null, function () { f.round = r; redraw(); }, 'dg:round:' + r);
      b.setAttribute('title', lbl(T.rounds, r));
      b.setAttribute('aria-label', r + ' ' + lbl(T.rounds, r));
      rg.appendChild(b);
    });
    filters.appendChild(rg);
  }
  var sevUsed = SEVERITIES.filter(function (sv) { return all.some(function (i) { return i.severity === sv; }); });
  if (sevUsed.length > 1) {
    var sg = el('div', { cls: 'fgroup' }, el('span', { text: T.dg.severity }));
    sg.appendChild(chip(T.dg.any, !f.severity, null, function () { f.severity = ''; redraw(); }, 'dg:sev:'));
    sevUsed.forEach(function (sv) { sg.appendChild(chip(lbl(T.severity, sv), f.severity === sv, null, function () { f.severity = sv; redraw(); }, 'dg:sev:' + sv)); });
    filters.appendChild(sg);
  }
  pane.appendChild(filters);

  var list = all.filter(function (i) { return matchesShow(i, f.show) && (!f.round || i.round === f.round) && (!f.severity || i.severity === f.severity); })
    .map(function (i, k) { return { i: i, k: k }; })
    .sort(function (a, b) { return (SEV_RANK[a.i.severity] - SEV_RANK[b.i.severity]) || (a.i.round - b.i.round) || (a.k - b.k); });
  var cases = el('div', { cls: 'cases' });
  list.forEach(function (x) { cases.appendChild(caseCard(x.i, { target: x.i.id === target })); });
  pane.appendChild(list.length ? cases : el('p', { cls: 'empty', text: T.dg.none }));
  return pane;
}

// --- sections below the sub-tabs ------------------------------------------------------------

var LAYER_SHADES = ['#04122e', '#1b3e78', '#0a6cff', '#6ba6ff', '#b9c6da', '#5b7ba6'];

function defensesSection(h) {
  var list = whereOf(h.id, 'defenses');
  var s = section(null, T.def.h, T.def.note);
  if (!list.length) { s.appendChild(el('p', { cls: 'empty', text: T.def.none })); return s; }
  var ul = el('ul', { cls: 'plain' });
  list.forEach(function (d) { ul.appendChild(el('li', null, el('b', { text: d.title }), d.detail ? el('small', { text: d.detail }) : null)); });
  s.appendChild(ul);
  return s;
}

/** What enters every session, in load order: the explanation of the fixed cost. */
function layersBlock(h) {
  var ls = whereOf(h.id, 'layers');
  var box = el('div', null, el('div', { cls: 'ih' }, el('h3', { text: T.lay.h }), el('p', { text: T.lay.sub })));
  if (!ls.length) { box.appendChild(el('p', { cls: 'empty', text: T.lay.none })); return box; }
  var total = ls.reduce(function (a, l) { return a + (l.tokens || 0); }, 0);
  box.appendChild(el('div', { cls: 'pathline', text: tx(T.lay.total, { total: fmtInt(total) }) }));
  var withTokens = ls.filter(function (l) { return l.tokens; });
  var stack = el('div', { cls: 'lstack', 'aria-hidden': 'true' });
  withTokens.forEach(function (l, k) { stack.appendChild(el('i', { title: l.name, style: { flex: String(l.tokens), background: LAYER_SHADES[k % LAYER_SHADES.length] } })); });
  if (withTokens.length) box.appendChild(stack);
  ls.forEach(function (l) {
    var k = withTokens.indexOf(l);
    var fileId = l.file && FILE[l.file] ? l.file : null;
    box.appendChild(el('div', { cls: 'lrow' },
      el('span', { cls: 'sw', style: { background: k >= 0 ? LAYER_SHADES[k % LAYER_SHADES.length] : 'var(--gray-200)' } }),
      el('span', { cls: 'k', text: lbl(T.layerKind, l.kind) }),
      el('span', { cls: 'v' }, fileId ? el('a', { href: R.file(h.id, fileId), text: l.name }) : l.name, (l.note || l.path) ? el('span', { text: l.note || l.path }) : null),
      el('span', { cls: 'tk' }, typeof l.tokens === 'number' ? fmtInt(l.tokens) : '', l.basis ? [' ', tag(lbl(T.basis, l.basis), l.basis === 'measured' ? 'navy' : 'dashed')] : null)));
  });
  return box;
}

function roundsSection(h) {
  var s = section(null, T.rnd.h, T.rnd.sub);
  var flow = el('div', { cls: 'flow', tabindex: '0', role: 'list', 'aria-label': T.rnd.h });
  var nowSet = false;
  for (var r = 1; r <= Scoring.ROUNDS_TOTAL; r++) {
    var entry = (ST.rounds || []).filter(function (x) { return x.harness === h.id && x.round === r; })[0];
    var status = entry ? entry.status : 'pending';
    var state = status === 'done' ? 'done' : status === 'skipped' ? 'skipped' : status === 'not-applicable' ? 'na' : nowSet ? 'todo' : 'now';
    if (state === 'now') nowSet = true;
    flow.appendChild(el('div', { cls: 'node ' + state, role: 'listitem' }, el('span', { cls: 'pt' }),
      el('div', { cls: 's', text: lbl(T.rnd.state, state) }), el('div', { cls: 't', text: r + ' ' + lbl(T.rounds, r) }),
      entry && entry.note ? el('div', { cls: 'x', text: entry.note }) : null));
  }
  s.appendChild(flow);
  return s;
}

function inventorySection(h) {
  var inv = whereOf(h.id, 'inventory');
  var s = section(null, T.inv.h, T.inv.sub);
  if (!inv.length) { s.appendChild(el('p', { cls: 'empty', text: T.inv.empty })); return s; }
  var groups = {};
  var order = [];
  inv.forEach(function (e) { if (!groups[e.category]) { groups[e.category] = []; order.push(e.category); } groups[e.category].push(e); });
  order.forEach(function (cat) {
    var list = groups[cat];
    var flagged = list.filter(function (e) { return e.verdict !== 'fine'; }).length;
    var rows = list.map(function (e) {
      var fileId = e.file && FILE[e.file] ? e.file : null;
      return row(tag(lbl(T.verdict, e.verdict), e.verdict === 'fine' ? 'ok' : e.verdict === 'attention' ? 'warn' : 'bad'),
        [fileId ? el('a', { href: R.file(h.id, fileId), text: e.name }) : e.name, e.path ? el('small', { cls: 'mono', text: e.path }) : null],
        e.detail || '', e.opinion, e.item ? cid(e.item) : '');
    });
    s.appendChild(fold('inv:' + h.id + ':' + cat, 'foldbox',
      [cat, el('span', { text: fmtInt(list.length) + (flagged ? ' · ' + pl(T.inv.flagged, flagged) : '') })],
      tableBox([T.col.verdict, T.col.name, T.col.detail, T.col.opinion, T.col.item], rows, cat), flagged > 0));
  });
  return s;
}

function viewHarness(route) {
  var h = HARNESS[route.harness];
  if (!h) {
    return el('div', { cls: 'hero small' }, el('p', { cls: 'lead', text: T.hz.unknownHarness }), el('p', { style: { 'margin-top': '14px' } }, el('a', { cls: 'btn', href: R.overview(), text: T.hz.backToOverview })));
  }
  var out = el('div');
  out.appendChild(harnessHero(h));
  // Nothing was found here at all: say so, instead of a row of empty panels.
  if (isEmptyHarness(h)) {
    out.appendChild(el('p', { cls: 'blank', text: emptyText(h) }));
    if (h.impactSkipped) out.appendChild(impactStrip(h));
    return out;
  }
  out.appendChild(scoreConsole(h));
  out.appendChild(impactStrip(h));

  // Three sub-tabs. The explorer is the default; a file or a view route is the explorer with a selection.
  var sub = route.sub === 'diagnosis' || route.sub === 'impact' ? route.sub : 'explorer';
  var items = itemsOf(h.id);
  var open = openItems(h.id).length;
  var w = h.impact ? Scoring.wasteOf(h.impact) : null;
  var share = !w ? null : fmtPct(w.weighted !== null ? w.weighted : w.tokens, w.weighted !== null ? h.impact.weightedTotal : h.impact.totalTokens) + '%';
  var tab = function (key, href, label, count) {
    return el('a', { cls: 'chip', href: href, 'aria-current': sub === key ? 'true' : null, 'data-fk': 'sub:' + key }, el('span', { cls: 'slash' }), label, count === null ? null : el('span', { cls: 'c', text: count }));
  };
  out.appendChild(el('div', { cls: 'subtabs', id: 'subtabs', role: 'group', 'aria-label': T.tab.label },
    tab('explorer', R.harness(h.id), T.tab.explorer, String(filesOf(h.id).length)),
    tab('diagnosis', R.diagnosis(h.id), T.tab.diagnosis, open ? open + ' / ' + items.length : String(items.length)),
    tab('impact', R.impact(h.id), T.tab.impact, share)));

  if (sub === 'explorer') { out.appendChild(explorerPane(h, route)); return out; }
  if (sub === 'impact') { out.appendChild(impactPane(h)); return out; }

  out.appendChild(diagnosisPane(h, route));
  out.appendChild(defensesSection(h));
  out.appendChild(roundsSection(h));
  out.appendChild(inventorySection(h));
  var leads = whereOf(h.id, 'leads');
  out.appendChild(section(null, T.lead.h, T.lead.sub, leads.length ? leadList(leads) : el('p', { cls: 'empty', text: T.lead.none })));
  var log = whereOf(h.id, 'log');
  out.appendChild(section(null, T.log.h, null, log.length ? logTable(log, false) : el('p', { cls: 'empty', text: T.log.empty })));
  return out;
}
