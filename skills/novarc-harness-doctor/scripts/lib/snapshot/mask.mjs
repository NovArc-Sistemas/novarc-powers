// Masking for harness file text that is about to leave the machine inside a snapshot.
// Pure string work, no file system access. Every function keeps the line structure of its input,
// so a line number in the snapshot is the line number on disk.
//
// A text goes through these nets, in this order:
//   1. by key, with the structure of the file (JSON, TOML, YAML): every string under a key whose
//      name says "secret" is masked, whatever it looks like and however short it is. That covers
//      what a line cannot show: a nested object, a string with escaped quotes, a string that
//      spans lines, a table header.
//   2. by key, without structure: the same rule for `"key": "value"` and `KEY=value` wherever
//      they are written (a command, a script, a comment, a paragraph), and for a value written
//      apart from its name (`--api-key VALUE`, `"--api-key", "VALUE"`). It is all that can be
//      done for a text whose format is unknown, and it never masks what (1) decided to keep.
//   2b. by noun, in running text: the value a sentence gives a secret noun, in English or
//      Portuguese (`the password is v`, `a senha é v`, `use secret v`, `chave v`), when it reads
//      like a value (see maskSentences). It does not ask the format either: a comment, a note and
//      an instruction file are read alike, and the barrier of a run (no hint) sees what a snapshot does.
//   3. by shape: the scanner's fixed-prefix tokens, the credential shapes below and private key
//      blocks, line by line.
// Two rules hold through all three. A name is judged as it reads, not as it is spelled (an
// escaped character, an invisible one, a letter of another alphabet). And a value stays
// readable only when all of it can be shown to carry no literal of its own: when in doubt it
// is masked.
// The output is a fixed point: masking it again changes nothing, with or without the `lang`
// hint. lib/run/secrets.mjs relies on that to tell masked text from text copied off the disk.
// So no rule may mask, when the format is not given, what the same rule leaves readable when it
// is: a hint can only add (the two rules for files of prose are the ones that do).
//
// What is still not masked, because no rule here can tell it from a sentence:
//   - in running text, a value that does not read like one: a word of letters only after any noun
//     but a password (`the token is swordfish`); after a password noun, the same word joined by
//     `:`, `=`, a qualifier or nothing (`password: swordfish` is masked only with the markdown or
//     text hint, and only alone on its line), or one of PROSE_WORDS or with one of PROSE_ENDING
//     (`the password is protected`); a value of fewer than six characters (`the token is ab12c`);
//     a number of fewer than six digits (four after the verb of a password; `pin` takes 4 to 12);
//   - a value that is not the word right after the noun or its verb (`the password, which is v`,
//     `v is the password`), a value on another line than its noun, a value in a table cell, a pass
//     phrase without quotes, and a quoted word with no digit right after a noun other than a
//     password (`the token "abcdefgh"`: there it is as often the name of a field);
//   - a value shaped like a name: a variable in upper case with an underscore (`ABC_123`), a member
//     (`a.b`), a path, a file, a version, an amount with its unit, an e-mail address, and the
//     algorithm and product names of NAMES_SOMETHING (`sha256`, `1password`);
//   - in running text, a noun spelled with an escape or a lookalike letter (the key nets read
//     names that way; the sentence net reads nouns as written), and the word `password` given as
//     its own value.
import path from 'node:path';
import { PATTERNS, mask } from '../../secret-scan.mjs';
import { IS_WIN, home, realpathSafe } from '../common.mjs';

// A name holds a secret when one of these words is anywhere in it (`clientSecret`, `DB_PASSWORD_2`) ...
const ANYWHERE = '(?:secret|password|passwd|passphrase|credentials?)';
// ... or when it ends in one of these (`access_token`, `X-Api-Key`). Ending only: `tokens`,
// `max_tokens`, `tokenizer` and `apiKeyHelper` are settings, not secrets.
const AT_END = '(?:token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|authorization|bearer)';
const NAME = `(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9_.-]*${ANYWHERE}[A-Za-z0-9_.-]*|[A-Za-z0-9_.-]*${AT_END})`;
const ENV_NAME = `(?<![A-Za-z0-9_])(?:[A-Za-z0-9_]*${ANYWHERE.toUpperCase()}[A-Za-z0-9_]*|[A-Za-z0-9_]*(?:TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY))`;

/**
 * Credential shapes that config files carry but secret-scan.mjs has no fixed-prefix pattern for:
 * header values, URL passwords, query-string keys and assignments to a name that says "secret".
 * Only the group `v` is the secret; a group `k`, when there is one, is the name it is assigned
 * to. They run after the scanner's own patterns.
 */
