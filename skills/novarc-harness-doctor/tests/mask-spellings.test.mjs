// The masker judges a name by how it reads and a value by what it carries (lib/snapshot/mask.mjs):
// the spellings that hide a secret name, the expressions that hide a literal, and the values
// that are written apart from their name. Each case with the exact text that comes out, and the
// barrier of a run (lib/run/secrets.mjs) refusing every one of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskText, isSensitiveKey } from '../scripts/lib/snapshot/mask.mjs';
import { scanText } from '../scripts/secret-scan.mjs';
import { hasCredential } from '../scripts/lib/run/secrets.mjs';

// Every secret-looking value is assembled at runtime, so the repository scan finds none in this file.
const join = (...parts) => parts.join('');
const PW7 = join('Zq7', '!kP2'); // 7 characters: shorter than any minimum length
const LIT = join('real', '-pass', 'word-', '9876', '54'); // 20 characters, no known prefix
const PIN = join('1234', '5678'); // a credential that is a number
const WORD = join('correct', 'horse'); // 12 letters and nothing else: no shape gives it away
const SECRETS = [PW7, LIT, PIN, WORD];
// A backslash, and a character from its code point: an escape and a letter of another alphabet are
// both built here, so this source holds neither.
const BS = '\\';
const U = (hex) => String.fromCodePoint(parseInt(hex, 16));
const ESCAPED_W = `${BS}u0077`; // the six characters a JSON file writes for an escaped `w`
const ESCAPED_K = `${BS}u006B`;
const ZERO_WIDTH = U('200B');
const CYRILLIC_A = U('430');

/** Masks `src`, checks what every masked text must satisfy, and returns the result. */
function masked(src, lang) {
  const out = maskText(src, lang ? { lang } : undefined);
  assert.equal(out.split('\n').length, src.split('\n').length, 'the number of lines is kept');
  for (const s of SECRETS) assert.ok(!out.includes(s), 'a secret survived');
  assert.equal(maskText(out, lang ? { lang } : undefined), out, 'masking twice changes nothing');
  assert.equal(maskText(out), out, 'the result is a fixed point when the format is not known');
  assert.deepEqual(scanText(out), [], 'nothing the scanner flags is left');
  return out;
}

/** `src` is left exactly as it is, read as `lang` and read with no hint, and the run accepts it. */
function kept(src, lang) {
  assert.equal(maskText(src, { lang }), src, `${lang}: ${src}`);
  assert.equal(maskText(src), src, `no hint: ${src}`);
  assert.equal(hasCredential(src), false, `the run accepts: ${src}`);
}

// ------------------------------------------------------------------------------------------
// Names
// ------------------------------------------------------------------------------------------

test('isSensitiveKey: a name is judged as it reads, not as it is spelled', () => {
  const fullwidth = [...'password'].map((c) => U((c.charCodeAt(0) + 0xfee0).toString(16))).join('');
  const yes = [
    `pass${ESCAPED_W}ord`, `pass${BS}u{77}ord`, `p${BS}x61ssword`, `pass${BS}167ord`, `pass${BS}U00000077ord`, 'pass%77ord',
    `pass${ZERO_WIDTH}word`, `${U('FEFF')}password`, `p${CYRILLIC_A}ssword`, fullwidth, `pa${U('308')}ssword`,
    'PASS_WORD', 'passWord', 'pass-word', 'Pass.Word', 'pass word', `token${BS}n`, `pass${BS}tword`,
    'senha', 'SENHA_DB', 'segredo', 'credencial', `contrase${U('F1')}a`, 'chave_api', 'chave_de_acesso', 'DB_PWD',
  ];
  const no = ['pwd', 'compass', 'keyword', 'tokens', 'max_tokens', 'pass_word_length', 'chave', 'password-stdin', `C:${BS}tools${BS}tokens`];
  for (const k of yes) assert.equal(isSensitiveKey(k), true, JSON.stringify(k));
  for (const k of no) assert.equal(isSensitiveKey(k), false, JSON.stringify(k));
});

