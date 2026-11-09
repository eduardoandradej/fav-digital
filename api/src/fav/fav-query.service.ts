/** Leitura: visão completa da ficha, autoria por campo, histórico, linha do tempo, pesquisa e próximos atos. */
import { Injectable } from '@nestjs/common';
import { Database } from '../db/database.js';
import { forbidden } from '../common/errors.js';
import { hasRole } from '../authz/policy.js';
import type { Actor } from '../authz/roles.js';
import { AuditService } from '../audit/audit.service.js';
import { FAV_FIELDS, SECTION_LABELS } from './fields.js';
import { FavAccess, type FavRow } from './fav.access.js';

const PERSON_SQL = `
  SELECT i.id, i.display_name AS nome, i.functional_id AS id_funcional, i.unit_code AS lotacao, i.job_title AS cargo
  FROM identity i WHERE i.id = ANY($1)`;

export interface NextAct { acao: string; rotulo: string; permitido: boolean; motivo?: string }

@Injectable()
export class FavQueryService {
  constructor(private readonly db: Database, private readonly access: FavAccess, private readonly audit: AuditService) {}

  async view(actor: Actor, favId: string) {
    const f = await this.access.loadForRead(actor, favId);
    const q = (sql: string, p: unknown[] = [f.id]) => this.db.query(sql, p).then((r) => r.rows);
    const [seals, openings, movements, interveners, links, storage, closure, volumes, labels, units] = await Promise.all([
      q(`SELECT * FROM seal WHERE fav_id = $1 AND status <> 'substituido_rascunho' ORDER BY ordinal`),
      q(`SELECT o.*, s.display_name AS responsavel_nome, s.functional_id AS responsavel_id_funcional, s.job_title AS responsavel_cargo, s.unit_code AS responsavel_lotacao,
              ps.number AS lacre_anterior, ns.number AS novo_lacre
         FROM seal_opening o JOIN identity_snapshot s ON s.id = o.responsible_snapshot_id
         JOIN seal ps ON ps.id = o.previous_seal_id LEFT JOIN seal ns ON ns.id = o.new_seal_id
        WHERE o.fav_id = $1 ORDER BY o.opened_at, o.created_at`),
      q(`SELECT m.*, ou.code AS origem_codigo, du.code AS destino_codigo, du.name AS destino_nome,
              ss.display_name AS remetente_nome, ss.functional_id AS remetente_id_funcional,
              rs.display_name AS recebedor_nome, rs.functional_id AS recebedor_id_funcional,
              si.name AS remetente_externo_nome, si.document_type AS remetente_externo_doc_tipo, si.document_number AS remetente_externo_doc,
              ti.name AS transportador_nome
         FROM movement m LEFT JOIN unit ou ON ou.id = m.origin_unit_id JOIN unit du ON du.id = m.dest_unit_id
         LEFT JOIN identity_snapshot ss ON ss.id = m.sender_snapshot_id
         LEFT JOIN identity_snapshot rs ON rs.id = m.receiver_snapshot_id
         LEFT JOIN intervener si ON si.id = m.sender_intervener_id
         LEFT JOIN intervener ti ON ti.id = m.transporter_intervener_id
        WHERE m.fav_id = $1 ORDER BY m.seq`),
      q(`SELECT iv.*, i.display_name AS registrado_por_nome FROM intervener iv JOIN identity i ON i.id = iv.registered_by WHERE iv.fav_id = $1 ORDER BY iv.registered_at`),
      q(`SELECT l.*, pf.numero AS prova_numero, df.numero AS derivada_numero, df.draft_code AS derivada_rascunho
           FROM sample_link l JOIN fav pf ON pf.id = l.prova_fav_id JOIN fav df ON df.id = l.derivada_fav_id
          WHERE l.prova_fav_id = $1 OR l.derivada_fav_id = $1 ORDER BY l.created_at`),
      q(`SELECT se.*, u.code AS unidade_codigo, i.display_name AS pessoa_nome, i.functional_id AS pessoa_id_funcional, iv.name AS pessoa_externa_nome
           FROM storage_event se JOIN unit u ON u.id = se.unit_id LEFT JOIN identity i ON i.id = se.person_identity_id
           LEFT JOIN intervener iv ON iv.id = se.person_intervener_id WHERE se.fav_id = $1 ORDER BY se.effective_at`),
      q(`SELECT c.*, s.display_name AS responsavel_nome, s.functional_id AS responsavel_id_funcional, s.job_title AS responsavel_cargo
           FROM closure c JOIN identity_snapshot s ON s.id = c.responsible_snapshot_id WHERE c.fav_id = $1`),
      q(`SELECT * FROM volume WHERE fav_id = $1 ORDER BY ordinal`),
      q(`SELECT b.*, s.display_name AS responsavel_nome FROM label_batch b JOIN identity_snapshot s ON s.id = b.responsible_snapshot_id WHERE b.fav_id = $1 ORDER BY b.batch_version`),
      q(`SELECT id, code, name FROM unit WHERE id = ANY($1)`, [[f.origin_unit_id, f.custodian_unit_id, f.unidade_pj_id, f.guarda_unidade_id].filter(Boolean)]),
    ]);
    const personIds = [f.coleta_responsavel_identity_id, f.preservacao_identity_id, f.custodian_identity_id, f.created_by].filter(Boolean);
    const people = (await this.db.query(PERSON_SQL, [personIds])).rows;
    const autoria = await this.authorship(f.id);
    await this.audit.security('consulta_fav', 'sucesso', { actor, targetType: 'fav', targetId: f.id });

    const activeSeal = seals.find((s: any) => s.status === 'ativo') ?? null;
    const lastMovement = movements[movements.length - 1] ?? null;
    const custodianIntervener = interveners.find((i: any) => i.id === f.custodian_intervener_id);
    const pendencias = this.pendencias(f, interveners, movements, openings);
    return {
      ficha: f,
      unidades: Object.fromEntries(units.map((u: any) => [u.id, u])),
      pessoas: Object.fromEntries(people.map((p: any) => [p.id, p])),
      lacreVigente: activeSeal,
      lacres: seals,
      aberturas: openings,
      movimentacoes: movements,
      intervenientes: interveners,
      amostras: links,
      armazenamento: storage,
      encerramento: closure[0] ?? null,
      volumes,
      etiquetas: labels,
      autoria,
      situacao: {
        estadoFicha: f.status,
        estadoFisicoDeclarado: f.physical_state,
        responsavelAtual: f.status === 'em_transito' ? null
          : f.custodian_kind === 'servidor' ? people.find((p: any) => p.id === f.custodian_identity_id) ?? null
          : custodianIntervener ? { nome: custodianIntervener.name, externo: true } : null,
        emTransito: f.status === 'em_transito' ? { destino: lastMovement?.destino_codigo, desde: lastMovement?.sent_at, ultimaConfirmacao: 'envio' } : null,
        ultimaMovimentacao: lastMovement ? { seq: lastMovement.seq, status: lastMovement.status, enviadoEm: lastMovement.sent_at, recebidoEm: lastMovement.received_at } : null,
        pendencias,
      },
      proximosAtos: this.nextActs(actor, f, lastMovement, openings),
      campos: Object.fromEntries(Object.entries(FAV_FIELDS).map(([k, d]) => [k, { rotulo: d.label, secao: d.section, secaoRotulo: SECTION_LABELS[d.section], papeis: d.roles, regra: d.rule }])),
    };
  }

