# Segurança

## Reportando uma vulnerabilidade

Não abra issue pública. Use o [reporte privado de vulnerabilidades do GitHub](https://github.com/NovArc-Sistemas/novarc-powers/security/advisories/new)
deste repositório. Respondemos em até 5 dias úteis.

Interessa em especial:

- uma skill ou o instalador que escreve fora do que declara, ou sem a confirmação prometida;
- qualquer caminho em que um segredo é impresso, gravado em log ou enviado para fora da máquina;
- o hook de atualização executando algo além de checar a versão (ou atualizar, no modo
  automático que o usuário escolheu).

## O que o pacote faz na sua máquina

- `npx novarc-powers` grava apenas os arquivos listados no resumo antes da confirmação, faz
  backup de tudo que já existia e registra cada arquivo em `.novarc-powers/manifest.json`.
- O hook opcional de atualização consulta `registry.npmjs.org` no máximo uma vez por dia. Não
  envia nenhum dado seu.
- As skills rodam com as permissões do seu agente. Leia o `SKILL.md` antes de usar uma skill
  nova, como faria com qualquer script.

## Publicação

Cada versão é publicada no npm pelo GitHub Actions a partir de uma tag, com
[proveniência](https://docs.npmjs.com/generating-provenance-statements), o que liga o pacote
ao commit que o gerou.