test('JSON: a key written with an escape, an invisible character or a lookalike letter is still the key', () => {
  const src = [
    '{',
    `  "pass${ESCAPED_W}ord": "${PW7}",`,
    `  "auth": { "to${ESCAPED_K}en": "${PW7}", "retries": 3 },`,
    `  "pass${ZERO_WIDTH}word": "${PW7}",`,
    `  "p${CYRILLIC_A}ssword": "${PW7}",`,
    `  "PASS_WORD": "${PW7}", "passWord": "${PW7}", "senha": "${PW7}", "db_pwd": "${PW7}",`,
    '  "keyword": "plain", "compass": "north", "pwd": "/srv/app"',
    '}',
  ].join('\n');
  const expected = [
    '{',
    `  "pass${ESCAPED_W}ord": "…7",`,
    `  "auth": { "to${ESCAPED_K}en": "…7", "retries": 3 },`,
    `  "pass${ZERO_WIDTH}word": "…7",`,
    `  "p${CYRILLIC_A}ssword": "…7",`,
    '  "PASS_WORD": "…7", "passWord": "…7", "senha": "…7", "db_pwd": "…7",',
    '  "keyword": "plain", "compass": "north", "pwd": "/srv/app"',
    '}',
  ].join('\n');
  assert.equal(masked(src, 'json'), expected);
  assert.equal(masked(src), expected, 'and the same when the text is only found to be JSON');
  // What JSON.parse reads as `password` is what the masker hides, parent keys included.
  const doc = `{"credentials":{"val${BS}u0075e":"${LIT}"},"note":"x"}`;
  assert.equal(JSON.parse(doc).credentials.value, LIT);
  assert.equal(masked(doc), `{"credentials":{"val${BS}u0075e":"real…20"},"note":"x"}`);
});

test('TOML and YAML: quoted keys with escapes, dotted keys and table headers', () => {
  const toml = [
    `"pass${ESCAPED_W}ord" = "${PW7}"`,
    `auth."to${ESCAPED_K}en" = "${PW7}"`,
    `'pass word' = "${PW7}"`,
    `[servers."cr${BS}u0065dentials"]`,
    'user = "bob"',
    '[other]',
    'keyword = "plain"',
  ].join('\n');
  assert.equal(masked(toml, 'toml'), [
    `"pass${ESCAPED_W}ord" = "…7"`,
    `auth."to${ESCAPED_K}en" = "…7"`,
    `'pass word' = "…7"`,
    `[servers."cr${BS}u0065dentials"]`,
    'user = "…3"',
    '[other]',
    'keyword = "plain"',
  ].join('\n'));

  const yaml = [`"pass${ESCAPED_W}ord": ${PW7}`, `'pass word': "${PW7}"`, `pass${ZERO_WIDTH}word: ${PW7}`, `senha: ${PW7}`, `"to${BS}x6Ben": ${PW7}`, 'keyword: plain'].join('\n');
  assert.equal(masked(yaml, 'yaml'), [`"pass${ESCAPED_W}ord": …7`, `'pass word': "…7"`, `pass${ZERO_WIDTH}word: …7`, 'senha: …7', `"to${BS}x6Ben": …7`, 'keyword: plain'].join('\n'));
});

test('running text: the same names with no structure to help, and one level of quoting further in', () => {
  const src = [
    `The file has "pass${ESCAPED_W}ord": "${PW7}" in it.`,
    `auth."pass${ESCAPED_W}ord" = "${PW7}"`,
    `PASS_WORD=${PW7}`,
    `passWord: "${PW7}"`,
    `{"env": "{${BS}"pass${BS}${ESCAPED_W}ord${BS}": ${BS}"${PW7}${BS}"}"}`,
    `chave_api = "${PW7}"`,
    `https://example.invalid/cb?pass%77ord=${PW7}&next=1`,
  ].join('\n');
  assert.equal(masked(src), [
    `The file has "pass${ESCAPED_W}ord": "…7" in it.`,
    `auth."pass${ESCAPED_W}ord" = "…7"`,
    'PASS_WORD=…7',
    'passWord: "…7"',
    `{"env": "{${BS}"pass${BS}${ESCAPED_W}ord${BS}": ${BS}"…7${BS}"}"}`,
    'chave_api = "…7"',
    'https://example.invalid/cb?pass%77ord=…7&next=1',
  ].join('\n'));
});

// ------------------------------------------------------------------------------------------
// Expressions. One is a reference only when it can be shown to carry no value of its own.
// ------------------------------------------------------------------------------------------

