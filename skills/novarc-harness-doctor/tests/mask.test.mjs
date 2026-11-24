// Masking by key (lib/snapshot/mask.mjs): what must be hidden and what must stay readable, each
// with the exact text that comes out. Line counts never change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskText, maskLine, isSensitiveKey } from '../scripts/lib/snapshot/mask.mjs';
import { scanText } from '../scripts/secret-scan.mjs';

// Every secret-looking value is assembled at runtime, so the repository scan finds none in this file.
const join = (...parts) => parts.join('');
const PW7 = join('Zq7', '!kP2'); // 7 characters: shorter than any minimum length
const LONG = join('Wm4', 'nB8xC2vL6', 'pJ9hT3rF7'); // 21 characters, no known prefix
const ESCAPED = join('ab', '\\"', 'Xy9', '\\\\', 'end'); // as written in a file: ab\"Xy9\\end
const TOKEN_GH = `ghp_${'y'.repeat(36)}`;
const SECRETS = [PW7, LONG, 'Xy9', TOKEN_GH];

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
    '    "attempts": 3,',
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
    'port = 5432',
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
