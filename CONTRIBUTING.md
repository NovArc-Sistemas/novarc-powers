# Contribuindo

Obrigado por querer ajudar. Issues e pull requests podem ser em português ou inglês.

## Ideias e problemas

- **Bug:** abra uma issue com o agente e a versão que você usa, o que pediu, o que esperava e
  o que aconteceu. Nunca cole tokens, transcripts inteiros ou caminhos com seu nome de usuário.
- **Skill nova:** abra uma issue descrevendo a tarefa, quem usaria e com que frequência. Isso
  define o perfil de instalação.

## Pull requests

1. Siga o padrão de [docs/authoring.md](docs/authoring.md).
2. Rode localmente:

   ```bash
   npm install
   npm run catalog
   npm run validate
   npm test
   ```

3. Acrescente uma linha ao [CHANGELOG.md](CHANGELOG.md) em `Unreleased`.
4. Descreva no PR o que mudou, por quê e como você testou, incluindo o que não conseguiu testar.

## Regras do repositório

- Tudo que um agente lê (`SKILL.md`, `references/`, saída de scripts) é escrito em inglês. Os
  READMEs existem em português e inglês.
- Scripts de skills usam Node 20+ e nenhuma dependência.
- Nenhuma skill pode instalar software, apagar arquivos, mudar permissões, mexer em segredos ou
  publicar algo sem a confirmação do usuário.
- Nada de dados de clientes, tokens, e-mails ou caminhos pessoais. O CI recusa.
