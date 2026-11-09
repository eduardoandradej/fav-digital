# Roteiro de trabalho — cenário sintético completo

**Percurso:** DP-001 (coleta e registro) → ICCE (perícia) → CCV (central de custódia) → destinação final.
Todos os dados são **fictícios**. A senha de todas as contas é **`Sintetica#2026`**.

> **Antes de começar**
> - Suba o sistema (`./deploy/podman/local.sh up`) e abra `http://localhost:8080`.
> - Use **uma janela anônima (ou outro navegador) por pessoa**, para as sessões não se misturarem.
> - Horários: use horários **de hoje, em ordem crescente e no passado** (o sistema recusa data futura e coleta posterior ao envio).
>   Se o ato ocorreu há mais de 24 h, o sistema pede o **motivo de lançamento posterior**.
> - Os horários abaixo são sugestões. Ajuste-os ao momento em que estiver testando. Se for antes das 15h, recue tudo algumas horas.
> - Depois de cada ato, confira o item **"Conferir"**. É o que valida a regra.

## Personagens

| Janela | Login | Pessoa (sintética) | Unidade | Papel no cenário |
|---|---|---|---|---|
| 1 | `1000001` | Ana Souza | DP-001 | Coletora: coleta, acondiciona, lacra e entrega |
| 2 | `1000002` | Bruno Lima | DP-001 | Cartório: registro do vestígio e dados do SCO |
| 3 | `1000003` | Carla Mendes | ICCE | Perita: recebe, examina, abre e relacra, emite laudo |
| 4 | `1000004` | Diego Rocha | CCV | Central: recebe, armazena, encerra |
| 5 | `1000012` | Lucas Alves | CCV | Central: acesso físico para inventário |
| 6 | `1000005` | Elisa Prado | DP-001 / ICCE | Auditora: confere tudo, somente leitura |

## Caso fictício

> Ocorrência fictícia **RO 900-00123/2026**: disparo de arma de fogo em via pública, sem vítimas.
> A inspetora Ana coleta um **projétil** junto ao meio-fio, acondiciona em envelope e aplica o **lacre nº `DPX-000501`**.
> O material segue para exame de balística no ICCE e, depois, para guarda na Central de Custódia (CCV).

---

## Etapa 1 — Abertura da ficha e dados da coleta (Ana, DP-001)

**Janela 1, login `1000001`**

1. Na página inicial, confira os **três cards** e o contexto **DP-001** no topo.
2. Card **FAV Digital** → **Criar ficha** → marque **Regular** → **Abrir rascunho**.
   - **Conferir:** o título mostra "rascunho RASC-…" e o estado é **Rascunho**.
3. Seção **Dados da Coleta e 1º Lacre** → **Preencher**:

| Campo | Valor |
|---|---|
| Nº 1º lacre | `DPX-000501` |
| Responsável pela coleta — tipo | Servidor da PCERJ |
| Buscar servidor | `1000001`, e selecione **Ana Souza (sintética)** na lista |
| Data/hora da coleta | hoje, **08:30** |
| Endereço do local de crime | `Rua Fictícia das Acácias, 120 — Centro (dado sintético)` |
| Tipo do vestígio | `Projétil de arma de fogo` |
| Descrição do vestígio | `Projétil deformado, metal amarelado, aprox. 9 mm, acondicionado em envelope pardo` |
| Localização do vestígio no local de crime | `Junto ao meio-fio, a 2 m do poste nº 45` |
| Preservação do local: mesmo da coleta | ☑ |
| Referência à documentação de reconhecimento/isolamento/fixação | `Croqui e fotos nº 01–08 (sintético)` |

4. **Salvar**.
   - **Conferir:** ao lado de cada campo há o link **autoria**. Ele mostra "Preenchido por Ana Souza (ID 1000001, DP-001)" com data e hora.

## Etapa 2 — Dados do Vestígio (Bruno, cartório da DP-001)

**Janela 2, login `1000002`.** Card **FAV Digital** → **Pesquisar** com o campo vazio, filtrando o estado **Rascunho**.
Use esse caminho, e não "Meus rascunhos", que mostra só as fichas abertas pelo próprio Bruno. Abra a ficha **RASC-…** criada pela Ana.

1. Seção **Dados do Vestígio** → **Preencher**:

