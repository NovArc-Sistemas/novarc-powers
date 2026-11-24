// Board client, fragment 2 of 10: keeping the page current. The board only shows; nothing leaves
// it. Served by serve-board.mjs on this machine it asks `/api/state` every few seconds and reloads
// when the run's board was rebuilt. Opened from disk, or published as a claude.ai Artifact (which
// the agent republishes after each build), there is nothing to ask.

/**
 * `opts`: { onStale() }. Returns { start() }. `onStale` is called once the server says the board
 * on disk is newer than this page.
 */
function createRefresh(opts) {
  var token = '';

  function isLocalServer() {
    var l = window.location;
    if (l.protocol !== 'http:' && l.protocol !== 'https:') return false;
    return l.hostname === '127.0.0.1' || l.hostname === 'localhost' || l.hostname === '[::1]' || l.hostname === '::1';
  }

  function poll(version) {
    return fetch('/api/state?t=' + encodeURIComponent(token) + '&v=' + encodeURIComponent(version === null ? '' : version), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
  }

  function start() {
    if (!isLocalServer()) return;
    try { token = new URLSearchParams(window.location.search).get('t') || ''; } catch (e) { token = ''; }
    var version = null;
    var tick = function () {
      poll(version).then(function (body) {
        if (!body) return;
        // The first answer only tells which version this page is; later ones can ask for a reload.
        if (version === null) { version = String(body.version); return; }
        if (body.changed === true || (body.version !== undefined && String(body.version) !== version)) opts.onStale();
      }).catch(function () {});
    };
    tick();
    window.setInterval(tick, 4000);
  }

  return { start: start };
}
