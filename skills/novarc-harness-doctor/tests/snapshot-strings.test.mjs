// The texts snapshot-harness.mjs writes for a person (lib/snapshot/strings.mjs): every one of
// them in both languages, word for word, so a change of wording is a change someone made on
// purpose. tests/snapshot-harness.test.mjs checks the same texts where they come out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS, translator, parseLang } from '../scripts/lib/snapshot/strings.mjs';

/** `key -> template` for every string of a dictionary (`layer.skills.one`, ...). */
function flat(dict, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(dict)) {
    if (v && typeof v === 'object') flat(v, `${prefix}${k}.`, out); else out[`${prefix}${k}`] = v;
  }
  return out;
}

test('both languages have the same strings, with the same placeholders, and follow the brand rule', () => {
  const en = flat(STRINGS.en);
  const pt = flat(STRINGS.pt);
  assert.deepEqual(Object.keys(pt).sort(), Object.keys(en).sort());
  const holes = (s) => (s.match(/\{\w+\}/g) || []).sort();
  for (const key of Object.keys(en)) {
    // A singular form may spell its number out and leave `{n}` away.
    const loose = key.endsWith('.one') ? (list) => list.filter((h) => h !== '{n}') : (list) => list;
    assert.deepEqual(loose(holes(pt[key])), loose(holes(en[key])), key);
    for (const s of [en[key], pt[key]]) {
      assert.equal(typeof s, 'string', key);
      assert.ok(s.trim() === s && s.length > 0, key);
      assert.doesNotMatch(s, /[–—]|\p{Extended_Pictographic}/u, `${key}: no dash used as punctuation and no emoji`);
    }
  }
});

