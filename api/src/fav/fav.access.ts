import { Injectable } from '@nestjs/common';
import { Database, type Tx } from '../db/database.js';
import { conflict, forbidden, notFound } from '../common/errors.js';
import { READER_ROLES, type Actor } from '../authz/roles.js';
import { AuditService } from '../audit/audit.service.js';

export interface FavRow {
  id: string; draft_code: string; kind: 'regular' | 'grande_porte'; numero: string | null; numero_year: number | null;
  origin_unit_id: string; status: string; physical_state: string; custodian_kind: string | null;
  custodian_identity_id: string | null; custodian_intervener_id: string | null; custodian_unit_id: string | null;
  version: number; coleta_confirmed_at: string | null; created_by: string; [k: string]: any;
}

@Injectable()
export class FavAccess {
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  canRead(actor: Actor): boolean {
    return !!actor.unitId && actor.roles.some((r) => READER_ROLES.includes(r));
  }

  /**
   * Leitura no escopo da unidade selecionada. Acesso por ID direto fora do escopo devolve 404
   * (não revela existência) e é auditado.
   */
  async loadForRead(actor: Actor, favId: string, q: Pick<Tx, 'query'> = this.db.pool): Promise<FavRow> {
    if (!/^[0-9a-f-]{36}$/i.test(favId)) throw notFound();
    const r = await q.query<FavRow>(`SELECT * FROM fav WHERE id = $1 AND fav.fav_in_unit(id, $2)`, [favId, actor.unitId]);
    if (!r.rows[0] || !this.canRead(actor)) {
      await this.audit.security('consulta_fav', 'negado', { actor, targetType: 'fav', targetId: favId });
      throw notFound();
    }
    return r.rows[0];
  }

  /** Bloqueia a linha da FAV para o comando; verifica a versão esperada quando informada (perda de atualização). */
  async lockForWrite(tx: Tx, actor: Actor, favId: string, expectedVersion?: number): Promise<FavRow> {
    if (!/^[0-9a-f-]{36}$/i.test(favId)) throw notFound();
    const r = await tx.query<FavRow>(`SELECT * FROM fav WHERE id = $1 FOR UPDATE`, [favId]);
    const f = r.rows[0];
    if (!f) throw notFound();
    const inScope = await tx.query<{ ok: boolean }>(`SELECT fav.fav_in_unit($1, $2) AS ok`, [favId, actor.unitId]);
    if (!inScope.rows[0].ok) {
      await this.audit.security('escrita_fav', 'negado', { actor, targetType: 'fav', targetId: favId });
      throw notFound();
    }
    if (expectedVersion !== undefined && expectedVersion !== f.version) {
      throw conflict('VERSAO_DESATUALIZADA', 'A ficha foi alterada por outra pessoa. Recarregue para ver a versão atual antes de salvar.',
        { versaoAtual: f.version, versaoInformada: expectedVersion });
    }
    return f;
  }

  async bumpVersion(tx: Tx, favId: string, sets: Record<string, unknown> = {}): Promise<number> {
    const keys = Object.keys(sets);
    const assignments = keys.map((k, i) => `${k} = $${i + 2}`);
    const r = await tx.query<{ version: number }>(
      `UPDATE fav SET ${[...assignments, 'version = version + 1', 'updated_at = now()'].join(', ')} WHERE id = $1 RETURNING version`,
      [favId, ...keys.map((k) => sets[k])]);
    return r.rows[0].version;
  }

  /** O ator atua pela unidade custodiante? */
  requireCustodianUnit(actor: Actor, f: FavRow): void {
    if (!f.custodian_unit_id || f.custodian_unit_id !== actor.unitId) {
      throw forbidden('FORA_DA_CUSTODIA', 'A unidade selecionada não detém a custódia deste vestígio.');
    }
  }

  requireNotClosed(f: FavRow): void {
    if (f.status === 'encerrado') throw conflict('FICHA_ENCERRADA', 'Cadeia de custódia encerrada na SEPOL; a ficha permanece apenas para consulta e exportação.');
  }
}
