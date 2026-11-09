# Matriz de requisitos — FAV Digital

Fontes lidas visualmente (PDFs digitalizados, sem camada de texto; conferência direta da imagem):
`Instrucoes.pdf` (pp. 1–3, itens 1–20), `Infomacoes_Gerais_e_Encaminhamento.pdf` (p. 1 — Informações Gerais),
`Folhas_Complementares_de_Encaminhamento.pdf` (p. 1 — Encaminhamento do Vestígio, 6 blocos por folha),
`Anexo_Etiquetas.pdf` (p. 1 — instruções 1–6 e 2 etiquetas por página) e CPP arts. 158-A a 158-F.
O manual `Manual_Autenticacao_AD_SGE_Homologacao.docx` e o slide de referência tecnológica **não estavam disponíveis** nesta sessão;
o fluxo de autenticação segue o resumo da seção 5 do prompt mestre (ver P-AD-01).

**Classificação:** `DOC` regra documental · `PROD` decisão de produto · `PEND` pendência institucional.
**Testes:** arquivos em `api/test/` (prefixo do cenário) e `web/e2e/jornada.mjs` (E2E).

## 1. Informações Gerais — Dados da Coleta e 1º Lacre

| ID | Classe | Fonte | Entidade/campo | Obrigatório a partir de | Quem preenche | Tela / PDF | Auditoria | Teste |
|---|---|---|---|---|---|---|---|---|
| R-IG-01 | DOC | IG p.1; Instr. 5 | `fav.coleta_responsavel_*` (servidor → `identity`; externo → `intervener`) | Confirmar coleta | ORIGEM_COLETA / REGISTRO_UNIDADE da unidade de origem | Seção Coleta; PDF "Responsável pela Coleta e Acondicionamento" + "ID Funcional ou Nº Documento com Foto" | Revisão por campo | A03, A05 |
| R-IG-02 | DOC | IG p.1; Anexo 2 | `seal` ordinal 1 (`primeiro_lacre_numero`) | Confirmar coleta (regular); facultativo (grande porte) | idem | "Nº 1º Lacre" | Revisão entidade `seal` | A03 número |
| R-IG-03 | DOC | IG p.1 | `fav.coleta_data_hora` (UTC; exibição America/Sao_Paulo) | Confirmar coleta | idem | "Data/Hora de Coleta" | Revisão; recusa de data futura | A03 data futura |
| R-IG-04 | DOC | IG p.1 | `fav.coleta_endereco` **ou** `coleta_geo_lat/lon` | Confirmar coleta | idem | "Endereço do Local de Crime (ou geolocalização)" | Revisão | A03 |
| R-IG-05 | DOC | IG p.1 | `fav.vestigio_tipo`, `vestigio_descricao` | Confirmar coleta | idem | "Tipo e Descrição do vestígio" | Revisão | A03 |
| R-IG-06 | DOC | IG p.1 | `fav.vestigio_localizacao` | Facultativo | idem | "Localização do vestígio no local de crime" | Revisão | — |
| R-IG-07 | DOC | IG p.1 | `fav.preservacao_mesmo_coletor` ou `preservacao_*` | Confirmar coleta | idem | "☐ mesmo da Coleta" | Revisão + limpeza automática coerente | A03 |
| R-IG-08 | DOC | IG p.1 | "Assinatura" | — | — | Campo de assinatura manuscrita preservado no PDF | Distinção autoria × assinatura (R-AUD-06) | A09 PDF |
| R-CPP-158B | DOC | CPP 158-B I–III | `fav.documentacao_pericial_ref` | Facultativo (regra por ato pendente) | idem | Seção Coleta | Revisão | — |
| R-NUM-01 | DOC | IG cabeçalho | `fav.numero` = `1º lacre/ano/unidade` (ano em America/Sao_Paulo; código da unidade de origem) | Gerado em Confirmar coleta | automático | "Nº FAV" | Revisão `automatico` com regra-fonte | A03 |
| R-NUM-02 | DOC | Anexo 3, 5; Instr. 9 | grande porte: `fav.numero` = nº da requisição | Confirmar coleta | automático | idem + etiquetas | idem | A08 |
| R-NUM-03 | DOC | Instr. 15 | Abertura de outro lacre preserva o nº original | Sempre | — | — | — | A06 |
| P-NUM-01 | PEND | — | Escopo de unicidade do nº (adotado: global) | — | SSPTC/CEPF | — | — | A03 |
| P-NUM-02 | PEND | — | Mais de um vestígio distinto de grande porte na mesma requisição | — | SSPTC/CEPF | Conflito 409 com código da pendência; rascunho preservado por chave técnica | Evento não gerado | A08 colisão |

