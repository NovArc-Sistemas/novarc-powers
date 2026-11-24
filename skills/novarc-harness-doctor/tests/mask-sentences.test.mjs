// Masking in running text (lib/snapshot/mask.mjs, maskSentences): the value a sentence gives a
// secret noun, in English and in Portuguese, in instruction files, docs, comments and notes. Each
// case has the exact text that comes out; prose that only talks about a secret stays as it is.
// A field test leaked three of eighteen fake secrets this way ("password is ...", "chave ...",
// "use secret ..."); every shape it named is here, at line start and mid-sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskText, maskLine } from '../scripts/lib/snapshot/mask.mjs';
import { hasCredential } from '../scripts/lib/run/secrets.mjs';

// Every secret-looking value is assembled at runtime, so the repository scan finds none in this
// file. None has a prefix the scanner knows and none is 16 characters of [A-Za-z0-9_-], so what
// the barrier sees in them is this rule, not the scanner's patterns.
const join = (...parts) => parts.join('');
const HUNTER = join('hun', 'ter', '2'); // 7
const SUPER = join('Sup3r', 'S3cr', 'et!'); // 12
const SK = join('sk9', 'Ab3', 'xYz'); // 9
const WX = join('wX9p', 'Q2zL'); // 8
const MUDAR = join('Mudar', '@', '123'); // 9
const SWORD = join('sword', 'fish'); // 9, letters only
const ABACAXI = join('aba', 'caxi'); // 7, letters only
const H2024 = join('Hunter', '2024'); // 10
const QW = join('Qw3r', 'ty99'); // 8
const PIN4 = join('48', '21'); // 4
const AB = join('Ab12', 'Cd34', 'Ef'); // 10
const HEX = join('9f8e', '7d6c', '5b'); // 10
const M123 = join('Mudar', '123'); // 8
const DIG6 = join('739', '214'); // 6
const PHRASE = join('correct ', 'horse ', 'battery ', 'staple'); // 28
const LONG = join('Zx81', 'Qw72', '!Er63', 'Ty54'); // 17: long enough to keep its first four characters
const SECRETS = [HUNTER, SUPER, SK, WX, MUDAR, SWORD, ABACAXI, H2024, QW, AB, HEX, M123, DIG6, PHRASE, LONG];

// [text, what comes out, the language of the file it stands in (null: a note of no known format)]
const POSITIVE = [
  // "password is ...": English, then Portuguese
  [`password is ${HUNTER}`, 'password is …7', null],
  [`The password is ${SUPER}`, 'The password is …12', 'markdown'],
  [`If it asks, the password is ${SWORD}.`, 'If it asks, the password is …9.', 'markdown'],
  [`My password is "${HUNTER}" for now.`, 'My password is "…7" for now.', 'markdown'],
  [`Don't share it: the password is '${HUNTER}'`, "Don't share it: the password is '…7'", 'text'],
  [`the \`password\` is \`${HUNTER}\``, 'the `password` is `…7`', 'markdown'],
  [`The password for staging is ${QW}, rotate it monthly.`, 'The password for staging is …8, rotate it monthly.', 'markdown'],
  [`- **Password:** ${H2024}`, '- **Password:** …10', 'markdown'],
  [`pass phrase: "${PHRASE}"`, 'pass phrase: "corr…28"', 'text'],
  [`my password: ${DIG6}`, 'my password: …6', null],
  [`<!-- password is ${HUNTER} -->`, '<!-- password is …7 -->', 'markdown'],
  [`a senha é ${MUDAR}`, 'a senha é …9', null],
  [`A senha do banco é ${M123}.`, 'A senha do banco é …8.', 'markdown'],
  [`Para entrar, a senha é ${ABACAXI}`, 'Para entrar, a senha é …7', 'markdown'],
  [`senha: ${M123}`, 'senha: …8', 'text'],
  [`* a senha fica "${HUNTER}" até trocar`, '* a senha fica "…7" até trocar', 'markdown'],
  // "chave ...": the noun and the value with nothing between them
  [`chave ${SK}`, 'chave …9', null],
  [`Use a chave ${SK} no header.`, 'Use a chave …9 no header.', 'markdown'],
  [`a chave de api é ${HEX}`, 'a chave de api é …10', 'markdown'],
  [`# a chave secreta é "${MUDAR}"`, '# a chave secreta é "…9"', 'shell'],
  [`Passe a credencial ${AB} pro script.`, 'Passe a credencial …10 pro script.', 'markdown'],
  [`o segredo é ${MUDAR}`, 'o segredo é …9', 'text'],
  [`código de acesso: ${DIG6}`, 'código de acesso: …6', 'markdown'],
  // "use secret ..."
  [`use secret ${WX}`, 'use secret …8', null],
  [`Then use secret ${WX} to sign the webhook.`, 'Then use secret …8 to sign the webhook.', 'markdown'],
  [`1. Set the API key to ${AB} before running.`, '1. Set the API key to …10 before running.', 'markdown'],
  [`the secret key is "${HUNTER}"`, 'the secret key is "…7"', 'markdown'],
  [`token ${LONG}`, 'token Zx81…17', null],
  // tokens, PINs and credentials, in comments of code and in lists
  [`// token: ${AB}`, '// token: …10', 'javascript'],
  [`# api key = ${AB}`, '# api key = …10', 'python'],
  [`o token é o ${AB}`, 'o token é o …10', null],
  [`O token fica ${AB} até amanhã.`, 'O token fica …10 até amanhã.', 'markdown'],
  [`* Token: \`${AB}\``, '* Token: `…10`', 'markdown'],
  [`the access token is ${AB}`, 'the access token is …10', 'markdown'],
  [`credentials: ${AB}`, 'credentials: …10', 'text'],
  [`PIN ${PIN4}`, 'PIN …4', null],
  [`The PIN is ${PIN4}.`, 'The PIN is …4.', 'markdown'],
];

