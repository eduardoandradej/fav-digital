# FAV Digital — Ficha de Acompanhamento de Vestígio (PCERJ)

MVP do sistema Web institucional que registra e consulta o percurso de cada vestígio, da coleta ao encerramento da
custódia no âmbito da SEPOL. Todo o preenchimento é reservado a servidores da PCERJ autenticados com conta importada
do AD e autorizados para a operação. Cada campo mostra **quem preencheu, quem alterou por último, quando e por qual unidade**,
com histórico e retificações preservados.

> ⚠️ Somente **dados sintéticos** até autorização institucional. O provedor de identidade simulado é recusado nos perfis
> `homologacao`/`producao`.

## Caminho curto (Ubuntu 24.04 + Podman)

```bash
git clone https://github.com/eduardoandradej/fav-digital.git && cd fav-digital
```
```bash
./deploy/podman/local.sh up
```

Abra **http://localhost:8080** e entre com o ID funcional **1000001** e a senha **Sintetica#2026** (Ana, DP-001).
Crie uma FAV, confirme a coleta e registre o envio para o ICCE. Em uma janela anônima, entre como **1000003**
(Carla, ICCE), abra **Encaminhamentos** e confirme o recebimento.

Guia completo, com serviço systemd/Quadlet, VM KVM isolada e ambiente de desenvolvimento:
**[docs/guia-ubuntu-24.04-podman-kvm.md](docs/guia-ubuntu-24.04-podman-kvm.md)**.

## O que está implementado

- **Página inicial com três cards**: FAV Digital, Encaminhamentos e Etiquetas de Grande Porte. Mostra contexto de
  unidade, indicadores e pesquisa por nº da FAV, requisição, procedimento ou lacre.
- **Ficha**:
  - situação atual: estado da ficha, estado físico declarado, lacre vigente, responsável ou trânsito, pendências e próximo ato permitido;
  - seções do modelo (Coleta e 1º Lacre, Dados do Vestígio, Perícia, Guarda);
  - **autoria por campo sob demanda** e **ver histórico**;
  - lista contínua de **movimentações**, com filtros e paginação, além de **lacres/aberturas**, intervenientes externos,
    central/armazenamento, amostragem e encerramento;
  - **linha do tempo** ordenada por registro ou pela data efetiva.
- **Atos com resumo antes da confirmação**: Confirmar coleta, Registrar envio, Confirmar recebimento (com conferência
  de lacre, embalagem e SPT/SCO), Recusar, Cancelar, Registrar abertura e novo lacre, Vincular FAV de amostra,
  armazenamento/acesso físico, consumo parcial, Registrar destinação e registro documental de pessoa externa.
- **Regras**:
  - nº da FAV no formato 1º lacre/ano/unidade (grande porte: nº da requisição);
  - item 11 (primeira entrega pelo coletor);
  - não conformidades descritas;
  - recipiente aberto bloqueia movimentação;
  - laudo como documento na análise destrutiva;
  - autorização judicial na destruição e na devolução;
  - lançamento posterior motivado;
  - datas futuras recusadas.
- **Identidade**:
  - adaptador kinit → ldapsearch SASL/GSSAPI (`minssf=128`);
  - sincronização paginada e idempotente com proteção contra anomalias;
  - projeção por `objectGUID` com retratos históricos;
  - elegibilidade por grupo, revalidada no backend em toda operação;
  - sessão opaca revogável com CSRF;
  - bloqueio de atos de custódia fora da janela de revalidação.
- **Integridade**:
  - transação única por ato;
  - índices parciais (uma transferência ativa, um lacre ativo);
  - idempotência por ator, operação e conteúdo;
  - trilhas de inclusão contínua (GRANT + gatilho);
  - conta de execução separada da de migração.
- **Documentos**: PDF da FAV (Informações Gerais + Encaminhamentos, com continuação de páginas) e etiquetas A4,
  2 por página, "Volume X de N". Lotes versionados, reimpressão com motivo e registro de impressão e de afixação.
  Exportações auditadas com SHA-256.

## Estrutura

```
api/         NestJS 12 (ESM) — src/, test/ (node:test + PostgreSQL real), openapi/openapi.yaml
web/         Angular 22 (standalone, zoneless) — src/app/pages, e2e/jornada.mjs (Playwright)
db/          bootstrap/00-roles.sql (DBA) e migrations/ (papel fav_migrator)
seed/        diretório e unidades SINTÉTICOS
deploy/      podman/ (script local e Quadlet) · k8s/ (Kustomize base + homologacao + openshift)
docs/        matriz de requisitos, fluxo e permissões, AD, implantação, homologação, ADRs, guia Ubuntu
Containerfile  imagem única multiestágio (UID arbitrário, raiz somente leitura)
```

## Documentação

| Documento | Conteúdo |
|---|---|
| [docs/matriz-requisitos-fav.md](docs/matriz-requisitos-fav.md) | Regra → fonte → campo → etapa → perfil → tela/PDF → auditoria → teste; DOC / PROD / PEND |
| [docs/fluxo-e-permissoes.md](docs/fluxo-e-permissoes.md) | Estados, tabela de comandos, papéis e escopo |
| [docs/autenticacao-e-importacao-ad.md](docs/autenticacao-e-importacao-ad.md) | Kerberos/GSSAPI, sincronização, contas sintéticas |
| [docs/implantacao-e-operacao.md](docs/implantacao-e-operacao.md) | Podman, Kubernetes/OpenShift, banco, backup, CI |
| [docs/homologacao.md](docs/homologacao.md) | Status A01–A11 com evidências e pendências institucionais |
| [docs/roteiro-cenario-sintetico.md](docs/roteiro-cenario-sintetico.md) | Roteiro passo a passo: DP-001 → ICCE → CCV → destinação, com variações |
| [docs/adr/](docs/adr/) | Decisões de arquitetura |
| `GET /api/v1/openapi.yaml` | Contrato OpenAPI 3.1 |

## Testes (última execução)

- API: **58/58** testes de integração com PostgreSQL 18 real (cenários A01–A10 e adaptador Kerberos com executáveis falsos).
- Web: **2/2** testes unitários.
- E2E: **1 jornada** no Chromium (login → três cards → FAV → autoria → coleta → envio → recebimento por outra conta → linha do tempo).

Ensaios que dependem da rede institucional (login Kerberos/GSSAPI real, sincronização com o AD, cluster e impressão física)
estão listados como **pendentes** em [docs/homologacao.md](docs/homologacao.md).
