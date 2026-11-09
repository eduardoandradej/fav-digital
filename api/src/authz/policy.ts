import { forbidden } from '../common/errors.js';
import type { Actor, Role } from './roles.js';

/** Vínculo elegível + identidade ativa: exigido em TODA operação de preenchimento, inclusive via API direta. */
export function requireFiller(a: Actor): void {
  if (!a.eligible) throw forbidden('SEM_VINCULO_ELEGIVEL', 'Sua identidade não possui vínculo elegível como servidor da PCERJ para preencher a FAV.');
  if (!a.unitId) throw forbidden('SEM_CONTEXTO_UNIDADE', 'Selecione um contexto de unidade autorizado.');
}

export function hasRole(a: Actor, ...roles: Role[]): boolean {
  return roles.some((r) => a.roles.includes(r));
}

export function requireRole(a: Actor, ...roles: Role[]): Role {
  const r = roles.find((x) => a.roles.includes(x));
  if (!r) throw forbidden('PAPEL_INSUFICIENTE', `Operação exige papel: ${roles.join(' ou ')} na unidade selecionada.`);
  return r;
}

/** Atos de custódia são bloqueados quando a identidade/autorização não pôde ser revalidada na janela. */
export function requireCustodyAct(a: Actor): void {
  requireFiller(a);
  if (!a.directoryFresh) {
    throw forbidden('IDENTIDADE_NAO_REVALIDADA',
      'Não foi possível revalidar identidades no diretório dentro da janela estabelecida. Atos de custódia estão temporariamente bloqueados.');
  }
}