test('a template expression is a reference when it only names things', () => {
  for (const e of ['{{ secrets.API_KEY }}', '${{ secrets.DEPLOY_TOKEN }}', '${{ secrets.A || secrets.B }}', '{{ .Values.token }}', '{{- vault_token -}}', '{{ lookup(env, name) }}']) {
    kept(JSON.stringify({ password: e }), 'json');
  }
  const literal = [
    [`\${{ '${LIT}' }}`, '…29'],
    [`{{ '${PW7}' }}`, '…15'],
    [`{{ ${PIN} }}`, '…14'],
    [`{{ secrets.X || '${PW7}' }}`, '…28'],
    [`{{ format('${PW7}') }}`, '…23'],
    [`{{ secrets['${PW7}'] }}`, '…24'],
  ];
  for (const [e, left] of literal) assert.equal(masked(JSON.stringify({ password: e })), `{"password":"${left}"}`, e);

  const js = [
    'const headers = {',
    '  token: `${getToken()}`,',
    '  apiKey: `${cfg.apiKey ?? fallbackKey}`,',
    '  authorization: `Bearer ${session.token}`,',
    `  secret: \`\${"${PW7}"}\`,`,
    `  password: \`\${${PIN}}\`,`,
    `  passphrase: \`\${decode("${PW7}")}\`,`,
    '};',
  ].join('\n');
  assert.equal(masked(js, 'javascript'), [
    'const headers = {',
    '  token: `${getToken()}`,',
    '  apiKey: `${cfg.apiKey ?? fallbackKey}`,',
    '  authorization: `Bearer ${session.token}`,',
    '  secret: `…12`,',
    '  password: `…11`,',
    '  passphrase: `…20`,',
    '};',
  ].join('\n'));
});

// (Every command and every form it is accepted in: tests/mask-commands.test.mjs.)
test('a command substitution is a reference when its command fetches the value', () => {
  const fetching = [
    'TOKEN=$(cat ~/.config/app/token)',
    'TOKEN=$(cat ~/.config/app/token | head -n 1)',
    'PASSWORD=$(op read op://vault/item/password)',
    'DB_PASSWORD=$(aws secretsmanager get-secret-value --secret-id prod/db --query SecretString --output text | jq -r .password)',
    'GH_TOKEN=$(gh auth token)',
    'API_KEY=$(security find-generic-password -s my-service -w)',
    'SECRET=$(< ~/.secret)',
    'NPM_TOKEN=$(pass show npm/token 2>/dev/null)',
    'VAULT_TOKEN="$(vault kv get -field=token secret/ci)"',
    '$token = $(Get-Content token.txt)',
    'PASSWORD=$($env:DB_PASSWORD)',
    'TOKEN=`cat ~/.token`',
  ].join('\n');
  kept(fetching, 'shell');

  const other = [
    `PASSWORD=$(printf ${LIT})`,
    `TOKEN=$(echo ${PW7})`,
    `API_KEY=$(cat <<< ${PW7})`,
    `SECRET=$(cat ~/.secret; echo ${PW7})`,
    `DB_PASSWORD=$(op read x || echo ${PW7})`,
    'GH_TOKEN=$(./get-token.sh)',
    `NPM_TOKEN=$(aws ssm get-parameter --query "'${PW7}'")`,
    `X_TOKEN=$(cat f | jq -r '"${PW7}"')`,
    `password = "$(printf ${LIT})"`,
    'GH_TOKEN=$(gh api user)',
    `SECRET=$(printf '%s' ${PW7})tail`,
    `TOKEN=\`echo ${PW7}\``,
  ].join('\n');
  assert.equal(masked(other, 'shell'), [
    'PASSWORD=…30',
    'TOKEN=…15',
    'API_KEY=…18',
    'SECRET=…30',
    'DB_PASSWORD=…28',
    'GH_TOKEN=…17',
    'NPM_TOKEN=…44',
    'X_TOKEN=…28',
    'password = "…30"',
    'GH_TOKEN=…14',
    'SECRET=…26',
    'TOKEN=`…12`',
  ].join('\n'));
});

