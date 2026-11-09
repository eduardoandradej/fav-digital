/**
 * CLI operacional.
 *   migrate  — aplica migrações (MIGRATION_DATABASE_URL, papel fav_migrator)
 *   seed     — unidades e papéis SINTÉTICOS + sincronização do diretório simulado (somente dev/test)
 *   sync     — executa sincronização completa do diretório configurado
 *   setup    — dev/test: bootstrap de papéis (superusuário local) + migrate + seed
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { findUp } from '../paths.js';
import { migrate } from './migrator.js';
import { Database } from './database.js';
import { IdentityService } from '../identity/identity.service.js';
import { identityProviders } from '../app.module.js';

const migrationsDir = () => findUp('db/migrations');

async function bootstrapRoles(adminUrl: string, appPassword: string, migratorPassword: string): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query(readFileSync(findUp('db/bootstrap/00-roles.sql'), 'utf8'));
    // Senhas apenas para o ambiente local descartável.
    await c.query(`ALTER ROLE fav_app PASSWORD ${pg.escapeLiteral(appPassword)}`);
    await c.query(`ALTER ROLE fav_migrator PASSWORD ${pg.escapeLiteral(migratorPassword)}`);
    await c.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(c.database!)} TO fav_app, fav_migrator`);
  } finally {
    await c.end();
  }
}

export async function seedSynthetic(db: Database, identities: IdentityService): Promise<void> {
  const data = JSON.parse(readFileSync(findUp('seed/unidades-e-papeis.json'), 'utf8'));
  for (const u of data.unidades) {
    await db.query(`INSERT INTO unit (code, name, kind) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind`,
      [u.code, u.name, u.kind]);
  }
  const rep = await identities.syncFull();
  console.log(`sincronização sintética: ${rep.status} (vistos ${rep.seen}, criados ${rep.created})`);
  for (const p of data.papeis) {
    for (const role of p.papeis) {
      await db.query(
        `INSERT INTO role_assignment (identity_id, role, unit_id, reason)
         SELECT i.id, $2, u.id, 'massa sintética de desenvolvimento' FROM identity i, unit u
          WHERE i.login = $1 AND u.code = $3
         ON CONFLICT DO NOTHING`, [p.login, role, p.unidade]);
    }
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const cfg = loadConfig();
  if (cmd === 'migrate') {
    const url = process.env.MIGRATION_DATABASE_URL;
    if (!url) throw new Error('MIGRATION_DATABASE_URL é obrigatório (papel fav_migrator).');
    const r = await migrate(url, migrationsDir());
    console.log(`migrações aplicadas: ${r.applied.join(', ') || 'nenhuma'}; já aplicadas: ${r.skipped.length}`);
    return;
  }
  if (cmd === 'setup') {
    if (cfg.institutional) throw new Error('setup é exclusivo de desenvolvimento/teste.');
    const admin = process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:devonly@localhost:5432/fav';
    await bootstrapRoles(admin, 'devonly', 'devonly');
    const u = new URL(admin);
    u.username = 'fav_migrator'; u.password = 'devonly';
    const r = await migrate(u.toString(), migrationsDir());
    console.log(`migrações aplicadas: ${r.applied.join(', ') || 'nenhuma'}`);
  }
  if (cmd === 'seed' || cmd === 'setup') {
    if (cfg.institutional || cfg.auth.provider !== 'simulated') throw new Error('seed sintético é exclusivo do provedor simulado em dev/test.');
    const db = new Database(cfg.db);
    const { source } = identityProviders(cfg);
    await seedSynthetic(db, new IdentityService(db, cfg, source));
    await db.close();
    console.log('massa sintética carregada.');
    return;
  }
  if (cmd === 'sync') {
    const db = new Database(cfg.db);
    const { source } = identityProviders(cfg);
    const rep = await new IdentityService(db, cfg, source).syncFull();
    console.log(JSON.stringify(rep));
    await db.close();
    process.exitCode = rep.status === 'ok' ? 0 : 2;
    return;
  }
  console.error('uso: cli.js <migrate|seed|sync|setup>');
  process.exitCode = 64;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error((e as Error).message); process.exit(1); });
}