  private pendencias(f: FavRow, interveners: any[], movements: any[], openings: any[]): string[] {
    const p: string[] = [];
    if (f.status === 'rascunho') p.push('Coleta ainda não confirmada.');
    if (f.status !== 'rascunho' && !f.natureza_exame) p.push('Dados do Vestígio: natureza do exame não informada.');
    if (f.status !== 'rascunho' && !f.requisicao) p.push('Dados do Vestígio: nº da requisição não informado.');
    if (f.status !== 'rascunho' && f.kind === 'regular' && !f.sco_primeiro_lacre_ref) p.push('Referência do 1º lacre no SCO não registrada (item 6).');
    for (const i of interveners) if (i.evidence_status === 'pendente') p.push(`Comprovação documental pendente: interveniente ${i.name} (${i.role}).`);
    if (openings.some((o) => o.status === 'aberto')) p.push('Recipiente aberto: registre o novo lacre antes de movimentar.');
    if (movements.some((m) => m.status === 'recebido_com_ressalva')) p.push('Há recebimento com ressalva/não conformidade registrada.');
    if (f.status === 'encerrado' && !f.sco_anexacao_ref) p.push('Guarda documental: registrar a anexação da FAV no SCO (item 20).');
    return p;
  }

  /** Próximo ato permitido, com motivo quando bloqueado (a API revalida tudo no comando). */
  nextActs(actor: Actor, f: FavRow, lastMovement: any, openings: any[]): NextAct[] {
    const acts: NextAct[] = [];
    const filler = actor.eligible;
    const atCustody = f.custodian_unit_id === actor.unitId;
    const open = openings.some((o) => o.status === 'aberto');
    const add = (acao: string, rotulo: string, cond: boolean, motivo: string) => acts.push(cond ? { acao, rotulo, permitido: true } : { acao, rotulo, permitido: false, motivo });
    if (!filler) return [{ acao: 'nenhum', rotulo: 'Somente consulta', permitido: false, motivo: 'Sem vínculo elegível para preenchimento.' }];
    if (f.status === 'rascunho') {
      add('confirmar_coleta', 'Confirmar coleta', actor.unitId === f.origin_unit_id && hasRole(actor, 'ORIGEM_COLETA', 'REGISTRO_UNIDADE'), 'Exige papel de origem/registro na unidade de origem.');
      return acts;
    }
    if (f.status === 'encerrado') {
      add('guarda_documental', 'Registrar guarda/anexação no SCO', hasRole(actor, 'ENCERRAMENTO', 'REGISTRO_UNIDADE'), 'Exige papel de encerramento ou registro.');
      return acts;
    }
    if (f.status === 'em_transito') {
      const toMe = lastMovement?.dest_unit_id === actor.unitId;
      add('confirmar_recebimento', 'Confirmar recebimento', toMe && hasRole(actor, 'CUSTODIA', 'PERICIA') && lastMovement?.sender_identity_id !== actor.identityId,
        'Recebimento é confirmado por servidor da unidade de destino, distinto do remetente.');
      add('recusar_recebimento', 'Recusar recebimento', toMe && hasRole(actor, 'CUSTODIA', 'PERICIA'), 'Somente a unidade de destino pode recusar.');
      add('cancelar_envio', 'Cancelar envio', lastMovement?.send_registered_by === actor.identityId, 'Somente quem registrou o envio pode cancelá-lo.');
      return acts;
    }
    add('registrar_envio', 'Registrar envio', atCustody && !open && hasRole(actor, 'CUSTODIA', 'ORIGEM_COLETA', 'REGISTRO_UNIDADE'),
      open ? 'Recipiente aberto: registre o novo lacre.' : 'Exige custódia na unidade selecionada e papel de custódia.');
    add('registrar_abertura', 'Registrar abertura e novo lacre', atCustody && !open && f.physical_state === 'lacrado' && hasRole(actor, 'PERICIA', 'CUSTODIA'), 'Exige custódia, lacre vigente e papel de perícia ou pessoa autorizada.');
    if (open) add('registrar_novo_lacre', 'Registrar novo lacre', atCustody && hasRole(actor, 'PERICIA', 'CUSTODIA'), 'Exige custódia na unidade.');
    add('vincular_amostra', 'Vincular FAV de amostra', atCustody && hasRole(actor, 'PERICIA'), 'Exclusivo da perícia com custódia do vestígio.');
    add('registrar_armazenamento', 'Registrar entrada/saída/acesso físico', atCustody && hasRole(actor, 'CUSTODIA'), 'Exige papel de custódia na unidade custodiante.');
    add('registrar_destinacao', 'Registrar destinação (encerramento)', atCustody && !open && hasRole(actor, 'ENCERRAMENTO'), 'Exige papel de encerramento na unidade custodiante.');
    return acts;
  }