test('every string in English and in Portuguese', () => {
  const en = translator('en');
  const pt = translator('pt');
  const used = new Set();
  const both = (key, vars) => { used.add(key); return [en(key, vars), pt(key, vars)]; };
  const want = [
    [both('layer.instructions'), ['instructions', 'instruções']],
    [both('layer.includes', { n: 1 }), ['includes 1 imported file', 'inclui 1 arquivo importado']],
    [both('layer.includes', { n: 3 }), ['includes 3 imported files', 'inclui 3 arquivos importados']],
    [both('layer.broken', { n: 1 }), ['1 import that does not resolve', '1 import que não resolve']],
    [both('layer.broken', { n: 2 }), ['2 imports that do not resolve', '2 imports que não resolvem']],
    [both('layer.rules', { n: 1 }), ['Rules (1 file without a path scope)', 'Regras (1 arquivo sem restrição de caminho)']],
    [both('layer.rules', { n: 5 }), ['Rules (5 files without a path scope)', 'Regras (5 arquivos sem restrição de caminho)']],
    [both('layer.memory'), ['Memory index', 'Índice de memória']],
    [both('layer.outputStyle', { name: 'Terse' }), ['Output style Terse', 'Estilo de saída Terse']],
    [both('layer.skills', { n: 1 }), ['Skill descriptions (1 skill)', 'Descrições das skills (1 skill)']],
    [both('layer.skills', { n: 74 }), ['Skill descriptions (74 skills)', 'Descrições das skills (74 skills)']],
    [both('layer.skillsFromPlugins', { n: 1 }), ['1 from plugins', '1 vem de plugins']],
    [both('layer.skillsFromPlugins', { n: 21 }), ['21 from plugins', '21 vêm de plugins']],
    [both('layer.agents', { n: 1 }), ['Agent definitions (1 agent)', 'Definições dos agentes (1 agente)']],
    [both('layer.agents', { n: 4 }), ['Agent definitions (4 agents)', 'Definições dos agentes (4 agentes)']],
    [both('layer.agentsNote'), [
      'Name and description of each agent are listed in every session; the prompt loads when the agent runs.',
      'O nome e a descrição de cada agente são listados em toda sessão; o prompt só é carregado quando o agente roda.',
    ]],
    [both('layer.mcp', { n: 1 }), ['MCP servers (1)', 'Servidores MCP (1)']],
    [both('layer.mcpNote'), [
      'Each server adds its tool definitions to the session; their size is not measured here.',
      'Cada servidor acrescenta à sessão as definições das suas ferramentas; o tamanho delas não é medido aqui.',
    ]],
    [both('layer.plugins', { n: 0 }), ['Plugins (0 enabled)', 'Plugins (0 ativos)']],
    [both('layer.plugins', { n: 1 }), ['Plugins (1 enabled)', 'Plugins (1 ativo)']],
    [both('layer.plugins', { n: 2 }), ['Plugins (2 enabled)', 'Plugins (2 ativos)']],
    [both('layer.pluginsCounted'), ['Their skills and agents are counted in the layers above.', 'As skills e os agentes deles já estão contados nas camadas acima.']],
    [both('layer.pluginsUnmeasured'), ['What each plugin adds is not measured here.', 'O que cada plugin acrescenta não é medido aqui.']],
    [both('layer.pluginsNoState', { n: 1 }), ['1 plugin listed without an on/off state', '1 plugin listado sem dizer se está ligado ou desligado']],
    [both('layer.pluginsNoState', { n: 2 }), ['2 plugins listed without an on/off state', '2 plugins listados sem dizer se estão ligados ou desligados']],
    [both('layer.sessionStart', { n: 3 }), ['SessionStart hooks (3)', 'Hooks de SessionStart (3)']],
    [both('layer.sessionStartNote'), [
      'What these hooks print is added to the context; its size is not measured here.',
      'O que esses hooks imprimem entra no contexto; o tamanho disso não é medido aqui.',
    ]],
    [both('hook.type', { type: 'prompt' }), ['prompt hook', 'hook do tipo prompt']],
    [both('hook.background'), ['runs in the background', 'roda em segundo plano']],
    [both('hook.outside'), ['runs a script outside the harness folders', 'roda um script que fica fora das pastas do harness']],
    [both('hook.preCommit'), [
      'pre-commit framework config; active only where `pre-commit install` was run',
      'configuração do framework pre-commit; só vale onde `pre-commit install` foi executado',
    ]],
    [both('hook.lefthook'), [
      'lefthook config; active only where `lefthook install` was run',
      'configuração do lefthook; só vale onde `lefthook install` foi executado',
    ]],
    [both('hook.workflow', { name: 'CI' }), ['workflow CI', 'workflow CI']],
    [both('plugin.version', { version: '1.0.0' }), ['version 1.0.0', 'versão 1.0.0']],
    [both('plugin.autoUpdate'), ['marketplace auto-updates', 'o marketplace se atualiza sozinho']],
    [both('plugin.noInstall'), ['enabled but no install record found', 'ativado, mas sem registro de instalação']],
    [both('mcp.stateFile', { file: '~/.claude.json' }), [
      'kept in ~/.claude.json, which is not part of the snapshot',
      'fica em ~/.claude.json, que não faz parte do retrato',
    ]],
    [both('mcp.fromPlugin', { name: 'alpha' }), ['from plugin alpha', 'vem do plugin alpha']],
    [both('harness.user', { provider: 'Codex', path: '~/.codex' }), ['Codex (~/.codex)', 'Codex (~/.codex)']],
    [both('harness.agents'), ['Shared agents folder', 'Pasta compartilhada de agentes']],
    [both('harness.other'), ['Agent', 'Agente']],
  ];
  for (const [got, expected] of want) assert.deepEqual(got, expected);
  // The table above leaves no string out. (A `{ one, other }` pair is one string to ask for.)
  const keys = [];
  const walk = (dict, prefix) => {
    for (const [k, v] of Object.entries(dict)) {
      if (typeof v === 'string' || (typeof v.one === 'string' && typeof v.other === 'string')) keys.push(`${prefix}${k}`); else walk(v, `${prefix}${k}.`);
    }
  };
  walk(STRINGS.en, '');
  assert.deepEqual([...used].sort(), keys.sort());
});

test('parseLang and the fallbacks of the translator', () => {
  assert.deepEqual(['pt', 'pt-BR', 'PT_br', ' en ', 'en-US', undefined, null].map(parseLang), ['pt', 'pt', 'pt', 'en', 'en', 'en', 'en']);
  assert.deepEqual(['', 'tlh', 'es', 'portuguese', true].map(parseLang), [null, null, null, null, null]);
  assert.equal(translator('pt').lang, 'pt');
  // A language with no dictionary and a key that does not exist never throw and never print `undefined`.
  const other = translator('tlh');
  assert.equal(other.lang, 'en');
  assert.equal(other('layer.memory'), 'Memory index');
  assert.equal(translator('pt')('layer.noSuchKey', { n: 2 }), 'layer.noSuchKey');
  assert.equal(translator('pt')('layer.skills', {}), 'Descrições das skills ({n} skills)', 'a missing variable stays visible');
});
