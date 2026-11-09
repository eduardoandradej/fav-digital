import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Database, type Tx } from '../db/database.js';
import { ActWriter, type RevisionInput, revisionAction, valuesEqual, withIdempotency } from '../common/acts.js';
import { badRequest, conflict, forbidden, mapPgError, unprocessable } from '../common/errors.js';
import { parse } from '../common/validation.js';
import { checkEffectiveAt } from '../common/time.js';
import { requireFiller, requireRole } from '../authz/policy.js';
import type { Actor, Role } from '../authz/roles.js';
import { AuditService } from '../audit/audit.service.js';
import { FAV_FIELDS, PRIMEIRO_LACRE } from './fields.js';
import { FavAccess, type FavRow } from './fav.access.js';

const CreateBody = z.object({
  tipo: z.enum(['regular', 'grande_porte']),
  campos: z.record(z.string(), z.unknown()).optional(),
});

const PatchBody = z.object({
  versao: z.number().int().positive(),
  campos: z.record(z.string(), z.unknown()),
  motivo: z.string().trim().min(5).max(1000).optional(),
});

const IntervenerBody = z.object({
  papel: z.enum(['coletor', 'preservador', 'transportador', 'entregador', 'destinatario', 'acesso_fisico', 'outro']),
  nome: z.string().trim().min(3).max(200),
  tipoDocumento: z.string().trim().min(2).max(40),
  numeroDocumento: z.string().trim().min(2).max(60),
  orgao: z.string().trim().max(200).optional(),
  fonteComprobatoria: z.string().trim().min(3).max(500),
  comprovacao: z.enum(['pendente', 'apresentada']),
});

/** Normalização de números documentais: texto, sem espaços externos, maiúsculas; zeros preservados. */
export function normalizeDocNumber(v: string): string {
  return v.trim().toUpperCase().replace(/\s+/g, '');
}

/** Ano no fuso de apresentação America/Sao_Paulo. */
function yearInSaoPaulo(iso: string): number {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric' }).format(new Date(iso)));
}

