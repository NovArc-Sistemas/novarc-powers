// Board client, fragment 1 of 9: decision logic. No DOM and no globals, so the same text is
// loaded by tests/board-logic.test.mjs in Node.
//
// The fragments in this folder are concatenated by scripts/render-board.mjs, in the order listed
// there, inside one function scope: a name declared in one fragment is visible in the next ones.

/** What a decision turns an item into. `ask` leaves the status alone and sets a question. */
var ACTION_STATUS = { approve: 'approved', decline: 'declined', defer: 'deferred' };
var ACTIONS = { approve: true, decline: true, defer: true, ask: true };
/** Statuses the user can still decide (or decide again) from the board. */
var DECIDABLE = { open: true, deferred: true, declined: true, failed: true, approved: true };
var PRIMARY_TARGET = 'accounts.primary';

/** A value quoted for a shell command line the user pastes in chat. */
function quoteArg(text) {
  return '"' + String(text).replace(/\s+/g, ' ').trim().replace(/[\\"$`]/g, '\\$&') + '"';
}

/** The exact line that records a decision from chat (references/contracts.md, `run.mjs decide`). */
function decisionCommand(d) {
  var parts = ['run.mjs decide', '--run', d.runId, '--target', d.target, '--action', d.action];
  if (d.note) parts.push('--note', quoteArg(d.note));
  if (d.exclude && d.exclude.length) parts.push('--exclude', d.exclude.join(','));
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

/** One decision in the shape every channel carries. Empty `note` and `exclude` are left out. */
function makeDecision(runId, target, action, note, exclude, id, at) {
  var d = { id: id, at: at, runId: runId, target: target, action: action, via: 'board' };
  var text = typeof note === 'string' ? note.trim() : '';
  if (text) d.note = text;
  if (exclude && exclude.length) d.exclude = exclude.slice();
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
  var latest = latestPerTarget(decisions.filter(function (d) { return !inState[d.id]; }));
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
