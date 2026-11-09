/**
 * Migrador explícito: executado em etapa própria, com o papel de migração (fav_migrator),
 * protegido contra execução concorrente por advisory lock.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const LOCK_KEY = 0x0fa7_d161; // constante arbitrária do projeto

export interface MigrationResult { applied: string[]; skipped: string[] }

export async function migrate(connectionString: string, dir: string, log = console.log): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString, application_name: 'fav-digital-migrator' });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!got.rows[0].ok) throw new Error('Outra migração está em execução (advisory lock ocupado).');
    await client.query(`CREATE TABLE IF NOT EXISTS fav.schema_migration (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (await client.query('SELECT name, checksum FROM fav.schema_migration')).rows.map((r) => [r.name, r.checksum]),
    );
    const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      const sql = readFileSync(join(dir, f), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      if (done.has(f)) {
        if (done.get(f) !== sum) throw new Error(`Migração ${f} foi alterada após aplicada (checksum divergente).`);
        result.skipped.push(f);
        continue;
      }
      log(`aplicando ${f}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO fav.schema_migration (name, checksum) VALUES ($1, $2)', [f, sum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Falha em ${f}: ${(e as Error).message}`);
      }
      result.applied.push(f);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
  return result;
}
