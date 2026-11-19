# novarc-harness-doctor

**Português** · [English](README.en.md)

Revisa o harness do seu agente de código, dá uma nota de 0 a 100 e corrige com você.

O harness é tudo o que molda uma sessão antes de você digitar: arquivos de instrução,
permissões, hooks, skills, plugins, servidores MCP, CLIs, a documentação do projeto e os gates
que impedem erros.

## Como usar

Sem instalar nada, peça ao seu agente:

> Rode `npx -y novarc-powers fetch novarc-harness-doctor`, leia o SKILL.md no caminho que ele
> imprimir e siga as instruções para revisar meu harness.

Ou instale o ponteiro com `npx novarc-powers add novarc-harness-doctor`. Depois basta pedir
"revisa meu harness" em qualquer sessão.

## O que ela faz

1. **Pergunta** o escopo (harness de usuário, de projeto ou os dois) e o modo.
2. **Descobre**, sem alterar nada: todas as pastas de configuração de todas as contas, imports
   que não resolvem, segredos expostos (sempre mascarados), CLIs instalados, documentação,
   hooks e, no projeto, onde as sessões anteriores costumam falhar.
3. **Monta um painel** com a nota de cada escopo, o inventário completo (incluindo o que está
   certo, com opinião em cada item) e a fila de decisões.
4. **Percorre oito rodadas**: segurança e permissões; instruções e estrutura; documentação;
   gates e automação; limpeza; skills e conhecimento; CLIs, MCPs e ferramentas; dependências externas.
5. **Corrige item a item**: backup, execução, verificação depois da mudança e registro do que
   não deu para verificar.

## Os dois modos

| | Revisão guiada | Doctor |
|---|---|---|
| Correções reversíveis com backup | você decide | aplica sozinho |
| Acréscimos (regra que falta, índice de skills) | você decide | aplica sozinho |
| Tradução de arquivos de agente para inglês | você decide | deixa pronta para você aprovar |
| Ligar recurso opcional confirmado para a sua versão | você decide | aplica e testa |
| Permissões, segredos, exclusões, instalações, gates, MCPs | você decide | fila para você |

## O que ela recomenda

Só o que foi verificado na fonte, com data. Hoje:

- **Superpowers**, como metodologia que dispara sozinha, mais um índice curto de skills no
  `CLAUDE.md` para que elas sejam usadas sem você pedir.
- **rtk**, **caveman** e **ponytail**, para gastar menos tokens, avisando onde eles se sobrepõem.
- **Graphify** em projetos de código, conferindo se os hooks de atualização do grafo funcionam
  sem atrasar o desenvolvimento e se o agente foi instruído a consultar o grafo.
- **Arquivos para agentes em inglês**, que custam menos tokens.
- **Gates** a partir dos problemas que você teve de fato no projeto, não de uma lista genérica.
- **CLI antes de MCP.** Cada servidor MCP vira uma decisão sua, com as opções na mesa: trocar
  pelo CLI oficial, mover para o nível do projeto, manter no nível do usuário (só o que é útil em
  quase toda conversa) ou desligar. A skill sugere os CLIs que faltam, guia o login de cada um
  sem pedir token no chat, e grava no `CLAUDE.md` a preferência por CLI.
- **Recursos ocultos e experimentais** que ajudam, como o Code Mode do Claude Code: confirmados
  para a versão instalada, ligados quando todas as condições batem e testados logo depois.

## Privacidade

Tudo roda na sua máquina. A leitura de sessões anteriores devolve apenas contagens (comandos
que falharam, correções, bloqueios de hook), nunca o texto das conversas. Segredos aparecem só
com os 4 primeiros caracteres.

## Arquivos que ela cria

```text
.novarc-powers/novarc-harness-doctor/
├── state.json      # estado da revisão
├── board.html      # painel
├── board.md        # o mesmo painel em texto
├── reports/        # relatório de cada execução
├── drafts/         # traduções aguardando aprovação
├── backups/        # local, nunca vai para o git
└── logs/           # local, nunca vai para o git
```

## Requisitos

Node 20 ou mais novo para os scripts de diagnóstico (sem dependências). Sem Node, a skill segue
pelos passos manuais e diz que a revisão ficou sem nota.