@Injectable()
export class FavService {
  constructor(
    private readonly db: Database,
    private readonly access: FavAccess,
    private readonly acts: ActWriter,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ abertura
  async create(actor: Actor, body: unknown): Promise<{ id: string }> {
    requireFiller(actor);
    const role = requireRole(actor, 'ORIGEM_COLETA', 'REGISTRO_UNIDADE');
    const b = parse(CreateBody, body);
    try {
      return await this.db.tx(async (tx) => {
        const ctx = await this.acts.context(tx, actor, role);
        const r = await tx.query<FavRow>(
          `INSERT INTO fav (kind, origin_unit_id, created_by, physical_state)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [b.tipo, actor.unitId, actor.identityId, b.tipo === 'grande_porte' ? 'sem_lacre_grande_porte' : 'lacrado']);
        const f = r.rows[0];
        const ev = await this.acts.event(tx, ctx, {
          favId: f.id, type: 'fav_aberta', favVersion: f.version, summary: `FAV ${b.tipo === 'grande_porte' ? 'de grande porte ' : ''}aberta em rascunho (${f.draft_code})`,
          statusAfter: 'rascunho', payload: { tipo: b.tipo },
        });
        await this.acts.revisions(tx, ctx, f.id, f.version, [
          { entity: 'fav', key: f.id, field: 'kind', oldValue: null, newValue: b.tipo, action: 'preenchimento' },
          { entity: 'fav', key: f.id, field: 'origin_unit_id', oldValue: null, newValue: actor.unitId, action: 'automatico', origin: 'automatico', sourceRef: 'contexto_de_unidade_da_sessao' },
        ], ev);
        if (b.campos && Object.keys(b.campos).length) await this.applyFields(tx, actor, f, b.campos, undefined, role);
        return { id: f.id };
      });
    } catch (e) { mapPgError(e); }
  }

  // ------------------------------------------------------------------ preenchimento progressivo / retificação
  async patch(actor: Actor, favId: string, body: unknown): Promise<{ versao: number }> {
    requireFiller(actor);
    const b = parse(PatchBody, body);
    try {
      return await this.db.tx(async (tx) => {
        const f = await this.access.lockForWrite(tx, actor, favId, b.versao);
        const versao = await this.applyFields(tx, actor, f, b.campos, b.motivo, null);
        return { versao };
      });
    } catch (e) { mapPgError(e); }
  }

  private async applyFields(tx: Tx, actor: Actor, f: FavRow, campos: Record<string, unknown>, motivo: string | undefined, roleHint: Role | null): Promise<number> {
    const isDraft = f.status === 'rascunho';
    const changes: Record<string, unknown> = {};
    const revs: RevisionInput[] = [];
    let usedRole: Role | null = roleHint;
    let sealChange: { old: string | null; next: string | null } | null = null;

    for (const [name, raw] of Object.entries(campos)) {
      if (name === PRIMEIRO_LACRE) {
        if (f.kind === 'regular' || raw !== null) {
          const v = raw === null ? null : z.string().trim().min(1).max(60).parse(raw);
          const next = v === null ? null : normalizeDocNumber(v);
          const cur = await tx.query<{ number: string }>(`SELECT number FROM seal WHERE fav_id = $1 AND ordinal = 1 AND status <> 'substituido_rascunho'`, [f.id]);
          if ((cur.rows[0]?.number ?? null) !== next) sealChange = { old: cur.rows[0]?.number ?? null, next };
        }
        if (f.status === 'encerrado') throw conflict('FICHA_ENCERRADA', 'Ficha encerrada.');
        usedRole = usedRole ?? this.roleFor(actor, ['ORIGEM_COLETA', 'REGISTRO_UNIDADE'], 'coleta', f);
        continue;
      }
      const def = FAV_FIELDS[name];
      if (!def) throw badRequest('CAMPO_DESCONHECIDO', `Campo não pertence ao modelo vigente: ${name}`);
      const r = def.schema.safeParse(raw);
      if (!r.success) throw badRequest('DADOS_INVALIDOS', `Valor inválido para "${def.label}".`, r.error.issues);
      let value = r.data as unknown;
      if (typeof value === 'string' && (name === 'requisicao' || name === 'procedimento')) value = normalizeDocNumber(value);
      if (Array.isArray(value)) value = [...new Set(value)].sort();
      if (name === 'coleta_data_hora' && value) checkEffectiveAt(value as string, def.label);

      // Escopo por seção e estado.
      if (f.status === 'encerrado' && def.section !== 'guarda') {
        throw conflict('FICHA_ENCERRADA', 'Após o encerramento, apenas a guarda documental pode ser complementada. Retificações exigem regra própria (pendência P-ENC-02).');
      }
      if (def.section === 'pericia') {
        if (isDraft) throw conflict('ETAPA_INVALIDA', 'Campos periciais só podem ser preenchidos após a confirmação da coleta.');
        this.access.requireCustodianUnit(actor, f);
      }
      usedRole = usedRole && def.roles.includes(usedRole) ? usedRole : this.roleFor(actor, def.roles, def.section, f);
      if (def.ref) await this.checkRef(tx, def.ref, value as string | null, f.id);

      const old = f[name] ?? null;
      if (valuesEqual(old, value)) continue;
      const action = revisionAction(old, value, isDraft);
      revs.push({ entity: 'fav', key: f.id, field: name, oldValue: old, newValue: value, action, reason: motivo ?? null });
      changes[name] = value;
      f[name] = value;
    }

    // Coerência dos responsáveis (tipo ↔ referência).
    for (const p of ['coleta_responsavel', 'preservacao'] as const) {
      const kind = f[`${p}_kind`];
      if (kind === 'servidor' && f[`${p}_intervener_id`]) { changes[`${p}_intervener_id`] = null; revs.push(this.autoClear(f, `${p}_intervener_id`)); f[`${p}_intervener_id`] = null; }
      if (kind === 'externo' && f[`${p}_identity_id`]) { changes[`${p}_identity_id`] = null; revs.push(this.autoClear(f, `${p}_identity_id`)); f[`${p}_identity_id`] = null; }
    }
    if (f.preservacao_mesmo_coletor === true && (f.preservacao_kind || f.preservacao_identity_id || f.preservacao_intervener_id)) {
      for (const c of ['preservacao_kind', 'preservacao_identity_id', 'preservacao_intervener_id']) {
        if (f[c] !== null) { revs.push(this.autoClear(f, c)); changes[c] = null; f[c] = null; }
      }
    }
    if (f.status !== 'rascunho' && f.coleta_responsavel_kind) {
      const ok = (f.coleta_responsavel_kind === 'servidor' && f.coleta_responsavel_identity_id) || (f.coleta_responsavel_kind === 'externo' && f.coleta_responsavel_intervener_id);
      if (!ok) throw unprocessable('RESPONSAVEL_INCOMPLETO', 'Informe o responsável pela coleta correspondente ao tipo selecionado.');
    }

    if (!revs.length && !sealChange) return f.version;
    if ((revs.some((r) => r.action === 'retificacao') || (sealChange && !isDraft)) && !motivo) {
      throw badRequest('MOTIVO_OBRIGATORIO', 'Este registro já foi confirmado: a alteração é uma retificação e exige motivo.');
    }

    const ctx = await this.acts.context(tx, actor, usedRole);
    const version = await this.access.bumpVersion(tx, f.id, this.pick(changes));
    f.version = version;

    if (sealChange) revs.push(...(await this.applyFirstSeal(tx, actor, f, sealChange.next, isDraft, motivo)));
    // Número documental derivado: recalculado por regra automática se a origem for retificada.
    if (!isDraft) revs.push(...(await this.recomputeNumero(tx, f)));

    const retif = revs.some((r) => r.action === 'retificacao');
    const ev = await this.acts.event(tx, ctx, {
      favId: f.id, type: retif ? 'retificacao_registro' : 'complementacao_registro', favVersion: version,
      summary: retif ? `Retificação de ${revs.filter((r) => r.action === 'retificacao').length} campo(s): ${motivo}` : `Preenchimento/alteração de ${revs.length} campo(s)`,
      payload: { campos: [...new Set(revs.map((r) => r.field))] },
    });
    await this.acts.revisions(tx, ctx, f.id, version, revs, ev);
    return version;
  }

  private autoClear(f: FavRow, field: string): RevisionInput {
    return { entity: 'fav', key: f.id, field, oldValue: f[field], newValue: null, action: 'automatico', origin: 'automatico', sourceRef: 'coerencia_tipo_responsavel' };
  }

  private pick(changes: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(changes)) if (k in FAV_FIELDS) out[k] = v;
    return out;
  }

  private roleFor(actor: Actor, roles: Role[], section: string, f: FavRow): Role {
    const unitOk = actor.unitId === f.origin_unit_id || actor.unitId === f.custodian_unit_id;
    if (!unitOk) throw forbidden('FORA_DO_ESCOPO', 'A unidade selecionada não pode preencher esta ficha (nem origem nem custódia).');
    try { return requireRole(actor, ...roles); }
    catch { throw forbidden('PAPEL_INSUFICIENTE', `Seção "${section}" exige papel: ${roles.join(' ou ')}.`); }
  }

  private async checkRef(tx: Tx, ref: 'identity' | 'intervener' | 'unit', id: string | null, favId: string): Promise<void> {
    if (!id) return;
    const sql = {
      identity: `SELECT 1 FROM identity WHERE id = $1 AND status = 'active'`,
      intervener: `SELECT 1 FROM intervener WHERE id = $1 AND fav_id = $2`,
      unit: `SELECT 1 FROM unit WHERE id = $1 AND active`,
    }[ref];
    const r = await tx.query(sql, ref === 'intervener' ? [id, favId] : [id]);
    if (!r.rowCount) throw unprocessable('REFERENCIA_INVALIDA', `Referência inexistente ou inativa (${ref}).`);
  }

  private async applyFirstSeal(tx: Tx, actor: Actor, f: FavRow, next: string | null, isDraft: boolean, motivo?: string): Promise<RevisionInput[]> {
    const cur = await tx.query<{ id: string; number: string; status: string }>(`SELECT id, number, status FROM seal WHERE fav_id = $1 AND ordinal = 1`, [f.id]);
    const s = cur.rows[0];
    if (!s && next === null) return [];
    if (s && s.number === next) return [];
    if (!s) {
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO seal (fav_id, ordinal, number, created_by, identificador_grande_porte) VALUES ($1, 1, $2, $3, $4) RETURNING id`,
        [f.id, next, actor.identityId, f.kind === 'grande_porte']);
      return [{ entity: 'seal', key: ins.rows[0].id, field: 'number', oldValue: null, newValue: next, action: 'preenchimento' }];
    }
    if (next === null) {
      if (!isDraft) throw unprocessable('LACRE_OBRIGATORIO', 'O 1º lacre não pode ser removido após a confirmação da coleta.');
      await tx.query(`UPDATE seal SET status = 'substituido_rascunho' WHERE id = $1`, [s.id]);
      return [{ entity: 'seal', key: s.id, field: 'number', oldValue: s.number, newValue: null, action: 'remocao' }];
    }
    if (!isDraft && s.status !== 'ativo') throw conflict('LACRE_JA_ROMPIDO', 'O 1º lacre já foi rompido; registre o fato em nova abertura/relacre, não por retificação.');
    await tx.query(`UPDATE seal SET number = $2, status = CASE WHEN status = 'substituido_rascunho' THEN 'ativo' ELSE status END WHERE id = $1`, [s.id, next]);
    return [{ entity: 'seal', key: s.id, field: 'number', oldValue: s.number, newValue: next, action: isDraft ? 'alteracao' : 'retificacao', reason: motivo ?? null }];
  }

  private async computeNumero(tx: Tx, f: FavRow): Promise<{ numero: string; year: number | null }> {
    if (f.kind === 'grande_porte') {
      if (!f.requisicao) throw unprocessable('REQUISICAO_OBRIGATORIA', 'Vestígio de grande porte: o nº da FAV é o nº da requisição (Anexo, item 5).');
      return { numero: f.requisicao, year: null };
    }
    const seal = await tx.query<{ number: string }>(`SELECT number FROM seal WHERE fav_id = $1 AND ordinal = 1 AND status <> 'substituido_rascunho'`, [f.id]);
    if (!seal.rows[0]) throw unprocessable('LACRE_OBRIGATORIO', 'Informe o nº do 1º lacre: ele compõe o nº da FAV (1º lacre/ano/unidade).');
    if (!f.coleta_data_hora) throw unprocessable('DATA_COLETA_OBRIGATORIA', 'Informe a data/hora da coleta.');
    const unit = await tx.query<{ code: string }>(`SELECT code FROM unit WHERE id = $1`, [f.origin_unit_id]);
    const year = yearInSaoPaulo(f.coleta_data_hora);
    return { numero: `${seal.rows[0].number}/${year}/${unit.rows[0].code}`, year };
  }

  private async recomputeNumero(tx: Tx, f: FavRow): Promise<RevisionInput[]> {
    const { numero, year } = await this.computeNumero(tx, f);
    if (numero === f.numero) return [];
    await this.assertNumeroFree(tx, f, numero);
    await tx.query(`UPDATE fav SET numero = $2, numero_year = $3 WHERE id = $1`, [f.id, numero, year]);
    const rev: RevisionInput = { entity: 'fav', key: f.id, field: 'numero', oldValue: f.numero, newValue: numero, action: 'automatico', origin: 'automatico', sourceRef: f.kind === 'grande_porte' ? 'regra:numero=requisicao' : 'regra:1o_lacre/ano/unidade' };
    f.numero = numero;
    return [rev];
  }

  private async assertNumeroFree(tx: Tx, f: FavRow, numero: string): Promise<void> {
    const other = await tx.query(`SELECT id FROM fav WHERE numero = $1 AND id <> $2`, [numero, f.id]);
    if (other.rowCount) {
      throw conflict(f.kind === 'grande_porte' ? 'REQUISICAO_COLIDE_GRANDE_PORTE' : 'NUMERO_FAV_COLIDE',
        f.kind === 'grande_porte'
          ? 'Já existe FAV de grande porte com este nº de requisição. A regra oficial para múltiplos vestígios na mesma requisição está pendente (P-NUM-02); o rascunho foi preservado.'
          : 'Já existe FAV com este número (1º lacre/ano/unidade). Confira o nº do 1º lacre.',
        { pendencia: f.kind === 'grande_porte' ? 'P-NUM-02' : 'P-NUM-01' });
    }
  }

  // ------------------------------------------------------------------ intervenientes externos
  async addIntervener(actor: Actor, favId: string, body: unknown): Promise<{ id: string; versao: number }> {
    requireFiller(actor);
    const b = parse(IntervenerBody, body);
    try {
      return await this.db.tx(async (tx) => {
        const f = await this.access.lockForWrite(tx, actor, favId);
        this.access.requireNotClosed(f);
        const role = this.roleFor(actor, ['ORIGEM_COLETA', 'REGISTRO_UNIDADE', 'CUSTODIA', 'PERICIA'], 'intervenientes', f);
        const ctx = await this.acts.context(tx, actor, role);
        const r = await tx.query(
          `INSERT INTO intervener (fav_id, role, name, document_type, document_number, organization, evidence_source, evidence_status, registered_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [f.id, b.papel, b.nome, b.tipoDocumento, b.numeroDocumento, b.orgao ?? null, b.fonteComprobatoria, b.comprovacao, actor.identityId]);
        const i = r.rows[0];
        const version = await this.access.bumpVersion(tx, f.id);
        const ev = await this.acts.event(tx, ctx, {
          favId: f.id, type: 'interveniente_registrado', favVersion: version,
          summary: `Interveniente externo registrado documentalmente (${b.papel}); comprovação ${b.comprovacao}`,
          payload: { intervenienteId: i.id, papel: b.papel, comprovacao: b.comprovacao },
        });
        await this.acts.revisions(tx, ctx, f.id, version, this.acts.creationRevisions('intervener', i.id, i,
          ['role', 'name', 'document_type', 'document_number', 'organization', 'evidence_source', 'evidence_status']), ev);
        return { id: i.id, versao: version };
      });
    } catch (e) { mapPgError(e); }
  }

  // ------------------------------------------------------------------ Confirmar coleta
  async confirmColeta(actor: Actor, favId: string, body: unknown, idemKey: string | undefined) {
    requireFiller(actor);
    const b = parse(z.object({ versao: z.number().int().positive() }), body);
    try {
      return await this.db.tx(async (tx) => {
        const { result } = await withIdempotency(tx, actor, idemKey, `confirmar_coleta:${favId}`, b, async () => {
          const f = await this.access.lockForWrite(tx, actor, favId, b.versao);
          if (f.status !== 'rascunho') throw conflict('ETAPA_INVALIDA', 'A coleta desta FAV já foi confirmada.');
          if (actor.unitId !== f.origin_unit_id) throw forbidden('FORA_DO_ESCOPO', 'A confirmação da coleta é feita pela unidade de origem.');
          const role = requireRole(actor, 'ORIGEM_COLETA', 'REGISTRO_UNIDADE');

          const missing: string[] = [];
          if (!f.coleta_responsavel_kind) missing.push('Responsável pela coleta e acondicionamento');
          if (!f.coleta_data_hora) missing.push('Data/hora da coleta');
          if (!f.coleta_endereco && f.coleta_geo_lat === null) missing.push('Endereço do local ou geolocalização');
          if (!f.vestigio_tipo) missing.push('Tipo do vestígio');
          if (!f.vestigio_descricao) missing.push('Descrição do vestígio');
          if (f.preservacao_mesmo_coletor === null || (f.preservacao_mesmo_coletor === false && !f.preservacao_kind)) missing.push('Responsável pela preservação do local');
          if (f.kind === 'grande_porte' && !f.requisicao) missing.push('Nº da requisição (grande porte)');
          if (missing.length) throw unprocessable('CAMPOS_OBRIGATORIOS', 'Preencha os campos obrigatórios para confirmar a coleta.', { campos: missing });

          // O ato de coleta por servidor é confirmado pela sessão do próprio coletor.
          let externalPending = false;
          if (f.coleta_responsavel_kind === 'servidor' && f.coleta_responsavel_identity_id !== actor.identityId) {
            throw forbidden('CONFIRMACAO_PELO_COLETOR', 'Coleta por servidor: a confirmação deve ser feita pelo próprio responsável pela coleta, em sua sessão.');
          }
          if (f.coleta_responsavel_kind === 'externo') {
            const iv = await tx.query(`SELECT evidence_status FROM intervener WHERE id = $1`, [f.coleta_responsavel_intervener_id]);
            externalPending = iv.rows[0]?.evidence_status !== 'apresentada';
          }
          const effective = checkEffectiveAt(f.coleta_data_hora, 'Data/hora da coleta');

          const { numero, year } = await this.computeNumero(tx, f);
          await this.assertNumeroFree(tx, f, numero);
          const ctx = await this.acts.context(tx, actor, role);
          const custodian = f.coleta_responsavel_kind === 'servidor'
            ? { custodian_kind: 'servidor', custodian_identity_id: f.coleta_responsavel_identity_id, custodian_intervener_id: null }
            : { custodian_kind: 'externo', custodian_identity_id: null, custodian_intervener_id: f.coleta_responsavel_intervener_id };
          const version = await this.access.bumpVersion(tx, f.id, {
            status: 'sob_custodia', numero, numero_year: year, coleta_confirmed_at: new Date().toISOString(),
            custodian_unit_id: f.origin_unit_id, ...custodian,
          });
          await tx.query(
            `UPDATE seal SET applied_at = $2, applied_by_identity_id = $3, applied_by_intervener_id = $4
              WHERE fav_id = $1 AND ordinal = 1 AND status = 'ativo'`,
            [f.id, effective.toISOString(), f.coleta_responsavel_identity_id, f.coleta_responsavel_intervener_id]);
          const ev = await this.acts.event(tx, ctx, {
            favId: f.id, type: 'coleta_confirmada', favVersion: version, effectiveAt: effective,
            statusBefore: 'rascunho', statusAfter: 'sob_custodia',
            summary: f.coleta_responsavel_kind === 'externo'
              ? `Coleta por interveniente externo registrada documentalmente; nº ${numero}${externalPending ? ' — comprovação documental PENDENTE' : ''}`
              : `Coleta confirmada pelo coletor; nº ${numero}`,
            payload: { numero, coletorTipo: f.coleta_responsavel_kind, comprovacaoExternaPendente: externalPending, alcance: f.coleta_responsavel_kind === 'externo' ? 'registro_documental_por_servidor' : 'confirmacao_pelo_coletor' },
          });
          await this.acts.revisions(tx, ctx, f.id, version, [
            { entity: 'fav', key: f.id, field: 'numero', oldValue: null, newValue: numero, action: 'automatico', origin: 'automatico', sourceRef: f.kind === 'grande_porte' ? 'regra:numero=requisicao' : 'regra:1o_lacre/ano/unidade' },
            { entity: 'fav', key: f.id, field: 'status', oldValue: 'rascunho', newValue: 'sob_custodia', action: 'automatico', origin: 'automatico', sourceRef: 'ato:confirmar_coleta' },
          ], ev);
          return { numero, versao: version, comprovacaoExternaPendente: externalPending };
        });
        return result;
      });
    } catch (e) { mapPgError(e); }
  }
}
