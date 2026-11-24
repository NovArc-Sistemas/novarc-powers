// The prose policy: what the words of a review may carry of a person or of a machine.
//
// A reviewer, the user and the run itself write text that ends up in state.json, on the board and
// in the review records: titles, findings, notes. That text may name a person or a folder without
// any need. So, in prose and only in prose:
//
//   an e-mail address      keeps the first two characters of its local part (one when it has only
//                          one or two) and its domain: `alice@example.com` -> `al…@example.com`,
//                          the way an account identity is shown;
//   a known harness root   becomes its display path (`~/dev/shop`, or the path itself for a
//                          project outside the home), with forward slashes in what follows it;
//   any other absolute     a Windows drive path, a UNC path, a `file:` URL, or a POSIX path of
//   path                   three or more segments that starts at a well-known root of a file
//                          system (`/home/`, `/Users/`, `/var/`, ...: POSIX_ROOTS), becomes `…/`
//                          and its last two segments:
//                          `C:\Clients\Acme\notes\plan.md` -> `…/notes/plan.md`.
//
// Nothing is refused: the text is rewritten, and the caller is told where. What is left alone on
// purpose: `~/...` and relative paths, URLs, a POSIX path of one or two segments (a slash
// command, `/dev/null`) or one that starts anywhere else (a route such as `/api/v1/users`, a
// path written from the root of a repository such as `/src/app/page.tsx`), `name@1.2.3` (a
// package version), `git@host:owner/repo` (the address of a repository) and `logo@2x.png` (a
// file name).
//
// Which strings are prose is said by a list of JSON pointers with `*` for "every key or index":
// STATE_PROSE for the state, RECORD_PROSE for a review record. Text that must keep matching a
// file (`files[].content`, a change's `before`, `after` and `insertAfter`) and every path field
// are never in those lists.
//
// One prose field keeps its paths: the proposal of an item (EXACT_PATHS). A proposal is what
// gets applied, a command included, and the user must read exactly what they approve. An e-mail
// address in it is still masked, and a harness root is still shown as its display path.
//
// The policy is idempotent: applied to its own output it changes nothing.
import { folderMatchers, literalMatchers } from './scrub.mjs';
import { setOwn } from './store.mjs';

const ELLIPSIS = '…';

// ---------------------------------------------------------------------------------------------
// E-mail addresses
// ---------------------------------------------------------------------------------------------

// The local part starts where no address character comes before it; the domain ends in a label
// of letters, which is what tells `alice@example.com` from `react@18.3.1`.
const EMAIL_RE = /(?<![A-Za-z0-9._%+\-…*])([A-Za-z0-9][A-Za-z0-9._%+-]{0,63})@((?:[A-Za-z0-9][A-Za-z0-9-]{0,62}\.)+[A-Za-z]{2,24})(?![A-Za-z0-9-])/g;

/** `text` with every e-mail address masked: `alice@example.com` -> `al…@example.com`. */
export function maskEmails(text) {
  if (typeof text !== 'string' || !text.includes('@')) return text;
  return text.replace(EMAIL_RE, (whole, local, domain, offset, all) => {
    const after = all.slice(offset + whole.length, offset + whole.length + 2);
    if (/^:[^\s\d]/.test(after)) return whole; // git@host:owner/repo
    if (/^\d+x\./i.test(domain)) return whole; // logo@2x.png
    return `${local.slice(0, local.length > 2 ? 2 : 1)}${ELLIPSIS}@${domain}`;
  });
}

// ---------------------------------------------------------------------------------------------
// Absolute paths
// ---------------------------------------------------------------------------------------------

const QUOTES = '"\'`';
/**
 * The first segment of a POSIX path that is a path of some machine. Anything else that starts
 * with a slash is as likely a route or a path inside a repository, and is left as written.
 */
