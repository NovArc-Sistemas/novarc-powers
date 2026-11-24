// Anchoring for novarc-harness-doctor: where each proposed change sits inside the file it touches.
//
// Pure ESM with no imports: render-board.mjs imports it to report changes that cannot be located,
// and the same source is inlined into board.html (the `export` keywords are stripped there) so the
// file viewer can draw every change in place. Keep it free of Node and DOM APIs, and declare every
// export as `export const` or `export function` at the start of a line.
//
// Rules (templates/state.schema.json, `items[].changes`):
// - a pending change is located by its exact `before` text; a pure insertion (`before` empty) by
//   its `insertAfter` line, or appended at the end when there is none;
// - an applied change (`applied: true`) is located by its exact `after` text;
// - a change with no `file` and an empty `before` is a new file;
// - CRLF is normalised to LF on both sides before matching;
// - a file that is a link into another harness's file (`omitted: 'linked'`) has no text of its
//   own: a change aimed at it is located in the file it links to;
// - a change that cannot be located is reported as a warning and kept as a detached hunk;
// - of two changes that touch the same lines, the first wins and the other is a warning.

/** Largest LCS table (rows x columns) built for one hunk; larger hunks fall back to a block diff. */
export const LCS_LIMIT = 250000;
/** Most places one text is tried at before giving up on finding a free one. */
export const CANDIDATE_LIMIT = 64;

/** English text for each problem code; the board shows its own localised text by code. */
export const PROBLEMS = {
  'before-not-found': 'before text not found in the file',
  'after-not-found': 'after text of an applied change not found in the file',
  'insert-after-not-found': 'insertAfter line not found in the file',
  overlap: 'overlaps an earlier change in the same file',
  'no-op': 'before and after are identical',
  'file-not-in-snapshot': 'the file is not in the snapshot',
  'file-id-unknown': 'file id not found in files',
  'file-omitted': 'the file content is omitted from the snapshot',
};

export function normalizeEol(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n');
}

