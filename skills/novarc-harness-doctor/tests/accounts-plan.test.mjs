// accounts.mjs plan, and the pure pieces it is built from: instruction generation, the MCP
// translation, the TOML reader/writer and the surgical JSON editor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildHome, acc, rmrf, write, read, json, snapshot, assertClean, FAKE_TOKEN, CLAUDE_MD,
} from './accounts-fixture.mjs';
import {
  applyProviderFences, generateInstructions, collectImports, findInlineSecrets, claudeToNeutral,
  codexToNeutral, neutralToClaude, neutralToCodex, desiredServer, scanCodexServers,
  renderCodexServer, rewriteCodexServers, reconcileServers, sha256, canon, BLOCK_START, BLOCK_END,
} from '../scripts/sync-check.mjs';
import { setIn, appendIn, removeIn, removeItem, makePatch, revertPatch } from '../scripts/lib/accounts/jsonedit.mjs';
import { maskIdentity, isNeverTop } from '../scripts/lib/accounts/detect.mjs';
import { STRINGS, translator, parseLang } from '../scripts/lib/accounts/strings.mjs';

const actionsFor = (plan, account, element) => plan.actions.filter((a) => a.account === account && a.element === element).map((a) => a.action);
const conflict = (plan, account, element) => plan.conflicts.find((c) => c.account === account && c.element === element);

test('plan: the same provider is linked, and nothing is written', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  const before = snapshot(h.home);
  const r = acc(h.home, ['plan', '--primary', 'claude-1']);
  assert.equal(r.code, 0, r.stderr);
  const p = r.json;
  assert.deepEqual(snapshot(h.home), before, 'plan wrote something');
  assert.equal(p.primary.id, 'claude-1');
  assert.deepEqual(p.accounts.map((a) => `${a.id}:${a.mode}`), ['claude-2:linked', 'codex-1:replicated', 'agents-1:replicated']);
  // Missing: a link, replacing nothing.
  assert.deepEqual(actionsFor(p, 'claude-2', 'keybindings.json'), ['link']);
  const link = p.actions.find((a) => a.account === 'claude-2' && a.element === 'keybindings.json');
  assert.equal(link.from, '~/.claude/keybindings.json');
  assert.equal(link.to, '~/.hostapp/host/harness-accounts/claude-code/acc-1/keybindings.json');
  assert.equal(link.replaces, 'nothing');
  assert.ok(link.why.length > 10);
  assert.deepEqual(actionsFor(p, 'claude-2', 'agents/'), ['link']);
  // An identical copy: backed up, then linked.
  assert.deepEqual(actionsFor(p, 'claude-2', 'settings.json'), ['backup', 'link']);
  assert.deepEqual(actionsFor(p, 'claude-2', 'commands/'), ['backup', 'link']);
  const backup = p.actions.find((a) => a.account === 'claude-2' && a.element === 'settings.json' && a.action === 'backup');
  assert.equal(backup.to, '~/.novarc-powers/novarc-harness-doctor/sync/backups/<stamp>/claude-2/settings.json');
  // Actions are numbered in order.
  assert.deepEqual(p.actions.map((a) => a.n), p.actions.map((_, i) => i + 1));
  assert.ok(p.actions.every((a) => ['link', 'generate', 'copy', 'backup', 'skip'].includes(a.action)));
  assertClean(assert, h, r.stdout + r.stderr);
});

test('plan: what differs or exists only in the account is a conflict that defaults to keep-as-exception', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  const p = acc(h.home, ['plan', '--primary', 'claude-1']).json;
  for (const [account, element, state] of [['claude-2', 'CLAUDE.md', 'divergent'], ['claude-2', 'skills/', 'divergent'], ['claude-2', 'output-styles/', 'account-only'], ['agents-1', 'skills/shared-skill', 'account-only']]) {
    const c = conflict(p, account, element);
    assert.ok(c, `${account}:${element} is not a conflict`);
    assert.equal(c.state, state);
    assert.deepEqual(c.options, ['adopt-into-primary', 'keep-as-exception', 'replace-with-primary']);
    assert.equal(c.default, 'keep-as-exception');
    assert.equal(c.choice, 'keep-as-exception');
    assert.equal(c.decidedBy, 'default');
    assert.deepEqual(actionsFor(p, account, element), ['skip'], 'a conflict is never acted on by default');
  }
  assert.equal(conflict(p, 'claude-2', 'CLAUDE.md').primaryPath, '~/.claude/CLAUDE.md');
  assert.equal(conflict(p, 'claude-2', 'CLAUDE.md').accountPath, '~/.hostapp/host/harness-accounts/claude-code/acc-1/CLAUDE.md');
  assert.deepEqual(p.exceptions['claude-2'], ['CLAUDE.md', 'skills/', 'output-styles/', 'mcp servers/only-here']);
  // A generated file cannot be adopted back, and an MCP server that lives only here stays here.
  assert.deepEqual(conflict(p, 'codex-1', 'AGENTS.md').options, ['keep-as-exception', 'replace-with-primary']);
  assert.deepEqual(conflict(p, 'codex-1', 'mcp servers/existing').options, ['keep-as-exception']);
  assert.equal(p.summary.conflicts, p.conflicts.length);
});

