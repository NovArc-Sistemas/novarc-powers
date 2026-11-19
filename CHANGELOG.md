# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versões seguem
[SemVer](https://semver.org/lang/pt-BR/).

## [Unreleased]

## [0.1.0] - não publicada

### Adicionado

- Instalador `npx novarc-powers` com perfis de instalação (execução pontual, harness de usuário,
  harness de projeto), manifesto, backups, `update` com detecção de edições manuais e aviso de
  versão nova.
- Skill `novarc-harness-doctor`: revisão guiada ou automática do harness de usuário e de
  projeto em oito rodadas, com nota por escopo, painel em português ou inglês e relatório.
  Inclui revisão de documentação, gates a partir das falhas reais do projeto, política de CLI
  antes de MCP com login guiado, e ativação de recursos ocultos confirmados para a versão
  instalada.
- Pasta de trabalho padrão `.novarc-powers/<skill>/`.
- Marketplace de plugins do Claude Code com um plugin por skill.
