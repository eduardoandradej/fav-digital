import { HttpException } from '@nestjs/common';

/** Erro de domínio com código estável, mensagem para o usuário e status HTTP. */
export class DomainError extends HttpException {
  constructor(status: number, readonly code: string, message: string, readonly details?: unknown) {
    super({ code, message, details }, status);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new DomainError(400, code, message, details);
export const unauthorized = (message = 'Sessão inválida ou expirada.') => new DomainError(401, 'NAO_AUTENTICADO', message);
export const forbidden = (code: string, message: string) => new DomainError(403, code, message);
export const notFound = (message = 'Registro não encontrado ou fora do escopo autorizado.') => new DomainError(404, 'NAO_ENCONTRADO', message);
export const conflict = (code: string, message: string, details?: unknown) => new DomainError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) => new DomainError(422, code, message, details);
export const unavailable = (code: string, message: string) => new DomainError(503, code, message);

/** Converte violações de restrições do PostgreSQL em conflitos compreensíveis. */
export function mapPgError(e: any): never {
  if (e && typeof e === 'object' && 'code' in e) {
    const c = (e as { code: string; constraint?: string }).code;
    const constraint = (e as { constraint?: string }).constraint ?? '';
    const known: Record<string, string> = {
      movement_one_active: 'Já existe uma transferência ativa para este vestígio.',
      seal_one_active: 'Já existe um lacre ativo para este vestígio.',
      seal_opening_one_open: 'Já existe abertura sem novo lacre para este vestígio.',
      fav_numero_unique: 'Número de FAV já utilizado por outro vestígio.',
      movement_fav_id_seq_key: 'Conflito de sequência de movimentação; recarregue a ficha.',
      sample_link_derivada_fav_id_key: 'Esta FAV já está vinculada a uma prova.',
      identity_active_login: 'Colisão de login entre identidades ativas.',
      seal_fav_id_ordinal_key: 'Conflito de ordem de lacre; recarregue a ficha.',
    };
    if (c === '23505' || c === '23P01') throw conflict('CONFLITO_RESTRICAO', known[constraint] ?? 'Conflito com registro existente.', { constraint });
    if (c === '23514' || c === '23502' || c === '23503') throw unprocessable('RESTRICAO_VIOLADA', 'Dados incompatíveis com as regras da ficha.', { constraint });
    if (c === '40001' || c === '40P01') throw conflict('CONFLITO_CONCORRENCIA', 'Conflito de concorrência; tente novamente.');
  }
  throw e;
}
