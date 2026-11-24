// Masking by key (lib/snapshot/mask.mjs): what must be hidden and what must stay readable, each
// with the exact text that comes out. Line counts never change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskText, maskLine, isSensitiveKey } from '../scripts/lib/snapshot/mask.mjs';
import { scanText } from '../scripts/secret-scan.mjs';
import { hasCredential } from '../scripts/lib/run/secrets.mjs';

// Every secret-looking value is assembled at runtime, so the repository scan finds none in this file.
const join = (...parts) => parts.join('');
const PW7 = join('Zq7', '!kP2'); // 7 characters: shorter than any minimum length
const LONG = join('Wm4', 'nB8xC2vL6', 'pJ9hT3rF7'); // 21 characters, no known prefix
const ESCAPED = join('ab', '\\"', 'Xy9', '\\\\', 'end'); // as written in a file: ab\"Xy9\\end
const TOKEN_GH = `ghp_${'y'.repeat(36)}`;
const LIT = join('real', '-pass', 'word-', '9876', '54'); // 20 characters: the literal part of a value that starts like a reference
const PIN = join('1234', '5678'); // a credential that is a number
const SECRETS = [PW7, LONG, 'Xy9', TOKEN_GH, LIT, PIN];

/** Masks `src`, checks what every masked text must satisfy, and returns the result. */
function masked(src, lang) {
  const out = maskText(src, lang ? { lang } : undefined);
  assert.equal(out.split('\n').length, src.split('\n').length, 'the number of lines is kept');
  for (const s of SECRETS) assert.ok(!out.includes(s), 'a secret survived');
  assert.equal(maskText(out, lang ? { lang } : undefined), out, 'masking twice changes nothing');
  // lib/run/secrets.mjs tells masked text from text copied off the disk by masking it without a hint.
  assert.equal(maskText(out), out, 'the result is a fixed point when the format is not known');
  for (const line of out.split('\n')) assert.equal(maskText(line), line, 'and so is each of its lines, quoted on its own');
  assert.deepEqual(scanText(out), [], 'nothing the scanner flags is left');
  return out;
}

test('JSON: every string under a secret key is hidden, whatever its length, depth or escapes', () => {
  const src = [
    '{',
    '  "model": "sonnet",',
    `  "password": "${PW7}",`,
    `  "apiKey": "${ESCAPED}",`,
    '  "credentials": {',
    '    "type": "basic",',
    `    "value": "${LONG}",`,
    `    "history": ["${PW7}", { "old": "${PW7}" }],`,
    '    "attempts": 3,',
    '    "enabled": true',
    '  },',
    '  "env": {',
    `    "DB_PASSWORD": "${PW7}",`,
    '    "GITHUB_TOKEN": "${GITHUB_TOKEN}",',
    `    "NOTE": "${TOKEN_GH}"`,
    '  },',
    `  "headers": { "Authorization": "Bearer ${LONG}", "X-Api-Key": "${PW7}" }`,
    '}',
  ].join('\n');
  assert.equal(masked(src, 'json'), [
    '{',
    '  "model": "sonnet",',
    '  "password": "…7",',
    '  "apiKey": "…12",',
    '  "credentials": {',
    '    "type": "…5",',
    '    "value": "Wm4n…21",',
    '    "history": ["…7", { "old": "…7" }],',
    '    "attempts": …1,',
    '    "enabled": true',
    '  },',
    '  "env": {',
    '    "DB_PASSWORD": "…7",',
    '    "GITHUB_TOKEN": "${GITHUB_TOKEN}",',
    '    "NOTE": "ghp_…40"',
    '  },',
    '  "headers": { "Authorization": "Bearer Wm4n…21", "X-Api-Key": "…7" }',
    '}',
  ].join('\n'));
});

test('JSON: the four shapes the line patterns missed, with no format hint', () => {
  assert.equal(masked(JSON.stringify({ credentials: { value: LONG } })), '{"credentials":{"value":"Wm4n…21"}}');
  assert.equal(masked(JSON.stringify({ password: `ab"${LONG}` })), '{"password":"…25"}');
  assert.equal(masked(JSON.stringify({ password: PW7 })), '{"password":"…7"}');
  assert.equal(masked(`api_key = """\n${LONG}\n"""`), 'api_key = """\n…21\n"""');
  assert.equal(masked(`api_key = '''\n${LONG}\n'''`), "api_key = '''\n…21\n'''");
});