export const EXTRA_PATTERNS = [
  { id: 'authorization-value', re: /\bauthorization["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic|Token)\s+)?(?<v>[^\s"',;\\]{8,})/gi },
  { id: 'bearer-token', re: /\bBearer\s+(?<v>[A-Za-z0-9._~+/=-]{16,})/g },
  { id: 'url-password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'<>\\]*:(?<v>[^\s@/"'<>\\]{3,})@/gi },
  { id: 'query-secret', re: /[?&](?:api[_-]?key|apikey|key|token|access_token|auth|secret|signature|sig|password|pwd)=(?<v>[^&\s"'<>#\\]{8,})/gi },
  // "clientSecret": "value", api_key = 'value': a quoted value of any shape.
  { id: 'sensitive-key-quoted', re: new RegExp(`["']?(?<k>${NAME})["']?\\s*[:=]\\s*(?<q>["'])(?<v>[^"'\\n]{8,})\\k<q>`, 'gi') },
  // DB_PASSWORD=value, GITHUB_TOKEN: value: upper-case names, the way environment variables are written.
  { id: 'env-assignment', re: new RegExp(`(?<k>${ENV_NAME})["']?\\s*[:=]\\s*["']?(?<v>[^\\s"',;\\\\]{8,})`, 'g') },
];

// ---------------------------------------------------------------------------------------------
// Which names hold a secret
// ---------------------------------------------------------------------------------------------

// The last word of a name, when it is one of these, says the name describes a secret instead of
// holding one: `secret-scan`, `password_min_length`, `tokenUrl`, `credentialsFile`,
// `bearer_token_env_var`, `apiKeyHelper`. The last row is products and kinds of thing that are
// named after what they keep.
const DESCRIPTORS = new Set([
  'scan', 'scans', 'scanner', 'scanning', 'check', 'checker', 'detect', 'detector', 'lint', 'mask', 'masked', 'redact', 'redacted',
  'policy', 'policies', 'rule', 'rules', 'pattern', 'patterns', 'regex', 'length', 'len', 'min', 'max', 'count', 'limit', 'limits',
  'budget', 'size', 'bytes', 'chars', 'ttl', 'expiry', 'expires', 'expiration', 'lifetime', 'rotation', 'interval', 'timeout',
  'hint', 'prompt', 'label', 'title', 'description', 'placeholder', 'message', 'error', 'status', 'state', 'strength',
  'name', 'names', 'field', 'fields', 'url', 'uri', 'endpoint', 'host', 'path', 'paths', 'file', 'files', 'filename', 'dir',
  'directory', 'folder', 'location', 'env', 'var', 'variable', 'type', 'kind', 'mode', 'format', 'version', 'algorithm', 'alg', 'scheme',
  'enabled', 'disabled', 'required', 'optional', 'exists', 'present', 'configured', 'valid',
  'helper', 'command', 'cmd', 'script', 'provider', 'manager', 'store', 'vault', 'source', 'backend', 'ref', 'reference',
  'server', 'servers', 'plugin', 'cli', 'tool', 'tools', 'stdin', '1password', 'onepassword',
]);
const END_WORD = /(?:secrets?|passwords?|passwd|passphrase|credentials?|token|api_?keys?|private_?keys?|access_?keys?|secret_?keys?|authorization|bearer|senhas?|segredos?)(?:_?\d+)?$/;
// `tokens` alone counts things (`max_tokens`); behind one of these words it is a list of credentials.
const TOKEN_LIST = /(?:^|_)(?:access|refresh|auth|api|bearer|session|oauth|personal|bot|deploy|registry)_?tokens$/;
// The same words in Portuguese and Spanish, where a harness is written in one of them.
const ANY_WORD = /secret|password|passwd|passphrase|credential|senha|segredo|credencia|contrasena/;
// `chave_api`, `chave_de_acesso`, `chave_secreta`, and `pwd` when it is part of a longer name
// (`DB_PWD`; alone it is as often the working directory).
const LONGER_NAME = /(?:^|_)chave_(?:de_)?(?:api|acesso|secreta|privada)(?:_?\d+)?$|_pwd(?:_?\d+)?$/;
// The session key of a password manager, the way its environment variable is written
// (`BW_SESSION`, `OP_SESSION_account`). Upper case only: `tokensPerSession` counts things.
const ENV_SESSION = /^(?:[A-Z][A-Z0-9]*_)+SESSION$|^OP_SESSION_\w+$/;
const KEY_MEMO = new Map();

// A name is classified by what it says once it is read, not by how it is spelled in the file:
// `"pass\u0077ord"` is `password` to every parser, and `password` with a zero-width space in
// the middle, or with a Cyrillic letter for its `a`, is `password` to every reader. So an
// escaped character is decoded, what does not show is dropped, compatibility forms and accents
// are folded, and letters of other alphabets that are drawn like Latin ones are read as those.
// Every non-ASCII character below is written as an escape, so the source shows what it holds.
const ESCAPED_CHAR = /\\+(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|x([0-9a-fA-F]{2}))/g;
// One level of backslash escapes, the way a parser reads them: the numbered ones above, an
// octal one (`\167`), the short ones that stand for a character that does not show (`\t`, `\n`)
// and a backslash in front of the character itself (`\/`, `\"`, `\\`).
const ANY_ESCAPE = /\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|x([0-9a-fA-F]{2})|([0-7]{1,3})|([\s\S]))/g;
// `%77`: a character of a name in a query string.
const PERCENT_CHAR = /%([0-9a-fA-F]{2})/g;
const UNSEEN = /[\p{M}\p{Cf}\p{Cc}\u115F\u1160\u2800\u3164\uFFA0]/gu;
const LOOKALIKE = new Map();
{
  // Cyrillic, then Greek: each letter next to the Latin one it passes for.
  const from = '\u0430\u0441\u0501\u0435\u04BB\u0456\u0458\u043A\u04CF\u043E\u0440\u0455\u0445\u0443\u0410\u0412\u0421\u0415\u041D\u0406\u0408\u041A\u041C\u041E\u0420\u0405\u0422\u0425\u0423'
    + '\u03B1\u03B5\u03B9\u03BA\u03BD\u03BF\u03C1\u03C4\u03C5\u03C7\u0391\u0392\u0395\u0397\u0399\u039A\u039C\u039D\u039F\u03A1\u03A4\u03A5\u03A7\u0396';
  const to = 'acdehijklopsxyABCEHIJKMOPSTXY' + 'aeikvoptuxABEHIKMNOPTYXZ';
  [...from].forEach((ch, i) => LOOKALIKE.set(ch, to[i]));
}
const LOOKALIKE_RE = new RegExp(`[${[...LOOKALIKE.keys()].join('')}]`, 'g');

const fromCode = (hex, base, kept) => { const code = parseInt(hex, base); return code <= 0x10ffff ? String.fromCodePoint(code) : kept; };
/** Invisible characters and accents gone, compatibility forms folded, lookalike letters as Latin. */
const folded = (s) => (/[^\x20-\x7e]/.test(s) ? s.normalize('NFKD').replace(UNSEEN, '').replace(LOOKALIKE_RE, (ch) => LOOKALIKE.get(ch)) : s);
/** `s` with one level of backslash escapes read (see ANY_ESCAPE). */
const unescaped = (s) => s.replace(ANY_ESCAPE, (m, a, b, c, d, octal, ch) => {
  if (octal) return fromCode(octal, 8, m);
  if (ch !== undefined) return /[abefnrtv]/.test(ch) ? '\t' : ch;
  return fromCode(a || b || c || d, 16, m);
});

/**
 * The ways a name can read. First with its numbered escapes decoded wherever they stand, however
 * many backslashes are in front (a name kept inside a string is escaped once more). Then, when
 * it has other backslashes, with every escape read as a parser reads it, once for each level of
 * quoting; and, when it has a `%`, percent-decoded.
 */
function readings(raw) {
  if (!raw.includes('\\') && !raw.includes('%')) return [folded(raw)];
  const out = [folded(raw.replace(ESCAPED_CHAR, (m, a, b, c, d) => fromCode(a || b || c || d, 16, m)))];
  let s = raw;
  for (let level = 0; level < 3 && s.includes('\\'); level++) {
    s = unescaped(s);
    out.push(folded(s));
  }
  if (raw.includes('%')) out.push(folded(raw.replace(PERCENT_CHAR, (m, hex) => fromCode(hex, 16, m))));
  return out;
}

/** The words of a name in any spelling: `X-Api-Key`, `clientSecret`, `DB_PASSWORD_2`. */
function keyWords(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function saysSecret(name) {
  if (ENV_SESSION.test(name)) return true;
  const words = keyWords(name);
  if (!words.length || words.length > 16 || DESCRIPTORS.has(words[words.length - 1])) return false;
  // With its separators, and without them: `pass_word`, `passWord` and `pass-word` are `password`.
  const norm = words.join('_');
  const flat = words.join('');
  return END_WORD.test(norm) || END_WORD.test(flat) || TOKEN_LIST.test(norm) || ANY_WORD.test(flat) || LONGER_NAME.test(norm);
}

/** True when the name, in one of the ways it can read, says it holds a secret. */
const holdsSecret = (raw) => raw.length <= 256 && readings(raw).some(saysSecret);

/**
 * True when a key, variable or flag of this name holds a secret: the name ends in one of the
 * secret words (`password`, `client_secret`, `access_token`, `X-Api-Key`) or has `secret`,
 * `password` or `credential` anywhere in it, unless its last word says it only describes one.
 * The name is taken as written in the file (escapes included) and judged as it reads.
 */
export function isSensitiveKey(name) {
  const key = String(name);
  let known = KEY_MEMO.get(key);
  if (known === undefined) {
    known = holdsSecret(key);
    if (KEY_MEMO.size >= 4096) KEY_MEMO.clear();
    KEY_MEMO.set(key, known);
  }
  return known;
}

// ---------------------------------------------------------------------------------------------
// References: a value that names a secret instead of being one
// ---------------------------------------------------------------------------------------------

// A value is left readable only when ALL of it is a reference, in a syntax that really expands.
// `${VAR}` followed by anything, `$VAR` and then more text, a default that is a literal: each of
// those carries a literal part, and a literal part under a secret name is masked with the rest.
// The rule does not depend on the language of the file: what one pass leaves readable, every
// other pass must leave readable too (see the note on fixed points at the top).
const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
// `$NAME` only when it is written the way environment variables are (`$GITHUB_TOKEN`, `$env:ApiKey`):
// a password that happens to start with `$` (`$ecret123`) must not pass for a variable.
const VAR_ENV = /^\$(?:env:[A-Za-z_][A-Za-z0-9_]*|[A-Z_][A-Z0-9_]*)(?![A-Za-z0-9_])/;
// `$1`, `$@`, `$*`: the arguments of a script.
const POSITIONAL = /^\$[0-9@*](?![A-Za-z0-9_])/;
// An expression that only names things, and so carries no value of its own: a name, a member
// (`secrets.X`, `steps.build.outputs.token`, `.Values.key`), an index by number, a call whose
// arguments are names (`getToken()`, `decode(key)`), and several of those joined by `||`, `??`
// or `&&`. A quoted string or a number in it is a literal, and the expression is none of these.
const NAMED = '[.$]?[A-Za-z_][\\w$-]*(?:\\??\\.[A-Za-z_][\\w$-]*|\\[\\d+\\])*';
const NAMING = `${NAMED}(?:\\(\\s*(?:${NAMED}(?:\\s*,\\s*${NAMED})*)?\\s*\\))?`;
const PURE_EXPRESSION = `\\s*${NAMING}(?:\\s*(?:\\|\\||\\?\\?|&&)\\s*${NAMING})*\\s*`;
// `{{ secrets.X }}`, `${{ secrets.X }}`: a template expression, whole.
const DOUBLE_BRACE = new RegExp(`^\\$?\\{\\{-?${PURE_EXPRESSION}-?\\}\\}`);
// The name inside `${...}`: `VAR`, `config.token`, `env:VAR`, `#VAR`. A colon belongs to the name
// only after one of these words; anywhere else it starts a default (`${prop:default}`).
const BRACED_NAME = new RegExp(`^[#!]?(?:(?:env|localEnv|containerEnv|input|config):)?${IDENT}(?:\\.${IDENT})*`);
// A placeholder of a JavaScript template literal: the same kind of expression.
const JS_PLACEHOLDER = new RegExp(`^\\$\\{${PURE_EXPRESSION}\\}`);
// Whole values that stand for "put it here": `%VAR%`, `<your token>`, `***`, `xxxx`, `...`, and
// the slot of a format string (`%s`, `{}`, `{0}`).
const PLACEHOLDER = /^(?:%[A-Za-z_][A-Za-z0-9_]*%|<\p{L}[\p{L}\p{N} _.:-]{0,60}>|\*+|x+|\.{2,}|%[sdvq]|\{\d?\})$/iu;
// Code that reads the environment, as it stands unquoted in a script. The shape patterns capture
// a value up to the first quote, so the form cut at its bracket (`os.environ[`) is one too.
const NAME_ARG = `["']${IDENT}["']`;
const CODE_READER = new RegExp(`^(?:${[
  `process\\.env(?:\\.${IDENT}|\\[(?:${NAME_ARG}\\])?)`,
  `import\\.meta\\.env\\.${IDENT}`,
  `Bun\\.env\\.${IDENT}`,
  `Deno\\.env\\.get\\((?:${NAME_ARG}\\))?`,
  `os\\.environ(?:\\[(?:${NAME_ARG}\\])?|\\.get\\((?:${NAME_ARG}\\))?)`,
  `os\\.getenv\\((?:${NAME_ARG}\\))?`,
  `getenv\\((?:${NAME_ARG}\\))?`,
  `System\\.getenv\\((?:${NAME_ARG}\\))?`,
  `ENV(?:\\[(?:${NAME_ARG}\\])?|\\.fetch\\((?:${NAME_ARG}\\))?)`,
].join('|')})$`);
const REFERENCE_MAX = 512;

/**
 * True when `s` can be the message of a `${VAR:?message}`: a sentence about the variable, made
 * of words of letters and of names in upper case, with nothing that could be a value written
 * where a message goes.
 */
const isMessage = (s) => /^(?:(?:\p{L}+|[A-Z][A-Z0-9_]*)(?:[ .,:;!?'-]+|$))*$/u.test(s);

/** Index after the `${...}` that starts at `i`, when all of it is a reference; else -1. */
function bracedEnd(v, i, ctx) {
  let j = i + 2;
  const name = BRACED_NAME.exec(v.slice(j, j + 200));
  if (!name) return -1;
  j += name[0].length;
  if (v[j] === '}') return j + 1;
  const op = /^(?::?[-=+?]|:)/.exec(v.slice(j, j + 2));
  if (!op) return -1;
  j += op[0].length;
  if (op[0].endsWith('?')) {
    // `${VAR:?message}`: the message is printed when VAR is missing; it never becomes the value.
    const end = v.indexOf('}', j);
    return end === -1 || !isMessage(v.slice(j, end)) ? -1 : end + 1;
  }
  // What follows `:-`, `-`, `:=`, `=`, `:+`, `+` or a bare `:` can become the value: it has to be
  // empty (`""` and `''` included) or made of references itself.
  if ((v[j] === '"' || v[j] === "'") && v[j + 1] === v[j]) j += 2;
  else j = referencesEnd(v, j, ctx);
  return v[j] === '}' ? j + 1 : -1;
}

// Every exemption in this section leaves a text readable because it names a value. So nothing
// in such a text may read like a value itself: a run of letters and digits that is long and
// mixed (`aB3xK9mQ2pL7`), a long number, or any run too long for a word is a credential wherever
// it stands: in the name of a variable, in an argument of a command, in the name asked of the
// environment.
function valueLike(run) {
  if (run.length >= 32) return true;
  if (run.length < 10) return false;
  const digits = run.replace(/\D/g, '').length;
  return digits === run.length ? digits >= 16 : digits >= 3 && run.length - digits >= 3;
}
const carriesValue = (text) => (text.match(/[A-Za-z0-9]+/g) || []).some(valueLike);

// A command substitution. Knowing that a command fetches a value says nothing about its
// arguments (`bw get password item --session KEY` carries a key, `bw unlock PASSWORD` a
// password), so a `$(...)` is a reference only when the whole command is one of the forms
// written down here, argument by argument: the words of the form in order, and for each flag it
// may carry whether that flag takes nothing (null), a name, or one of a set of words. A command
// in any other shape is masked: another subcommand, a flag the form does not list, a quoted or
// escaped argument, a glob, a redirection, an argument that reads like a value.
const ITEM = Symbol('name'); // a path, a URI, the name of an item or of a field: see argName
const OP_URI = Symbol('op uri'); // `op://vault/item/field`
const JQ_PATH = Symbol('jq path'); // `.`, `.token`, `.data.token`
const oneOf = (...words) => new Set(words);
const OUTPUT = oneOf('text', 'json', 'tsv', 'yaml', 'table', 'none');
const AWS_FLAGS = { '--query': ITEM, '--output': OUTPUT, '--region': ITEM, '--profile': ITEM };
const AZ_FLAGS = { '--query': ITEM, '--output': OUTPUT, '-o': OUTPUT, '--subscription': ITEM };
const KEYCHAIN_FLAGS = { '-s': ITEM, '-a': ITEM, '-l': ITEM, '-w': null };
const GET_CONTENT = [
  { ci: true, words: [ITEM], flags: { '-raw': null } },
  { ci: true, words: [], flags: { '-path': ITEM, '-literalpath': ITEM, '-raw': null }, any: ['-path', '-literalpath'] },
];
// `any` lists the flags of which the form needs at least one. `ci` is a PowerShell command:
// its words and flags are matched without regard to case.
const COMMAND_FORMS = {
  cat: [{ words: [ITEM] }],
  type: [{ words: [ITEM] }],
  'get-content': GET_CONTENT,
  gc: GET_CONTENT,
  'get-secret': [
    { ci: true, words: [ITEM], flags: { '-asplaintext': null, '-vault': ITEM } },
    { ci: true, words: [], flags: { '-name': ITEM, '-asplaintext': null, '-vault': ITEM }, any: ['-name'] },
  ],
  op: [
    { words: ['read', OP_URI], flags: { '--account': ITEM, '-n': null, '--no-newline': null } },
    { words: ['item', 'get', ITEM], flags: { '--fields': ITEM, '--vault': ITEM, '--account': ITEM, '--reveal': null }, any: ['--fields'] },
  ],
  pass: [{ words: ['show', ITEM] }, { words: [ITEM] }],
  gopass: [{ words: ['show', ITEM], flags: { '-o': null } }],
  bw: [{ words: ['get', oneOf('password', 'username', 'uri', 'totp', 'notes', 'item'), ITEM], flags: { '--raw': null, '--nointeraction': null } }],
  vault: [
    { words: ['kv', 'get', ITEM], flags: { '-field': ITEM, '--field': ITEM, '-mount': ITEM, '--mount': ITEM }, any: ['-field', '--field'] },
    { words: ['read', ITEM], flags: { '-field': ITEM, '--field': ITEM }, any: ['-field', '--field'] },
  ],
  doppler: [{ words: ['secrets', 'get', ITEM], flags: { '--plain': null, '--project': ITEM, '--config': ITEM }, any: ['--plain'] }],
  aws: [
    { words: ['secretsmanager', 'get-secret-value'], flags: { '--secret-id': ITEM, '--version-stage': ITEM, ...AWS_FLAGS }, any: ['--secret-id'] },
    { words: ['ssm', 'get-parameter'], flags: { '--name': ITEM, '--with-decryption': null, ...AWS_FLAGS }, any: ['--name'] },
    { words: ['ecr', 'get-login-password'], flags: { '--region': ITEM, '--profile': ITEM } },
  ],
  gcloud: [
    { words: ['secrets', 'versions', 'access', ITEM], flags: { '--secret': ITEM, '--project': ITEM }, any: ['--secret'] },
    { words: ['auth', 'print-access-token'] },
    { words: ['auth', 'print-identity-token'] },
  ],
  az: [
    { words: ['keyvault', 'secret', 'show'], flags: { '--vault-name': ITEM, '--name': ITEM, '-n': ITEM, '--id': ITEM, ...AZ_FLAGS }, any: ['--name', '-n', '--id'] },
    { words: ['account', 'get-access-token'], flags: { '--resource': ITEM, ...AZ_FLAGS } },
  ],
  gh: [{ words: ['auth', 'token'], flags: { '--hostname': ITEM, '-h': ITEM } }],
  security: [
    { words: ['find-generic-password'], flags: KEYCHAIN_FLAGS, any: ['-w'] },
    { words: ['find-internet-password'], flags: KEYCHAIN_FLAGS, any: ['-w'] },
  ],
  'secret-tool': [{ words: ['lookup', ITEM, ITEM] }, { words: ['lookup', ITEM, ITEM, ITEM, ITEM] }],
  keyring: [{ words: ['get', ITEM, ITEM] }],
  sops: [{ words: [ITEM], flags: { '-d': null, '--decrypt': null }, any: ['-d', '--decrypt'] }, { words: ['decrypt', ITEM] }],
  jq: [{ words: [JQ_PATH, ITEM], flags: { '-r': null, '--raw-output': null } }],
};
// What the output of such a command may be piped through: a filter that only cuts it, written
// with no argument that is a text of its own.
const FILTER_FORMS = [
  /^head(?: -n ?\d{1,4}| -c ?\d{1,6}| -\d{1,4})?$/,
  /^tail(?: -n ?\d{1,4}| -c ?\d{1,6}| -\d{1,4})?$/,
  /^cut(?: -d ?[:=,.@/_-])? -f ?\d{1,3}(?:[,-]\d{1,3})*$/,
  /^base64 (?:-d|-D|--decode)$/,
  /^jq(?: -r| -j| -e| --raw-output)* \.(?:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?$/,
  /^grep(?: -[iEow])* [A-Za-z_][A-Za-z0-9_.=-]{0,60}$/,
];
const JQ_PATH_RE = /^\.(?:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?$/;
const SAFE_ARGUMENT = /^[A-Za-z0-9._/:@~+,%=-]+$/;

/**
 * True when `tok` is an argument that names something: a path, a URI, an item, a field. It is
 * made of safe characters (no quote, no escape, no glob, no space), a reference may stand in it
 * (`$HOME/.token`, `${XDG_CONFIG_HOME}/app/key`), and nothing in it reads like a value.
 */
function argName(tok) {
  if (!tok || tok.length > 200 || tok[0] === '-') return false;
  let written = '';
  for (let i = 0; i < tok.length;) {
    const end = tok[i] === '$' ? referenceEnd(tok, i, { template: false }) : -1;
    if (end !== -1) { written += '/'; i = end; } else written += tok[i++];
  }
  return SAFE_ARGUMENT.test(written) && !carriesValue(written);
}

/** True when the token `tok` is what the slot of a form asks for. */
function fits(slot, tok, ci) {
  if (typeof slot === 'string') return (ci ? tok.toLowerCase() : tok) === slot;
  if (slot instanceof Set) return slot.has(tok);
  if (slot === JQ_PATH) return JQ_PATH_RE.test(tok) && !carriesValue(tok);
  if (slot === OP_URI) return tok.startsWith('op://') && argName(tok);
  return argName(tok);
}

/** True when the tokens after a command are that form: its words in order, its flags anywhere. */
function matchesForm(form, tokens) {
  const flags = form.flags || {};
  const seen = new Set();
  let w = 0;
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.length > 1 && tok[0] === '-') {
      const eq = tok.indexOf('=');
      const written = eq === -1 ? tok : tok.slice(0, eq);
      const flag = form.ci ? written.toLowerCase() : written;
      if (!Object.hasOwn(flags, flag)) {
        // A flag the form does not list (`--session`, `--token`, `--password` among them) may
        // stand in it only when what it is given is a reference and nothing else: then the
        // command still holds no text of its own.
        const value = eq !== -1 ? tok.slice(eq + 1) : tokens[++t];
        if (!/^--?[A-Za-z][A-Za-z-]*$/.test(written) || !value || referencesEnd(value, 0, { template: false }) !== value.length) return false;
        continue;
      }
      seen.add(flag);
      if (flags[flag] === null) { if (eq !== -1) return false; continue; }
      const value = eq !== -1 ? tok.slice(eq + 1) : tokens[++t];
      if (value === undefined || !fits(flags[flag], value, form.ci)) return false;
      continue;
    }
    if (w >= form.words.length || !fits(form.words[w++], tok, form.ci)) return false;
  }
  return w === form.words.length && (!form.any || form.any.some((f) => seen.has(f)));
}

/** True when the body of a `$(...)` is a verified form of a command that fetches a value. */
function fetches(body) {
  const b = body.trim();
  if (!b || b.length > 400) return false;
  // A subexpression around a reference: `$($env:TOKEN)`.
  if (referencesEnd(b, 0, { template: false }) === b.length) return true;
  return b.split('|').every((part, n) => {
    // The one redirection that changes nothing: errors thrown away.
    const stage = part.trim().replace(/\s+2>\s?\/dev\/null$/, '').replace(/\s+/g, ' ');
    if (!stage || carriesValue(stage)) return false;
    if (n > 0) return FILTER_FORMS.some((re) => re.test(stage));
    const tokens = stage.split(' ');
    if (tokens[0] === 'sudo') tokens.shift();
    // `$(< file)`
    if (tokens[0] === '<' && tokens.length === 2) return argName(tokens[1]);
    if (tokens.length === 1 && tokens[0].length > 1 && tokens[0][0] === '<') return argName(tokens[0].slice(1));
    const command = (tokens.shift() || '').toLowerCase().replace(/\.exe$/, '');
    return Object.hasOwn(COMMAND_FORMS, command) && COMMAND_FORMS[command].some((form) => matchesForm(form, tokens));
  });
}

/**
 * Index after the one reference that starts at `i`, or -1 when there is none there. A reference
 * whose own text reads like a value is none: `${aB3xK9mQ2pL7}` is that value in braces.
 */
function referenceEnd(v, i, ctx) {
  const end = referenceShapeEnd(v, i, ctx);
  return end !== -1 && carriesValue(v.slice(i, end)) ? -1 : end;
}

function referenceShapeEnd(v, i, ctx) {
  if (v[i] === '`' && !ctx.template) {
    // Backticks inside another string (`"`cat file`"`): judged like a value written between them.
    const close = v.indexOf('`', i + 1);
    return close !== -1 && isReference(v.slice(i + 1, close), true) ? close + 1 : -1;
  }
  if (v[i] !== '$' && v[i] !== '{') return -1;
  const rest = v.slice(i, i + REFERENCE_MAX);
  let m = ctx.template ? null : DOUBLE_BRACE.exec(rest);
  if (m) return i + m[0].length;
  if (v[i] !== '$') return -1;
  if (v[i + 1] === '{') {
    if (!ctx.template) return bracedEnd(v, i, ctx);
    m = JS_PLACEHOLDER.exec(rest);
    return m ? i + m[0].length : -1;
  }
  if (ctx.template) return -1; // in a template literal only `${...}` expands
  if (v[i + 1] === '(') {
    // `$(command ...)`, up to the parenthesis that closes it, when the command fetches a value.
    let depth = 0;
    for (let j = i + 1; j < v.length; j++) {
      if (v[j] === '(') depth++;
      else if (v[j] === ')' && --depth === 0) return fetches(v.slice(i + 2, j)) ? j + 1 : -1;
    }
    return -1;
  }
  m = VAR_ENV.exec(rest) || POSITIONAL.exec(rest);
  return m ? i + m[0].length : -1;
}

/** Index after the run of references that starts at `i` (`i` itself when it starts with none). */
function referencesEnd(v, i, ctx) {
  for (;;) {
    const next = referenceEnd(v, i, ctx);
    if (next === -1) return i;
    i = next;
  }
}

/**
 * True when `v`, all of it, names a secret instead of being one:
 *   `${VAR}`, `${config.token}`, `${env:VAR}`; `${VAR:-default}` and its kin only when the default
 *   is empty or a reference itself; `${VAR:?message}`
 *   `$(command ...)`, whole, when the command is a verified form of one that fetches the value
 *   (see COMMAND_FORMS)
 *   `$VAR` in upper case, `$env:Name`, and the arguments `$1`, `$@`, `$*`
 *   `{{ expression }}` and `${{ expression }}`, when the expression only names things
 *   `%VAR%`, `<placeholder>`, `***`, `xxx`, `...`
 *   unquoted code that reads the environment: `process.env.X`, `os.environ["X"]`, `ENV["X"]`...
 *   several of the `$` forms in a row with nothing between them (`${A}${B}`)
 * `backticks` says the value is written between backticks. That is a template literal in
 * JavaScript (only `${expression}` expands, and the expression has to be one that only names
 * things) and a command substitution in a shell (a reference when the command fetches the
 * value). The language is not asked: a value that is a reference in either reading is one, so
 * the answer is the same with and without knowing the file.
 */
function isReference(v, backticks = false) {
  if (!v || v.length > REFERENCE_MAX) return false;
  if ((PLACEHOLDER.test(v) || CODE_READER.test(v)) && !carriesValue(v)) return true;
  if (referencesEnd(v, 0, { template: false }) === v.length) return true;
  return backticks && (referencesEnd(v, 0, { template: true }) === v.length || fetches(v));
}

/** The index of the bracket that closes the `(` or `{` at `open`, before `stop`; -1 when nothing does. */
function bracketEnd(text, open, stop) {
  const [left, right] = text[open] === '(' ? ['(', ')'] : ['{', '}'];
  let depth = 0;
  for (let e = open; e < stop; e++) {
    if (text[e] === left) depth++;
    else if (text[e] === right && --depth === 0) return e;
  }
  return -1;
}

/**
 * The unquoted value that starts at `i`: it runs to the next space, quote, comma or semicolon,
 * except that a `$(command ...)`, a `${...}` and a `{{ expression }}` in it count whole, spaces
 * included, whether they are references or not (`$(printf text)` is one word, and all of it is
 * the value). Returns where it ends and whether all of it is a reference (a full stop or a
 * closing bracket right after one belongs to the sentence around it).
 */
function bareValue(text, i) {
  const line = text.slice(i, Math.min(lineEnd(text, i), i + 4096));
  let j = 0;
  while (j < line.length) {
    const c = line[j];
    const open = c === '$' && (line[j + 1] === '(' || line[j + 1] === '{') ? j + 1 : (c === '{' && line[j + 1] === '{' ? j : -1);
    if (open !== -1) {
      // To the bracket that closes this one; left as it is when nothing does.
      const e = bracketEnd(line, open, line.length);
      if (e !== -1) { j = e + 1; continue; }
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '"' || c === "'" || c === '`' || c === ',' || c === ';' || c === '\\') break;
    j++;
  }
  const head = referencesEnd(line.slice(0, REFERENCE_MAX), 0, { template: false });
  return { end: i + j, reference: head > 0 && head <= j && line.slice(head, j).replace(/[.)\]]+$/, '') === '' };
}

/**
 * The value of a query string pair that starts at `i`: to the next `&`, space, quote, `<`, `>`,
 * `#` or backslash. A comma or a semicolon inside it belongs to it; punctuation at its end is
 * the sentence's. Same answer as bareValue.
 */
function queryValue(text, i) {
  const run = /^[^&\s"'<>#\\]*/.exec(text.slice(i, i + 4096))[0].replace(/[.,;:!?]+$/, '');
  return { end: i + run.length, reference: run !== '' && referencesEnd(run.slice(0, REFERENCE_MAX), 0, { template: false }) === run.length };
}

// ---------------------------------------------------------------------------------------------
// What a masked value looks like
// ---------------------------------------------------------------------------------------------

// The word in front of a credential in a header value stays readable.
const SCHEME_RE = /^(?:Bearer|Basic|Token|Digest|Negotiate|ApiKey)\s+/i;
// What this module writes (`abcd…40`, `…7`), the same written by hand without the length, and
// several of them in a row (two parts of one word, each masked on its own).
const isMasked = (v) => { const s = v.replace(SCHEME_RE, ''); return /^.{0,4}…\d*$/.test(s) || /^(?:[^…\s]{0,4}…\d+)+$/.test(s); };
const MASKED_HEAD = /^[^\s…]{0,4}…\d+/;
const hidden = (s) => `…${s.length}`;
// What the head of a masked value never shows: a bracket, a quote, a `$`, a backslash or a
// space. Left behind, one of those would open something the rest of the line does not close,
// and the text would read differently the next time it is masked.
const NOT_SHOWN = /[\\${}()[\]"'`\s]/;
/** `mask()` shows four characters: fine for a long token, too much of a short password. */
const maskValue = (v) => {
  if (v.length < 16) return hidden(v);
  const cut = v.slice(0, 4).search(NOT_SHOWN);
  return cut === -1 ? mask(v) : `${v.slice(0, cut)}${hidden(v)}`;
};
// An unquoted value that only switches something on or off is not a secret. A number is: a PIN
// or a numeric password is a credential like any other (`0` and `1` are read as off and on).
const SWITCH_WORD = /^(?:true|false|yes|no|on|off|null|none|nil|undefined|~|0|1)$/i;
// The two workflow keywords that sit under a key named like a secret.
const KEYWORD = { secrets: /^inherit$/i, 'id-token': /^(?:read|write|none)$/i };
/** True when the unquoted value `v` of the key `name` says nothing secret. */
function plainScalar(name, v) {
  const key = String(name).toLowerCase();
  return SWITCH_WORD.test(v) || (Object.hasOwn(KEYWORD, key) && KEYWORD[key].test(v));
}
// A number as it is written in data and code: `12345678`, `-3.5`, `1_000_000`.
const NUMBER_RE = /^[-+]?\d[\d_]*(?:\.\d+)?(?=$|[\s,;)\]}"'\\]|\.(?:\s|$))/;

/** What replaces the value of a secret key, or null when there is nothing to hide in it. */
function secretText(raw, template) {
  const head = (SCHEME_RE.exec(raw) || [''])[0];
  const v = raw.slice(head.length);
  if (!v.trim() || isMasked(v) || isReference(v, template)) return null;
  return head + maskValue(v);
}

/**
 * Mask `text[s, e)`, the value of a secret key on one line. `quote` is the quote it is written
 * in (null for an unquoted value): a backtick makes it a template literal.
 */
function pushValue(st, text, s, e, quote = null) {
  if (e <= s) return;
  const r = secretText(text.slice(s, e), quote === '`');
  if (r !== null) st.spans.push([s, e, r]);
}

/** Mask `text[s, e)`, a value that spans lines: each line keeps its place and shows only its length. */
function pushLines(st, text, s, e) {
  let i = s;
  while (i < e) {
    let nl = text.indexOf('\n', i);
    if (nl === -1 || nl > e) nl = e;
    const end = nl > i && text[nl - 1] === '\r' ? nl - 1 : nl;
    const seg = text.slice(i, end);
    if (seg.trim() && !isMasked(seg.trim())) st.spans.push([i, end, hidden(seg)]);
    i = nl + 1;
  }
}

function applySpans(text, spans) {
  if (!spans.length) return text;
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let pos = 0;
  for (const [s, e, r] of spans) {
    if (s < pos) continue; // inside a value that is already masked as a whole
    out += text.slice(pos, s) + r;
    pos = e;
  }
  return out + text.slice(pos);
}

// ---------------------------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------------------------

const lineEnd = (text, i) => { const k = text.indexOf('\n', i); return k === -1 ? text.length : k; };

/**
 * How deep a quote is nested, from the number of backslashes in front of it: `"` is a quote of the
 * text itself (0), `\"` a quote of a text kept inside a string (1), `\\\"` one level further in
 * (2). An even run is escaped backslashes followed by a quote of the outer text, so `\\"` is 0.
 */
function quoteDepth(backslashes) {
  let n = 0;
  for (let b = backslashes; b & 1; b >>= 1) n++;
  return n;
}

/**
 * The end of the string opened by the quote at `q`, which has `k` backslashes in front of it.
 * Returns [end of the content, index after the closing quote, closed]. A string never runs past
 * its line; one that is not closed there, or whose enclosing string ends first, is `closed: false`.
 * `escapes: false` is a string where a backslash is a plain character (TOML '...').
 */
function stringEnd(text, q, k, escapes = true) {
  const ch = text[q];
  const depth = quoteDepth(k);
  let i = q + 1;
  for (;;) {
    const c = text[i];
    if (c === undefined || c === '\n') {
      const end = c === '\n' && text[i - 1] === '\r' && i - 1 > q ? i - 1 : i;
      return [end, end, false];
    }
    if (c === '\\' && escapes) {
      let b = 1;
      while (text[i + b] === '\\') b++;
      if (text[i + b] !== ch) { i += b; continue; }
      const d = quoteDepth(b);
      if (d > depth) { i += b + 1; continue; } // a quote of a text nested further in: content
      // The last backslashes of the run belong to the quote; the ones before them are content.
      const end = i + b - ((1 << d) - 1);
      return d === depth ? [end, i + b + 1, true] : [end, end, false];
    }
    if (c === ch) return depth === 0 ? [i, i + 1, true] : [i, i, false];
    i++;
  }
}

/** Index of the `"""` or `'''` that closes a multi-line string whose content starts at `from`, or -1. */
function tripleEnd(text, from, delim) {
  let i = from;
  for (;;) {
    i = text.indexOf(delim, i);
    if (i === -1 || delim === "'''") return i;
    let b = 0;
    while (text[i - 1 - b] === '\\') b++;
    if (b % 2 === 0) return i;
    i++;
  }
}

// ---------------------------------------------------------------------------------------------
// Net 1: by key, with the structure of the file
// ---------------------------------------------------------------------------------------------

/**
 * JSON, read leniently (comments, trailing commas, a file cut at the size cap): every value
 * under a secret key, at any depth below it. A string of any shape and a number are masked;
 * `true`, `false` and `null` stay. Keys are never masked.
 */
function jsonSpans(text, st) {
  const frames = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    const top = frames.length ? frames[frames.length - 1] : null;
    if (c === '"') {
      const [end, after, closed] = stringEnd(text, i, 0);
      if (top && top.obj && closed && /^\s*:/.test(text.slice(after, after + 64))) top.secret = isSensitiveKey(text.slice(i + 1, end));
      else if (top && (top.all || top.secret)) pushValue(st, text, i + 1, end, '"');
      i = Math.max(after, i + 1);
    } else if (top && (top.all || top.secret) && !' \t\r\n,:{}[]/'.includes(c)) {
      // A value that is not a string: a number, or a word. One followed by `:` is a key.
      const word = /^[^\s,{}[\]":/]+/.exec(text.slice(i, i + 256))[0];
      if (!plainScalar('', word) && !/^\s*:/.test(text.slice(i + word.length, i + word.length + 64))) pushValue(st, text, i, i + word.length);
      i += word.length;
    } else if (c === '{' || c === '[') {
      frames.push({ obj: c === '{', secret: false, all: !!top && (top.all || top.secret) });
      i++;
    } else if (c === '}' || c === ']') {
      frames.pop();
      i++;
    } else if (c === ',') {
      if (top && top.obj) top.secret = false;
      i++;
    } else if (c === '/' && text[i + 1] === '/') i = lineEnd(text, i);
    else if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; } else i++;
  }
}

/**
 * TOML: every value under a secret key: a string in any of the four forms (basic, literal and
 * their multi-line `"""` / `'''` variants), a number or a date, inside arrays and inline tables
 * too, and every value of a table whose header has a secret segment (`[servers.x.credentials]`).
 * `true` and `false` stay.
 */
function tomlSpans(text, st) {
  const n = text.length;
  const spaces = (j) => { while (text[j] === ' ' || text[j] === '\t') j++; return j; };
  // Spaces, line ends and comments: what may sit between the items of an array.
  const blank = (j) => {
    for (;;) {
      const c = text[j];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') j++;
      else if (c === '#') j = lineEnd(text, j);
      else return j;
    }
  };
  /** Segments of a (dotted) key from `j` up to one of the characters in `stop`. */
  const key = (j, stop) => {
    const segs = [];
    for (;;) {
      j = spaces(j);
      const c = text[j];
      if (c === '"' || c === "'") {
        const [end, after, closed] = stringEnd(text, j, 0, c === '"');
        if (!closed) return null;
        segs.push(text.slice(j + 1, end));
        j = after;
      } else {
        const m = /^[\p{L}\p{N}\p{M}\p{Cf}_-]+/u.exec(text.slice(j, j + 256));
        if (!m) return null;
        segs.push(m[0]);
        j += m[0].length;
      }
      j = spaces(j);
      if (text[j] === '.') { j++; continue; }
      return text[j] !== undefined && stop.includes(text[j]) ? { segs, end: j } : null;
    }
  };
  const secretKey = (segs) => segs.some((s) => isSensitiveKey(s)) || isSensitiveKey(segs.join('.'));
  /** Reads the value at `j`; returns the index after it. */
  const value = (j, secret) => {
    j = spaces(j);
    const three = text.slice(j, j + 3);
    if (three === '"""' || three === "'''") {
      const close = tripleEnd(text, j + 3, three);
      if (secret) pushLines(st, text, j + 3, close === -1 ? n : close);
      return close === -1 ? n : close + 3;
    }
    const c = text[j];
    if (c === '"' || c === "'") {
      const [end, after] = stringEnd(text, j, 0, c === '"');
      if (secret) pushValue(st, text, j + 1, end, c);
      return Math.max(after, j + 1);
    }
    if (c === '[' || c === '{') {
      const close = c === '[' ? ']' : '}';
      j++;
      for (;;) {
        j = blank(j);
        if (j >= n) return n;
        if (text[j] === close) return j + 1;
        if (text[j] === ',') { j++; continue; }
        let next;
        if (c === '[') next = value(j, secret);
        else {
          const k = key(j, '=');
          next = k ? value(k.end + 1, secret || secretKey(k.segs)) : j + 1;
        }
        j = next > j ? next : j + 1;
      }
    }
    const from = j;
    while (j < n && !',]}#\n'.includes(text[j])) j++; // a number, a boolean, a date
    const word = text.slice(from, j).trimEnd();
    if (secret && word && !plainScalar('', word)) pushValue(st, text, from, from + word.length);
    return j;
  };

  let table = false;
  let i = 0;
  while (i < n) {
    const j = spaces(i);
    const c = text[j];
    if (c === undefined) break;
    if (c === '[') {
      const k = key(text[j + 1] === '[' ? j + 2 : j + 1, ']');
      if (k) table = secretKey(k.segs);
      i = lineEnd(text, j) + 1;
      continue;
    }
    const k = c === '#' || c === '\n' || c === '\r' ? null : key(j, '=');
    i = lineEnd(text, k ? Math.max(value(k.end + 1, table || secretKey(k.segs)), k.end + 1) : j) + 1;
  }
}

/**
 * YAML, the forms the keyless net cannot see: an unquoted scalar (`password: hunter2`, a number
 * included), a block scalar (`key: |` followed by indented lines) and a value behind an anchor
 * or a tag (`password: &pw "..."`). Other quoted values and `{ }` / `[ ]` values are the next
 * net's. A mapping nested under a secret key is not followed: in a workflow the key of such a
 * mapping is as often the name of a job.
 */
// A YAML key in front of its colon: double-quoted (escapes included), single-quoted, or plain
// (letters of any alphabet, and what does not show between them). isSensitiveKey reads it.
const YAML_KEY = /^(?<lead>\s*(?:-\s+)*)(?:"(?<dq>(?:[^"\\]|\\.)*)"|'(?<sq>(?:[^']|'')*)'|(?<plain>[\p{L}\p{N}\p{M}\p{Cf}_$][\p{L}\p{N}\p{M}\p{Cf}_.$-]*))\s*:(?:\s+(?<value>.*))?$/u;

function yamlSpans(text, st) {
  const n = text.length;
  let block = -1; // indentation of the secret key whose block scalar is being read, or -1
  let i = 0;
  while (i < n) {
    const nl = lineEnd(text, i);
    const end = nl > i && text[nl - 1] === '\r' ? nl - 1 : nl;
    const line = text.slice(i, end);
    const start = i;
    i = nl + 1;
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (block >= 0) {
      if (indent > block) {
        const seg = line.slice(indent);
        if (!isMasked(seg)) st.spans.push([start + indent, end, hidden(seg)]);
        continue;
      }
      block = -1;
    }
    const m = YAML_KEY.exec(line);
    if (!m) continue;
    const key = m.groups.dq !== undefined ? m.groups.dq : m.groups.sq !== undefined ? m.groups.sq.replace(/''/g, "'") : m.groups.plain;
    if (!isSensitiveKey(key)) continue;
    let v = m.groups.value === undefined ? '' : m.groups.value;
    // An anchor names the value and a tag types it: the value itself comes after them. Only
    // `!secret name` is a reference (the value is kept in another file); `*alias` is one as well.
    for (let lead; (lead = /^(?:&\S+|!(?!secret\s)\S*)\s+/.exec(v)) !== null;) v = v.slice(lead[0].length);
    const at = end - v.length;
    if (/^[|>][0-9+-]*\s*(?:#.*)?$/.test(v)) { block = m.groups.lead.length; continue; }
    if (!v || v[0] === '#' || v[0] === '`') continue;
    // Both name the value; a "name" that reads like a value, or more than a name, is the value.
    if (/^(?:\*|!secret\s+)[A-Za-z0-9_.-]+\s*(?:#.*)?$/.test(v) && !carriesValue(v)) continue;
    if (v[0] === '"' || v[0] === "'") {
      const [stop] = stringEnd(text, at, 0, v[0] === '"');
      pushValue(st, text, at + 1, stop, v[0]);
      continue; // what is stuck to that string, or joined to it, is the next net's
    }
    if (v[0] === '{' || v[0] === '[') { containerSpans(text, at, st); continue; }
    const bare = v.replace(/\s+#.*$/, '').trimEnd();
    if (!bare || plainScalar(key, bare)) continue;
    pushValue(st, text, at, at + bare.length);
  }
}

const STRUCTURE = { json: jsonSpans, toml: tomlSpans, yaml: yamlSpans };

/** A text with no `lang` hint that parses as a JSON object or array. */
function looksLikeJson(text) {
  const first = /\S/.exec(text);
  if (!first || (first[0] !== '{' && first[0] !== '[')) return false;
  try { const v = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); return v !== null && typeof v === 'object'; } catch { return false; }
}

// ---------------------------------------------------------------------------------------------
// Net 2: by key, wherever `key: value` or `KEY=value` is written
// ---------------------------------------------------------------------------------------------

// `DB_PASSWORD`, `$API_KEY`: the way environment variables are written.
const ENV_LIKE = /^\$?[A-Z][A-Z0-9_]*$/;
// A bracket of running text that nothing closes must not take the rest of the file with it,
// and a text full of such brackets is not read again from each of them.
const CONTAINER_MAX = 32 * 1024;
const UNCLOSED_MAX = 16;
// Where `key: 1234` is data or code and not a sentence: a number there is a value like any other.
const DATA_LANGS = new Set(['json', 'toml', 'yaml', 'javascript', 'python', 'powershell', 'shell']);
// A backtick is a quote in every language: a template literal in JavaScript, a command
// substitution in a shell, a span of code in Markdown. What stands between two of them is one
// value, judged whole (see isReference), whatever the file is.
const isQuote = (c) => c === '"' || c === "'" || c === '`';

/**
 * Mask every value between the bracket at `open` and the one that closes it, values of nested
 * brackets included: strings, and numbers where a value stands (after `[`, `,`, `:` or `=`). A
 * string followed by `:` or `=` is a key and stays. The bracket may close on a later line only when
 * it ends its own line, the way data is laid out: `"secrets": {` inside a string of some other
 * language (`'  "secrets": {',`) is followed by that language's quotes, which must not be paired up
 * as values. Returns the index after the closing bracket, or the one after the opening bracket
 * when nothing closes it.
 */
function containerSpans(text, open, st) {
  const found = [];
  const eol = lineEnd(text, open);
  const mayRun = st.unclosed < UNCLOSED_MAX && /^[ \t]*(?:(?:#|\/\/).*)?\r?$/.test(text.slice(open + 1, eol));
  const stop = mayRun ? Math.min(text.length, open + CONTAINER_MAX) : eol;
  const js = st.lang === 'javascript';
  let depth = 0;
  let closed = false;
  let slot = false; // true right after `[`, `{`, `,`, `:` or `=`: where a value can start
  let i = open;
  while (i < stop) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '{' || c === '[') { depth++; i++; slot = true; continue; }
    if (c === '}' || c === ']') { depth--; i++; slot = false; if (depth <= 0) { closed = true; break; } continue; }
    if (c === ',' || c === ':' || c === '=') { slot = true; i++; continue; }
    if (c === '#') {
      if (!js && st.lang !== 'json' && (i === 0 || /\s/.test(text[i - 1]))) i = lineEnd(text, i); else i++;
      continue;
    }
    if (c === '/') {
      if (text[i + 1] === '/') i = lineEnd(text, i);
      else if (text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e === -1 ? stop : e + 2; } else i++;
      continue;
    }
    const wasSlot = slot;
    slot = false;
    if (c !== '"' && c !== "'" && c !== '\\' && c !== '`') {
      // A number where a value stands, with the end of that value right after it.
      const num = wasSlot ? NUMBER_RE.exec(text.slice(i, i + 64)) : null;
      if (num && /^[ \t]*(?:[,\]}\r\n]|#|\/\/|$)/.test(text.slice(i + num[0].length, i + num[0].length + 16)) && !SWITCH_WORD.test(num[0])) {
        found.push([false, i, i + num[0].length, null]);
        i += num[0].length;
        continue;
      }
      const from = i;
      while (i < stop && !' \t\r\n{}[],:=#/"\'\\`'.includes(text[i])) i++; // a bare word
      // A bare word is a name, unless it reads like a value.
      if (wasSlot && carriesValue(text.slice(from, i))) found.push([false, from, i, null]);
      continue;
    }
    if (c !== '\\' && c !== '`' && text[i + 1] === c && text[i + 2] === c) {
      const e = tripleEnd(text, i + 3, c + c + c);
      found.push([true, i + 3, e === -1 ? text.length : e, c]);
      i = e === -1 ? text.length : e + 3;
      continue;
    }
    let k = 0;
    while (text[i + k] === '\\') k++;
    const q = text[i + k];
    if (isQuote(q)) {
      const [end, after, ok] = stringEnd(text, i + k, k, !(st.lang === 'toml' && q === "'"));
      const isKey = ok && /^[ \t]*(?:=>|:|=)/.test(text.slice(after, after + 16));
      if (!isKey) found.push([false, i + k + 1, end, q]);
      i = Math.max(after, i + k + 1);
      continue;
    }
    i += k || 1;
  }
  // A bracket nothing closes is running text, not data: what follows it is read as usual.
  if (!closed) {
    if (mayRun) st.unclosed++;
    return open + 1;
  }
  for (const [lines, s, e, quote] of found) {
    if (lines) pushLines(st, text, s, e);
    else pushValue(st, text, s, e, quote);
  }
  return i;
}

// `X-Api-Key`, `Private-Token`, `Authorization`: the way a header is named.
const HEADER_LIKE = /^(?:[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+|authorization)$/i;
// What is stuck to a closing quote and is still part of the same shell word: everything up to the
// next space, quote, bracket or shell operator. Not a run that starts with a dot (`"x".trim()`, the
// end of a sentence), with an operator of a programming language (`"a"+b`, `"a"==b`, `"a"?b:c`)
// or with the `#` of a comment. A part that is masked already (`…12`) is never inside a run.
const STUCK_RUN = /^(?![.+=!?:*#])(?:[^\s"'`\\;|&()<>,[\]{}$…]|\$(?![({])|…(?!\d))+/;

/**
 * What is stuck to the first part of a value, from `j`: another string or a bare run with no
 * space before it (`"$A"literal`, `"$A"'literal'`: one word to a shell; in Python two strings a
 * space apart are one string too). Each is judged like a value: a reference stays, a literal is
 * masked. `depth` is the number of backslashes in front of the first part's quotes (null when it
 * had none): a string that continues it is written at the same depth, and a quote at another
 * depth closes something around it instead. Returns the index after the last stuck part.
 */
function stuckSpans(text, j, st, depth) {
  for (;;) {
    let at = j;
    if (st.lang === 'python') while (text[at] === ' ' || text[at] === '\t') at++; // Python joins two strings that only a space separates
    let k = 0;
    while (text[at + k] === '\\') k++;
    const q = text[at + k];
    if (isQuote(q) && (depth === null || k === depth)) {
      const [end, after, closed] = stringEnd(text, at + k, k, !(st.lang === 'toml' && q === "'"));
      const body = text.slice(at + k + 1, end);
      // After a bare first part the quote may be the one that closes a string around the whole
      // assignment: what it "opens" then starts with a separator or runs into the next word.
      const around = depth === null && (!body || /^[\s,:;)\]}]/.test(body) || /[A-Za-z0-9_]/.test(text[after] || ''));
      if (closed && !around) { pushValue(st, text, at + k + 1, end, q); j = after; continue; }
    }
    // A part that is masked already stays a part of its own: the next one is read after it.
    const done = MASKED_HEAD.exec(text.slice(j, j + 32));
    if (done) { j += done[0].length; continue; }
    if (text[j] === '$' && (text[j + 1] === '(' || text[j + 1] === '{')) {
      // A substitution stuck to it, whole: a reference stays, anything else is masked.
      const close = bracketEnd(text, j + 1, lineEnd(text, j));
      if (close === -1) return j;
      pushValue(st, text, j, close + 1);
      j = close + 1;
      continue;
    }
    const run = STUCK_RUN.exec(text.slice(j, j + 4096));
    if (!run || !/[A-Za-z0-9$]/.test(run[0])) return j;
    pushValue(st, text, j, j + run[0].length);
    j += run[0].length;
  }
}

// What joins the parts of a value in code. What stands after one of these is as much the value
// as what stands before it: `"${A}" + "literal"`, `process.env.X || "literal"`, `a ? "x" : "y"`.
const OPERATOR = /^[ \t]*(?:\r?\n[ \t]*)?(\+(?![+=])|\|\|(?!=)|\?\?(?!=)|&&(?!=)|\?:|\?(?![?.:=])|:(?![:=]))[ \t]*(?:\r?\n[ \t]*)?/;
// The same, written as words (`x or "literal"`, `"a" if x else "b"`).
const WORD_OPERATOR = /^[ \t]+(?:or|and|if|else|unless)[ \t]+/;
// A call that reads the environment: the string it is given first is the name asked for.
const isReader = (callee) => /(?:^|[.:])(?:getenv|get|fetch|env)$/i.test(callee) && (/getenv$/i.test(callee) || /(?:^|[.:])(?:env|environ)(?:[.:]|$)/i.test(callee));
const GROUP_MAX = 2000;
// A name as code writes it: `token`, `$token`, `@token`, `$env:TOKEN`, and what is read from it
// (`cfg.auth.token`, `a?.b`, `A::b`, `a->b`). A `$` belongs to a name except where it opens a
// substitution: `abc$(cat f)` is a word a shell joins, not a call of `abc$`.
const NAME_HEAD = /^(?:\$[A-Za-z_]\w*:[A-Za-z_]\w*|[$@]?[A-Za-z_](?:\w|\$(?![({]))*)/;
const MEMBER = /^(?:\?\.|\.|::|->)(?:[A-Za-z_]|\$(?![({]))(?:\w|\$(?![({]))*/;

/**
 * A name at `j` with what is read from it and what it is called or indexed with. The strings in
 * its brackets are masked like values, except where they are names (see groupSpans). Returns
 * the index after it, or -1 when there is no name there.
 */
function nameSpans(text, j, st) {
  const head = NAME_HEAD.exec(text.slice(j, j + 200));
  if (!head) return -1;
  let e = j + head[0].length;
  for (;;) {
    const member = MEMBER.exec(text.slice(e, e + 200));
    if (member) { e += member[0].length; continue; }
    if (text[e] !== '[' && text[e] !== '(') return e;
    const close = groupSpans(text, e, st, text[e] === '[' ? 'index' : (isReader(text.slice(j, e)) ? 'reader' : 'call'));
    if (close === -1) return e;
    e = close;
  }
}

// A word with no quotes around it, as far as it may be one value: `cfg.token`, `aB3xK9mQ2pL7+/=`.
const BARE_WORD = /^[A-Za-z0-9_$@.+/=-]+/;
/** True when a quoted string is the name of something (a variable, a key), not a value. */
const isPlainName = (s) => /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,120}$/.test(s) && !carriesValue(s);

/**
 * The inside of the bracket at `open`, to the one that closes it on the same line. Every string
 * in it is masked like a value, except where it is a name: the index in `x["name"]`, and the
 * first argument of a call that reads the environment (`getenv("NAME", "fallback")`: the fallback
 * is a value, and so is a number in its place). A call inside it is read the same way. Returns
 * the index after the closing bracket, or -1 when nothing closes it.
 */
function groupSpans(text, open, st, kind) {
  const stop = Math.min(lineEnd(text, open), open + GROUP_MAX);
  const found = [];
  let arg = 0;
  let fresh = true; // at the start of an argument
  for (let i = open + 1; i < stop;) {
    const c = text[i];
    if (c === ')' || c === ']' || c === '}') {
      for (const [s, e, quote] of found) pushValue(st, text, s, e, quote);
      return i + 1;
    }
    if (c === ',') { arg++; i++; fresh = true; continue; }
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '(' || c === '[' || c === '{') {
      const close = groupSpans(text, i, st, 'call');
      if (close === -1) return -1;
      i = close;
      fresh = false;
      continue;
    }
    let k = 0;
    while (text[i + k] === '\\') k++;
    if (isQuote(text[i + k])) {
      const q = text[i + k];
      const [end, after] = stringEnd(text, i + k, k, !(st.lang === 'toml' && q === "'"));
      // The name asked for stays only when it is one: `getenv("DB_PASSWORD")`, not `getenv("aB3xK9mQ2pL7")`.
      const name = (kind === 'index' || (kind === 'reader' && arg === 0)) && isPlainName(text.slice(i + k + 1, end));
      if (!name) found.push([i + k + 1, end, q]);
      i = Math.max(after, i + k + 1);
      fresh = false;
      continue;
    }
    const num = fresh && kind === 'reader' && arg > 0 ? NUMBER_RE.exec(text.slice(i, i + 64)) : null;
    const word = num || k ? null : BARE_WORD.exec(text.slice(i, i + 200));
    if (num) {
      if (!SWITCH_WORD.test(num[0])) found.push([i, i + num[0].length, null]);
      i += num[0].length;
    } else if (word && carriesValue(word[0])) {
      found.push([i, i + word[0].length, null]); // an argument that reads like a value is one
      i += word[0].length;
    } else {
      const named = k === 0 ? nameSpans(text, i, st) : -1;
      i = named !== -1 ? named : i + (k || 1);
    }
    fresh = false;
  }
  return -1;
}

/**
 * One part of a value at `j`: a string (with what is stuck to it), a number, a group in
 * parentheses, or a name with what is read from it and what it is called with. The literals in
 * it are masked. `group` says a parenthesis may open the part. Returns the index after it, or
 * -1 when there is no part there or when it is the name of the next assignment.
 */
function operandSpans(text, j, st, depth, group) {
  const lead = /^(?:(?:await|new|not|typeof)[ \t]+|!+)/.exec(text.slice(j, j + 12));
  if (lead) j += lead[0].length;
  let k = 0;
  while (text[j + k] === '\\') k++;
  const q = text[j + k];
  if (isQuote(q) && (depth === null || k === depth)) {
    const [end, after, closed] = stringEnd(text, j + k, k, !(st.lang === 'toml' && q === "'"));
    pushValue(st, text, j + k + 1, end, q);
    return closed ? stuckSpans(text, after, st, k) : Math.max(after, j + k + 1);
  }
  if (k) return -1;
  if (q === '(') return group ? groupSpans(text, j, st, 'call') : -1;
  const num = NUMBER_RE.exec(text.slice(j, j + 64));
  if (num) {
    if (!SWITCH_WORD.test(num[0])) pushValue(st, text, j, j + num[0].length);
    return j + num[0].length;
  }
  // A bare word is a name (`pw`, `cfg.token`), which holds no value, unless it reads like one.
  const word = BARE_WORD.exec(text.slice(j, j + 200));
  if (word && carriesValue(word[0])) {
    pushValue(st, text, j, j + word[0].length);
    return j + word[0].length;
  }
  const e = nameSpans(text, j, st);
  if (e === -1) return -1;
  // `A="x" || B="y"`: the name of another assignment is not a part of this value. That name
  // is read to its end the way nameBefore reads it, dashes and letters of any alphabet included.
  let end = e;
  while (end - e < NAME_MAX && isNameChar(text.charCodeAt(end))) end++;
  return /^[ \t]*(?:[|?+&]*=(?!=)|:=)/.test(text.slice(end, end + 8)) ? -1 : e;
}

/**
 * The rest of a value after its first part, from `j`: every operator and the part it joins.
 * `words` allows the operators that are words, where the text is code and not a sentence;
 * `shell` says the value is the one of a shell assignment (`NAME=value`), after which `&&` and
 * `||` start another command and join no value. Returns the index after the last part.
 */
function expressionSpans(text, j, st, { depth, words, shell = false }) {
  let ternary = 0;
  for (;;) {
    const rest = text.slice(j, j + 200);
    let op = OPERATOR.exec(rest);
    if (op && shell && (op[1] === '&&' || op[1] === '||')) op = null;
    if (op && op[1] === ':') { if (ternary === 0) op = null; else ternary--; } else if (op && op[1] === '?') ternary++;
    if (!op && words) op = WORD_OPERATOR.exec(rest);
    if (!op) return j;
    const next = operandSpans(text, j + op[0].length, st, depth, true);
    if (next === -1) return j;
    j = next;
  }
}

// What files.mjs calls a file of prose (`markdown`) and one of no known format (`text`).
const PROSE_LANGS = new Set(['markdown', 'text']);
// A word no sentence has: a letter and a digit in it, or one of the symbols a generated value is made with.
const GENERATED = /^(?=.*\p{L})(?=.*\d)|^(?=.*[\p{L}\d]).*[!@#%^&*+~]/u;
// A row of pairs: another `name=` earlier on the line, and a space or a semicolon right in front
// of this name (`user=u password=`, `Database=d;Password=`). A comma is not one of its
// separators: `connect(user=u, password=pw)` is a call. Both tests look only at what masking a
// value leaves as it was, so a text reads the same way after it is masked.
const PAIR_EARLIER = /[A-Za-z0-9_]=/;
const PAIR_SEPARATOR = /(?:[^\s,;][ \t]+|;[ \t]*)$/;
const inRow = (before) => PAIR_SEPARATOR.test(before) && PAIR_EARLIER.test(before);
// A name that is called or indexed: `getToken(`, `os.environ[`, `cfg.get(`.
const CALLED = new RegExp(`${NAME_HEAD.source}(?:${MEMBER.source.slice(1)})*[([]`);
// What may stand in front of an assignment that has a line to itself.
const LINE_LEAD = /^[ \t]*(?:(?:export|local|declare|readonly|typeset|set|env)[ \t]+(?:-\w+[ \t]+)*)?$/;

/** True when the assignment whose name starts at `at` is the first thing on its line. */
const leadsLine = (text, at) => LINE_LEAD.test(text.slice(text.lastIndexOf('\n', at - 1) + 1, at));

/** True when the value that starts at `i` is one shell word and nothing but a comment follows it on the line. */
function endsLine(text, i) {
  // Strings, substitutions and bare runs with no space between them.
  let j = i;
  for (;;) {
    if (text[j] === '"' || text[j] === "'") {
      const [, after, closed] = stringEnd(text, j, 0);
      if (!closed) return false;
      j = after;
      continue;
    }
    if (text[j] === '$' && (text[j + 1] === '(' || text[j + 1] === '{')) {
      const close = bracketEnd(text, j + 1, lineEnd(text, j));
      if (close === -1) return false;
      j = close + 1;
      continue;
    }
    const run = /^(?:[^\s"'`;|&<>$]|\$(?![({]))+/.exec(text.slice(j, j + 4096));
    if (!run) break;
    j += run[0].length;
  }
  return j > i && /^[ \t]*(?:#.*)?\r?$/.test(text.slice(j, lineEnd(text, j)));
}

/**
 * True when a quote is left open on the line in front of `at`: `at` may then be inside a string.
 * `kind` asks about one kind of quote only; without it any kind counts.
 */
function insideString(text, at, kind = null) {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  if (at - start > 4096) return true;
  const open = { '"': 0, "'": 0, '`': 0 };
  for (let i = start; i < at; i++) if (Object.hasOwn(open, text[i]) && text[i - 1] !== '\\') open[text[i]] ^= 1;
  return Boolean(kind ? open[kind] : open['"'] || open["'"] || open['`']);
}

/** How much of an unquoted value is the value: up to a bracket it did not open, or to the `&` of a query string. */
function unclosedEnd(run, query) {
  let depth = 0;
  for (let i = 0; i < run.length; i++) {
    const c = run[i];
    if (query && c === '&') return i;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth < 0) return i;
  }
  return run.length;
}

/**
 * The value that follows a secret name at `p`. `opener` is the quote right in front of a bare
 * name, when there is one. Returns the index after what was read.
 */
function valueSpans(text, p, st, { name, quotedKey, tight, sep, opener, at }) {
  let i = p;
  const prefix = /^[rRbBfFuU]{1,2}(?=["'])/.exec(text.slice(i, i + 3)); // r"...", b'...'
  if (prefix) i += prefix[0].length;
  const three = text.slice(i, i + 3);
  if (three === '"""' || three === "'''") {
    const close = tripleEnd(text, i + 3, three);
    pushLines(st, text, i + 3, close === -1 ? text.length : close);
    return close === -1 ? text.length : close + 3;
  }
  let k = 0;
  while (text[i + k] === '\\') k++;
  const q = text[i + k];
  // An assignment with no space around its `=`, where what follows cannot be running text:
  // `DB_PASSWORD=value` and `--token=value` wherever they are written; a name in any other case
  // (`password=value`) in a query string, or when the line is that assignment and nothing else
  // (a properties file, a shell script). `f(password=pw)` in code is neither.
  const query = text[at - 1] === '?' || text[at - 1] === '&';
  const assigned = !quotedKey && tight && sep === '=';
  const leads = assigned && leadsLine(text, at);
  const envLike = assigned && (ENV_LIKE.test(name) || name.startsWith('-') || query || (leads && endsLine(text, i)));
  // A pair that leads its line with more after it, opens a string or stands in a row of pairs
  // is data as well (`password=two words`, `-d "password=value"`, `host=h user=u password=value`,
  // `Server=h;Password=value;`), but only its unquoted value is read: after such a name a quote
  // is as often the one that closes the string (`"token=" + t`).
  const pair = assigned && !envLike && (leads || opener !== null || inRow(text.slice(Math.max(text.lastIndexOf('\n', at - 1) + 1, at - 200), at)));
  if (isQuote(q)) {
    const [end, after, closed] = stringEnd(text, i + k, k, !(st.lang === 'toml' && q === "'"));
    // After a bare name written inside a string the quote may be the one that closes that string
    // (`"header": "Authorization: ", "next": ...`): what follows is then not a value. Only where
    // the line shows a string open around the name; `password = "value` with nothing closing it,
    // or with a word stuck to its closing quote, is a value.
    if (!quotedKey && !envLike && (!closed || /[A-Za-z0-9_]/.test(text[after] || '')) && insideString(text, at)) return p;
    pushValue(st, text, i + k + 1, end, q);
    if (!closed) return Math.max(after, i + k + 1);
    // In a sentence `or` and `if` are words; after `=`, or in a Python or Ruby file, they join values.
    return expressionSpans(text, stuckSpans(text, after, st, k), st, { depth: k, words: !envLike && (sep !== ':' || st.lang === 'python' || st.lang === 'ruby'), shell: envLike });
  }
  if (k === 0 && (q === '{' || q === '[')) return containerSpans(text, i, st);
  // A number: after a quoted name or where the text is data or code it is the value; in running
  // text only a long one is (`password: 12345678`), since "token: 5" is as often a count.
  const num = k === 0 ? NUMBER_RE.exec(text.slice(i, i + 64)) : null;
  if (num && !envLike && !pair) {
    const digits = num[0].replace(/\D/g, '').length;
    if (SWITCH_WORD.test(num[0]) || !(quotedKey || digits >= 6 || DATA_LANGS.has(st.lang))) return p;
    pushValue(st, text, i, i + num[0].length);
    return i + num[0].length;
  }
  // Unquoted, only where the value cannot be running text: `DB_PASSWORD=value`, `--token=value`.
  if (envLike || pair) {
    // `TOKEN=Bearer value`: the word after the scheme is the value, and the scheme stays readable.
    const from = i + (query ? 0 : (SCHEME_RE.exec(text.slice(i, i + 16)) || [''])[0].length);
    const value = query ? queryValue(text, i) : bareValue(text, from);
    let end = value.end;
    // A value that starts with a masked one was masked with the structure of its file (which
    // may end it sooner, at a `#`): only what is stuck to it is still read.
    const masked = MASKED_HEAD.exec(text.slice(from, from + 32));
    if (masked) end = from + masked[0].length;
    else if (!value.reference) {
      // A name that is called or indexed is code (`TOKEN=getToken()`, `password=os.environ["X"]`),
      // when its brackets close; in a query string nothing is.
      const code = !query && CALLED.test(text.slice(from, from + 200)) ? nameSpans(text, from, st) : -1;
      if (code !== -1 && (text[code - 1] === ')' || text[code - 1] === ']') && !carriesValue(text.slice(from, code))) end = code;
      else {
        // The value stops where the brackets around the assignment close, and at the next pair of a query string.
        end = from + unclosedEnd(text.slice(from, end), query);
        if (end > from && !plainScalar(name, text.slice(from, end))) pushValue(st, text, i, end);
      }
    }
    // Nothing is stuck to the value of a query string pair: what follows is the next pair or the
    // fragment. After a shell assignment `&&` and `||` start another command; after a pair that
    // may as well be code (`password=os.getenv("X") or "literal"`) they join values.
    if (query) return end;
    return expressionSpans(text, stuckSpans(text, end, st, null), st, envLike ? { depth: null, words: false, shell: true } : { depth: null, words: true });
  }
  // ... and a header written inside a string: `-H "X-Api-Key: value"`, up to the closing quote.
  if (!quotedKey && opener && sep === ':' && HEADER_LIKE.test(name)) {
    const close = text.indexOf(opener, i);
    if (close === -1 || close > lineEnd(text, i)) return p;
    const v = text.slice(i, close).replace(/\\+$/, '');
    if (!/^\S+$/.test(v.replace(SCHEME_RE, '')) || plainScalar(name, v)) return p; // one word: a sentence is not a credential
    pushValue(st, text, i, i + v.length, opener);
    return i + v.length;
  }
  // `!secret name` and `*alias` (YAML) name the value; a "name" that reads like a value is one.
  const named = k === 0 ? /^(?:!secret[ \t]+|\*)([A-Za-z0-9_.-]+)/.exec(text.slice(i, i + 200)) : null;
  if (named) {
    if (carriesValue(named[1])) pushValue(st, text, i + named[0].length - named[1].length, i + named[0].length);
    return i + named[0].length;
  }
  // In a file of prose or of no known format (notes, a configuration file with no extension) an
  // unquoted word after a secret name is its value in two cases: when the line is that name and
  // that word and nothing else (`password = value`), and, anywhere in a line, when the word reads
  // like a generated value (`the token: v4lue99 expired`). Only with that hint: a text whose
  // format is not given may be code, where `token = cfg.token` names a value and holds none.
  if (k === 0 && !quotedKey && PROSE_LANGS.has(st.lang)) {
    const value = bareValue(text, i);
    const start = text.lastIndexOf('\n', at - 1) + 1;
    const alone = /^[ \t]*(?:[-*+][ \t]+)?$/.test(text.slice(start, at)) && /^[ \t]*(?:[;#].*)?\r?$/.test(text.slice(value.end, lineEnd(text, value.end)));
    const v = alone ? text.slice(i, value.end) : text.slice(i, value.end).replace(/[.,;:)\]]+$/, '');
    // A word with a call or a member in it is code; one with a masked part in it was read already.
    const code = v.includes('(') || v.includes('…') || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v);
    if (v && !value.reference && !code && !plainScalar(name, v) && !ANGLE_PLACEHOLDER.test(v) && (alone || (v.length >= 6 && GENERATED.test(v)))) {
      pushValue(st, text, i, i + v.length);
      return i + v.length;
    }
  }
  // A name, a call or a group first (`password = prefix + "literal"`, `token: process.env.X || "literal"`,
  // `secret = decode("literal")`): the literals in the expression are the value. A group opens a
  // value only where the text is code; in a sentence it is an aside (`password: (see "notes")`).
  if (k === 0) {
    const first = operandSpans(text, i, st, null, sep !== ':' || DATA_LANGS.has(st.lang));
    if (first !== -1) return expressionSpans(text, first, st, { depth: null, words: true });
  }
  return p;
}

// `${NAME:-word}`, `${NAME-word}`, `${NAME:=word}`, `${NAME:+word}`, `${prop:word}`: an expansion
// with a word that can stand where the name does; and `${NAME:?message}`, with a message.
const BRACED_DEFAULT = /\$\{([A-Za-z_][A-Za-z0-9_.]*)(:?[-=+?]|:)/g;
/** True when the name that starts at `at` is the one of a `${NAME...}` expansion. */
const expanded = (text, at) => text[at - 1] === '{' && text[at - 2] === '$';

// A character of a bare name: [A-Za-z0-9_.$-], and outside ASCII a letter, a mark, a digit or a
// character that does not show (a name with one of those in it still reads as the same name).
const WIDE_NAME_CHAR = /[\p{L}\p{N}\p{M}\p{Cf}\u115F\u1160\u2800\u3164\uFFA0]/u;
const isNameChar = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 36 || c === 45
  || (c > 127 && ((c >= 0xd800 && c <= 0xdfff) || WIDE_NAME_CHAR.test(String.fromCharCode(c))));
const NAME_MAX = 120;
const HEX_PAIR = /^[0-9A-Fa-f]{2}/;

/**
 * The name in front of the separator at `c`, read backwards, no further than `floor`: a quoted
 * name (the quotes escaped or not, the way JSON kept inside a string writes them; no space in
 * it, since with one it is as often the first branch of `cond ? 'some text' : 'other'`) or a
 * bare one (`[A-Za-z_$]` first, after up to two dashes of a command line flag). A name never
 * starts in the middle of a word. Returns { name, start, quoted, spaced } or null.
 */
function nameBefore(text, c, floor) {
  let e = c;
  while (e > floor && (text[e - 1] === ' ' || text[e - 1] === '\t')) e--;
  const spaced = e < c;
  if (e <= floor) return null;
  const q = text[e - 1];
  if (q === '"' || q === "'") {
    let k = 0;
    while (text[e - 2 - k] === '\\') k++;
    const close = e - 1 - k;
    let s = close;
    while (s > floor && close - s <= NAME_MAX) {
      const ch = text[s - 1];
      if (ch === '"' || ch === "'" || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') break;
      // A backslash belongs to the name only as part of a numbered escape or of a doubled backslash.
      if (ch === '\\' && !(s < close && 'uUx\\'.includes(text[s]))) break;
      s--;
    }
    if (s === close || s - 1 < floor || text[s - 1] !== q) return null;
    let kb = 0;
    while (text[s - 2 - kb] === '\\') kb++;
    const start = s - 1 - k;
    // Not in the middle of a word, except after the dot of a dotted key (`auth."password" = ...`).
    if (kb < k || start < floor || (kb === k && start > 0 && text[start - 1] !== '.' && isNameChar(text.charCodeAt(start - 1)))) return null;
    return { name: text.slice(s, close), start, quoted: true, spaced };
  }
  let s = e;
  // `pass%77ord=`: a percent-encoded character belongs to the name of a query string pair.
  while (s > floor && e - s <= NAME_MAX + 2 && (isNameChar(text.charCodeAt(s - 1)) || (text[s - 1] === '%' && HEX_PAIR.test(text.slice(s, s + 2))))) s--;
  if (s === e || (s > 0 && isNameChar(text.charCodeAt(s - 1))) || !/^-{0,2}[A-Za-z_$%\u0080-\uFFFF]/.test(text.slice(s, s + 3))) return null;
  return { name: text.slice(s, e), start: s, quoted: false, spaced };
}

// A command line flag, as it stands in a command or as one element of a list of arguments:
// `--api-key`, `-token`. (`--api-key=value` is an assignment, read with the others.)
const FLAG = /(?<![A-Za-z0-9_-])-{1,2}([A-Za-z][A-Za-z0-9_-]{2,80})(?![A-Za-z0-9_=-])/g;
// A word of a sentence, or a name that stands for a value in one (`TOKEN`, `YOUR_API_KEY`):
// letters only, with the punctuation that may be around it.
const PROSE_WORD = /^[([]?(?:\p{L}+|[A-Z][A-Z_]*)[.,;:!?)\]]*$/u;
const ANGLE_PLACEHOLDER = /^<\p{L}[\p{L}\p{N} _.:-]{0,60}>/u;
// Where a bare word after a flag is always an argument, never a word of a sentence.
const SCRIPT_LANGS = new Set(['shell', 'powershell']);

/**
 * The value of each flag whose name says it takes a secret, where it is written apart from the
 * flag: the next word of the command (`--api-key VALUE`, `--token "VALUE"`), the next element
 * of the list the flag is an element of (`"--api-key", "VALUE"`), or in YAML the next item of
 * the sequence (`- --api-key`, then `- VALUE`). Another flag in that place is not a value. In a
 * text that is not a script a bare word made of letters only is a word of the sentence
 * (`pass --token to the command`), not a value.
 */
function flagSpans(text, st) {
  FLAG.lastIndex = 0;
  let m;
  while ((m = FLAG.exec(text)) !== null) {
    if (!isSensitiveKey(m[1])) continue;
    // `--secret-id name`, `--secret-arn ...`: such a flag takes the name of a secret, not one,
    // as long as what it is given reads like a name.
    const namesOne = /[-_](?:id|arn)$/i.test(m[1]);
    const start = m.index;
    const e = start + m[0].length;
    // The quotes around the flag when it is a whole element: `"--token"`, `\"--token\"`.
    let k = 0;
    while (text[e + k] === '\\') k++;
    const fq = text[e + k];
    const element = (fq === '"' || fq === "'") && text[start - 1] === fq && text.slice(start - 1 - k, start - 1) === '\\'.repeat(k);
    const after = element ? e + k + 1 : e;
    const rest = text.slice(after, after + 400);
    const line = text.lastIndexOf('\n', start - 1) + 1;
    let gap = element ? /^[ \t]*,[ \t]*(?:\r?\n[ \t]*)?/.exec(rest) : null;
    let kind = 'list';
    if (!gap && st.lang === 'yaml' && /^[ \t]*-[ \t]+$/.test(text.slice(line, element ? start - 1 - k : start))) {
      gap = /^[ \t]*(?:#[^\n]*)?\r?\n[ \t]*-[ \t]+/.exec(rest);
      kind = 'item';
    }
    if (!gap && !element) {
      gap = /^[ \t]+/.exec(rest);
      kind = 'word';
    }
    if (!gap) continue;
    const p = after + gap[0].length;
    let kv = 0;
    while (text[p + kv] === '\\') kv++;
    const q = text[p + kv];
    if (isQuote(q)) {
      // In a command a quote of a kind that is open on the line closes the string around it (`"use --token " + t`).
      if (text[p + kv + 1] === '-' || (kind === 'word' && kv === 0 && insideString(text, start, q))) continue;
      const [end, , closed] = stringEnd(text, p + kv, kv, !(st.lang === 'toml' && q === "'"));
      if (namesOne && isPlainName(text.slice(p + kv + 1, end))) continue;
      if (closed || kind === 'word') pushValue(st, text, p + kv + 1, end, q); // an element of a list is a whole string
      continue;
    }
    if (kv || kind === 'list' || text[p] === '-' || ANGLE_PLACEHOLDER.test(text.slice(p, p + 64))) continue;
    const value = bareValue(text, p);
    let end = value.end;
    if (kind === 'item') end = p + (/^[^\r\n]*?(?=[ \t]+#|[ \t]*\r?$)/m.exec(text.slice(p, lineEnd(text, p))) || [''])[0].length;
    else end = p + unclosedEnd(text.slice(p, end), false);
    const v = text.slice(p, end);
    if (value.reference || !/[\p{L}\p{N}]/u.test(v) || plainScalar(m[1], v) || (namesOne && isPlainName(v))) continue;
    if (kind === 'word' && !SCRIPT_LANGS.has(st.lang) && PROSE_WORD.test(v)) continue;
    pushValue(st, text, p, end);
  }
  // `curl -u name:password`: the credentials of a request. What follows the colon is the secret.
  CURL_USER.lastIndex = 0;
  while ((m = CURL_USER.exec(text)) !== null) {
    const p = m.index + m[0].length;
    const q = m[1].slice(-1);
    const end = q ? stringEnd(text, p - m[2].length - 2, m[1].length - 1)[0] : bareValue(text, p).end;
    if (end > p) pushValue(st, text, p, end, q || null);
  }
  // A command that is handed a credential as an argument, whatever name it stands under.
  for (const re of CREDENTIAL_ARGUMENT) {
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const p = m.index + m[0].length;
      let kv = 0;
      while (text[p + kv] === '\\') kv++;
      const q = text[p + kv];
      if (isQuote(q)) {
        if (!(kv === 0 && insideString(text, m.index, q))) pushValue(st, text, p + kv + 1, stringEnd(text, p + kv, kv)[0], q);
        continue;
      }
      const value = bareValue(text, p);
      const end = p + unclosedEnd(text.slice(p, value.end), false);
      const v = text.slice(p, end);
      if (kv || value.reference || !/[\p{L}\p{N}]/u.test(v) || ANGLE_PLACEHOLDER.test(v)) continue;
      if (!SCRIPT_LANGS.has(st.lang) && PROSE_WORD.test(v)) continue; // `run bw unlock first`
      pushValue(st, text, p, end);
    }
  }
}

const CURL_USER = /\bcurl\b[^\n]{0,400}?[ \t](?:-u|--user)[ \t]+(\\*["']|)([^\s:"'\\]*):/g;
// Each ends right in front of the credential: `bw unlock PASSWORD`, `bw login NAME PASSWORD`,
// `vault login TOKEN`, `sshpass -p PASSWORD`, `docker login ... -p PASSWORD` (and the tools that
// log in the same way), `mysql ... -pPASSWORD`.
const CREDENTIAL_ARGUMENT = [
  /\bbw[ \t]+unlock[ \t]+(?!-)/g,
  /\bbw[ \t]+login[ \t]+(?!-)\S+[ \t]+(?!-)/g,
  /\bvault[ \t]+login[ \t]+(?!-)/g,
  /\bsshpass[ \t]+-p[ \t]*(?=\S)/g,
  /\b(?:docker|podman|nerdctl|buildah|skopeo|az|oc|helm[ \t]+registry)[ \t]+login\b[^\n|;&]{0,200}?[ \t]-p[ \t]+(?!-)/g,
  /\bmysql(?:dump|admin)?\b[^\n|;&]{0,200}?[ \t]-p(?=[^\s-])/g,
];

/**
 * `text` with the value of every secret name masked, read without any knowledge of its format:
 * a name followed by `:`, `=`, `:=` or `=>` and by a value. The text is walked from one separator
 * to the next, and the name is looked for only in front of one.
 */
function maskByKey(text, lang) {
  const st = { spans: [], lang, unclosed: 0 };
  const n = text.length;
  // `${TOKEN:-fallback}`: the name is being expanded, not assigned, and what a secret falls back
  // to is a secret as well, unless it is empty or a reference itself. A message (`:?`) stays
  // when it is a sentence and nothing else.
  for (const m of text.matchAll(BRACED_DEFAULT)) {
    if (!isSensitiveKey(m[1])) continue;
    const from = m.index + m[0].length;
    let depth = 1;
    let j = from;
    for (; j < n && j - from <= REFERENCE_MAX && text[j] !== '\n'; j++) {
      if (text[j] === '$' && text[j + 1] === '{') { depth++; j++; } else if (text[j] === '}' && --depth === 0) break;
    }
    const word = text.slice(from, j);
    const harmless = m[2].endsWith('?')
      ? isMessage(word) && !carriesValue(word)
      : word === '""' || word === "''" || referencesEnd(word, 0, { template: false }) === word.length;
    if (depth === 0 && !harmless) pushValue(st, text, from, j);
  }
  flagSpans(text, st);
  let i = 0; // nothing before `i` is read again
  for (;;) {
    let c = i;
    for (; c < n; c++) { const ch = text.charCodeAt(c); if (ch === 58 || ch === 61) break; } // `:` or `=`
    if (c >= n) break;
    let sep;
    if (text[c] === ':') {
      if (text[c + 1] === ':') { i = c + 2; continue; } // `a::b` names something, it assigns nothing
      sep = text[c + 1] === '=' ? ':=' : ':';
    } else {
      let run = 1;
      while (text[c + run] === '=') run++;
      if (run > 3) { i = c + run; continue; } // a ruler
      sep = run === 1 && text[c + 1] === '>' ? '=>' : '='.repeat(run);
    }
    const after = c + sep.length;
    let nameEnd = c;
    if (sep === '=') while (nameEnd > i && '|?+&'.includes(text[nameEnd - 1])) nameEnd--; // `||=`, `??=`, `+=`, `&&=`, `?=`
    const key = nameBefore(text, nameEnd, i);
    if (!key || !isSensitiveKey(key.name) || expanded(text, key.start)) { i = after; continue; }
    let p = after;
    while (text[p] === ' ' || text[p] === '\t') p++;
    const before = text[key.start - 1];
    const next = valueSpans(text, p, st, {
      name: key.name, quotedKey: key.quoted, tight: !key.spaced && p === after, sep, opener: !key.quoted && (before === '"' || before === "'") ? before : null, at: key.start,
    });
    i = Math.max(next, p);
  }
  return applySpans(text, st.spans);
}

// ---------------------------------------------------------------------------------------------
// Net 2b: a value named in a sentence
// ---------------------------------------------------------------------------------------------

// The nouns a sentence names a secret with, in English and in Portuguese, in three classes. A
// password (`pass`) is the only kind whose value may be a plain word; a PIN (`pin`) is digits and
// nothing else; the value of any other kind (`any`) has to read like a value. A noun is a whole
// word: not part of a name (`max_tokens`, `secret-scan`, `X-Api-Key`, `1Password`), of a path or
// of a query string, which the other nets read.
const PASS_NOUN = 'pass[ -]?phrases?|passwords?|passwd|senhas?';
const ANY_NOUN = [
  '(?:(?:api|access|auth|bearer|refresh|session|oauth)[ _-]?)?token',
  'secret(?:[ _-]?key)?', 'api[ _-]?key', 'apikey', 'access[ _-]?key', 'private[ _-]?key', 'credentials?',
  'chave(?: d[ea] api| secreta| privada| de acesso)?', 'segredo', 'credencia(?:l|is)', 'c(?:o|\\u00f3|o\\u0301)digo de acesso',
].join('|');
const SENTENCE_NOUN = new RegExp(
  `(?<![\\p{L}\\p{N}\\p{M}_$@#%&?=./\\\\-])(?:(?<pass>${PASS_NOUN})|(?<pin>pin)|(?<any>${ANY_NOUN}))(?![\\p{L}\\p{N}\\p{M}_-]|\\.[\\p{L}\\p{N}])`,
  'giu',
);
// What joins the noun to its value: a verb (`is`, `é`, `fica`, `vale`), `:`, `=` or the `to` of
// `set the token to v`. In front of
// it the noun may be qualified (`the password for staging is`, `a senha do banco é`) and behind
// it an article may stand (`o token é o ...`); markdown emphasis around either is skipped.
const COPULA = '(?:is|was|are|were|s(?:\\u00e3|a\\u0303|a)o|ser(?:\\u00e1|a\\u0301)|era|\\u00e9|e\\u0301|eh|fica|vale)';
const QUALIFIER = '[ \\t]+(?:for|of|on|in|to|do|da|de|dos|das|para|no|na)(?:[ \\t]+(?:the|a|an|my|your|our|this|that|o|os|as|meu|minha|seu|sua|nosso|nossa))?[ \\t]+[\\p{L}\\p{N}\\p{M}_.-]{1,40}';
const AFTER_NOUN = new RegExp(
  `^(?:\\*{1,2}|\`)?(?<qual>${QUALIFIER})?(?<conn>[ \\t]*[:=](?![:=>])[ \\t]*|[ \\t]+(?<verb>${COPULA})(?:[ \\t]*:)?[ \\t]+|[ \\t]+to[ \\t]+)(?:\\*{1,2}[ \\t]*)?(?<art>(?:the|a|an|o|um|uma)[ \\t]+)?`,
  'iu',
);
// What a word that follows such a noun names, when it does not hold a value: a URL (`op://...`
// included), a path or a dotfile, an e-mail address, a file, a variable in upper case, a member
// (`cfg.token`), a call, an index or a placeholder, a version, an amount with its unit, and the
// names of algorithms, encodings and products that are written with digits.
const NAMES_SOMETHING = [
  /:\/\//,
  /^(?:[A-Za-z]:)?[\\/~.]/,
  /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/,
  /\.(?:json|jsonc|ya?ml|toml|env|md|mdx|txt|js|mjs|cjs|ts|py|sh|ps1|pem|key|pub|crt|cfg|conf|ini|lock|log|html|csv|xml|kdbx)$/i,
  /^\$?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/,
  /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+$/,
  /[([{<]/,
  /^v?\d+(?:\.\d+)+(?:[-+][\w.]+)?$/i,
  /^v\d+$/i,
  /^\d+(?:[.,]\d+)?(?:ms|s|secs?|min|mins|h|hrs?|d|days?|k|kb|kib|mb|mib|gb|gib|tb|px|em|rem|x|st|nd|rd|th|chars?|bytes?|tokens?|bits?|lines?|rpm|tpm)$/i,
  /^(?:sha-?(?:1|2|224|256|384|512)|md5|base(?:32|64)(?:url)?|utf-?(?:8|16|32)(?:mb4)?|x86(?:[-_]64)?|x64|arm64|aarch64|amd64|aes-?(?:128|192|256)(?:-[a-z]+)?|rsa-?\d{3,4}|ed25519|ed448|curve25519|secp256k1|p-?256|[hrep]s(?:256|384|512)|oauth2|pbkdf2|argon2(?:id|i|d)?|hmac-?sha\d+|ipv[46]|http[23]|2fa|k8s|i18n|l10n|e2e|1password|win(?:32|64)|u?int(?:8|16|32|64)|float(?:32|64)|o200k(?:_base)?|cl100k(?:_base)?|gpt-?\d[\w.-]*)$/i,
];
const namesSomething = (v) => NAMES_SOMETHING.some((re) => re.test(v)) || ((v.includes('/') || v.includes('\\')) && !carriesValue(v));
// A plain word after `the password is` / `a senha é` is its value unless it reads as a word of the
// sentence: one of these, or a word with the ending of a participle, an adverb or an abstract
// noun in either language (`stored`, `required`, `guardada`, `obrigatória`, `currently`). Words
// shorter than six letters are never a value, so only longer ones matter here.
const PROSE_ENDING = /(?:ed|ing|ly|able|ible|tion|sion|ment|ness|ous|ive|ful|less|ence|ance|ent|ant|ary|ory|ical|ic|al|ity|ize|ise|ure|ward|wise|self|selves|ado|ada|ados|adas|ido|idos|idas|ção|ções|cao|coes|mente|vel|veis|oso|osa|osos|osas|ário|ária|ario|aria|ório|ória|orio|oria|ivo|iva|ivos|ivas|ente|ante|eiro|eira|agem|dade|ência|ância|encia|ancia|ismo|ista)$/u;
const PROSE_WORDS = new Set([
  // English
  'secret', 'secrets', 'password', 'passwords', 'passphrase', 'token', 'tokens', 'credential', 'credentials', 'private', 'public',
  'strong', 'stronger', 'weaker', 'longer', 'shorter', 'better', 'simple', 'unique', 'random', 'secure', 'unsafe', 'either',
  'neither', 'within', 'without', 'inside', 'outside', 'before', 'behind', 'beyond', 'always', 'rather', 'enough', 'really',
  'pretty', 'should', 'would', 'could', 'might', 'become', 'became', 'itself', 'unknown', 'shown', 'hidden', 'written', 'given',
  'taken', 'broken', 'stolen', 'chosen', 'forgotten', 'gotten', 'cannot', 'nothing', 'something', 'anything', 'everything',
  'somewhere', 'elsewhere', 'anywhere', 'wherever', 'whatever', 'whichever', 'another', 'others', 'common', 'normal', 'default',
  'defaults', 'sample', 'example', 'placeholder', 'dummy', 'invalid', 'correct', 'incorrect', 'change', 'changes', 'unset', 'empty',
  'blank', 'wrong', 'right', 'there', 'where', 'which', 'still', 'already', 'other', 'never', 'often', 'mostly', 'second', 'twelve',
  'longest', 'shortest', 'strongest', 'weakest', 'yourself', 'myself', 'ourselves', 'theirs', 'yours', 'single', 'double',
  'remote', 'online', 'offline', 'inline', 'stored', 'saved', 'kept', 'reset', 'rotated', 'changed', 'printed', 'masked',
  // Portuguese
  'secreta', 'secreto', 'segredo', 'senhas', 'privada', 'privado', 'pública', 'público', 'publica', 'publico', 'simples',
  'única', 'único', 'segura', 'seguro', 'sempre', 'também', 'tambem', 'outra', 'outro', 'outras', 'outros', 'mesma',
  'mesmo', 'padrão', 'padrao', 'vazia', 'vazio', 'certa', 'correta', 'correto', 'incorreta', 'incorreto', 'inválida',
  'inválido', 'invalida', 'invalido', 'válida', 'válido', 'valida', 'valido', 'opcional', 'nenhuma', 'nenhum',
  'alguma', 'algum', 'qualquer', 'aquela', 'aquele', 'nossa', 'nosso', 'minha', 'pessoal', 'própria', 'próprio',
  'propria', 'proprio', 'depois', 'antes', 'então', 'entao', 'assim', 'igual', 'iguais', 'longa', 'longo', 'curta', 'curto',
  'grande', 'pequena', 'pequeno', 'forte', 'fraca', 'fraco', 'trocar', 'mudar', 'guardar', 'secretas', 'secretos', 'exemplo',
]);
/** True when `v`, a word of letters only, is the value a sentence gives a password, and not a word of that sentence. */
function plainSecretWord(v) {
  const w = v.normalize('NFC');
  if (!/^[\p{L}\p{M}]+$/u.test(w) || /\p{Ll}\p{Lu}/u.test(w) || /^\p{Lu}+$/u.test(w)) return false;
  const lower = w.toLowerCase();
  return !PROSE_WORDS.has(lower) && !PROSE_ENDING.test(lower);
}

/**
 * True when `v`, an unquoted word that follows a secret noun, is that secret. `mode` says how it
 * follows: `copula` right after a verb (`the password is v`), `named` after a `:`, an `=`, a
 * qualifier or an article, `next` with nothing between them (`use secret v`).
 */
function sentenceWord(v, cls, mode) {
  if (!v || v.length > 512 || v.includes('…') || /^[-!*&]/.test(v)) return false;
  if (isReference(v) || PLACEHOLDER.test(v) || plainScalar('', v) || namesSomething(v)) return false;
  if (/^\d+$/.test(v)) return cls === 'pin' ? v.length >= 4 && v.length <= 12 : v.length >= (cls === 'pass' && mode !== 'next' ? 4 : 6);
  if (cls === 'pin' || v.length < 6) return false;
  if (GENERATED.test(v)) return true;
  return cls === 'pass' && mode === 'copula' && plainSecretWord(v);
}

/** The same for a value between quotes or backticks, `v` being what is between them. */
function sentenceQuoted(v, cls, mode, backticks) {
  if (!v.trim() || v.length > 512 || v.includes('…')) return false;
  if (isReference(v, backticks) || PLACEHOLDER.test(v) || ANGLE_PLACEHOLDER.test(v) || plainScalar('', v)) return false;
  // Several words: a pass phrase, when a sentence gives it as the value of a password.
  if (/\s/.test(v)) return cls === 'pass' && mode !== 'next' && v.trim() === v && !/[([{<]/.test(v);
  if (namesSomething(v) || /^-/.test(v)) return false;
  // The name of a key (`access_token`, `password`), not its value.
  if (/^[A-Za-z][A-Za-z_.-]*$/.test(v) && isSensitiveKey(v)) return false;
  // Right after the noun a quoted word is as often a name (the token `max_tokens`): only one that
  // reads like a value is one, or a word given as a password.
  if (mode === 'next' || cls === 'pin') return sentenceWord(v, cls, 'next') || (cls === 'pass' && v.length >= 4 && plainSecretWord(v));
  return true;
}

/**
 * True when the quote at `p` opens a string: an even number of quotes of its kind stands in
 * front of it on its line. An apostrophe between two letters (`don't`) is not a quote.
 */
function opensString(text, p) {
  const q = text[p];
  const start = text.lastIndexOf('\n', p - 1) + 1;
  if (p - start > 4096) return false;
  let open = false;
  for (let i = start; i < p; i++) {
    if (text[i] !== q || text[i - 1] === '\\') continue;
    if (q === "'" && /[\p{L}\p{N}]/u.test(text[i - 1] || '') && /\p{L}/u.test(text[i + 1] || '')) continue;
    open = !open;
  }
  return !open;
}

/**
 * The value written after a secret noun in running text, in English or Portuguese:
 *   `the password is v`, `a senha é v`, `o token fica v`, `password: v`, `secret = v`, `set the
 *   token to v`, with a
 *   qualifier before the verb (`the password for staging is v`) or an article after it;
 *   `use secret v`, `a chave v`: the noun and the value with nothing between them;
 *   any of these with the value in quotes or backticks.
 * The value is one word, to a space or a closing mark (`.`, `,`, `;`, `:`, a bracket), or what is
 * between the quotes. It is masked when it is a word no sentence has (letters with digits or with
 * one of `!@#%^&*+~`, six characters or more), a long number (six digits; four after the verb of
 * a password; four to twelve after `pin`), a quoted value after a verb, `:` or `=`, or, after the
 * verb of a password only (`the password is v`), a word of six letters or more that is not one of
 * PROSE_WORDS and has no PROSE_ENDING. What NAMES_SOMETHING describes, a reference, a placeholder
 * and a switch word (`true`, `none`) stay. The language of the file is not asked.
 */
function maskSentences(text) {
  const spans = [];
  SENTENCE_NOUN.lastIndex = 0;
  let m;
  while ((m = SENTENCE_NOUN.exec(text)) !== null) {
    const cls = m.groups.pass !== undefined ? 'pass' : (m.groups.pin !== undefined ? 'pin' : 'any');
    const e = m.index + m[0].length;
    const rest = text.slice(e, Math.min(lineEnd(text, e), e + 240));
    const joined = AFTER_NOUN.exec(rest);
    let p;
    let mode;
    if (joined) {
      p = e + joined[0].length;
      mode = joined.groups.verb && !joined.groups.qual && !joined.groups.art ? 'copula' : 'named';
    } else {
      const gap = /^(?:\*{1,2}|`)?[ \t]+/.exec(rest);
      if (!gap) continue;
      p = e + gap[0].length;
      mode = 'next';
    }
    const q = text[p];
    let end = -1;
    if (q === '"' || q === "'" || q === '`') {
      if (!opensString(text, p)) continue;
      const [close, after, closed] = stringEnd(text, p, 0);
      if (closed && sentenceQuoted(text.slice(p + 1, close), cls, mode, q === '`')) {
        spans.push([p + 1, close, maskValue(text.slice(p + 1, close))]);
        end = after;
      }
    } else if (q !== undefined && q !== '\n' && q !== '\r') {
      const value = bareValue(text, p);
      let v = text.slice(p, value.end).replace(/[.,:;)\]}>]+$/, '');
      // The mark that closes an emphasis opened earlier on the line (`**the secret masked**`) is not part of the word.
      const mark = /(?:\*{1,2}|_{1,2}|~~)$/.exec(v);
      if (mark && text.slice(text.lastIndexOf('\n', p - 1) + 1, p).includes(mark[0])) v = v.slice(0, -mark[0].length).replace(/[.,:;)\]}>]+$/, '');
      if (!value.reference && sentenceWord(v, cls, mode)) {
        spans.push([p, p + v.length, maskValue(v)]);
        end = p + v.length;
      }
    }
    if (end > SENTENCE_NOUN.lastIndex) SENTENCE_NOUN.lastIndex = end;
  }
  return applySpans(text, spans);
}

// ---------------------------------------------------------------------------------------------
// Net 3: by shape
// ---------------------------------------------------------------------------------------------

const withIndices = (re) => new RegExp(re.source, re.flags.includes('d') ? re.flags : `${re.flags}d`);
const KEY_BEGIN_SRC = PATTERNS.find((p) => p.id === 'private-key').re.source;
const KEY_BEGIN = new RegExp(KEY_BEGIN_SRC);
const KEY_END = new RegExp(KEY_BEGIN_SRC.replace('BEGIN', 'END'));
const LINE_PATTERNS = [
  ...PATTERNS.filter((p) => p.id !== 'private-key').map((p) => ({ id: p.id, re: withIndices(p.re), extra: false })),
  ...EXTRA_PATTERNS.map((p) => ({ id: p.id, re: withIndices(p.re), extra: true })),
];

function shapeLineOnce(line) {
  const taken = [];
  const spans = [];
  for (const p of LINE_PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(line)) !== null) {
      if (m[0].length === 0) { p.re.lastIndex++; continue; }
      const a = m.index;
      const b = m.index + m[0].length;
      if (taken.some(([x, y]) => a < y && b > x)) continue;
      // `secret-scan`, `password_min_length`: a name that describes a secret holds none. And the
      // name of a `${NAME:-word}` expansion is not being assigned to: the pass by key reads those.
      if (p.extra && m.groups && m.groups.k !== undefined && (!isSensitiveKey(m.groups.k) || expanded(line, m.indices.groups.k[0]))) continue;
      const g = m.indices && m.indices.groups && m.indices.groups.v ? m.indices.groups.v : m.indices[0];
      const value = line.slice(g[0], g[1]);
      // A value that starts with a masked one was read by key already: what is stuck to it was
      // judged there (a bracket, a comma and the next word), and is not a second value.
      if (isMasked(value) || MASKED_HEAD.test(value)) continue;
      if (p.extra) {
        // A reference is no secret. The patterns capture a value up to the first space or quote,
        // so `$(command with arguments)` and `${VAR:?a message}` arrive cut short: the run of
        // references is read from the line itself, and it has to cover all that was captured.
        const lead = (SCHEME_RE.exec(value) || [''])[0].length;
        const rest = line.slice(g[0] + lead, g[0] + lead + REFERENCE_MAX);
        if (isReference(value.slice(lead)) || referencesEnd(rest, 0, { template: false }) >= value.length - lead) continue;
      }
      taken.push([a, b]);
      spans.push([g[0], g[1], maskValue(value)]);
    }
  }
  if (!spans.length) return line;
  spans.sort((x, y) => x[0] - y[0]);
  let out = '';
  let pos = 0;
  for (const [s, e, r] of spans) { out += line.slice(pos, s) + r; pos = e; }
  return out + line.slice(pos);
}

/** Every secret-shaped value of one line. */
function shapeLine(line) {
  let cur = line;
  for (let i = 0; i < 5; i++) {
    const next = shapeLineOnce(cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/** Mask every secret on one line (no newline inside): by the name it is assigned to, then by its shape. */
export function maskLine(line) {
  return shapeLine(maskSentences(maskByKey(String(line), null)));
}

/** A line that can be part of a PEM body: one base64-ish token, a PEM header field, or blank. */
const pemBodyLine = (l) => /^\s*[A-Za-z0-9+/=_-]*\s*$/.test(l) || /^[A-Za-z-]+:\s/.test(l);

/**
 * Private key blocks lose their header, body and footer (the body without even a prefix); every
 * other line goes through the shape patterns.
 */
function maskByShape(text) {
  const lines = text.split('\n');
  let inKey = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const cr = line.endsWith('\r') ? '\r' : '';
    if (cr) line = line.slice(0, -1);
    if (inKey) {
      const end = KEY_END.exec(line);
      if (end) {
        const stop = end.index + end[0].length;
        line = hidden(line.slice(0, stop)) + shapeLine(line.slice(stop));
        inKey = false;
      } else if (pemBodyLine(line)) {
        line = line.trim() ? hidden(line) : line;
      } else {
        inKey = false; // prose after a mention of the marker, not key material
        i--;
        continue;
      }
      lines[i] = line + cr;
      continue;
    }
    const begin = KEY_BEGIN.exec(line);
    if (begin) {
      const rest = line.slice(begin.index);
      const end = KEY_END.exec(rest);
      if (end) {
        const stop = begin.index + end.index + end[0].length;
        line = shapeLine(line.slice(0, begin.index)) + mask(line.slice(begin.index, stop)) + shapeLine(line.slice(stop));
      } else {
        line = shapeLine(line.slice(0, begin.index)) + mask(rest);
        inKey = true;
      }
      lines[i] = line + cr;
      continue;
    }
    lines[i] = shapeLine(line) + cr;
  }
  return lines.join('\n');
}

/**
 * Mask a whole text. `lang` is what files.mjs calls the file's language (`json`, `toml`, `yaml`,
 * `javascript`, ...): it selects the structure the text is read with. Without it a text that
 * parses as JSON is read as JSON and anything else as running text. The number of lines never
 * changes.
 */
export function maskText(text, { lang = null } = {}) {
  let cur = String(text);
  const structure = Object.hasOwn(STRUCTURE, lang || '') ? lang : ((lang === null || lang === 'text') && looksLikeJson(cur) ? 'json' : null);
  if (structure) {
    const st = { spans: [], lang: structure, unclosed: 0 };
    STRUCTURE[structure](cur, st);
    cur = applySpans(cur, st.spans);
  }
  return maskByShape(maskSentences(maskByKey(cur, structure || lang)));
}

const SENSITIVE_NAMES = [
  /^\.env(\..+)?$/i, /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.?credentials(\.[a-z]+)?$/i, /^\.credentials\.json/i, /^auth\.json$/i, /^\.npmrc$/i, /^\.netrc$/i, /^\.pypirc$/i,
  /^\.claude\.json$/i, /(^|[._-])secrets?\.(json|ya?ml|toml|env|txt)$/i,
];

/** Files whose every value is treated as a secret, whatever its shape. */
export function isSensitiveName(file) {
  const base = path.basename(String(file));
  return SENSITIVE_NAMES.some((re) => re.test(base));
}

/**
 * For a file that exists to hold credentials: keep comments and the names on the left of an
 * assignment, replace every value and every other line by its length.
 */
export function maskSensitiveText(text) {
  return String(text).split('\n').map((raw) => {
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    if (!line.trim() || /^\s*(#|\/\/|;)/.test(line)) return maskLine(line) + cr;
    const kv = /^(\s*(?:export\s+)?["']?[A-Za-z_][A-Za-z0-9_.-]*["']?\s*[=:]\s*)(.*)$/.exec(line);
    if (kv) return kv[1] + (kv[2].trim() ? hidden(kv[2]) : kv[2]) + cr;
    return hidden(line) + cr;
  }).join('\n');
}

let homeRegexes = null;

function buildHomeRegexes() {
  const set = new Set();
  const add = (p) => {
    if (!p || p.length < 3) return;
    set.add(p);
    set.add(p.replace(/\\/g, '/'));
    set.add(p.replace(/\\/g, '\\\\')); // as written inside a JSON string
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
    if (m) {
      const rest = m[2].replace(/\\/g, '/');
      set.add(`/${m[1].toLowerCase()}/${rest}`); // Git Bash
      set.add(`/mnt/${m[1].toLowerCase()}/${rest}`); // WSL
    }
  };
  const h = home();
  add(h);
  add(realpathSafe(h));
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...set].sort((a, b) => b.length - a.length)
    .map((v) => new RegExp(`(?<![A-Za-z0-9_.~-])${esc(v)}(?![A-Za-z0-9_-])`, IS_WIN ? 'gi' : 'g'));
}

/** Replace the home directory, in every spelling a config file uses, by `~`. */
export function scrubHome(text) {
  if (typeof text !== 'string' || !text) return text;
  if (!homeRegexes) homeRegexes = buildHomeRegexes();
  let s = text;
  for (const re of homeRegexes) s = s.replace(re, '~');
  return s;
}

/** One-line, masked, home-scrubbed, capped form of a short text (a command, a description, a rule). */
export function inline(text, max = 300) {
  const s = scrubHome(maskText(String(text ?? ''))).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
