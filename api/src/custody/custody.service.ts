/**
 * Atos de cadeia de custódia. Cada comando: valida ator/estado no servidor, grava projeção corrente,
 * evento, revisões de campo e registro de idempotência em UMA transação.
 */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Database, type Tx } from '../db/database.js';
import { ActWriter, type RevisionInput, valuesEqual, withIdempotency } from '../common/acts.js';
import { badRequest, conflict, forbidden, mapPgError, notFound, unprocessable } from '../common/errors.js';
import { parse } from '../common/validation.js';
import { assertOrder, checkEffectiveAt, requireLateReason } from '../common/time.js';
import { requireCustodyAct, requireRole } from '../authz/policy.js';
import type { Actor } from '../authz/roles.js';
import { FavAccess, type FavRow } from '../fav/fav.access.js';
import { normalizeDocNumber } from '../fav/fav.service.js';

const dt = z.iso.datetime({ offset: true });
const txt = (max = 500) => z.string().trim().min(1).max(max);
const optTxt = (max = 500) => z.string().trim().max(max).optional().transform((v) => (v ? v : null));

const SendBody = z.object({
  versao: z.number().int().positive(),
  enviadoEm: dt,
  localEnvio: txt(300),
  unidadeDestinoId: z.uuid(),
  /** Remetente externo (registro documental): obrigatório quando o custodiante é interveniente externo. */
  transportadorIntervenienteId: z.uuid().optional(),
  codigoRastreamento: optTxt(100),
  motivoLancamentoPosterior: optTxt(1000),
});

const ObsSchema = z.object({
  semAlteracoes: z.boolean(),
  alteracoes: optTxt(2000),
  naoConformidades: optTxt(2000),
}).superRefine((o, ctx) => {
  if (o.semAlteracoes && (o.alteracoes || o.naoConformidades)) ctx.addIssue({ code: 'custom', message: '"Sem alterações" não admite descrições.' });
  if (!o.semAlteracoes && !o.alteracoes && !o.naoConformidades) ctx.addIssue({ code: 'custom', message: 'Descreva as alterações previstas e/ou as não conformidades.' });
});

const ReceiveBody = z.object({
  recebidoEm: dt,
  localEntrega: txt(300),
  protocolo: optTxt(100),
  lacreObservado: optTxt(60),
  situacaoLacre: z.enum(['integro', 'rompido', 'divergente', 'sem_lacre']),
  situacaoEmbalagem: z.enum(['integra', 'violada', 'danificada']),
  correspondenciaSco: z.enum(['confere', 'nao_confere', 'nao_aplicavel', 'nao_verificado']),
  observacoes: ObsSchema,
  observacaoLivre: optTxt(2000),
  motivoLancamentoPosterior: optTxt(1000),
});

const RefuseBody = z.object({ motivo: txt(1000), recusadoEm: dt });
const CancelBody = z.object({ motivo: txt(1000) });

const OpenBody = z.object({
  versao: z.number().int().positive(),
  motivo: txt(1000),
  finalidade: optTxt(500),
  abertoEm: dt,
  local: txt(300),
  autorizacaoRef: optTxt(200),
  motivoLancamentoPosterior: optTxt(1000),
  fechamento: z.object({
    novoLacre: txt(60),
    fechadoEm: dt,
    lacreRompidoAcondicionado: z.literal(true),
    referenciaSco: optTxt(200),
  }).optional(),
});

const ResealBody = z.object({
  versao: z.number().int().positive(),
  novoLacre: txt(60),
  fechadoEm: dt,
  lacreRompidoAcondicionado: z.literal(true),
  referenciaSco: optTxt(200),
});

const StorageBody = z.object({
  tipo: z.enum(['entrada', 'saida', 'acesso_fisico', 'guarda_contrapericia', 'deposito_alternativo', 'devolucao_pos_pericia']),
  protocolo: optTxt(100),
  referenciaOcorrencia: optTxt(100),
  localGuarda: optTxt(300),
  pessoa: z.discriminatedUnion('tipo', [
    z.object({ tipo: z.literal('servidor'), identidadeId: z.uuid() }),
    z.object({ tipo: z.literal('externo'), intervenienteId: z.uuid() }),
  ]),
  ocorridoEm: dt,
  finalidade: optTxt(500),
  documentoDecisao: optTxt(200),
});

const DeriveBody = z.object({
  relacao: z.enum(['contraprova', 'aliquota', 'contrapericia']),
  atoDerivacao: txt(1000),
  /** Cria nova FAV derivada já lacrada pelo perito… */
  nova: z.object({ primeiroLacre: txt(60), coletadoEm: dt, local: txt(300), descricao: txt(2000), tipo: txt(200) }).optional(),
  /** …ou vincula uma FAV existente. */
  favExistenteId: z.uuid().optional(),
}).refine((b) => !!b.nova !== !!b.favExistenteId, { message: 'Informe "nova" ou "favExistenteId" (apenas um).' });

const PartialBody = z.object({ laudo: txt(60), descricao: txt(1000), ocorridoEm: dt });

const CloseBody = z.object({
  versao: z.number().int().positive(),
  tipo: z.enum(['analise_destrutiva', 'destruicao', 'devolucao_proprietario', 'transferencia_externa', 'outro']),
  outroDescricao: optTxt(500),
  documentoNumero: optTxt(100),
  autorizacaoJudicialRef: optTxt(200),
  ocorridoEm: dt,
  local: txt(300),
  destinatario: optTxt(300),
  motivoLancamentoPosterior: optTxt(1000),
});

const MOVEMENT_RETIFIABLE: Record<string, z.ZodType> = {
  send_location: txt(300), receive_location: txt(300), tracking_code: txt(100).nullable(), protocolo: txt(100).nullable(),
  obs_livre: txt(2000).nullable(), sent_at: dt, received_at: dt,
};

const OPEN_STATES = new Set(['sob_custodia', 'recebido_com_ocorrencia', 'em_processamento', 'armazenado']);

@Injectable()
export class CustodyService {
  constructor(private readonly db: Database, private readonly access: FavAccess, private readonly acts: ActWriter) {}