test('plan: imports of the primary are linked only where its instruction file is followed', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  let p = acc(h.home, ['plan', '--primary', 'claude-1']).json;
  assert.deepEqual(actionsFor(p, 'claude-2', 'RTK.md'), ['skip']);
  assert.match(p.actions.find((a) => a.account === 'claude-2' && a.element === 'RTK.md').why, /does not follow/);
  p = acc(h.home, ['plan', '--primary', 'claude-1', '--resolve', 'claude-2:CLAUDE.md=replace-with-primary']).json;
  assert.deepEqual(actionsFor(p, 'claude-2', 'CLAUDE.md'), ['backup', 'link']);
  for (const el of ['RTK.md', 'NESTED.md', 'docs/extra.md']) assert.deepEqual(actionsFor(p, 'claude-2', el), ['link'], el);
  const c = conflict(p, 'claude-2', 'CLAUDE.md');
  assert.equal(c.choice, 'replace-with-primary');
  assert.equal(c.decidedBy, 'user');
});

test('plan: --resolve chooses per conflict, keeps an element apart, and rejects nonsense', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  const p = acc(h.home, ['plan', '--primary', 'claude-1', '--resolve', 'claude-2:skills/=adopt-into-primary', '--resolve=claude-2:output-styles/=replace-with-primary', '--resolve', 'claude-2:settings.json=keep-as-exception']).json;
  assert.deepEqual(actionsFor(p, 'claude-2', 'skills/'), ['copy', 'backup', 'link']);
  assert.deepEqual(actionsFor(p, 'claude-2', 'output-styles/'), ['backup'], 'dropping an account-only element moves it to the backup');
  assert.deepEqual(actionsFor(p, 'claude-2', 'settings.json'), ['skip'], 'a non-conflict can be kept apart too');
  assert.ok(p.exceptions['claude-2'].includes('settings.json'));
  assert.ok(!p.exceptions['claude-2'].includes('skills/'));
  for (const bad of ['claude-2:skills/=burn-it', 'claude-2:nothing-here=keep-as-exception', 'no-colon=keep-as-exception', 'codex-1:AGENTS.md=adopt-into-primary', 'claude-2:keybindings.json=adopt-into-primary']) {
    const r = acc(h.home, ['plan', '--primary', 'claude-1', '--resolve', bad]);
    assert.equal(r.code, 2, `${bad} was accepted`);
    assert.equal(r.stdout, '');
  }
});

test('plan: another provider gets its instruction file generated, imports inlined and fences honoured', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  const drafts = path.join(h.root, 'drafts');
  const r = acc(h.home, ['plan', '--primary', 'claude-1', '--resolve', 'codex-1:AGENTS.md=replace-with-primary', '--drafts', drafts]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(actionsFor(r.json, 'codex-1', 'AGENTS.md'), ['backup', 'generate']);
  const gen = r.json.actions.find((a) => a.account === 'codex-1' && a.action === 'generate' && a.element === 'AGENTS.md');
  assert.equal(gen.from, '~/.claude/CLAUDE.md');
  assert.equal(gen.to, '~/.codex/AGENTS.md');
  assert.equal(read(path.join(h.codexDir, 'AGENTS.md')), '# Codex rules written by hand\n', 'plan must not write the target');
  const text = read(path.join(drafts, 'codex-1', 'AGENTS.md'));
  const lines = text.split('\n');
  assert.equal(lines[0], '<!-- generated by novarc-harness-doctor from ~/.claude/CLAUDE.md; edit the primary and run the sync check -->');
  // Imports are inlined where they stood, recursively; an import inside a sentence keeps its line.
  assert.ok(text.includes('<!-- import: RTK.md -->\n# RTK\n\nPrefix commands. RTK-BODY\n\n<!-- import: NESTED.md -->\nNested import. NESTED-BODY\n<!-- /import -->\n<!-- /import -->'));
  assert.ok(!/^@RTK\.md$/m.test(text));
  assert.ok(text.includes('See @docs/extra.md for the long version.\n<!-- import: docs/extra.md -->\nThe long version. EXTRA-BODY\n<!-- /import -->'));
  assert.ok(text.includes('Style rules. STYLE-BODY'));
  assert.ok(text.indexOf('RTK-BODY') < text.indexOf('EXTRA-BODY') && text.indexOf('EXTRA-BODY') < text.indexOf('STYLE-BODY'), 'inlined in place, in order');
  assert.ok(text.includes('@missing-file.md'), 'an import that does not resolve stays as text');
  // Provider fences.
  assert.ok(text.includes('CODEX-ONLY-LINE'));
  assert.ok(!text.includes('CLAUDE-ONLY-LINE'));
  assert.ok(!text.includes('EXCEPT-CODEX-LINE'));
  assert.ok(!text.includes('GEMINI-INLINE'));
  assert.ok(text.includes('Inline tail.'));
  assert.ok(!/<!--\s*\/?(only|except)/.test(text.replace(/```[\s\S]*?```/g, '')), 'a fence marker leaked');
  // Code blocks and non-imports are left alone.
  assert.ok(text.includes('```\n@not-an-import.md\n<!-- only: claude-code -->\ninside a code block: kept as text\n```'));
  assert.ok(text.includes('Mention `@types/node` and @someone are not imports.'));
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
  assert.deepEqual(r.json.drafts, [path.join(drafts, 'codex-1', 'AGENTS.md').replace(/\\/g, '/')].map((p) => (p.startsWith(h.home.replace(/\\/g, '/')) ? `~${p.slice(h.home.length)}` : p)));
  assert.ok(r.json.accounts.find((a) => a.id === 'codex-1').notes.some((n) => /1 import of the primary does not resolve/.test(n)));
});