| Campo | Valor |
|---|---|
| Natureza do exame | ☑ Criminal |
| Nº da requisição | `REQ-2026-0457` |
| Nº do procedimento | `900-00123/2026` |
| Unidade de polícia judiciária | `DP-001 — 1ª Delegacia de Polícia (sintética)` |
| Referência do 1º lacre na observação do SCO | `SCO obs. 900-00123/2026 — lacre DPX-000501` |
| Conferência do 1º lacre no SCO | ☑ |

2. **Salvar**.
   - **Conferir:** a autoria desses campos mostra **Bruno**, e a dos campos da coleta continua com **Ana**.
     Cada campo registra quem lançou, independente de quem abriu a ficha.

## Etapa 3 — Confirmar coleta (Ana)

**Janela 1.** Recarregue a ficha (F5).

1. Clique em **Confirmar coleta** → **Revisar resumo**. Leia o resumo, que mostra quem você é, a unidade e a versão da ficha.
   Depois clique em **Confirmar e registrar**.
   - **Conferir:**
     - Título **Nº FAV: `DPX-000501/2026/DP-001`**, montado como 1º lacre/ano/unidade.
     - Estado **Sob custódia**, lacre vigente `DPX-000501` e responsável atual **Ana Souza**.
     - Aba **Linha do tempo**: "Coleta confirmada pelo coletor".

> **Teste de regra:** se o Bruno tentar confirmar a coleta, o sistema recusa. Coleta feita por servidor só pode ser
> confirmada pelo próprio coletor, na sessão dele.

## Etapa 4 — Envio para a perícia (Ana → ICCE)

**Janela 1**

1. Clique em **Registrar envio**:

| Campo | Valor |
|---|---|
| Unidade de destino | `ICCE — Instituto de Criminalística (sintético)` |
| Data/hora do envio | hoje, **10:00** |
| Local de envio | `Cartório da DP-001` |
| Código de rastreamento | `MALOTE-DP001-0091` (opcional) |

2. **Revisar resumo**. O resumo mostra o lacre vigente declarado, `DPX-000501`. Depois **Confirmar e registrar**.
   - **Conferir:** a situação aparece como **EM TRÂNSITO para ICCE**, com a observação "última confirmação: envio".
     Na aba **Movimentações**, o registro **Nº 1 — Em trânsito** mostra Ana como responsável pela entrega.

> **Regra (item 11):** no 1º encaminhamento, quem entrega precisa ser o próprio coletor. Se o Bruno tentar enviar, o sistema recusa.

## Etapa 5 — Recebimento na perícia (Carla, ICCE)

**Janela 3, login `1000003`**

1. Card **Encaminhamentos** → aba **A receber**. A FAV `DPX-000501/2026/DP-001` aparece na lista. Clique em **Abrir ficha**.
2. Clique em **Confirmar recebimento**:

| Campo | Valor |
|---|---|
| Data/hora do recebimento | hoje, **10:40** |
| Local de entrega | `Recepção do ICCE` |
| Protocolo | `ICCE-PROT-2026-7781` |
| Nº do lacre observado | `DPX-000501` |
| Situação do lacre | Íntegro |
| Embalagem | Íntegra |
| Correspondência com SPT/SCO | Confere |
| OBS. | ☑ Sem alterações |

3. **Revisar resumo** → **Confirmar e registrar**.
   - **Conferir:** responsável atual **Carla Mendes**. A movimentação Nº 1 aparece como **Recebido**, com Ana na entrega,
     Carla no recebimento e "lacre esperado DPX-000501 / observado DPX-000501".

## Etapa 6 — Exame pericial: abertura, novo lacre e laudo (Carla)

**Janela 3**

1. Clique em **Registrar abertura e novo lacre**:

| Campo | Valor |
|---|---|
| Motivo da abertura | `Exame de balística: microcomparação` |
| Finalidade | `Confronto balístico` |
| Data/hora da abertura | hoje, **11:00** |
| Local | `Laboratório de Balística — ICCE` |
| Registrar o novo lacre agora | ☑ |
| Nº do novo lacre | `ICCE-778812` |
| Data/hora do novo lacre | hoje, **12:30** |
| Referência da observação no SPT/SCO | `SPT obs. — relacre ICCE-778812` |
| O lacre rompido foi acondicionado na nova embalagem | ☑ |

2. **Revisar resumo** → **Confirmar e registrar**.
   - **Conferir:**
     - Lacre vigente **`ICCE-778812`**, situação física **Lacrado** e estado **Em processamento**.
     - Aba **Lacres**: 1º `DPX-000501` rompido e 2º `ICCE-778812` vigente, com motivo, horário, local e Carla com cargo.
     - O **nº da FAV não muda** (`DPX-000501/2026/DP-001`).
