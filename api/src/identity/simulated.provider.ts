/**
 * Diretório SIMULADO e isolado — somente perfis development/test.
 * Contém apenas identidades sintéticas. O perfil institucional recusa este provedor (config.ts).
 */
import { scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AuthOutcome, AuthProvider, DirectoryEntry, DirectorySource } from './directory.js';

export interface SimulatedAccount extends DirectoryEntry { passwordHash: string; foraDoEscopo?: boolean }

export function hashSyntheticPassword(password: string, salt: string): string {
  return ['scrypt', salt, scryptSync(password, salt, 32).toString('hex')].join('$');
}

function verify(password: string, stored: string): boolean {
  const [alg, salt, hex] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hex) return false;
  const a = Buffer.from(hashSyntheticPassword(password, salt).split('$')[2], 'hex');
  const b = Buffer.from(hex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const DUMMY_HASH = ['scrypt', '0000000000000000', '0'.repeat(64)].join('$');

export class SimulatedDirectory implements AuthProvider, DirectorySource {
  readonly kind = 'simulated';
  readonly source: string;
  accounts: SimulatedAccount[];
  /** Permite simular indisponibilidade do diretório em testes. */
  available = true;
  /** Permite simular falha no meio da sincronização (após N páginas). */
  failAfterPages: number | null = null;
  pageSize = 3;

  constructor(file: string, source = 'sim') {
    this.source = source;
    const data = JSON.parse(readFileSync(file, 'utf8')) as { accounts: SimulatedAccount[] };
    this.accounts = data.accounts;
  }

  async authenticate(login: string, password: string): Promise<AuthOutcome> {
    if (!this.available) return { outcome: 'unavailable', diagnostic: 'simulador_indisponivel' };
    const matches = this.accounts.filter((a) => a.login.toLowerCase() === login.toLowerCase() && !a.disabled);
    // Custo de verificação constante mesmo sem conta, para não revelar existência.
    const ok = verify(password, matches[0]?.passwordHash ?? DUMMY_HASH);
    if (matches.length === 0 || !ok) return { outcome: 'rejected', reason: 'credencial' };
    if (matches.length > 1) return { outcome: 'rejected', reason: 'ambiguo' };
    const { passwordHash: _ignored, foraDoEscopo: _f, ...entry } = matches[0];
    if (entry.incomplete) return { outcome: 'rejected', reason: 'incompleto' };
    return { outcome: 'success', entry };
  }

  async *pages(): AsyncIterable<DirectoryEntry[]> {
    if (!this.available) throw new Error('simulador_indisponivel');
    let n = 0;
    for (let i = 0; i < this.accounts.length; i += this.pageSize) {
      if (this.failAfterPages !== null && n >= this.failAfterPages) throw new Error('falha_simulada_paginacao');
      n++;
      // Contas fora do escopo de importação (OU/grupo/filtro) não são entregues à sincronização.
      yield this.accounts.slice(i, i + this.pageSize).filter((a) => !a.foraDoEscopo).map(({ passwordHash: _p, foraDoEscopo: _f, ...e }) => e);
    }
  }
}