  /** Primeira e última autoria por campo (chave estável do item, independente da posição na tela). */
  async authorship(favId: string) {
    const r = await this.db.query(
      `WITH ranked AS (
         SELECT fr.*, row_number() OVER w_asc AS rn_first, row_number() OVER w_desc AS rn_last, count(*) OVER w_all AS total
           FROM field_revision fr WHERE fr.fav_id = $1
         WINDOW w_asc AS (PARTITION BY entity, entity_key, field ORDER BY id),
                w_desc AS (PARTITION BY entity, entity_key, field ORDER BY id DESC),
                w_all AS (PARTITION BY entity, entity_key, field))
       SELECT r.entity, r.entity_key, r.field, r.rn_first, r.rn_last, r.total, r.action, r.origin, r.recorded_at, r.reason,
              s.display_name, s.functional_id, s.unit_code AS lotacao, u.code AS unidade_atuacao, r.author_role
         FROM ranked r JOIN identity_snapshot s ON s.id = r.author_snapshot_id LEFT JOIN unit u ON u.id = r.author_unit_id
        WHERE r.rn_first = 1 OR r.rn_last = 1`, [favId]);
    const out: Record<string, any> = {};
    for (const x of r.rows) {
      const k = `${x.entity}:${x.entity_key}:${x.field}`;
      const info = { por: x.display_name, idFuncional: x.functional_id, unidade: x.unidade_atuacao, lotacao: x.lotacao, papel: x.author_role, em: x.recorded_at, acao: x.action, origem: x.origin, motivo: x.reason };
      out[k] ??= { revisoes: x.total };
      if (x.rn_first === 1) out[k].preenchidoPor = info;
      if (x.rn_last === 1) out[k].ultimaAlteracao = info;
    }
    return out;
  }