3. Seção **Dados do Vestígio (exclusivo da perícia)** → **Complementar / retificar** → Nº do laudo: `LAUDO-BAL-2026-0312` → **Salvar**.
   - **Conferir:** a autoria do laudo mostra **Carla**, com papel **PERICIA**.

> **Variante opcional, contraprova:** clique em **Vincular FAV de amostra** e preencha relação **Contraprova**,
> 1º lacre `ICCE-778813`, tipo `Fragmento de referência` e descrição `Fragmento retirado para contraprova`.
> O sistema cria uma **nova FAV** vinculada nas duas direções. Ela aparece na aba **Custódia e encerramento → Amostragem**,
> e esta FAV passa a ser a **prova**.

## Etapa 7 — Envio para a Central de Custódia (Carla → CCV)

**Janela 3** → **Registrar envio**:

| Campo | Valor |
|---|---|
| Unidade de destino | `CCV — Central de Custódia de Vestígios (sintética)` |
| Data/hora do envio | hoje, **14:00** |
| Local de envio | `Guarda provisória do ICCE` |

**Revisar resumo** → **Confirmar e registrar**.
- **Conferir:** **EM TRÂNSITO para CCV**. O registro **Nº 2** foi criado, e o lacre declarado é `ICCE-778812`.

## Etapa 8 — Recebimento e entrada na central (Diego, CCV)

**Janela 4, login `1000004`**

1. **Encaminhamentos → A receber → Abrir ficha → Confirmar recebimento**:

| Campo | Valor |
|---|---|
| Data/hora do recebimento | hoje, **14:45** |
| Local de entrega | `Balcão de recebimento da CCV` |
| Protocolo | `CCV-ENT-2026-05520` |
| Nº do lacre observado | `ICCE-778812` |
| Situação do lacre / Embalagem / SCO | Íntegro / Íntegra / Confere |
| OBS. | ☐ Sem alterações → **Com alterações**: `Etiqueta de inventário da CCV afixada no envelope` |

   As "alterações previstas" não são irregulares. Elas apenas precisam ser descritas.
2. Clique em **Registrar entrada/saída/acesso físico**:

| Campo | Valor |
|---|---|
| Tipo | Entrada na central |
| Protocolo | `CCV-ENT-2026-05520` |
| Referência ocorrência/inquérito | `RO 900-00123/2026` |
| Local de guarda | `Sala 2 — Armário B — Prateleira 3` |
| Pessoa | Eu (servidor da sessão) |
| Data/hora | hoje, **15:00** |

   - **Conferir:** o estado muda para **Armazenado**. A aba **Custódia e encerramento** mostra a entrada com protocolo e local.

## Etapa 9 — Acesso físico para inventário (Lucas, CCV)

**Janela 5, login `1000012`.** Pesquise `DPX-000501` e abra a ficha → **Registrar entrada/saída/acesso físico**:
tipo **Acesso físico**, pessoa **Eu**, data/hora hoje **15:30**, finalidade `Inventário mensal`.
- **Conferir:** o acesso físico fica registrado com **pessoa, data e hora**. Ele é diferente da simples consulta à ficha no
  sistema, que é registrada à parte na auditoria de segurança.

## Etapa 10 — Destinação e encerramento (Diego, CCV)

**Janela 4.** Simule que chegou a decisão judicial. Clique em **Registrar destinação (encerramento)**:

| Campo | Valor |
|---|---|
| Tipo | Destruição |
| Nº do documento do encerramento | `TERMO-DESTR-2026-0044` |
| Autorização judicial (ref.) | `Decisão 2ª Vara Criminal — proc. 0001234-56.2026 (fictício)` |
| Data/hora | hoje, **16:00** |
| Local | `Central de Custódia — área de descarte` |

**Revisar resumo** (o resumo avisa que a cadeia de custódia será **ENCERRADA**) → **Confirmar e registrar**.
- **Conferir:**
  - estado **Encerrado na SEPOL**;
  - a aba **Custódia e encerramento** mostra tipo, documento, autorização, responsável (Diego, com cargo) e local;
  - tentar editar um campo comum é **recusado**, porque a ficha encerrada fica só para consulta.

Depois, ainda com Diego: seção **Guarda documental** → **Complementar / retificar** → Protocolo da anexação no SCO:
`SCO CI 900-00123/2026 — FAV anexada` → **Salvar**. Essa anexação no SCO é a do item 20 das instruções.

