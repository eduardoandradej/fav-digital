/**
 * Adaptador do padrão validado no SGE:
 *   kinit com a credencial informada → ldapsearch SASL/GSSAPI (minssf) → sAMAccountName único.
 * Sem fallback para bind simples, senha local ou LDAP sem proteção.
 * Cache de tickets exclusivo por tentativa em área temporária privada (tmpfs), removido inclusive em falha.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import {
  type AuthOutcome, type AuthProvider, type DirectoryEntry, type DirectorySource,
  entryFromLdif, escapeLdapFilterValue, parseLdif,
} from './directory.js';
import { runFixed, type RunResult } from './process-runner.js';

type KrbCfg = AppConfig['auth']['kerberos'];

/** Classificação de falhas do kinit sem expor a saída bruta. */
export function classifyKinit(r: RunResult): 'ok' | 'rejected' | 'unavailable' {
  if (r.timedOut || r.code === -1) return 'unavailable';
  if (r.code === 0) return 'ok';
  const e = r.stderr.toLowerCase();
  const rejected = ['preauthentication failed', 'password incorrect', 'client not found', 'not found in kerberos database',
    'revoked', 'expired', 'locked out', 'password has expired', 'clients credentials have been revoked'];
  if (rejected.some((p) => e.includes(p))) return 'rejected';
  return 'unavailable';
}

/** Ambiente mínimo para os executáveis: sem herdar segredos do processo pai. */
function toolEnv(cfg: KrbCfg, ccache: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', KRB5CCNAME: `FILE:${ccache}` };
  if (cfg.krb5Config) env.KRB5_CONFIG = cfg.krb5Config;
  return env;
}

async function withPrivateCcache<T>(cfg: KrbCfg, fn: (ccache: string) => Promise<T>): Promise<T> {
  await mkdir(cfg.ccacheDir, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(cfg.ccacheDir, 'a-'));
  const ccache = join(dir, `cc_${randomBytes(8).toString('hex')}`);
  try {
    return await fn(ccache);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ldapArgs(cfg: KrbCfg, base: string, filter: string, attrs: string[], paged: boolean): string[] {
  const args = ['-LLL', '-Q', '-Y', 'GSSAPI', '-O', `minssf=${cfg.saslMinSsf}`, '-H', cfg.ldapUri, '-b', base,
    '-o', `nettimeout=${Math.ceil(cfg.timeoutMs / 1000)}`, '-l', String(Math.ceil(cfg.timeoutMs / 1000))];
  if (cfg.saslNoCanon) args.push('-N');
  if (paged) args.push('-E', 'pr=500/noprompt');
  args.push(filter, ...attrs);
  return args;
}

/** Códigos de saída do ldapsearch que indicam rejeição de credencial/autorização. */
const LDAP_REJECT_CODES = new Set([49, 50]);

export class KerberosLdapProvider implements AuthProvider {
  readonly kind = 'kerberos-ldap';
  constructor(private readonly cfg: AppConfig['auth']) {}

  async authenticate(login: string, password: string): Promise<AuthOutcome> {
    const k = this.cfg.kerberos;
    const principal = `${login}@${k.realm}`;
    return withPrivateCcache(k, async (ccache) => {
      const env = toolEnv(k, ccache);
      const kinit = await runFixed(k.kinitPath, ['-c', `FILE:${ccache}`, principal], {
        env, stdin: `${password}\n`, timeoutMs: k.timeoutMs, maxOutputBytes: 8192,
      });
      const kc = classifyKinit(kinit);
      if (kc === 'rejected') return { outcome: 'rejected', reason: 'credencial' };
      if (kc === 'unavailable') return { outcome: 'unavailable', diagnostic: kinit.timedOut ? 'kinit_timeout' : `kinit_exit_${kinit.code}` };

      const a = this.cfg.attributes;
      const filter = `(&(objectClass=user)(${a.login}=${escapeLdapFilterValue(login)}))`;
      const attrs = [a.guid, a.login, a.functionalId, a.displayName, a.unit, a.title, a.memberOf, a.userAccountControl];
      const ls = await runFixed(k.ldapsearchPath, ldapArgs(k, k.baseDn, filter, attrs, false), {
        env, timeoutMs: k.timeoutMs, maxOutputBytes: k.maxOutputBytes,
      });
      if (ls.timedOut || ls.truncated || ls.code === -1) return { outcome: 'unavailable', diagnostic: ls.timedOut ? 'ldap_timeout' : 'ldap_falha_execucao' };
      if (ls.code !== 0) {
        if (LDAP_REJECT_CODES.has(ls.code ?? 0)) return { outcome: 'rejected', reason: 'credencial' };
        return { outcome: 'unavailable', diagnostic: `ldap_exit_${ls.code}` };
      }
      const recs = parseLdif(ls.stdout);
      // Correspondência única e exata do sAMAccountName (comparação sem diferenciar maiúsculas, como o AD).
      const entries = recs.map((r) => entryFromLdif(r, a)).filter((e): e is DirectoryEntry => !!e && e.login.toLowerCase() === login.toLowerCase());
      if (recs.length > 1 || entries.length > 1) return { outcome: 'rejected', reason: 'ambiguo' };
      if (recs.length === 0) return { outcome: 'rejected', reason: 'nao_encontrado' };
      if (entries.length === 0 || entries[0].incomplete) return { outcome: 'rejected', reason: 'incompleto' };
      return { outcome: 'success', entry: entries[0] };
    });
  }
}

/** Fonte de sincronização via identidade técnica (keytab), com consulta paginada. */
export class LdapDirectorySource implements DirectorySource {
  readonly source: string;
  constructor(private readonly cfg: AppConfig['auth']) { this.source = cfg.directorySource; }

  async *pages(): AsyncIterable<DirectoryEntry[]> {
    const k = this.cfg.kerberos;
    if (!this.cfg.syncKeytab || !this.cfg.syncPrincipal) throw new Error('SYNC_KEYTAB_FILE/SYNC_PRINCIPAL não configurados');
    const all = await withPrivateCcache(k, async (ccache) => {
      const env = toolEnv(k, ccache);
      const kinit = await runFixed(k.kinitPath, ['-k', '-t', this.cfg.syncKeytab!, '-c', `FILE:${ccache}`, this.cfg.syncPrincipal!], {
        env, timeoutMs: k.timeoutMs, maxOutputBytes: 8192,
      });
      if (classifyKinit(kinit) !== 'ok') throw new Error(`identidade técnica: kinit falhou (${kinit.timedOut ? 'timeout' : kinit.code})`);
      const a = this.cfg.attributes;
      const attrs = [a.guid, a.login, a.functionalId, a.displayName, a.unit, a.title, a.memberOf, a.userAccountControl];
      const ls = await runFixed(k.ldapsearchPath, ldapArgs(k, k.baseDn, this.cfg.importFilter, attrs, true), {
        env, timeoutMs: k.timeoutMs * 30, maxOutputBytes: 512 * 1024 * 1024,
      });
      if (ls.code !== 0 || ls.timedOut || ls.truncated) throw new Error(`consulta de sincronização incompleta (${ls.timedOut ? 'timeout' : ls.code})`);
      return parseLdif(ls.stdout);
    });
    const page: DirectoryEntry[] = [];
    for (const rec of all) {
      const e = entryFromLdif(rec, this.cfg.attributes);
      if (e) page.push(e);
      if (page.length === 500) yield page.splice(0);
    }
    if (page.length) yield page;
  }
}