test('plan: MCP servers are translated into a managed TOML block; a secret-bearing one is a conflict', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  const r = acc(h.home, ['plan', '--primary', 'claude-1']);
  const p = r.json;
  for (const name of ['context7', 'remote']) {
    const a = p.actions.find((x) => x.account === 'codex-1' && x.element === `mcp servers/${name}`);
    assert.equal(a.action, 'generate');
    assert.equal(a.from, '~/.claude.json');
    assert.equal(a.to, '~/.codex/config.toml');
    assert.equal(a.replaces, 'nothing');
  }
  const leak = conflict(p, 'codex-1', 'mcp servers/leaky');
  assert.equal(leak.state, 'not-portable');
  assert.deepEqual(leak.options, ['keep-as-exception']);
  assert.match(leak.note, /inline secret \(env GITHUB_TOKEN\)/);
  assert.match(leak.note, /environment variable/);
  assert.deepEqual(actionsFor(p, 'codex-1', 'mcp servers/leaky'), ['skip']);
  assert.ok(!r.stdout.includes(FAKE_TOKEN), 'the secret value reached the plan');
  assert.match(conflict(p, 'codex-1', 'mcp servers/streamy').note, /SSE/);
  // Permissions, hooks, plugins and key bindings are listed with what to mirror by hand.
  const np = p.notPortable.filter((x) => x.account === 'codex-1').map((x) => x.element);
  for (const n of ['permissions', 'hooks', 'plugins', 'keybindings']) assert.ok(np.includes(n), n);
  assert.ok(p.notPortable.every((x) => x.note.length > 20));
  assert.ok(p.warnings.some((w) => /Close the agent apps/.test(w)));
});