  private async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try { return await this.db.tx(fn); } catch (e) { mapPgError(e); }
  }

  private async activeSeal(tx: Tx, favId: string): Promise<{ id: string; number: string; ordinal: number } | null> {
    return (await tx.query(`SELECT id, number, ordinal FROM seal WHERE fav_id = $1 AND status = 'ativo'`, [favId])).rows[0] ?? null;
  }

  private requireMovable(f: FavRow): void {
    this.access.requireNotClosed(f);
    if (f.status === 'rascunho') throw conflict('ETAPA_INVALIDA', 'Confirme a coleta antes de movimentar o vestígio.');
    if (f.status === 'em_transito') throw conflict('TRANSFERENCIA_ATIVA', 'Já existe transferência ativa para este vestígio.');
    if (f.physical_state === 'aberto') throw conflict('RECIPIENTE_ABERTO', 'Recipiente aberto: registre o novo lacre antes de qualquer movimentação ordinária.');
    if (!OPEN_STATES.has(f.status)) throw conflict('ETAPA_INVALIDA', `Estado atual (${f.status}) não admite envio.`);
  }

  // ------------------------------------------------------------------ Registrar envio
  async send(actor: Actor, favId: string, body: unknown, key?: string) {
    requireCustodyAct(actor);
    const b = parse(SendBody, body);
    return this.run(async (tx) => (await withIdempotency(tx, actor, key, `envio:${favId}`, b, async () => {
      const f = await this.access.lockForWrite(tx, actor, favId, b.versao);
      this.requireMovable(f);
      this.access.requireCustodianUnit(actor, f);
      const sent = checkEffectiveAt(b.enviadoEm, 'Data/hora do envio');
      const late = requireLateReason(sent, b.motivoLancamentoPosterior, 'Envio');
      assertOrder(f.coleta_data_hora, sent, 'O envio não pode ser anterior à coleta.');
      if (b.unidadeDestinoId === actor.unitId) throw unprocessable('DESTINO_INVALIDO', 'A unidade de destino deve ser diferente da unidade remetente.');
      const dest = await tx.query(`SELECT code FROM unit WHERE id = $1 AND active`, [b.unidadeDestinoId]);
      if (!dest.rowCount) throw unprocessable('DESTINO_INVALIDO', 'Unidade de destino inexistente ou inativa.');

      const last = (await tx.query(`SELECT * FROM movement WHERE fav_id = $1 ORDER BY seq DESC LIMIT 1`, [f.id])).rows[0];
      if (last?.received_at) assertOrder(last.received_at, sent, 'O envio não pode ser anterior ao último recebimento.');
      const seq = (last?.seq ?? 0) + 1;

      // Remetente: o servidor da sessão; se o custodiante é externo, registro documental do interveniente.
      let sender: { kind: 'servidor' | 'externo'; identity: string | null; intervener: string | null };
      let role;
      if (f.custodian_kind === 'externo') {
        role = requireRole(actor, 'REGISTRO_UNIDADE', 'ORIGEM_COLETA');
        sender = { kind: 'externo', identity: null, intervener: f.custodian_intervener_id };
      } else {
        role = requireRole(actor, 'CUSTODIA', 'ORIGEM_COLETA', 'REGISTRO_UNIDADE', 'PERICIA');
        sender = { kind: 'servidor', identity: actor.identityId, intervener: null };
      }
      // Item 11: no primeiro registro, o responsável pela entrega é o próprio coletor.
      if (seq === 1) {
        const same = f.coleta_responsavel_kind === 'servidor'
          ? sender.identity === f.coleta_responsavel_identity_id
          : sender.intervener === f.coleta_responsavel_intervener_id;
        if (!same) throw unprocessable('PRIMEIRA_ENTREGA_PELO_COLETOR', 'No primeiro encaminhamento, o responsável pela entrega deve ser o responsável pela coleta (item 11).');
      }
      if (b.transportadorIntervenienteId) {
        const t = await tx.query(`SELECT 1 FROM intervener WHERE id = $1 AND fav_id = $2`, [b.transportadorIntervenienteId, f.id]);
        if (!t.rowCount) throw unprocessable('REFERENCIA_INVALIDA', 'Transportador não registrado nesta FAV.');
      }
      const seal = await this.activeSeal(tx, f.id);
      const ctx = await this.acts.context(tx, actor, role);
      const m = (await tx.query(
        `INSERT INTO movement (fav_id, seq, status, sent_at, send_location, sender_kind, sender_identity_id, sender_intervener_id,
           sender_snapshot_id, origin_unit_id, dest_unit_id, transporter_intervener_id, tracking_code, send_registered_by, send_seal_number)
         VALUES ($1,$2,'em_transito',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [f.id, seq, sent.toISOString(), b.localEnvio, sender.kind, sender.identity, sender.intervener,
          sender.kind === 'servidor' ? ctx.snapshotId : null, actor.unitId, b.unidadeDestinoId, b.transportadorIntervenienteId ?? null,
          b.codigoRastreamento, actor.identityId, seal?.number ?? null])).rows[0];
      const version = await this.access.bumpVersion(tx, f.id, { status: 'em_transito' });
      const ev = await this.acts.event(tx, ctx, {
        favId: f.id, type: 'envio_registrado', favVersion: version, effectiveAt: sent, statusBefore: f.status, statusAfter: 'em_transito',
        movementId: m.id, lateEntryReason: late,
        summary: `Envio nº ${seq} para ${dest.rows[0].code}${sender.kind === 'externo' ? ' (entrega por interveniente externo, registro documental)' : ''}`,
        payload: { seq, destino: dest.rows[0].code, lacreVigente: seal?.number ?? null, remetenteTipo: sender.kind },
      });
      await this.acts.revisions(tx, ctx, f.id, version, this.acts.creationRevisions('movement', m.id, m,
        ['seq', 'sent_at', 'send_location', 'sender_kind', 'sender_identity_id', 'sender_intervener_id', 'origin_unit_id', 'dest_unit_id',
          'transporter_intervener_id', 'tracking_code', 'send_seal_number']), ev);
      return { movimentacaoId: m.id, seq, versao: version };
    })).result);
  }

  private async lockActiveMovement(tx: Tx, movementId: string): Promise<any> {
    const m = (await tx.query(`SELECT * FROM movement WHERE id = $1 FOR UPDATE`, [movementId])).rows[0];
    if (!m) throw notFound();
    return m;
  }

  // ------------------------------------------------------------------ Confirmar recebimento
  async receive(actor: Actor, movementId: string, body: unknown, key?: string) {
    requireCustodyAct(actor);
    const b = parse(ReceiveBody, body);
    return this.run(async (tx) => (await withIdempotency(tx, actor, key, `recebimento:${movementId}`, b, async () => {
      const pre = (await tx.query(`SELECT fav_id FROM movement WHERE id = $1`, [movementId])).rows[0];
      if (!pre) throw notFound();
      const f = await this.access.lockForWrite(tx, actor, pre.fav_id);
      const m = await this.lockActiveMovement(tx, movementId);
      if (m.status !== 'em_transito') throw conflict('RECEBIMENTO_JA_REGISTRADO', `Esta movimentação já está "${m.status}". Nenhum novo fato foi registrado.`);
      if (m.dest_unit_id !== actor.unitId) throw forbidden('DESTINO_DIVERGENTE', 'O recebimento é confirmado por servidor da unidade de destino.');
      const role = requireRole(actor, 'CUSTODIA', 'PERICIA');
      if (m.sender_identity_id === actor.identityId) throw forbidden('RECEBEDOR_IGUAL_REMETENTE', 'Recebedor deve ser distinto do remetente.');
      const received = checkEffectiveAt(b.recebidoEm, 'Data/hora do recebimento');
      assertOrder(m.sent_at, received, 'O recebimento não pode ser anterior ao envio.');
      const late = requireLateReason(received, b.motivoLancamentoPosterior, 'Recebimento');

      // Conferência (itens 12–13): número vigente na FAV × observado.
      const seal = await this.activeSeal(tx, f.id);
      const expected = seal?.number ?? null;
      const observed = b.lacreObservado ? normalizeDocNumber(b.lacreObservado) : null;
      const divergent = (expected ?? null) !== (observed ?? null);
      const physicalIssue = b.situacaoLacre !== 'integro' && !(b.situacaoLacre === 'sem_lacre' && !expected)
        || b.situacaoEmbalagem !== 'integra' || b.correspondenciaSco === 'nao_confere' || divergent;
      if (physicalIssue && !b.observacoes.naoConformidades) {
        throw unprocessable('NAO_CONFORMIDADE_SEM_DESCRICAO',
          'A conferência indica não conformidade (lacre/embalagem/número/SCO). Descreva-a em "Não conformidades".',
          { lacreEsperado: expected, lacreObservado: observed });
      }
      const withIssue = !!b.observacoes.naoConformidades;
      const mStatus = withIssue ? 'recebido_com_ressalva' : 'recebido';
      const fStatus = withIssue ? 'recebido_com_ocorrencia' : 'sob_custodia';
      const ctx = await this.acts.context(tx, actor, role);
      const updated = (await tx.query(
        `UPDATE movement SET status = $2, received_at = $3, receive_location = $4, receiver_identity_id = $5, receiver_snapshot_id = $6,
           receive_registered_at = now(), protocolo = $7, seal_expected = $8, seal_observed = $9, seal_situation = $10,
           packaging_situation = $11, sco_correspondencia = $12, obs_sem_alteracoes = $13, obs_alteracoes = $14,
           obs_nao_conformidades = $15, obs_livre = $16, closed_at = now()
         WHERE id = $1 RETURNING *`,
        [m.id, mStatus, received.toISOString(), b.localEntrega, actor.identityId, ctx.snapshotId, b.protocolo, expected, observed,
          b.situacaoLacre, b.situacaoEmbalagem, b.correspondenciaSco, b.observacoes.semAlteracoes, b.observacoes.alteracoes,
          b.observacoes.naoConformidades, b.observacaoLivre])).rows[0];
      const version = await this.access.bumpVersion(tx, f.id, {
        status: fStatus, custodian_kind: 'servidor', custodian_identity_id: actor.identityId, custodian_intervener_id: null, custodian_unit_id: actor.unitId,
      });
      const ev = await this.acts.event(tx, ctx, {
        favId: f.id, type: withIssue ? 'recebimento_com_ressalva' : 'recebimento_confirmado', favVersion: version, effectiveAt: received,
        statusBefore: 'em_transito', statusAfter: fStatus, movementId: m.id, lateEntryReason: late,
        summary: `Recebimento da movimentação nº ${m.seq} confirmado${withIssue ? ' COM não conformidade' : ''}; custódia transferida`,
        payload: { seq: m.seq, lacreEsperado: expected, lacreObservado: observed, situacaoLacre: b.situacaoLacre, situacaoEmbalagem: b.situacaoEmbalagem, correspondenciaSco: b.correspondenciaSco },
      });
      await this.acts.revisions(tx, ctx, f.id, version, this.acts.creationRevisions('movement', m.id, updated,
        ['received_at', 'receive_location', 'receiver_identity_id', 'protocolo', 'seal_expected', 'seal_observed', 'seal_situation',
          'packaging_situation', 'sco_correspondencia', 'obs_sem_alteracoes', 'obs_alteracoes', 'obs_nao_conformidades', 'obs_livre']), ev);
      return { movimentacaoId: m.id, status: mStatus, versao: version };
    })).result);
  }

  // ------------------------------------------------------------------ Recusa e cancelamento (eventos próprios; originais preservados)
  async refuse(actor: Actor, movementId: string, body: unknown, key?: string) {
    requireCustodyAct(actor);
    const b = parse(RefuseBody, body);
    return this.run(async (tx) => (await withIdempotency(tx, actor, key, `recusa:${movementId}`, b, async () => {
      const pre = (await tx.query(`SELECT fav_id FROM movement WHERE id = $1`, [movementId])).rows[0];
      if (!pre) throw notFound();
      const f = await this.access.lockForWrite(tx, actor, pre.fav_id);
      const m = await this.lockActiveMovement(tx, movementId);
      if (m.status !== 'em_transito') throw conflict('MOVIMENTACAO_ENCERRADA', `Movimentação já está "${m.status}".`);
      if (m.dest_unit_id !== actor.unitId) throw forbidden('DESTINO_DIVERGENTE', 'Somente a unidade de destino pode recusar.');
      const role = requireRole(actor, 'CUSTODIA', 'PERICIA');
      const at = checkEffectiveAt(b.recusadoEm, 'Data/hora da recusa');
      const ctx = await this.acts.context(tx, actor, role);
      await tx.query(`UPDATE movement SET status = 'recusado', refusal_reason = $2, closed_at = now() WHERE id = $1`, [m.id, b.motivo]);
      // O material permanece com o remetente: custódia não muda.
      const version = await this.access.bumpVersion(tx, f.id, { status: 'sob_custodia' });
      const ev = await this.acts.event(tx, ctx, {
        favId: f.id, type: 'recebimento_recusado', favVersion: version, effectiveAt: at, statusBefore: 'em_transito', statusAfter: 'sob_custodia',
        movementId: m.id, summary: `Recebimento da movimentação nº ${m.seq} RECUSADO: ${b.motivo}`, payload: { seq: m.seq },
      });
      await this.acts.revisions(tx, ctx, f.id, version, [
        { entity: 'movement', key: m.id, field: 'status', oldValue: 'em_transito', newValue: 'recusado', action: 'preenchimento' },
        { entity: 'movement', key: m.id, field: 'refusal_reason', oldValue: null, newValue: b.motivo, action: 'preenchimento' },
      ], ev);
      return { movimentacaoId: m.id, status: 'recusado', versao: version };
    })).result);
  }

  async cancel(actor: Actor, movementId: string, body: unknown, key?: string) {
    requireCustodyAct(actor);
    const b = parse(CancelBody, body);
    return this.run(async (tx) => (await withIdempotency(tx, actor, key, `cancelamento:${movementId}`, b, async () => {
      const pre = (await tx.query(`SELECT fav_id FROM movement WHERE id = $1`, [movementId])).rows[0];
      if (!pre) throw notFound();
      const f = await this.access.lockForWrite(tx, actor, pre.fav_id);
      const m = await this.lockActiveMovement(tx, movementId);
      if (m.status !== 'em_transito') throw conflict('MOVIMENTACAO_ENCERRADA', `Movimentação já está "${m.status}".`);
      if (m.send_registered_by !== actor.identityId) throw forbidden('NAO_REMETENTE', 'Somente quem registrou o envio pode cancelá-lo.');
      const ctx = await this.acts.context(tx, actor, null);
      await tx.query(`UPDATE movement SET status = 'cancelado', cancel_reason = $2, closed_at = now() WHERE id = $1`, [m.id, b.motivo]);
      const version = await this.access.bumpVersion(tx, f.id, { status: 'sob_custodia' });
      const ev = await this.acts.event(tx, ctx, {
        favId: f.id, type: 'envio_cancelado', favVersion: version, statusBefore: 'em_transito', statusAfter: 'sob_custodia', movementId: m.id,
        summary: `Envio nº ${m.seq} cancelado antes do recebimento: ${b.motivo}`, payload: { seq: m.seq },
      });
      await this.acts.revisions(tx, ctx, f.id, version, [
        { entity: 'movement', key: m.id, field: 'status', oldValue: 'em_transito', newValue: 'cancelado', action: 'preenchimento' },
        { entity: 'movement', key: m.id, field: 'cancel_reason', oldValue: null, newValue: b.motivo, action: 'preenchimento' },
      ], ev);
      return { movimentacaoId: m.id, status: 'cancelado', versao: version };
    })).result);
  }

  // ------------------------------------------------------------------ Retificação de movimentação (≠ novo ato físico)
  async retifyMovement(actor: Actor, movementId: string, body: unknown) {
    requireCustodyAct(actor);
    const b = parse(z.object({ campo: z.string(), valor: z.unknown(), motivo: txt(1000) }), body);
    const schema = MOVEMENT_RETIFIABLE[b.campo];
    if (!schema) throw badRequest('CAMPO_NAO_RETIFICAVEL', 'Campo não retificável por esta via. Atos físicos novos exigem novo registro.');
    const value = parse(schema, b.valor);
    return this.run(async (tx) => {
      const pre = (await tx.query(`SELECT fav_id FROM movement WHERE id = $1`, [movementId])).rows[0];
      if (!pre) throw notFound();
      const f = await this.access.lockForWrite(tx, actor, pre.fav_id);
      this.access.requireNotClosed(f);
      const m = await this.lockActiveMovement(tx, movementId);
      const involved = [m.send_registered_by, m.receiver_identity_id].includes(actor.identityId);
      if (!involved) throw forbidden('RETIFICACAO_NAO_AUTORIZADA', 'Somente quem registrou o ato pode retificá-lo (regra inicial; ver P-RET-01).');
      if (b.campo === 'received_at' && !m.received_at) throw conflict('ETAPA_INVALIDA', 'Recebimento ainda não registrado.');
      if (b.campo === 'sent_at' || b.campo === 'received_at') checkEffectiveAt(value as string, b.campo);
      const old = m[b.campo];
      if (valuesEqual(old, value)) return { versao: f.version };
      const ctx = await this.acts.context(tx, actor, null);
      const cols: Record<string, string> = { send_location: 'send_location', receive_location: 'receive_location', tracking_code: 'tracking_code', protocolo: 'protocolo', obs_livre: 'obs_livre', sent_at: 'sent_at', received_at: 'received_at' };
      await tx.query(`UPDATE movement SET ${cols[b.campo]} = $2 WHERE id = $1`, [m.id, value]);
      const version = await this.access.bumpVersion(tx, f.id);
      const ev = await this.acts.event(tx, ctx, {
        favId: f.id, type: 'retificacao_registro', favVersion: version, movementId: m.id,
        summary: `Retificação na movimentação nº ${m.seq} (${b.campo}): ${b.motivo}`, payload: { campo: b.campo },
      });
      await this.acts.revisions(tx, ctx, f.id, version, [{ entity: 'movement', key: m.id, field: b.campo, oldValue: old, newValue: value, action: 'retificacao', reason: b.motivo }], ev);
      return { versao: version };
    });
  }

  // ------------------------------------------------------------------ Abertura e relacre (item 14)
  async open(actor: Actor, favId: string, body: unknown, key?: string) {
    requireCustodyAct(actor);
    const b = parse(OpenBody, body);
    return this.run(async (tx) => (await withIdempotency(tx, actor, key, `abertura:${favId}`, b, async () => {
      const f = await this.access.lockForWrite(tx, actor, favId, b.versao);
      this.access.requireNotClosed(f);
      if (f.status === 'em_transito' || f.status === 'rascunho') throw conflict('ETAPA_INVALIDA', 'Abertura exige vestígio sob custódia (fora de trânsito).');
      this.access.requireCustodianUnit(actor, f);
      // Perito que procede à análise ou pessoa autorizada (com referência à autorização).
      const role = requireRole(actor, 'PERICIA', 'CUSTODIA');
      if (role !== 'PERICIA' && !b.autorizacaoRef) throw forbidden('ABERTURA_NAO_AUTORIZADA', 'Fora da perícia, a abertura exige referência à autorização.');
      if (f.physical_state === 'aberto') throw conflict('RECIPIENTE_ABERTO', 'Já existe abertura sem novo lacre.');
      const seal = await this.activeSeal(tx, f.id);
      if (!seal) throw conflict('SEM_LACRE_VIGENTE', 'Não há lacre vigente a romper.');
      const opened = checkEffectiveAt(b.abertoEm, 'Data/hora da abertura');
      const late = requireLateReason(opened, b.motivoLancamentoPosterior, 'Abertura');
      const ctx = await this.acts.context(tx, actor, role);
      await tx.query(`UPDATE seal SET status = 'rompido', broken_at = $2 WHERE id = $1`, [seal.id, opened.toISOString()]);
      const o = (await tx.query(
        `INSERT INTO seal_opening (fav_id, previous_seal_id, motivo, finalidade, opened_at, location, responsible_identity_id, responsible_snapshot_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [f.id, seal.id, b.motivo, b.finalidade, opened.toISOString(), b.local, actor.identityId, ctx.snapshotId])).rows[0];
      let version = await this.access.bumpVersion(tx, f.id, { physical_state: 'aberto', status: 'em_processamento' });
      const ev = await this.acts.event(tx, ctx, {
        favId: f.id, type: 'abertura_registrada', favVersion: version, effectiveAt: opened, statusBefore: f.status, statusAfter: 'em_processamento',
        lateEntryReason: late, summary: `Abertura do lacre ${seal.number}: ${b.motivo}`,
        payload: { lacreAnterior: seal.number, autorizacaoRef: b.autorizacaoRef ?? null },
      });
      await this.acts.revisions(tx, ctx, f.id, version, [
        ...this.acts.creationRevisions('seal_opening', o.id, o, ['motivo', 'finalidade', 'opened_at', 'location', 'responsible_identity_id']),
        { entity: 'seal', key: seal.id, field: 'status', oldValue: 'ativo', newValue: 'rompido', action: 'automatico', origin: 'automatico', sourceRef: 'ato:abertura' },
      ], ev);
      let novo = null;
      if (b.fechamento) {
        const r = await this.closeOpening(tx, actor, ctx, f, o, seal, b.fechamento);
        version = r.version; novo = r.numero;
      }
      return { aberturaId: o.id, novoLacre: novo, versao: version };
    })).result);
  }

  async reseal(actor: Actor, favId: string, body: unknown, key?: string) {
    requireCustodyAct(actor);
    const b = parse(ResealBody, body);
    return this.run(async (tx) => (await withIdempotency(tx, actor, key, `relacre:${favId}`, b, async () => {
      const f = await this.access.lockForWrite(tx, actor, favId, b.versao);
      this.access.requireCustodianUnit(actor, f);
      const role = requireRole(actor, 'PERICIA', 'CUSTODIA');
      const o = (await tx.query(`SELECT * FROM seal_opening WHERE fav_id = $1 AND status = 'aberto' FOR UPDATE`, [f.id])).rows[0];
      if (!o) throw conflict('SEM_ABERTURA', 'Não há abertura pendente de novo lacre.');
      const prev = (await tx.query(`SELECT id, number, ordinal FROM seal WHERE id = $1`, [o.previous_seal_id])).rows[0];
      const ctx = await this.acts.context(tx, actor, role);
      const r = await this.closeOpening(tx, actor, ctx, f, o, prev, b);
      return { aberturaId: o.id, novoLacre: r.numero, versao: r.version };
    })).result);
  }

  private async closeOpening(tx: Tx, actor: Actor, ctx: Awaited<ReturnType<ActWriter['context']>>, f: FavRow, o: any, prev: { id: string; number: string; ordinal: number },
    c: { novoLacre: string; fechadoEm: string; lacreRompidoAcondicionado: true; referenciaSco: string | null }) {
    const number = normalizeDocNumber(c.novoLacre);
    const closed = checkEffectiveAt(c.fechadoEm, 'Data/hora do novo lacre');
    assertOrder(o.opened_at, closed, 'O novo lacre não pode ser anterior à abertura.');
    const used = await tx.query(`SELECT 1 FROM seal WHERE fav_id = $1 AND number = $2`, [f.id, number]);
    if (used.rowCount) throw unprocessable('LACRE_REUTILIZADO', 'Número de lacre já utilizado nesta FAV.');
    const maxOrd = (await tx.query(`SELECT max(ordinal) AS m FROM seal WHERE fav_id = $1`, [f.id])).rows[0].m as number;
    const s = (await tx.query(
      `INSERT INTO seal (fav_id, ordinal, number, applied_at, applied_by_identity_id, applied_location, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$5) RETURNING *`, [f.id, maxOrd + 1, number, closed.toISOString(), actor.identityId, o.location])).rows[0];
    await tx.query(`UPDATE seal_opening SET status = 'fechado', closed_at = $2, new_seal_id = $3, broken_seal_packaged = true, sco_observacao_ref = $4 WHERE id = $1`,
      [o.id, closed.toISOString(), s.id, c.referenciaSco]);
    const version = await this.access.bumpVersion(tx, f.id, { physical_state: 'lacrado' });
    const ev = await this.acts.event(tx, ctx, {
      favId: f.id, type: 'novo_lacre_registrado', favVersion: version, effectiveAt: closed,
      summary: `Novo lacre ${number} (${s.ordinal}º) aplicado; lacre ${prev.number} acondicionado na nova embalagem`,
      payload: { lacreAnterior: prev.number, novoLacre: number, ordinal: s.ordinal, referenciaSco: c.referenciaSco },
    });
    await this.acts.revisions(tx, ctx, f.id, version, [
      ...this.acts.creationRevisions('seal', s.id, s, ['ordinal', 'number', 'applied_at', 'applied_by_identity_id']),
      { entity: 'seal_opening', key: o.id, field: 'new_seal_id', oldValue: null, newValue: s.id, action: 'preenchimento' },
      { entity: 'seal_opening', key: o.id, field: 'broken_seal_packaged', oldValue: null, newValue: true, action: 'preenchimento' },
      ...(c.referenciaSco ? [{ entity: 'seal_opening', key: o.id, field: 'sco_observacao_ref', oldValue: null, newValue: c.referenciaSco, action: 'preenchimento' as const }] : []),
    ], ev);
    return { version, numero: number };
  }

  // ------------------------------------------------------------------ Central / armazenamento / acesso físico
  async storage(actor: Actor, favId: string, body: unknown, key?: string) {
    requireCustodyAct(actor);
    const b = parse(StorageBody, body);
    return this.run(async (tx) => (await withIdempotency(tx, actor, key, `armazenamento:${favId}`, b, async () => {
      const f = await this.access.lockForWrite(tx, actor, favId);
      this.access.requireNotClosed(f);
      if (f.status === 'em_transito' || f.status === 'rascunho') throw conflict('ETAPA_INVALIDA', 'Registro de armazenamento exige vestígio sob custódia.');
      this.access.requireCustodianUnit(actor, f);
      const role = requireRole(actor, 'CUSTODIA');
      if (b.tipo === 'entrada' && !b.localGuarda) throw unprocessable('LOCAL_OBRIGATORIO', 'Informe o local de guarda.');
      if ((b.tipo === 'entrada' || b.tipo === 'saida') && !b.protocolo) throw unprocessable('PROTOCOLO_OBRIGATORIO', 'Entradas e saídas exigem protocolo.');
      if (b.tipo === 'deposito_alternativo' && !b.documentoDecisao) throw unprocessable('DOCUMENTO_OBRIGATORIO', 'Depósito alternativo exige documento de decisão.');
      if (b.tipo === 'entrada' && f.physical_state === 'aberto') throw conflict('RECIPIENTE_ABERTO', 'Regularize o lacre antes da entrada na central.');
      if (b.pessoa.tipo === 'externo') {
        const iv = await tx.query(`SELECT 1 FROM intervener WHERE id = $1 AND fav_id = $2`, [b.pessoa.intervenienteId, f.id]);
        if (!iv.rowCount) throw unprocessable('REFERENCIA_INVALIDA', 'Interveniente não registrado nesta FAV.');
      } else {
        const p = await tx.query(`SELECT 1 FROM identity WHERE id = $1 AND status = 'active'`, [b.pessoa.identidadeId]);
        if (!p.rowCount) throw unprocessable('REFERENCIA_INVALIDA', 'Servidor inexistente ou inativo.');
      }
      const at = checkEffectiveAt(b.ocorridoEm, 'Data/hora');
      const ctx = await this.acts.context(tx, actor, role);
      const se = (await tx.query(
        `INSERT INTO storage_event (fav_id, kind, protocolo, ocorrencia_ref, local_guarda, person_kind, person_identity_id, person_intervener_id,
           effective_at, finalidade, decision_doc, unit_id, registered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [f.id, b.tipo, b.protocolo, b.referenciaOcorrencia, b.localGuarda, b.pessoa.tipo,
          b.pessoa.tipo === 'servidor' ? b.pessoa.identidadeId : null, b.pessoa.tipo === 'externo' ? b.pessoa.intervenienteId : null,
          at.toISOString(), b.finalidade, b.documentoDecisao, actor.unitId, actor.identityId])).rows[0];
      const statusAfter = b.tipo === 'entrada' || b.tipo === 'guarda_contrapericia' || b.tipo === 'deposito_alternativo' || b.tipo === 'devolucao_pos_pericia'
        ? 'armazenado' : b.tipo === 'saida' ? 'sob_custodia' : f.status;
      const version = await this.access.bumpVersion(tx, f.id, statusAfter !== f.status ? { status: statusAfter } : {});
      const labels: Record<string, string> = { entrada: 'Entrada na central', saida: 'Saída da central', acesso_fisico: 'Acesso físico ao material', guarda_contrapericia: 'Guarda para contraperícia', deposito_alternativo: 'Depósito alternativo', devolucao_pos_pericia: 'Devolução à central após perícia' };
      const ev = await this.acts.event(tx, ctx, {
        favId: f.id, type: `armazenamento_${b.tipo}`, favVersion: version, effectiveAt: at, statusBefore: f.status, statusAfter,
        summary: `${labels[b.tipo]}${b.protocolo ? ` (protocolo ${b.protocolo})` : ''}`, payload: { armazenamentoId: se.id, tipo: b.tipo },
      });
      await this.acts.revisions(tx, ctx, f.id, version, this.acts.creationRevisions('storage_event', se.id, se,
        ['kind', 'protocolo', 'ocorrencia_ref', 'local_guarda', 'person_kind', 'person_identity_id', 'person_intervener_id', 'effective_at', 'finalidade', 'decision_doc']), ev);
      return { armazenamentoId: se.id, versao: version };
    })).result);
  }

  // ------------------------------------------------------------------ Amostragem (item 8)
  async derive(actor: Actor, provaId: string, body: unknown, key?: string) {
    requireCustodyAct(actor);
    const b = parse(DeriveBody, body);
    return this.run(async (tx) => (await withIdempotency(tx, actor, key, `amostra:${provaId}`, b, async () => {
      const prova = await this.access.lockForWrite(tx, actor, provaId);
      this.access.requireNotClosed(prova);
      this.access.requireCustodianUnit(actor, prova);
      const role = requireRole(actor, 'PERICIA');
      if (prova.amostragem_classe && prova.amostragem_classe !== 'prova') throw unprocessable('CLASSE_INCOMPATIVEL', 'Somente a FAV da prova pode originar contraprova/alíquota/contraperícia.');
      const ctx = await this.acts.context(tx, actor, role);
      let derivadaId: string;
      let derivadaNumero: string | null;
      if (b.nova) {
        const at = checkEffectiveAt(b.nova.coletadoEm, 'Data/hora da derivação');
        const unit = (await tx.query(`SELECT code FROM unit WHERE id = $1`, [actor.unitId])).rows[0];
        const lacre = normalizeDocNumber(b.nova.primeiroLacre);
        const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric' }).format(at));
        derivadaNumero = `${lacre}/${year}/${unit.code}`;
        const d = (await tx.query(
          `INSERT INTO fav (kind, numero, numero_year, origin_unit_id, status, physical_state, custodian_kind, custodian_identity_id, custodian_unit_id,
             coleta_confirmed_at, coleta_responsavel_kind, coleta_responsavel_identity_id, coleta_data_hora, coleta_endereco, vestigio_tipo,
             vestigio_descricao, preservacao_mesmo_coletor, natureza_exame, requisicao, procedimento, unidade_pj_id, amostragem_classe, created_by)
           VALUES ('regular',$1,$2,$3,'sob_custodia','lacrado','servidor',$4,$3, now(),'servidor',$4,$5,$6,$7,$8,true,$9,$10,$11,$12,$13,$4) RETURNING *`,
          [derivadaNumero, year, actor.unitId, actor.identityId, at.toISOString(), b.nova.local, b.nova.tipo, b.nova.descricao,
            prova.natureza_exame, prova.requisicao, prova.procedimento, prova.unidade_pj_id, b.relacao])).rows[0];
        await tx.query(`INSERT INTO seal (fav_id, ordinal, number, applied_at, applied_by_identity_id, applied_location, created_by) VALUES ($1,1,$2,$3,$4,$5,$4)`,
          [d.id, lacre, at.toISOString(), actor.identityId, b.nova.local]);
        derivadaId = d.id;
        const evd = await this.acts.event(tx, ctx, {
          favId: d.id, type: 'fav_derivada_aberta', favVersion: d.version, effectiveAt: at, statusAfter: 'sob_custodia',
          summary: `FAV de ${b.relacao} aberta a partir da prova ${prova.numero}: ${b.atoDerivacao}`, payload: { provaFavId: prova.id, relacao: b.relacao },
        });
        await this.acts.revisions(tx, ctx, d.id, d.version, this.acts.creationRevisions('fav', d.id, d,
          ['kind', 'numero', 'coleta_responsavel_identity_id', 'coleta_data_hora', 'coleta_endereco', 'vestigio_tipo', 'vestigio_descricao', 'amostragem_classe']), evd);
      } else {
        const d = (await tx.query(`SELECT * FROM fav WHERE id = $1 FOR UPDATE`, [b.favExistenteId])).rows[0];
        if (!d) throw notFound();
        if (d.id === prova.id) throw unprocessable('VINCULO_PROPRIO', 'Uma FAV não pode ser vinculada a si mesma.');
        if (d.custodian_unit_id !== actor.unitId) throw forbidden('FORA_DA_CUSTODIA', 'A FAV derivada deve estar sob custódia da unidade selecionada.');
        // Impede ciclos: a prova não pode descender da derivada.
        const cyc = await tx.query(
          `WITH RECURSIVE anc(id) AS (SELECT prova_fav_id FROM sample_link WHERE derivada_fav_id = $1
             UNION SELECT l.prova_fav_id FROM sample_link l JOIN anc ON l.derivada_fav_id = anc.id)
           SELECT 1 FROM anc WHERE id = $2`, [prova.id, d.id]);
        if (cyc.rowCount) throw unprocessable('VINCULO_CIRCULAR', 'Vínculo circular entre FAVs de amostragem.');
        derivadaId = d.id;
        derivadaNumero = d.numero;
        if (d.amostragem_classe !== b.relacao) {
          await tx.query(`UPDATE fav SET amostragem_classe = $2, version = version + 1, updated_at = now() WHERE id = $1`, [d.id, b.relacao]);
          await this.acts.revisions(tx, ctx, d.id, d.version + 1, [{ entity: 'fav', key: d.id, field: 'amostragem_classe', oldValue: d.amostragem_classe, newValue: b.relacao, action: d.amostragem_classe ? 'retificacao' : 'preenchimento', reason: d.amostragem_classe ? `Vínculo de amostragem: ${b.atoDerivacao}` : null }], null);
        }
      }
      const link = (await tx.query(
        `INSERT INTO sample_link (prova_fav_id, derivada_fav_id, relation, derivation_act, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [prova.id, derivadaId, b.relacao, b.atoDerivacao, actor.identityId])).rows[0];
      const sets: Record<string, unknown> = prova.amostragem_classe ? {} : { amostragem_classe: 'prova' };
      const version = await this.access.bumpVersion(tx, prova.id, sets);
      const ev = await this.acts.event(tx, ctx, {
        favId: prova.id, type: 'amostra_vinculada', favVersion: version,
        summary: `Vínculo recíproco com FAV de ${b.relacao} ${derivadaNumero ?? ''}: ${b.atoDerivacao}`, payload: { derivadaFavId: derivadaId, relacao: b.relacao, vinculoId: link.id },
      });
      const revs: RevisionInput[] = [{ entity: 'sample_link', key: link.id, field: 'derivada_fav_id', oldValue: null, newValue: derivadaId, action: 'preenchimento' }];
      if (!prova.amostragem_classe) revs.push({ entity: 'fav', key: prova.id, field: 'amostragem_classe', oldValue: null, newValue: 'prova', action: 'automatico', origin: 'automatico', sourceRef: 'ato:vincular_amostra' });
      await this.acts.revisions(tx, ctx, prova.id, version, revs, ev);
      return { vinculoId: link.id, derivadaFavId: derivadaId, derivadaNumero, versao: version };
    })).result);
  }

  // ------------------------------------------------------------------ Consumo parcial (mantém custódia)
  async partialConsumption(actor: Actor, favId: string, body: unknown, key?: string) {
    requireCustodyAct(actor);
    const b = parse(PartialBody, body);
    return this.run(async (tx) => (await withIdempotency(tx, actor, key, `consumo_parcial:${favId}`, b, async () => {
      const f = await this.access.lockForWrite(tx, actor, favId);
      this.access.requireNotClosed(f);
      this.access.requireCustodianUnit(actor, f);
      const role = requireRole(actor, 'PERICIA');
      const at = checkEffectiveAt(b.ocorridoEm, 'Data/hora');
      const ctx = await this.acts.context(tx, actor, role);
      const version = await this.access.bumpVersion(tx, f.id);
      await this.acts.event(tx, ctx, {
        favId: f.id, type: 'consumo_parcial', favVersion: version, effectiveAt: at,
        summary: `Consumo parcial em exame (laudo ${b.laudo}); remanescente permanece sob custódia: ${b.descricao}`, payload: { laudo: b.laudo },
      });
      return { versao: version };
    })).result);
  }

  // ------------------------------------------------------------------ Registrar destinação (encerramento na SEPOL)
  async close(actor: Actor, favId: string, body: unknown, key?: string) {
    requireCustodyAct(actor);
    const b = parse(CloseBody, body);
    return this.run(async (tx) => (await withIdempotency(tx, actor, key, `encerramento:${favId}`, b, async () => {
      const f = await this.access.lockForWrite(tx, actor, favId, b.versao);
      this.access.requireNotClosed(f);
      if (f.status === 'em_transito' || f.status === 'rascunho') throw conflict('ETAPA_INVALIDA', 'Encerramento exige vestígio sob custódia.');
      this.access.requireCustodianUnit(actor, f);
      const role = requireRole(actor, 'ENCERRAMENTO');
      let documento = b.documentoNumero;
      if (b.tipo === 'analise_destrutiva') {
        // Item 17: o laudo é o documento que registra o encerramento.
        if (!f.laudo_numero) throw unprocessable('LAUDO_OBRIGATORIO', 'Análise destrutiva: registre o nº do laudo (campo pericial) antes de encerrar.');
        if (documento && documento !== f.laudo_numero) throw unprocessable('DOCUMENTO_DIVERGENTE', 'Na análise destrutiva o documento de encerramento é o laudo.');
        documento = f.laudo_numero;
      } else {
        if (f.physical_state === 'aberto') throw conflict('RECIPIENTE_ABERTO', 'Regularize o lacre antes da destinação.');
        if (!documento) throw unprocessable('DOCUMENTO_OBRIGATORIO', 'Informe o nº do documento que registra o encerramento.');
      }
      if (b.tipo === 'outro' && !b.outroDescricao) throw unprocessable('MOTIVO_OBRIGATORIO', '"Outro" exige descrição motivada.');
      if ((b.tipo === 'destruicao' || b.tipo === 'devolucao_proprietario') && !b.autorizacaoJudicialRef) {
        throw unprocessable('AUTORIZACAO_JUDICIAL_OBRIGATORIA', 'Destruição e devolução ao proprietário exigem referência à autorização judicial (item 18).');
      }
      if ((b.tipo === 'transferencia_externa' || b.tipo === 'devolucao_proprietario') && !b.destinatario) {
        throw unprocessable('DESTINATARIO_OBRIGATORIO', 'Informe o destinatário/órgão externo.');
      }
      const at = checkEffectiveAt(b.ocorridoEm, 'Data/hora do encerramento');
      const late = requireLateReason(at, b.motivoLancamentoPosterior, 'Encerramento');
      const ctx = await this.acts.context(tx, actor, role);
      const c = (await tx.query(
        `INSERT INTO closure (fav_id, tipo, outro_descricao, documento_numero, autorizacao_judicial_ref, effective_at, location, destinatario,
           responsible_identity_id, responsible_snapshot_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [f.id, b.tipo, b.outroDescricao, documento, b.autorizacaoJudicialRef, at.toISOString(), b.local, b.destinatario, actor.identityId, ctx.snapshotId])).rows[0];
      const sets: Record<string, unknown> = { status: 'encerrado', guarda_unidade_id: f.guarda_unidade_id ?? actor.unitId };
      if (b.tipo === 'analise_destrutiva') sets.physical_state = 'consumido_total';
      const version = await this.access.bumpVersion(tx, f.id, sets);
      const ev = await this.acts.event(tx, ctx, {
        favId: f.id, type: 'encerramento_registrado', favVersion: version, effectiveAt: at, statusBefore: f.status, statusAfter: 'encerrado',
        lateEntryReason: late, summary: `Cadeia de custódia encerrada na SEPOL: ${b.tipo.replace(/_/g, ' ')} (doc. ${documento})`,
        payload: { tipo: b.tipo, documento },
      });
      const revs = this.acts.creationRevisions('closure', f.id, c,
        ['tipo', 'outro_descricao', 'documento_numero', 'autorizacao_judicial_ref', 'effective_at', 'location', 'destinatario', 'responsible_identity_id']);
      if (!f.guarda_unidade_id) revs.push({ entity: 'fav', key: f.id, field: 'guarda_unidade_id', oldValue: null, newValue: actor.unitId, action: 'automatico', origin: 'automatico', sourceRef: 'regra:item_20_ultimo_orgao_responsavel' });
      await this.acts.revisions(tx, ctx, f.id, version, revs, ev);
      return { versao: version, documento };
    })).result);
  }
}
