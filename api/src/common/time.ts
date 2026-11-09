import { unprocessable } from './errors.js';

/** Tolerância para relógios de estação ligeiramente adiantados. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
/** A partir deste atraso, o lançamento é "posterior" e exige motivação. */
export const LATE_ENTRY_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function checkEffectiveAt(iso: string, label: string, now = Date.now()): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw unprocessable('DATA_INVALIDA', `${label}: data/hora inválida.`);
  if (d.getTime() > now + FUTURE_TOLERANCE_MS) throw unprocessable('DATA_FUTURA', `${label}: data/hora no futuro não é permitida.`);
  if (d.getUTCFullYear() < 1990) throw unprocessable('DATA_INCOERENTE', `${label}: data/hora incoerente.`);
  return d;
}

export function requireLateReason(effective: Date, reason: string | null | undefined, label: string, now = Date.now()): string | null {
  if (now - effective.getTime() > LATE_ENTRY_THRESHOLD_MS) {
    if (!reason || reason.trim().length < 5) {
      throw unprocessable('LANCAMENTO_POSTERIOR_SEM_MOTIVO', `${label}: lançamento posterior (mais de 24 h após o ato) exige motivo.`);
    }
    return reason.trim();
  }
  return reason?.trim() || null;
}

export function assertOrder(before: Date | string | null | undefined, after: Date, message: string): void {
  if (!before) return;
  const b = typeof before === 'string' ? new Date(before) : before;
  if (after.getTime() < b.getTime()) throw unprocessable('DATAS_INCOERENTES', message);
}