test('plan: skills are linked one by one, and a name the account already has is left alone', (t) => {
  const h = buildHome({ agents: false });
  t.after(() => rmrf(h.root));
  write(path.join(h.codexDir, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nCodex wrote its own alpha.\n');
  const p = acc(h.home, ['plan', '--primary', 'claude-1']).json;
  assert.deepEqual(actionsFor(p, 'codex-1', 'skills/beta'), ['link']);
  assert.equal(p.actions.find((a) => a.account === 'codex-1' && a.element === 'skills/beta').to, '~/.codex/skills/beta');
  assert.equal(conflict(p, 'codex-1', 'skills/alpha').state, 'divergent');
  assert.deepEqual(actionsFor(p, 'codex-1', 'skills/alpha'), ['skip']);
  assert.equal(conflict(p, 'codex-1', 'skills/own-skill').state, 'account-only');
});

test('plan: --out writes the plan and only the plan; --only and --skip narrow it', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  const before = snapshot(h.home);
  const out = path.join(h.root, 'plans', 'p.json');
  const r = acc(h.home, ['plan', '--primary', 'claude-1', '--out', out, '--only', 'codex-1']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(snapshot(h.home), before);
  const file = json(out);
  assert.deepEqual(file.accounts.map((a) => a.id), ['codex-1']);
  assert.ok(file.actions.every((a) => a.account === 'codex-1'));
  assert.equal(file.fingerprint, r.json.fingerprint);
  assert.equal(file.tool, 'novarc-harness-doctor');
  assertClean(assert, h, read(out));
  // With the shared folder left out, Codex receives the skills in its own folder.
  assert.ok(file.actions.some((a) => a.element === 'skills/alpha' && a.action === 'link'));
  const skipped = acc(h.home, ['plan', '--primary', 'claude-1', '--skip', 'codex-1,agents-1']).json;
  assert.deepEqual(skipped.accounts.map((a) => a.id), ['claude-2']);
  assert.equal(acc(h.home, ['plan', '--primary', 'claude-1', '--only', 'nope-1']).code, 2);
});

test('plan: a Codex file over the default instruction limit raises a warning', (t) => {
  const h = buildHome({ second: false, agents: false });
  t.after(() => rmrf(h.root));
  fs.appendFileSync(path.join(h.claude, 'RTK.md'), `${'A long line of guidance for the agent to read.\n'.repeat(900)}`);
  write(path.join(h.codexDir, 'AGENTS.override.md'), 'override\n');
  const p = acc(h.home, ['plan', '--primary', 'claude-1']).json;
  assert.ok(p.warnings.some((w) => /project_doc_max_bytes/.test(w)), JSON.stringify(p.warnings));
  assert.ok(p.warnings.some((w) => /AGENTS\.override\.md/.test(w)));
});

test('plan --lang pt: the same plan, worded in Portuguese, and apply reads it the same', (t) => {
  const h = buildHome();
  t.after(() => rmrf(h.root));
  const resolve = ['--resolve', 'claude-2:CLAUDE.md=replace-with-primary', '--resolve', 'claude-2:skills/=adopt-into-primary', '--resolve', 'claude-2:output-styles/=replace-with-primary', '--resolve', 'codex-1:AGENTS.md=replace-with-primary', '--resolve', 'claude-2:settings.json=keep-as-exception'];
  const planFile = path.join(h.root, 'pt.json');
  const en = acc(h.home, ['plan', '--primary', 'claude-1', ...resolve]);
  const pt = acc(h.home, ['plan', '--primary', 'claude-1', '--lang', 'pt', '--out', planFile, ...resolve]);
  assert.equal(pt.code, 0, pt.stderr);
  assert.equal(en.json.lang, 'en');
  assert.equal(pt.json.lang, 'pt');
  // Machine fields: identical, down to the fingerprint and the signatures apply compares.
  assert.equal(pt.json.fingerprint, en.json.fingerprint);
  assert.deepEqual(pt.json.signatures, en.json.signatures);
  assert.deepEqual(pt.json.summary, en.json.summary);
  assert.deepEqual(pt.json.exceptions, en.json.exceptions);
  const actions = (p) => p.actions.map((a) => [a.n, a.account, a.element, a.action, a.from, a.to, 'replaces' in a, 'why' in a]);
  assert.deepEqual(actions(pt.json), actions(en.json));
  const conflicts = (p) => p.conflicts.map((c) => [c.account, c.element, c.state, c.options, c.default, c.choice, c.decidedBy, c.primaryPath, c.accountPath, 'note' in c]);
  assert.deepEqual(conflicts(pt.json), conflicts(en.json));
  assert.deepEqual(pt.json.notPortable.map((x) => [x.account, x.element]), en.json.notPortable.map((x) => [x.account, x.element]));
  assert.deepEqual(pt.json.accounts.map((a) => [a.id, a.provider, a.path, a.mode, (a.notes || []).length]), en.json.accounts.map((a) => [a.id, a.provider, a.path, a.mode, (a.notes || []).length]));
  // Every sentence is there in both, and none was left in English.
  const sentences = (p) => [p.primary.label, ...p.accounts.flatMap((a) => [a.label, ...(a.notes || [])]), ...p.actions.flatMap((a) => [a.why, a.replaces].filter((x) => x !== undefined)), ...p.conflicts.map((c) => c.note).filter(Boolean), ...p.notPortable.map((x) => x.note), ...p.warnings];
  const sEn = sentences(en.json);
  const sPt = sentences(pt.json);
  assert.equal(sPt.length, sEn.length);
  sPt.forEach((s, i) => assert.notEqual(s, sEn[i], `not translated: ${s}`));
  assert.ok(!pt.stdout.includes(String.fromCharCode(0x2014)), 'an em dash reached the Portuguese plan');
  const text = sPt.join('\n');
  for (const expected of [
    'Claude Code · conta 1', 'mesmo provedor: o elemento vira um link para a conta principal', 'a pasta da skill vira um link para a conta principal',
    'uma cópia idêntica; guardada para a mudança poder ser desfeita', 'mantido como exceção da conta (sua escolha)', 'existe só nesta conta; mantido como exceção da conta',
    'gerado a partir das instruções da conta principal', 'o arquivo próprio da conta; movido, não apagado', 'trazido para a conta principal',
    'nada: só entram os itens que faltam na conta principal', 'a conta principal não tem esse elemento; movido para fora da conta (sua escolha), não apagado',
    'replicado da conta principal para a parte gerenciada do arquivo', 'idêntico ao da conta principal: passa para a parte gerenciada',
    'não replicado: contém um segredo embutido (env GITHUB_TOKEN)', 'Um servidor que existe só aqui fica aqui', 'Um arquivo gerado não volta a ser a fonte da conta principal',
    'Feche os apps de agente das contas envolvidas antes de aplicar', 'nada',
  ]) assert.ok(text.includes(expected), `missing in pt: ${expected}`);
  assert.ok(!pt.stdout.includes(FAKE_TOKEN));
  assertClean(assert, h, pt.stdout + pt.stderr + read(planFile));
  // The plan file carries its language; a dry run answers in it, and apply carries it out.
  assert.equal(json(planFile).lang, 'pt');
  const dry = acc(h.home, ['apply', '--plan', planFile, '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.ok(dry.json.actions.some((a) => a.why === 'mesmo provedor: o elemento vira um link para a conta principal'));
  assert.ok(dry.json.warnings.some((w) => w.startsWith('Feche os apps de agente')));
  const applied = acc(h.home, ['apply', '--plan', planFile, '--yes']);
  assert.equal(applied.code, 0, applied.stdout);
  assert.equal(applied.json.failed, 0);
  assert.ok(read(path.join(h.codexDir, 'AGENTS.md')).startsWith('<!-- generated by novarc-harness-doctor from ~/.claude/CLAUDE.md; edit the primary and run the sync check -->'), 'the generated file itself is not localised');
  // What was decided is remembered, and said, in Portuguese on the next plan.
  const next = acc(h.home, ['plan', '--primary', 'claude-1', '--lang', 'pt']).json;
  assert.equal(next.actions.find((a) => a.account === 'claude-2' && a.element === 'settings.json').why, 'mantido como exceção da conta (decidido antes)');
  assert.equal(next.actions.find((a) => a.account === 'claude-2' && a.element === 'CLAUDE.md').why, 'já vinculado à conta principal');
  assert.match(acc(h.home, ['diff', '--lang', 'pt']).json.accounts.find((a) => a.id === 'claude-2').sync.elements.find((e) => e.name === 'settings.json').note, /mantido como exceção da conta$/);
});

test('strings: both dictionaries have the same keys, plural forms where needed, and no em dash', () => {
  const DASHES = [String.fromCharCode(0x2013), String.fromCharCode(0x2014)]; // en dash, em dash
  const kinds = (v) => (typeof v === 'string' ? 'text' : Object.keys(v).every((k) => ['zero', 'one', 'other'].includes(k)) ? 'plural' : 'group');
  const walk = (a, b, at) => {
    assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort(), `keys differ at ${at || 'the root'}`);
    for (const k of Object.keys(a)) {
      const where = at ? `${at}.${k}` : k;
      const ka = kinds(a[k]);
      const kb = kinds(b[k]);
      if (ka === 'group' || kb === 'group') { assert.equal(ka, kb, where); walk(a[k], b[k], where); continue; }
      for (const text of [a[k], b[k]].flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v)))) {
        assert.equal(typeof text, 'string', where);
        assert.ok(text.length > 0 && !DASHES.some((d) => text.includes(d)), `dash or empty text at ${where}`);
      }
      // The same placeholders on both sides, so nothing is dropped in translation.
      const vars = (v) => [...new Set((typeof v === 'string' ? [v] : Object.values(v)).flatMap((s) => s.match(/\{\w+\}/g) || []))].filter((x) => x !== '{n}').sort();
      assert.deepEqual(vars(b[k]), vars(a[k]), `placeholders differ at ${where}`);
    }
  };
  walk(STRINGS.en, STRINGS.pt, '');
  const t = translator('pt');
  assert.equal(t('detail.state.missing', { n: 1 }), '1 faltando');
  assert.equal(t('detail.state.missing', { n: 4 }), '4 faltando');
  assert.equal(translator('en')('detail.state.missing', { n: 1 }), '1 missing');
  assert.equal(t('notPortable.claude.plugins', { n: 0 }).startsWith('Os plugins'), true);
  assert.equal(translator('xx')('plan.nothing'), 'nothing', 'an unknown language reads as English');
  assert.equal(t('no.such.key'), 'no.such.key');
  assert.deepEqual([parseLang(undefined), parseLang('pt'), parseLang('PT-br'), parseLang('en_US'), parseLang('es'), parseLang('')], ['en', 'pt', 'pt', 'en', null, null]);
  // Every reason the core can give for not replicating a server has its wording.
  for (const code of ['inline-secret', 'sse', 'command-expansion', 'arg-expansion', 'env-expansion', 'url-expansion', 'header-expansion', 'unknown-transport', 'not-object', 'env-vars-remote', 'auth-helper', 'disabled', 'bad-name']) assert.ok(t.has(`mcp.blocked.${code}`), code);
  const reasons = [
    claudeToNeutral(null), claudeToNeutral({ type: 'sse', url: 'https://x.example.com' }), claudeToNeutral({ command: '${X}' }), claudeToNeutral({ command: 'x', args: ['${X}'] }),
    claudeToNeutral({ command: 'x', env: { A: '${B}' } }), claudeToNeutral({ type: 'http', url: 'https://${H}/mcp' }), claudeToNeutral({ type: 'http', url: 'https://x.example.com', headers: { K: 'a-${B}' } }),
    claudeToNeutral({ type: 'weird' }), codexToNeutral({ command: 'x', env_vars: [{ name: 'A', source: 'remote' }] }), codexToNeutral({ url: 'https://x.example.com', auth: {} }),
    codexToNeutral({ command: 'x', enabled: false }), desiredServer('bad name', { command: 'x' }, 'claude-json', 'codex-toml'), desiredServer('s', { command: 'x', env: { GITHUB_TOKEN: FAKE_TOKEN } }, 'claude-json', 'codex-toml'),
  ];
  for (const r of reasons) {
    assert.equal(r.ok, false);
    assert.ok(t.has(`mcp.blocked.${r.code}`), `no wording for ${r.code}`);
    assert.ok(!t(`mcp.blocked.${r.code}`, r.params).includes('{'), `a placeholder of ${r.code} was not filled`);
  }
});

