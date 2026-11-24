// Board client, fragment 1 of 10: the logic that needs no page: the pending queue, routes,
// storage that may fail, what counts as unknown, and what the follow-up of an earlier review comes
// to. No DOM and no globals, so the same text is loaded by tests/board-logic.test.mjs in Node, and
// by scripts/render-board.mjs, which words board.md with the follow-up helpers at the end.
//
// The board only shows: every decision is taken in the chat session with the agent (run.mjs
// decide), and what was decided arrives here through the state.
//
// The fragments in this folder are concatenated by scripts/render-board.mjs, in the order listed
// there, inside one function scope: a name declared in one fragment is visible in the next ones.

/**
 * True for a finding the user declined in an earlier review (`history.lastStatus`). When it is
 * open again it came back with another proposal, so it is asked once more, after everything else.
 */
function declinedBefore(item) {
  return !!item && !!item.history && typeof item.history === 'object' && item.history.lastStatus === 'declined';
}

/**
 * What waits for the user's decision, in the order the Pending view lists it: groups that still
 * have an open member first, then every open item no such group covers, most severe first. An
 * open item the user declined before comes after the ones never declined, in the same order among
 * themselves. Returns `[{ kind: 'group' | 'item', id }]`.
 */
function pendingQueue(state) {
  var sev = { critical: 0, high: 1, medium: 2, low: 3 };
  var again = function (i) { return declinedBefore(i) ? 1 : 0; };
  var byId = {};
  (state.items || []).forEach(function (i) { byId[i.id] = i; });
  var covered = {};
  var queue = [];
  (state.groups || []).forEach(function (g) {
    var open = (g.items || []).filter(function (id) { return byId[id] && byId[id].status === 'open'; });
    if (!open.length) return;
    open.forEach(function (id) { covered[id] = true; });
    queue.push({ kind: 'group', id: g.id });
  });
  (state.items || [])
    .filter(function (i) { return i.status === 'open' && !covered[i.id]; })
    .map(function (i, k) { return { i: i, k: k }; })
    .sort(function (a, b) { return (again(a.i) - again(b.i)) || (sev[a.i.severity] - sev[b.i.severity]) || (a.i.round - b.i.round) || (a.k - b.k); })
    .forEach(function (x) { queue.push({ kind: 'item', id: x.i.id }); });
  return queue;
}

// --- routes ---------------------------------------------------------------------------------

/** A hash route as `{ page, harness, sub, arg, q }`. Anything unknown is the overview. */
function parseRoute(hash) {
  var raw = String(hash || '').replace(/^#\/?/, '');
  var q = {};
  var qi = raw.indexOf('?');
  if (qi >= 0) {
    raw.slice(qi + 1).split('&').forEach(function (kv) {
      var p = kv.split('=');
      try { q[decodeURIComponent(p[0])] = decodeURIComponent(p.slice(1).join('=')); } catch (e) { /* ignore a broken pair */ }
    });
    raw = raw.slice(0, qi);
  }
  var seg = raw.split('/').filter(Boolean).map(function (s) { try { return decodeURIComponent(s); } catch (e) { return s; } });
  if (seg[0] === 'h' && seg[1]) return { page: 'harness', harness: seg[1], sub: seg[2] || 'explorer', arg: seg.slice(3).join('/') || null, q: q };
  // `#/decide` is what boards that still had decision buttons wrote; it opens the Pending view.
  if (seg[0] === 'pending' || seg[0] === 'decide') return { page: 'pending', q: q };
  return { page: 'overview', q: q };
}

/** Where the page keeps the route it was last on: one key per run, so two boards never share it. */
function routeKey(runId) { return 'novarc-harness-doctor:' + runId + ':route'; }

var ROUTE_MAX = 600;
var HARNESS_SUBS = { explorer: true, diagnosis: true, impact: true };

/**
 * True when a parsed route leads somewhere in this state. `known` is what the page has:
 * `{ harnesses: { id: true }, files: { fileId: harnessId }, views: { name: true } }`.
 */
function routeExists(route, known) {
  var has = function (map, key) { return !!map && typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key); };
  if (!route || !known) return false;
  if (route.page === 'overview') return true;
  if (route.page === 'pending') return true;
  if (route.page !== 'harness' || !has(known.harnesses, route.harness)) return false;
  if (route.sub === 'file') return has(known.files, route.arg) && known.files[route.arg] === route.harness;
  if (route.sub === 'view') return has(known.views, route.arg);
  return has(HARNESS_SUBS, route.sub);
}