test('code that reads the environment: the name it asks for stays, a fallback is a value', () => {
  const js = [
    'const cfg = {',
    `  password: process.env.DB_PASS || "${PW7}",`,
    `  token: process.env.TOKEN ?? '${PW7}',`,
    '  apiKey: process.env.API_KEY,',
    `  secret: isProd ? "${PW7}" : process.env.SECRET,`,
    '};',
  ].join('\n');
  assert.equal(masked(js, 'javascript'), [
    'const cfg = {',
    '  password: process.env.DB_PASS || "…7",',
    "  token: process.env.TOKEN ?? '…7',",
    '  apiKey: process.env.API_KEY,',
    '  secret: isProd ? "…7" : process.env.SECRET,',
    '};',
  ].join('\n'));

  const python = [
    `password = os.environ.get("DB_PASS", "${PW7}")`,
    `token = os.getenv("TOKEN") or "${PW7}"`,
    'secret = os.environ["APP_SECRET"]',
    `api_key = "${PW7}" if debug else os.getenv("API_KEY")`,
    `pin_token = int(os.getenv("PIN", ${PIN}))`,
  ].join('\n');
  assert.equal(masked(python, 'python'), [
    'password = os.environ.get("DB_PASS", "…7")',
    'token = os.getenv("TOKEN") or "…7"',
    'secret = os.environ["APP_SECRET"]',
    'api_key = "…7" if debug else os.getenv("API_KEY")',
    'pin_token = int(os.getenv("PIN", …8))',
  ].join('\n'));

  const anywhere = [
    `$password = $env:DB_PASS ?? '${PW7}'`,
    `password ||= "${PW7}"`,
    `secret = ENV.fetch("APP_SECRET", "${PW7}")`,
    `token = decrypt("${PW7}")`,
    `"password": os.getenv("X") or "${PW7}"`,
    `apiKey: process.env.API_KEY || "${PW7}"`,
  ].join('\n');
  assert.equal(masked(anywhere), [
    "$password = $env:DB_PASS ?? '…7'",
    'password ||= "…7"',
    'secret = ENV.fetch("APP_SECRET", "…7")',
    'token = decrypt("…7")',
    '"password": os.getenv("X") or "…7"',
    'apiKey: process.env.API_KEY || "…7"',
  ].join('\n'));

  kept('const password = process.env.DB_PASSWORD ?? process.env.FALLBACK_PASSWORD;\nconst token = getToken(config.name);', 'javascript');
  kept('client = Client(api_key=api_key, password=pw)\nconnect(host=h, user=u, password=pw)\nsecret = os.environ["APP_SECRET"]', 'python');
});

// ------------------------------------------------------------------------------------------
// Values written apart from their name
// ------------------------------------------------------------------------------------------

test('a flag that takes a secret: its value is the next word, or the next element of the list', () => {
  const src = [
    `{"mcpServers":{"db":{"command":"npx","args":["-y","db-mcp","--api-key","${PW7}","--verbose"]}}}`,
    `args = ['--password', '${WORD}']`,
    `spawn("tool", ["--token", "${PW7}"])`,
    `npx db-mcp --api-key ${PW7} --verbose`,
    `tool --password "${WORD}" -token '${PW7}'`,
    `{"command": "npx db-mcp --client-secret ${PW7}"}`,
    `sh -c "tool --token '${PW7}'"`,
  ].join('\n');
  assert.equal(masked(src), [
    '{"mcpServers":{"db":{"command":"npx","args":["-y","db-mcp","--api-key","…7","--verbose"]}}}',
    "args = ['--password', '…12']",
    'spawn("tool", ["--token", "…7"])',
    'npx db-mcp --api-key …7 --verbose',
    `tool --password "…12" -token '…7'`,
    '{"command": "npx db-mcp --client-secret …7"}',
    `sh -c "tool --token '…7'"`,
  ].join('\n'));

  const yaml = ['args:', '  - --api-key', `  - ${PW7}`, '  - "--token"', `  - "${WORD}"`, '  - --verbose'].join('\n');
  assert.equal(masked(yaml, 'yaml'), ['args:', '  - --api-key', '  - …7', '  - "--token"', '  - "…12"', '  - --verbose'].join('\n'));
  // In a script a bare word after such a flag is always its argument.
  assert.equal(masked(`tool --password ${WORD}\nConnect-Thing -ApiKey ${WORD}`, 'shell'), 'tool --password …12\nConnect-Thing -ApiKey …12');

  const stays = [
    'Pass --token to the command, or --password when asked; --api-key YOUR_API_KEY works too.',
    '| --token | the token to use | --token <your token> |',
    'tool --token $TOKEN --password "${DB_PASSWORD}" --api-key "$(cat ~/.key)" --secret --verbose',
    'tool --password-stdin registry.example.invalid --token-file /run/secrets/t --secret-id prod/db',
    '{"args":["--token","$TOKEN","--api-key","${API_KEY}","--secret","--verbose"]}',
    'const usage = "use --token " + name;',
  ].join('\n');
  kept(stays, 'markdown');
});