test('JSON: ordinary settings stay readable', () => {
  const src = [
    '{',
    '  "tokenBudget": 2000,',
    '  "max_tokens": 4096,',
    '  "maxOutputTokens": "8192",',
    '  "apiKeyHelper": "~/bin/key-helper.sh",',
    '  "passwordMinLength": "twelve characters",',
    '  "credentialsFile": "~/.config/app/credentials.json",',
    '  "env": { "DB_PASSWORD_FILE": "/run/secrets/db", "BEARER_TOKEN_ENV_VAR": "MY_SERVICE_TOKEN" },',
    '  "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node hooks/secret-scan.mjs" }] }] },',
    '  "scripts": { "secret-scan": "node scripts/secret-scan.mjs --staged" },',
    '  "mcpServers": { "1password": { "command": "op-mcp", "args": ["--vault", "Private"] } },',
    '  "description": "Rotates tokens and passwords every month."',
    '}',
  ].join('\n');
  assert.equal(maskText(src, { lang: 'json' }), src);
  assert.equal(maskText(src), src);
});

test('JSON: a file cut at the size cap, and a secret left in a comment', () => {
  const cut = `{\n  "secrets": {\n    "a": "${PW7}",\n    "b": ["${PW7}`;
  assert.equal(masked(cut, 'json'), '{\n  "secrets": {\n    "a": "…7",\n    "b": ["…7');
  const commented = `{\n  // "password": "${PW7}"\n  "name": "x"\n}`;
  assert.equal(masked(commented, 'json'), '{\n  // "password": "…7"\n  "name": "x"\n}');
});

test('TOML: multi-line strings, literal strings, arrays, inline tables and table headers', () => {
  const src = [
    'model = "gpt"',
    'max_tokens = 4096',
    'token_budget = 2000',
    '[mcp_servers.secret-scan]',
    'command = "npx"',
    'args = ["-y", "secret-scan-mcp"]',
    '[mcp_servers.db]',
    'command = "psql"',
    `env = { PGPASSWORD = "${PW7}", PGHOST = "localhost" }`,
    '[model_providers.acme]',
    'name = "Acme"',
    'api_key = """',
    LONG,
    `  ${PW7}`,
    '"""',
    "private_key = '''",
    `key ${PW7}`,
    "'''",
    `password = "${ESCAPED}"`,
    `passphrase = '${PW7}\\'`,
    'refresh_tokens = [',
    `  "${PW7}", # the first one`,
    `  '${PW7}',`,
    ']',
    '[model_providers.acme.credentials]',
    'user = "bob"',
    'port = 5432',
    '[other]',
    'name = "kept"',
    `# password = "${PW7}"`,
  ].join('\n');
  assert.equal(masked(src, 'toml'), [
    'model = "gpt"',
    'max_tokens = 4096',
    'token_budget = 2000',
    '[mcp_servers.secret-scan]',
    'command = "npx"',
    'args = ["-y", "secret-scan-mcp"]',
    '[mcp_servers.db]',
    'command = "psql"',
    'env = { PGPASSWORD = "…7", PGHOST = "localhost" }',
    '[model_providers.acme]',
    'name = "Acme"',
    'api_key = """',
    '…21',
    '…9',
    '"""',
    "private_key = '''",
    '…11',
    "'''",
    'password = "…12"',
    "passphrase = '…8'",
    'refresh_tokens = [',
    '  "…7", # the first one',
    "  '…7',",
    ']',
    '[model_providers.acme.credentials]',
    'user = "…3"',
    'port = …4',
    '[other]',
    'name = "kept"',
    '# password = "…7"',
  ].join('\n'));
});

test('YAML: unquoted and block values are hidden, workflow keywords are not', () => {
  const src = [
    'name: CI',
    'permissions:',
    '  id-token: write',
    '  contents: read',
    'jobs:',
    '  rotate-secrets:',
    '    runs-on: ubuntu-latest',
    '    secrets: inherit',
    '    env:',
    '      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}',
    `      REGISTRY_PASSWORD: ${PW7}`,
    '    steps:',
    '      - name: Secret scan',
    '        run: node scripts/secret-scan.mjs',
    '      - uses: example/login@v1',
    '        with:',
    `          password: ${PW7} # inline`,
    `          token: "${PW7}"`,
    '          ssh-private-key: |',
    `            ${LONG}`,
    `            ${PW7}`,
    '          retries: 3',
  ].join('\n');
  assert.equal(masked(src, 'yaml'), [
    'name: CI',
    'permissions:',
    '  id-token: write',
    '  contents: read',
    'jobs:',
    '  rotate-secrets:',
    '    runs-on: ubuntu-latest',
    '    secrets: inherit',
    '    env:',
    '      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}',
    '      REGISTRY_PASSWORD: …7',
    '    steps:',
    '      - name: Secret scan',
    '        run: node scripts/secret-scan.mjs',
    '      - uses: example/login@v1',
    '        with:',
    '          password: …7 # inline',
    '          token: "…7"',
    '          ssh-private-key: |',
    '            …21',
    '            …7',
    '          retries: 3',
  ].join('\n'));
});

