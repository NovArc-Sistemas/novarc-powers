// A command substitution is a reference only in a verified form (lib/snapshot/mask.mjs,
// COMMAND_FORMS). Knowing that a command fetches a value says nothing about its arguments, so
// for every command the masker accepts: the forms that stay readable, and forms of the same
// command that carry a text of their own, each masked whole. Then the same reasoning for the
// other exemptions (a name that reads like a value is the value) and for the commands that are
// handed a credential as an argument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskText, isSensitiveKey } from '../scripts/lib/snapshot/mask.mjs';
import { scanText } from '../scripts/secret-scan.mjs';
import { hasCredential } from '../scripts/lib/run/secrets.mjs';

// Every secret-looking value is assembled at runtime, so the repository scan finds none in this file.
const join = (...parts) => parts.join('');
const VALUE = join('test', 'Session', 'Credential', '9876', '54'); // 27 characters: long and mixed, the way a key is
const MASTER = join('test', 'Master', 'Credential', '9876', '54'); // 26 characters
const MIXED = join('aB3x', 'K9mQ', '2pL7'); // 12 characters, letters and digits
const PW7 = join('Zq7', '!kP2'); // 7 characters, with a symbol no name has
const PW10 = join('hunter', '2Zq7'); // 10 characters, a word and a few more
const SECRETS = [VALUE, MASTER, MIXED, PW7, PW10];

/** Masks `src`, checks what every masked text must satisfy, and returns the result. */
function masked(src, lang) {
  const out = maskText(src, lang ? { lang } : undefined);
  assert.notEqual(out, src, `masked: ${src}`);
  assert.equal(out.split('\n').length, src.split('\n').length, 'the number of lines is kept');
  for (const s of SECRETS) assert.ok(!out.includes(s), `a secret survived: ${src}`);
  assert.equal(maskText(out, lang ? { lang } : undefined), out, `masking twice changes nothing: ${src}`);
  assert.equal(maskText(out), out, `a fixed point when the format is not known: ${src}`);
  assert.deepEqual(scanText(out), [], 'nothing the scanner flags is left');
  assert.equal(hasCredential(src), true, `the run refuses it: ${src}`);
  assert.equal(hasCredential(out), false, `and accepts what the masker wrote: ${out}`);
  return out;
}

/** `src` is left exactly as it is, read as `lang` and read with no hint, and the run accepts it. */
function kept(src, lang) {
  assert.equal(maskText(src, { lang }), src, `${lang}: ${src}`);
  assert.equal(maskText(src), src, `no hint: ${src}`);
  assert.equal(hasCredential(src), false, `the run accepts: ${src}`);
}

