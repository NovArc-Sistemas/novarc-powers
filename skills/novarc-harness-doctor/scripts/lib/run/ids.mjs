// Harness ids and harness keys. An id is a slug used in file names and as the `harness` field of
// every state entry; a key is the short uppercase prefix of item ids (`U1`, `ACME`).

/** Ids that would collide with a folder the run already uses under `probes/`. */
export const RESERVED_IDS = ['accounts'];

const ascii = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** Lowercase slug matching `^[a-z0-9][a-z0-9-]*$`. */
export function slugify(text, fallback = 'harness') {
  const out = ascii(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return out || fallback;
}

/** `base`, or `base-2`, `base-3`... when taken. Adds the result to `taken`. */
export function uniqueId(base, taken) {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

const KEY_RE = /^[A-Z][A-Z0-9]{1,4}$/;

/**
 * Key candidates for a project name, best first: a short first word as it is (`acme-shop` ->
 * ACME), else the initials of its words (`novarc-powers` -> NP), else leading letters (`dashboard`
 * -> DASH). Always 2 to 5 characters starting with a letter.
 */
export function projectKeyCandidates(name) {
  const words = ascii(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/)
    .map((w) => w.toUpperCase().replace(/^[0-9]+/, '')).filter(Boolean);
  const out = [];
  const first = words[0] || '';
  if (first.length >= 2 && first.length <= 5) out.push(first);
  if (words.length >= 2) out.push(words.map((w) => w[0]).join('').slice(0, 5));
  if (first.length > 5) out.push(first.slice(0, 4));
  const joined = words.join('');
  for (const n of [3, 4, 5, 2]) {
    if (first.length >= n) out.push(first.slice(0, n));
    if (joined.length >= n) out.push(joined.slice(0, n));
  }
  if (words.length >= 2) out.push((words[0].slice(0, 2) + words[1].slice(0, 2)).slice(0, 5));
  // `U<n>` belongs to user harnesses even when none uses that number.
  return [...new Set(out)].filter((c) => KEY_RE.test(c) && !/^U[0-9]+$/.test(c));
}

/** A key for `name` that is not in `taken`; adds it to `taken`. */
export function uniqueProjectKey(name, taken) {
  const candidates = projectKeyCandidates(name);
  for (const c of candidates) if (!taken.has(c)) { taken.add(c); return c; }
  const base = candidates[0] || 'PJ';
  if (!taken.has(base)) { taken.add(base); return base; } // a name with no usable letters
  for (let n = 2; n < 100; n++) {
    const key = `${base.slice(0, n < 10 ? 4 : 3)}${n}`;
    if (!taken.has(key)) { taken.add(key); return key; }
  }
  for (let n = 100; ; n++) {
    const key = `P${n}`;
    if (!taken.has(key)) { taken.add(key); return key; }
  }
}

/**
 * Turn a validated selection into the run's accounts and harnesses.
 * User harnesses come first, in account order, with keys U1, U2...; then projects.
 */
export function assignHarnesses(accounts, projects) {
  const ids = new Set(RESERVED_IDS);
  const keys = new Set();
  const harnesses = [];
  const outAccounts = [];
  accounts.forEach((a, i) => {
    const id = uniqueId(slugify(a.id, 'account'), ids);
    const key = `U${i + 1}`;
    keys.add(key);
    const h = { id, key, kind: 'user', name: a.label, path: a.path, pathAbs: a.pathAbs, provider: a.provider, account: a.id };
    harnesses.push(h);
    outAccounts.push({ ...a, harness: id });
  });
  // A linked account takes its elements from the account it links into, when that one is in the run.
  for (const a of outAccounts) {
    if (!a.linksInto || a.linksInto === a.id) continue;
    const target = outAccounts.find((x) => x.id === a.linksInto);
    if (target && target.provider === a.provider) harnesses.find((h) => h.id === a.harness).inherits = target.harness;
  }
  for (const p of projects) {
    const id = uniqueId(slugify(p.name, 'project'), ids);
    const key = uniqueProjectKey(p.name, keys);
    const h = { id, key, kind: 'project', name: p.name, path: p.path, pathAbs: p.pathAbs };
    if (p.hints) h.hints = p.hints;
    harnesses.push(h);
  }
  return { accounts: outAccounts, harnesses };
}