export const POSIX_ROOTS = new Set([
  'home', 'Users', 'root', 'var', 'etc', 'opt', 'usr', 'tmp', 'mnt', 'media', 'srv', 'private',
  'Volumes', 'Library', 'Applications', 'System', 'bin', 'sbin', 'lib', 'proc', 'dev', 'run',
]);
/** What may come right before a POSIX path that starts a word. */
const BEFORE_POSIX = new Set([' ', '\t', '\n', '\r', '"', "'", '`', '(', '[', '{', '=', ',', ';', '|']);
/** Where an unquoted path ends. */
const UNQUOTED_END = /[\s"'`<>|*?,;)\]}]/;
const CANDIDATE = /file:\/{2,3}|[A-Za-z]:[\\/]|\\\\|\//g;
const isWordChar = (c) => c !== undefined && /[A-Za-z0-9]/.test(c);
/** Private-use characters that stand for a known root while the other paths are shortened. */
const HOLD_OPEN = '\uE000';
const HOLD_CLOSE = '\uE001';

/** The end of the path that starts at `start`: up to the closing quote, or to the end of the word. */
function pathEnd(text, start, quote, backslashes) {
  if (quote) {
    const close = text.indexOf(quote, start);
    const line = text.indexOf('\n', start);
    if (close !== -1 && (line === -1 || close < line)) return close;
  }
  let end = start;
  while (end < text.length && !UNQUOTED_END.test(text[end])) end++;
  // A Windows path with a space in a folder name: the next word still belongs to it when it
  // holds a backslash, which running text otherwise never does.
  while (backslashes && text[end] === ' ') {
    let next = end + 1;
    while (next < text.length && !UNQUOTED_END.test(text[next])) next++;
    const word = text.slice(end + 1, next);
    if (!word.includes('\\') || /^[A-Za-z]:[\\/]/.test(word) || word.startsWith('\\\\')) break;
    end = next;
  }
  // The full stop or colon that ends a sentence is not part of the path; `:12` (a line) is.
  while (end > start && /[.:!]/.test(text[end - 1]) && !/:\d+$/.test(text.slice(start, end))) end--;
  return end;
}

/** `text` with every absolute path reduced to `…/` and its last two segments. */
export function shortenPaths(text) {
  if (typeof text !== 'string' || !/[\\/]/.test(text)) return text;
  let out = '';
  let done = 0;
  CANDIDATE.lastIndex = 0;
  for (let m = CANDIDATE.exec(text); m; m = CANDIDATE.exec(text)) {
    const at = m.index;
    const before = at > 0 ? text[at - 1] : undefined;
    let start = -1; // where the segments begin
    let posix = false;
    let backslashes = false;
    if (m[0].startsWith('file:')) {
      if (!isWordChar(before)) {
        const rest = text.slice(at + m[0].length);
        if (/^[A-Za-z]:[\\/]/.test(rest)) start = at + m[0].length + 2;
        else if (m[0].length === 8 && /^[^/\s]/.test(rest)) start = at + m[0].length;
      }
    } else if (m[0] === '\\\\') {
      if (before !== '\\' && before !== ':' && before !== ELLIPSIS && before !== HOLD_CLOSE && !isWordChar(before) && isWordChar(text[at + 2])) { start = at + 2; backslashes = true; }
    } else if (m[0] === '/') {
      const next = text[at + 1];
      if ((before === undefined || BEFORE_POSIX.has(before)) && next !== undefined && next !== '/' && !/\s/.test(next)) { start = at + 1; posix = true; }
    } else if (!isWordChar(before) && before !== ELLIPSIS && before !== HOLD_CLOSE) {
      start = at + 2;
      backslashes = m[0][2] === '\\';
    }
    if (start === -1) { CANDIDATE.lastIndex = at + 1; continue; }
    const quote = before !== undefined && QUOTES.includes(before) ? before : null;
    const end = pathEnd(text, start, quote, backslashes);
    const segments = text.slice(start, end).split(/[\\/]+/).filter(Boolean);
    // A POSIX path counts from three segments on, and only from a root of a file system.
    if (!segments.length || (posix && (segments.length < 3 || !POSIX_ROOTS.has(segments[0])))) { CANDIDATE.lastIndex = at + 1; continue; }
    out += `${text.slice(done, at)}${ELLIPSIS}/${segments.slice(-2).join('/')}`;
    done = end;
    CANDIDATE.lastIndex = end;
  }
  return done ? out + text.slice(done) : text;
}

// ---------------------------------------------------------------------------------------------
// One text
// ---------------------------------------------------------------------------------------------

/**
 * What the policy needs to know of the machine: the roots of the harnesses, each with the path it
 * is shown as. `roots` is `[{ abs, display }]`; `literal: true` takes `abs` as written (a path
 * read from a record names no folder of this machine).
 */
export function proseContext(roots = []) {
  const known = [];
  for (const r of roots) {
    if (!r || typeof r.abs !== 'string' || !r.abs || typeof r.display !== 'string' || !r.display) continue;
    const matchers = r.literal ? literalMatchers([r.abs]) : folderMatchers([r.abs]);
    if (matchers.length) known.push({ matchers, display: r.display, length: r.abs.length });
  }
  // The longest root first: a harness inside another is named, not its parent.
  known.sort((a, b) => b.length - a.length);
  return { roots: known };
}

/** The roots of a run: every harness and every account, as `proseContext` takes them. */
export function runRoots(run) {
  const roots = [];
  for (const x of [...(Array.isArray(run && run.harnesses) ? run.harnesses : []), ...(Array.isArray(run && run.accounts) ? run.accounts : [])]) {
    if (x && typeof x.pathAbs === 'string' && typeof x.path === 'string') roots.push({ abs: x.pathAbs, display: x.path });
  }
  return roots;
}

const EMPTY = { roots: [] };

/**
 * One prose text under the policy. `paths: false` leaves every other absolute path as written
 * (see EXACT_PATHS): e-mail addresses are still masked and harness roots still shown as their
 * display path.
 */
export function proseText(text, ctx = EMPTY, { paths = true } = {}) {
  if (typeof text !== 'string' || !text) return text;
  if (!text.includes('@') && !/[\\/]/.test(text)) return text;
  let s = text;
  const held = [];
  if (ctx.roots.length && /[\\/]/.test(s) && !s.includes(HOLD_OPEN) && !s.includes(HOLD_CLOSE)) {
    for (const root of ctx.roots) {
      for (const re of root.matchers) {
        re.lastIndex = 0;
        s = s.replace(re, () => { held.push(root.display); return `${HOLD_OPEN}${held.length - 1}${HOLD_CLOSE}`; });
      }
    }
    // What follows a root is shown the way display paths are written.
    if (held.length) s = s.replace(new RegExp(`${HOLD_CLOSE}[^\\s"'\`<>|*?,;)\\]}]*`, 'g'), (tail) => tail.replace(/\\+/g, '/'));
  }
  s = maskEmails(paths ? shortenPaths(s) : s);
  if (held.length) s = s.replace(new RegExp(`${HOLD_OPEN}(\\d+)${HOLD_CLOSE}`, 'g'), (whole, n) => held[Number(n)] ?? whole);
  return s;
}

// ---------------------------------------------------------------------------------------------
// A whole document
// ---------------------------------------------------------------------------------------------

/**
 * The prose of state.json. Reviewer text (items, groups, inventory, defenses, leads, layers,
 * rounds, file roles, element notes), the user's notes and labels, and the log.
 */
export const STATE_PROSE = [
  '/run/title',
  '/accounts/list/*/label', '/accounts/list/*/suggestionText', '/accounts/list/*/sync/detail', '/accounts/list/*/sync/elements/*/note',
  '/harnesses/*/name',
  '/harnesses/*/elements/*/*/note', '/harnesses/*/elements/*/*/reason',
  '/harnesses/*/followUp/items/*/title',
  '/rounds/*/note',
  '/layers/*/note',
  '/files/*/role',
  '/inventory/*/detail', '/inventory/*/opinion',
  '/items/*/title', '/items/*/finding', '/items/*/evidence', '/items/*/proposal', '/items/*/opinion',
  '/items/*/decision', '/items/*/question', '/items/*/verified', '/items/*/notVerified',
  '/items/*/saves/how', '/items/*/history/lastNote', '/items/*/lesson/*', '/items/*/changes/*/why',
  '/groups/*/title', '/groups/*/summary',
  '/defenses/*/title', '/defenses/*/detail',
  '/leads/*/title', '/leads/*/source', '/leads/*/note',
  '/decisions/*/note',
  '/log/*/text',
];

/** The prose of a review record (templates/record.schema.json). */
export const RECORD_PROSE = [
  '/name',
  '/items/*/title', '/items/*/proposal', '/items/*/verified', '/items/*/notVerified', '/items/*/principle',
  '/items/*/decision/note', '/items/*/saves/how',
  '/outcome/items/*/title',
];

/**
 * The prose that keeps its absolute paths as written, in the state and in a record alike: what an
 * item proposes. Everything else of the policy applies to it.
 */
export const EXACT_PATHS = ['/items/*/proposal'];

function compile(patterns) {
  const root = { kids: new Map(), leaf: false, paths: true };
  for (const pattern of patterns) {
    let node = root;
    for (const step of pattern.split('/').slice(1)) {
      if (!node.kids.has(step)) node.kids.set(step, { kids: new Map(), leaf: false, paths: true });
      node = node.kids.get(step);
    }
    node.leaf = true;
    node.paths = !EXACT_PATHS.includes(pattern);
  }
  return root;
}

const compiled = new Map();
const policyOf = (patterns) => {
  if (!compiled.has(patterns)) compiled.set(patterns, compile(patterns));
  return compiled.get(patterns);
};
const childOf = (node, key) => node.kids.get(key) || node.kids.get('*') || null;
const segment = (key) => String(key).replace(/~/g, '~0').replace(/\//g, '~1');

function walk(value, node, ctx, hits, at) {
  if (!node) return value;
  if (typeof value === 'string') {
    if (!node.leaf) return value;
    const out = proseText(value, ctx, { paths: node.paths });
    if (out !== value) hits.push(at || '/');
    return out;
  }
  if (Array.isArray(value)) {
    const kid = node.kids.get('*') || null;
    return kid ? value.map((v, i) => walk(v, kid, ctx, hits, `${at}/${i}`)) : value;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) setOwn(out, k, walk(v, childOf(node, k), ctx, hits, `${at}/${segment(k)}`));
    return out;
  }
  return value;
}

/**
 * Copy of `value` with the policy applied to the strings `patterns` name (STATE_PROSE,
 * RECORD_PROSE). `hits` receives the JSON pointer of every string that was rewritten; a pointer
 * never carries a value.
 */
export function applyProse(value, patterns, ctx = EMPTY, hits = []) {
  return walk(value, policyOf(patterns), ctx, hits, '');
}
