# Homologação — matriz de testes, evidências e pendências

Status em **9/11/2026**, conforme resultados reais. Classificação: **Implementado** (código presente),
**Validado localmente** (teste automatizado ou manual executado em ambiente isolado com dados sintéticos),
**Validado em homologação** (ambiente institucional) e **Pendente**.

Ambiente local de validação: PostgreSQL **18.6**; Node 22.23 (testes) e **24.15.0** (smoke da API em contêiner);
Angular 22.2.5; NestJS 12.4.2; Chromium/Playwright (E2E).

## Cenários de aceite

| ID | Status | Evidência |
|---|---|---|
| A01 | Validado localmente (exceto Kerberos real) | `a01-a02-identidade.test.ts`: três cards; normalização/zeros; rejeição genérica (credencial inválida, não importada, desativada, inexistente, formato); CSRF; sem vínculo elegível bloqueado por API direta; AD indisponível = 503; expiração por inatividade; renovação do identificador; limite de tentativas; admin sem custódia. `adaptador-kerberos.test.ts`: cache Kerberos isolado por tentativa, concorrência, timeout, senha só por stdin. **Kerberos/GSSAPI real: pendente (rede institucional).** |
| A02 | Validado localmente | Sincronização parcial e vazia anômala não desativam; desativação revoga sessão; GUID novo com login reutilizado = identidade separada; colisão bloqueia; retrato histórico em mudança de nome/lotação; janela de revalidação bloqueia atos de custódia. |
| A03 | Validado localmente | Primeira autoria × última alteração; retificação com motivo e valor anterior; campos/autor forjados rejeitados ou ignorados; conflito de versão; confirmação de coleta pelo próprio coletor; nº 1º lacre/ano/unidade; data futura recusada. |
| A04 | Validado localmente | Envio/recebimento por contas distintas; item 11; não conformidade com descrição; ressalva; recusa; devolução; trânsito; cancelamento; concorrência entre recebedores (só um registra); lançamento posterior motivado. |
| A05 | Validado localmente | Coletor externo como interveniente; servidor como autor; custódia não transferida ao operador; nenhuma confirmação digital atribuída ao externo; comprovação pendente sinalizada. |
| A06 | Validado localmente | 5 aberturas/6 lacres e 9 movimentações (acima da folha física) na mesma FAV; bloqueio com recipiente aberto; PDF paginado com continuação; abertura autorizada fora da perícia. |
| A07 | Validado localmente | Campos periciais restritos; contraprova/alíquota/contraperícia com vínculo recíproco; vínculo próprio/circular bloqueado; acesso físico com pessoa/data/hora; acesso à FAV digital auditado separadamente. |
| A08 | Validado localmente (PDF); impressão física pendente | 3 volumes → "Volume 1 de 3 … 3 de 3", A4 com 2 por página, lacre identificador facultativo, reimpressão com motivo, histórico de lotes, impressão solicitada e afixação confirmada; colisão de requisição (P-NUM-02). **Impressão física de teste: pendente.** |
| A09 | Validado localmente | Análise destrutiva com laudo; destruição exige autorização; transferência externa; consumo parcial mantém custódia; PDF com versão, Informações Gerais e Encaminhamentos; hash registrado. Conferência visual do PDF em relação aos modelos: feita; layout aprovado pela área: **pendente**. |
| A10 | Validado localmente | Idempotência (reenvio idêntico = mesmo resultado; conteúdo divergente = 409; chave obrigatória); falha antes do commit sem efeitos; `fav_app` não altera/apaga trilhas; gatilho barra até o dono; acesso por ID direto fora do escopo = 404 auditado; troca de unidade; exportação sem escopo negada; pesquisa no escopo. |
| A11 | Parcial | Validado localmente: estágios `api` e `web` do `Containerfile` em Node 24; API em contêiner Node 24 contra PostgreSQL 18; migrações e reaplicação idempotente; backup/restauração (`pg_dump`/`pg_restore`); probes (`/saude/*`); YAML dos manifests (sintaxe). **Pendente:** build da imagem final (o estágio `apt` não teve acesso ao espelho Debian no sandbox), execução Podman/Quadlet, `kustomize build`/kubeconform (no CI), cluster, impressão física e login Kerberos/GSSAPI na homologação institucional. |

Totais da última execução: **API 58/58 testes**, **Web 2/2**, **E2E navegador 1 jornada** (login → três cards →
abrir FAV → preencher com autoria → confirmar coleta → envio → recebimento por outra conta → linha do tempo).

## Roteiro na homologação institucional

1. CEPF: fornecer realm/KDC/DC, `krb5.conf`, base DN, filtro de importação, grupo de elegibilidade, conta técnica (keytab), DNS/NTP e liberação 88/389.
2. Banco provisionado: executar `db/bootstrap/00-roles.sql` e definir as senhas; Job de migração.
3. Primeira sincronização: CronJob manual (`kubectl create job --from=cronjob/fav-digital-sync sync-1`). Conferir `directory_sync_run`.
4. Atribuir papéis do piloto (`/admin/papeis`) a identidades importadas.
5. Login real com 3 contas de teste (perfil coletor, perito, central). Registrar evidência de sucesso, senha errada, conta desativada e AD indisponível.
6. Rodar a jornada E2E (`BASE=https://… node web/e2e/jornada.mjs`) com dados sintéticos.
7. Imprimir etiquetas A4 em impressora da unidade e conferir com o Anexo.
8. Testar restauração de backup no banco de homologação.

## Pendências institucionais

| Código | Tema | Decisão a obter |
|---|---|---|
| P-AD-01 | CEPF | Conferir o fluxo com o manual do SGE (não disponível nesta sessão); política SASL/TLS efetiva |
| P-AD-02 | CEPF/PCERJ | Critério oficial de elegibilidade como servidor (grupo/atributo/fonte) |
| P-AD-03 | CEPF | Grupos por papel/unidade; fonte oficial de lotação e cargo |
| P-AD-04 | CEPF | Conduta das sessões durante falha do diretório (adotado: leitura mantida, atos bloqueados após 26 h sem sincronização íntegra) |
| P-NUM-01 | SSPTC/CEPF | Escopo de unicidade do nº da FAV (adotado: global) |
| P-NUM-02 | SSPTC/CEPF | Vários vestígios de grande porte na mesma requisição |
| P-DV-01 | Perícia | Natureza do exame com seleção múltipla (adotado: sim) |
| P-RET-01 | SSPTC | Quem pode retificar cada ato (adotado: quem registrou) |
| P-ENC-01/02 | SSPTC | "Doação" como "Outro"; retificação/reabertura após encerramento |
| P-ETQ-01/02 | SSPTC | Código opaco de consulta; redução de volumes |
| P-ASS-01 | Jurídico/SSPTC | Valor da confirmação digital × assinatura formal; aceitação do PDF; guarda |
| P-SCO-01 | CEPF | Integração SCO/SPT (no MVP: declaração do operador) |
| P-INT-01 | CEPF | Proteção adicional das trilhas perante DBA (backup imutável, encadeamento criptográfico) |
