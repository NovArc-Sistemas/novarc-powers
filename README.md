<div align="center">

# NOVARC Powers

**Skills que deixam o seu agente de código melhor no que já faz.**
Para Claude Code, Codex e qualquer agente que lê arquivos e roda comandos. macOS, Windows e Linux.

[![CI](https://github.com/NovArc-Sistemas/novarc-powers/actions/workflows/validate.yml/badge.svg)](https://github.com/NovArc-Sistemas/novarc-powers/actions/workflows/validate.yml)
[![Licença MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-111)](LICENSE)

[English](README.en.md) · **Português**

</div>

---

## novarc-harness-doctor

Seu agente carrega instruções, permissões, hooks, skills, plugins e servidores MCP antes de você
digitar a primeira palavra. Isso é o **harness**, e ele decide quanto cada sessão custa e
quantas vezes o agente erra. O harness-doctor encontra todos os harness da sua máquina (um por
conta, um por projeto), mede o que custaram nos últimos 30 dias e mostra, num painel só, o que
está errado, por quê, e exatamente o que muda.

<p align="center">
  <img src="https://raw.githubusercontent.com/NovArc-Sistemas/novarc-powers/main/assets/board-overview.png" alt="Visão geral do painel: nota de antes e depois de cada harness, tokens gastos em ineficiências medidas e decisões pendentes" width="820">
</p>

- **Mede com os seus dados.** Lê as sessões dos últimos 30 dias, só na sua máquina, e conta os
  tokens que foram para comando repetido depois de falhar, trabalho refeito depois de uma
  correção sua, exploração às cegas e contexto carregado sem uso. Medido e estimado nunca se
  misturam.
- **Ensina enquanto diagnostica.** Cada achado vem com o porquê, o custo, a regra para levar e a
  mudança desenhada dentro do próprio arquivo: o que sai em vermelho, o que entra em verde.
- **É um explorador do seu harness.** Cada conta e cada projeto vira uma aba: instruções,
  permissões, hooks, scripts de apoio, gates, skills, MCPs e CLIs, tudo navegável.
- **Você decide, ele aplica.** Aprovar, recusar ou adiar com um clique. Toda mudança tem
  backup e pode ser desfeita com um comando.
- **Mantém suas contas iguais.** Escolha uma conta como principal; as outras do mesmo provedor
  passam a apontar para ela, e as de outros provedores recebem a parte que dá para replicar.
- **Volta para conferir.** Cada revisão fica registrada: o que foi decidido, o que mudou e o que
  cada mudança prometia economizar. Um mês depois, a mesma skill mede de novo, mostra o que se
  confirmou, o que foi desfeito e o que voltou, e reavalia cada harness.

<p align="center">
  <img src="https://raw.githubusercontent.com/NovArc-Sistemas/novarc-powers/main/assets/board-explorer.png" alt="Explorador de um harness: o arquivo de instruções com a mudança proposta em vermelho e verde e a explicação ao lado" width="820">
</p>

### Use agora, sem instalar nada

Cole no seu agente:

> Rode `npx -y github:NovArc-Sistemas/novarc-powers fetch novarc-harness-doctor`, leia o SKILL.md
> no caminho que ele imprimir e siga as instruções para revisar os meus harness.

Precisa de Node 20 ou mais novo e de git. Nada sai da sua máquina, a menos que você escolha
publicar o painel como uma página privada no claude.ai.

Detalhes: [skills/novarc-harness-doctor](skills/novarc-harness-doctor).

## Instalador

```bash
npx github:NovArc-Sistemas/novarc-powers
```

O instalador detecta seus agentes, mostra as skills agrupadas pelo perfil que recomendamos para
cada uma, e lista cada arquivo que vai criar ou alterar antes de pedir confirmação.

```bash
npx github:NovArc-Sistemas/novarc-powers list          # catálogo com o perfil recomendado
npx github:NovArc-Sistemas/novarc-powers add <skill>   # uma skill, sem menu
npx github:NovArc-Sistemas/novarc-powers status        # o que está instalado, onde e em que versão
npx github:NovArc-Sistemas/novarc-powers update        # mostra o que muda e aplica após confirmar
npx github:NovArc-Sistemas/novarc-powers remove <skill>
```

Todos aceitam `--yes`, `--scope user|project|both`, `--skills a,b`, `--dry-run` e `--json`,
para rodar sem menu (por um agente ou num script).

## Catálogo

| Skill | O que faz | Perfil recomendado | Agentes |
|---|---|---|---|
| [**novarc-harness-doctor**](skills/novarc-harness-doctor) | Encontra, mede, explica e corrige os harness dos seus agentes: uma revisão para todas as contas e projetos, num painel interativo. | Execução pontual | Claude Code · Codex · OpenCode · Cursor |

Mais skills chegando. Acompanhe o [CHANGELOG](CHANGELOG.md).

## Perfis de instalação

Cada skill vem com o perfil que recomendamos. Você pode trocar na instalação.

| Perfil | Para quê | O que o instalador faz | Custo em toda sessão |
|---|---|---|---|
| **Execução pontual** | Tarefa rara, com começo e fim | Grava só um bloco curto no `CLAUDE.md` / `AGENTS.md` dizendo como buscar a skill quando precisar | Poucas linhas |
| **Harness de usuário** | Hábito seu, em todo projeto | Copia a skill para `~/.claude/skills`, `~/.codex/skills` ou `~/.agents/skills` | A descrição da skill |
| **Harness de projeto** | Processo do time, versionado com o código | Copia a skill para `.claude/skills` ou `.agents/skills` do projeto | A descrição, só naquele projeto |

Detalhes em [docs/profiles.md](docs/profiles.md).

## Atualizações

Na instalação você escolhe: **avisar** (recomendado), aplicar sozinho ou desligado. Uma skill é
um texto que o agente obedece com as suas permissões; ler o que mudou antes de aplicar custa um
comando.

## Onde as skills guardam seus arquivos

Toda skill usa uma pasta só, `.novarc-powers/`, na sua home ou no projeto, com uma subpasta por
skill. Desinstalar uma skill não apaga os dados dela, a menos que você peça `--purge`.

## Garantias

Nenhuma skill daqui faz sem a sua confirmação: instalar software, apagar arquivos, mudar
permissões, mexer em segredos, criar um gate, ligar contas, fazer commit, push ou publicar
qualquer coisa. Segredos nunca são impressos, e toda edição tem backup antes.

## Compartilhe uma skill só

Cada pasta em [`skills/`](skills) é autocontida e tem README próprio: para mandar uma skill
para alguém, mande o link da pasta. No Claude Code também dá para usar o marketplace de
plugins, uma skill por plugin:

```text
/plugin marketplace add NovArc-Sistemas/novarc-powers
/plugin install novarc-harness-doctor@novarc-powers
```

## Contribua

Ideias e correções são bem-vindas. Leia [CONTRIBUTING.md](CONTRIBUTING.md) e o padrão para
uma skill nova em [docs/authoring.md](docs/authoring.md).

## Créditos

O motor de regras do harness-doctor e o modelo de nota ponderada foram inspirados no
[AgentShield](https://github.com/affaan-m/agentshield) (MIT). As recomendações de ferramentas
citam a fonte de cada uma em [`references/catalog`](skills/novarc-harness-doctor/references/catalog).

## Licença

[MIT](LICENSE) © NOVARC Sistemas
