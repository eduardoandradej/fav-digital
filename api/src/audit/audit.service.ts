import { Injectable, Logger } from '@nestjs/common';
import { Database, type Tx } from '../db/database.js';
import type { Actor } from '../authz/roles.js';

export type Outcome = 'sucesso' | 'negado' | 'rejeitado' | 'indisponivel' | 'erro';

/** Auditoria de acesso/segurança — separada das revisões de campo e dos eventos de custódia. */
@Injectable()
export class AuditService {
  private readonly log = new Logger('Auditoria');
  constructor(private readonly db: Database) {}

  async security(
    action: string,
    outcome: Outcome,
    opts: { actor?: Actor | null; identityId?: string | null; targetType?: string; targetId?: string; detail?: Record<string, unknown>; tx?: Pick<Tx, 'query'> } = {},
  ): Promise<void> {
    const q = opts.tx ?? this.db.pool;
    try {
      await q.query(
        `INSERT INTO security_audit (identity_id, unit_id, action, target_type, target_id, outcome, correlation_id, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [opts.actor?.identityId ?? opts.identityId ?? null, opts.actor?.unitId ?? null, action, opts.targetType ?? null,
          opts.targetId ?? null, outcome, opts.actor?.correlationId ?? null, JSON.stringify(opts.detail ?? {})]);
    } catch (e) {
      if (opts.tx) throw e;
      // Nunca registra conteúdo de vestígio, segredo ou credencial no log operacional.
      this.log.error(`falha ao gravar auditoria de segurança (${action}): ${(e as Error).message}`);
    }
  }
}