// Prose that names a secret and holds none, each with its language. It must come out unchanged.
const NEGATIVE = [
  ['the password is stored in 1Password', 'markdown'],
  ['a senha fica no cofre', 'markdown'],
  ['use secret scanning', 'markdown'],
  ['token budget is 2000', 'markdown'],
  ['a chave do objeto é o id', 'markdown'],
  ['set the token in the environment', 'markdown'],
  ['set the token to expire in 1h', 'markdown'],
  ['the password is required', 'markdown'],
  ['a senha é obrigatória', 'markdown'],
  ['a senha é a mesma do e-mail', 'markdown'],
  ['the token is $GITHUB_TOKEN', 'markdown'],
  ['the api key is ${API_KEY}', 'markdown'],
  ['the token is <your-token>', 'markdown'],
  ['the secret key is %SECRET_KEY%', 'text'],
  ['read the password from op://vault/item/password', 'markdown'],
  ['the token is base64 encoded', 'markdown'],
  ['the password is hashed with argon2id', 'markdown'],
  ['the secret is out', 'markdown'],
  ['the token `max_tokens` counts output', 'markdown'],
  ['add the secret `GITHUB_TOKEN` to the repository', 'markdown'],
  ['the secret `CLAUDE_CODE_OAUTH_TOKEN` is set by the action', 'markdown'],
  ['the token file ~/.config/gh/hosts.yml', 'markdown'],
  ['the private key is ~/.ssh/id_ed25519', 'markdown'],
  ['credentials file at ./creds.json', 'markdown'],
  ['the API key lives in .env.local', 'markdown'],
  ['the token is the bottleneck', 'markdown'],
  ['the token is null', 'markdown'],
  ['the PIN is 12', 'markdown'],
  ['token v2 is out', 'markdown'],
  ['the token is v1.2.3', 'markdown'],
  ['the token gpt-4o counts differently', 'markdown'],
  ['the password is case-sensitive', 'markdown'],
  ['o token é gerado no painel', 'markdown'],
  ['tokens: 128k context', 'markdown'],
  ['the password manager keeps it', 'markdown'],
  ['password policy: 12 characters minimum', 'markdown'],
  ['the session token is sent as a cookie', 'markdown'],
  ['a chave primária é composta', 'markdown'],
  ['o token expira em 3600 segundos', 'markdown'],
  ['token: 5 minutes is a count', 'markdown'],
  ['the password: (see the vault)', 'markdown'],
  ['if token is None:', 'python'],
  ['log("invalid token " + t)', 'javascript'],
  ['throw new Error("missing token: " + x)', 'javascript'],
  ['api_key: !secret api_key', 'yaml'],
  ['token: ${{ secrets.GH_TOKEN }}', 'yaml'],
];

const LANGS = [null, 'markdown', 'text', 'json', 'yaml', 'javascript', 'shell', 'python', 'powershell', 'toml'];
const opts = (lang) => (lang ? { lang } : undefined);

test('the table holds what it says: at least 30 cases each way, no value spelled out twice', () => {
  assert.ok(POSITIVE.length >= 30, `${POSITIVE.length} positive cases`);
  assert.ok(NEGATIVE.length >= 30, `${NEGATIVE.length} negative cases`);
  assert.equal(new Set(POSITIVE.map(([t]) => t)).size, POSITIVE.length);
  assert.equal(new Set(NEGATIVE.map(([t]) => t)).size, NEGATIVE.length);
});

test('a value a sentence gives a secret noun is masked, with and without the language of the file', () => {
  for (const [text, expected, lang] of POSITIVE) {
    assert.equal(maskText(text), expected, `no hint: ${text}`);
    if (lang) assert.equal(maskText(text, { lang }), expected, `${lang}: ${text}`);
    assert.equal(maskLine(text), expected, `maskLine: ${text}`);
    for (const s of SECRETS) assert.ok(!expected.includes(s), `nothing of the value is left: ${expected}`);
  }
});

test('prose that only talks about a secret is left as it is, in its own language and in none', () => {
  for (const [text, lang] of NEGATIVE) {
    assert.equal(maskText(text), text, `no hint: ${text}`);
    assert.equal(maskText(text, { lang }), text, `${lang}: ${text}`);
  }
});

test('the output is a fixed point: masking it again, with any hint or none, changes nothing', () => {
  const inputs = [...POSITIVE.map(([t]) => t), ...NEGATIVE.map(([t]) => t)];
  // Each one on its own, and all of them as one file, the way a snapshot reads them.
  for (const text of [...inputs, inputs.join('\n')]) {
    for (const a of LANGS) {
      const once = maskText(text, opts(a));
      assert.equal(once.split('\n').length, text.split('\n').length, 'the number of lines is kept');
      assert.equal(maskText(once, opts(a)), once, `${a} then ${a}: ${text.slice(0, 80)}`);
      assert.equal(maskText(once), once, `${a} then no hint: ${text.slice(0, 80)}`);
    }
  }
});

test('the barrier of a run refuses every positive, and accepts what the masker writes instead', () => {
  for (const [text, expected] of POSITIVE) {
    assert.equal(hasCredential(text), true, `refused: ${text}`);
    assert.equal(hasCredential(expected), false, `accepted: ${expected}`);
  }
  for (const [text] of NEGATIVE) assert.equal(hasCredential(text), false, `accepted: ${text}`);
});
