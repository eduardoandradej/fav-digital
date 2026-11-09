/**
 * Infraestrutura comum dos atos: contexto de autoria obtido no servidor, revisões de campo,
 * eventos de cadeia de custódia e idempotência de comandos de confirmação.
 */
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Tx } from '../db/database.js';
import type { Actor, Role } from '../authz/roles.js';
import { IdentityService } from '../identity/identity.service.js';
import { badRequest, conflict } from './errors.js';

export interface ActContext {
  actor: Actor;
  snapshotId: string;
  role: Role | null;
}

export type RevisionAction = 'preenchimento' | 'alteracao' | 'remocao' | 'retificacao' | 'automatico' | 'transcricao';

export interface RevisionInput {
  entity: string;
  key: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  action: RevisionAction;
  reason?: string | null;
  origin?: 'humano' | 'automatico' | 'transcricao';
  sourceRef?: string | null;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Ação de revisão derivada do valor anterior/novo e do estado da ficha. */
export function revisionAction(oldV: unknown, newV: unknown, isDraft: boolean): RevisionAction {
  const empty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0) || v === '';
  if (empty(oldV) && !empty(newV)) return 'preenchimento';
  if (!isDraft) return 'retificacao';
  if (empty(newV)) return 'remocao';
  return 'alteracao';
}

@Injectable()
export class ActWriter {
  constructor(private readonly identities: IdentityService) {}

  async context(tx: Tx, actor: Actor, role: Role | null): Promise<ActContext> {
    // Autoria e contexto vêm da sessão no servidor, independentemente do que o cliente envie.
    return { actor, snapshotId: await this.identities.snapshot(tx, actor.identityId), role };
  }

  async event(tx: Tx, ctx: ActContext, e: {
    favId: string; type: string; favVersion: number; summary: string; effectiveAt?: string | Date | null;
    statusBefore?: string | null; statusAfter?: string | null; movementId?: string | null; payload?: Record<string, unknown>;
    lateEntryReason?: string | null;
  }): Promise<number> {
    const r = await tx.query<{ id: number }>(
      `INSERT INTO custody_event (fav_id, type, effective_at, actor_identity_id, actor_snapshot_id, actor_unit_id, actor_role,
         fav_version, status_before, status_after, movement_id, summary, payload, late_entry_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [e.favId, e.type, e.effectiveAt ?? null, ctx.actor.identityId, ctx.snapshotId, ctx.actor.unitId, ctx.role, e.favVersion,
        e.statusBefore ?? null, e.statusAfter ?? null, e.movementId ?? null, e.summary, JSON.stringify(e.payload ?? {}),
        e.lateEntryReason ?? null]);
    return r.rows[0].id;
  }

  async revisions(tx: Tx, ctx: ActContext, favId: string, favVersion: number, items: RevisionInput[], eventId: number | null): Promise<void> {
    for (const it of items) {
      if (it.action === 'retificacao' && !it.reason) throw badRequest('MOTIVO_OBRIGATORIO', `Retificação de "${it.field}" exige motivo.`);
      await tx.query(
        `INSERT INTO field_revision (fav_id, entity, entity_key, field, old_value, new_value, action, fav_version,
           author_identity_id, author_snapshot_id, author_unit_id, author_role, reason, origin, source_ref, custody_event_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [favId, it.entity, it.key, it.field, JSON.stringify(it.oldValue ?? null), JSON.stringify(it.newValue ?? null), it.action,
          favVersion, ctx.actor.identityId, ctx.snapshotId, ctx.actor.unitId, ctx.role, it.reason ?? null,
          it.origin ?? (it.action === 'automatico' ? 'automatico' : 'humano'), it.sourceRef ?? null, eventId]);
    }
  }

  /** Revisões de "preenchimento" para todos os campos não vazios de um item recém-criado. */
  creationRevisions(entity: string, key: string, row: Record<string, unknown>, fields: string[]): RevisionInput[] {
    return fields
      .filter((f) => row[f] !== null && row[f] !== undefined && row[f] !== '')
      .map((f) => ({ entity, key, field: f, oldValue: null, newValue: row[f], action: 'preenchimento' as const }));
  }
}

/**
 * Idempotência vinculada a ator + operação + conteúdo: reenvio idêntico devolve o resultado original;
 * mesma chave com conteúdo divergente gera conflito. O registro é gravado na mesma transação do ato.
 */
export async function withIdempotency<T>(
  tx: Tx, actor: Actor, key: string | undefined, operation: string, body: unknown, fn: () => Promise<T>,
): Promise<{ replay: boolean; result: T }> {
  if (!key || key.length < 8 || key.length > 128) {
    throw badRequest('IDEMPOTENCY_KEY_OBRIGATORIA', 'Comandos de confirmação exigem o cabeçalho Idempotency-Key (8 a 128 caracteres).');
  }
  const hash = createHash('sha256').update(operation + '\u0000' + JSON.stringify(body ?? null)).digest('hex');
  const ins = await tx.query(
    `INSERT INTO idempotency_record (actor_identity_id, key, operation, request_hash) VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING RETURNING key`, [actor.identityId, key, operation, hash]);
  if (!ins.rowCount) {
    const ex = await tx.query(`SELECT operation, request_hash, response FROM idempotency_record WHERE actor_identity_id = $1 AND key = $2`,
      [actor.identityId, key]);
    const row = ex.rows[0];
    if (!row || row.operation !== operation || row.request_hash !== hash) {
      throw conflict('IDEMPOTENCY_CONFLITO', 'A chave de idempotência já foi usada com conteúdo diferente.');
    }
    return { replay: true, result: row.response as T };
  }
  const result = await fn();
  await tx.query(`UPDATE idempotency_record SET response = $3, status_code = 200 WHERE actor_identity_id = $1 AND key = $2`,
    [actor.identityId, key, JSON.stringify(result ?? null)]);
  return { replay: false, result };
}
