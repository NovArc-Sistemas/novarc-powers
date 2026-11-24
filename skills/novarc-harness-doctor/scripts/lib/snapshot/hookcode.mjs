// Reads the source of a hook far enough to tell three things apart: code, comments and string
// literals. What a hook does is decided from its code; a comment that mentions `exit 2` and a
// message that quotes `"permissionDecision": "deny"` are not evidence of anything.
//
// It is a scanner, not a parser, for the languages hooks are written in: sh / bash / zsh,
// PowerShell, JavaScript / TypeScript and Python (Ruby and Perl get the `#` comment rule). It
// never runs anything. Where it cannot follow the source (a quote or a comment that never ends)
// it says so with `ok: false`, and the caller answers "unknown" instead of guessing.
const blank = (s) => s.replace(/[^\r\n]/g, ' ');
// How far back the start of the current command or the token before a `/` is looked for.
const LOOK_BACK = 400;

const EXT_LANG = {
  sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell', ps1: 'powershell', psm1: 'powershell',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'javascript', mts: 'javascript', cts: 'javascript',
  py: 'python', rb: 'hash', pl: 'hash',
};
// Programs that run the text they are given: the language their `-c` / `-e` string, or the
// here-document fed to them, is written in. `eval` and `trap` run their first argument.
const INTERPRETERS = {
  sh: 'shell', bash: 'shell', zsh: 'shell', dash: 'shell', ksh: 'shell', eval: 'shell', trap: 'shell',
  node: 'javascript', nodejs: 'javascript', deno: 'javascript', bun: 'javascript',
  python: 'python', python3: 'python', py: 'python', pwsh: 'powershell', powershell: 'powershell', ruby: 'hash', perl: 'hash',
};
// Words that may stand in front of the program of a command.
const WRAPPERS = new Set(['env', 'exec', 'command', 'sudo', 'nohup', 'time', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']);
const CODE_FLAG = /^(?:-[A-Za-z]*c|-e|-p|-pe|--eval|--print|--command|-command)$/i;
const SCRIPT_TOKEN = /[^\s"']+\.(?:sh|bash|zsh|ksh|ps1|psm1|js|mjs|cjs|ts|mts|cts|py|rb|pl)(?![A-Za-z0-9])/i;
// A `/` after one of these starts a regular expression, not a division.
const REGEX_AFTER = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|in|of|do|else|void|delete|throw|new|yield|await))\s*$/;

/** The language of a script, from its file name, else from its `#!` line. */
export function sourceLang(file, text = '') {
  const ext = /\.([A-Za-z0-9]+)$/.exec(String(file || ''));
  if (ext && EXT_LANG[ext[1].toLowerCase()]) return EXT_LANG[ext[1].toLowerCase()];
  const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(String(text || ''));
  if (shebang) {
    const prog = `${shebang[1]} ${shebang[2] || ''}`;
    if (/\b(node|deno|bun)\b/.test(prog)) return 'javascript';
    if (/\bpython[0-9.]*\b/.test(prog)) return 'python';
    if (/\b(pwsh|powershell)\b/.test(prog)) return 'powershell';
    if (/\b(ba|z|da|k)?sh\b/.test(prog)) return 'shell';
  }
  return 'hash';
}

/** What the command being written at the end of `tail` runs: its program and its last word so far. */
function commandAt(tail) {
  const words = tail.split(/[\n;|&(){}`]/).pop().trim().split(/\s+/).filter(Boolean);
  const base = (w) => w.replace(/^["']|["']$/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.has(base(words[i])))) i++;
  if (i >= words.length) return null;
  const head = base(words[i]);
  return { head, lang: INTERPRETERS[head] || null, last: words[words.length - 1], args: words.length - i - 1 };
}

/**
 * Split `source`, written in `lang`, into two texts of the same length and line structure:
 *   text  the source with its comments blanked out (strings kept: a decision is printed from one)
 *   code  the source with comments and the content of string literals blanked out, except a
 *         string or here-document that is itself code (`sh -c "..."`, `node -e '...'`,
 *         `python3 - <<'PY'`), which is read in its own language
 * `ok` is false when a quote, a comment or a here-document never ends: from there on both texts
 * hold the source as it is.
 */
export function splitSource(source, lang) {
  const src = String(source ?? '');
  const n = src.length;
  let text = '';
  let code = '';
  let ok = true;
  let from = 0; // start of the run of plain code not yet copied
  let recent = ''; // the last characters of `code`, kept apart so that looking back stays cheap
  const eol = (i) => { const k = src.indexOf('\n', i); return k === -1 ? n : k; };
  const emit = (t, c) => { text += t; code += c; recent = c.length >= LOOK_BACK ? c.slice(-LOOK_BACK) : (recent + c).slice(-LOOK_BACK); };
  const flush = (to) => { if (to > from) { const seg = src.slice(from, to); emit(seg, seg); } from = Math.max(from, to); };
  const comment = (s, e) => { flush(s); const b = blank(src.slice(s, e)); emit(b, b); from = e; return e; };
  /** A literal from `s` to `e` whose content is `[bs, be)`. `nested`: the language its content is code in. */
  const literal = (s, bs, be, e, nested = null) => {
    flush(s);
    const body = src.slice(bs, be);
    const inner = nested ? splitSource(body, nested) : null;
    if (inner && !inner.ok) ok = false;
    emit(src.slice(s, bs) + (inner ? inner.text : body) + src.slice(be, e), src.slice(s, bs) + (inner ? inner.code : blank(body)) + src.slice(be, e));
    from = e;
    return e;
  };
  /** Give up: the rest is copied as it is. */
  const lost = () => { ok = false; flush(n); return n; };
  /** The last characters of the code written so far, up to `i`. */
  const tail = (i) => {
    const pending = src.slice(Math.max(from, i - LOOK_BACK), i);
    return pending.length >= LOOK_BACK ? pending : recent.slice(-(LOOK_BACK - pending.length)) + pending;
  };
  const wordStart = (i) => i === 0 || /[\s;|&]/.test(src[i - 1]);
  /** End of a quoted run that starts after `i`: the index of the closing `q`, or -1. `esc`: the escape character. */
  const closing = (i, q, esc, sameLine) => {
    for (let j = i + 1; j < n; j++) {
      const c = src[j];
      if (c === esc) { j++; continue; }
      if (c === q) return j;
      if (sameLine && c === '\n') return -1;
    }
    return -1;
  };
  /** The language a string at `i` is code in, when the command it belongs to runs it. */
  const codeString = (i) => {
    const cmd = commandAt(tail(i));
    if (!cmd || !cmd.lang) return null;
    if (cmd.head === 'eval' || cmd.head === 'trap') return cmd.args === 0 ? cmd.lang : null;
    return CODE_FLAG.test(cmd.last) ? cmd.lang : null;
  };

  const heredocs = []; // here-documents opened on the current line: { delim, nested }
  const steps = {
    shell(i) {
      const c = src[i];
      if (c === '\\') return i + 2;
      if (c === '#' && wordStart(i)) return comment(i, eol(i));
      if (c === "'" || c === '"') {
        const e = closing(i, c, c === '"' ? '\\' : null, false);
        return e === -1 ? lost() : literal(i, i + 1, e, e + 1, codeString(i));
      }
      if (c === '$' && src[i + 1] === "'") {
        const e = closing(i + 1, "'", '\\', false);
        return e === -1 ? lost() : literal(i, i + 2, e, e + 1);
      }
      if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<' && src[i - 1] !== '<') {
        const m = /^<<[-~]?[ \t]*(?:(["'])([^"'\n]+)\1|\\?([A-Za-z_][A-Za-z0-9_]*))/.exec(src.slice(i, i + 200));
        if (m) {
          const cmd = commandAt(tail(i));
          heredocs.push({ delim: m[2] || m[3], nested: cmd && cmd.lang && cmd.head !== 'eval' && cmd.head !== 'trap' ? cmd.lang : null });
          return i + m[0].length;
        }
      }
      if (c === '\n' && heredocs.length) {
        let at = i + 1;
        for (const h of heredocs.splice(0)) {
          let end = -1;
          for (let j = at; j <= n; j = eol(j) + 1) {
            if (src.slice(j, eol(j)).trim() === h.delim) { end = j; break; }
            if (eol(j) === n) break;
          }
          if (end === -1) return lost();
          at = literal(at, at, end, eol(end), h.nested);
        }
        return at;
      }
      return -1;
    },
    powershell(i) {
      const c = src[i];
      if (c === '`') return i + 2;
      if (c === '<' && src[i + 1] === '#') { const e = src.indexOf('#>', i + 2); return e === -1 ? lost() : comment(i, e + 2); }
      if (c === '#' && (wordStart(i) || /[({]/.test(src[i - 1]))) return comment(i, eol(i));
      if (c === '@' && (src[i + 1] === '"' || src[i + 1] === "'") && /^[ \t]*\r?$/.test(src.slice(i + 2, eol(i)))) {
        const m = new RegExp(`\\n${src[i + 1]}@`).exec(src.slice(i));
        return m ? literal(i, i + 2, i + m.index, i + m.index + 3) : lost();
      }
      if (c === "'" || c === '"') {
        let e = i;
        for (;;) {
          e = closing(e, c, c === '"' ? '`' : null, false);
          if (e === -1) return lost();
          if (src[e + 1] !== c) break; // a doubled quote is a quote inside the string
          e++;
        }
        return literal(i, i + 1, e, e + 1);
      }
      return -1;
    },
    javascript(i) {
      const c = src[i];
      if (c === '#' && src[i + 1] === '!' && i === 0) return comment(i, eol(i));
      if (c === '/' && src[i + 1] === '/') return comment(i, eol(i));
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); return e === -1 ? lost() : comment(i, e + 2); }
      if (c === "'" || c === '"') { const e = closing(i, c, '\\', true); return e === -1 ? -1 : literal(i, i + 1, e, e + 1); }
      if (c === '`') { const e = closing(i, c, '\\', false); return e === -1 ? lost() : literal(i, i + 1, e, e + 1); }
      if (c === '/' && REGEX_AFTER.test(tail(i))) {
        let cls = false;
        for (let j = i + 1; j < n && src[j] !== '\n'; j++) {
          if (src[j] === '\\') j++;
          else if (src[j] === '[') cls = true;
          else if (src[j] === ']') cls = false;
          else if (src[j] === '/' && !cls) return literal(i, i + 1, j, j + 1);
        }
      }
      return -1;
    },
    python(i) {
      const c = src[i];
      if (c === '#') return comment(i, eol(i));
      if (c === "'" || c === '"') {
        if (src[i + 1] === c && src[i + 2] === c) {
          for (let j = i + 3; j < n; j++) {
            if (src[j] === '\\') j++;
            else if (src[j] === c && src[j + 1] === c && src[j + 2] === c) return literal(i, i + 3, j, j + 3);
          }
          return lost();
        }
        const e = closing(i, c, '\\', true);
        return e === -1 ? -1 : literal(i, i + 1, e, e + 1);
      }
      return -1;
    },
    hash(i) {
      const c = src[i];
      if (c === '#' && wordStart(i)) return comment(i, eol(i));
      if (c === "'" || c === '"') { const e = closing(i, c, '\\', true); return e === -1 ? -1 : literal(i, i + 1, e, e + 1); }
      return -1;
    },
  };
  const step = Object.hasOwn(steps, lang || '') ? steps[lang] : steps.hash;
  let i = 0;
  while (i < n) {
    const next = step(i);
    i = next > i ? next : i + 1;
  }
  flush(n);
  return { text, code, ok };
}

const NOTHING = { text: '', code: '', ok: true };

/**
 * Everything a command hook runs that could be read: its command line (a shell line) and the
 * script that line names, each split by splitSource and joined line by line.
 * `h`: { command, scriptText, scriptAbs | scriptDisplay }.
 */
export function hookSource(h) {
  const command = typeof h.command === 'string' ? h.command : '';
  const line = splitSource(command, 'shell');
  const read = typeof h.scriptText === 'string';
  const file = h.scriptAbs || h.scriptDisplay || (SCRIPT_TOKEN.exec(command) || [''])[0];
  const script = read ? splitSource(h.scriptText, sourceLang(file, h.scriptText)) : NOTHING;
  return { read, ok: line.ok && script.ok, text: `${line.text}\n${script.text}`, code: `${line.code}\n${script.code}` };
}
