// Every string `accounts.mjs list | diff | plan` shows to a person, one dictionary per language.
// Only wording lives here: ids, states, modes, options and actions are machine fields and are
// never translated. A count-dependent string is `{ one, other }` (plus `zero` where it reads
// differently), chosen by the `n` variable. Templates use {name} placeholders.
// Brand rule: no em dash and no emoji in any string.
import { fill, LANGUAGES, DEFAULT_LANGUAGE } from '../i18n.mjs';

const en = {
  label: {
    account: '{provider} · account {n}',
    agents: 'Shared agents dir',
  },
  detail: {
    primary: 'the source the other accounts follow',
    none: 'no harness elements',
    state: {
      linked: '{n} linked',
      generated: '{n} generated',
      copied: '{n} copied',
      divergent: '{n} divergent',
      missing: '{n} missing',
      'account-only': '{n} account-only',
      'not-portable': '{n} not-portable',
    },
  },
  suggest: {
    primary: 'This is the primary: the other accounts follow it.',
    inStep: 'Already follows the primary. Nothing to do.',
    nothing: 'Nothing in this account can follow the primary; mirror by hand what is listed as not-portable.',
    link: { one: 'Same provider as the primary: 1 element can be linked to it', other: 'Same provider as the primary: {n} elements can be linked to it' },
    replicate: { one: 'Another provider: 1 element can be generated from the primary', other: 'Another provider: {n} elements can be generated from the primary' },
    decisions: { one: ', 1 of them after your decision', other: ', {n} of them after your decision' },
  },
  path: {
    symlink: 'symbolic link',
    hardlink: 'hardlink: breaks when the primary is saved atomically; the sync check re-creates it',
    inherited: 'through a linked parent folder',
    primaryBroken: 'the primary has a broken link here',
    broken: 'a broken link',
    elsewhere: 'a link to another place',
    typeMismatch: 'a file on one side, a folder on the other',
    sameNotLinked: 'same content, not linked',
    tooLarge: 'too large to compare fully; treated as different',
    managedCopy: 'managed copy (a link was not possible here)',
    managedCopyStale: 'managed copy, out of date: the primary changed',
  },
  exception: 'kept as an account exception',
  importNotNeeded: 'not needed: this account keeps its own {file}',
  note: {
    skillsNative: 'skills: reads {path}/skills itself',
    skillsShared: 'skills: reads {path}/skills, where they are linked once ({id})',
    skillsNoDir: 'skills: not replicated, {path} does not exist (create it if this version reads skills from there)',
    mcpPrimaryUnreadable: 'MCP servers: the primary\'s server list cannot be read',
    mcpTargetUnreadable: 'MCP servers: {path} cannot be read',
    mcpNoState: 'MCP servers: this account has no state file yet (start it once); nothing is replicated into it',
    unresolvedImports: { one: 'instructions: 1 import of the primary does not resolve and stays as text', other: 'instructions: {n} imports of the primary do not resolve and stay as text' },
    cursor: 'Cursor keeps its user rules in the app\'s own settings, not in a file: mirror the instructions by hand.',
  },
  warning: {
    codexLimit: '{id}: the generated {file} is {kib} KiB; Codex reads {limit} KiB of instructions by default (project_doc_max_bytes). Trim the primary or raise the limit in config.toml.',
    codexOverride: '{id}: AGENTS.override.md exists, so Codex ignores {file} in that folder.',
    closeApps: 'Close the agent apps of the accounts involved before applying: a running app can rewrite its own config and undo a change.',
    otherPrimary: 'The accounts are already synced from {id}. Applying this plan needs --new-primary and starts the bookkeeping over; undo the earlier run first if its links should go.',
    unfinished: {
      one: 'An earlier run did not finish (the process died or was stopped): {stamps}. Take back what it had done first, with "node accounts.mjs undo --stamp {stamps} --yes", then plan again.',
      other: '{n} earlier runs did not finish (the process died or was stopped): {stamps}. Take back what they had done first, newest first, with "node accounts.mjs undo --stamp <stamp> --yes" for each, then plan again.',
    },
  },
  instruction: {
    noSource: 'the primary has no instruction file to generate it from',
    outOfDate: 'out of date: the primary changed',
    generatedEdited: 'a generated file that was then edited by hand',
    moved: 'a generated file that is now a link, shares its content with another file, or sits behind a redirected folder',
    own: 'written for this account',
  },
  mcp: {
    fixed: 'defined in a form this tool does not rewrite',
    foreignIdentical: 'defined by the account itself, identical to the primary',
    foreignExtras: 'defined by the account itself: the primary\'s definition plus settings of its own; left as it is',
    edited: 'replicated, then edited by hand in this account',
    outOfDate: 'out of date: the primary changed',
    gone: 'no longer in the primary; the replicated copy is removed',
    goneEdited: 'was replicated, then edited here; no longer in the primary',
    blocked: {
      'inline-secret': 'carries an inline secret ({where}); move it to an environment variable in the primary first',
      sse: 'SSE transport has no equivalent in the target; use a streamable HTTP endpoint',
      'command-expansion': 'the command uses variable expansion',
      'arg-expansion': 'an argument uses variable expansion the target cannot express',
      'env-expansion': 'env {name} uses variable expansion the target cannot express',
      'url-expansion': 'the URL uses variable expansion',
      'header-expansion': 'header {name} uses variable expansion the target cannot express',
      'unknown-transport': 'unknown transport',
      'not-object': 'the definition is not an object',
      'env-vars-remote': 'env_vars uses a remote source',
      'auth-helper': 'uses an auth helper that has no equivalent in the target',
      disabled: 'disabled in the primary',
      'bad-name': 'the name is not valid for Codex (letters, digits and - _ : @ / . only)',
    },
  },
  notPortable: {
    claude: {
      permissions: '{deny} deny, {ask} ask and {allow} allow rules live in settings.json and have no file-level equivalent elsewhere. Mirror the intent by hand: in Codex, approval_policy and sandbox_mode in config.toml.',
      hooks: 'Hook events and payloads differ per provider. Re-create each gate by hand for the target\'s own events; in Codex a hook also has to be trusted through /hooks.',
      hooksEvents: 'Hook events and payloads differ per provider (registered here: {events}). Re-create each gate by hand for the target\'s own events; in Codex a hook also has to be trusted through /hooks.',
      plugins: {
        zero: 'Plugins and their marketplaces are specific to Claude Code. Install the target\'s equivalent, or replicate the skills they ship.',
        one: '1 enabled plugin and its marketplace are specific to Claude Code. Install the target\'s equivalent, or replicate the skills it ships.',
        other: '{n} enabled plugins and their marketplaces are specific to Claude Code. Install the target\'s equivalent, or replicate the skills they ship.',
      },
      keybindings: 'Key bindings belong to each app; set them in the target app.',
      agents: 'Subagent definitions use Claude Code\'s own format. Rewrite the ones you need in the target\'s format, or fold their content into the instruction file.',
      commands: 'Slash commands use Claude Code\'s own format. Rewrite the ones you need in the target\'s format, or fold their content into the instruction file.',
      rules: 'Rule files use Claude Code\'s own format. Rewrite the ones you need in the target\'s format, or fold their content into the instruction file.',
      'output-styles': 'Output styles use Claude Code\'s own format. Rewrite the ones you need in the target\'s format, or fold their content into the instruction file.',
    },
    codex: {
      permissions: 'Sandbox mode and approval policy live in config.toml. Mirror the intent by hand with the target\'s permission rules.',
      hooks: 'Hook events and payloads differ per provider. Re-create each gate by hand for the target\'s own events.',
      agents: 'Agent definitions use Codex\'s own format. Rewrite the ones you need in the target\'s format.',
      prompts: 'Custom prompts use Codex\'s own format. Rewrite the ones you need in the target\'s format.',
    },
  },
  plan: {
    nothing: 'nothing',
    alreadyLinked: 'already linked to the primary',
    alreadyLinkedRecorded: 'already linked to the primary; recorded so the sync check watches it',
    upToDate: 'already generated and up to date',
    hardlinkBackup: 'the hardlink itself; kept so the change can be undone',
    hardlinkReplaces: 'a hardlink to the same file',
    hardlinkWhy: 'a symbolic link survives an atomic save of the primary; where the OS refuses one, the hardlink is made again',
    primaryChanged: 'the primary changed',
    staleServerReplaces: 'the definition this tool wrote earlier',
    serverGone: 'the primary no longer has this server (or it can no longer be replicated); the replicated copy is removed',
    staleFileReplaces: 'the file this tool generated earlier (unedited)',
    staleCopyBackup: 'the earlier managed copy (unedited); kept so the change can be undone',
    staleCopyReplaces: 'the managed copy this tool made earlier',
    notReplicated: 'not replicated: {note}',
    keptChoice: 'kept as an account exception (your choice)',
    keptEarlier: 'kept as an account exception (decided earlier)',
    importSkipped: 'imported by the primary\'s {file}, which this account does not follow; link that file first',
    serverAdoptReplaces: 'an identical definition the account wrote itself',
    serverAdoptWhy: 'identical to the primary: taken into the managed part so it follows the primary from now on',
    serverWriteWhy: 'replicated from the primary into the managed part of the file',
    instructionWhy: 'generated from the primary\'s instructions, imports inlined and provider fences applied',
    copyBackup: 'an identical copy; kept so the change can be undone',
    copyReplaces: 'an identical copy',
    brokenReplaces: 'a broken link',
    linkWhy: 'same provider: the element becomes a link into the primary',
    skillWhy: 'the skill folder becomes a link into the primary',
    keptDivergent: 'differs from the primary; kept as an account exception',
    keptOnly: 'exists only in this account; kept as an account exception',
    serverReplaceReplaces: 'the account\'s own definition (your choice); the old one stays in the undo journal',
    serverReplaceWhy: 'replaced with the primary\'s definition',
    ownFileBackup: 'the account\'s own file; moved, not deleted',
    ownFileReplaces: 'the account\'s own file (your choice)',
    instructionReplaceWhy: 'generated from the primary\'s instructions',
    dropBackup: 'the primary has no such element; moved out of the account (your choice), not deleted',
    ownVersionBackup: 'the account\'s own version; moved, not deleted',
    ownVersionReplaces: 'the account\'s own version (your choice)',
    becomesLink: 'the element becomes a link into the primary',
    primaryBackup: 'the primary\'s current version; kept so the change can be undone',
    adoptFolderReplaces: 'nothing: only entries the primary lacks are added; where both have an entry the primary\'s stays',
    adoptFileReplaces: 'the primary\'s version (your choice)',
    adoptWhy: 'brought into the primary',
    originalBackup: 'the account\'s original; moved, not deleted',
    adoptLinkReplaces: 'the account\'s own version',
  },
  conflict: {
    serverAdopt: 'To adopt this definition, add the server to the primary with its own CLI and plan again.',
    serverFixed: 'This definition is written in a form the tool does not rewrite.',
    serverOnlyHere: 'A server that exists only here stays here; add it to the primary with its own CLI if every account should have it.',
    instructionNoAdopt: 'A generated file cannot be turned back into the primary\'s source; merge by hand what you want to keep into the primary first.',
  },
};