test('pairs: in a string, in a row, in a query string, after a scheme, and the credentials of a request', () => {
  const src = [
    `curl -d "password=${PW7}" -d 'user=bob&token=${PW7}' https://example.invalid`,
    `Server=db.example.invalid;Database=app;User ID=bob;Password=${WORD};`,
    `host=localhost user=bob password=${WORD} dbname=app`,
    `"url": "https://example.invalid/sse?pass%77ord=${PW7}&next=1"`,
    `curl -u bob:${WORD} https://example.invalid`,
    `curl -s --user "bob:${PW7}" https://example.invalid`,
    `API_TOKEN=Bearer ${WORD}`,
    `password = "${PW7}`,
    `password = "${PW7}"tail`,
  ].join('\n');
  assert.equal(masked(src), [
    `curl -d "password=…7" -d 'user=bob&token=…7' https://example.invalid`,
    'Server=db.example.invalid;Database=app;User ID=bob;Password=…12;',
    'host=localhost user=bob password=…12 dbname=app',
    '"url": "https://example.invalid/sse?pass%77ord=…7&next=1"',
    'curl -u bob:…12 https://example.invalid',
    'curl -s --user "bob:…7" https://example.invalid',
    'API_TOKEN=Bearer …12',
    'password = "…7',
    'password = "…7"…4',
  ].join('\n'));
  kept('connect(host=h, user=u, password=pw)\ncurl -u "$USER:$PASS" https://example.invalid && docker run -u 1000:1000 image\n"header": "Authorization: ", "next": 1', 'text');
});

test('notes and files of no known format: an unquoted word after a secret name', () => {
  const src = [
    `password = ${WORD}`,
    `  token: ${PW7}  ; rotated in March`,
    `- DB password: ${PW7}`,
    `The token: ab${PIN} expired, and the secret: \`${WORD}\` is old.`,
    `//registry.example.invalid/:_authToken=${PW7}`,
    'The password: must be long. token: see below. secret: none',
    'token = cfg.token',
    '- token: `$GITHUB_TOKEN`, password: `<your password>`',
  ].join('\n');
  const expected = [
    'password = …12',
    '  token: …7  ; rotated in March',
    '- DB password: …7',
    'The token: …10 expired, and the secret: `…12` is old.',
    '//registry.example.invalid/:_authToken=…7',
    'The password: must be long. token: see below. secret: none',
    'token = cfg.token',
    '- token: `$GITHUB_TOKEN`, password: `<your password>`',
  ].join('\n');
  assert.equal(masked(src, 'markdown'), expected);
  assert.equal(masked(src, 'text'), expected);
  // Read as code, or with no hint at all, a bare word after a name is as often another name.
  assert.equal(maskText('token = cfg.token\npassword = pw', { lang: 'python' }), 'token = cfg.token\npassword = pw');
  assert.equal(maskText(`The secret: \`${WORD}\` is old.`), 'The secret: `…12` is old.');
});

// ------------------------------------------------------------------------------------------
// The barrier
// ------------------------------------------------------------------------------------------

test('the barrier of a run refuses each of these spellings', () => {
  const leaking = [
    // The four texts of the third review round.
    `{"pass${ESCAPED_W}ord":"${LIT}"}`,
    `{"credentials":{"val${BS}u0075e":"${LIT}"}}`,
    `password = "$(printf ${LIT})"`,
    `password = "\${{ '${LIT}' }}"`,
    // Their kin.
    `{"note": "{${BS}"pass${BS}${ESCAPED_W}ord${BS}": ${BS}"${PW7}${BS}"}"}`,
    `"pass${ZERO_WIDTH}word": "${PW7}"`,
    `"p${CYRILLIC_A}ssword": "${PW7}"`,
    `auth."pass${ESCAPED_W}ord" = "${PW7}"`,
    `password: process.env.DB_PASS || "${PW7}"`,
    `password = os.environ.get("DB_PASS", "${PW7}")`,
    `TOKEN=$(echo ${PW7})`,
    `TOKEN=\`echo ${PW7}\``,
    `{"password":"{{ secrets.X || '${PW7}' }}"}`,
    `{"args":["--api-key","${PW7}"]}`,
    `tool --password ${PW7}`,
    `https://example.invalid/cb?pass%77ord=${PW7}`,
    `curl -u bob:${PW7} https://example.invalid`,
  ];
  for (const text of leaking) {
    const out = maskText(text);
    assert.notEqual(out, text, `the masker changes it: ${text}`);
    for (const s of SECRETS) assert.ok(!out.includes(s), `nothing of the literal is left: ${text}`);
    assert.equal(hasCredential(text), true, `the run refuses it: ${text}`);
    assert.equal(hasCredential(out), false, `and accepts what the masker wrote instead: ${out}`);
  }
});