## 2. Informações Gerais — Dados do Vestígio

| ID | Classe | Fonte | Entidade/campo | Etapa | Quem | Tela/PDF | Auditoria | Teste |
|---|---|---|---|---|---|---|---|---|
| R-DV-01 | DOC | IG p.1 | `fav.natureza_exame text[]` (criminal, medico_legal, papiloscopico, dna) | Progressivo (pendência exibida após coleta) | REGISTRO_UNIDADE / ORIGEM_COLETA | "Natureza do Exame" | Revisão | A03 |
| P-DV-01 | PEND | — | Natureza admite seleção múltipla? (adotado: sim) | — | Área pericial | — | — | A03 |
| R-DV-02/03 | DOC | IG p.1 | `fav.requisicao`, `fav.procedimento` (normalizados, zeros preservados) | Progressivo | idem | "Nº Requisição", "Nº Procedimento" | Revisão | A03, A10 pesquisa |
| R-DV-04 | DOC | CPP 158-E; prompt §6 | `fav.unidade_pj_id` | Progressivo | idem | Seção Vestígio | Revisão | — |
| R-INS-06 | DOC | Instr. 6 | `fav.sco_primeiro_lacre_ref`, `sco_primeiro_lacre_conferido` — **declaração do operador** | Pendência exibida até preenchimento | REGISTRO_UNIDADE | Seção Vestígio | Revisão | — |
| R-INS-07 | DOC | Instr. 7 | `fav.laudo_numero` — exclusivo da perícia | Após exames | PERICIA na unidade custodiante | "Nº do Laudo" | Revisão com papel | A07 |
| R-INS-08 | DOC | Instr. 8 | `fav.amostragem_classe` + `sample_link` recíproco | Vincular FAV de amostra | PERICIA | "Em caso de amostragem…" + "Nº FAV correspondente" | Evento + revisão | A07 |

## 3. Lacres, abertura e relacre

| ID | Classe | Fonte | Entidade | Regra | Quem | Teste |
|---|---|---|---|---|---|---|
| R-INS-13 | DOC | Instr. 13 | `movement.seal_expected/observed` | Conferência do nº vigente × observado em cada recebimento | Recebedor | A04 |
| R-INS-14 | DOC | Instr. 14 | `seal_opening` | Motivo, data/hora, local, responsável, ID, cargo (retrato), novo nº; lacre rompido acondicionado (obrigatório `true`); ref. SPT/SCO | PERICIA ou pessoa autorizada (CUSTODIA + `autorizacaoRef`) | A06 |
| R-INS-15 | DOC | Instr. 15 | lista contínua de `seal`/`seal_opening` | Sem limite de linhas (substitui anexar nova folha) | — | A06 (5 aberturas) |
| R-LAC-01 | PROD | prompt §6 | `fav.physical_state = aberto` | Abertura e fechamento separados; envio, entrada na central e destinação bloqueados enquanto aberto | — | A06 |
| R-LAC-02 | PROD | — | `seal_one_active` (índice parcial) | Um único lacre ativo por FAV | — | A06 |

## 4. Encaminhamentos (lista contínua)