test('running text: assignments and headers are hidden wherever they are written', () => {
  const src = [
    `Run \`export GITHUB_TOKEN=${PW7}\` first.`,
    `curl --password=${PW7} -H "X-Api-Key: ${PW7}" -H 'Authorization: Bearer ${PW7}' https://example.invalid`,
    `The file has "password": "${PW7}" and client_secret = '${PW7}' in it.`,
    `{"command": "curl -d '{\\"password\\": \\"${PW7}\\"}' https://example.invalid"}`,
    `$env:API_KEY = "${PW7}"; DB_PASSWORD_2=${PW7}`,
  ].join('\n');
  assert.equal(masked(src, 'markdown'), [
    'Run `export GITHUB_TOKEN=…7` first.',
    `curl --password=…7 -H "X-Api-Key: …7" -H 'Authorization: Bearer …7' https://example.invalid`,
    `The file has "password": "…7" and client_secret = '…7' in it.`,
    `{"command": "curl -d '{\\"password\\": \\"…7\\"}' https://example.invalid"}`,
    '$env:API_KEY = "…7"; DB_PASSWORD_2=…7',
  ].join('\n'));
  assert.equal(maskLine(`Bash(PGPASSWORD=${PW7} psql *)`), 'Bash(PGPASSWORD=…7 psql *)');
});

test('running text: prose, references and switches stay as they are', () => {
  const src = [
    '# Secrets and tokens',
    '',
    'Never commit secrets: use the vault. The password: must be at least 8 characters.',
    'The hook named `secret-scan` runs before every commit; `tokenBudget` is 2000 and max_tokens = 4096.',
    '| token | see `GITHUB_TOKEN` |',
    '- credentials: [ask the team lead]',
    '- "apiKeyHelper": "~/bin/key-helper.sh"',
    '- password: "$DB_PASSWORD" comes from the environment, token: <your token>',
    'Set PASSWORD_MIN_LENGTH=12 and USE_TOKEN=true, then TOKEN=${{ secrets.DEPLOY_TOKEN }}.',
    'The header is written "X-Api-Key: $KEY", and "id-token: write" is a permission.',
    "It says \"token: 'til the end\" and the token isn't valid.",
  ].join('\n');
  for (const lang of ['markdown', 'text', 'shell', null]) assert.equal(maskText(src, lang ? { lang } : undefined), src, String(lang));
});

test('the shape patterns still catch what no key announces', () => {
  const src = [
    `note = "${TOKEN_GH}"`,
    `url: postgres://app:${PW7}@db.example.invalid/app`,
    `Authorization: Bearer ${LONG}`,
  ].join('\n');
  assert.equal(masked(src), [
    'note = "ghp_…40"',
    'url: postgres://app:…7@db.example.invalid/app',
    'Authorization: Bearer Wm4n…21',
  ].join('\n'));
});

// ------------------------------------------------------------------------------------------
// References. A value under a secret name stays readable only when ALL of it is a reference,
// in a syntax that really expands. A reference with a literal before, after or inside it is a
// literal, and so is a number.
// ------------------------------------------------------------------------------------------

