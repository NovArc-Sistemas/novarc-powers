# Perfis de instalação

Toda skill declara no seu `skill.json` o perfil que recomendamos e os perfis em que funciona:

```json
"profile": { "recommended": "on-demand", "supported": ["on-demand", "user", "project"] }
```

## Execução pontual (`on-demand`)

Para skills de uso raro. Nada é copiado. O instalador mantém um bloco gerenciado no arquivo de
instruções do agente (`CLAUDE.md`, `AGENTS.md`), entre `<!-- novarc-powers:start -->` e
`<!-- novarc-powers:end -->`, com uma linha por skill dizendo como buscá-la:

```text
npx -y novarc-powers@<versão> fetch <skill>
```

O `fetch` copia a skill para `~/.novarc-powers/cache/<skill>@<versão>/` e imprime o caminho do
`SKILL.md`, que o agente lê e segue. O texto fora do bloco nunca é tocado.

**Custo:** uma linha por skill em toda sessão. **Atualização:** a versão fica fixada no
ponteiro; `npx novarc-powers update` troca para a nova.

## Harness de usuário (`user`)

Para hábitos que valem em todos os projetos. A pasta da skill é copiada para o diretório de
skills de cada agente escolhido:

| Agente | Destino |
|---|---|
| Claude Code | `~/.claude/skills/<skill>/` (e o diretório de `CLAUDE_CONFIG_DIR`, se houver) |
| Codex | `~/.codex/skills/<skill>/` |
| Genérico | `~/.agents/skills/<skill>/` |

**Custo:** a descrição da skill entra em toda sessão.

## Harness de projeto (`project`)

Para o processo do time, versionado junto com o código. A skill é copiada para
`.claude/skills/<skill>/` ou `.agents/skills/<skill>/` do projeto, e você faz commit dela.

**Custo:** a descrição da skill, só nas sessões daquele projeto.

## Como escolhemos o perfil recomendado

| Pergunta | Se sim |
|---|---|
| É usada poucas vezes por mês, para uma tarefa fechada? | `on-demand` |
| Muda o jeito de trabalhar em qualquer projeto? | `user` |
| Depende das convenções de um projeto, ou o time inteiro deve usar igual? | `project` |

## O registro do instalador

`.novarc-powers/manifest.json` (na home para o escopo de usuário, no projeto para o de
projeto) guarda cada skill instalada, a versão, o perfil, o destino e o hash de cada arquivo.
É ele que permite atualizar sem sobrescrever o que você editou à mão e desinstalar sem deixar
resto.