| ID | Classe | Fonte | Entidade/campo | Regra | Quem | Teste |
|---|---|---|---|---|---|---|
| R-ENC-01 | DOC | Encaminhamento p.1; Instr. 1, 2, 4, 10 | `movement` (seq, envio, recebimento, OBS) | Lista contínua com "Adicionar movimentação"; folhas só na saída PDF | — | A06 (9 movimentações), A09 PDF |
| R-INS-10 | DOC | Instr. 10 | `obs_sem_alteracoes`, `obs_alteracoes`, `obs_nao_conformidades` | "Sem alterações" exclusivo; descrição obrigatória nas demais; ambas podem coexistir | Recebedor | A04 |
| R-INS-11 | DOC | Instr. 11 | 1ª movimentação: remetente = coletor (servidor ou interveniente externo) | Bloqueio 422 | — | A04 |
| R-INS-12 | DOC | Instr. 12 | `seal_situation`, `packaging_situation`, `sco_correspondencia` | Problema físico exige não conformidade descrita | Recebedor | A04 |
| R-MOV-01 | PROD | prompt §6.1 | `movement_one_active` | Uma transferência ativa; recusa/cancelamento são eventos próprios | — | A04 |
| R-MOV-02 | PROD | prompt §6.1 | envio pela sessão do remetente; recebimento pela sessão de servidor da unidade de destino, distinto do remetente | — | A04 |
| R-MOV-03 | PROD | prompt §6.1 | Datas: efetiva × registro; > 24 h exige motivo; futura recusada; ordem envio ≥ coleta, recebimento ≥ envio | — | A04 |
| R-CPP-158E | DOC | CPP 158-E | protocolo, unidade de PJ, natureza, tipo, transportador, rastreamento | Campos disponíveis no recebimento/envio | — | — |

## 5. Origem externa

| ID | Classe | Fonte | Regra | Teste |
|---|---|---|---|---|
| R-INS-05 | DOC | Instr. 5 | Coletor pode ser externo à SEPOL | A05 |
| R-EXT-01 | PROD | prompt §6.1 | Externo = `intervener` (nome, documento, fonte comprobatória, situação da comprovação); sem conta; lançado por servidor identificado separadamente | A05 |
| R-EXT-02 | PROD | prompt §6.1 | Registro da origem externa não transfere custódia ao operador (`custodian_kind = externo`) | A05 |
| R-EXT-03 | PROD | prompt §6.1 | Comprovação pendente: confirmação permitida e sinalizada (`comprovacaoExternaPendente`, pendência na ficha) | A05 |

## 6. Central, armazenamento e acesso físico

| ID | Classe | Fonte | Regra | Teste |
|---|---|---|---|---|
| R-CPP-158F | DOC | CPP 158-E/F | `storage_event`: entrada/saída com protocolo, local de guarda, pessoa/data/hora; depósito alternativo exige documento de decisão | A07 |
| R-ACE-01 | PROD | prompt §6 | Acesso físico (`storage_event.acesso_fisico`) ≠ acesso à FAV digital (`security_audit.consulta_fav`) | A07 |

## 7. Encerramento e guarda documental

| ID | Classe | Fonte | Regra | Teste |
|---|---|---|---|---|
| R-INS-16 | DOC | Instr. 16 | Encerramento pelo último custodiante (unidade custodiante, papel ENCERRAMENTO) | A09 |
| R-INS-17 | DOC | Instr. 17 | Análise totalmente destrutiva: laudo = documento; `physical_state = consumido_total` | A09 |
| R-INS-18 | DOC | Instr. 18 | Devolução, destruição (exigem ref. de autorização judicial — PROD), doação → "Outro" motivado (P-ENC-01) | A09 |
| R-INS-19 | DOC | Instr. 19 | Transferência a depósito externo exige destinatário | A09 |
| R-CON-01 | PROD | prompt §6 | Consumo parcial: evento, custódia mantida | A09 |
| R-INS-20 | DOC | Instr. 20 | `guarda_unidade_id` (padrão: unidade que encerrou) + `sco_anexacao_ref` (declaração); exportação PDF registrada | A09 |
| P-ENC-01 | PEND | — | "Doação" como "Outro"? | — |
| P-ENC-02 | PEND | — | Retificação/reabertura após encerramento: bloqueadas (exceto guarda documental) até regra | A09 |