/** Lines of a text. One trailing newline is a terminator, not an extra empty line; '' has no lines. */
export function toLines(text) {
  const s = normalizeEol(text);
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function joinLines(lines, trailingNewline) {
  if (!lines.length) return '';
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

function stripOneNewline(s) {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

/**
 * Line diff of two arrays of lines: rows of `{ t: 'same' | 'del' | 'add', text }`, deletions
 * before additions. Common leading and trailing lines are matched first; the middle uses an LCS
 * table, or a plain block (all deleted, then all added) past LCS_LIMIT.
 */
export function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  let p = 0;
  while (p < n && p < m && a[p] === b[p]) p++;
  let s = 0;
  while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) s++;
  const rows = [];
  for (let i = 0; i < p; i++) rows.push({ t: 'same', text: a[i] });
  const A = a.slice(p, n - s);
  const B = b.slice(p, m - s);
  if (A.length * B.length > LCS_LIMIT || !A.length || !B.length) {
    for (const x of A) rows.push({ t: 'del', text: x });
    for (const x of B) rows.push({ t: 'add', text: x });
  } else {
    const w = B.length + 1;
    const table = new Uint32Array((A.length + 1) * w);
    for (let i = A.length - 1; i >= 0; i--) {
      for (let j = B.length - 1; j >= 0; j--) {
        table[i * w + j] = A[i] === B[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < A.length || j < B.length) {
      if (i < A.length && j < B.length && A[i] === B[j]) { rows.push({ t: 'same', text: A[i] }); i++; j++; }
      else if (i < A.length && (j >= B.length || table[(i + 1) * w + j] >= table[i * w + j + 1])) { rows.push({ t: 'del', text: A[i] }); i++; }
      else { rows.push({ t: 'add', text: B[j] }); j++; }
    }
  }
  for (let i = n - s; i < n; i++) rows.push({ t: 'same', text: a[i] });
  return rows;
}

/** Category for a file that exists only as a proposal, from its path. Display only. */
export function guessCategory(path) {
  const p = String(path || '').replace(/\\/g, '/').toLowerCase();
  const base = p.split('/').pop() || '';
  if (/(^|\/)(\.githooks|\.husky|\.git\/hooks|\.github\/workflows|\.gitlab)\//.test(p) || /^(pre-commit|pre-push|commit-msg|lefthook\.ya?ml|\.pre-commit-config\.ya?ml|\.gitlab-ci\.ya?ml)$/.test(base)) return 'gate';
  if (/(^|\/)skills\//.test(p)) return 'skill';
  if (/(^|\/)agents\/[^/]+$/.test(p)) return 'agent';
  if (/(^|\/)commands\//.test(p)) return 'command';
  if (/(^|\/)rules\//.test(p) || base === '.cursorrules') return 'rule';
  if (/(^|\/)hooks\//.test(p)) return 'hook';
  if (/(^|\/)plugins\//.test(p)) return 'plugin';
  if (/(^|\/)memory\//.test(p) || base === 'memory.md') return 'memory';
  if (/^(claude|agents|gemini|copilot-instructions)(\.local)?\.md$/.test(base)) return 'instructions';
  if (base === '.mcp.json' || base === 'mcp.json') return 'mcp';
  if (/^settings(\.local)?\.json$/.test(base) || base === 'config.toml' || base === 'keybindings.json') return 'settings';
  if (/(^|\/)(scripts|bin)\//.test(p) || /\.(sh|ps1|bash|zsh)$/.test(base)) return 'script';
  if (/(^|\/)docs?\//.test(p) || /^(readme|changelog|contributing)(\.[a-z-]+)?\.md$/.test(base)) return 'doc';
  return 'other';
}

/** Language for a file that exists only as a proposal, from its extension. Display only. */
export function guessLang(path) {
  const base = String(path || '').toLowerCase().split(/[\\/]/).pop() || '';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  const map = { md: 'markdown', mdx: 'markdown', json: 'json', toml: 'toml', yml: 'yaml', yaml: 'yaml', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', js: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python' };
  if (map[ext]) return map[ext];
  if (/^(pre-commit|pre-push|commit-msg)$/.test(base)) return 'shell';
  return 'text';
}

function runAt(lines, needle, at) {
  for (let k = 0; k < needle.length; k++) if (lines[at + k] !== needle[k]) return false;
  return true;
}

/**
 * Places where `text` occurs in `lines`, in file order: first as a run of whole lines, then
 * inside lines (a partial-line match carries the `prefix` and `suffix` left on its first and last
 * line). Each place is `{ start, end, prefix, suffix }` with a half-open line range.
 */
function candidates(lines, text) {
  const out = [];
  const seen = new Set();
  const needle = toLines(text);
  if (needle.length) {
    for (let i = 0; i + needle.length <= lines.length && out.length < CANDIDATE_LIMIT; i++) {
      if (!runAt(lines, needle, i)) continue;
      seen.add(i + ':' + (i + needle.length));
      out.push({ start: i, end: i + needle.length, prefix: '', suffix: '' });
    }
  }
  const t = stripOneNewline(normalizeEol(text));
  if (!t || !lines.length) return out;
  const joined = lines.join('\n');
  const starts = new Array(lines.length);
  let off = 0;
  for (let i = 0; i < lines.length; i++) { starts[i] = off; off += lines[i].length + 1; }
  const lineOf = (pos) => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  let from = 0;
  while (out.length < CANDIDATE_LIMIT) {
    const idx = joined.indexOf(t, from);
    if (idx < 0) break;
    from = idx + 1;
    const a = lineOf(idx);
    const b = lineOf(idx + t.length - 1);
    if (seen.has(a + ':' + (b + 1))) continue;
    const prefix = joined.slice(starts[a], idx);
    const suffix = joined.slice(idx + t.length, starts[b] + lines[b].length);
    if (prefix === '' && suffix === '') continue;
    out.push({ start: a, end: b + 1, prefix, suffix });
  }
  return out;
}

/** Removes the lines both sides share at the start and at the end, shrinking the range to match. */
function trimHunk(h) {
  const r = h.removed;
  const a = h.added;
  let lead = 0;
  while (lead < r.length && lead < a.length && r[lead] === a[lead]) lead++;
  let trail = 0;
  while (trail < r.length - lead && trail < a.length - lead && r[r.length - 1 - trail] === a[a.length - 1 - trail]) trail++;
  if (!lead && !trail) return h;
  // The range is over the current lines: the removed side for a pending change, the added side
  // for an applied one. Both sides lose the same lines, so it shrinks by the same amount.
  return {
    start: h.start + lead,
    end: h.end - trail,
    removed: r.slice(lead, r.length - trail),
    added: a.slice(lead, a.length - trail),
  };
}

function isFree(h, placed) {
  const zero = h.start === h.end;
  for (const p of placed) {
    const pZero = p.start === p.end;
    if (zero && pZero) continue;
    if (zero) { if (p.start < h.start && h.start < p.end) return false; continue; }
    if (pZero) { if (h.start < p.start && p.start < h.end) return false; continue; }
    if (h.start < p.end && p.start < h.end) return false;
  }
  return true;
}

function numberRows(rows, oldStart, newStart) {
  let o = oldStart;
  let n = newStart;
  return rows.map((r) => {
    if (r.t === 'same') return { t: 'same', text: r.text, old: o++, new: n++ };
    if (r.t === 'del') return { t: 'del', text: r.text, old: o++ };
    return { t: 'add', text: r.text, new: n++ };
  });
}

/**
 * Anchors the changes of one file.
 *
 * `file` is a `files[]` entry (or a stand-in with `virtual: 'new' | 'missing'`); `entries` is
 * `[{ item, index, change }]` in state order. Returns
 * `{ segments, detached, before, current, after, stats, warnings }`:
 * - `segments`: ordered `{ type: 'same', lines, oldStart, newStart, curStart }` and
 *   `{ type: 'hunk', item, change, applied, removed, added, rows, oldStart, newStart, curStart }`,
 *   where `rows` is the numbered line diff of the hunk and the line numbers are 1-based;
 * - `detached`: hunks that could not be placed, each with a problem `code`;
 * - `before`: the file before any change of this run (applied changes reverted);
 *   `current`: the file as the snapshot has it; `after`: the file with every pending change applied.
 */
export function anchorFile(file, entries) {
  const f = file || {};
  const content = normalizeEol(f.content);
  const lines = toLines(content);
  const placed = [];
  const detached = [];
  const warnings = [];
  let newFileNewline = null;

  const fail = (entry, code, silent) => {
    const removed = toLines(entry.change.before);
    const added = toLines(entry.change.after);
    detached.push({
      type: 'hunk', detached: true, code,
      item: entry.item, change: entry.index, applied: entry.change.applied === true,
      removed, added, rows: numberRows(diffLines(removed, added), 1, 1),
    });
    if (!silent) warnings.push({ item: entry.item, change: entry.index, problem: PROBLEMS[code] || code, code });
  };

  (entries || []).forEach((entry, seq) => {
    const c = entry.change || {};
    const applied = c.applied === true;
    const beforeText = normalizeEol(c.before);
    const afterText = normalizeEol(c.after);
    if (f.virtual === 'missing') return fail(entry, f.problem || 'file-not-in-snapshot');
    if (f.omitted) return fail(entry, 'file-omitted');

    let options = [];
    let missing = 'before-not-found';
    if (f.virtual === 'new' && beforeText === '' && !c.insertAfter) {
      // The file does not exist yet: its whole text is the addition.
      options = [{ start: 0, end: 0, removed: [], added: toLines(afterText) }];
      missing = 'overlap';
    } else if (applied) {
      // An applied removal leaves nothing to look for: it is kept as history, without a warning.
      if (afterText === '') return fail(entry, 'applied-removal', true);
      missing = 'after-not-found';
      options = candidates(lines, afterText).map((k) => ({
        start: k.start,
        end: k.end,
        removed: toLines(k.prefix + stripOneNewline(beforeText) + k.suffix),
        added: lines.slice(k.start, k.end),
      }));
    } else if (beforeText !== '') {
      options = candidates(lines, beforeText).map((k) => ({
        start: k.start,
        end: k.end,
        removed: lines.slice(k.start, k.end),
        added: k.prefix === '' && k.suffix === '' ? toLines(afterText) : toLines(k.prefix + stripOneNewline(afterText) + k.suffix),
      }));
    } else if (c.insertAfter !== undefined && c.insertAfter !== null && normalizeEol(c.insertAfter) !== '') {
      missing = 'insert-after-not-found';
      const needle = toLines(c.insertAfter);
      for (let i = 0; i + needle.length <= lines.length && options.length < CANDIDATE_LIMIT; i++) {
        if (runAt(lines, needle, i)) options.push({ start: i + needle.length, end: i + needle.length, removed: [], added: toLines(afterText) });
      }
    } else {
      options = [{ start: lines.length, end: lines.length, removed: [], added: toLines(afterText) }];
    }

    if (!options.length) return fail(entry, missing);
    let noop = false;
    for (const raw of options) {
      const h = trimHunk(raw);
      if (!h.removed.length && !h.added.length) { noop = true; continue; }
      if (!isFree(h, placed)) continue;
      placed.push({ start: h.start, end: h.end, removed: h.removed, added: h.added, item: entry.item, change: entry.index, applied, seq });
      if (f.virtual === 'new' && newFileNewline === null) newFileNewline = afterText.endsWith('\n');
      return undefined;
    }
    return fail(entry, noop ? 'no-op' : 'overlap');
  });

  placed.sort((a, b) => a.start - b.start || (a.start === a.end ? 0 : 1) - (b.start === b.end ? 0 : 1) || a.seq - b.seq);

  const segments = [];
  const beforeLines = [];
  const afterLines = [];
  let pos = 0;
  let oldNo = 1;
  let newNo = 1;
  const same = (to) => {
    if (to <= pos) return;
    const chunk = lines.slice(pos, to);
    segments.push({ type: 'same', lines: chunk, oldStart: oldNo, newStart: newNo, curStart: pos + 1 });
    for (const x of chunk) { beforeLines.push(x); afterLines.push(x); }
    oldNo += chunk.length;
    newNo += chunk.length;
    pos = to;
  };
  const stats = { hunks: placed.length, pending: 0, applied: 0, added: 0, removed: 0, detached: detached.length };
  for (const h of placed) {
    same(h.start);
    segments.push({
      type: 'hunk', item: h.item, change: h.change, applied: h.applied,
      removed: h.removed, added: h.added,
      rows: numberRows(diffLines(h.removed, h.added), oldNo, newNo),
      oldStart: oldNo, newStart: newNo, curStart: h.start + 1,
    });
    for (const x of h.removed) beforeLines.push(x);
    for (const x of h.added) afterLines.push(x);
    oldNo += h.removed.length;
    newNo += h.added.length;
    pos = h.end;
    stats[h.applied ? 'applied' : 'pending']++;
    stats.added += h.added.length;
    stats.removed += h.removed.length;
  }
  same(lines.length);

  const newline = lines.length ? content.endsWith('\n') : newFileNewline !== false;
  return {
    segments,
    detached,
    before: joinLines(beforeLines, newline),
    current: joinLines(lines, content.endsWith('\n')),
    after: joinLines(afterLines, newline),
    stats,
    warnings,
  };
}

/** Stable id of a file that exists only in a change (a new file, or one outside the snapshot). */
export function virtualFileId(harness, path) {
  return 'new:' + harness + ':' + path;
}

/**
 * Anchors every change of a state. Returns
 * `{ files, virtual, byItem, warnings }`:
 * - `files`: anchor result by file id, for the files that have at least one change;
 * - `virtual`: stand-in file records for new files and for files outside the snapshot, shaped
 *   like `files[]` entries plus `virtual: 'new' | 'missing'`;
 * - `byItem`: for each item id, `[{ change, file, located, code }]`;
 * - `warnings`: `[{ item, change, problem, code }]` in state order.
 */
export function anchorState(state) {
  const files = state.files || [];
  const byId = new Map();
  const byPath = new Map();
  for (const f of files) {
    byId.set(f.id, f);
    const k = f.harness + '\n' + f.path;
    if (!byPath.has(k)) byPath.set(k, f);
  }
  // A linked file stands for the file it links to (same path, in the harness that owns it).
  const real = (f) => {
    if (!f || f.omitted !== 'linked' || !f.linkTo || !f.inheritedFrom) return f;
    const target = byPath.get(f.inheritedFrom + '\n' + f.linkTo);
    return target && target.omitted !== 'linked' ? target : f;
  };
  const virtual = new Map();
  const buckets = new Map();
  const order = [];
  const bucket = (file) => {
    if (!buckets.has(file.id)) { buckets.set(file.id, { file, entries: [] }); order.push(file.id); }
    return buckets.get(file.id);
  };
  const standIn = (item, c, kind, problem) => {
    const id = virtualFileId(item.harness, c.path);
    if (!virtual.has(id)) {
      virtual.set(id, { id, harness: item.harness, path: c.path, category: guessCategory(c.path), lang: c.lang || guessLang(c.path), content: '', virtual: kind, problem });
    }
    return virtual.get(id);
  };

  for (const item of state.items || []) {
    (item.changes || []).forEach((c, index) => {
      let file = null;
      if (c.file) {
        file = real(byId.get(c.file)) || standIn(item, c, 'missing', 'file-id-unknown');
      } else {
        const known = real(byPath.get(item.harness + '\n' + c.path));
        const isNew = normalizeEol(c.before) === '' && !c.insertAfter;
        // Without a file id, a change that names existing text, or one already applied, still
        // belongs to the snapshot file at the same path when there is one.
        if (known && (!isNew || c.applied === true)) file = known;
        else if (isNew) file = standIn(item, c, 'new');
        else file = standIn(item, c, 'missing', 'file-not-in-snapshot');
      }
      bucket(file).entries.push({ item: item.id, index, change: c });
    });
  }

  const out = { files: {}, virtual: [...virtual.values()], byItem: {}, warnings: [] };
  const located = new Map();
  for (const id of order) {
    const b = buckets.get(id);
    const res = anchorFile(b.file, b.entries);
    out.files[id] = res;
    for (const s of res.segments) if (s.type === 'hunk') located.set(s.item + '\n' + s.change, { file: id, located: true, code: null });
    for (const d of res.detached) located.set(d.item + '\n' + d.change, { file: id, located: false, code: d.code });
  }
  // Warnings and the per-item index follow state order, not file order.
  const warnAt = new Map();
  for (const id of order) for (const w of out.files[id].warnings) warnAt.set(w.item + '\n' + w.change, w);
  for (const item of state.items || []) {
    (item.changes || []).forEach((c, index) => {
      const k = item.id + '\n' + index;
      const at = located.get(k);
      if (!out.byItem[item.id]) out.byItem[item.id] = [];
      out.byItem[item.id].push({ change: index, file: at ? at.file : null, located: !!(at && at.located), code: at ? at.code : null });
      if (warnAt.has(k)) out.warnings.push(warnAt.get(k));
    });
  }
  return out;
}

/**
 * The rows of one hunk with up to `context` unchanged lines on each side, for showing a change
 * outside the file viewer. Returns `{ rows, located }`, or null when the change is not in `result`.
 */
export function hunkContext(result, item, change, context) {
  const n = context === undefined ? 3 : context;
  const segs = result.segments;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.type !== 'hunk' || s.item !== item || s.change !== change) continue;
    const rows = [];
    const prev = segs[i - 1];
    if (prev && prev.type === 'same' && n > 0) {
      const from = Math.max(0, prev.lines.length - n);
      for (let k = from; k < prev.lines.length; k++) rows.push({ t: 'same', text: prev.lines[k], old: prev.oldStart + k, new: prev.newStart + k });
    }
    for (const r of s.rows) rows.push(r);
    const next = segs[i + 1];
    if (next && next.type === 'same' && n > 0) {
      for (let k = 0; k < Math.min(n, next.lines.length); k++) rows.push({ t: 'same', text: next.lines[k], old: next.oldStart + k, new: next.newStart + k });
    }
    return { rows, located: true, applied: s.applied, added: s.added.length, removed: s.removed.length };
  }
  for (const d of result.detached) {
    if (d.item === item && d.change === change) return { rows: d.rows, located: false, applied: d.applied, added: d.added.length, removed: d.removed.length, code: d.code };
  }
  return null;
}