  async history(actor: Actor, favId: string, entity: string, key: string, field: string) {
    await this.access.loadForRead(actor, favId);
    const r = await this.db.query(
      `SELECT fr.id, fr.old_value, fr.new_value, fr.action, fr.origin, fr.source_ref, fr.reason, fr.recorded_at, fr.fav_version,
              s.display_name AS por, s.functional_id AS id_funcional, s.unit_code AS lotacao, s.job_title AS cargo, u.code AS unidade_atuacao, fr.author_role
         FROM field_revision fr JOIN identity_snapshot s ON s.id = fr.author_snapshot_id LEFT JOIN unit u ON u.id = fr.author_unit_id
        WHERE fr.fav_id = $1 AND fr.entity = $2 AND fr.entity_key::text = $3 AND fr.field = $4 ORDER BY fr.id`,
      [favId, entity, key, field]);
    await this.audit.security('consulta_historico_campo', 'sucesso', { actor, targetType: 'fav', targetId: favId, detail: { entity, field } });
    return r.rows;
  }

  async timeline(actor: Actor, favId: string, order: 'registro' | 'efetiva') {
    await this.access.loadForRead(actor, favId);
    const orderBy = order === 'efetiva' ? 'coalesce(e.effective_at, e.recorded_at), e.id' : 'e.id';
    const r = await this.db.query(
      `SELECT e.id, e.event_uuid, e.type, e.effective_at, e.recorded_at, e.summary, e.payload, e.status_before, e.status_after,
              e.fav_version, e.late_entry_reason, e.actor_role, s.display_name AS registrado_por, s.functional_id AS id_funcional,
              s.job_title AS cargo, u.code AS unidade, e.movement_id
         FROM custody_event e JOIN identity_snapshot s ON s.id = e.actor_snapshot_id LEFT JOIN unit u ON u.id = e.actor_unit_id
        WHERE e.fav_id = $1 ORDER BY ${orderBy}`, [favId]);
    return r.rows;
  }

  async search(actor: Actor, params: { q?: string; status?: string; page?: number; pageSize?: number; meusRascunhos?: boolean }) {
    if (!this.access.canRead(actor)) throw forbidden('PAPEL_INSUFICIENTE', 'Sem acesso de consulta na unidade selecionada.');
    const page = Math.max(1, params.page ?? 1);
    const size = Math.min(50, Math.max(1, params.pageSize ?? 20));
    const where: string[] = ['fav.fav_in_unit(f.id, $1)'];
    const args: unknown[] = [actor.unitId];
    if (params.q && params.q.trim()) {
      args.push(params.q.trim().toUpperCase());
      const i = args.length;
      where.push(`(upper(f.numero) = $${i} OR upper(f.requisicao) = $${i} OR upper(f.procedimento) = $${i} OR f.draft_code = $${i}
               OR EXISTS (SELECT 1 FROM seal s WHERE s.fav_id = f.id AND upper(s.number) = $${i})
               OR upper(f.numero) LIKE $${i} || '/%')`);
    }
    if (params.status) { args.push(params.status); where.push(`f.status = $${args.length}`); }
    if (params.meusRascunhos) { args.push(actor.identityId); where.push(`f.status = 'rascunho' AND f.created_by = $${args.length}`); }
    args.push(size, (page - 1) * size);
    const r = await this.db.query(
      `SELECT f.id, f.numero, f.draft_code, f.kind, f.status, f.physical_state, f.requisicao, f.procedimento, f.vestigio_tipo,
              f.updated_at, cu.code AS custodia_unidade, count(*) OVER () AS total,
              (SELECT s.number FROM seal s WHERE s.fav_id = f.id AND s.status = 'ativo') AS lacre_vigente
         FROM fav f LEFT JOIN unit cu ON cu.id = f.custodian_unit_id
        WHERE ${where.join(' AND ')} ORDER BY f.updated_at DESC LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    if (params.q) await this.audit.security('pesquisa_fav', 'sucesso', { actor, detail: { resultados: r.rowCount } });
    return { pagina: page, tamanho: size, total: Number(r.rows[0]?.total ?? 0), itens: r.rows.map(({ total: _t, ...x }) => x) };
  }

  /** Busca mínima de servidores importados para indicar responsáveis (sem expor atributos além do necessário). */
  async findPeople(actor: Actor, q: string) {
    if (!actor.eligible) throw forbidden('SEM_VINCULO_ELEGIVEL', 'Sem vínculo elegível.');
    const term = q.trim();
    if (term.length < 3) return [];
    const r = await this.db.query(
      `SELECT id, display_name AS nome, functional_id AS id_funcional, unit_code AS lotacao, job_title AS cargo
         FROM identity WHERE status = 'active' AND eligible_pcerj AND (functional_id = $1 OR display_name ILIKE '%' || $2 || '%')
        ORDER BY display_name LIMIT 10`, [term.replace('-', ''), term.replace(/[%_]/g, '')]);
    return r.rows;
  }

  async units() {
    return (await this.db.query(`SELECT id, code, name, kind FROM unit WHERE active ORDER BY code`)).rows;
  }
}
