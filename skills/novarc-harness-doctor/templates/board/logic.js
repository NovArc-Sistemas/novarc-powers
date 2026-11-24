// Board client, fragment 1 of 9: the logic that needs no page: decisions, routes, storage that
// may fail, what counts as unknown, and what the follow-up of an earlier review comes to. No DOM
// and no globals, so the same text is loaded by tests/board-logic.test.mjs in Node, and by
// scripts/render-board.mjs, which words board.md with the follow-up helpers at the end.
//
// The fragments in this folder are concatenated by scripts/render-board.mjs, in the order listed
// there, inside one function scope: a name declared in one fragment is visible in the next ones.

/** What a decision turns an item into. `ask` leaves the status alone and sets a question. */
var ACTION_STATUS = { approve: 'approved', decline: 'declined', defer: 'deferred' };
var ACTIONS = { approve: true, decline: true, defer: true, ask: true };
/** Statuses the user can still decide (or decide again) from the board. */
var DECIDABLE = { open: true, deferred: true, declined: true, failed: true, approved: true };
var PRIMARY_TARGET = 'accounts.primary';
/** What a `rev` looks like in the state: 12 lowercase hex characters (templates/state.schema.json). */
var REV_RE = /^[0-9a-f]{12}$/;

/** A value quoted for a shell command line the user pastes in chat. */
function quoteArg(text) {
  return '"' + String(text).replace(/\s+/g, ' ').trim().replace(/[\\"$`]/g, '\\$&') + '"';
}

/** The exact line that records a decision from chat (references/contracts.md, `run.mjs decide`). */
function decisionCommand(d) {
  var parts = ['run.mjs decide', '--run', d.runId, '--target', d.target, '--action', d.action];
  if (d.note) parts.push('--note', quoteArg(d.note));
  if (d.exclude && d.exclude.length) parts.push('--exclude', d.exclude.join(','));
  if (typeof d.rev === 'string' && REV_RE.test(d.rev)) parts.push('--rev', d.rev);
  return parts.join(' ');
}

/** RFC 4122 version 4 id from 16 random bytes. */
function uuidFromBytes(b) {
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  var hex = [];
  for (var i = 0; i < 16; i++) hex.push((b[i] + 0x100).toString(16).slice(1));
  return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' + hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' + hex.slice(10).join('');
}

/**
 * The revision of what a target proposes, as this state records it: the `rev` of the group or of
 * the item with that id. Null when the state has none for it, and for `accounts.primary`.
 */
function revOf(state, target) {
  var lists = [state.groups || [], state.items || []];
  for (var k = 0; k < lists.length; k++) {
    for (var i = 0; i < lists[k].length; i++) {
      var x = lists[k][i];
      if (x && x.id === target) return typeof x.rev === 'string' && REV_RE.test(x.rev) ? x.rev : null;
    }
  }
  return null;
}

/**
 * One decision in the shape every channel carries. Empty `note` and `exclude` are left out, and
 * so is `rev` when the target has none. With it, the session applies the decision only to the
 * proposal the user actually saw.
 */
function makeDecision(runId, target, action, note, exclude, id, at, rev) {
  var d = { id: id, at: at, runId: runId, target: target, action: action, via: 'board' };
  var text = typeof note === 'string' ? note.trim() : '';
  if (text) d.note = text;
  if (exclude && exclude.length) d.exclude = exclude.slice();
  if (typeof rev === 'string' && REV_RE.test(rev)) d.rev = rev;
  return d;
}

/**
 * A decision read back from a channel (database, server, browser storage) is untrusted data:
 * keep only well-formed ones, with strings cut to sane lengths. Returns null otherwise.
 */
function cleanDecision(raw, fallbackTarget) {
  if (!raw || typeof raw !== 'object') return null;
  var target = typeof raw.target === 'string' && raw.target ? raw.target : fallbackTarget;
  if (typeof target !== 'string' || !target || target.length > 80) return null;
  if (typeof raw.action !== 'string' || !ACTIONS[raw.action]) return null;
  var at = typeof raw.at === 'string' && !isNaN(Date.parse(raw.at)) ? raw.at : null;
  if (!at) return null;
  var d = {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 80) : target + '@' + at,
    at: at,
    runId: typeof raw.runId === 'string' ? raw.runId.slice(0, 80) : '',
    target: target,
    action: raw.action,
    via: raw.via === 'chat' ? 'chat' : 'board',
  };
  if (typeof raw.note === 'string' && raw.note.trim()) d.note = raw.note.trim().slice(0, 4000);
  if (Array.isArray(raw.exclude)) {
    var ex = raw.exclude.filter(function (x) { return typeof x === 'string' && x && x.length <= 80; }).slice(0, 500);
    if (ex.length) d.exclude = ex;
  }
  if (typeof raw.rev === 'string' && REV_RE.test(raw.rev)) d.rev = raw.rev;
  return d;
}

function timeOf(iso) {
  var t = Date.parse(iso);
  return isNaN(t) ? 0 : t;
}

/** The newest decision per target. Later entries win a tie, so arrival order breaks it. */
function latestPerTarget(decisions) {
  var by = {};
  var order = [];
  decisions.forEach(function (d) {
    if (!by[d.target]) order.push(d.target);
    if (!by[d.target] || timeOf(d.at) >= timeOf(by[d.target].at)) by[d.target] = d;
  });
  return order.map(function (t) { return by[t]; });
}

/** Group ids each item belongs to, from `groups[].items` and from `items[].group`. */
function groupsOfItems(state) {
  var map = {};
  var add = function (item, group) {
    if (!map[item]) map[item] = [];
    if (map[item].indexOf(group) < 0) map[item].push(group);
  };
  (state.groups || []).forEach(function (g) { (g.items || []).forEach(function (id) { add(id, g.id); }); });
  (state.items || []).forEach(function (i) { if (i.group) add(i.id, i.group); });
  return map;
}

/**
 * Which local decisions hold, given the state. The state always wins over memory:
 * - a decision the state already lists (same id) is ignored;
 * - a decision made on another revision of its target is ignored: what it answered is not what
 *   is proposed now, and the session does not apply it either;
 * - a decision made in this page load (`fresh[id]`) holds for any item the user may still decide;
 * - a decision restored from a channel holds for an `open` item unless the state has a newer
 *   decision for it, and for an item the state already moved on only when it is provably newer
 *   than what the state records.
 * Returns `{ items: { id: decision }, groups: { id: decision }, primary: decision | null, held }`,
 * where `held` lists the decisions that changed something, in arrival order.
 */
function overlayFor(state, decisions, fresh) {
  var freshIds = fresh || {};
  var inState = {};
  var stampByTarget = {};
  (state.decisions || []).forEach(function (d) {
    if (d.id) inState[d.id] = true;
    stampByTarget[d.target] = Math.max(stampByTarget[d.target] || 0, timeOf(d.at));
  });
  var memberOf = groupsOfItems(state);
  var stale = function (d) {
    if (typeof d.rev !== 'string') return false;
    var now = revOf(state, d.target);
    return now !== null && now !== d.rev;
  };
  var latest = latestPerTarget(decisions.filter(function (d) { return !inState[d.id] && !stale(d); }));
  var byTarget = {};
  latest.forEach(function (d) { byTarget[d.target] = d; });

  var out = { items: {}, groups: {}, primary: null, held: [] };
  var used = {};
  (state.items || []).forEach(function (item) {
    var groups = memberOf[item.id] || [];
    var stamp = Math.max(timeOf(item.updatedAt), stampByTarget[item.id] || 0);
    groups.forEach(function (g) { stamp = Math.max(stamp, stampByTarget[g] || 0); });
    var holds = function (d) {
      if (!d) return false;
      if (item.status !== 'open' && !DECIDABLE[item.status]) return false;
      if (freshIds[d.id]) return true;
      if (item.status === 'open') return timeOf(d.at) >= stamp;
      return stamp > 0 && timeOf(d.at) > stamp;
    };
    var best = null;
    var own = byTarget[item.id];
    if (holds(own)) best = own;
    groups.forEach(function (g) {
      var gd = byTarget[g];
      if (!gd || (gd.exclude && gd.exclude.indexOf(item.id) >= 0) || !holds(gd)) return;
      if (!best || timeOf(gd.at) > timeOf(best.at)) best = gd;
    });
    if (!best) return;
    out.items[item.id] = best;
    used[best.id] = true;
    if (best.target !== item.id) out.groups[best.target] = best;
  });

  var p = byTarget[PRIMARY_TARGET];
  if (p && p.action === 'approve' && p.note) {
    var known = ((state.accounts || {}).list || []).some(function (a) { return a.id === p.note; });
    var undecided = !state.accounts || state.accounts.primary === null || state.accounts.primary === undefined;
    if (known && (freshIds[p.id] || undecided)) { out.primary = p; used[p.id] = true; }
  }
  out.held = latest.filter(function (d) { return used[d.id]; });
  return out;
}

/**
 * The status the board shows for an item: its state status, moved by the decision that holds.
 * Returns `{ status, decision, asked, question }`.
 */
function effectiveOf(item, overlay) {
  var d = overlay.items[item.id] || null;
  if (!d) return { status: item.status, decision: null, asked: !!item.question, question: item.question || '' };
  if (d.action === 'ask') return { status: item.status, decision: d, asked: true, question: d.note || '' };
  return { status: ACTION_STATUS[d.action], decision: d, asked: false, question: '' };
}

/** Copies of the items with the effective status, for scoring what the page shows. */
function effectiveItems(state, overlay) {
  return (state.items || []).map(function (item) {
    var e = effectiveOf(item, overlay);
    if (e.status === item.status) return item;
    var copy = {};
    for (var k in item) if (Object.prototype.hasOwnProperty.call(item, k)) copy[k] = item[k];
    copy.status = e.status;
    return copy;
  });
}

/**
 * The decision queue of the Decide tab, fixed for a page load: groups that still have an open
 * member first, then every open item no such group covers, most severe first.
 * Returns `[{ kind: 'group' | 'item', id }]`.
 */
function decisionQueue(state) {
  var sev = { critical: 0, high: 1, medium: 2, low: 3 };
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
    .sort(function (a, b) { return (sev[a.i.severity] - sev[b.i.severity]) || (a.i.round - b.i.round) || (a.k - b.k); })
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
  if (seg[0] === 'decide') return { page: 'decide', arg: seg.slice(1).join('/') || null, q: q };
  return { page: 'overview', q: q };
}

/** Where the page keeps the route it was last on: one key per run, so two boards never share it. */
function routeKey(runId) { return 'novarc-harness-doctor:' + runId + ':route'; }

var ROUTE_MAX = 600;
var HARNESS_SUBS = { explorer: true, diagnosis: true, impact: true };

/**
 * True when a parsed route leads somewhere in this state. `known` is what the page has:
 * `{ harnesses: { id: true }, files: { fileId: harnessId }, views: { name: true }, targets: { id: true } }`,
 * where `targets` are the entries of the decision queue.
 */
function routeExists(route, known) {
  var has = function (map, key) { return !!map && typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key); };
  if (!route || !known) return false;
  if (route.page === 'overview') return true;
  if (route.page === 'decide') return !route.arg || route.arg === 'summary' || has(known.targets, route.arg);
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
 * How one metric moved between the two reviews: `{ pct, dir, tone }`. `pct` is the state's
 * `changePct`, or the change from `before` to `after` when the state has none; it is null when
 * either side was not measured. `dir` is 'down', 'up', 'flat' or null. `tone` is 'good' for a
 * fall and 'bad' for a rise, and '' when the verdict is a neutral one or when `waiting` is true
 * (the sample is still too small for any verdict to count).
 */
function metricChange(m, waiting) {
  var before = countOf(m && m.before);
  var after = countOf(m && m.after);
  if (before === null || after === null) return { pct: null, dir: null, tone: '' };
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
 * That history as one line: when it was first seen, in how many earlier reviews, and how the
 * last one left it, with the date and the note of that decision. Same `T` and `f` as followUpLine.
 */
function historyLine(hist, T, f) {
  var parts = [];
  if (hist.firstSeenAt) parts.push(f.fill(T.hist.first, { date: f.date(hist.firstSeenAt) }));
  if (hist.times) parts.push(f.plural(T.hist.times, hist.times));
  if (hist.lastStatus) {
    var status = f.label(T.hist.status, hist.lastStatus);
    var last = hist.lastDecisionAt ? f.fill(T.hist.lastOn, { status: status, date: f.date(hist.lastDecisionAt) }) : status;
    parts.push(last + (hist.lastNote ? ': ' + hist.lastNote : ''));
  }
  var text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