// For each command: the forms it is accepted in, and forms that are not, each with the length
// of the `$(...)` that is hidden in its place (`TOKEN=$(cmd)` becomes `TOKEN=…N`).
const COMMANDS = {
  cat: {
    accepted: ['cat /run/secrets/pw', 'cat ~/.config/app/token', 'cat $HOME/.token', 'cat ${XDG_CONFIG_HOME}/app/key', 'sudo cat /etc/app/secret', '< ~/.secret', '<~/.secret', 'cat ~/.token 2>/dev/null'],
    refused: [[`cat "${VALUE}"`, 36], [`cat ${VALUE}`, 34], ['cat a b', 10], ['cat -A f', 11], ['/usr/bin/cat f', 17], ['cat ~/.tok*', 14], [`cat f; printf ${VALUE}`, 44]],
  },
  type: { accepted: ['type C:/secrets/token.txt'], refused: [[`type ${VALUE}`, 35]] },
  'Get-Content': {
    accepted: ['Get-Content token.txt', 'Get-Content -Path ./token.txt -Raw', 'gc token.txt'],
    refused: [[`Get-Content ${VALUE}`, 42], [`gc -Path ${VALUE}`, 39], [`Get-Content token.txt -Encoding ${VALUE}`, 62]],
  },
  'Get-Secret': {
    accepted: ['Get-Secret -Name ApiToken -AsPlainText', 'Get-Secret ApiToken -Vault Work'],
    refused: [[`Get-Secret -Name ApiToken -Password ${PW7}`, 46], [`Get-Secret -Name ${VALUE}`, 47]],
  },
  op: {
    accepted: ['op read op://vault/item/password', 'op read op://vault/item/password --no-newline', 'op item get GitHub --fields token --vault Private'],
    refused: [[`op read op://vault/item/password --session ${VALUE}`, 73], ['op read "op://vault/item/password"', 37], ['op signin --raw', 18], ['op item get GitHub', 21], [`op read ${VALUE}`, 38]],
  },
  pass: { accepted: ['pass show npm/token', 'pass npm/token'], refused: [[`pass show ${VALUE}`, 40], ['pass insert npm/token', 24]] },
  gopass: { accepted: ['gopass show -o work/db'], refused: [[`gopass show --password ${PW7}`, 33], [`gopass show ${VALUE}`, 42]] },
  bw: {
    accepted: ['bw get password github.com', 'bw get password item --raw', 'bw get password item --session $BW_SESSION'],
    refused: [[`bw unlock '${VALUE}' --raw`, 48], [`bw get password item --session ${VALUE}`, 61], [`bw unlock ${VALUE} --raw`, 46], [`bw get password ${VALUE}`, 46], ['bw encode', 12]],
  },
  vault: {
    accepted: ['vault kv get -field=token secret/ci', 'vault read -field password secret/data/db'],
    refused: [[`vault login ${VALUE}`, 42], ['vault kv get secret/ci', 25], [`vault kv put secret/ci token=${PW7}`, 39], [`vault kv get -field=token secret/ci -token=${VALUE}`, 73]],
  },
  doppler: {
    accepted: ['doppler secrets get API_KEY --plain', 'doppler secrets get API_KEY --plain --project web --config prd'],
    refused: [[`doppler secrets get API_KEY --plain --token ${VALUE}`, 74], [`doppler secrets set API_KEY ${PW7}`, 38]],
  },
  aws: {
    accepted: [
      'aws secretsmanager get-secret-value --secret-id prod/db --query SecretString --output text',
      'aws ssm get-parameter --name /prod/db/password --with-decryption --query Parameter.Value --output text',
      'aws ecr get-login-password --region us-east-1',
    ],
    refused: [
      [`aws secretsmanager get-secret-value --secret-id ${VALUE}`, 78], [`aws configure set aws_secret_access_key ${VALUE}`, 70],
      [`aws secretsmanager get-secret-value --secret-id prod/db --query "'${PW7}'"`, 78], [`aws ssm put-parameter --name /prod/db --value ${PW7}`, 56],
    ],
  },
  gcloud: {
    accepted: ['gcloud secrets versions access latest --secret=db-password', 'gcloud auth print-access-token'],
    refused: [[`gcloud secrets versions access latest --secret=db --access-token-file ${VALUE}`, 100], ['gcloud auth login --cred-file x', 34], [`gcloud secrets versions access latest --secret=${VALUE}`, 77]],
  },
  az: {
    accepted: ['az keyvault secret show --vault-name kv-prod --name db-password --query value -o tsv', 'az account get-access-token --query accessToken -o tsv'],
    refused: [[`az keyvault secret show --name db --vault-name kv --query value -o tsv --password ${PW7}`, 92], [`az login -u bob -p ${PW7}`, 29], [`az keyvault secret set --name db --value ${PW7}`, 51]],
  },
  gh: { accepted: ['gh auth token', 'gh auth token --hostname github.example.com'], refused: [[`gh auth token --hostname ${VALUE}`, 55], ['gh api user', 14], ['gh auth login --with-token', 29]] },
  security: {
    accepted: ['security find-generic-password -s my-service -a bob -w', 'security find-internet-password -s example.com -w'],
    refused: [[`security find-generic-password -s my-service -w -p ${PW7}`, 61], [`security unlock-keychain -p ${PW7}`, 38], [`security add-generic-password -s svc -w ${VALUE}`, 70]],
  },
  'secret-tool': { accepted: ['secret-tool lookup service myapp'], refused: [[`secret-tool lookup service ${VALUE}`, 57], ['secret-tool store --label=x service myapp', 44]] },
  keyring: { accepted: ['keyring get myapp bob'], refused: [[`keyring get myapp ${VALUE}`, 48], ['keyring set myapp bob', 24]] },
  sops: { accepted: ['sops -d secrets.enc.yaml', 'sops decrypt secrets.enc.yaml'], refused: [[`sops --encrypt --age ${VALUE} f`, 53], [`sops -d ${VALUE}`, 38]] },
  jq: { accepted: ['jq -r .token config.json'], refused: [[`jq -r '"${PW7}"' f`, 22], [`jq -n ${VALUE}`, 36], [`jq -r .token ${VALUE}`, 43]] },
  'what the output is piped through': {
    accepted: [
      'cat .env | grep API_KEY | cut -d= -f2', 'cat f | head -n 1', 'cat f | tail -1', 'cat f | base64 -d', 'cat f | jq -r .data.token',
      'aws secretsmanager get-secret-value --secret-id prod/db --query SecretString --output text | jq -r .password',
    ],
    refused: [
      [`cat f | tr a ${VALUE}`, 43], ["cat f | tr -d '\\n'", 21], [`cat f | grep ${VALUE}`, 43], ["cat f | jq -r '.a'", 21], [`cat f | sed s/a/${PW7}/`, 27],
      ['cat f | xargs echo', 21], [`cat f || echo ${PW7}`, 24], [`cat f | head -n 1 | tee ${VALUE}`, 54],
    ],
  },
  'a command that is not in the table': {
    accepted: ['$env:TOKEN'],
    refused: [[`echo ${PW7}`, 15], [`printf ${VALUE}`, 37], ['./get-token.sh', 17], [`bw get password item --session=${VALUE}`, 61], ['bw get password item --session', 33], [`bw get password item --${VALUE} $X`, 56]],
  },
};

