-- FAV Digital — migração 0001: identidade, autorização, sessão, FAV, custódia e auditoria.
-- Executada pelo papel fav_migrator (dono do esquema `fav`). A aplicação usa fav_app.
-- Instantes em UTC (timestamptz); apresentação em America/Sao_Paulo.

SET search_path = fav;

-- ---------------------------------------------------------------- utilitários
CREATE FUNCTION fav.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tabela % é de inclusão contínua: % não permitido', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END$$;

-- ---------------------------------------------------------------- unidades
CREATE TABLE unit (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('policia_judiciaria','pericia','central_custodia','administrativa','outra')),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- identidade importada
CREATE TABLE directory_sync_run (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  source        text NOT NULL,
  mode          text NOT NULL CHECK (mode IN ('full','incremental')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','failed','aborted_anomaly')),
  seen          integer NOT NULL DEFAULT 0,
  created       integer NOT NULL DEFAULT 0,
  updated       integer NOT NULL DEFAULT 0,
  disabled      integer NOT NULL DEFAULT 0,
  blocked       integer NOT NULL DEFAULT 0,
  pages         integer NOT NULL DEFAULT 0,
  diagnostic    text      -- sanitizado: sem senhas, tickets ou respostas brutas
);
-- Uma sincronização por origem de cada vez.
CREATE UNIQUE INDEX directory_sync_run_one_running ON directory_sync_run (source) WHERE status = 'running';

CREATE TABLE identity (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  source             text NOT NULL,                       -- ex.: 'ad-pcerj', 'sim'
  directory_guid     text NOT NULL,                       -- objectGUID em forma canônica (minúsculas, com hífens)
  login              text NOT NULL,                       -- sAMAccountName (ID funcional normalizado)
  functional_id      text NOT NULL,
  display_name       text NOT NULL,
  unit_code          text,                                -- lotação informada pela fonte autorizada
  job_title          text,
  eligible_pcerj     boolean NOT NULL DEFAULT false,      -- vínculo elegível de servidor (critério institucional)
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','blocked')),
  block_reason       text,
  attributes_complete boolean NOT NULL DEFAULT true,
  last_seen_sync_id  uuid REFERENCES directory_sync_run(id),
  imported_at        timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  disabled_at        timestamptz,
  UNIQUE (source, directory_guid)
);
-- Um login só pode corresponder a uma identidade ativa por origem; colisões ficam bloqueadas.
CREATE UNIQUE INDEX identity_active_login ON identity (source, lower(login)) WHERE status = 'active';
CREATE INDEX identity_login ON identity (source, lower(login));

-- Retrato dos atributos institucionais no instante da atuação (inclusão contínua).
CREATE TABLE identity_snapshot (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  identity_id    uuid NOT NULL REFERENCES identity(id),
  login          text NOT NULL,
  functional_id  text NOT NULL,
  display_name   text NOT NULL,
  unit_code      text,
  job_title      text,
  captured_at    timestamptz NOT NULL DEFAULT now(),
  fingerprint    text NOT NULL
);
CREATE INDEX identity_snapshot_lookup ON identity_snapshot (identity_id, fingerprint);

CREATE TABLE role_assignment (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  identity_id  uuid NOT NULL REFERENCES identity(id),
  role         text NOT NULL CHECK (role IN ('ORIGEM_COLETA','REGISTRO_UNIDADE','CUSTODIA','PERICIA','ENCERRAMENTO','AUDITOR','ADMIN_CONFIG')),
  unit_id      uuid NOT NULL REFERENCES unit(id),
  source       text NOT NULL DEFAULT 'atribuicao_auditada' CHECK (source IN ('atribuicao_auditada','grupo_diretorio')),
  granted_by   uuid REFERENCES identity(id),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  reason       text,
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES identity(id),
  revoke_reason text
);
CREATE UNIQUE INDEX role_assignment_active ON role_assignment (identity_id, role, unit_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- sessão
CREATE TABLE app_session (
  token_hash          bytea PRIMARY KEY,                  -- SHA-256 do identificador opaco; o valor bruto só existe no cookie
  identity_id         uuid NOT NULL REFERENCES identity(id),
  unit_id             uuid REFERENCES unit(id),           -- contexto de unidade selecionado
  csrf_token          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  last_validated_at   timestamptz NOT NULL DEFAULT now(), -- última validação de identidade/autorização
  revoked_at          timestamptz,
  revoke_reason       text,
  client_hint         text
);
CREATE INDEX app_session_identity ON app_session (identity_id) WHERE revoked_at IS NULL;

CREATE TABLE login_throttle (
  key          text PRIMARY KEY,           -- hash de login ou de origem; nunca o valor bruto
  window_start timestamptz NOT NULL,
  failures     integer NOT NULL DEFAULT 0,
  locked_until timestamptz
);

-- ---------------------------------------------------------------- intervenientes externos
-- Pessoas de fora da PCERJ que praticaram atos físicos. Sem conta, sem confirmação no sistema.
CREATE TABLE intervener (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  fav_id          uuid NOT NULL,                  -- FK adicionada após a criação de `fav`
  role            text NOT NULL CHECK (role IN ('coletor','preservador','transportador','entregador','destinatario','acesso_fisico','outro')),
  name            text NOT NULL,
  document_type   text NOT NULL,              -- ex.: RG, CNH, matrícula de outro órgão
  document_number text NOT NULL,
  organization    text,
  evidence_source text NOT NULL,              -- fonte comprobatória (ex.: termo de entrega nº ...)
  evidence_status text NOT NULL DEFAULT 'pendente' CHECK (evidence_status IN ('pendente','apresentada')),
  registered_by   uuid NOT NULL REFERENCES identity(id),
  registered_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- FAV
CREATE SEQUENCE fav_draft_seq;

CREATE TABLE fav (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  draft_code            text NOT NULL UNIQUE DEFAULT ('RASC-' || lpad(nextval('fav.fav_draft_seq')::text, 6, '0')),
  kind                  text NOT NULL CHECK (kind IN ('regular','grande_porte')),
  numero                text,                         -- nº documental: 1º lacre/ano/unidade ou nº da requisição
  numero_year           integer,
  origin_unit_id        uuid NOT NULL REFERENCES unit(id),
  model_version         text NOT NULL DEFAULT 'FAV-2026.1',
  status                text NOT NULL DEFAULT 'rascunho'
                        CHECK (status IN ('rascunho','sob_custodia','em_transito','recebido_com_ocorrencia','em_processamento','armazenado','encerrado')),
  physical_state        text NOT NULL DEFAULT 'lacrado'
                        CHECK (physical_state IN ('lacrado','aberto','sem_lacre_grande_porte','consumido_parcial','consumido_total')),
  custodian_kind        text CHECK (custodian_kind IN ('servidor','externo')),
  custodian_identity_id uuid REFERENCES identity(id),
  custodian_intervener_id uuid REFERENCES intervener(id),
  custodian_unit_id     uuid REFERENCES unit(id),
  version               integer NOT NULL DEFAULT 1,
  coleta_confirmed_at   timestamptz,
  vestigio_confirmed_at timestamptz,

  -- Dados da Coleta e 1º Lacre
  coleta_responsavel_kind          text CHECK (coleta_responsavel_kind IN ('servidor','externo')),
  coleta_responsavel_identity_id   uuid REFERENCES identity(id),
  coleta_responsavel_intervener_id uuid REFERENCES intervener(id),
  coleta_data_hora                 timestamptz,
  coleta_endereco                  text,
  coleta_geo_lat                   numeric(9,6),
  coleta_geo_lon                   numeric(9,6),
  vestigio_tipo                    text,
  vestigio_descricao               text,
  vestigio_localizacao             text,
  preservacao_mesmo_coletor        boolean,
  preservacao_kind                 text CHECK (preservacao_kind IN ('servidor','externo')),
  preservacao_identity_id          uuid REFERENCES identity(id),
  preservacao_intervener_id        uuid REFERENCES intervener(id),
  documentacao_pericial_ref        text,          -- reconhecimento, isolamento, fixação

  -- Dados do Vestígio
  natureza_exame                   text[] CHECK (natureza_exame <@ ARRAY['criminal','medico_legal','papiloscopico','dna']::text[]),
  requisicao                       text,
  procedimento                     text,
  unidade_pj_id                    uuid REFERENCES unit(id),
  sco_primeiro_lacre_ref           text,          -- referência do registro no SCO declarada pelo operador
  sco_primeiro_lacre_conferido     boolean,

  -- Dados do Vestígio (exclusivo da perícia)
  laudo_numero                     text,
  amostragem_classe                text CHECK (amostragem_classe IN ('prova','contraprova','aliquota','contrapericia')),

  -- Guarda documental
  guarda_unidade_id                uuid REFERENCES unit(id),
  sco_anexacao_ref                 text,

  created_by     uuid NOT NULL REFERENCES identity(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fav_coleta_resp_xor CHECK (
    coleta_responsavel_kind IS NULL
    OR (coleta_responsavel_kind = 'servidor' AND coleta_responsavel_identity_id IS NOT NULL AND coleta_responsavel_intervener_id IS NULL)
    OR (coleta_responsavel_kind = 'externo'  AND coleta_responsavel_intervener_id IS NOT NULL AND coleta_responsavel_identity_id IS NULL)),
  CONSTRAINT fav_custodian_xor CHECK (
    custodian_kind IS NULL
    OR (custodian_kind = 'servidor' AND custodian_identity_id IS NOT NULL AND custodian_intervener_id IS NULL)
    OR (custodian_kind = 'externo'  AND custodian_intervener_id IS NOT NULL AND custodian_identity_id IS NULL)),
  CONSTRAINT fav_numero_required CHECK (status = 'rascunho' OR numero IS NOT NULL),
  CONSTRAINT fav_geo_pair CHECK ((coleta_geo_lat IS NULL) = (coleta_geo_lon IS NULL))
);
-- Unicidade do número documental no escopo provisório (global) — ver pendência P-NUM-01.
ALTER TABLE intervener ADD CONSTRAINT intervener_fav_fk FOREIGN KEY (fav_id) REFERENCES fav(id);
CREATE INDEX intervener_fav ON intervener (fav_id);

CREATE UNIQUE INDEX fav_numero_unique ON fav (numero) WHERE numero IS NOT NULL;
CREATE INDEX fav_requisicao ON fav (requisicao);
CREATE INDEX fav_procedimento ON fav (procedimento);
CREATE INDEX fav_custodian_unit ON fav (custodian_unit_id);

-- Lacres (1º lacre e sucessivos). Um único lacre ativo por FAV.
CREATE TABLE seal (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  fav_id            uuid NOT NULL REFERENCES fav(id),
  ordinal           integer NOT NULL CHECK (ordinal >= 1),
  number            text NOT NULL,
  status            text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','rompido','substituido_rascunho')),
  applied_at        timestamptz,
  applied_by_identity_id   uuid REFERENCES identity(id),
  applied_by_intervener_id uuid REFERENCES intervener(id),
  applied_location  text,
  identificador_grande_porte boolean NOT NULL DEFAULT false,
  created_by        uuid NOT NULL REFERENCES identity(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  broken_at         timestamptz,
  UNIQUE (fav_id, ordinal)
);
CREATE UNIQUE INDEX seal_one_active ON seal (fav_id) WHERE status = 'ativo';
CREATE INDEX seal_number ON seal (number);

-- Abertura e relacre (tabela "Lacres" do modelo; repetível sem limite de linhas).
CREATE TABLE seal_opening (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  fav_id                 uuid NOT NULL REFERENCES fav(id),
  previous_seal_id       uuid NOT NULL REFERENCES seal(id),
  motivo                 text NOT NULL,
  finalidade             text,
  opened_at              timestamptz NOT NULL,          -- data/hora efetiva declarada
  location               text NOT NULL,
  responsible_identity_id uuid NOT NULL REFERENCES identity(id),
  responsible_snapshot_id uuid NOT NULL REFERENCES identity_snapshot(id),
  status                 text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','fechado')),
  closed_at              timestamptz,
  new_seal_id            uuid REFERENCES seal(id),
  broken_seal_packaged   boolean,                       -- lacre rompido acondicionado na nova embalagem
  sco_observacao_ref     text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seal_opening_closed CHECK (status = 'aberto' OR (new_seal_id IS NOT NULL AND closed_at IS NOT NULL AND broken_seal_packaged IS TRUE))
);
CREATE UNIQUE INDEX seal_opening_one_open ON seal_opening (fav_id) WHERE status = 'aberto';

-- Movimentações (lista contínua; substitui as folhas complementares).
CREATE TABLE movement (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  fav_id                 uuid NOT NULL REFERENCES fav(id),
  seq                    integer NOT NULL CHECK (seq >= 1),
  status                 text NOT NULL CHECK (status IN ('em_transito','recebido','recebido_com_ressalva','recusado','cancelado')),
  -- envio
  sent_at                timestamptz NOT NULL,        -- data/hora efetiva declarada
  send_location          text NOT NULL,
  sender_kind            text NOT NULL CHECK (sender_kind IN ('servidor','externo')),
  sender_identity_id     uuid REFERENCES identity(id),
  sender_intervener_id   uuid REFERENCES intervener(id),
  sender_snapshot_id     uuid REFERENCES identity_snapshot(id),
  origin_unit_id         uuid REFERENCES unit(id),
  dest_unit_id           uuid NOT NULL REFERENCES unit(id),
  transporter_intervener_id uuid REFERENCES intervener(id),
  tracking_code          text,
  send_registered_by     uuid NOT NULL REFERENCES identity(id),
  send_registered_at     timestamptz NOT NULL DEFAULT now(),
  send_seal_number       text,                       -- lacre vigente declarado no envio
  -- recebimento
  received_at            timestamptz,
  receive_location       text,
  receiver_identity_id   uuid REFERENCES identity(id),
  receiver_snapshot_id   uuid REFERENCES identity_snapshot(id),
  receive_registered_at  timestamptz,
  protocolo              text,
  -- conferência (itens 12–13)
  seal_expected          text,
  seal_observed          text,
  seal_situation         text CHECK (seal_situation IN ('integro','rompido','divergente','sem_lacre')),
  packaging_situation    text CHECK (packaging_situation IN ('integra','violada','danificada')),
  sco_correspondencia    text CHECK (sco_correspondencia IN ('confere','nao_confere','nao_aplicavel','nao_verificado')),
  obs_sem_alteracoes     boolean,
  obs_alteracoes         text,                       -- "alterações previstas" (não fraudulentas)
  obs_nao_conformidades  text,
  obs_livre              text,
  refusal_reason         text,
  cancel_reason          text,
  closed_at              timestamptz,
  UNIQUE (fav_id, seq),
  CONSTRAINT movement_sender_xor CHECK (
    (sender_kind = 'servidor' AND sender_identity_id IS NOT NULL AND sender_intervener_id IS NULL)
    OR (sender_kind = 'externo' AND sender_intervener_id IS NOT NULL AND sender_identity_id IS NULL)),
  CONSTRAINT movement_obs_consistent CHECK (
    status NOT IN ('recebido','recebido_com_ressalva')
    OR ((obs_sem_alteracoes IS TRUE AND obs_alteracoes IS NULL AND obs_nao_conformidades IS NULL)
     OR (obs_sem_alteracoes IS FALSE AND (obs_alteracoes IS NOT NULL OR obs_nao_conformidades IS NOT NULL)))),
  CONSTRAINT movement_receiver_distinct CHECK (receiver_identity_id IS NULL OR sender_identity_id IS NULL OR receiver_identity_id <> sender_identity_id)
);
-- Uma única transferência ativa por vestígio.
CREATE UNIQUE INDEX movement_one_active ON movement (fav_id) WHERE status = 'em_transito';
CREATE INDEX movement_dest_unit_active ON movement (dest_unit_id) WHERE status = 'em_transito';

-- Vínculos de amostragem (prova ↔ contraprova/alíquota/contraperícia).
CREATE TABLE sample_link (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  prova_fav_id    uuid NOT NULL REFERENCES fav(id),
  derivada_fav_id uuid NOT NULL REFERENCES fav(id),
  relation        text NOT NULL CHECK (relation IN ('contraprova','aliquota','contrapericia')),
  derivation_act  text NOT NULL,
  created_by      uuid NOT NULL REFERENCES identity(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prova_fav_id, derivada_fav_id),
  UNIQUE (derivada_fav_id),                       -- uma FAV derivada tem uma única prova de origem
  CHECK (prova_fav_id <> derivada_fav_id)
);

-- Central de custódia / armazenamento / acesso físico.
CREATE TABLE storage_event (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  fav_id          uuid NOT NULL REFERENCES fav(id),
  kind            text NOT NULL CHECK (kind IN ('entrada','saida','acesso_fisico','guarda_contrapericia','deposito_alternativo','devolucao_pos_pericia')),
  protocolo       text,
  ocorrencia_ref  text,
  local_guarda    text,
  person_kind     text NOT NULL CHECK (person_kind IN ('servidor','externo')),
  person_identity_id   uuid REFERENCES identity(id),
  person_intervener_id uuid REFERENCES intervener(id),
  effective_at    timestamptz NOT NULL,
  finalidade      text,
  decision_doc    text,
  unit_id         uuid NOT NULL REFERENCES unit(id),
  registered_by   uuid NOT NULL REFERENCES identity(id),
  registered_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX storage_event_fav ON storage_event (fav_id, effective_at);

-- Encerramento da cadeia de custódia no âmbito da SEPOL.
CREATE TABLE closure (
  fav_id            uuid PRIMARY KEY REFERENCES fav(id),
  tipo              text NOT NULL CHECK (tipo IN ('analise_destrutiva','destruicao','devolucao_proprietario','transferencia_externa','outro')),
  outro_descricao   text,
  documento_numero  text NOT NULL,
  autorizacao_judicial_ref text,
  effective_at      timestamptz NOT NULL,
  location          text NOT NULL,
  destinatario      text,
  responsible_identity_id uuid NOT NULL REFERENCES identity(id),
  responsible_snapshot_id uuid NOT NULL REFERENCES identity_snapshot(id),
  registered_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (tipo <> 'outro' OR outro_descricao IS NOT NULL)
);

-- Volumes do vestígio de grande porte e etiquetas.
CREATE TABLE volume (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  fav_id      uuid NOT NULL REFERENCES fav(id),
  ordinal     integer NOT NULL CHECK (ordinal >= 1),
  descricao   text,
  lacre_identificador text,
  created_by  uuid NOT NULL REFERENCES identity(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fav_id, ordinal)
);

CREATE TABLE label_batch (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  fav_id         uuid NOT NULL REFERENCES fav(id),
  batch_version  integer NOT NULL,
  volumes_total  integer NOT NULL,
  responsible_identity_id uuid NOT NULL REFERENCES identity(id),
  responsible_snapshot_id uuid NOT NULL REFERENCES identity_snapshot(id),
  pdf_sha256     text NOT NULL,
  reason         text,                            -- obrigatório na reimpressão
  status         text NOT NULL DEFAULT 'gerada' CHECK (status IN ('gerada','impressao_solicitada','afixacao_confirmada','substituida')),
  superseded_by  uuid REFERENCES label_batch(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fav_id, batch_version)
);

-- ---------------------------------------------------------------- trilhas de inclusão contínua
-- 1) Eventos de cadeia de custódia
CREATE TABLE custody_event (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_uuid       uuid NOT NULL UNIQUE DEFAULT uuidv7(),
  fav_id           uuid NOT NULL REFERENCES fav(id),
  type             text NOT NULL,
  effective_at     timestamptz,                    -- data/hora efetiva declarada do ato
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  actor_identity_id uuid NOT NULL REFERENCES identity(id),
  actor_snapshot_id uuid NOT NULL REFERENCES identity_snapshot(id),
  actor_unit_id    uuid REFERENCES unit(id),
  actor_role       text,
  fav_version      integer NOT NULL,
  status_before    text,
  status_after     text,
  movement_id      uuid REFERENCES movement(id),
  summary          text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  late_entry_reason text                            -- lançamento posterior motivado
);
CREATE INDEX custody_event_fav ON custody_event (fav_id, id);
CREATE TRIGGER custody_event_append_only BEFORE UPDATE OR DELETE ON custody_event FOR EACH ROW EXECUTE FUNCTION fav.forbid_mutation();
CREATE TRIGGER custody_event_no_truncate BEFORE TRUNCATE ON custody_event FOR EACH STATEMENT EXECUTE FUNCTION fav.forbid_mutation();

-- 2) Revisões de campo
CREATE TABLE field_revision (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fav_id           uuid NOT NULL REFERENCES fav(id),
  entity           text NOT NULL,                   -- 'fav','movement','seal','seal_opening','closure','volume',...
  entity_key       uuid NOT NULL,                   -- chave estável do item
  field            text NOT NULL,
  old_value        jsonb,
  new_value        jsonb,
  action           text NOT NULL CHECK (action IN ('preenchimento','alteracao','remocao','retificacao','automatico','transcricao')),
  fav_version      integer NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  author_identity_id uuid NOT NULL REFERENCES identity(id),
  author_snapshot_id uuid NOT NULL REFERENCES identity_snapshot(id),
  author_unit_id   uuid REFERENCES unit(id),
  author_role      text,
  reason           text,
  origin           text NOT NULL DEFAULT 'humano' CHECK (origin IN ('humano','automatico','transcricao')),
  source_ref       text,                            -- fonte da transcrição ou regra automática
  custody_event_id bigint REFERENCES custody_event(id),
  CHECK (action <> 'retificacao' OR reason IS NOT NULL)
);
CREATE INDEX field_revision_lookup ON field_revision (fav_id, entity, entity_key, field, id);
CREATE TRIGGER field_revision_append_only BEFORE UPDATE OR DELETE ON field_revision FOR EACH ROW EXECUTE FUNCTION fav.forbid_mutation();
CREATE TRIGGER field_revision_no_truncate BEFORE TRUNCATE ON field_revision FOR EACH STATEMENT EXECUTE FUNCTION fav.forbid_mutation();

-- 3) Auditoria de acesso e segurança
CREATE TABLE security_audit (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  identity_id   uuid REFERENCES identity(id),
  unit_id       uuid REFERENCES unit(id),
  action        text NOT NULL,                     -- login, logout, consulta_fav, exportacao, impressao, sincronizacao, papel...
  target_type   text,
  target_id     text,
  outcome       text NOT NULL CHECK (outcome IN ('sucesso','negado','rejeitado','indisponivel','erro')),
  correlation_id text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb -- sanitizado
);
CREATE INDEX security_audit_target ON security_audit (target_type, target_id, id);
CREATE TRIGGER security_audit_append_only BEFORE UPDATE OR DELETE ON security_audit FOR EACH ROW EXECUTE FUNCTION fav.forbid_mutation();
CREATE TRIGGER security_audit_no_truncate BEFORE TRUNCATE ON security_audit FOR EACH STATEMENT EXECUTE FUNCTION fav.forbid_mutation();

CREATE TRIGGER identity_snapshot_append_only BEFORE UPDATE OR DELETE ON identity_snapshot FOR EACH ROW EXECUTE FUNCTION fav.forbid_mutation();

-- Documentos exportados (PDF da FAV / etiquetas): registro de geração e hash.
CREATE TABLE document_export (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  fav_id        uuid NOT NULL REFERENCES fav(id),
  kind          text NOT NULL CHECK (kind IN ('fav_pdf','etiquetas_pdf')),
  fav_version   integer NOT NULL,
  sha256        text NOT NULL,
  generated_by  uuid NOT NULL REFERENCES identity(id),
  generated_at  timestamptz NOT NULL DEFAULT now(),
  purpose       text
);
CREATE TRIGGER document_export_append_only BEFORE UPDATE OR DELETE ON document_export FOR EACH ROW EXECUTE FUNCTION fav.forbid_mutation();

-- Idempotência de comandos de confirmação.
CREATE TABLE idempotency_record (
  actor_identity_id uuid NOT NULL REFERENCES identity(id),
  key           text NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  operation     text NOT NULL,
  request_hash  text NOT NULL,
  status_code   integer,
  response      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_identity_id, key)
);

-- ---------------------------------------------------------------- permissões da conta de execução
GRANT SELECT ON ALL TABLES IN SCHEMA fav TO fav_app;
GRANT INSERT, UPDATE ON unit, directory_sync_run, identity, role_assignment, app_session, login_throttle,
  intervener, fav, seal, seal_opening, movement, sample_link, storage_event, closure, volume, label_batch,
  idempotency_record TO fav_app;
GRANT DELETE ON app_session, login_throttle, idempotency_record TO fav_app;
-- Trilhas: somente inclusão.
GRANT INSERT ON custody_event, field_revision, security_audit, identity_snapshot, document_export TO fav_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA fav TO fav_app;
