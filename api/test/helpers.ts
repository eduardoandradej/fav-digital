/**
 * Infraestrutura de teste: banco PostgreSQL REAL e descartável por arquivo de teste, migrações,
 * massa sintética e aplicação Nest em porta efêmera. Requer ADMIN_DATABASE_URL (padrão: container local).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { loadConfig, type AppConfig } from '../src/config.js';
import { Database } from '../src/db/database.js';
import { migrate } from '../src/db/migrator.js';
import { createApp } from '../src/bootstrap.js';
import { findUp } from '../src/paths.js';
import { SimulatedDirectory } from '../src/identity/simulated.provider.js';
import { IdentityService } from '../src/identity/identity.service.js';
import { seedSynthetic } from '../src/db/cli.js';

export const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:devonly@localhost:5432/fav';
export const PASSWORD = 'Sintetica#2026';

export interface TestEnv {
  app: INestApplication;
  base: string;
  db: Database;
  cfg: AppConfig;
  sim: SimulatedDirectory;
  dbName: string;
  appUrl: string;
  close(): Promise<void>;
}

function withDb(url: string, db: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = '/' + db;
  if (user) { u.username = user; u.password = password ?? ''; }
  return u.toString();
}

export async function startEnv(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const dbName = `fav_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const a2 = new pg.Client({ connectionString: withDb(ADMIN_URL, dbName) });
  await a2.connect();
  await a2.query(readFileSync(findUp('db/bootstrap/00-roles.sql'), 'utf8'));
  await a2.query(`ALTER ROLE fav_app PASSWORD 'devonly'; ALTER ROLE fav_migrator PASSWORD 'devonly'`);
  await a2.end();
  await migrate(withDb(ADMIN_URL, dbName, 'fav_migrator', 'devonly'), findUp('db/migrations'), () => undefined);

  const appUrl = withDb(ADMIN_URL, dbName, 'fav_app', 'devonly');
  Object.assign(process.env, { FAV_PROFILE: 'test', DATABASE_URL: appUrl, AUTH_PROVIDER: 'simulated', ...overrides });
  const cfg = loadConfig();
  const db = new Database(cfg.db);
  const sim = new SimulatedDirectory(cfg.auth.simulatedDirectoryFile);
  await seedSynthetic(db, new IdentityService(db, cfg, sim));
  const app = await createApp(cfg, db, { simulated: sim, logger: false });
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return {
    app, db, cfg, sim, dbName, appUrl, base: `http://127.0.0.1:${port}/api/v1`,
    async close() {
      await app.close();
      await db.close();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await c.end();
    },
  };
}

export interface Res<T = any> { status: number; body: T; headers: Headers }

/** Cliente HTTP com cookies e token CSRF, como o navegador. */
export class Client {
  cookies = new Map<string, string>();
  csrf = '';
  constructor(readonly base: string) {}

  private store(h: Headers) {
    for (const c of h.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(k); else this.cookies.set(k, decodeURIComponent(v));
    }
  }

  async req<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const h: Record<string, string> = { ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    if (body !== undefined) h['content-type'] = 'application/json';
    if (method !== 'GET' && this.csrf && !('x-csrf-token' in h)) h['x-csrf-token'] = this.csrf;
    const r = await fetch(this.base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    this.store(r.headers);
    const ct = r.headers.get('content-type') ?? '';
    const data = ct.includes('json') ? await r.json() : ct.includes('pdf') ? Buffer.from(await r.arrayBuffer()) : await r.text();
    return { status: r.status, body: data as T, headers: r.headers };
  }

  get<T = any>(p: string) { return this.req<T>('GET', p); }
  post<T = any>(p: string, b?: unknown, idem?: string | true) {
    return this.req<T>('POST', p, b ?? {}, idem ? { 'idempotency-key': idem === true ? randomUUID() : idem } : {});
  }
  patch<T = any>(p: string, b: unknown) { return this.req<T>('PATCH', p, b); }

  async login(idFuncional: string, senha = PASSWORD): Promise<Res> {
    const r = await this.req('POST', '/auth/login', { idFuncional, senha }, { 'x-requested-with': 'fav-digital' });
    if (r.status === 200) this.csrf = r.body.csrfToken;
    return r;
  }
}

export async function loginAs(env: TestEnv, id: string, unitCode?: string): Promise<Client> {
  const c = new Client(env.base);
  const r = await c.login(id);
  if (r.status !== 200) throw new Error(`login ${id} falhou: ${r.status} ${JSON.stringify(r.body)}`);
  if (unitCode) await selectUnit(c, unitCode);
  return c;
}

export async function selectUnit(c: Client, code: string): Promise<void> {
  const s = await c.get('/auth/sessao');
  const u = s.body.unidadesAutorizadas.find((x: any) => x.code === code);
  if (!u) throw new Error(`unidade ${code} não autorizada`);
  const r = await c.post('/auth/contexto', { unidadeId: u.id });
  if (r.status !== 200) throw new Error('falha ao trocar contexto');
}

export async function unitId(env: TestEnv, code: string): Promise<string> {
  return (await env.db.query(`SELECT id FROM unit WHERE code = $1`, [code])).rows[0].id;
}

export async function identityId(env: TestEnv, login: string): Promise<string> {
  return (await env.db.query(`SELECT id FROM identity WHERE login = $1 AND status = 'active'`, [login])).rows[0].id;
}

export const isoMinusMinutes = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export function expectOk(r: Res, status = [200, 201]): any {
  if (!status.includes(r.status)) throw new Error(`esperado ${status.join('/')}, obtido ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

/** Cria e confirma uma FAV regular coletada por Ana (DP-001). Retorna id, número e versão. */
export async function regularFav(env: TestEnv, ana: Client, lacre = `L${Math.floor(Math.random() * 1e9)}`) {
  const anaId = await identityId(env, '1000001');
  const c = expectOk(await ana.post('/favs', {
    tipo: 'regular',
    campos: {
      coleta_responsavel_kind: 'servidor', coleta_responsavel_identity_id: anaId, coleta_data_hora: isoMinusMinutes(120),
      coleta_endereco: 'Rua Sintética, 100', vestigio_tipo: 'Projétil', vestigio_descricao: 'Projétil deformado (dado sintético)',
      vestigio_localizacao: 'Próximo à porta', preservacao_mesmo_coletor: true, primeiro_lacre_numero: lacre,
    },
  }));
  const v = expectOk(await ana.get(`/favs/${c.id}`));
  const conf = expectOk(await ana.post(`/favs/${c.id}/confirmar-coleta`, { versao: v.ficha.version }, true));
  return { id: c.id as string, numero: conf.numero as string, versao: conf.versao as number, lacre };
}

export async function version(c: Client, id: string): Promise<number> {
  return expectOk(await c.get(`/favs/${id}`)).ficha.version;
}