// ---- pure pieces --------------------------------------------------------------------------------

test('fences: only / except, lists, nesting, and code blocks left alone', () => {
  const src = ['a', '<!-- only: claude-code, codex -->', 'both', '<!-- only: codex -->', 'nested', '<!-- /only -->', '<!-- /only -->', '<!-- except: gemini -->', 'not-gemini', '<!-- /except -->', 'z'].join('\n');
  assert.equal(applyProviderFences(src, 'codex'), 'a\nboth\nnested\nnot-gemini\nz');
  assert.equal(applyProviderFences(src, 'claude-code'), 'a\nboth\nnot-gemini\nz');
  assert.equal(applyProviderFences(src, 'claude'), 'a\nboth\nnot-gemini\nz', '`claude` is an alias');
  assert.equal(applyProviderFences(src, 'gemini'), 'a\nz');
  assert.equal(applyProviderFences('x\n\n<!-- only: codex -->\ny\n<!-- /only -->\n\nz', 'gemini'), 'x\n\nz', 'no doubled blank line where a block was dropped');
  assert.equal(applyProviderFences(CLAUDE_MD, 'claude-code').includes('CLAUDE-ONLY-LINE'), true);
});

test('generate: nothing is inlined when the source format has no imports, and cycles end', (t) => {
  const h = buildHome({ second: false, codex: false, agents: false });
  t.after(() => rmrf(h.root));
  const a = path.join(h.root, 'a.md');
  const b = path.join(h.root, 'b.md');
  write(a, 'A\n@b.md\n');
  write(b, 'B\n@a.md\n');
  const g = generateInstructions({ source: a, provider: 'codex', sourceDisplay: '~/a.md', home: h.home });
  assert.equal(g.text, '<!-- generated by novarc-harness-doctor from ~/a.md; edit the primary and run the sync check -->\nA\n<!-- import: b.md -->\nB\n@a.md\n<!-- /import -->\n');
  assert.deepEqual(g.unresolved, ['a.md']);
  const plain = generateInstructions({ source: a, provider: 'claude-code', sourceDisplay: '~/a.md', inlineImports: false, home: h.home });
  assert.ok(plain.text.includes('@b.md') && !plain.text.includes('<!-- import'));
  assert.equal(generateInstructions({ source: path.join(h.root, 'nope.md'), provider: 'codex', sourceDisplay: 'x', home: h.home }), null);
  // Credential-shaped files are never inlined or followed, whatever imports them.
  write(path.join(h.root, 'auth.json'), 'SECRET-IN-AUTH\n');
  write(path.join(h.root, 'c.md'), '@auth.json\n@.env\n');
  write(path.join(h.root, '.env'), 'SECRET-IN-ENV\n');
  const c = generateInstructions({ source: path.join(h.root, 'c.md'), provider: 'codex', sourceDisplay: 'c', home: h.home });
  assert.ok(!c.text.includes('SECRET-IN'));
  assert.deepEqual(collectImports(path.join(h.root, 'c.md'), { home: h.home }), []);
  assert.deepEqual(collectImports(path.join(h.claude, 'CLAUDE.md'), { home: h.home }).map((p) => path.relative(h.claude, p).replace(/\\/g, '/')), ['RTK.md', 'NESTED.md', 'docs/extra.md', 'rules/style.md']);
});

