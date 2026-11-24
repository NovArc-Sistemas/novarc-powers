# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versões seguem
[SemVer](https://semver.org/lang/pt-BR/).

## [Unreleased]

## [0.2.0] - 2026-11-23

### novarc-harness-doctor

#### Adicionado

- **Uma revisão para todos os harness.** A skill encontra as contas de agente da máquina e os
  repositórios git com atividade, e revisa tudo o que você escolher numa única execução, que
  fica em disco e pode ser dividida entre várias sessões.
- **Medição real de impacto.** Lê as sessões dos últimos 30 dias, localmente, e mede tokens,
  contexto no início da sessão, comandos repetidos, trabalho refeito depois de correção,
  exploração e contexto carregado sem uso. Também mostra o custo relativo, que dá peso menor à
  leitura de cache.
- **Painel novo**, com a marca NovArc: visão geral com a nota de antes e depois de cada harness,
  uma aba por harness com impacto, explorador de arquivos e diagnóstico, e uma tela para
  decidir. As mudanças aparecem dentro do arquivo, em vermelho e verde, com o porquê ao lado.
- **Decisões pelo painel.** Aprovar, recusar, adiar ou perguntar direto na página, no claude.ai
  ou numa página local; a sessão aplica o que foi aprovado.
- **Contas.** Escolha uma conta como principal: as outras do mesmo provedor são ligadas a ela,
  as de outros provedores recebem a parte replicável, e uma checagem mantém tudo em dia.
- **Motor de regras** com 23 checagens e **nota ponderada** pela origem do achado, inspirados no
  AgentShield (MIT). Defesas reconhecidas aparecem no painel e não somam pontos.
- **Cada achado ensina**: por que é um problema, o que custa, como fica melhor, a regra para
  levar e o custo da mudança.
- **Desfazer.** Toda mudança fica registrada com backup; um comando desfaz um item ou a
  revisão inteira.
- **Registro e acompanhamento.** Ao fechar, cada harness ganha um registro da revisão em
  `~/.novarc-powers/novarc-harness-doctor/history/`: decisões, mudanças aplicadas, economia
  esperada e as medições do dia. A revisão seguinte mede de novo desde então, diz por medida se
  o efeito esperado se confirmou, confere no disco se cada correção continua no lugar e mostra
  o que voltou. `run.mjs history` lista o que já foi revisado e o que está na hora de rever.
- **Decisão presa ao que você viu.** Uma aprovação vale para a versão exata da proposta; se a
  proposta mudar depois, o item volta a ficar aberto e nada é aplicado sem nova decisão.
- Veredito por skill (manter, melhorar, atualizar, aposentar, juntar), regras que nunca
  disparam, e correções repetidas que viram proposta de regra.

#### Segurança

- Credenciais nunca chegam ao painel: um achado ou uma nota que contenha uma é recusado na
  entrada, e o estado passa por uma última barreira antes de ser gravado. O mascaramento dos
  arquivos mostrados é por nome da chave (senha, token, segredo), em JSON, TOML e YAML, além
  dos formatos de token conhecidos.
- A sincronização entre contas não grava mais por cima de um arquivo que virou link ou ganhou
  outro nome, nunca trunca antes de gravar, e confere o conteúdo por trás de um link antes de
  aplicar um plano. Um desfazer parcial pode ser repetido até completar.
- As sondas de uma conta não leem mais nada de outra conta.
- Uma contagem que não pôde ser medida aparece como "não medido", nunca como zero: uma skill
  ou um servidor MCP só é dado como sem uso quando isso foi de fato medido.

#### Alterado

- O estado da revisão passou para o esquema 2 (vários harness) e vive em
  `~/.novarc-powers/novarc-harness-doctor/runs/`.
- As letras da nota passam a ser A, B, C, D e F.
- O painel é o mesmo em todo ambiente; o que muda é por onde as decisões voltam.

### Instalador

- O bloco de ponteiro no `CLAUDE.md` / `AGENTS.md` traz também o comando pelo GitHub, para
  versões que ainda não estão no npm.

## [0.1.0] - 2026-11-19

### Adicionado

- Instalador `novarc-powers` com perfis de instalação (execução pontual, harness de usuário,
  harness de projeto), manifesto, backups, `update` com detecção de edições manuais e aviso de
  versão nova.
- Skill `novarc-harness-doctor`: revisão guiada ou automática do harness de usuário e de
  projeto em oito rodadas, com nota por escopo, painel e relatório.
- Pasta de trabalho padrão `.novarc-powers/<skill>/`.
- Marketplace de plugins do Claude Code com um plugin por skill.
