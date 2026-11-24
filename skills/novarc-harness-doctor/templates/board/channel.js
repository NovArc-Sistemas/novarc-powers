// Board client, fragment 2 of 9: the decision channel (references/contracts.md, "Decisions").
// One adapter, three ways out, chosen by what the page can actually do:
//   artifact  a claude.ai Artifact with the `db` capability: one document per target
//   server    served by serve-board.mjs on this machine: POST /api/decisions
//   file      opened from disk (or anywhere else): the user pastes a `run.mjs decide` line in chat
// The --channel flag only sets what the status says while the page is still finding out.

/**
 * `opts`: { hint, runId, onKind(kind), onRestore(decisions), onStale() }.
 * Returns { kind(), start(), send(decision) }. `send` resolves `{ ok }`; `ok: false` means the
 * decision did not leave the page and the caller shows the line to paste in chat.
 */
function createChannel(opts) {
  var kind = 'detecting';
  var db = null;
  var waiting = [];
  var writes = {};
  var token = '';
  var storageKey = 'novarc-harness-doctor:' + opts.runId;

  function setKind(k) {
    kind = k;
    opts.onKind(k);
    var q = waiting;
    waiting = [];
    q.forEach(function (w) { deliver(w.decision).then(w.resolve); });
  }

  function restore(list) {
    var clean = [];
    (list || []).forEach(function (raw) {
      var d = cleanDecision(raw && raw.data ? raw.data : raw, raw && raw.id && raw.data ? raw.id : undefined);
      if (d && (!d.runId || d.runId === opts.runId)) clean.push(d);
    });
    if (clean.length) opts.onRestore(clean);
  }

  // --- artifact -----------------------------------------------------------------------------
  function useDb(ns) {
    db = ns;
    try {
      db.collection('decisions').onSnapshot(function (snap) {
        var docs = snap && snap.docs ? snap.docs : [];
        restore(docs.map(function (doc) {
          var data = null;
          try { data = typeof doc.data === 'function' ? doc.data() : null; } catch (e) { data = null; }
          return { id: doc.id, data: data };
        }));
      }, function () { /* terminal for the listener only: decisions already restored stay */ });
    } catch (e) { /* the subscription is a convenience; writing still works */ }
    setKind('artifact');
  }

  function writeDb(d) {
    // One write at a time per document: each target has its own chain.
    var prev = writes[d.target] || Promise.resolve();
    var next = prev.then(function () { return db.collection('decisions').doc(d.target).set(d); });
    writes[d.target] = next.then(function () {}, function () {});
    return next.then(function () { return { ok: true }; }, function () { return { ok: false }; });
  }

  // --- local server -------------------------------------------------------------------------
  function isLocalServer() {
    var l = window.location;
    if (l.protocol !== 'http:' && l.protocol !== 'https:') return false;
    return l.hostname === '127.0.0.1' || l.hostname === 'localhost' || l.hostname === '[::1]' || l.hostname === '::1';
  }

  function api(path, extra) {
    return path + '?t=' + encodeURIComponent(token) + (extra || '');
  }

  function useServer() {
    try { token = new URLSearchParams(window.location.search).get('t') || ''; } catch (e) { token = ''; }
    setKind('server');
    fetch(api('/api/decisions'), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) { if (body) restore(Array.isArray(body) ? body : body.decisions); })
      .catch(function () {});
    var version = null;
    var poll = function () {
      fetch(api('/api/state', '&v=' + encodeURIComponent(version === null ? '' : version)), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (body) {
          if (!body) return;
          // The first answer only tells which version this page is; later ones can ask for a reload.
          if (version === null) { version = String(body.version); return; }
          if (body.changed === true || (body.version !== undefined && String(body.version) !== version)) opts.onStale();
        })
        .catch(function () {});
    };
    poll();
    window.setInterval(poll, 4000);
  }

  function postServer(d) {
    return fetch(api('/api/decisions'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })
      .then(function (r) { return { ok: r.ok }; }, function () { return { ok: false }; });
  }

  // --- file ---------------------------------------------------------------------------------
  function useFile() {
    setKind('file');
    try {
      var saved = JSON.parse(window.localStorage.getItem(storageKey) || '[]');
      if (Array.isArray(saved)) restore(saved);
    } catch (e) { /* storage is a convenience: the page works without it */ }
  }

  function remember(list) {
    if (kind !== 'file') return;
    try { window.localStorage.setItem(storageKey, JSON.stringify(list)); } catch (e) { /* same */ }
  }

  function deliver(d) {
    try {
      if (kind === 'artifact') return writeDb(d);
      if (kind === 'server') return postServer(d);
    } catch (e) { /* fall through to the paste line */ }
    return Promise.resolve({ ok: false });
  }

  function start() {
    var fallback = function () { if (isLocalServer()) useServer(); else useFile(); };
    var c = window.claude;
    if (c && typeof c.use === 'function') {
      // The namespace arrives later, possibly as null and possibly only after 10 s.
      opts.onKind('detecting');
      var p;
      try { p = c.use('db'); } catch (e) { p = null; }
      Promise.resolve(p).then(function (ns) { if (ns) useDb(ns); else fallback(); }, fallback);
      return;
    }
    fallback();
  }

  return {
    kind: function () { return kind; },
    start: start,
    remember: remember,
    send: function (d) {
      if (kind !== 'detecting') return deliver(d);
      return new Promise(function (resolve) { waiting.push({ decision: d, resolve: resolve }); });
    },
  };
}
