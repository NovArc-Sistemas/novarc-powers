// Board chrome strings for render-board.mjs, one dictionary per language.
// Only labels live here: enum VALUES in state.json never change; each value maps to a label.
// Templates use {name} placeholders, filled by `fill()` (server) or the same logic in the client.

export const LANGUAGES = ['en', 'pt'];
export const DEFAULT_LANGUAGE = 'en';
export const LOCALES = { en: 'en-US', pt: 'pt-BR' };

export const STRINGS = {
  en: {
    title: 'Harness board {name}',
    heading: 'Harness board: {name}',
    mode: 'Mode',
    scopesLabel: 'Scopes',
    date: 'Date',
    agent: 'Agent',
    agentOn: '{agent} on {os}',
    noscript: 'This board renders with JavaScript. Without it, read board.md next to this file.',
    hScores: 'Scores',
    hLayers: 'Layers, in load order',
    hRounds: 'Rounds',
    hItems: 'Items',
    hItemsByRound: 'Items by round',
    hQueue: 'Queue',
    hInventory: 'Inventory',
    hLeads: 'Unconfirmed leads',
    hLog: 'Log',
    scoreAria: '{scope} score',
    notScored: 'not scored',
    outOf: '/ 100',
    baselineCurrent: 'Baseline {baseline} → current {current}',
    previousRun: 'Previous run {previous}',
    none: 'none',
    roundsOf: '{n} of {m} rounds',
    countOf: '{n} of {m}',
    pointsOf: '{score} of {weight}',
    tokensPerSession: '{scope} · ~{total} tokens per session',
    tokensPerSessionMd: '{scope} (~{total} tokens per session)',
    noLayers: 'No layers recorded.',
    all: 'all',
    itemsCount: '{n} of {m} items',
    noItemsMatch: 'No items match.',
    noItems: 'No items.',
    nothingQueued: 'Nothing queued.',
    inventoryEmpty: 'Inventory is empty.',
    flagged: '{n} flagged',
    noLeads: 'No unconfirmed leads.',
    logEmpty: 'Log is empty.',
    scopeByRound: '{scope} by round',
    roundHeading: 'Round {n}: {name}',
    queueEntry: '{scope}, round {round}, {severity}, {class}',
    col: {
      round: 'Round', weight: 'Weight', status: 'Status', score: 'Score', items: 'Items', scope: 'Scope',
      grade: 'Grade', baseline: 'Baseline', previous: 'Previous', roundsCounted: 'Rounds counted',
      num: '#', kind: 'Kind', name: 'Name', path: 'Path', tokens: 'Tokens', id: 'ID', severity: 'Severity',
      class: 'Class', title: 'Title', verdict: 'Verdict', detail: 'Detail', opinion: 'Opinion', item: 'Item',
      at: 'At', entry: 'Entry',
    },
    filter: { scope: 'scope', round: 'round', status: 'status', severity: 'severity' },
    field: {
      finding: 'Finding', evidence: 'Evidence', proposal: 'Proposal', opinion: 'Opinion', decision: 'Decision',
      verified: 'Verified', notVerified: 'Not verified', backup: 'Backup', updated: 'Updated',
    },
    rounds: {
      1: 'Security and permissions',
      2: 'Instructions and structure',
      3: 'Documentation',
      4: 'Gates and automation',
      5: 'Cleanup',
      6: 'Skills and knowledge',
      7: 'CLIs, MCP servers and tools',
      8: 'External dependencies',
    },
    scopeHarness: { user: 'User harness', project: 'Project harness' },
    scope: { user: 'user', project: 'project' },
    scopeTitle: { user: 'User', project: 'Project' },
    status: {
      open: 'open', queued: 'queued', 'in-progress': 'in progress', fixed: 'fixed', accepted: 'accepted',
      failed: 'failed', ok: 'ok', 'wontfix-not-applicable': 'not applicable',
    },
    roundStatus: { pending: 'pending', done: 'done', skipped: 'skipped', 'not-applicable': 'not applicable' },
    severity: { critical: 'critical', high: 'high', medium: 'medium', low: 'low' },
    verdict: { fine: 'ok', attention: 'attention', problem: 'problem' },
    class: {
      reversible: 'reversible', additive: 'additive', 'translate-agent': 'translate (agent)',
      'translate-human': 'translate (human)', permission: 'permission', secret: 'secret', delete: 'delete',
      install: 'install', gate: 'gate', external: 'external', none: 'none',
    },
    kind: {
      instructions: 'instructions', settings: 'settings', permissions: 'permissions', hooks: 'hooks',
      skills: 'skills', plugins: 'plugins', mcp: 'mcp', memory: 'memory', docs: 'docs', clis: 'clis', other: 'other',
    },
    modeName: { guided: 'guided review', doctor: 'doctor' },
  },
  pt: {
    title: 'Painel do harness {name}',
    heading: 'Painel do harness: {name}',
    mode: 'Modo',
    scopesLabel: 'Escopos',
    date: 'Data',
    agent: 'Agente',
    agentOn: '{agent} em {os}',
    noscript: 'Este painel é desenhado com JavaScript. Sem ele, leia o board.md ao lado deste arquivo.',
    hScores: 'Notas',
    hLayers: 'Camadas, em ordem de carga',
    hRounds: 'Rodadas',
    hItems: 'Itens',
    hItemsByRound: 'Itens por rodada',
    hQueue: 'Fila',
    hInventory: 'Inventário',
    hLeads: 'Pistas não confirmadas',
    hLog: 'Registro',
    scoreAria: 'Nota do {scope}',
    notScored: 'sem nota',
    outOf: '/ 100',
    baselineCurrent: 'Linha de base {baseline} → atual {current}',
    previousRun: 'Execução anterior {previous}',
    none: 'nenhuma',
    roundsOf: '{n} de {m} rodadas',
    countOf: '{n} de {m}',
    pointsOf: '{score} de {weight}',
    tokensPerSession: '{scope} · ~{total} tokens por sessão',
    tokensPerSessionMd: '{scope} (~{total} tokens por sessão)',
    noLayers: 'Nenhuma camada registrada.',
    all: 'todos',
    itemsCount: '{n} de {m} itens',
    noItemsMatch: 'Nenhum item corresponde.',
    noItems: 'Nenhum item.',
    nothingQueued: 'Nada na fila.',
    inventoryEmpty: 'O inventário está vazio.',
    flagged: '{n} com alerta',
    noLeads: 'Nenhuma pista não confirmada.',
    logEmpty: 'O registro está vazio.',
    scopeByRound: '{scope} por rodada',
    roundHeading: 'Rodada {n}: {name}',
    queueEntry: '{scope}, rodada {round}, {severity}, {class}',
    col: {
      round: 'Rodada', weight: 'Peso', status: 'Status', score: 'Nota', items: 'Itens', scope: 'Escopo',
      grade: 'Conceito', baseline: 'Linha de base', previous: 'Anterior', roundsCounted: 'Rodadas contadas',
      num: '#', kind: 'Tipo', name: 'Nome', path: 'Caminho', tokens: 'Tokens', id: 'ID', severity: 'Severidade',
      class: 'Classe', title: 'Título', verdict: 'Veredito', detail: 'Detalhe', opinion: 'Opinião', item: 'Item',
      at: 'Quando', entry: 'Entrada',
    },
    filter: { scope: 'escopo', round: 'rodada', status: 'status', severity: 'severidade' },
    field: {
      finding: 'Achado', evidence: 'Evidência', proposal: 'Proposta', opinion: 'Opinião', decision: 'Decisão',
      verified: 'Verificado', notVerified: 'Não verificado', backup: 'Backup', updated: 'Atualizado',
    },
    rounds: {
      1: 'Segurança e permissões',
      2: 'Instruções e estrutura',
      3: 'Documentação',
      4: 'Gates e automação',
      5: 'Limpeza',
      6: 'Skills e conhecimento',
      7: 'CLIs, MCPs e ferramentas',
      8: 'Dependências externas',
    },
    scopeHarness: { user: 'Harness de usuário', project: 'Harness de projeto' },
    scope: { user: 'usuário', project: 'projeto' },
    scopeTitle: { user: 'Usuário', project: 'Projeto' },
    status: {
      open: 'aberto', queued: 'na fila', 'in-progress': 'em andamento', fixed: 'corrigido', accepted: 'aceito',
      failed: 'falhou', ok: 'ok', 'wontfix-not-applicable': 'não se aplica',
    },
    roundStatus: { pending: 'pendente', done: 'concluída', skipped: 'pulada', 'not-applicable': 'não se aplica' },
    severity: { critical: 'crítica', high: 'alta', medium: 'média', low: 'baixa' },
    verdict: { fine: 'ok', attention: 'atenção', problem: 'problema' },
    class: {
      reversible: 'reversível', additive: 'aditiva', 'translate-agent': 'tradução (agente)',
      'translate-human': 'tradução (humano)', permission: 'permissão', secret: 'segredo', delete: 'exclusão',
      install: 'instalação', gate: 'gate', external: 'externa', none: 'nenhuma',
    },
    kind: {
      instructions: 'instruções', settings: 'configurações', permissions: 'permissões', hooks: 'hooks',
      skills: 'skills', plugins: 'plugins', mcp: 'mcp', memory: 'memória', docs: 'documentação', clis: 'clis', other: 'outro',
    },
    modeName: { guided: 'revisão guiada', doctor: 'doctor' },
  },
};

/** `state.language`, else the --lang flag, else English. Anything unsupported falls back to English. */
export function resolveLanguage(stateLanguage, flagLanguage) {
  if (LANGUAGES.includes(stateLanguage)) return stateLanguage;
  if (LANGUAGES.includes(flagLanguage)) return flagLanguage;
  return DEFAULT_LANGUAGE;
}

/** Replace {key} placeholders. Unknown keys are left as written. */
export function fill(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Label for an enum value from one of the dictionary maps; the raw value when no label exists. */
export function label(map, value) {
  return map && Object.prototype.hasOwnProperty.call(map, value) ? map[value] : String(value ?? '');
}

/**
 * JS source for a plain object, with every string single-quoted and `<` escaped, so it is safe
 * inside an inline <script> (no `</script>` can appear) and deterministic across runs.
 */
export function jsLiteral(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') {
    return "'" + v
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026') + "'";
  }
  if (Array.isArray(v)) return '[' + v.map(jsLiteral).join(', ') + ']';
  return '{ ' + Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${jsLiteral(x)}`).join(', ') + ' }';
}
