/** Contratos do diretório institucional (AD) e utilitários LDAP. */

export interface DirectoryEntry {
  guid: string;            // forma canônica do objectGUID
  login: string;           // sAMAccountName
  functionalId: string;
  displayName: string;
  unitCode: string | null;
  jobTitle: string | null;
  memberOf: string[];
  disabled: boolean;       // userAccountControl ACCOUNTDISABLE (0x2)
  /** GUID válido, porém sem atributos mínimos: a identidade fica bloqueada até reconciliação. */
  incomplete?: boolean;
}

export type AuthOutcome =
  | { outcome: 'success'; entry: DirectoryEntry }
  | { outcome: 'rejected'; reason: 'credencial' | 'nao_encontrado' | 'ambiguo' | 'incompleto' }
  | { outcome: 'unavailable'; diagnostic: string };

/** Provedor de autenticação individual (credencial do próprio usuário). */
export interface AuthProvider {
  readonly kind: string;
  authenticate(login: string, password: string): Promise<AuthOutcome>;
}

/** Fonte de sincronização (identidade técnica de leitura). Entrega páginas de entradas. */
export interface DirectorySource {
  readonly source: string;
  pages(): AsyncIterable<DirectoryEntry[]>;
}

export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');
export const DIRECTORY_SOURCE = Symbol('DIRECTORY_SOURCE');

/** RFC 4515: escapa valores usados em filtros LDAP. */
export function escapeLdapFilterValue(v: string): string {
  return v.replace(/[\\*()\u0000]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

/**
 * Converte o objectGUID binário (16 bytes, little-endian nos 3 primeiros campos)
 * para a forma textual canônica usada pelo AD.
 */
export function guidFromBytes(b: Buffer): string {
  if (b.length !== 16) throw new Error('objectGUID com tamanho inesperado');
  const hex = (x: Buffer) => x.toString('hex');
  const le = (start: number, len: number) => hex(Buffer.from(b.subarray(start, start + len)).reverse());
  return `${le(0, 4)}-${le(4, 2)}-${le(6, 2)}-${hex(b.subarray(8, 10))}-${hex(b.subarray(10, 16))}`.toLowerCase();
}

/** Interpreta a saída LDIF (-LLL) do ldapsearch, inclusive valores base64 (`attr::`) e linhas continuadas. */
export function parseLdif(text: string): Array<Record<string, Buffer[]>> {
  const entries: Array<Record<string, Buffer[]>> = [];
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const unfolded = block.replace(/\n /g, '');
    const lines = unfolded.split('\n').filter((l) => l && !l.startsWith('#'));
    if (!lines.length) continue;
    const rec: Record<string, Buffer[]> = {};
    for (const line of lines) {
      const m = /^([A-Za-z0-9;-]+)(::?)\s?(.*)$/.exec(line);
      if (!m) continue;
      const [, key, sep, val] = m;
      const buf = sep === '::' ? Buffer.from(val, 'base64') : Buffer.from(val, 'utf8');
      const k = key.toLowerCase();
      (rec[k] ??= []).push(buf);
    }
    if (rec['dn']) entries.push(rec);
  }
  return entries;
}

export interface AttributeMap {
  guid: string; login: string; functionalId: string; displayName: string; unit: string; title: string;
  memberOf: string; userAccountControl: string;
}

export function entryFromLdif(rec: Record<string, Buffer[]>, a: AttributeMap): DirectoryEntry | null {
  const s = (k: string) => rec[k.toLowerCase()]?.[0]?.toString('utf8')?.trim() || null;
  const guidRaw = rec[a.guid.toLowerCase()]?.[0];
  const login = s(a.login);
  const displayName = s(a.displayName);
  const functionalId = s(a.functionalId);
  if (!guidRaw || guidRaw.length !== 16) return null;
  const incomplete = !login || !displayName || !functionalId;
  const uac = Number(s(a.userAccountControl) ?? '0');
  return {
    guid: guidFromBytes(guidRaw),
    login: login ?? '',
    functionalId: functionalId ?? '',
    displayName: displayName ?? '',
    incomplete,
    unitCode: s(a.unit),
    jobTitle: s(a.title),
    memberOf: (rec[a.memberOf.toLowerCase()] ?? []).map((b) => b.toString('utf8')),
    disabled: Number.isFinite(uac) && (uac & 0x2) === 0x2,
  };
}
