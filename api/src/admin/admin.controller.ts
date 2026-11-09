import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '../db/database.js';
import { conflict, forbidden, notFound, unprocessable } from '../common/errors.js';
import { parse } from '../common/validation.js';
import { requireRole } from '../authz/policy.js';
import { ROLES, type Actor } from '../authz/roles.js';
import { AuditService } from '../audit/audit.service.js';
import { IdentityService } from '../identity/identity.service.js';
import { CurrentActor } from '../session/auth.guard.js';

const Grant = z.object({ identidadeId: z.uuid(), papel: z.enum(ROLES), unidadeId: z.uuid(), motivo: z.string().trim().min(5).max(500) });
const Revoke = z.object({ motivo: z.string().trim().min(5).max(500) });

/**
 * Administração de configuração (piloto): atribuição AUDITADA de papéis a identidades já importadas
 * e disparo de sincronização. Não concede poder de registrar atos de custódia nem de consultar fichas.
 */
@Controller('admin')
export class AdminController {
  constructor(private readonly db: Database, private readonly identities: IdentityService, private readonly audit: AuditService) {}

  @Get('identidades')
  async list(@CurrentActor() a: Actor) {
    requireRole(a, 'ADMIN_CONFIG');
    const r = await this.db.query(
      `SELECT i.id, i.login, i.functional_id, i.display_name, i.unit_code, i.job_title, i.eligible_pcerj, i.status, i.block_reason,
              coalesce(json_agg(json_build_object('id', ra.id, 'papel', ra.role, 'unidade', u.code)) FILTER (WHERE ra.id IS NOT NULL), '[]') AS papeis
         FROM identity i LEFT JOIN role_assignment ra ON ra.identity_id = i.id AND ra.revoked_at IS NULL LEFT JOIN unit u ON u.id = ra.unit_id
        GROUP BY i.id ORDER BY i.display_name LIMIT 500`);
    return r.rows;
  }

  @Post('papeis')
  async grant(@CurrentActor() a: Actor, @Body() body: unknown) {
    requireRole(a, 'ADMIN_CONFIG');
    const b = parse(Grant, body);
    if (b.identidadeId === a.identityId) throw forbidden('AUTOATRIBUICAO', 'Não é permitido atribuir papéis a si mesmo.');
    const i = await this.identities.byId(b.identidadeId);
    if (!i || i.status !== 'active') throw unprocessable('IDENTIDADE_INVALIDA', 'Identidade inexistente ou não ativa (somente identidades importadas).');
    try {
      const r = await this.db.query(
        `INSERT INTO role_assignment (identity_id, role, unit_id, granted_by, reason) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [b.identidadeId, b.papel, b.unidadeId, a.identityId, b.motivo]);
      await this.audit.security('atribuicao_papel', 'sucesso', { actor: a, targetType: 'identity', targetId: b.identidadeId, detail: { papel: b.papel, unidadeId: b.unidadeId, atribuicaoId: r.rows[0].id } });
      return { id: r.rows[0].id };
    } catch (e: any) {
      if (e.code === '23505') throw conflict('PAPEL_JA_ATRIBUIDO', 'Papel já atribuído nesta unidade.');
      throw e;
    }
  }

  @Post('papeis/:id/revogacao') @HttpCode(200)
  async revoke(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireRole(a, 'ADMIN_CONFIG');
    const b = parse(Revoke, body);
    const r = await this.db.query(
      `UPDATE role_assignment SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1 AND revoked_at IS NULL RETURNING identity_id`,
      [id, a.identityId, b.motivo]);
    if (!r.rowCount) throw notFound();
    await this.audit.security('revogacao_papel', 'sucesso', { actor: a, targetType: 'role_assignment', targetId: id, detail: { identidadeId: r.rows[0].identity_id } });
    return { ok: true };
  }

  @Post('sincronizacao') @HttpCode(200)
  async sync(@CurrentActor() a: Actor) {
    requireRole(a, 'ADMIN_CONFIG');
    const rep = await this.identities.syncFull();
    await this.audit.security('sincronizacao_manual', rep.status === 'ok' ? 'sucesso' : 'erro', { actor: a, targetType: 'sync_run', targetId: rep.runId });
    return rep;
  }

  @Get('sincronizacoes')
  async runs(@CurrentActor() a: Actor) {
    requireRole(a, 'ADMIN_CONFIG');
    return (await this.db.query(`SELECT * FROM directory_sync_run ORDER BY started_at DESC LIMIT 50`)).rows;
  }
}