## Etapa 11 — PDF e auditoria (qualquer um; Elisa para conferência)

1. Clique em **PDF da FAV**. O documento traz:
   - página **INFORMAÇÕES GERAIS**: coleta, dados do vestígio, laudo, lacres com o 2º lacre e encerramento;
   - página **ENCAMINHAMENTO DO VESTÍGIO**: Nº 1 (DP-001 → ICCE) e Nº 2 (ICCE → CCV) com responsáveis e observações;
   - rodapé com **versão da ficha**, data/hora de geração e quem gerou.
2. **Janela 6, login `1000005` (Elisa, auditora, DP-001).** Abra a ficha e percorra a **Linha do tempo**. Alterne a ordem entre
   **sequência de registro** e **data/hora efetiva** e clique em **ver histórico** de qualquer campo. Os botões de ato ficam
   indisponíveis, porque a auditora tem acesso somente de leitura.

### Linha do tempo esperada (resumo)

| # | Ato | Quem registrou | Unidade |
|---|---|---|---|
| 1 | FAV aberta em rascunho | Ana | DP-001 |
| 2–3 | Preenchimento (coleta / dados do vestígio) | Ana / Bruno | DP-001 |
| 4 | Coleta confirmada — nº DPX-000501/2026/DP-001 | Ana | DP-001 |
| 5 | Envio nº 1 para ICCE | Ana | DP-001 |
| 6 | Recebimento nº 1 confirmado; custódia transferida | Carla | ICCE |
| 7–8 | Abertura do lacre DPX-000501; novo lacre ICCE-778812 | Carla | ICCE |
| 9 | Preenchimento do laudo | Carla | ICCE |
| 10 | Envio nº 2 para CCV | Carla | ICCE |
| 11 | Recebimento nº 2 (com alterações previstas) | Diego | CCV |
| 12 | Entrada na central | Diego | CCV |
| 13 | Acesso físico (inventário) | Lucas | CCV |
| 14 | Encerramento: destruição | Diego | CCV |
| 15 | Guarda documental (anexação no SCO) | Diego | CCV |

---

## Variações para treinar exceções

| Variação | Como fazer | Resultado esperado |
|---|---|---|
| **Lacre divergente** | Na etapa 5, informe lacre observado `DPX-000599` | O sistema exige descrever em **Não conformidades** (ex.: `Número de lacre não confere`). Depois disso, o estado vira **Recebido com ocorrência** e a pendência fica visível |
| **Recusa** | Na etapa 5, use **Recusar recebimento** (motivo `Requisição ausente`) | Movimentação **Recusado**; custódia volta para Ana; ela pode enviar de novo (Nº 2) |
| **Envio errado** | Ana envia para a CCV por engano e usa **Cancelar envio** antes do recebimento | Movimentação **Cancelado**, com o registro original preservado |
| **Recipiente aberto** | Na etapa 6, desmarque "Registrar o novo lacre agora" e tente **Registrar envio** | Bloqueado: "Recipiente aberto". Use **Registrar novo lacre** para regularizar |
| **Coletor externo** | Ficha nova (Bruno): **Registrar pessoa externa** (papel coletor, `Paulo Guarda (fictício)`, RG `12.345.678-9`, fonte `Termo de entrega nº 55/2026`) e escolha "Pessoa externa" como responsável pela coleta | Bruno aparece como autor do lançamento e Paulo como interveniente documental, sem conta. A primeira entrega é registrada em nome do externo |
| **Sem vínculo elegível** | Entre como `1000006` (Fábio) | Ele consulta, mas não consegue criar nem preencher ficha |
| **Fora do escopo** | Entre como `0000010` (Joana, DP-002) e pesquise `DPX-000501` | Nada aparece: a ficha não passou pela DP-002 |
| **Retificação** | Bruno corrige o nº do procedimento após a confirmação | O sistema exige **motivo**; o histórico mostra o valor anterior, o novo e quem retificou |
| **Grande porte** | Joana cria uma ficha **Grande porte** (requisição `REQ-GP-2026-0010`, procedimento `900-00200/2026`, tipo `Motor de veículo`), confirma a coleta e, no card **Etiquetas de Grande Porte**, cadastra 3 volumes e gera o PDF | Etiquetas A4 "Volume 1 de 3, 2 de 3, 3 de 3"; nº da FAV = nº da requisição; reimpressão exige motivo |