## 8. Etiquetas de grande porte

| ID | Classe | Fonte | Regra | Teste |
|---|---|---|---|---|
| R-ETQ-01 | DOC | Anexo 1; Instr. 9 | Somente `kind = grande_porte` (impossibilidade de embalagem lacrada inviolável; tamanho não é o único critério) | A08 |
| R-ETQ-02 | DOC | Anexo etiqueta | Nº procedimento, nº requisição, lacre identificador facultativo, nome, matrícula/lotação, assinatura, "Volume X de N" | A08 |
| R-ETQ-03 | DOC | Anexo 4 | Uma etiqueta por volume; A4 com 2 por página | A08 |
| R-ETQ-04 | PROD | prompt §8 | Lotes versionados; reimpressão exige motivo e marca lote anterior como substituído; impressão solicitada e afixação confirmada são eventos distintos | A08 |
| P-ETQ-01 | PEND | — | Código de consulta opaco na etiqueta (não implementado) | — |
| P-ETQ-02 | PEND | — | Redução do nº de volumes (bloqueada) | — |

## 9. Identidade, autorização e auditoria

| ID | Classe | Fonte | Regra | Teste |
|---|---|---|---|---|
| R-AUT-01 | PROD | prompt §5.1 | ID funcional 2–20 dígitos, hífen facultativo antes do último; zeros preservados | A01 |
| R-AUT-02 | PROD | prompt §5.1 | kinit → ldapsearch GSSAPI `minssf=128` → `sAMAccountName` único; sem fallback | adaptador |
| R-AUT-03 | PROD | prompt §5.1 | Sucesso / rejeição genérica / indisponibilidade 503 | A01 |
| R-AUT-04 | PROD | prompt §5.2 | Sem cadastro local; login exige identidade previamente importada (sincronização no escopo) | A01 |
| R-AUT-05 | PROD | prompt §5.2 | Elegibilidade de preenchimento por grupo (`LDAP_ELIGIBLE_GROUP_DN`); revalidada em toda operação | A01 |
| R-AUT-06 | PROD | prompt §5.1 | Sessão opaca, revogável, cookies Secure/HttpOnly/SameSite=Strict, CSRF, expiração ociosa/absoluta | A01 |
| R-AUT-07 | PROD | prompt §5.1 | Atos de custódia bloqueados se a última sincronização íntegra exceder a janela | A02 |
| R-SYNC-01 | PROD | prompt §5.2 | Sincronização paginada/idempotente; desativação só em execução completa íntegra; anomalia não desativa | A02 |
| R-SYNC-02 | PROD | prompt §5.2 | GUID novo com login reutilizado = nova identidade; colisão bloqueia | A02 |
| R-AUD-01 | PROD | prompt §7.1 | `field_revision` em toda mudança persistida (preenchimento, alteração, remoção, retificação, automático) | A03 |
| R-AUD-02 | PROD | prompt §7.2 | "Preenchido por", "alterado pela última vez por", "ver histórico"; retrato `identity_snapshot` | A02, A03 |
| R-AUD-03 | PROD | prompt §7.3 | Trilhas separadas: revisões, eventos de custódia, auditoria de segurança | A07, A10 |
| R-AUD-04 | PROD | prompt §7.4 | Transação única; índices parciais; idempotência ator+operação+conteúdo | A04, A10 |
| R-AUD-05 | PROD | prompt §7.5 | `fav_app` sem UPDATE/DELETE nas trilhas + gatilho de inclusão contínua | A10 |
| R-AUD-06 | PEND | prompt §7.6 | Valor institucional da confirmação digital × assinatura formal | — |
