<div align="center">

# NovArc Powers

**Superpoderes sob demanda para o seu agente de código.**
Skills para as tarefas que você faz de vez em quando, cada uma com o perfil de instalação certo.
Claude Code, Codex e qualquer agente que lê arquivos e roda comandos. macOS, Windows e Linux.

[![CI](https://github.com/NovArc-Sistemas/novarc-powers/actions/workflows/validate.yml/badge.svg)](https://github.com/NovArc-Sistemas/novarc-powers/actions/workflows/validate.yml)
[![npm](https://img.shields.io/npm/v/novarc-powers?color=0a6cff)](https://www.npmjs.com/package/novarc-powers)
[![Licença MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-111)](LICENSE)

[English](README.en.md) · **Português**

</div>

---

NovArc Powers é uma coleção de skills para os momentos em que o seu agente precisa ir além do
dia a dia: revisar o próprio harness, medir para onde foram os tokens, deixar várias contas
iguais. Cada skill resolve uma tarefa com começo e fim, chega com o perfil de instalação que
recomendamos, e não cobra nada nas sessões em que você não a usa.

## Sumário

- [Como funciona](#como-funciona)
- [Instalação](#instalação)
- [O que tem dentro](#o-que-tem-dentro)
- [Perfis de instalação](#perfis-de-instalação)
- [Filosofia](#filosofia)
- [Atualizações](#atualizações)
- [Onde as skills guardam seus arquivos](#onde-as-skills-guardam-seus-arquivos)
- [Contribua](#contribua)

## Como funciona

Uma skill é um conjunto de instruções e scripts que o agente segue para fazer uma tarefa bem
feita. A maioria das coleções instala tudo no harness, e a descrição de cada skill passa a ser
lida em toda sessão, use você ou não. Para skills de uso raro, isso é custo sem retorno.

O NovArc Powers parte do contrário: o padrão é **sob demanda**. O instalador grava poucas linhas
no seu `CLAUDE.md` ou `AGENTS.md` dizendo que a skill existe e como buscá-la. Quando você pede
("revisa meus harness"), o agente baixa a versão fixada, lê o `SKILL.md` e segue. Nas outras
sessões, o custo é só esse bloco curto. Uma skill que você usa todo dia pode ir para o harness
de usuário ou do projeto: o instalador pergunta.

Toda skill daqui segue as mesmas regras: mede antes de opinar, explica o porquê de cada
recomendação, pede a sua confirmação antes de qualquer mudança que importa, guarda o que fez
numa pasta só e funciona igual no macOS, no Windows e no Linux.

## Instalação

Precisa de Node 20 ou mais novo.

### Qualquer agente, sem instalar nada

Cole no seu agente:

> Rode `npx -y novarc-powers fetch novarc-harness-doctor`, leia o SKILL.md no caminho que ele
> imprimir e siga as instruções.

Troque o nome pela skill que quiser. É o jeito mais rápido de experimentar.

### Instalador

```bash
npx novarc-powers
```

Detecta seus agentes (Claude Code, Codex e as ferramentas que leem `AGENTS.md` e `.agents/skills`), mostra as skills com o perfil que
recomendamos para cada uma e lista cada arquivo que vai criar ou alterar antes de pedir
confirmação.

```bash
npx novarc-powers list            # catálogo com o perfil recomendado
npx novarc-powers add <skill>     # uma skill, sem menu
npx novarc-powers status          # o que está instalado, onde e em que versão
npx novarc-powers update          # mostra o que muda e aplica após confirmar
npx novarc-powers remove <skill>
```

Todos aceitam `--yes`, `--scope user|project|both`, `--skills a,b`, `--dry-run` e `--json`,
para rodar sem menu, por um agente ou num script.

### Claude Code: marketplace de plugins

```text
/plugin marketplace add NovArc-Sistemas/novarc-powers
/plugin install novarc-harness-doctor@novarc-powers
```

Uma skill por plugin: instale só as que quiser.

### Uma versão fixa, direto do GitHub

```bash
npx -y github:NovArc-Sistemas/novarc-powers#v0.2.1 fetch <skill>
```

## O que tem dentro

### Diagnóstico e manutenção

- **[novarc-harness-doctor](skills/novarc-harness-doctor)**: revisa todos os harness da sua
  máquina (cada conta, cada projeto) numa execução só. Mede o que custaram nos últimos 30
  dias, explica cada problema com o porquê, mostra a mudança dentro do arquivo, aplica o que
  você aprovar e volta um mês depois para conferir se o efeito esperado aconteceu.
  *Perfil recomendado: execução pontual.*

Cada skill tem a própria pasta em [`skills/`](skills), com README, `SKILL.md`, scripts e
referências. Mais skills chegando: acompanhe o [CHANGELOG](CHANGELOG.md).

## Perfis de instalação

| Perfil | Para quê | O que o instalador faz | Custo em toda sessão |
|---|---|---|---|
| **Execução pontual** | Tarefa rara, com começo e fim | Grava só um bloco curto no `CLAUDE.md` / `AGENTS.md` dizendo como buscar a skill quando precisar | Poucas linhas |
| **Harness de usuário** | Hábito seu, em todo projeto | Copia a skill para `~/.claude/skills`, `~/.codex/skills` ou `~/.agents/skills` | A descrição da skill |
| **Harness de projeto** | Processo do time, versionado com o código | Copia a skill para `.claude/skills` ou `.agents/skills` do projeto | A descrição, só naquele projeto |

Cada skill vem com o perfil que recomendamos, e você pode trocar na instalação. Detalhes em
[docs/profiles.md](docs/profiles.md).

## Filosofia

- **Sob demanda primeiro.** O que entra em toda sessão custa em toda sessão. Uma skill de uso
  raro fica fora até ser chamada.
- **Medir antes de opinar.** Os números vêm dos seus próprios dados, e o que é estimado aparece
  separado do que foi medido.
- **Ensinar enquanto faz.** Cada recomendação diz por que importa, quanto custa e a regra que
  vale levar para a próxima vez.
- **Você decide.** Nada de instalar software, apagar arquivos, mudar permissões, mexer em
  segredos, fazer commit ou publicar sem a sua confirmação. Toda edição tem backup e desfazer.
- **Local primeiro.** Seus dados ficam na sua máquina, a menos que você escolha publicar algo.

## Atualizações

Na instalação você escolhe: **avisar** (recomendado), aplicar sozinho ou desligado. Uma skill é
um texto que o agente obedece com as suas permissões; ler o que mudou antes de aplicar custa um
comando (`npx novarc-powers update`).

## Onde as skills guardam seus arquivos

Toda skill usa uma pasta só, `.novarc-powers/`, na sua home ou no projeto, com uma subpasta por
skill. Desinstalar uma skill não apaga os dados dela, a menos que você peça `--purge`.

## Contribua

Ideias, correções e skills novas são bem-vindas. Leia [CONTRIBUTING.md](CONTRIBUTING.md) e o
padrão para uma skill nova em [docs/authoring.md](docs/authoring.md): uma pasta autocontida,
perfil recomendado, testes, e funcionar nos três sistemas.

## Créditos

Cada skill credita as próprias fontes no seu README.

## Licença

[MIT](LICENSE) © NovArc Sistemas