test('a value that is a reference from end to end stays readable', () => {
  const references = [
    '${DB_PASSWORD}', '${config.token}', '${env:GITHUB_TOKEN}', '${input:apiKey}',
    '${DB_PASSWORD:-}', "${DB_PASSWORD:-''}", '${DB_PASSWORD:-${FALLBACK_PASSWORD}}', '${DB_PASSWORD:?DB_PASSWORD is required}',
    '$(cat ~/.config/app/token)', '$GITHUB_TOKEN', '$env:ApiKey', '$1', '$@',
    '{{ secrets.API_KEY }}', '${{ secrets.DEPLOY_TOKEN }}', '%API_KEY%', '<your token>', '***', 'xxxx', '...',
    '${USER_PART}${HOST_PART}', 'Bearer ${TOKEN}', 'Basic $BASIC_AUTH',
  ];
  for (const ref of references) {
    const src = JSON.stringify({ password: ref, nested: { apiKey: [ref] } });
    for (const lang of ['json', null]) assert.equal(maskText(src, lang ? { lang } : undefined), src, ref);
    assert.equal(hasCredential(src), false, `${ref} is nothing the run has to refuse`);
  }
  // The same in the files a harness is made of, each read with its own structure and with none.
  const shell = [
    'export GITHUB_TOKEN=$GITHUB_TOKEN',
    'TOKEN=${TOKEN:-}',
    'API_KEY=$(cat ~/.config/app/key)',
    'PASSWORD="$1"',
    'DB_PASSWORD="${DB_PASSWORD:?DB_PASSWORD is required}"',
    'curl -H "Authorization: Bearer $GITHUB_TOKEN" -H "X-Api-Key: ${API_KEY}" https://example.invalid',
  ].join('\n');
  const yaml = [
    'env:',
    '  NPM_TOKEN: ${{ secrets.NPM_TOKEN }}',
    '  password: $DB_PASSWORD',
    '  api_key: !secret api_key',
    '  token: *shared_token',
    '  secrets: inherit',
  ].join('\n');
  const js = [
    "const headers = { Authorization: `Bearer ${token}`, 'X-Api-Key': process.env.API_KEY };",
    'const password = process.env.DB_PASSWORD;',
    'const secret = os.environ["APP_SECRET"]',
  ].join('\n');
  const toml = 'api_key = "${API_KEY}"\nbearer_token_env_var = "MY_SERVICE_TOKEN"\n';
  for (const [src, lang] of [[shell, 'shell'], [yaml, 'yaml'], [js, 'javascript'], [toml, 'toml']]) {
    assert.equal(maskText(src, { lang }), src, lang);
    assert.equal(maskText(src), src, `${lang}, read with no hint`);
  }
});

test('a reference with a literal around it is masked whole', () => {
  // [the value, what is left of it]. Values of 16 characters and more keep their first four.
  const cases = [
    ['${EXAMPLE}' + LIT, '${EX…30'],
    ['$ABC ' + LIT, '$ABC…25'],
    [LIT + '${SUFFIX}', 'real…29'],
    ['${DB_PASSWORD:-' + LIT + '}', '${DB…36'],
    ['${A:-${B:-' + PW7 + '}}', '${A:…19'],
    ['${server.password:' + PW7 + '}', '${se…26'],
    ['${not-a-reference}' + PW7, '${no…25'],
    ['$' + 'ecret123', '…9'],
    ['$' + 'ecret123!', '…10'],
    ['$TOKEN/' + PW7, '…14'],
    ['$TOKEN ' + PW7, '…14'],
    ['$(echo x)' + PW7, '$(ec…16'],
    ['%VAR%' + PW7, '…12'],
    ['<token>' + PW7, '…14'],
    ['{{ x }}' + PW7, '…14'],
    ['${A}:' + PW7, '…12'],
    ['Bearer $TOKEN ' + PW7, 'Bearer …14'],
    ['abcd…40 ' + PW7, '…15'],
  ];
  for (const [value, left] of cases) {
    assert.equal(masked(JSON.stringify({ password: value })), `{"password":"${left}"}`, value);
    assert.equal(masked(JSON.stringify({ secrets: { any: [value] } }), 'json'), `{"secrets":{"any":["${left}"]}}`, value);
  }
  // Unquoted, where a value can be written without quotes.
  assert.equal(masked(`password: $ABC ${LIT}\ntoken: \${TOKEN}${PW7}\napi_key: $lower_case`, 'yaml'), 'password: $ABC…25\ntoken: …15\napi_key: …11');
  assert.equal(masked(`export DB_PASSWORD=\${PREFIX}${PW7}\nTOKEN=$token\nAPI_KEY=$(cat key)${PW7}`, 'shell'), 'export DB_PASSWORD=${PR…16\nTOKEN=…6\nAPI_KEY=$(ca…17');
});