test('mcp: inline secrets are found by location, never by value', () => {
  assert.deepEqual(findInlineSecrets({ command: 'x', env: { GITHUB_TOKEN: FAKE_TOKEN } }), ['env GITHUB_TOKEN']);
  assert.deepEqual(findInlineSecrets({ command: 'x', env: { API_KEY: 'plainvalue123' } }), ['env API_KEY']);
  assert.deepEqual(findInlineSecrets({ command: 'x', args: ['--api-key', 'abcdefgh1234', '--token=abcdefgh1234'] }), ['args[1]', 'args[2]']);
  assert.deepEqual(findInlineSecrets({ type: 'http', url: 'https://h.example.com/mcp', headers: { Authorization: 'Bearer abcdefghijklmnop' } }), ['headers Authorization']);
  assert.deepEqual(findInlineSecrets({ url: 'https://h.example.com/mcp?api_key=abcdefgh1234' }), ['url']);
  assert.deepEqual(findInlineSecrets({ url: 'https://user:hunter2hunter2@h.example.com/mcp' }), ['url']);
  assert.deepEqual(findInlineSecrets({ command: 'x', env: { SESSION: 'a1'.repeat(20) } }), ['env SESSION'], 'a long opaque value');
  // References and ordinary values are fine.
  assert.deepEqual(findInlineSecrets({ command: 'npx', args: ['-y', 'some-package-name-that-is-quite-long-indeed'], env: { API_KEY: '${API_KEY}', MODE: 'fast', TOKEN_FILE: '/etc/keys/token', HOME_DIR: '%USERPROFILE%' } }), []);
  assert.deepEqual(findInlineSecrets({ type: 'http', url: 'https://h.example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}', 'X-Region': 'eu' } }), []);
  assert.deepEqual(findInlineSecrets({ url: 'https://h.example.com/mcp', bearer_token_env_var: 'TOKEN', env_http_headers: { 'X-Api-Key': 'KEY_VAR' } }), []);
});

test('mcp: Claude JSON and Codex TOML translate both ways', () => {
  const stdio = { command: 'npx', args: ['-y', 'pkg'], env: { MODE: 'fast', PASSTHRU: '${PASSTHRU}' } };
  const n = claudeToNeutral(stdio);
  assert.deepEqual(n.neutral, { transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { MODE: 'fast' }, envVars: ['PASSTHRU'] });
  assert.deepEqual(neutralToCodex(n.neutral), { command: 'npx', args: ['-y', 'pkg'], env_vars: ['PASSTHRU'], env: { MODE: 'fast' } });
  assert.deepEqual(neutralToClaude(codexToNeutral(neutralToCodex(n.neutral)).neutral), { type: 'stdio', ...stdio });
  const http = { type: 'http', url: 'https://h.example.com/mcp', headers: { Authorization: 'Bearer ${T}', 'X-Key': '${K}', 'X-Region': 'eu' } };
  const codex = desiredServer('remote', http, 'claude-json', 'codex-toml').def;
  assert.deepEqual(codex, { url: 'https://h.example.com/mcp', bearer_token_env_var: 'T', http_headers: { 'X-Region': 'eu' }, env_http_headers: { 'X-Key': 'K' } });
  assert.deepEqual(desiredServer('remote', codex, 'codex-toml', 'claude-json').def, { type: 'http', url: http.url, headers: { 'X-Region': 'eu', 'X-Key': '${K}', Authorization: 'Bearer ${T}' } });
  // What cannot be expressed is refused with a reason, never guessed.
  assert.equal(claudeToNeutral({ type: 'sse', url: 'https://x.example.com' }).ok, false);
  assert.equal(claudeToNeutral({ command: 'x', env: { A: '${B}' } }).ok, false);
  assert.equal(claudeToNeutral({ command: 'x', args: ['--dir=${HOME}/x'] }).ok, false);
  assert.equal(codexToNeutral({ command: 'x', enabled: false }).reason, 'disabled');
  assert.equal(desiredServer('bad name', { command: 'x' }, 'claude-json', 'codex-toml').ok, false);
  assert.equal(desiredServer('s', { command: 'x', env: { GITHUB_TOKEN: FAKE_TOKEN } }, 'claude-json', 'claude-json').reason, 'inline-secret');
  // The same format is copied as it is.
  assert.deepEqual(desiredServer('s', { type: 'sse', url: 'https://x.example.com' }, 'claude-json', 'claude-json').def, { type: 'sse', url: 'https://x.example.com' });
});

