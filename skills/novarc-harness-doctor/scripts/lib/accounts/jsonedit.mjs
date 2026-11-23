// Surgical edits of a JSON text: change one value and keep every other byte (key order,
// indentation, line endings). Used on files the user or an app owns (settings.json, hooks.json,
// the Claude Code state file), where a whole-file re-serialisation would be a noisy diff.
//
// Every edit is verified: the result must parse to exactly the expected value, otherwise the
// function falls back to a plain re-serialisation with the file's own indentation.
import { canon } from '../../sync-check.mjs';

const BOM = String.fromCharCode(0xfeff);

class JsonSyntaxError extends Error {}

/** Parse JSON into a tree of nodes carrying their source offsets. */
function parseSpans(text) {
  let i = 0;
  const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++; };
  const str = () => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
    if (i >= text.length) throw new JsonSyntaxError('unterminated string');
    i++;
    return { start, end: i };
  };
  const value = () => {
    ws();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i++;
      const members = [];
      ws();
      if (text[i] === '}') { i++; return { type: 'object', start, end: i, members }; }
      for (;;) {
        ws();
        if (text[i] !== '"') throw new JsonSyntaxError('expected a key');
        const k = str();
        const key = JSON.parse(text.slice(k.start, k.end));
        ws();
        if (text[i] !== ':') throw new JsonSyntaxError('expected a colon');
        i++;
        const v = value();
        members.push({ key, start: k.start, end: v.end, value: v });
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return { type: 'object', start, end: i, members }; }
        throw new JsonSyntaxError('expected a comma or a closing brace');
      }
    }
    if (c === '[') {
      i++;
      const items = [];
      ws();
      if (text[i] === ']') { i++; return { type: 'array', start, end: i, items }; }
      for (;;) {
        const v = value();
        items.push(v);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return { type: 'array', start, end: i, items }; }
        throw new JsonSyntaxError('expected a comma or a closing bracket');
      }
    }
    if (c === '"') { const s = str(); return { type: 'scalar', start: s.start, end: s.end }; }
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) throw new JsonSyntaxError('unexpected token');
    i += m[0].length;
    return { type: 'scalar', start, end: i };
  };
  const root = value();
  ws();
  if (i !== text.length) throw new JsonSyntaxError('trailing content');
  return root;
}

function style(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = /\n([ \t]+)"/.exec(text);
  return { eol, unit: m ? m[1] : '  ' };
}

/** Leading whitespace of the line that holds `offset`, when only whitespace precedes it there. */
function indentAt(text, offset) {
  const nl = text.lastIndexOf('\n', offset - 1);
  const lead = text.slice(nl + 1, offset);
  return /^[ \t]*$/.test(lead) ? lead : null;
}

function lineIndent(text, offset) {
  const nl = text.lastIndexOf('\n', offset - 1);
  return /^[ \t]*/.exec(text.slice(nl + 1))[0];
}

function fmt(value, indent, st) {
  return JSON.stringify(value, null, st.unit).split('\n').map((l, n) => (n ? indent + l : l)).join(st.eol);
}

/** Text with `piece` added as the last child of a container node. `piece(indent)` renders it. */
function appendChild(text, node, children, piece, st) {
  const open = text[node.start];
  const close = open === '{' ? '}' : ']';
  if (!children.length) {
    const outer = lineIndent(text, node.start);
    const inner = outer + st.unit;
    return text.slice(0, node.start) + open + st.eol + inner + piece(inner) + st.eol + outer + close + text.slice(node.end);
  }
  const last = children[children.length - 1];
  const inner = indentAt(text, children[0].start);
  if (inner === null) return `${text.slice(0, last.end)}, ${piece(lineIndent(text, node.start))}${text.slice(last.end)}`;
  return text.slice(0, last.end) + ',' + st.eol + inner + piece(inner) + text.slice(last.end);
}

