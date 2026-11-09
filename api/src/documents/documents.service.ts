import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '../db/database.js';
import { ActWriter, withIdempotency } from '../common/acts.js';
import { conflict, forbidden, mapPgError, notFound, unprocessable } from '../common/errors.js';
import { parse } from '../common/validation.js';
import { requireFiller, requireRole } from '../authz/policy.js';
import type { Actor } from '../authz/roles.js';
import { AuditService } from '../audit/audit.service.js';
import { FavAccess } from '../fav/fav.access.js';
import { FavQueryService } from '../fav/fav-query.service.js';
import { renderFavPdf, renderLabelsPdf, type LabelData } from './pdf.js';

const VolumesBody = z.object({
  versao: z.number().int().positive(),
  volumes: z.array(z.object({ descricao: z.string().trim().max(300).optional(), lacreIdentificador: z.string().trim().max(60).optional() })).min(1).max(200),
});
const LabelsBody = z.object({ motivoReimpressao: z.string().trim().min(5).max(500).optional() });
const LabelStatusBody = z.object({ status: z.enum(['impressao_solicitada', 'afixacao_confirmada']), observacao: z.string().trim().max(500).optional() });

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: Database,
    private readonly access: FavAccess,
    private readonly query: FavQueryService,
    private readonly acts: ActWriter,
    private readonly audit: AuditService,
  ) {}

  /** PDF da FAV na versão corrente; registra exportação com hash. */
  async favPdf(actor: Actor, favId: string, purpose: string | undefined): Promise<{ pdf: Uint8Array; filename: string; sha: string; version: number }> {
    const v = await this.query.view(actor, favId);
    const now = new Date().toISOString();
    const status = v.ficha.status === 'rascunho' ? 'RASCUNHO — sem valor de acompanhamento' : v.ficha.status === 'encerrado' ? 'Ficha encerrada' : 'Documento de acompanhamento';
    const pdf = await renderFavPdf(v, { geradoEm: now, geradoPor: `${actor.displayName} (${actor.functionalId})`, status });
    const sha = sha256(pdf);
    await this.db.query(`INSERT INTO document_export (fav_id, kind, fav_version, sha256, generated_by, purpose) VALUES ($1,'fav_pdf',$2,$3,$4,$5)`,
      [favId, v.ficha.version, sha, actor.identityId, purpose?.slice(0, 200) ?? null]);
    await this.audit.security('exportacao_pdf_fav', 'sucesso', { actor, targetType: 'fav', targetId: favId, detail: { versao: v.ficha.version, sha256: sha } });
    const name = (v.ficha.numero ?? v.ficha.draft_code).replace(/[^A-Za-z0-9-]+/g, '_');
    return { pdf, filename: `FAV_${name}_v${v.ficha.version}.pdf`, sha, version: v.ficha.version };
  }

  async setVolumes(actor: Actor, favId: string, body: unknown) {
    requireFiller(actor);
    const b = parse(VolumesBody, body);
    try {
      return await this.db.tx(async (tx) => {
        const f = await this.access.lockForWrite(tx, actor, favId, b.versao);
        this.access.requireNotClosed(f);
        if (f.kind !== 'grande_porte') throw unprocessable('NAO_GRANDE_PORTE', 'Volumes/etiquetas do Anexo aplicam-se a vestígios de grande porte.');
        if (actor.unitId !== f.origin_unit_id && actor.unitId !== f.custodian_unit_id) throw forbidden('FORA_DO_ESCOPO', 'Unidade sem custódia/origem.');
        const role = requireRole(actor, 'ORIGEM_COLETA', 'REGISTRO_UNIDADE', 'CUSTODIA');
        const ctx = await this.acts.context(tx, actor, role);
        const cur = (await tx.query(`SELECT * FROM volume WHERE fav_id = $1 ORDER BY ordinal`, [f.id])).rows;
        const version = await this.access.bumpVersion(tx, f.id);
        const revs = [];
        for (let i = 0; i < b.volumes.length; i++) {
          const want = { descricao: b.volumes[i].descricao || null, lacre_identificador: b.volumes[i].lacreIdentificador?.toUpperCase() || null };
          const ex = cur[i];
          if (!ex) {
            const ins = (await tx.query(`INSERT INTO volume (fav_id, ordinal, descricao, lacre_identificador, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
              [f.id, i + 1, want.descricao, want.lacre_identificador, actor.identityId])).rows[0];
            revs.push(...this.acts.creationRevisions('volume', ins.id, ins, ['ordinal', 'descricao', 'lacre_identificador']));
          } else {
            for (const k of ['descricao', 'lacre_identificador'] as const) {
              if ((ex[k] ?? null) !== want[k]) {
                await tx.query(`UPDATE volume SET ${k} = $2 WHERE id = $1`, [ex.id, want[k]]);
                revs.push({ entity: 'volume', key: ex.id, field: k, oldValue: ex[k], newValue: want[k], action: f.status === 'rascunho' ? 'alteracao' as const : (ex[k] ? 'retificacao' as const : 'preenchimento' as const), reason: 'Atualização da relação de volumes' });
              }
            }
          }
        }
        if (cur.length > b.volumes.length) throw unprocessable('REDUCAO_VOLUMES', 'Redução do número de volumes exige registro de ocorrência própria (pendência P-ETQ-02).');
        const ev = await this.acts.event(tx, ctx, { favId: f.id, type: 'volumes_atualizados', favVersion: version, summary: `Relação de volumes: ${b.volumes.length} volume(s)`, payload: { total: b.volumes.length } });
        await this.acts.revisions(tx, ctx, f.id, version, revs, ev);
        return { versao: version, total: b.volumes.length };
      });
    } catch (e) { mapPgError(e); }
  }

  /** Gera (ou reimprime, com motivo) o lote de etiquetas do Anexo, um por volume. */
  async generateLabels(actor: Actor, favId: string, body: unknown, key?: string): Promise<{ pdf: Uint8Array; filename: string; loteId: string; versaoLote: number }> {
    requireFiller(actor);
    const b = parse(LabelsBody, body);
    let pdfOut: Uint8Array | null = null;
    try {
      const res = await this.db.tx(async (tx) => (await withIdempotency(tx, actor, key, `etiquetas:${favId}`, b, async () => {
        const f = await this.access.lockForWrite(tx, actor, favId);
        this.access.requireNotClosed(f);
        if (f.kind !== 'grande_porte') throw unprocessable('NAO_GRANDE_PORTE', 'Etiquetas do Anexo são exclusivas de vestígios de grande porte.');
        if (!f.requisicao || !f.procedimento) throw unprocessable('CAMPOS_OBRIGATORIOS', 'Etiqueta exige nº do procedimento e nº da requisição.');
        if (actor.unitId !== f.origin_unit_id && actor.unitId !== f.custodian_unit_id) throw forbidden('FORA_DO_ESCOPO', 'Unidade sem custódia/origem.');
        const role = requireRole(actor, 'ORIGEM_COLETA', 'REGISTRO_UNIDADE', 'CUSTODIA');
        const vols = (await tx.query(`SELECT * FROM volume WHERE fav_id = $1 ORDER BY ordinal`, [f.id])).rows;
        if (!vols.length) throw unprocessable('SEM_VOLUMES', 'Cadastre os volumes do vestígio antes de gerar as etiquetas.');
        const prev = (await tx.query(`SELECT * FROM label_batch WHERE fav_id = $1 AND status <> 'substituida' ORDER BY batch_version DESC LIMIT 1 FOR UPDATE`, [f.id])).rows[0];
        if (prev && !b.motivoReimpressao) throw conflict('REIMPRESSAO_SEM_MOTIVO', 'Já existe lote de etiquetas. A reimpressão exige motivo.');
        const ctx = await this.acts.context(tx, actor, role);
        const snap = (await tx.query(`SELECT * FROM identity_snapshot WHERE id = $1`, [ctx.snapshotId])).rows[0];
        const maxV = (await tx.query(`SELECT coalesce(max(batch_version),0) AS v FROM label_batch WHERE fav_id = $1`, [f.id])).rows[0].v as number;
        const versaoLote = maxV + 1;
        const data: LabelData[] = vols.map((v: any) => ({
          procedimento: f.procedimento, requisicao: f.requisicao, lacreIdentificador: v.lacre_identificador, responsavel: snap.display_name,
          matriculaLotacao: `${snap.functional_id} / ${snap.unit_code ?? actor.unitCode}`, volume: v.ordinal, total: vols.length, versao: versaoLote,
        }));
        const pdf = await renderLabelsPdf(data, `Etiquetas — FAV ${f.numero ?? f.draft_code} — lote v${versaoLote}${prev ? ' (REIMPRESSÃO)' : ''}`);
        pdfOut = pdf;
        const sha = sha256(pdf);
        const lote = (await tx.query(
          `INSERT INTO label_batch (fav_id, batch_version, volumes_total, responsible_identity_id, responsible_snapshot_id, pdf_sha256, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [f.id, versaoLote, vols.length, actor.identityId, ctx.snapshotId, sha, b.motivoReimpressao ?? null])).rows[0];
        if (prev) await tx.query(`UPDATE label_batch SET status = 'substituida', superseded_by = $2 WHERE id = $1`, [prev.id, lote.id]);
        await tx.query(`INSERT INTO document_export (fav_id, kind, fav_version, sha256, generated_by, purpose) VALUES ($1,'etiquetas_pdf',$2,$3,$4,$5)`,
          [f.id, f.version, sha, actor.identityId, prev ? 'reimpressao' : 'geracao']);
        const version = await this.access.bumpVersion(tx, f.id);
        await this.acts.event(tx, ctx, {
          favId: f.id, type: prev ? 'etiquetas_reimpressas' : 'etiquetas_geradas', favVersion: version,
          summary: prev ? `Etiquetas reimpressas (lote v${versaoLote}, substitui v${prev.batch_version}): ${b.motivoReimpressao}` : `Etiquetas geradas (lote v${versaoLote}, ${vols.length} volume(s))`,
          payload: { loteId: lote.id, versaoLote, volumes: vols.length, sha256: sha },
        });
        await this.audit.security(prev ? 'reimpressao_etiquetas' : 'geracao_etiquetas', 'sucesso', { actor, targetType: 'fav', targetId: f.id, detail: { versaoLote }, tx });
        return { loteId: lote.id as string, versaoLote, sha };
      })).result);
      if (!pdfOut) {
        // Reenvio idempotente: devolve o mesmo lote regenerado (conteúdo determinístico pelo lote) — exige leitura.
        pdfOut = await this.regenerate(actor, favId, res.loteId);
      }
      const f = await this.access.loadForRead(actor, favId);
      return { pdf: pdfOut, filename: `Etiquetas_${(f.numero ?? f.draft_code).replace(/[^A-Za-z0-9-]+/g, '_')}_v${res.versaoLote}.pdf`, loteId: res.loteId, versaoLote: res.versaoLote };
    } catch (e) { mapPgError(e); }
  }

  private async regenerate(actor: Actor, favId: string, loteId: string): Promise<Uint8Array> {
    const f = await this.access.loadForRead(actor, favId);
    const lote = (await this.db.query(`SELECT b.*, s.display_name, s.functional_id, s.unit_code FROM label_batch b JOIN identity_snapshot s ON s.id = b.responsible_snapshot_id WHERE b.id = $1 AND b.fav_id = $2`, [loteId, favId])).rows[0];
    if (!lote) throw notFound();
    const vols = (await this.db.query(`SELECT * FROM volume WHERE fav_id = $1 ORDER BY ordinal`, [favId])).rows;
    return renderLabelsPdf(vols.map((v: any) => ({
      procedimento: f.procedimento, requisicao: f.requisicao, lacreIdentificador: v.lacre_identificador, responsavel: lote.display_name,
      matriculaLotacao: `${lote.functional_id} / ${lote.unit_code ?? ''}`, volume: v.ordinal, total: vols.length, versao: lote.batch_version,
    })), `Etiquetas — FAV ${f.numero ?? f.draft_code} — lote v${lote.batch_version}`);
  }

  /** Solicitação de impressão / confirmação operacional de afixação (o PDF ou o clique não comprovam afixação). */
  async labelStatus(actor: Actor, favId: string, loteId: string, body: unknown) {
    requireFiller(actor);
    const b = parse(LabelStatusBody, body);
    try {
      return await this.db.tx(async (tx) => {
        const f = await this.access.lockForWrite(tx, actor, favId);
        const role = requireRole(actor, 'ORIGEM_COLETA', 'REGISTRO_UNIDADE', 'CUSTODIA');
        const lote = (await tx.query(`SELECT * FROM label_batch WHERE id = $1 AND fav_id = $2 FOR UPDATE`, [loteId, f.id])).rows[0];
        if (!lote) throw notFound();
        if (lote.status === 'substituida') throw conflict('LOTE_SUBSTITUIDO', 'Este lote foi substituído por reimpressão.');
        if (b.status === 'impressao_solicitada' && lote.status !== 'gerada') throw conflict('ETAPA_INVALIDA', 'Impressão já solicitada.');
        if (b.status === 'afixacao_confirmada' && lote.status === 'afixacao_confirmada') throw conflict('ETAPA_INVALIDA', 'Afixação já confirmada.');
        const ctx = await this.acts.context(tx, actor, role);
        await tx.query(`UPDATE label_batch SET status = $2 WHERE id = $1`, [lote.id, b.status]);
        const version = await this.access.bumpVersion(tx, f.id);
        const ev = await this.acts.event(tx, ctx, {
          favId: f.id, type: b.status === 'afixacao_confirmada' ? 'etiquetas_afixacao_confirmada' : 'etiquetas_impressao_solicitada', favVersion: version,
          summary: b.status === 'afixacao_confirmada' ? `Afixação das etiquetas (lote v${lote.batch_version}) confirmada pelo operador` : `Impressão das etiquetas (lote v${lote.batch_version}) solicitada`,
          payload: { loteId: lote.id, observacao: b.observacao ?? null },
        });
        await this.acts.revisions(tx, ctx, f.id, version, [{ entity: 'label_batch', key: lote.id, field: 'status', oldValue: lote.status, newValue: b.status, action: 'preenchimento' }], ev);
        await this.audit.security(b.status === 'afixacao_confirmada' ? 'confirmacao_afixacao' : 'solicitacao_impressao', 'sucesso', { actor, targetType: 'label_batch', targetId: lote.id, tx });
        return { versao: version, status: b.status };
      });
    } catch (e) { mapPgError(e); }
  }
}