/**
 * The route to open when the page loads, or null for the one in the URL. A remembered route is
 * used only when the URL names none and the route still leads somewhere in this state: a reload
 * inside a frame loses the hash, and a link that carries a hash always wins. `stored` comes from
 * browser storage, so it is untrusted: anything that is not a short `#/` route is ignored.
 */
function routeToRestore(urlHash, stored, known) {
  if (String(urlHash || '').replace(/^#/, '') !== '') return null;
  if (typeof stored !== 'string' || stored.length > ROUTE_MAX || stored.slice(0, 2) !== '#/') return null;
  var route = parseRoute(stored);
  return route.page !== 'overview' && routeExists(route, known) ? stored : null;
}

/**
 * Browser storage that never throws. `getStorage` returns the storage object; reaching it can
 * throw by itself (a private window, a sandboxed frame, blocked site data), it can be missing,
 * and every read and write can fail. `get` returns a string or null; `set` says whether the
 * value was kept. The page must draw the same without it.
 */
function safeStore(getStorage) {
  return {
    get: function (key) {
      try {
        var s = getStorage();
        var v = s ? s.getItem(key) : null;
        return typeof v === 'string' ? v : null;
      } catch (e) { return null; }
    },
    set: function (key, value) {
      try {
        var s = getStorage();
        if (!s) return false;
        s.setItem(key, String(value));
        return true;
      } catch (e) { return false; }
    },
  };
}

// --- unknown is neither "no" nor zero --------------------------------------------------------

/** 'yes', 'no' or 'unknown': only a real true or a real false is an answer. */
function triState(v) { return v === true ? 'yes' : v === false ? 'no' : 'unknown'; }

/** A count that was measured, or null when it was not (missing, null, not a number). Zero is a count. */
function countOf(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

/**
 * The waste kinds of an impact block, most tokens first, in three groups: `seen` had episodes,
 * `quiet` was measured and had none, `unknown` has no episode count, so it was not measured.
 */
function wasteGroups(rows) {
  var out = { seen: [], quiet: [], unknown: [] };
  (rows || []).map(function (x, i) { return { x: x, i: i }; })
    .sort(function (a, b) { return ((countOf(b.x.tokens) || 0) - (countOf(a.x.tokens) || 0)) || (a.i - b.i); })
    .forEach(function (e) {
      var n = countOf(e.x.episodes);
      (n === null ? out.unknown : n > 0 ? out.seen : out.quiet).push(e.x);
    });
  return out;
}

// --- follow-up: a harness against its last review (references/follow-up.md) -------------------
// Every field read here may be absent: a first review has no history and no follow-up.

/**
 * Chip tone per verdict. Lower is better for every metric, so a fall reads as good and a rise as
 * bad; a verdict that says nothing moved, or that nothing can be said yet, stays neutral.
 */
var FU_VERDICT_TONE = { confirmed: 'ok', partial: 'ok soft', improved: 'ok', 'no-change': '', worse: 'bad', 'not-enough-data': 'dashed', 'not-measured': 'dashed' };
/** Chip tone per on-disk check of an item that review fixed. */
var FU_CHECK_TONE = { 'in-place': 'ok', reverted: 'bad', changed: 'warn', missing: 'bad', 'not-checked': 'dashed' };
var FU_NEUTRAL = { 'no-change': true, 'not-enough-data': true, 'not-measured': true };
var FU_UNITS = { 'tokens/session': true, 'chars/session': true, percent: true };

function has(map, key) { return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key); }

/** A date-time string that parses, or null. */
function dateOf(v) { return typeof v === 'string' && !isNaN(Date.parse(v)) ? v : null; }

/** The unit of a comparable metric: what the state says, else what the name of the metric implies. */
function metricUnit(m) {
  if (m && has(FU_UNITS, m.unit)) return m.unit;
  var name = m ? m.metric : '';
  return name === 'waste-share' ? 'percent' : name === 'tool-output' ? 'chars/session' : 'tokens/session';
}

/**
 * The words under the name of a metric: its unit and, when the state says which base both numbers
 * are on (`base`, on the wasted share), that base: "percent of the spend, in relative cost".
 */
function metricSubLabel(m, T) {
  var unit = metricUnit(m);
  var text = has(T.fu.unit, unit) ? T.fu.unit[unit] : unit;
  return m && has(T.fu.base, m.base) ? text + ', ' + T.fu.base[m.base] : text;
}

/**
 * Why a row reads "not measured" although both reviews have a number (`reason`), in words; null
 * when the state gives none, or when the row is not a not-measured one.
 */
function notMeasuredReason(m, T) {
  return m && m.verdict === 'not-measured' && has(T.fu.rowReason, m.reason) ? T.fu.rowReason[m.reason] : null;
}

/**
 * How one metric moved between the two reviews: `{ pct, dir, tone }`. `pct` is the state's
 * `changePct`, or the change from `before` to `after` when the state has none; it is null when
 * either side was not measured, and for a row that reads "not measured" with both numbers there
 * (they are on different bases, so their difference means nothing). `dir` is 'down', 'up',
 * 'flat' or null. `tone` is 'good' for a fall and 'bad' for a rise, and '' when the verdict is a
 * neutral one or when `waiting` is true (the sample is still too small for any verdict to count).
 */
function metricChange(m, waiting) {
  var before = countOf(m && m.before);
  var after = countOf(m && m.after);
  if (before === null || after === null || m.verdict === 'not-measured') return { pct: null, dir: null, tone: '' };
  var pct = countOf(m.changePct);
  if (pct === null && before !== 0) pct = (after - before) / before * 100;
  var dir = after < before ? 'down' : after > before ? 'up' : 'flat';
  var neutral = waiting === true || has(FU_NEUTRAL, m.verdict) || dir === 'flat';
  return { pct: pct, dir: dir, tone: neutral ? '' : dir === 'down' ? 'good' : 'bad' };
}

/**
 * What a follow-up comes to, for the one line the overview shows:
 * `{ state, confirmed, expected, readyAt, reason }`. `state` is 'waiting' while the sample is
 * too small to compare (`readyAt` is then the date it will be enough, or `reason` says why),
 * 'effects' when at least one metric carried an expectation (`confirmed` of `expected` came
 * true), and 'none' when that review expected nothing measurable. Null without a follow-up.
 */
function followUpSummary(fu) {
  if (!fu || typeof fu !== 'object') return null;
  var sample = fu.sample || {};
  var out = { state: 'none', confirmed: 0, expected: 0, readyAt: null, reason: null };
  if (sample.enough === false) {
    out.state = 'waiting';
    out.readyAt = dateOf(sample.readyAt);
    out.reason = typeof sample.reason === 'string' && sample.reason ? sample.reason : null;
    return out;
  }
  (Array.isArray(fu.metrics) ? fu.metrics : []).forEach(function (m) {
    if (!m || countOf(m.expected) === null) return;
    out.expected++;
    if (m.verdict === 'confirmed') out.confirmed++;
  });
  if (out.expected) out.state = 'effects';
  return out;
}

/**
 * That summary as one line of text. `T` is the dictionary and `f` the caller's formatters,
 * `{ date(iso), plural(forms, n, vars), fill(template, vars), label(map, value) }`, so the page
 * and board.md word it the same way.
 */
function followUpLine(sum, T, f) {
  if (sum.state === 'waiting') {
    if (sum.readyAt) return f.fill(T.fu.readyAt, { date: f.date(sum.readyAt) });
    return has(T.fu.reason, sum.reason) ? T.fu.reason[sum.reason] : T.fu.notReady;
  }
  if (sum.state === 'effects') return f.plural(T.fu.effects, sum.expected, { confirmed: sum.confirmed });
  return T.fu.noExpectation;
}

/**
 * What that review left, in two lists: `fixed`, each one checked on disk, and `carried`, what it
 * did not apply (declined, deferred, failed, still open).
 */
function followUpItems(fu) {
  var out = { fixed: [], carried: [] };
  (fu && Array.isArray(fu.items) ? fu.items : []).forEach(function (i) {
    if (i && typeof i.id === 'string') (i.status === 'fixed' ? out.fixed : out.carried).push(i);
  });
  return out;
}

/**
 * The earlier reviews of a harness, oldest first: `[{ runId, at, score, grade }]`. An entry
 * without a date that parses is left out; `score` and `grade` are null when that review had none.
 */
function reviewTrail(history) {
  return (Array.isArray(history) ? history : [])
    .map(function (r, i) { return { r: r || {}, i: i, t: r ? Date.parse(r.reviewedAt) : NaN }; })
    .filter(function (e) { return dateOf(e.r.reviewedAt) !== null; })
    .sort(function (a, b) { return (a.t - b.t) || (a.i - b.i); })
    .map(function (e) {
      return { runId: e.r.runId, at: e.r.reviewedAt, score: countOf(e.r.score), grade: typeof e.r.grade === 'string' && e.r.grade ? e.r.grade : null };
    });
}

/**
 * What the records say about one finding: `{ firstSeenAt, times, lastStatus, lastDecisionAt,
 * lastNote }`, each null when absent. Null when the item has no `history`, or one that says
 * nothing: a `previous` link alone is not shown.
 */
function itemHistory(item) {
  var h = item && item.history;
  if (!h || typeof h !== 'object') return null;
  var times = countOf(h.times);
  var out = {
    firstSeenAt: dateOf(h.firstSeenAt),
    times: times !== null && times >= 1 ? Math.floor(times) : null,
    lastStatus: typeof h.lastStatus === 'string' && h.lastStatus ? h.lastStatus : null,
    lastDecisionAt: dateOf(h.lastDecisionAt),
    lastNote: typeof h.lastNote === 'string' && h.lastNote.trim() ? h.lastNote.trim() : null,
  };
  return out.firstSeenAt || out.times || out.lastStatus ? out : null;
}

/**
 * A decline carried from an earlier review (`carriedFrom`): the user declined this exact proposal
 * there, so it was not asked again. Returns `{ at, note }`, the date and the note of that
 * decision (each null when the records do not say), or null when the item carries none or is no
 * longer declined. `status` is the status the page shows, which a decision made here can move.
 */
function carriedDecline(item, status) {
  var from = item && item.carriedFrom;
  if (!from || typeof from !== 'object' || (status === undefined ? item.status : status) !== 'declined') return null;
  var h = item.history && typeof item.history === 'object' ? item.history : {};
  return { at: dateOf(h.lastDecisionAt), note: typeof h.lastNote === 'string' && h.lastNote.trim() ? h.lastNote.trim() : null };
}

/** That carried decline in plain words, with the note the user left then. Same `T` and `f` as followUpLine. */
function carriedLine(carried, T, f) {
  var text = carried.at ? f.fill(T.hist.carried, { date: f.date(carried.at) }) : T.hist.carriedNoDate;
  return carried.note ? text + ' ' + f.fill(T.hist.carriedNote, { note: carried.note }) : text;
}

/**
 * That history as one line: when it was first seen, in how many earlier reviews, and how the
 * last one left it, with the date and the note of that decision. Same `T` and `f` as followUpLine.
 * `withoutLast` leaves the last decision out, for an item whose carried decline already says it;
 * the line can then be empty.
 */
function historyLine(hist, T, f, withoutLast) {
  var parts = [];
  if (hist.firstSeenAt) parts.push(f.fill(T.hist.first, { date: f.date(hist.firstSeenAt) }));
  if (hist.times) parts.push(f.plural(T.hist.times, hist.times));
  if (hist.lastStatus && !withoutLast) {
    var status = f.label(T.hist.status, hist.lastStatus);
    var last = hist.lastDecisionAt ? f.fill(T.hist.lastOn, { status: status, date: f.date(hist.lastDecisionAt) }) : status;
    parts.push(last + (hist.lastNote ? ': ' + hist.lastNote : ''));
  }
  var text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