function removeChild(text, node, children, index) {
  if (children.length === 1) return text.slice(0, node.start + 1) + text.slice(node.end - 1);
  if (index === children.length - 1) return text.slice(0, children[index - 1].end) + text.slice(children[index].end);
  return text.slice(0, children[index].start) + text.slice(children[index + 1].start);
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function finish(original, edited, expected) {
  try {
    if (canon(JSON.parse(edited)) === canon(expected)) return edited;
  } catch { /* fall through to the plain form */ }
  const st = style(original);
  const tail = /\r?\n$/.test(original) ? st.eol : '';
  return JSON.stringify(expected, null, st.unit).replace(/\n/g, st.eol) + tail;
}

function parseOrThrow(text) {
  try { return { value: JSON.parse(text), root: parseSpans(text) }; } catch { throw new Error('not valid JSON'); }
}

/**
 * Set `value` at an object path, creating the objects on the way. A UTF-8 byte order mark and
 * everything outside the changed value are kept. Throws 'not valid JSON' on a bad input and
 * 'not an object' when the path crosses something that is not one.
 */
export function setIn(text, keys, value) {
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = bom ? text.slice(1) : text;
  const { value: data, root } = parseOrThrow(body);
  const st = style(body);
  const expected = clone(data);
  let obj = expected;
  for (let k = 0; k < keys.length - 1; k++) {
    if (obj[keys[k]] === undefined) obj[keys[k]] = {};
    obj = obj[keys[k]];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not an object');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not an object');
  obj[keys[keys.length - 1]] = value;

  let node = root;
  let depth = 0;
  for (; depth < keys.length; depth++) {
    if (node.type !== 'object') throw new Error('not an object');
    const m = node.members.find((x) => x.key === keys[depth]);
    if (!m) break;
    if (depth === keys.length - 1) {
      const edited = body.slice(0, m.value.start) + fmt(value, lineIndent(body, m.start), st) + body.slice(m.value.end);
      return bom + finish(body, edited, expected);
    }
    node = m.value;
  }
  if (node.type !== 'object') throw new Error('not an object');
  // Missing from `depth` on: add one member holding the rest of the path.
  let tail = value;
  for (let k = keys.length - 1; k > depth; k--) tail = { [keys[k]]: tail };
  const edited = appendChild(body, node, node.members, (indent) => `${JSON.stringify(keys[depth])}: ${fmt(tail, indent, st)}`, st);
  return bom + finish(body, edited, expected);
}

/** Append `value` to the array at an object path, creating the path and the array when missing. */
export function appendIn(text, keys, value) {
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = bom ? text.slice(1) : text;
  const { value: data, root } = parseOrThrow(body);
  let cur = data;
  for (const k of keys) cur = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur[k] : undefined;
  if (cur === undefined) return setIn(text, keys, [value]);
  if (!Array.isArray(cur)) throw new Error('not an array');
  const st = style(body);
  const expected = clone(data);
  let arr = expected;
  for (const k of keys) arr = arr[k];
  arr.push(value);
  let node = root;
  for (const k of keys) node = node.members.find((x) => x.key === k).value;
  const edited = appendChild(body, node, node.items, (indent) => fmt(value, indent, st), st);
  return bom + finish(body, edited, expected);
}

/** Follow a path of object keys (strings) and array positions (numbers); null when it breaks. */
function descend(node, keys) {
  for (const k of keys) {
    if (typeof k === 'number') node = node.type === 'array' ? node.items[k] : null;
    else { const m = node.type === 'object' ? node.members.find((x) => x.key === k) : null; node = m ? m.value : null; }
    if (!node) return null;
  }
  return node;
}

/** Remove the member at a path (the last segment is an object key). Unchanged when absent. */
export function removeIn(text, keys) {
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = bom ? text.slice(1) : text;
  const { value: data, root } = parseOrThrow(body);
  const node = descend(root, keys.slice(0, -1));
  const last = keys[keys.length - 1];
  const index = node && node.type === 'object' ? node.members.findIndex((x) => x.key === last) : -1;
  if (index === -1) return text;
  const expected = clone(data);
  let eo = expected;
  for (let k = 0; k < keys.length - 1; k++) eo = eo[keys[k]];
  delete eo[last];
  return bom + finish(body, removeChild(body, node, node.members, index), expected);
}

/** Remove item `index` of the array at a path. Unchanged when it is not there. */
export function removeItem(text, keys, index) {
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = bom ? text.slice(1) : text;
  const { value: data, root } = parseOrThrow(body);
  const node = descend(root, keys);
  if (!node || node.type !== 'array' || index < 0 || index >= node.items.length) return text;
  const expected = clone(data);
  let arr = expected;
  for (const k of keys) arr = arr[k];
  arr.splice(index, 1);
  return bom + finish(body, removeChild(body, node, node.items, index), expected);
}

/** The smallest description of how `before` became `after`: enough to restore `before` exactly. */
export function makePatch(before, after) {
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
  return { prefix, suffix, removed: before.slice(prefix, before.length - suffix) };
}

export function revertPatch(after, patch) {
  return after.slice(0, patch.prefix) + patch.removed + after.slice(after.length - patch.suffix);
}
