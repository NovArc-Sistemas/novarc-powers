// Every string snapshot-harness.mjs writes for a person to read, one dictionary per language:
// the names and notes of the layers, and the notes on hooks, plugins and MCP servers. The board
// shows them as they are, so they come in the language of the run (`--lang`).
// Only wording lives here. Ids, events, categories, load modes, paths, commands and the names
// people gave their own things are machine fields and never change with the language.
// A count-dependent string is `{ one, other }`, chosen by the `n` variable. Templates use {name}
// placeholders. Brand rule: no em dash and no emoji in any string.
import { fill, LANGUAGES, DEFAULT_LANGUAGE } from '../i18n.mjs';

const en = {
  layer: {
    instructions: 'instructions',
    includes: { one: 'includes 1 imported file', other: 'includes {n} imported files' },
    broken: { one: '1 import that does not resolve', other: '{n} imports that do not resolve' },
    rules: { one: 'Rules (1 file without a path scope)', other: 'Rules ({n} files without a path scope)' },
    memory: 'Memory index',
    outputStyle: 'Output style {name}',
    skills: { one: 'Skill descriptions (1 skill)', other: 'Skill descriptions ({n} skills)' },
    skillsFromPlugins: { one: '1 from plugins', other: '{n} from plugins' },
    agents: { one: 'Agent definitions (1 agent)', other: 'Agent definitions ({n} agents)' },
    agentsNote: 'Name and description of each agent are listed in every session; the prompt loads when the agent runs.',
    mcp: 'MCP servers ({n})',
    mcpNote: 'Each server adds its tool definitions to the session; their size is not measured here.',
    plugins: { one: 'Plugins (1 enabled)', other: 'Plugins ({n} enabled)' },
    pluginsCounted: 'Their skills and agents are counted in the layers above.',
    pluginsUnmeasured: 'What each plugin adds is not measured here.',
    pluginsNoState: { one: '1 plugin listed without an on/off state', other: '{n} plugins listed without an on/off state' },
    sessionStart: 'SessionStart hooks ({n})',
    sessionStartNote: 'What these hooks print is added to the context; its size is not measured here.',
  },
  hook: {
    type: '{type} hook',
    background: 'runs in the background',
    outside: 'runs a script outside the harness folders',
    preCommit: 'pre-commit framework config; active only where `pre-commit install` was run',
    lefthook: 'lefthook config; active only where `lefthook install` was run',
    workflow: 'workflow {name}',
  },
  plugin: {
    version: 'version {version}',
    autoUpdate: 'marketplace auto-updates',
    noInstall: 'enabled but no install record found',
  },
  mcp: {
    stateFile: 'kept in {file}, which is not part of the snapshot',
    fromPlugin: 'from plugin {name}',
  },
  harness: {
    user: '{provider} ({path})',
    agents: 'Shared agents folder',
    other: 'Agent',
  },
};

const pt = {
  layer: {
    instructions: 'instruções',
    includes: { one: 'inclui 1 arquivo importado', other: 'inclui {n} arquivos importados' },
    broken: { one: '1 import que não resolve', other: '{n} imports que não resolvem' },
    rules: { one: 'Regras (1 arquivo sem restrição de caminho)', other: 'Regras ({n} arquivos sem restrição de caminho)' },
    memory: 'Índice de memória',
    outputStyle: 'Estilo de saída {name}',
    skills: { one: 'Descrições das skills (1 skill)', other: 'Descrições das skills ({n} skills)' },
    skillsFromPlugins: { one: '1 vem de plugins', other: '{n} vêm de plugins' },
    agents: { one: 'Definições dos agentes (1 agente)', other: 'Definições dos agentes ({n} agentes)' },
    agentsNote: 'O nome e a descrição de cada agente são listados em toda sessão; o prompt só é carregado quando o agente roda.',
    mcp: 'Servidores MCP ({n})',
    mcpNote: 'Cada servidor acrescenta à sessão as definições das suas ferramentas; o tamanho delas não é medido aqui.',
    plugins: { one: 'Plugins (1 ativo)', other: 'Plugins ({n} ativos)' },
    pluginsCounted: 'As skills e os agentes deles já estão contados nas camadas acima.',
    pluginsUnmeasured: 'O que cada plugin acrescenta não é medido aqui.',
    pluginsNoState: { one: '1 plugin listado sem dizer se está ligado ou desligado', other: '{n} plugins listados sem dizer se estão ligados ou desligados' },
    sessionStart: 'Hooks de SessionStart ({n})',
    sessionStartNote: 'O que esses hooks imprimem entra no contexto; o tamanho disso não é medido aqui.',
  },
  hook: {
    type: 'hook do tipo {type}',
    background: 'roda em segundo plano',
    outside: 'roda um script que fica fora das pastas do harness',
    preCommit: 'configuração do framework pre-commit; só vale onde `pre-commit install` foi executado',
    lefthook: 'configuração do lefthook; só vale onde `lefthook install` foi executado',
    workflow: 'workflow {name}',
  },
  plugin: {
    version: 'versão {version}',
    autoUpdate: 'o marketplace se atualiza sozinho',
    noInstall: 'ativado, mas sem registro de instalação',
  },
  mcp: {
    stateFile: 'fica em {file}, que não faz parte do retrato',
    fromPlugin: 'vem do plugin {name}',
  },
  harness: {
    user: '{provider} ({path})',
    agents: 'Pasta compartilhada de agentes',
    other: 'Agente',
  },
};

export const STRINGS = { en, pt };

/** `pt`, `pt-BR`, `en`, `en-US`... -> 'pt' | 'en'. Nothing given -> English. Anything else -> null. */
export function parseLang(value) {
  if (value === undefined || value === null) return DEFAULT_LANGUAGE;
  const base = String(value).trim().toLowerCase().split(/[-_]/)[0];
  return LANGUAGES.includes(base) && Object.hasOwn(STRINGS, base) ? base : null;
}

function lookup(dict, key) {
  let v = dict;
  for (const part of key.split('.')) v = v && typeof v === 'object' ? v[part] : undefined;
  return v;
}

/**
 * A translator for one language: `t('layer.memory')`, `t('layer.skills', { n: 74 })`.
 * A language without a dictionary, or a key missing in it, falls back to English.
 */
export function translator(lang) {
  const dict = Object.hasOwn(STRINGS, lang) ? STRINGS[lang] : en;
  const t = (key, vars = {}) => {
    let v = lookup(dict, key);
    if (v === undefined) v = lookup(en, key);
    if (v === undefined) return key;
    if (v && typeof v === 'object') v = vars.n === 1 ? v.one : v.other;
    return fill(v, vars);
  };
  t.lang = Object.hasOwn(STRINGS, lang) ? lang : DEFAULT_LANGUAGE;
  return t;
}