test('a number under a secret name is a credential; true, false and null are not', () => {
  const json = [
    '{',
    `  "password": ${PIN},`,
    '  "pin": 4321,',
    '  "apiKey": -3.5,',
    '  "token": 0,',
    '  "secret": true,',
    '  "passphrase": null,',
    '  "credentials": { "port": 5432, "enabled": false, "retries": [3, 14] },',
    '  "tokenBudget": 2000, "max_tokens": 4096, "password_min_length": 12',
    '}',
  ].join('\n');
  assert.equal(masked(json, 'json'), [
    '{',
    '  "password": …8,',
    '  "pin": 4321,',
    '  "apiKey": …4,',
    '  "token": 0,',
    '  "secret": true,',
    '  "passphrase": null,',
    '  "credentials": { "port": …4, "enabled": false, "retries": […1, …2] },',
    '  "tokenBudget": 2000, "max_tokens": 4096, "password_min_length": 12',
    '}',
  ].join('\n'));
  assert.equal(masked(JSON.stringify({ password: Number(PIN) })), '{"password":…8}');

  const toml = ['max_tokens = 4096', `password = ${PIN}`, 'api_key = 0x1F', 'token = 1', 'secret = false', '[db.credentials]', 'port = 5432', 'since = 2026-01-01'].join('\n');
  assert.equal(masked(toml, 'toml'), ['max_tokens = 4096', 'password = …8', 'api_key = …4', 'token = 1', 'secret = false', '[db.credentials]', 'port = …4', 'since = …10'].join('\n'));

  const yaml = ['max_tokens: 4096', `password: ${PIN}`, 'pin_token: 007', 'token: 0', 'secret: true', 'api_key: ~', 'id-token: write'].join('\n');
  assert.equal(masked(yaml, 'yaml'), ['max_tokens: 4096', 'password: …8', 'pin_token: …3', 'token: 0', 'secret: true', 'api_key: ~', 'id-token: write'].join('\n'));

  // Where the format is not known: after a quoted name any number, in a sentence only a long one.
  assert.equal(
    masked(`{"password": ${PIN}} is what the file says. The password: ${PIN} again, "pin_token": 4321, PASSWORD=4321, but token: 5 minutes is a count.`),
    '{"password": …8} is what the file says. The password: …8 again, "pin_token": …4, PASSWORD=…4, but token: 5 minutes is a count.',
  );
  assert.equal(masked(`module.exports = { password: 4321, secrets: [1234, 5678], retries: 3 };\nconst token = ${PIN};`, 'javascript'), 'module.exports = { password: …4, secrets: […4, …4], retries: 3 };\nconst token = …8;');
});

test('a value that goes on after its first string is masked to its end', () => {
  const js = [
    'module.exports = {',
    `  password: "\${DB_PASSWORD}" + "${PW7}",`,
    `  token: prefix + "${PW7}" + suffix,`,
    `  apiKey: \`key-\${id}-${PW7}\`,`,
    '  secret: "abc".trim(),',
    '};',
  ].join('\n');
  assert.equal(masked(js, 'javascript'), [
    'module.exports = {',
    '  password: "${DB_PASSWORD}" + "…7",',
    '  token: prefix + "…7" + suffix,',
    '  apiKey: `key-…17`,',
    '  secret: "…3".trim(),',
    '};',
  ].join('\n'));

  const shell = [
    `PASSWORD="$PREFIX"${PW7}`,
    `TOKEN=$TOKEN_PREFIX"${PW7}"`,
    `API_KEY="\${A}"'${PW7}'`,
    'DB_PASSWORD="abc"def',
    `curl --password="$BASE"${PW7} https://example.invalid`,
  ].join('\n');
  assert.equal(masked(shell, 'shell'), [
    'PASSWORD="$PREFIX"…7',
    'TOKEN=$TOKEN_PREFIX"…7"',
    'API_KEY="${A}"\'…7\'',
    'DB_PASSWORD="…3"…3',
    'curl --password="$BASE"…7 https://example.invalid',
  ].join('\n'));

  const python = `password = "abc" "def"\ntoken = os.environ["APP_TOKEN"] + "${PW7}"`;
  assert.equal(masked(python, 'python'), 'password = "…3" "…3"\ntoken = os.environ["APP_TOKEN"] + "…7"');

  // A command kept inside a JSON string: the quotes of the value are the escaped ones.
  const command = JSON.stringify({ command: `curl --password="$BASE"${PW7} -H "Authorization: Bearer $TOKEN" https://example.invalid` });
  assert.equal(masked(command, 'json'), '{"command":"curl --password=\\"$BASE\\"…7 -H \\"Authorization: Bearer $TOKEN\\" https://example.invalid"}');
  // A quote doubled inside a string does not let the rest of it through.
  assert.equal(masked(`password: 'it''s ${PW7}'`, 'yaml'), "password: '…2''…9'");
});

