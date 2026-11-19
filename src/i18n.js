// UI strings in English and Brazilian Portuguese. Every user-facing message
// lives here; code calls `t(key, vars)`.

const en = {
  tagline: 'Agent skills for Claude Code, Codex and AGENTS.md tools',
  detectedTools: 'Detected tools',
  noToolsDetected: 'No agent tool detected in your home directory.',
  scopePrompt: 'Where should the skills go?',
  scopeUser: 'User',
  scopeUserHint: 'every project on this machine',
  scopeProject: 'Project',
  scopeProjectHint: 'only {cwd}',
  scopeBoth: 'Both',
  scopeBothHint: 'user and project',
  toolsPrompt: 'Which tools should receive the skills?',
  skillsPrompt: 'Which skills?',
  groupOnDemand: 'On demand: a pointer line only, fetched when needed',
  groupUser: 'User: copied into your user skills folder',
  groupProject: 'Project: copied into this project',
  noSkills: 'No skills were found in the package.',
  updatesPrompt: 'How should updates be handled?',
  updatesNotify: 'Notify',
  updatesNotifyHint: 'recommended: one line when a new version exists',
  updatesAuto: 'Automatic',
  updatesAutoHint: 'warning: applies new skill instructions without review',
  updatesOff: 'Off',
  updatesOffHint: 'never check',
  summaryTitle: 'Planned changes',
  nothingToDo: 'Nothing to change: everything is already up to date.',
  confirm: 'Apply these changes?',
  cancelled: 'Cancelled. Nothing was changed.',
  done: 'Done.',
  dryRunDone: 'Dry run: nothing was written.',
  backupsMade: 'Backups of changed files: {dir}',
  conflictsTitle: 'Skipped because of hand edits (use --force to overwrite)',
  warningsTitle: 'Warnings',
  missingChoices: 'Missing required choices in non-interactive mode: {flags}. Pass them as flags or run in a terminal.',
  needYes: 'Not running in a terminal: pass --yes to confirm the changes (or --dry-run to preview).',
  needSkillArg: 'Name at least one skill.',
  notInstalled: '{skill} is not installed in the selected scope.',
  invalidOption: 'Invalid value for {flag}: {value} (allowed: {allowed}).',
  unknownCommand: 'Unknown command: {cmd}. Run novarc-powers --help.',
  unknownFlag: 'Unknown option: {flag}.',
  listTitle: 'Available skills',
  listInstalled: 'installed',
  listRecommended: 'recommended',
  statusTitle: 'Installed skills',
  statusNone: 'Nothing installed by novarc-powers.',
  statusScope: '{scope} scope ({root})',
  statusHandEdited: 'hand-edited',
  statusUpdates: 'updates: {mode}',
  updateCheckTitle: 'Update check',
  updateAvailable: '{skill}: {from} -> {to}',
  updateNone: 'Everything matches the running version {version}.',
  fetchFailed: 'Could not fetch {skill}: {error}',
  op_create: 'create',
  op_update: 'update',
  op_remove: 'remove',
  op_delete: 'remove',
  op_purge: 'delete data',
  'op_register-hook': 'register update hook',
  'op_unregister-hook': 'unregister update hook',
  help: `Usage: novarc-powers [command] [options]

Commands
  install (default)       Interactive install
  add <skill...>          Install skills
  remove <skill...>       Uninstall skills (--purge also deletes their data)
  list                    List available skills
  status                  Show what is installed, where, and hand edits
  update                  Update installed skills (--check, --force)
  fetch <skill>           Cache a skill and print the path of its SKILL.md

Options
  --yes                   Confirm without prompting
  --scope user|project|both
  --skills a,b
  --tools claude-code,codex,agents
  --profile on-demand|user|project
  --updates notify|auto|off
  --dry-run               Show the plan, write nothing
  --json                  Machine-readable output on stdout
  --cwd <dir>             Project directory (default: current directory)
  --force                 Overwrite hand-edited files
  --lang en|pt            Interface language
  --version, --help`,
};