const pt = {
  label: {
    account: '{provider} · conta {n}',
    agents: 'Pasta compartilhada de agentes',
  },
  detail: {
    primary: 'a fonte que as outras contas seguem',
    none: 'nenhum elemento de harness',
    state: {
      linked: { one: '1 vinculado', other: '{n} vinculados' },
      generated: { one: '1 gerado', other: '{n} gerados' },
      copied: { one: '1 copiado', other: '{n} copiados' },
      divergent: { one: '1 divergente', other: '{n} divergentes' },
      missing: { one: '1 faltando', other: '{n} faltando' },
      'account-only': { one: '1 só nesta conta', other: '{n} só nesta conta' },
      'not-portable': { one: '1 não portável', other: '{n} não portáveis' },
    },
  },
  suggest: {
    primary: 'Esta é a conta principal: as outras a seguem.',
    inStep: 'Já segue a conta principal. Nada a fazer.',
    nothing: 'Nada nesta conta pode seguir a conta principal; espelhe manualmente o que aparece como não portável.',
    link: { one: 'Mesmo provedor da conta principal: 1 elemento pode ser vinculado a ela', other: 'Mesmo provedor da conta principal: {n} elementos podem ser vinculados a ela' },
    replicate: { one: 'Outro provedor: 1 elemento pode ser gerado a partir da conta principal', other: 'Outro provedor: {n} elementos podem ser gerados a partir da conta principal' },
    decisions: { one: ', 1 deles depois da sua decisão', other: ', {n} deles depois da sua decisão' },
  },
  path: {
    symlink: 'link simbólico',
    hardlink: 'hardlink: quebra quando a conta principal é salva de forma atômica; a verificação de sincronia o recria',
    inherited: 'por uma pasta superior vinculada',
    primaryBroken: 'a conta principal tem um link quebrado aqui',
    broken: 'um link quebrado',
    elsewhere: 'um link para outro lugar',
    typeMismatch: 'um arquivo de um lado, uma pasta do outro',
    sameNotLinked: 'mesmo conteúdo, sem vínculo',
    tooLarge: 'grande demais para comparar por inteiro; tratado como diferente',
    managedCopy: 'cópia gerenciada (aqui não foi possível criar um link)',
    managedCopyStale: 'cópia gerenciada desatualizada: a conta principal mudou',
  },
  exception: 'mantido como exceção da conta',
  importNotNeeded: 'desnecessário: esta conta mantém o seu próprio {file}',
  note: {
    skillsNative: 'skills: lê {path}/skills por conta própria',
    skillsShared: 'skills: lê {path}/skills, onde são vinculadas uma única vez ({id})',
    skillsNoDir: 'skills: não replicadas, {path} não existe (crie a pasta se esta versão lê skills dali)',
    mcpPrimaryUnreadable: 'Servidores MCP: a lista de servidores da conta principal não pôde ser lida',
    mcpTargetUnreadable: 'Servidores MCP: {path} não pôde ser lido',
    mcpNoState: 'Servidores MCP: esta conta ainda não tem arquivo de estado (inicie-a uma vez); nada é replicado nela',
    unresolvedImports: { one: 'instruções: 1 import da conta principal não resolve e fica como texto', other: 'instruções: {n} imports da conta principal não resolvem e ficam como texto' },
    cursor: 'O Cursor guarda as regras do usuário nas configurações do próprio app, não em arquivo: espelhe as instruções manualmente.',
  },
  warning: {
    codexLimit: '{id}: o {file} gerado tem {kib} KiB; o Codex lê {limit} KiB de instruções por padrão (project_doc_max_bytes). Enxugue a conta principal ou aumente o limite no config.toml.',
    codexOverride: '{id}: existe AGENTS.override.md, então o Codex ignora o {file} dessa pasta.',
    closeApps: 'Feche os apps de agente das contas envolvidas antes de aplicar: um app em execução pode reescrever a própria configuração e desfazer uma mudança.',
    otherPrimary: 'As contas já estão sincronizadas a partir de {id}. Aplicar este plano exige --new-primary e reinicia o registro; desfaça a execução anterior antes, se os vínculos dela devem sair.',
    unfinished: {
      one: 'Uma execução anterior não terminou (o processo morreu ou foi interrompido): {stamps}. Desfaça antes o que ela chegou a fazer, com "node accounts.mjs undo --stamp {stamps} --yes", e planeje de novo.',
      other: '{n} execuções anteriores não terminaram (o processo morreu ou foi interrompido): {stamps}. Desfaça antes o que elas chegaram a fazer, da mais recente para a mais antiga, com "node accounts.mjs undo --stamp <stamp> --yes" para cada uma, e planeje de novo.',
    },
  },
  instruction: {
    noSource: 'a conta principal não tem arquivo de instruções para gerá-lo',
    outOfDate: 'desatualizado: a conta principal mudou',
    generatedEdited: 'um arquivo gerado que depois foi editado à mão',
    moved: 'um arquivo gerado que agora é um link, divide o conteúdo com outro arquivo ou está atrás de uma pasta redirecionada',
    own: 'escrito para esta conta',
  },
  mcp: {
    fixed: 'definido de uma forma que esta ferramenta não reescreve',
    foreignIdentical: 'definido pela própria conta, idêntico ao da conta principal',
    foreignExtras: 'definido pela própria conta: a definição da conta principal mais configurações próprias; fica como está',
    edited: 'replicado e depois editado à mão nesta conta',
    outOfDate: 'desatualizado: a conta principal mudou',
    gone: 'não está mais na conta principal; a cópia replicada é removida',
    goneEdited: 'foi replicado e depois editado aqui; não está mais na conta principal',
    blocked: {
      'inline-secret': 'contém um segredo embutido ({where}); mova-o antes para uma variável de ambiente na conta principal',
      sse: 'o transporte SSE não tem equivalente no destino; use um endpoint HTTP com streaming',
      'command-expansion': 'o comando usa expansão de variáveis',
      'arg-expansion': 'um argumento usa expansão de variáveis que o destino não consegue expressar',
      'env-expansion': 'a variável env {name} usa uma expansão que o destino não consegue expressar',
      'url-expansion': 'a URL usa expansão de variáveis',
      'header-expansion': 'o cabeçalho {name} usa expansão de variáveis que o destino não consegue expressar',
      'unknown-transport': 'transporte desconhecido',
      'not-object': 'a definição não é um objeto',
      'env-vars-remote': 'env_vars usa uma origem remota',
      'auth-helper': 'usa um auxiliar de autenticação sem equivalente no destino',
      disabled: 'desativado na conta principal',
      'bad-name': 'o nome não é válido no Codex (apenas letras, dígitos e - _ : @ / .)',
    },
  },
  notPortable: {
    claude: {
      permissions: 'As regras de permissão ({deny} de negar, {ask} de perguntar, {allow} de permitir) ficam no settings.json e não têm equivalente em arquivo nos outros provedores. Espelhe a intenção manualmente: no Codex, approval_policy e sandbox_mode no config.toml.',
      hooks: 'Os eventos e os dados dos hooks mudam de um provedor para outro. Recrie cada gate manualmente para os eventos do destino; no Codex o hook ainda precisa ser aprovado em /hooks.',
      hooksEvents: 'Os eventos e os dados dos hooks mudam de um provedor para outro (registrados aqui: {events}). Recrie cada gate manualmente para os eventos do destino; no Codex o hook ainda precisa ser aprovado em /hooks.',
      plugins: {
        zero: 'Os plugins e os marketplaces deles são específicos do Claude Code. Instale o equivalente no destino ou replique as skills que eles trazem.',
        one: '1 plugin ativo e o marketplace dele são específicos do Claude Code. Instale o equivalente no destino ou replique as skills que ele traz.',
        other: '{n} plugins ativos e os marketplaces deles são específicos do Claude Code. Instale o equivalente no destino ou replique as skills que eles trazem.',
      },
      keybindings: 'Os atalhos de teclado pertencem a cada app; configure-os no app de destino.',
      agents: 'As definições de subagentes usam o formato próprio do Claude Code. Reescreva as que precisar no formato do destino ou incorpore o conteúdo ao arquivo de instruções.',
      commands: 'Os comandos de barra usam o formato próprio do Claude Code. Reescreva os que precisar no formato do destino ou incorpore o conteúdo ao arquivo de instruções.',
      rules: 'Os arquivos de regras usam o formato próprio do Claude Code. Reescreva os que precisar no formato do destino ou incorpore o conteúdo ao arquivo de instruções.',
      'output-styles': 'Os estilos de saída usam o formato próprio do Claude Code. Reescreva os que precisar no formato do destino ou incorpore o conteúdo ao arquivo de instruções.',
    },
    codex: {
      permissions: 'O modo de sandbox e a política de aprovação ficam no config.toml. Espelhe a intenção manualmente com as regras de permissão do destino.',
      hooks: 'Os eventos e os dados dos hooks mudam de um provedor para outro. Recrie cada gate manualmente para os eventos do destino.',
      agents: 'As definições de agentes usam o formato próprio do Codex. Reescreva as que precisar no formato do destino.',
      prompts: 'Os prompts personalizados usam o formato próprio do Codex. Reescreva os que precisar no formato do destino.',
    },
  },
  plan: {
    nothing: 'nada',
    alreadyLinked: 'já vinculado à conta principal',
    alreadyLinkedRecorded: 'já vinculado à conta principal; registrado para a verificação de sincronia acompanhar',
    upToDate: 'já gerado e atualizado',
    hardlinkBackup: 'o próprio hardlink; guardado para a mudança poder ser desfeita',
    hardlinkReplaces: 'um hardlink para o mesmo arquivo',
    hardlinkWhy: 'um link simbólico sobrevive a um salvamento atômico da conta principal; onde o sistema recusa, o hardlink é refeito',
    primaryChanged: 'a conta principal mudou',
    staleServerReplaces: 'a definição que esta ferramenta escreveu antes',
    serverGone: 'a conta principal não tem mais este servidor (ou ele não pode mais ser replicado); a cópia replicada é removida',
    staleFileReplaces: 'o arquivo que esta ferramenta gerou antes (sem edições)',
    staleCopyBackup: 'a cópia gerenciada anterior (sem edições); guardada para a mudança poder ser desfeita',
    staleCopyReplaces: 'a cópia gerenciada que esta ferramenta fez antes',
    notReplicated: 'não replicado: {note}',
    keptChoice: 'mantido como exceção da conta (sua escolha)',
    keptEarlier: 'mantido como exceção da conta (decidido antes)',
    importSkipped: 'importado pelo {file} da conta principal, que esta conta não segue; vincule esse arquivo primeiro',
    serverAdoptReplaces: 'uma definição idêntica escrita pela própria conta',
    serverAdoptWhy: 'idêntico ao da conta principal: passa para a parte gerenciada e segue a conta principal daqui em diante',
    serverWriteWhy: 'replicado da conta principal para a parte gerenciada do arquivo',
    instructionWhy: 'gerado a partir das instruções da conta principal, com os imports embutidos e as marcações por provedor aplicadas',
    copyBackup: 'uma cópia idêntica; guardada para a mudança poder ser desfeita',
    copyReplaces: 'uma cópia idêntica',
    brokenReplaces: 'um link quebrado',
    linkWhy: 'mesmo provedor: o elemento vira um link para a conta principal',
    skillWhy: 'a pasta da skill vira um link para a conta principal',
    keptDivergent: 'difere da conta principal; mantido como exceção da conta',
    keptOnly: 'existe só nesta conta; mantido como exceção da conta',
    serverReplaceReplaces: 'a definição própria da conta (sua escolha); a antiga fica no registro de desfazer',
    serverReplaceWhy: 'substituída pela definição da conta principal',
    ownFileBackup: 'o arquivo próprio da conta; movido, não apagado',
    ownFileReplaces: 'o arquivo próprio da conta (sua escolha)',
    instructionReplaceWhy: 'gerado a partir das instruções da conta principal',
    dropBackup: 'a conta principal não tem esse elemento; movido para fora da conta (sua escolha), não apagado',
    ownVersionBackup: 'a versão própria da conta; movida, não apagada',
    ownVersionReplaces: 'a versão própria da conta (sua escolha)',
    becomesLink: 'o elemento vira um link para a conta principal',
    primaryBackup: 'a versão atual da conta principal; guardada para a mudança poder ser desfeita',
    adoptFolderReplaces: 'nada: só entram os itens que faltam na conta principal; onde as duas têm o item, fica o da conta principal',
    adoptFileReplaces: 'a versão da conta principal (sua escolha)',
    adoptWhy: 'trazido para a conta principal',
    originalBackup: 'o original da conta; movido, não apagado',
    adoptLinkReplaces: 'a versão própria da conta',
  },
  conflict: {
    serverAdopt: 'Para adotar esta definição, adicione o servidor à conta principal com a CLI do próprio provedor e planeje de novo.',
    serverFixed: 'Esta definição está escrita de uma forma que a ferramenta não reescreve.',
    serverOnlyHere: 'Um servidor que existe só aqui fica aqui; adicione-o à conta principal com a CLI do próprio provedor se todas as contas devem tê-lo.',
    instructionNoAdopt: 'Um arquivo gerado não volta a ser a fonte da conta principal; antes, junte à mão na conta principal o que quiser manter.',
  },
};

