import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../tokens.js';
import { Database } from '../db/database.js';
import type { Actor, Role } from '../authz/roles.js';
import { IdentityService } from '../identity/identity.service.js';

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

@Injectable()
export class SessionService {
  constructor(
    private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly identities: IdentityService,
  ) {}

  /** Cria sessão opaca nova (o identificador é sempre renovado no login). */
  async create(identityId: string, unitId: string | null, clientHint: string | null): Promise<{ token: string; csrf: string }> {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    await this.db.query(
      `INSERT INTO app_session (token_hash, identity_id, unit_id, csrf_token, absolute_expires_at, client_hint)
       VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5), $6)`,
      [hashToken(token), identityId, unitId, csrf, this.cfg.session.absoluteHours, clientHint?.slice(0, 120) ?? null]);
    return { token, csrf };
  }

  async revoke(hash: Buffer, reason: string): Promise<void> {
    await this.db.query(`UPDATE app_session SET revoked_at = now(), revoke_reason = $2 WHERE token_hash = $1 AND revoked_at IS NULL`, [hash, reason]);
  }

  async setUnit(hash: Buffer, unitId: string): Promise<void> {
    await this.db.query('UPDATE app_session SET unit_id = $2 WHERE token_hash = $1', [hash, unitId]);
  }

  /**
   * Resolve a sessão a partir do token do cookie. Expira por inatividade e prazo absoluto.
   * A cada requisição revalida a identidade importada (ativa) e os papéis vigentes no banco.
   */
  async resolve(token: string): Promise<Actor | null> {
    const hash = hashToken(token);
    const r = await this.db.query(
      `SELECT s.*, i.status AS identity_status, i.login, i.functional_id, i.display_name, i.job_title, i.eligible_pcerj,
              (s.last_seen_at < now() - make_interval(mins => $2)) AS idle_expired,
              (s.absolute_expires_at < now()) AS abs_expired
         FROM app_session s JOIN identity i ON i.id = s.identity_id
        WHERE s.token_hash = $1`, [hash, this.cfg.session.idleMinutes]);
    const s = r.rows[0];
    if (!s || s.revoked_at) return null;
    if (s.idle_expired || s.abs_expired) {
      await this.revoke(hash, s.abs_expired ? 'expiracao_absoluta' : 'expiracao_inatividade');
      return null;
    }
    if (s.identity_status !== 'active') {
      await this.revoke(hash, `identidade_${s.identity_status}`);
      return null;
    }
    const roles = await this.db.query<{ role: Role; unit_id: string; code: string; name: string }>(
      `SELECT ra.role, ra.unit_id, u.code, u.name FROM role_assignment ra JOIN unit u ON u.id = ra.unit_id
        WHERE ra.identity_id = $1 AND ra.revoked_at IS NULL AND u.active ORDER BY u.code, ra.role`, [s.identity_id]);
    if (!roles.rowCount) {
      await this.revoke(hash, 'sem_autorizacao');
      return null;
    }
    const assignments = roles.rows.map((x) => ({ role: x.role, unitId: x.unit_id, unitCode: x.code, unitName: x.name }));
    let unitId: string | null = s.unit_id;
    if (unitId && !assignments.some((a) => a.unitId === unitId)) unitId = null; // papel revogado na unidade
    const unit = assignments.find((a) => a.unitId === unitId);
    await this.db.query('UPDATE app_session SET last_seen_at = now(), last_validated_at = now() WHERE token_hash = $1', [hash]);

    const last = await this.identities.lastGoodSync();
    const fresh = !!last && Date.now() - last.getTime() <= this.cfg.session.directoryStalenessHours * 3600_000;

    return {
      identityId: s.identity_id,
      login: s.login,
      functionalId: s.functional_id,
      displayName: s.display_name,
      jobTitle: s.job_title,
      eligible: s.eligible_pcerj,
      unitId,
      unitCode: unit?.unitCode ?? null,
      unitName: unit?.unitName ?? null,
      roles: assignments.filter((a) => a.unitId === unitId).map((a) => a.role),
      assignments,
      sessionHash: hash,
      csrf: s.csrf_token,
      directoryFresh: fresh,
      correlationId: randomUUID(),
    };
  }
}