test('toml: the reader finds servers written in every common form', () => {
  const text = [
    '# a comment', 'model = "x"', 'mcp_servers.dotted.command = "d"', '',
    '[mcp_servers]', 'inline = { command = "i", args = ["a", "b"] }', '',
    '[mcp_servers.plain]', 'command = "npx" # trailing comment', 'args = [', '  "-y", # first', '  "pkg",', ']', 'startup_timeout_sec = 20', 'enabled = true', '',
    '[mcp_servers.plain.env]', 'A = "1"', "B = 'lit\\eral'", 'C = "esc \\"q\\" \\\\ \\t \\u00e9"', '',
    '[mcp_servers."quoted name".http_headers]', '"X Key" = "v"', '',
    '[other]', 'mcp_servers.fake.command = "not a server"', 'multi = """', '[mcp_servers.ghost]', 'command = "inside a string"', '"""', '',
    '[[array.of.tables]]', 'x = 1',
  ].join('\n');
  const { servers } = scanCodexServers(text);
  assert.deepEqual(Object.keys(servers).sort(), ['dotted', 'inline', 'plain', 'quoted name']);
  assert.deepEqual(servers.plain.def, { command: 'npx', args: ['-y', 'pkg'], startup_timeout_sec: 20, enabled: true, env: { A: '1', B: 'lit\\eral', C: 'esc "q" \\ \t é' } });
  assert.deepEqual(servers['quoted name'].def, { http_headers: { 'X Key': 'v' } });
  assert.deepEqual(servers.inline.def, { command: 'i', args: ['a', 'b'] });
  assert.equal(servers.inline.inline, true);
  assert.equal(servers.dotted.inline, true);
  assert.equal(servers.plain.inline, false);
  assert.equal(servers.plain.spans.length, 2);
  assert.equal(scanCodexServers('[mcp_servers.x]\ncommand = \n').servers.x.opaque, true);
});

test('toml: the writer round-trips through the reader, with CRLF and awkward strings', () => {
  const def = { command: 'C:\\tools\\srv.exe', args: ['a "quoted" value', 'tab\there', 'é'], env_vars: ['V'], env: { 'KEY.DOTS': 'x', PLAIN: 'back\\slash' } };
  const lines = renderCodexServer('scoped@pkg/name', def);
  assert.equal(lines[0], '[mcp_servers."scoped@pkg/name"]');
  for (const eol of ['\n', '\r\n']) {
    const text = lines.join(eol) + eol;
    assert.deepEqual(scanCodexServers(text).servers['scoped@pkg/name'].def, def);
  }
});

test('toml: rewriting touches the managed tables and nothing else', () => {
  const head = 'model = "x"\n\n[mcp_servers.mine]\ncommand = "keep"\n\n[projects."/w"]\ntrust_level = "trusted"\n';
  const one = rewriteCodexServers(head, { write: [{ name: 'a', def: { command: 'npx', env: { K: 'v' } } }, { name: 'b', def: { url: 'https://x.example.com' } }] });
  assert.ok(one.startsWith(head), 'everything before the block is byte-identical');
  const block = one.slice(head.length);
  assert.ok(block.startsWith(`\n${BLOCK_START}`) && block.trimEnd().endsWith(BLOCK_END));
  assert.deepEqual(Object.keys(scanCodexServers(one).servers).sort(), ['a', 'b', 'mine']);
  assert.equal(rewriteCodexServers(one, { write: [{ name: 'a', def: { command: 'npx', env: { K: 'v' } } }, { name: 'b', def: { url: 'https://x.example.com' } }] }), one, 'rewriting the same set changes nothing');
  // Change one, drop one.
  const two = rewriteCodexServers(one, { remove: ['b'], write: [{ name: 'a', def: { command: 'node' } }] });
  assert.ok(two.startsWith(head));
  assert.deepEqual(scanCodexServers(two).servers.a.def, { command: 'node' });
  assert.equal(scanCodexServers(two).servers.b, undefined);
  // Nothing left to manage: the file is as it was.
  assert.equal(rewriteCodexServers(two, { remove: ['a'], write: [] }), head);
  // A server the app wrote between the markers is not ours: it survives a rewrite.
  const mixed = one.replace(BLOCK_END, `[mcp_servers.foreign]\ncommand = "theirs"\n${BLOCK_END}`);
  const three = rewriteCodexServers(mixed, { write: [{ name: 'a', def: { command: 'npx' } }] , remove: ['b'] });
  assert.equal(scanCodexServers(three).servers.foreign.def.command, 'theirs');
  assert.equal((three.match(new RegExp(BLOCK_START, 'g')) || []).length, 1);
  // CRLF files keep CRLF; an inline definition is never cut.
  const crlf = rewriteCodexServers('model = "x"\r\n', { write: [{ name: 'a', def: { command: 'npx' } }] });
  assert.ok(!/[^\r]\n/.test(crlf));
  assert.throws(() => rewriteCodexServers('mcp_servers.a.command = "x"\n', { write: [{ name: 'a', def: { command: 'y' } }] }));
  assert.equal(rewriteCodexServers('', { write: [] }), '');
});

