/**
 * Configuração por variáveis de ambiente. Valores sensíveis (senhas de banco, keytabs)
 * chegam por arquivos/segredos montados pela infraestrutura; nunca por argumentos de processo.
 */
import { readFileSync } from 'node:fs';
import { findUp } from './paths.js';

export type Profile = 'development' | 'test' | 'homologacao' | 'producao';
export type AuthProviderKind = 'simulated' | 'kerberos-ldap';

export interface AppConfig {
  profile: Profile;
  institutional: boolean;
  port: number;
  host: string;
  trustProxy: string | boolean;
  publicDir: string | null;
  db: { connectionString: string; poolMax: number; statementTimeoutMs: number };
  session: {
    cookieName: string;
    csrfCookieName: string;
    secureCookie: boolean;
    idleMinutes: number;
    absoluteHours: number;
    /** Prazo máximo desde a última sincronização bem-sucedida para permitir atos de custódia. */
    directoryStalenessHours: number;
  };
  login: { pattern: RegExp; stripHyphen: boolean; maxFailures: number; maxFailuresPerIp: number; windowMinutes: number; lockMinutes: number };
  auth: {
    provider: AuthProviderKind;
    directorySource: string;
    simulatedDirectoryFile: string;
    kerberos: {
      realm: string;
      krb5Config: string | null;
      kinitPath: string;
      ldapsearchPath: string;
      ldapUri: string;
      baseDn: string;
      saslMinSsf: number;
      saslNoCanon: boolean;
      timeoutMs: number;
      maxOutputBytes: number;
      ccacheDir: string;
    };
    attributes: {
      guid: string; login: string; functionalId: string; displayName: string; unit: string; title: string;
      memberOf: string; userAccountControl: string;
    };
    importFilter: string;
    eligibleGroupDn: string | null;
    syncKeytab: string | null;
    syncPrincipal: string | null;
    syncAnomalyRatio: number;
  };
  timezone: string;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'sim'].includes(v.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Valor inválido para ${name}`);
  return n;
}

/** Lê DATABASE_URL diretamente ou de DATABASE_URL_FILE (segredo montado). */
function databaseUrl(): string {
  const file = process.env.DATABASE_URL_FILE;
  if (file) return readFileSync(file, 'utf8').trim();
  return env('DATABASE_URL', 'postgres://fav_app:devonly@localhost:5432/fav');
}

export function loadConfig(): AppConfig {
  const profile = env('FAV_PROFILE', 'development') as Profile;
  if (!['development', 'test', 'homologacao', 'producao'].includes(profile)) {
    throw new Error(`FAV_PROFILE inválido: ${profile}`);
  }
  const institutional = profile === 'homologacao' || profile === 'producao';
  const provider = env('AUTH_PROVIDER', institutional ? 'kerberos-ldap' : 'simulated') as AuthProviderKind;
  const secureCookie = envBool('SESSION_COOKIE_SECURE', institutional);

  const cfg: AppConfig = {
    profile,
    institutional,
    port: envInt('PORT', 8080),
    host: env('HOST', '0.0.0.0'),
    trustProxy: process.env.TRUST_PROXY ? (process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY) : false,
    publicDir: process.env.PUBLIC_DIR || null,
    db: {
      connectionString: databaseUrl(),
      poolMax: envInt('DB_POOL_MAX', 10),
      statementTimeoutMs: envInt('DB_STATEMENT_TIMEOUT_MS', 15000),
    },
    session: {
      cookieName: secureCookie ? '__Host-fav_sid' : 'fav_sid',
      csrfCookieName: secureCookie ? '__Host-fav_csrf' : 'fav_csrf',
      secureCookie,
      idleMinutes: envInt('SESSION_IDLE_MINUTES', 30),
      absoluteHours: envInt('SESSION_ABSOLUTE_HOURS', 10),
      directoryStalenessHours: envInt('DIRECTORY_STALENESS_HOURS', 26),
    },
    login: {
      // Referência do SGE homologado: 2 a 20 dígitos, hífen facultativo antes do último dígito.
      pattern: new RegExp(env('LOGIN_PATTERN', '^\\d{1,19}-?\\d$')),
      stripHyphen: envBool('LOGIN_STRIP_HYPHEN', true),
      maxFailures: envInt('LOGIN_MAX_FAILURES', 5),
      maxFailuresPerIp: envInt('LOGIN_MAX_FAILURES_PER_IP', 50),
      windowMinutes: envInt('LOGIN_WINDOW_MINUTES', 15),
      lockMinutes: envInt('LOGIN_LOCK_MINUTES', 15),
    },
    auth: {
      provider,
      directorySource: env('DIRECTORY_SOURCE', provider === 'simulated' ? 'sim' : 'ad-pcerj'),
      simulatedDirectoryFile: env('SIMULATED_DIRECTORY_FILE', findUp('seed/diretorio-sintetico.json')),
      kerberos: {
        realm: env('KRB5_REALM', 'EXEMPLO.INVALID'),
        krb5Config: process.env.KRB5_CONFIG || null,
        kinitPath: env('KINIT_PATH', '/usr/bin/kinit'),
        ldapsearchPath: env('LDAPSEARCH_PATH', '/usr/bin/ldapsearch'),
        ldapUri: env('LDAP_URI', 'ldap://dc.exemplo.invalid:389'),
        baseDn: env('LDAP_BASE_DN', 'DC=exemplo,DC=invalid'),
        saslMinSsf: envInt('LDAP_SASL_MINSSF', 128),
        saslNoCanon: envBool('LDAP_SASL_NOCANON', false),
        timeoutMs: envInt('AUTH_TIMEOUT_MS', 8000),
        maxOutputBytes: envInt('AUTH_MAX_OUTPUT_BYTES', 262144),
        ccacheDir: env('KRB5_CCACHE_DIR', '/dev/shm/fav-krb'),
      },
      attributes: {
        guid: env('LDAP_ATTR_GUID', 'objectGUID'),
        login: env('LDAP_ATTR_LOGIN', 'sAMAccountName'),
        functionalId: env('LDAP_ATTR_FUNCTIONAL_ID', 'sAMAccountName'),
        displayName: env('LDAP_ATTR_DISPLAY_NAME', 'displayName'),
        unit: env('LDAP_ATTR_UNIT', 'department'),
        title: env('LDAP_ATTR_TITLE', 'title'),
        memberOf: env('LDAP_ATTR_MEMBER_OF', 'memberOf'),
        userAccountControl: env('LDAP_ATTR_UAC', 'userAccountControl'),
      },
      importFilter: env('LDAP_IMPORT_FILTER', '(&(objectCategory=person)(objectClass=user))'),
      eligibleGroupDn: process.env.LDAP_ELIGIBLE_GROUP_DN || (provider === 'simulated' ? 'CN=FAV-Servidores-PCERJ,OU=Grupos,DC=sintetico,DC=invalid' : null),
      syncKeytab: process.env.SYNC_KEYTAB_FILE || null,
      syncPrincipal: process.env.SYNC_PRINCIPAL || null,
      syncAnomalyRatio: Number(env('SYNC_ANOMALY_RATIO', '0.5')),
    },
    timezone: 'America/Sao_Paulo',
  };

  // Salvaguardas do perfil institucional: recusa inicializar com provedor simulado ou cookie inseguro.
  if (cfg.institutional) {
    if (cfg.auth.provider !== 'kerberos-ldap') {
      throw new Error('Perfil institucional exige AUTH_PROVIDER=kerberos-ldap; provedor simulado recusado.');
    }
    if (!cfg.session.secureCookie) throw new Error('Perfil institucional exige SESSION_COOKIE_SECURE=true.');
    if (cfg.auth.kerberos.saslMinSsf < 56) throw new Error('LDAP_SASL_MINSSF abaixo do mínimo aceitável.');
  }
  return cfg;
}