for (const [command, { accepted, refused }] of Object.entries(COMMANDS)) {
  test(`${command}: the accepted forms stay readable, any other is masked whole`, () => {
    for (const form of accepted) kept(`TOKEN=$(${form})`, 'shell');
    for (const [form, length] of refused) {
      assert.equal(`$(${form})`.length, length, `the table has the length of: ${form}`);
      assert.equal(masked(`TOKEN=$(${form})`, 'shell'), `TOKEN=…${length}`, form);
    }
  });
}

test('the two forms of the fourth review round, as they were written', () => {
  assert.equal(masked(`token = "$(bw unlock '${MASTER}' --raw)"`), 'token = "…47"');
  assert.equal(masked(`password = "$(bw get password item --session ${VALUE})"`), 'password = "…61"');
  assert.equal(masked(`password = "$(cat /run/secrets/pw | tr a ${VALUE})"`), 'password = "…57"');
  assert.equal(masked(`password = "$(cat /run/secrets/pw; printf ${VALUE})"`), 'password = "…58"');
  kept('password = "$(cat /run/secrets/pw)"', 'shell');
  // Between backticks, the older spelling of the same thing.
  assert.equal(masked(`TOKEN=\`bw unlock ${VALUE} --raw\``, 'shell'), 'TOKEN=`bw…43`');
  kept('TOKEN=`cat /run/secrets/pw`', 'shell');
});