const pt = {
  tagline: 'Skills para agentes no Claude Code, no Codex e em ferramentas AGENTS.md',
  detectedTools: 'Ferramentas detectadas',
  noToolsDetected: 'Nenhuma ferramenta de agente foi detectada na sua pasta pessoal.',
  scopePrompt: 'Onde as skills devem ficar?',
  scopeUser: 'Usuário',
  scopeUserHint: 'todos os projetos desta máquina',
  scopeProject: 'Projeto',
  scopeProjectHint: 'somente {cwd}',
  scopeBoth: 'Ambos',
  scopeBothHint: 'usuário e projeto',
  toolsPrompt: 'Quais ferramentas devem receber as skills?',
  skillsPrompt: 'Quais skills?',
  groupOnDemand: 'Sob demanda: só uma linha de referência, baixada quando precisar',
  groupUser: 'Usuário: copiada para a sua pasta de skills',
  groupProject: 'Projeto: copiada para este projeto',
  noSkills: 'Nenhuma skill foi encontrada no pacote.',
  updatesPrompt: 'Como tratar as atualizações?',
  updatesNotify: 'Avisar',
  updatesNotifyHint: 'recomendado: uma linha quando sair versão nova',
  updatesAuto: 'Automático',
  updatesAutoHint: 'atenção: aplica instruções novas das skills sem revisão',
  updatesOff: 'Desligado',
  updatesOffHint: 'nunca verificar',
  summaryTitle: 'Alterações previstas',
  nothingToDo: 'Nada a alterar: tudo já está atualizado.',
  confirm: 'Aplicar estas alterações?',
  cancelled: 'Cancelado. Nada foi alterado.',
  done: 'Concluído.',
  dryRunDone: 'Simulação: nada foi gravado.',
  backupsMade: 'Cópias de segurança dos arquivos alterados: {dir}',
  conflictsTitle: 'Ignorados por terem edições manuais (use --force para sobrescrever)',
  warningsTitle: 'Avisos',
  missingChoices: 'Faltam escolhas obrigatórias no modo não interativo: {flags}. Passe-as como opções ou rode num terminal.',
  needYes: 'Fora de um terminal: passe --yes para confirmar as alterações (ou --dry-run para pré-visualizar).',
  needSkillArg: 'Informe ao menos uma skill.',
  notInstalled: '{skill} não está instalada no escopo escolhido.',
  invalidOption: 'Valor inválido para {flag}: {value} (permitidos: {allowed}).',
  unknownCommand: 'Comando desconhecido: {cmd}. Rode novarc-powers --help.',
  unknownFlag: 'Opção desconhecida: {flag}.',
  listTitle: 'Skills disponíveis',
  listInstalled: 'instalada',
  listRecommended: 'recomendado',
  statusTitle: 'Skills instaladas',
  statusNone: 'Nada instalado pelo novarc-powers.',
  statusScope: 'escopo {scope} ({root})',
  statusHandEdited: 'editado à mão',
  statusUpdates: 'atualizações: {mode}',
  updateCheckTitle: 'Verificação de atualizações',
  updateAvailable: '{skill}: {from} -> {to}',
  updateNone: 'Tudo corresponde à versão em execução {version}.',
  fetchFailed: 'Não foi possível baixar {skill}: {error}',
  op_create: 'criar',
  op_update: 'atualizar',
  op_remove: 'remover',
  op_delete: 'remover',
  op_purge: 'apagar dados',
  'op_register-hook': 'registrar hook de atualização',
  'op_unregister-hook': 'remover hook de atualização',
  help: `Uso: novarc-powers [comando] [opções]

Comandos
  install (padrão)        Instalação interativa
  add <skill...>          Instala skills
  remove <skill...>       Desinstala skills (--purge apaga também os dados)
  list                    Lista as skills disponíveis
  status                  Mostra o que está instalado, onde, e edições manuais
  update                  Atualiza as skills instaladas (--check, --force)
  fetch <skill>           Guarda a skill em cache e imprime o caminho do SKILL.md

Opções
  --yes                   Confirma sem perguntar
  --scope user|project|both
  --skills a,b
  --tools claude-code,codex,agents
  --profile on-demand|user|project
  --updates notify|auto|off
  --dry-run               Mostra o plano sem gravar nada
  --json                  Saída legível por máquina no stdout
  --cwd <dir>             Pasta do projeto (padrão: a pasta atual)
  --force                 Sobrescreve arquivos editados à mão
  --lang en|pt            Idioma da interface
  --version, --help`,
};

export const STRINGS = { en, pt };

/** Pick the language: --lang, then LC_ALL / LC_MESSAGES / LANG, then Intl; default English. */
export function detectLang(flag, env = process.env) {
  const norm = (v) => {
    if (!v) return null;
    const s = String(v).toLowerCase();
    if (s.startsWith('pt')) return 'pt';
    if (s.startsWith('en')) return 'en';
    return null;
  };
  if (flag) return norm(flag) || 'en';
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const v = env[key];
    if (v && v !== 'C' && v !== 'POSIX') return norm(v) || 'en';
  }
  try {
    return norm(Intl.DateTimeFormat().resolvedOptions().locale) || 'en';
  } catch {
    return 'en';
  }
}

export function makeT(lang) {
  const table = STRINGS[lang] || en;
  return (key, vars = {}) => {
    const s = table[key] ?? en[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
  };
}