export const STRINGS = { en, pt };

/** `pt`, `pt-BR`, `en`, `en-US`... -> 'pt' | 'en'. Nothing given -> English. Anything else -> null. */
export function parseLang(value) {
  if (value === undefined || value === null) return DEFAULT_LANGUAGE;
  const base = String(value).trim().toLowerCase().split(/[-_]/)[0];
  return LANGUAGES.includes(base) ? base : null;
}

function lookup(dict, key) {
  let v = dict;
  for (const part of key.split('.')) v = v && typeof v === 'object' ? v[part] : undefined;
  return v;
}

/**
 * A translator for one language: `t('plan.linkWhy')`, `t('detail.state.missing', { n: 3 })`.
 * A key missing in that language falls back to English, then to the key itself.
 */
export function translator(lang) {
  const dict = STRINGS[LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE];
  const t = (key, vars = {}) => {
    let v = lookup(dict, key);
    if (v === undefined) v = lookup(en, key);
    if (v === undefined) return key;
    if (v && typeof v === 'object') v = vars.n === 0 && v.zero !== undefined ? v.zero : vars.n === 1 ? v.one : v.other;
    return fill(v, vars);
  };
  t.lang = LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
  /** True when the dictionary has that key (used for codes that come from elsewhere). */
  t.has = (key) => lookup(en, key) !== undefined;
  return t;
}
