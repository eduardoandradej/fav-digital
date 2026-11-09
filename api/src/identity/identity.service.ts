/**
 * Projeção de identidade institucional: importação no primeiro login (dentro do escopo),
 * sincronização paginada e idempotente, retratos históricos e bloqueio de colisões.
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../tokens.js';
import { Database, type Tx } from '../db/database.js';
import { DIRECTORY_SOURCE, type DirectoryEntry, type DirectorySource } from './directory.js';

export interface IdentityRow {
  id: string; source: string; directory_guid: string; login: string; functional_id: string; display_name: string;
  unit_code: string | null; job_title: string | null; eligible_pcerj: boolean; status: 'active' | 'disabled' | 'blocked';
  block_reason: string | null; attributes_complete: boolean;
}

export interface SyncReport {
  runId: string; status: 'ok' | 'partial' | 'failed' | 'aborted_anomaly';
  seen: number; created: number; updated: number; disabled: number; blocked: number; pages: number; diagnostic: string | null;
}

@Injectable()
export class IdentityService {
  private readonly log = new Logger('Identidade');

  constructor(
    private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(DIRECTORY_SOURCE) private readonly directory: DirectorySource,
  ) {}

  get source(): string { return this.directory.source; }

  isEligible(e: DirectoryEntry): boolean {
    const g = this.cfg.auth.eligibleGroupDn;
    if (!g) return false; // sem critério aprovado configurado, ninguém é elegível para preenchimento
    return e.memberOf.some((m) => m.toLowerCase() === g.toLowerCase());
  }

  async byId(id: string, q: Pick<Tx, 'query'> = this.db.pool): Promise<IdentityRow | null> {
    const r = await q.query('SELECT * FROM identity WHERE id = $1', [id]);
    return r.rows[0] ?? null;
  }

  /**
   * Após autenticação individual bem-sucedida: localiza a identidade pelo identificador estável (GUID).
   * O primeiro login exige importação prévia bem-sucedida (sincronização no escopo aprovado);
   * não há cadastro manual nem autoinscrição. Atributos mutáveis são atualizados a partir da consulta.
   */
  async resolveOnLogin(entry: DirectoryEntry): Promise<IdentityRow | null> {
    return this.db.tx(async (tx) => {
      const existing = await tx.query<IdentityRow>(
        'SELECT * FROM identity WHERE source = $1 AND directory_guid = $2 FOR UPDATE', [this.source, entry.guid]);
      const row = existing.rows[0];
      if (!row) return null;
      await this.applyAttributes(tx, row, entry);
      return this.byId(row.id, tx);
    });
  }

  private async insertEntry(tx: Tx, e: DirectoryEntry, runId: string | null): Promise<IdentityRow> {
    let status: IdentityRow['status'] = e.disabled ? 'disabled' : 'active';
    let reason: string | null = null;
    if (e.incomplete) { status = 'blocked'; reason = 'atributos_incompletos'; }
    if (status === 'active') {
      const clash = await tx.query(
        `SELECT id FROM identity WHERE source = $1 AND lower(login) = lower($2) AND status = 'active' FOR UPDATE`, [this.source, e.login]);
      if (clash.rowCount) { status = 'blocked'; reason = 'colisao_login'; }
    }
    const r = await tx.query<IdentityRow>(
      `INSERT INTO identity (source, directory_guid, login, functional_id, display_name, unit_code, job_title,
         eligible_pcerj, status, block_reason, attributes_complete, last_seen_sync_id, disabled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $9 = 'disabled' THEN now() END)
       RETURNING *`,
      [this.source, e.guid, e.login, e.functionalId, e.displayName, e.unitCode, e.jobTitle, this.isEligible(e), status, reason,
        !e.incomplete, runId]);
    return r.rows[0];
  }

  /** Atualiza atributos mutáveis (login, nome, lotação, cargo). Retratos anteriores permanecem. */
  private async applyAttributes(tx: Tx, row: IdentityRow, e: DirectoryEntry, runId: string | null = null): Promise<'updated' | 'unchanged' | 'disabled' | 'blocked'> {
    let status = row.status;
    let reason = row.block_reason;
    if (e.disabled) { status = 'disabled'; reason = null; }
    else if (e.incomplete) { status = 'blocked'; reason = 'atributos_incompletos'; }
    else if (row.status === 'disabled' && (row.block_reason === null || row.block_reason === 'ausente_no_diretorio')) {
      reason = null;
      // reativação explícita no diretório volta a ativo (sujeito a colisão abaixo)
      status = 'active';
    } else if (row.status === 'blocked' && row.block_reason === 'atributos_incompletos') {
      status = 'active'; reason = null;
    }
    if (status === 'active' || (status === 'blocked' && reason === 'colisao_login')) {
      const clash = await tx.query(
        `SELECT id FROM identity WHERE source = $1 AND lower(login) = lower($2) AND status = 'active' AND id <> $3`,
        [this.source, e.incomplete ? row.login : e.login, row.id]);
      if (clash.rowCount) { status = 'blocked'; reason = 'colisao_login'; }
      else if (status === 'blocked') { status = 'active'; reason = null; }
    }
    const eligible = this.isEligible(e);
    const changed = row.login !== e.login || row.functional_id !== e.functionalId || row.display_name !== e.displayName
      || row.unit_code !== e.unitCode || row.job_title !== e.jobTitle || row.eligible_pcerj !== eligible
      || row.status !== status || row.block_reason !== reason;
    if (changed && !e.incomplete) {
      await tx.query(
        `UPDATE identity SET login=$2, functional_id=$3, display_name=$4, unit_code=$5, job_title=$6, eligible_pcerj=$7,
           status=$8, block_reason=$9, attributes_complete=true, updated_at=now(),
           disabled_at = CASE WHEN $8 = 'disabled' THEN coalesce(disabled_at, now()) ELSE NULL END,
           last_seen_sync_id = coalesce($10, last_seen_sync_id)
         WHERE id=$1`,
        [row.id, e.login, e.functionalId, e.displayName, e.unitCode, e.jobTitle, eligible, status, reason, runId]);
    } else if (changed) {
      await tx.query(`UPDATE identity SET status=$2, block_reason=$3, attributes_complete=false, updated_at=now(),
        last_seen_sync_id = coalesce($4, last_seen_sync_id) WHERE id=$1`, [row.id, status, reason, runId]);
    } else if (runId) {
      await tx.query('UPDATE identity SET last_seen_sync_id = $2 WHERE id = $1', [row.id, runId]);
    }
    if (status !== 'active' && row.status === 'active') await this.revokeSessions(tx, row.id, `identidade_${status}`);
    if (!changed) return 'unchanged';
    if (status === 'disabled' && row.status !== 'disabled') return 'disabled';
    if (status === 'blocked' && row.status !== 'blocked') return 'blocked';
    return 'updated';
  }

  async revokeSessions(tx: Pick<Tx, 'query'>, identityId: string, reason: string): Promise<void> {
    await tx.query(`UPDATE app_session SET revoked_at = now(), revoke_reason = $2 WHERE identity_id = $1 AND revoked_at IS NULL`,
      [identityId, reason]);
  }

  /**
   * Sincronização completa do escopo. Desativações por ausência só ocorrem se a execução
   * terminar íntegra e sem anomalia (consulta vazia ou queda brusca de volume).
   */
  async syncFull(): Promise<SyncReport> {
    const run = await this.db.query<{ id: string }>(
      `INSERT INTO directory_sync_run (source, mode) VALUES ($1, 'full') RETURNING id`, [this.source]);
    const runId = run.rows[0].id;
    const rep: SyncReport = { runId, status: 'ok', seen: 0, created: 0, updated: 0, disabled: 0, blocked: 0, pages: 0, diagnostic: null };
    try {
      for await (const page of this.directory.pages()) {
        rep.pages++;
        // Cada página em sua transação: idempotente (upsert por GUID).
        await this.db.tx(async (tx) => {
          for (const e of page) {
            rep.seen++;
            const ex = await tx.query<IdentityRow>(
              'SELECT * FROM identity WHERE source = $1 AND directory_guid = $2 FOR UPDATE', [this.source, e.guid]);
            if (!ex.rows[0]) {
              const ins = await this.insertEntry(tx, e, runId);
              rep.created++;
              if (ins.status === 'blocked') rep.blocked++;
              if (ins.status === 'disabled') rep.disabled++;
            } else {
              const r = await this.applyAttributes(tx, ex.rows[0], e, runId);
              if (r === 'updated') rep.updated++;
              if (r === 'disabled') rep.disabled++;
              if (r === 'blocked') rep.blocked++;
            }
          }
        });
      }
    } catch (err) {
      rep.status = rep.seen > 0 ? 'partial' : 'failed';
      rep.diagnostic = sanitize((err as Error).message);
    }

    if (rep.status === 'ok') {
      const active = await this.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM identity WHERE source = $1 AND status = 'active'`, [this.source]);
      const prev = active.rows[0].n;
      if (rep.seen === 0 || (prev > 10 && rep.seen < prev * this.cfg.auth.syncAnomalyRatio)) {
        rep.status = 'aborted_anomaly';
        rep.diagnostic = `volume_anomalo: vistos=${rep.seen} ativos_anteriores=${prev}`;
      }
    }

    if (rep.status === 'ok') {
      // Ausência confirmada em sincronização completa e íntegra → desativação; sessões revogadas.
      await this.db.tx(async (tx) => {
        const gone = await tx.query<{ id: string }>(
          `UPDATE identity SET status = 'disabled', block_reason = 'ausente_no_diretorio', disabled_at = now(), updated_at = now()
           WHERE source = $1 AND status <> 'disabled' AND (last_seen_sync_id IS DISTINCT FROM $2)
           RETURNING id`, [this.source, runId]);
        for (const g of gone.rows) await this.revokeSessions(tx, g.id, 'ausente_no_diretorio');
        rep.disabled += gone.rowCount ?? 0;
        // Colisões que deixaram de existir são reavaliadas (ex.: GUID antigo desativado).
        const blocked = await tx.query<IdentityRow>(
          `SELECT * FROM identity WHERE source = $1 AND status = 'blocked' AND block_reason = 'colisao_login' ORDER BY imported_at FOR UPDATE`,
          [this.source]);
        for (const b of blocked.rows) {
          const clash = await tx.query(`SELECT 1 FROM identity WHERE source=$1 AND lower(login)=lower($2) AND status='active' AND id<>$3`,
            [this.source, b.login, b.id]);
          if (!clash.rowCount) await tx.query(`UPDATE identity SET status='active', block_reason=NULL, updated_at=now() WHERE id=$1`, [b.id]);
        }
      });
    } else {
      this.log.warn(`sincronização ${rep.status}: ${rep.diagnostic ?? ''} — desativações por ausência NÃO aplicadas`);
    }

    await this.db.query(
      `UPDATE directory_sync_run SET finished_at = now(), status = $2, seen = $3, created = $4, updated = $5, disabled = $6,
         blocked = $7, pages = $8, diagnostic = $9 WHERE id = $1`,
      [runId, rep.status, rep.seen, rep.created, rep.updated, rep.disabled, rep.blocked, rep.pages, rep.diagnostic]);
    await this.db.query(
      `INSERT INTO security_audit (action, target_type, target_id, outcome, detail) VALUES ('sincronizacao_diretorio','sync_run',$1,$2,$3)`,
      [runId, rep.status === 'ok' ? 'sucesso' : 'erro', JSON.stringify({ ...rep, runId: undefined })]);
    return rep;
  }

  /** Instante da última sincronização completa íntegra (para a janela de revalidação). */
  async lastGoodSync(): Promise<Date | null> {
    const r = await this.db.query<{ t: string | null }>(
      `SELECT max(finished_at) AS t FROM directory_sync_run WHERE source = $1 AND status = 'ok'`, [this.source]);
    return r.rows[0].t ? new Date(r.rows[0].t) : null;
  }

  /** Retrato dos atributos no instante da atuação; reaproveitado quando inalterado. */
  async snapshot(tx: Pick<Tx, 'query'>, identityId: string): Promise<string> {
    const r = await tx.query<IdentityRow>('SELECT * FROM identity WHERE id = $1', [identityId]);
    const i = r.rows[0];
    const fp = createHash('sha256').update(JSON.stringify([i.login, i.functional_id, i.display_name, i.unit_code, i.job_title])).digest('hex');
    const found = await tx.query<{ id: string }>(
      'SELECT id FROM identity_snapshot WHERE identity_id = $1 AND fingerprint = $2 ORDER BY captured_at DESC LIMIT 1', [identityId, fp]);
    if (found.rows[0]) return found.rows[0].id;
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO identity_snapshot (identity_id, login, functional_id, display_name, unit_code, job_title, fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [identityId, i.login, i.functional_id, i.display_name, i.unit_code, i.job_title, fp]);
    return ins.rows[0].id;
  }
}

/** Diagnóstico restrito: remove possíveis DNs, e-mails e números longos. */
export function sanitize(msg: string): string {
  return msg.replace(/(CN|OU|DC)=[^,\s)]+/gi, '$1=…').replace(/\S+@\S+/g, '…@…').slice(0, 300);
}
