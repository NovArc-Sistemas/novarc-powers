// The managed pointer block written into agent instruction files for
// on-demand skills. Only the text between the markers is ever touched.
import { sha256 } from './fsutil.js';

export const BLOCK_START = '<!-- novarc-powers:start -->';
export const BLOCK_END = '<!-- novarc-powers:end -->';

/** Detect the line ending a file already uses; LF when it has none. */
export function detectEol(text) {
  if (!text) return '\n';
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * Block body (LF line endings, no markers). `skills` is a list of
 * `{name, summary}`; `version` is the package version used in the fetch command.
 */
export function renderBlockBody(skills, version) {
  // The GitHub form is the fallback for a version that is not on the npm registry.
  const lines = [
    '## NovArc Powers (on-demand skills)',
    '',
    'These skills are not installed. Fetch one only when the task calls for it:',
    `\`npx -y novarc-powers@${version} fetch <skill>\` prints the path of its SKILL.md; read that file and follow it.`,
    `If npm cannot find that version, use \`npx -y github:NovArc-Sistemas/novarc-powers#v${version} fetch <skill>\`.`,
    '',
  ];
  for (const s of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`- \`${s.name}\`: ${s.summary}`);
  }
  return lines.join('\n');
}

/** Full block (markers included) with the given line ending. */
export function renderBlock(body, eol = '\n') {
  return [BLOCK_START, ...body.split('\n'), BLOCK_END].join(eol);
}

/** Locate an existing block: returns `{start, end}` offsets (end exclusive) or null. */
export function findBlock(text) {
  const start = text.indexOf(BLOCK_START);
  if (start === -1) return null;
  const endMarker = text.indexOf(BLOCK_END, start);
  if (endMarker === -1) return null;
  return { start, end: endMarker + BLOCK_END.length };
}

/** Text of the current block (markers included, EOL normalised to LF), or null. */
export function extractBlock(text) {
  if (text == null) return null;
  const loc = findBlock(text);
  if (!loc) return null;
  return text.slice(loc.start, loc.end).replace(/\r\n/g, '\n');
}

/** Hash of a block, independent of line endings. */
export function blockHash(blockText) {
  return sha256(blockText.replace(/\r\n/g, '\n'));
}

/**
 * Insert or replace the block. `text` may be null (file missing). Text outside
 * the block is preserved byte for byte; the file's line ending is kept.
 */
export function upsertBlock(text, body) {
  const original = text ?? '';
  const eol = detectEol(original);
  const block = renderBlock(body, eol);
  const loc = findBlock(original);
  if (loc) return original.slice(0, loc.start) + block + original.slice(loc.end);
  if (original === '') return block + eol;
  // Append after the existing content, separated by one blank line.
  let prefix = original;
  if (!prefix.endsWith('\n')) prefix += eol;
  if (!prefix.endsWith(eol + eol) && !/^\s*$/.test(prefix)) prefix += eol;
  return prefix + block + eol;
}

/**
 * Remove the block and the blank line this tool added before it. Returns the
 * new text; '' when nothing else remains.
 */
export function removeBlock(text) {
  if (text == null) return text;
  const loc = findBlock(text);
  if (!loc) return text;
  const eol = detectEol(text);
  let before = text.slice(0, loc.start);
  let after = text.slice(loc.end);
  if (after.startsWith(eol)) after = after.slice(eol.length);
  else if (after.startsWith('\n')) after = after.slice(1);
  if (after === '' && before.endsWith(eol + eol)) before = before.slice(0, -eol.length);
  const out = before + after;
  return /^\s*$/.test(out) ? '' : out;
}