test('reconcile: only what this tool wrote, untouched, may change without asking', () => {
  const src = { same: { def: { command: 'a' } }, moved: { def: { command: 'new' } }, fresh: { def: { command: 'f' } }, tuned: { def: { command: 't' } }, theirs: { def: { command: 'p' } }, secret: { def: { command: 's', env: { GITHUB_TOKEN: FAKE_TOKEN } } } };
  const h = (d) => sha256(canon(d));
  const target = {
    same: { def: { command: 'a' } }, moved: { def: { command: 'old' } }, tuned: { def: { command: 't', startup_timeout_sec: 30 } },
    theirs: { def: { command: 'different' } }, gone: { def: { command: 'g' } }, edited: { def: { command: 'hand' } }, extra: { def: { command: 'x' } },
  };
  const managed = { same: h({ command: 'a' }), moved: h({ command: 'old' }), tuned: h({ command: 't' }), gone: h({ command: 'g' }), edited: h({ command: 'was' }), vanished: h({ command: 'v' }) };
  const got = Object.fromEntries(reconcileServers({ source: { ...src, edited: { def: { command: 'e2' } } }, target, sourceFormat: 'codex-toml', targetFormat: 'codex-toml', managed }).map((i) => [i.name, i.status]));
  assert.deepEqual(got, { edited: 'edited', extra: 'account-only', fresh: 'missing', gone: 'gone', moved: 'stale', same: 'ok', secret: 'blocked', theirs: 'differs', tuned: 'ok', vanished: 'gone' });
  const ex = reconcileServers({ source: src, target, sourceFormat: 'codex-toml', targetFormat: 'codex-toml', managed, exceptions: ['mcp servers/theirs', 'mcp servers/extra'] });
  assert.equal(ex.find((i) => i.name === 'theirs').status, 'excepted');
  assert.equal(ex.find((i) => i.name === 'extra').status, 'excepted');
});

test('jsonedit: one value changes and every other byte stays', () => {
  const src = '{\n  "model": "x",\n  "env": { "A": "1" },\n  "hooks": {\n    "PreToolUse": [\n      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "g" } ] }\n    ]\n  },\n  "last": [1, 2]\n}\n';
  const entry = { matcher: 'startup', hooks: [{ type: 'command', command: 'c' }] };
  const a = appendIn(src, ['hooks', 'SessionStart'], entry);
  assert.deepEqual(JSON.parse(a).hooks.SessionStart, [entry]);
  const p = makePatch(src, a);
  assert.equal(p.removed, '', 'a pure insertion');
  assert.equal(a.slice(0, p.prefix) + a.slice(a.length - p.suffix), src);
  assert.equal(revertPatch(a, p), src);
  assert.ok(a.includes('  "env": { "A": "1" },'), 'the hand formatting of other keys survives');
  const b = appendIn(a, ['hooks', 'SessionStart'], { x: 1 });
  assert.equal(JSON.parse(b).hooks.SessionStart.length, 2);
  assert.equal(removeItem(b, ['hooks', 'SessionStart'], 1), a);
  assert.equal(removeIn(a, ['hooks', 'SessionStart']), src);
  // Nested removal through an array position.
  const c = removeItem(src, ['hooks', 'PreToolUse', 0, 'hooks'], 0);
  assert.deepEqual(JSON.parse(c).hooks.PreToolUse[0].hooks, []);
  // Create the whole path, in an empty object, with tabs, CRLF and a byte order mark.
  assert.equal(setIn('{}', ['a', 'b'], 1), '{\n  "a": {\n    "b": 1\n  }\n}');
  const tabbed = '\uFEFF{\r\n\t"k": 1\r\n}\r\n';
  const t2 = setIn(tabbed, ['mcpServers', 's'], { command: 'x' });
  assert.ok(t2.startsWith('\uFEFF{\r\n\t"k": 1,\r\n\t"mcpServers": {\r\n\t\t"s": {\r\n\t\t\t"command": "x"'));
  assert.ok(!/[^\r]\n/.test(t2));
  assert.deepEqual(JSON.parse(t2.slice(1)), { k: 1, mcpServers: { s: { command: 'x' } } });
  assert.equal(setIn('{"a":1}', ['b'], 2), '{"a":1, "b": 2}');
  assert.equal(setIn('{ "a": {"x": 1}, "z": 0 }', ['a'], 5), '{ "a": 5, "z": 0 }');
  assert.equal(removeIn('{ "a": 1 }', ['nope']), '{ "a": 1 }');
  assert.equal(removeIn('{ "a": 1 }', ['a']), '{}');
  assert.throws(() => setIn('{ not json', ['a'], 1), /not valid JSON/);
  assert.throws(() => appendIn('{"hooks": {"SessionStart": 3}}', ['hooks', 'SessionStart'], 1), /not an array/);
  assert.throws(() => setIn('{"a": [1]}', ['a', 'b'], 1), /not an object/);
});

test('detect: masking and the never-list', () => {
  assert.equal(maskIdentity('someone@example.com'), 'so…@example.com');
  assert.equal(maskIdentity('a@example.org'), 'a…@example.org');
  assert.equal(maskIdentity('not an address'), undefined);
  assert.equal(maskIdentity(undefined), undefined);
  for (const n of ['.credentials.json', '.claude.json', '.claude.json.backup', 'auth.json', 'projects', 'todos', 'shell-snapshots', 'statsig', 'sessions', 'history.jsonl', 'history', 'settings.local.json', 'cache', 'state.sqlite', 'logs', 'codex.log']) assert.equal(isNeverTop(n), true, n);
  for (const n of ['CLAUDE.md', 'settings.json', 'skills', 'RTK.md', 'keybindings.json', 'statusline.sh']) assert.equal(isNeverTop(n), false, n);
});