test('YAML: a value behind an anchor or a tag is still the value', () => {
  const src = ['defaults:', `  password: &pw ${PW7}`, `  token: &tok "${PW7}"`, `  secret: !!str ${PW7}`, `  credentials: &c { user: "bob", pin: ${PIN} }`, '  api_key: !secret api_key', '  other_password: *pw'].join('\n');
  assert.equal(masked(src, 'yaml'), ['defaults:', '  password: &pw …7', '  token: &tok "…7"', '  secret: !!str …7', '  credentials: &c { user: "…3", pin: …8 }', '  api_key: !secret api_key', '  other_password: *pw'].join('\n'));
});

test('what the masker wrote is left alone, in every format and in none', () => {
  const src = '{"password": "…7", "token": "ghp_…40", "apiKey": "Bearer abcd…22", "pin_token": …4, "secret": "ghp_…", "credentials": { "port": …4, "list": ["…3", …2] }}';
  for (const lang of ['json', 'yaml', 'javascript', 'markdown', null]) assert.equal(maskText(src, lang ? { lang } : undefined), src, String(lang));
  // A line the masker wrote, read again as the file it came from and as a text of no known format.
  const lines = [
    ['password = …8', 'toml'], ['PASSWORD="$PREFIX"…7', 'shell'], ["API_KEY=\"${A}\"'…7'", 'shell'], ['export DB_PASSWORD=${PR…16', 'shell'],
    ['password: &pw …7', 'yaml'], ['token: prefix + "…7" + suffix', 'javascript'], ['apiKey: `key-…17`,', 'javascript'],
  ];
  for (const [line, lang] of lines) for (const hint of [lang, null]) assert.equal(maskText(line, hint ? { lang: hint } : undefined), line, `${line} (${hint})`);
});

// lib/run/secrets.mjs refuses a text when masking it changes it. The two cannot drift apart: what
// leaks past the masker leaks past every barrier of a run, into the state, the board and the
// review record.
test('the barrier of a run detects every value the masker hides', () => {
  const leaking = [
    JSON.stringify({ password: '${EXAMPLE}' + LIT }),
    JSON.stringify({ password: '$ABC ' + LIT }),
    JSON.stringify({ password: Number(PIN) }),
    JSON.stringify({ password: '${not-actually-a-reference}' + LIT }),
    JSON.stringify({ password: '$' + 'ecret123!' }),
    `The file has password: "\${DB_PASSWORD}${PW7}" in it.`,
    `export DB_PASSWORD="$PREFIX"${PW7}`,
    `password: "\${A}" + "${PW7}"`,
  ];
  for (const text of leaking) {
    const out = maskText(text);
    assert.notEqual(out, text, 'the masker changes it');
    for (const s of SECRETS) assert.ok(!out.includes(s), 'and nothing of the literal is left');
    assert.equal(hasCredential(text), true, 'the run refuses it');
    assert.equal(hasCredential(out), false, 'and accepts what the masker wrote instead');
  }
});

test('isSensitiveKey: names that hold a secret, and names that only describe one', () => {
  const yes = ['password', 'Password', 'DB_PASSWORD', 'DB_PASSWORD_2', 'password2', 'clientSecret', 'client_secret', 'secrets', 'credentials',
    'passphrase', 'token', 'access_token', 'accessToken', 'id-token', 'GITHUB_TOKEN', 'refresh_tokens', 'apiKey', 'api_key', 'APIKEY',
    'X-Api-Key', 'private_key', 'AWS_SECRET_ACCESS_KEY', 'SECRET_KEY', 'Authorization', 'bearer', 'bearer_token', '--password', '$env:API_KEY'];
  const no = ['tokens', 'max_tokens', 'maxOutputTokens', 'tokenBudget', 'token_budget', 'tokenizer', 'apiKeyHelper', 'secret-scan', 'secretScanning',
    'password_min_length', 'passwordPolicy', 'credentialsFile', 'credentials_path', 'token_url', 'tokenEndpoint', 'secretName', 'bearer_token_env_var',
    'api_key_env', 'aws_access_key_id', 'private_key_id', 'key', 'author', '1password', 'secrets-manager', 'command', 'model', ''];
  for (const k of yes) assert.equal(isSensitiveKey(k), true, k);
  for (const k of no) assert.equal(isSensitiveKey(k), false, k);
});