test('a name that reads like a value is the value, wherever a name is exempt', () => {
  const cases = [
    [`password = "\${${VALUE}}"`, 'password = "…30"'],
    [`password = "$${VALUE.toUpperCase()}"`, 'password = "…28"'],
    [`{"password":"{{ secrets.${VALUE} }}"}`, '{"password":"…41"}'],
    [`password = "<${VALUE}>"`, 'password = "<tes…29"'],
    [`password = "%${VALUE}%"`, 'password = "%tes…29"'],
    [`password = os.getenv("${VALUE}")`, 'password = os.getenv("test…27")'],
    [`password = os.environ["${VALUE}"]`, 'password = os.environ["test…27"]'],
    [`const password = process.env.${VALUE};`, 'const password = proc…39;'],
    [`password = cfg["${PW7}"]`, 'password = cfg["…7"]'],
    [`password = os.environ.get("DB_PASS", "${PW7}")`, 'password = os.environ.get("DB_PASS", "…7")'],
    [`password = \${DB_PASSWORD:?${VALUE}}`, 'password = ${DB_PASSWORD:?test…27}'],
    [`password = "\${DB_PASSWORD:?use ${PW10}}"`, 'password = "…30"'],
    [`password = ${VALUE}`, 'password = test…27'],
    [`password: ${MIXED}`, 'password: …12'],
    [`token = decode( ${MIXED} )`, 'token = decode( …12 )'],
    [`secrets: [${MIXED}, name]`, 'secrets: […12, name]'],
    [`api_key: !secret ${MIXED}`, 'api_key: !secret …12'],
    [`token: *${MIXED}`, 'token: *…12'],
    [`tool --secret-id ${VALUE}`, 'tool --secret-id test…27'],
    [`{"args":["--secret-id","${MIXED}"]}`, '{"args":["--secret-id","…12"]}'],
  ];
  for (const [src, expected] of cases) assert.equal(masked(src), expected, src);
  // Read as YAML the whole scalar is the value: a tag in front of it is no longer a reference.
  assert.equal(masked(`api_key: !secret ${MIXED}\ntoken: *${MIXED}`, 'yaml'), 'api_key: !sec…20\ntoken: …13');

  const names = [
    'password = "${GITHUB_TOKEN}"', 'password = "$NEXT_PUBLIC_SUPABASE_ANON_KEY"', '{"password":"${{ secrets.productionDatabasePassword }}"}',
    'password = "${DB_PASSWORD:?DB_PASSWORD is required}"', 'const password = process.env.DB_PASSWORD;', 'password = os.environ["DB_PASSWORD"]',
    'token = cfg.token', 'password = pw', 'api_key: !secret api_key', 'token: *shared_token', 'tool --secret-id prod/db',
  ];
  // Read as code: in a file of prose or of no known format a line that is only `name = word`
  // is a line of configuration, and its word a value (tests/mask-spellings.test.mjs).
  for (const src of names) kept(src, 'python');
});

test('a command that is handed a credential as an argument, under any name', () => {
  assert.equal(isSensitiveKey('BW_SESSION'), true);
  assert.equal(isSensitiveKey('OP_SESSION_my'), true);
  for (const k of ['session', 'tokensPerSession', 'tokens_per_session', 'SessionStart']) assert.equal(isSensitiveKey(k), false, k);

  const json = [
    '{',
    `  "env": { "BW_SESSION": "$(bw unlock '${MASTER}' --raw)", "DB_PASSWORD": "$(cat /run/secrets/pw)" },`,
    `  "hooks": [{ "type": "command", "command": "bw unlock '${MASTER}' --raw" }],`,
    `  "note": "bw unlock ${PW10} --raw && bw sync"`,
    '}',
  ].join('\n');
  assert.equal(masked(json, 'json'), [
    '{',
    '  "env": { "BW_SESSION": "…47", "DB_PASSWORD": "$(cat /run/secrets/pw)" },',
    `  "hooks": [{ "type": "command", "command": "bw unlock 'test…26' --raw" }],`,
    '  "note": "bw unlock …10 --raw && bw sync"',
    '}',
  ].join('\n'));

  const shell = [
    `export BW_SESSION=$(bw unlock ${PW10} --raw)`,
    `bw login bob@example.invalid ${PW10}`,
    `vault login ${PW10}`,
    `sshpass -p ${PW10} ssh host`,
    `docker login -u bob -p ${PW10} registry.example.invalid`,
    `mysql -u root -p${PW10} app`,
  ].join('\n');
  assert.equal(masked(shell, 'shell'), [
    'export BW_SESSION=…29',
    'bw login bob@example.invalid …10',
    'vault login …10',
    'sshpass -p …10 ssh host',
    'docker login -u bob -p …10 registry.example.invalid',
    'mysql -u root -p…10 app',
  ].join('\n'));
  assert.equal(masked(`Run \`bw unlock ${PW10}\` and then sync.`, 'markdown'), 'Run `bw unlock …10` and then sync.');

  kept('Run bw unlock first, then vault login again; ssh login@host -p 2222; mysql -u root -p app', 'markdown');
  kept('bw unlock --raw; bw unlock $BW_PASSWORD; vault login -method=github; docker login -u bob --password-stdin', 'shell');
  kept('"tokensPerSession": 100000, "session": "tester", "perSession": 12345678', 'json');
});
